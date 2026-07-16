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
