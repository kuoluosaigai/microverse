const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { adminAgent, queries, dbReady } = require('../helpers/setup');

let agent;
before(async () => { await dbReady; agent = await adminAgent(); });

test('same-name uploads in one request are de-duplicated, not overwritten', async () => {
  const created = await agent.post('/api/apps').send({ name: 'up-san-dup', deploy_type: 'http-server' });
  const id = created.body.data.id;
  const app = await queries.getAppById(id);

  const res = await agent.post(`/api/apps/${id}/upload`)
    .attach('files', Buffer.from('<h1>first</h1>'), 'index.html')
    .attach('files', Buffer.from('<h1>second</h1>'), 'index.html')
    .expect(200);

  assert.equal(res.body.data.filesUploaded, 2);
  const names = res.body.data.files.sort();
  assert.deepEqual(names, ['index (1).html', 'index.html']);
  assert.equal(fs.readFileSync(path.join(app.path, 'index.html'), 'utf8'), '<h1>first</h1>');
  assert.equal(fs.readFileSync(path.join(app.path, 'index (1).html'), 'utf8'), '<h1>second</h1>');

  await agent.delete(`/api/apps/${id}`).expect(200);
});

test('traversal filenames stay inside the app directory', async () => {
  const created = await agent.post('/api/apps').send({ name: 'up-san-trav', deploy_type: 'http-server' });
  const id = created.body.data.id;
  const app = await queries.getAppById(id);

  const res = await agent.post(`/api/apps/${id}/upload`)
    .attach('files', Buffer.from('pwn'), '../evil.html')
    .expect(200);

  const saved = res.body.data.files[0];
  assert.ok(!saved.includes('/') && !saved.includes('\\'), `saved name must be flat: ${saved}`);
  assert.ok(!fs.existsSync(path.join(app.path, '..', 'evil.html')), 'nothing written outside the app dir');
  assert.ok(fs.existsSync(path.join(app.path, saved)), 'file landed inside the app dir');

  await agent.delete(`/api/apps/${id}`).expect(200);
});

test('GET /apps/:id/files exposes only relative paths', async () => {
  const created = await agent.post('/api/apps').send({ name: 'up-san-files', deploy_type: 'http-server' });
  const id = created.body.data.id;
  const app = await queries.getAppById(id);

  await agent.post(`/api/apps/${id}/upload`)
    .attach('files', Buffer.from('<h1>x</h1>'), 'index.html')
    .expect(200);

  const res = await agent.get(`/api/apps/${id}/files`).expect(200);
  assert.ok(res.body.data.length >= 1);
  for (const entry of res.body.data) {
    assert.ok(!path.isAbsolute(entry.path), `path must be relative: ${entry.path}`);
    assert.ok(!entry.path.includes(app.path), 'absolute app dir must not leak');
  }
  const index = res.body.data.find((f) => f.name === 'index.html');
  assert.equal(index.path, 'index.html');

  await agent.delete(`/api/apps/${id}`).expect(200);
});
