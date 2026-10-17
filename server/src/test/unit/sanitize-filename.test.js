const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeFilename } = require('../../utils/sanitize-filename');

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

// Regression: the cap used to shrink the base while keeping the extension, so a
// name whose EXTENSION alone fills the component ("a." + 300 chars -> extname()
// returns 301 bytes) produced the condition `byteLength(base) > -46`, which can
// never become false — the request handler spun forever and the whole worker
// stopped serving. Every case below must return, in bounded time.
test('over-long names terminate, whatever shape the overflow has', () => {
  const inputs = [
    'a.'.concat('x'.repeat(300)),          // extension alone exceeds the cap
    'x'.repeat(200).concat('.' + 'y'.repeat(120)), // both halves oversized
    '.html'.repeat(70),                     // 350 chars, no room for a base
    '.'.repeat(300),                        // dots only -> stripped -> fallback
    '报'.repeat(400),                        // multibyte, no extension
    'a'.repeat(255).concat('💾'.repeat(50)),  // surrogate pairs at the cut
    'con' + 'f'.repeat(300) + '.html',      // device stem + overflow
  ];
  for (const input of inputs) {
    const out = sanitizeFilename(input); // would hang (test timeout) if it regresses
    assert.ok(out.length > 0, `${input.slice(0, 8)}… must not produce an empty name`);
    assert.ok(Buffer.byteLength(out, 'utf8') <= 260, `capped near 255 bytes: got ${Buffer.byteLength(out)}`);
    assert.ok(!out.includes('/') && !out.includes('\\'), 'no separators');
    // No code point may be cut in half: every surrogate must have its partner.
    assert.ok(
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|[\uDC00-\uDFFF](?![\uD800-\uDBFF])/u.test(out),
      `no split code point: ${JSON.stringify(out.slice(-4))}`
    );
  }
});

test('device prefix is applied after the cap and cannot push past the limit', () => {
  const out = sanitizeFilename('con' + '.' + 'x'.repeat(250));
  assert.ok(out.startsWith('_'), `device name must be prefixed: ${out}`);
  assert.ok(Buffer.byteLength(out, 'utf8') <= 256);
});

// --- uniqueInRequest: same-request collision slots ---------------------------
const { uniqueInRequest, MAX_NAME_BYTES } = require('../../utils/sanitize-filename');

test('uniqueInRequest: free name passes, collisions get (1), (2), ...', () => {
  const reserved = new Set();
  assert.equal(uniqueInRequest(reserved, 'index.html'), 'index.html');
  reserved.add('index.html');
  assert.equal(uniqueInRequest(reserved, 'index.html'), 'index (1).html');
  reserved.add('index (1).html');
  assert.equal(uniqueInRequest(reserved, 'index.html'), 'index (2).html');
  // Extension-less names work too.
  reserved.add('README');
  assert.equal(uniqueInRequest(reserved, 'README'), 'README (1)');
  // A missing/undefined reserved set behaves like "no collisions".
  assert.equal(uniqueInRequest(undefined, 'a.txt'), 'a.txt');
});

test('uniqueInRequest: counter is never truncated away, even for max-length names', () => {
  const reserved = new Set();
  const long = 'x'.repeat(300) + '.html'; // sanitize would cap this; feed the capped form
  const capped = 'x'.repeat(MAX_NAME_BYTES - 5) + '.html';
  reserved.add(capped);
  const out = uniqueInRequest(reserved, capped);
  assert.notEqual(out, capped);
  assert.ok(out.endsWith(' (1).html'), `counter must survive at the end: ${out}`);
  assert.ok(Buffer.byteLength(out, 'utf8') <= MAX_NAME_BYTES, 'stays within the byte cap');
  assert.ok(long.length > MAX_NAME_BYTES); // sanity: the input really was over-long
});

test('uniqueInRequest terminates when the extension alone eats the budget', () => {
  const reserved = new Set();
  const weird = 'a.' + 'x'.repeat(300); // extname = 301 bytes -> extension dropped
  reserved.add(weird);
  const out = uniqueInRequest(reserved, weird); // would spin forever if it regressed
  assert.notEqual(out, weird);
  assert.ok(Buffer.byteLength(out, 'utf8') <= MAX_NAME_BYTES);
});
