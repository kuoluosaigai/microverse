const express = require('express');
const router = express.Router();
const AppManager = require('../services/app-manager');
const DeployManager = require('../services/deploy-manager');

/**
 * API Routes
 */

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({
    success: true,
    data: {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    }
  });
});

// Get all applications
router.get('/apps', async (req, res, next) => {
  try {
    const apps = await AppManager.getAllApps();

    res.json({
      success: true,
      data: apps
    });
  } catch (error) {
    next(error);
  }
});

// Get application by ID
router.get('/apps/:id', async (req, res, next) => {
  try {
    const app = await AppManager.getAppById(req.params.id);

    res.json({
      success: true,
      data: app
    });
  } catch (error) {
    if (error.message === 'App not found') {
      return res.status(404).json({
        success: false,
        error: { message: error.message }
      });
    }
    next(error);
  }
});

// Create new application
router.post('/apps', async (req, res, next) => {
  try {
    const { name, deploy_type } = req.body;

    if (!name || !deploy_type) {
      return res.status(400).json({
        success: false,
        error: { message: 'Missing required fields: name, deploy_type' }
      });
    }

    const newApp = await AppManager.createApp(name, deploy_type);

    res.status(201).json({
      success: true,
      data: newApp
    });
  } catch (error) {
    if (error.message.includes('already exists') || error.message.includes('Invalid')) {
      return res.status(400).json({
        success: false,
        error: { message: error.message }
      });
    }
    next(error);
  }
});

// Delete application
router.delete('/apps/:id', async (req, res, next) => {
  try {
    await AppManager.deleteApp(req.params.id);

    res.json({
      success: true,
      data: { message: 'App deleted successfully' }
    });
  } catch (error) {
    if (error.message === 'App not found') {
      return res.status(404).json({
        success: false,
        error: { message: error.message }
      });
    }
    if (error.message.includes('Cannot delete running app')) {
      return res.status(400).json({
        success: false,
        error: { message: error.message }
      });
    }
    next(error);
  }
});

// Start application
router.post('/apps/:id/start', async (req, res, next) => {
  try {
    const app = await DeployManager.deployApp(req.params.id);

    res.json({
      success: true,
      data: app
    });
  } catch (error) {
    if (error.message === 'App not found') {
      return res.status(404).json({
        success: false,
        error: { message: error.message }
      });
    }
    if (error.message.includes('already running') || error.message.includes('Missing') || error.message.includes('empty')) {
      return res.status(400).json({
        success: false,
        error: { message: error.message }
      });
    }
    next(error);
  }
});

// Stop application
router.post('/apps/:id/stop', async (req, res, next) => {
  try {
    const app = await DeployManager.stopApp(req.params.id);

    res.json({
      success: true,
      data: app
    });
  } catch (error) {
    if (error.message === 'App not found') {
      return res.status(404).json({
        success: false,
        error: { message: error.message }
      });
    }
    if (error.message.includes('not running')) {
      return res.status(400).json({
        success: false,
        error: { message: error.message }
      });
    }
    next(error);
  }
});

// Restart application
router.post('/apps/:id/restart', async (req, res, next) => {
  try {
    const app = await DeployManager.restartApp(req.params.id);

    res.json({
      success: true,
      data: app
    });
  } catch (error) {
    if (error.message === 'App not found') {
      return res.status(404).json({
        success: false,
        error: { message: error.message }
      });
    }
    if (error.message.includes('not running')) {
      return res.status(400).json({
        success: false,
        error: { message: error.message }
      });
    }
    next(error);
  }
});

// Sync application status with PM2
router.post('/apps/:id/sync', async (req, res, next) => {
  try {
    const app = await DeployManager.syncAppStatus(req.params.id);

    res.json({
      success: true,
      data: app
    });
  } catch (error) {
    if (error.message === 'App not found') {
      return res.status(404).json({
        success: false,
        error: { message: error.message }
      });
    }
    next(error);
  }
});

// File upload route (placeholder)
router.post('/apps/:id/upload', async (req, res, next) => {
  try {
    res.status(501).json({
      success: false,
      error: { message: 'Not implemented yet' }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
