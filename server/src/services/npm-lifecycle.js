const { exec, execFile, spawn } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { queries } = require('../db');
const config = require('../config');
const ProcessManager = require('./process-manager');
const { perfLine } = require('../utils/lap-timer');
const { DEPLOY_STEP } = require('../utils/deploy-steps');

const execPromise = util.promisify(exec);
const execFilePromise = util.promisify(execFile);

/**
 * NpmLifecycle — npm app install / build / env resolution.
 * Used by DeployManager for the npm deploy_type.
 */
class NpmLifecycle {
  /**
   * Read and parse an app's package.json.
   * @throws {Error} 'package.json not found' or 'Invalid package.json: ...'
   */
  static readPackageJson(appPath) {
    const pkgPath = path.join(appPath, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      throw new Error('package.json not found');
    }
    try {
      return JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    } catch (err) {
      throw new Error('Invalid package.json: ' + err.message);
    }
  }

  /**
   * Install fingerprint: sha256 over package.json (+ lockfile when present)
   * contents. Changes iff the dependency set definition changed.
   * @returns {string|null} null when package.json is unreadable
   */
  static installFingerprint(appPath) {
    try {
      const hash = crypto.createHash('sha256');
      hash.update(fs.readFileSync(path.join(appPath, 'package.json')));
      for (const lock of ['package-lock.json', 'npm-shrinkwrap.json']) {
        const lockPath = path.join(appPath, lock);
        if (fs.existsSync(lockPath)) {
          hash.update('\0' + lock + '\0');
          hash.update(fs.readFileSync(lockPath));
        }
      }
      return hash.digest('hex');
    } catch (_err) {
      return null;
    }
  }

  /**
   * Build fingerprint: sha256 over the app tree (relPath:size:mtimeMs per file,
   * sorted) WITHOUT reading file contents — cheap even for 100MB uploads.
   * Skips node_modules (npm's own state) and platform-managed files (per-app
   * PM2 ecosystem config, nginx artifacts). Any user-visible source change —
   * new upload, zip re-extract, env file edit — flips it; byte-identical
   * re-uploads with unchanged mtimes correctly do not.
   * @returns {string|null} null when the directory is unreadable
   */
  static buildFingerprint(appPath) {
    // `.git` is platform-managed state, not app source. A git sync rewrites its
    // internals (FETCH_HEAD/ORIG_HEAD/index/objects) on every start even when no
    // tracked file changed, so hashing it made the fingerprint — and therefore a
    // full `npm run build` — re-run on every single deploy of a Git-sourced app.
    const skip = new Set(['node_modules', '.git']);
    const skipName = (name) =>
      skip.has(name) || /^pm2\..*\.config\.cjs$/.test(name) || /^nginx[.]/.test(name);
    const lines = [];
    const walk = (dir, rel) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_err) {
        return false;
      }
      for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (skipName(e.name)) continue;
        const abs = path.join(dir, e.name);
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          lines.push(`d:${relPath}`);
          if (!walk(abs, relPath)) return false;
        } else if (e.isFile()) {
          try {
            const st = fs.statSync(abs);
            lines.push(`f:${relPath}:${st.size}:${Math.round(st.mtimeMs)}`);
          } catch (_err) {
            return false;
          }
        }
      }
      return true;
    };
    if (!walk(appPath, '')) return null;
    return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
  }

  /**
   * Does the app declare anything to install? `npm install` does not create
   * `node_modules` for a dependency-free package, so treating a missing
   * `node_modules` as "never installed" made every start of such an app re-run
   * install — and, because install forces a rebuild, a full `npm run build`.
   * @returns {boolean}
   */
  static hasDependencies(appPath) {
    let pkg;
    try {
      pkg = this.readPackageJson(appPath);
    } catch (_err) {
      return false; // unreadable package.json: install would fail anyway
    }
    return [pkg.dependencies, pkg.devDependencies].some(
      (deps) => deps && typeof deps === 'object' && Object.keys(deps).length > 0
    );
  }

  /**
   * Does this app need `npm install`? Always when the install fingerprint
   * changed since the stored one (null = never run), and when a dependency
   * tree that should exist is gone (manually deleted, or an interrupted install).
   */
  static needsInstall(appPath, savedFp) {
    if (this.hasDependencies(appPath) && !fs.existsSync(path.join(appPath, 'node_modules'))) return true;
    if (!savedFp) return true;
    const current = this.installFingerprint(appPath);
    return current !== savedFp;
  }

  /**
   * Does this app need `npm run build`? When the tree fingerprint changed
   * since the stored one (null = never run).
   */
  static needsBuild(appPath, savedFp) {
    if (!savedFp) return true;
    const current = this.buildFingerprint(appPath);
    return current !== savedFp;
  }

  /**
   * Fingerprint-gated `npm install` + `npm run build` for one app.
   * Shared by DeployManager.deployApp (start) and GitLifecycle.sync (pull) so
   * both honor app_deploy_state; a plain stop→start or a no-op sync does no work.
   * Post-run fingerprints are stored from the AFTER state because npm may
   * rewrite the lockfile itself; a dependency change (install ran) forces a
   * build even when app sources are untouched.
   * `force` skips the fingerprint gates and runs install + build unconditionally.
   * GitLifecycle's rollback uses it: a `git reset --hard` restores the OLD
   * package.json/lockfile, which matches the stored install fingerprint, but the
   * dependencies/build output must still be repaired after the failed attempt.
   * @param {number} appId
   * @param {string} appPath
   * @param {{ force?: boolean, logFile?: string|null, onStep?: ((step: string) => void)|null }} [options]
   *   logFile is the deploy job's log path (DeployJobs.claim() created it);
   *   install/build output streams into it so a background job's transcript
   *   survives on disk. null/undefined keeps the old in-memory-buffered
   *   behavior. onStep receives DEPLOY_STEP.INSTALL / DEPLOY_STEP.BUILD —
   *   the same names DeployJobs.STEPS exposes — immediately before that step RUNS,
   *   and never when a gate skips it (see the WHY comments inside); like
   *   every logging/progress hook here, a throwing listener is swallowed and
   *   can never fail the build.
   */
  static async ensureBuilt(appId, appPath, { force = false, logFile = null, onStep = null } = {}) {
    // Same contract as DeployManager.deployApp's report(): names come from
    // utils/deploy-steps (a leaf both modules require DOWN into — see the
    // acyclicity note in deploy-manager), and a throwing listener must not
    // break the install/build work any more than an unopenable log file can.
    const report = (step) => {
      if (!onStep) return;
      try {
        onStep(step);
      } catch (_err) {
        // ignore — progress reporting never touches the work
      }
    };

    const scope = path.basename(appPath);
    const state = await queries.getAppDeployState(appId);
    const mustInstall = force || this.needsInstall(appPath, state && state.install_fp);
    const installStartedAt = Date.now();
    if (mustInstall) {
      // WHY only here (and only when it runs): the fingerprint gates skip
      // `npm install` on a plain stop->start — gating behavior fixed by a
      // real production bug (npm-deploy-gating is its regression net).
      // Reporting 'install' unconditionally would park the UI badge on
      // "installing" for a step that does 0ms of work and did nothing, a lie
      // operators would quickly learn to distrust.
      report(DEPLOY_STEP.INSTALL);
      await this.install(appPath, { logFile });
      await queries.setUpDeployState(appId, { installFp: this.installFingerprint(appPath) });
      perfLine(scope, 'npm install', Date.now() - installStartedAt);
    } else {
      perfLine(scope, 'npm install', Date.now() - installStartedAt, 'skipped (fingerprint unchanged)');
    }
    const mustBuild = force || mustInstall || this.needsBuild(appPath, state && state.build_fp);
    const buildStartedAt = Date.now();
    if (mustBuild) {
      // build() no-ops for apps without a build script, so THAT case reports
      // nothing either — same no-work-no-step rule as install above. This
      // package.json read decides the REPORT only: the build() call, its
      // error contract, and the fingerprint bookkeeping are unchanged, and
      // an unreadable package.json simply reports nothing before build()
      // throws its own 'package.json not found' / 'Invalid package.json'.
      let hasBuildScript = false;
      try {
        const pkg = this.readPackageJson(appPath);
        hasBuildScript = Boolean(pkg.scripts && typeof pkg.scripts.build === 'string');
      } catch (_err) {
        // fall through: build() below surfaces the real error
      }
      if (hasBuildScript) report(DEPLOY_STEP.BUILD);
      await this.build(appPath, { logFile }); // no-op when there is no build script
      await queries.setUpDeployState(appId, { buildFp: this.buildFingerprint(appPath) });
      perfLine(scope, 'npm run build', Date.now() - buildStartedAt);
    } else {
      perfLine(scope, 'npm run build', Date.now() - buildStartedAt, 'skipped (fingerprint unchanged)');
    }
  }

  /**
   * Run the npm CLI with an argument array (no shell interpolation).
   * Prefers npm's JS entry (npm-cli.js beside the running node binary) so it
   * behaves identically on Windows, where a bare `npm` is a .cmd shim Node
   * refuses to execFile without a shell. Falls back to a shell string only
   * when the entry is unresolvable — the command is then a fixed platform
   * string (no user input), the shell merely supplies PATH resolution.
   *
   * With `options.logFile` the child runs through spawn with stdout/stderr
   * attached to that file's fd instead: a real `npm install` can outgrow any
   * in-memory maxBuffer, and a background deploy job must leave its transcript
   * on disk for the operator. Failure messages then read their tail back from
   * the file (see readOutputTail). If the file cannot be opened we degrade to
   * the buffered path — a logging problem must never fail an install (Review
   * Focus 4). The shell fallback does not exist in the logFile path: the
   * no-shell rule (argument injection, see ProcessManager.pm2Exec) applies
   * here, and a host where npm-cli.js is unresolvable surfaces that as a
   * normal spawn error instead of being papered over with cmd.exe.
   * @param {string[]} args npm CLI arguments
   * @param {{ cwd?: string, timeout?: number, maxBuffer?: number, logFile?: string|null }} options
   */
  static async npmExec(args, options = {}) {
    const { logFile, ...execOptions } = options;
    const npmCli = ProcessManager.getNpmCliPath();

    let fd = null;
    if (logFile) {
      try {
        fd = fs.openSync(logFile, 'a');
      } catch (_err) {
        fd = null; // unopenable/unwritable log -> buffered run, never an error
      }
    }
    if (fd !== null) {
      try {
        return await this.spawnToLogFile(args, execOptions, npmCli, logFile, fd);
      } finally {
        // Closed on EVERY path (success, npm failure, timeout/kill). The child
        // holds its own inherited dup; the parent must not keep the fd — and
        // with it the log file — alive past the run.
        try {
          fs.closeSync(fd);
        } catch (_err) {
          // ignore close errors
        }
      }
    }

    if (npmCli !== 'npm') {
      return execFilePromise(process.execPath, [npmCli, ...args], execOptions);
    }
    return execPromise(`npm ${args.map(a => `"${a}"`).join(' ')}`, execOptions);
  }

  /**
   * spawn() npm with both output channels on an inherited fd (no shell —
   * never `{ shell: true }`, see npmExec). Resolves like execFile with empty
   * channels (the transcript is on disk, not in memory) and rejects with an
   * execFile-shaped error so install()/build() keep their exact catch-side
   * contracts: `.killed` for timeouts, and a readable tail in `.stderr` —
   * here read back from the log file, since the child wrote nothing to any
   * captured stream.
   * @returns {Promise<{stdout: string, stderr: string}>}
   */
  static spawnToLogFile(args, { cwd, timeout }, npmCli, logFile, fd) {
    const command = npmCli !== 'npm' ? process.execPath : 'npm';
    const fullArgs = npmCli !== 'npm' ? [npmCli, ...args] : args;
    return new Promise((resolve, reject) => {
      let timedOut = false;
      const child = spawn(command, fullArgs, { cwd, stdio: ['ignore', fd, fd] });
      const timer = timeout
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, timeout)
        : null;
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code, signal) => {
        if (timer) clearTimeout(timer);
        if (timedOut) {
          const err = new Error(`npm run timed out after ${timeout}ms: ${command} ${fullArgs.join(' ')}`);
          err.killed = true; // mirrors the execFile timeout shape install() checks
          return reject(err);
        }
        if (code !== 0) {
          const err = new Error(`Command failed: ${command} ${fullArgs.join(' ')}`);
          err.code = code;
          err.signal = signal;
          // The message tail comes from the file, not from a captured stream.
          err.stderr = this.readOutputTail(logFile);
          return reject(err);
        }
        resolve({ stdout: '', stderr: '' });
      });
    });
  }

  /**
   * Last `bytes` of a log file as text — the failure-message tail when output
   * was streamed to disk. Deliberately a local function: DeployJobs (which has
   * its own tail()) sits ABOVE npm-lifecycle in the call hierarchy (job
   * runners -> DeployJobs -> DeployManager/GitLifecycle -> this module), so
   * requiring it here would invert that direction and close a real require
   * cycle as soon as a runner loads both. Simpler than DeployJobs.tail by
   * design: no line splitting, no ANSI stripping — this text is only sliced
   * to 500 chars for a one-line error message, never rendered to a human.
   * Never throws: a broken log read must not mask the real npm failure.
   * @returns {string}
   */
  static readOutputTail(logPath, bytes = 4096) {
    let fd;
    try {
      const size = fs.statSync(logPath).size;
      if (size === 0) return '';
      // Read at most the tail — deploy logs carry real npm output and must
      // never be slurped whole.
      const start = Math.max(0, size - bytes);
      const buffer = Buffer.alloc(size - start);
      fd = fs.openSync(logPath, 'r');
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } catch (_err) {
      return '';
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch (_err) {
          // ignore close errors
        }
      }
    }
  }

  /**
   * Run `npm install` in the app directory.
   * @param {string} appPath
   * @param {{ logFile?: string|null }} [options] job log file; see npmExec
   */
  static async install(appPath, { logFile } = {}) {
    try {
      // --include=dev: the platform runs under NODE_ENV=production, which makes
      // plain `npm install` omit devDependencies. Build tools (@vue/cli-service,
      // vite, tsc, ...) live in devDependencies and are required for `npm run
      // build`, so install MUST include them. --no-audit/--no-fund skip
      // non-essential network calls during deploy.
      await this.npmExec(['install', '--include=dev', '--no-audit', '--no-fund'], {
        cwd: appPath,
        timeout: config.deployment.npmInstallTimeoutMs,
        maxBuffer: 4 * 1024 * 1024, // buffered path only; logFile streams to disk instead
        logFile,
      });
    } catch (err) {
      if (err.killed || /TIMEDOUT/i.test(err.message || '')) {
        throw new Error('npm install timed out');
      }
      throw new Error('npm install failed: ' + (err.stderr || err.stdout || err.message).slice(-500));
    }
  }

  /**
   * Run `npm run build` if a build script exists; otherwise no-op.
   * @param {string} appPath
   * @param {{ logFile?: string|null }} [options] job log file; see npmExec
   */
  static async build(appPath, { logFile } = {}) {
    const pkg = this.readPackageJson(appPath);
    if (!pkg.scripts || typeof pkg.scripts.build !== 'string') {
      return;
    }
    try {
      await this.npmExec(['run', 'build'], {
        cwd: appPath,
        timeout: config.deployment.npmBuildTimeoutMs,
        maxBuffer: 4 * 1024 * 1024, // buffered path only; logFile streams to disk instead
        logFile,
      });
    } catch (err) {
      if (err.killed || /TIMEDOUT/i.test(err.message || '')) {
        throw new Error('npm run build timed out');
      }
      throw new Error('build failed: ' + (err.stderr || err.stdout || err.message).slice(-500));
    }
  }

  /**
   * Resolve the env object for PM2: user-defined vars + platform-forced PORT.
   * PORT is always set to the platform-assigned port (user cannot override).
   */
  static async resolveEnv(appId, port) {
    const rows = await queries.getAppEnv(appId);
    const env = {};
    for (const r of rows) {
      env[r.key] = r.value === null ? '' : r.value;
    }
    env.PORT = String(port);
    return env;
  }
}

module.exports = NpmLifecycle;
