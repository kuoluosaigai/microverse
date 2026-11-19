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

module.exports = { sendDeployConflict };
