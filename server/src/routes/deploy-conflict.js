const { queries } = require('../db');
const DeployJobs = require('../services/deploy-jobs');

/**
 * Shared mapping from a caught error to the standard 409 deploy-conflict
 * response.
 *
 * DeployJobs.assertIdle (Task 2) refuses mutating an app whose deploy job is
 * live by throwing an Error with `.status = 409` and the fixed Chinese
 * message `部署进行中（kind · step），请等待完成后再<action>`. Task 7 gates
 * ten more handlers on it, and every one must answer that error identically
 * — so BOTH the decision (is this a deploy conflict?) and the response
 * shape ({ success:false, error:{ message } }) live here, in one producer.
 * The two route files keep their local idioms (apps.js inlines
 * res.status().json(), git.js has sendError) but neither re-implements the
 * 409 mapping; each just calls this first and `return`s when it handled it.
 *
 * @param {import('express').Response} res
 * @param {unknown} error the caught error
 * @returns {boolean} true when the 409 was sent (caller must stop handling
 *   this error); false means "not a deploy conflict" and the caller's own
 *   branches / next(error) run unchanged.
 */
function sendDeployConflict(res, error) {
  if (!error || typeof error !== 'object' || error.status !== 409) return false;
  res.status(409).json({ success: false, error: { message: error.message } });
  return true;
}

/**
 * Shared mapping from a LOST DeployJobs.claim() to its HTTP response (Task 10
 * Step 0: the start and pull routes each hand-rolled this mapping verbatim,
 * differing only in the action verb — self-update is the third caller the
 * Task 9 review foresaw, and three copies would drift).
 *
 * Contract (Task 2's claim reasons, Task 6's wording ruling):
 *  - 'gone'      -> 404 'App not found' (app deleted between lookup and claim;
 *                   explicitly NOT a 202 — no background task was started)
 *  - 'updating'  -> 409 with the fixed self-update-lock wording
 *                   '平台正在自更新，请稍后再试'
 *  - 'busy'      -> 409 rendered through the ONE busy-message producer
 *                   (DeployJobs.busyMessage) from the row that won the atomic
 *                   claim; if that row is already gone the app was deleted
 *                   mid-race — same 404 as 'gone'.
 *
 * The response bodies are byte-identical to what both routes produced
 * inline before the extraction ({success:false, error:{message}} under
 * res.status(...).json — git.js's sendError is exactly that shape).
 *
 * @param {import('express').Response} res
 * @param {{ok:false, reason:'busy'|'updating'|'gone'}} claim the losing claim
 * @param {{ id: number }} app the app the caller tried to claim for
 * @param {string} action verb for the busy message, e.g. '启动' / '拉取更新'
 * @returns {Promise<void>}
 */
async function sendClaimFailure(res, claim, app, action) {
  if (claim.reason === 'gone') {
    res.status(404).json({ success: false, error: { message: 'App not found' } });
    return;
  }
  if (claim.reason === 'updating') {
    res.status(409).json({ success: false, error: { message: '平台正在自更新，请稍后再试' } });
    return;
  }
  const busyJob = await queries.getDeployJob(app.id);
  if (!busyJob) {
    res.status(404).json({ success: false, error: { message: 'App not found' } });
    return;
  }
  res.status(409).json({
    success: false,
    error: { message: DeployJobs.busyMessage(busyJob, action) }
  });
}

module.exports = { sendDeployConflict, sendClaimFailure };
