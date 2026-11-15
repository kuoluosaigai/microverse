const express = require('express');
const AppManager = require('../services/app-manager');
const GitLifecycle = require('../services/git-lifecycle');
const { queries } = require('../db');
const config = require('../config');
const { verifyWebhookSignature } = require('../utils/webhook-signature');
const { normalizeGitUrl } = require('../utils/validate-git-source');

/**
 * Public GitHub webhook receiver.
 *
 * Mounted in app.js BEFORE express.json() with express.raw(), so `req.body` is
 * the exact bytes GitHub signed. Authentication is per-app HMAC (X-Hub-
 * Signature-256 with the app's stored webhook_secret); there is no session.
 *
 * Response contract:
 *   200 ping, 204 non-push, 202 accepted/ignored, 400 malformed JSON,
 *   401 bad signature, 404 unknown app or unbound source, 429 rate-limited.
 * Responses deliberately reveal nothing about an app beyond the 404 GitHub
 * already cannot use.
 */
const router = express.Router();

const SHA_RE = /^[0-9a-f]{40,64}$/i;

function sendError(res, status, message) {
  return res.status(status).json({ success: false, error: { message } });
}

router.post('/github/:appId', async (req, res, next) => {
  try {
    // Cheap event routing first: ping is GitHub's setup probe and needs no
    // app/signature; anything other than a push is acknowledged and dropped.
    const event = req.get('X-GitHub-Event');
    if (event === 'ping') {
      return res.json({ ok: true });
    }
    if (event !== 'push') {
      return res.status(204).end();
    }

    const app = await AppManager.getAppById(req.params.appId);
    const source = await queries.getAppGitSource(app.id);
    if (!source) {
      return sendError(res, 404, 'No Git source bound');
    }

    // Signature over the RAW bytes, before parsing (parsing first would allow
    // JSON-shape attacks to run on unauthenticated input). A missing/non-Buffer
    // body (wrong content type) is treated as a failed signature.
    if (!verifyWebhookSignature(req.body, source.webhook_secret, req.get('X-Hub-Signature-256'))) {
      return sendError(res, 401, 'Invalid webhook signature');
    }

    let payload;
    try {
      if (!Buffer.isBuffer(req.body)) throw new Error('missing raw body');
      payload = JSON.parse(req.body.toString('utf8'));
    } catch (_err) {
      return sendError(res, 400, 'Malformed JSON payload');
    }

    const repository = payload && payload.repository ? payload.repository : {};
    const repositoryUrl = repository.clone_url || repository.html_url;
    const expectedRef = `refs/heads/${source.branch}`;
    const sameRepo = typeof repositoryUrl === 'string'
      && normalizeGitUrl(repositoryUrl) === normalizeGitUrl(source.url);
    if (payload.ref !== expectedRef || !sameRepo) {
      // A push to another branch/repo is a normal GitHub delivery, not an
      // error. Acknowledge it without any DB write so it stays cheap.
      return res.status(202).json({ ok: true, ignored: true });
    }

    const after = payload.after;
    if (typeof after === 'string' && SHA_RE.test(after)) {
      await queries.setGitRemoteCommit(app.id, after);
    }

    if (source.auto_update) {
      // Never awaited: the pull can take minutes and GitHub times deliveries
      // out. The DB claim inside sync is the single-flight guard.
      GitLifecycle.triggerBackgroundSync(app.id);
      return res.status(202).json({ ok: true, message: 'update queued' });
    }

    await queries.markGitUpdateAvailable(app.id, config.git.staleSyncMs);
    return res.status(202).json({ ok: true });
  } catch (error) {
    if (error.message === 'App not found') return sendError(res, 404, error.message);
    next(error);
  }
});

module.exports = router;
