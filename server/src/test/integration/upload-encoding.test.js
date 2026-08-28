const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { adminAgent, queries, dbReady } = require('../helpers/setup');

let agent;
before(async () => { await dbReady; agent = await adminAgent(); });

// A stored (uncompressed) zip containing a single file whose name is GBK-encoded
// "如何发布文章.md" — exactly what Windows Explorer / Chinese archivers produce,
// with no UTF-8 flag set. Built with a raw zip writer; see unit/zip-decoder.test.js
// for the byte-level encoding.
const GBK_ZIP = Buffer.from(
  'UEsDBBQAAAAAAAAAAAD+/TiGDQAAAA0AAAAPAAAAyOe6zreisrzOxNXCLm1kPGgxPnRlc3Q8L2gxPlBLAQIUABQAAAAAAAAAAAD+/TiGDQAAAA0AAAAPAAAAAAAAAAAAAAAAAAAAAADI57rOt6KyvM7E1cIubWRQSwUGAAAAAAEAAQA9AAAAOgAAAAAA',
  'base64'
);

test('uploading a GBK-named zip extracts the correct Chinese filename', async () => {
  const created = await agent.post('/api/apps').send({ name: 'upload-cn', deploy_type: 'http-server' });
  assert.equal(created.status, 201);
  const id = created.body.data.id;

  const res = await agent.post(`/api/apps/${id}/upload`)
    .attach('files', GBK_ZIP, 'repo.zip');
  assert.equal(res.status, 200, res.text);

  // The reported filename must be the real name, not UTF-8-misread mojibake.
  assert.ok(res.body.data.files.includes('如何发布文章.md'),
    `files should include the decoded name, got: ${res.body.data.files}`);

  // On-disk: the file was written under the correct name.
  const app = await queries.getAppById(id);
  assert.ok(fs.existsSync(path.join(app.path, '如何发布文章.md')), 'Chinese-named file exists on disk');

  await agent.delete(`/api/apps/${id}`).expect(200);
});
