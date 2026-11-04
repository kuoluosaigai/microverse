const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
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
