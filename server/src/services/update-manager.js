const fs = require('fs');
const path = require('path');
const pathHelper = require('../utils/path-helper');

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
}

module.exports = UpdateManager;
