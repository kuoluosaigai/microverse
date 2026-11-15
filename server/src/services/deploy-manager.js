const AppManager = require('./app-manager');
const ProcessManager = require('./process-manager');
const NpmLifecycle = require('./npm-lifecycle');
const NginxLifecycle = require('./nginx-lifecycle');
const ProxyManager = require('./proxy-manager');
const { queries } = require('../db');
const config = require('../config');
const { createExclusive } = require('../utils/serialize');

// Marks an app row whose status reconcileStatus just flipped running->stopped
// (and whose edge-proxy config was therefore already regenerated). Symbol keys
// are invisible to JSON.stringify, so flagged rows serialize cleanly in API
// responses.
const PROXY_ALREADY_REGENERATED = Symbol('proxyAlreadyRegenerated');

// Serializes the port-allocation critical section across concurrent deployApp
// calls so two never read the same "claimed" set and pick the same port.
// Process-local: sufficient for the single-instance, single-admin deployment.
const exclusive = createExclusive();

/**
 * Deployment Manager Service
 * Orchestrates application deployment and lifecycle
 */

class DeployManager {
  /**
   * Reconcile the app's DB status with PM2 truth, then return the (updated) row.
   * Makes stop/restart/delete/start operate on what is ACTUALLY running, not on
   * a stale DB flag (crashed or externally-deleted processes used to wedge these
   * ops behind a manual /sync). When PM2 is unreachable (jlist fails) we trust
   * the DB: on a PM2-less machine absence of the CLI must not make every app
   * look stopped — that would silently bypass the running-app guards.
   * @returns {Promise<object>} app row with the reconciled status
   */
  static async reconcileStatus(appId) {
    const app = await AppManager.getAppById(appId);

    let processInfo;
    try {
      processInfo = await ProcessManager.getProcessStatus(app.name);
    } catch (_err) {
      return app; // PM2 unavailable — DB status stands
    }

    const actual = processInfo.exists && processInfo.status === 'online' ? 'running' : 'stopped';
    if (app.status !== actual) {
      await queries.updateAppStatus(actual, appId);
      app.status = actual;
      // A running->stopped flip means the process died behind our back; the
      // edge proxy may still route its subdomain to a dead port. Regenerate
      // best-effort to keep the "proxy reflects running apps" invariant, and
      // flag the row so deleteApp doesn't reload nginx a second time for the
      // same (already correct) conf.
      if (actual === 'stopped') {
        try {
          await ProxyManager.regenerate();
          app[PROXY_ALREADY_REGENERATED] = true;
        } catch (e) { console.warn(`[proxy] regenerate after status reconcile failed: ${e.message}`); }
      }
    }
    return app;
  }

  /**
   * Deploy an application (start it)
   */
  static async deployApp(appId) {
    // Reconcile first: a crashed/removed PM2 process must not block a re-start
    // with "already running", and a live one must not be launched twice.
    const app = await this.reconcileStatus(appId);

    // Validate app can be deployed
    const validation = await AppManager.validateAppDeployment(appId);
    if (!validation.valid) {
      throw new Error(validation.message);
    }

    // Check if already running
    if (app.status === 'running') {
      throw new Error('App is already running');
    }

    // Assign port if needed — http-server, nginx, and npm all get a platform port.
    // npm apps receive it via the PORT env var (resolved below). Exclude ports
    // already claimed by other apps so two apps never share a port.
    if (!app.port) {
      // Serialize the read-claimed -> pick -> write critical section. Two
      // concurrent starts can no longer pick the same free port. npm
      // install / build / startProcess stay outside the lock — they don't
      // contend on port selection and can be slow.
      app.port = await exclusive(async () => {
        const claimed = (await queries.getAllClaimedPorts()).map(r => r.port);
        const port = await ProcessManager.findAvailablePort(
          config.deployment.portRangeMin,
          config.deployment.portRangeMax,
          { exclude: claimed }
        );
        await AppManager.updateApp(appId, { port });
        return port;
      });
    }

    // Start the process. For npm: install → build → resolve env → launch with env.
    // For nginx: generate the per-app config and pre-flight it (binary present +
    // config valid) before launch, so failures surface as clean 400s.
    if (app.deploy_type === 'npm') {
      // install/build run only when their fingerprint changed (or the step never
      // completed), so a plain stop→start doesn't reinstall + rebuild. Fingerprints
      // live in app_deploy_state (DB) — zip-replacement cleanup can't erase them.
      // Post-run fingerprints are stored from the AFTER state because npm may
      // rewrite the lockfile itself.
      const state = await queries.getAppDeployState(appId);
      const mustInstall = NpmLifecycle.needsInstall(app.path, state && state.install_fp);
      if (mustInstall) {
        await NpmLifecycle.install(app.path);
        await queries.setUpDeployState(appId, { installFp: NpmLifecycle.installFingerprint(app.path) });
      }
      // Dependency changes (install ran) force a rebuild even if app sources
      // are untouched; otherwise rebuild only when the source tree fingerprint moved.
      if (mustInstall || NpmLifecycle.needsBuild(app.path, state && state.build_fp)) {
        await NpmLifecycle.build(app.path); // no-op when there is no build script
        await queries.setUpDeployState(appId, { buildFp: NpmLifecycle.buildFingerprint(app.path) });
      }
      const env = await NpmLifecycle.resolveEnv(appId, app.port);
      await ProcessManager.startProcess(app, { env });
    } else if (app.deploy_type === 'nginx') {
      const confPath = NginxLifecycle.generateConfig(app.path, app.name, app.port);
      const result = await NginxLifecycle.testConfig(confPath);
      if (!result.ok) {
        throw new Error(result.message);
      }
      await ProcessManager.startProcess(app, { nginxConf: confPath });
    } else {
      await ProcessManager.startProcess(app);
    }

    // Update status in database
    await queries.updateAppStatus('running', appId);

    // Best-effort: refresh the edge-proxy routes so this app's subdomain is
    // reachable. Never let a proxy problem block the deploy.
    try { await ProxyManager.regenerate(); } catch (e) { console.warn(`[proxy] regenerate after start failed: ${e.message}`); }

    return AppManager.getAppById(appId);
  }

  /**
   * Stop a deployed application. Idempotent: when PM2 reports nothing online
   * the status is merely reconciled and the call succeeds (a crashed or
   * externally-deleted process must not wedge the app in "running").
   */
  static async stopApp(appId) {
    const app = await this.reconcileStatus(appId);

    if (app.status !== 'running') {
      return app; // already stopped in reality — nothing to do
    }

    // Stop the process
    await ProcessManager.stopProcess(app.name);

    // Update status in database
    await queries.updateAppStatus('stopped', appId);

    try { await ProxyManager.regenerate(); } catch (e) { console.warn(`[proxy] regenerate after stop failed: ${e.message}`); }

    return AppManager.getAppById(appId);
  }

  /**
   * Restart a deployed application (must actually be running in PM2)
   */
  static async restartApp(appId) {
    const app = await this.reconcileStatus(appId);

    if (app.status !== 'running') {
      throw new Error('App is not running');
    }

    // Restart the process
    await ProcessManager.restartProcess(app.name);

    return AppManager.getAppById(appId);
  }

  /**
   * Delete an application. Reconciles with PM2 first so a dead-but-DB-"running"
   * app can be cleaned up in one call instead of erroring with "stop it first";
   * the AppManager guard still protects genuinely running apps.
   * @param {number} appId
   * @param {{deleteFiles?: boolean}} [options] also remove the app directory.
   */
  static async deleteApp(appId, options = {}) {
    const app = await this.reconcileStatus(appId);
    // When reconcile flipped the status and already regenerated, the conf on
    // disk no longer references this app — skip AppManager's second regenerate
    // (one nginx write/validate/reload cycle per delete instead of two).
    return AppManager.deleteApp(appId, {
      deleteFiles: !!options.deleteFiles,
      skipProxyRegenerate: !!app[PROXY_ALREADY_REGENERATED]
    });
  }

  /**
   * Get application status with process info
   */
  static async getAppStatus(appId) {
    const app = await AppManager.getAppById(appId);

    let processInfo = null;

    if (app.status === 'running') {
      try {
        processInfo = await ProcessManager.getProcessStatus(app.name);
      } catch (error) {
        // If process not found, update database status
        if (!processInfo || !processInfo.exists) {
          await queries.updateAppStatus('stopped', appId);
          app.status = 'stopped';
        }
      }
    }

    return {
      ...app,
      process: processInfo
    };
  }

  /**
   * Sync app status with PM2
   * Updates database based on actual PM2 process status
   */
  static async syncAppStatus(appId) {
    const app = await AppManager.getAppById(appId);

    try {
      const processInfo = await ProcessManager.getProcessStatus(app.name);

      const newStatus = processInfo.exists && processInfo.status === 'online'
        ? 'running'
        : 'stopped';

      if (app.status !== newStatus) {
        await queries.updateAppStatus(newStatus, appId);
      }

      return AppManager.getAppById(appId);
    } catch (error) {
      // On error, mark as stopped
      await queries.updateAppStatus('stopped', appId);
      return AppManager.getAppById(appId);
    }
  }

  /**
   * Sync all apps status
   */
  static async syncAllAppsStatus() {
    const apps = await AppManager.getAllApps();

    const results = await Promise.allSettled(
      apps.map(app => this.syncAppStatus(app.id))
    );

    return results.map((result, index) => ({
      app: apps[index].name,
      success: result.status === 'fulfilled',
      data: result.status === 'fulfilled' ? result.value : null,
      error: result.status === 'rejected' ? result.reason.message : null
    }));
  }
}

module.exports = DeployManager;
