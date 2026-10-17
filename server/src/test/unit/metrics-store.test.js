const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { queries, dbReady } = require('../helpers/setup');
const metricsSampler = require('../../services/metrics-sampler');
const AppManager = require('../../services/app-manager');

before(async () => { await dbReady; });

// metrics.app_name has an FK to apps(name) with ON DELETE CASCADE — samples
// must belong to a real app row (that is the point of the FK: no orphans, no
// stale inheritance when a name is reused).
async function makeApp(name) {
  return AppManager.createApp(name, 'http-server');
}

test('metrics store: latest, ordered history, and ring-buffer pruning', async () => {
  const app = await makeApp('metrics-test-app');
  try {
    // Three samples, ascending ts.
    await queries.insertMetric(app.name, { ts: 1000, cpu: 1, memory: 100, uptimeMs: 10 });
    await queries.insertMetric(app.name, { ts: 2000, cpu: 2, memory: 200, uptimeMs: 20 });
    await queries.insertMetric(app.name, { ts: 3000, cpu: 3, memory: 300, uptimeMs: null });

    const latest = await metricsSampler.getLatest(app.name);
    assert.deepEqual(latest, { ts: 3000, cpu: 3, memory: 300, uptimeMs: null });

    const history = await metricsSampler.getHistory(app.name);
    assert.deepEqual(history.map(h => h.ts), [1000, 2000, 3000]); // oldest first

    // Prune to 2: oldest goes, newest survive.
    await queries.pruneMetrics(app.name, 2);
    const after = await metricsSampler.getHistory(app.name);
    assert.deepEqual(after.map(h => h.ts), [2000, 3000]);
  } finally {
    await AppManager.deleteApp(app.id);
  }

  // Unknown app -> null / [] (shape the routes serialize).
  assert.equal(await metricsSampler.getLatest('never-sampled'), null);
  assert.deepEqual(await metricsSampler.getHistory('never-sampled'), []);
});

test('tie on identical ts resolves deterministically (last insert wins)', async () => {
  const app = await makeApp('metrics-tie-app');
  try {
    await queries.insertMetric(app.name, { ts: 5000, cpu: 10, memory: 1, uptimeMs: 0 });
    await queries.insertMetric(app.name, { ts: 5000, cpu: 20, memory: 2, uptimeMs: 0 });
    const latest = await metricsSampler.getLatest(app.name);
    assert.equal(latest.cpu, 20); // ORDER BY ts DESC, id DESC
  } finally {
    await AppManager.deleteApp(app.id);
  }
});

test('deleting an app removes its metrics (no stale inheritance for a reused name)', async () => {
  const app = await makeApp('metrics-cascade-app');
  await queries.insertMetric(app.name, { ts: 9000, cpu: 5, memory: 50, uptimeMs: 1 });
  assert.ok(await metricsSampler.getLatest(app.name));

  await AppManager.deleteApp(app.id);
  assert.equal(await metricsSampler.getLatest(app.name), null);
  assert.deepEqual(await metricsSampler.getHistory(app.name), []);
});
