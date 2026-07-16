const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateManifest } = require('../../utils/validate-manifest');

test('valid manifest returns null', () => {
  assert.equal(validateManifest({ name: 'my-app', deploy_type: 'http-server' }), null);
  assert.equal(validateManifest({ name: 'a_b-1', deploy_type: 'npm' }), null);
});

test('missing/invalid name is rejected', () => {
  assert.match(validateManifest({ deploy_type: 'npm' }), /Invalid app name/);
  assert.match(validateManifest({ name: 'bad name!', deploy_type: 'npm' }), /Invalid app name/);
  assert.match(validateManifest({ name: 'a/b', deploy_type: 'npm' }), /Invalid app name/);
});

test('invalid deploy_type is rejected', () => {
  assert.match(validateManifest({ name: 'ok', deploy_type: 'docker' }), /Invalid deploy_type/);
  assert.match(validateManifest({ name: 'ok' }), /Invalid deploy_type/);
});
