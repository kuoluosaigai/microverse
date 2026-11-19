const express = require('express');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');
const AppManager = require('../services/app-manager');
const DeployManager = require('../services/deploy-manager');
const DeployJobs = require('../services/deploy-jobs');
const DeployRunner = require('../services/deploy-runner');
const GitLifecycle = require('../services/git-lifecycle');
const LogManager = require('../services/log-manager');
const BackupManager = require('../services/backup-manager');
const ProxyManager = require('../services/proxy-manager');
const metricsSampler = require('../services/metrics-sampler');
const { upload, restoreUpload } = require('../middleware/upload');
const { isSafeEntry } = require('../utils/validate-zip');
const { validateEnvEntries } = require('../utils/validate-env');
const { flattenTopDirs } = require('../utils/flatten-zip-root');
const zipDecoder = require('../utils/zip-decoder');
const { staleFilesToRemove, platformManagedNames } = require('../utils/stale-files');
const config = require('../config');
const { queries } = require('../db');

/**
 * Application lifecycle endpoints (all protected — mounted AFTER requireAuth).
 */
const router = express.Router();

// Get all applications (with latest resource metrics attached)
router.get('/apps', async (req, res, next) => {
  try {
    const apps = await AppManager.getAllApps();
    const withMetrics = await Promise.all(apps.map(async app => ({
      ...app,
      metrics: await metricsSampler.getLatest(app.name)
    })));

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
      data: { ...app, metrics: await metricsSampler.getLatest(app.name) }
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
    const history = await metricsSampler.getHistory(app.name);
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
    const { name, deploy_type, git_url, git_branch, git_auto_update } = req.body;

    if (!name || !deploy_type) {
      return res.status(400).json({
        success: false,
        error: { message: 'Missing required fields: name, deploy_type' }
      });
    }

    const gitOptions = git_url
      ? {
          url: git_url,
          branch: git_branch || 'main',
          autoUpdate: git_auto_update !== false
        }
      : null;

    const newApp = await AppManager.createApp(name, deploy_type, gitOptions);

    res.status(201).json({
      success: true,
      data: newApp
    });
  } catch (error) {
    if (
      error.message.includes('already exists') ||
      error.message.includes('Invalid') ||
      error.message.includes('Git URL')
    ) {
      return res.status(400).json({
        success: false,
        error: { message: error.message }
      });
    }
    next(error);
  }
});

// Delete application (goes through DeployManager so the running-guard is
// checked against PM2 truth, not a stale DB flag)
router.delete('/apps/:id', async (req, res, next) => {
  try {
    const deleteFiles = req.query.deleteFiles === 'true';
    await DeployManager.deleteApp(req.params.id, { deleteFiles });

    res.json({
      success: true,
      data: { message: 'App deleted successfully', filesDeleted: deleteFiles }
    });
  } catch (error) {
    if (error.message === 'App not found') {
      return res.status(404).json({
        success: false,
        error: { message: error.message }
      });
    }
    if (error.message === 'Update in progress') {
      return res.status(409).json({
        success: false,
        error: { message: error.message }
      });
    }
    if (error.message.includes('Cannot delete running app') || error.message.includes('Refusing to delete')) {
      return res.status(400).json({
        success: false,
        error: { message: error.message }
      });
    }
    next(error);
  }
});

// Start application — 202 + background deploy job. Everything the request can
// still decide WITHOUT doing the work answers synchronously with its old
// status code (spec decision 7); everything that requires touching the disk /
// PM2 / npm now happens in the job and is reported through the job row.
// Order below is load-bearing: fetch -> job gate -> reconcile (already
// running) -> validation (non-git only) -> git claim check -> claim -> 202.
router.post('/apps/:id/start', async (req, res, next) => {
  try {
    const app = await AppManager.getAppById(req.params.id); // 404 'App not found'

    // A live deploy job for THIS app means a second start would double-launch
    // the same work. (claim() below re-checks atomically; this one fails fast.)
    await DeployJobs.assertIdle(app.id, '启动'); // throws err.status = 409

    // PM2 reconcile (~0.2-1s `jlist`) is worth waiting for: an already-running
    // app must keep its synchronous 400 instead of a doomed background job.
    const reconciled = await DeployManager.reconcileStatus(app.id);
    if (reconciled.status === 'running') {
      return res.status(400).json({
        success: false,
        error: { message: 'App is already running' }
      });
    }

    // Synchronous validation is only safe for apps whose files already exist:
    // a git-bound app's directory is legitimately empty until the clone runs
    // (the repo owns the content), so full validation moves into the job.
    const source = await queries.getAppGitSource(app.id);
    if (!source) {
      const validation = await AppManager.validateAppDeployment(app.id);
      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          error: { message: validation.message }
        });
      }
    }

    // A webhook background sync already owns the working tree claim: 409 stays
    // synchronous (existing contract, same message).
    if (await GitLifecycle.isSyncInProgress(app.id)) {
      return res.status(409).json({
        success: false,
        error: { message: 'Update in progress' }
      });
    }

    // Atomic cross-worker claim. Reasons map per Task 2's contract:
    // 'gone' -> 404 (NO 202, no background task), 'updating' -> 409
    // (platform self-update lock), 'busy' -> 409 (lost the fast-path race).
    const claim = await DeployJobs.claim(app, DeployJobs.KINDS.START);
    if (!claim.ok) {
      if (claim.reason === 'gone') {
        return res.status(404).json({
          success: false,
          error: { message: 'App not found' }
        });
      }
      if (claim.reason === 'updating') {
        return res.status(409).json({
          success: false,
          error: { message: '平台正在自更新，请稍后再试' }
        });
      }
      return res.status(409).json({
        success: false,
        error: { message: `部署进行中（${DeployJobs.KINDS.START}），请等待完成后再启动` }
      });
    }

    res.status(202).json({
      success: true,
      data: {
        app_id: app.id,
        kind: DeployJobs.KINDS.START,
        status: 'running'
      }
    });

    // Sent, so from here the ONLY reporter is the job row. The runner owns
    // every failure path, including failures of its own bookkeeping.
    DeployRunner.startBackground(app, DeployJobs.KINDS.START, claim.job, (ctx) =>
      DeployManager.deployApp(app.id, { onStep: ctx.report, logFile: ctx.logFile })
    );
  } catch (error) {
    if (error.message === 'App not found') {
      return res.status(404).json({
        success: false,
        error: { message: error.message }
      });
    }
    if (error.message === 'Update in progress') {
      return res.status(409).json({
        success: false,
        error: { message: error.message }
      });
    }
    // assertIdle and friends stamp the status to use (409 for deploy-in-progress).
    if (error.status === 409) {
      return res.status(409).json({
        success: false,
        error: { message: error.message }
      });
    }
    // Expected pre-check failures (bad app input) -> 400. The full list is
    // kept for the synchronous checks above — validation messages and
    // 'already running' still arrive here — but install/build/git failures
    // can no longer: they happen inside the background job now.
    const isClientError =
      error.status === 400 ||
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
    if (error.message === 'Update in progress') {
      return res.status(409).json({
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

    // A git-sourced app's content is owned by the repository: an upload would
    // be silently reverted on the next sync, so reject it up front.
    if (await queries.getAppGitSource(app.id)) {
      return res.status(400).json({
        success: false,
        error: { message: 'Git source apps must be updated from the repository' }
      });
    }

    // Set upload path for multer
    req.uploadPath = app.path;

    // Ensure upload directory exists
    if (!fs.existsSync(app.path)) {
      fs.mkdirSync(app.path, { recursive: true });
    }

    // Snapshot the app dir before multer writes this upload's files, so we can
    // tell which entries predate the request (stale user content to remove when
    // a zip upload replaces the app).
    const beforeFiles = fs.readdirSync(app.path);

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

      // The names multer actually wrote. multer hands out one path per
      // (sanitized) name, so several parts with the same name collapse onto the
      // same file — the basename list is therefore de-duplicated, and the count
      // reported to the user is the number of files that now exist, not parts.
      const writtenNames = [...new Set(req.files.map(f => path.basename(f.filename)))];

      // A zip upload is a full-content replacement: remove stale user files left
      // over from a previous deploy, but keep platform-managed entries
      // (node_modules, nginx conf/pid/logs) and the files just written here.
      const hasZip = writtenNames.some(n => path.extname(n).toLowerCase() === '.zip');
      if (hasZip) {
        const stale = staleFilesToRemove(app, beforeFiles, writtenNames);
        for (const name of stale) {
          fs.rmSync(path.join(app.path, name), { recursive: true, force: true });
        }
      }

      const uploadedFiles = [];
      const addFile = (name) => {
        if (!uploadedFiles.includes(name)) uploadedFiles.push(name);
      };

      // Process each file
      for (const file of req.files) {
        const name = path.basename(file.filename);
        const filePath = path.join(app.path, name);

        // If ZIP file, extract it
        if (path.extname(name).toLowerCase() !== '.zip') {
          addFile(name);
          continue;
        }

        // Two parts named "x.zip" share one path: the first iteration extracts
        // and removes it, so skip the (now missing) duplicate instead of failing.
        if (!fs.existsSync(filePath)) continue;

        try {
          const zip = new AdmZip(filePath, { decoder: zipDecoder });

          // Guard against path traversal (zip-slip): every entry must
          // resolve inside the app directory before we extract.
          const entries = zip.getEntries();
          for (const entry of entries) {
            if (!isSafeEntry(app.path, entry.entryName)) {
              throw new Error(`Unsafe zip entry path: ${entry.entryName}`);
            }
          }

          zip.extractAllTo(app.path, true);

          // Delete the uploaded .zip BEFORE flattening. multer writes the
          // archive directly into app.path, so leaving it here makes
          // readdirSync(app.path) see two entries (the archive + the extracted
          // wrapper folder) and flattenTopDirs bails out — leaving index.html
          // buried under repo-main/ and deploy validation failing.
          fs.unlinkSync(filePath);

          // If the zip wrapped everything in one or more nested top-level
          // folders (common with GitHub/IDE zips), hoist their contents up so
          // index.html etc. land directly under the app directory. Returns the
          // unwrapped path prefix when it flattened (used below), or null.
          const flattenedPrefix = flattenTopDirs(app.path, platformManagedNames(app));

          // Reported file names should match the on-disk paths. When wrappers
          // were flattened, strip their prefix and drop the wrapper dir entries
          // themselves (which collapse to ''). Otherwise the list is the entry
          // names verbatim. The archive itself is never reported — it no longer
          // exists on disk.
          let extractedFiles = entries.map(entry => entry.entryName);
          if (flattenedPrefix) {
            const prefix = `${flattenedPrefix}/`;
            extractedFiles = extractedFiles
              .map(entry => (entry.startsWith(prefix) ? entry.slice(prefix.length) : entry))
              .filter(entry => entry.length > 0);
          }
          extractedFiles.forEach(addFile);
        } catch (zipError) {
          console.error('ZIP extraction error:', zipError);
          return res.status(400).json({
            success: false,
            error: { message: 'Failed to extract ZIP file' }
          });
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
      return res.status(404).json({ success: false, error: { message: error.message } });
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
      return res.status(404).json({ success: false, error: { message: error.message } });
    }
    next(error);
  }
});

// Set this app as the root-domain default (reverse proxy). Single-default:
// clears any other app's flag first, then regenerates the edge config.
router.put('/apps/:id/default', async (req, res, next) => {
  try {
    await AppManager.getAppById(req.params.id); // 404 if missing
    const app = await queries.setDefaultApp(Number(req.params.id));
    try { await ProxyManager.regenerate(); } catch (e) { console.warn(`[proxy] regenerate after set-default failed: ${e.message}`); }
    res.json({ success: true, data: app });
  } catch (error) {
    if (error.message === 'App not found') {
      return res.status(404).json({ success: false, error: { message: error.message } });
    }
    next(error);
  }
});

// Clear this app's root-domain default, then regenerate.
router.delete('/apps/:id/default', async (req, res, next) => {
  try {
    await AppManager.getAppById(req.params.id);
    await queries.updateApp({ id: Number(req.params.id), is_default: 0 });
    try { await ProxyManager.regenerate(); } catch (e) { console.warn(`[proxy] regenerate after clear-default failed: ${e.message}`); }
    res.json({ success: true, data: { message: 'Default cleared' } });
  } catch (error) {
    if (error.message === 'App not found') {
      return res.status(404).json({ success: false, error: { message: error.message } });
    }
    next(error);
  }
});

module.exports = router;
