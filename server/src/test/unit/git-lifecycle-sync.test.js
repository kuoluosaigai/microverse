const { test, mock, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { queries, dbReady } = require('../helpers/setup');
const { dbRun } = require('../../db');
const AppManager = require('../../services/app-manager');
const GitLifecycle = require('../../services/git-lifecycle');
const NpmLifecycle = require('../../services/npm-lifecycle');
const ProcessManager = require('../../services/process-manager');
const config = require('../../config');

before(async () => { await dbReady; });
afterEach(() => mock.reset());

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'microverse-git-sync-'));
const createdAppIds = [];

after(async () => {
  for (const id of createdAppIds) {
    try { await queries.deleteApp(id); } catch (_err) { /* best-effort */ }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const fileUrl = (dir) => 'file://' + path.resolve(dir).replace(/\\/g, '/');

function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one');
  return [
    ['init', '-q', '-b', 'main'],
    ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'add', '.'],
    ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-qm', 'one']
  ].reduce((p, args) => p.then(() => GitLifecycle.gitExec(args, { cwd: dir })), Promise.resolve());
}

function commitTo(dir, content, message) {
  fs.writeFileSync(path.join(dir, 'a.txt'), content);
  return [
    ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'add', '.'],
    ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-qm', message]
  ].reduce((p, args) => p.then(() => GitLifecycle.gitExec(args, { cwd: dir })), Promise.resolve());
}

// Real DB row + real git repo bound as the app's git source, with
// deployed_commit set to the initial commit (the usual post-first-deploy state).
async function makeGitApp(name, { deployType = 'npm' } = {}) {
  const src = path.join(tmp, `${name}-src`);
  await makeRepo(src);

  const created = await AppManager.createApp(name, deployType);
  createdAppIds.push(created.id);

  const appPath = path.join(tmp, `${name}-app`);
  await GitLifecycle.ensureRepo(appPath, { url: fileUrl(src), branch: 'main' });
  const prevSha = await GitLifecycle.currentHead(appPath);

  await queries.updateApp({ id: created.id, path: appPath });
  await queries.upsertAppGitSource({
    appId: created.id,
    url: fileUrl(src),
    branch: 'main',
    webhookSecret: 'test-secret'
  });
  await queries.finishGitSync(created.id, { status: 'success', deployedCommit: prevSha });

  const app = await AppManager.getAppById(created.id);
  return { app, src, appPath, prevSha };
}

function onlineStatus() {
  return { exists: true, status: 'online' };
}

test('sync updates files, stores the commit, and restarts a running npm app', async () => {
  const { app, src, appPath, prevSha } = await makeGitApp('sync-success');

  mock.method(ProcessManager, 'getProcessStatus', async () => onlineStatus());
  const restarted = [];
  mock.method(ProcessManager, 'restartProcess', async (name) => { restarted.push(name); });
  let builds = 0;
  mock.method(NpmLifecycle, 'ensureBuilt', async () => { builds += 1; });

  await commitTo(src, 'two', 'two');
  const newSha = await GitLifecycle.currentHead(src);

  const result = await GitLifecycle.sync(app);

  assert.equal(result.status, 'success');
  assert.equal(result.deployedCommit, newSha);
  assert.equal(fs.readFileSync(path.join(appPath, 'a.txt'), 'utf8'), 'two');
  assert.deepEqual(restarted, [app.name]);
  assert.equal(builds, 1);

  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.deployed_commit, newSha);
  assert.notEqual(source.deployed_commit, prevSha);
  assert.equal(source.last_status, 'success');
  assert.ok(source.synced_at);
  assert.equal(source.sync_started_at, null);
});

test('sync does not restart when the app was stopped during the build', async () => {
  const { app, src } = await makeGitApp('sync-stopped');

  // First call (wasRunning) reports online; by the time the build finishes the
  // process is gone.
  let calls = 0;
  mock.method(ProcessManager, 'getProcessStatus', async () => {
    calls += 1;
    return calls === 1 ? onlineStatus() : { exists: false, status: 'stopped' };
  });
  let restarts = 0;
  mock.method(ProcessManager, 'restartProcess', async () => { restarts += 1; });
  mock.method(NpmLifecycle, 'ensureBuilt', async () => {});

  await commitTo(src, 'two', 'two');
  const result = await GitLifecycle.sync(app);

  assert.equal(result.status, 'success');
  assert.equal(restarts, 0);

  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.last_status, 'success');
  assert.equal(source.deployed_commit, await GitLifecycle.currentHead(src));
});

test('build failure rolls back to the previous commit and stores failed', async () => {
  const { app, src, appPath, prevSha } = await makeGitApp('sync-build-fail');

  mock.method(ProcessManager, 'getProcessStatus', async () => onlineStatus());
  let restarts = 0;
  mock.method(ProcessManager, 'restartProcess', async () => { restarts += 1; });
  mock.method(NpmLifecycle, 'ensureBuilt', async () => {
    throw new Error('build failed: boom');
  });

  await commitTo(src, 'two', 'two');

  const result = await GitLifecycle.sync(app);

  assert.equal(result.status, 'failed');
  assert.match(result.error, /boom/);
  assert.equal(await GitLifecycle.currentHead(appPath), prevSha);
  assert.equal(fs.readFileSync(path.join(appPath, 'a.txt'), 'utf8'), 'one');
  assert.equal(restarts, 0);

  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.last_status, 'failed');
  assert.match(source.last_error, /boom/);
  assert.equal(source.deployed_commit, prevSha);
  assert.equal(source.sync_started_at, null);
});

test('rollback after a failed build forces install+build despite matching fingerprints', async () => {
  const { app, src } = await makeGitApp('sync-rollback-force');

  mock.method(ProcessManager, 'getProcessStatus', async () => onlineStatus());
  let restarts = 0;
  mock.method(ProcessManager, 'restartProcess', async () => { restarts += 1; });
  const ensureBuiltCalls = [];
  mock.method(NpmLifecycle, 'ensureBuilt', async (appId, appPath, opts) => {
    ensureBuiltCalls.push(opts);
    if (ensureBuiltCalls.length === 1) throw new Error('build failed: boom');
  });

  await commitTo(src, 'two', 'two');

  const result = await GitLifecycle.sync(app);

  assert.equal(result.status, 'failed');
  assert.equal(restarts, 0);
  assert.equal(ensureBuiltCalls.length, 2);
  // Forward build stays fingerprint-gated; the rollback must repair deps even
  // though the restored package.json/lockfile match the stored fingerprint.
  assert.equal(ensureBuiltCalls[0], undefined);
  assert.deepEqual(ensureBuiltCalls[1], { force: true });
});

test('restart failure keeps the new commit and reports failed', async () => {
  const { app, src, appPath } = await makeGitApp('sync-restart-fail');

  mock.method(ProcessManager, 'getProcessStatus', async () => onlineStatus());
  mock.method(ProcessManager, 'restartProcess', async () => {
    throw new Error('restart exploded');
  });
  mock.method(NpmLifecycle, 'ensureBuilt', async () => {});

  await commitTo(src, 'two', 'two');
  const newSha = await GitLifecycle.currentHead(src);

  const result = await GitLifecycle.sync(app);

  assert.equal(result.status, 'failed');
  assert.match(result.error, /restart/i);
  assert.equal(await GitLifecycle.currentHead(appPath), newSha);
  assert.equal(fs.readFileSync(path.join(appPath, 'a.txt'), 'utf8'), 'two');

  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.last_status, 'failed');
  assert.equal(source.deployed_commit, newSha);
  assert.match(source.last_error, /restart/i);
});

test('a same-SHA sync is up-to-date and runs no install/build', async () => {
  const { app, prevSha } = await makeGitApp('sync-uptodate');

  mock.method(ProcessManager, 'getProcessStatus', async () => onlineStatus());
  let restarts = 0;
  mock.method(ProcessManager, 'restartProcess', async () => { restarts += 1; });
  let builds = 0;
  mock.method(NpmLifecycle, 'ensureBuilt', async () => { builds += 1; });

  const result = await GitLifecycle.sync(app);

  assert.equal(result.status, 'up-to-date');
  assert.equal(result.deployedCommit, prevSha);
  assert.equal(builds, 0);
  assert.equal(restarts, 0);

  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.last_status, 'success');
  assert.equal(source.deployed_commit, prevSha);
  assert.ok(source.synced_at);
  assert.equal(source.sync_started_at, null);
});

test('a same-SHA sync with a dirty worktree repairs it instead of reporting up-to-date', async () => {
  const { app, appPath, prevSha } = await makeGitApp('sync-dirty');

  mock.method(ProcessManager, 'getProcessStatus', async () => onlineStatus());
  mock.method(ProcessManager, 'restartProcess', async () => {});
  let builds = 0;
  mock.method(NpmLifecycle, 'ensureBuilt', async () => { builds += 1; });

  // A hand edit (or a failed deploy) leaves the checkout dirty at the same SHA.
  fs.writeFileSync(path.join(appPath, 'a.txt'), 'local edit');

  const result = await GitLifecycle.sync(app);

  assert.equal(result.status, 'success');
  assert.equal(result.deployedCommit, prevSha);
  assert.equal(builds, 1);
  assert.equal(fs.readFileSync(path.join(appPath, 'a.txt'), 'utf8'), 'one');

  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.last_status, 'success');
  assert.equal(source.deployed_commit, prevSha);
  assert.equal(source.sync_started_at, null);
});

test('a same-SHA sync ignores platform-managed nginx files and preserves them', async () => {
  const { app, appPath, prevSha } = await makeGitApp('sync-nginx-uptodate', { deployType: 'nginx' });

  mock.method(ProcessManager, 'getProcessStatus', async () => onlineStatus());
  let restarts = 0;
  mock.method(ProcessManager, 'restartProcess', async () => { restarts += 1; });

  // NginxLifecycle writes these into the app dir after the deploy; they are
  // untracked and un-gitignored, but they are platform state, not user dirt.
  const platformFiles = [
    `nginx.${app.name}.conf`,
    'nginx.pid',
    'nginx-access.log',
    'nginx-error.log'
  ];
  for (const name of platformFiles) {
    fs.writeFileSync(path.join(appPath, name), `platform ${name}`);
  }
  fs.mkdirSync(path.join(appPath, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(appPath, 'node_modules', 'pkg', 'index.js'), 'dep');

  const result = await GitLifecycle.sync(app);

  assert.equal(result.status, 'up-to-date');
  assert.equal(result.deployedCommit, prevSha);
  assert.equal(restarts, 0);
  for (const name of platformFiles) {
    assert.equal(fs.readFileSync(path.join(appPath, name), 'utf8'), `platform ${name}`);
  }
  assert.equal(fs.readFileSync(path.join(appPath, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'dep');

  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.last_status, 'success');
  assert.equal(source.deployed_commit, prevSha);
});

test('a new commit syncs and preserves platform-managed nginx files through reset/clean', async () => {
  const { app, src, appPath } = await makeGitApp('sync-nginx-newcommit', { deployType: 'nginx' });

  mock.method(ProcessManager, 'getProcessStatus', async () => onlineStatus());
  let restarts = 0;
  mock.method(ProcessManager, 'restartProcess', async () => { restarts += 1; });

  const platformFiles = [
    `nginx.${app.name}.conf`,
    'nginx.pid',
    'nginx-access.log',
    'nginx-error.log'
  ];
  for (const name of platformFiles) {
    fs.writeFileSync(path.join(appPath, name), `platform ${name}`);
  }
  fs.mkdirSync(path.join(appPath, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(appPath, 'node_modules', 'pkg', 'index.js'), 'dep');
  // Ordinary untracked user content must still be cleaned away.
  fs.writeFileSync(path.join(appPath, 'scratch.txt'), 'user dirt');

  await commitTo(src, 'two', 'two');
  const newSha = await GitLifecycle.currentHead(src);

  const result = await GitLifecycle.sync(app);

  assert.equal(result.status, 'success');
  assert.equal(result.deployedCommit, newSha);
  assert.equal(restarts, 0);
  // The tracked source did move (reset happened)...
  assert.equal(fs.readFileSync(path.join(appPath, 'a.txt'), 'utf8'), 'two');
  // ...but git clean -fd spared the platform files (and node_modules).
  for (const name of platformFiles) {
    assert.equal(fs.readFileSync(path.join(appPath, name), 'utf8'), `platform ${name}`);
  }
  assert.equal(fs.readFileSync(path.join(appPath, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'dep');
  assert.equal(fs.existsSync(path.join(appPath, 'scratch.txt')), false);

  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.last_status, 'success');
  assert.equal(source.deployed_commit, newSha);
});

test('second sync is busy while the first claim is fresh', async () => {
  const { app } = await makeGitApp('sync-busy');

  mock.method(ProcessManager, 'getProcessStatus', async () => onlineStatus());
  let builds = 0;
  mock.method(NpmLifecycle, 'ensureBuilt', async () => { builds += 1; });

  assert.equal(await queries.claimGitSync(app.id, config.git.staleSyncMs), true);

  const result = await GitLifecycle.sync(app);

  assert.equal(result.status, 'busy');
  assert.equal(builds, 0);
  // The loser must not have released the winner's claim.
  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.last_status, 'updating');
  assert.ok(source.sync_started_at);
});

test('isSyncInProgress is true only for a fresh updating claim', async () => {
  const { app } = await makeGitApp('sync-in-progress');

  assert.equal(await GitLifecycle.isSyncInProgress(app.id), false);
  await GitLifecycle.assertNotSyncing(app.id);

  assert.equal(await queries.claimGitSync(app.id, config.git.staleSyncMs), true);
  assert.equal(await GitLifecycle.isSyncInProgress(app.id), true);
  await assert.rejects(GitLifecycle.assertNotSyncing(app.id), /Update in progress/);

  await queries.finishGitSync(app.id, { status: 'failed', error: 'done' });
  assert.equal(await GitLifecycle.isSyncInProgress(app.id), false);

  // A stale claim (crashed worker) no longer counts as in progress.
  await queries.claimGitSync(app.id, config.git.staleSyncMs);
  await dbRun(
    "UPDATE app_git_source SET sync_started_at = datetime('now', '-1 hour') WHERE app_id = ?",
    [app.id]
  );
  assert.equal(await GitLifecycle.isSyncInProgress(app.id), false);
  await GitLifecycle.assertNotSyncing(app.id);
});

test('check reports the deployed/remote commits and up-to-date state', async () => {
  const { app, src, prevSha } = await makeGitApp('sync-check');
  const source = await queries.getAppGitSource(app.id);

  const same = await GitLifecycle.check(app, source);
  assert.equal(same.deployedCommit, prevSha);
  assert.equal(same.remoteCommit, prevSha);
  assert.equal(same.upToDate, true);
  // A manual check persists the observed remote head for the UI/update badge.
  assert.equal((await queries.getAppGitSource(app.id)).remote_commit, prevSha);

  await commitTo(src, 'two', 'two');
  const advancedRemote = await GitLifecycle.currentHead(src);
  const advanced = await GitLifecycle.check(app, source);
  assert.equal(advanced.deployedCommit, prevSha);
  assert.equal(advanced.remoteCommit, advancedRemote);
  assert.equal(advanced.upToDate, false);
  assert.equal((await queries.getAppGitSource(app.id)).remote_commit, advancedRemote);
});

test('pull delegates to sync', async () => {
  const { app } = await makeGitApp('sync-pull');

  mock.method(ProcessManager, 'getProcessStatus', async () => onlineStatus());
  mock.method(NpmLifecycle, 'ensureBuilt', async () => {});
  const synced = [];
  mock.method(GitLifecycle, 'sync', async (a, opts) => {
    synced.push({ app: a, opts });
    return { status: 'success', deployedCommit: 'deadbeef', error: null };
  });

  const result = await GitLifecycle.pull(app);

  assert.equal(result.status, 'success');
  assert.equal(synced.length, 1);
  assert.equal(synced[0].app, app);
});

test('a failed first sync leaves deployed_commit null so a retry rebuilds', async () => {
  const name = 'sync-first-fail';
  const src = path.join(tmp, `${name}-src`);
  await makeRepo(src);
  await commitTo(src, 'two', 'two');
  const newSha = await GitLifecycle.currentHead(src);

  const created = await AppManager.createApp(name, 'npm');
  createdAppIds.push(created.id);
  const appPath = path.join(tmp, `${name}-app`);
  await queries.updateApp({ id: created.id, path: appPath });
  await queries.upsertAppGitSource({
    appId: created.id,
    url: fileUrl(src),
    branch: 'main',
    webhookSecret: 'test-secret'
  });
  const app = await AppManager.getAppById(created.id);

  mock.method(ProcessManager, 'getProcessStatus', async () => onlineStatus());
  mock.method(ProcessManager, 'restartProcess', async () => {});
  let builds = 0;
  mock.method(NpmLifecycle, 'ensureBuilt', async () => {
    builds += 1;
    if (builds === 1) throw new Error('build failed: boom');
  });

  // First sync: the repo is cloned at newSha, prevSha === newSha, and the build
  // fails. Recording newSha as deployed would brand a never-built tree "good".
  const first = await GitLifecycle.sync(app);
  assert.equal(first.status, 'failed');
  assert.equal(first.deployedCommit, null);
  // One primary build attempt plus the best-effort rollback rebuild.
  assert.equal(builds, 2);

  let source = await queries.getAppGitSource(app.id);
  assert.equal(source.deployed_commit, null);
  assert.equal(source.last_status, 'failed');
  assert.match(source.last_error, /boom/);
  assert.equal(source.sync_started_at, null);

  // Same remote SHA, but deployed_commit is still NULL -> must rebuild, not
  // report up-to-date off the failed attempt.
  const second = await GitLifecycle.sync(app);
  assert.equal(second.status, 'success');
  assert.equal(second.deployedCommit, newSha);
  assert.equal(builds, 3);

  source = await queries.getAppGitSource(app.id);
  assert.equal(source.deployed_commit, newSha);
  assert.equal(source.last_status, 'success');
  assert.equal(fs.readFileSync(path.join(appPath, 'a.txt'), 'utf8'), 'two');
});

test('sync follows a re-bound URL instead of the checkout\'s old origin', async () => {
  const { app, src, appPath } = await makeGitApp('sync-rebind');

  // A second remote with different content.
  const srcB = path.join(tmp, 'sync-rebind-srcB');
  await makeRepo(srcB);
  await commitTo(srcB, 'bee', 'bee');
  const shaB = await GitLifecycle.currentHead(srcB);
  const shaA = await GitLifecycle.currentHead(src);
  assert.notEqual(shaA, shaB);

  mock.method(ProcessManager, 'getProcessStatus', async () => onlineStatus());
  mock.method(ProcessManager, 'restartProcess', async () => {});
  mock.method(NpmLifecycle, 'ensureBuilt', async () => {});

  // Task 8's URL re-bind updates the DB only; the checkout still has origin A.
  await queries.upsertAppGitSource({ appId: app.id, url: fileUrl(srcB), branch: 'main' });

  const result = await GitLifecycle.sync(app);

  assert.equal(result.status, 'success');
  assert.equal(result.deployedCommit, shaB);
  assert.equal(fs.readFileSync(path.join(appPath, 'a.txt'), 'utf8'), 'bee');

  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.deployed_commit, shaB);
  assert.equal(source.last_status, 'success');
});

test('ensureBuilt force skips the fingerprint gates and persists fresh fingerprints', async () => {
  const { app, appPath } = await makeGitApp('sync-force-build');
  fs.writeFileSync(path.join(appPath, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }));
  fs.mkdirSync(path.join(appPath, 'node_modules'), { recursive: true });
  await queries.setUpDeployState(app.id, {
    installFp: NpmLifecycle.installFingerprint(appPath),
    buildFp: NpmLifecycle.buildFingerprint(appPath)
  });

  const calls = [];
  mock.method(NpmLifecycle, 'install', async () => { calls.push('install'); });
  mock.method(NpmLifecycle, 'build', async () => { calls.push('build'); });

  // Matching fingerprints: the default path does no work.
  await NpmLifecycle.ensureBuilt(app.id, appPath);
  assert.deepEqual(calls, []);

  // Force runs both steps unconditionally (rollback repair path).
  await NpmLifecycle.ensureBuilt(app.id, appPath, { force: true });
  assert.deepEqual(calls, ['install', 'build']);

  const state = await queries.getAppDeployState(app.id);
  assert.equal(state.install_fp, NpmLifecycle.installFingerprint(appPath));
  assert.equal(state.build_fp, NpmLifecycle.buildFingerprint(appPath));
});

test('sync coalesces a webhook commit recorded during an up-to-date attempt', async () => {
  const { app } = await makeGitApp('sync-coalesce-uptodate');
  const attempts = [];
  mock.method(GitLifecycle, 'syncAttempt', async () => {
    attempts.push(attempts.length + 1);
    if (attempts.length === 1) {
      // The remote moved on, but this attempt only managed to prove the
      // deployed SHA (up-to-date). The loop must not stop here.
      return { status: 'up-to-date', deployedCommit: 'deployed-sha', error: null };
    }
    return { status: 'success', deployedCommit: 'newer-sha', error: null };
  });
  await queries.setGitRemoteCommit(app.id, 'newer-sha');

  const result = await GitLifecycle.sync(app);

  assert.equal(attempts.length, 2);
  assert.equal(result.status, 'success');
  assert.equal(result.deployedCommit, 'newer-sha');
});

test('sync coalesces a webhook commit that landed mid-build (bounded retries)', async () => {
  const { app, src } = await makeGitApp('sync-coalesce');

  mock.method(ProcessManager, 'getProcessStatus', async () => onlineStatus());
  mock.method(ProcessManager, 'restartProcess', async () => {});
  let builds = 0;
  mock.method(NpmLifecycle, 'ensureBuilt', async () => {
    builds += 1;
    if (builds === 1) {
      // Another worker's webhook recorded the next commit while this build ran.
      await commitTo(src, 'three', 'three');
      await queries.setGitRemoteCommit(app.id, await GitLifecycle.currentHead(src));
    }
  });

  await commitTo(src, 'two', 'two');

  const result = await GitLifecycle.sync(app);

  // The commit created mid-build ('three') is what ends up deployed.
  const finalSha = await GitLifecycle.currentHead(src);
  assert.equal(result.status, 'success');
  assert.equal(result.deployedCommit, finalSha);
  assert.equal(builds, 2);

  const source = await queries.getAppGitSource(app.id);
  assert.equal(source.deployed_commit, finalSha);
  assert.equal(source.last_status, 'success');
  const content = fs.readFileSync(path.join(app.path, 'a.txt'), 'utf8');
  assert.equal(content, 'three');
});
