const AppManager = require('./app-manager');
const ProcessManager = require('./process-manager');
const NpmLifecycle = require('./npm-lifecycle');
const NginxLifecycle = require('./nginx-lifecycle');
const GitLifecycle = require('./git-lifecycle');
const ProxyManager = require('./proxy-manager');
const { queries } = require('../db');
const config = require('../config');
const { createExclusive } = require('../utils/serialize');
const { createLapTimer, perfLine } = require('../utils/lap-timer');
const { DEPLOY_STEP } = require('../utils/deploy-steps');

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
   * Deploy an application (start it).
   * @param {number|string} appId
   * @param {{ onStep?: ((step: string) => void) | null, logFile?: string | null }} [options]
   *   onStep — optional synchronous progress listener called with plain
   *   step-name strings at the boundaries the [deploy-perf] laps below
   *   measure, in real execution order git -> validate -> install -> build
   *   -> launch -> proxy, each reported immediately BEFORE the work it names
   *   and only when that work actually runs (gated install/build and a
   *   skipped proxy regenerate report nothing). logFile —
   *   the deploy job's transcript path, forwarded to NpmLifecycle.ensureBuilt
   *   so background npm install/build output lands on disk. Both default to
   *   null; calling deployApp(appId) with no options behaves exactly as
   *   before (every existing caller is untouched).
   */
  static async deployApp(appId, { onStep = null, logFile = null } = {}) {
    // onStep is pure observability: a listener that throws must never fail or
    // corrupt the deploy — the same rule as the best-effort proxy regenerate
    // below and the job log file upstream. Step names come from
    // utils/deploy-steps (DEPLOY_STEP), the leaf module that ALSO defines
    // DeployJobs.STEPS: this service requires DOWN into a constants file
    // instead of importing upward from deploy-jobs, so the hierarchy stays
    // acyclic by construction (pinned by a test, not a comment).
    const report = (step) => {
      if (!onStep) return;
      try {
        onStep(step);
      } catch (_err) {
        // ignore — progress reporting never touches the orchestration
      }
    };

    const deployStartedAt = Date.now();
    // Reconcile first: a crashed/removed PM2 process must not block a re-start
    // with "already running", and a live one must not be launched twice.
    const app = await this.reconcileStatus(appId);
    const perf = createLapTimer(app.name, deployStartedAt);
    perf.lap('reconcile(pm2 jlist)');

    // Check if already running BEFORE any git work: a start must never fetch
    // and hard-reset the worktree under a live process.
    if (app.status === 'running') {
      throw new Error('App is already running');
    }

    // The DB claim is the cross-worker single-flight guard for everything that
    // touches the app directory (git → install/build → launch). It is held until
    // the process is up and released exactly once below (success or failure).
    const source = await queries.getAppGitSource(appId);
    let gitClaimed = false;
    let gitCommit = null;
    let gitWarning = null;
    if (source) {
      gitClaimed = await queries.claimGitSync(appId, config.git.staleSyncMs);
      if (!gitClaimed) throw new Error('Update in progress');
      try {
        // Reported immediately before the git work runs, so a slow/hung
        // clone or fetch is visible as the current step.
        report(DEPLOY_STEP.GIT);
        const prepared = await GitLifecycle.prepareForStart(app, source);
        perf.lap('git-prepare(clone/fetch/reset/clean)');
        gitCommit = prepared.commit;
        gitWarning = prepared.warning || null;
        // A fetch failure is not fatal: the last good checkout still starts.
        if (gitWarning) console.warn(`[git] ${app.name}: ${gitWarning}`);
      } catch (err) {
        perf.lap('git-prepare(clone/fetch/reset/clean)', 'FAILED');
        // Clone (or checkout inspection) failed — nothing safe to launch and
        // the cause is client-facing (bad URL/branch, unreachable repo), not a
        // server fault. Mark it so the start route maps it to 400 without
        // string-matching git stderr. Do NOT release inside the try below:
        // releasing here is the only exit path.
        if (err && typeof err === 'object') err.status = 400;
        await queries.finishGitSync(appId, {
          status: 'failed',
          error: err && err.message ? err.message : String(err)
        });
        throw err;
      }
    }

    try {
      // Validate app can be deployed. Reported immediately before the
      // validation runs — the same "before the work" rule as every step here,
      // so a slow/hung disk check is visible as the current step even after
      // the git block above has completed.
      report(DEPLOY_STEP.VALIDATE);
      const validation = await AppManager.validateAppDeployment(appId);
      perf.lap('validate(files on disk)');
      if (!validation.valid) {
        throw new Error(validation.message);
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
        perf.lap('port-assign');
      }

      // Start the process. For npm: install → build → resolve env → launch with env.
      // For nginx: generate the per-app config and pre-flight it (binary present +
      // config valid) before launch, so failures surface as clean 400s.
      if (app.deploy_type === 'npm') {
        // install/build run only when their fingerprint changed (or the step never
        // completed), so a plain stop→start doesn't reinstall + rebuild.
        // ensureBuilt reports 'install'/'build' itself, only when each runs.
        await NpmLifecycle.ensureBuilt(appId, app.path, { logFile, onStep });
        const env = await NpmLifecycle.resolveEnv(appId, app.port);
        report(DEPLOY_STEP.LAUNCH);
        await ProcessManager.startProcess(app, { env });
      } else if (app.deploy_type === 'nginx') {
        const confPath = NginxLifecycle.generateConfig(app.path, app.name, app.port);
        const result = await NginxLifecycle.testConfig(confPath);
        if (!result.ok) {
          throw new Error(result.message);
        }
        report(DEPLOY_STEP.LAUNCH);
        await ProcessManager.startProcess(app, { nginxConf: confPath });
      } else {
        report(DEPLOY_STEP.LAUNCH);
        await ProcessManager.startProcess(app);
      }
      perf.lap('launch(pm2 start)');

      // Update status in database
      await queries.updateAppStatus('running', appId);
      perf.lap('db status=running');

      // Best-effort: refresh the edge-proxy routes so this app's subdomain is
      // reachable. Never let a proxy problem block the deploy. The proxy step
      // is reported only when it actually does work: with PROXY_ENABLED off,
      // regenerate() short-circuits to { skipped: true } in 0ms, and a badge
      // for nothing is the same lie Ruling 1 bans for gated npm steps. A
      // THROWING regenerate is not a skip — the step started, so it still
      // counts as reported. (The skip is only known from the return value,
      // so unlike the other steps this one is reported just after the call;
      // a slow live reload shows the previous step until it finishes.)
      let proxySkipped = false;
      try {
        const result = await ProxyManager.regenerate();
        proxySkipped = Boolean(result && result.skipped);
      } catch (e) { console.warn(`[proxy] regenerate after start failed: ${e.message}`); }
      if (!proxySkipped) report(DEPLOY_STEP.PROXY);
      perf.lap('proxy regenerate');
    } catch (err) {
      perfLine(app.name, 'deployApp FAILED after', perf.total(), err.message);
      if (gitClaimed) {
        await queries.finishGitSync(appId, { status: 'failed', error: err.message, deployedCommit: gitCommit });
      }
      throw err;
    }

    // The process is up: everything below is bookkeeping, so a DB hiccup here
    // must never turn a successful start into a 500 (or record it as failed).
    if (gitClaimed) {
      try {
        // A fetch warning is not fatal, but it must stay visible in the UI
        // (a success status with last_error carrying the warning).
        await queries.finishGitSync(appId, {
          status: 'success',
          deployedCommit: gitCommit,
          error: gitWarning
        });

        // A webhook can land while this start holds the claim: it records
        // remote_commit but loses the claim (busy) and is never retried. Now
        // that the claim is released, reconcile that missed commit — queue a
        // background sync when auto-update is on, otherwise mark the update
        // badge (markGitUpdateAvailable is a no-op while a fresh claim exists).
        const current = await queries.getAppGitSource(appId);
        if (current && current.remote_commit && current.remote_commit !== gitCommit) {
          if (current.auto_update) {
            GitLifecycle.triggerBackgroundSync(appId);
          } else {
            await queries.markGitUpdateAvailable(appId, config.git.staleSyncMs);
          }
        }
      } catch (err) {
        console.error(`[git] post-start bookkeeping failed for ${app.name}: ${err && err.message ? err.message : err}`);
      }
      perf.lap('git bookkeeping');
    }

    perfLine(app.name, 'deployApp total', perf.total());
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

    // A sync owns the working tree + process right now; a restart would race it.
    await GitLifecycle.assertNotSyncing(appId);

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
    // Refuse BEFORE touching PM2/status: deleting files out from under a sync
    // would corrupt the checkout it is fetching into.
    await GitLifecycle.assertNotSyncing(appId);

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
