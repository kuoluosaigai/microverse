const { queries } = require('../db');
const pathHelper = require('../utils/path-helper');
const ProcessManager = require('./process-manager');
const NpmLifecycle = require('./npm-lifecycle');
const ProxyManager = require('./proxy-manager');
const { isValidAppName } = require('../utils/validate-app-name');
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

    if (!isValidAppName(name)) {
      throw new Error('Invalid app name: use only letters, numbers, dashes, and underscores (max 64)');
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
   * Delete application.
   * @param {number} id
   * @param {{deleteFiles?: boolean, skipProxyRegenerate?: boolean}} [options]
   *   deleteFiles: remove the app directory too (default false; the DB row is
   *   kept when the directory cannot be safely removed).
   *   skipProxyRegenerate: set by DeployManager when its status reconcile
   *   already regenerated the edge conf moments ago.
   */
  static async deleteApp(id, options = {}) {
    const { deleteFiles = false } = options;
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

    // Optional: remove the app directory. Only a path strictly inside APPS_DIR
    // is eligible — a DB row pointing at APPS_DIR itself, a sibling, or any
    // other location is refused BEFORE the row is deleted, so the app remains
    // visible and can be repaired instead of silently leaking its data.
    if (deleteFiles) {
      const appsRoot = path.resolve(pathHelper.getAppsDir());
      const target = path.resolve(app.path);
      const rel = path.relative(appsRoot, target);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error('Refusing to delete a directory outside APPS_DIR');
      }
      fs.rmSync(target, { recursive: true, force: true });
    }

    // Delete from database (metrics rows cascade via FK; the explicit delete
    // covers DBs whose metrics table predates the FK).
    await queries.deleteApp(id);
    await queries.deleteMetricsForApp(app.name).catch(() => { /* best-effort */ });

    if (!options.skipProxyRegenerate) {
      try { await ProxyManager.regenerate(); } catch (e) { console.warn(`[proxy] regenerate after delete failed: ${e.message}`); }
    }

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
   * Get app directory contents (top level). `path` is RELATIVE to the app root
   * (equal to `name` at this depth) — the server's absolute directory layout is
   * never exposed to the API consumer.
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
      path: file.name
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
        if (!files.includes('index.html')) {
          return { valid: false, message: 'Missing index.html for nginx deployment' };
        }
        break;
    }

    return { valid: true };
  }
}

module.exports = AppManager;
