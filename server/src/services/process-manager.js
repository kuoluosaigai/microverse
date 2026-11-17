const { exec, execFile } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const NginxLifecycle = require('./nginx-lifecycle');
const { perfLine } = require('../utils/lap-timer');

const execPromise = util.promisify(exec);
const execFilePromise = util.promisify(execFile);

/**
 * Process Manager Service
 * Handles process lifecycle using PM2
 */

class ProcessManager {
  /**
   * Resolve the real npm global root via `npm root -g` (covers nvm / fnm /
   * volta / custom prefixes that the hardcoded candidates miss). Process-lifetime
   * cached — spawns npm at most once, and only when cheaper candidates miss.
   * @returns {string|null}
   */
  static npmGlobalRoot() {
    if (this._npmGlobalRoot === undefined) {
      this._npmGlobalRoot = null;
      try {
        const { execSync } = require('child_process');
        const out = execSync('npm root -g', {
          encoding: 'utf8',
          timeout: 15000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (out) this._npmGlobalRoot = out;
      } catch (_err) { /* npm not installed / not on PATH — stay null */ }
    }
    return this._npmGlobalRoot;
  }

  /**
   * Resolve a CLI module's JS entry file across local/global node_modules.
   * Returns an absolute path when found, or null so the caller can fall back
   * to a bare command (works on Linux/macOS, but NOT in PM2 fork mode on Windows).
   *
   * Candidates, cheapest first (all plain fs checks until the last one):
   *   1. cwd node_modules               — direct install under the launch dir
   *   2. repo-root node_modules         — npm workspaces hoists server deps here
   *   3. global root beside the running node binary — the layout nvm/fnm/volta
   *      and the Windows official installer use (globals live next to node.exe
   *      / under its ../lib on POSIX)
   *   4. %APPDATA%/npm/node_modules     — Windows npm default prefix
   *   5. ~/.npm-global                  — common manual prefix
   *   6. /usr/local/lib/node_modules    — classic Unix default
   *   7. `npm root -g` (cached spawn)   — authoritative for custom prefixes
   */
  static resolveCliModule(relativePath) {
    const roots = [
      path.join(process.cwd(), 'node_modules'),
      // server/src/services -> server/src -> server -> repo root
      path.join(__dirname, '..', '..', '..', 'node_modules'),
    ];
    const nodeBinDir = path.dirname(process.execPath);
    roots.push(
      process.platform === 'win32'
        ? path.join(nodeBinDir, 'node_modules')
        : path.join(nodeBinDir, '..', 'lib', 'node_modules')
    );
    roots.push(
      process.platform === 'win32'
        ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules')
        : path.join(os.homedir(), '.npm-global', 'node_modules')
    );
    if (process.platform !== 'win32') {
      roots.push(path.join('/usr', 'local', 'lib', 'node_modules'));
    }

    for (const root of roots) {
      const p = path.join(root, relativePath);
      if (fs.existsSync(p)) {
        return p;
      }
    }

    // Last resort (cached): the real global prefix, which no static candidate
    // is guaranteed to know. Spawns `npm root -g` at most once per process.
    const npmRoot = this.npmGlobalRoot();
    if (npmRoot) {
      const p = path.join(npmRoot, relativePath);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  /**
   * Get http-server executable path (cross-platform), memoized — resolveCliModule
   * runs up to 6 existsSync checks (plus a cached `npm root -g` on total miss).
   * Uses the JS entry directly (not the .cmd wrapper) so PM2 fork mode works on Windows.
   */
  static getHttpServerPath() {
    if (this._httpServerPath === undefined) {
      this._httpServerPath = this.resolveCliModule('http-server/bin/http-server') || 'http-server';
    }
    return this._httpServerPath;
  }

  /**
   * Get npm CLI JS entry path (cross-platform), memoized.
   * Avoids the .cmd wrapper problem on Windows, same approach as http-server.
   */
  static getNpmCliPath() {
    if (this._npmCliPath === undefined) {
      this._npmCliPath = this.resolveCliModule('npm/bin/npm-cli.js') || 'npm';
    }
    return this._npmCliPath;
  }

  /**
   * Boot-time warmup (fire-and-forget, called from server.js): resolve the real
   * npm global prefix ASYNCHRONOUSLY so the synchronous `npm root -g` fallback
   * inside resolveCliModule never lands on the request path. On hosts where
   * pm2/http-server live under a version-manager prefix, a cold resolve during
   * a request would otherwise block that worker's event loop for up to 15s.
   * Failure is fine — the sync fallback still works, just slower the first time.
   */
  static warmNpmGlobalRoot() {
    if (this._npmGlobalRoot !== undefined) return Promise.resolve(this._npmGlobalRoot);
    const npmCli = this.getNpmCliPath();
    if (npmCli === 'npm') return Promise.resolve(null);
    return execFilePromise(process.execPath, [npmCli, 'root', '-g'], { timeout: 15000 })
      .then(({ stdout }) => {
        const out = String(stdout).trim();
        this._npmGlobalRoot = out || null;
        return this._npmGlobalRoot;
      })
      .catch(() => null);
  }

  /**
   * pm2's JS entry (bin/pm2), resolved once per process. pm2 is a direct
   * server dependency, so this resolves even without a global install.
   * @returns {string|null}
   */
  static resolvePm2Entry() {
    if (this._pm2Entry === undefined) {
      this._pm2Entry = this.resolveCliModule('pm2/bin/pm2');
    }
    return this._pm2Entry;
  }

  /**
   * Single choke point for every PM2 CLI invocation. Argument arrays mean no
   * shell interpolation of app names/paths anywhere (execFile), with two
   * platform concessions:
   *  - POSIX: plain `pm2` from PATH first (preserves the "global pm2 owns the
   *    daemon" semantics); falls back to the resolved JS entry when the global
   *    CLI is missing.
   *  - Windows: a bare `pm2` is a .cmd shim that Node refuses to execFile
   *    without a shell, so run the resolved JS entry with the current node;
   *    only if that fails to resolve do we fall back to a shell string (args
   *    are platform-controlled there: validated app names + internal paths).
   * @param {string[]} args pm2 subcommand + arguments
   * @param {object} [options] execFile options (timeout, maxBuffer, ...)
   */
  static async pm2Exec(args, options = {}) {
    const opts = { maxBuffer: 10 * 1024 * 1024, ...options };
    const startedAt = Date.now();
    const finish = () => {
      // Every lifecycle op pays for at least one PM2 CLI spawn (node boot +
      // daemon RPC). Worth a line when it dominates a request.
      const ms = Date.now() - startedAt;
      if (ms >= ProcessManager.PM2_SLOW_MS) {
        perfLine('pm2', args[0], ms, `slow (>=${ProcessManager.PM2_SLOW_MS}ms)`);
      }
    };

    try {
      if (process.platform === 'win32') {
        const entry = this.resolvePm2Entry();
        if (entry) {
          return await execFilePromise(process.execPath, [entry, ...args], opts);
        }
        return await execPromise(`pm2 ${args.map(a => `"${a}"`).join(' ')}`, opts);
      }

      try {
        return await execFilePromise('pm2', args, opts);
      } catch (err) {
        if (err.code === 'ENOENT') {
          const entry = this.resolvePm2Entry();
          if (entry) {
            return await execFilePromise(process.execPath, [entry, ...args], opts);
          }
        }
        throw err;
      }
    } finally {
      finish();
    }
  }

  /**
   * Write a temporary PM2 ecosystem config and schedule its deletion.
   * Shared by all deploy types to avoid duplicated write+cleanup code.
   * Returns the config file path (caller runs `pm2 start <path>`).
   *
   * Uses a `.cjs` extension: the config lives inside the app directory, and an
   * app that ships a `package.json` with `"type": "module"` (Vite/ESM static
   * sites) would otherwise make Node treat a `.js` file as an ES module — PM2
   * then `require()`s it and dies with "module is not defined". `.cjs` is
   * always loaded as CommonJS regardless of the app's package.json, and PM2's
   * `Common.knonwConfigFileExtensions` recognizes `.config.cjs` as a JS config.
   */
  static writeEcosystemConfig(appPath, name, appsEntry) {
    const ecosystemConfig = { apps: [appsEntry] };
    const configPath = path.join(appPath, `pm2.${name}.config.cjs`);
    fs.writeFileSync(
      configPath,
      `module.exports = ${JSON.stringify(ecosystemConfig, null, 2)}`
    );
    // PM2 reads the file synchronously during start; 5s is enough, then clean up.
    setTimeout(() => {
      try {
        if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
      } catch (_err) { /* ignore */ }
    }, 5000);
    return configPath;
  }

  /**
   * Start an application process
   */
  static async startProcess(app, options = {}) {
    const { name, path: appPath, deploy_type, port } = app;

    switch (deploy_type) {
      case 'npm': {
        // Start npm application. On Windows, `npm` is a .cmd wrapper that PM2
        // fork mode can't launch, so resolve the JS entry and run it with node
        // (same approach as http-server).
        const npmCliPath = this.getNpmCliPath();
        const resolvedJs = npmCliPath !== 'npm';

        try {
          const appsEntry = {
            name: name,
            script: npmCliPath,
            args: 'start',
            cwd: appPath,
            interpreter: resolvedJs ? 'node' : 'none',
            exec_mode: 'fork',
            autorestart: true
          };
          // Inject resolved env (PORT + user vars) for npm apps.
          if (options.env && typeof options.env === 'object') {
            appsEntry.env = options.env;
          }

          const configPath = this.writeEcosystemConfig(appPath, name, appsEntry);
          await this.pm2Exec(['start', configPath]);

          return { success: true, message: `Process ${name} started` };
        } catch (error) {
          throw new Error(`Failed to start process: ${error.message}`);
        }
      }

      case 'http-server':
        // Start http-server
        if (!port) {
          throw new Error('Port is required for http-server deployment');
        }

        try {
          // Use node to run http-server directly (cross-platform)
          const httpServerPath = this.getHttpServerPath();

          const appsEntry = {
            name: name,
            script: httpServerPath,
            args: `. -p ${port}`,
            cwd: appPath,
            interpreter: 'node', // Use node interpreter
            exec_mode: 'fork',
            autorestart: true,
            max_restarts: 10,
            min_uptime: 1000
          };

          const configPath = this.writeEcosystemConfig(appPath, name, appsEntry);
          await this.pm2Exec(['start', configPath]);

          return { success: true, message: `Process ${name} started` };
        } catch (error) {
          throw new Error(`Failed to start process: ${error.message}`);
        }

      case 'nginx': {
        // Launch nginx as a PM2-managed process. nginx is a native binary (not a
        // JS entry / .cmd wrapper), so interpreter:'none' execs it directly — no
        // Windows PM2-fork-.cmd problem. `daemon off;` keeps the master in the
        // foreground so PM2 can track/restart/collect stderr.
        if (!port) {
          throw new Error('Port is required for nginx deployment');
        }
        if (!options.nginxConf) {
          throw new Error('nginx config path is required (options.nginxConf)');
        }
        const appsEntry = {
          name: name,
          script: NginxLifecycle.resolveBinary(),
          args: ['-c', options.nginxConf, '-g', 'daemon off;'],
          cwd: appPath,
          interpreter: 'none',
          exec_mode: 'fork',
          autorestart: true,
          max_restarts: 10,
          min_uptime: 1000
        };
        const configPath = this.writeEcosystemConfig(appPath, name, appsEntry);
        await this.pm2Exec(['start', configPath]);
        return { success: true, message: `Process ${name} started` };
      }

      default:
        throw new Error(`Unknown deploy type: ${deploy_type}`);
    }
  }

  /**
   * Stop an application process
   */
  static async stopProcess(appName) {
    try {
      await this.pm2Exec(['stop', appName]);
      return { success: true, message: `Process ${appName} stopped` };
    } catch (error) {
      throw new Error(`Failed to stop process: ${error.message}`);
    }
  }

  /**
   * Restart an application process
   */
  static async restartProcess(appName) {
    try {
      await this.pm2Exec(['restart', appName]);
      return { success: true, message: `Process ${appName} restarted` };
    } catch (error) {
      throw new Error(`Failed to restart process: ${error.message}`);
    }
  }

  /**
   * Delete an application process from PM2
   */
  static async deleteProcess(appName) {
    try {
      await this.pm2Exec(['delete', appName]);
      return { success: true, message: `Process ${appName} deleted` };
    } catch (error) {
      // Ignore error if process doesn't exist
      if (error.message.includes('not found')) {
        return { success: true, message: `Process ${appName} not found in PM2` };
      }
      throw new Error(`Failed to delete process: ${error.message}`);
    }
  }

  /**
   * Get status for ALL PM2 processes in one `pm2 jlist` call.
   * Used by MetricsSampler (one call per tick covers every app).
   * @returns {Promise<Array<{name:string,status:string,pid:number,uptime:number,memory:number,cpu:number}>>}
   */
  static async getAllProcessStatus() {
    try {
      const { stdout } = await this.pm2Exec(['jlist']);
      const processes = JSON.parse(stdout);
      return processes.map(p => ({
        name: p.name,
        status: p.pm2_env.status,
        pid: p.pid,
        uptime: p.pm2_env.pm_uptime,
        memory: p.monit.memory,
        cpu: p.monit.cpu
      }));
    } catch (error) {
      throw new Error(`Failed to list PM2 processes: ${error.message}`);
    }
  }

  /**
   * Get process status for a single app by name. Delegates to getAllProcessStatus.
   * @returns {Promise<{exists:false}|{exists:true,status,pid,uptime,memory,cpu}>}
   */
  static async getProcessStatus(appName) {
    const all = await this.getAllProcessStatus();
    const p = all.find(x => x.name === appName);
    if (!p) {
      return { exists: false };
    }
    return {
      exists: true,
      status: p.status,
      pid: p.pid,
      uptime: p.uptime,
      memory: p.memory,
      cpu: p.cpu
    };
  }

  /**
   * Probe whether (host, port) can be bound. Resolves true on listen, false on
   * EADDRINUSE or any other bind error (treated as unavailable).
   */
  static probeBind(host, port, ipv6Only = false) {
    return new Promise((resolve) => {
      const net = require('net');
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      if (ipv6Only) {
        server.listen({ port, host, ipv6Only: true });
      } else {
        server.listen(port, host);
      }
    });
  }

  /**
   * Check if a port is free on BOTH IPv4 and IPv6. A single-stack listener
   * (e.g. http-server binding 0.0.0.0) is enough to make the port occupied —
   * previously we only probed one stack and missed the other.
   */
  static async isPortAvailable(port) {
    const v4 = await this.probeBind('0.0.0.0', port, false);
    if (!v4) return false;
    return this.probeBind('::', port, true);
  }

  /**
   * Find an available port in range, skipping any port in options.exclude
   * (ports already claimed by other apps). A port is returned only if it is
   * not excluded AND free on both stacks.
   */
  static async findAvailablePort(minPort, maxPort, options = {}) {
    const exclude = new Set(options.exclude || []);
    const startedAt = Date.now();
    let probes = 0;
    for (let port = minPort; port <= maxPort; port++) {
      if (exclude.has(port)) continue;
      probes++;
      if (await this.isPortAvailable(port)) {
        perfLine('ports', 'findAvailablePort', Date.now() - startedAt,
          `probed=${probes} range=${minPort}-${maxPort} -> ${port}`);
        return port;
      }
    }
    perfLine('ports', 'findAvailablePort', Date.now() - startedAt,
      `probed=${probes} range=${minPort}-${maxPort} -> NONE`);
    throw new Error('No available ports in range');
  }
}

// PM2 CLI calls slower than this get a `[deploy-perf]` line. The threshold has
// to sit above normal spawn cost because MetricsSampler polls `jlist` every 10s
// in one worker — a low bar would write ~6 lines/minute forever.
ProcessManager.PM2_SLOW_MS = 3000;

module.exports = ProcessManager;
