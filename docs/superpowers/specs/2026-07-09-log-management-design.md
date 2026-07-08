# Microverse — Application Log Management

**Date:** 2026-07-09
**Status:** Approved design (history + live SSE; file-tail source; dedicated page)
**Scope:** New feature — view a deployed application's PM2 logs from the UI. Adds one backend service, one SSE endpoint, one frontend page, and a row action.

## Context

Microverse launches apps via PM2 but exposes no way to see their logs. PM2 writes each app's output to `~/.pm2/logs/<name>-out.log` and `~/.pm2/logs/<name>-error.log` by default (the launch config in `ProcessManager.startProcess` does not set `out_file`/`error_file`). There is already a `ProcessManager.getProcessLogs(appName, lines)` method that shells out to `pm2 logs --nostream`, but **no route calls it** — it is dead code. There is no SSE / WebSocket infrastructure anywhere in the Express server today.

This design adds the ability to open a per-app logs page that shows recent history, then streams new lines live as the app writes them.

## Goals

- Show a deployed app's recent stdout/stderr (last N lines) the moment the logs page opens.
- Stream new log lines to the open page in real time (no manual refresh).
- Fit the existing editorial UI language and the existing service-layer / route patterns.
- Be robust on Windows (the project's primary platform): no per-connection child processes, no reliance on Unix signals.
- Clean up resources on disconnect so an open-then-close logs page never leaks file watchers or keeps the server alive.

## Non-goals

- No multi-user / per-user log access control (single-user platform today).
- No persistent log storage beyond what PM2 already keeps on disk — we read PM2's own log files; we do not introduce a separate log store.
- No full-text search, filtering, or log retention/rotation UI in this pass.
- No WebSocket. Transport is SSE (server→client one-way is exactly what log streaming needs).
- No timestamps injected into historical lines (PM2 logs aren't timestamped by the current launch config); live lines carry a server-side send timestamp only. Interleaving stdout/stderr *history* precisely by time is therefore not possible — see *Limitations*.

## Architecture

A new **LogManager** service owns everything log-related. The route layer orchestrates an SSE response on top of it. A new **AppLogs** page consumes the stream. `ProcessManager` stays focused on lifecycle; its dead `getProcessLogs` is removed.

```
Route GET /api/apps/:id/logs/stream
  └─ AppManager.getAppById          (resolve app, 404 if missing — before SSE headers)
  └─ LogManager.getLogPaths(app.name)  → readHistory(out) + readHistory(err)  (last N lines)
  └─ LogManager.attachTailer(res)   (fs.watch each file → emit new lines as SSE events)
        └─ req.on('close') → detach + close watchers
```

### Why file-tailing (not `pm2 logs` spawn, not `pm2.launchBus`)

Three options were considered for the live source:

1. **Tail PM2's log files directly (chosen).** Resolve the real file paths via `pm2 jlist` (`pm_out_log_path` / `pm_err_log_path`), read recent bytes for history, then `fs.watch` and read incremental bytes for live lines. No child process per connection, clean stdout/stderr separation, cross-platform `fs` APIs, trivial cleanup (`stop()` the watchers).
2. Spawn `pm2 logs <name>` (stream mode) per SSE connection. Simplest, but one child process per viewer, messy kill-on-disconnect on Windows, and stdout/stderr arrive merged.
3. PM2 programmatic `pm2.launchBus()`. The "official" realtime API, but it requires managing `pm2.connect`/`launchBus` lifecycle inside Express and delivers *all* processes' logs (must filter by name) — high complexity and daemon-state risk for a single-user tool.

## Backend

### New: `server/src/services/log-manager.js`

Single responsibility: resolve log file paths for an app, read history, and watch for new lines. No Express knowledge.

- **`getLogPaths(appName) → { outPath, errPath }`**
  - Run `pm2 jlist`, parse, find the process whose `name === appName`, read `pm2_env.pm_out_log_path` and `pm2_env.pm_err_log_path`.
  - Fallback if the process isn't listed: compute PM2's default paths `path.join(os.homedir(), '.pm2', 'logs', \`${appName}-out.log\`)` / `-error.log`, and use each only if the file exists on disk.
  - Returns `{ outPath, errPath }` where either may be `null` (file doesn't exist / app never started). Never throws for "no logs" — callers treat null as "empty".
  - Throws only if `pm2 jlist` itself fails in a way that isn't "process not found"; the route catches and surfaces as an SSE `error` event.

- **`readHistory(filePath, level, lines) → [{ level, msg }]`**
  - If `filePath` is null or doesn't exist → `[]`.
  - Else read the file (UTF-8), split on newlines, drop empties, take the last `lines` entries, tag each with `level`.

- **`createTailer(filePath, level, onLine) → { stop }`**
  - Records `lastSize = current file size` at attach time (set *after* history is read, so history is never re-emitted as live).
  - Attaches `fs.watch(filePath, onChange)`.
  - `onChange`: `stat` the file → `newSize`. 
    - `newSize > lastSize`: read bytes `[lastSize, newSize)`, decode UTF-8, append to a per-tailer **line buffer**. Emit one `onLine({ level, msg })` for each complete line (terminated by `\n`); keep any trailing partial (no `\n`) buffered for the next change. Set `lastSize = newSize`.
    - `newSize < lastSize` (log flushed/rotated, e.g. `pm2 flush`): reset `lastSize = 0`, clear the line buffer. Do not emit.
    - `newSize === lastSize`: no-op (handles `fs.watch` firing multiple times for one write — idempotent by construction).
  - If `filePath` is null or missing at attach → returns a no-op tailer (`stop` does nothing). This lets the route attach unconditionally even when only one of out/err exists.
  - `stop()`: removes the `fs.watch` listener and clears state. Safe to call more than once.
  - `fs.watch` errors (e.g. file deleted mid-stream): log and `stop()` that tailer; the other tailer (if any) and the connection keep running.

### Route: `GET /api/apps/:id/logs/stream?lines=100`

EventSource only supports GET, so this single endpoint serves both history and live streaming.

1. `AppManager.getAppById(id)` — if not found, return **404 JSON** *before* writing any SSE headers (clean error for the client).
2. Set headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no` (proxy buffering safety).
3. `const paths = await LogManager.getLogPaths(app.name)` (resolved once), then `LogManager.readHistory(paths.outPath, 'out', lines)` + `LogManager.readHistory(paths.errPath, 'err', lines)` (`lines` default 100, `?lines=` override, clamped to a sane max e.g. 1000).
4. Emit one `event: history` whose `data` is `{ "lines": [ {level, msg}, … ] }` — out lines first, then err lines (see *Limitations* on ordering).
5. `LogManager.createTailer(outPath, 'out', emitLine)` and `createTailer(errPath, 'err', emitLine)`, where `emitLine({level,msg})` writes `event: line` / `data: { level, msg, ts }` (`ts` = server `Date.now()` at send time).
6. Heartbeat: every 15s write a comment line `: ping\n\n` (no event type) to keep the connection alive and let the server detect a dead client via write failure.
7. `req.on('close')`: call `stop()` on both tailers and clear the heartbeat timer. This is the single cleanup path — no matter how the client goes away, watchers and timers are released.

### Removed

- `ProcessManager.getProcessLogs(appName, lines)` — superseded by LogManager; deleting it avoids two divergent log code paths.

### PM2 ecosystem

No change to `ProcessManager.startProcess`. Apps continue to log to PM2's default files, which LogManager reads by path. (Adding `time: true` to the ecosystem config is intentionally out of scope — it would only affect apps started after the change and is noted under *Future*.)

## SSE protocol

| Event | `data` shape | When |
|---|---|---|
| `history` | `{ lines: [{ level: 'out'\|'err', msg: string }] }` | Once, right after connect |
| `line` | `{ level: 'out'\|'err', msg: string, ts: number }` | Each new live line |
| `error` | `{ message: string }` | Fatal source error; server then closes the stream |
| (comment) | `: ping` | Every 15s, keep-alive |

The client listens for the named events `history`, `line`, `error`. The comment heartbeat is ignored by `EventSource` automatically.

## Frontend

### New page: `client/src/pages/AppLogs.jsx` (route `/apps/:id/logs`)

- Wrapped in `EditorialShell` — serif title `Logs — {app.name}`, a `←` mono text-link back to the dashboard.
- On mount: open `new EventSource(\`/api/apps/${id}/logs/stream?lines=100\`)`.
  - **Proxy note:** in dev this goes through Vite's `/api` proxy. `http-proxy`-based proxies generally pass SSE through without buffering; verify during implementation and, only if needed, disable response compression on the route.
- `onmessage`-style handlers per named event:
  - `history` → replace the in-memory log buffer with `data.lines`.
  - `line` → append `{level, msg, ts}` to the buffer and re-render.
  - `error` → set connection state to `DISCONNECTED`, keep the buffer, show `Retry`.
- **Log area:** a scrollable mono block on the paper surface. Each line: optional level glyph + the message. **`err` lines rendered in `var(--accent)`** (red) to make errors pop; `out` lines in `var(--ink)`. Numbered rows are *not* used here (logs aren't a fixed list) — plain mono lines.
- **Sticky follow:** when the view is scrolled to the bottom, new lines auto-scroll into view. If the user scrolls up to read, auto-scroll pauses and a small `Jump to latest ↓` mono link appears; clicking it scrolls to the bottom and resumes follow.
- **Connection indicator** (mono small-caps, top of the log area):
  - `LIVE` — connected, and a line arrived within the last 10s.
  - `IDLE` — connected, but no line in the last 10s (app isn't producing output right now).
  - `DISCONNECTED` — `EventSource` fired `onerror` or closed; show a `Retry` button that closes the old source and opens a fresh one.
- Empty state (no history, no lines): serif statement `No logs yet — start the app and output appears here.` (i18n).
- `EventSource` is closed on unmount/route-away (no leak across navigations).

### Entry point: `AppRow.jsx`

- Add a `Logs` action button in the row's action group, between **View Directory** and **Upload**. It `navigate(\`/apps/${app.id}/logs\`)`.
- Available in both running and stopped states (history is readable while stopped). i18n key added.

### API client: `client/src/api/apps.js`

- Add `appLogsStreamUrl(id, lines = 100)` → returns the relative EventSource URL `/api/apps/${id}/logs/stream?lines=${lines}`. Keeps URL construction next to the other app API helpers.

### Routing: `client/src/App.jsx`

- Add route `/apps/:id/logs` → `AppLogs`, alongside the existing `CreateApp` and `UploadFiles` routes.

### i18n: `client/src/i18n/locales/{zh,en}.json`

- New keys: logs page title, back label, connection states (`LIVE` / `IDLE` / `DISCONNECTED`), retry button, jump-to-latest, empty state. No structural i18n change.

## Error handling

- **App not found:** 404 JSON, returned before SSE headers (client shows a not-found state).
- **`pm2 jlist` failure / path resolution error:** route catches, emits `event: error` with a message, then ends the stream. Client goes `DISCONNECTED` + retry.
- **Log file missing (never started / flushed):** empty history, no-op tailer → page shows empty state. Not an error.
- **Client disconnect:** `req.close` → both tailers stopped + heartbeat cleared. No watcher/timer leaks; the Node process is not kept alive by lingering handles.
- **Mid-stream `fs.watch` error (file deleted while open):** that one tailer stops and logs; the connection stays up.
- **Partial log line:** the tailer's line buffer only emits on `\n`, so a write split across two `fs.watch` callbacks never produces a half-line.
- **Frontend proxy buffering:** verify SSE through Vite proxy; mitigate only if observed.

## Testing

The project has no automated test framework; verification follows the manual pattern in `CLAUDE.md`.

1. Create an `http-server` app, start it, open its logs page → startup/visit output appears (history on first connect).
2. Generate more output (e.g. `curl http://localhost:<port>` to produce http-server request lines) → new lines stream in live; auto-scroll follows.
3. Scroll up → auto-scroll pauses, `Jump to latest ↓` appears; click it → resumes.
4. Create an `npm` app that does `console.log` / `console.error` on an interval, start it → both `out` and `err` lines stream, errors rendered in accent red.
5. Stop the app → status flips to `IDLE`, history remains visible.
6. Reload the page → history reloads from disk.
7. Stop the backend mid-stream → client shows `DISCONNECTED`; restart backend, click `Retry` → reconnects and resumes.
8. Open the page then immediately navigate away → confirm (e.g. via server log / process exit) that no `fs.watch` handle lingers.

## Limitations

- **Historical stdout/stderr are not interleaved by time.** PM2 log lines carry no timestamp under the current config, so there is no faithful way to merge past out/err chronologically. History is delivered out-lines-first then err-lines; **live** lines, by contrast, arrive in true real-time order with a server send timestamp. (Adding `time: true` to the PM2 config would timestamp future logs but is out of scope here — see *Future*.)
- **History is bounded to the last N lines** of each file (default 100). Older content is not paged through in this pass.

## Component / file plan

New:
- `server/src/services/log-manager.js`
- `client/src/pages/AppLogs.jsx`

Changed:
- `server/src/routes/index.js` — add `GET /api/apps/:id/logs/stream`
- `server/src/services/process-manager.js` — remove `getProcessLogs`
- `client/src/components/AppRow.jsx` — add `Logs` action
- `client/src/api/apps.js` — add `appLogsStreamUrl`
- `client/src/App.jsx` — add route
- `client/src/i18n/locales/zh.json`, `en.json` — new keys
- `client/src/styles/editorial.css` — log area + connection-indicator styling
- `CLAUDE.md`, `PROGRESS.md`, `README.md` — document the new endpoint/page (after implementation)

## Future

- Timestamp log lines via PM2 `time: true` (would enable accurate history interleaving / "since" queries).
- A plain `GET /api/apps/:id/logs?lines=N` JSON endpoint as a fallback when SSE is blocked by a buffering proxy.
- Search / filter / log-level toggles in the viewer.
- A "clear logs" action (`pm2 flush <name>`).
