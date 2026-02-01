const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');

const execPromise = util.promisify(exec);

/**
 * Process Manager Service
 * Handles process lifecycle using PM2
 */

class ProcessManager {
  /**
   * Get http-server executable path (cross-platform)
   */
  static getHttpServerPath() {
    // Try to find http-server in node_modules
    const globalNodeModules = path.join(
      process.env.APPDATA || process.env.HOME,
      'npm/node_modules/http-server/bin/http-server'
    );

    // For Windows, we need to use the JS file directly, not the CMD wrapper
    if (process.platform === 'win32') {
      // Check global installation
      const globalPath = 'C:\\Users\\User\\AppData\\Roaming\\npm\\node_modules\\http-server\\bin\\http-server';
      if (fs.existsSync(globalPath)) {
        return globalPath;
      }

      // Check local installation
      const localPath = path.join(process.cwd(), 'node_modules/http-server/bin/http-server');
      if (fs.existsSync(localPath)) {
        return localPath;
      }
    }

    // For Linux/Mac, can use http-server directly
    return 'http-server';
  }

  /**
   * Start an application process
   */
  static async startProcess(app) {
    const { name, path: appPath, deploy_type, port } = app;

    switch (deploy_type) {
      case 'npm':
        // Start npm application
        try {
          const ecosystemConfig = {
            apps: [{
              name: name,
              script: 'npm',
              args: 'start',
              cwd: appPath,
              interpreter: 'none',
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
   * Get process logs
   */
  static async getProcessLogs(appName, lines = 50) {
    try {
      const { stdout } = await execPromise(`pm2 logs "${appName}" --lines ${lines} --nostream`);
      return stdout;
    } catch (error) {
      throw new Error(`Failed to get process logs: ${error.message}`);
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
