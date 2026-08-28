const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { flattenTopDirs } = require('../../utils/flatten-zip-root');

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
    const flattened = flattenTopDirs(dir);
    assert.equal(flattened, 'mysite');
    assert.ok(fs.existsSync(path.join(dir, 'index.html')), 'index.html hoisted');
    assert.ok(fs.existsSync(path.join(dir, 'css', 'x.css')), 'nested dir hoisted');
    assert.ok(!fs.existsSync(wrapper), 'wrapper removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('flattens multiple nested wrapper levels (e.g. GitHub zip -> repo-main/dist)', () => {
  const dir = makeDir();
  const wrapper = path.join(dir, 'repo-main');
  fs.mkdirSync(path.join(wrapper, 'dist', 'css'), { recursive: true });
  fs.writeFileSync(path.join(wrapper, 'dist', 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(wrapper, 'dist', 'css', 'x.css'), 'body{}');
  try {
    const flattened = flattenTopDirs(dir);
    assert.equal(flattened, 'repo-main/dist');
    assert.ok(fs.existsSync(path.join(dir, 'index.html')), 'index.html hoisted to root');
    assert.ok(fs.existsSync(path.join(dir, 'css', 'x.css')), 'nested dir hoisted to root');
    assert.ok(!fs.existsSync(wrapper), 'outer wrapper removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stops at the first ambiguous level (multiple entries)', () => {
  const dir = makeDir();
  const wrapper = path.join(dir, 'repo-main');
  fs.mkdirSync(path.join(wrapper, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(wrapper, 'dist', 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(wrapper, 'README.md'), 'x');
  try {
    const flattened = flattenTopDirs(dir);
    assert.equal(flattened, 'repo-main');
    // Only the outer wrapper is stripped; dist/ + README.md are ambiguous.
    assert.ok(fs.existsSync(path.join(dir, 'README.md')), 'README.md hoisted');
    assert.ok(fs.existsSync(path.join(dir, 'dist', 'index.html')), 'dist/ left in place');
    assert.ok(!fs.existsSync(wrapper), 'outer wrapper removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no-op (null) when multiple top-level entries', () => {
  const dir = makeDir();
  fs.mkdirSync(path.join(dir, 'a'));
  fs.mkdirSync(path.join(dir, 'b'));
  try {
    assert.equal(flattenTopDirs(dir), null);
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
    assert.equal(flattenTopDirs(dir), null);
    assert.ok(fs.existsSync(path.join(dir, 'index.html')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no-op (null) when directory does not exist', () => {
  assert.equal(flattenTopDirs(path.join(os.tmpdir(), 'flatten-nonexistent-xyz')), null);
});

test('flattens the wrapper while ignoring platform entries (node_modules)', () => {
  const dir = makeDir();
  const wrapper = path.join(dir, 'repo-main');
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(wrapper, 'src'), { recursive: true });
  fs.writeFileSync(path.join(wrapper, 'package.json'), '{}');
  fs.writeFileSync(path.join(wrapper, 'src', 'index.js'), 'x');
  try {
    const flattened = flattenTopDirs(dir, new Set(['node_modules']));
    assert.equal(flattened, 'repo-main');
    assert.ok(fs.existsSync(path.join(dir, 'package.json')), 'package.json hoisted to root');
    assert.ok(fs.existsSync(path.join(dir, 'node_modules')), 'node_modules preserved');
    assert.ok(!fs.existsSync(wrapper), 'wrapper removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no-op when multiple non-ignored top-level entries remain', () => {
  const dir = makeDir();
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.mkdirSync(path.join(dir, 'a'));
  fs.mkdirSync(path.join(dir, 'b'));
  try {
    assert.equal(flattenTopDirs(dir, new Set(['node_modules'])), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
