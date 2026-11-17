const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// setup points DB_PATH/APPS_DIR at a temp dir BEFORE npm-lifecycle's require
// chain (-> ../db) opens the database — never touch the real dev DB in tests.
require('../helpers/setup');
const NpmLifecycle = require('../../services/npm-lifecycle');

function tmpApp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'npm-fp-'));
}

test('installFingerprint is content-based: same bytes -> same fp, edited -> changed, reverted -> original', () => {
  const dir = tmpApp();
  try {
    const pkg = path.join(dir, 'package.json');
    fs.writeFileSync(pkg, '{"name":"a","version":"1.0.0"}');
    const fp1 = NpmLifecycle.installFingerprint(dir);

    fs.writeFileSync(pkg, '{"name":"a","version":"1.0.1"}');
    const fp2 = NpmLifecycle.installFingerprint(dir);
    assert.notEqual(fp2, fp1);

    fs.writeFileSync(pkg, '{"name":"a","version":"1.0.0"}');
    assert.equal(NpmLifecycle.installFingerprint(dir), fp1); // identical bytes despite new mtime

    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
    assert.notEqual(NpmLifecycle.installFingerprint(dir), fp1); // lockfile joins in
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildFingerprint tracks the app tree but ignores node_modules, .git and platform files', () => {
  const dir = tmpApp();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"a"}');
    fs.writeFileSync(path.join(dir, 'index.js'), 'console.log(1)');
    const fp1 = NpmLifecycle.buildFingerprint(dir);

    // Dependency install must not trigger a rebuild check.
    fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'x');
    assert.equal(NpmLifecycle.buildFingerprint(dir), fp1);

    // Transient platform files (ecosystem config, nginx artifacts) are skipped.
    fs.writeFileSync(path.join(dir, 'pm2.a.config.cjs'), 'module.exports={}');
    fs.writeFileSync(path.join(dir, 'nginx.a.conf'), 'x');
    assert.equal(NpmLifecycle.buildFingerprint(dir), fp1);

    // Git metadata is not app source: a fetch/reset rewrites .git internals on
    // every start, and hashing them made a Git-sourced app rebuild every time.
    fs.mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'FETCH_HEAD'), 'abc123\tnot-for-main\n');
    assert.equal(NpmLifecycle.buildFingerprint(dir), fp1, 'creating .git must not flip the fp');
    fs.writeFileSync(path.join(dir, '.git', 'FETCH_HEAD'), 'def456\tnot-for-main\n');
    fs.writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'main'), 'def456');
    assert.equal(NpmLifecycle.buildFingerprint(dir), fp1, 'rewriting .git must not flip the fp');

    // A source edit flips it.
    fs.writeFileSync(path.join(dir, 'index.js'), 'console.log(2222)');
    const fp2 = NpmLifecycle.buildFingerprint(dir);
    assert.notEqual(fp2, fp1);

    // Pure mtime touch (same size) also flips it — re-uploads can't hide.
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, 'index.js'), t, t);
    assert.notEqual(NpmLifecycle.buildFingerprint(dir), fp2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('needsInstall: a missing dependency tree installs only when deps exist', () => {
  const dir = tmpApp();
  try {
    // Dependency-free: `npm install` legitimately produces no node_modules, so
    // its absence must not re-trigger install on every start.
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"a"}');
    const fp = NpmLifecycle.installFingerprint(dir);
    assert.equal(NpmLifecycle.needsInstall(dir, fp), false);
    assert.equal(NpmLifecycle.needsInstall(dir, null), true); // never ran
    assert.equal(NpmLifecycle.needsInstall(dir, 'stale'), true); // lockfile/definition changed

    // Declared dependencies: node_modules is the proof install completed, so a
    // missing tree (deleted, or an interrupted install) must install again.
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"a","dependencies":{"ms":"^2.0.0"}}');
    const fpDeps = NpmLifecycle.installFingerprint(dir);
    assert.equal(NpmLifecycle.needsInstall(dir, fpDeps), true);
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    assert.equal(NpmLifecycle.needsInstall(dir, fpDeps), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('needsBuild: matches stored fp, rebuilds on change or absence', () => {
  const dir = tmpApp();
  try {
    fs.writeFileSync(path.join(dir, 'index.js'), 'a');
    const fp = NpmLifecycle.buildFingerprint(dir);
    assert.equal(NpmLifecycle.needsBuild(dir, fp), false);
    assert.equal(NpmLifecycle.needsBuild(dir, null), true);
    assert.equal(NpmLifecycle.needsBuild(dir, 'stale'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
