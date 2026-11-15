const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { adminAgent, queries, dbReady } = require('../helpers/setup');
const AppManager = require('../../services/app-manager');
const BackupManager = require('../../services/backup-manager');
const { staleFilesToRemove } = require('../../utils/stale-files');

let agent;
before(async () => { await dbReady; agent = await adminAgent(); });

// Create a git-sourced app on disk with a working-copy marker and a site file.
async function makeGitApp(name) {
  const app = await AppManager.createApp(name, 'npm', { url: 'https://github.com/o/r' });
  fs.mkdirSync(path.join(app.path, '.git'), { recursive: true });
  fs.writeFileSync(path.join(app.path, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(app.path, 'index.html'), '<h1>x</h1>');
  return app;
}

test('getAppFiles hides .git but keeps other dotfiles', async () => {
  const app = await makeGitApp('git-files-list');
  fs.writeFileSync(path.join(app.path, '.env'), 'A=1');

  const files = await AppManager.getAppFiles(app.id);
  assert.equal(files.some(f => f.name === '.git'), false);
  assert.ok(files.some(f => f.name === 'index.html'));
  assert.ok(files.some(f => f.name === '.env'), 'ordinary dotfiles are still listed');
});

test('stale zip cleanup preserves .git', () => {
  const app = { name: 'git-files-stale' };
  const stale = staleFilesToRemove(
    app,
    ['.git', 'index.html', 'node_modules'],
    ['x.zip']
  );
  assert.deepEqual(stale, ['index.html']);
});

test('backup excludes .git but keeps ordinary dotfiles and content', async () => {
  const app = await makeGitApp('git-files-backup');
  fs.writeFileSync(path.join(app.path, '.env'), 'A=1');

  const { buffer } = await BackupManager.createBackup(app);
  const names = new AdmZip(buffer).getEntries().map(e => e.entryName);
  assert.equal(
    names.some(n => n.split(/[\\/]/).includes('.git')),
    false,
    'no zip entry may live under .git'
  );
  assert.ok(names.includes('files/index.html'));
  assert.ok(names.includes('files/.env'));
  assert.ok(names.includes('microverse-manifest.json'));
});

test('upload to a git-sourced app is rejected with 400', async () => {
  const app = await makeGitApp('git-files-upload');

  const res = await agent.post(`/api/apps/${app.id}/upload`)
    .attach('files', Buffer.from('<h1>replaced</h1>'), 'index.html');

  assert.equal(res.status, 400);
  assert.equal(res.body.error.message, 'Git source apps must be updated from the repository');
  assert.equal(
    fs.readFileSync(path.join(app.path, 'index.html'), 'utf8'),
    '<h1>x</h1>',
    'on-disk content is untouched'
  );
});

test('POST /api/apps with git fields binds the source and returns the enriched app', async () => {
  const res = await agent.post('/api/apps').send({
    name: 'git-files-create',
    deploy_type: 'npm',
    git_url: 'https://github.com/o/r',
    git_branch: 'dev',
    git_auto_update: false
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.data.git.url, 'https://github.com/o/r');
  assert.equal(res.body.data.git.branch, 'dev');
  assert.equal(res.body.data.git.auto_update, 0);
  assert.equal(res.body.data.git.webhook_secret, undefined);

  const row = await queries.getAppGitSource(res.body.data.id);
  assert.equal(row.branch, 'dev');
  assert.equal(row.auto_update, 0);
  assert.match(row.webhook_secret, /^[0-9a-f]{64}$/);
});

test('POST /api/apps without git fields stays a plain upload app', async () => {
  const res = await agent.post('/api/apps').send({
    name: 'git-files-create-plain',
    deploy_type: 'http-server'
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.git, null);
  assert.equal(await queries.getAppGitSource(res.body.data.id), undefined);
});

test('POST /api/apps with an invalid git URL -> 400 and no app', async () => {
  const res = await agent.post('/api/apps').send({
    name: 'git-files-bad-url',
    deploy_type: 'npm',
    git_url: 'file:///tmp/x'
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /https/);
  assert.equal(await queries.getAppByName('git-files-bad-url'), undefined);
});

test('POST /api/apps with an invalid git branch -> 400', async () => {
  const res = await agent.post('/api/apps').send({
    name: 'git-files-bad-branch',
    deploy_type: 'npm',
    git_url: 'https://github.com/o/r',
    git_branch: 'bad..branch'
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /Invalid git branch/);
  assert.equal(await queries.getAppByName('git-files-bad-branch'), undefined);
});
