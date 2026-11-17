const { test, before } = require('node:test');
const assert = require('node:assert/strict');
// setup must load first: it sets DB_PATH/APPS_DIR before server/src/db is required.
const { queries, dbReady } = require('../helpers/setup');
const { dbRun, dbAll } = require('../../db');
const AppManager = require('../../services/app-manager');

before(async () => { await dbReady; });

// One claim() call shape for all tests; individual cases override only what
// the assertion is about (pid/logPath matter for the loser-clobber check,
// staleMs for the stale-window pair).
function claimArgs(appId, over = {}) {
  return {
    appId,
    kind: 'start',
    pid: 4242,
    logPath: 'data/deploy-logs/app-1.log',
    staleMs: 60_000,
    ...over
  };
}

test('claimDeployJob inserts a row on the very first claim (no pre-existing row)', async () => {
  const app = await AppManager.createApp('deploy-job-claim-a', 'npm');
  // Unlike app_git_source (a row exists once bound), app_deploy_job has NO
  // row before an app's first deploy — the claim must create it.
  assert.equal(await queries.getDeployJob(app.id), null);

  assert.equal(await queries.claimDeployJob(claimArgs(app.id)), true);

  const row = await queries.getDeployJob(app.id);
  assert.equal(row.status, 'running');
  assert.equal(row.kind, 'start');
  assert.equal(row.finished_at, null);
});

test('claimDeployJob refuses while another live job holds the app', async () => {
  const app = await AppManager.createApp('deploy-job-claim-b', 'npm');
  assert.equal(
    await queries.claimDeployJob(claimArgs(app.id, { pid: 1111, logPath: 'first.log' })),
    true
  );

  assert.equal(
    await queries.claimDeployJob(claimArgs(app.id, { pid: 2222, logPath: 'second.log' })),
    false
  );

  // The losing claim must be a pure no-op: it must not clobber the winner's
  // pid/log_path — the winner still owns the job and its log file.
  const row = await queries.getDeployJob(app.id);
  assert.equal(row.pid, 1111);
  assert.equal(row.log_path, 'first.log');
});

test('claimDeployJob takes over a terminal job and clears message/finished_at', async () => {
  const app = await AppManager.createApp('deploy-job-claim-c', 'npm');
  await queries.claimDeployJob(claimArgs(app.id));
  // finish is owner-fenced: only the claimant's pid may terminate the row.
  await queries.finishDeployJob(app.id, { status: 'failed', message: 'x', pid: 4242 });

  assert.equal(await queries.claimDeployJob(claimArgs(app.id)), true);

  const row = await queries.getDeployJob(app.id);
  assert.equal(row.status, 'running');
  // Stale failure text and finish time must not leak into the new run.
  assert.equal(row.message, null);
  assert.equal(row.finished_at, null);
});

test('claimDeployJob steals a job older than staleMs', async () => {
  const app = await AppManager.createApp('deploy-job-claim-d', 'npm');
  await queries.claimDeployJob(claimArgs(app.id));
  // Age the claim far past the stale window with raw SQL — a crashed worker
  // leaves exactly this shape, and no test-only hook may exist in queries.
  await dbRun(
    `UPDATE app_deploy_job SET started_at = datetime('now', '-9999 seconds') WHERE app_id = ?`,
    [app.id]
  );

  assert.equal(await queries.claimDeployJob(claimArgs(app.id, { staleMs: 1000 })), true);

  const row = await queries.getDeployJob(app.id);
  assert.equal(row.status, 'running');
});

test('claimDeployJob does not steal a job inside the stale window', async () => {
  const app = await AppManager.createApp('deploy-job-claim-e', 'npm');
  await queries.claimDeployJob(claimArgs(app.id));

  assert.equal(await queries.claimDeployJob(claimArgs(app.id, { staleMs: 60_000 })), false);
});

test('finish/updateStep on a missing row are no-ops that do not throw', async () => {
  // No app 999999 exists, so there is no job row: both writes must resolve
  // quietly (a post-crash finish racing a gone row must not throw in the
  // caller) and must not create a row as a side effect.
  await queries.finishDeployJob(999999, { status: 'failed', message: 'boom', pid: 4242 });
  assert.equal(await queries.getDeployJob(999999), null);

  const updated = await queries.updateDeployJobStep(999999, 'install', 4242);
  assert.equal(updated.changes, 0);
});

test('deleting the app cascades the job row away', async () => {
  const app = await AppManager.createApp('deploy-job-claim-f', 'npm');
  await queries.claimDeployJob(claimArgs(app.id));
  assert.ok(await queries.getDeployJob(app.id));

  await queries.deleteApp(app.id);
  assert.equal(await queries.getDeployJob(app.id), null);
});

// --- Owner fencing (Task 1 review gap) -------------------------------------
// Without `AND pid = ?` on the step/finish writes, a job stolen via the
// stale window (original worker still running, new worker already claimed)
// could be terminated by the ORIGINAL owner when it eventually finishes —
// writing a terminal status onto the new owner's in-flight row.

test("finishDeployJob by a foreign pid does not terminate the current owner's job", async () => {
  const app = await AppManager.createApp('deploy-job-fence-finish', 'npm');
  // A claim by "me" (the real pid, like DeployJobs.claim does)…
  assert.equal(
    await queries.claimDeployJob(claimArgs(app.id, { pid: process.pid })),
    true
  );
  // …then a stale-thief takes the row over (simulated by rewriting pid).
  await dbRun('UPDATE app_deploy_job SET pid = 4242 WHERE app_id = ?', [app.id]);

  // The original owner finishes with its own (now foreign) pid: no effect.
  await queries.finishDeployJob(app.id, { status: 'succeeded', pid: process.pid });

  const row = await queries.getDeployJob(app.id);
  assert.equal(row.status, 'running');
  assert.equal(row.finished_at, null);
  assert.equal(row.pid, 4242);

  // The actual current owner can still finish it.
  await queries.finishDeployJob(app.id, { status: 'succeeded', pid: 4242 });
  assert.equal((await queries.getDeployJob(app.id)).status, 'succeeded');
});

test('updateDeployJobStep by a foreign pid changes nothing', async () => {
  const app = await AppManager.createApp('deploy-job-fence-step', 'npm');
  assert.equal(
    await queries.claimDeployJob(claimArgs(app.id, { pid: process.pid })),
    true
  );
  await dbRun('UPDATE app_deploy_job SET pid = 4242 WHERE app_id = ?', [app.id]);

  const updated = await queries.updateDeployJobStep(app.id, 'install', process.pid);
  assert.equal(updated.changes, 0);
  assert.equal((await queries.getDeployJob(app.id)).step, 'queued');

  // The actual owner still advances its own row.
  assert.equal((await queries.updateDeployJobStep(app.id, 'install', 4242)).changes, 1);
  assert.equal((await queries.getDeployJob(app.id)).step, 'install');
});

// --- busy_timeout (Task 1 review gap) ---------------------------------------
// The platform runs under PM2 cluster and async deploys deliberately raise
// cross-worker write contention. node-sqlite3 ships an implicit 1000ms busy
// handler; the platform raises it explicitly to 5000ms (db/index.js) so a
// contended writer waits instead of rejecting with SQLITE_BUSY.
// (The harness serializes statements on ONE shared connection, so a live race
// cannot be proven here; the honest version is the PRAGMA read-back. It must
// assert >= 5000, not merely non-zero, because the driver default of 1000
// already satisfies non-zero — see the probe note in the task report.)

test('the db connection is opened with a busy_timeout so a contended writer waits instead of throwing', async () => {
  const rows = await dbAll('PRAGMA busy_timeout');
  assert.equal(rows.length, 1);
  assert.ok(
    rows[0].timeout >= 5000,
    `expected the platform busy_timeout (>= 5000ms), got ${rows[0].timeout}`
  );
});
