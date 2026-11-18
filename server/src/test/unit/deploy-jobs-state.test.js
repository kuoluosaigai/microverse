const { test, before, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// setup must load first: it sets DB_PATH/APPS_DIR before server/src/db is required.
const { queries, dbReady } = require('../helpers/setup');
const { dbRun } = require('../../db');
const config = require('../../config');
const AppManager = require('../../services/app-manager');
const DeployJobs = require('../../services/deploy-jobs');

before(async () => { await dbReady; });

// A SQLite CURRENT_TIMESTAMP string: UTC, 'YYYY-MM-DD HH:MM:SS', no zone
// marker — exactly what getDeployJob hands to isLive().
function sqliteNow(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
}

// Redirect the log directory into a throwaway tmp dir and neutralize the
// update-lock probe for one test. Returns { dir } and registers the restore
// so no test ever writes into <repoRoot>/data or reads a real update.lock.
function isolate(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-logs-test-'));
  mock.method(DeployJobs, 'logDir', () => dir);
  mock.method(DeployJobs, 'isUpdateRunning', () => false);
  t.after(() => {
    mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir };
}

function dbError(code, message = 'mocked db failure') {
  const err = new Error(message);
  err.code = code;
  return err;
}

test('claim creates the log file and advances queued→…→done persisting each step', async (t) => {
  const app = await AppManager.createApp('jobs-state-happy', 'npm');
  const { dir } = isolate(t);

  const claimed = await DeployJobs.claim(app, DeployJobs.KINDS.START);
  assert.equal(claimed.ok, true);
  assert.equal(claimed.job.status, 'running');
  assert.equal(claimed.job.step, 'queued');
  assert.equal(claimed.job.kind, 'start');
  // The fencing pid is DeployJobs' own process — not a caller-visible value.
  assert.equal(claimed.job.pid, process.pid);
  // <app.name>-<epochMs>.log inside the (tmp) log dir, created only now.
  assert.match(path.basename(claimed.job.log_path), /^jobs-state-happy-\d+\.log$/);
  assert.equal(path.dirname(claimed.job.log_path), dir);
  assert.equal(fs.existsSync(claimed.job.log_path), true);

  // Every step in the ladder must round-trip through the DB row.
  for (const step of DeployJobs.STEPS.slice(1)) {
    await DeployJobs.advance(app.id, step);
    assert.equal((await queries.getDeployJob(app.id)).step, step);
  }

  await DeployJobs.finish(app.id, { ok: true });
  const row = await queries.getDeployJob(app.id);
  assert.equal(row.status, 'succeeded');
  assert.ok(row.finished_at);
});

test('claim returns busy when a live job holds the app', async (t) => {
  const app = await AppManager.createApp('jobs-state-busy', 'npm');
  isolate(t);

  const first = await DeployJobs.claim(app, DeployJobs.KINDS.START);
  assert.equal(first.ok, true);

  const second = await DeployJobs.claim(app, DeployJobs.KINDS.PULL);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'busy');
  assert.equal(second.job, undefined);
});

test('claim returns busy when the claim query throws SQLITE_BUSY', async (t) => {
  const app = await AppManager.createApp('jobs-state-sqlbusy', 'npm');
  const { dir } = isolate(t);
  mock.method(queries, 'claimDeployJob', async () => {
    throw dbError('SQLITE_BUSY', 'database is locked');
  });

  const res = await DeployJobs.claim(app, DeployJobs.KINDS.START);
  assert.deepEqual(res, { ok: false, reason: 'busy' });
  // A denied lock must not leave filesystem traces.
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('claim rethrows an unrelated DB failure', async (t) => {
  const app = await AppManager.createApp('jobs-state-rethrow', 'npm');
  const { dir } = isolate(t);
  mock.method(queries, 'claimDeployJob', async () => {
    throw dbError('SQLITE_CANTOPEN', 'unable to open database file');
  });

  // A real DB fault must not be disguised as "someone else is deploying".
  await assert.rejects(
    () => DeployJobs.claim(app, DeployJobs.KINDS.START),
    (err) => err.code === 'SQLITE_CANTOPEN'
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('claim returns updating when a live update.lock is held', async (t) => {
  const app = await AppManager.createApp('jobs-state-updating', 'npm');
  isolate(t);
  mock.method(DeployJobs, 'isUpdateRunning', () => true);

  const res = await DeployJobs.claim(app, DeployJobs.KINDS.START);
  assert.deepEqual(res, { ok: false, reason: 'updating' });
  // The gate runs before any DB touch: no job row was created.
  assert.equal(await queries.getDeployJob(app.id), null);
});

test('advance and finish are silent no-ops when the row vanished', async (t) => {
  const app = await AppManager.createApp('jobs-state-vanish', 'npm');
  isolate(t);
  const claimed = await DeployJobs.claim(app, DeployJobs.KINDS.START);
  assert.equal(claimed.ok, true);

  // App deleted mid-job: deleteApp's FK cascade removes the row.
  await dbRun('DELETE FROM app_deploy_job WHERE app_id = ?', [app.id]);

  await DeployJobs.advance(app.id, 'install');
  await DeployJobs.finish(app.id, { ok: false, message: 'boom' });
  // Both resolved quietly, and neither resurrected a row.
  assert.equal(await queries.getDeployJob(app.id), null);
});

test('isLive is false for a dead pid even inside the stale window', async (t) => {
  const base = { kind: 'start', step: 'install', started_at: sqliteNow() };
  // Control: our own live pid, fresh started_at -> live.
  assert.equal(DeployJobs.isLive({ ...base, status: 'running', pid: process.pid }), true);

  // A dead pid, mocked via process.kill ESRCH (deterministic; a bare number
  // could one day be a real process).
  mock.method(process, 'kill', () => { throw dbError('ESRCH'); });
  t.after(() => mock.restoreAll());
  assert.equal(DeployJobs.isLive({ ...base, status: 'running', pid: 424242 }), false);
});

test('isLive is false once the stale window passes despite a live pid', () => {
  const agedMs = -(config.deployment.deployJobStaleMs + 60_000);
  const base = { kind: 'start', step: 'install', pid: process.pid };
  assert.equal(
    DeployJobs.isLive({ ...base, status: 'running', started_at: sqliteNow(agedMs) }),
    false
  );
  // Terminal status is not live regardless of pid/time.
  assert.equal(
    DeployJobs.isLive({ ...base, status: 'succeeded', started_at: sqliteNow() }),
    false
  );
});

test('assertIdle throws a 409-stamped error naming the current step', async (t) => {
  const app = await AppManager.createApp('jobs-state-idle', 'npm');
  isolate(t);
  await DeployJobs.claim(app, DeployJobs.KINDS.START);
  await DeployJobs.advance(app.id, 'install');

  await assert.rejects(
    () => DeployJobs.assertIdle(app.id, '删除'),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.message, '部署进行中（start · install），请等待完成后再删除');
      return true;
    }
  );

  // Once finished, the same call resolves.
  await DeployJobs.finish(app.id, { ok: true });
  await DeployJobs.assertIdle(app.id, '删除');
});

test('tail strips ANSI escapes and caps lines and bytes', async (t) => {
  const app = await AppManager.createApp('jobs-state-tail', 'npm');
  isolate(t);
  const { job } = await DeployJobs.claim(app, DeployJobs.KINDS.START);

  // ~90KB of colored npm-style output: far past any sane byte window.
  const filler = 'x'.repeat(200);
  const ESI = String.fromCharCode(27); // ESC without control chars in source
  const lines = Array.from(
    { length: 400 },
    (_, i) => 'L' + i + ' ' + filler + ' ' + ESI + '[32mdone' + ESI + '[0m'
  );
  fs.writeFileSync(job.log_path, lines.join('\n') + '\n');
  assert.ok(fs.statSync(job.log_path).size > 80_000);

  const tail = await DeployJobs.tail(app.id, { lines: 3, maxBytes: 2048 });
  // Line cap.
  assert.equal(tail.length, 3);
  // ANSI stripped, visible text kept.
  assert.ok(tail.every((l) => !l.includes(ESI)));
  assert.ok(tail[0].includes('done'));
  // The head is gone — but note `lines: 3` alone cannot prove the read was
  // bounded: a whole-file slurp followed by slice(-3) returns the same three
  // lines. The discriminating assertion for "never read the whole file" is
  // `wide` below.
  assert.ok(Number(/^L(\d+)/.exec(tail[0])[1]) > 300, 'byte window must drop the head: ' + tail[0].slice(0, 8));
  assert.ok(tail[2].startsWith('L399'));

  // TRUE byte-cap discriminator: ask for far more lines than a 2KB window can
  // hold (~9 lines of ~224B each). A bounded seek-to-end read returns those;
  // a readFileSync + split + slice(-400) would return all 400.
  const wide = await DeployJobs.tail(app.id, { lines: 400, maxBytes: 2048 });
  assert.ok(wide.length >= 3 && wide.length < 15,
    `2048-byte window must cap the line count well below 400, got ${wide.length}`);

  // Default options must also be bounded (<= 200 lines from a 400-line file).
  const def = await DeployJobs.tail(app.id);
  assert.equal(def.length, 200);
  assert.ok(def[def.length - 1].startsWith('L399'));
});

test('tail returns [] when the log file does not exist', async (t) => {
  const app = await AppManager.createApp('jobs-state-tail-missing', 'npm');
  // No job at all -> nothing to tail.
  assert.deepEqual(await DeployJobs.tail(app.id), []);

  const { dir } = isolate(t);
  const { job } = await DeployJobs.claim(app, DeployJobs.KINDS.START);
  fs.rmSync(path.join(dir, path.basename(job.log_path)));
  // Row references a vanished file: a quiet [], never a throw.
  assert.deepEqual(await DeployJobs.tail(app.id), []);
});

test('claim still succeeds with log_path=null when the log directory cannot be created', async (t) => {
  const app = await AppManager.createApp('jobs-state-blocked', 'npm');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-logs-blocked-'));
  t.after(() => { mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); });
  // The log dir path exists as a REGULAR FILE: mkdirSync must fail (ENOTDIR).
  const blocked = path.join(root, 'deploy-logs');
  fs.writeFileSync(blocked, 'not a directory');
  mock.method(DeployJobs, 'logDir', () => blocked);
  mock.method(DeployJobs, 'isUpdateRunning', () => false);

  const res = await DeployJobs.claim(app, DeployJobs.KINDS.START);
  // A broken log must NEVER fail the deploy itself.
  assert.equal(res.ok, true);
  assert.equal(res.job.log_path, null);
  // And the row must not keep a phantom path either — readers stay quiet.
  assert.equal((await queries.getDeployJob(app.id)).log_path, null);
  assert.deepEqual(await DeployJobs.tail(app.id), []);
});

test('claim returns gone and unlinks its log file when the app row is deleted mid-claim', async (t) => {
  const app = await AppManager.createApp('jobs-state-gone', 'npm');
  const { dir } = isolate(t);
  // Simulate the race: claim wins (real INSERT, file really created), but the
  // read-back finds no row because the app was CASCADE-deleted in between.
  mock.method(queries, 'getDeployJob', async () => null);

  const res = await DeployJobs.claim(app, DeployJobs.KINDS.START);
  // Not a lie ('busy' — nobody holds a deploy), not an empty success
  // (ok:true would TypeErrors the first reader of job.log_path).
  assert.deepEqual(res, { ok: false, reason: 'gone' });
  // The freshly created log has no owner left to prune it: it must be gone.
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a losing claim creates no log file at all', async (t) => {
  const app = await AppManager.createApp('jobs-state-losing', 'npm');
  const { dir } = isolate(t);

  const first = await DeployJobs.claim(app, DeployJobs.KINDS.START);
  assert.equal(first.ok, true);
  const afterFirst = fs.readdirSync(dir);
  assert.equal(afterFirst.length, 1);

  const second = await DeployJobs.claim(app, DeployJobs.KINDS.PULL);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'busy');
  // The invariant this service exists for: losing == zero filesystem effect.
  assert.deepEqual(fs.readdirSync(dir), afterFirst);
});

test('pruneLogs keeps the newest N and leaves other apps alone', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-logs-prune-'));
  t.after(() => { mock.restoreAll(); fs.rmSync(dir, { recursive: true, force: true }); });
  mock.method(DeployJobs, 'logDir', () => dir);

  const base = 1_700_000_000_000;
  const name = (app, epoch) => app + '-' + epoch + '.log';
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(dir, name('prune-a', base + i)), 'x');
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(dir, name('prune-b', base + i)), 'x');
  // Not a job log for any app we touch — must survive everything below.
  fs.writeFileSync(path.join(dir, 'prune-a-notes.txt'), 'x');

  await DeployJobs.pruneLogs('prune-a');
  let names = fs.readdirSync(dir);
  // Default retention: the 5 NEWEST prune-a logs, oldest 3 gone.
  assert.equal(DeployJobs.LOG_RETENTION, 5);
  assert.deepEqual(
    names.filter((n) => n.startsWith('prune-a-')).sort(),
    [name('prune-a', base + 3), name('prune-a', base + 4), name('prune-a', base + 5),
     name('prune-a', base + 6), name('prune-a', base + 7), 'prune-a-notes.txt'].sort()
  );
  // Other app untouched — same 3 files.
  assert.equal(names.filter((n) => n.startsWith('prune-b-')).length, 3);

  // Explicit keep wins over the default.
  await DeployJobs.pruneLogs('prune-b', 1);
  names = fs.readdirSync(dir);
  assert.deepEqual(names.filter((n) => n.startsWith('prune-b-')), [name('prune-b', base + 2)]);
});