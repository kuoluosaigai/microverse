const { test } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');

// A stable SESSION_SECRET must be in place BEFORE the helper (and therefore
// config) is required. createApp() derives the signing secret from
// config.auth.sessionSecret; in a multi-worker (PM2 cluster) deployment every
// worker must share the same secret, or each worker signs/verifies with a
// different random key and rejects the others' cookies -> intermittent 401.
// Tests run without SESSION_SECRET, so pin it here before anything loads config.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'cross-instance-test-secret';

const { createApp, init } = require('../helpers/setup');

// Simulates the production failure: PM2 cluster runs multiple workers, each its
// own process. With an in-memory session store, a session created by worker A is
// invisible to worker B -> intermittent 401 "Authentication required". A shared
// persistent store (sqlite) must make the session visible across instances.
test('session is shared across app instances (multi-worker simulation)', async () => {
  await init();
  const appA = createApp();
  const appB = createApp(); // separate instance; both share the module-level sqlite store

  // Log in against appA and capture the session cookie.
  const loginRes = await supertest(appA)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'test-pass' })
    .expect(200);
  const cookie = loginRes.headers['set-cookie'][0].split(';')[0]; // connect.sid=...

  // Hit appB with that cookie. Under the old MemoryStore appB had its own memory
  // and returned 401; with the shared sqlite store it resolves the session -> 200.
  const meRes = await supertest(appB).get('/api/auth/me').set('Cookie', cookie);
  assert.equal(meRes.status, 200);
  assert.equal(meRes.body.data.user.username, 'admin');
});
