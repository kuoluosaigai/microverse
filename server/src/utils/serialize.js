/**
 * Returns an `exclusive(task)` function that runs each task strictly after the
 * previous one settles (success or failure). Used to serialize a critical
 * section (e.g. port allocation) without a dependency.
 *
 * - `chain.then(task, task)` passes the same fn as both onFulfilled and
 *   onRejected, so the next task always runs once after the previous settles.
 * - The trailing `.then(()=>{}, ()=>{})` swallows errors so a failed task can
 *   never break the chain for subsequent callers.
 *
 * Each call to createExclusive() has independent chain state, so tests are
 * isolated from each other and from DeployManager's instance.
 * @returns {(task: () => Promise<any>) => Promise<any>}
 */
function createExclusive() {
  let chain = Promise.resolve();
  return function exclusive(task) {
    const run = chain.then(task, task);
    chain = run.then(() => {}, () => {});
    return run;
  };
}

module.exports = { createExclusive };
