const { queries } = require('../db');
const pathHelper = require('../utils/path-helper');
const ProcessManager = require('./process-manager');
const NpmLifecycle = require('./npm-lifecycle');
const ProxyManager = require('./proxy-manager');
// Task 8: the deploy summary is attached alongside `git`, so AppManager needs
// DeployJobs.isLive. Safe at module load — deploy-jobs' own require graph is
// leaves (db/config/utils) and it reaches back here only lazily (update-
// manager is the lazy one, never app-manager), so no cycle can form.
const DeployJobs = require('./deploy-jobs');
const { isValidAppName } = require('../utils/validate-app-name');
const { validateGitUrl, validateGitBranch } = require('../utils/validate-git-source');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Public shape of an app's git binding, attached to every app object returned
// by AppManager. The webhook_secret and internal claim bookkeeping stay out.
function toGitSummary(row) {
  if (!row) return null;
  return {
    url: row.url,
    branch: row.branch,
    auto_update: row.auto_update,
    deployed_commit: row.deployed_commit,
    remote_commit: row.remote_commit,
    synced_at: row.synced_at,
    last_status: row.last_status,
    last_error: row.last_error
  };
}

// Public shape of an app's deploy job (current or most recent), attached to
// every app object next to the git summary. camelCase by contract — no
// snake_case column, and no pid/log_path, leaks to the client. `live` is
// DeployJobs.isLive's verdict, never a status-name check (a dead-owner row
// must not hold the client's UI in a fake "deploying" state).
function toDeploySummary(row) {
  if (!row) return null;
  return {
    kind: row.kind,
    status: row.status,
    step: row.step,
    message: row.message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    live: DeployJobs.isLive(row)
  };
}

/**
 * Application Manager Service
 * Handles application lifecycle management
 */

class AppManager {
  /**
   * Create a new application.
   * @param {string} name
   * @param {'npm'|'http-server'|'nginx'} deployType
   * @param {{url: string, branch?: string, autoUpdate?: boolean}|null} [gitOptions]
   *   optional git source to bind in the same call. Validated BEFORE the app
   *   row or directory is created, so invalid input has no side effects.
   */
  static async createApp(name, deployType, gitOptions = null) {
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

    // Validate the optional git source up front — no DB row or directory may
    // exist for a rejected URL/branch.
    let git = null;
    if (gitOptions) {
      const url = gitOptions.url;
      const branch = gitOptions.branch || 'main';
      const autoUpdate = gitOptions.autoUpdate === undefined || gitOptions.autoUpdate === null
        ? true
        : Boolean(gitOptions.autoUpdate);

      const urlError = validateGitUrl(url);
      if (urlError) throw new Error(urlError);
      const branchError = validateGitBranch(branch);
      if (branchError) throw new Error(branchError);

      git = { url, branch, autoUpdate };
    }

    // Check if app already exists
    const existing = await queries.getAppByName(name);
    if (existing) {
      throw new Error(`App '${name}' already exists`);
    }

    // Create app directory. Remember whether we created it (or whether it was
    // empty) so a failed git-source insert can clean up without destroying
    // user files that predate the create call.
    const appPath = pathHelper.getAppDir(name);
    const dirExisted = fs.existsSync(appPath);
    const dirWasEmpty = dirExisted ? fs.readdirSync(appPath).length === 0 : true;
    pathHelper.ensureDir(appPath);

    // Insert into database
    const result = await queries.createApp({
      name,
      path: appPath,
      deploy_type: deployType,
      port: null,
      status: 'stopped'
    });

    if (git) {
      try {
        await queries.upsertAppGitSource({
          appId: result.lastID,
          url: git.url,
          branch: git.branch,
          autoUpdate: git.autoUpdate,
          // First bind only: the NOT NULL column needs a secret. A later
          // re-bind through upsert keeps this value (COALESCE).
          webhookSecret: crypto.randomBytes(32).toString('hex')
        });
      } catch (err) {
        // Compensate in reverse order: drop the app row, then the directory
        // only when this call created it or found it empty. A pre-existing
        // non-empty directory holds user content and is never removed here.
        try { await queries.deleteApp(result.lastID); } catch (_e) { /* best-effort */ }
        if (!dirExisted || dirWasEmpty) {
          try { fs.rmSync(appPath, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
        }
        throw err;
      }
    }

    // Enriched shape (git attached), so the create response matches GET /apps.
    return this.getAppById(result.lastID);
  }

  /**
   * Get all applications
   */
  static async getAllApps() {
    const [apps, sources] = await Promise.all([
      queries.getAllApps(),
      queries.getAllAppGitSources()
    ]);
    // One batched read for every app's job — the ids are only known after the
    // first round-trip, but the read itself never scales with N (the summary
    // exists precisely to keep the list endpoint off a per-app N+1).
    const jobs = await queries.getDeployJobsByAppIds(apps.map(app => app.id));
    const sourceByAppId = new Map(sources.map(source => [source.app_id, source]));
    const jobByAppId = new Map(jobs.map(job => [job.app_id, job]));
    return apps.map(app => ({
      ...app,
      git: toGitSummary(sourceByAppId.get(app.id)),
      deploy: toDeploySummary(jobByAppId.get(app.id))
    }));
  }

  /**
   * Get application by ID
   */
  static async getAppById(id) {
    const [app, source, job] = await Promise.all([
      queries.getAppById(id),
      queries.getAppGitSource(id),
      queries.getDeployJob(id)
    ]);
    if (!app) {
      throw new Error('App not found');
    }
    return { ...app, git: toGitSummary(source), deploy: toDeploySummary(job) };
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

    // `.git` is the sync working copy, not deployable user content — hide it
    // from the file browser (ordinary dotfiles stay visible).
    return files
      .filter(file => file.name !== '.git')
      .map(file => ({
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
