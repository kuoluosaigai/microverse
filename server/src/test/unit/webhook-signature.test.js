const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyWebhookSignature } = require('../../utils/webhook-signature');

const SECRET = 'secret';
const BODY = Buffer.from(JSON.stringify({ ref: 'refs/heads/main' }), 'utf8');

function sign(body, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

test('accepts a correctly signed body', () => {
  assert.equal(verifyWebhookSignature(BODY, SECRET, sign(BODY)), true);
});

test('accepts a string raw body signed over its utf8 bytes', () => {
  const text = BODY.toString('utf8');
  assert.equal(verifyWebhookSignature(text, SECRET, sign(Buffer.from(text, 'utf8'))), true);
});

test('rejects a wrong signature', () => {
  const wrong = 'sha256=' + '0'.repeat(64);
  assert.equal(verifyWebhookSignature(BODY, SECRET, wrong), false);
});

test('rejects a missing header', () => {
  assert.equal(verifyWebhookSignature(BODY, SECRET, undefined), false);
  assert.equal(verifyWebhookSignature(BODY, SECRET, ''), false);
});

test('rejects a wrong prefix', () => {
  const valid = sign(BODY);
  assert.equal(verifyWebhookSignature(BODY, SECRET, valid.replace('sha256=', 'sha1=')), false);
  assert.equal(verifyWebhookSignature(BODY, SECRET, valid.slice('sha256='.length)), false);
});

test('rejects a different body', () => {
  assert.equal(verifyWebhookSignature(Buffer.from('other'), SECRET, sign(BODY)), false);
});

test('rejects malformed hex and wrong secret', () => {
  assert.equal(verifyWebhookSignature(BODY, SECRET, 'sha256=zzzz'), false);
  assert.equal(verifyWebhookSignature(BODY, SECRET, 'sha256=abc'), false);
  assert.equal(verifyWebhookSignature(BODY, 'other-secret', sign(BODY)), false);
});
