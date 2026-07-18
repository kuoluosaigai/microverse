const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request } = require('../helpers/setup');

test('GET /api/health returns ok', async () => {
  const res = await request().get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.status, 'ok');
});

test('GET /api/config exposes upload limits', async () => {
  const res = await request().get('/api/config');
  assert.equal(res.status, 200);
  assert.ok(res.body.data.upload.maxFileSize > 0);
  assert.ok(res.body.data.upload.maxFiles > 0);
});

test('GET /api/config exposes appPublicUrlTemplate field', async () => {
  const res = await request().get('/api/config');
  assert.equal(res.status, 200);
  assert.ok('appPublicUrlTemplate' in res.body.data, 'appPublicUrlTemplate present');
  // unset in tests -> null
  assert.equal(res.body.data.appPublicUrlTemplate, null);
});

test('GET / returns server info JSON (non-production)', async () => {
  const res = await request().get('/');
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Microverse Server');
  assert.equal(res.body.status, 'running');
});
