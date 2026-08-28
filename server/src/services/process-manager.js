const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const NginxLifecycle = require('./nginx-lifecycle');

const execPromise = util.promisify(exec);

/**
 * Process Manager Service
 * Handles process lifecycle using PM2
 */

class ProcessManager {
  /**
   * Resolve a CLI module's JS entry file across local/global node_modules.
   * Returns an absolute path when found, or null so the caller can fall back
   * to a bare command (works on Linux/macOS, but NOT in PM2 fork mode on Windows).
   */
  static resolveCliModule(relativePath) {
    // 1. Local (project) node_modules
    const localPath = path.join(process.cwd(), 'node_modules', relativePath);
    if (fs.existsSync(localPath)) {
      return localPath;
    }

    // 2. Global node_modules at the platform-specific install root
    const globalRoot = process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules')
      : path.join(os.homedir(), '.npm-global', 'node_modules');
    const globalPath = path.join(globalRoot, relativePath);
    if (fs.existsSync(globalPath)) {
      return globalPath;
    }

    // 3. Unix fallback: /usr/local global root (common default)
    if (process.platform !== 'win32') {
      const unixGlobal = path.join('/usr', 'local', 'lib', 'node_modules', relativePath);
      if (fs.existsSync(unixGlobal)) {
        return unixGlobal;
      }
    }

    return null;
  }

  /**
   * Get http-server executable path (cross-platform)
   * Uses the JS entry directly (not the .cmd wrapper) so PM2 fork mode works on Windows.
   */
  static getHttpServerPath() {
    return this.resolveCliModule('http-server/bin/http-server') || 'http-server';
  }

  /**
   * Get npm CLI JS entry path (cross-platform)
   * Avoids the .cmd wrapper problem on Windows, same approach as http-server.
   */
  static getNpmCliPath() {
    return this.resolveCliModule('npm/bin/npm-cli.js') || 'npm';
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
          await execPromise(`pm2 start "${configPath}"`);

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
          await execPromise(`pm2 start "${configPath}"`);

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
        await execPromise(`pm2 start "${configPath}"`);
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
      await execPromise(`pm2 stop "${appName}"`);
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
      await execPromise(`pm2 restart "${appName}"`);
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
      await execPromise(`pm2 delete "${appName}"`);
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
      const { stdout } = await execPromise('pm2 jlist');
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
    for (let port = minPort; port <= maxPort; port++) {
      if (exclude.has(port)) continue;
      if (await this.isPortAvailable(port)) {
        return port;
      }
    }
    throw new Error('No available ports in range');
  }
}

module.exports = ProcessManager;
