const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { createApp, init } = require('../helpers/setup');

before(async () => { await init(); });

test('api limiter: 101st request within window -> 429', async () => {
  const agent = supertest.agent(createApp());
  await agent.post('/api/auth/login')
    .send({ username: 'admin', password: 'test-pass' })
    .expect(200);
  for (let i = 0; i < 100; i++) {
    await agent.get('/api/apps').expect(200);
  }
  const blocked = await agent.get('/api/apps');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.success, false);
  assert.match(blocked.body.error.message, /Too many requests/);
});
