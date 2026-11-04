const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const pathHelper = require('../utils/path-helper');
const config = require('../config');
const ProcessManager = require('./process-manager');

const execFilePromise = promisify(execFile);

// Version-check cache window: one `git ls-remote` per 10 minutes is plenty.
const CHECK_TTL_MS = 10 * 60 * 1000;

/**
 * Update Manager Service
 * Filesystem and state primitives for platform self-update:
 * runtime paths, update state (atomic JSON), lock staleness, remote-sha
 * parsing, and bounded log tails. No Express or git knowledge here — the
 * orchestration methods are layered on top by later tasks.
 */
class UpdateManager {
  /**
   * Resolve the runtime artifact paths for self-update.
   * All artifacts live under <repoRoot>/data so they survive a code update
   * and are shared by every PM2 cluster worker. The data directory itself is
   * created (recursively, idempotently) so callers can write to the paths.
   *
   * @param {string} [repoRoot]
   */
  static getPaths(repoRoot = pathHelper.getProjectRoot()) {
    const dataDir = path.join(repoRoot, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    return {
      repoRoot,
      statePath: path.join(dataDir, 'update-state.json'),
      lockPath: path.join(dataDir, 'update.lock'),
      checkPath: path.join(dataDir, 'update-check.json'),
      logPath: path.join(dataDir, 'update.log'),
      backupsDir: path.join(dataDir, 'backups')
    };
  }

  /**
   * Parse `git ls-remote` output: `<hex-sha><TAB><ref>`.
   * Returns null when the first field is not a plausible sha.
   */
  static parseRemoteSha(stdout) {
    if (typeof stdout !== 'string') return null;
    const line = stdout
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (!line) return null;
    const [sha, ref] = line.split('\t');
    if (!sha || !ref) return null;
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return null;
    return sha;
  }

  /**
   * True only when both versions are known, the working tree is clean, and
   * the shas differ. Missing/dirty data means "no update to offer".
   */
  static computeUpdateAvailable(current, latest) {
    if (!current || !latest) return false;
    if (current.dirty) return false;
    if (!current.sha || !latest.sha) return false;
    return current.sha !== latest.sha;
  }

  /**
   * A lock is stale (and may be preempted) when it is missing/malformed, its
   * pid is not alive, or it started more than 2 hours ago.
   *
   * @param {object|null} lock - { pid, startedAt }
   * @param {number} nowMs
   * @param {(pid:number)=>boolean} isPidAlive
   */
  static isLockStale(lock, nowMs, isPidAlive) {
    if (!lock || typeof lock !== 'object') return true;
    if (!Number.isInteger(lock.pid) || lock.pid <= 0) return true;

    const startedAt = Date.parse(lock.startedAt);
    if (Number.isNaN(startedAt)) return true;

    let alive;
    try {
      alive = Boolean(isPidAlive(lock.pid));
    } catch (_err) {
      alive = false;
    }
    if (!alive) return true;

    return nowMs - startedAt > 2 * 60 * 60 * 1000;
  }

  /**
   * Read a JSON state file. Returns null when the file is missing, unreadable,
   * or corrupt — callers treat that as "no state".
   */
  static readState(statePath) {
    try {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (_err) {
      return null;
    }
  }

  /**
   * Atomically replace a JSON state file: write `<path>.tmp`, then rename.
   * Creates the parent directory when needed.
   */
  static writeState(statePath, state) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmpPath = statePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    fs.renameSync(tmpPath, statePath);
  }

  /**
   * Return the last `maxLines` non-empty lines, reading at most the last
   * `maxBytes` bytes. A truncated leading line is dropped. Never throws.
   *
   * @param {string} logPath
   * @param {{ maxLines?: number, maxBytes?: number }} [options]
   * @returns {string[]}
   */
  static readLogTail(logPath, { maxLines = 200, maxBytes = 65536 } = {}) {
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
        // The first line may be cut mid-line; drop it.
        const newline = text.indexOf('\n');
        text = newline === -1 ? '' : text.slice(newline + 1);
      }

      return text
        .split('\n')
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
   * Promisified `execFile` with bounded output and a default timeout. Throws
   * the underlying error (including non-zero exit) — callers decide whether
   * that means "unknown" or "fatal".
   */
  static async execFileAsync(file, args, options = {}) {
    const { stdout, stderr } = await execFilePromise(file, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10000,
      ...options
    });
    return { stdout, stderr };
  }

  /**
   * Describe the checked-out commit. Returns null when this is not a usable
   * git working tree (missing git, not a repo, command failure).
   */
  static async getCurrentVersion() {
    const cwd = pathHelper.getProjectRoot();
    try {
      const inside = await this.execFileAsync(
        'git', ['rev-parse', '--is-inside-work-tree'], { cwd });
      if (inside.stdout.trim() !== 'true') return null;

      const { stdout: shaOut } = await this.execFileAsync(
        'git', ['rev-parse', 'HEAD'], { cwd });
      const sha = shaOut.trim();
      if (!sha) return null;

      const { stdout: committedOut } = await this.execFileAsync(
        'git', ['log', '-1', '--format=%cI'], { cwd });
      const { stdout: statusOut } = await this.execFileAsync(
        'git', ['status', '--porcelain', '--untracked-files=no'], { cwd });

      return {
        sha,
        shortSha: sha.slice(0, 7),
        version: require('../../../package.json').version,
        committedAt: committedOut.trim(),
        dirty: statusOut.trim().length > 0
      };
    } catch (_err) {
      return null;
    }
  }

  /**
   * Resolve the remote tip of the configured branch, cached in
   * `update-check.json` for CHECK_TTL_MS. Returns null when the remote cannot
   * be reached or its output is unparseable.
   */
  static async getLatestVersion({ now = Date.now(), paths = this.getPaths() } = {}) {
    const cached = this.readState(paths.checkPath);
    if (cached && typeof cached.checkedAt === 'string') {
      const checkedMs = Date.parse(cached.checkedAt);
      if (now - checkedMs < CHECK_TTL_MS) return cached;
    }

    try {
      const { stdout } = await this.execFileAsync(
        'git',
        ['ls-remote', config.selfUpdate.remote, `refs/heads/${config.selfUpdate.ref}`],
        { cwd: paths.repoRoot, timeout: 5000 });
      const sha = this.parseRemoteSha(stdout);
      if (!sha) return null;

      const latest = {
        sha,
        shortSha: sha.slice(0, 7),
        checkedAt: new Date(now).toISOString()
      };
      try {
        this.writeState(paths.checkPath, latest);
      } catch (_err) {
        // Cache is best-effort; a read-only data dir must not break the check.
      }
      return latest;
    } catch (_err) {
      return null;
    }
  }

  /**
   * True when the configured platform process (PM2_INSTANCE_NAME) is online
   * according to `pm2 jlist`. Any failure means "not online".
   */
  static async isPm2Online() {
    try {
      const { stdout } = await ProcessManager.pm2Exec(['jlist'], { timeout: 10000 });
      const list = JSON.parse(stdout);
      if (!Array.isArray(list)) return false;
      const entry = list.find((proc) => proc && proc.name === config.pm2.instanceName);
      return Boolean(entry && entry.pm2_env && entry.pm2_env.status === 'online');
    } catch (_err) {
      return false;
    }
  }

  /**
   * Shallow clones cannot be ancestry-checked safely, so updates are refused.
   */
  static async isShallowRepository() {
    try {
      const { stdout } = await this.execFileAsync(
        'git', ['rev-parse', '--is-shallow-repository'],
        { cwd: pathHelper.getProjectRoot() });
      return stdout.trim() === 'true';
    } catch (_err) {
      return false;
    }
  }

  static isPlatformSupported(platform = process.platform) {
    return platform !== 'win32';
  }

  /**
   * True when a live update lock is held (the lock exists and is not stale).
   */
  static isUpdateRunning(now = Date.now()) {
    const lock = this.readState(this.getPaths().lockPath);
    const isPidAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        // EPERM means the process exists but belongs to another user.
        return Boolean(err && err.code === 'EPERM');
      }
    };
    return !this.isLockStale(lock, now, isPidAlive);
  }

  /**
   * Display payload for the update banner. Never throws.
   */
  static async getVersionInfo() {
    try {
      const current = await this.getCurrentVersion();
      const latest = await this.getLatestVersion();
      const platformSupported = this.isPlatformSupported();
      const pm2Online = await this.isPm2Online();
      const updateEnabled = Boolean(
        config.selfUpdate.enabled && platformSupported && pm2Online);
      const updateAvailable = this.computeUpdateAvailable(current, latest);

      let reason = null;
      if (!config.selfUpdate.enabled) {
        reason = '自更新未开启 (SELF_UPDATE_ENABLED)';
      } else if (!platformSupported) {
        reason = '当前平台不支持自更新';
      } else if (!current) {
        reason = '平台不是 git 部署，无法自更新';
      } else if (current.dirty) {
        reason = '工作区有未提交改动';
      } else if (!latest) {
        reason = '无法获取远端版本';
      } else if (!updateAvailable) {
        reason = '已经是最新版本';
      } else if (!pm2Online) {
        reason = 'PM2 进程未在线（检查 PM2_INSTANCE_NAME）';
      }

      return { current, latest, updateAvailable, updateEnabled, reason };
    } catch (err) {
      return {
        current: null,
        latest: null,
        updateAvailable: false,
        updateEnabled: false,
        reason: err.message
      };
    }
  }

  /**
   * Cheap, synchronous-order gate performed by the route before spawning the
   * detached update runner. Ancestry/divergence resolution is deferred to the
   * runner (see later tasks).
   *
   * @returns {Promise<{ok:true, fromSha:string, toSha:string}
   *   | {ok:false, httpStatus:number, message:string}>}
   */
  static async preflight() {
    if (!config.selfUpdate.enabled) {
      return { ok: false, httpStatus: 400, message: '自更新未开启 (SELF_UPDATE_ENABLED)' };
    }
    if (!this.isPlatformSupported()) {
      return { ok: false, httpStatus: 400, message: '当前平台不支持自更新' };
    }
    if (this.isUpdateRunning()) {
      return { ok: false, httpStatus: 409, message: '已有更新正在进行' };
    }

    const current = await this.getCurrentVersion();
    if (!current) {
      return { ok: false, httpStatus: 400, message: '平台不是 git 部署，无法自更新' };
    }
    if (current.dirty) {
      return { ok: false, httpStatus: 400, message: '工作区有未提交改动' };
    }
    if (await this.isShallowRepository()) {
      return { ok: false, httpStatus: 400, message: 'git 仓库是 shallow clone，无法安全判断祖先关系' };
    }

    const latest = await this.getLatestVersion();
    if (!latest || !latest.sha) {
      return { ok: false, httpStatus: 400, message: '无法获取远端版本' };
    }
    if (current.sha === latest.sha) {
      return { ok: false, httpStatus: 400, message: '已经是最新版本' };
    }
    if (!(await this.isPm2Online())) {
      return { ok: false, httpStatus: 400, message: 'PM2 进程未在线（检查 PM2_INSTANCE_NAME）' };
    }

    return { ok: true, fromSha: current.sha, toSha: latest.sha };
  }

  /**
   * Record a `running` state and spawn the detached self-update runner
   * (scripts/self-update.js). Returns the child pid; the runner owns the
   * lock and rewrites the state file as it progresses.
   *
   * @param {{fromSha: string, toSha: string}} args
   * @returns {Promise<{pid: number}>}
   */
  static async startUpdate({ fromSha, toSha }) {
    const paths = this.getPaths();
    const startedAt = new Date().toISOString();
    const state = {
      status: 'running', step: 'queued', fromSha, toSha,
      startedAt, finishedAt: null, error: null, warning: null,
      logPath: paths.logPath, pid: process.pid
    };
    this.writeState(paths.statePath, state);
    const child = this.spawnDetached(process.execPath, [
      path.join(paths.repoRoot, 'scripts', 'self-update.js'), '--from', fromSha, '--to', toSha
    ], { cwd: paths.repoRoot, detached: true, stdio: 'ignore' });
    child.unref();
    state.pid = child.pid;
    this.writeState(paths.statePath, state);
    return { pid: child.pid };
  }

  /**
   * Spawn indirection kept as its own method so tests can stub the runner
   * launch without touching child_process.
   */
  static spawnDetached(file, args, options) {
    const { spawn } = require('child_process');
    return spawn(file, args, options);
  }

  /**
   * Poll payload for the update banner: the last recorded state (idle when
   * none/corrupt) plus a bounded tail of the runner log.
   */
  static async getUpdateStatus() {
    const paths = this.getPaths();
    return {
      state: this.readState(paths.statePath) || { status: 'idle' },
      logTail: this.readLogTail(paths.logPath)
    };
  }
}

module.exports = UpdateManager;
