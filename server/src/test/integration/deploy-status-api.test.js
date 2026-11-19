const { test, mock, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { adminAgent, queries, dbReady } = require('../helpers/setup');
const config = require('../../config');
const AppManager = require('../../services/app-manager');
const DeployManager = require('../../services/deploy-manager');
const DeployJobs = require('../../services/deploy-jobs');

// Task 8 contract: every app object carries a `deploy` summary attached with
// ONE batched job read (never per-app), and GET /api/apps/:id/deploy serves
// that summary plus a bounded tail of the job log. The file also lands the
// obligations carried over from Task 6's review: the `done` step writer on
// success, the terminal guard on late step writes, and the single producer
// for the busy-409 wording.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'microverse-deploy-status-'));

before(async () => { await dbReady; });
afterEach(() => mock.reset());
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// Plain static app with a valid index.html: every route-driven test below must
// get past the start route's synchronous validation to reach its claim branch.
async function makeApp(name) {
  const app = await AppManager.createApp(name, 'http-server');
  fs.writeFileSync(path.join(app.path, 'index.html'), '<h1>x</h1>');
  return AppManager.getAppById(app.id);
}

// Keep claim()'s log files out of the repo's real data/ dir and make the
// self-update gate deterministic (same seams as deploy-async-start.test.js).
function stubClaimEnvironment() {
  mock.method(DeployJobs, 'logDir', () => tmp);
  mock.method(DeployJobs, 'isUpdateRunning', () => false);
}

// --- Step 0: the `done` writer and the terminal step guard -------------------

test('a succeeded job ends on the done step', async () => {
  const app = await AppManager.createApp('status-done-step', 'npm');
  stubClaimEnvironment();
  await DeployJobs.claim(app, DeployJobs.KINDS.START);
  await DeployJobs.advance(app.id, 'proxy'); // the last step a real deploy reports
  await DeployJobs.finish(app.id, { ok: true });

  const row = await queries.getDeployJob(app.id);
  assert.equal(row.status, 'succeeded');
  // Today nobody writes 'done': a green deploy would point at 'proxy' forever.
  // finish({ok:true}) must land the terminal step in the SAME UPDATE (no
  // finish-then-advance window for a late report to slip into).
  assert.equal(row.step, 'done');
});

test('a failed job keeps the step it failed on', async () => {
  const app = await AppManager.createApp('status-fail-step', 'npm');
  stubClaimEnvironment();
  await DeployJobs.claim(app, DeployJobs.KINDS.START);
  await DeployJobs.advance(app.id, 'install');
  await DeployJobs.finish(app.id, { ok: false, message: 'npm install failed: exit code 1' });

  const row = await queries.getDeployJob(app.id);
  assert.equal(row.status, 'failed');
  // The `done` write must be conditional on ok:true. Task 6's 'install'
  // assertion (deploy-async-start) depends on a failed job keeping its step —
  // "finish always writes done" would silently erase where the deploy died.
  assert.equal(row.step, 'install');
});

test('a late advance cannot overwrite a terminal row', async () => {
  const app = await AppManager.createApp('status-late-advance', 'npm');
  stubClaimEnvironment();
  await DeployJobs.claim(app, DeployJobs.KINDS.START);
  await DeployJobs.advance(app.id, 'proxy');
  await DeployJobs.finish(app.id, { ok: true });

  // 命门: the runner's step reports are fire-and-forget and node-sqlite3 runs
  // statements in parallel absent serialize() — a slow advance can still land
  // AFTER finish wrote the row terminal. The WHERE clause must fence on
  // status='running' (alongside the pid fence), not only on pid.
  const late = await DeployJobs.advance(app.id, 'proxy');
  assert.equal(late.changes, 0, 'a terminal row must accept no late step write');
  assert.equal((await queries.getDeployJob(app.id)).step, 'done');
});

// --- Step 0b: one producer for the busy-409 wording --------------------------

test('the claim-busy 409 message is produced by the same code path as assertIdle', async () => {
  const app = await makeApp('status-busy-wording');
  stubClaimEnvironment();
  // A real job row owned by a FOREIGN, dead pid: the route's assertIdle fast
  // path passes (liveness, not existence, gates it) and the mocked losing
  // claim drives the route's second busy producer — the exact race shape
  // where two workers claimed at once.
  await queries.claimDeployJob({
    appId: app.id,
    kind: 'start',
    pid: 4242,
    logPath: 'x.log',
    staleMs: config.deployment.deployJobStaleMs
  });
  await queries.updateDeployJobStep(app.id, 'install', 4242);
  mock.method(DeployJobs, 'isPidAlive', () => false);
  mock.method(DeployJobs, 'claim', async () => ({ ok: false, reason: 'busy' }));
  const deployMock = mock.method(DeployManager, 'deployApp', async () => ({}));

  const agent = await adminAgent();
  const res = await agent.post(`/api/apps/${app.id}/start`).expect(409);

  // Task 6's defect: the start route hand-copied assertIdle's format and
  // dropped the `· <step>` part — same 409, two wordings. Both paths must
  // now render through ONE producer (DeployJobs.busyMessage), and the
  // rendered message must name kind AND step, identical in shape to the
  // assertIdle message deploy-job-guard pins for the other nine endpoints.
  const row = await queries.getDeployJob(app.id);
  assert.equal(typeof DeployJobs.busyMessage, 'function', 'busyMessage must exist');
  assert.equal(res.body.error.message, DeployJobs.busyMessage(row, '启动'));
  assert.equal(res.body.error.message, '部署进行中（start · install），请等待完成后再启动');
  assert.equal(deployMock.mock.callCount(), 0, 'a losing claim never deploys');

  await queries.finishDeployJob(app.id, { status: 'succeeded', pid: 4242 });
});

// --- Step 0c: Task 6's three untested start-route claim branches ------------

test('claim reason gone yields 404 and never starts a background deploy', async () => {
  const app = await makeApp('status-claim-gone');
  stubClaimEnvironment();
  // The (already-deleted app) race is not reproducible single-process: drive
  // the route's reason->status mapping directly with a losing claim.
  mock.method(DeployJobs, 'claim', async () => ({ ok: false, reason: 'gone' }));
  const deployMock = mock.method(DeployManager, 'deployApp', async () => ({}));

  const agent = await adminAgent();
  const res = await agent.post(`/api/apps/${app.id}/start`).expect(404);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error.message, 'App not found');
  // The Task 6 contract: 'gone' must NOT 202 and must NOT run work.
  assert.equal(deployMock.mock.callCount(), 0);
});

test('claim reason updating yields 409 with the self-update wording', async () => {
  const app = await makeApp('status-claim-updating');
  stubClaimEnvironment();
  mock.method(DeployJobs, 'claim', async () => ({ ok: false, reason: 'updating' }));
  const deployMock = mock.method(DeployManager, 'deployApp', async () => ({}));

  const agent = await adminAgent();
  const res = await agent.post(`/api/apps/${app.id}/start`).expect(409);
  // The claim-gate wording, not the busy-job wording (Task 2's contract).
  assert.equal(res.body.error.message, '平台正在自更新，请稍后再试');
  assert.equal(deployMock.mock.callCount(), 0);
});

test('an unknown app id yields 404 without claiming', async () => {
  // claim() is a trap here: reaching it means getAppById did not short-circuit
  // the way the route contract says it must.
  const claimSpy = mock.method(DeployJobs, 'claim', async () => {
    throw new Error('claim must never run for an unknown app');
  });

  const agent = await adminAgent();
  const gone = await agent.post('/api/apps/999999/start').expect(404);
  assert.equal(gone.body.error.message, 'App not found');
  assert.equal(claimSpy.mock.callCount(), 0);
});

// --- Step 1: the deploy summary and GET /apps/:id/deploy --------------------

test('GET /apps attaches deploy=null for an untouched app', async () => {
  const app = await makeApp('status-untouched');
  const agent = await adminAgent();

  const res = await agent.get('/api/apps').expect(200);
  const entry = res.body.data.find((a) => a.id === app.id);
  assert.ok(entry, 'the app is listed');
  assert.ok('deploy' in entry, 'every app object carries the deploy key');
  assert.equal(entry.deploy, null);
});

test('GET /apps/:id exposes the live job step', async () => {
  const app = await makeApp('status-live-step');
  stubClaimEnvironment();
  await DeployJobs.claim(app, DeployJobs.KINDS.START);
  await DeployJobs.advance(app.id, 'install');

  const agent = await adminAgent();
  const res = await agent.get(`/api/apps/${app.id}`).expect(200);
  const deploy = res.body.data.deploy;
  assert.equal(deploy.kind, 'start');
  assert.equal(deploy.status, 'running');
  assert.equal(deploy.step, 'install');
  assert.equal(deploy.message, null);
  assert.ok(deploy.startedAt);
  assert.equal(deploy.finishedAt, null);
  // live is DeployJobs.isLive's verdict (owner pid alive, fresh, non-terminal)
  // — never keyed on status alone (the 40-minute-lockout class of bug).
  assert.equal(deploy.live, true);
  // camelCase contract, and nothing else: no snake_case column, no pid or
  // log_path leaking to the client.
  assert.deepEqual(
    Object.keys(deploy).sort(),
    ['finishedAt', 'kind', 'live', 'message', 'startedAt', 'status', 'step']
  );
});

test('deploy summary survives a terminal job (message shown after failure)', async () => {
  const app = await makeApp('status-terminal-summary');
  stubClaimEnvironment();
  await DeployJobs.claim(app, DeployJobs.KINDS.START);
  await DeployJobs.advance(app.id, 'install');
  await DeployJobs.finish(app.id, { ok: false, message: 'npm install failed: exit code 1' });

  const agent = await adminAgent();
  const res = await agent.get('/api/apps').expect(200);
  const deploy = res.body.data.find((a) => a.id === app.id).deploy;
  // The row is terminal but NOT cleared: the operator's dashboard must still
  // show what just failed and where.
  assert.equal(deploy.status, 'failed');
  assert.equal(deploy.message, 'npm install failed: exit code 1');
  assert.equal(deploy.step, 'install');
  assert.equal(deploy.live, false);
  assert.ok(deploy.finishedAt);
});

test('the summary is one query, not one per app', async () => {
  const agent = await adminAgent();

  // Count every app_deploy_job READ the list endpoint could perform, once
  // the counter covers only the GET itself (makeApp's getAppById reads happen
  // with the spy installed too — reset the counters right after setup).
  let batchReads = 0;
  let singleReads = 0;
  const realBatch = queries.getDeployJobsByAppIds;
  const realSingle = queries.getDeployJob;
  mock.method(queries, 'getDeployJobsByAppIds', (ids) => {
    batchReads += 1;
    return realBatch(ids);
  });
  mock.method(queries, 'getDeployJob', (id) => {
    singleReads += 1;
    return realSingle(id);
  });

  for (let i = 0; i < 3; i++) await makeApp(`status-n1-${i}`);
  batchReads = 0;
  singleReads = 0;
  await agent.get('/api/apps').expect(200);
  assert.equal(batchReads, 1, 'exactly one batch job read per list request');
  assert.equal(singleReads, 0, 'the list summary must never read a per-app job');

  // Doubling the apps must not move the count — the N+1 shape fails this arm.
  for (let i = 3; i < 6; i++) await makeApp(`status-n1-${i}`);
  batchReads = 0;
  singleReads = 0;
  const second = await agent.get('/api/apps').expect(200);
  assert.equal(second.body.data.length >= 6, true);
  assert.equal(batchReads, 1, 'the batch read must not scale with the app count');
  assert.equal(singleReads, 0);
});

test('GET /apps/:id/deploy returns the bounded ANSI-stripped tail', async () => {
  const app = await makeApp('status-deploy-tail');
  stubClaimEnvironment();
  const { job } = await DeployJobs.claim(app, DeployJobs.KINDS.START);
  await DeployJobs.advance(app.id, 'install');

  // 300 colored lines — past the default 200-line cap, proof the tail is
  // bounded, and ANSI must be stripped exactly like DeployJobs.tail does.
  const ESI = String.fromCharCode(27); // ESC without control chars in source
  const lines = Array.from(
    { length: 300 },
    (_, i) => `L${i} ${ESI}[31mboom${ESI}[0m`
  );
  fs.writeFileSync(job.log_path, lines.join('\n') + '\n');

  const agent = await adminAgent();
  const res = await agent.get(`/api/apps/${app.id}/deploy`).expect(200);
  assert.equal(res.body.success, true);
  // The SAME summary shape as the attached field (one producer, toDeploySummary).
  assert.equal(res.body.data.job.step, 'install');
  assert.equal(res.body.data.job.live, true);
  const tail = res.body.data.logTail;
  assert.equal(tail.length, 200, 'default line cap keeps the payload bounded');
  assert.ok(tail.every((l) => !l.includes(ESI)), 'ANSI stripped');
  assert.ok(tail[0].startsWith('L100'), `head must be dropped, got ${tail[0]}`);
  assert.ok(tail[tail.length - 1].startsWith('L299'));
});

test('GET /apps/:id/deploy returns an empty logTail when no log exists yet', async () => {
  const agent = await adminAgent();

  // (a) never-deployed app: no job row at all — job null AND a quiet [].
  const fresh = await makeApp('status-deploy-nolog');
  const res1 = await agent.get(`/api/apps/${fresh.id}/deploy`).expect(200);
  assert.equal(res1.body.data.job, null);
  assert.deepEqual(res1.body.data.logTail, []);

  // (b) claimed job whose log file vanished: readers must get [], never throw.
  const app = await makeApp('status-deploy-loggone');
  stubClaimEnvironment();
  const { job } = await DeployJobs.claim(app, DeployJobs.KINDS.START);
  fs.rmSync(job.log_path);
  const res2 = await agent.get(`/api/apps/${app.id}/deploy`).expect(200);
  assert.deepEqual(res2.body.data.logTail, []);
  assert.equal(res2.body.data.job.status, 'running');
});

test('GET /apps/:id/deploy on an unknown app is 404', async () => {
  const agent = await adminAgent();
  const res = await agent.get('/api/apps/999999/deploy').expect(404);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error.message, 'App not found');
});

test('getDeployJobsByAppIds returns one row per app and [] for an empty id list', async () => {
  const appA = await AppManager.createApp('status-batch-a', 'npm');
  const appB = await AppManager.createApp('status-batch-b', 'npm');
  const appC = await AppManager.createApp('status-batch-c', 'npm');
  stubClaimEnvironment();
  await DeployJobs.claim(appA, DeployJobs.KINDS.START);
  await DeployJobs.claim(appB, DeployJobs.KINDS.PULL);

  // Task 1 review leftover, now committed coverage: this query is the ONLY
  // implementation keeping the summary off N+1, and the empty-list branch
  // matters because `IN ()` is a SQL syntax error — a refactor dropping the
  // guard would break at runtime, not at load.
  const rows = await queries.getDeployJobsByAppIds([appA.id, appB.id, appC.id]);
  assert.equal(rows.length, 2, 'one row per app WITH a job; none invented for the third');
  assert.deepEqual(rows.map((r) => r.app_id).sort(), [appA.id, appB.id].sort());
  assert.equal(rows.find((r) => r.app_id === appB.id).kind, 'pull');
  assert.deepEqual(await queries.getDeployJobsByAppIds([]), []);
});
