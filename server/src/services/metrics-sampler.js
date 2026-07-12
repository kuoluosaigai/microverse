const config = require('../config');
const ProcessManager = require('./process-manager');

/**
 * MetricsSampler — boot-started background sampler. Polls PM2 once per tick for
 * ALL processes and keeps an in-memory ring buffer of recent resource samples
 * per app. Decouples PM2 from the request path: GET /api/apps reads the buffer,
 * not PM2. Exported as a singleton instance.
 *
 * Sample = { ts:number(epoch ms), cpu:number(%), memory:number(bytes), uptimeMs:number }
 */
class MetricsSampler {
  constructor() {
    /** @type {Map<string, Array<{ts:number,cpu:number,memory:number,uptimeMs:number}>>} */
    this.buffers = new Map();
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    const cap = config.deployment.metricsMaxSamples;
    // Tick immediately so data appears without waiting a full interval.
    this._tick(cap);
    this.timer = setInterval(() => this._tick(cap), config.deployment.metricsIntervalMs);
    if (this.timer.unref) this.timer.unref(); // don't keep the process alive solely for sampling
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async _tick(cap) {
    try {
      const all = await ProcessManager.getAllProcessStatus();
      const ts = Date.now();
      // Only sample online processes: `pm2 stop` leaves a process in jlist with
      // monit:{cpu:0,memory:0}, so sampling stopped apps would push misleading
      // zero-samples + a growing uptime. Filtering freezes the buffer at the
      // last good sample when an app stops.
      for (const p of all.filter(x => x.status === 'online')) {
        const sample = {
          ts,
          cpu: p.cpu,
          memory: p.memory,
          uptimeMs: p.uptime ? ts - p.uptime : 0
        };
        const buf = this.buffers.get(p.name);
        if (buf) {
          buf.push(sample);
          if (buf.length > cap) buf.shift();
        } else {
          this.buffers.set(p.name, [sample]);
        }
      }
    } catch (err) {
      // PM2 unavailable or jlist failed — warn and skip; never crash the loop.
      console.warn(`MetricsSampler tick failed: ${err.message}`);
    }
  }

  /** Latest sample for an app, or null (stopped/never seen). */
  getLatest(name) {
    const buf = this.buffers.get(name);
    if (!buf || buf.length === 0) return null;
    return buf[buf.length - 1];
  }

  /** Copy of the sample history for an app (empty array if none). */
  getHistory(name) {
    const buf = this.buffers.get(name);
    return buf ? buf.slice() : [];
  }
}

module.exports = new MetricsSampler();
