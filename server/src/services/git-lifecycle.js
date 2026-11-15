const { execFile } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const config = require('../config');

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
      throw new Error(`git ${args[0]} failed: ${String(detail).slice(-500)}`);
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
}

module.exports = GitLifecycle;
