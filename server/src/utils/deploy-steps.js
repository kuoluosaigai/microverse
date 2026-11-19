/**
 * deploy-steps — single source of truth for deploy-job step and kind names.
 *
 * LEAF module: requires nothing, and never a service. That is what makes the
 * names shareable across the whole call hierarchy: deploy-jobs (top) AND
 * deploy-manager / npm-lifecycle (below it) all require DOWN into this file,
 * so the step reporting never needs an upward reference from a service to
 * deploy-jobs and no require cycle can form. The acyclicity is pinned by a
 * test (deploy-step-reporting.test.js: loading this module in a clean process
 * must pull zero files from src/services into require.cache).
 *
 * NOTE on ordering: DEPLOY_STEPS keeps the historical list order (validate
 * before git) because DeployJobs.STEPS has exported exactly that array since
 * Task 2 and later tasks/tests reference it by name. The REPORT order of a
 * deploy is the real execution order (the git block runs before
 * validationAppDeployment) — deploy-step-reporting.test.js pins that too.
 * List order here is a name registry, not the progression a job walks.
 */

const DEPLOY_STEP = {
  QUEUED: 'queued',
  VALIDATE: 'validate',
  GIT: 'git',
  INSTALL: 'install',
  BUILD: 'build',
  LAUNCH: 'launch',
  PROXY: 'proxy',
  DONE: 'done'
};

// Object key insertion order === the historical DeployJobs.STEPS array.
const DEPLOY_STEPS = Object.values(DEPLOY_STEP);

const DEPLOY_KINDS = {
  START: 'start',
  PULL: 'pull'
};

module.exports = { DEPLOY_STEPS, DEPLOY_STEP, DEPLOY_KINDS };
