const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const ProcessManager = require('../../services/process-manager');

test('isPortAvailable: free port -> true', async () => {
  const srv = net.createServer();
  const port = await new Promise((resolve) => {
    srv.listen(0, '0.0.0.0', () => resolve(srv.address().port));
  });
  await new Promise((r) => srv.close(r));
  assert.equal(await ProcessManager.isPortAvailable(port), true);
});

test('isPortAvailable: occupied port -> false', async () => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '0.0.0.0', r));
  const port = srv.address().port;
  try {
    assert.equal(await ProcessManager.isPortAvailable(port), false);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('findAvailablePort returns a free port within range', async () => {
  const port = await ProcessManager.findAvailablePort(40000, 40100);
  assert.ok(port >= 40000 && port <= 40100);
  assert.equal(await ProcessManager.isPortAvailable(port), true);
});

test('findAvailablePort: fully-excluded range -> throws', async () => {
  const all = new Set();
  for (let p = 40000; p <= 40005; p++) all.add(p);
  await assert.rejects(
    () => ProcessManager.findAvailablePort(40000, 40005, { exclude: all }),
    /No available ports/
  );
});
