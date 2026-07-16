const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { createApp, init } = require('../helpers/setup');

before(async () => { await init(); });

test('api limiter exempts SSE (skip) — reaches handler (404), not 429', async () => {
  const agent = supertest.agent(createApp());
  await agent.post('/api/auth/login')
    .send({ username: 'admin', password: 'test-pass' })
    .expect(200);
  // Exhaust the API limiter (a normal route would now 429).
  for (let i = 0; i < 101; i++) {
    await agent.get('/api/apps');
  }
  // /logs/stream is skipped by apiLimiter → passes to the handler → 404 on a missing app.
  const streamRes = await agent.get('/api/apps/999999/logs/stream');
  assert.equal(streamRes.status, 404);
});
