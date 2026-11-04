const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runUpdate } = require('../../services/self-updater');
const UpdateManager = require('../../services/update-manager');

const FROM = 'a'.repeat(40);
const TO = 'b'.repeat(40);

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-rollback-'));
  fs.mkdirSync(path.join(repoRoot, 'client', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'client', 'dist', 'index.html'), 'old');
  fs.mkdirSync(path.join(repoRoot, 'data'), { recursive: true });
  return { repoRoot, paths: UpdateManager.getPaths(repoRoot) };
}

function deps(repoRoot, calls, overrides = {}) {
  return {
    repoRoot,
    paths: UpdateManager.getPaths(repoRoot),
    fromSha: FROM,
    toSha: TO,
    runCommand: async (file, args) => {
      const cmd = `${file} ${args.join(' ')}`;
      calls.push(cmd);
      if (overrides.fail && cmd.includes(overrides.fail)) throw new Error('boom');
      if (cmd.includes('rev-parse HEAD')) return { stdout: FROM + '\n', stderr: '' };
      if (cmd.includes('status --porcelain --untracked-files=no')) return { stdout: '', stderr: '' };
      if (cmd.includes('rev-parse --is-shallow-repository')) return { stdout: 'false\n', stderr: '' };
      if (cmd.includes('rev-parse origin/main')) return { stdout: TO + '\n', stderr: '' };
      if (cmd.includes('merge-base --is-ancestor')) return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    },
    runNpm: async (args) => {
      calls.push(`npm ${args.join(' ')}`);
      if (overrides.failNpm && args.includes(overrides.failNpm)) throw new Error('npm failed');
      if (args.includes('build:staging')) {
        fs.mkdirSync(path.join(repoRoot, 'client', 'dist.next'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'client', 'dist.next', 'index.html'), 'new');
      }
      return { stdout: '', stderr: '' };
    },
    runPm2: async (args) => { calls.push(`pm2 ${args.join(' ')}`); return { stdout: '', stderr: '' }; },
    backupDb: async () => {},
    healthCheck: async () => overrides.health !== false,
    now: () => Date.parse('2026-11-05T00:00:00Z'),
    sleep: async () => {},
    isPidAlive: overrides.isPidAlive || (() => false)
  };
}

test('build failure rolls code back and leaves dist untouched', async () => {
  const { repoRoot } = fixture();
  const calls = [];
  const state = await runUpdate(deps(repoRoot, calls, { failNpm: 'build:staging' }));
  assert.equal(state.status, 'rolled_back');
  assert.ok(calls.includes(`git reset --hard ${FROM}`));
  assert.equal(fs.readFileSync(path.join(repoRoot, 'client', 'dist', 'index.html'), 'utf8'), 'old');
  assert.equal(fs.existsSync(path.join(repoRoot, 'client', 'dist.next')), false);
  assert.equal(calls.filter(c => c.includes('pm2 reload')).length, 1);
});

test('health failure restores dist.prev and reloads twice', async () => {
  const { repoRoot } = fixture();
  const calls = [];
  let healthCalls = 0;
  const state = await runUpdate({
    ...deps(repoRoot, calls),
    healthCheck: async () => { healthCalls += 1; return healthCalls > 1; }
  });
  assert.equal(state.status, 'rolled_back');
  assert.equal(fs.readFileSync(path.join(repoRoot, 'client', 'dist', 'index.html'), 'utf8'), 'old');
  assert.equal(fs.existsSync(path.join(repoRoot, 'client', 'dist.prev')), false);
  assert.equal(calls.filter(c => c.includes('pm2 reload')).length, 2);
});

test('rollback that stays unhealthy ends failed for manual intervention', async () => {
  const { repoRoot } = fixture();
  const calls = [];
  const state = await runUpdate({
    ...deps(repoRoot, calls),
    healthCheck: async () => false
  });
  assert.equal(state.status, 'failed');
  assert.match(state.error, /人工介入/);
  assert.match(state.error, /健康检查失败/);
});

test('rollback reports failed when the code reset fails', async () => {
  const { repoRoot } = fixture();
  const calls = [];
  const base = deps(repoRoot, calls);
  let healthCalls = 0;
  const state = await runUpdate({
    ...base,
    runCommand: async (file, args, options) => {
      if (args[0] === 'reset' && args[1] === '--hard') {
        calls.push(`git ${args.join(' ')}`);
        throw new Error('reset failed');
      }
      return base.runCommand(file, args, options);
    },
    healthCheck: async () => { healthCalls += 1; return healthCalls > 1; }
  });
  assert.equal(state.status, 'failed');
  assert.match(state.error, /代码恢复失败/);
  assert.doesNotMatch(state.error, /健康检查失败/);
});

test('rollback reports failed when the dist restore fails', async () => {
  const { repoRoot } = fixture();
  const calls = [];
  let healthCalls = 0;
  const state = await runUpdate({
    ...deps(repoRoot, calls),
    restoreDist: async () => { throw new Error('dist restore failed'); },
    healthCheck: async () => { healthCalls += 1; return healthCalls > 1; }
  });
  assert.equal(state.status, 'failed');
  assert.match(state.error, /dist 恢复失败/);
  assert.doesNotMatch(state.error, /健康检查失败/);
});

test('diverged history fails before any file is touched', async () => {
  const { repoRoot } = fixture();
  const calls = [];
  const state = await runUpdate({
    ...deps(repoRoot, calls),
    runCommand: async (file, args) => {
      const cmd = `${file} ${args.join(' ')}`;
      calls.push(cmd);
      if (cmd.includes('rev-parse HEAD')) return { stdout: FROM + '\n', stderr: '' };
      if (cmd.includes('status --porcelain')) return { stdout: '', stderr: '' };
      if (cmd.includes('merge-base --is-ancestor')) throw new Error('exit 1');
      return { stdout: '', stderr: '' };
    }
  });
  assert.equal(state.status, 'failed');
  assert.ok(!calls.some(c => c.includes('git merge --ff-only')));
  assert.equal(fs.readFileSync(path.join(repoRoot, 'client', 'dist', 'index.html'), 'utf8'), 'old');
});

test('cleanup restores a lone lockfile modification', async () => {
  const { repoRoot } = fixture();
  const calls = [];
  let statusCalls = 0;
  const state = await runUpdate({
    ...deps(repoRoot, calls),
    runCommand: async (file, args) => {
      const cmd = `${file} ${args.join(' ')}`;
      calls.push(cmd);
      if (cmd.includes('status --porcelain --untracked-files=no')) {
        statusCalls += 1;
        return { stdout: statusCalls === 1 ? '' : ' M package-lock.json\n', stderr: '' };
      }
      if (cmd.includes('rev-parse HEAD')) return { stdout: FROM + '\n', stderr: '' };
      if (cmd.includes('rev-parse origin/main')) return { stdout: TO + '\n', stderr: '' };
      return { stdout: '', stderr: '' };
    }
  });
  assert.equal(state.status, 'success');
  assert.ok(calls.includes('git checkout -- package-lock.json'));
  assert.equal(state.warning, null);
});

test('cleanup ignores untracked state files (uses --untracked-files=no)', async () => {
  const { repoRoot } = fixture();
  const calls = [];
  const state = await runUpdate({
    ...deps(repoRoot, calls),
    runCommand: async (file, args) => {
      const cmd = `${file} ${args.join(' ')}`;
      calls.push(cmd);
      if (cmd.includes('status --porcelain') && !cmd.includes('--untracked-files=no')) {
        return { stdout: '?? data/update-state.json\n', stderr: '' };
      }
      if (cmd.includes('rev-parse HEAD')) return { stdout: FROM + '\n', stderr: '' };
      if (cmd.includes('rev-parse origin/main')) return { stdout: TO + '\n', stderr: '' };
      return { stdout: '', stderr: '' };
    }
  });
  assert.equal(state.status, 'success');
  assert.equal(state.warning, null);
  assert.ok(calls.some(c => c.includes('status --porcelain --untracked-files=no')));
});

test('a live lock refuses to start; a dead lock proceeds', async () => {
  const { repoRoot, paths } = fixture();
  fs.writeFileSync(paths.lockPath, JSON.stringify({ pid: 999, startedAt: '2026-11-05T00:00:00Z' }));
  const calls = [];
  const denied = await runUpdate(deps(repoRoot, calls, { isPidAlive: () => true }));
  assert.equal(denied.status, 'failed');
  assert.match(denied.error, /正在进行/);
  assert.equal(calls.length, 0);

  const resumed = await runUpdate(deps(repoRoot, calls, { isPidAlive: () => false }));
  assert.equal(resumed.status, 'success');
});

test('inherits a lock claimed by the spawning parent', async () => {
  const { repoRoot, paths } = fixture();
  fs.writeFileSync(paths.lockPath, JSON.stringify({ pid: process.ppid, startedAt: '2026-11-05T00:00:00Z' }));
  const calls = [];
  const state = await runUpdate(deps(repoRoot, calls, { isPidAlive: () => true }));
  assert.equal(state.status, 'success');
});

test('a cleanup failure warns but still finishes success', async () => {
  const { repoRoot } = fixture();
  const calls = [];
  const base = deps(repoRoot, calls);
  let statusCalls = 0;
  const state = await runUpdate({
    ...base,
    runCommand: async (file, args, options) => {
      if (args.join(' ') === 'status --porcelain --untracked-files=no') {
        statusCalls += 1;
        if (statusCalls === 2) throw new Error('cleanup boom');
      }
      return base.runCommand(file, args, options);
    }
  });
  assert.equal(state.status, 'success');
  assert.match(state.warning, /清理失败（忽略）：cleanup boom/);
});

test('pollHealth gives up at the deadline', async () => {
  let t = 0;
  const { pollHealth } = require('../../services/self-updater');
  const ok = await pollHealth({
    port: 5000, timeoutMs: 3000, intervalMs: 1000,
    now: () => t, sleep: async () => { t += 1000; },
    request: async () => { throw new Error('refused'); }
  });
  assert.equal(ok, false);
});
