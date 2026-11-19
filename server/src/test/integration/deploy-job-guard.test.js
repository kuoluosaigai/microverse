const { test, mock, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { adminAgent, queries, dbReady } = require('../helpers/setup');
const { dbRun } = require('../../db');
const AppManager = require('../../services/app-manager');
const DeployJobs = require('../../services/deploy-jobs');

// Task 7 contract: while an app's deploy job is LIVE, every write endpoint
// aimed at that app refuses with 409 + assertIdle's fixed message naming
// kind and step. Read endpoints and POST /sync stay open (sync only writes
// PM2 truth into the status column; it cannot corrupt a running job). The
// refusal is liveness-based — terminal (finish), stale, or dead-owner jobs
// must NOT keep holding the guard.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'microverse-job-guard-'));

before(async () => { await dbReady; });
afterEach(() => mock.reset());
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

async function makeApp(name, { withGit = false } = {}) {
  const app = await AppManager.createApp(name, 'http-server');
  fs.writeFileSync(path.join(app.path, 'index.html'), '<h1>x</h1>');
  if (withGit) {
    await queries.upsertAppGitSource({
      appId: app.id,
      url: 'https://example.com/guard.git',
      branch: 'main',
      webhookSecret: 'a'.repeat(64)
    });
  }
  return AppManager.getAppById(app.id);
}

// Keep claim()'s log files out of the repo's real data/ dir and make the
// self-update gate deterministic (same seams as deploy-async-start.test.js).
function stubClaimEnvironment() {
  mock.method(DeployJobs, 'logDir', () => tmp);
  mock.method(DeployJobs, 'isUpdateRunning', () => false);
}

// Live jobs are created through the real DeployJobs.claim — never by
// hand-inserting rows. A fake row would keep these tests green even if the
// claim() shape (status/step/pid/started_at) drifted out from under the
// guard; a real claim ties the route tests to the exact row a live deploy
// actually leaves behind.
async function liveJob(app) {
  stubClaimEnvironment();
  const claim = await DeployJobs.claim(app, DeployJobs.KINDS.START);
  assert.equal(claim.ok, true, `claim failed: ${JSON.stringify(claim)}`);
  return claim.job;
}

// Every guarded mutation from the Task 7 table, driven through the real
// routes. `withGit` cases pre-bind a source so the handlers get past their
// own preconditions and the 409 can only come from the deploy guard.
const MUTATIONS = [
  { label: 'stop', call: (agent, app) => agent.post(`/api/apps/${app.id}/stop`) },
  { label: 'restart', call: (agent, app) => agent.post(`/api/apps/${app.id}/restart`) },
  { label: 'delete', call: (agent, app) => agent.delete(`/api/apps/${app.id}`) },
  {
    label: 'upload',
    call: (agent, app) => agent
      .post(`/api/apps/${app.id}/upload`)
      .attach('files', Buffer.from('<h1>late upload</h1>'), 'index.html')
  },
  {
    label: 'put-env',
    call: (agent, app) => agent
      .put(`/api/apps/${app.id}/env`)
      .send({ env: [{ key: 'GUARDED', value: '1' }] })
  },
  { label: 'put-default', call: (agent, app) => agent.put(`/api/apps/${app.id}/default`) },
  { label: 'delete-default', call: (agent, app) => agent.delete(`/api/apps/${app.id}/default`) },
  {
    label: 'git-put-bind',
    call: (agent, app) => agent
      .put(`/api/apps/${app.id}/git`)
      .send({ url: 'https://example.com/rebind.git' })
  },
  {
    label: 'git-unbind',
    withGit: true,
    call: (agent, app) => agent.delete(`/api/apps/${app.id}/git`)
  },
  {
    label: 'git-rotate-secret',
    withGit: true,
    call: (agent, app) => agent.post(`/api/apps/${app.id}/git/secret`)
  }
];

// node:test has no test.each — the loop emits one test per mutation with
// the pinned title, so each guard fails (and gets deleted) independently.
for (const m of MUTATIONS) {
  test(`${m.label} on an app with a live deploy job returns 409 naming the step`, async () => {
    const app = await makeApp(`guard-${m.label}`, { withGit: !!m.withGit });
    await liveJob(app);

    const agent = await adminAgent();
    const res = await m.call(agent, app);

    assert.equal(res.status, 409, `${m.label} returned ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.success, false);
    // assertIdle's fixed message shape (Task 11 i18n keys off it). A job
    // fresh from claim() names kind 'start' and step 'queued'.
    assert.match(res.body.error.message, /^部署进行中（start · queued），请等待完成后再/);
  });
}

test('read endpoints keep working during a live job', async () => {
  const app = await makeApp('guard-reads', { withGit: true });
  await liveJob(app);

  const agent = await adminAgent();
  // Watching an app mid-deploy is the operator's main use case for the job
  // row, so every read path must stay open while writes are refused.
  await agent.get('/api/apps').expect(200);
  await agent.get(`/api/apps/${app.id}`).expect(200);
  await agent.get(`/api/apps/${app.id}/files`).expect(200);
  await agent.get(`/api/apps/${app.id}/metrics`).expect(200);
  await agent.get(`/api/apps/${app.id}/env`).expect(200);

  const git = await agent.get(`/api/apps/${app.id}/git`).expect(200);
  assert.equal(git.body.success, true);
});

test('POST /apps/:id/sync is intentionally NOT guarded', async () => {
  // Pinned decision: sync only writes PM2 truth back into the status column
  // — it races nothing and must keep working while a deploy job is live.
  const app = await makeApp('guard-sync');
  await liveJob(app);

  const agent = await adminAgent();
  const res = await agent.post(`/api/apps/${app.id}/sync`).expect(200);
  assert.equal(res.body.success, true);
});

test('the guard lifts as soon as the job finishes', async () => {
  const app = await makeApp('guard-lift');
  await liveJob(app);

  const agent = await adminAgent();
  await agent.post(`/api/apps/${app.id}/stop`).expect(409);

  // Real terminal transition through the service (owner-fenced finish()).
  await DeployJobs.finish(app.id, { ok: true });

  const res = await agent.post(`/api/apps/${app.id}/stop`).expect(200);
  assert.equal(res.body.success, true);
});

test('a dead-pid job does not hold the guard', async () => {
  // Liveness, not status: keying the guard on the status alone would lock a
  // crashed worker's app out of EVERY write for the whole stale window
  // (~40 min). Simulate the crashed owner for real: a genuine claim() row
  // whose pid points at a process that does not exist — the probe itself
  // (process.kill signal 0) reports ESRCH. The ESRCH mock is scoped to
  // signal 0 so every other process.kill behaves exactly as before.
  const app = await makeApp('guard-deadpid');
  const job = await liveJob(app);

  const realKill = process.kill.bind(process);
  mock.method(process, 'kill', (pid, signal) => {
    if (signal === 0) {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    }
    return realKill(pid, signal);
  });
  await dbRun('UPDATE app_deploy_job SET pid = ? WHERE app_id = ?', [424242, app.id]);

  // Sanity: the row still reads as in-flight — only its owner is gone.
  const row = await queries.getDeployJob(app.id);
  assert.equal(row.status, 'running');
  assert.equal(row.pid, 424242);
  assert.ok(job.kind === 'start');

  const agent = await adminAgent();
  await agent.post(`/api/apps/${app.id}/stop`).expect(200);
});
