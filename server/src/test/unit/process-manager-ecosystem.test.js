const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ProcessManager = require('../../services/process-manager');

test('ecosystem config uses .cjs so it loads under an ESM ("type":"module") app', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecosystem-'));
  // Simulate a modern static app (Vite/ESM) whose package.json opts into ESM.
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));

  const appsEntry = { name: 'blog', script: 'http-server', args: '. -p 3000', cwd: dir, interpreter: 'node' };
  try {
    const configPath = ProcessManager.writeEcosystemConfig(dir, 'blog', appsEntry);

    assert.equal(path.basename(configPath), 'pm2.blog.config.cjs');
    assert.ok(!fs.existsSync(path.join(dir, 'pm2.blog.config.js')), 'no .js variant left behind');

    // The regression: requiring a .js file in this dir would throw
    // "module is not defined in ES module scope". A .cjs file must load fine.
    const loaded = require(configPath);
    assert.deepEqual(loaded, { apps: [appsEntry] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
