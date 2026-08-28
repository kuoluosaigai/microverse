const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { adminAgent, queries, dbReady } = require('../helpers/setup');

let agent;
before(async () => { await dbReady; agent = await adminAgent(); });

// A GitHub/IDE source zip wraps everything in a top-level folder named after
// the repo/branch (e.g. repo-main/). The upload route must flatten that wrapper
// so index.html lands at the app root — otherwise deploy validation fails.
function githubZip() {
  const zip = new AdmZip();
  zip.addFile('repo-main/index.html', Buffer.from('<h1>hi</h1>'));
  zip.addFile('repo-main/css/x.css', Buffer.from('body{}'));
  zip.addFile('repo-main/README.md', Buffer.from('x'));
  return zip.toBuffer();
}

test('uploading a GitHub-style zip flattens the repo-main wrapper to the app root', async () => {
  const created = await agent.post('/api/apps').send({ name: 'upload-flat', deploy_type: 'http-server' });
  assert.equal(created.status, 201);
  const id = created.body.data.id;

  const res = await agent.post(`/api/apps/${id}/upload`)
    .attach('files', githubZip(), 'repo.zip');
  assert.equal(res.status, 200, res.text);

  // Reported file names must reflect the flattened on-disk paths.
  assert.ok(res.body.data.files.includes('index.html'), `files should include index.html, got: ${res.body.data.files}`);
  assert.ok(!res.body.data.files.some(f => f.startsWith('repo-main/')), `files should not contain wrapper prefix, got: ${res.body.data.files}`);

  // On-disk: index.html at the app root, wrapper folder gone.
  const app = await queries.getAppById(id);
  assert.ok(fs.existsSync(path.join(app.path, 'index.html')), 'index.html hoisted to app root');
  assert.ok(fs.existsSync(path.join(app.path, 'css', 'x.css')), 'nested dir hoisted to app root');
  assert.ok(!fs.existsSync(path.join(app.path, 'repo-main')), 'wrapper folder removed');

  await agent.delete(`/api/apps/${id}`).expect(200);
});

test('uploading a multi-level wrapper (repo-main/dist) unwraps all levels', async () => {
  const created = await agent.post('/api/apps').send({ name: 'upload-flat2', deploy_type: 'http-server' });
  const id = created.body.data.id;

  const zip = new AdmZip();
  zip.addFile('repo-main/dist/index.html', Buffer.from('<h1>hi</h1>'));
  zip.addFile('repo-main/dist/css/x.css', Buffer.from('body{}'));

  const res = await agent.post(`/api/apps/${id}/upload`)
    .attach('files', zip.toBuffer(), 'repo.zip');
  assert.equal(res.status, 200, res.text);

  const app = await queries.getAppById(id);
  assert.ok(fs.existsSync(path.join(app.path, 'index.html')), 'index.html at root after multi-level unwrap');
  assert.ok(!fs.existsSync(path.join(app.path, 'repo-main')), 'outer wrapper removed');

  await agent.delete(`/api/apps/${id}`).expect(200);
});
