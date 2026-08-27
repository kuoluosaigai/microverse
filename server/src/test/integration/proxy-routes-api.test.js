const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request, adminAgent, queries } = require('../helpers/setup');
const ProxyManager = require('../../services/proxy-manager');

async function seedApp(name) {
  const a = await queries.createApp({ name, path: `/tmp/${name}`, deploy_type: 'http-server', port: 4001, status: 'running' });
  return a.lastID;
}

test('proxy-routes endpoints require auth', async () => {
  const r = await request().get('/api/proxy-routes');
  assert.equal(r.status, 401);
  const p = await request().post('/api/proxy-routes').send({});
  assert.equal(p.status, 401);
});

test('POST creates a port route and regenerates', async () => {
  const agent = await adminAgent();
  const orig = ProxyManager.regenerate;
  let called = false;
  ProxyManager.regenerate = async () => { called = true; return { ok: true }; };
  try {
    const r = await agent.post('/api/proxy-routes').send({ host: 'a.example.com', target_type: 'port', target_port: 8080 });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.host, 'a.example.com');
    assert.equal(r.body.data.target_port, 8080);
    assert.equal(called, true);
  } finally {
    ProxyManager.regenerate = orig;
  }
});

test('POST rejects duplicate host and invalid target', async () => {
  const agent = await adminAgent();
  await agent.post('/api/proxy-routes').send({ host: 'dup.example.com', target_type: 'port', target_port: 8080 });
  const dup = await agent.post('/api/proxy-routes').send({ host: 'dup.example.com', target_type: 'port', target_port: 9090 });
  assert.equal(dup.status, 400);
  const bad = await agent.post('/api/proxy-routes').send({ host: 'bad.example.com', target_type: 'app', target_app_id: 999999 });
  assert.equal(bad.status, 400);
});

test('GET lists routes with target_app_name + resolved', async () => {
  const agent = await adminAgent();
  const id = await seedApp('resolve-me');
  await agent.post('/api/proxy-routes').send({ host: 'resolve.example.com', target_type: 'app', target_app_id: id });
  const r = await agent.get('/api/proxy-routes');
  assert.equal(r.status, 200);
  const row = r.body.data.find(x => x.host === 'resolve.example.com');
  assert.ok(row);
  assert.equal(row.target_app_name, 'resolve-me');
  assert.equal(row.resolved, true);
});

test('PUT updates a route and regenerates; DELETE removes and regenerates', async () => {
  const agent = await adminAgent();
  const created = await agent.post('/api/proxy-routes').send({ host: 'edit.example.com', target_type: 'port', target_port: 8080 });
  const id = created.body.data.id;
  const orig = ProxyManager.regenerate;
  let called = 0;
  ProxyManager.regenerate = async () => { called++; return { ok: true }; };
  try {
    const up = await agent.put(`/api/proxy-routes/${id}`).send({ host: 'edit.example.com', target_type: 'port', target_port: 9090 });
    assert.equal(up.status, 200);
    assert.equal(up.body.data.target_port, 9090);

    const del = await agent.delete(`/api/proxy-routes/${id}`);
    assert.equal(del.status, 200);
    assert.ok(called >= 2, 'regenerate called on update and delete');
  } finally {
    ProxyManager.regenerate = orig;
  }
});

test('PUT/DELETE on a missing route returns 404', async () => {
  const agent = await adminAgent();
  const up = await agent.put('/api/proxy-routes/999999').send({ host: 'x.example.com', target_type: 'port', target_port: 80 });
  assert.equal(up.status, 404);
  const del = await agent.delete('/api/proxy-routes/999999');
  assert.equal(del.status, 404);
});
