const AppManager = require('./app-manager');
const ProcessManager = require('./process-manager');
const { queries } = require('../db');
const config = require('../config');

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

    // Assign port if needed
    if (app.deploy_type === 'http-server' && !app.port) {
      const port = await ProcessManager.findAvailablePort(
        config.deployment.portRangeMin,
        config.deployment.portRangeMax
      );

      await AppManager.updateApp(appId, { port });
      app.port = port;
    }

    // Start the process
    await ProcessManager.startProcess(app);

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
   * Get application logs
   */
  static async getAppLogs(appId, lines = 50) {
    const app = await AppManager.getAppById(appId);

    if (app.status !== 'running') {
      return '';
    }

    return ProcessManager.getProcessLogs(app.name, lines);
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
