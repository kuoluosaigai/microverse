const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { adminAgent, queries } = require('../helpers/setup');
const AppManager = require('../../services/app-manager');

test('DELETE /api/apps/:id?deleteFiles=true removes the app directory', async () => {
  const agent = await adminAgent();
  const app = await AppManager.createApp('route-del-files-yes', 'http-server');
  fs.writeFileSync(path.join(app.path, 'index.html'), '<h1>x</h1>');

  const res = await agent.delete(`/api/apps/${app.id}?deleteFiles=true`).expect(200);

  assert.equal(res.body.success, true);
  assert.equal(res.body.data.message, 'App deleted successfully');
  assert.equal(res.body.data.filesDeleted, true);
  assert.equal(fs.existsSync(app.path), false);
});

test('DELETE /api/apps/:id keeps the app directory by default', async () => {
  const agent = await adminAgent();
  const app = await AppManager.createApp('route-del-files-no', 'http-server');
  fs.writeFileSync(path.join(app.path, 'index.html'), '<h1>x</h1>');

  const res = await agent.delete(`/api/apps/${app.id}`).expect(200);

  assert.equal(res.body.data.filesDeleted, false);
  assert.equal(fs.existsSync(app.path), true);

  fs.rmSync(app.path, { recursive: true, force: true });
});

test('DELETE /api/apps/:id?deleteFiles=true returns 400 for a path outside APPS_DIR', async () => {
  const agent = await adminAgent();
  const app = await AppManager.createApp('route-del-files-outside', 'http-server');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-route-outside-'));
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  await queries.updateApp({ id: app.id, path: outside });

  const res = await agent.delete(`/api/apps/${app.id}?deleteFiles=true`).expect(400);

  assert.equal(res.body.success, false);
  assert.match(res.body.error.message, /outside APPS_DIR/);
  assert.equal(fs.existsSync(path.join(outside, 'keep.txt')), true);
  assert.ok(await queries.getAppById(app.id), 'DB row survives the refusal');

  fs.rmSync(outside, { recursive: true, force: true });
  fs.rmSync(app.path, { recursive: true, force: true });
  await queries.deleteApp(app.id);
});
