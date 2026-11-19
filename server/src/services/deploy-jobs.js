const fs = require('fs');
const path = require('path');
const { queries } = require('../db');
const config = require('../config');
const pathHelper = require('../utils/path-helper');
const { DEPLOY_STEPS, DEPLOY_STEP, DEPLOY_KINDS } = require('../utils/deploy-steps');

// Lazy require (git-lifecycle.js pattern): update-manager.js and THIS module
// are a dependency cycle by design — claim() consults the update lock,
// preflight() consults the job table. BOTH directions stay behind function
// accessors (update-manager.js has the mirror `deployJobs()` accessor since
// Task 10): any top-level require in either direction would close the cycle
// at module load, and — because deploy-jobs requires src/db at load — would
// drag the SQLite connection into every process that merely requires
// update-manager (the db-isolation fence runs update-state.test.js
// precisely to prove that chain stays db-free).
function updateManager() { return require('./update-manager'); }

// Terminal statuses free the single-flight lock; anything else is in-flight.
const TERMINAL_STATUSES = new Set(['succeeded', 'failed']);

// Fixed Chinese string — reconcileOnBoot's outcome message, displayed as-is
// by Task 11's frontend (never translated/reworded at the write side).
const INTERRUPTED_MESSAGE = '部署被中断（平台重启）';

// CSI escape sequences (colors, cursor moves — everything npm emits):
// ESC [ <params> <intermediates> <final byte>.
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

/**
 * DeployJobs — owner of async deploy-job STATE and job LOG FILES.
 *
 * Single responsibility: who holds an app's deploy lock, how far the job has
 * gotten, how it ended, and where its log lives. No PM2, no npm, no HTTP —
 * runners (Tasks 5-10) drive the actual work through this service and never
 * touch the app_deploy_job table directly.
 *
 * Two invariants define the design:
 *  1. LOG OWNERSHIP LIVES IN claim(). A log path is only COMPUTED before the
 *     DB claim, and the file is only CREATED after the claim is won, so a
 *     losing claim touches the filesystem zero times. Callers never build a
 *     path, and a log-file failure never fails a deploy (log_path -> null).
 *  2. OWNER FENCING. Every step/log/finish write carries process.pid, so a
 *     job stolen through the stale window cannot be mutated (or terminated)
 *     by its previous owner still running with a stale handle. The expected
 *     pid never enters a caller-visible signature.
 */
class DeployJobs {
  // Step/kind names are DEFINED in utils/deploy-steps (the leaf module the
  // services below the job layer also require — single source, no upward
  // imports) and re-exported here unchanged: DeployJobs.STEPS and
  // DeployJobs.KINDS remain the stable public API Task 2's tests and the
  // later runner/UI tasks build on.
  static KINDS = DEPLOY_KINDS;
  static STEPS = DEPLOY_STEPS;
  static LOG_RETENTION = 5;

  /**
   * Directory holding every job's log file: <repoRoot>/data/deploy-logs.
   * Not created here — creation is claim()'s job (and may fail harmlessly).
   * @returns {string}
   */
  static logDir() {
    return path.join(pathHelper.getProjectRoot(), 'data', 'deploy-logs');
  }

  /**
   * Seam over UpdateManager's live lock/state probe (no lock parsing here).
   * Its own method so tests can override it without touching the filesystem.
   * @returns {boolean}
   */
  static isUpdateRunning() {
    return updateManager().isUpdateRunning();
  }

  /**
   * Whether `pid` exists on this machine. Signal 0 performs error checking
   * without delivering anything — the only cross-platform liveness probe.
   * EPERM means the process exists but belongs to someone else.
   * Separate method for test injection.
   * @param {number} pid
   * @returns {boolean}
   */
  static isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return Boolean(err && err.code === 'EPERM');
    }
  }

  /**
   * Synchronous liveness verdict for a job row (or row-shaped object):
   * non-terminal status AND a fresh-enough started_at AND a live owner pid.
   * A dead pid demotes a job immediately — inside the stale window is still
   * dead, which is how a crashed worker stops blocking its app.
   * SQLite CURRENT_TIMESTAMP is UTC without a zone marker (same treatment as
   * GitLifecycle.isSyncInProgress); an unparseable/missing started_at is
   * treated as not live.
   * @param {object|null} job
   * @param {number} [now]
   * @returns {boolean}
   */
  static isLive(job, now = Date.now()) {
    if (!job || TERMINAL_STATUSES.has(job.status)) return false;
    if (!job.started_at) return false;
    const startedMs = new Date(`${job.started_at}Z`).getTime();
    if (Number.isNaN(startedMs)) return false;
    if (now - startedMs > config.deployment.deployJobStaleMs) return false;
    return this.isPidAlive(job.pid);
  }

  /**
   * Try to become the owner of `app`'s deploy job.
   *
   * Order: update-lock gate -> atomic DB claim -> log file creation. Only the
   * winner ever touches the filesystem (see class invariant 1); the path was
   * precomputed as a pure string and is passed INTO the claim so a locked job
   * carries its log path from the moment the lock exists. If creating the file
   * fails, the deploy still proceeds — the path is retracted from the row so
   * readers never chase a phantom, and `job.log_path` is null.
   *
   * SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT from the claim mean "a contended writer
   * won the race" (the platform-wide busy_timeout is the first line of
   * defense) and map to a plain lost claim; any other DB error is a real
   * fault and rethrows — it must never masquerade as "someone else is
   * deploying".
   *
   * @param {{ id: number, name: string }} app app row (name is filename-safe:
   *   ^[A-Za-z0-9_-]{1,64}$ is enforced at creation)
   * @param {'start'|'pull'} kind
   * @returns {Promise<{ ok: boolean, reason?: 'busy'|'updating'|'gone', job?: object }>}
   */
  static async claim(app, kind) {
    if (this.isUpdateRunning()) {
      return { ok: false, reason: 'updating' };
    }

    const logPath = path.join(this.logDir(), `${app.name}-${Date.now()}.log`);
    let won;
    try {
      won = await queries.claimDeployJob({
        appId: app.id,
        kind,
        pid: process.pid,
        logPath,
        staleMs: config.deployment.deployJobStaleMs
      });
    } catch (err) {
      if (err && (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_BUSY_SNAPSHOT')) {
        return { ok: false, reason: 'busy' };
      }
      throw err;
    }
    if (!won) return { ok: false, reason: 'busy' };

    // Won: NOW (and only now) the file appears.
    const created = this.createLogFile(logPath);
    if (!created) {
      // Best-effort retraction. If even this write fails the persisted row
      // keeps a path to a file that will never exist — tolerated, because
      // tail() returns [] for missing files; the returned job is always
      // honest (log_path forced to null below).
      try {
        await queries.setDeployJobLogPath(app.id, null, process.pid);
      } catch (_err) {
        // bookkeeping only; never fails the deploy
      }
    }
    const job = await queries.getDeployJob(app.id);
    if (!job) {
      // The app row was CASCADE-deleted between winning the claim and this
      // read-back. Not 'busy' — nobody is deploying; and never ok:true with a
      // null job — a truthy-but-empty success TypeErrors the moment a runner
      // reads job.log_path. The log file already created here would leak too:
      // pruneLogs(appName) never runs again for a deleted app, so unlink it
      // (best-effort) before reporting the app as gone.
      if (created) {
        try {
          fs.rmSync(logPath, { force: true });
        } catch (_err) {
          // an orphaned log is strictly less bad than failing this path
        }
      }
      return { ok: false, reason: 'gone' };
    }
    if (!created) job.log_path = null;
    return { ok: true, job };
  }

  /**
   * Create an empty job log file (and the log dir on demand).
   * @returns {boolean} false on ANY filesystem failure — the caller decides
   *   how to degrade, a log problem never throws into a deploy.
   */
  static createLogFile(logPath) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, '');
      return true;
    } catch (_err) {
      return false;
    }
  }

  /**
   * Persist progress of the job this process owns. Silent no-op (changes=0)
   * when the row is gone (app deleted mid-job), was stolen (pid fence
   * mismatch) or already TERMINAL (status fence — a late fire-and-forget
   * report must never rewrite a finished job's step).
   * @param {number} appId
   * @param {string} step one of DeployJobs.STEPS
   * @returns {Promise<object>} the dbRun result; callers may observe changes
   */
  static async advance(appId, step) {
    return queries.updateDeployJobStep(appId, step, process.pid);
  }

  /**
   * Record this process's job outcome and release the lock. Owner-fenced and
   * silent on a vanished row, like advance().
   *
   * OWN-PROCESS ONLY: the fence binds this worker's process.pid, so this can
   * only ever finish a job the calling process itself claimed. Boot-time
   * convergence over ORPHANED rows (pids of crashed workers) must NOT call
   * this method — it must go through the query layer with the row's own pid:
   * queries.finishDeployJob(appId, { status, message, pid: row.pid }).
   * (advance() carries the same own-pid fence.)
   *
   * SUCCESS LANDS THE TERMINAL STEP: ok:true writes step='done' in the SAME
   * UPDATE as status/finished_at, so there is no finish-then-advance window a
   * late fire-and-forget report could overwrite. This is deliberate (Task 8
   * review ruling): start and pull share this single success path (no second
   * writer can forget 'done'), and reconcileOnBoot goes through the query
   * layer WITHOUT step on purpose — an interrupted job keeps the step it died
   * on and never claims done. ok:false never touches step.
   *
   * @param {number} appId
   * @param {{ ok: boolean, message?: string|null }} result
   * @returns {Promise<void>}
   */
  static async finish(appId, { ok, message = null } = {}) {
    await queries.finishDeployJob(appId, {
      status: ok ? 'succeeded' : 'failed',
      message,
      step: ok ? DEPLOY_STEP.DONE : undefined,
      pid: process.pid
    });
  }

  /**
   * Boot-time convergence: a worker that died mid-deploy (crash, or the
   * platform's own `pm2 reload`) leaves its app_deploy_job row 'running'
   * forever — the ONLY remedy is this pass, run once from server.js after the
   * DB is ready (boot-only by design: no timer, no periodic sweeper).
   *
   * Every row in listNonTerminalDeployJobs() that is NOT live by isLive()'s
   * reasoning (dead owner pid, or past the stale window) becomes 'failed'
   * with the fixed interruption message; live rows — another cluster worker's
   * in-flight deploy — are left exactly alone.
   *
   * WHY it must bypass finish(): finish() fences on process.pid (see its
   * OWN-PROCESS ONLY note), and this runs in a process that by definition is
   * NOT the owner of an orphaned row — routing through it would silently
   * change ZERO rows (fence mismatch is designed to be quiet). Each row
   * self-certifies the terminal write with the pid stored IN the row:
   * queries.finishDeployJob(appId, { ..., pid: row.pid }). This is the only
   * exception to the own-pid rule; it weakens nothing, because rows whose
   * owner is still live are skipped above and never reach the write.
   *
   * Idempotent: converged rows turn terminal, so a later boot (every cluster
   * worker runs this) lists and changes nothing.
   *
   * @param {{ now?: number, isPidAlive?: (pid: number) => boolean }} [options]
   *   test seams only — production takes the defaults (Date.now and the class
   *   pid probe).
   * @returns {Promise<{ converged: number }>} rows actually terminated
   */
  static async reconcileOnBoot({ now = Date.now(), isPidAlive } = {}) {
    // isLive() consults `this.isPidAlive`; when a probe is injected, hand it
    // a `this` that only provides the injected one — reusing the full
    // status/started_at/staleness reasoning instead of re-deriving it.
    const liveOwner = typeof isPidAlive === 'function' ? { isPidAlive } : this;
    const rows = await queries.listNonTerminalDeployJobs();
    let converged = 0;
    for (const row of rows) {
      if (this.isLive.call(liveOwner, row, now)) continue;
      const result = await queries.finishDeployJob(row.app_id, {
        status: 'failed',
        message: INTERRUPTED_MESSAGE,
        pid: row.pid
      });
      // Count only rows we really flipped: one lost to a mid-loop app delete
      // or a fresh claim is not a convergence.
      if (result && result.changes > 0) converged += 1;
    }
    return { converged };
  }

  /**
   * The app's current job when it is still live, else null (terminal rows,
   * stale rows and dead-owner rows are all "not active").
   * @param {number} appId
   * @returns {Promise<object|null>}
   */
  static async activeJob(appId) {
    const job = await queries.getDeployJob(appId);
    return job && this.isLive(job) ? job : null;
  }

  /**
   * The first LIVE job across ALL apps, with the owning app's `name` attached
   * as `app_name`, or null. This is what UpdateManager.preflight() consults
   * (Task 10 mutual exclusion): a self-update ends in `pm2 reload` of every
   * worker, so a live job on ANY app kills ANY deploy — per-app activeJob()
   * cannot answer that. Liveness is exactly isLive()'s verdict (terminal,
   * dead-owner and stale rows never block) applied to the same non-terminal
   * scan reconcileOnBoot uses; rows whose app vanished between scan and name
   * read are skipped (CASCADE removes the job row with it — nothing live is
   * blocking).
   * @returns {Promise<object|null>} job row plus app_name, or null
   */
  static async anyActiveJob() {
    const rows = await queries.listNonTerminalDeployJobs();
    for (const row of rows) {
      if (!this.isLive(row)) continue;
      const app = await queries.getAppById(row.app_id);
      if (!app) continue;
      return { ...row, app_name: app.name };
    }
    return null;
  }

  /**
   * THE single producer of the busy-409 wording (Task 6 review: the start
   * route hand-copied this message and dropped the `· <step>` part — two
   * producers, two wordings, guaranteed drift once Task 11 keys i18n off
   * them). assertIdle and the route's losing-claim branch both render here.
   * Format is fixed (Task 11 i18n keys off it):
   *   部署进行中（<kind> · <step>），请等待完成后再<action>
   * @param {{kind?: string, step?: string}|null} job the live (or just-lost-
   *   the-race-to) job row; missing parts degrade to whatever the row has
   * @param {string} action verb appended to the message, e.g. '删除'
   * @returns {string}
   */
  static busyMessage(job, action) {
    const detail = [job && job.kind, job && job.step].filter(Boolean).join(' · ');
    return `部署进行中（${detail}），请等待完成后再${action}`;
  }

  /**
   * Reject mutating an app whose deploy job is live.
   * @param {number} appId
   * @param {string} action verb appended to the message, e.g. '删除'
   * @throws {Error} err.status = 409
   * @returns {Promise<void>}
   */
  static async assertIdle(appId, action) {
    const job = await this.activeJob(appId);
    if (!job) return;
    const err = new Error(this.busyMessage(job, action));
    err.status = 409;
    throw err;
  }

  /**
   * Bounded tail of the app's most recent job log, ANSI-stripped.
   * Seeks to the end and reads at most `maxBytes` — deploy logs carry real
   * `npm install` output and must never be slurped whole (same discipline as
   * UpdateManager.readLogTail). Missing row / missing path / missing file all
   * yield []; reads never throw.
   * @param {number} appId
   * @param {{ lines?: number, maxBytes?: number }} [options]
   * @returns {Promise<string[]>}
   */
  static async tail(appId, { lines = 200, maxBytes = 65536 } = {}) {
    const job = await queries.getDeployJob(appId);
    if (!job || !job.log_path) return [];
    return this.readLogTail(job.log_path, lines, maxBytes);
  }

  /**
   * Read the last `maxLines` non-empty lines, looking at no more than the
   * last `maxBytes` bytes. A leading line cut by the byte window is dropped.
   * Never throws.
   * @returns {string[]}
   */
  static readLogTail(logPath, maxLines, maxBytes) {
    let fd;
    try {
      const size = fs.statSync(logPath).size;
      if (size === 0) return [];

      const start = Math.max(0, size - maxBytes);
      const length = size - start;
      const buffer = Buffer.alloc(length);
      fd = fs.openSync(logPath, 'r');
      fs.readSync(fd, buffer, 0, length, start);

      let text = buffer.toString('utf8');
      if (start > 0) {
        // The window may begin mid-line; that partial line is not readable.
        const newline = text.indexOf('\n');
        text = newline === -1 ? '' : text.slice(newline + 1);
      }

      return text
        .split(/\r?\n/)
        .map((line) => line.replace(ANSI_RE, ''))
        .filter((line) => line.length > 0)
        .slice(-maxLines);
    } catch (_err) {
      return [];
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch (_err) {
          // ignore close errors
        }
      }
    }
  }

  /**
   * Keep only the newest `keep` log files for one app (newest = highest epoch
   * ms embedded in `<name>-<epoch>.log`). Other apps' files — and files that
   * merely share the name as a prefix — are untouched.
   *
   * Housekeeping after a finished deploy: every filesystem failure is
   * swallowed, because failing to prune old logs must never surface as a
   * failed deploy.
   * @param {string} appName
   * @param {number} [keep]
   * @returns {Promise<void>}
   */
  static async pruneLogs(appName, keep = DeployJobs.LOG_RETENTION) {
    // App names are enforced as ^[A-Za-z0-9_-]{1,64}$, none of which are
    // regex metacharacters outside a character class — safe to interpolate.
    const pattern = new RegExp(`^${appName}-(\\d+)\\.log$`);
    let entries;
    try {
      entries = fs.readdirSync(this.logDir());
    } catch (_err) {
      return;
    }
    const owned = [];
    for (const name of entries) {
      const match = pattern.exec(name);
      if (match) owned.push({ name, epoch: Number(match[1]) });
    }
    owned.sort((a, b) => b.epoch - a.epoch);
    for (const { name } of owned.slice(Math.max(0, keep))) {
      try {
        fs.rmSync(path.join(this.logDir(), name), { force: true });
      } catch (_err) {
        // Locked (being tailed) or vanished — next prune picks it up.
      }
    }
  }
}

module.exports = DeployJobs;
