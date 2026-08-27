const { test } = require('node:test');
const assert = require('node:assert/strict');
const { init, queries } = require('../helpers/setup');
const { dbAll } = require('../../db');

test('proxy_domains table exists after init', async () => {
  await init();
  const tables = await dbAll(`SELECT name FROM sqlite_master WHERE type='table' AND name='proxy_domains'`);
  assert.equal(tables.length, 1, 'proxy_domains table present');
});

test('createProxyDomain + listProxyDomains round-trip', async () => {
  await init();
  const r = await queries.createProxyDomain({ host: 'a.example.com' });
  const rows = await queries.listProxyDomains();
  const row = rows.find(x => x.id === r.lastID);
  assert.ok(row);
  assert.equal(row.host, 'a.example.com');
  await queries.deleteProxyDomain(r.lastID);
});

test('deleteProxyDomain removes the row', async () => {
  await init();
  const r = await queries.createProxyDomain({ host: 'gone.example.com' });
  await queries.deleteProxyDomain(r.lastID);
  const rows = await queries.listProxyDomains();
  assert.ok(!rows.some(x => x.id === r.lastID), 'row removed');
});

test('duplicate host violates UNIQUE', async () => {
  await init();
  const r = await queries.createProxyDomain({ host: 'dup.example.com' });
  await assert.rejects(
    () => queries.createProxyDomain({ host: 'dup.example.com' }),
    /UNIQUE constraint failed/i
  );
  await queries.deleteProxyDomain(r.lastID);
});
