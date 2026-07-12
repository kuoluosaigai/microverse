# App Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose PM2's per-app CPU/memory/uptime as a resource-monitoring dashboard — inline current values on the Dashboard rows + a dedicated Metrics page with hand-rolled SVG sparkline history.

**Architecture:** A boot-started `MetricsSampler` singleton polls PM2 once per 10s tick into an in-memory ring buffer (180 samples ≈ 30min), decoupling PM2 from the request path. `GET /api/apps` attaches the latest sample; a new `GET /api/apps/:id/metrics` returns the history array. The frontend polls these (no SSE — metrics are low-frequency) and renders tiles + zero-dependency SVG sparklines.

**Tech Stack:** Node.js, Express, PM2 (`pm2 jlist`), React + Ant Design + react-i18next. No new frontend dependency.

## Global Constraints

- **No test framework.** Verify via `node -e` one-liners (backend units) and `curl` (backend integration) and `npm run lint` (frontend). Absence of jest is NOT a defect.
- **Cross-platform paths:** `path.join` everywhere.
- **Database is async (`sqlite3`):** always `await` query calls.
- **Commit on `main`** (repo convention). English commit messages ending `Co-Authored-By: Claude <noreply@anthropic.com>`.
- **App shape change is additive:** `GET /api/apps` gains an optional `metrics` field — backward compatible.
- **Editorial UI vars:** `--paper`, `--paper-hover`, `--ink`, `--ink-2`, `--ink-3`, `--accent`, `--rule`, `--surface`, `--idle`, `--serif`, `--mono`. Mono = uppercase letterspaced labels; serif = values/titles; hairline = `1px solid var(--rule)`.
- **Windows dev server:** restarting the backend leaves port 5000 bound; `taskkill /PID <pid> /F` the holder before relaunch.

## File Structure

**Create (backend):** `server/src/services/metrics-sampler.js` — boot-started sampler, in-memory ring buffer, singleton export.

**Create (frontend):** `client/src/components/Sparkline.jsx` (pure SVG, no dep); `client/src/pages/AppMetrics.jsx` (metrics page, mirrors AppLogs).

**Modify (backend):** `server/src/services/process-manager.js` (`getAllProcessStatus` + `getProcessStatus` delegates); `server/src/routes/index.js` (attach `metrics` + new `/metrics` route); `server/src/app.js` (start/stop sampler); `server/src/config/index.js` + `.env.example` (two knobs); `server/src/docs/openapi.yaml`.

**Modify (frontend):** `client/src/App.jsx` (route); `client/src/components/AppRow.jsx` (Metrics button + inline cell); `client/src/pages/Dashboard.jsx` (10s auto-refresh); `client/src/api/apps.js` (`getAppMetrics`); `client/src/i18n/locales/{zh,en}.json`; `client/src/styles/editorial.css`.

**Modify (docs):** `PROGRESS.md`, `README.md`.

---

## Task 1: Backend foundation — config + `getAllProcessStatus` + `MetricsSampler`

**Files:**
- Modify: `server/src/config/index.js` (deployment tail)
- Modify: `.env.example`
- Modify: `server/src/services/process-manager.js` (add `getAllProcessStatus`; refactor `getProcessStatus`)
- Create: `server/src/services/metrics-sampler.js`

**Interfaces:**
- Produces: `config.deployment.metricsIntervalMs` (default 10000), `config.deployment.metricsMaxSamples` (default 180); `ProcessManager.getAllProcessStatus()` → `Promise<Array<{name,status,pid,uptime,memory,cpu}>>`; `metricsSampler` singleton with `.start()` / `.stop()` / `.getLatest(name)` / `.getHistory(name)`. Consumed by Task 2.

- [ ] **Step 1: Add metrics config knobs**

In `server/src/config/index.js`, replace:

```js
    // nginx binary path (default 'nginx' = PATH; set NGINX_BIN for non-PATH installs)
    nginxBin: process.env.NGINX_BIN || 'nginx'
  },
```

with:

```js
    // nginx binary path (default 'nginx' = PATH; set NGINX_BIN for non-PATH installs)
    nginxBin: process.env.NGINX_BIN || 'nginx',

    // metrics sampler (resource monitoring): PM2 poll interval + ring-buffer cap
    metricsIntervalMs: parseInt(process.env.METRICS_INTERVAL_MS) || 10000,
    metricsMaxSamples: parseInt(process.env.METRICS_MAX_SAMPLES) || 180
  },
```

- [ ] **Step 2: Add knobs to `.env.example`**

Replace:

```env
# nginx binary path for the nginx deploy type (default 'nginx' = PATH)
# On Windows set the full path, e.g. NGINX_BIN=D:\nginx\nginx.exe
NGINX_BIN=nginx

# PM2 Configuration
```

with:

```env
# nginx binary path for the nginx deploy type (default 'nginx' = PATH)
# On Windows set the full path, e.g. NGINX_BIN=D:\nginx\nginx.exe
NGINX_BIN=nginx

# Metrics sampler (resource monitoring): poll interval (ms) + ring-buffer cap (samples)
METRICS_INTERVAL_MS=10000
METRICS_MAX_SAMPLES=180

# PM2 Configuration
```

- [ ] **Step 3: Add `getAllProcessStatus` + refactor `getProcessStatus`**

In `server/src/services/process-manager.js`, replace the existing `getProcessStatus` method:

```js
  /**
   * Get process status
   */
  static async getProcessStatus(appName) {
    try {
      const { stdout } = await execPromise(`pm2 jlist`);
      const processes = JSON.parse(stdout);

      const process = processes.find(p => p.name === appName);

      if (!process) {
        return { exists: false };
      }

      return {
        exists: true,
        status: process.pm2_env.status,
        pid: process.pid,
        uptime: process.pm2_env.pm_uptime,
        memory: process.monit.memory,
        cpu: process.monit.cpu
      };
    } catch (error) {
      throw new Error(`Failed to get process status: ${error.message}`);
    }
  }
```

with:

```js
  /**
   * Get status for ALL PM2 processes in one `pm2 jlist` call.
   * Used by MetricsSampler (one call per tick covers every app).
   * @returns {Promise<Array<{name:string,status:string,pid:number,uptime:number,memory:number,cpu:number}>>}
   */
  static async getAllProcessStatus() {
    try {
      const { stdout } = await execPromise('pm2 jlist');
      const processes = JSON.parse(stdout);
      return processes.map(p => ({
        name: p.name,
        status: p.pm2_env.status,
        pid: p.pid,
        uptime: p.pm2_env.pm_uptime,
        memory: p.monit.memory,
        cpu: p.monit.cpu
      }));
    } catch (error) {
      throw new Error(`Failed to list PM2 processes: ${error.message}`);
    }
  }

  /**
   * Get process status for a single app by name. Delegates to getAllProcessStatus.
   * @returns {Promise<{exists:false}|{exists:true,status,pid,uptime,memory,cpu}>}
   */
  static async getProcessStatus(appName) {
    const all = await this.getAllProcessStatus();
    const p = all.find(x => x.name === appName);
    if (!p) {
      return { exists: false };
    }
    return {
      exists: true,
      status: p.status,
      pid: p.pid,
      uptime: p.uptime,
      memory: p.memory,
      cpu: p.cpu
    };
  }
```

(The returned shape is identical to the old `getProcessStatus`, so `syncAppStatus` / `getAppStatus` callers are unaffected.)

- [ ] **Step 4: Create `server/src/services/metrics-sampler.js`**

Full file content:

```js
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
      for (const p of all) {
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
```

- [ ] **Step 5: Verify ring-buffer logic + module loads (no PM2 needed)**

From `server/`:

```bash
cd server
node -e '
const pm = require("./src/services/process-manager");
const s = require("./src/services/metrics-sampler");
if (typeof pm.getAllProcessStatus !== "function") throw new Error("getAllProcessStatus missing");
if (typeof pm.getProcessStatus !== "function") throw new Error("getProcessStatus missing");
["start","stop","getLatest","getHistory"].forEach(k => { if (typeof s[k] !== "function") throw new Error("sampler."+k+" missing"); });
// Exercise ring-buffer cap + accessors directly (no PM2).
const cap = 5;
s.buffers.set("demo", []);
for (let i = 0; i < 7; i++) { const b = s.buffers.get("demo"); b.push({ts:i,cpu:i*10,memory:i*1000,uptimeMs:i}); if (b.length > cap) b.shift(); }
const h = s.getHistory("demo");
if (h.length !== cap) throw new Error("cap failed: len=" + h.length);
if (h[0].ts !== 2) throw new Error("oldest should be ts=2, got " + h[0].ts);
if (s.getLatest("demo").ts !== 6) throw new Error("latest should be ts=6");
if (s.getLatest("nope") !== null) throw new Error("missing latest should be null");
if (s.getHistory("nope").length !== 0) throw new Error("missing history should be []");
console.log("MetricsSampler + ProcessManager methods OK");
'
```

Expected: `MetricsSampler + ProcessManager methods OK`.

- [ ] **Step 6: Commit**

```bash
git add server/src/config/index.js .env.example server/src/services/process-manager.js server/src/services/metrics-sampler.js
git commit -m "feat(monitoring): add MetricsSampler + getAllProcessStatus + config knobs

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Backend endpoints + sampler wiring + openapi

**Files:**
- Modify: `server/src/routes/index.js` (require sampler; attach `metrics` to `GET /apps` + `GET /apps/:id`; new `GET /apps/:id/metrics`)
- Modify: `server/src/app.js` (require sampler; `start()` in listen; `stop()` on SIGTERM/SIGINT)
- Modify: `server/src/docs/openapi.yaml`

**Interfaces:**
- Consumes: Task 1's `metricsSampler` singleton + `getAllProcessStatus`.
- Produces: `GET /api/apps` and `GET /api/apps/:id` return apps with an added `metrics` field (object or null); new `GET /api/apps/:id/metrics` → `{ success, data: Sample[] }`.

- [ ] **Step 1: Attach metrics + add metrics-history route**

In `server/src/routes/index.js`, add to the top requires (after `const LogManager = require('../services/log-manager');`):

```js
const metricsSampler = require('../services/metrics-sampler');
```

Replace the `GET /apps` handler:

```js
// Get all applications
router.get('/apps', async (req, res, next) => {
  try {
    const apps = await AppManager.getAllApps();

    res.json({
      success: true,
      data: apps
    });
  } catch (error) {
    next(error);
  }
});
```

with:

```js
// Get all applications (with latest resource metrics attached)
router.get('/apps', async (req, res, next) => {
  try {
    const apps = await AppManager.getAllApps();
    const withMetrics = apps.map(app => ({
      ...app,
      metrics: metricsSampler.getLatest(app.name)
    }));

    res.json({
      success: true,
      data: withMetrics
    });
  } catch (error) {
    next(error);
  }
});
```

Replace the `GET /apps/:id` handler:

```js
// Get application by ID
router.get('/apps/:id', async (req, res, next) => {
  try {
    const app = await AppManager.getAppById(req.params.id);

    res.json({
      success: true,
      data: app
    });
  } catch (error) {
    if (error.message === 'App not found') {
      return res.status(404).json({
        success: false,
        error: { message: error.message }
      });
    }
    next(error);
  }
});
```

with:

```js
// Get application by ID (with latest resource metrics attached)
router.get('/apps/:id', async (req, res, next) => {
  try {
    const app = await AppManager.getAppById(req.params.id);

    res.json({
      success: true,
      data: { ...app, metrics: metricsSampler.getLatest(app.name) }
    });
  } catch (error) {
    if (error.message === 'App not found') {
      return res.status(404).json({
        success: false,
        error: { message: error.message }
      });
    }
    next(error);
  }
});
```

Add the new metrics-history route immediately after the `GET /apps/:id` handler (before `// Start application`):

```js
// Get application resource-metrics history
router.get('/apps/:id/metrics', async (req, res, next) => {
  try {
    const app = await AppManager.getAppById(req.params.id);
    const history = metricsSampler.getHistory(app.name);
    res.json({ success: true, data: history });
  } catch (error) {
    if (error.message === 'App not found') {
      return res.status(404).json({
        success: false,
        error: { message: error.message }
      });
    }
    next(error);
  }
});
```

- [ ] **Step 2: Start/stop the sampler in `app.js`**

In `server/src/app.js`, add to the top requires (after `const NginxLifecycle = require('./services/nginx-lifecycle');`):

```js
const metricsSampler = require('./services/metrics-sampler');
```

In the `app.listen` callback, after the nginx probe block, add (before the closing `});` of the listen callback):

```js

  // Start the resource-metrics sampler (10s default; decouples PM2 from requests).
  metricsSampler.start();
```

In both the `SIGTERM` and `SIGINT` handlers, add `metricsSampler.stop();` as the first line inside each handler (before `console.log(...)`). For example, the SIGTERM handler becomes:

```js
process.on('SIGTERM', () => {
  metricsSampler.stop();
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
```

(and the identical `metricsSampler.stop();` first line in the `SIGINT` handler).

- [ ] **Step 3: OpenAPI — `App.metrics` + new endpoint**

In `server/src/docs/openapi.yaml`, inside the `App` schema's `properties:` (after the `status:` block, before `created_at:`), add a `metrics` property:

```yaml
        metrics:
          type: object
          nullable: true
          description: Latest resource sample (null if the app has never run / sampler has no data).
          properties:
            ts: { type: integer, description: "epoch ms" }
            cpu: { type: number, description: "CPU %" }
            memory: { type: integer, description: "bytes" }
            uptimeMs: { type: integer, description: "uptime in ms" }
```

Then register the new endpoint. Add this operation among the other `/apps/{id}` GET operations (e.g. right after the `/apps/{id}/files` block — match the existing path/operation style; paths use `{id}` and `tags: [Applications]`):

```yaml
  /apps/{id}/metrics:
    get:
      tags: [Applications]
      summary: Get an app's resource-metrics history
      description: Returns the in-memory ring buffer of recent CPU/memory samples (default last 30 min, 10s interval).
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: integer }
      responses:
        '200':
          description: Sample array (newest last)
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, example: true }
                  data:
                    type: array
                    items:
                      type: object
                      properties:
                        ts: { type: integer }
                        cpu: { type: number }
                        memory: { type: integer }
                        uptimeMs: { type: integer }
        '404':
          description: App not found
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }
```

(If the file uses `application/json` without the escaped slash, match whatever the surrounding operations use.)

- [ ] **Step 4: Integration-verify (always runnable; no app needs to be running)**

Free port 5000 if held, then start the backend in the background and curl:

```bash
cd server && npm run dev   # background or separate terminal
curl -s http://localhost:5000/api/apps | head -c 400
```

Expected: a JSON object whose `data` is an array; each app object now has a `"metrics"` key (value `null` for stopped/never-run apps, or an object once the sampler has ticked). Then:

```bash
# pick an <id> from the list above (any app, running or not)
curl -s http://localhost:5000/api/apps/<id>/metrics
```

Expected: `{ "success": true, "data": [ ... ] }` — `data` is `[]` for an app with no samples. Also confirm `/api-docs` still loads (openapi parses): `curl -s http://localhost:5000/openapi.json | head -c 80` returns JSON.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/index.js server/src/app.js server/src/docs/openapi.yaml
git commit -m "feat(monitoring): expose metrics on /apps + new /apps/:id/metrics, wire sampler

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Frontend — Sparkline + Metrics page + route + entry button + i18n + css

**Files:**
- Create: `client/src/components/Sparkline.jsx`
- Create: `client/src/pages/AppMetrics.jsx`
- Modify: `client/src/App.jsx` (import + route)
- Modify: `client/src/components/AppRow.jsx` (Metrics action button)
- Modify: `client/src/api/apps.js` (`getAppMetrics`)
- Modify: `client/src/i18n/locales/en.json` + `zh.json`
- Modify: `client/src/styles/editorial.css`

**Interfaces:**
- Consumes: Task 2's `GET /api/apps/:id/metrics`.
- Produces: `/apps/:id/metrics` route + page; a "Metrics" entry button on each app row.

- [ ] **Step 1: Create `client/src/components/Sparkline.jsx`**

```jsx
/**
 * Minimal SVG sparkline. Zero dependencies. Editorial: thin line, single accent,
 * no axes (the "now" value is shown by the tiles beside it).
 *
 * props:
 *   data: number[]       samples (oldest → newest)
 *   width, height        svg box (default 120 × 32)
 *   color                stroke (CSS var; default --accent)
 *   max?                 fixed upper bound (e.g. 100 for CPU%); omitted → data max
 */
function Sparkline({ data = [], width = 120, height = 32, color = 'var(--accent)', max }) {
  const n = data.length

  if (n === 0) {
    return (
      <svg className="sparkline" width={width} height={height} aria-hidden="true">
        <line x1={0} y1={height / 2} x2={width} y2={height / 2}
          stroke="var(--rule)" strokeWidth={1} />
      </svg>
    )
  }

  const lo = Math.min(...data)
  const hi = max !== undefined ? max : Math.max(...data)
  const span = hi - lo || 1

  let points
  if (n < 2) {
    const y = (height - ((data[0] - lo) / span) * height).toFixed(1)
    points = `0,${y} ${width},${y}`
  } else {
    points = data
      .map((v, i) => {
        const x = ((i / (n - 1)) * width).toFixed(1)
        const y = (height - ((v - lo) / span) * height).toFixed(1)
        return `${x},${y}`
      })
      .join(' ')
  }

  return (
    <svg className="sparkline" width={width} height={height} preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke={color}
        strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export default Sparkline
```

- [ ] **Step 2: Add `getAppMetrics` to the API client**

In `client/src/api/apps.js`, add (e.g. after `getAppFiles`):

```js
/**
 * Get an application's resource-metrics history (resource samples, newest last).
 */
export const getAppMetrics = async (id) => {
  const response = await api.get(`/apps/${id}/metrics`)
  return response.data.data
}
```

- [ ] **Step 3: Create `client/src/pages/AppMetrics.jsx`**

```jsx
import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import EditorialShell from '../components/EditorialShell'
import Sparkline from '../components/Sparkline'
import { getAppById, getAppMetrics } from '../api/apps'

const POLL_MS = 10000

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatUptime(ms) {
  if (!ms || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function AppMetrics() {
  const navigate = useNavigate()
  const { id } = useParams()
  const { t } = useTranslation()

  const [app, setApp] = useState(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [history, setHistory] = useState([])
  const [stale, setStale] = useState(false)

  // Resolve the app once.
  useEffect(() => {
    let alive = true
    getAppById(id)
      .then((a) => { if (alive) setApp(a) })
      .catch(() => { if (alive) setLoadFailed(true) })
    return () => { alive = false }
  }, [id])

  // Poll metrics every POLL_MS; keep last data + flag stale on error.
  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const data = await getAppMetrics(id)
        if (alive) { setHistory(data); setStale(false) }
      } catch {
        if (alive) setStale(true)
      }
    }
    poll()
    const timer = setInterval(poll, POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [id])

  const latest = history.length > 0 ? history[history.length - 1] : null

  if (loadFailed) {
    return (
      <EditorialShell>
        <div className="empty">
          <h2>{t('appMetrics.loadError')}</h2>
        </div>
      </EditorialShell>
    )
  }

  return (
    <EditorialShell>
      <button className="back-link" onClick={() => navigate('/')}>
        ← {t('common.back')}
      </button>
      <h1 className="page-title">
        {t('appMetrics.title')}{app ? ` — ${app.name}` : ''}
      </h1>
      <div className="lead">
        {t('appMetrics.lead')}
        {stale && <span className="metrics-stale"> · {t('appMetrics.stale')}</span>}
      </div>

      <div className="metrics-tiles">
        <div className="metric-tile">
          <div className="metric-label">{t('appMetrics.cpu')}</div>
          <div className="metric-value">{latest ? `${latest.cpu.toFixed(1)}%` : '—'}</div>
        </div>
        <div className="metric-tile">
          <div className="metric-label">{t('appMetrics.memory')}</div>
          <div className="metric-value">{latest ? formatBytes(latest.memory) : '—'}</div>
        </div>
        <div className="metric-tile">
          <div className="metric-label">{t('appMetrics.uptime')}</div>
          <div className="metric-value">{latest ? formatUptime(latest.uptimeMs) : '—'}</div>
        </div>
      </div>

      {history.length === 0 ? (
        <div className="metrics-empty">{t('appMetrics.empty')}</div>
      ) : (
        <div className="metrics-charts">
          <div className="metric-chart">
            <div className="metric-chart-label">{t('appMetrics.cpu')}</div>
            <Sparkline data={history.map((h) => h.cpu)} max={100} />
          </div>
          <div className="metric-chart">
            <div className="metric-chart-label">{t('appMetrics.memory')}</div>
            <Sparkline data={history.map((h) => h.memory)} />
          </div>
        </div>
      )}
    </EditorialShell>
  )
}

export default AppMetrics
```

- [ ] **Step 4: Register the route in `client/src/App.jsx`**

Add the import (after `import AppLogs from './pages/AppLogs'`):

```jsx
import AppMetrics from './pages/AppMetrics'
```

Add the route (after the `<Route path="/apps/:id/logs" ...>` line):

```jsx
        <Route path="/apps/:id/metrics" element={<AppMetrics />} />
```

- [ ] **Step 5: Add the Metrics entry button in `AppRow.jsx`**

In `client/src/components/AppRow.jsx`, add a Metrics button in the `acts` div, right after the Logs button:

```jsx
          <button className="act" onClick={() => navigate(`/apps/${app.id}/logs`)}>
            {t('appCard.logs')}
          </button>
          <button className="act" onClick={() => navigate(`/apps/${app.id}/metrics`)}>
            {t('appCard.metrics')}
          </button>
```

- [ ] **Step 6: Add i18n keys (zh + en)**

In `client/src/i18n/locales/zh.json`, inside the `"appCard"` object add (after `"logs": "日志",`):

```json
    "metrics": "监控",
```

And add a new top-level section (e.g. after the `"appLogs"` block):

```json
  "appMetrics": {
    "title": "监控",
    "lead": "资源使用 —— 每 10 秒采样",
    "cpu": "CPU",
    "memory": "内存",
    "uptime": "运行时长",
    "empty": "暂无数据 —— 启动应用后采样会显示在这里。",
    "stale": "数据未更新",
    "loadError": "加载应用失败"
  },
```

In `client/src/i18n/locales/en.json`, mirror it — inside `appCard` add:

```json
    "metrics": "Metrics",
```

and a new section after `appLogs`:

```json
  "appMetrics": {
    "title": "Metrics",
    "lead": "Resource usage — sampled every 10s",
    "cpu": "CPU",
    "memory": "Memory",
    "uptime": "Uptime",
    "empty": "No data yet — start the app and samples will appear here.",
    "stale": "data not updating",
    "loadError": "Failed to load app"
  },
```

- [ ] **Step 7: Add CSS for tiles, charts, sparkline**

Append to `client/src/styles/editorial.css`:

```css
/* ----- Metrics ----- */
.metrics-tiles {
  display: flex; gap: 0; margin-top: 26px; border: 1px solid var(--rule);
}
.metric-tile { flex: 1; padding: 18px 22px; border-right: 1px solid var(--rule); }
.metric-tile:last-child { border-right: none; }
.metric-label { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase;
  letter-spacing: 0.12em; color: var(--ink-3); }
.metric-value { font-family: var(--serif); font-size: 26px; font-weight: 400;
  color: var(--ink); margin-top: 6px; letter-spacing: -0.01em; }
.metrics-charts { display: flex; gap: 32px; margin-top: 28px; flex-wrap: wrap; }
.metric-chart { min-width: 220px; }
.metric-chart-label { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase;
  letter-spacing: 0.12em; color: var(--ink-3); margin-bottom: 8px; }
.sparkline { display: block; }
.metrics-empty { font-family: var(--serif); font-size: 15px; color: var(--ink-3);
  text-align: center; padding: 60px 0; }
.metrics-stale { color: var(--accent); }
```

- [ ] **Step 8: Verify lint + JSON validity**

```bash
cd client && npm run lint
```
Expected: no errors (`--max-warnings 0`). Also confirm both locale files parse:

```bash
node -e "JSON.parse(require('fs').readFileSync('src/i18n/locales/zh.json','utf-8'));JSON.parse(require('fs').readFileSync('src/i18n/locales/en.json','utf-8'));console.log('locales OK')"
```
Expected: `locales OK`.

- [ ] **Step 9: Commit**

```bash
git add client/src/components/Sparkline.jsx client/src/pages/AppMetrics.jsx client/src/App.jsx client/src/components/AppRow.jsx client/src/api/apps.js client/src/i18n/locales/en.json client/src/i18n/locales/zh.json client/src/styles/editorial.css
git commit -m "feat(monitoring): Metrics page + Sparkline + entry button

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Dashboard inline values + 10s auto-refresh

**Files:**
- Modify: `client/src/components/AppRow.jsx` (inline metrics cell)
- Modify: `client/src/pages/Dashboard.jsx` (auto-refresh interval)
- Modify: `client/src/styles/editorial.css` (row grid gains a metrics column)

**Interfaces:**
- Consumes: the `metrics` field now present on each app from `GET /api/apps` (Task 2).

- [ ] **Step 1: Add a metrics column to the AppRow grid**

In `client/src/styles/editorial.css`, replace the `.app-row` grid + the responsive rule:

```css
.app-row {
  display: grid;
  grid-template-columns: 40px minmax(180px,1fr) 140px 150px 80px 1fr;
  align-items: center; gap: 18px;
  padding: 22px 8px; border-bottom: 1px solid var(--rule);
  transition: background .15s;
}
```

with (adds a 130px metrics column between port and kind):

```css
.app-row {
  display: grid;
  grid-template-columns: 40px minmax(160px,1fr) 130px 130px 150px 80px 1fr;
  align-items: center; gap: 16px;
  padding: 22px 8px; border-bottom: 1px solid var(--rule);
  transition: background .15s;
}
```

And replace the responsive collapse:

```css
@media (max-width: 760px) {
  .app-row { grid-template-columns: 30px 1fr; row-gap: 10px; }
  .app-row .port, .app-row .kind, .app-row .status { grid-column: 2; }
  .app-row .acts { grid-column: 1 / -1; justify-content: flex-start; flex-wrap: wrap; }
}
```

with:

```css
@media (max-width: 760px) {
  .app-row { grid-template-columns: 30px 1fr; row-gap: 10px; }
  .app-row .port, .app-row .metrics, .app-row .kind, .app-row .status { grid-column: 2; }
  .app-row .acts { grid-column: 1 / -1; justify-content: flex-start; flex-wrap: wrap; }
}
```

Append the inline-metrics cell style (after the `.app-row .kind { ... }` rule):

```css
.app-row .metrics { font-family: var(--mono); font-size: 11px; color: var(--ink-2); }
.app-row .metrics .lbl { color: var(--ink-3); }
```

- [ ] **Step 2: Render the inline metrics cell in `AppRow.jsx`**

In `client/src/components/AppRow.jsx`, add a small formatter inside the component (near `typeLabel`):

```jsx
  const memShort = (bytes) => {
    if (!bytes && bytes !== 0) return ''
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}K`
    return `${Math.round(bytes / (1024 * 1024))}M`
  }
```

Then add the metrics cell in the row markup, between the `.port` div and the `.kind` div:

```jsx
        <div className="metrics">
          {isRunning && app.metrics ? (
            <span>{app.metrics.cpu.toFixed(1)}% · {memShort(app.metrics.memory)}</span>
          ) : (
            <span className="lbl">—</span>
          )}
        </div>
```

- [ ] **Step 3: Add 10s auto-refresh to `Dashboard.jsx`**

In `client/src/pages/Dashboard.jsx`, add a second `useEffect` right after the existing load-on-mount `useEffect`:

```jsx
  // Silent background refresh every 10s (no spinner; just updates app data incl. metrics).
  useEffect(() => {
    const timer = setInterval(() => loadApps(false), 10000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
```

- [ ] **Step 4: Verify lint**

```bash
cd client && npm run lint
```
Expected: no errors (`--max-warnings 0`).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/AppRow.jsx client/src/pages/Dashboard.jsx client/src/styles/editorial.css
git commit -m "feat(monitoring): Dashboard inline CPU/mem + 10s auto-refresh

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Docs — PROGRESS + README

**Files:**
- Modify: `PROGRESS.md`
- Modify: `README.md`

- [ ] **Step 1: Update `PROGRESS.md`**

(a) In "## 当前状态" → 状态 line, append a mention (optional polish). (Skip if it overcomplicates; the key edits are below.)

(b) Replace the Phase 13 block:

```markdown
### 🎯 Phase 13: 应用监控 (优先级: 低)
- [ ] CPU/内存使用监控
- [ ] 请求统计
- [ ] 错误率监控
- [ ] 告警系统
```

with:

```markdown
### ✅ Phase 13: 应用监控（资源监控部分，2026-07-12）
- [x] CPU/内存/运行时长监控（`MetricsSampler` 10s 采样 + 内存环形缓冲；Dashboard 行内当前值 + 独立 Metrics 页火花线）
- [ ] 请求统计（需反向代理网关层）
- [ ] 错误率监控（需网关层或平台 API 中间件）
- [ ] 告警系统（需阈值规则 + 通知渠道）
```

(c) In the changelog "### [Unreleased] — 2026-07-12" block, under "#### 新增", prepend:

```markdown
- Phase 13（资源监控部分）：新增 `MetricsSampler`（开机启动，10s/tick 单次 `pm2 jlist`，内存环形缓冲 180 样本）；`ProcessManager.getAllProcessStatus` 抽取；`GET /api/apps` 附带 `metrics` + 新 `GET /api/apps/:id/metrics`；前端独立 Metrics 页（数值卡 + 手写 SVG 火花线）+ Dashboard 行内 CPU/内存 + 10s 自动刷新。请求/错误/告警待后续迭代。
```

(d) In "## 下一步计划" → "中期目标", tick monitoring:

```markdown
2. ✅ 应用监控仪表盘 (Phase 13，资源监控部分)
```

- [ ] **Step 2: Update `README.md`**

In the Features list (the bulleted section starting with `## Features`), add a bullet after the "📜 **Live Logs**" line:

```markdown
- 📈 **Resource Metrics**: per-app CPU / memory / uptime — inline on the dashboard and on a dedicated metrics page with sparkline history (sampled every 10s)
```

- [ ] **Step 3: Commit**

```bash
git add PROGRESS.md README.md
git commit -m "docs: app resource monitoring (Phase 13 partial)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Done criteria

- `GET /api/apps` returns each app with a `metrics` field (object or null); `GET /api/apps/:id/metrics` returns a sample array.
- A running app's CPU/memory appear inline on its dashboard row and refresh every 10s; its Metrics page shows tiles + growing sparkline.
- `npm run lint` (client) passes; server boots and the sampler starts/stops with the process.
- `PROGRESS.md` Phase 13 resource-monitoring item ticked; README mentions metrics. Request/error/alerting remain explicitly deferred.
