const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const execPromise = util.promisify(exec);

/**
 * NginxLifecycle — config generation, binary resolution, and pre-flight checks
 * for the nginx deploy_type (static-site server). Mirrors the NpmLifecycle
 * pattern. Used by DeployManager (generate + test before launch) and
 * ProcessManager (binary path for the PM2 entry); app.js calls probe() at boot.
 */
class NginxLifecycle {
  /**
   * nginx binary path. Defaults to 'nginx' (PATH lookup); override via NGINX_BIN
   * for non-PATH installs (common on Windows: NGINX_BIN=D:\nginx\nginx.exe).
   */
  static resolveBinary() {
    return config.deployment.nginxBin;
  }

  /**
   * Render and write the per-app nginx server config. Persisted (not auto-deleted)
   * because nginx re-reads it on PM2 restart.
   *
   * pid / error_log / access_log MUST be redirected into the app dir — nginx's
   * default prefix (install dir, often Program Files on Windows) is not writable.
   * Paths are quoted because the project root may contain spaces.
   *
   * @param {string} appPath absolute app directory
   * @param {string} name app name (sanitized; used in the filename only)
   * @param {number} port platform-assigned port
   * @returns {string} absolute path to the written config
   */
  static generateConfig(appPath, name, port) {
    const confPath = path.join(appPath, `nginx.${name}.conf`);
    // nginx's double-quoted strings process backslash escapes (\n, \t, \u…), and
    // a Windows appPath is full of backslashes — so e.g. ...\apps\node-api would
    // have its \n turned into a newline, corrupting the config. Forward slashes
    // are accepted by nginx on all platforms and carry no escape risk; normalize
    // the paths interpolated into the config body (confPath itself stays
    // OS-native for the filesystem write).
    const p = appPath.replace(/\\/g, '/');
    const conf = `worker_processes  1;
error_log  "${p}/nginx-error.log"  warn;
pid        "${p}/nginx.pid";

events { worker_connections 1024; }

http {
  access_log  "${p}/nginx-access.log";

  server {
    listen ${port};
    server_name _;
    root   "${p}";
    index  index.html;

    location / {
      try_files $uri $uri/ =404;
    }
  }
}
`;
    fs.writeFileSync(confPath, conf, 'utf-8');
    return confPath;
  }

  /**
   * Pre-flight: run `nginx -t -c <conf>`. One call covers two failure modes:
   *  - binary missing (ENOENT / exit 127)  -> 'nginx binary not found ...'
   *  - config syntax / path error          -> 'nginx config invalid: <stderr tail>'
   *
   * @returns {Promise<{ok: boolean, message?: string}>}
   */
  static async testConfig(confPath) {
    const bin = this.resolveBinary();
    try {
      await execPromise(`"${bin}" -t -c "${confPath}"`, {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      return { ok: true };
    } catch (err) {
      if (err.code === 'ENOENT' || /command not found|not recognized|127/.test(err.message || '')) {
        return { ok: false, message: 'nginx binary not found (set NGINX_BIN or add nginx to PATH)' };
      }
      const stderr = (err.stderr || err.stdout || err.message || '').trim();
      return { ok: false, message: 'nginx config invalid: ' + stderr.slice(-500) };
    }
  }

  /**
   * Boot probe: confirm the nginx binary exists/runs. Warn-only — http-server/npm
   * apps don't need it. Called from app.js at startup.
   *
   * @returns {Promise<{ok: boolean, message?: string}>}
   */
  static async probe() {
    const bin = this.resolveBinary();
    try {
      await execPromise(`"${bin}" -v`, { timeout: 10000 });
      return { ok: true };
    } catch (err) {
      if (err.code === 'ENOENT' || /command not found|not recognized|127/.test(err.message || '')) {
        return { ok: false, message: `nginx binary not found at '${bin}' (nginx deploy type unavailable; set NGINX_BIN or add nginx to PATH)` };
      }
      return { ok: false, message: `nginx probe failed: ${(err.stderr || err.message || '').trim().slice(-200)}` };
    }
  }
}

module.exports = NginxLifecycle;
