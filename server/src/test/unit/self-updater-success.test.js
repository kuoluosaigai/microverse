const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runUpdate, pollHealth } = require('../../services/self-updater');
const UpdateManager = require('../../services/update-manager');

const FROM = 'a'.repeat(40);
const TO = 'b'.repeat(40);

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-self-update-'));
  fs.mkdirSync(path.join(repoRoot, 'client', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'client', 'dist', 'index.html'), 'old');
  fs.mkdirSync(path.join(repoRoot, 'data'), { recursive: true });
  return { repoRoot, paths: UpdateManager.getPaths(repoRoot) };
}

function successDeps(calls, { buildImpl } = {}) {
  return {
    fromSha: FROM,
    toSha: TO,
    runCommand: async (file, args) => {
      const cmd = `${file} ${args.join(' ')}`;
      calls.push(cmd);
      if (cmd.includes('rev-parse HEAD')) return { stdout: FROM + '\n', stderr: '' };
      if (cmd.includes('status --porcelain --untracked-files=no')) return { stdout: '', stderr: '' };
      if (cmd.includes('rev-parse --is-shallow-repository')) return { stdout: 'false\n', stderr: '' };
      if (cmd.includes('rev-parse origin/main')) return { stdout: TO + '\n', stderr: '' };
      if (cmd.includes('ls-remote')) return { stdout: `${TO}\trefs/heads/main\n`, stderr: '' };
      if (cmd.includes('merge-base --is-ancestor')) return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    },
    runNpm: async (args) => {
      calls.push(`npm ${args.join(' ')}`);
      if (args.includes('build:staging')) {
        if (buildImpl) return buildImpl();
        fs.mkdirSync(path.join(fixtureRoot, 'client', 'dist.next'), { recursive: true });
        fs.writeFileSync(path.join(fixtureRoot, 'client', 'dist.next', 'index.html'), 'new');
      }
      return { stdout: '', stderr: '' };
    },
    runPm2: async (args) => { calls.push(`pm2 ${args.join(' ')}`); return { stdout: '', stderr: '' }; },
    backupDb: async () => { calls.push('backupDb'); },
    healthCheck: async () => true,
    now: () => Date.parse('2026-11-05T00:00:00Z'),
    sleep: async () => {},
    isPidAlive: () => false
  };
}

let fixtureRoot;

test('successful update walks the steps in order and swaps dist', async () => {
  const { repoRoot, paths } = fixture();
  fixtureRoot = repoRoot;
  const calls = [];
  const state = await runUpdate({ ...successDeps(calls), repoRoot, paths });
  assert.equal(state.status, 'success');
  assert.equal(fs.readFileSync(path.join(repoRoot, 'client', 'dist', 'index.html'), 'utf8'), 'new');
  assert.equal(fs.existsSync(path.join(repoRoot, 'client', 'dist.next')), false);
  assert.equal(fs.existsSync(path.join(repoRoot, 'client', 'dist.prev')), false);
  assert.equal(fs.existsSync(paths.lockPath), false);
  assert.deepEqual(
    calls.filter(c => /git fetch|merge-base|git merge --ff-only|npm install|build:staging|pm2 reload/.test(c)),
    [
      'git fetch origin main',
      'git merge-base --is-ancestor HEAD origin/main',
      'git merge --ff-only origin/main',
      'npm install --include=dev --no-audit --no-fund',
      'npm run build:staging --workspace=client',
      'pm2 reload microverse-server'
    ]
  );
});

test('stale dist.next/dist.prev are cleaned before building', async () => {
  const { repoRoot, paths } = fixture();
  fixtureRoot = repoRoot;
  fs.mkdirSync(path.join(repoRoot, 'client', 'dist.next'));
  fs.mkdirSync(path.join(repoRoot, 'client', 'dist.prev'));
  const calls = [];
  const state = await runUpdate({ ...successDeps(calls), repoRoot, paths });
  assert.equal(state.status, 'success');
  assert.equal(fs.existsSync(path.join(repoRoot, 'client', 'dist.prev')), false);
});

test('pollHealth only accepts HTTP 200, not a redirect', async () => {
  let t = 0;
  const ok = await pollHealth({
    port: 5000,
    timeoutMs: 3000,
    intervalMs: 1000,
    now: () => t,
    sleep: async () => { t += 1000; },
    request: async () => 302
  });
  assert.equal(ok, false);
});

test('pollHealth retries transient errors until the deadline', async () => {
  let attempts = 0;
  let t = 0;
  const ok = await pollHealth({
    port: 5000,
    timeoutMs: 5000,
    intervalMs: 1000,
    now: () => t,
    sleep: async () => { t += 1000; },
    request: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('ECONNREFUSED');
      return 200;
    }
  });
  assert.equal(ok, true);
  assert.equal(attempts, 3);
});
