const { test } = require('node:test');
const assert = require('node:assert/strict');
const { staleFilesToRemove } = require('../../utils/stale-files');

test('removes stale user files while keeping platform + incoming names', () => {
  const app = { name: 'blog' };
  const before = [
    'index.html',
    'old.html',
    'node_modules',
    'nginx.blog.conf',
    'nginx.pid',
    'nginx-access.log',
    'nginx-error.log',
  ];
  const incoming = ['site.zip'];
  assert.deepEqual(staleFilesToRemove(app, before, incoming), ['index.html', 'old.html']);
});

test('keeps an incoming name even if it matches a pre-existing entry', () => {
  const app = { name: 'blog' };
  assert.deepEqual(staleFilesToRemove(app, ['index.html'], ['index.html']), []);
});

test('empty before list yields no removals', () => {
  const app = { name: 'blog' };
  assert.deepEqual(staleFilesToRemove(app, [], ['site.zip']), []);
});
