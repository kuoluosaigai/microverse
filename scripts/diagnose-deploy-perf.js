#!/usr/bin/env node
/**
 * Deployment latency diagnostic — run it on the machine where deploys are slow.
 *
 *   node scripts/diagnose-deploy-perf.js env                # read-only probes
 *   node scripts/diagnose-deploy-perf.js start <appId>      # instrumented REAL start
 *
 * `env` measures the cost of each external dependency a deploy touches (PM2 CLI
 * spawn, npm registry round-trip, git remote round-trip, nginx validate/reload)
 * and prints what the DB says about every app (deploy type, git binding,
 * install/build fingerprints). It changes nothing.
 *
 * `start` wraps the real service-layer boundaries in timers and performs ONE
 * start of the given app (the same code path as POST /api/apps/:id/start), then
 * prints where the wall time went and which steps were skipped. The app ends up
 * running, exactly as clicking Start does.
 *
 * Run from the repository root so module resolution matches the platform's.
 */

const path = require('path');
const os = require('os');
const util = require('util');
const { execFile } = require('child_process');

const execFilePromise = util.promisify(execFile);
const REPO = process.cwd();
const req = (rel) => require(path.join(REPO, rel));

const timings = [];   // {label, ms}
const decisions = []; // {label, note}

function record(label, ms) { timings.push({ label, ms }); }
function decide(label, note) { decisions.push({ label, note }); }
function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}
function printTable(title) {
  if (!timings.length) return;
  console.log(`\n${title}`);
  const width = Math.max(...timings.map(r => r.label.length), 10);
  for (const r of timings) console.log(`  ${r.label.padEnd(width)}  ${fmtMs(r.ms).padStart(9)}`);
  const sum = timings.reduce((s, r) => s + (r.ms || 0), 0);
  console.log(`  ${'-'.repeat(width)}  ${'-'.repeat(9)}`);
  console.log(`  ${'sum of measured steps'.padEnd(width)}  ${fmtMs(sum).padStart(9)}`);
}
async function timed(label, fn, note) {
  const t = Date.now();
  try {
    const value = await fn();
    record(label, Date.now() - t);
    if (note) decide(label, note);
    return { ok: true, value };
  } catch (err) {
    record(`${label} FAILED`, Date.now() - t);
    decide(label, `FAILED: ${String((err && err.message) || err).slice(0, 160)}`);
    return { ok: false, error: err };
  }
}

async function loadPlatform() {
  const { queries, dbReady } = req('server/src/db');
  await dbReady;
  return { queries, config: req('server/src/config') };
}

/**
 * Patch every boundary the start path crosses so one real deploy reports its own
 * cost per call. Wrapping the module objects (not the callers) is what lets this
 * run against the production code path unchanged.
 */
function instrument() {
  const ProcessManager = req('server/src/services/process-manager');
  const NpmLifecycle = req('server/src/services/npm-lifecycle');
  const GitLifecycle = req('server/src/services/git-lifecycle');
  const ProxyManager = req('server/src/services/proxy-manager');
  const AppManager = req('server/src/services/app-manager');

  const wrapAsync = (obj, method, labelOf) => {
    const original = obj[method].bind(obj);
    obj[method] = async (...args) => {
      const t = Date.now();
      try {
        return await original(...args);
      } finally {
        record(labelOf(...args), Date.now() - t);
      }
    };
  };
  const wrapSync = (obj, method, labelOf, noteOf) => {
    const original = obj[method].bind(obj);
    obj[method] = (...args) => {
      const value = original(...args);
      decide(labelOf(...args), noteOf(value));
      return value;
    };
  };

  wrapAsync(ProcessManager, 'pm2Exec', args => `pm2 ${args[0]}`);
  wrapAsync(ProcessManager, 'isPortAvailable', port => `probeBind(:${port}) [first candidates]`);
  wrapAsync(NpmLifecycle, 'install', () => 'npm install');
  wrapAsync(NpmLifecycle, 'build', () => 'npm run build');
  wrapAsync(GitLifecycle, 'gitExec', args => `git ${args.slice(0, 2).join(' ')}`);
  wrapAsync(ProxyManager, 'regenerate', () => 'nginx regenerate (-t + reload)');
  wrapAsync(AppManager, 'validateAppDeployment', () => 'validate app files');

  const yesNo = (v) => v ? 'YES -> step will run' : 'no  -> step skipped';
  wrapSync(NpmLifecycle, 'needsInstall', () => 'gate: npm install', yesNo);
  wrapSync(NpmLifecycle, 'needsBuild', () => 'gate: npm run build', yesNo);
}

// ------------------------------------------------------------------ env probes
async function env() {
  const { queries, config } = await loadPlatform();
  const ProcessManager = req('server/src/services/process-manager');

  console.log('=== 1. Environment ===');
  console.log(`  node ${process.version} | ${process.platform} | ${os.cpus().length} cpu(s) | NODE_ENV=${config.server.nodeEnv}`);
  console.log(`  PROXY_ENABLED=${config.deployment.proxyEnabled} | git timeout=${config.git.timeoutMs}ms | npm install timeout=${config.deployment.npmInstallTimeoutMs}ms`);

  const apps = await queries.getAllApps();
  console.log(`\n=== 2. Apps in this database (${apps.length}) ===`);
  if (!apps.length) console.log('  (none)');
  for (const a of apps) {
    const state = await queries.getAppDeployState(a.id);
    const git = await queries.getAppGitSource(a.id);
    const nm = require('fs').existsSync(path.join(a.path, 'node_modules'));
    console.log(`  #${a.id} ${a.name}: ${a.deploy_type} / ${a.status} / port=${a.port || '-'} / node_modules=${nm ? 'yes' : 'MISSING'}`);
    console.log(`      install_fp=${state && state.install_fp ? state.install_fp.slice(0, 12) : 'NONE'} build_fp=${state && state.build_fp ? state.build_fp.slice(0, 12) : 'NONE'} updated=${state ? state.updated_at : '-'}`);
    if (git) console.log(`      git: ${git.url} (${git.branch}) auto_update=${git.auto_update} status=${git.last_status}`);
  }

  console.log('\n=== 3. PM2 CLI spawn cost (paid by every lifecycle op) ===');
  for (let i = 1; i <= 3; i++) await timed(`pm2 jlist #${i}`, () => ProcessManager.pm2Exec(['jlist']));
  printTable('PM2:');
  timings.length = 0;

  console.log('\n=== 4. npm registry reachability (npm install pays this) ===');
  const npmCli = ProcessManager.getNpmCliPath();
  let registry = '(unknown, assuming https://registry.npmjs.org)';
  try {
    const { stdout } = await execFilePromise(process.execPath, [npmCli, 'config', 'get', 'registry'], { timeout: 20000 });
    registry = String(stdout).trim() || registry;
  } catch (_e) { /* default */ }
  console.log(`  registry = ${registry}`);
  await timed('npm ping', () => execFilePromise(process.execPath, [npmCli, 'ping', '--registry', registry], { timeout: 30000 }).then(() => {}));
  printTable('npm:');
  timings.length = 0;

  const gitApps = [];
  for (const a of apps) {
    const g = await queries.getAppGitSource(a.id);
    if (g) gitApps.push({ a, g });
  }
  console.log(`\n=== 5. git remote reachability (${gitApps.length} git-bound app(s)) ===`);
  for (const { a, g } of gitApps.slice(0, 3)) {
    await timed(`git ls-remote ${a.name}`, () => execFilePromise(config.git.bin,
      ['ls-remote', '--heads', g.url, g.branch], { timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).then(() => {}), g.url);
  }
  printTable('git:');
  timings.length = 0;

  console.log('\n=== 6. nginx edge reload cost ===');
  if (!config.deployment.proxyEnabled) {
    console.log('  PROXY_ENABLED=false -> regenerate() short-circuits (~0 cost)');
  } else {
    const bin = config.deployment.proxyReloadBinary;
    await timed('nginx -t', () => execFilePromise(bin, ['-t'], { timeout: 20000 }).then(() => {}));
    await timed('nginx -s reload', () => execFilePromise(bin, ['-s', 'reload'], { timeout: 20000 }).then(() => {}));
    printTable('nginx:');
  }

  if (decisions.length) {
    console.log('\n=== notes ===');
    for (const d of decisions) console.log(`  ${d.label}: ${d.note}`);
  }
  console.log('\nNext: `node scripts/diagnose-deploy-perf.js start <appId>` for the real per-deploy breakdown.');
}

// ------------------------------------------------------------------ start mode
async function start(appId) {
  const { queries } = await loadPlatform();
  const app = await queries.getAppById(appId);
  if (!app) throw new Error(`No app with id ${appId}`);

  const DeployManager = req('server/src/services/deploy-manager');
  if (app.status === 'running') {
    console.log(`  #${app.id} ${app.name} is running -> stopping it first (a start refuses a live process).`);
    await DeployManager.stopApp(app.id);
  }

  console.log(`\nInstrumented REAL start of #${app.id} ${app.name} (${app.deploy_type}). Same path as the UI's Start button.`);
  instrument();

  const t = Date.now();
  let failure = null;
  try {
    await DeployManager.deployApp(app.id);
  } catch (err) {
    failure = err;
  }
  const total = Date.now() - t;

  console.log(`\n=== breakdown: ${app.name} (${app.deploy_type}) ===`);
  const width = Math.max(...timings.map(r => r.label.length), 10);
  for (const r of timings) console.log(`  ${r.label.padEnd(width)}  ${fmtMs(r.ms).padStart(9)}`);
  const sum = timings.reduce((s, r) => s + (r.ms || 0), 0);
  console.log(`  ${'-'.repeat(width)}  ${'-'.repeat(9)}`);
  console.log(`  ${'TOTAL deployApp'.padEnd(width)}  ${fmtMs(total).padStart(9)}`);
  console.log(`  ${'unaccounted (DB, event loop)'.padEnd(width)}  ${fmtMs(Math.max(0, total - sum)).padStart(9)}`);

  if (decisions.length) {
    console.log('\n=== gates (why each heavy step ran or not) ===');
    for (const d of decisions) console.log(`  ${d.label}: ${d.note}`);
  }
  console.log(`\n  app is now: ${failure ? `start FAILED (${failure.message})` : 'running'}`);
  if (failure) process.exitCode = 1;
}

(async () => {
  const mode = process.argv[2];
  if (mode === 'env') return env();
  if (mode === 'start') {
    const id = Number(process.argv[3]);
    if (!Number.isInteger(id) || id < 1) throw new Error('usage: start <appId>');
    return start(id);
  }
  console.log('usage: node scripts/diagnose-deploy-perf.js env | start <appId>');
  console.log('  env    read-only probes: PM2 spawn, npm registry, git remote, nginx + DB state');
  console.log('  start  one instrumented REAL start of an app, with per-boundary breakdown');
})().catch(err => {
  console.error((err && err.stack) || String(err));
  process.exit(1);
});
