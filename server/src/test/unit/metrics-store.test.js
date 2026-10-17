const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { queries, dbReady } = require('../helpers/setup');
const metricsSampler = require('../../services/metrics-sampler');

before(async () => { await dbReady; });

const APP = 'metrics-test-app';

test('metrics store: latest, ordered history, and ring-buffer pruning', async () => {
  // Three samples, ascending ts.
  await queries.insertMetric(APP, { ts: 1000, cpu: 1, memory: 100, uptimeMs: 10 });
  await queries.insertMetric(APP, { ts: 2000, cpu: 2, memory: 200, uptimeMs: 20 });
  await queries.insertMetric(APP, { ts: 3000, cpu: 3, memory: 300, uptimeMs: null });

  const latest = await metricsSampler.getLatest(APP);
  assert.deepEqual(latest, { ts: 3000, cpu: 3, memory: 300, uptimeMs: null });

  const history = await metricsSampler.getHistory(APP);
  assert.deepEqual(history.map(h => h.ts), [1000, 2000, 3000]); // oldest first

  // Prune to 2: oldest goes, newest survive.
  await queries.pruneMetrics(APP, 2);
  const after = await metricsSampler.getHistory(APP);
  assert.deepEqual(after.map(h => h.ts), [2000, 3000]);

  // Unknown app -> null / [] (shape the routes serialize).
  assert.equal(await metricsSampler.getLatest('never-sampled'), null);
  assert.deepEqual(await metricsSampler.getHistory('never-sampled'), []);

  // Cleanup so other tests see an empty table for this name.
  const rows = await queries.getMetricHistory(APP);
  assert.equal(rows.length, 2);
});

test('tie on identical ts resolves deterministically (last insert wins)', async () => {
  const name = 'metrics-tie-app';
  await queries.insertMetric(name, { ts: 5000, cpu: 10, memory: 1, uptimeMs: 0 });
  await queries.insertMetric(name, { ts: 5000, cpu: 20, memory: 2, uptimeMs: 0 });
  const latest = await metricsSampler.getLatest(name);
  assert.equal(latest.cpu, 20); // ORDER BY ts DESC, id DESC
});

test('deleting an app removes its metrics (no stale inheritance for a reused name)', async () => {
  const AppManager = require('../../services/app-manager');
  const app = await AppManager.createApp('metrics-cascade-app', 'http-server');
  await queries.insertMetric(app.name, { ts: 9000, cpu: 5, memory: 50, uptimeMs: 1 });
  assert.ok(await metricsSampler.getLatest(app.name));

  await AppManager.deleteApp(app.id);
  assert.equal(await metricsSampler.getLatest(app.name), null);
  assert.deepEqual(await metricsSampler.getHistory(app.name), []);
});
