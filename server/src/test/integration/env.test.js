const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { adminAgent, dbReady } = require('../helpers/setup');

let agent, appId;
before(async () => {
  await dbReady;
  agent = await adminAgent();
  const res = await agent.post('/api/apps').send({ name: 'env-app', deploy_type: 'npm' });
  appId = res.body.data.id;
});

test('PUT then GET env round-trips', async () => {
  const put = await agent.put(`/api/apps/${appId}/env`).send({
    env: [{ key: 'API_KEY', value: 'sekret' }, { key: 'PORT_OFFSET', value: '1' }]
  });
  assert.equal(put.status, 200);
  const get = await agent.get(`/api/apps/${appId}/env`);
  assert.equal(get.status, 200);
  const keys = get.body.data.map(e => e.key).sort();
  assert.deepEqual(keys, ['API_KEY', 'PORT_OFFSET']);
});

test('PUT env rejects invalid key', async () => {
  const res = await agent.put(`/api/apps/${appId}/env`).send({ env: [{ key: '1bad' }] });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /Invalid env key/);
});

test('PUT env rejects duplicate key', async () => {
  const res = await agent.put(`/api/apps/${appId}/env`).send({
    env: [{ key: 'DUP' }, { key: 'DUP' }]
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /Duplicate env key/);
});

test('GET env 404 for missing app', async () => {
  const res = await agent.get('/api/apps/999999/env');
  assert.equal(res.status, 404);
});
