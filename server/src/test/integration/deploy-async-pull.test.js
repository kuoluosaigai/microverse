const { test, mock, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { adminAgent, queries, dbReady } = require('../helpers/setup');
const AppManager = require('../../services/app-manager');
const GitLifecycle = require('../../services/git-lifecycle');
const NpmLifecycle = require('../../services/npm-lifecycle');
const ProcessManager = require('../../services/process-manager');
const DeployJobs = require('../../services/deploy-jobs');
const config = require('../../config');

// Contract under test (Task 9): POST /apps/:id/git/pull answers 202 with a
// claimed 'pull' deploy job and runs the real GitLifecycle.sync in the
// background through DeployRunner — the same minutes-long fetch/reset/install/
// build chain start already runs async. Three legs are pinned here:
//  1. the job context (ctx.logFile / ctx.report) reaches sync and the npm
//     transcript lands in the job log file, visible via GET /:id/deploy —
//     not just for start;
//  2. app_git_source stays the OWNER of the outcome (last_status /
//     deployed_commit / last_error), the job row only reports progress;
//  3. both halves of the lost-git-race: the webhook's claim is answered 409
//     synchronously BEFORE any job is claimed, and a claim lost in between
//     (sync() returning 'busy') converges the job to failed, never running.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'microverse-async-pull-'));
const createdAppIds = [];

before(async () => { await dbReady; });
afterEach(() => mock.reset());
after(async () => {
  for (const id of createdAppIds) {
    try { await queries.deleteApp(id); } catch (_err) { /* best-effort */ }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const fileUrl = (dir) => 'file://' + path.resolve(dir).replace(/\\/g, '/');

function gitRun(args, cwd) {
  return GitLifecycle.gitExec(args, { cwd });
}

// Real local git repo as the remote (same shape as git-lifecycle-sync's
// helpers): the sync path runs against real git so the threading under test
// is the production one, down to ensureBuilt.
async function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one');
  await gitRun(['init', '-q', '-b', 'main'], dir);
  await gitRun(['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'add', '.'], dir);
  await gitRun(
    ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-qm', 'one'],
    dir
  );
}

async function commitTo(dir, content, message) {
  fs.writeFileSync(path.join(dir, 'a.txt'), content);
  await gitRun(['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'add', '.'], dir);
  await gitRun(
    ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-qm', message],
    dir
  );
}

async function makeGitApp(name) {
  const src = path.join(tmp, `${name}-src`);
  await makeRepo(src);

  const created = await AppManager.createApp(name, 'npm');
  createdAppIds.push(created.id);

  const appPath = path.join(tmp, `${name}-app`);
  await GitLifecycle.ensureRepo(appPath, { url: fileUrl(src), branch: 'main' });
  const prevSha = await GitLifecycle.currentHead(appPath);

  await queries.updateApp({ id: created.id, path: appPath });
  await queries.upsertAppGitSource({
    appId: created.id,
    url: fileUrl(src),
    branch: 'main',
    webhookSecret: 'test-secret'
  });
  await queries.finishGitSync(created.id, { status: 'success', deployedCommit: prevSha });

  const app = await AppManager.getAppById(created.id);
  return { app, src, appPath, prevSha };
}

// Keep claim()'s log files out of the repo's real data/ dir and make the
// self-update gate deterministic (same seams as deploy-async-start.test.js).
function stubClaimEnvironment() {
  mock.method(DeployJobs, 'logDir', () => tmp);
  mock.method(DeployJobs, 'isUpdateRunning', () => false);
}

// PM2 must look stopped: sync then builds but never restarts (and the test
// must not touch the real PM2 CLI).
function stoppedProcess() {
  mock.method(ProcessManager, 'getProcessStatus', async () => ({ exists: false, status: 'stopped' }));
}

async function waitForJob(appId, { timeoutMs = 5000 } = {}) {
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

test('POST /git/pull returns 202 while the sync is still running', async () => {
  const { app } = await makeGitApp('pull-202');
  stubClaimEnvironment();
  // The sync parks on a deferred the test owns (same machine-speed-
  // independent shape as start's 202 test): every assertion below runs
  // while the sync is demonstrably unfinished.
  let releaseSync;
  const gate = new Promise((resolve) => { releaseSync = resolve; });
  const syncCalls = [];
  mock.method(GitLifecycle, 'sync', async (a, opts) => {
    syncCalls.push({ app: a, opts });
    await gate;
    return { status: 'success', deployedCommit: 'abc123', error: null };
  });

  const agent = await adminAgent();
  // .timeout keeps the regression deterministic: if anyone reverts the route
  // to awaiting the sync, this request simply never answers, and the client
  // timeout reddens the test instead of hanging the runner.
  const res = await agent.post(`/api/apps/${app.id}/git/pull`).timeout(8000);

  assert.equal(res.status, 202);
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.data, { app_id: app.id, kind: 'pull', status: 'running' });

  // The 202 is backed by a real claimed job — still running, because the
  // sync is parked and nothing has released it.
  const job = await queries.getDeployJob(app.id);
  assert.equal(job.status, 'running');
  assert.equal(job.kind, 'pull');

  // Wiring contract: the route hands the job context through pull -> sync —
  // the claimed log file (same data/deploy-logs mechanism as start) and the
  // step reporter.
  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].app.id, app.id);
  const { opts } = syncCalls[0];
  assert.equal(opts.reason, 'manual');
  assert.equal(opts.logFile, job.log_path);
  assert.ok(opts.logFile.startsWith(tmp));
  assert.ok(fs.existsSync(opts.logFile));
  assert.equal(typeof opts.onStep, 'function');

  releaseSync();
  const done = await waitForJob(app.id);
  assert.equal(done.status, 'succeeded');
});

test('a pull while a start job holds the app is 409', async () => {
  const { app } = await makeGitApp('pull-job-busy');
  stubClaimEnvironment();
  const syncMock = mock.method(GitLifecycle, 'sync', async () => {
    throw new Error('a rejected pull must not start a sync');
  });

  // A live 'start' job on the same app — one row per app, so the pull can
  // never claim; assertIdle answers it synchronously.
  const claim = await DeployJobs.claim(app, DeployJobs.KINDS.START);
  assert.equal(claim.ok, true);

  const agent = await adminAgent();
  const res = await agent.post(`/api/apps/${app.id}/git/pull`).expect(409);
  assert.match(res.body.error.message, /部署进行中/);
  assert.match(res.body.error.message, /start/);
  assert.equal(syncMock.mock.callCount(), 0);
  assert.equal((await queries.getDeployJob(app.id)).kind, 'start', 'the held job is untouched');

  await DeployJobs.finish(app.id, { ok: true });
});

test('pull writes its npm output into the job log file', async () => {
  const { app, src } = await makeGitApp('pull-log');
  stubClaimEnvironment();
  stoppedProcess();
  await commitTo(src, 'two', 'two');
  const newSha = await GitLifecycle.currentHead(src);

  // The fake stands in for the minutes-long real npm install and asserts its
  // own input: if GitLifecycle drops the logFile threading on the pull path,
  // this throws (no transcript is written) and the tail assertion below
  // catches it.
  mock.method(NpmLifecycle, 'ensureBuilt', async (appId, appPath, opts) => {
    if (!opts || !opts.logFile) {
      throw new Error('pull lost the job log file before ensureBuilt');
    }
    fs.appendFileSync(opts.logFile, 'npm install: fake pull transcript\n');
  });

  const agent = await adminAgent();
  const res = await agent.post(`/api/apps/${app.id}/git/pull`).expect(202);
  assert.equal(res.body.data.kind, 'pull');

  const job = await waitForJob(app.id);
  assert.equal(job.status, 'succeeded');

  // Task 8's endpoint must be able to SHOW the pull transcript — decision 8
  // holds on the pull path, not only on start.
  const deploy = await agent.get(`/api/apps/${app.id}/deploy`).expect(200);
  assert.equal(deploy.body.data.job.kind, 'pull');
  assert.ok(
    deploy.body.data.logTail.includes('npm install: fake pull transcript'),
    `job log tail was: ${JSON.stringify(deploy.body.data.logTail)}`
  );
  assert.equal((await queries.getAppGitSource(app.id)).deployed_commit, newSha);
});

test('app_git_source still owns the outcome: last_status/deployed_commit/last_error', async () => {
  const { app, src } = await makeGitApp('pull-source-truth');
  stubClaimEnvironment();
  stoppedProcess();
  await commitTo(src, 'two', 'two');
  const newSha = await GitLifecycle.currentHead(src);
  mock.method(NpmLifecycle, 'ensureBuilt', async () => {});

  const agent = await adminAgent();
  await agent.post(`/api/apps/${app.id}/git/pull`).expect(202);
  const job = await waitForJob(app.id);

  // The job row reports progress only — kind/status/step, no commit truth.
  assert.equal(job.status, 'succeeded');
  assert.equal(job.kind, 'pull');
  assert.equal(job.step, 'done');

  // app_git_source is still the outcome owner, written by the unchanged sync
  // bookkeeping (finishGitSync), and the app response surfaces it (Task 8).
  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.last_status, 'success');
  assert.equal(source.deployed_commit, newSha);
  assert.equal(source.last_error, null);
  assert.equal(source.sync_started_at, null, 'the sync claim was released');

  const get = await agent.get(`/api/apps/${app.id}`).expect(200);
  assert.equal(get.body.data.git.last_status, 'success');
  assert.equal(get.body.data.git.deployed_commit, newSha);
});

test('rollback path still runs and its output lands in the same log', async () => {
  const { app, src, appPath, prevSha } = await makeGitApp('pull-rollback');
  stubClaimEnvironment();
  stoppedProcess();
  await commitTo(src, 'two', 'two');

  const calls = [];
  mock.method(NpmLifecycle, 'ensureBuilt', async (appId, p, opts) => {
    calls.push(opts);
    if (calls.length === 1) throw new Error('build failed: boom');
    // The rollback's forced repair rebuild must ALSO receive the job log.
    if (!opts || !opts.logFile) {
      throw new Error('rollback lost the job log file before ensureBuilt');
    }
    fs.appendFileSync(opts.logFile, 'rollback: forced rebuild transcript\n');
  });

  const agent = await adminAgent();
  await agent.post(`/api/apps/${app.id}/git/pull`).expect(202);
  const job = await waitForJob(app.id);

  // The failure converges the job (202 was already out); nothing is left
  // running and the error surfaces through the row.
  assert.equal(job.status, 'failed');
  assert.match(job.message, /boom/);

  // GitLifecycle's rollback semantics are untouched: worktree back to the
  // previous HEAD, and the repair rebuild ran force-gated...
  assert.equal(await GitLifecycle.currentHead(appPath), prevSha);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].force, true);
  // ...into the SAME job log file.
  const log = fs.readFileSync(job.log_path, 'utf8');
  assert.ok(log.includes('rollback: forced rebuild transcript'), `log was: ${JSON.stringify(log)}`);

  // Outcome truth still lives in app_git_source.
  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.last_status, 'failed');
  assert.match(source.last_error, /boom/);
  assert.equal(source.deployed_commit, prevSha);
});

test('a pull whose sync loses the git claim after the job was won converges the job to failed', async () => {
  const { app } = await makeGitApp('pull-busy-race');
  stubClaimEnvironment();
  // Background half: the route passed the synchronous isSyncInProgress gate,
  // the job got claimed and answered 202 — and only THEN a webhook delivery
  // won claimGitSync, so sync() really returns 'busy'. The 202 cannot be
  // revoked; the row must converge to failed, never stay running and never
  // report success.
  mock.method(GitLifecycle, 'sync', async () => ({
    status: 'busy', deployedCommit: null, error: null
  }));

  const agent = await adminAgent();
  await agent.post(`/api/apps/${app.id}/git/pull`).expect(202);

  const job = await waitForJob(app.id);
  assert.equal(job.status, 'failed');
  assert.match(job.message, /in progress/i);
  // The busy loser never released a claim it did not own.
  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.last_status, 'success');
});

test('a webhook sync holding the git claim is 409 before any job is claimed', async () => {
  const { app } = await makeGitApp('pull-git-claim-held');
  assert.equal(await queries.claimGitSync(app.id, config.git.staleSyncMs), true);
  stubClaimEnvironment();
  // Sync half (symmetric with start's identical guard): the common doomed
  // case is answered before the claim, so no job row exists afterwards.
  mock.method(DeployJobs, 'claim', async () => { throw new Error('must not claim'); });
  mock.method(GitLifecycle, 'sync', async () => { throw new Error('must not sync'); });

  const agent = await adminAgent();
  const res = await agent.post(`/api/apps/${app.id}/git/pull`).expect(409);
  assert.equal(res.body.error.message, 'Update in progress');
  assert.equal(await queries.getDeployJob(app.id), null);

  await queries.finishGitSync(app.id, { status: 'success' });
});
