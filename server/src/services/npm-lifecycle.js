const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { queries } = require('../db');
const config = require('../config');

const execPromise = util.promisify(exec);

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
    const skip = new Set(['node_modules']);
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
   * Does this app need `npm install`? Always when node_modules is missing or
   * the install fingerprint changed since the stored one (null = never run).
   */
  static needsInstall(appPath, savedFp) {
    if (!fs.existsSync(path.join(appPath, 'node_modules'))) return true;
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
   * Run `npm install` in the app directory.
   * exec runs through the shell, so the npm .cmd wrapper works on Windows.
   */
  static async install(appPath) {
    try {
      // --include=dev: the platform runs under NODE_ENV=production, which makes
      // plain `npm install` omit devDependencies. Build tools (@vue/cli-service,
      // vite, tsc, ...) live in devDependencies and are required for `npm run
      // build`, so install MUST include them. --no-audit/--no-fund skip
      // non-essential network calls during deploy.
      await execPromise('npm install --include=dev --no-audit --no-fund', {
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
      await execPromise('npm run build', {
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
