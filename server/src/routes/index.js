const express = require('express');
const router = express.Router();
const AppManager = require('../services/app-manager');
const DeployManager = require('../services/deploy-manager');
const { upload, restoreUpload } = require('../middleware/upload');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const LogManager = require('../services/log-manager');
const metricsSampler = require('../services/metrics-sampler');
const BackupManager = require('../services/backup-manager');
const AuthManager = require('../services/auth-manager');
const { requireAuth } = require('../middleware/auth');
const { loginLimiter, apiLimiter } = require('../middleware/rate-limit');
const { isSafeEntry } = require('../utils/validate-zip');
const { validateEnvEntries } = require('../utils/validate-env');

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

// Public client configuration (upload limits, etc.)
router.get('/config', (req, res) => {
  res.json({
    success: true,
    data: {
      upload: {
        maxFileSize: config.deployment.maxFileSize,
        maxFiles: config.deployment.maxFiles
      }
    }
  });
});

// Authenticate (public — must be registered BEFORE requireAuth)
router.post('/auth/login', loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: { message: 'username and password are required' }
      });
    }
    const user = await AuthManager.verifyCredentials(username, password);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: { message: 'Invalid credentials' }
      });
    }
    // Regenerate the session to defeat session fixation, then stamp the user.
    req.session.regenerate((err) => {
      if (err) {
        return res.status(500).json({ success: false, error: { message: 'Login failed' } });
      }
      req.session.user = user;
      res.json({ success: true, data: { user } });
    });
  } catch (err) {
    next(err);
  }
});

// Everything below requires an authenticated session.
router.use(requireAuth);

// Generic per-IP ceiling on authenticated API traffic (SSE exempt via skip).
router.use(apiLimiter);

// Get all applications (with latest resource metrics attached)
router.get('/apps', async (req, res, next) => {
  try {
    const apps = await AppManager.getAllApps();
    const withMetrics = apps.map(app => ({
      ...app,
      metrics: metricsSampler.getLatest(app.name)
    }));

    res.json({
      success: true,
      data: withMetrics
    });
  } catch (error) {
    next(error);
  }
});

// Get application by ID (with latest resource metrics attached)
router.get('/apps/:id', async (req, res, next) => {
  try {
    const app = await AppManager.getAppById(req.params.id);

    res.json({
      success: true,
      data: { ...app, metrics: metricsSampler.getLatest(app.name) }
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

// Get application resource-metrics history
router.get('/apps/:id/metrics', async (req, res, next) => {
  try {
    const app = await AppManager.getAppById(req.params.id);
    const history = metricsSampler.getHistory(app.name);
    res.json({ success: true, data: history });
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

// Download a backup zip of an app (files + manifest)
router.get('/apps/:id/backup', async (req, res, next) => {
  try {
    const app = await AppManager.getAppById(req.params.id);
    const { buffer, filename } = await BackupManager.createBackup(app);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`
    });
    res.send(buffer);
  } catch (error) {
    if (error.message === 'App not found') {
      return res.status(404).json({ success: false, error: { message: error.message } });
    }
    next(error);
  }
});

// Restore an app from a backup zip (multipart field 'file')
router.post('/apps/restore', (req, res, next) => {
  restoreUpload(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ success: false, error: { message: err.message } });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: { message: 'No backup file provided' } });
    }
    try {
      const app = await BackupManager.restoreBackup(req.file.buffer);
      res.status(201).json({ success: true, data: app });
    } catch (error) {
      const isClientError = ['Invalid backup file', 'Invalid app name', 'Invalid deploy_type', 'already exists', 'Unsafe zip entry path']
        .some(s => error.message.includes(s));
      if (isClientError) {
        return res.status(400).json({ success: false, error: { message: error.message } });
      }
      next(error);
    }
  });
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
    // Expected deployment failures (bad app input) -> 400. Covers validation
    // messages plus NpmLifecycle errors (install/build/package.json), which are
    // deterministic client-side failures, not server faults.
    const isClientError =
      error.message.includes('already running') ||
      error.message.includes('nginx binary not found') ||
      error.message.includes('nginx config invalid') ||
      error.message.includes('Missing') ||
      error.message.includes('empty') ||
      error.message.includes('npm install failed') ||
      error.message.includes('npm install timed out') ||
      error.message.includes('build failed') ||
      error.message.includes('npm run build timed out') ||
      error.message.includes('package.json not found') ||
      error.message.includes('Invalid package.json');
    if (isClientError) {
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

// Stream an app's PM2 logs as SSE (recent history + live).
router.get('/apps/:id/logs/stream', async (req, res, next) => {
  // 1. Resolve the app BEFORE writing SSE headers so 404 is clean JSON.
  let app;
  try {
    app = await AppManager.getAppById(req.params.id);
  } catch (error) {
    if (error.message === 'App not found') {
      return res.status(404).json({
        success: false,
        error: { message: error.message },
      });
    }
    return next(error);
  }

  // 2. Parse + clamp requested history size.
  const requested = parseInt(req.query.lines, 10);
  const lines = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, 1000)
    : 100;

  // 3. SSE headers + flush so the client connects immediately.
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Guarded writer — never throws after the client has gone away.
  const send = (event, data) => {
    if (res.writableEnded) return;
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (_err) {
      /* client gone — req 'close' will clean up */
    }
  };

  // Register disconnect cleanup IMMEDIATELY (before any await). getLogPaths
  // spawns `pm2 jlist` (~100–500 ms); if the client drops in that window the
  // 'close' event must already have a listener, or the heartbeat/tailers we
  // create afterwards would leak (timer + fs.watch per tailer, forever).
  // tailers/heartbeat are assigned later in the try block; if cleanup runs
  // before they exist it's a no-op. After the getLogPaths await we gate on
  // `cleaned` (return early) so a during-await disconnect never creates the
  // leakable resources in the first place.
  let cleaned = false;
  let tailers = [];
  let heartbeat = null;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (heartbeat) clearInterval(heartbeat);
    tailers.forEach((t) => t.stop());
  };
  req.on('close', cleanup);
  req.on('error', cleanup);

  try {
    const paths = await LogManager.getLogPaths(app);

    // If the client disconnected during the await above, cleanup already ran
    // (cleaned === true). Bail before creating any tailers/heartbeat — Node is
    // single-threaded so 'close' can't fire again until this sync block yields,
    // meaning cleaned cannot flip true here mid-block; any later disconnect
    // runs cleanup normally. Prevents the during-await leak at the source.
    if (cleaned) return;

    // 4. History: out first, then err (PM2 logs aren't timestamped, so exact
    //    chronological merge of past lines isn't possible — live lines stream
    //    in true order with a server send timestamp).
    const history = [
      ...LogManager.readHistory(paths.outPath, 'out', lines),
      ...LogManager.readHistory(paths.errPath, 'err', lines),
    ];
    send('history', { lines: history });

    // 5. Live tail both streams.
    tailers = [
      LogManager.createTailer(paths.outPath, 'out', ({ level, msg }) =>
        send('line', { level, msg, ts: Date.now() })
      ),
      LogManager.createTailer(paths.errPath, 'err', ({ level, msg }) =>
        send('line', { level, msg, ts: Date.now() })
      ),
    ];

    // 6. Keep-alive heartbeat.
    heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);
  } catch (error) {
    send('error', { message: error.message || 'Failed to stream logs' });
    try { res.end(); } catch (_e) { /* ignore */ }
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
            error: { message: `File size exceeds ${Math.floor(config.deployment.maxFileSize / (1024 * 1024))}MB limit` }
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
            const entries = zip.getEntries();
            for (const entry of entries) {
              if (!isSafeEntry(app.path, entry.entryName)) {
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

// Get application environment variables
router.get('/apps/:id/env', async (req, res, next) => {
  try {
    const env = await AppManager.getAppEnv(req.params.id);
    res.json({ success: true, data: env });
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

// Replace application environment variables
router.put('/apps/:id/env', async (req, res, next) => {
  try {
    const { env } = req.body;
    const envError = validateEnvEntries(env);
    if (envError) {
      return res.status(400).json({ success: false, error: { message: envError } });
    }

    const entries = env.map(e => ({ key: e.key, value: e.value === undefined ? null : e.value }));
    const result = await AppManager.setAppEnv(req.params.id, entries);
    res.json({ success: true, data: result });
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

// Get the current session user (protected)
router.get('/auth/me', (req, res) => {
  res.json({ success: true, data: { user: req.session.user } });
});

// Log out (protected) — destroy the session + clear the cookie
router.post('/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ success: false, error: { message: 'Logout failed' } });
    }
    res.clearCookie('connect.sid'); // express-session default cookie name
    res.json({ success: true, data: { message: 'Logged out' } });
  });
});

module.exports = router;
