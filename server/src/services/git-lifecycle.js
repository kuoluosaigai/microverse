const { execFile } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const config = require('../config');

// DB / PM2 / npm services are required lazily inside the methods that use them.
// Requiring ../db at module load opens the SQLite connection and logs progress
// to stdout, which would corrupt the node test runner's IPC stream for files
// that only exercise the pure git primitives (git-lifecycle-repo.test.js).
// Accessors keep the dependency surface explicit and cheap (require is cached).
function db() { return require('../db'); }
function processManager() { return require('./process-manager'); }
function npmLifecycle() { return require('./npm-lifecycle'); }

const execFilePromise = util.promisify(execFile);

// Control characters and whitespace. `url`/`branch` are passed as arguments
// (never through a shell), but a leading '-' would still be parsed as an
// option by git, and odd whitespace is a classic argument-injection vector.
// This is defense in depth only — production URL/branch policy lives in
// utils/validate-git-source.js. It is intentionally NOT called here because
// repo tests point at local `file://` repositories that policy rejects.
const UNSAFE_ARG_RE = /[\u0000-\u001f\u007f\s]/;

/**
 * GitLifecycle — git repository primitives for git-source deploys.
 *
 * Every git invocation goes through `gitExec`, which uses execFile with an
 * argument array (no shell), a bounded timeout and a non-interactive
 * environment so a bad/private remote fails fast instead of hanging.
 */
class GitLifecycle {
  /**
   * Reject values that would be dangerous as a git argument.
   * @param {*} value
   * @param {string} label
   * @throws {Error} 'Invalid git <label>'
   */
  static assertSafeArg(value, label) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Invalid git ${label}`);
    }
    if (value.startsWith('-') || UNSAFE_ARG_RE.test(value)) {
      throw new Error(`Invalid git ${label}`);
    }
  }

  /**
   * Run git with an argument array.
   * @param {string[]} args
   * @param {{ cwd?: string, timeoutMs?: number }} [options]
   * @returns {Promise<{ stdout: string, stderr: string }>}
   */
  static async gitExec(args, { cwd, timeoutMs } = {}) {
    try {
      return await execFilePromise(config.git.bin, args, {
        cwd,
        timeout: timeoutMs || config.git.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      });
    } catch (err) {
      const detail = err.stderr || err.message || String(err);
      // Tag git subprocess failures so route handlers can map them to 400
      // without also swallowing unrelated server faults (DB/PM2/plumbing).
      const wrapped = new Error(`git ${args[0]} failed: ${String(detail).slice(-500)}`);
      wrapped.gitError = true;
      throw wrapped;
    }
  }

  /**
   * Whether appPath is already a git repository.
   * @param {string} appPath
   * @returns {boolean}
   */
  static hasRepo(appPath) {
    return fs.existsSync(path.join(appPath, '.git'));
  }

  /**
   * Bind appPath to the remote branch: init when needed, point origin at the
   * source, shallow-fetch and check the branch out. Untracked files (for
   * example platform-added ones) are preserved.
   * @param {string} appPath
   * @param {{ url: string, branch: string }} source
   * @returns {Promise<{ cloned: boolean, commit: string }>}
   */
  static async ensureRepo(appPath, { url, branch } = {}) {
    this.assertSafeArg(url, 'url');
    this.assertSafeArg(branch, 'branch');

    const hadRepo = this.hasRepo(appPath);
    if (!hadRepo) {
      fs.mkdirSync(appPath, { recursive: true });
      await this.gitExec(['init', '-q'], { cwd: appPath });
    }

    let hasOrigin = false;
    try {
      await this.gitExec(['remote', 'get-url', 'origin'], { cwd: appPath });
      hasOrigin = true;
    } catch (_err) {
      // No origin configured yet.
    }
    if (hasOrigin) {
      await this.gitExec(['remote', 'set-url', 'origin', url], { cwd: appPath });
    } else {
      await this.gitExec(['remote', 'add', 'origin', url], { cwd: appPath });
    }

    await this.gitExec(['fetch', '--depth', '1', 'origin', branch], { cwd: appPath });
    await this.gitExec(['checkout', '-B', branch, 'FETCH_HEAD'], { cwd: appPath });

    return { cloned: !hadRepo, commit: await this.currentHead(appPath) };
  }

  /**
   * Point `origin` at url (idempotent: set-url when origin exists, add when
   * not). Needed before every fetch because a URL re-bind only updates the DB —
   * an existing checkout would otherwise keep fetching the previous remote.
   * @param {string} appPath
   * @param {string} url
   */
  static async setRemote(appPath, url) {
    this.assertSafeArg(url, 'url');
    let hasOrigin = false;
    try {
      await this.gitExec(['remote', 'get-url', 'origin'], { cwd: appPath });
      hasOrigin = true;
    } catch (_err) {
      // No origin configured yet.
    }
    if (hasOrigin) {
      await this.gitExec(['remote', 'set-url', 'origin', url], { cwd: appPath });
    } else {
      await this.gitExec(['remote', 'add', 'origin', url], { cwd: appPath });
    }
  }

  /**
   * @param {string} appPath
   * @returns {Promise<string>} current HEAD sha
   */
  static async currentHead(appPath) {
    const { stdout } = await this.gitExec(['rev-parse', 'HEAD'], { cwd: appPath });
    return stdout.trim();
  }

  /**
   * Fetch the remote branch and return its sha without touching the worktree.
   * @param {string} appPath
   * @param {string} branch
   * @returns {Promise<string>}
   */
  static async fetchHead(appPath, branch) {
    this.assertSafeArg(branch, 'branch');
    await this.gitExec(['fetch', '--depth', '1', 'origin', branch], { cwd: appPath });
    const { stdout } = await this.gitExec(['rev-parse', 'FETCH_HEAD'], { cwd: appPath });
    return stdout.trim();
  }

  /**
   * Look up the branch sha on the remote without cloning.
   * @param {{ url: string, branch: string }} source
   * @returns {Promise<string|null>} null when the branch does not exist
   */
  static async remoteHead({ url, branch } = {}) {
    this.assertSafeArg(url, 'url');
    this.assertSafeArg(branch, 'branch');
    const { stdout } = await this.gitExec(['ls-remote', '--heads', url, `refs/heads/${branch}`]);
    const line = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (!line) return null;
    return line.split(/\s+/)[0];
  }

  /**
   * Compare the deployed commit with the remote branch head (no clone/worktree
   * changes). A missing branch yields `remoteCommit: null` and `upToDate: false`.
   * @param {object} app
   * @param {object} source app_git_source row
   * @returns {Promise<{ remoteCommit: string|null, deployedCommit: string|null, upToDate: boolean }>}
   */
  static async check(app, source) {
    if (!source) {
      throw new Error('Not a Git-sourced app');
    }
    const deployedCommit = source.deployed_commit || null;
    const remoteCommit = await this.remoteHead(source);
    return { remoteCommit, deployedCommit, upToDate: remoteCommit === deployedCommit };
  }

  /**
   * Whether a sync currently holds a fresh (non-stale) claim. A claim older
   * than config.git.staleSyncMs belongs to a crashed worker and does not count.
   * @param {number} appId
   * @returns {Promise<boolean>}
   */
  static async isSyncInProgress(appId) {
    const source = await db().queries.getAppGitSource(appId);
    if (!source || source.last_status !== 'updating' || !source.sync_started_at) {
      return false;
    }
    // SQLite CURRENT_TIMESTAMP is UTC without a zone marker.
    const startedAt = new Date(source.sync_started_at + 'Z').getTime();
    if (Number.isNaN(startedAt)) return false;
    return startedAt > Date.now() - config.git.staleSyncMs;
  }

  /**
   * Reject lifecycle mutations while a sync owns the working tree.
   * @param {number} appId
   * @throws {Error} 'Update in progress'
   */
  static async assertNotSyncing(appId) {
    if (await this.isSyncInProgress(appId)) {
      throw new Error('Update in progress');
    }
  }

  /**
   * Get the app's checkout ready for a start.
   *
   * Clone is mandatory (a failed clone fails the start). For an existing
   * checkout origin is re-pointed at the stored URL first, so a URL re-bind is
   * honored; then, when `auto_update` is on, fetch and hard-reset the worktree
   * to the remote head. A fetch failure is NOT fatal: the app starts on the
   * last good checkout and the failure is reported as a warning.
   * @param {object} app app row (needs path)
   * @param {object} source app_git_source row
   * @returns {Promise<{ commit: string, warning: string|null }>}
   */
  static async prepareForStart(app, source) {
    if (!this.hasRepo(app.path)) {
      const { commit } = await this.ensureRepo(app.path, source); // clone is mandatory
      return { commit, warning: null };
    }

    // A URL re-bind only updates the DB; re-point origin every start so an
    // existing checkout never fetches from the previous remote.
    await this.setRemote(app.path, source.url);

    if (!source.auto_update) {
      return { commit: await this.currentHead(app.path), warning: null };
    }

    try {
      const commit = await this.fetchHead(app.path, source.branch);
      await this.gitExec(['reset', '--hard', 'FETCH_HEAD'], { cwd: app.path });
      // -fd only: never -x, which would delete node_modules / platform files.
      await this.gitExec(['clean', '-fd'], { cwd: app.path });
      return { commit, warning: null };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      return { commit: await this.currentHead(app.path), warning: `fetch failed: ${message}` };
    }
  }

  /**
   * Pull the app's branch into place and rebuild/restart when needed.
   * The DB claim is the single-flight guard, so this is safe across cluster
   * workers: a second concurrent caller returns `busy` without touching files.
   *
   * Rollback ordering: any git/build failure restores the previous HEAD and a
   * best-effort npm rebuild, and records the failure with the OLD commit (or
   * leaves deployed_commit NULL when nothing was ever deployed). A restart
   * failure is different — the new files are already valid, so it keeps the new
   * commit and only reports failed (no rollback).
   * @param {object} app app row (needs id, name, path, deploy_type)
   * @param {{ reason?: string }} [options]
   * @returns {Promise<{ status: 'busy'|'up-to-date'|'success'|'failed', deployedCommit: string|null, error: string|null }>}
   */
  static async sync(app, { reason = 'manual' } = {}) {
    void reason; // reserved for callers/logging; outcome is recorded in the DB row
    const source = await db().queries.getAppGitSource(app.id);
    if (!source) {
      return { status: 'failed', deployedCommit: null, error: 'Not a Git-sourced app' };
    }

    // A webhook may land on another worker while this sync builds. `setGitRemoteCommit`
    // records it without touching the fresh claim, so after a successful attempt we
    // re-check and pull again (bounded) instead of leaving the app one commit behind.
    const maxAttempts = 3;
    let result = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      result = await this.syncAttempt(app);
      if (result.status !== 'success') return result;
      const current = await db().queries.getAppGitSource(app.id);
      if (!current || !current.remote_commit || current.remote_commit === result.deployedCommit) {
        return result;
      }
    }
    return result;
  }

  /**
   * One claimed sync attempt. Every path that gets past a successful claim ends
   * with finishGitSync (which clears sync_started_at) — including unexpected
   * throws — so a failure can never wedge the app behind a permanent claim.
   * @param {object} app
   */
  static async syncAttempt(app) {
    if (!(await db().queries.claimGitSync(app.id, config.git.staleSyncMs))) {
      return { status: 'busy', deployedCommit: null, error: null };
    }

    try {
      return await this.runClaimedSync(app);
    } catch (err) {
      // Unexpected error outside the explicit rollback paths (DB/PM2/git
      // plumbing). Release the claim and report it; there is no known-good
      // partial state to reason about here.
      const message = err && err.message ? err.message : String(err);
      await db().queries.finishGitSync(app.id, { status: 'failed', error: message }).catch(() => {});
      return { status: 'failed', deployedCommit: null, error: message };
    }
  }

  /**
   * Body of a claimed sync. Callers must hold the claim.
   * @param {object} app
   */
  static async runClaimedSync(app) {
    const source = await db().queries.getAppGitSource(app.id);
    if (!source) {
      await db().queries.finishGitSync(app.id, { status: 'failed', error: 'Not a Git-sourced app' });
      return { status: 'failed', deployedCommit: null, error: 'Not a Git-sourced app' };
    }

    // PM2 is the source of truth, but a PM2-less machine must not look stopped.
    const wasRunning = await this.isProcessRunning(app);

    // Whether a deployed state exists to fall back to. When it does not, a
    // failed first sync must leave deployed_commit NULL so the next attempt
    // retries the build instead of calling the never-built commit up-to-date.
    const hadDeployedCommit = !!source.deployed_commit;

    let newSha = null;
    let prevSha = null;
    try {
      if (!this.hasRepo(app.path)) {
        await this.ensureRepo(app.path, source);
      }
      // A URL re-bind only updates the DB; re-point origin every time so an
      // existing checkout never fetches from the previous remote.
      await this.setRemote(app.path, source.url);
      newSha = await this.fetchHead(app.path, source.branch);

      if (newSha === source.deployed_commit) {
        // Same commit, but this still proves the remote was reached: record the
        // success (and advance synced_at) via deployedCommit.
        await db().queries.finishGitSync(app.id, { status: 'success', deployedCommit: newSha });
        return { status: 'up-to-date', deployedCommit: newSha, error: null };
      }

      prevSha = await this.currentHead(app.path);
      await this.gitExec(['reset', '--hard', 'FETCH_HEAD'], { cwd: app.path });
      // -fd only: never -x, which would delete node_modules / platform files.
      await this.gitExec(['clean', '-fd'], { cwd: app.path });

      if (app.deploy_type === 'npm') {
        await npmLifecycle().ensureBuilt(app.id, app.path);
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      const rollbackTo = prevSha || source.deployed_commit || null;
      if (rollbackTo) {
        try {
          await this.gitExec(['reset', '--hard', rollbackTo], { cwd: app.path });
        } catch (_rollbackErr) {
          // Keep the original failure; the stored deployed_commit still tells
          // which commit the app should be running.
        }
      }
      if (app.deploy_type === 'npm') {
        try {
          await npmLifecycle().ensureBuilt(app.id, app.path);
        } catch (_rebuildErr) {
          // Best-effort only: never mask the original error.
        }
      }
      // Never advertise a commit as deployed when there was no prior deployed
      // state: that would make a same-SHA retry "up-to-date" and skip the
      // rebuild, silently masking this failure.
      const recordedCommit = hadDeployedCommit ? rollbackTo : null;
      await db().queries.finishGitSync(app.id, {
        status: 'failed',
        error: message,
        deployedCommit: recordedCommit
      });
      return { status: 'failed', deployedCommit: recordedCommit, error: message };
    }

    // Files are in place. Only a running npm app has anything to reload; static
    // deploys serve from disk. Re-check PM2 after the build so a stop issued
    // mid-build wins (never resurrect a process the operator stopped).
    if (wasRunning && app.deploy_type === 'npm' && (await this.isProcessRunning(app))) {
      try {
        await processManager().restartProcess(app.name);
      } catch (err) {
        const message = `Restart failed: ${err && err.message ? err.message : String(err)}`;
        // No rollback: the new commit is valid, only the reload failed.
        await db().queries.finishGitSync(app.id, {
          status: 'failed',
          error: message,
          deployedCommit: newSha
        });
        return { status: 'failed', deployedCommit: newSha, error: message };
      }
    }

    await db().queries.finishGitSync(app.id, { status: 'success', deployedCommit: newSha });
    return { status: 'success', deployedCommit: newSha, error: null };
  }

  /**
   * PM2 truth with a DB fallback when the CLI is unreachable.
   * @param {object} app
   * @returns {Promise<boolean>}
   */
  static async isProcessRunning(app) {
    try {
      const status = await processManager().getProcessStatus(app.name);
      return !!(status && status.exists && status.status === 'online');
    } catch (_err) {
      return app.status === 'running';
    }
  }

  /**
   * Fire-and-forget sync used by the webhook handler: a webhook response must
   * never wait on (or fail because of) the pull. Resolves the app/source itself
   * and swallows every failure, including lookup errors, so nothing can escape
   * to the caller as an unhandled rejection.
   * @param {number} appId
   * @returns {void}
   */
  static triggerBackgroundSync(appId) {
    const lifecycle = this;
    (async () => {
      let label = `#${appId}`;
      try {
        const app = await require('./app-manager').getAppById(appId);
        label = app.name;
        const source = await db().queries.getAppGitSource(appId);
        if (!source) return;
        await lifecycle.sync(app, { reason: 'webhook' });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        console.error(`[git] background sync failed for ${label}: ${message}`);
      }
    })();
  }

  /**
   * Alias used by route/background callers: pull === sync.
   * @param {object} app
   * @returns {Promise<ReturnType<typeof GitLifecycle.sync>>}
   */
  static async pull(app) {
    return this.sync(app);
  }
}

module.exports = GitLifecycle;
