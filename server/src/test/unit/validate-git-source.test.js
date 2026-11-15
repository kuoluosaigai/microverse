const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateGitUrl,
  normalizeGitUrl,
  validateGitBranch
} = require('../../utils/validate-git-source');

test('accepts public https repository URLs', () => {
  assert.equal(validateGitUrl('https://github.com/foXerw/personal-blog'), null);
  assert.equal(validateGitUrl('https://github.com/foXerw/personal-blog.git'), null);
  assert.equal(validateGitUrl('https://git.example.com:8443/a/b.git'), null);
});

test('rejects non-https transports', () => {
  assert.match(validateGitUrl('http://github.com/a/b'), /https/);
  assert.match(validateGitUrl('git@github.com:a/b.git'), /https/);
  assert.match(validateGitUrl('file:///tmp/repo'), /https/);
});

test('rejects option-injection and control characters', () => {
  assert.match(validateGitUrl('--upload-pack=evil'), /https/);
  assert.match(validateGitUrl('https://github.com/a/b\nrm -rf /'), /invalid/i);
  assert.match(validateGitUrl('https://github.com/a b'), /invalid/i);
  assert.match(validateGitUrl(''), /https/);
  assert.match(validateGitUrl(null), /https/);
  assert.match(validateGitUrl(undefined), /https/);
  assert.match(validateGitUrl(42), /https/);
});

test('file URLs are opt-in (tests only)', () => {
  assert.equal(validateGitUrl('file:///tmp/repo', { allowFile: true }), null);
  assert.match(validateGitUrl('file:///tmp/re po', { allowFile: true }), /invalid/i);
});

test('branch names: valid', () => {
  assert.equal(validateGitBranch('main'), null);
  assert.equal(validateGitBranch('release/1.2'), null);
  assert.equal(validateGitBranch('feature_x-1'), null);
});

test('branch names: invalid', () => {
  assert.match(validateGitBranch('-x'), /invalid/i);
  assert.match(validateGitBranch('/main'), /invalid/i);
  assert.match(validateGitBranch('a..b'), /invalid/i);
  assert.match(validateGitBranch('a b'), /invalid/i);
  assert.match(validateGitBranch(''), /invalid/i);
  assert.match(validateGitBranch(null), /invalid/i);
  assert.match(validateGitBranch('a'.repeat(201)), /invalid/i);
});

test('normalizeGitUrl lowercases, strips trailing slash and .git', () => {
  assert.equal(
    normalizeGitUrl('https://GitHub.com/FoXerw/Personal-Blog.git/'),
    'https://github.com/foxerw/personal-blog'
  );
  assert.equal(
    normalizeGitUrl('  https://github.com/A/B/  '),
    'https://github.com/a/b'
  );
});
