const { test, mock, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { queries, dbReady } = require('../helpers/setup');
const AppManager = require('../../services/app-manager');
const ProcessManager = require('../../services/process-manager');
const ProxyManager = require('../../services/proxy-manager');

before(async () => {
  await dbReady;
  // Real PM2 is already stubbed in helpers/setup; mock the service entry the
  // deletion path calls directly, plus the edge-proxy reload.
  mock.method(ProcessManager, 'deleteProcess', async () => ({ success: true }));
  mock.method(ProxyManager, 'regenerate', async () => ({ ok: true }));
});

test('deleteFiles=true removes the app directory', async () => {
  const app = await AppManager.createApp('del-files-yes', 'http-server');
  fs.writeFileSync(path.join(app.path, 'index.html'), '<h1>x</h1>');
  await AppManager.deleteApp(app.id, { deleteFiles: true });
  assert.equal(fs.existsSync(app.path), false);
});

test('deleteFiles=false keeps the app directory', async () => {
  const app = await AppManager.createApp('del-files-no', 'http-server');
  fs.writeFileSync(path.join(app.path, 'index.html'), '<h1>x</h1>');
  await AppManager.deleteApp(app.id);
  assert.equal(fs.existsSync(app.path), true);
  fs.rmSync(app.path, { recursive: true, force: true });
});

test('refuses to delete a directory outside APPS_DIR', async () => {
  const app = await AppManager.createApp('del-files-outside', 'http-server');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-outside-'));
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  await queries.updateApp({ id: app.id, path: outside });
  await assert.rejects(
    () => AppManager.deleteApp(app.id, { deleteFiles: true }),
    /outside APPS_DIR/
  );
  assert.equal(fs.existsSync(path.join(outside, 'keep.txt')), true);
  assert.ok(await queries.getAppById(app.id), 'DB row survives the refusal');
  fs.rmSync(outside, { recursive: true, force: true });
  fs.rmSync(app.path, { recursive: true, force: true });
  await queries.deleteApp(app.id);
});

test('refuses to delete a running app', async () => {
  const app = await AppManager.createApp('del-files-running', 'http-server');
  await queries.updateAppStatus('running', app.id);
  await assert.rejects(
    () => AppManager.deleteApp(app.id, { deleteFiles: true }),
    /Cannot delete running app/
  );
  assert.equal(fs.existsSync(app.path), true);
  fs.rmSync(app.path, { recursive: true, force: true });
  await queries.deleteApp(app.id);
});
