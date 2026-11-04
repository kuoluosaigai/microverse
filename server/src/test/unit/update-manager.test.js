const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const UpdateManager = require('../../services/update-manager');
const ProcessManager = require('../../services/process-manager');
const config = require('../../config');

const SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);

function tmpPaths() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-update-'));
  return UpdateManager.getPaths(repoRoot);
}

function makeChild(pid) {
  const child = new EventEmitter();
  if (pid !== undefined) child.pid = pid;
  child.unref = () => {};
  return child;
}

function stubGit(overrides = {}) {
  return mock.method(UpdateManager, 'execFileAsync', async (file, args) => {
    const cmd = args.join(' ');
    if (overrides[cmd]) return overrides[cmd];
    switch (cmd) {
      case 'rev-parse --is-inside-work-tree': return { stdout: 'true\n', stderr: '' };
      case 'rev-parse HEAD': return { stdout: SHA + '\n', stderr: '' };
      case 'log -1 --format=%cI': return { stdout: '2026-11-01T00:00:00+00:00\n', stderr: '' };
      case 'status --porcelain --untracked-files=no': return { stdout: '', stderr: '' };
      case 'rev-parse --is-shallow-repository': return { stdout: 'false\n', stderr: '' };
      default: return { stdout: '', stderr: '' };
    }
  });
}

test('current version is null for a non-git directory', async () => {
  mock.method(UpdateManager, 'execFileAsync', async () => {
    throw new Error('not a git repository');
  });
  try {
    assert.equal(await UpdateManager.getCurrentVersion(), null);
  } finally { mock.reset(); }
});

test('current version reports dirty status', async () => {
  stubGit({ 'status --porcelain --untracked-files=no': { stdout: ' M package.json\n', stderr: '' } });
  try {
    const v = await UpdateManager.getCurrentVersion();
    assert.equal(v.sha, SHA);
    assert.equal(v.shortSha, SHA.slice(0, 7));
    assert.equal(v.dirty, true);
  } finally { mock.reset(); }
});

test('latest version is cached for 10 minutes', async () => {
  const paths = tmpPaths();
  const calls = [];
  mock.method(UpdateManager, 'execFileAsync', async (file, args) => {
    calls.push(args.join(' '));
    return { stdout: `${NEW_SHA}\trefs/heads/main\n`, stderr: '' };
  });
  try {
    const t0 = Date.parse('2026-11-05T00:00:00Z');
    const first = await UpdateManager.getLatestVersion({ now: t0, paths });
    assert.equal(first.sha, NEW_SHA);
    assert.equal(calls.length, 1);
    const second = await UpdateManager.getLatestVersion({ now: t0 + 60_000, paths });
    assert.equal(second.sha, NEW_SHA);
    assert.equal(calls.length, 1);
    await UpdateManager.getLatestVersion({ now: t0 + 11 * 60_000, paths });
    assert.equal(calls.length, 2);
  } finally { mock.reset(); }
});

test('pm2 online requires the configured process to be online', async () => {
  mock.method(ProcessManager, 'pm2Exec', async () => ({
    stdout: JSON.stringify([{ name: config.pm2.instanceName, pm2_env: { status: 'online' } }]),
    stderr: ''
  }));
  try { assert.equal(await UpdateManager.isPm2Online(), true); } finally { mock.reset(); }

  mock.method(ProcessManager, 'pm2Exec', async () => ({
    stdout: JSON.stringify([{ name: config.pm2.instanceName, pm2_env: { status: 'stopped' } }]),
    stderr: ''
  }));
  try { assert.equal(await UpdateManager.isPm2Online(), false); } finally { mock.reset(); }
});

test('preflight rejects a shallow repository', async () => {
  stubGit({
    'rev-parse --is-shallow-repository': { stdout: 'true\n', stderr: '' },
  });
  const orig = config.selfUpdate.enabled;
  config.selfUpdate.enabled = true;
  // The suite must pass on Windows too; the platform gate is covered separately.
  mock.method(UpdateManager, 'isPlatformSupported', () => true);
  mock.method(UpdateManager, 'isPm2Online', async () => true);
  mock.method(UpdateManager, 'isUpdateRunning', () => false);
  mock.method(UpdateManager, 'getLatestVersion', async () => ({ sha: NEW_SHA, shortSha: NEW_SHA.slice(0, 7), checkedAt: new Date().toISOString() }));
  try {
    const r = await UpdateManager.preflight();
    assert.equal(r.ok, false);
    assert.match(r.message, /shallow/);
  } finally { mock.reset(); config.selfUpdate.enabled = orig; }
});

test('preflight returns from/to shas when all checks pass', async () => {
  stubGit();
  const orig = config.selfUpdate.enabled;
  config.selfUpdate.enabled = true;
  // The suite must pass on Windows too; the platform gate is covered separately.
  mock.method(UpdateManager, 'isPlatformSupported', () => true);
  mock.method(UpdateManager, 'isPm2Online', async () => true);
  mock.method(UpdateManager, 'isUpdateRunning', () => false);
  mock.method(UpdateManager, 'getLatestVersion', async () => ({ sha: NEW_SHA, shortSha: NEW_SHA.slice(0, 7), checkedAt: new Date().toISOString() }));
  try {
    const r = await UpdateManager.preflight();
    assert.deepEqual(r, { ok: true, fromSha: SHA, toSha: NEW_SHA });
  } finally { mock.reset(); config.selfUpdate.enabled = orig; }
});

test('startUpdate claims the lock and spawns the runner with from/to shas', async () => {
  const paths = tmpPaths();
  const child = makeChild(4242);
  const calls = [];
  mock.method(UpdateManager, 'spawnDetached', (file, args, options) => {
    calls.push({ file, args, options });
    return child;
  });
  try {
    const r = await UpdateManager.startUpdate({ fromSha: SHA, toSha: NEW_SHA, paths });
    assert.deepEqual(r, { ok: true, pid: 4242 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, process.execPath);
    assert.deepEqual(calls[0].args.slice(-4), ['--from', SHA, '--to', NEW_SHA]);
    assert.equal(calls[0].options.detached, true);

    const lock = JSON.parse(fs.readFileSync(paths.lockPath, 'utf8'));
    assert.equal(lock.pid, 4242);
    const state = UpdateManager.readState(paths.statePath);
    assert.equal(state.status, 'running');
    assert.equal(state.pid, 4242);
    assert.equal(state.fromSha, SHA);
    assert.equal(state.toSha, NEW_SHA);
  } finally { mock.reset(); }
});

test('startUpdate rejects an invalid sha without locking or spawning', async () => {
  const paths = tmpPaths();
  let spawns = 0;
  mock.method(UpdateManager, 'spawnDetached', () => { spawns += 1; return makeChild(1); });
  try {
    const r = await UpdateManager.startUpdate({ fromSha: 'not-a-sha', toSha: NEW_SHA, paths });
    assert.deepEqual(r, { ok: false, httpStatus: 400, message: 'Invalid SHA' });
    assert.equal(spawns, 0);
    assert.equal(fs.existsSync(paths.lockPath), false);
    assert.equal(fs.existsSync(paths.statePath), false);
  } finally { mock.reset(); }
});

test('startUpdate returns 409 when a live run holds the lock', async () => {
  const paths = tmpPaths();
  fs.writeFileSync(paths.lockPath, JSON.stringify({
    pid: process.pid, startedAt: new Date().toISOString()
  }));
  let spawns = 0;
  mock.method(UpdateManager, 'isPidAlive', () => true);
  mock.method(UpdateManager, 'spawnDetached', () => { spawns += 1; return makeChild(1); });
  try {
    const r = await UpdateManager.startUpdate({ fromSha: SHA, toSha: NEW_SHA, paths });
    assert.deepEqual(r, { ok: false, httpStatus: 409, message: '已有更新正在进行' });
    assert.equal(spawns, 0);
    assert.equal(fs.existsSync(paths.statePath), false);
    assert.equal(JSON.parse(fs.readFileSync(paths.lockPath, 'utf8')).pid, process.pid);
  } finally { mock.reset(); }
});

test('startUpdate preempts a stale lock once', async () => {
  const paths = tmpPaths();
  fs.writeFileSync(paths.lockPath, JSON.stringify({
    pid: 999999, startedAt: new Date().toISOString()
  }));
  mock.method(UpdateManager, 'isPidAlive', () => false);
  mock.method(UpdateManager, 'spawnDetached', () => makeChild(5151));
  try {
    const r = await UpdateManager.startUpdate({ fromSha: SHA, toSha: NEW_SHA, paths });
    assert.deepEqual(r, { ok: true, pid: 5151 });
    assert.equal(JSON.parse(fs.readFileSync(paths.lockPath, 'utf8')).pid, 5151);
  } finally { mock.reset(); }
});

test('startUpdate records a failed state and drops the lock when the spawn errors', async () => {
  const paths = tmpPaths();
  const child = makeChild(4242);
  mock.method(UpdateManager, 'spawnDetached', () => child);
  try {
    const r = await UpdateManager.startUpdate({ fromSha: SHA, toSha: NEW_SHA, paths });
    assert.equal(r.ok, true);
    child.emit('error', new Error('boom'));

    const state = UpdateManager.readState(paths.statePath);
    assert.equal(state.status, 'failed');
    assert.equal(state.step, 'queued');
    assert.equal(state.error, 'boom');
    assert.ok(state.finishedAt);
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally { mock.reset(); }
});

test('startUpdate fails cleanly when the spawned child has no pid', async () => {
  const paths = tmpPaths();
  mock.method(UpdateManager, 'spawnDetached', () => makeChild(undefined));
  try {
    const r = await UpdateManager.startUpdate({ fromSha: SHA, toSha: NEW_SHA, paths });
    assert.deepEqual(r, { ok: false, httpStatus: 500, message: '无法启动更新进程' });

    const state = UpdateManager.readState(paths.statePath);
    assert.equal(state.status, 'failed');
    assert.equal(state.error, '无法启动更新进程');
    assert.ok(state.finishedAt);
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally { mock.reset(); }
});
