const { test, mock, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { queries, dbReady } = require('../helpers/setup');
const AppManager = require('../../services/app-manager');
const DeployManager = require('../../services/deploy-manager');
const NpmLifecycle = require('../../services/npm-lifecycle');
const ProcessManager = require('../../services/process-manager');

before(async () => { await dbReady; });

test('stop->start skips npm install/build; content changes re-trigger exactly the needed step', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-skip-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'skip-app',
    scripts: { start: 'node index.js', build: 'node build.js' },
  }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'console.log(1)');

  const counts = { install: 0, build: 0, start: 0 };
  // Simulated npm install must produce node_modules — needsInstall gates on it.
  mock.method(NpmLifecycle, 'install', async (appPath) => {
    counts.install += 1;
    fs.mkdirSync(path.join(appPath, 'node_modules'), { recursive: true });
  });
  mock.method(NpmLifecycle, 'build', async () => { counts.build += 1; });
  mock.method(ProcessManager, 'startProcess', async () => { counts.start += 1; return { success: true }; });
  // PM2 never actually launches in tests: report "no process" so reconcile
  // flips status to stopped between starts.
  mock.method(ProcessManager, 'getProcessStatus', async () => ({ exists: false }));

  const app = await AppManager.createApp('skip-app', 'npm');
  // Point the app at our temp tree and pre-assign a port (skips allocation).
  await queries.updateApp({ id: app.id, path: dir });
  await AppManager.updateApp(app.id, { port: 45789 });

  try {
    // 1) First start: install + build run once.
    await DeployManager.deployApp(app.id);
    assert.deepEqual(counts, { install: 1, build: 1, start: 1 });

    // 2) Plain stop -> start: nothing is redone, only the process (re)starts.
    await DeployManager.stopApp(app.id);
    await DeployManager.deployApp(app.id);
    assert.deepEqual(counts, { install: 1, build: 1, start: 2 });

    // 3) Source-only change: rebuild, no reinstall.
    fs.writeFileSync(path.join(dir, 'extra.js'), 'console.log("new")');
    await DeployManager.stopApp(app.id);
    await DeployManager.deployApp(app.id);
    assert.deepEqual(counts, { install: 1, build: 2, start: 3 });

    // 4) Dependency-definition change: reinstall + forced rebuild.
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'skip-app',
      dependencies: { express: '^4.0.0' },
      scripts: { start: 'node index.js', build: 'node build.js' },
    }));
    await DeployManager.stopApp(app.id);
    await DeployManager.deployApp(app.id);
    assert.deepEqual(counts, { install: 2, build: 3, start: 4 });
  } finally {
    mock.reset();
    await queries.deleteApp(app.id); // cascades app_deploy_state
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
