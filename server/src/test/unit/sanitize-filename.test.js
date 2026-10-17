const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sanitizeFilename, uniqueFilename } = require('../../utils/sanitize-filename');

test('path traversal components are neutralized', () => {
  for (const input of ['../evil.html', '..\\..\\evil.html', '/etc/passwd', 'C:\\Users\\x\\secret.txt', 'a/b/c.zip']) {
    const out = sanitizeFilename(input);
    assert.ok(!out.includes('/') && !out.includes('\\'), `${input} -> ${out} must have no separators`);
    assert.ok(out !== '.' && out !== '..', `${input} -> ${out} must not be a dot name`);
    assert.ok(!out.includes(':'), `${input} -> ${out} must have no drive/ADS colon`);
    assert.ok(out.length > 0);
  }
});

test('NUL bytes and control characters are stripped', () => {
  assert.equal(sanitizeFilename('a\x00b.html'), 'ab.html');
  assert.equal(sanitizeFilename('ev\x01il\x1f.zip'), 'evil.zip');
  assert.equal(sanitizeFilename('bell\x07.txt'), 'bell.txt');
});

test('Windows device names get prefixed, with any extension', () => {
  assert.equal(sanitizeFilename('con.txt'), '_con.txt');
  assert.equal(sanitizeFilename('NUL'), '_NUL');
  assert.equal(sanitizeFilename('com1.log'), '_com1.log');
  assert.equal(sanitizeFilename('LPT9.tar.gz'), '_LPT9.tar.gz');
  assert.equal(sanitizeFilename('console.txt'), 'console.txt'); // not a device name
});

test('trailing dots/spaces are stripped; empty and dot-only collapse to fallback', () => {
  assert.equal(sanitizeFilename('report...   '), 'report');
  assert.equal(sanitizeFilename(''), 'file');
  assert.equal(sanitizeFilename('...'), 'file');
  assert.equal(sanitizeFilename('   '), 'file');
});

test('benign names pass through unchanged', () => {
  for (const n of ['index.html', 'my-app_v2.zip', 'styles.min.css', '报告.zip', 'file (1).txt']) {
    assert.equal(sanitizeFilename(n), n);
  }
});

test('over-long names are byte-capped with the extension preserved', () => {
  const out = sanitizeFilename('a'.repeat(300) + '.html');
  assert.ok(Buffer.byteLength(out, 'utf8') <= 255);
  assert.ok(out.endsWith('.html'));
  const uni = sanitizeFilename('报'.repeat(100) + '.zip'); // multibyte
  assert.ok(Buffer.byteLength(uni, 'utf8') <= 255);
  assert.ok(uni.endsWith('.zip'));
});

test('uniqueFilename never overwrites: (1), (2), ... suffixes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uniq-'));
  try {
    assert.equal(uniqueFilename(dir, 'a.txt'), 'a.txt'); // free name stays
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    assert.equal(uniqueFilename(dir, 'a.txt'), 'a (1).txt');
    fs.writeFileSync(path.join(dir, 'a (1).txt'), 'x');
    assert.equal(uniqueFilename(dir, 'a.txt'), 'a (2).txt');
    fs.writeFileSync(path.join(dir, 'README'), 'x');
    assert.equal(uniqueFilename(dir, 'README'), 'README (1)'); // extension-less
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uniqueFilename honors the in-request reserved set (nothing on disk yet)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uniq-res-'));
  try {
    const reserved = new Set(['index.html']);
    assert.equal(uniqueFilename(dir, 'index.html', reserved), 'index (1).html');
    reserved.add('index (1).html');
    assert.equal(uniqueFilename(dir, 'index.html', reserved), 'index (2).html');
    assert.equal(uniqueFilename(dir, 'other.css', reserved), 'other.css');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
