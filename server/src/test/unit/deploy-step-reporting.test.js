const { test, mock, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { queries, dbReady } = require('../helpers/setup');
const AppManager = require('../../services/app-manager');
const DeployJobs = require('../../services/deploy-jobs');
const DeployManager = require('../../services/deploy-manager');
const GitLifecycle = require('../../services/git-lifecycle');
const NpmLifecycle = require('../../services/npm-lifecycle');
const ProcessManager = require('../../services/process-manager');
const ProxyManager = require('../../services/proxy-manager');

before(async () => { await dbReady; });
afterEach(() => mock.reset());

// Real app row + real app directory containing the files its deploy type
// validates. npm apps get a package.json WITH a build script, so the real
// fingerprint gates in ensureBuilt run over a real tree.
async function makeApp(name, deployType) {
  const app = await AppManager.createApp(name, deployType);
  if (deployType === 'npm') {
    fs.writeFileSync(path.join(app.path, 'package.json'), JSON.stringify({
      name,
      scripts: { start: 'node index.js', build: 'node build.js' },
    }));
    fs.writeFileSync(path.join(app.path, 'index.js'), 'console.log(1)');
  } else {
    fs.writeFileSync(path.join(app.path, 'index.html'), '<h1>x</h1>');
  }
  return AppManager.getAppById(app.id);
}

// PM2 reports nothing running (reconcile keeps the DB truth), lifecycle
// launches and the edge-proxy reload are stubbed.
function mockStartEnvironment() {
  mock.method(ProcessManager, 'getProcessStatus', async () => ({ exists: false, status: 'stopped' }));
  mock.method(ProcessManager, 'startProcess', async () => ({ success: true }));
  mock.method(ProxyManager, 'regenerate', async () => ({ ok: true, skipped: true }));
}

// Stubbed install/build bodies, but the REAL fingerprint gating in
// ensureBuilt decides whether they run (same shape as npm-deploy-gating).
function mockNpmSteps(counts) {
  mock.method(NpmLifecycle, 'install', async (appPath) => {
    counts.install += 1;
    fs.mkdirSync(path.join(appPath, 'node_modules'), { recursive: true });
  });
  mock.method(NpmLifecycle, 'build', async () => { counts.build += 1; });
}

test('deployApp reports steps in order for an http-server app', async () => {
  const app = await makeApp('steps-http', 'http-server');
  mockStartEnvironment();
  const steps = [];
  try {
    const started = await DeployManager.deployApp(app.id, { onStep: (s) => steps.push(s) });
    assert.equal(started.status, 'running');
    // No git binding, no npm: exactly the three steps that ran.
    assert.deepEqual(steps, ['validate', 'launch', 'proxy']);
  } finally {
    await queries.deleteApp(app.id);
  }
});

test('deployApp reports git/install/build for a git-bound npm app', async () => {
  const app = await makeApp('steps-git-npm', 'npm');
  await queries.upsertAppGitSource({
    appId: app.id,
    url: 'https://example.com/repo.git',
    branch: 'main',
    autoUpdate: true,
    webhookSecret: 'test-secret'
  });
  mockStartEnvironment();
  mockNpmSteps({ install: 0, build: 0 });
  mock.method(GitLifecycle, 'prepareForStart', async () => ({ commit: 'sha1', warning: null }));
  const steps = [];
  try {
    await DeployManager.deployApp(app.id, { onStep: (s) => steps.push(s) });
    // Fixed order, every step present (first deploy: gates are fresh, so
    // install and build actually run and therefore get reported).
    assert.deepEqual(steps, ['validate', 'git', 'install', 'build', 'launch', 'proxy']);
    assert.equal(steps[0], 'validate');
    // Reported names must be members of DeployJobs.STEPS and arrive in
    // non-decreasing STEPS order — the runner writes them through advance().
    const idx = steps.map((s) => DeployJobs.STEPS.indexOf(s));
    assert.ok(idx.every((i) => i >= 0), `unknown step names reported: ${steps}`);
    for (let i = 1; i < idx.length; i++) {
      assert.ok(idx[i] >= idx[i - 1], `steps not monotonic under STEPS: ${steps}`);
    }
  } finally {
    await queries.deleteAppGitSource(app.id);
    await queries.deleteApp(app.id);
  }
});

test('deployApp without options behaves exactly as before', async () => {
  const app = await makeApp('steps-compat', 'npm');
  const counts = { install: 0, build: 0, start: 0 };
  mock.method(ProcessManager, 'getProcessStatus', async () => ({ exists: false, status: 'stopped' }));
  mock.method(ProcessManager, 'startProcess', async () => { counts.start += 1; return { success: true }; });
  mock.method(ProxyManager, 'regenerate', async () => ({ ok: true, skipped: true }));
  mockNpmSteps(counts);
  try {
    // No second argument at all: the default path must be untouched.
    const started = await DeployManager.deployApp(app.id);
    assert.equal(started.status, 'running');
    assert.deepEqual(counts, { install: 1, build: 1, start: 1 });

    // ensureBuilt called with NO options keeps the fingerprint-gated default
    // behavior (fresh fingerprints from the deploy above -> no work).
    await NpmLifecycle.ensureBuilt(app.id, app.path);
    assert.deepEqual(counts, { install: 1, build: 1, start: 1 },
      'a no-options ensureBuilt on fresh fingerprints must do exactly nothing');
  } finally {
    await queries.deleteApp(app.id);
  }
});

test('an app without a build script reports no build step', async () => {
  // Ruling 1 extends to build()'s early return: mustBuild can be true while
  // build() itself does nothing (no scripts.build), so no 'build' step is
  // reported for work that did not run. The mocked build counts anyway —
  // what matters is that the REPORT gate reads the real package.json.
  const app = await AppManager.createApp('steps-nobuild', 'npm');
  fs.writeFileSync(path.join(app.path, 'package.json'), JSON.stringify({
    name: 'steps-nobuild',
    scripts: { start: 'node index.js' },
  }));
  const counts = { install: 0, build: 0 };
  mockNpmSteps(counts);
  const steps = [];
  try {
    await NpmLifecycle.ensureBuilt(app.id, app.path, { onStep: (s) => steps.push(s) });
    assert.deepEqual(steps, ['install'],
      'a no-op build() (no build script) must report nothing');
    assert.equal(counts.install, 1);
  } finally {
    await queries.deleteApp(app.id);
  }
});

test('a throwing onStep does not fail the deploy', async () => {
  const app = await makeApp('steps-thrower', 'npm');
  const counts = { install: 0, build: 0 };
  mockStartEnvironment();
  mockNpmSteps(counts);
  let calls = 0;
  try {
    const started = await DeployManager.deployApp(app.id, {
      onStep: () => { calls += 1; throw new Error('listener exploded'); }
    });
    // Every report blew up, yet the deploy completed fully: the callback is
    // pure observability and can never break the orchestration.
    assert.equal(started.status, 'running');
    assert.equal(counts.install, 1);
    assert.equal(counts.build, 1);
    assert.equal(calls, 5, 'validate/install/build/launch/proxy each blew up once');
  } finally {
    await queries.deleteApp(app.id);
  }
});

test('a skipped install/build reports no step for it', async () => {
  // Ruling: the fingerprint gates skip `npm install` / `npm run build` on a
  // plain stop->start. A skipped step did 0ms of work, so it must NOT be
  // reported either — a badge stuck on "installing" over nothing is a lie
  // operators would learn to ignore. This is the regression net against a
  // future "simplification" that reports install/build unconditionally.
  const app = await makeApp('steps-skip', 'npm');
  const counts = { install: 0, build: 0 };
  mockStartEnvironment();
  mockNpmSteps(counts);
  const first = [];
  const second = [];
  try {
    await DeployManager.deployApp(app.id, { onStep: (s) => first.push(s) });
    assert.deepEqual(first, ['validate', 'install', 'build', 'launch', 'proxy']);

    // No file touched, no fingerprint changed: the gates skip both steps.
    await queries.updateAppStatus('stopped', app.id);
    await DeployManager.deployApp(app.id, { onStep: (s) => second.push(s) });

    assert.deepEqual(second, ['validate', 'launch', 'proxy'],
      'the gated-out install/build must report nothing at all');
    assert.equal(counts.install, 1);
    assert.equal(counts.build, 1);
  } finally {
    await queries.deleteApp(app.id);
  }
});
