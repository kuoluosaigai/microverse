const { test, mock, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { queries, dbReady } = require('../helpers/setup');
const { dbRun } = require('../../db');
const AppManager = require('../../services/app-manager');
const DeployManager = require('../../services/deploy-manager');
const GitLifecycle = require('../../services/git-lifecycle');
const NpmLifecycle = require('../../services/npm-lifecycle');
const ProcessManager = require('../../services/process-manager');
const ProxyManager = require('../../services/proxy-manager');
const config = require('../../config');

before(async () => { await dbReady; });
afterEach(() => mock.reset());

const createdAppIds = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'microverse-git-start-'));

after(async () => {
  for (const id of createdAppIds) {
    try { await queries.deleteApp(id); } catch (_err) { /* best-effort */ }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const fileUrl = (dir) => 'file://' + path.resolve(dir).replace(/\\/g, '/');

async function makeRepo(dir, content) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), content);
  await GitLifecycle.gitExec(['init', '-q', '-b', 'main'], { cwd: dir });
  await GitLifecycle.gitExec(['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'add', '.'], { cwd: dir });
  await GitLifecycle.gitExec(['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-qm', content], { cwd: dir });
}

async function commitTo(dir, content) {
  fs.writeFileSync(path.join(dir, 'a.txt'), content);
  await GitLifecycle.gitExec(['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-qam', content], { cwd: dir });
}

// Real DB row + real app directory containing the files its deploy type
// validates, and a real app_git_source binding.
async function makeApp(name, { deployType = 'http-server' } = {}) {
  const app = await AppManager.createApp(name, deployType);
  createdAppIds.push(app.id);

  if (deployType === 'npm') {
    fs.writeFileSync(
      path.join(app.path, 'package.json'),
      JSON.stringify({ scripts: { start: 'node index.js' } })
    );
  } else {
    fs.writeFileSync(path.join(app.path, 'index.html'), '<h1>x</h1>');
  }

  await queries.upsertAppGitSource({
    appId: app.id,
    url: 'https://example.com/repo.git',
    branch: 'main',
    webhookSecret: 'test-secret'
  });

  return AppManager.getAppById(app.id);
}

// PM2 reports nothing running (reconcile keeps DB truth), lifecycle launches
// are recorded, and the edge-proxy reload is stubbed.
function mockStartEnvironment() {
  const calls = { start: [], restart: [] };
  mock.method(ProcessManager, 'getProcessStatus', async () => ({ exists: false, status: 'stopped' }));
  mock.method(ProcessManager, 'startProcess', async (app) => { calls.start.push(app.name); return { success: true }; });
  mock.method(ProcessManager, 'restartProcess', async (name) => { calls.restart.push(name); return { success: true }; });
  mock.method(ProcessManager, 'deleteProcess', async () => ({ success: true }));
  mock.method(ProxyManager, 'regenerate', async () => ({ ok: true }));
  return calls;
}

test('start claims and releases the git source on success', async () => {
  const app = await makeApp('git-start-ok', { deployType: 'npm' });
  const calls = mockStartEnvironment();
  let builds = 0;
  mock.method(NpmLifecycle, 'ensureBuilt', async () => { builds += 1; });
  const prepared = [];
  mock.method(GitLifecycle, 'prepareForStart', async (a, source) => {
    prepared.push({ app: a, source });
    return { commit: 'sha1', warning: null };
  });

  const started = await DeployManager.deployApp(app.id);

  assert.equal(started.status, 'running');
  assert.equal(builds, 1);
  assert.deepEqual(calls.start, [app.name]);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].app.id, app.id);
  assert.equal(prepared[0].source.url, 'https://example.com/repo.git');

  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.last_status, 'success');
  assert.equal(source.deployed_commit, 'sha1');
  assert.equal(source.sync_started_at, null);
});

test('start releases the claim as failed when prepareForStart throws', async () => {
  const app = await makeApp('git-start-clone-fail');
  const calls = mockStartEnvironment();
  mock.method(GitLifecycle, 'prepareForStart', async () => {
    throw new Error('git clone failed');
  });

  await assert.rejects(() => DeployManager.deployApp(app.id), /git clone failed/);
  assert.equal(calls.start.length, 0);

  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.last_status, 'failed');
  assert.match(source.last_error, /git clone failed/);
  assert.equal(source.sync_started_at, null);
});

test('start still starts when fetch failed but a checkout exists', async () => {
  const app = await makeApp('git-start-fetch-warn');
  const calls = mockStartEnvironment();
  mock.method(GitLifecycle, 'prepareForStart', async () => ({
    commit: 'sha1',
    warning: 'fetch failed: network unreachable'
  }));

  const started = await DeployManager.deployApp(app.id);

  assert.equal(started.status, 'running');
  assert.deepEqual(calls.start, [app.name]);

  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.last_status, 'success');
  assert.equal(source.deployed_commit, 'sha1');
  assert.equal(source.sync_started_at, null);
});

test('start/restart/delete reject a fresh updating claim', async () => {
  const app = await makeApp('git-guard-updating');
  mockStartEnvironment();
  mock.method(GitLifecycle, 'prepareForStart', async () => ({ commit: 'sha1', warning: null }));

  assert.equal(await queries.claimGitSync(app.id, config.git.staleSyncMs), true);
  try {
    await assert.rejects(() => DeployManager.deployApp(app.id), /Update in progress/);
    await assert.rejects(() => DeployManager.restartApp(app.id), /Update in progress/);
    await assert.rejects(() => DeployManager.deleteApp(app.id), /Update in progress/);
  } finally {
    // The rejected start must not have released the guard's claim.
    const source = await queries.getAppGitSource(app.id);
    assert.equal(source.last_status, 'updating');
    assert.ok(source.sync_started_at);
    await queries.finishGitSync(app.id, { status: 'failed', error: 'cleanup' });
  }
});

test('an expired updating claim does not block start', async () => {
  const app = await makeApp('git-stale-claim');
  const calls = mockStartEnvironment();
  mock.method(GitLifecycle, 'prepareForStart', async () => ({ commit: 'sha2', warning: null }));

  assert.equal(await queries.claimGitSync(app.id, config.git.staleSyncMs), true);
  await dbRun(
    "UPDATE app_git_source SET sync_started_at = datetime('now', '-2 hours') WHERE app_id = ?",
    [app.id]
  );

  const started = await DeployManager.deployApp(app.id);

  assert.equal(started.status, 'running');
  assert.deepEqual(calls.start, [app.name]);

  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.last_status, 'success');
  assert.equal(source.deployed_commit, 'sha2');
  assert.equal(source.sync_started_at, null);
});

// --- prepareForStart against real local repositories (not mocked) -----------

test('prepareForStart clones a missing checkout', async () => {
  const src = path.join(tmp, 'prep-clone-src');
  await makeRepo(src, 'one');
  const dst = path.join(tmp, 'prep-clone-app');

  const prepared = await GitLifecycle.prepareForStart(
    { path: dst },
    { url: fileUrl(src), branch: 'main', auto_update: 1 }
  );

  assert.equal(prepared.warning, null);
  assert.equal(prepared.commit, await GitLifecycle.currentHead(src));
  assert.equal(fs.readFileSync(path.join(dst, 'a.txt'), 'utf8'), 'one');
});

test('prepareForStart does not fetch when auto_update is off', async () => {
  const src = path.join(tmp, 'prep-noauto-src');
  await makeRepo(src, 'one');
  const dst = path.join(tmp, 'prep-noauto-app');
  await GitLifecycle.ensureRepo(dst, { url: fileUrl(src), branch: 'main' });
  const oldSha = await GitLifecycle.currentHead(dst);

  await commitTo(src, 'two');

  const prepared = await GitLifecycle.prepareForStart(
    { path: dst },
    { url: fileUrl(src), branch: 'main', auto_update: 0 }
  );

  assert.equal(prepared.commit, oldSha);
  assert.equal(prepared.warning, null);
  assert.equal(fs.readFileSync(path.join(dst, 'a.txt'), 'utf8'), 'one');
});

test('prepareForStart fetches and hard-resets when auto_update is on', async () => {
  const src = path.join(tmp, 'prep-auto-src');
  await makeRepo(src, 'one');
  const dst = path.join(tmp, 'prep-auto-app');
  await GitLifecycle.ensureRepo(dst, { url: fileUrl(src), branch: 'main' });

  await commitTo(src, 'two');
  const newSha = await GitLifecycle.currentHead(src);

  const prepared = await GitLifecycle.prepareForStart(
    { path: dst },
    { url: fileUrl(src), branch: 'main', auto_update: 1 }
  );

  assert.equal(prepared.commit, newSha);
  assert.equal(prepared.warning, null);
  assert.equal(fs.readFileSync(path.join(dst, 'a.txt'), 'utf8'), 'two');
});

test('prepareForStart warns and keeps the checkout when the fetch fails', async () => {
  const src = path.join(tmp, 'prep-fail-src');
  await makeRepo(src, 'one');
  const dst = path.join(tmp, 'prep-fail-app');
  await GitLifecycle.ensureRepo(dst, { url: fileUrl(src), branch: 'main' });
  const oldSha = await GitLifecycle.currentHead(dst);

  const prepared = await GitLifecycle.prepareForStart(
    { path: dst },
    { url: fileUrl(path.join(tmp, 'prep-fail-missing')), branch: 'main', auto_update: 1 }
  );

  assert.equal(prepared.commit, oldSha);
  assert.match(prepared.warning, /^fetch failed:/);
  assert.equal(fs.readFileSync(path.join(dst, 'a.txt'), 'utf8'), 'one');
});

test('prepareForStart honors a re-bound URL on an existing checkout', async () => {
  const srcA = path.join(tmp, 'prep-rebind-a');
  await makeRepo(srcA, 'alpha');
  const srcB = path.join(tmp, 'prep-rebind-b');
  await makeRepo(srcB, 'bravo');
  const shaB = await GitLifecycle.currentHead(srcB);

  const dst = path.join(tmp, 'prep-rebind-app');
  await GitLifecycle.ensureRepo(dst, { url: fileUrl(srcA), branch: 'main' });

  const prepared = await GitLifecycle.prepareForStart(
    { path: dst },
    { url: fileUrl(srcB), branch: 'main', auto_update: 1 }
  );

  assert.equal(prepared.commit, shaB);
  assert.equal(fs.readFileSync(path.join(dst, 'a.txt'), 'utf8'), 'bravo');
});
