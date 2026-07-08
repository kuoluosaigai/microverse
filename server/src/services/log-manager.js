const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const execPromise = util.promisify(exec);

/**
 * Log Manager Service
 * Resolves an app's PM2 log files, reads recent history, and tails new lines.
 * No Express knowledge — the route layer composes these primitives.
 */
class LogManager {
  /**
   * Resolve the PM2 out/error log file paths for an app.
   * Reads the real paths from `pm2 jlist`; falls back to PM2's default
   * ~/.pm2/logs/<name>-{out,error}.log when the file exists there.
   * Returns { outPath, errPath } where either may be null (no file yet).
   * Never throws for "no logs".
   */
  static async getLogPaths(appName) {
    try {
      const { stdout } = await execPromise('pm2 jlist');
      const processes = JSON.parse(stdout);
      const proc = processes.find((p) => p.name === appName);
      if (proc && proc.pm2_env) {
        return {
          outPath: proc.pm2_env.pm_out_log_path || null,
          errPath: proc.pm2_env.pm_err_log_path || null,
        };
      }
    } catch (_err) {
      // PM2 not reachable / process not listed — fall through to default paths.
    }

    const dir = path.join(os.homedir(), '.pm2', 'logs');
    const outPath = path.join(dir, `${appName}-out.log`);
    const errPath = path.join(dir, `${appName}-error.log`);
    return {
      outPath: fs.existsSync(outPath) ? outPath : null,
      errPath: fs.existsSync(errPath) ? errPath : null,
    };
  }

  /**
   * Read the last `lines` non-empty lines of a log file, tagged with `level`.
   * Synchronous; returns [] when the file is missing/unreadable.
   */
  static readHistory(filePath, level, lines = 100) {
    if (!filePath || !fs.existsSync(filePath)) return [];
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (_err) {
      return [];
    }
    return content
      .split('\n')
      .filter((l) => l.length > 0)
      .slice(-lines)
      .map((msg) => ({ level, msg }));
  }

  /**
   * Watch a log file and call onLine({level,msg}) for each newly appended line.
   * - Byte-offset incremental reads: idempotent under fs.watch's multi-fire.
   * - Line buffer: a write split across two watch callbacks never yields a
   *   half-line; only complete (newline-terminated) lines are emitted.
   * - Truncation/rotation (e.g. `pm2 flush`): resets offset to 0.
   * Returns { stop() } — no-op when filePath is null/missing. Safe to call stop() twice.
   */
  static createTailer(filePath, level, onLine) {
    if (!filePath || !fs.existsSync(filePath)) {
      return { stop() {} };
    }

    let lastSize = fs.statSync(filePath).size;
    let buffer = '';
    let watcher = null;
    let stopped = false;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (watcher) {
        watcher.removeAllListeners();
        try { watcher.close(); } catch (_e) { /* ignore */ }
      }
    };

    const readNew = () => {
      if (stopped) return;

      let size;
      try {
        size = fs.statSync(filePath).size;
      } catch (_err) {
        stop(); // file deleted under us
        return;
      }

      if (size < lastSize) {
        // truncated / rotated — restart from the top
        lastSize = 0;
        buffer = '';
      }

      const length = size - lastSize;
      if (length <= 0) return; // no new bytes (fs.watch noise)

      let fd;
      try {
        fd = fs.openSync(filePath, 'r');
        const chunk = Buffer.alloc(length);
        fs.readSync(fd, chunk, 0, length, lastSize);
        buffer += chunk.toString('utf8');

        const parts = buffer.split('\n');
        buffer = parts.pop(); // keep trailing partial line
        for (const line of parts) {
          if (line.length) onLine({ level, msg: line });
        }
        lastSize = size;
      } catch (_err) {
        stop();
      } finally {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch (_e) { /* ignore */ }
        }
      }
    };

    try {
      watcher = fs.watch(filePath, () => readNew());
      watcher.on('error', () => stop());
    } catch (_err) {
      stop();
    }

    return { stop };
  }
}

module.exports = LogManager;
