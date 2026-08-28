const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { adminAgent, queries, dbReady } = require('../helpers/setup');

let agent;
before(async () => { await dbReady; agent = await adminAgent(); });

function zipWith(files) {
  const z = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    z.addFile(name, Buffer.from(content));
  }
  return z.toBuffer();
}

test('a zip upload replaces stale user files but keeps platform files', async () => {
  const created = await agent.post('/api/apps').send({ name: 'upload-replace', deploy_type: 'http-server' });
  const id = created.body.data.id;
  const app = await queries.getAppById(id);

  // First upload: index.html + old.html.
  await agent.post(`/api/apps/${id}/upload`)
    .attach('files', zipWith({ 'index.html': 'v1', 'old.html': 'stale' }), 'site.zip')
    .expect(200);

  // Platform-managed entries that must survive a re-upload.
  fs.mkdirSync(path.join(app.path, 'node_modules'));
  fs.writeFileSync(path.join(app.path, 'nginx.upload-replace.conf'), 'conf');

  assert.ok(fs.existsSync(path.join(app.path, 'old.html')), 'seed old.html present');

  // Re-upload a zip that only contains index.html (v2): old.html must go away.
  await agent.post(`/api/apps/${id}/upload`)
    .attach('files', zipWith({ 'index.html': 'v2' }), 'site2.zip')
    .expect(200);

  assert.ok(!fs.existsSync(path.join(app.path, 'old.html')), 'stale old.html removed');
  assert.ok(fs.existsSync(path.join(app.path, 'index.html')), 'new index.html present');
  assert.ok(fs.existsSync(path.join(app.path, 'node_modules')), 'node_modules preserved');
  assert.ok(fs.existsSync(path.join(app.path, 'nginx.upload-replace.conf')), 'nginx conf preserved');

  await agent.delete(`/api/apps/${id}`).expect(200);
});

test('an individual (non-zip) upload does not clear existing files', async () => {
  const created = await agent.post('/api/apps').send({ name: 'upload-append', deploy_type: 'http-server' });
  const id = created.body.data.id;
  const app = await queries.getAppById(id);

  await agent.post(`/api/apps/${id}/upload`)
    .attach('files', Buffer.from('<h1>a</h1>'), 'index.html')
    .expect(200);

  // A second single-file upload must append, not wipe the first.
  await agent.post(`/api/apps/${id}/upload`)
    .attach('files', Buffer.from('body{}'), 'style.css')
    .expect(200);

  assert.ok(fs.existsSync(path.join(app.path, 'index.html')), 'index.html retained');
  assert.ok(fs.existsSync(path.join(app.path, 'style.css')), 'style.css added');

  await agent.delete(`/api/apps/${id}`).expect(200);
});

test('a wrapper zip flattens even when node_modules is preserved from a prior deploy', async () => {
  const created = await agent.post('/api/apps').send({ name: 'upload-npm-reup', deploy_type: 'npm' });
  const id = created.body.data.id;
  const app = await queries.getAppById(id);

  // A previous deploy would have installed deps into node_modules.
  fs.mkdirSync(path.join(app.path, 'node_modules', 'pkg'), { recursive: true });

  // GitHub-style npm zip: repo-main/ wrapper holding package.json.
  const zip = new AdmZip();
  zip.addFile('repo-main/package.json', Buffer.from(JSON.stringify({ name: 'x', scripts: { start: 'node index.js' } })));
  zip.addFile('repo-main/index.js', Buffer.from('x'));

  await agent.post(`/api/apps/${id}/upload`)
    .attach('files', zip.toBuffer(), 'repo.zip')
    .expect(200);

  assert.ok(fs.existsSync(path.join(app.path, 'package.json')), 'package.json flattened to root');
  assert.ok(!fs.existsSync(path.join(app.path, 'repo-main')), 'wrapper removed');
  assert.ok(fs.existsSync(path.join(app.path, 'node_modules')), 'node_modules preserved');

  await agent.delete(`/api/apps/${id}`).expect(200);
});
