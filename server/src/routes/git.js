const express = require('express');
const crypto = require('crypto');
const AppManager = require('../services/app-manager');
const GitLifecycle = require('../services/git-lifecycle');
const DeployJobs = require('../services/deploy-jobs');
const { sendDeployConflict } = require('./deploy-conflict');
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

// Expected client-facing failures during check/pull. Everything else is a
// server fault and must reach the global error handler (500 + logged) rather
// than being misreported as a 400.
const CLIENT_GIT_ERROR_PATTERNS = [
  'Invalid git ',
  'npm install failed',
  'npm install timed out',
  'build failed',
  'npm run build timed out',
  'package.json not found',
  'Invalid package.json'
];

function isClientGitError(error) {
  if (!error) return false;
  if (error.gitError === true) return true;
  const message = typeof error.message === 'string' ? error.message : '';
  return CLIENT_GIT_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
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
    // A live sync owns the working tree and its claim; mutating the binding
    // (and especially resetGitSourceProgress, which clears sync_started_at)
    // would let the running pull write the old repo's commits onto the new one.
    await GitLifecycle.assertNotSyncing(app.id);
    // A live deploy job clones/fetches and builds from THIS binding —
    // rebinding mid-job makes the job deploy a source the operator has
    // already replaced. Refuse until it finishes. (Task 7.)
    await DeployJobs.assertIdle(app.id, '修改 Git 源');
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
    if (sendDeployConflict(res, error)) return;
    next(error);
  }
});

// Unbind the source. The app row, its directory and its files are untouched.
router.delete('/apps/:id/git', async (req, res, next) => {
  try {
    const app = await AppManager.getAppById(req.params.id);
    // Unbinding during a sync would delete the row the running pull is about
    // to finish against; refuse until it settles.
    await GitLifecycle.assertNotSyncing(app.id);
    // Same reasoning as the bind route: a live deploy job still reads this
    // binding (clone/build), so unbinding mid-job yanks it out from under
    // the run. (Task 7.)
    await DeployJobs.assertIdle(app.id, '解绑 Git 源');
    await queries.deleteAppGitSource(app.id);
    res.json({ success: true });
  } catch (error) {
    if (error.message === 'App not found') return sendError(res, 404, error.message);
    if (error.message === 'Update in progress') return sendError(res, 409, error.message);
    if (sendDeployConflict(res, error)) return;
    next(error);
  }
});

// Rotate the webhook secret. The git binding and deployment progress stay.
router.post('/apps/:id/git/secret', async (req, res, next) => {
  try {
    const app = await AppManager.getAppById(req.params.id);
    const source = await queries.getAppGitSource(app.id);
    if (!source) return sendError(res, 404, NO_SOURCE_MESSAGE);

    // The 404 above still wins for an unbound app (nothing to rotate
    // regardless of the job). Once there IS a secret, refuse while a
    // deploy job is live: a GitHub delivery racing the job could trigger a
    // sync against a secret the operator is mid-way through changing.
    // (Task 7.)
    await DeployJobs.assertIdle(app.id, '轮换密钥');

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
    if (sendDeployConflict(res, error)) return;
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
    if (isClientGitError(error)) return sendError(res, 400, error.message);
    next(error);
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
    if (isClientGitError(error)) return sendError(res, 400, error.message);
    next(error);
  }
});

module.exports = router;
