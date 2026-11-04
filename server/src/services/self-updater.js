const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const sqlite3 = require('sqlite3');
const pathHelper = require('../utils/path-helper');
const config = require('../config');
const UpdateManager = require('./update-manager');
const ProcessManager = require('./process-manager');

const execFilePromise = promisify(execFile);

/**
 * Ordered phases of a self-update. The status endpoint/UI renders progress
 * against this list; each phase is logged to `data/update.log`.
 */
const STEPS = [
  'preflight',
  'fetch',
  'backup',
  'pull',
  'install',
  'build',
  'reload',
  'health',
  'cleanup'
];

const GIT_TIMEOUT_MS = 30000;
const GIT_ROLLBACK_TIMEOUT_MS = 60000;
const FETCH_TIMEOUT_MS = 120000;
const NPM_TIMEOUT_MS = 15 * 60 * 1000;
const PM2_TIMEOUT_MS = 60000;
const HEALTH_TIMEOUT_MS = 60000;
const HEALTH_INTERVAL_MS = 1000;
const HEALTH_REQUEST_TIMEOUT_MS = 2000;

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `execFile` only — args are always passed as an array, never a shell string,
 * so request-supplied shas/refs cannot be interpreted by a shell.
 */
async function defaultRunCommand(file, args, options = {}) {
  const { stdout, stderr } = await execFilePromise(file, args, {
    maxBuffer: 16 * 1024 * 1024,
    ...options
  });
  return { stdout, stderr };
}

/**
 * Resolve npm the same way the rest of the platform does: run the JS entry
 * with the current node binary when one is found (Windows .cmd wrappers cannot
 * be execFile'd), otherwise fall back to a bare `npm`.
 */
function defaultRunNpm(args, options = {}) {
  const npmCli = ProcessManager.getNpmCliPath();
  if (npmCli && npmCli !== 'npm') {
    return defaultRunCommand(process.execPath, [npmCli, ...args], options);
  }
  return defaultRunCommand('npm', args, options);
}

function defaultRunPm2(args, options = {}) {
  return ProcessManager.pm2Exec(args, options);
}

/**
 * Copy the SQLite database with `VACUUM INTO` (consistent snapshot, no WAL
 * coupling). Skipped by the caller when the DB file does not exist.
 */
function defaultBackupDb(dbPath, destPath) {
  if (!fs.existsSync(dbPath)) return Promise.resolve();
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (openErr) => {
      if (openErr) {
        reject(openErr);
        return;
      }
      db.run('VACUUM INTO ?', [destPath], (runErr) => {
        db.close((closeErr) => {
          if (runErr) reject(runErr);
          else if (closeErr) reject(closeErr);
          else resolve();
        });
      });
    });
  });
}

/**
 * GET the platform health endpoint and resolve the HTTP status code.
 * Any network error rejects so `pollHealth` treats it as transient.
 */
function httpGetStatus(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: '/api/health',
      timeout: HEALTH_REQUEST_TIMEOUT_MS
    }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => req.destroy(new Error('health check timed out')));
    req.on('error', reject);
  });
}

/**
 * Poll `request(port)` until it yields a 2xx/3xx status or the deadline
 * passes. Transient errors (connection refused while PM2 restarts) are
 * retried. Resolves a boolean; never throws.
 */
async function pollHealth({
  request,
  now = Date.now,
  sleep = defaultSleep,
  port,
  timeoutMs = HEALTH_TIMEOUT_MS,
  intervalMs = HEALTH_INTERVAL_MS
}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      const status = await request(port);
      if (status >= 200 && status < 400) return true;
    } catch (_err) {
      // Transient: the server is still coming back up.
    }
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * Detached self-update runner.
 *
 * Owns the whole lifecycle of an update initiated by
 * `UpdateManager.startUpdate`: it inherits the lock claimed by the API worker,
 * runs each step against injected dependencies (so tests never touch git, npm
 * or pm2), and always leaves a final state behind. Task 5 layers rollback on
 * top of the same step methods.
 */
class SelfUpdater {
  constructor(options = {}) {
    const o = options;

    this.repoRoot = o.repoRoot || pathHelper.getProjectRoot();
    this.paths = o.paths || UpdateManager.getPaths(this.repoRoot);
    this.dbPath = o.dbPath || config.database.path;
    this.port = o.port !== undefined ? o.port : config.server.port;
    this.pm2Name = o.pm2Name || config.pm2.instanceName;
    this.ref = o.ref || config.selfUpdate.ref;
    this.remote = o.remote || config.selfUpdate.remote;
    this.fromSha = o.fromSha || null;
    this.toSha = o.toSha || null;

    this.healthTimeoutMs = o.healthTimeoutMs !== undefined ? o.healthTimeoutMs : HEALTH_TIMEOUT_MS;
    this.healthIntervalMs = o.healthIntervalMs !== undefined ? o.healthIntervalMs : HEALTH_INTERVAL_MS;

    this.runCommand = o.runCommand || defaultRunCommand;
    this.runNpm = o.runNpm || defaultRunNpm;
    this.runPm2 = o.runPm2 || defaultRunPm2;
    this.backupDb = o.backupDb || defaultBackupDb;
    this.now = o.now || Date.now;
    this.sleep = o.sleep || defaultSleep;
    this.isPidAlive = o.isPidAlive || UpdateManager.isPidAlive;

    // Bound health check: succeeds once the reloaded platform reports healthy.
    this.healthCheck = o.healthCheck || (() => pollHealth({
      request: httpGetStatus,
      port: this.port,
      timeoutMs: this.healthTimeoutMs,
      intervalMs: this.healthIntervalMs,
      now: this.now,
      sleep: this.sleep
    }));

    this.clientDir = path.join(this.repoRoot, 'client');
    this.distDir = path.join(this.clientDir, 'dist');
    this.nextDir = path.join(this.clientDir, 'dist.next');
    this.prevDir = path.join(this.clientDir, 'dist.prev');

    this.state = {
      status: 'running',
      step: 'queued',
      fromSha: this.fromSha,
      toSha: this.toSha,
      startedAt: this.iso(this.now()),
      finishedAt: null,
      error: null,
      warning: null,
      logPath: this.paths.logPath,
      pid: process.pid
    };
  }

  iso(ms) {
    return new Date(ms).toISOString();
  }

  /** Persist the current state atomically; bookkeeping must never abort an update. */
  save(patch) {
    if (patch && Object.keys(patch).length > 0) {
      this.state = { ...this.state, ...patch };
    }
    try {
      UpdateManager.writeState(this.paths.statePath, this.state);
    } catch (_err) {
      // A full/read-only data dir must not kill an otherwise healthy update.
    }
    return this.state;
  }

  log(line) {
    try {
      fs.appendFileSync(this.paths.logPath, `[${this.iso(this.now())}] ${line}\n`);
    } catch (_err) {
      // Logging is best-effort.
    }
  }

  /**
   * Claim (or take over) `data/update.lock` for this runner.
   *
   * Accepted starting points:
   *  - no lock / stale lock -> claim it with our own pid
   *  - a live lock owned by us or by the spawning API worker (ppid) -> adopt it
   * Anything else is an active update: refuse without running a command.
   *
   * @returns {boolean} true when this runner owns the lock.
   */
  acquireLock() {
    const payload = JSON.stringify({ pid: process.pid, startedAt: this.state.startedAt });
    const writeExclusive = () => {
      fs.writeFileSync(this.paths.lockPath, payload, { flag: 'wx', mode: 0o600 });
    };

    try {
      writeExclusive();
      return true;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }

    const lock = UpdateManager.readState(this.paths.lockPath);
    if (UpdateManager.isLockStale(lock, this.now(), this.isPidAlive)) {
      try {
        fs.rmSync(this.paths.lockPath, { force: true });
      } catch (_err) {
        // Best-effort; the exclusive retry decides whether we still race.
      }
      try {
        writeExclusive();
        return true;
      } catch (err) {
        if (err && err.code === 'EEXIST') return false;
        throw err;
      }
    }

    const inherited = lock && (lock.pid === process.pid || lock.pid === process.ppid);
    if (!inherited) return false;

    // Take ownership so the API worker is not credited with a running update.
    try {
      fs.writeFileSync(this.paths.lockPath, payload, { mode: 0o600 });
    } catch (_err) {
      // The lock is already held by our parent; a failed hand-off write must
      // not abort an update that is otherwise ready to run.
    }
    return true;
  }

  removeLock() {
    try {
      fs.rmSync(this.paths.lockPath, { force: true });
    } catch (_err) {
      // Best-effort.
    }
  }

  git(args, timeout = GIT_TIMEOUT_MS) {
    return this.runCommand('git', args, { cwd: this.repoRoot, timeout });
  }

  async step(name, fn) {
    this.save({ step: name });
    this.log(`[${name}] 开始`);
    await fn();
    this.log(`[${name}] 完成`);
  }

  /** Verify this is a clean, non-shallow checkout sitting on the expected sha. */
  async preflightStep() {
    // Git itself exits non-zero outside a work tree; an explicit `false` means
    // the path is a bare repo (or a work tree of a bare repo), which we cannot
    // update. Anything else (including older git output) falls through to the
    // HEAD check below.
    const inside = await this.git(['rev-parse', '--is-inside-work-tree']);
    if (inside.stdout.trim() === 'false') {
      throw new Error('当前目录不是 git 工作区，无法自动更新');
    }

    const status = await this.git(['status', '--porcelain', '--untracked-files=no']);
    if (status.stdout.trim() !== '') {
      throw new Error('工作区有未提交改动，无法自动更新');
    }

    const shallow = await this.git(['rev-parse', '--is-shallow-repository']);
    if (shallow.stdout.trim() === 'true') {
      throw new Error('git 仓库是 shallow clone，无法安全判断祖先关系');
    }

    const head = await this.git(['rev-parse', 'HEAD']);
    const headSha = head.stdout.trim();
    if (!headSha) {
      throw new Error('无法读取当前版本 (git rev-parse HEAD)');
    }
    if (this.fromSha && headSha !== this.fromSha) {
      throw new Error(`本地版本已变化（HEAD ${headSha.slice(0, 7)}），请刷新后重试`);
    }
    if (!this.fromSha) {
      this.fromSha = headSha;
      this.save({ fromSha: headSha });
    }
  }

  /** Fetch the remote ref and refuse to proceed when local commits diverge. */
  async fetchStep() {
    await this.git(['fetch', this.remote, this.ref], FETCH_TIMEOUT_MS);

    const remoteRef = `${this.remote}/${this.ref}`;
    try {
      await this.git(['merge-base', '--is-ancestor', 'HEAD', remoteRef]);
    } catch (_err) {
      throw new Error('本地提交与远端分叉，拒绝更新');
    }

    const tip = (await this.git(['rev-parse', remoteRef])).stdout.trim();
    if (UpdateManager.isValidSha(tip)) {
      this.toSha = tip;
      this.save({ toSha: tip });
    } else if (!this.toSha) {
      throw new Error('无法解析远端版本');
    }
  }

  /** Best-effort DB snapshot, then clear any stale staging directories. */
  async backupStep() {
    if (fs.existsSync(this.dbPath)) {
      const stamp = this.iso(this.now()).replace(/[:.]/g, '-');
      const destPath = path.join(this.paths.backupsDir, `${stamp}.sqlite`);
      try {
        await this.backupDb(this.dbPath, destPath);
        this.log(`数据库已备份到 ${destPath}`);
      } catch (err) {
        this.log(`数据库备份失败（继续更新）：${errorMessage(err)}`);
      }
    } else {
      this.log('数据库文件不存在，跳过备份');
    }

    fs.rmSync(this.nextDir, { recursive: true, force: true });
    fs.rmSync(this.prevDir, { recursive: true, force: true });
  }

  async pullStep() {
    await this.git(['merge', '--ff-only', `${this.remote}/${this.ref}`], FETCH_TIMEOUT_MS);
  }

  async installStep() {
    await this.runNpm(
      ['install', '--include=dev', '--no-audit', '--no-fund'],
      { cwd: this.repoRoot, timeout: NPM_TIMEOUT_MS }
    );
  }

  /**
   * Build into `client/dist.next` and only then swap. The live `client/dist`
   * is never touched while the build runs.
   */
  async buildStep() {
    await this.runNpm(
      ['run', 'build:staging', '--workspace=client'],
      { cwd: this.repoRoot, timeout: NPM_TIMEOUT_MS }
    );

    if (!fs.existsSync(this.nextDir)) {
      throw new Error('构建产出 client/dist.next 不存在，拒绝切换');
    }

    if (fs.existsSync(this.distDir)) {
      fs.rmSync(this.prevDir, { recursive: true, force: true });
      fs.renameSync(this.distDir, this.prevDir);
    }
    fs.renameSync(this.nextDir, this.distDir);
  }

  async reloadStep() {
    await this.runPm2(['reload', this.pm2Name], { timeout: PM2_TIMEOUT_MS });
  }

  async healthStep() {
    const healthy = await this.healthCheck();
    if (!healthy) {
      throw new Error('更新后健康检查失败');
    }
  }

  /**
   * Put the pre-update `dist` back after a failed update.
   *
   * The live `dist` is only replaced when `dist.prev` exists — that directory
   * is created by a build that completed its swap. A build that failed before
   * the swap leaves the original `dist` in place, so removing it would destroy
   * the only working copy. Any leftover `dist.next` is always discarded.
   */
  restoreDist() {
    if (fs.existsSync(this.prevDir)) {
      fs.rmSync(this.distDir, { recursive: true, force: true });
      fs.renameSync(this.prevDir, this.distDir);
    }
    fs.rmSync(this.nextDir, { recursive: true, force: true });
  }

  /**
   * Undo a failure in the pull → health range: reset tracked files to the
   * pre-update sha, restore the staged-build swap, reinstall whatever the old
   * code needs, reload and re-check health.
   *
   * Every step is best-effort except the final health verdict: a rollback that
   * itself fails must still produce a final state, flagged for manual
   * intervention.
   *
   * @param {Error} err - the error that triggered the rollback
   * @returns {Promise<object>} final state
   */
  async rollback(err) {
    const cause = errorMessage(err);
    this.log(`回滚开始：${cause}`);

    if (this.fromSha) {
      try {
        await this.git(['reset', '--hard', this.fromSha], GIT_ROLLBACK_TIMEOUT_MS);
        this.log(`代码已回滚到 ${this.fromSha}`);
      } catch (resetErr) {
        this.log(`代码回滚失败：${errorMessage(resetErr)}`);
      }
    }

    try {
      this.restoreDist();
      this.log('client/dist 已恢复');
    } catch (distErr) {
      this.log(`client/dist 恢复失败：${errorMessage(distErr)}`);
    }

    try {
      await this.runNpm(
        ['install', '--include=dev', '--no-audit', '--no-fund'],
        { cwd: this.repoRoot, timeout: NPM_TIMEOUT_MS }
      );
    } catch (npmErr) {
      this.log(`回滚后 npm install 失败（忽略）：${errorMessage(npmErr)}`);
    }

    try {
      await this.runPm2(['reload', this.pm2Name], { timeout: PM2_TIMEOUT_MS });
    } catch (pm2Err) {
      this.log(`回滚后 reload 失败：${errorMessage(pm2Err)}`);
    }

    let healthy = false;
    try {
      healthy = await this.healthCheck();
    } catch (healthErr) {
      this.log(`回滚后健康检查失败：${errorMessage(healthErr)}`);
    }

    if (healthy) {
      this.save({
        status: 'rolled_back',
        error: cause,
        finishedAt: this.iso(this.now())
      });
      this.log(`更新失败，已回滚：${cause}`);
    } else {
      this.save({
        status: 'failed',
        error: `更新失败，且回滚后健康检查仍未通过，需要人工介入（${cause}）`,
        finishedAt: this.iso(this.now())
      });
      this.log('回滚后健康检查仍未通过，需要人工介入');
    }

    return this.state;
  }

  /**
   * Final bookkeeping: `npm install` may rewrite the lockfile, which is the
   * only working-tree change we silently accept. Anything else is surfaced as
   * a warning but does not fail an otherwise healthy update.
   */
  async cleanupStep() {
    const status = await this.git(['status', '--porcelain', '--untracked-files=no']);
    const lines = status.stdout
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.trim().length > 0);

    if (lines.length === 1 && /^\s*M\s+package-lock\.json$/.test(lines[0])) {
      await this.git(['checkout', '--', 'package-lock.json']);
      this.log('已还原 package-lock.json');
    } else if (lines.length > 0) {
      const warning = `更新后工作区存在未提交改动：${lines.join('; ')}`;
      this.save({ warning });
      this.log(warning);
    }

    fs.rmSync(this.prevDir, { recursive: true, force: true });
  }

  /**
   * Run the whole update. Never throws: every failure is recorded in the
   * returned state.
   *
   * Failures in preflight/fetch/backup happen before anything is modified, so
   * they are plain `failed` states. Once tracked files can change (pull →
   * health) a failure triggers a full rollback and ends as `rolled_back` (the
   * old code is healthy again) or `failed` (manual intervention required).
   *
   * @returns {Promise<object>} final state
   */
  async run() {
    try {
      if (!this.acquireLock()) {
        this.save({
          status: 'failed',
          step: 'queued',
          error: '另一个更新正在进行中',
          finishedAt: this.iso(this.now())
        });
        this.log('拒绝更新：另一个更新正在进行中');
        return this.state;
      }
    } catch (err) {
      this.save({
        status: 'failed',
        error: errorMessage(err),
        finishedAt: this.iso(this.now())
      });
      return this.state;
    }

    try {
      this.save({ status: 'running' });
      this.log(`更新开始：${this.fromSha || '(unknown)'} -> ${this.toSha || '(unknown)'}`);

      // Nothing has been modified yet: a failure here needs no rollback.
      await this.step('preflight', () => this.preflightStep());
      await this.step('fetch', () => this.fetchStep());
      await this.step('backup', () => this.backupStep());

      try {
        await this.step('pull', () => this.pullStep());
        await this.step('install', () => this.installStep());
        await this.step('build', () => this.buildStep());
        await this.step('reload', () => this.reloadStep());
        await this.step('health', () => this.healthStep());
      } catch (err) {
        // Returned from inside the outer try so the lock is still released.
        return await this.rollback(err);
      }

      await this.step('cleanup', () => this.cleanupStep());

      this.save({ status: 'success', error: null, finishedAt: this.iso(this.now()) });
      this.log('更新完成');
    } catch (err) {
      const message = errorMessage(err);
      this.save({ status: 'failed', error: message, finishedAt: this.iso(this.now()) });
      this.log(`更新失败：${message}`);
    } finally {
      this.removeLock();
    }

    return this.state;
  }
}

/**
 * Entry point for the detached runner.
 *
 * @param {object} options injected dependencies/overrides (see SelfUpdater)
 * @returns {Promise<object>} final state (never rejects)
 */
async function runUpdate(options = {}) {
  const updater = new SelfUpdater(options);
  return updater.run();
}

module.exports = {
  runUpdate,
  pollHealth,
  STEPS,
  SelfUpdater
};
