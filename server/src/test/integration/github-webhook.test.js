const { test, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { request, init, queries } = require('../helpers/setup');
const AppManager = require('../../services/app-manager');
const GitLifecycle = require('../../services/git-lifecycle');
const NpmLifecycle = require('../../services/npm-lifecycle');

before(async () => { await init(); });
afterEach(() => mock.reset());

const SECRET = 'webhook-test-secret';
const REPO_URL = 'https://github.com/o/r.git';
const CLONE_URL = 'https://github.com/o/r';
const SHA = 'a'.repeat(40);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'microverse-webhook-git-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function sign(body, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// Returns the exact JSON string that is signed AND sent, so the HMAC is
// computed over the same bytes the server receives.
function payload(over = {}) {
  return JSON.stringify({
    ref: 'refs/heads/main',
    after: SHA,
    repository: { clone_url: CLONE_URL, html_url: 'https://github.com/o/r' },
    ...over
  });
}

function postWebhook(appId, body, { event = 'push', signature } = {}) {
  const req = request()
    .post(`/api/webhooks/github/${appId}`)
    .set('Content-Type', 'application/json')
    .set('X-GitHub-Event', event);
  // undefined -> sign with the real secret; null -> omit the header entirely.
  const header = signature === undefined ? sign(body) : signature;
  if (header !== null) {
    req.set('X-Hub-Signature-256', header);
  }
  return req.send(body);
}

let appSeq = 0;
async function makeBoundApp({ autoUpdate = true, url = REPO_URL } = {}) {
  appSeq += 1;
  const app = await AppManager.createApp(`webhook-app-${appSeq}`, 'npm');
  await queries.upsertAppGitSource({
    appId: app.id,
    url,
    branch: 'main',
    autoUpdate,
    webhookSecret: SECRET
  });
  return app;
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitFor timed out');
}

const fileUrl = (dir) => 'file://' + path.resolve(dir).replace(/\\/g, '/');

function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one');
  return [
    ['init', '-q', '-b', 'main'],
    ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'add', '.'],
    ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-qm', 'one']
  ].reduce((p, args) => p.then(() => GitLifecycle.gitExec(args, { cwd: dir })), Promise.resolve());
}

function commitTo(dir, content, message) {
  fs.writeFileSync(path.join(dir, 'a.txt'), content);
  return [
    ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'add', '.'],
    ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-qm', message]
  ].reduce((p, args) => p.then(() => GitLifecycle.gitExec(args, { cwd: dir })), Promise.resolve());
}

test('ping event returns 200 without requiring an app or a signature', async () => {
  const res = await postWebhook(999999, '{}', { event: 'ping', signature: null });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

test('non-push event returns 204', async () => {
  const res = await postWebhook(999999, '{}', { event: 'issues', signature: null });

  assert.equal(res.status, 204);
  assert.equal(res.text, '');
});

test('bad signature returns 401 and records nothing', async () => {
  const app = await makeBoundApp();
  const body = payload();

  const res = await postWebhook(app.id, body, { signature: sign(body, 'wrong-secret') });

  assert.equal(res.status, 401);
  assert.equal(res.body.success, false);
  assert.equal(typeof res.body.error.message, 'string');

  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.remote_commit, null);
  assert.equal(source.last_status, 'idle');
});

test('missing signature returns 401', async () => {
  const app = await makeBoundApp();

  const res = await postWebhook(app.id, payload(), { signature: null });

  assert.equal(res.status, 401);
});

test('body-less push with a syntactically valid signature header returns 401', async () => {
  const app = await makeBoundApp();

  const res = await request()
    .post(`/api/webhooks/github/${app.id}`)
    .set('Content-Type', 'application/json')
    .set('X-GitHub-Event', 'push')
    .set('X-Hub-Signature-256', 'sha256=' + 'a'.repeat(64));

  assert.equal(res.status, 401);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error.message, 'Invalid webhook signature');
});

test('non-JSON content type returns 401 instead of 500', async () => {
  const app = await makeBoundApp();

  const res = await request()
    .post(`/api/webhooks/github/${app.id}`)
    .set('Content-Type', 'text/plain')
    .set('X-GitHub-Event', 'push')
    .set('X-Hub-Signature-256', 'sha256=' + 'a'.repeat(64))
    .send('hello');

  assert.equal(res.status, 401);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error.message, 'Invalid webhook signature');
});

test('unknown app returns 404', async () => {
  const body = payload();

  const res = await postWebhook(999999, body);

  assert.equal(res.status, 404);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error.message, 'App not found');
});

test('unbound app returns 404', async () => {
  const app = await AppManager.createApp('webhook-unbound', 'npm');
  const body = payload();

  const res = await postWebhook(app.id, body);

  assert.equal(res.status, 404);
  assert.equal(res.body.success, false);
});

test('malformed JSON returns 400 after a valid signature', async () => {
  const app = await makeBoundApp();
  const body = '{"ref":';

  const res = await postWebhook(app.id, body, { signature: sign(body) });

  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
});

test('wrong branch or repo returns 202 ignored and records nothing', async () => {
  const app = await makeBoundApp();
  const trigger = mock.method(GitLifecycle, 'triggerBackgroundSync', () => {});

  const wrongBranch = await postWebhook(app.id, payload({ ref: 'refs/heads/dev' }));
  assert.equal(wrongBranch.status, 202);
  assert.deepEqual(wrongBranch.body, { ok: true, ignored: true });

  const wrongRepo = await postWebhook(app.id, payload({
    repository: { clone_url: 'https://github.com/o/other.git', html_url: 'https://github.com/o/other' }
  }));
  assert.equal(wrongRepo.status, 202);
  assert.deepEqual(wrongRepo.body, { ok: true, ignored: true });

  assert.equal(trigger.mock.callCount(), 0);
  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.remote_commit, null);
  assert.equal(source.last_status, 'idle');
});

test('valid push with auto_update=0 records update_available and does not sync', async () => {
  const app = await makeBoundApp({ autoUpdate: false });
  const trigger = mock.method(GitLifecycle, 'triggerBackgroundSync', () => {});

  const res = await postWebhook(app.id, payload());

  assert.equal(res.status, 202);
  assert.equal(res.body.ok, true);
  assert.equal(trigger.mock.callCount(), 0);

  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.remote_commit, SHA);
  assert.equal(source.last_status, 'update_available');
});

test('valid push with auto_update=1 queues exactly one sync', async () => {
  const app = await makeBoundApp({ autoUpdate: true });
  const trigger = mock.method(GitLifecycle, 'triggerBackgroundSync', () => {});

  const res = await postWebhook(app.id, payload());

  assert.equal(res.status, 202);
  assert.deepEqual(res.body, { ok: true, message: 'update queued' });
  assert.equal(trigger.mock.callCount(), 1);
  assert.equal(trigger.mock.calls[0].arguments[0], app.id);

  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.remote_commit, SHA);
});

test('duplicate delivery of the same SHA is idempotent (no second build)', async () => {
  const src = path.join(tmp, 'dup-src');
  await makeRepo(src);
  const appPath = path.join(tmp, 'dup-app');
  await GitLifecycle.ensureRepo(appPath, { url: fileUrl(src), branch: 'main' });
  const firstSha = await GitLifecycle.currentHead(appPath);

  appSeq += 1;
  const app = await AppManager.createApp(`webhook-dup-${appSeq}`, 'npm');
  await queries.updateApp({ id: app.id, path: appPath });
  await queries.upsertAppGitSource({
    appId: app.id,
    url: fileUrl(src),
    branch: 'main',
    autoUpdate: true,
    webhookSecret: SECRET
  });
  await queries.finishGitSync(app.id, { status: 'success', deployedCommit: firstSha });

  await commitTo(src, 'two', 'two');
  const secondSha = await GitLifecycle.currentHead(src);

  let builds = 0;
  mock.method(NpmLifecycle, 'ensureBuilt', async () => { builds += 1; });
  let syncs = 0;
  let completed = 0;
  const realSync = GitLifecycle.sync;
  mock.method(GitLifecycle, 'sync', async function (...args) {
    syncs += 1;
    try {
      return await realSync.apply(GitLifecycle, args);
    } finally {
      completed += 1;
    }
  });

  const body = payload({
    after: secondSha,
    repository: { clone_url: fileUrl(src), html_url: fileUrl(src) }
  });

  const first = await postWebhook(app.id, body);
  assert.equal(first.status, 202);
  await waitFor(() => completed === 1 && builds === 1);

  const second = await postWebhook(app.id, body);
  assert.equal(second.status, 202);
  await waitFor(() => completed === 2);

  assert.equal(syncs, 2);
  assert.equal(builds, 1, 'the same SHA must not trigger a second build');
  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.deployed_commit, secondSha);
  assert.equal(source.remote_commit, secondSha);
  assert.equal(source.last_status, 'success');
});

test('webhook endpoint is rate limited to 120 requests per minute', async () => {
  let limited = null;
  for (let i = 0; i < 140 && !limited; i += 1) {
    const res = await postWebhook(999999, '{}', { event: 'ping', signature: null });
    if (res.status === 429) limited = res;
  }

  assert.ok(limited, 'expected a 429 within 140 requests');
  assert.equal(limited.body.success, false);
  assert.match(limited.body.error.message, /Too many webhook requests/);
});
