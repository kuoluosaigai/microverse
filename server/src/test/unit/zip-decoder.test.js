const { test } = require('node:test');
const assert = require('node:assert/strict');
const zipDecoder = require('../../utils/zip-decoder');

test('decodes valid UTF-8 names unchanged', () => {
  const buf = Buffer.from('如何发布文章.md', 'utf8');
  assert.equal(zipDecoder.decode(buf), '如何发布文章.md');
});

test('decodes pure-ASCII names unchanged', () => {
  assert.equal(zipDecoder.decode(Buffer.from('index.html', 'utf8')), 'index.html');
});

test('re-decodes GBK names (no UTF-8 flag) instead of producing mojibake', () => {
  // "如何发布文章.md" as raw GBK bytes, as Windows Explorer / Chinese archivers write.
  const gbk = Buffer.from([
    0xc8, 0xe7, // 如
    0xba, 0xce, // 何
    0xb7, 0xa2, // 发
    0xb2, 0xbc, // 布
    0xce, 0xc4, // 文
    0xd5, 0xc2, // 章
    0x2e, 0x6d, 0x64, // .md
  ]);
  // Sanity: the raw bytes are NOT valid UTF-8, so the default decoder garbles them.
  assert.notEqual(gbk.toString('utf8'), '如何发布文章.md');
  assert.equal(zipDecoder.decode(gbk), '如何发布文章.md');
});
