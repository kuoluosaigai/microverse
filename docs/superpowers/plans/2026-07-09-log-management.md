# Log Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users view a deployed application's PM2 logs (recent history + live stream) from a per-app logs page in the Microverse UI.

**Architecture:** A new `LogManager` service resolves each app's PM2 log-file paths (via `pm2 jlist`, falling back to PM2's default `~/.pm2/logs` location), reads recent history, and `fs.watch`-tails the files for new lines. One SSE endpoint (`GET /api/apps/:id/logs/stream`) emits `history` then `line` events. A new `AppLogs` page opens an `EventSource`, renders the lines (stderr in accent red), follows new output with sticky auto-scroll, and tracks `LIVE` / `IDLE` / `DISCONNECTED` connection state with manual retry. The dead `ProcessManager.getProcessLogs` is removed.

**Tech Stack:** Express (SSE over a plain GET route), Node `fs`/`child_process` (no new backend deps), React + react-router + `EventSource`, react-i18next (zh/en), editorial CSS variables.

## Global Constraints

(Copied verbatim from the spec / project conventions. Every task's requirements include these.)

- **Node >= 18, npm >= 9.** No new dependencies are added by this plan.
- **No test framework.** The project intentionally has no automated tests; verification is manual (exact `curl` commands + browser checks) per the approved spec. Each task ends with a manual verify step and a commit.
- **Backend:** all DB ops are `await`ed; all paths use the `path` module; cross-platform (Windows is the primary platform). PM2 is driven via shell-out (`util.promisify(exec)`), matching the existing `ProcessManager` style.
- **Frontend:** all API calls use relative paths (`/api/...`) — they go through Vite's `/api` proxy in dev. Every user-facing string must be added to **both** `zh.json` and `en.json`. Styling uses the editorial CSS variables (`--paper`, `--ink`, `--accent`, `--rule`, `--mono`, `--serif`, …) defined in `client/src/styles/index.css`.
- **EventSource only supports GET.** The stream endpoint resolves the app *before* writing SSE headers, so "app not found" can be returned as a normal 404 JSON.
- **i18n keys are added once, up front, in Task 4 and Task 6** (see those tasks) so later tasks don't churn the locale files.
- **Routes are mounted at `/api`** (`server/src/app.js` → `app.use('/api', routes)`), so a route defined as `router.get('/apps/:id/logs/stream', …)` is publicly `GET /api/apps/:id/logs/stream`. There is **no compression middleware** in `app.js`, so SSE responses are not buffered server-side.

---

## File Structure

**New files:**
- `server/src/services/log-manager.js` — PM2 log path resolution, history reading, file-tailing. One responsibility: turn an app name into log lines.
- `client/src/pages/AppLogs.jsx` — the logs page (`/apps/:id/logs`).

**Modified files:**
- `server/src/routes/index.js` — add the SSE route.
- `server/src/services/process-manager.js` — remove dead `getProcessLogs`.
- `client/src/App.jsx` — register the `/apps/:id/logs` route.
- `client/src/api/apps.js` — add `appLogsStreamUrl(id, lines)`.
- `client/src/components/AppRow.jsx` — add the `Logs` action.
- `client/src/styles/editorial.css` — log view + connection-indicator styles.
- `client/src/i18n/locales/en.json`, `zh.json` — `appLogs` and `appCard.logs` keys.
- `CLAUDE.md`, `PROGRESS.md`, `README.md` — document the new endpoint/page (Task 7).

---

## Task 1: LogManager — path resolution + history

**Files:**
- Create: `server/src/services/log-manager.js`

**Interfaces:**
- Produces:
  - `LogManager.getLogPaths(appName: string) → Promise<{ outPath: string|null, errPath: string|null }>` — resolves PM2's actual log file paths for the app. Returns `null` for a stream that has no file yet. Never throws for "no logs".
  - `LogManager.readHistory(filePath: string|null, level: 'out'|'err', lines?: number) → Array<{ level, msg }>` — synchronous; returns the last `lines` (default 100) non-empty lines, tagged with `level`. Empty array when the file is missing.

- [ ] **Step 1: Create `log-manager.js` with `getLogPaths` and `readHistory`**

Create `server/src/services/log-manager.js`:

```js
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const execPromise = util.promisify(exec);

/**
 * Log Manager Service
 * Resolves an app's PM2 log files, reads recent history, and tails new lines.
 * No Express knowledge — the route layer composes these primitives.
 */
class LogManager {
  /**
   * Resolve the PM2 out/error log file paths for an app.
   * Reads the real paths from `pm2 jlist`; falls back to PM2's default
   * ~/.pm2/logs/<name>-{out,error}.log when the file exists there.
   * Returns { outPath, errPath } where either may be null (no file yet).
   * Never throws for "no logs".
   */
  static async getLogPaths(appName) {
    try {
      const { stdout } = await execPromise('pm2 jlist');
      const processes = JSON.parse(stdout);
      const proc = processes.find((p) => p.name === appName);
      if (proc && proc.pm2_env) {
        return {
          outPath: proc.pm2_env.pm_out_log_path || null,
          errPath: proc.pm2_env.pm_err_log_path || null,
        };
      }
    } catch (_err) {
      // PM2 not reachable / process not listed — fall through to default paths.
    }

    const dir = path.join(os.homedir(), '.pm2', 'logs');
    const outPath = path.join(dir, `${appName}-out.log`);
    const errPath = path.join(dir, `${appName}-error.log`);
    return {
      outPath: fs.existsSync(outPath) ? outPath : null,
      errPath: fs.existsSync(errPath) ? errPath : null,
    };
  }

  /**
   * Read the last `lines` non-empty lines of a log file, tagged with `level`.
   * Synchronous; returns [] when the file is missing/unreadable.
   */
  static readHistory(filePath, level, lines = 100) {
    if (!filePath || !fs.existsSync(filePath)) return [];
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (_err) {
      return [];
    }
    return content
      .split('\n')
      .filter((l) => l.length > 0)
      .slice(-lines)
      .map((msg) => ({ level, msg }));
  }
}

module.exports = LogManager;
```

- [ ] **Step 2: Start a test app so PM2 creates log files**

Run, from the repo root, with the backend already running (`npm run dev:server` in another terminal):

```bash
# Create + seed + start a throwaway http-server app
curl -X POST http://localhost:5000/api/apps -H "Content-Type: application/json" -d '{"name":"logtest","deploy_type":"http-server"}'
echo "<h1>hi</h1>" > apps/logtest/index.html
curl -X POST http://localhost:5000/api/apps/1/start
# Wait ~3s for http-server to boot and write startup lines, then:
curl http://localhost:5000/api/apps/1/start   # harmless re-hit; ignore "already running"
```

Confirm the app is `running`: `curl -s http://localhost:5000/api/apps | python -m json.tool` shows `logtest` with `status: "running"`.

- [ ] **Step 3: Verify `getLogPaths` + `readHistory` from a Node snippet**

Run from the `server/` directory:

```bash
cd server
node -e "const L=require('./src/services/log-manager');(async()=>{const p=await L.getLogPaths('logtest');console.log('PATHS',p);console.log('OUT',L.readHistory(p.outPath,'out',20));console.log('ERR',L.readHistory(p.errPath,'err',20));})()"
```

Expected: `PATHS { outPath: 'C:\\Users\\...\\.pm2\\logs\\logtest-out.log', errPath: '...\\logtest-error.log' }` (real paths from `pm2 jlist`), and `OUT` prints an array of `{ level: 'out', msg: '...' }` objects containing http-server's startup banner (e.g. `Starting up http-server` / `http-server version` / `Available on:`). `ERR` is likely `[]` (no errors yet) or a small array.

If `PATHS` is `{ outPath: null, errPath: null }`, the app didn't actually start — re-check Step 2 (app must be running so PM2 has it in its list).

- [ ] **Step 4: Commit**

```bash
git add server/src/services/log-manager.js
git commit -m "feat(logs): LogManager — resolve PM2 log paths + read history"
```

---

## Task 2: LogManager — live tailer

**Files:**
- Modify: `server/src/services/log-manager.js` (add `createTailer`)

**Interfaces:**
- Consumes: `fs`, `path` (already required in Task 1).
- Produces:
  - `LogManager.createTailer(filePath: string|null, level: 'out'|'err', onLine: ({level,msg}) => void) → { stop: () => void }` — watches `filePath` with `fs.watch`; for each new appended chunk, splits on `\n`, calls `onLine` for each complete line (keeping any trailing partial line buffered for the next chunk). Tracks byte offsets so it is idempotent under `fs.watch` firing multiple times, and resets on truncation/rotation (`pm2 flush`). Returns a no-op `{ stop }` when `filePath` is null/missing.

- [ ] **Step 1: Add `createTailer` to `LogManager`**

In `server/src/services/log-manager.js`, insert this method **before** the closing `}` of the class (i.e. after `readHistory`, before `module.exports`):

```js
  /**
   * Watch a log file and call onLine({level,msg}) for each newly appended line.
   * - Byte-offset incremental reads: idempotent under fs.watch's multi-fire.
   * - Line buffer: a write split across two watch callbacks never yields a
   *   half-line; only complete (newline-terminated) lines are emitted.
   * - Truncation/rotation (e.g. `pm2 flush`): resets offset to 0.
   * Returns { stop() } — no-op when filePath is null/missing. Safe to call stop() twice.
   */
  static createTailer(filePath, level, onLine) {
    if (!filePath || !fs.existsSync(filePath)) {
      return { stop() {} };
    }

    let lastSize = fs.statSync(filePath).size;
    let buffer = '';
    let watcher = null;
    let stopped = false;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (watcher) {
        watcher.removeAllListeners();
        try { watcher.close(); } catch (_e) { /* ignore */ }
      }
    };

    const readNew = () => {
      if (stopped) return;

      let size;
      try {
        size = fs.statSync(filePath).size;
      } catch (_err) {
        stop(); // file deleted under us
        return;
      }

      if (size < lastSize) {
        // truncated / rotated — restart from the top
        lastSize = 0;
        buffer = '';
      }

      const length = size - lastSize;
      if (length <= 0) return; // no new bytes (fs.watch noise)

      let fd;
      try {
        fd = fs.openSync(filePath, 'r');
        const chunk = Buffer.alloc(length);
        fs.readSync(fd, chunk, 0, length, lastSize);
        buffer += chunk.toString('utf8');

        const parts = buffer.split('\n');
        buffer = parts.pop(); // keep trailing partial line
        for (const line of parts) {
          if (line.length) onLine({ level, msg: line });
        }
        lastSize = size;
      } catch (_err) {
        stop();
      } finally {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch (_e) { /* ignore */ }
        }
      }
    };

    try {
      watcher = fs.watch(filePath, () => readNew());
      watcher.on('error', () => stop());
    } catch (_err) {
      stop();
    }

    return { stop };
  }
```

- [ ] **Step 2: Verify the tailer against a temp file**

Run from the `server/` directory:

```bash
cd server
node -e "const fs=require('fs'),L=require('./src/services/log-manager');const f='./__tailtest.log';fs.writeFileSync(f,'first\n');const t=L.createTailer(f,'out',(l)=>console.log('LINE',JSON.stringify(l)));setTimeout(()=>{fs.appendFileSync(f,'second\n');fs.appendFileSync(f,'partial-');setTimeout(()=>{fs.appendFileSync(f,'line\n');},200);},300);setTimeout(()=>{console.log('TRUNCATE');fs.writeFileSync(f,'after-flush\n');},900);setTimeout(()=>{t.stop();fs.unlinkSync(f);console.log('DONE');},1500);"
```

Expected output (the timestamps are just the sequence):
```
LINE {"level":"out","msg":"second"}
LINE {"level":"out","msg":"partial-line"}
TRUNCATE
LINE {"level":"out","msg":"after-flush"}
DONE
```

This confirms: new appends are emitted (`second`), a line split across two writes is reassembled (`partial-line`), and after truncation the new content still streams (`after-flush`). `first` (written before the tailer attached) is NOT emitted — history is not the tailer's job.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/log-manager.js
git commit -m "feat(logs): LogManager — fs.watch tailer with byte-offset + line buffer"
```

---

## Task 3: SSE route + remove dead `getProcessLogs`

**Files:**
- Modify: `server/src/routes/index.js` (add `GET /apps/:id/logs/stream`, require `LogManager`)
- Modify: `server/src/services/process-manager.js` (delete `getProcessLogs`)

**Interfaces:**
- Consumes: `AppManager.getAppById` (existing), `LogManager.getLogPaths` / `readHistory` / `createTailer` (Tasks 1–2).
- Produces: `GET /api/apps/:id/logs/stream?lines=100` — SSE. Emits `event: history` once (`data: { lines: [{level,msg}] }`), then `event: line` per new line (`data: { level, msg, ts }`), a `: ping` comment every 15 s, and `event: error` (`data: { message }`) on unexpected failure. Returns 404 JSON when the app id doesn't exist (before SSE headers).

- [ ] **Step 1: Require LogManager at the top of the routes file**

In `server/src/routes/index.js`, add to the existing require block at the top (after `const config = require('../config');` on line 9):

```js
const LogManager = require('../services/log-manager');
```

- [ ] **Step 2: Add the SSE route**

In `server/src/routes/index.js`, insert this route **immediately after** the existing `GET /apps/:id/files` handler (the one ending around line 245, right before the `// File upload route` comment):

```js
// Stream an app's PM2 logs as SSE (recent history + live).
router.get('/apps/:id/logs/stream', async (req, res, next) => {
  // 1. Resolve the app BEFORE writing SSE headers so 404 is clean JSON.
  let app;
  try {
    app = await AppManager.getAppById(req.params.id);
  } catch (error) {
    if (error.message === 'App not found') {
      return res.status(404).json({
        success: false,
        error: { message: error.message },
      });
    }
    return next(error);
  }

  // 2. Parse + clamp requested history size.
  const requested = parseInt(req.query.lines, 10);
  const lines = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, 1000)
    : 100;

  // 3. SSE headers + flush so the client connects immediately.
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Guarded writer — never throws after the client has gone away.
  const send = (event, data) => {
    if (res.writableEnded) return;
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (_err) {
      /* client gone — req 'close' will clean up */
    }
  };

  let cleaned = false;
  const cleanup = (tailers, heartbeat) => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    tailers.forEach((t) => t.stop());
  };

  try {
    const paths = await LogManager.getLogPaths(app.name);

    // 4. History: out first, then err (PM2 logs aren't timestamped, so exact
    //    chronological merge of past lines isn't possible — live lines stream
    //    in true order with a server send timestamp).
    const history = [
      ...LogManager.readHistory(paths.outPath, 'out', lines),
      ...LogManager.readHistory(paths.errPath, 'err', lines),
    ];
    send('history', { lines: history });

    // 5. Live tail both streams.
    const tailers = [
      LogManager.createTailer(paths.outPath, 'out', ({ level, msg }) =>
        send('line', { level, msg, ts: Date.now() })
      ),
      LogManager.createTailer(paths.errPath, 'err', ({ level, msg }) =>
        send('line', { level, msg, ts: Date.now() })
      ),
    ];

    // 6. Keep-alive heartbeat.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);

    // 7. Clean up on disconnect — single path, no watcher/timer leaks.
    req.on('close', () => cleanup(tailers, heartbeat));
    req.on('error', () => cleanup(tailers, heartbeat));
  } catch (error) {
    send('error', { message: error.message || 'Failed to stream logs' });
    try { res.end(); } catch (_e) { /* ignore */ }
  }
});
```

- [ ] **Step 3: Remove the dead `getProcessLogs` from ProcessManager**

In `server/src/services/process-manager.js`, delete the entire `getProcessLogs` method (the block including its JSDoc, currently around lines 230–240):

```js
  /**
   * Get process logs
   */
  static async getProcessLogs(appName, lines = 50) {
    try {
      const { stdout } = await execPromise(`pm2 logs "${appName}" --lines ${lines} --nostream`);
      return stdout;
    } catch (error) {
      throw new Error(`Failed to get process logs: ${error.message}`);
    }
  }
```

(Leave the surrounding methods — `getProcessStatus` above it and `isPortAvailable` below it — untouched.)

- [ ] **Step 4: Verify the endpoint end-to-end with curl**

With the backend running and the `logtest` app from Task 1 still started (id `1`, running):

```bash
# History arrives first, then the connection stays open for live + heartbeats.
curl -N "http://localhost:5000/api/apps/1/logs/stream?lines=20"
```

Expected: within the first second you see

```
event: history
data: {"lines":[{"level":"out","msg":"...http-server startup lines..."}]}

```

Leave it open. In a **second terminal**, drive new output by hitting the app a few times (each http-server request logs a line):

```bash
curl http://localhost:<logtest-port>/    # find the port in the dashboard / GET /api/apps
curl http://localhost:<logtest-port>/
```

Back in the first terminal, new `event: line` / `data: {"level":"out","msg":"[...] GET /" ...,"ts":...}` blocks appear within ~1 s. If you wait 15 s with no output, a `: ping` line appears. Press Ctrl+C to stop.

Then verify the 404 path (note: returns JSON, not SSE, because app resolution happens before headers):

```bash
curl -i http://localhost:5000/api/apps/999999/logs/stream
```

Expected: `HTTP/1.1 404 ...` with body `{"success":false,"error":{"message":"App not found"}}`.

- [ ] **Step 5: Verify the server still boots and lint is clean**

```bash
cd server && npm run dev   # boots without "LogManager is not defined" / syntax errors; Ctrl+C once you see the banner
cd ../client && npm run lint
```

Expected: server prints the `Microverse Server` banner; ESLint reports no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/index.js server/src/services/process-manager.js
git commit -m "feat(logs): SSE /api/apps/:id/logs/stream; remove dead getProcessLogs"
```

---

## Task 4: AppLogs page — connect, history, live, auto-scroll (frontend core)

**Files:**
- Create: `client/src/pages/AppLogs.jsx`
- Modify: `client/src/App.jsx` (register route + import)
- Modify: `client/src/api/apps.js` (add `appLogsStreamUrl`)
- Modify: `client/src/i18n/locales/en.json`, `zh.json` (add the full `appLogs` block)
- Modify: `client/src/styles/editorial.css` (log view styles)

**Interfaces:**
- Consumes: `GET /api/apps/:id` (existing `getAppById`), the SSE endpoint from Task 3, `EditorialShell`, i18n `t()`.
- Produces: the `/apps/:id/logs` route rendering a live-tailing log view.

> **i18n note:** This task adds the *entire* `appLogs` block (including the connection-state strings that Task 5 uses) so Task 5 doesn't need to edit the locale files again.

- [ ] **Step 1: Add `appLogsStreamUrl` to the API client**

In `client/src/api/apps.js`, append before the final `export default api`:

```js
/**
 * EventSource URL for an app's live log stream (SSE).
 * EventSource can't use axios; the consumer opens this URL directly.
 */
export const appLogsStreamUrl = (id, lines = 100) =>
  `/api/apps/${id}/logs/stream?lines=${lines}`
```

- [ ] **Step 2: Add the `appLogs` i18n keys (both languages)**

In `client/src/i18n/locales/en.json`, add this block as a new top-level key (e.g. after the `appCard` block, before `messages`):

```json
  "appLogs": {
    "title": "Logs",
    "lead": "Recent stdout / stderr — streaming live",
    "empty": "No logs yet — start the app and output appears here.",
    "statusLive": "Live",
    "statusIdle": "Idle",
    "statusDisconnected": "Disconnected",
    "retry": "Retry",
    "jumpLatest": "Jump to latest ↓",
    "loadError": "Failed to load application"
  },
```

In `client/src/i18n/locales/zh.json`, add the matching block (same position):

```json
  "appLogs": {
    "title": "日志",
    "lead": "最近的 stdout / stderr —— 实时推送",
    "empty": "暂无日志 —— 启动应用后输出会显示在这里。",
    "statusLive": "实时",
    "statusIdle": "空闲",
    "statusDisconnected": "已断开",
    "retry": "重试",
    "jumpLatest": "跳到最新 ↓",
    "loadError": "加载应用失败"
  },
```

- [ ] **Step 3: Add log-view styles**

Append to `client/src/styles/editorial.css`:

```css
/* ----- Logs ----- */
.log-view {
  margin-top: 22px; height: 62vh; overflow-y: auto;
  background: var(--surface); border: 1px solid var(--rule);
  padding: 14px 18px; position: relative;
}
.log-line { font-family: var(--mono); font-size: 12px; line-height: 1.7;
  color: var(--ink); white-space: pre-wrap; word-break: break-word; }
.log-line.log-err { color: var(--accent); }
.log-empty { font-family: var(--serif); font-size: 15px; color: var(--ink-3);
  text-align: center; padding: 60px 0; }
.log-toolbar { display: flex; align-items: center; justify-content: space-between;
  margin-top: 14px; }
.log-status { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase;
  letter-spacing: 0.14em; color: var(--ink-3); }
.log-status.live { color: var(--accent); }
.log-status.disconnected { color: var(--accent); }
.log-jump { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase;
  letter-spacing: 0.1em; color: var(--ink-2); background: none; border: none;
  border-bottom: 1px solid transparent; cursor: pointer; padding: 0 0 1px; }
.log-jump:hover { color: var(--accent); border-bottom-color: var(--accent); }
```

- [ ] **Step 4: Create `AppLogs.jsx` (core version)**

Create `client/src/pages/AppLogs.jsx`:

```jsx
import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import EditorialShell from '../components/EditorialShell'
import { getAppById, appLogsStreamUrl } from '../api/apps'

function AppLogs() {
  const navigate = useNavigate()
  const { id } = useParams()
  const { t } = useTranslation()

  const [app, setApp] = useState(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [lines, setLines] = useState([])

  const scrollRef = useRef(null)
  const atBottomRef = useRef(true)

  // Resolve the app (for the title / load-failure handling).
  useEffect(() => {
    let alive = true
    getAppById(id)
      .then((a) => { if (alive) setApp(a) })
      .catch(() => { if (alive) setLoadFailed(true) })
    return () => { alive = false }
  }, [id])

  // Track whether the view is pinned to the bottom.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }, [])

  // Sticky auto-scroll on new lines.
  useEffect(() => {
    if (!atBottomRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  // Open the SSE stream: history first, then live lines.
  useEffect(() => {
    const es = new EventSource(appLogsStreamUrl(id))

    es.addEventListener('history', (e) => {
      const data = JSON.parse(e.data)
      setLines(Array.isArray(data.lines) ? data.lines : [])
    })
    es.addEventListener('line', (e) => {
      const data = JSON.parse(e.data)
      setLines((prev) => [...prev, { level: data.level, msg: data.msg, ts: data.ts }])
    })
    es.onerror = () => {
      // Connection-state UI (LIVE/IDLE/DISCONNECTED + retry) lands in Task 5.
    }

    return () => es.close()
  }, [id])

  if (loadFailed) {
    return (
      <EditorialShell>
        <div className="empty">
          <h2>{t('appLogs.loadError')}</h2>
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
        {t('appLogs.title')}{app ? ` — ${app.name}` : ''}
      </h1>
      <div className="lead">{t('appLogs.lead')}</div>

      <div className="log-view" ref={scrollRef} onScroll={handleScroll}>
        {lines.length === 0 ? (
          <div className="log-empty">{t('appLogs.empty')}</div>
        ) : (
          lines.map((l, i) => (
            <div key={i} className={`log-line log-${l.level}`}>{l.msg}</div>
          ))
        )}
      </div>
    </EditorialShell>
  )
}

export default AppLogs
```

- [ ] **Step 5: Register the route**

In `client/src/App.jsx`, add the import alongside the other page imports (after `import UploadFiles from './pages/UploadFiles'`):

```jsx
import AppLogs from './pages/AppLogs'
```

And add the route inside `<Routes>`, after the `apps/:id/upload` route:

```jsx
<Route path="/apps/:id/logs" element={<AppLogs />} />
```

- [ ] **Step 6: Verify the live-tailing flow in the browser**

With `npm run dev` (both servers) and `logtest` still running: open `http://localhost:5173/apps/1/logs`.

Expected:
- The page title reads `Logs — logtest`; http-server's startup lines appear immediately (from the `history` event).
- In another terminal, `curl http://localhost:<logtest-port>/` a few times → new request-log lines append at the bottom and the view auto-scrolls to follow them.
- Scroll the log view **up** → new lines still arrive but the view no longer auto-scrolls (you're reading older output).

- [ ] **Step 7: Lint + commit**

```bash
cd client && npm run lint
git add client/src/pages/AppLogs.jsx client/src/App.jsx client/src/api/apps.js \
        client/src/i18n/locales/en.json client/src/i18n/locales/zh.json \
        client/src/styles/editorial.css
git commit -m "feat(logs): AppLogs page — history, live append, sticky auto-scroll"
```

---

## Task 5: AppLogs — connection indicator, retry, jump-to-latest, stderr accent

**Files:**
- Modify: `client/src/pages/AppLogs.jsx` (add state machine + toolbar)

**Interfaces:**
- Consumes: the `appLogs.*` i18n keys added in Task 4 (including `statusLive`, `statusIdle`, `statusDisconnected`, `retry`, `jumpLatest`) and the `.log-status` / `.log-jump` styles added in Task 4.

- [ ] **Step 1: Replace `AppLogs.jsx` with the resilient version**

Replace the entire contents of `client/src/pages/AppLogs.jsx` with:

```jsx
import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import EditorialShell from '../components/EditorialShell'
import { getAppById, appLogsStreamUrl } from '../api/apps'

const IDLE_AFTER_MS = 10000

function AppLogs() {
  const navigate = useNavigate()
  const { id } = useParams()
  const { t } = useTranslation()

  const [app, setApp] = useState(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [lines, setLines] = useState([])
  const [status, setStatus] = useState('live')      // 'live' | 'idle' | 'disconnected'
  const [showJump, setShowJump] = useState(false)

  const scrollRef = useRef(null)
  const atBottomRef = useRef(true)
  const lastLineAtRef = useRef(Date.now())
  const [streamTick, setStreamTick] = useState(0)   // bump to force a fresh EventSource

  // Resolve the app.
  useEffect(() => {
    let alive = true
    getAppById(id)
      .then((a) => { if (alive) setApp(a) })
      .catch(() => { if (alive) setLoadFailed(true) })
    return () => { alive = false }
  }, [id])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    atBottomRef.current = atBottom
    setShowJump(!atBottom && lines.length > 0)
  }, [lines.length])

  // Sticky auto-scroll.
  useEffect(() => {
    if (!atBottomRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  // Open the SSE stream; re-open whenever streamTick changes (Retry).
  useEffect(() => {
    setStatus('live')
    const es = new EventSource(appLogsStreamUrl(id))

    const markLive = () => {
      lastLineAtRef.current = Date.now()
      setStatus('live')
    }

    es.addEventListener('open', () => setStatus('live'))
    es.addEventListener('history', (e) => {
      const data = JSON.parse(e.data)
      setLines(Array.isArray(data.lines) ? data.lines : [])
      markLive()
    })
    es.addEventListener('line', (e) => {
      const data = JSON.parse(e.data)
      setLines((prev) => [...prev, { level: data.level, msg: data.msg, ts: data.ts }])
      markLive()
    })
    es.onerror = () => setStatus('disconnected')

    return () => es.close()
  }, [id, streamTick])

  // LIVE vs IDLE: no line for IDLE_AFTER_MS while connected => idle.
  useEffect(() => {
    const timer = setInterval(() => {
      setStatus((prev) => {
        if (prev === 'disconnected') return prev
        return Date.now() - lastLineAtRef.current > IDLE_AFTER_MS ? 'idle' : 'live'
      })
    }, 3000)
    return () => clearInterval(timer)
  }, [])

  const jumpToLatest = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    atBottomRef.current = true
    setShowJump(false)
  }

  const retry = () => setStreamTick((n) => n + 1)

  const statusKey = {
    live: 'statusLive',
    idle: 'statusIdle',
    disconnected: 'statusDisconnected',
  }[status]

  if (loadFailed) {
    return (
      <EditorialShell>
        <div className="empty">
          <h2>{t('appLogs.loadError')}</h2>
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
        {t('appLogs.title')}{app ? ` — ${app.name}` : ''}
      </h1>
      <div className="lead">{t('appLogs.lead')}</div>

      <div className="log-view" ref={scrollRef} onScroll={handleScroll}>
        {lines.length === 0 ? (
          <div className="log-empty">{t('appLogs.empty')}</div>
        ) : (
          lines.map((l, i) => (
            <div key={i} className={`log-line log-${l.level}`}>{l.msg}</div>
          ))
        )}
      </div>

      <div className="log-toolbar">
        <span className={`log-status ${status}`}>
          {t(`appLogs.${statusKey}`)}
          {status === 'disconnected' && (
            <button className="log-jump" style={{ marginLeft: 12 }} onClick={retry}>
              {t('appLogs.retry')}
            </button>
          )}
        </span>
        {showJump && (
          <button className="log-jump" onClick={jumpToLatest}>
            {t('appLogs.jumpLatest')}
          </button>
        )}
      </div>
    </EditorialShell>
  )
}

export default AppLogs
```

- [ ] **Step 2: Verify connection states + retry + stderr color**

1. **Empty state:** create a fresh app (`logtest2`) but don't start it. Open `http://localhost:5173/apps/<id>/logs` → the empty-state line `No logs yet — start the app and output appears here.` shows, status reads `Live` (connected, just no history).
2. **Stderr accent:** create an `npm` app whose `start` script does `node -e "setInterval(()=>{console.log('out');console.error('ERR BOOM')},1000)"`, start it, open its logs page → `out` lines render in ink, `ERR BOOM` lines render in **accent red**.
3. **DISCONNECTED + Retry:** with the logs page open, stop the backend (`Ctrl+C` on the server). Within a second the status flips to `Disconnected` and a `Retry` button appears next to it. Restart the backend (`npm run dev:server`) and click `Retry` → status returns to `Live` and streaming resumes (history reloads).
4. **IDLE:** on the running `logtest` (http-server) logs page, stop generating requests and wait ~10 s → status flips to `Idle`; `curl` the app once → it flips back to `Live`.
5. **Jump to latest:** scroll up → a `Jump to latest ↓` button appears in the toolbar; click it → view snaps to the bottom and the button hides.

- [ ] **Step 3: Lint + commit**

```bash
cd client && npm run lint
git add client/src/pages/AppLogs.jsx
git commit -m "feat(logs): AppLogs — LIVE/IDLE/DISCONNECTED indicator, retry, jump-to-latest"
```

---

## Task 6: AppRow `Logs` action (entry point)

**Files:**
- Modify: `client/src/components/AppRow.jsx` (add the `Logs` button + navigation)
- Modify: `client/src/i18n/locales/en.json`, `zh.json` (add `appCard.logs`)

**Interfaces:**
- Consumes: `useNavigate` (already imported in AppRow), the `/apps/:id/logs` route from Task 4, a new `appCard.logs` i18n key.

- [ ] **Step 1: Add the `logs` i18n key**

In `client/src/i18n/locales/en.json`, inside the `appCard` object, add (e.g. after `"viewDirectory": "View Deployment Directory",`):

```json
    "logs": "Logs",
```

In `client/src/i18n/locales/zh.json`, inside the `appCard` object, add (after `"viewDirectory": "查看部署目录",`):

```json
    "logs": "日志",
```

- [ ] **Step 2: Add the `Logs` button between View Directory and Upload**

In `client/src/components/AppRow.jsx`, find the action group. Insert this button **immediately after** the `View Directory` button (the one whose `onClick={openDir}`) and **before** the Upload button:

```jsx
          <button className="act" onClick={() => navigate(`/apps/${app.id}/logs`)}>
            {t('appCard.logs')}
          </button>
```

(The `navigate` and `t` bindings already exist at the top of `AppRow` — no new imports needed. `app.id` is passed in as a prop.)

- [ ] **Step 3: Verify the entry point**

1. On the dashboard, hover an app row → the `Logs` action appears between `View Deployment Directory` and `Upload`, for **both** running and stopped apps.
2. Click `Logs` → navigates to `/apps/<id>/logs` and the logs page renders.
3. Toggle the language (EN / 中) → the button label flips between `Logs` and `日志`.

- [ ] **Step 4: Lint + commit**

```bash
cd client && npm run lint
git add client/src/components/AppRow.jsx client/src/i18n/locales/en.json client/src/i18n/locales/zh.json
git commit -m "feat(logs): add Logs action to AppRow"
```

---

## Task 7: Document the new endpoint + page

**Files:**
- Modify: `CLAUDE.md` (API endpoint list)
- Modify: `PROGRESS.md` (mark Phase 10 done; changelog)
- Modify: `README.md` (API endpoints + Features/Usage)

**Interfaces:** None — docs only.

- [ ] **Step 1: Add the endpoint to CLAUDE.md**

In `CLAUDE.md`, in the `Key endpoints:` list (under `### API Endpoints`), add this line after the `GET /api/apps/:id/files` entry:

```markdown
- `GET /api/apps/:id/logs/stream` - SSE stream of an app's logs (history then live; `?lines=N`)
```

- [ ] **Step 2: Mark Phase 10 done in PROGRESS.md**

In `PROGRESS.md`:
- Change the Phase 10 heading from `### 🎯 Phase 10: 日志管理 (优先级: 高)` to `### ✅ Phase 10: 日志管理 (2026-07-09)` and tick its checkboxes:

```markdown
### ✅ Phase 10: 日志管理 (2026-07-09)
- [x] 后端日志接口
  - [x] GET /api/apps/:id/logs/stream - SSE（历史 + 实时）
  - [x] 15s 心跳保活；app 不存在返回 404 JSON
- [x] 前端日志查看
  - [x] 独立页面 /apps/:id/logs（AppLogs）
  - [x] 实时追加 + 粘性自动滚动 + 跳到最新
  - [x] LIVE/IDLE/DISCONNECTED 状态 + 手动重试
  - [x] stderr accent 着色
```

- Update the `### [Unreleased]` changelog at the top of the changelog section by prepending a dated entry (keep existing entries below):

```markdown
### [Unreleased] — 2026-07-09
#### 新增
- 日志管理（Phase 10）：`GET /api/apps/:id/logs/stream` SSE（最近 N 行历史 + 实时推送）；`LogManager` 服务（解析 PM2 日志路径 + `fs.watch` 增量 tail，按字节偏移、行缓冲、轮转重置）；前端 `AppLogs` 页面（粘性自动滚动、LIVE/IDLE/DISCONNECTED + 重试、stderr 红色）；AppRow 新增 Logs 入口。
#### 移除
- `ProcessManager.getProcessLogs`（死代码，被 LogManager 取代）。
```

- In the `## 下一步计划` → `立即任务` section, remove the `1. 日志管理功能 (Phase 10)` line and renumber (npm 完善与测试成为新的立即任务).

- [ ] **Step 3: Add the endpoint + feature to README.md**

In `README.md`, under `### Applications` in the `## API Endpoints` section, add after the `POST /api/apps/:id/upload` line:

```markdown
- `GET /api/apps/:id/logs/stream` - Live log stream (SSE; emits recent history then new lines; `?lines=N`, default 100)
```

In the `## Features` list, add a bullet (e.g. after the Status Sync bullet):

```markdown
- 📜 **Live Logs**: stream each app's PM2 stdout/stderr from a dedicated logs page — recent history on open, then new lines in real time
```

In `### Managing Applications` under `## Usage`, add a bullet:

```markdown
- **Logs**: Open the app's live log stream (stdout/stderr, history + real-time) on a dedicated page
```

- [ ] **Step 4: Verify + commit**

```bash
git add CLAUDE.md PROGRESS.md README.md
git commit -m "docs: document log management (endpoint, Phase 10 done, README feature)"
```

---

## Self-Review (run after writing — recorded here for the implementer)

**Spec coverage** — every spec section maps to a task:
- LogManager `getLogPaths` / `readHistory` → Task 1 ✓
- `createTailer` (byte offset, line buffer, rotation, no-op on missing) → Task 2 ✓
- SSE route (history before headers / 404, history event, line events, 15 s heartbeat, close cleanup, error event) → Task 3 ✓
- Remove `ProcessManager.getProcessLogs` → Task 3 ✓
- AppLogs page (history, live, sticky auto-scroll, empty state, stderr accent) → Tasks 4 + 5 ✓
- LIVE/IDLE/DISCONNECTED + retry + jump-to-latest → Task 5 ✓
- AppRow Logs action → Task 6 ✓
- API helper, route, i18n, styles → Tasks 4 + 6 ✓
- Docs (CLAUDE/PROGRESS/README) → Task 7 ✓

**Open spec items deliberately deferred** (per spec *Future*, not gaps): PM2 `time: true` timestamps; a plain JSON `GET /logs` fallback; search/filter; "clear logs" action.

**Type/name consistency:** `getLogPaths` → `{ outPath, errPath }` (used identically in Task 3); `readHistory(filePath, level, lines)` signature matches across tasks; `createTailer` returns `{ stop }` and `stop()` is what Task 3's cleanup calls; `appLogsStreamUrl(id, lines)` matches Task 4's import; i18n keys (`appLogs.*`, `appCard.logs`) match the strings used in the JSX.

**Known minor race:** between `readHistory` (Task 3) and `createTailer` attaching, a line written in that window is missed. Acceptable for v1; the live stream resumes from attach onward. Not worth a pre-read offset handoff.
