const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isValidAppName } = require('../../utils/validate-app-name');

test('accepts valid names', () => {
  assert.equal(isValidAppName('my-app'), true);
  assert.equal(isValidAppName('app_1'), true);
  assert.equal(isValidAppName('A'), true);
  assert.equal(isValidAppName('a'.repeat(64)), true); // boundary: exactly 64
});

test('rejects empty / non-string', () => {
  assert.equal(isValidAppName(''), false);
  assert.equal(isValidAppName(null), false);
  assert.equal(isValidAppName(undefined), false);
  assert.equal(isValidAppName(42), false);
});

test('rejects path-traversal / injection / disallowed chars', () => {
  assert.equal(isValidAppName('../pwn'), false);
  assert.equal(isValidAppName('a b'), false);
  assert.equal(isValidAppName('a;b'), false);
  assert.equal(isValidAppName('a.b'), false);
  assert.equal(isValidAppName('a/b'), false);
});

test('rejects over-long names', () => {
  assert.equal(isValidAppName('a'.repeat(65)), false); // boundary: 65
});
