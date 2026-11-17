/**
 * Lap timer for deployment performance diagnosis.
 *
 * A deploy crosses several component boundaries (PM2 CLI, git, npm install,
 * npm build, nginx reload) where the wall time is dominated by external
 * processes we do not control. Without per-boundary numbers a "slow deploy"
 * report cannot be attributed to a cause, so each boundary reports its own lap
 * on one `[deploy-perf]` line. Lines are few (one per step per lifecycle op) and
 * never contain user data beyond the app name, so they are safe to leave on.
 */

const PREFIX = '[deploy-perf]';

/**
 * @param {string} scope label prefixed to every lap (normally the app name)
 * @param {number} [startAt] epoch ms the measured span began (for a timer created
 *   after its own start, e.g. once the app row — and so its name — is known)
 * @returns {{lap: (label: string, extra?: string) => number, total: () => number}}
 */
function createLapTimer(scope, startAt = Date.now()) {
  const start = startAt;
  let last = start;

  return {
    /** Log the time since the previous lap (or since creation) and return it. */
    lap(label, extra) {
      const now = Date.now();
      const ms = now - last;
      last = now;
      console.log(`${PREFIX} ${scope} ${label}: ${ms}ms${extra ? ` (${extra})` : ''}`);
      return ms;
    },
    /** Wall time since creation. */
    total() {
      return Date.now() - start;
    }
  };
}

/** One-off perf line for callers that are not inside a lap scope. */
function perfLine(scope, label, ms, extra) {
  console.log(`${PREFIX} ${scope} ${label}: ${ms}ms${extra ? ` (${extra})` : ''}`);
}

module.exports = { createLapTimer, perfLine };
