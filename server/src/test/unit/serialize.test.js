const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createExclusive } = require('../../utils/serialize');

test('runs overlapping tasks strictly one at a time', async () => {
  const exclusive = createExclusive();
  let active = 0;
  let maxActive = 0;
  const task = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active -= 1;
  };
  await Promise.all(Array.from({ length: 6 }, () => exclusive(task)));
  assert.equal(maxActive, 1);
});

test('preserves order (FIFO)', async () => {
  const exclusive = createExclusive();
  const order = [];
  await Promise.all([
    exclusive(async () => { order.push('a'); }),
    exclusive(async () => { order.push('b'); }),
    exclusive(async () => { order.push('c'); }),
  ]);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('propagates errors AND keeps the chain alive for the next task', async () => {
  const exclusive = createExclusive();
  await assert.rejects(() => exclusive(async () => { throw new Error('boom'); }), /boom/);
  const result = await exclusive(async () => 42); // chain not poisoned
  assert.equal(result, 42);
});
