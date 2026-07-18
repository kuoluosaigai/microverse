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
   - Starts/stops/restarts processes via PM2
   - **Windows-specific**: Uses http-server JS file directly (not CMD wrapper) to avoid PM2 fork mode issues
   - Finds available ports in range (3000-9000); IPv4/IPv6 dual-stack probe, excludes DB-claimed ports

3. **DeployManager** - Orchestration layer
   - Coordinates AppManager and ProcessManager
   - Assigns ports automatically (serialized via `utils/serialize.js#createExclusive` to close the TOCTOU port race)
   - Syncs database status with actual PM2 process status

Specialized services:
- **NpmLifecycle** - npm apps: `npm install` (incl. devDependencies, + optional `npm run build`) before start; resolves user env vars (`app_env` table) into the PM2 ecosystem env.
- **NginxLifecycle** - `nginx` deploy type: generates per-app nginx server block (pid/log redirected into app dir), runs `nginx -t` preflight, managed by PM2 with `interpreter: 'none'` + `daemon off;`.
- **LogManager** - SSE log streaming: resolves PM2 log paths per deploy_type, tails with `fs.watch` (byte offset, line buffer, rotation reset). nginx apps tail `nginx-access.log`/`nginx-error.log`.
- **MetricsSampler** - Resource monitoring: 10s/tick `pm2 jlist`, in-memory ring buffer (180 samples) for CPU/memory.
- **AuthManager** - Single-admin auth: bcryptjs verify, seeds admin from env on boot.
- **BackupManager** - Per-app zip export/import with `microverse-manifest.json` (name/deploy_type/env); restore validates first, rolls back on failure, 400 on name clash.
- **ProxyManager** - Platform-managed nginx edge reverse proxy (opt-in via `PROXY_ENABLED`): renders subdomain + root-default routes into `PROXY_CONF_FILE`, `nginx -t` then `-s reload`, rolls back on failure. Regenerated on app start/stop/delete and on boot.

**Call hierarchy**: Routes → DeployManager → AppManager + ProcessManager (+ NpmLifecycle / NginxLifecycle) → Database/PM2

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
- Database: DB_PATH (data/microverse.sqlite)
- PM2: PM2_INSTANCE_NAME (microverse-server)
- Admin auth: ADMIN_USERNAME, ADMIN_PASSWORD (seeded on first boot only; to reset, delete the `users` row + restart), SESSION_SECRET (REQUIRED under PM2 cluster — otherwise each worker signs with a different key → intermittent 401), SESSION_COOKIE_SECURE (follows PROXY_SSL_ENABLED), SESSION_DB_PATH (data/sessions.sqlite; shared sqlite session store so sessions survive across cluster workers + restarts)
- Nginx: NGINX_BIN (default `nginx` = PATH; used by BOTH the nginx deploy type AND the reverse-proxy reload)
- Reverse proxy (opt-in edge, see ProxyManager): PROXY_ENABLED, PROXY_CONF_FILE, PROXY_BASE_DOMAIN, PROXY_SSL_ENABLED + PROXY_SSL_CERT/KEY paths (v1 does NOT issue certs — only emits the server-block shape; run certbot yourself then fill paths)

Config is validated on startup; invalid config throws immediately.

### PM2 Ecosystem

When deploying apps, temporary PM2 ecosystem config files are created in app directories:
```javascript
// Temporary file: apps/<app-name>/pm2.<app-name>.config.js
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

Key endpoints:
- `GET /api/health` - Health check
- `GET /api/config` - Public client config (upload limits, app URL template, proxy/base-domain fields)
- `GET /api/apps` - List all apps (response includes per-app `metrics`)
- `GET /api/apps/:id` - Get app by ID
- `POST /api/apps` - Create app (body: { name, deploy_type }; name must match `^[A-Za-z0-9_-]{1,64}$`)
- `DELETE /api/apps/:id` - Delete app (must be stopped first; cleans PM2 orphan)
- `POST /api/apps/:id/start` - Start app (assigns port, launches PM2)
- `POST /api/apps/:id/stop` - Stop app
- `POST /api/apps/:id/restart` - Restart app
- `POST /api/apps/:id/sync` - Sync DB status with PM2 actual status
- `GET /api/apps/:id/files` - List deployed files
- `GET /api/apps/:id/logs/stream` - SSE stream of an app's logs (history then live; `?lines=N`)
- `GET /api/apps/:id/metrics` - Per-app resource metrics history (CPU/memory samples)
- `GET|PUT /api/apps/:id/env` - Get/set user env vars (baked at launch; restart to apply)
- `POST /api/apps/:id/upload` - Upload files (multipart field `files`; ZIPs auto-extract with zip-slip guard; single top-level folder auto-flattened)
- `GET /api/apps/:id/backup` - Download per-app backup zip (files + manifest)
- `POST /api/apps/restore` - Restore app from backup zip (validates first, rolls back on failure, 400 on name clash)
- `POST /api/apps/:id/default-app` - Mark/unmark a running app as the root-domain default (regenerates edge proxy)
- `POST /api/auth/login` | `POST /api/auth/logout` | `GET /api/auth/me` - Single-admin session

Auth: `requireAuth` gates `/api/apps*`; `/health`, `/config`, `/auth/login` are public. Rate-limited: login 5/15min/IP, API 100/min/IP (SSE exempt). Interactive API docs: swagger-ui-express at `/api-docs`; spec at `/openapi.json`.

### Deployment Types

Currently supported:
- `http-server` - Static sites (requires `index.html`)
- `npm` - Node.js apps (requires `package.json` with start script; on start auto-runs `npm install` (incl. devDependencies) + optional `npm run build`, assigns a platform port injected as `PORT`, and injects user env vars from the `app_env` table)
- `nginx` - Static sites served by nginx (requires `index.html`; nginx is a system binary — set `NGINX_BIN` if not on PATH). Managed by PM2 with `interpreter: 'none'` + `daemon off;`; per-app pid/logs redirected into the app dir.

Each type has different validation rules in `AppManager.validateAppDeployment()`.

### Platform-managed reverse proxy (cross-cutting, not a deploy type)

Opt-in via `PROXY_ENABLED`. The platform writes one nginx edge conf (`PROXY_CONF_FILE`) mapping each **running** app's subdomain (`<app>.<base-domain>`) to its port, plus an optional root-domain default app (`apps.is_default`). Regenerated on app start/stop/delete and on boot; `nginx -t` then `-s reload`, rolled back on failure. v1 does NOT issue SSL certs — it only emits the server-block shape; provision certs yourself (certbot) and fill `PROXY_SSL_*` paths.

### Error Handling

Global error handler in `server/src/middleware/error-handler.js` catches all route errors.

Services throw descriptive errors; routes catch and map to appropriate HTTP status codes:
- 400: Validation errors, business logic errors
- 404: Resource not found
- 500: Unexpected server errors

### Key Files to Modify

**Adding new deploy type**:
1. Update `schema.sql` CHECK constraint
2. Add case in `ProcessManager.startProcess()`
3. Add validation in `AppManager.validateAppDeployment()`

**Injecting environment variables**: `DeployManager.deployApp` calls `NpmLifecycle.resolveEnv(appId, port)` and passes `{ env }` to `ProcessManager.startProcess(app, { env })`, which writes it into the PM2 ecosystem config. User env vars live in the `app_env` table, edited via `GET/PUT /api/apps/:id/env` (UI: `EnvModal`). Env is baked at launch — changes require a restart.

**Adding new API endpoint**:
1. Add route in `server/src/routes/index.js`
2. Use async/await for all database operations
3. Map service errors to HTTP status codes

**Database schema changes**:
1. Modify `schema.sql` (use `CREATE TABLE IF NOT EXISTS` for additive tables like `app_env` — no DB deletion needed; the server re-runs the schema on every start)
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

# 4. Start app
curl -X POST http://localhost:5000/api/apps/1/start

# 5. Verify in PM2
npx pm2 list

# 6. Access app
curl http://localhost:3000  # Or assigned port
```

## Critical Notes

- Never use `better-sqlite3`; it has Windows compilation issues. Use `sqlite3` only.
- Database queries are async; always await them.
- PM2 + Windows + http-server requires special handling (see ProcessManager).
- All paths must use `path` module for cross-platform compatibility.
- Apps directory (`apps/*`) and database files (`*.sqlite`) are gitignored.
- Frontend proxy only works in development; production needs different setup.
