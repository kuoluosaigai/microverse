const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ProcessManager = require('../../services/process-manager');

test('resolves a workspace-hoisted dep via the repo-root node_modules even when cwd has none', () => {
  // Regression: the old lookup only checked process.cwd()/node_modules, so a
  // server started from server/ missed deps npm hoisted to the repo root.
  const prevCwd = process.cwd();
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'no-node-modules-'));
  try {
    process.chdir(foreign); // cwd without any node_modules
    const p = ProcessManager.resolveCliModule('express/package.json');
    assert.ok(p, 'expected express to resolve from the repo-root candidate');
    assert.ok(fs.existsSync(p));
    assert.ok(path.isAbsolute(p));
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(foreign, { recursive: true, force: true });
  }
});

test('falls back to the cached npm global root when static candidates miss', () => {
  // Simulate `npm root -g` having already been probed (cache primed) and the
  // package living ONLY under that custom prefix (nvm/fnm layout).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-global-root-'));
  const entry = path.join(dir, 'fake-cli', 'bin', 'cli.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '// fake');
  ProcessManager._npmGlobalRoot = dir;
  try {
    const p = ProcessManager.resolveCliModule('fake-cli/bin/cli.js');
    assert.equal(p, entry);
  } finally {
    delete ProcessManager._npmGlobalRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown modules resolve to null (callers keep their bare-command fallback)', () => {
  assert.equal(ProcessManager.resolveCliModule('microverse-definitely-not-installed/pkg.js'), null);
});

test('getNpmCliPath returns an existing absolute JS entry when npm is resolvable', () => {
  const p = ProcessManager.getNpmCliPath();
  if (p !== 'npm') {
    assert.ok(path.isAbsolute(p), `expected absolute path or bare fallback, got ${p}`);
    assert.ok(fs.existsSync(p));
  }
});
