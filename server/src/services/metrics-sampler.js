const config = require('../config');
const ProcessManager = require('./process-manager');
const { queries } = require('../db');

/**
 * MetricsSampler — boot-started background sampler. Polls PM2 once per tick for
 * ALL processes and appends resource samples to the shared SQLite `metrics`
 * table, pruned to the newest METRICS_MAX_SAMPLES rows per app (ring-buffer
 * semantics).
 *
 * Under PM2 cluster only ONE worker runs the sampler (server.js gates start()
 * on NODE_APP_INSTANCE), while every worker serves reads from the same table —
 * the old in-memory buffer made GET /api/apps return whichever worker's view
 * the load balancer happened to hit.
 *
 * Sample = { ts:number(epoch ms), cpu:number(%), memory:number(bytes), uptimeMs:number }
 */
class MetricsSampler {
  constructor() {
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    // Tick immediately so data appears without waiting a full interval.
    this._tick();
    this.timer = setInterval(() => this._tick(), config.deployment.metricsIntervalMs);
    if (this.timer.unref) this.timer.unref(); // don't keep the process alive solely for sampling
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async _tick() {
    const cap = config.deployment.metricsMaxSamples;
    try {
      const all = await ProcessManager.getAllProcessStatus();
      const ts = Date.now();
      // Only sample online processes: `pm2 stop` leaves a process in jlist with
      // monit:{cpu:0,memory:0}, so sampling stopped apps would push misleading
      // zero-samples + a growing uptime. Absence of new rows freezes an app's
      // history at its last good sample.
      for (const p of all.filter(x => x.status === 'online')) {
        await queries.insertMetric(p.name, {
          ts,
          cpu: p.cpu,
          memory: p.memory,
          uptimeMs: p.uptime ? ts - p.uptime : 0,
        });
        await queries.pruneMetrics(p.name, cap);
      }
    } catch (err) {
      // PM2 unavailable or jlist failed — warn and skip; never crash the loop.
      console.warn(`MetricsSampler tick failed: ${err.message}`);
    }
  }

  /** Latest sample for an app, or null (stopped/never seen). */
  async getLatest(name) {
    const row = await queries.getLatestMetric(name);
    if (!row) return null;
    return { ts: row.ts, cpu: row.cpu, memory: row.memory, uptimeMs: row.uptime_ms };
  }

  /** Sample history for an app, oldest first (empty array if none). */
  async getHistory(name) {
    const rows = await queries.getMetricHistory(name);
    return rows.map(r => ({ ts: r.ts, cpu: r.cpu, memory: r.memory, uptimeMs: r.uptime_ms }));
  }
}

module.exports = new MetricsSampler();
