const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { adminAgent, dbReady } = require('../helpers/setup');

let agent;
before(async () => { await dbReady; agent = await adminAgent(); });

test('backup -> delete -> restore roundtrip', async () => {
  const created = await agent.post('/api/apps').send({ name: 'bk-app', deploy_type: 'http-server' });
  const id = created.body.data.id;

  // .responseType('blob') forces superagent to buffer the binary body as a
  // Buffer (res.body). Without it, supertest's default text parser runs for
  // application/zip and res.body comes back as {} — see superagent isBinary().
  const bk = await agent.get(`/api/apps/${id}/backup`).responseType('blob');
  assert.equal(bk.status, 200);
  assert.equal(bk.headers['content-type'], 'application/zip');
  assert.ok(Buffer.isBuffer(bk.body), 'backup body must be a Buffer');
  const zipBuffer = bk.body;

  await agent.delete(`/api/apps/${id}`).expect(200);

  const restore = await agent.post('/api/apps/restore')
    .attach('file', zipBuffer, 'bk-app-backup.zip');
  assert.equal(restore.status, 201);
  assert.equal(restore.body.data.name, 'bk-app');
  assert.equal(restore.body.data.deploy_type, 'http-server');

  await agent.delete(`/api/apps/${restore.body.data.id}`).expect(200);
});

test('restore a name that already exists -> 400', async () => {
  const created = await agent.post('/api/apps').send({ name: 'bk-conflict', deploy_type: 'http-server' });
  const bk = await agent.get(`/api/apps/${created.body.data.id}/backup`).responseType('blob').expect(200);
  assert.ok(Buffer.isBuffer(bk.body), 'backup body must be a Buffer');
  const restore = await agent.post('/api/apps/restore')
    .attach('file', bk.body, 'bk-conflict-backup.zip');
  assert.equal(restore.status, 400);
  assert.match(restore.body.error.message, /already exists/);
  await agent.delete(`/api/apps/${created.body.data.id}`).expect(200);
});

test('restore non-zip -> 400', async () => {
  const restore = await agent.post('/api/apps/restore')
    .attach('file', Buffer.from('not a zip'), 'x.zip');
  assert.equal(restore.status, 400);
});

test('restore a backup with an invalid manifest name -> 400', async () => {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile(
    'microverse-manifest.json',
    JSON.stringify({ name: '../bad', deploy_type: 'http-server', env: [] })
  );
  const restore = await agent.post('/api/apps/restore')
    .attach('file', zip.toBuffer(), 'bad.zip');
  assert.equal(restore.status, 400);
  assert.match(restore.body.error.message, /Invalid app name/);
});
