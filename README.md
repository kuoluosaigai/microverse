# <img src="client/public/favicon.svg" width="28" height="28" alt="Microverse" align="top"> Microverse

> Deploy and manage your micro applications with ease

**Languages:** [English](README.md) | [中文](README.zh-CN.md)

A web-based platform for deploying and managing micro applications. Create, upload, and deploy multiple small web applications with different runtime environments (npm, http-server, nginx) through a single web interface — so the long tail of one-off static sites and tiny Node services has one home instead of a dozen half-forgotten ports.

## Features

- 📁 **Application Management**: Create and organize applications in dedicated directories
- 📤 **Drag-and-drop Upload**: Upload individual files or a ZIP archive (auto-extracted on upload)
- 🚀 **Multiple Deploy Options**:
  - `http-server` — for static sites (requires `index.html`)
  - `npm` — for Node.js applications (requires `package.json` with a `start` script; auto-runs `npm install` + optional `npm run build` on start; platform assigns a port and injects `PORT` + your env vars)
  - `nginx` — for static sites served by nginx (requires nginx installed; set `NGINX_BIN` if not on `PATH`)
- 🔗 **Central Dashboard**: View and access every deployed application from one place
- ⚙️ **Port Management**: Automatic port allocation in a configurable range (3000–9000 by default)
- 📊 **Status Sync**: `Live` / `Idle` status, reconciled with actual PM2 process state
- 🔒 **Admin Login**: the dashboard and API are gated behind a single admin session (set `ADMIN_USERNAME`/`ADMIN_PASSWORD` in `.env`; the password is bcrypt-hashed on first boot)
- 💾 **Backup & Restore**: export any app as a zip (files + manifest + env) and restore it on the same or another instance. Backups include environment variables (which may contain secrets) — store and share them accordingly
- 📜 **Live Logs**: stream each app's PM2 stdout/stderr from a dedicated logs page — recent history on open, then new lines in real time
- 📈 **Resource Metrics**: per-app CPU / memory / uptime — inline on the dashboard and on a dedicated metrics page with sparkline history (sampled every 10s)
- 🌐 **Bilingual UI**: Chinese / English toggle, persisted per browser
- 🎨 **Editorial Interface**: warm-paper, serif/mono, single accent — a deliberate, non-template look (see [design spec](docs/superpowers/specs/2026-06-28-editorial-ui-redesign-design.md))

## Screenshots

**Dashboard** — apps as numbered editorial rows (shown here in `Idle` state; running apps show a red `Live` status and a clickable port chip that opens the deployed app):

![Dashboard](docs/assets/dashboard.png)

**Create Application** — underline inputs, hairline select, ink submit button:

![Create App](docs/assets/create-app.png)

**Upload Files** — paper dropzone with the live per-file size limit (`100MB per file`, fetched from `GET /api/config` and driven by `MAX_FILE_SIZE`):

![Upload Files](docs/assets/upload-files.png)

## 📚 Documentation

**New to Microverse?** Start here:
- 📖 [Installation & Usage Guide](README.md) - You're here
- 🚀 [Quick Start Guide](#quick-start) - Get up and running in 5 minutes

**For Developers:**
- 🏗️ [Architecture & Development Guide](CLAUDE.md) - Understand the codebase architecture
- 📋 [Development Progress](PROGRESS.md) - Current status and roadmap
- 🔄 [Daily Workflow Guide](WORKFLOW.md) - How to start/end your workday
- 📚 [Documentation Index](DOCS.md) - Complete documentation overview
- 🎨 [UI Design Spec](docs/superpowers/specs/2026-06-28-editorial-ui-redesign-design.md) - Editorial redesign

## Quick Start

### Prerequisites

- Node.js >= 18.0.0
- npm >= 9.0.0
- [PM2](https://pm2.keymetrics.io/) installed globally (`npm install -g pm2`) and, for `http-server` static deploys, `http-server` globally (`npm install -g http-server`)

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd microverse
```

2. Install dependencies:
```bash
npm run install:all
```

3. Create environment configuration:
```bash
cp .env.example .env
```

4. Start development servers:
```bash
# Start both frontend and backend in development mode
npm run dev

# Or start them separately:
npm run dev:server  # Backend on http://localhost:5000
npm run dev:client  # Frontend on http://localhost:5173
```

5. Open your browser and navigate to `http://localhost:5173`

### Production Deployment

In production the backend serves both the API and the built frontend UI from a
single port, so you only need to reverse-proxy that one port to your domain.

1. Build the frontend:
```bash
npm run build:client
```

2. Set production env in your `.env` (at minimum):
```env
NODE_ENV=production
PORT=5000                            # the port your reverse proxy targets
SESSION_SECRET=<long random string>  # stable across restarts (else sessions reset)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<initial password>    # bcrypt-hashed on first boot, then ignored
```

3. Run the backend — with `NODE_ENV=production` it also serves `client/dist`:
```bash
# directly
npm run start:server

# or under PM2 (cluster mode, zero-downtime reloads)
cd server
npm run pm2:start
```

4. Put a reverse proxy (nginx/caddy/…) in front of `:<PORT>` for your domain
   (TLS termination; and if you expose deployed apps under subdomains, map each
   app subdomain to its assigned port). The proxy is your infrastructure;
   Microverse does not manage it.

> To make deployed-app **Open** links use your domain instead of `localhost`,
> set `APP_PUBLIC_URL_TEMPLATE` (see [Configuration](#configuration)).

### Reverse proxy (subdomain access on port 80)

Apps listen on high ports. To reach them at `http://<app>.yourdomain.com/` on
port 80, enable the platform-managed reverse proxy:

1. Install nginx and ensure its `nginx.conf` includes the conf dir below
   (Debian/Ubuntu include `/etc/nginx/conf.d/*.conf` by default).
2. In `.env` set `PROXY_ENABLED=true` and `APP_PUBLIC_URL_TEMPLATE=http://{name}.yourdomain.com`
   (or set `PROXY_BASE_DOMAIN=yourdomain.com`).
3. Add a DNS record for each app subdomain (or a `*.yourdomain.com` wildcard)
   pointing at this server.
4. Run the platform with enough privilege to write `PROXY_CONF_FILE` and run
   `nginx -s reload` (typically: the PM2 process runs as root, or is in the
   `nginx` group with write access to the conf dir + pid file).

Start/stop/delete an app and the platform regenerates + reloads automatically.
Optionally mark one running app as the **root-domain default** (toggle on its
row) to serve `http://yourdomain.com/` from it. SSL is wired for when you
supply cert paths (`PROXY_SSL_*`); the platform does not issue certificates
itself — obtain them (e.g. `certbot`) and point the config at them.

### Updating an existing deployment

`data/*.sqlite` (apps, env, admin account) and `apps/` (deployed app files) are
gitignored, and the DB schema self-heals on boot (`CREATE TABLE IF NOT EXISTS`),
so updates never lose data and need no migration step.

```bash
git pull origin main

# only if dependencies changed in this update:
npm run install:all

# only if the frontend changed in this update:
npm run build:client

# reload the backend (PM2 cluster mode = zero downtime):
pm2 reload microverse-server
# (or restart however you run it)
```

Already-running deployed apps (the http-server/nginx/npm processes PM2 manages)
keep running through the platform update.

> **If you previously hand-edited `server/src/app.js` to serve the frontend**
> (e.g. via an automated deployment tool), the repo now does that officially.
> Drop your local patch before pulling so it doesn't conflict:
> `git checkout -- server/src/app.js` then `git pull`.

## Usage

### Creating an Application

1. Click **+ New app** in the top nav
2. Enter a unique application name (alphanumeric, dash, and underscore only)
3. Select a deployment type:
   - **Static Site (http-server)**: For HTML/CSS/JS static websites
   - **Node.js (npm)**: For Node.js applications with a `package.json` `start` script (dependencies install and an optional build run automatically on start)
   - **Nginx**: For static sites, served by nginx (install nginx separately; set `NGINX_BIN` if not on `PATH`)
4. Submit — the app appears on the dashboard as `Idle`

### Uploading Files

1. On an app's row, click **Upload**
2. Drag files onto the drop zone (or click to pick), including a `.zip` — archives are extracted automatically on upload
3. Allowed types: HTML, CSS, JS, JSON, TXT, MD, images (JPG/PNG/GIF/SVG/ICO), ZIP
4. Click **Upload Files** — you return to the dashboard

### Deploying & Accessing

1. Click **Start** on the app row — a port is assigned automatically. For **npm** apps the first start also runs `npm install` (and `npm run build` if a build script exists), so the button shows **Starting…** until the process is live.
2. The status flips to **Live** and the port becomes a clickable chip
3. Click the port chip to open the deployed app at `http://localhost:<port>`
4. Use **Stop** to take it back to **Idle**

### Managing Applications

- **Start / Stop**: Toggle an app's process via PM2
- **View Directory**: Inspect the deployed files in a modal
- **Upload**: Add or replace files
- **Logs**: Open the app's live log stream (stdout/stderr, history + real-time) on a dedicated page
- **Environment (npm only)**: Click **Environment** on an npm app's row to set key/value env vars (e.g. `API_KEY`). They're injected on the next start — change them, then restart. The platform also assigns each npm app a port and exposes it as `PORT`.
- **Delete**: Remove an app (must be stopped first; its PM2 entry is cleaned up)
- **Refresh**: Re-fetch the app list; status is reconciled with PM2 on each request via the sync endpoint

## Project Structure

```
microverse/
├── server/                 # Backend server
│   ├── src/
│   │   ├── server.js      # Process entry (listens + bootstraps)
│   │   ├── app.js         # createApp() — Express app factory (used by tests)
│   │   ├── config/        # Configuration management
│   │   ├── db/            # Database (SQLite via sqlite3)
│   │   ├── routes/        # API routes
│   │   ├── services/      # Business logic (AppManager / ProcessManager / DeployManager)
│   │   ├── middleware/    # Express middleware (errors, upload)
│   │   └── utils/         # Utility functions (path-helper)
│   └── package.json
├── client/                # Frontend application
│   ├── public/
│   │   └── favicon.svg    # Editorial grid mark
│   ├── src/
│   │   ├── pages/         # React pages (Dashboard, CreateApp, UploadFiles)
│   │   ├── components/    # EditorialShell, AppRow, LanguageSwitcher
│   │   ├── api/           # API client
│   │   ├── i18n/          # zh / en locales
│   │   └── styles/        # index.css (palette + antd neutralization) + editorial.css
│   └── package.json
├── apps/                  # Deployed applications directory (runtime data)
├── data/                  # Database files (runtime data)
└── package.json           # Root workspace configuration
```

## API Endpoints

All endpoints return `{ success, data }` or `{ success: false, error: { message } }`.

> Interactive API docs (Swagger UI): `http://localhost:5000/api-docs` — raw spec at `GET /openapi.json`.

### Applications
- `GET /api/apps` - List all applications
- `GET /api/apps/:id` - Get an application by ID
- `POST /api/apps` - Create an application (body: `{ name, deploy_type }`)
- `DELETE /api/apps/:id` - Delete an application (must be stopped)
- `POST /api/apps/:id/start` - Start (assigns a port, launches via PM2)
- `POST /api/apps/:id/stop` - Stop
- `POST /api/apps/:id/restart` - Restart
- `POST /api/apps/:id/sync` - Reconcile DB status with actual PM2 process state
- `GET /api/apps/:id/files` - List the application's deployed files
- `POST /api/apps/:id/upload` - Upload files (`multipart/form-data`, field `files`; ZIPs auto-extract)
- `GET /api/apps/:id/logs/stream` - Live log stream (SSE; emits recent history then new lines; `?lines=N`, default 100)
- `GET /api/apps/:id/env` - List an app's environment variables
- `PUT /api/apps/:id/env` - Replace an app's environment variables (`{ env: [{ key, value }] }`; applies on next start)

### System
- `GET /api/health` - Health check
- `GET /api/config` - Public client configuration (upload limits)
- `GET /` - Server information

## Configuration

Copy `.env.example` to `.env` and adjust:

```env
# Server
PORT=5000
HOST=0.0.0.0
NODE_ENV=development

# CORS
CORS_ORIGIN=http://localhost:5173

# Database
# DB_PATH=./data/microverse.sqlite

# Deployed-app port range
APP_PORT_MIN=3000
APP_PORT_MAX=9000

# File upload limits
MAX_FILE_SIZE=104857600  # 100MB in bytes
MAX_FILES=100

# Deployed-app "Open" link template ({name} -> app name); unset -> http://localhost:<port>
# APP_PUBLIC_URL_TEMPLATE=https://{name}.yourdomain.com

# npm install / build timeouts (ms, default 300000)
NPM_INSTALL_TIMEOUT_MS=300000
NPM_BUILD_TIMEOUT_MS=300000

# Admin auth (single admin) — see notes below
ADMIN_USERNAME=admin
ADMIN_PASSWORD=            # plaintext; used ONCE on first boot to seed a bcrypt hash; ignored afterwards
SESSION_SECRET=            # REQUIRED in production / PM2 cluster (see below)
# SESSION_COOKIE_SECURE=false   # force cookie Secure; default follows PROXY_SSL_ENABLED in production
# SESSION_DB_PATH=data/sessions.sqlite   # shared session store (cluster-safe, survives restarts)

# nginx binary (default 'nginx' = PATH). Used by BOTH the nginx deploy type AND
# the reverse-proxy reload. Must be a real, existing executable — see notes below.
NGINX_BIN=nginx

# PM2
PM2_INSTANCE_NAME=microverse-server

# Reverse proxy (platform-managed nginx edge; opt-in). See "Reverse proxy" above.
# PROXY_ENABLED=false
# PROXY_CONF_FILE=/etc/nginx/conf.d/microverse_apps.conf
# PROXY_BASE_DOMAIN=                # empty -> derived from APP_PUBLIC_URL_TEMPLATE
# PROXY_SSL_ENABLED=false           # SSL structure only; v1 does NOT issue certs
# PROXY_SSL_CERT=/etc/letsencrypt/live/<domain>/fullchain.pem
# PROXY_SSL_CERT_KEY=/etc/letsencrypt/live/<domain>/privkey.pem
```

> The per-file size limit is configured via `MAX_FILE_SIZE` (default 100MB), enforced by the upload middleware, and surfaced to the UI via `GET /api/config`.

**`SESSION_SECRET` — set it in production / PM2 cluster.** Every worker derives the cookie-signing key from it; if left empty, each worker signs with a different random key and rejects the others' cookies (intermittent `401 Authentication required` / random logouts). Use any long random string. Sessions live in `SESSION_DB_PATH` (sqlite), so they're shared across cluster workers and survive restarts.

**`ADMIN_PASSWORD` — first-boot only.** It's plaintext in `.env`, used once (when the `users` table is empty) to seed a bcrypt hash in the DB. Once the admin exists, changing `ADMIN_PASSWORD` in `.env` has **no effect**. To reset the password: set the new value in `.env`, delete the `users` row (or the DB), and restart — `ensureAdmin` re-seeds from the current `.env`.

**`NGINX_BIN` must point at a real nginx executable.** It's used to validate and reload the reverse-proxy config (`nginx -t` / `nginx -s reload`) and to run the nginx deploy type. If it points at a path that doesn't exist (e.g. a stale `nginx-wrapper.sh`), `nginx -t` fails, the platform rolls back the conf, and app subdomains fall through to nginx's default "Welcome to nginx" page. Symptom in logs: `⚠ [proxy] nginx -t failed: ... not found`. Fix: run `which nginx` and set `NGINX_BIN` to that path (or leave it as `nginx` if nginx is on `PATH`).

## Cross-Platform Compatibility

Designed to work on both Windows and Linux:

- **Path handling**: Node.js `path` module everywhere (no string-concatenated paths)
- **Environment variables**: `cross-env` for Windows-compatible scripts
- **File operations**: `fs` APIs instead of shell commands
- **PM2 + Windows**: PM2 fork mode can't launch `.cmd` wrappers (npm, http-server), so `ProcessManager` resolves the JS entry points (`http-server/bin/http-server`, `npm/bin/npm-cli.js`) and runs them with `interpreter: 'node'`
- **nginx deploy type**: nginx is a system binary (not an npm package). Set `NGINX_BIN` (default `nginx`) to point at it; PM2 launches it with `interpreter: 'none'` and `daemon off;`. Per-app `pid`/`error_log`/`access_log` are redirected into the app directory so nginx doesn't need write access to its install prefix.
- **Database**: uses the `sqlite3` package (not `better-sqlite3`, which has Windows compilation issues)

## Development

### Backend Development
```bash
cd server
npm run dev
```

### Frontend Development
```bash
cd client
npm run dev
```

Lint and build the frontend:
```bash
cd client
npm run lint    # ESLint, --max-warnings 0
npm run build   # Vite production build
```

### Tests

Backend unit + integration tests (Node's built-in test runner):

```bash
npm test
```

Covers pure helpers and all non-PM2 API endpoints against an isolated temp DB. PM2-dependent endpoints (start/stop/restart/sync/metrics/logs) are still manually verified.

> Note: the suite uses a glob test-runner invocation (`node --test "src/test/**/*.test.js"`) that requires Node ≥ 22; the server runtime itself supports Node ≥ 18 (`engines.node`).

### Database

SQLite stores application metadata. The database file is created automatically at `data/microverse.sqlite` on first server start. To reset it, delete the file and restart the server.

## Troubleshooting

### Port already in use
- Stop the process using that port, or change `PORT` in `.env`

### PM2 commands not found
```bash
npm install -g pm2
# or
npx pm2 list
```

### Database errors
```bash
rm data/microverse.sqlite   # Linux/Mac
del data\microverse.sqlite  # Windows
npm run dev:server
```

## Technology Stack

- **Backend**: Node.js + Express + SQLite (`sqlite3`)
- **Frontend**: React 18 + Vite + Ant Design 5 + react-i18next
- **Process Management**: PM2
- **Cross-Platform**: `path` module, `cross-env`, platform-agnostic APIs

## License

MIT © [kuoluosaigai](https://github.com/kuoluosaigai)

---

**Organization**: [kuoluosaigai](https://github.com/kuoluosaigai) - 这个世界

**Project**: microverse - Deploy your micro worlds
