const { queries } = require('../db');
const pathHelper = require('../utils/path-helper');
const ProcessManager = require('./process-manager');
const NpmLifecycle = require('./npm-lifecycle');
const fs = require('fs');
const path = require('path');

/**
 * Application Manager Service
 * Handles application lifecycle management
 */

class AppManager {
  /**
   * Create a new application
   */
  static async createApp(name, deployType) {
    // Validate inputs
    if (!name || !deployType) {
      throw new Error('Name and deploy_type are required');
    }

    if (!['npm', 'http-server', 'nginx'].includes(deployType)) {
      throw new Error('Invalid deploy_type. Must be: npm, http-server, or nginx');
    }

    // Check if app already exists
    const existing = await queries.getAppByName(name);
    if (existing) {
      throw new Error(`App '${name}' already exists`);
    }

    // Create app directory
    const appPath = pathHelper.getAppDir(name);
    pathHelper.ensureDir(appPath);

    // Insert into database
    const result = await queries.createApp({
      name,
      path: appPath,
      deploy_type: deployType,
      port: null,
      status: 'stopped'
    });

    return queries.getAppById(result.lastID);
  }

  /**
   * Get all applications
   */
  static async getAllApps() {
    return queries.getAllApps();
  }

  /**
   * Get application by ID
   */
  static async getAppById(id) {
    const app = await queries.getAppById(id);
    if (!app) {
      throw new Error('App not found');
    }
    return app;
  }

  /**
   * Get application by name
   */
  static async getAppByName(name) {
    const app = await queries.getAppByName(name);
    if (!app) {
      throw new Error('App not found');
    }
    return app;
  }

  /**
   * Update application
   */
  static async updateApp(id, updates) {
    const app = await this.getAppById(id);

    await queries.updateApp({
      id,
      path: updates.path || null,
      deploy_type: updates.deploy_type || null,
      port: updates.port || null,
      status: updates.status || null
    });

    return queries.getAppById(id);
  }

  /**
   * Delete application
   */
  static async deleteApp(id) {
    const app = await this.getAppById(id);

    // Check if app is running
    if (app.status === 'running') {
      throw new Error('Cannot delete running app. Stop it first.');
    }

    // Remove any leftover PM2 entry. `stop` leaves the process in the PM2
    // list, so without this we'd orphan it. Non-fatal: DB deletion proceeds
    // even if PM2 has nothing to remove.
    try {
      await ProcessManager.deleteProcess(app.name);
    } catch (err) {
      console.warn(`Could not remove PM2 process for '${app.name}': ${err.message}`);
    }

    // Delete from database
    await queries.deleteApp(id);

    // Note: We don't delete the app directory to prevent data loss
    // User should manually delete if needed
    return true;
  }

  /**
   * Get environment variables for an app (forwarded to queries).
   */
  static async getAppEnv(id) {
    await this.getAppById(id); // throws 'App not found' if missing
    return queries.getAppEnv(id);
  }

  /**
   * Replace environment variables for an app (forwarded to queries).
   * entries: [{ key, value }]
   */
  static async setAppEnv(id, entries) {
    await this.getAppById(id);
    return queries.setAppEnv(id, entries);
  }

  /**
   * Get app directory contents
   */
  static async getAppFiles(id) {
    const app = await this.getAppById(id);

    if (!fs.existsSync(app.path)) {
      return [];
    }

    const files = fs.readdirSync(app.path, { withFileTypes: true });

    return files.map(file => ({
      name: file.name,
      type: file.isDirectory() ? 'directory' : 'file',
      path: path.join(app.path, file.name)
    }));
  }

  /**
   * Check if app has required files for deployment
   */
  static async validateAppDeployment(id) {
    const app = await this.getAppById(id);

    if (!fs.existsSync(app.path)) {
      return { valid: false, message: 'App directory does not exist' };
    }

    const files = fs.readdirSync(app.path);

    if (files.length === 0) {
      return { valid: false, message: 'App directory is empty' };
    }

    switch (app.deploy_type) {
      case 'npm': {
        let pkg;
        try {
          pkg = NpmLifecycle.readPackageJson(app.path);
        } catch (err) {
          return { valid: false, message: err.message };
        }
        if (!pkg.scripts || typeof pkg.scripts.start !== 'string' || !pkg.scripts.start.trim()) {
          return { valid: false, message: 'Missing start script in package.json' };
        }
        break;
      }

      case 'http-server':
        if (!files.includes('index.html')) {
          return { valid: false, message: 'Missing index.html for http-server deployment' };
        }
        break;

      case 'nginx':
        // For nginx, just check if there are any files
        break;
    }

    return { valid: true };
  }
}

module.exports = AppManager;
