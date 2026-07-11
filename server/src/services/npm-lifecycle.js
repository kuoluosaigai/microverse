const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
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
   * Run `npm install` in the app directory.
   * exec runs through the shell, so the npm .cmd wrapper works on Windows.
   */
  static async install(appPath) {
    try {
      await execPromise('npm install', {
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
