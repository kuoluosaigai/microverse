const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { adminAgent, queries, dbReady } = require('../helpers/setup');

let agent;
before(async () => { await dbReady; agent = await adminAgent(); });

test('POST /api/apps creates an app', async () => {
  const res = await agent.post('/api/apps').send({ name: 'crud-app', deploy_type: 'http-server' });
  assert.equal(res.status, 201);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.name, 'crud-app');
  assert.equal(res.body.data.status, 'stopped');
});

test('POST /api/apps rejects missing fields', async () => {
  const res = await agent.post('/api/apps').send({ name: 'no-type' });
  assert.equal(res.status, 400);
});

test('POST /api/apps rejects duplicate name', async () => {
  await agent.post('/api/apps').send({ name: 'dup-app', deploy_type: 'http-server' });
  const res = await agent.post('/api/apps').send({ name: 'dup-app', deploy_type: 'http-server' });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /already exists/);
});

test('GET /api/apps lists apps', async () => {
  const res = await agent.get('/api/apps');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data));
  assert.ok(res.body.data.some(a => a.name === 'crud-app'));
});

test('GET /api/apps/:id 404 for missing', async () => {
  const res = await agent.get('/api/apps/999999');
  assert.equal(res.status, 404);
});

test('DELETE /api/apps/:id 404 for missing', async () => {
  const res = await agent.delete('/api/apps/999999');
  assert.equal(res.status, 404);
});

test('DELETE /api/apps/:id rejects a running app (no PM2 needed)', async () => {
  const created = await agent.post('/api/apps').send({ name: 'running-app', deploy_type: 'http-server' });
  // NOTE: setup.queries.updateAppStatus signature is (status, id) — status first.
  await queries.updateAppStatus('running', created.body.data.id);
  const res = await agent.delete(`/api/apps/${created.body.data.id}`);
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /Cannot delete running app/);
  // cleanup
  await queries.updateAppStatus('stopped', created.body.data.id);
  await agent.delete(`/api/apps/${created.body.data.id}`).expect(200);
});
