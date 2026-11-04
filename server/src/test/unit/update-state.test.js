const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const UpdateManager = require('../../services/update-manager');

function tmpPaths() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-update-'));
  return UpdateManager.getPaths(repoRoot);
}

test('parseRemoteSha returns the sha from an ls-remote line', () => {
  assert.equal(UpdateManager.parseRemoteSha('abc1234\trefs/heads/main\n'), 'abc1234');
  assert.equal(UpdateManager.parseRemoteSha('abc1234\trefs/heads/main'), 'abc1234');
  assert.equal(UpdateManager.parseRemoteSha(''), null);
  assert.equal(UpdateManager.parseRemoteSha('nope refs/heads/main'), null);
});

test('computeUpdateAvailable ignores dirty trees and missing data', () => {
  const current = { sha: 'aaa', dirty: false };
  assert.equal(UpdateManager.computeUpdateAvailable(current, { sha: 'bbb' }), true);
  assert.equal(UpdateManager.computeUpdateAvailable(current, { sha: 'aaa' }), false);
  assert.equal(UpdateManager.computeUpdateAvailable({ sha: 'aaa', dirty: true }, { sha: 'bbb' }), false);
  assert.equal(UpdateManager.computeUpdateAvailable(null, { sha: 'bbb' }), false);
  assert.equal(UpdateManager.computeUpdateAvailable(current, null), false);
});

test('isLockStale treats missing, dead, old, and malformed locks as stale', () => {
  const now = Date.parse('2026-11-05T00:00:00Z');
  const alive = () => true;
  const dead = () => false;
  assert.equal(UpdateManager.isLockStale(null, now, alive), true);
  assert.equal(UpdateManager.isLockStale({ pid: 1, startedAt: '2026-11-05T00:00:00Z' }, now, dead), true);
  assert.equal(UpdateManager.isLockStale({ pid: 1, startedAt: '2026-11-05T00:00:00Z' }, now, alive), false);
  assert.equal(UpdateManager.isLockStale(
    { pid: 1, startedAt: '2026-11-04T21:00:00Z' }, now, alive), true);
  assert.equal(UpdateManager.isLockStale({ pid: 1 }, now, alive), true);
});

test('writeState is atomic and readState tolerates missing/corrupt files', () => {
  const paths = tmpPaths();
  UpdateManager.writeState(paths.statePath, { status: 'running', step: 'queued' });
  assert.deepEqual(UpdateManager.readState(paths.statePath), { status: 'running', step: 'queued' });
  assert.equal(fs.existsSync(paths.statePath + '.tmp'), false);
  fs.writeFileSync(paths.statePath, '{not json');
  assert.equal(UpdateManager.readState(paths.statePath), null);
  assert.equal(UpdateManager.readState(path.join(paths.repoRoot, 'missing.json')), null);
});

test('readLogTail caps lines and bytes', () => {
  const paths = tmpPaths();
  fs.writeFileSync(paths.logPath, Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n'));
  const tail = UpdateManager.readLogTail(paths.logPath);
  assert.equal(tail.length, 200);
  assert.equal(tail[0], 'line 100');
  assert.equal(tail[199], 'line 299');

  fs.writeFileSync(paths.logPath, ('x'.repeat(100) + '\n').repeat(2000));
  const longTail = UpdateManager.readLogTail(paths.logPath);
  assert.equal(longTail.length, 200);
  assert.ok(longTail.join('\n').length <= 64 * 1024);
  assert.deepEqual(UpdateManager.readLogTail(path.join(paths.repoRoot, 'nope.log')), []);
});
