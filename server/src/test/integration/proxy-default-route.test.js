const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request, adminAgent, queries } = require('../helpers/setup');
const ProxyManager = require('../../services/proxy-manager');

async function seed(name) {
  const a = await queries.createApp({ name, path: `/tmp/${name}`, deploy_type: 'http-server', port: 4001, status: 'running' });
  return a.lastID;
}

test('default routes require auth', async () => {
  const r1 = await request().put('/api/apps/1/default');
  assert.equal(r1.status, 401);
  const r2 = await request().delete('/api/apps/1/default');
  assert.equal(r2.status, 401);
});

test('GET /api/config exposes proxyEnabled + proxyBaseDomain', async () => {
  const res = await request().get('/api/config');
  assert.equal(res.status, 200);
  assert.ok('proxyEnabled' in res.body.data);
  assert.ok('proxyBaseDomain' in res.body.data);
});

test('PUT /default sets a single default and regenerates', async () => {
  const agent = await adminAgent();
  const idA = await seed('route-a');
  const idB = await seed('route-b');
  const orig = ProxyManager.regenerate;
  let called = 0;
  ProxyManager.regenerate = async () => { called++; return { ok: true }; };
  try {
    const r1 = await agent.put(`/api/apps/${idA}/default`);
    assert.equal(r1.status, 200);
    assert.equal(r1.body.data.is_default, 1);

    await agent.put(`/api/apps/${idB}/default`);
    const rows = await queries.getAllApps();
    assert.equal(rows.find(r => r.id === idA).is_default, 0);
    assert.equal(rows.find(r => r.id === idB).is_default, 1);
    assert.ok(called >= 2, 'regenerate called on each set');
  } finally {
    ProxyManager.regenerate = orig;
  }
});

test('DELETE /default clears the flag and regenerates', async () => {
  const agent = await adminAgent();
  const id = await seed('route-c');
  const orig = ProxyManager.regenerate;
  let called = false;
  ProxyManager.regenerate = async () => { called = true; return { ok: true }; };
  try {
    await agent.put(`/api/apps/${id}/default`);
    const r = await agent.delete(`/api/apps/${id}/default`);
    assert.equal(r.status, 200);
    const rows = await queries.getAllApps();
    assert.equal(rows.find(row => row.id === id).is_default, 0);
    assert.equal(called, true);
  } finally {
    ProxyManager.regenerate = orig;
  }
});

test('PUT /default on a missing app returns 404', async () => {
  const agent = await adminAgent();
  const r = await agent.put('/api/apps/999999/default');
  assert.equal(r.status, 404);
});
