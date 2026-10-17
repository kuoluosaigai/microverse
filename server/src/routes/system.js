const express = require('express');
const config = require('../config');

/**
 * Public system endpoints: health check + client bootstrap config.
 * Mounted BEFORE requireAuth in routes/index.js.
 */
const router = express.Router();

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

// Public client configuration (upload limits, etc.)
router.get('/config', (req, res) => {
  res.json({
    success: true,
    data: {
      upload: {
        maxFileSize: config.deployment.maxFileSize,
        maxFiles: config.deployment.maxFiles
      },
      appPublicUrlTemplate: config.deployment.appPublicUrlTemplate || null,
      proxyEnabled: !!config.deployment.proxyEnabled,
      proxyBaseDomain: config.deployment.proxyBaseDomain || null
    }
  });
});

module.exports = router;
