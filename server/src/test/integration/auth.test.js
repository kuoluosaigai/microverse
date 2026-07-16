const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { request, init, adminAgent } = require('../helpers/setup');

before(async () => { await init(); });

test('GET /api/apps without session -> 401', async () => {
  const res = await request().get('/api/apps');
  assert.equal(res.status, 401);
});

test('POST /api/auth/login missing fields -> 400', async () => {
  const res = await request().post('/api/auth/login').send({ username: 'admin' });
  assert.equal(res.status, 400);
});

test('POST /api/auth/login wrong password -> 401', async () => {
  const res = await request().post('/api/auth/login').send({ username: 'admin', password: 'nope' });
  assert.equal(res.status, 401);
  assert.equal(res.body.success, false);
});

test('login -> me -> logout flow', async () => {
  const agent = await adminAgent();
  const me = await agent.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.data.user.username, 'admin');

  const out = await agent.post('/api/auth/logout');
  assert.equal(out.status, 200);

  const meAfter = await agent.get('/api/auth/me');
  assert.equal(meAfter.status, 401);
});
