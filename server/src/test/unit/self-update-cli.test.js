const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../../../../scripts/self-update');

test('parseArgs reads --from/--to and rejects invalid shas', () => {
  assert.deepEqual(parseArgs(['--from', 'abc1234', '--to', 'def5678']), { fromSha: 'abc1234', toSha: 'def5678' });
  assert.throws(() => parseArgs(['--from', 'nope', '--to', 'def5678']), /invalid/i);
  assert.throws(() => parseArgs(['--from', 'abc1234']), /invalid/i);
});
