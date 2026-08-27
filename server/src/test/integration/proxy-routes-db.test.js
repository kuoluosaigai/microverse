const { test } = require('node:test');
const assert = require('node:assert/strict');
const { init, queries } = require('../helpers/setup');
const { dbAll } = require('../../db');

test('proxy_routes table exists after init', async () => {
  await init();
  const tables = await dbAll(`SELECT name FROM sqlite_master WHERE type='table' AND name='proxy_routes'`);
  assert.equal(tables.length, 1, 'proxy_routes table present');
});

test('createProxyRoute + listProxyRoutes round-trip', async () => {
  await init();
  const r = await queries.createProxyRoute({ host: 'a.example.com', target_type: 'port', target_port: 8080, target_app_id: null });
  const rows = await queries.listProxyRoutes();
  const row = rows.find(x => x.id === r.lastID);
  assert.ok(row);
  assert.equal(row.host, 'a.example.com');
  assert.equal(row.target_type, 'port');
  assert.equal(row.target_port, 8080);
  assert.equal(row.target_app_id, null);
  await queries.deleteProxyRoute(r.lastID);
});

test('updateProxyRoute updates fields', async () => {
  await init();
  const r = await queries.createProxyRoute({ host: 'upd.example.com', target_type: 'port', target_port: 8080, target_app_id: null });
  await queries.updateProxyRoute(r.lastID, { host: 'upd.example.com', target_type: 'port', target_port: 9090, target_app_id: null });
  const rows = await queries.listProxyRoutes();
  assert.equal(rows.find(x => x.id === r.lastID).target_port, 9090);
  await queries.deleteProxyRoute(r.lastID);
});

test('duplicate host violates UNIQUE', async () => {
  await init();
  const r = await queries.createProxyRoute({ host: 'dup.example.com', target_type: 'port', target_port: 8080, target_app_id: null });
  await assert.rejects(
    () => queries.createProxyRoute({ host: 'dup.example.com', target_type: 'port', target_port: 9090, target_app_id: null }),
    /UNIQUE constraint failed/i
  );
  await queries.deleteProxyRoute(r.lastID);
});

test('CHECK rejects port target with no target_port', async () => {
  await init();
  await assert.rejects(
    () => queries.createProxyRoute({ host: 'noport.example.com', target_type: 'port', target_port: null, target_app_id: null }),
    /CHECK constraint failed/i
  );
});

test('ON DELETE CASCADE removes routes pointing at a deleted app', async () => {
  await init();
  const a = await queries.createApp({ name: 'route-cascade', path: '/tmp/rc', deploy_type: 'http-server', port: 3001, status: 'running' });
  const r = await queries.createProxyRoute({ host: 'cascade.example.com', target_type: 'app', target_port: null, target_app_id: a.lastID });
  await queries.deleteApp(a.lastID);
  const rows = await queries.listProxyRoutes();
  assert.ok(!rows.some(x => x.id === r.lastID), 'route removed when app deleted');
});
