const { test, mock, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { queries, dbReady } = require('../helpers/setup');
const AppManager = require('../../services/app-manager');
const DeployManager = require('../../services/deploy-manager');
const NpmLifecycle = require('../../services/npm-lifecycle');
const ProcessManager = require('../../services/process-manager');

before(async () => { await dbReady; });

/** Deploy an npm app twice with install/build/start counted. */
async function deployTwice(setup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-gating-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'gating-app',
    scripts: { start: 'node index.js', build: 'node build.js' },
  }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dir, 'build.js'), 'console.log("built")');

  const counts = { install: 0, build: 0, start: 0 };
  mock.method(NpmLifecycle, 'install', async (appPath) => {
    counts.install += 1;
    fs.mkdirSync(path.join(appPath, 'node_modules'), { recursive: true });
  });
  mock.method(NpmLifecycle, 'build', async () => { counts.build += 1; });
  mock.method(ProcessManager, 'startProcess', async () => { counts.start += 1; return { success: true }; });
  mock.method(ProcessManager, 'getProcessStatus', async () => ({ exists: false }));

  const app = await AppManager.createApp('gating-app', 'npm');
  await queries.updateApp({ id: app.id, path: dir });
  await AppManager.updateApp(app.id, { port: 45790 });

  try {
    await DeployManager.deployApp(app.id);
    await DeployManager.stopApp(app.id);
    setup(dir);
    await DeployManager.deployApp(app.id);
    return counts;
  } finally {
    mock.reset();
    await queries.deleteApp(app.id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a sync that only rewrites .git does not re-install or re-build', async () => {
  const counts = await deployTwice((dir) => {
    // What a git fetch + reset --hard + clean does to a checkout with no new
    // commits: tracked files keep their mtime, .git internals get rewritten.
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'FETCH_HEAD'), 'abc123\tnot-for-main\n');
    fs.writeFileSync(path.join(dir, '.git', 'ORIG_HEAD'), 'def456\n');
    fs.writeFileSync(path.join(dir, 'node_modules', '.keep'), 'kept');
  });
  assert.deepEqual(counts, { install: 1, build: 1, start: 2 },
    'git metadata churn is not a source change: the second start must be launch-only');
});

test('an app with no dependencies does not re-install on every start', async () => {
  // `npm install` never creates node_modules when there is nothing to install,
  // so a "node_modules must exist" gate re-ran install — and, because install
  // forces a rebuild, a full build — on every single start.
  const counts = await deployTwice((dir) => {
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
  });
  assert.deepEqual(counts, { install: 1, build: 1, start: 2 },
    'a dependency-free app is already installed; the second start must not redo install+build');
});

test('a real source change still triggers exactly one rebuild', async () => {
  const counts = await deployTwice((dir) => {
    fs.writeFileSync(path.join(dir, 'index.js'), 'console.log("changed")');
  });
  assert.deepEqual(counts, { install: 1, build: 2, start: 2 },
    'the fingerprint gate must stay sensitive to actual source edits');
});

test('a Git-sourced npm app does not reinstall/rebuild on every start', async () => {
  // The production shape of the bug: the app repo tracks no lockfile, so the
  // lockfile in the checkout is the one the platform's own `npm install`
  // generated. `git clean -fd` treated it as leftover junk and deleted it,
  // which flipped the install fingerprint on EVERY start — a full install plus
  // a forced rebuild each deploy, even with no new commits.
  const GitLifecycle = require('../../services/git-lifecycle');
  const { execFileSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-git-gating-'));
  const remote = path.join(tmp, 'remote');
  fs.mkdirSync(remote, { recursive: true });
  fs.writeFileSync(path.join(remote, 'package.json'), JSON.stringify({
    name: 'git-gating',
    dependencies: { ms: '^2.0.0' },
    scripts: { start: 'node index.js', build: 'node build.js' },
  }));
  fs.writeFileSync(path.join(remote, 'index.js'), 'console.log(1)');
  const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
  const id = ['-c', 'user.name=T', '-c', 'user.email=t@example.com'];
  git(['init', '-q', '-b', 'main'], remote);
  git([...id, 'add', '-A'], remote);
  git([...id, 'commit', '-qm', 'one'], remote);

  const counts = { install: 0, build: 0, start: 0 };
  mock.method(NpmLifecycle, 'install', async (appPath) => {
    counts.install += 1;
    // What real npm leaves behind for a lockfile-less repo:
    fs.mkdirSync(path.join(appPath, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(appPath, 'package-lock.json'), '{"lockfileVersion":3}\n');
  });
  mock.method(NpmLifecycle, 'build', async () => { counts.build += 1; });
  mock.method(ProcessManager, 'startProcess', async () => { counts.start += 1; return { success: true }; });
  mock.method(ProcessManager, 'getProcessStatus', async () => ({ exists: false }));

  const app = await AppManager.createApp('git-gating', 'npm');
  await queries.updateApp({ id: app.id, path: path.join(tmp, 'app') });
  await AppManager.updateApp(app.id, { port: 45791 });
  await queries.upsertAppGitSource({
    appId: app.id,
    url: require('url').pathToFileURL(remote).href,
    branch: 'main',
    autoUpdate: true,
    webhookSecret: 'test-secret'
  });

  try {
    await DeployManager.deployApp(app.id);
    assert.deepEqual(counts, { install: 1, build: 1, start: 1 }, 'first start installs + builds once');

    await DeployManager.stopApp(app.id);
    await DeployManager.deployApp(app.id);
    assert.deepEqual(counts, { install: 1, build: 1, start: 2 },
      'a no-op sync must not undo the platform-generated lockfile and re-run install+build');

    // The gate must still react to a real upstream dependency change.
    fs.writeFileSync(path.join(remote, 'package.json'), JSON.stringify({
      name: 'git-gating',
      dependencies: { ms: '^3.0.0' },
      scripts: { start: 'node index.js', build: 'node build.js' },
    }));
    git([...id, 'add', '-A'], remote);
    git([...id, 'commit', '-qm', 'two'], remote);
    await DeployManager.stopApp(app.id);
    await DeployManager.deployApp(app.id);
    assert.deepEqual(counts, { install: 2, build: 2, start: 3 },
      'an upstream dependency change must still reinstall and rebuild');
  } finally {
    mock.reset();
    await queries.deleteAppGitSource(app.id);
    await queries.deleteApp(app.id);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
