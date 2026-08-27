const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request, adminAgent } = require('../helpers/setup');
const ProxyManager = require('../../services/proxy-manager');

test('proxy-domains endpoints require auth', async () => {
  const r = await request().get('/api/proxy-domains');
  assert.equal(r.status, 401);
  const p = await request().post('/api/proxy-domains').send({ host: 'x.example.com' });
  assert.equal(p.status, 401);
});

test('POST creates a domain and does NOT regenerate', async () => {
  const agent = await adminAgent();
  const orig = ProxyManager.regenerate;
  let called = false;
  ProxyManager.regenerate = async () => { called = true; return { ok: true }; };
  try {
    const r = await agent.post('/api/proxy-domains').send({ host: 'A.Example.COM' });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.host, 'a.example.com');
    assert.ok(r.body.data.id);
    assert.equal(called, false);
  } finally {
    ProxyManager.regenerate = orig;
  }
});

test('POST rejects duplicate host (case-insensitive) and invalid host', async () => {
  const agent = await adminAgent();
  await agent.post('/api/proxy-domains').send({ host: 'dup.example.com' });
  const dup = await agent.post('/api/proxy-domains').send({ host: 'DUP.EXAMPLE.COM' });
  assert.equal(dup.status, 400);
  const bad = await agent.post('/api/proxy-domains').send({ host: 'bad host' });
  assert.equal(bad.status, 400);
});

test('GET lists domains', async () => {
  const agent = await adminAgent();
  await agent.post('/api/proxy-domains').send({ host: 'list.example.com' });
  const r = await agent.get('/api/proxy-domains');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
  assert.ok(r.body.data.some(x => x.host === 'list.example.com'));
});

test('DELETE removes a domain and does NOT regenerate; missing -> 404', async () => {
  const agent = await adminAgent();
  const created = await agent.post('/api/proxy-domains').send({ host: 'del.example.com' });
  const id = created.body.data.id;

  const orig = ProxyManager.regenerate;
  let called = false;
  ProxyManager.regenerate = async () => { called = true; return { ok: true }; };
  try {
    const del = await agent.delete(`/api/proxy-domains/${id}`);
    assert.equal(del.status, 200);
    assert.equal(called, false);
  } finally {
    ProxyManager.regenerate = orig;
  }

  const missing = await agent.delete('/api/proxy-domains/999999');
  assert.equal(missing.status, 404);
});
