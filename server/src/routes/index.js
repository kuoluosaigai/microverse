const express = require('express');
const router = express.Router();
const AppManager = require('../services/app-manager');
const DeployManager = require('../services/deploy-manager');
const { upload } = require('../middleware/upload');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');

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

// Get application files/directory listing
router.get('/apps/:id/files', async (req, res, next) => {
  try {
    const files = await AppManager.getAppFiles(req.params.id);

    res.json({
      success: true,
      data: files
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

// File upload route
router.post('/apps/:id/upload', async (req, res, next) => {
  try {
    // Get app and verify it exists
    const app = await AppManager.getAppById(req.params.id);

    // Set upload path for multer
    req.uploadPath = app.path;

    // Ensure upload directory exists
    if (!fs.existsSync(app.path)) {
      fs.mkdirSync(app.path, { recursive: true });
    }

    // Use multer middleware
    upload.array('files')(req, res, async (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            success: false,
            error: { message: 'File size exceeds 50MB limit' }
          });
        }
        return res.status(400).json({
          success: false,
          error: { message: err.message }
        });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({
          success: false,
          error: { message: 'No files uploaded' }
        });
      }

      const uploadedFiles = [];

      // Process each file
      for (const file of req.files) {
        const filePath = path.join(app.path, file.filename);
        uploadedFiles.push(file.filename);

        // If ZIP file, extract it
        if (path.extname(file.filename).toLowerCase() === '.zip') {
          try {
            const zip = new AdmZip(filePath);

            // Guard against path traversal (zip-slip): every entry must
            // resolve inside the app directory before we extract.
            const safeRoot = path.resolve(app.path);
            const entries = zip.getEntries();
            for (const entry of entries) {
              const entryTarget = path.resolve(app.path, entry.entryName);
              if (entryTarget !== safeRoot && !entryTarget.startsWith(safeRoot + path.sep)) {
                throw new Error(`Unsafe zip entry path: ${entry.entryName}`);
              }
            }

            zip.extractAllTo(app.path, true);

            // Get list of extracted files
            const extractedFiles = entries.map(entry => entry.entryName);
            uploadedFiles.push(...extractedFiles);

            // Delete the ZIP file after extraction
            fs.unlinkSync(filePath);

            // Remove ZIP from uploaded files list
            const zipIndex = uploadedFiles.indexOf(file.filename);
            if (zipIndex > -1) {
              uploadedFiles.splice(zipIndex, 1);
            }
          } catch (zipError) {
            console.error('ZIP extraction error:', zipError);
            return res.status(400).json({
              success: false,
              error: { message: 'Failed to extract ZIP file' }
            });
          }
        }
      }

      res.json({
        success: true,
        data: {
          filesUploaded: uploadedFiles.length,
          files: uploadedFiles
        }
      });
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

module.exports = router;
