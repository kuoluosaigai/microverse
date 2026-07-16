const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateEnvEntries } = require('../../utils/validate-env');

test('valid entries return null', () => {
  assert.equal(validateEnvEntries([{ key: 'A' }, { key: 'B_CD', value: '1' }]), null);
  assert.equal(validateEnvEntries([]), null);
});

test('non-array is rejected', () => {
  assert.match(validateEnvEntries('x'), /array/);
  assert.match(validateEnvEntries(undefined), /array/);
});

test('invalid key format is rejected', () => {
  assert.match(validateEnvEntries([{ key: '1bad' }]), /Invalid env key/);
  assert.match(validateEnvEntries([{ key: 'a-b' }]), /Invalid env key/);
  assert.match(validateEnvEntries([{ key: '' }]), /Invalid env key/);
});

test('duplicate key is rejected', () => {
  assert.match(validateEnvEntries([{ key: 'A' }, { key: 'A' }]), /Duplicate env key/);
});
