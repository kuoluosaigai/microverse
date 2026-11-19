const DeployJobs = require('./deploy-jobs');

/**
 * DeployRunner — the fire-and-forget boundary between a route that has
 * already answered 202 and the long-running deploy behind it.
 *
 * The caller owns the synchronous decisions (app exists, not already running,
 * validation, claim()); by the time startBackground runs, a job row is
 * claimed and the HTTP response has been sent — there is no request left to
 * deliver a failure to. So the runner has exactly one job: whatever workFn
 * does, the job must converge to a terminal state, and this call must never
 * produce an unhandled rejection.
 *
 * Contract with the owner-fenced writes of DeployJobs (Tasks 1-2): advance and
 * finish can silently change 0 rows when the row vanished (app deleted
 * mid-job) or was stolen through the stale window. That is the designed
 * outcome — the runner never assumes a write landed and never treats a silent
 * no-op as a failure. If even the finish write fails (DB down), the row stays
 * non-terminal and reconcileOnBoot's liveness sweep converges it later.
 */

function messageFrom(error) {
  if (error && typeof error.message === 'string' && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

class DeployRunner {
  /**
   * Run `workFn` detached from any request, driving `job`'s state.
   *
   * `workFn(ctx)` receives `ctx = { report, logFile }`:
   *   report(step) — sync progress hook, literally `(step) =>
   *     DeployJobs.advance(app.id, step)` (fire-and-forget: the step write is
   *     observability and its DB failure must never kill the deploy).
   *   logFile      — the claimed job's log path (job.log_path), or null when
   *     log-file creation failed at claim time (Task 2 degrades, the deploy
   *     proceeds without a log).
   * DeployManager.deployApp keeps its own parameter name `onStep`; callers
   * wire the two together: `workFn = (ctx) => deployApp(app.id, { onStep:
   * ctx.report, logFile: ctx.logFile })`.
   *
   * @param {{ id: number, name: string }} app app row the job belongs to
   * @param {'start'|'pull'} kind deploy kind (log lines only; the DB row was
   *   written with it at claim time)
   * @param {object|null} job the claimed app_deploy_job row (Task 2 `claim`)
   * @param {(ctx: { report: (step: string) => void, logFile: string|null }) => Promise<unknown>} workFn
   * @returns {void}
   */
  static startBackground(app, kind, job, workFn) {
    const ctx = {
      report: (step) => {
        // advance() is owner-fenced and silent on a lost row; a rejection can
        // only be a DB fault, and progress must never outrank the deploy.
        DeployJobs.advance(app.id, step).catch(() => { /* observability only */ });
      },
      logFile: job && job.log_path ? job.log_path : null
    };

    Promise.resolve()
      .then(() => workFn(ctx))
      .then(
        () => DeployJobs.finish(app.id, { ok: true }),
        (error) => {
          const message = messageFrom(error);
          // Nobody is listening on a socket any more — the platform log is the
          // only place a background failure is visible besides the job row.
          console.warn(`[deploy-job] ${kind} for ${app.name} failed: ${message}`);
          return DeployJobs.finish(app.id, { ok: false, message });
        }
      )
      // Task-end housekeeping (spec decision 8): drop this app's logs beyond
      // the retention window. pruneLogs swallows every fs failure itself.
      .then(() => DeployJobs.pruneLogs(app.name))
      .catch(() => {
        // Last line against unhandled rejections, reached only when the
        // finish/prune writes themselves reject (DB fault). It cannot fix the
        // row — reconcileOnBoot owns that recovery — and it must not throw,
        // so every path through startBackground converges or degrades quietly.
      });
  }
}

module.exports = DeployRunner;
