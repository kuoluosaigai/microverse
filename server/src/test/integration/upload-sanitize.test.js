const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { adminAgent, queries, dbReady } = require('../helpers/setup');

let agent;
before(async () => { await dbReady; agent = await adminAgent(); });

// Same-name parts in ONE request must not share a write path: multer opens one
// stream per part, and concurrent streams into one file interleave bytes into
// a corrupt merge. uniqueInRequest gives the later part its own "(1)" slot, so
// both payloads survive intact and neither is silently dropped.
test('same-name parts in one request each get an intact file', async () => {
  const created = await agent.post('/api/apps').send({ name: 'up-san-dup', deploy_type: 'http-server' });
  const id = created.body.data.id;
  const app = await queries.getAppById(id);

  const res = await agent.post(`/api/apps/${id}/upload`)
    .attach('files', Buffer.from('<h1>first</h1>'), 'index.html')
    .attach('files', Buffer.from('<h1>second</h1>'), 'index.html')
    .expect(200);

  assert.equal(res.body.data.filesUploaded, 2);
  assert.deepEqual(res.body.data.files.sort(), ['index (1).html', 'index.html']);
  assert.deepEqual(fs.readdirSync(app.path).sort(), ['index (1).html', 'index.html']);
  // Parts are handled in order: the first keeps the plain name.
  assert.equal(fs.readFileSync(path.join(app.path, 'index.html'), 'utf8'), '<h1>first</h1>');
  assert.equal(fs.readFileSync(path.join(app.path, 'index (1).html'), 'utf8'), '<h1>second</h1>');

  await agent.delete(`/api/apps/${id}`).expect(200);
});

test('re-uploading the same name replaces the file the app serves', async () => {
  const created = await agent.post('/api/apps').send({ name: 'up-san-re', deploy_type: 'http-server' });
  const id = created.body.data.id;
  const app = await queries.getAppById(id);

  await agent.post(`/api/apps/${id}/upload`)
    .attach('files', Buffer.from('<h1>v1</h1>'), 'index.html')
    .expect(200);
  const reup = await agent.post(`/api/apps/${id}/upload`)
    .attach('files', Buffer.from('<h1>v2</h1>'), 'index.html')
    .expect(200);

  assert.equal(reup.body.data.filesUploaded, 1);
  assert.deepEqual(reup.body.data.files, ['index.html']);
  assert.deepEqual(fs.readdirSync(app.path), ['index.html'], 'no "(1)" sibling left behind');
  assert.equal(fs.readFileSync(path.join(app.path, 'index.html'), 'utf8'), '<h1>v2</h1>');

  // The app directory listing stays a single, correctly-named entry.
  const listing = await agent.get(`/api/apps/${id}/files`).expect(200);
  assert.deepEqual(listing.body.data.map(f => f.name), ['index.html']);

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
