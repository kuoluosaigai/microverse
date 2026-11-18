const { test, before, mock } = require('node:test');
const assert = require('node:assert/strict');
// setup must load first: it sets DB_PATH/APPS_DIR before server/src/db is required.
const { queries, dbReady } = require('../helpers/setup');
const { dbRun } = require('../../db');
const config = require('../../config');
const AppManager = require('../../services/app-manager');
const DeployJobs = require('../../services/deploy-jobs');

before(async () => { await dbReady; });

// The fixed Chinese interruption message (Task 11's frontend displays this
// verbatim — the test pins it so a "rewording" here is a loud test failure).
const INTERRUPTED = '部署被中断（平台重启）';

// Create an app whose deploy-job row is already claimed by `pid` (raw query
// layer — no DeployJobs.claim, hence no filesystem and no update-lock probe).
// reconcileOnBoot converges the WHOLE table, so every row this file creates
// must leave again: t.after deletes it, keeping later tests' `converged`
// counts exact regardless of test order.
async function orphanJob(t, name, pid) {
  const app = await AppManager.createApp(name, 'npm');
  await queries.claimDeployJob({
    appId: app.id,
    kind: 'start',
    pid,
    logPath: 'orphan.log',
    staleMs: config.deployment.deployJobStaleMs
  });
  t.after(async () => {
    await dbRun('DELETE FROM app_deploy_job WHERE app_id = ?', [app.id]);
  });
  return app;
}

// Age a row's started_at past the stale window with raw SQL (same pattern as
// deploy-job-claim.test.js — no test-only hook may exist in queries).
async function agePastStale(appId) {
  const seconds = Math.ceil(config.deployment.deployJobStaleMs / 1000) + 60;
  await dbRun(
    `UPDATE app_deploy_job SET started_at = datetime('now', ?) WHERE app_id = ?`,
    [`-${seconds} seconds`, appId]
  );
}

test('reconcileOnBoot converges a dead-pid running job to failed with the interruption message', async (t) => {
  // 424242 stands in for a crashed worker; liveness is decided through the
  // injected probe, so the verdict does not depend on the pid lottery.
  const app = await orphanJob(t, 'boot-dead-pid', 424242);

  const { converged } = await DeployJobs.reconcileOnBoot({ isPidAlive: () => false });

  assert.equal(converged, 1);
  const row = await queries.getDeployJob(app.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.message, INTERRUPTED);
  assert.ok(row.finished_at, 'a converged row must carry a finish time');
});

test('reconcileOnBoot leaves a live job alone (another cluster worker owns it)', async (t) => {
  // No isPidAlive injection: this proves the DEFAULT path — process.pid is
  // by definition alive, standing in for a sibling cluster worker's job.
  const app = await orphanJob(t, 'boot-live-job', process.pid);

  const { converged } = await DeployJobs.reconcileOnBoot();

  assert.equal(converged, 0);
  const row = await queries.getDeployJob(app.id);
  assert.equal(row.status, 'running');
  assert.equal(row.message, null);
  assert.equal(row.finished_at, null);
});

test('reconcileOnBoot converges a live-pid job only once it is stale', async (t) => {
  const app = await orphanJob(t, 'boot-stale-job', process.pid);

  // Fresh + live pid = another worker's in-flight deploy: hands off.
  assert.deepEqual(await DeployJobs.reconcileOnBoot(), { converged: 0 });
  assert.equal((await queries.getDeployJob(app.id)).status, 'running');

  // Same live pid, but past the stale window (wedged worker): converge.
  await agePastStale(app.id);
  assert.deepEqual(await DeployJobs.reconcileOnBoot(), { converged: 1 });
  const row = await queries.getDeployJob(app.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.message, INTERRUPTED);
});

test('reconcileOnBoot reports a count and is idempotent when run twice', async (t) => {
  const appA = await orphanJob(t, 'boot-count-a', 424242);
  const appB = await orphanJob(t, 'boot-count-b', 424243);

  const first = await DeployJobs.reconcileOnBoot({ isPidAlive: () => false });
  assert.deepEqual(first, { converged: 2 });
  assert.equal((await queries.getDeployJob(appA.id)).status, 'failed');
  assert.equal((await queries.getDeployJob(appB.id)).status, 'failed');

  // Converged rows are terminal, so the input list no longer contains them:
  // a second boot (every cluster worker runs this) changes nothing.
  const second = await DeployJobs.reconcileOnBoot({ isPidAlive: () => false });
  assert.deepEqual(second, { converged: 0 });
  const rowA = await queries.getDeployJob(appA.id);
  assert.equal(rowA.status, 'failed');
  assert.equal(rowA.message, INTERRUPTED);
});

test("reconcileOnBoot writes through the row's own pid, not the booting process's", async (t) => {
  // THE critical case: a crashed worker's row. finish()/advance() fence on
  // process.pid, and a restarted process can never match a dead one's pid —
  // routing through finish() would silently change 0 rows (changes=0 is the
  // designed quiet behavior). Reconcile must pass the ROW's own pid to the
  // fenced query instead.
  const app = await orphanJob(t, 'boot-own-pid', 424242);

  // Make the silent no-op loud: if convergence "helpfully" goes through
  // DeployJobs.finish, this throws instead of quietly failing to fix rows.
  const finishSpy = mock.method(DeployJobs, 'finish', async () => {
    throw new Error('reconcileOnBoot must not route through finish()');
  });
  t.after(() => mock.restoreAll());

  const { converged } = await DeployJobs.reconcileOnBoot({ isPidAlive: () => false });

  assert.equal(finishSpy.mock.callCount(), 0);
  assert.equal(converged, 1);
  const row = await queries.getDeployJob(app.id);
  // The row really flipped…
  assert.equal(row.status, 'failed');
  assert.equal(row.message, INTERRUPTED);
  assert.ok(row.finished_at);
  // …and the fence value that let it flip was the row's own pid (finish
  // never rewrites pid, so 424242 here also rules out any takeover path).
  assert.equal(row.pid, 424242);
});

test('listNonTerminalDeployJobs returns only running rows and [] when there are none', async () => {
  // Task 1 review Minor 1: this query is reconcileOnBoot's ONLY input, so
  // its terminal-exclusion and empty-table shapes are pinned at the query
  // level, not just transitively through convergence tests.
  await dbRun('DELETE FROM app_deploy_job'); // this file's own temp DB

  const appA = await AppManager.createApp('boot-list-running', 'npm');
  const appB = await AppManager.createApp('boot-list-succeeded', 'npm');
  await queries.claimDeployJob({
    appId: appA.id, kind: 'start', pid: 424242, logPath: 'a.log',
    staleMs: config.deployment.deployJobStaleMs
  });
  await queries.claimDeployJob({
    appId: appB.id, kind: 'pull', pid: 424242, logPath: 'b.log',
    staleMs: config.deployment.deployJobStaleMs
  });
  await queries.finishDeployJob(appB.id, { status: 'succeeded', pid: 424242 });

  const rows = await queries.listNonTerminalDeployJobs();
  assert.equal(rows.length, 1, 'terminal rows must be excluded');
  assert.equal(rows[0].app_id, appA.id);
  assert.equal(rows[0].status, 'running');
  // The convergence write needs row.pid straight off this row — no extra
  // getDeployJob per candidate is allowed to depend on.
  assert.equal(rows[0].pid, 424242);
  assert.ok(rows[0].started_at);

  await queries.finishDeployJob(appA.id, { status: 'failed', message: INTERRUPTED, pid: 424242 });
  assert.deepEqual(await queries.listNonTerminalDeployJobs(), []);

  await dbRun('DELETE FROM app_deploy_job WHERE app_id IN (?, ?)', [appA.id, appB.id]);
});
