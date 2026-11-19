/**
 * deploy-steps — single source of truth for deploy-job step and kind names.
 *
 * LEAF module: requires nothing, and never a service. That is what makes the
 * names shareable across the whole call hierarchy: deploy-jobs (top) AND
 * deploy-manager / npm-lifecycle (below it) all require DOWN into this file,
 * so step reporting never needs an upward reference from a service to
 * deploy-jobs and no require cycle can form. The acyclicity is pinned by a
 * test (deploy-step-reporting.test.js: loading this module in a clean process
 * must pull zero files from src/services into require.cache).
 *
 * ORDER: the array order IS the report order IS the real execution order —
 * git-prepare physically runs before validateAppDeployment, and the nginx
 * per-app config work runs before that type's launch. deploy-jobs-state's
 * round-trip is order-insensitive and advance() validates nothing but the
 * name, so the sequence tests (deploy-step-reporting.test.js) are what keep
 * the producers honest. DeployJobs.STEPS re-exports THIS exact array, so the
 * list doubles as the progress ladder: within any reported run the indices
 * only move forward. Task 11's "step N of M" pairing (client AppRow):
 * the numerator is indexOf(step) with NO +1, and the denominator is
 * length - 2, EXCLUDING the `queued` (index 0) and `done` (index 8)
 * bookends — so `git` renders "1 of 7" … `proxy` renders "7 of 7". Adding 1
 * to the numerator while dropping the bookends from the denominator (the
 * plan's original wording, off by one) would render `proxy` as "8 of 7".
 */

const DEPLOY_STEP = {
  QUEUED: 'queued',
  GIT: 'git',
  VALIDATE: 'validate',
  INSTALL: 'install',
  BUILD: 'build',
  NGINX: 'nginx',
  LAUNCH: 'launch',
  PROXY: 'proxy',
  DONE: 'done'
};

// Object key insertion order defines the ladder above; consumers that need
// the stable name list go through DeployJobs.STEPS (same reference).
const DEPLOY_STEPS = Object.values(DEPLOY_STEP);

const DEPLOY_KINDS = {
  START: 'start',
  PULL: 'pull'
};

module.exports = { DEPLOY_STEPS, DEPLOY_STEP, DEPLOY_KINDS };
