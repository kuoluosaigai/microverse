# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Microverse is a cross-platform application deployment platform that allows users to deploy and manage micro applications (static sites, Node.js apps) through a web interface. The system manages application lifecycle through PM2 and stores metadata in SQLite.

## Development Commands

### Installation
```bash
npm run install:all          # Install all dependencies (root + workspaces)
```

### Development
```bash
npm run dev                  # Start both backend and frontend concurrently
npm run dev:server           # Start backend only (http://localhost:5000)
npm run dev:client           # Start frontend only (http://localhost:5173)
```

### Backend-specific
```bash
cd server
npm run dev                  # Development mode with NODE_ENV=development
npm run start                # Production mode with NODE_ENV=production
npm run pm2:start            # Start with PM2 using ecosystem.config.js
npm run pm2:logs             # View PM2 logs
```

### Frontend-specific
```bash
cd client
npm run dev                  # Vite dev server
npm run build                # Production build
npm run preview              # Preview production build
npm run lint                 # ESLint check
```

### PM2 Management (for deployed apps)
```bash
npx pm2 list                 # List all managed processes
npx pm2 logs <app-name>      # View logs for specific app
npx pm2 delete <app-name>    # Remove app from PM2
```

### Deployment latency diagnostics
```bash
node scripts/diagnose-deploy-perf.js env           # Read-only: PM2 spawn / npm registry / git remote / nginx cost + per-app fingerprints
node scripts/diagnose-deploy-perf.js start <id>    # ONE real instrumented start: per-boundary ms + why each install/build gate fired
```
Every lifecycle op logs `[deploy-perf] <app> <step>: <ms>` (see `server/src/utils/lap-timer.js`), so `pm2 logs` alone shows where a slow deploy spent its time.

## Architecture

### Workspace Structure

This is an **npm workspaces** monorepo with two workspaces:
- `server/` - Backend (Express + SQLite + PM2)
- `client/` - Frontend (React + Vite + Ant Design)

### Database Architecture

**CRITICAL**: Uses `sqlite3` package (NOT `better-sqlite3`) for Windows compatibility.

All database operations are **asynchronous** and return Promises:
```javascript
// In server/src/db/index.js
const queries = {
  getAllApps: () => dbAll('SELECT * FROM apps ...'),    // Returns Promise<Array>
  getAppById: (id) => dbGet('SELECT * ...', [id]),      // Returns Promise<Object>
  createApp: async (params) => { ... }                   // async function
}
```

When using database queries in services or routes, **always use await**:
```javascript
const apps = await queries.getAllApps();  // ✓ Correct
const app = queries.getAppById(id);       // ✗ Wrong - returns Promise
```

### Service Layer Architecture

Three core orchestration services in `server/src/services/`, plus specialized services:

1. **AppManager** - Application CRUD and validation
   - Manages app records in database
   - Validates deployment requirements (e.g., index.html for http-server)
   - Handles application directory creation
   - Enforces app-name format (`^[A-Za-z0-9_-]{1,64}$`) to block path-traversal/config-injection

2. **ProcessManager** - PM2 process lifecycle
   - Starts/stops/restarts processes via PM2; every PM2 CLI call goes through `ProcessManager.pm2Exec(args)` (execFile + arg arrays, single choke point; Windows runs the resolved JS entry under node because .cmd shims can't be execFile'd)
   - `resolveCliModule` finds global CLIs (http-server, npm, pm2) across cwd/repo-root/execPath-adjacent/`npm root -g` roots — works under nvm/fnm/volta
   - **Windows-specific**: Uses http-server JS file directly (not CMD wrapper) to avoid PM2 fork mode issues
   - Finds available ports in range (3000-9000); IPv4/IPv6 dual-stack probe, excludes DB-claimed ports

3. **DeployManager** - Orchestration layer
   - Coordinates AppManager and ProcessManager
   - Assigns ports automatically (serialized via `utils/serialize.js#createExclusive` to close the TOCTOU port race)
   - Reconciles DB status with PM2 truth before every lifecycle op (`reconcileStatus`): a crashed/externally-deleted process no longer wedges stop/delete; when the PM2 CLI is unreachable the DB status stands
   - `stopApp` is idempotent (already-stopped → success no-op)
   - `deployApp(appId, { onStep, logFile })` is the deploy-job body (the only server path to it is the start route's `DeployRunner.startBackground` workFn — plus `scripts/diagnose-deploy-perf.js`'s direct instrumented call, outside any request): reports each `DEPLOY_STEP` immediately BEFORE the work it names and only when that work actually runs (order git → validate → install → build → nginx → launch → proxy; gated install/build, `nginx` only for nginx apps, `proxy` only when `PROXY_ENABLED`), forwards `logFile` to NpmLifecycle so background npm output lands on disk, and holds/releases the git claim exactly once across all paths

Specialized services:
- **DeployJobs** - Owner of async deploy-job STATE and job LOG FILES (`app_deploy_job` table, one row per app = current or most recent job): `claim()` (update-lock gate → atomic DB claim → only then create the log file; lost claim reasons `busy`/`updating`/`gone`), `advance()`/`finish()` (pid-fenced writes — a job stolen through the stale window can't be mutated by its old owner), `isLive()` (non-terminal + owner pid alive + `started_at` within `DEPLOY_JOB_STALE_MS` — liveness, never a bare status check), `assertIdle()`/`busyMessage()` (the single producer of the `部署进行中（<kind> · <step>），请等待完成后再<action>` 409 wording), `reconcileOnBoot()` (called from server.js after DB ready: converges orphaned non-terminal rows to failed with `部署被中断（平台重启）`, so a crashed worker or a platform `pm2 reload` never wedges an app), `anyActiveJob()` (platform-wide liveness probe consulted by UpdateManager.preflight — self-update ends in `pm2 reload` and refuses while ANY deploy is live), `tail()` (bounded log read: newest 200 non-empty lines within 64KB, ANSI-stripped) and `pruneLogs()` (keeps the 5 newest `<app>-<epoch>.log` files under `data/deploy-logs/`; a log failure never fails a deploy — `log_path` retracts to null).
- **DeployRunner** - The fire-and-forget boundary after a route has already sent its 202: `startBackground(app, kind, job, workFn)` runs the work detached, drives `ctx.report(step)` → `DeployJobs.advance` and converges the job via `DeployJobs.finish` (ok:true lands step `done` in the same fenced UPDATE; any failure — including a thrown hostile object — becomes status failed + message; never an unhandled rejection). The job row is the only reporter after the 202 goes out.
- **NpmLifecycle** - npm apps: fingerprint-gated `npm install` (incl. devDependencies) + optional `npm run build` — content hash of `package.json`/lockfile gates install, a stat-based app-tree hash gates build, fingerprints persist in the `app_deploy_state` table so a plain stop→start skips both; resolves user env vars (`app_env` table) into the PM2 ecosystem env. Runs inside the deploy job: `ensureBuilt(appId, path, { logFile, onStep })` reports the `install`/`build` steps itself, only when each gated piece of work actually runs, and its transcript lands in the job log file.
  - **The gates are the whole perf story**: a false "needs install" also forces a rebuild (`mustInstall` implies build), so a stale gate costs two minutes-scale steps per start, not one. Keep both hashes free of platform-owned state — `buildFingerprint` skips `node_modules` **and `.git`** (a sync rewrites `.git` internals on every start with no source change), and `needsInstall` treats a missing `node_modules` as "not installed" **only when the app declares dependencies** (`npm install` creates no `node_modules` for a dependency-free package).
- **NginxLifecycle** - `nginx` deploy type: generates per-app nginx server block (pid/log redirected into app dir), runs `nginx -t` preflight, managed by PM2 with `interpreter: 'none'` + `daemon off;`.
- **GitLifecycle** - Git-source deploys (`app_git_source` table): clones/fetches the bound repo into the app dir (depth-1 fetch, `reset --hard`, `clean -fd` — never `-x`), runs on start / manual pull / signed GitHub push webhook, and rolls the worktree + deploy state back to the previous HEAD when fetch or npm build fails. The three entry points differ in threading: start runs `prepareForStart` inside the deploy job (step `git`, clone failure → job `failed`), manual pull IS a deploy job (`DeployRunner` → `GitLifecycle.pull` → `sync`, with `busy`/`failed` results converted to job failures), while a webhook push still fires the older plain `triggerBackgroundSync`.
  - `cleanArgs` and `isPlatformManagedPath` exclude `GitLifecycle.platformDeployArtifacts()` (`package-lock.json`) alongside `node_modules` and the per-app nginx files: for a repo that tracks no lockfile, the one in the checkout is the platform's own `npm install` output. Deleting it flips the install fingerprint on every sync (full reinstall + forced rebuild per start) and makes `git status` report it as user dirt, which also defeats the same-commit fast path in `runClaimedSync`. Tracked lockfiles are unaffected — `clean`/`reset` never touch tracked files. Single-flight is a DB claim (`claimGitSync` / `finishGitSync`, stale after `GIT_STALE_SYNC_MS`), so concurrent pulls from cluster workers return `busy` instead of racing the working tree. npm apps are rebuilt via `NpmLifecycle.ensureBuilt`; only a running npm app is restarted after a sync.
- **LogManager** - SSE log streaming: resolves PM2 log paths per deploy_type, tails with `fs.watch` (byte offset, line buffer, rotation reset). nginx apps tail `nginx-access.log`/`nginx-error.log`.
- **MetricsSampler** - Resource monitoring: 10s/tick `pm2 jlist` from ONE cluster worker (`NODE_APP_INSTANCE=0`, gated in server.js); samples persist to the shared SQLite `metrics` table (pruned to newest 180/app) so every worker serves identical reads.
- **AuthManager** - Single-admin auth: bcryptjs verify, seeds admin from env on boot.
- **BackupManager** - Per-app zip export/import with `microverse-manifest.json` (name/deploy_type/env); restore validates first, rolls back on failure, 400 on name clash.
- **ProxyManager** - Platform-managed nginx edge reverse proxy (opt-in via `PROXY_ENABLED`): renders subdomain + root-default routes into `PROXY_CONF_FILE`, `nginx -t` then `-s reload`, rolls back on failure. Regenerated on app start/stop/delete and on boot.
- **UpdateManager / SelfUpdater** - Platform self-update (opt-in via `SELF_UPDATE_ENABLED`; Linux + PM2 only). `UpdateManager` does the version check (`git ls-remote` + 10-min cache), preflight, atomic `data/update.lock` claim, and detached spawn; `scripts/self-update.js` does DB `VACUUM INTO` backup → ff-only pull → `npm install --include=dev` → staged client build (`dist.next` swap) → `pm2 reload` → health poll, with code/dist rollback and incomplete-update repair detection. Additive schema only; the DB is backed up but never auto-restored.

**Call hierarchy**: Routes → (for start/pull: DeployJobs.claim + DeployRunner) → DeployManager → AppManager + ProcessManager (+ NpmLifecycle / NginxLifecycle / GitLifecycle) → Database/PM2; step/kind names come from the leaf `utils/deploy-steps.js` (required DOWNWARD by both layers — no service pulls step/kind names back up from deploy-jobs; `app-manager.js` does import `DeployJobs`, but only for `isLive`)

### Cross-Platform Considerations

**Path Handling**: All file paths MUST use Node.js `path` module:
```javascript
const appPath = path.join(__dirname, 'apps', appName);  // ✓ Correct
const appPath = `./apps/${appName}`;                     // ✗ Wrong
```

**Environment Variables**: Use `cross-env` in package.json scripts for Windows compatibility:
```json
"dev": "cross-env NODE_ENV=development node src/app.js"
```

**PM2 + http-server on Windows**:
- PM2 cannot execute `.cmd` files directly in fork mode
- Solution: Use `interpreter: 'node'` and point to the JS file directly
- See `ProcessManager.getHttpServerPath()` for implementation

### Frontend-Backend Integration

**Proxy Configuration**: In development, Vite proxies `/api` requests to backend:
```javascript
// client/vite.config.js
proxy: {
  '/api': {
    target: 'http://localhost:5000',  // Backend server
    changeOrigin: true
  }
}
```

All API calls from frontend should use relative paths: `/api/apps`, not `http://localhost:5000/api/apps`.

### Configuration Management

Environment variables are loaded from root `.env` file (see `.env.example`).

Config hierarchy: `server/src/config/index.js`
- Server: PORT (5000), HOST (0.0.0.0), NODE_ENV, APPS_DIR (apps dir; overridable for tests)
- CORS: CORS_ORIGIN (http://localhost:5173)
- Deployment: APP_PORT_MIN (3000), APP_PORT_MAX (9000), MAX_FILE_SIZE (100MB), MAX_FILES (100), APP_PUBLIC_URL_TEMPLATE (e.g. `https://{name}.yourdomain.com`; surfaced to UI via `/api/config`, http/https only)
- Deploy jobs: DEPLOY_JOB_STALE_MS (default 2400000; a 'running' `app_deploy_job` row older than this is abandoned — the next claim may take it over and `isLive` stops counting it, so a crashed worker cannot hold its app at 409 forever; sized >3x the worst-case deploy budget, tune from real distributions without code changes)
- Database: DB_PATH (data/microverse.sqlite)
- PM2: PM2_INSTANCE_NAME (microverse-server)
- Admin auth: ADMIN_USERNAME, ADMIN_PASSWORD (seeded on first boot only, race-free via `ON CONFLICT DO NOTHING`; to reset, delete the `users` row + restart), SESSION_SECRET (REQUIRED under NODE_ENV=production — config validation throws at boot; otherwise each cluster worker signs with a different key → intermittent 401), SESSION_COOKIE_SECURE (follows PROXY_SSL_ENABLED), SESSION_DB_PATH (data/sessions.sqlite; shared sqlite session store so sessions survive across cluster workers + restarts)
- Nginx: NGINX_BIN (default `nginx` = PATH; used by BOTH the nginx deploy type AND the reverse-proxy reload)
- Git sources: GIT_BIN (default `git` = PATH), GIT_TIMEOUT_MS (per-command timeout, 120000), GIT_STALE_SYNC_MS (a sync claim older than this is treated as abandoned, 1800000)
- Reverse proxy (opt-in edge, see ProxyManager): PROXY_ENABLED, PROXY_CONF_FILE, PROXY_BASE_DOMAIN, PROXY_SSL_ENABLED + PROXY_SSL_CERT/KEY paths (v1 does NOT issue certs — only emits the server-block shape; run certbot yourself then fill paths)
- Self-update (opt-in, see UpdateManager/SelfUpdater): SELF_UPDATE_ENABLED (default false), SELF_UPDATE_REF (default main), SELF_UPDATE_REMOTE (default origin). Requires a git checkout and `PM2_INSTANCE_NAME` online; non-git / Windows / dirty-tree / shallow-clone deployments are refused.

Config is validated on startup; invalid config throws immediately.

### PM2 Ecosystem

When deploying apps, temporary PM2 ecosystem config files are created in app directories:
```javascript
// Temporary file: apps/<app-name>/pm2.<app-name>.config.cjs
// (.cjs so it stays CommonJS even if the app's package.json sets "type": "module")
{
  apps: [{
    name: 'app-name',
    script: 'path-to-http-server',
    args: '. -p 3000',
    cwd: '/path/to/app',
    interpreter: 'node'  // Critical for Windows
  }]
}
```

These are auto-deleted after 5 seconds to avoid clutter.

### API Endpoints

All endpoints return JSON with structure:
```javascript
{ success: true, data: {...} }           // Success
{ success: false, error: { message } }   // Error
```

While an app has a live deploy job (`deploy.live` per spec: non-terminal + owner pid alive + fresh `started_at`), EVERY mutating endpoint for that app — start/stop/restart/delete/upload/PUT env/PUT+DELETE default/Git bind/unbind/secret-rotate/pull — is refused with **409** (one producer for the wording: `DeployJobs.busyMessage`; one mapper for the response: `routes/deploy-conflict.js#sendDeployConflict`/`sendClaimFailure`). Reads and `/sync`/`git/check` stay allowed. The 202 responses (`start`, `git/pull`) acknowledge claim only — outcome is in the job row.

Key endpoints:
- `GET /api/health` - Health check
- `GET /api/config` - Public client config (upload limits, app URL template, proxy/base-domain fields)
- `GET /api/apps` - List all apps (response includes per-app `metrics`, `git` and `deploy` summaries)
- `GET /api/apps/:id` - Get app by ID
- `POST /api/apps` - Create app (body: { name, deploy_type }; name must match `^[A-Za-z0-9_-]{1,64}$`; optional `git_url`, `git_branch` (default `main`), `git_auto_update` (default `true`) bind a Git source in the same call; response is the enriched app shape — `deploy: null` before the app's first deploy)
- `DELETE /api/apps/:id` - Delete app (must be stopped first; cleans PM2 orphan). `?deleteFiles=true` also removes the app directory (default `false` keeps it); response reports `filesDeleted`; 409 while a deploy job or git sync is live (the job row cascades with the app, so refusing BEFORE the delete is what stops a running job from `pm2 start`ing an untracked process)
- `POST /api/apps/:id/start` - Start app — 202 + background deploy job (`kind start`): answers only what needs no work (400 already-running, 400 non-git validation, 404, 409 job/git-claim/update-lock), then runs port-assign + git/install/build/nginx/launch/proxy detached; outcome via `GET /api/apps/:id/deploy` or `app.deploy`
- `GET /api/apps/:id/deploy` - Current job summary + bounded log tail `{job, logTail}` (job = same shape as `app.deploy`, null before first deploy; `logTail` server-bounded 200 lines / 64KB, ANSI-stripped, `[]` when anything is missing — no client parameter enlarges it, no SSE)
- `POST /api/apps/:id/stop` - Stop app (409 while a deploy job is live — a no-op stop followed by the job's own launch would invert the button)
- `POST /api/apps/:id/restart` - Restart app (409 while a deploy job or git sync is live)
- `POST /api/apps/:id/sync` - Sync DB status with PM2 actual status
- `GET /api/apps/:id/files` - List deployed files (`.git` is hidden)
- `GET|PUT|DELETE /api/apps/:id/git` - Get (with webhook URL + secret) / bind or re-bind (body: { url, branch?, autoUpdate? }) / unbind the Git source. Unbind keeps app files; PUT/DELETE return 409 while a sync is in progress or a deploy job is live
- `POST /api/apps/:id/git/secret` - Rotate the per-app webhook secret (binding + deployment progress preserved; 409 while a deploy job is live)
- `POST /api/apps/:id/git/check` - Compare deployed commit with the remote branch head (no worktree changes)
- `POST /api/apps/:id/git/pull` - Fetch/sync the branch, rebuild npm apps, and restart a running app — 202 + background deploy job (`kind pull`, the same claim/gate ordering as start); the result is read from `app.git` (`last_status`, `deployed_commit`) + `app.deploy`, not the response; fetch/build failure rolls the worktree back inside the job
- `POST /api/webhooks/github/:appId` - Public GitHub push webhook (HMAC-SHA256 over the raw body via `X-Hub-Signature-256`, 2MB JSON limit, 120/min/IP; no session). `ping` → 200, non-push → 204, accepted/ignored → 202, bad signature → 401, unknown app/unbound source → 404
- `GET /api/apps/:id/logs/stream` - SSE stream of an app's logs (history then live; `?lines=N`)
- `GET /api/apps/:id/metrics` - Per-app resource metrics history (CPU/memory samples)
- `GET|PUT /api/apps/:id/env` - Get/set user env vars (baked at launch; restart to apply; PUT returns 409 while a deploy job is live — mid-job writes could ship a half-new set)
- `POST /api/apps/:id/upload` - Upload files (multipart field `files`; ZIPs auto-extract with zip-slip guard; single top-level folder auto-flattened; a zip upload replaces prior user content — stale files removed, platform files like `node_modules`/`.git`/nginx conf preserved). Git-source apps reject uploads (400) — repo content owns the directory; 409 while a deploy job is live (refused BEFORE multer is invoked, so zero bytes are written; the body may already be streaming — browsers surface that as a failed upload)
- `GET /api/apps/:id/backup` - Download per-app backup zip (files + manifest; `.git` excluded)
- `POST /api/apps/restore` - Restore app from backup zip (validates first, rolls back on failure, 400 on name clash; 201 returns the RAW app row, no `git`/`deploy` summaries)
- `PUT|DELETE /api/apps/:id/default` - Mark/unmark an app as the root-domain default (single-default; regenerates edge proxy; 409 while a deploy job is live — the job's proxy step would race the new choice). PUT returns the RAW app row (`queries.setDefaultApp`) — no `git`/`deploy`/`metrics` keys; DELETE returns only `{ message }`
- `POST /api/auth/login` | `POST /api/auth/logout` | `GET /api/auth/me` - Single-admin session
- `GET /api/system/version` - Platform version + update availability (`incomplete` = an interrupted update that can be repaired)
- `POST /api/system/update` - Start a self-update (202; 400 preflight failure; 409 `已有更新正在进行` when an update already runs OR 409 `有应用正在部署（<app> · <step>），请等待完成` when a deploy job is live on ANY app — a self-update ends in `pm2 reload` and would kill it; checked in `UpdateManager.preflight` and re-checked race-free after the lock claim in `startUpdate`)
- `GET /api/system/update/status` - Update state + bounded log tail

Auth: `requireAuth` gates `/api/apps*` and `/api/system/*`; `/health`, `/config`, `/auth/login`, and `/api/webhooks/github/:appId` are public (the webhook authenticates per-app via its own HMAC signature). Rate-limited: login 5/15min/IP, API 100/min/IP (SSE exempt), webhook 120/min/IP. Interactive API docs: swagger-ui-express at `/api-docs`; spec at `/openapi.json`.

### Deployment Types

Currently supported:
- `http-server` - Static sites (requires `index.html`)
- `npm` - Node.js apps (requires `package.json` with start script; on start auto-runs `npm install` (incl. devDependencies) + optional `npm run build`, assigns a platform port injected as `PORT`, and injects user env vars from the `app_env` table)
- `nginx` - Static sites served by nginx (requires `index.html`; nginx is a system binary — set `NGINX_BIN` if not on PATH). Managed by PM2 with `interpreter: 'none'` + `daemon off;`; per-app pid/logs redirected into the app dir.

Each type has different validation rules in `AppManager.validateAppDeployment()`.

### Async deploy jobs (cross-cutting — how start/pull actually run)

`POST /apps/:id/start` and `POST /apps/:id/git/pull` are 202 + a background deploy job; nothing about a multi-minute deploy is allowed to block an HTTP request anymore (uploads are still synchronous — see plan non-goals). The contract an agent must preserve:

- **State lives in the shared SQLite `app_deploy_job` table, one row per app** (current or most recent job; cascades with the app row) — that is the cluster story: the claim is an atomic `INSERT ... ON CONFLICT DO UPDATE ... WHERE terminal OR stale` (`queries.claimDeployJob`), so the single-flight guard is cross-worker, deliberately NOT the plain-UPDATE polarity of `claimGitSync` (no row exists before an app's first deploy). Step/log/finish writes carry `AND pid = ?` (owner fencing) plus a terminal-status fence on step writes (a fire-and-forget `advance` must never rewrite a finished job's step — node-sqlite3 runs statements in parallel, so the race is real).
- **Status has no `queued` value** — winning the claim means `running`; the queue-wait is `step='queued'`. Terminal `succeeded`/`failed` free the lock; liveness (`DeployJobs.isLive`) additionally requires a live owner pid inside `DEPLOY_JOB_STALE_MS`, so a crashed worker stops blocking within one probe instead of for 40 minutes.
- **Step vocabulary = `utils/deploy-steps.js`** — 9 values, array order IS execution order: `queued, git, validate, install, build, nginx, launch, proxy, done`. Gated steps are reported only when their work runs (install/build by fingerprint, `nginx` only for nginx apps — it exists because `nginx -t` hanging would otherwise display as `validate`; `proxy` only with `PROXY_ENABLED`). The client renders "step N of M" off `indexOf` with the two bookends (`queued`, `done`) excluded from the denominator (AppRow.jsx).
- **After the 202 the job row is the only reporter.** `DeployRunner.startBackground` guarantees convergence (success lands `step='done'` inside the same fenced UPDATE as `finish`; any thrown value — even one with a hostile `toString` — becomes `failed` + message; no unhandled rejections). `GET /apps/:id/deploy` adds `logTail` (bounded 200 lines/64KB, ANSI-stripped) from `data/deploy-logs/<app>-<epoch>.log`; the dir is created only by a winning claim, a failed log creation degrades to `log_path=null`, and `pruneLogs` keeps 5 files/app after each run.
- **Boot convergence** (`DeployJobs.reconcileOnBoot`, run from server.js after DB ready, idempotent, every cluster worker may run it): non-terminal rows that are not live — platform restart or `pm2 reload` killing a mid-deploy worker — become `failed` with the fixed message `部署被中断（平台重启）` and KEEP the step they died on; the UI shows "interrupted" and the app can be re-deployed immediately. It writes through the query layer with the ROW's pid (finish()'s own-pid fence is an own-process rule; boot convergence is the documented exception).
- **Mutual exclusion matrix**: live deploy job → 409 on all writes to that app (and 409 on `POST /system/update`); self-update lock held → new deploy claims answer 409 `平台正在自更新，请稍后再试` (`DeployJobs.claim` consults `UpdateManager.isUpdateRunning()` via a lazy accessor — the cycle with `update-manager`'s `deployJobs()` accessor is by design and keeps src/db out of load-time requires); git sync claim held → 409 `Update in progress` (start/pull bind-gates consult `GitLifecycle.isSyncInProgress`; the claim inside `deployApp`/sync stays the last-resort guard — when a webhook wins it mid-window the job just converges to `failed` (start throws `Update in progress` from the claim check; the pull runner converts a `busy` result to the job failure `Update already in progress` — git.js's BUSY_MESSAGE); the 202 cannot be revoked).
- **`deploy` summary attach scope**: attached by `AppManager.getAllApps`/`getAppById` (single producer `toDeploySummary`, camelCase, `live` computed not copied) — so `GET /apps`, `GET /apps/:id`, `POST /apps` (null before first deploy), and the stop/restart/sync responses carry it, while the raw-row responses `PUT /apps/:id/default` and `POST /apps/restore` carry NEITHER `deploy` NOR `git`. `GET /apps/:id/deploy`'s `job` field is the identical summary.

### Platform-managed reverse proxy (cross-cutting, not a deploy type)

Opt-in via `PROXY_ENABLED`. The platform writes one nginx edge conf (`PROXY_CONF_FILE`) mapping each **running** app's subdomain (`<app>.<base-domain>`) to its port, plus an optional root-domain default app (`apps.is_default`). Regenerated on app start/stop/delete and on boot; `nginx -t` then `-s reload`, rolled back on failure. v1 does NOT issue SSL certs — it only emits the server-block shape; provision certs yourself (certbot) and fill `PROXY_SSL_*` paths.

### Git-source apps (cross-cutting, not a deploy type)

Any deploy type can additionally be bound to a Git repository (`app_git_source`; secret-free summary attached to enriched app responses as `git`, `null` when unbound — same attach scope as `deploy`, see Async deploy jobs). The repo content owns the app directory: uploads are rejected, `.git` is hidden from file listings and excluded from backups, and a zip replacement preserves `.git` (like `node_modules`). Restoring a backup of a Git-sourced app produces a plain upload app — the Git binding and `.git` are not part of the backup.

- **First start clones** the repo (depth-1 fetch of the bound branch); a failed clone fails the deploy JOB (202 already sent — the job converges to `failed` with the client-facing git cause), not the request. An existing checkout re-points `origin` at the stored URL on every start, so a URL re-bind is honored.
- **`auto_update`** (default on): start fetches and hard-resets to the remote head (fetch failure is a non-fatal warning — the app starts on the last good checkout). When off, start uses the local HEAD and a webhook only records `remote_commit` + `last_status=update_available`.
- **Sync** (manual pull — which runs as a `pull` deploy job — or webhook-triggered background sync — which does not create a job row) writes `last_status` `updating` → `success` / `failed`, tracks `deployed_commit`/`remote_commit`, and rolls back the worktree to the previous HEAD if fetch/build fails (a restart-only failure keeps the new commit). A running npm app is rebuilt and restarted; static apps serve from disk.
- **Branches/URLs:** a PUT that changes URL or branch resets deployment progress. Bind/pull/unbind return 409 while a non-stale sync claim is active or a deploy job is live.
- Private repos are NOT supported (no credential storage); the repo must be publicly cloneable.

#### GitHub webhook setup

1. Bind the source in the app's Git dialog; copy **Webhook URL** (`<public-origin>/api/webhooks/github/<appId>`) and **Webhook secret**.
2. GitHub repo → Settings → Webhooks → Add webhook: paste the payload URL, set Content type to `application/json`, paste the secret, and select **push events only**.
3. The platform must be publicly reachable from GitHub. When the platform nginx edge is in front, `/api/webhooks/` must be proxied to the backend port (5000), not to an app port, and the raw body/content type must be preserved.
4. Only pushes to the bound branch of the bound repository trigger a sync; other deliveries return 202 and are ignored. With `auto_update` off, the webhook never pulls — use **Pull update** in the Git dialog.

### Error Handling

Global error handler in `server/src/middleware/error-handler.js` catches all route errors.

Services throw descriptive errors; routes catch and map to appropriate HTTP status codes:
- 400: Validation errors, business logic errors
- 404: Resource not found
- 409: Conflict with in-flight work — live deploy job (`DeployJobs.assertIdle`/lost claim), held git sync claim, or the platform self-update lock; deploy-job 409 responses (thrown `err.status = 409`, lost-claim `busy`/`updating` — the same mapper answers a lost `gone` claim as 404) are produced ONLY by `routes/deploy-conflict.js` (`sendDeployConflict`/`sendClaimFailure`); the git-sync `Update in progress` 409s are mapped inline instead (`routes/apps.js:218/278/314/406`, `routes/git.js` `sendError(res, 409, ...)` sites)
- 500: Unexpected server errors

### Key Files to Modify

**Adding new deploy type**:
1. Update `schema.sql` CHECK constraint
2. Add case in `ProcessManager.startProcess()`
3. Add validation in `AppManager.validateAppDeployment()`

**Injecting environment variables**: `DeployManager.deployApp` calls `NpmLifecycle.resolveEnv(appId, port)` and passes `{ env }` to `ProcessManager.startProcess(app, { env })`, which writes it into the PM2 ecosystem config. User env vars live in the `app_env` table, edited via `GET/PUT /api/apps/:id/env` (UI: `EnvModal`). Env is baked at launch — changes require a restart.

**Adding new API endpoint**:
1. Add the route in the matching sub-router under `server/src/routes/` (`system.js` public health/config, `auth.js` login/me/logout, `apps.js` core `/apps*`, `git.js` `/apps/:id/git*`, `webhooks.js` public GitHub receiver, `proxy.js` proxy-routes/domains, `update.js` authenticated `/system/version` + `/system/update*`; `deploy-conflict.js` is the shared 409 mapper, not a router). `index.js` only composes them — mount order is load-bearing: public routers → `requireAuth` → `apiLimiter` → protected routers; the webhook is mounted in `app.js` before `express.json()` with `express.raw()`.
2. Use async/await for all database operations
3. Map service errors to HTTP status codes

**Database schema changes**:
1. Modify `schema.sql` (use `CREATE TABLE IF NOT EXISTS` for additive tables like `app_env` / `app_git_source` — no DB deletion needed; the server re-runs the schema on every start)
2. For breaking changes only: delete `data/microverse.sqlite` to recreate
3. Update query functions in `server/src/db/index.js`

## Testing

To manually test the complete flow:
```bash
# 1. Start servers
npm run dev

# 2. Create test app via API
curl -X POST http://localhost:5000/api/apps \
  -H "Content-Type: application/json" \
  -d '{"name":"test","deploy_type":"http-server"}'

# 3. Add HTML file
echo "<h1>Test</h1>" > apps/test/index.html

# 4. Start app (answers 202 immediately — the deploy runs as a background job)
curl -X POST http://localhost:5000/api/apps/1/start

# 5. Poll the job until its status is terminal (succeeded or failed)
curl http://localhost:5000/api/apps/1/deploy

# 6. Verify in PM2
npx pm2 list

# 7. Access app
curl http://localhost:3000  # Or assigned port
```

## Critical Notes

- Never use `better-sqlite3`; it has Windows compilation issues. Use `sqlite3` only.
- Database queries are async; always await them.
- PM2 + Windows + http-server requires special handling (see ProcessManager).
- All paths must use `path` module for cross-platform compatibility.
- Apps directory (`apps/*`) and database files (`*.sqlite`) are gitignored.
- Frontend proxy only works in development; production needs different setup.
- Git-source apps reject uploads; `.git` is preserved by zip replacement, hidden from listings, and excluded from backups. Never run `git clean -x` in an app dir (it would delete `node_modules`).
- The webhook is session-less: it is authenticated only by the per-app HMAC signature, so it must be mounted before `express.json()` with the raw body and must never trust parsed JSON before verifying.
- A deploy is allowed to take minutes (`GIT_TIMEOUT_MS` per git call + `NPM_INSTALL_TIMEOUT_MS` + `NPM_BUILD_TIMEOUT_MS`) — but that time is spent inside the background deploy job, NOT in the HTTP request: since async start, `POST /start` returns 202 after its synchronous pre-checks and the request's only meaningful cost is the PM2 reconcile (~0.2–1s `jlist`). So "slow deploy" reports must be attributed before being fixed: read the `[deploy-perf]` lines (they land in the platform log as before — `utils/lap-timer.js` only `console.log`s, and the one writer that ever appends to a job log file is npm's child output via `npm-lifecycle.js` `spawnToLogFile`), or run `node scripts/diagnose-deploy-perf.js env` (read-only) / `... start <appId>` (one instrumented direct `deployApp` call — no job/claim involved, prints per-boundary ms plus why each gate fired). Every lifecycle op also pays a PM2 CLI spawn (~0.2–1.2s) — calls slower than `ProcessManager.PM2_SLOW_MS` are logged individually.
