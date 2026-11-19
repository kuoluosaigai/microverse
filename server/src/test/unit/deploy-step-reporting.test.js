const { test, mock, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { queries, dbReady } = require('../helpers/setup');
const AppManager = require('../../services/app-manager');
const config = require('../../config');
const DeployJobs = require('../../services/deploy-jobs');
const DeployManager = require('../../services/deploy-manager');
const GitLifecycle = require('../../services/git-lifecycle');
const NginxLifecycle = require('../../services/nginx-lifecycle');
const NpmLifecycle = require('../../services/npm-lifecycle');
const ProcessManager = require('../../services/process-manager');
const ProxyManager = require('../../services/proxy-manager');
const { DEPLOY_STEPS, DEPLOY_KINDS } = require('../../utils/deploy-steps');

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
// launches and the edge-proxy reload are stubbed. The regenerate stub only
// keeps real nginx logic out of the test - deployApp reads the CONFIG flag
// before calling it, so the returned shape no longer drives anything.
function mockStartEnvironment() {
  mock.method(ProcessManager, 'getProcessStatus', async () => ({ exists: false, status: 'stopped' }));
  mock.method(ProcessManager, 'startProcess', async () => ({ success: true }));
  mock.method(ProxyManager, 'regenerate', async () => ({ ok: true }));
}

// Expectations that INCLUDE the proxy step must pin PROXY_ENABLED on: the
// report is gated on config.deployment.proxyEnabled BEFORE the call, so a
// flipped ambient .env must never silently drop steps (or add real nginx
// calls). Returns a restore callback for the test's finally block.
function stubProxyEnabled(enabled = true) {
  const previous = config.deployment.proxyEnabled;
  config.deployment.proxyEnabled = enabled;
  return () => { config.deployment.proxyEnabled = previous; };
}

// Task 11's progress ladder: a reported sequence must move strictly forward
// in DeployJobs.STEPS order - index+1 is "step N of M". Guards against any
// future step being reported out of its ladder position (the git/validate
// masquerade this file exists to fix).
function assertForwardLadder(steps) {
  let last = -1;
  for (const step of steps) {
    const i = DeployJobs.STEPS.indexOf(step);
    assert.ok(i >= 0, `unknown step name reported: ${steps}`);
    assert.ok(i > last, `reported steps must advance strictly forward in the STEPS ladder: ${steps}`);
    last = i;
  }
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
  const restoreProxy = stubProxyEnabled();
  try {
    const started = await DeployManager.deployApp(app.id, { onStep: (s) => steps.push(s) });
    assert.equal(started.status, 'running');
    // No git binding, no npm: exactly the steps that ran, in ladder order.
    assert.deepEqual(steps, ['validate', 'launch', 'proxy']);
    assertForwardLadder(steps);
  } finally {
    restoreProxy();
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
  const restoreProxy = stubProxyEnabled();
  try {
    await DeployManager.deployApp(app.id, { onStep: (s) => steps.push(s) });
    // Real execution order: the git block physically runs BEFORE
    // validationAppDeployment, so 'git' is the FIRST report for a git-bound
    // app and every step is reported immediately before its work. First
    // deploy: gates are fresh, so install/build really run and are reported.
    assert.deepEqual(steps, ['git', 'validate', 'install', 'build', 'launch', 'proxy']);
    assert.equal(steps[0], 'git');
    assertForwardLadder(steps);
  } finally {
    restoreProxy();
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

test('nginx apps report a dedicated nginx step before launch', async () => {
  // generateConfig/testConfig used to hide in the gap between 'validate'
  // and 'launch' - the same masquerade the git fix killed: a hanging
  // `nginx -t` displayed 'validate'. The NGINX step names that work and is
  // reported before it.
  const app = await makeApp('steps-nginx', 'nginx');
  mockStartEnvironment();
  const order = [];
  mock.method(NginxLifecycle, 'generateConfig', (p, n) => { order.push('generate'); return path.join(p, `nginx.${n}.conf`); });
  mock.method(NginxLifecycle, 'testConfig', async () => { order.push('test'); return { ok: true }; });
  const steps = [];
  const restoreProxy = stubProxyEnabled();
  try {
    const started = await DeployManager.deployApp(app.id, { onStep: (s) => steps.push(s) });
    assert.equal(started.status, 'running');
    assert.deepEqual(steps, ['validate', 'nginx', 'launch', 'proxy']);
    assertForwardLadder(steps);
    // The step is reported before the work it names, not after:
    assert.deepEqual(order, ['generate', 'test']);
  } finally {
    restoreProxy();
    await queries.deleteApp(app.id);
  }
});

test('the proxy step follows the proxyEnabled config, not the result', async () => {
  // Proxy reporting is gated on config.deployment.proxyEnabled BEFORE the
  // call, like every other step reports before its work — so a hung
  // `nginx -s reload` shows 'proxy' instead of silently keeping the previous
  // step. The flag is pinned explicitly in every scenario: no test may
  // depend on the ambient PROXY_ENABLED default, which a future .env flip
  // could turn into either missing steps or real nginx calls.
  const app = await makeApp('steps-proxy-gate', 'http-server');
  mock.method(ProcessManager, 'getProcessStatus', async () => ({ exists: false, status: 'stopped' }));
  mock.method(ProcessManager, 'startProcess', async () => ({ success: true }));
  const previousProxy = config.deployment.proxyEnabled;
  try {
    // (1) Disabled: regenerate() is a 0ms skip (the real short-circuit, same
    // config gate) - nothing runs, nothing is reported.
    config.deployment.proxyEnabled = false;
    const steps1 = [];
    await DeployManager.deployApp(app.id, { onStep: (s) => steps1.push(s) });
    assert.deepEqual(steps1, ['validate', 'launch'], 'disabled proxy reports no proxy step');

    // (2) Enabled + throwing regenerate: reported (before the call). A
    // skip is not a failure; deployApp treats this path as best-effort and
    // the deploy still succeeds. regenerate() is documented never-throw, so
    // this arm pins the contract, not a production route.
    await queries.updateAppStatus('stopped', app.id);
    config.deployment.proxyEnabled = true;
    mock.method(ProxyManager, 'regenerate', async () => { throw new Error('nginx reload failed'); });
    mock.method(console, 'warn', () => {});
    const steps2 = [];
    const started = await DeployManager.deployApp(app.id, { onStep: (s) => steps2.push(s) });
    assert.equal(started.status, 'running');
    assert.deepEqual(steps2, ['validate', 'launch', 'proxy'],
      'a throwing regenerate was started, so it is reported');

    // (3) Enabled but internally skipped for no-base-domain: reported. It
    // really runs DB queries and attempts the conf write, so showing
    // "edge proxy" for a misconfigured domain is not a lie - the accepted
    // cost of one uniform config gate instead of branching on every reason.
    await queries.updateAppStatus('stopped', app.id);
    mock.method(ProxyManager, 'regenerate', async () => ({ ok: false, skipped: true, reason: 'no-base-domain' }));
    const steps3 = [];
    await DeployManager.deployApp(app.id, { onStep: (s) => steps3.push(s) });
    assert.deepEqual(steps3, ['validate', 'launch', 'proxy'],
      'an enabled-proxy no-base-domain skip did run work and is reported');
  } finally {
    config.deployment.proxyEnabled = previousProxy;
    await queries.deleteApp(app.id);
  }
});

test('deployApp without options behaves exactly as before', async () => {
  const app = await makeApp('steps-compat', 'npm');
  const counts = { install: 0, build: 0, start: 0 };
  mock.method(ProcessManager, 'getProcessStatus', async () => ({ exists: false, status: 'stopped' }));
  mock.method(ProcessManager, 'startProcess', async () => { counts.start += 1; return { success: true }; });
  mock.method(ProxyManager, 'regenerate', async () => ({ ok: true }));
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
  const restoreProxy = stubProxyEnabled();
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
    restoreProxy();
    await queries.deleteApp(app.id);
  }
});

test('utils/deploy-steps is a leaf: loading it pulls in no service', () => {
  // The single-source-of-truth refactor is safe only because the constants
  // module requires NOTHING upward: pin that as an assertion, not a comment.
  // It must run in a CLEAN child process — this one already has every
  // service in its require cache through helpers/setup — and a self-referential
  // require of a constants file must never load deploy-jobs/deploy-manager.
  const modulePath = require.resolve('../../utils/deploy-steps');
  const probe = [
    'require(process.argv[1]);',
    'const services = Object.keys(require.cache)',
    '  .map((p) => p.split(require("path").sep).join("/"))',
    '  .filter((p) => p.includes("/src/services/"));',
    'process.stdout.write(JSON.stringify(services));'
  ].join('\n');
  const loaded = execFileSync(process.execPath, ['-e', probe, modulePath], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(loaded), [],
    'deploy-steps must not drag any service (deploy-jobs, deploy-manager, ...) into the require graph');
  // Re-export IDENTITY, not content equality: a same-content hand copy
  // could still drift, so assert the very same reference.
  assert.equal(DeployJobs.STEPS, DEPLOY_STEPS, 'DeployJobs.STEPS must be THE utils array');
  assert.equal(DeployJobs.KINDS, DEPLOY_KINDS, 'DeployJobs.KINDS must be THE utils object');
  // The list order IS the execution/report ladder (Task 11 renders
  // "step N of M" straight from index+1): git before validate, the nginx
  // config work between build and launch.
  assert.deepEqual(DEPLOY_STEPS,
    ['queued', 'git', 'validate', 'install', 'build', 'nginx', 'launch', 'proxy', 'done']);
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
  const restoreProxy = stubProxyEnabled();
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
    restoreProxy();
    await queries.deleteApp(app.id);
  }
});
