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
// launches and the edge-proxy reload are stubbed. The regenerate stub returns
// a NON-skipped success (the enabled-proxy shape), so the proxy step counts as
// real work and IS reported; the skipped path is pinned separately below.
function mockStartEnvironment() {
  mock.method(ProcessManager, 'getProcessStatus', async () => ({ exists: false, status: 'stopped' }));
  mock.method(ProcessManager, 'startProcess', async () => ({ success: true }));
  mock.method(ProxyManager, 'regenerate', async () => ({ ok: true }));
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
    // Real execution order (plan revision): the git block physically runs
    // BEFORE validation, so every step is reported immediately before its
    // work and 'git' is the FIRST report for a git-bound app. First deploy:
    // gates are fresh, so install/build really run and are reported.
    assert.deepEqual(steps, ['git', 'validate', 'install', 'build', 'launch', 'proxy']);
    assert.equal(steps[0], 'git');
    // Names stay members of the shared step list (DeployJobs.STEPS is the
    // re-exported DEPLOY_STEPS from utils/deploy-steps).
    assert.ok(steps.every((s) => DeployJobs.STEPS.includes(s)), `unknown step names reported: ${steps}`);
  } finally {
    await queries.deleteAppGitSource(app.id);
    await queries.deleteApp(app.id);
  }
});

test('a git-prepare failure leaves git as the last reported step', async () => {
  // The observability point of reporting 'git' BEFORE prepareForStart: while
  // a clone/fetch hangs or dies, the job's current step is 'git' — it no
  // longer masquerades as validation. A rejection mid-prepare is the test
  // stand-in for a hang: the callback stream simply stops at 'git'.
  const app = await makeApp('steps-git-hang', 'npm');
  await queries.upsertAppGitSource({
    appId: app.id,
    url: 'https://example.com/repo.git',
    branch: 'main',
    autoUpdate: true,
    webhookSecret: 'test-secret'
  });
  mockStartEnvironment();
  mock.method(GitLifecycle, 'prepareForStart', async () => {
    throw new Error('git fetch hung');
  });
  const steps = [];
  try {
    await assert.rejects(
      () => DeployManager.deployApp(app.id, { onStep: (s) => steps.push(s) }),
      /git fetch hung/
    );
    assert.deepEqual(steps, ['git'], 'validate must NOT have been reported while git was current');
  } finally {
    await queries.deleteAppGitSource(app.id);
    await queries.deleteApp(app.id);
  }
});

test('a skipped proxy regenerate reports no proxy step', async () => {
  // Ruling 1 applied to proxy: with PROXY_ENABLED=false (the test-env
  // default) the REAL regenerate short-circuits to { skipped: true } in 0ms —
  // nothing ran, so nothing is reported. A THROWING regenerate is not a
  // skip: the step was started, so it still counts as reported.
  const app = await makeApp('steps-proxy-skip', 'http-server');
  mock.method(ProcessManager, 'getProcessStatus', async () => ({ exists: false, status: 'stopped' }));
  mock.method(ProcessManager, 'startProcess', async () => ({ success: true }));
  const steps = [];
  try {
    await DeployManager.deployApp(app.id, { onStep: (s) => steps.push(s) });
    assert.deepEqual(steps, ['validate', 'launch'],
      'the disabled-proxy skip must report no proxy step');

    // Throw path: best-effort regenerate fails, deploy still succeeds, and
    // the step that began is visible.
    await queries.updateAppStatus('stopped', app.id);
    mock.method(ProxyManager, 'regenerate', async () => { throw new Error('nginx reload failed'); });
    mock.method(console, 'warn', () => {});
    const steps2 = [];
    const started = await DeployManager.deployApp(app.id, { onStep: (s) => steps2.push(s) });
    assert.equal(started.status, 'running');
    assert.deepEqual(steps2, ['validate', 'launch', 'proxy'],
      'a throwing regenerate was started, so it counts as reported');
  } finally {
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
