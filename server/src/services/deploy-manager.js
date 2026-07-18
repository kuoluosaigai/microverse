const AppManager = require('./app-manager');
const ProcessManager = require('./process-manager');
const NpmLifecycle = require('./npm-lifecycle');
const NginxLifecycle = require('./nginx-lifecycle');
const { queries } = require('../db');
const config = require('../config');
const { createExclusive } = require('../utils/serialize');

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
   * Deploy an application (start it)
   */
  static async deployApp(appId) {
    const app = await AppManager.getAppById(appId);

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
      await NpmLifecycle.install(app.path);
      await NpmLifecycle.build(app.path);
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

    return AppManager.getAppById(appId);
  }

  /**
   * Stop a deployed application
   */
  static async stopApp(appId) {
    const app = await AppManager.getAppById(appId);

    // Check if running
    if (app.status !== 'running') {
      throw new Error('App is not running');
    }

    // Stop the process
    await ProcessManager.stopProcess(app.name);

    // Update status in database
    await queries.updateAppStatus('stopped', appId);

    return AppManager.getAppById(appId);
  }

  /**
   * Restart a deployed application
   */
  static async restartApp(appId) {
    const app = await AppManager.getAppById(appId);

    // Check if running
    if (app.status !== 'running') {
      throw new Error('App is not running');
    }

    // Restart the process
    await ProcessManager.restartProcess(app.name);

    return AppManager.getAppById(appId);
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
