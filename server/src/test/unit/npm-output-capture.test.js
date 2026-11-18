const { test, mock, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { queries, dbReady } = require('../helpers/setup');
const AppManager = require('../../services/app-manager');
const NpmLifecycle = require('../../services/npm-lifecycle');
const ProcessManager = require('../../services/process-manager');

before(async () => { await dbReady; });

/**
 * Stand-in for npm's JS entry (npm-cli.js). npmExec runs
 * `process.execPath <resolved-cli> <args>` whenever getNpmCliPath() returns
 * something other than the bare 'npm' fallback, so overriding getNpmCliPath
 * with a fixture path turns the child into a REAL `node` process we control
 * — the only way to verify fd-inherited streaming through an actual spawn
 * without running an actual npm install. Behaviour is driven by env vars
 * (install() owns the argument array), which spawn/execFile inherit by
 * default:
 *   FAKE_NPM_EXIT   — exit code (default 0)
 *   FAKE_NPM_FILLER — extra stderr bytes before the markers (pins the 500-char tail)
 */
const FAKE_NPM_SOURCE = `
const filler = Number(process.env.FAKE_NPM_FILLER || 0);
if (filler > 0) console.error('e'.repeat(filler));
console.log('npm-stdout-marker');
console.error('npm-stderr-marker');
process.exit(Number(process.env.FAKE_NPM_EXIT || '0'));
`;

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-output-'));
const fakeNpmCli = path.join(workRoot, 'fake-npm-cli.js');
fs.writeFileSync(fakeNpmCli, FAKE_NPM_SOURCE);
process.on('exit', () => {
  try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
});

function tmpAppDir(name) {
  const dir = path.join(workRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Route npmExec through the fake CLI instead of the real npm. */
function useFakeNpm() {
  mock.method(ProcessManager, 'getNpmCliPath', () => fakeNpmCli);
}

test('install with logFile streams npm stdout and stderr into the file', async () => {
  const dir = tmpAppDir('stream-ok');
  const logFile = path.join(dir, 'deploy.log');
  fs.writeFileSync(logFile, ''); // DeployJobs.claim() pre-creates the file
  useFakeNpm();
  try {
    await NpmLifecycle.install(dir, { logFile });
    const content = fs.readFileSync(logFile, 'utf8');
    // Both channels must reach the file through the inherited fd — a
    // stdout-only (or memory-buffered) implementation goes red here.
    assert.match(content, /npm-stdout-marker/, 'npm stdout must stream into the log file');
    assert.match(content, /npm-stderr-marker/, 'npm stderr must stream into the log file');
  } finally {
    mock.reset();
  }
});

test('install without logFile keeps returning stderr in the thrown message', async () => {
  const dir = tmpAppDir('buffered-fail');
  useFakeNpm();
  process.env.FAKE_NPM_EXIT = '1';
  process.env.FAKE_NPM_FILLER = '1000';
  try {
    await assert.rejects(() => NpmLifecycle.install(dir), (err) => {
      // The contract routes/apps.js and routes/git.js string-match on, and
      // the last-500-chars summary contract, must hold byte-identically.
      assert.match(err.message, /^npm install failed: /);
      assert.match(err.message, /npm-stderr-marker/, '500-char stderr tail must still be readable');
      assert.ok(
        err.message.length <= 'npm install failed: '.length + 500,
        'the failure summary must stay capped at 500 chars, got ' + err.message.length
      );
      return true;
    });
  } finally {
    delete process.env.FAKE_NPM_EXIT;
    delete process.env.FAKE_NPM_FILLER;
    mock.reset();
  }
});

test('a failing install still writes its output to the log file', async () => {
  const dir = tmpAppDir('stream-fail');
  const logFile = path.join(dir, 'deploy.log');
  fs.writeFileSync(logFile, '');
  useFakeNpm();
  process.env.FAKE_NPM_EXIT = '1';
  try {
    await assert.rejects(() => NpmLifecycle.install(dir, { logFile }), (err) => {
      assert.match(err.message, /^npm install failed: /);
      // The message tail now comes from the FILE (stdout+stderr interleaved):
      // a buffered implementation could never put the STDOUT marker here,
      // because execFile keeps stdout out of err.stderr.
      assert.match(err.message, /npm-stdout-marker/, 'error tail must be read back from the log file');
      assert.match(err.message, /npm-stderr-marker/);
      return true;
    });
    // A failed run loses nothing: its partial output is on disk for the operator.
    const content = fs.readFileSync(logFile, 'utf8');
    assert.match(content, /npm-stdout-marker/);
    assert.match(content, /npm-stderr-marker/);
  } finally {
    delete process.env.FAKE_NPM_EXIT;
    mock.reset();
  }
});

test('logFile is passed down from ensureBuilt to install and build', async () => {
  // Real app row: ensureBuilt persists fingerprints through app_deploy_state,
  // whose FK (PRAGMA foreign_keys=ON) needs apps.id to exist.
  const app = await AppManager.createApp('output-capture', 'npm');
  const dir = tmpAppDir('ensure-down');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'output-capture',
    scripts: { start: 'node index.js', build: 'node build.js' },
  }));
  const logFile = path.join(dir, 'deploy.log');
  const seen = {};
  mock.method(NpmLifecycle, 'install', async (appPath, opts) => { seen.install = opts; });
  mock.method(NpmLifecycle, 'build', async (appPath, opts) => { seen.build = opts; });
  try {
    await NpmLifecycle.ensureBuilt(app.id, dir, { force: true, logFile });
    assert.equal(seen.install.logFile, logFile, 'install must receive the job log file');
    assert.equal(seen.build.logFile, logFile, 'build must receive the same job log file');
  } finally {
    mock.reset();
    await queries.deleteApp(app.id);
  }
});

test('an unopenable log file degrades to no logging, not a failed install', async () => {
  const dir = tmpAppDir('unopenable');
  // Parent directory does not exist -> fs.openSync(logFile, 'a') throws ENOENT.
  const badLogFile = path.join(dir, 'missing-sub', 'deploy.log');
  useFakeNpm();
  try {
    // Success case: the install still completes, and the failed log open
    // creates nothing on the way (Review Focus 4: logging never fails work).
    await NpmLifecycle.install(dir, { logFile: badLogFile });
    assert.ok(!fs.existsSync(path.dirname(badLogFile)), 'degraded run must not create log dirs');

    // Failure case: the old buffered contract still reports the real npm error.
    process.env.FAKE_NPM_EXIT = '1';
    await assert.rejects(() => NpmLifecycle.install(dir, { logFile: badLogFile }), (err) => {
      assert.match(err.message, /^npm install failed: /);
      assert.match(err.message, /npm-stderr-marker/, 'degraded run must fall back to the buffered stderr tail');
      return true;
    });
  } finally {
    delete process.env.FAKE_NPM_EXIT;
    mock.reset();
  }
});
