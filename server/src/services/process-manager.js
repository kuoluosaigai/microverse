const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

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
   * Start an application process
   */
  static async startProcess(app) {
    const { name, path: appPath, deploy_type, port } = app;

    switch (deploy_type) {
      case 'npm': {
        // Start npm application. On Windows, `npm` is a .cmd wrapper that PM2
        // fork mode can't launch, so resolve the JS entry and run it with node
        // (same approach as http-server).
        const npmCliPath = this.getNpmCliPath();
        const resolvedJs = npmCliPath !== 'npm';

        try {
          const ecosystemConfig = {
            apps: [{
              name: name,
              script: npmCliPath,
              args: 'start',
              cwd: appPath,
              interpreter: resolvedJs ? 'node' : 'none',
              exec_mode: 'fork',
              autorestart: true
            }]
          };

          const configPath = path.join(appPath, `pm2.${name}.config.js`);
          fs.writeFileSync(
            configPath,
            `module.exports = ${JSON.stringify(ecosystemConfig, null, 2)}`
          );

          await execPromise(`pm2 start "${configPath}"`);

          // Clean up config file after a delay
          setTimeout(() => {
            try {
              if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
            } catch (err) { /* ignore */ }
          }, 5000);

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

          const ecosystemConfig = {
            apps: [{
              name: name,
              script: httpServerPath,
              args: `. -p ${port}`,
              cwd: appPath,
              interpreter: 'node', // Use node interpreter
              exec_mode: 'fork',
              autorestart: true,
              max_restarts: 10,
              min_uptime: 1000
            }]
          };

          const configPath = path.join(appPath, `pm2.${name}.config.js`);
          fs.writeFileSync(
            configPath,
            `module.exports = ${JSON.stringify(ecosystemConfig, null, 2)}`
          );

          await execPromise(`pm2 start "${configPath}"`);

          // Clean up config file after a delay
          setTimeout(() => {
            try {
              if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
            } catch (err) { /* ignore */ }
          }, 5000);

          return { success: true, message: `Process ${name} started` };
        } catch (error) {
          throw new Error(`Failed to start process: ${error.message}`);
        }

      case 'nginx':
        throw new Error('Nginx deployment not yet implemented');

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
   * Get process status
   */
  static async getProcessStatus(appName) {
    try {
      const { stdout } = await execPromise(`pm2 jlist`);
      const processes = JSON.parse(stdout);

      const process = processes.find(p => p.name === appName);

      if (!process) {
        return { exists: false };
      }

      return {
        exists: true,
        status: process.pm2_env.status,
        pid: process.pid,
        uptime: process.pm2_env.pm_uptime,
        memory: process.monit.memory,
        cpu: process.monit.cpu
      };
    } catch (error) {
      throw new Error(`Failed to get process status: ${error.message}`);
    }
  }

  /**
   * Check if a port is available
   */
  static async isPortAvailable(port) {
    return new Promise((resolve) => {
      const net = require('net');
      const server = net.createServer();

      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          resolve(false);
        } else {
          resolve(false);
        }
      });

      server.once('listening', () => {
        server.close();
        resolve(true);
      });

      server.listen(port);
    });
  }

  /**
   * Find an available port in range
   */
  static async findAvailablePort(minPort, maxPort) {
    for (let port = minPort; port <= maxPort; port++) {
      if (await this.isPortAvailable(port)) {
        return port;
      }
    }
    throw new Error('No available ports in range');
  }
}

module.exports = ProcessManager;
