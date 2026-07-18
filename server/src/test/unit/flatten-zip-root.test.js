const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { flattenSingleTopDir } = require('../../utils/flatten-zip-root');

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flatten-'));
}

test('flattens a single top-level directory and returns its name', () => {
  const dir = makeDir();
  const wrapper = path.join(dir, 'mysite');
  fs.mkdirSync(path.join(wrapper, 'css'), { recursive: true });
  fs.writeFileSync(path.join(wrapper, 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(wrapper, 'css', 'x.css'), 'body{}');
  try {
    const flattened = flattenSingleTopDir(dir);
    assert.equal(flattened, 'mysite');
    assert.ok(fs.existsSync(path.join(dir, 'index.html')), 'index.html hoisted');
    assert.ok(fs.existsSync(path.join(dir, 'css', 'x.css')), 'nested dir hoisted');
    assert.ok(!fs.existsSync(wrapper), 'wrapper removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no-op (null) when multiple top-level entries', () => {
  const dir = makeDir();
  fs.mkdirSync(path.join(dir, 'a'));
  fs.mkdirSync(path.join(dir, 'b'));
  try {
    assert.equal(flattenSingleTopDir(dir), null);
    assert.ok(fs.existsSync(path.join(dir, 'a')));
    assert.ok(fs.existsSync(path.join(dir, 'b')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no-op (null) when the single entry is a file', () => {
  const dir = makeDir();
  fs.writeFileSync(path.join(dir, 'index.html'), 'x');
  try {
    assert.equal(flattenSingleTopDir(dir), null);
    assert.ok(fs.existsSync(path.join(dir, 'index.html')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no-op (null) when directory does not exist', () => {
  assert.equal(flattenSingleTopDir(path.join(os.tmpdir(), 'flatten-nonexistent-xyz')), null);
});
