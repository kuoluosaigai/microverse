const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../helpers/setup');

test('app trusts a single reverse-proxy hop', () => {
  const app = createApp();
  // trust proxy === 1 -> req.ip/protocol honor exactly one X-Forwarded-* layer
  assert.equal(app.get('trust proxy'), 1);
});
