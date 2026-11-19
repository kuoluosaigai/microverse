const { test, before, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// setup must load first: it sets DB_PATH/APPS_DIR before server/src/db is
// required. This file exercises BOTH sides of the deploy-job state (real
// claims against the temp DB) and UpdateManager's real lock probe — every
// artifact stays under tmp dirs, the repo's data/ is never touched.
const { queries, dbReady } = require('../helpers/setup');
const { dbRun } = require('../../db');
const config = require('../../config');
const AppManager = require('../../services/app-manager');
const DeployJobs = require('../../services/deploy-jobs');
const UpdateManager = require('../../services/update-manager');

before(async () => { await dbReady; });

const SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);

// A throwaway repo root: update.lock / update-state.json live inside a tmp
// dir (UpdateManager.getPaths creates data/ under it), never the real one.
function tmpUpdatePaths() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-excl-update-'));
  const paths = UpdateManager.getPaths(repoRoot);
  paths._root = repoRoot;
  return paths;
}

// Redirect deploy-job log files into a tmp dir so claim() never writes under
// the real repoRoot/data/deploy-logs (same seam deploy-jobs-state isolate()
// uses).
function isolateLogDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-excl-logs-'));
  mock.method(DeployJobs, 'logDir', () => dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
}

// Make everything preflight checks BEFORE the deploy-job guard pass, so a
// refusal can only come from the guard itself.
function stubUntilGuard(t) {
  const orig = config.selfUpdate.enabled;
  config.selfUpdate.enabled = true;
  t.after(() => { config.selfUpdate.enabled = orig; });
  mock.method(UpdateManager, 'isPlatformSupported', () => true);
  mock.method(UpdateManager, 'isUpdateRunning', () => false);
}

// The remaining preflight checks (git tree, remote, PM2), stubbed so a
// green-light past the guard is provable all the way to ok:true.
function stubRestOfPreflight() {
  mock.method(UpdateManager, 'execFileAsync', async (file, args) => {
    const cmd = args.join(' ');
    switch (cmd) {
      case 'rev-parse --is-inside-work-tree': return { stdout: 'true\n', stderr: '' };
      case 'rev-parse HEAD': return { stdout: SHA + '\n', stderr: '' };
      case 'log -1 --format=%cI': return { stdout: '2026-11-01T00:00:00+00:00\n', stderr: '' };
      case 'status --porcelain --untracked-files=no': return { stdout: '', stderr: '' };
      case 'rev-parse --is-shallow-repository': return { stdout: 'false\n', stderr: '' };
      default: return { stdout: '', stderr: '' };
    }
  });
  mock.method(UpdateManager, 'getLatestVersion', async () => ({
    sha: NEW_SHA, shortSha: NEW_SHA.slice(0, 7), checkedAt: new Date().toISOString()
  }));
  mock.method(UpdateManager, 'isPm2Online', async () => true);
}

test('preflight refuses an update while a deploy job is live', async (t) => {
  const app = await AppManager.createApp('excl-live-job', 'npm');
  isolateLogDir(t);
  mock.method(DeployJobs, 'isUpdateRunning', () => false);
  const claim = await DeployJobs.claim(app, DeployJobs.KINDS.START);
  assert.equal(claim.ok, true, 'baseline: claim must succeed for the guard to see it');
  await DeployJobs.advance(app.id, 'install');

  stubUntilGuard(t);
  try {
    const r = await UpdateManager.preflight();
    // The operator deciding whether to wait needs the blocking app and its
    // step, not just "busy" — exact string is the contract (Task 11 keys off
    // preflight refusals verbatim).
    assert.deepEqual(r, {
      ok: false,
      httpStatus: 409,
      message: '有应用正在部署（excl-live-job · install），请等待完成'
    });
  } finally {
    await DeployJobs.finish(app.id, { ok: false, message: 'cleanup' });
    mock.restoreAll();
  }
});

test('preflight allows the update once the job is dead-pid stale', async (t) => {
  const app = await AppManager.createApp('excl-stale-job', 'npm');
  isolateLogDir(t);
  mock.method(DeployJobs, 'isUpdateRunning', () => false);
  const claim = await DeployJobs.claim(app, DeployJobs.KINDS.START);
  assert.equal(claim.ok, true);
  // The owner "crashed": row still non-terminal and fresh, but its pid is
  // dead — isLive demotes it immediately, so the guard must release. Without
  // the pid demotion this would block updates until the stale window ends.
  await dbRun('UPDATE app_deploy_job SET pid = 999999 WHERE app_id = ?', [app.id]);
  mock.method(DeployJobs, 'isPidAlive', (pid) => pid !== 999999);

  stubUntilGuard(t);
  stubRestOfPreflight();
  try {
    const r = await UpdateManager.preflight();
    assert.deepEqual(r, { ok: true, fromSha: SHA, toSha: NEW_SHA });
  } finally {
    await dbRun('DELETE FROM app_deploy_job WHERE app_id = ?', [app.id]);
    mock.restoreAll();
  }
});

test('claiming a deploy job is refused while update.lock is live', async (t) => {
  const app = await AppManager.createApp('excl-claim-live-lock', 'npm');
  isolateLogDir(t);
  const paths = tmpUpdatePaths();
  t.after(() => fs.rmSync(paths._root, { recursive: true, force: true }));
  fs.writeFileSync(paths.lockPath, JSON.stringify({
    pid: process.pid, startedAt: new Date().toISOString()
  }));
  // NO mock of isUpdateRunning anywhere: claim()'s gate must reach the REAL
  // UpdateManager lock probe through the lazy accessor, with only the paths
  // redirected into a tmp dir.
  mock.method(UpdateManager, 'getPaths', () => paths);
  try {
    const res = await DeployJobs.claim(app, DeployJobs.KINDS.PULL);
    assert.deepEqual(res, { ok: false, reason: 'updating' });
    // The gate runs before the DB claim: no job row exists.
    assert.equal(await queries.getDeployJob(app.id), null);
  } finally {
    mock.restoreAll();
  }
});

test('claiming succeeds when the lock is stale', async (t) => {
  const app = await AppManager.createApp('excl-claim-stale-lock', 'npm');
  isolateLogDir(t);
  const paths = tmpUpdatePaths();
  t.after(() => fs.rmSync(paths._root, { recursive: true, force: true }));
  fs.writeFileSync(paths.lockPath, JSON.stringify({
    pid: 999999, startedAt: new Date().toISOString()
  }));
  // Dead owner pid (same convention update-manager.test.js pins): the lock
  // is stale and must NOT keep blocking deploys forever.
  mock.method(UpdateManager, 'getPaths', () => paths);
  mock.method(UpdateManager, 'isPidAlive', () => false);
  try {
    const res = await DeployJobs.claim(app, DeployJobs.KINDS.START);
    assert.equal(res.ok, true, 'a stale lock is no block');
    assert.ok(res.job);
  } finally {
    await DeployJobs.finish(app.id, { ok: false, message: 'cleanup' });
    mock.restoreAll();
  }
});
