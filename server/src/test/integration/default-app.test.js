const { test } = require('node:test');
const assert = require('node:assert/strict');
const { init, queries } = require('../helpers/setup');
const { dbAll, applyMigrations } = require('../../db');

test('apps.is_default column exists after init', async () => {
  await init();
  const cols = await dbAll('PRAGMA table_info(apps)');
  assert.ok(cols.some(c => c.name === 'is_default'), 'is_default column present');
});

test('applyMigrations is idempotent', async () => {
  await init();
  await applyMigrations(); // column already present -> no-op, must not throw
  const cols = await dbAll('PRAGMA table_info(apps)');
  assert.equal(cols.filter(c => c.name === 'is_default').length, 1);
});

test('setDefaultApp enforces a single default', async () => {
  await init();
  const a1 = await queries.createApp({ name: 'default-a', path: '/tmp/a', deploy_type: 'http-server', port: 3001, status: 'running' });
  const a2 = await queries.createApp({ name: 'default-b', path: '/tmp/b', deploy_type: 'http-server', port: 3002, status: 'running' });

  await queries.setDefaultApp(a1.lastID);
  let rows = await queries.getAllApps();
  assert.equal(rows.find(r => r.id === a1.lastID).is_default, 1);
  assert.equal(rows.find(r => r.id === a2.lastID).is_default, 0);

  await queries.setDefaultApp(a2.lastID);
  rows = await queries.getAllApps();
  assert.equal(rows.find(r => r.id === a2.lastID).is_default, 1);
  assert.equal(rows.find(r => r.id === a1.lastID).is_default, 0, 'previous default cleared');
});

test('updateApp clears is_default via COALESCE', async () => {
  await init();
  const a = await queries.createApp({ name: 'default-c', path: '/tmp/c', deploy_type: 'http-server', port: 3003, status: 'running' });
  await queries.setDefaultApp(a.lastID);
  await queries.updateApp({ id: a.lastID, is_default: 0 });
  const rows = await queries.getAllApps();
  assert.equal(rows.find(r => r.id === a.lastID).is_default, 0);
});

const AppManager = require('../../services/app-manager');

test('deleteApp triggers a proxy regenerate', async () => {
  await init();
  const a = await queries.createApp({ name: 'del-hook', path: '/tmp/dh', deploy_type: 'http-server', port: null, status: 'stopped' });
  const ProxyManager = require('../../services/proxy-manager');
  const orig = ProxyManager.regenerate;
  let called = false;
  ProxyManager.regenerate = async () => { called = true; return { ok: true }; };
  try {
    await AppManager.deleteApp(a.lastID);
    assert.equal(called, true, 'regenerate called on delete');
    // app actually gone from DB
    const rows = await queries.getAllApps();
    assert.ok(!rows.some(r => r.id === a.lastID));
  } finally {
    ProxyManager.regenerate = orig;
  }
});
