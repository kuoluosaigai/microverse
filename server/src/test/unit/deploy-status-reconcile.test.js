const { test, mock, before } = require('node:test');
const assert = require('node:assert/strict');
const { queries, dbReady } = require('../helpers/setup');
const AppManager = require('../../services/app-manager');
const ProcessManager = require('../../services/process-manager');
const DeployManager = require('../../services/deploy-manager');

before(async () => { await dbReady; });

// Helper: app row whose DB status says 'running' while we control what PM2 reports.
async function fakeRunningApp(name) {
  const app = await AppManager.createApp(name, 'http-server');
  await queries.updateAppStatus('running', app.id);
  return app;
}

test('stopApp is an idempotent success when the PM2 process is gone (DB said running)', async () => {
  const app = await fakeRunningApp('drift-stop');
  mock.method(ProcessManager, 'getProcessStatus', async () => ({ exists: false }));
  const stopCalls = [];
  mock.method(ProcessManager, 'stopProcess', async (n) => { stopCalls.push(n); return { success: true }; });
  try {
    const result = await DeployManager.stopApp(app.id);
    assert.equal(result.status, 'stopped'); // DB reconciled to PM2 truth
    assert.equal(stopCalls.length, 0);      // nothing to stop was called
  } finally {
    mock.reset();
    await queries.deleteApp(app.id);
  }
});

test('deleteApp succeeds in one call when the PM2 process is gone (DB said running)', async () => {
  const app = await fakeRunningApp('drift-delete');
  mock.method(ProcessManager, 'getProcessStatus', async () => ({ exists: false }));
  mock.method(ProcessManager, 'deleteProcess', async () => ({ success: true }));
  try {
    const ok = await DeployManager.deleteApp(app.id);
    assert.equal(ok, true);
  } finally {
    mock.reset();
  }
});

test('deleteApp still blocks a genuinely online app', async () => {
  const app = await fakeRunningApp('really-running');
  mock.method(ProcessManager, 'getProcessStatus', async () => ({ exists: true, status: 'online' }));
  try {
    await assert.rejects(
      () => DeployManager.deleteApp(app.id),
      /Cannot delete running app/
    );
  } finally {
    mock.reset();
    await queries.deleteApp(app.id);
  }
});

test('reconcile trusts the DB when PM2 is unreachable (jlist throws)', async () => {
  const app = await fakeRunningApp('pm2-absent');
  mock.method(ProcessManager, 'getProcessStatus', async () => {
    throw new Error('Failed to list PM2 processes: pm2 not recognized');
  });
  try {
    const reconciled = await DeployManager.reconcileStatus(app.id);
    assert.equal(reconciled.status, 'running'); // NOT flipped to stopped
    const row = await queries.getAppById(app.id);
    assert.equal(row.status, 'running');        // and the DB was not touched
  } finally {
    mock.reset();
    await queries.deleteApp(app.id);
  }
});

test('restartApp calls PM2 restart only when the process is actually online', async () => {
  const app = await fakeRunningApp('drift-restart');
  const restartCalls = [];
  mock.method(ProcessManager, 'getProcessStatus', async () => ({ exists: false }));
  mock.method(ProcessManager, 'restartProcess', async (n) => { restartCalls.push(n); return { success: true }; });
  try {
    await assert.rejects(() => DeployManager.restartApp(app.id), /App is not running/);
    assert.equal(restartCalls.length, 0);
  } finally {
    mock.reset();
    await queries.deleteApp(app.id);
  }
});
