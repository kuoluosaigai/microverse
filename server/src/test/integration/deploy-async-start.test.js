const { test, mock, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { adminAgent, queries, dbReady } = require('../helpers/setup');
const AppManager = require('../../services/app-manager');
const DeployManager = require('../../services/deploy-manager');
const DeployJobs = require('../../services/deploy-jobs');
const ProcessManager = require('../../services/process-manager');
const config = require('../../config');

// Contract under test: POST /apps/:id/start does the synchronous pre-checks
// and then returns 202 with a claimed deploy job, while the real deploy runs
// fire-and-forget through DeployRunner (a faked DeployManager.deployApp).
// The 202-arrives-before-the-work-finishes assertions are the point of the
// file: they go red the moment someone awaits the job again.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'microverse-async-start-'));

before(async () => { await dbReady; });
afterEach(() => mock.reset());
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

async function makeApp(name, { deployType = 'http-server', indexHtml = true, git = false } = {}) {
  const app = await AppManager.createApp(name, deployType);
  if (deployType === 'npm') {
    fs.writeFileSync(
      path.join(app.path, 'package.json'),
      JSON.stringify({ scripts: { start: 'node index.js' } })
    );
  } else if (indexHtml) {
    fs.writeFileSync(path.join(app.path, 'index.html'), '<h1>x</h1>');
  }
  if (git) {
    await queries.upsertAppGitSource({
      appId: app.id,
      url: 'https://example.com/r.git',
      branch: 'main',
      webhookSecret: 'a'.repeat(64)
    });
  }
  return AppManager.getAppById(app.id);
}

// Keep claim()'s log files out of the repo's real data/ dir, and keep the
// self-update gate deterministic (a stale data/update.lock on the dev machine
// must never flip these 202s into 409s).
function stubClaimEnvironment() {
  mock.method(DeployJobs, 'logDir', () => tmp);
  mock.method(DeployJobs, 'isUpdateRunning', () => false);
}

async function waitForJob(appId, { timeoutMs = 3000 } = {}) {
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

test('POST /start returns 202 immediately while install is still running', async () => {
  const app = await makeApp('async-start-202');
  stubClaimEnvironment();
  const deployMock = mock.method(DeployManager, 'deployApp', async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return AppManager.getAppById(app.id);
  });

  const agent = await adminAgent();
  const startedAt = Date.now();
  const res = await agent.post(`/api/apps/${app.id}/start`);
  const elapsed = Date.now() - startedAt;

  assert.equal(res.status, 202);
  // The whole point of the task: the response must NOT wait for the deploy.
  // A faked deployApp hangs for 500ms, so any awaited variant blows past this.
  assert.ok(elapsed < 200, `202 took ${elapsed}ms — the route waited for the deploy`);
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.data, { app_id: app.id, kind: 'start', status: 'running' });

  // The 202 is backed by a real claimed job.
  const job = await queries.getDeployJob(app.id);
  assert.equal(job.status, 'running');
  assert.equal(job.kind, 'start');

  // Wiring contract: deployApp is called with { onStep, logFile }, the log
  // file being the claimed job's path inside the stubbed log dir.
  const [, options] = deployMock.mock.calls[0].arguments;
  assert.equal(typeof options.onStep, 'function');
  assert.equal(options.logFile, job.log_path);
  assert.ok(options.logFile.startsWith(tmp));
  assert.ok(fs.existsSync(options.logFile));

  await waitForJob(app.id);
  assert.equal(deployMock.mock.callCount(), 1);
});

test('a second start while the job is live returns 409', async () => {
  const app = await makeApp('async-start-busy');
  stubClaimEnvironment();
  const deployMock = mock.method(DeployManager, 'deployApp', async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return AppManager.getAppById(app.id);
  });

  const agent = await adminAgent();
  await agent.post(`/api/apps/${app.id}/start`).expect(202);

  const second = await agent.post(`/api/apps/${app.id}/start`).expect(409);
  // assertIdle's fixed message format (Task 11 i18n keys off it).
  assert.match(second.body.error.message, /部署进行中/);
  assert.match(second.body.error.message, /start/);

  await waitForJob(app.id);
  // The rejected second request never started a second deploy.
  assert.equal(deployMock.mock.callCount(), 1);
});

test('already-running app still returns 400 synchronously', async () => {
  const app = await makeApp('async-start-running');
  stubClaimEnvironment();
  const deployMock = mock.method(DeployManager, 'deployApp', async () => AppManager.getAppById(app.id));
  // The ONLY way to produce "running" in tests: reconcileStatus falls back to
  // the DB status when the PM2 CLI probe fails (pm2Exec is stubbed to ENOENT).
  mock.method(ProcessManager, 'getProcessStatus', async () => ({ exists: true, status: 'online' }));

  const agent = await adminAgent();
  const res = await agent.post(`/api/apps/${app.id}/start`).expect(400);
  assert.match(res.body.error.message, /already running/);

  assert.equal(deployMock.mock.callCount(), 0);
  assert.equal(await queries.getDeployJob(app.id), null);
});

test('a static app missing index.html still gets 400 synchronously', async () => {
  // Non-git app: validation is decidable without doing work, so it stays sync.
  const app = await makeApp('async-start-no-index', { indexHtml: false });
  fs.writeFileSync(path.join(app.path, 'README.txt'), 'no entry file here');
  stubClaimEnvironment();
  const deployMock = mock.method(DeployManager, 'deployApp', async () => AppManager.getAppById(app.id));

  const agent = await adminAgent();
  const res = await agent.post(`/api/apps/${app.id}/start`).expect(400);
  assert.match(res.body.error.message, /Missing index\.html/);

  assert.equal(deployMock.mock.callCount(), 0);
  assert.equal(await queries.getDeployJob(app.id), null);
});

test('a git-bound app does NOT get a synchronous missing-file 400', async () => {
  // The repo owns the content: an empty directory is NORMAL before the clone,
  // so the route must skip validation for git-bound apps and go straight to 202.
  const app = await makeApp('async-start-git-empty', { indexHtml: false, git: true });
  stubClaimEnvironment();
  mock.method(DeployManager, 'deployApp', async () => AppManager.getAppById(app.id));

  const agent = await adminAgent();
  const res = await agent.post(`/api/apps/${app.id}/start`).expect(202);
  assert.deepEqual(res.body.data, { app_id: app.id, kind: 'start', status: 'running' });

  await waitForJob(app.id);
});

test('git claim held by a background sync still yields 409 Update in progress', async () => {
  const app = await makeApp('async-start-git-syncing', { indexHtml: false, git: true });
  stubClaimEnvironment();
  const deployMock = mock.method(DeployManager, 'deployApp', async () => AppManager.getAppById(app.id));
  assert.equal(await queries.claimGitSync(app.id, config.git.staleSyncMs), true);

  const agent = await adminAgent();
  const res = await agent.post(`/api/apps/${app.id}/start`).expect(409);
  assert.equal(res.body.error.message, 'Update in progress');

  assert.equal(deployMock.mock.callCount(), 0);
  assert.equal(await queries.getDeployJob(app.id), null);

  await queries.finishGitSync(app.id, { status: 'success' });
});

test('the job converges to failed with the npm message when deployApp rejects', async () => {
  const app = await makeApp('async-start-fail');
  stubClaimEnvironment();
  mock.method(DeployManager, 'deployApp', async (_appId, { onStep } = {}) => {
    onStep('install');
    throw new Error('npm install failed: exit code 1');
  });

  const agent = await adminAgent();
  await agent.post(`/api/apps/${app.id}/start`).expect(202);

  const job = await waitForJob(app.id);
  assert.equal(job.status, 'failed');
  assert.equal(job.kind, 'start');
  assert.match(job.message, /npm install failed/);
  assert.ok(job.finished_at);
  // ctx.report really is DeployJobs.advance: the step the faked deploy
  // reported survived the rejection path.
  assert.equal(job.step, 'install');
  // A successful finish clears nothing here, but a failure must not leave the
  // app looking running either.
  const row = await queries.getAppById(app.id);
  assert.equal(row.status, 'stopped');
});

test('deployApp rejection never produces an unhandled rejection', async () => {
  const app = await makeApp('async-start-unhandled');
  stubClaimEnvironment();
  mock.method(DeployManager, 'deployApp', async (_appId, { onStep } = {}) => {
    onStep('install');
    throw new Error('build failed: boom');
  });

  const seen = [];
  const handler = (reason) => seen.push(reason);
  process.on('unhandledRejection', handler);
  try {
    const agent = await adminAgent();
    await agent.post(`/api/apps/${app.id}/start`).expect(202);
    await waitForJob(app.id);
    // Give any stray floating promise (advance/finish/prune) extra ticks to
    // surface before declaring the run clean.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', handler);
  }
  assert.deepEqual(seen, []);
});
