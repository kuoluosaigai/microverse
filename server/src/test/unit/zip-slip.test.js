const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { isSafeEntry } = require('../../utils/validate-zip');

const root = path.resolve(__dirname, 'sample-app');

test('entry inside root is safe', () => {
  assert.equal(isSafeEntry(root, 'index.html'), true);
  assert.equal(isSafeEntry(root, 'sub/dir/a.js'), true);
});

test('entry resolving exactly to root is safe', () => {
  assert.equal(isSafeEntry(root, '.'), true);
});

test('zip-slip traversal is unsafe', () => {
  assert.equal(isSafeEntry(root, '../secret'), false);
  assert.equal(isSafeEntry(root, '../../etc/passwd'), false);
  assert.equal(isSafeEntry(root, 'sub/../../../etc/passwd'), false);
});

test('sibling with shared prefix is unsafe', () => {
  assert.equal(isSafeEntry(root, '../sample-app-evil/x'), false);
});
