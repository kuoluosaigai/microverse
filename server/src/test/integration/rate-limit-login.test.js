const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { createApp, init } = require('../helpers/setup');

before(async () => { await init(); });

test('login limiter: 6th attempt within window -> 429', async () => {
  const agent = supertest.agent(createApp());
  for (let i = 0; i < 5; i++) {
    await agent.post('/api/auth/login')
      .send({ username: 'admin', password: 'test-pass' })
      .expect(200);
  }
  const blocked = await agent.post('/api/auth/login')
    .send({ username: 'admin', password: 'test-pass' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.success, false);
});
