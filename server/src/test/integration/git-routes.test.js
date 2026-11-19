const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { adminAgent, request, queries } = require('../helpers/setup');
const AppManager = require('../../services/app-manager');
const GitLifecycle = require('../../services/git-lifecycle');
const DeployJobs = require('../../services/deploy-jobs');
const config = require('../../config');

const HEX_SECRET = /^[0-9a-f]{64}$/;

// The two rewritten pull tests answer 202 through a real claimed job, so
// claim()'s log files need a tmp dir (never the repo's real data/) and the
// self-update gate must stay deterministic — same seams as
// deploy-async-start/deploy-async-pull.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'microverse-git-routes-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

async function waitForDeployJob(appId, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await queries.getDeployJob(appId);
    if (job && (job.status === 'succeeded' || job.status === 'failed')) return job;
    if (Date.now() > deadline) {
      throw new Error(`deploy job for app ${appId} did not converge within ${timeoutMs}ms (last: ${JSON.stringify(job)})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function bind(appId, overrides = {}) {
  await queries.upsertAppGitSource({
    appId,
    url: 'https://github.com/o/r',
    branch: 'main',
    autoUpdate: true,
    webhookSecret: 'a'.repeat(64),
    ...overrides
  });
}

test('PUT then GET returns url, branch, auto update, webhook url and secret', async () => {
  const app = await AppManager.createApp('routes-git-a', 'npm');
  const agent = await adminAgent();

  const put = await agent.put(`/api/apps/${app.id}/git`)
    .send({ url: 'https://github.com/o/r', branch: 'main', autoUpdate: true })
    .expect(200);

  assert.equal(put.body.success, true);
  assert.equal(put.body.data.url, 'https://github.com/o/r');
  assert.equal(put.body.data.branch, 'main');
  assert.equal(put.body.data.autoUpdate, true);
  assert.match(put.body.data.webhookSecret, HEX_SECRET);

  const get = await agent.get(`/api/apps/${app.id}/git`).expect(200);
  assert.match(get.body.data.webhookUrl, new RegExp(`/api/webhooks/github/${app.id}$`));
  assert.match(get.body.data.webhookUrl, /^http:\/\//);
  assert.equal(get.body.data.webhookSecret, put.body.data.webhookSecret);

  // The secret is only exposed by the dedicated endpoint, never in app rows.
  const list = await agent.get('/api/apps').expect(200);
  const listed = list.body.data.find(a => a.id === app.id);
  assert.equal(listed.git.webhook_secret, undefined);
  assert.equal(listed.git.webhookSecret, undefined);
});

test('GET returns clean JSON 404 when the app is unbound', async () => {
  const app = await AppManager.createApp('routes-git-unbound', 'npm');
  const agent = await adminAgent();

  const res = await agent.get(`/api/apps/${app.id}/git`).expect(404);

  assert.equal(res.body.success, false);
  assert.equal(typeof res.body.error.message, 'string');
  assert.ok(res.body.error.message.length > 0);
});

test('changing the URL or branch clears deployed progress', async () => {
  const app = await AppManager.createApp('routes-git-reset', 'npm');
  const secret = 'd'.repeat(64);
  await bind(app.id, { url: 'https://github.com/o/old', webhookSecret: secret });
  await queries.finishGitSync(app.id, { status: 'success', deployedCommit: 'old-sha', remoteCommit: 'old-sha' });
  const agent = await adminAgent();

  const byUrl = await agent.put(`/api/apps/${app.id}/git`)
    .send({ url: 'https://github.com/o/new' })
    .expect(200);

  assert.equal(byUrl.body.data.url, 'https://github.com/o/new');
  assert.equal(byUrl.body.data.branch, 'main');
  assert.equal(byUrl.body.data.deployedCommit, null);
  assert.equal(byUrl.body.data.remoteCommit, null);
  assert.equal(byUrl.body.data.syncedAt, null);
  assert.equal(byUrl.body.data.lastStatus, 'idle');
  assert.equal(byUrl.body.data.lastError, null);
  assert.equal(byUrl.body.data.webhookSecret, secret, 'URL change keeps the secret');

  // A branch-only change must reset too.
  await queries.finishGitSync(app.id, { status: 'success', deployedCommit: 'new-sha' });
  const byBranch = await agent.put(`/api/apps/${app.id}/git`)
    .send({ url: 'https://github.com/o/new', branch: 'dev' })
    .expect(200);

  assert.equal(byBranch.body.data.branch, 'dev');
  assert.equal(byBranch.body.data.deployedCommit, null);
  assert.equal(byBranch.body.data.lastStatus, 'idle');
});

test('auto-update-only change keeps the secret and deployment progress', async () => {
  const app = await AppManager.createApp('routes-git-autoupdate', 'npm');
  const secret = 'c'.repeat(64);
  // Same repository as the PUT below: trailing `.git`/slash are normalized away.
  await bind(app.id, { url: 'https://github.com/o/r.git', webhookSecret: secret });
  await queries.finishGitSync(app.id, { status: 'success', deployedCommit: 'abc', remoteCommit: 'abc' });
  const agent = await adminAgent();

  const res = await agent.put(`/api/apps/${app.id}/git`)
    .send({ url: 'https://github.com/o/r', autoUpdate: false })
    .expect(200);

  assert.equal(res.body.data.autoUpdate, false);
  assert.equal(res.body.data.deployedCommit, 'abc');
  assert.equal(res.body.data.lastStatus, 'success');
  assert.equal(res.body.data.webhookSecret, secret);
});

test('PUT rejects a missing URL, a non-https URL, and an invalid branch', async () => {
  const app = await AppManager.createApp('routes-git-invalid', 'npm');
  const agent = await adminAgent();

  const missing = await agent.put(`/api/apps/${app.id}/git`).send({}).expect(400);
  assert.equal(missing.body.success, false);

  const ssh = await agent.put(`/api/apps/${app.id}/git`).send({ url: 'ssh://x/y' }).expect(400);
  assert.match(ssh.body.error.message, /https/i);

  const branch = await agent.put(`/api/apps/${app.id}/git`)
    .send({ url: 'https://github.com/o/r', branch: 'bad..branch' })
    .expect(400);
  assert.match(branch.body.error.message, /branch/i);

  assert.equal(await queries.getAppGitSource(app.id), undefined, 'rejected input creates no source');
});

test('pull returns 409 while a fresh claim exists', async () => {
  const app = await AppManager.createApp('routes-git-busy', 'npm');
  await bind(app.id);
  assert.equal(await queries.claimGitSync(app.id, config.git.staleSyncMs), true);
  const agent = await adminAgent();

  const res = await agent.post(`/api/apps/${app.id}/git/pull`).expect(409);

  assert.equal(res.body.success, false);
  assert.match(res.body.error.message, /in progress/i);
});

test('PUT returns 409 and leaves the binding unchanged during a live sync', async () => {
  const app = await AppManager.createApp('routes-git-put-busy', 'npm');
  const secret = 'f'.repeat(64);
  await bind(app.id, { url: 'https://github.com/o/old', webhookSecret: secret });
  assert.equal(await queries.claimGitSync(app.id, config.git.staleSyncMs), true);
  const agent = await adminAgent();

  const res = await agent.put(`/api/apps/${app.id}/git`)
    .send({ url: 'https://github.com/o/new', branch: 'dev' })
    .expect(409);

  assert.equal(res.body.success, false);
  assert.match(res.body.error.message, /in progress/i);

  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.url, 'https://github.com/o/old');
  assert.equal(source.branch, 'main');
  assert.equal(source.webhook_secret, secret);
  assert.equal(source.last_status, 'updating');
});

test('DELETE returns 409 and keeps the binding during a live sync', async () => {
  const app = await AppManager.createApp('routes-git-del-busy', 'npm');
  await bind(app.id);
  assert.equal(await queries.claimGitSync(app.id, config.git.staleSyncMs), true);
  const agent = await adminAgent();

  const res = await agent.delete(`/api/apps/${app.id}/git`).expect(409);

  assert.equal(res.body.success, false);
  assert.match(res.body.error.message, /in progress/i);
  assert.ok(await queries.getAppGitSource(app.id));
});

// CONTRACT CHANGE (Task 9, spec decision 7): pull is a background deploy job
// now. The two tests below asserted the old synchronous contract (200 +
// data.status / 400 on failure) and are rewritten, renamed to say so.

test('POST /git/pull answers 202 and the git summary then reads success (contract change: was 200 + data.status)', async (t) => {
  const app = await AppManager.createApp('routes-git-pull-ok', 'npm');
  await bind(app.id);
  const agent = await adminAgent();
  t.mock.method(DeployJobs, 'logDir', () => tmp);
  t.mock.method(DeployJobs, 'isUpdateRunning', () => false);
  t.mock.method(GitLifecycle, 'pull', async () => {
    // A real sync writes its own outcome into app_git_source; the job row
    // never becomes the truth of what was deployed — it only reports
    // progress. The fake mirrors that split.
    await queries.finishGitSync(app.id, { status: 'success', deployedCommit: 'abc123' });
    return { status: 'success', deployedCommit: 'abc123', error: null };
  });

  const res = await agent.post(`/api/apps/${app.id}/git/pull`).expect(202);

  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.data, { app_id: app.id, kind: 'pull', status: 'running' });

  const job = await waitForDeployJob(app.id);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.kind, 'pull');

  const get = await agent.get(`/api/apps/${app.id}`).expect(200);
  assert.equal(get.body.data.git.last_status, 'success');
  assert.equal(get.body.data.git.deployed_commit, 'abc123');
});

test('POST /git/pull answers 202 and converges the job to failed when the sync fails (contract change: was 400)', async (t) => {
  const app = await AppManager.createApp('routes-git-pull-fail', 'npm');
  await bind(app.id);
  const agent = await adminAgent();
  t.mock.method(DeployJobs, 'logDir', () => tmp);
  t.mock.method(DeployJobs, 'isUpdateRunning', () => false);
  t.mock.method(GitLifecycle, 'pull', async () => ({
    status: 'failed', deployedCommit: null, error: 'npm run build failed'
  }));

  const res = await agent.post(`/api/apps/${app.id}/git/pull`).expect(202);
  assert.equal(res.body.data.kind, 'pull');

  // The failure is no longer a synchronous 400 — the request already
  // answered; the job row carries the original error message.
  const job = await waitForDeployJob(app.id);
  assert.equal(job.status, 'failed');
  assert.match(job.message, /build failed/);
});

test('check returns the lifecycle comparison and maps git errors to 400', async (t) => {
  const app = await AppManager.createApp('routes-git-check', 'npm');
  await bind(app.id);
  const agent = await adminAgent();
  const check = t.mock.method(GitLifecycle, 'check', async () => ({
    remoteCommit: 'bbb', deployedCommit: 'aaa', upToDate: false
  }));

  const ok = await agent.post(`/api/apps/${app.id}/git/check`).expect(200);
  assert.deepEqual(ok.body.data, { remoteCommit: 'bbb', deployedCommit: 'aaa', upToDate: false });

  check.mock.mockImplementation(async () => {
    const error = new Error('git ls-remote failed: boom');
    error.gitError = true;
    throw error;
  });
  const failed = await agent.post(`/api/apps/${app.id}/git/check`).expect(400);
  assert.match(failed.body.error.message, /git ls-remote failed/);
});

test('check lets unexpected errors reach the error handler as 500', async (t) => {
  const app = await AppManager.createApp('routes-git-check-500', 'npm');
  await bind(app.id);
  const agent = await adminAgent();
  t.mock.method(GitLifecycle, 'check', async () => {
    throw new Error('database is locked');
  });

  const res = await agent.post(`/api/apps/${app.id}/git/check`).expect(500);

  assert.equal(res.body.success, false);
  assert.match(res.body.error.message, /database is locked/);
});

test('unbind keeps the app and its files', async () => {
  const app = await AppManager.createApp('routes-git-unbind', 'http-server');
  fs.writeFileSync(path.join(app.path, 'index.html'), '<h1>keep</h1>');
  await bind(app.id);
  const agent = await adminAgent();

  const res = await agent.delete(`/api/apps/${app.id}/git`).expect(200);

  assert.equal(res.body.success, true);
  assert.equal(await queries.getAppGitSource(app.id), undefined);
  assert.ok(fs.existsSync(path.join(app.path, 'index.html')), 'user files survive unbind');

  const get = await agent.get(`/api/apps/${app.id}`).expect(200);
  assert.equal(get.body.data.git, null);
});

test('rotating the secret returns a different value', async () => {
  const app = await AppManager.createApp('routes-git-secret', 'npm');
  const agent = await adminAgent();
  const put = await agent.put(`/api/apps/${app.id}/git`)
    .send({ url: 'https://github.com/o/r' })
    .expect(200);

  const first = await agent.post(`/api/apps/${app.id}/git/secret`).expect(200);
  const second = await agent.post(`/api/apps/${app.id}/git/secret`).expect(200);

  assert.match(first.body.data.webhookSecret, HEX_SECRET);
  assert.match(second.body.data.webhookSecret, HEX_SECRET);
  assert.notEqual(first.body.data.webhookSecret, put.body.data.webhookSecret);
  assert.notEqual(second.body.data.webhookSecret, first.body.data.webhookSecret);

  const row = await queries.getAppGitSource(app.id);
  assert.equal(row.webhook_secret, second.body.data.webhookSecret);
});

test('unknown app returns 404 and unauthenticated requests are rejected', async () => {
  const agent = await adminAgent();

  const get = await agent.get('/api/apps/999999/git').expect(404);
  assert.equal(get.body.error.message, 'App not found');

  const put = await agent.put('/api/apps/999999/git')
    .send({ url: 'https://github.com/o/r' })
    .expect(404);
  assert.equal(put.body.error.message, 'App not found');

  await request().get('/api/apps/1/git').expect(401);
});
