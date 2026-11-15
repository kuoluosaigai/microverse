const express = require('express');
const crypto = require('crypto');
const AppManager = require('../services/app-manager');
const GitLifecycle = require('../services/git-lifecycle');
const { queries } = require('../db');
const {
  validateGitUrl,
  validateGitBranch,
  normalizeGitUrl
} = require('../utils/validate-git-source');

/**
 * Git-source endpoints (all protected — mounted AFTER requireAuth).
 *
 * The app's binding is stored in `app_git_source`; the app row itself only
 * carries a secret-free `git` summary. `GET/PUT/secret` are the only endpoints
 * that expose the webhook secret, which is why they build their own response
 * shape instead of returning an app row.
 */
const router = express.Router();

const NO_SOURCE_MESSAGE = 'No Git source bound';
const BUSY_MESSAGE = 'Update already in progress';

function toSourceData(req, app, source) {
  return {
    url: source.url,
    branch: source.branch,
    autoUpdate: !!source.auto_update,
    webhookUrl: `${req.protocol}://${req.get('host')}/api/webhooks/github/${app.id}`,
    webhookSecret: source.webhook_secret,
    deployedCommit: source.deployed_commit,
    remoteCommit: source.remote_commit,
    syncedAt: source.synced_at,
    lastStatus: source.last_status,
    lastError: source.last_error
  };
}

function sendError(res, status, message) {
  return res.status(status).json({ success: false, error: { message } });
}

// Get the app's git binding (secret-bearing shape).
router.get('/apps/:id/git', async (req, res, next) => {
  try {
    const app = await AppManager.getAppById(req.params.id);
    const source = await queries.getAppGitSource(app.id);
    if (!source) return sendError(res, 404, NO_SOURCE_MESSAGE);

    res.json({ success: true, data: toSourceData(req, app, source) });
  } catch (error) {
    if (error.message === 'App not found') return sendError(res, 404, error.message);
    next(error);
  }
});

// Bind or re-bind the app's source. A first bind generates the webhook secret;
// a re-bind keeps it. A URL/branch change invalidates deployment progress
// (the old repository's SHA must not masquerade as the new repo's deploy).
router.put('/apps/:id/git', async (req, res, next) => {
  try {
    const app = await AppManager.getAppById(req.params.id);
    const body = req.body || {};
    const url = body.url;

    if (typeof url !== 'string' || url.length === 0) {
      return sendError(res, 400, 'Git URL is required');
    }
    const urlError = validateGitUrl(url);
    if (urlError) return sendError(res, 400, urlError);

    const branchProvided = body.branch !== undefined && body.branch !== null && body.branch !== '';
    if (branchProvided) {
      const branchError = validateGitBranch(body.branch);
      if (branchError) return sendError(res, 400, branchError);
    }

    const autoUpdate = body.autoUpdate === undefined || body.autoUpdate === null
      ? undefined
      : Boolean(body.autoUpdate);

    const existing = await queries.getAppGitSource(app.id);

    await queries.upsertAppGitSource({
      appId: app.id,
      url,
      branch: branchProvided ? body.branch : undefined,
      autoUpdate,
      // A first bind needs a secret (NOT NULL); a re-bind must preserve the
      // stored one so existing webhook configuration keeps working.
      webhookSecret: existing ? undefined : crypto.randomBytes(32).toString('hex')
    });

    if (existing) {
      const urlChanged = normalizeGitUrl(existing.url) !== normalizeGitUrl(url);
      const branchChanged = branchProvided && body.branch !== existing.branch;
      if (urlChanged || branchChanged) {
        await queries.resetGitSourceProgress(app.id);
      } else if (autoUpdate !== undefined && (autoUpdate ? 1 : 0) !== existing.auto_update) {
        await queries.setGitAutoUpdate(app.id, autoUpdate);
      }
    }

    const source = await queries.getAppGitSource(app.id);
    res.json({ success: true, data: toSourceData(req, app, source) });
  } catch (error) {
    if (error.message === 'App not found') return sendError(res, 404, error.message);
    if (error.message === 'Update in progress') return sendError(res, 409, error.message);
    next(error);
  }
});

// Unbind the source. The app row, its directory and its files are untouched.
router.delete('/apps/:id/git', async (req, res, next) => {
  try {
    const app = await AppManager.getAppById(req.params.id);
    await queries.deleteAppGitSource(app.id);
    res.json({ success: true });
  } catch (error) {
    if (error.message === 'App not found') return sendError(res, 404, error.message);
    if (error.message === 'Update in progress') return sendError(res, 409, error.message);
    next(error);
  }
});

// Rotate the webhook secret. The git binding and deployment progress stay.
router.post('/apps/:id/git/secret', async (req, res, next) => {
  try {
    const app = await AppManager.getAppById(req.params.id);
    const source = await queries.getAppGitSource(app.id);
    if (!source) return sendError(res, 404, NO_SOURCE_MESSAGE);

    // PASS the existing url: upsertAppGitSource sets url unconditionally.
    // Omitted branch/autoUpdate are preserved by its COALESCE columns.
    await queries.upsertAppGitSource({
      appId: app.id,
      url: source.url,
      webhookSecret: crypto.randomBytes(32).toString('hex')
    });

    const updated = await queries.getAppGitSource(app.id);
    res.json({ success: true, data: toSourceData(req, app, updated) });
  } catch (error) {
    if (error.message === 'App not found') return sendError(res, 404, error.message);
    if (error.message === 'Update in progress') return sendError(res, 409, error.message);
    next(error);
  }
});

// Compare the deployed commit with the remote branch head (no worktree changes).
router.post('/apps/:id/git/check', async (req, res, next) => {
  try {
    const app = await AppManager.getAppById(req.params.id);
    const source = await queries.getAppGitSource(app.id);
    if (!source) return sendError(res, 404, NO_SOURCE_MESSAGE);

    const result = await GitLifecycle.check(app, source);
    res.json({ success: true, data: result });
  } catch (error) {
    if (error.message === 'App not found') return sendError(res, 404, error.message);
    if (error.message === 'Not a Git-sourced app') return sendError(res, 404, error.message);
    if (error.message === 'Update in progress') return sendError(res, 409, error.message);
    // Reaching the remote is the operation itself; a git failure is a client-
    // actionable condition (bad URL/branch/credentials), not a platform fault.
    return sendError(res, 400, error.message);
  }
});

// Pull the branch and rebuild/restart. Synchronous by design; the DB claim is
// the single-flight guard, so a concurrent pull reports busy rather than
// racing the working tree.
router.post('/apps/:id/git/pull', async (req, res, next) => {
  try {
    const app = await AppManager.getAppById(req.params.id);
    const source = await queries.getAppGitSource(app.id);
    if (!source) return sendError(res, 404, NO_SOURCE_MESSAGE);

    const result = await GitLifecycle.pull(app);
    if (result.status === 'busy') {
      return sendError(res, 409, result.error || BUSY_MESSAGE);
    }
    if (result.status === 'failed') {
      return sendError(res, 400, result.error || 'Git pull failed');
    }

    res.json({
      success: true,
      data: { deployedCommit: result.deployedCommit, status: result.status }
    });
  } catch (error) {
    if (error.message === 'App not found') return sendError(res, 404, error.message);
    if (error.message === 'Update in progress') return sendError(res, 409, error.message);
    return sendError(res, 400, error.message);
  }
});

module.exports = router;
