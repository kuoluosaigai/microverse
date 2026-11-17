const { exec, execFile } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { queries } = require('../db');
const config = require('../config');
const ProcessManager = require('./process-manager');
const { perfLine } = require('../utils/lap-timer');

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
   * @param {{ force?: boolean }} [options]
   */
  static async ensureBuilt(appId, appPath, { force = false } = {}) {
    const scope = path.basename(appPath);
    const state = await queries.getAppDeployState(appId);
    const mustInstall = force || this.needsInstall(appPath, state && state.install_fp);
    const installStartedAt = Date.now();
    if (mustInstall) {
      await this.install(appPath);
      await queries.setUpDeployState(appId, { installFp: this.installFingerprint(appPath) });
      perfLine(scope, 'npm install', Date.now() - installStartedAt);
    } else {
      perfLine(scope, 'npm install', Date.now() - installStartedAt, 'skipped (fingerprint unchanged)');
    }
    const mustBuild = force || mustInstall || this.needsBuild(appPath, state && state.build_fp);
    const buildStartedAt = Date.now();
    if (mustBuild) {
      await this.build(appPath); // no-op when there is no build script
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
   */
  static async npmExec(args, options = {}) {
    const npmCli = ProcessManager.getNpmCliPath();
    if (npmCli !== 'npm') {
      return execFilePromise(process.execPath, [npmCli, ...args], options);
    }
    return execPromise(`npm ${args.map(a => `"${a}"`).join(' ')}`, options);
  }

  /**
   * Run `npm install` in the app directory.
   */
  static async install(appPath) {
    try {
      // --include=dev: the platform runs under NODE_ENV=production, which makes
      // plain `npm install` omit devDependencies. Build tools (@vue/cli-service,
      // vite, tsc, ...) live in devDependencies and are required for `npm run
      // build`, so install MUST include them. --no-audit/--no-fund skip
      // non-essential network calls during deploy.
      await this.npmExec(['install', '--include=dev', '--no-audit', '--no-fund'], {
        cwd: appPath,
        timeout: config.deployment.npmInstallTimeoutMs,
        maxBuffer: 4 * 1024 * 1024,
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
   */
  static async build(appPath) {
    const pkg = this.readPackageJson(appPath);
    if (!pkg.scripts || typeof pkg.scripts.build !== 'string') {
      return;
    }
    try {
      await this.npmExec(['run', 'build'], {
        cwd: appPath,
        timeout: config.deployment.npmBuildTimeoutMs,
        maxBuffer: 4 * 1024 * 1024,
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
