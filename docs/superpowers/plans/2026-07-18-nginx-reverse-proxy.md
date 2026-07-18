# Platform-Managed Nginx Reverse Proxy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Have the platform generate and reload system-nginx reverse-proxy config so each running app is reachable at `<name>.<baseDomain>` (and an optional root domain → a designated default app), plus ship session hardening and the login-page double-underline CSS fix.

**Architecture:** A new `ProxyManager` renders all running apps (+ the default app) into one managed nginx conf file and reloads nginx via `nginx -t` + `nginx -s reload`. Lifecycle hooks (start/stop/delete/set-default/clear-default) call a single idempotent `regenerate()`. Feature is opt-in (`PROXY_ENABLED`); SSL config structure is reserved but not issued. New `apps.is_default` column via an idempotent `ALTER TABLE` migration.

**Tech Stack:** Express, express-session, sqlite3 (async), node:test + supertest, React + Ant Design + Vite. nginx (system binary, reused via `NGINX_BIN`).

## Global Constraints

- **Database:** `sqlite3` only (never `better-sqlite3`); all DB ops are async and must be `await`ed. Additive schema uses `CREATE TABLE IF NOT EXISTS`; new columns on existing tables use the idempotent `ALTER TABLE` migration introduced in Task 1.
- **Paths:** always Node `path` module (cross-platform). App names are validated to `[A-Za-z0-9_-]` (`server/src/utils/validate-app-name.js`) — the only string interpolated into nginx `server_name`.
- **Tests:** backend `node:test` + `node:assert/strict`; integration tests use `server/src/test/helpers/setup.js` (`request()` unauth, `adminAgent()` authed, plus exported `queries`/`dbReady`). Run backend tests with `npm test` from repo root. Each test file gets its own per-`pid` temp DB, so give apps unique names within a file. Frontend: `cd client && npm run lint && npm run build`.
- **Commits:** commit on `main`; end every commit message with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- **Opt-in / non-fatal:** reverse-proxy regeneration must NEVER block or break app start/stop/delete. When disabled, misconfigured, or nginx-absent, it is a no-op + warning log.
- **Spec:** `docs/superpowers/specs/2026-07-18-nginx-reverse-proxy-design.md`. Supersedes the "no reverse proxy" scope decision in `docs/superpowers/specs/2026-07-18-domain-deploy-hardening-design.md`.

---

## File Structure

**New backend files:**
- `server/src/services/proxy-manager.js` — pure `renderProxyConfig(apps, opts)` + async `regenerate({ execFn })` + `resolveBaseDomain()`. One responsibility: render + persist + reload the edge proxy config.

**Modified backend:**
- `server/src/db/schema.sql` — add `apps.is_default` column (for fresh DBs).
- `server/src/db/index.js` — idempotent `applyMigrations()`; extend `queries.updateApp` (`is_default`); add `queries.clearDefaultApp` / `queries.setDefaultApp`; export `dbAll` + `applyMigrations`.
- `server/src/config/index.js` — `deployment.proxy*` keys; `auth.sessionCookieSecure`.
- `server/src/services/deploy-manager.js` — call `ProxyManager.regenerate()` after start/stop.
- `server/src/services/app-manager.js` — call `ProxyManager.regenerate()` after delete.
- `server/src/routes/index.js` — `PUT/DELETE /api/apps/:id/default`; `GET /api/config` adds `proxyEnabled`/`proxyBaseDomain`; require `queries` + `ProxyManager`.
- `server/src/app.js` — `trust proxy`, session `resave`/`rolling`/`maxAge`/`secure`.
- `.env.example` — `PROXY_*`, `SESSION_COOKIE_SECURE`.

**New backend tests:**
- `server/src/test/unit/proxy-config.test.js` — pure renderer.
- `server/src/test/integration/default-app.test.js` — migration + `setDefaultApp`/`updateApp` + deleteApp hook.
- `server/src/test/integration/proxy-regenerate.test.js` — `regenerate()` short-circuits + write/reload with stubbed exec.
- `server/src/test/integration/proxy-default-route.test.js` — `PUT/DELETE /api/apps/:id/default` + `/api/config` fields.
- `server/src/test/integration/session-hardening.test.js` — `trust proxy` set.

**Modified frontend:**
- `client/src/api/apps.js` — `setAppDefault(id)` / `clearAppDefault(id)`.
- `client/src/components/AppRow.jsx` — "root-domain default app" Switch (only when proxy enabled + running).
- `client/src/pages/Dashboard.jsx` — `handleToggleDefault` wired into `AppRow`.
- `client/src/i18n/locales/en.json` + `zh.json` — Switch labels.
- `client/src/styles/index.css` — kill the affix-wrapper inner-input double underline.

**Docs:** `README.md`, `README.zh-CN.md`, `PROGRESS.md`, prior design doc note.

---

## Task 1: `apps.is_default` column + idempotent migration + DB queries

**Files:**
- Modify: `server/src/db/schema.sql:4-13`
- Modify: `server/src/db/index.js` (initDatabase ~:67-81; queries ~:109-124; exports ~:162-166)
- Test: `server/src/test/integration/default-app.test.js`

**Interfaces:**
- Produces: `queries.updateApp` now accepts `is_default` (COALESCE); `queries.clearDefaultApp()`; `queries.setDefaultApp(id)` (transactional single-default, returns the app row); `dbAll(sql)` exported; `applyMigrations()` exported and called from `initDatabase()`.

- [ ] **Step 1: Add the column to `schema.sql` for fresh DBs**

In `server/src/db/schema.sql`, insert `is_default` into the `apps` table between `port` and `status`:

```sql
CREATE TABLE IF NOT EXISTS apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  deploy_type TEXT CHECK(deploy_type IN ('npm', 'http-server', 'nginx')),
  port INTEGER,
  is_default INTEGER NOT NULL DEFAULT 0,
  status TEXT CHECK(status IN ('running', 'stopped')) DEFAULT 'stopped',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

- [ ] **Step 2: Add the migration + queries + exports in `db/index.js`**

2a. Replace the body of `initDatabase()` (currently `server/src/db/index.js:67-81`) with:

```js
async function initDatabase() {
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    await dbExec(schema);
    await applyMigrations();

    console.log('✓ Database initialized successfully');
    console.log(`✓ Database path: ${DB_PATH}`);
  } catch (error) {
    console.error('✗ Database initialization failed:', error.message);
    throw error;
  }
}

// Additive column migrations. CREATE TABLE IF NOT EXISTS will not add columns
// to an existing table, so each new column needs an ALTER guarded by presence.
// Idempotent: safe on fresh DBs (column already in schema) and existing DBs.
async function applyMigrations() {
  const cols = await dbAll(`PRAGMA table_info(apps)`);
  if (!cols.some(c => c.name === 'is_default')) {
    await dbExec(`ALTER TABLE apps ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0`);
    console.log('✓ Migration: added apps.is_default column');
  }
}
```

2b. Replace the `updateApp` query (currently `:109-120`) and add `clearDefaultApp` / `setDefaultApp` right after it:

```js
  updateApp: async (params) => {
    const result = await dbRun(
      `UPDATE apps SET
        path = COALESCE(?, path),
        deploy_type = COALESCE(?, deploy_type),
        port = COALESCE(?, port),
        status = COALESCE(?, status),
        is_default = COALESCE(?, is_default)
      WHERE id = ?`,
      [params.path, params.deploy_type, params.port, params.status, params.is_default, params.id]
    );
    return result;
  },

  // Clear every app's default flag (used inside setDefaultApp's transaction).
  clearDefaultApp: () => dbRun('UPDATE apps SET is_default = 0 WHERE is_default = 1'),

  // Single-default: atomically clear all, then set one. Returns the updated row.
  setDefaultApp: async (id) => {
    await dbRun('BEGIN TRANSACTION');
    try {
      await dbRun('UPDATE apps SET is_default = 0 WHERE is_default = 1');
      await dbRun('UPDATE apps SET is_default = 1 WHERE id = ?', [id]);
      await dbRun('COMMIT');
    } catch (err) {
      await dbRun('ROLLBACK').catch(() => { /* ignore rollback failure */ });
      throw err;
    }
    return dbGet('SELECT * FROM apps WHERE id = ?', [id]);
  },
```

2c. Extend the `module.exports` (currently `:162-166`) to also expose `dbAll` and `applyMigrations`:

```js
module.exports = {
  db,
  queries,
  dbReady,
  dbAll,
  applyMigrations
};
```

- [ ] **Step 3: Write the failing test**

Create `server/src/test/integration/default-app.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { init, queries } = require('../helpers/setup');
const { dbAll, applyMigrations } = require('../../db');

test('apps.is_default column exists after init', async () => {
  await init();
  const cols = await dbAll('PRAGMA table_info(apps)');
  assert.ok(cols.some(c => c.name === 'is_default'), 'is_default column present');
});

test('applyMigrations is idempotent', async () => {
  await init();
  await applyMigrations(); // column already present -> no-op, must not throw
  const cols = await dbAll('PRAGMA table_info(apps)');
  assert.equal(cols.filter(c => c.name === 'is_default').length, 1);
});

test('setDefaultApp enforces a single default', async () => {
  await init();
  const a1 = await queries.createApp({ name: 'default-a', path: '/tmp/a', deploy_type: 'http-server', port: 3001, status: 'running' });
  const a2 = await queries.createApp({ name: 'default-b', path: '/tmp/b', deploy_type: 'http-server', port: 3002, status: 'running' });

  await queries.setDefaultApp(a1.lastID);
  let rows = await queries.getAllApps();
  assert.equal(rows.find(r => r.id === a1.lastID).is_default, 1);
  assert.equal(rows.find(r => r.id === a2.lastID).is_default, 0);

  await queries.setDefaultApp(a2.lastID);
  rows = await queries.getAllApps();
  assert.equal(rows.find(r => r.id === a2.lastID).is_default, 1);
  assert.equal(rows.find(r => r.id === a1.lastID).is_default, 0, 'previous default cleared');
});

test('updateApp clears is_default via COALESCE', async () => {
  await init();
  const a = await queries.createApp({ name: 'default-c', path: '/tmp/c', deploy_type: 'http-server', port: 3003, status: 'running' });
  await queries.setDefaultApp(a.lastID);
  await queries.updateApp({ id: a.lastID, is_default: 0 });
  const rows = await queries.getAllApps();
  assert.equal(rows.find(r => r.id === a.lastID).is_default, 0);
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: the four new tests PASS (the column + queries land in the same change), and all pre-existing tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/schema.sql server/src/db/index.js server/src/test/integration/default-app.test.js
git commit -m "$(cat <<'EOF'
feat(db): add apps.is_default + idempotent migration + default-app queries

Introduces a minimal migration mechanism (PRAGMA-guarded ALTER) so additive
columns reach existing DBs without recreation. setDefaultApp enforces a single
root-domain default app transactionally.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `renderProxyConfig` pure renderer (TDD)

**Files:**
- Create: `server/src/services/proxy-manager.js`
- Test: `server/src/test/unit/proxy-config.test.js`

**Interfaces:**
- Produces: `renderProxyConfig(apps, opts)` → `string`; `validateBaseDomain(domain)` → throws on invalid; `resolveBaseDomain({ proxyBaseDomain, appPublicUrlTemplate })` → `string` (pure, no config import so it is unit-testable). `apps` items need `{ name, port, status, is_default }`; `opts` is `{ baseDomain, ssl: { enabled, cert, key } }`.

- [ ] **Step 1: Write the failing test**

Create `server/src/test/unit/proxy-config.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderProxyConfig, validateBaseDomain, resolveBaseDomain } = require('../../services/proxy-manager');

const app = (over) => ({ name: 'sticky', port: 3001, status: 'running', is_default: 0, ...over });

test('running app -> one HTTP server block on <name>.<base>', () => {
  const conf = renderProxyConfig([app()], { baseDomain: 'kuoluosaigai.com', ssl: {} });
  assert.match(conf, /server_name sticky\.kuoluosaigai\.com;/);
  assert.match(conf, /listen 80;/);
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:3001;/);
  assert.match(conf, /proxy_set_header X-Forwarded-Proto \$scheme;/);
  assert.doesNotMatch(conf, /listen 443/);
});

test('stopped app and portless running app produce no server block', () => {
  const stopped = renderProxyConfig([app({ status: 'stopped' })], { baseDomain: 'x.com', ssl: {} });
  assert.doesNotMatch(stopped, /server_name/);

  const portless = renderProxyConfig([app({ port: null })], { baseDomain: 'x.com', ssl: {} });
  assert.doesNotMatch(portless, /server_name/);
});

test('default running app gets an extra root-domain block', () => {
  const conf = renderProxyConfig([app({ is_default: 1 })], { baseDomain: 'kuoluosaigai.com', ssl: {} });
  assert.match(conf, /server_name kuoluosaigai\.com www\.kuoluosaigai\.com;/);
});

test('default flag is ignored when the app is not running', () => {
  const conf = renderProxyConfig([app({ is_default: 1, status: 'stopped' })], { baseDomain: 'x.com', ssl: {} });
  assert.doesNotMatch(conf, /server_name x\.com www\.x\.com/);
});

test('multiple running apps are emitted sorted by name', () => {
  const conf = renderProxyConfig(
    [app({ name: 'zeta' }), app({ name: 'alpha' })],
    { baseDomain: 'x.com', ssl: {} }
  );
  const ia = conf.indexOf('alpha.x.com');
  const iz = conf.indexOf('zeta.x.com');
  assert.ok(ia > -1 && iz > -1 && ia < iz, 'alpha before zeta');
});

test('no running apps -> header-only (no server block)', () => {
  const conf = renderProxyConfig([], { baseDomain: 'x.com', ssl: {} });
  assert.match(conf, /Managed by Microverse/);
  assert.doesNotMatch(conf, /server \{/);
});

test('missing or invalid baseDomain throws', () => {
  assert.throws(() => renderProxyConfig([app()], { baseDomain: '', ssl: {} }));
  assert.throws(() => renderProxyConfig([app()], { baseDomain: 'bad domain', ssl: {} }));
  assert.throws(() => validateBaseDomain(''));
  assert.throws(() => validateBaseDomain('a b;c'));
});

test('ssl enabled with cert+key -> 443 ssl block + 80->443 redirect', () => {
  const conf = renderProxyConfig([app()], {
    baseDomain: 'x.com',
    ssl: { enabled: true, cert: '/c.pem', key: '/k.pem' }
  });
  assert.match(conf, /listen 443 ssl;/);
  assert.match(conf, /ssl_certificate\s+\/c\.pem;/);
  assert.match(conf, /ssl_certificate_key\s+\/k\.pem;/);
  assert.match(conf, /return 301 https:\/\/\$host\$request_uri;/);
});

test('ssl enabled but missing cert/key falls back to HTTP-only', () => {
  const conf = renderProxyConfig([app()], { baseDomain: 'x.com', ssl: { enabled: true } });
  assert.doesNotMatch(conf, /listen 443/);
  assert.match(conf, /listen 80;/);
});

test('resolveBaseDomain prefers explicit, else derives from template', () => {
  assert.equal(resolveBaseDomain({ proxyBaseDomain: 'a.com', appPublicUrlTemplate: '' }), 'a.com');
  assert.equal(resolveBaseDomain({ proxyBaseDomain: '', appPublicUrlTemplate: 'http://{name}.b.com' }), 'b.com');
  assert.equal(resolveBaseDomain({ proxyBaseDomain: '', appPublicUrlTemplate: 'https://{name}.sub.c.io' }), 'sub.c.io');
  assert.equal(resolveBaseDomain({ proxyBaseDomain: '', appPublicUrlTemplate: '' }), '');
  assert.equal(resolveBaseDomain({ proxyBaseDomain: '', appPublicUrlTemplate: 'noscheme-{name}.c.com' }), '');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../services/proxy-manager'`.

- [ ] **Step 3: Write `proxy-manager.js` with the pure functions only (no `regenerate` yet)**

Create `server/src/services/proxy-manager.js`:

```js
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);

const HEADER = '# Managed by Microverse — do not edit by hand; regenerated on app lifecycle.';

/**
 * Validate a base domain. Only the whitelist passes — this is the one admin-
 * controlled string interpolated into nginx server_name, so it must be tame.
 * @param {string} baseDomain
 */
function validateBaseDomain(baseDomain) {
  if (!baseDomain || !/^[\w.-]+$/.test(baseDomain)) {
    throw new Error('Invalid or missing base domain for proxy config');
  }
}

/**
 * Pure: resolve the base domain from explicit config or the public URL template
 * (strip the `{name}.` prefix). Returns '' if neither yields one. Config values
 * are passed in (not imported) so this is unit-testable without the config singleton.
 */
function resolveBaseDomain({ proxyBaseDomain, appPublicUrlTemplate }) {
  if (proxyBaseDomain) return proxyBaseDomain;
  const tpl = appPublicUrlTemplate || '';
  const m = tpl.match(/^\w+:\/\/\{name\}\.([^\s/]+)/i);
  return m ? m[1] : '';
}

function locationBlock(port) {
  return [
    '    location / {',
    `      proxy_pass http://127.0.0.1:${port};`,
    '      proxy_set_header Host              $host;',
    '      proxy_set_header X-Real-IP         $remote_addr;',
    '      proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;',
    '      proxy_set_header X-Forwarded-Proto $scheme;',
    '    }'
  ].join('\n');
}

function renderServerBlock(host, port, ssl) {
  const loc = locationBlock(port);
  if (ssl && ssl.enabled && ssl.cert && ssl.key) {
    return [
      'server {',
      '    listen 80;',
      `    server_name ${host};`,
      '    return 301 https://$host$request_uri;',
      '}',
      'server {',
      '    listen 443 ssl;',
      `    server_name ${host};`,
      `    ssl_certificate     ${ssl.cert};`,
      `    ssl_certificate_key ${ssl.key};`,
      loc,
      '}'
    ].join('\n');
  }
  return [
    'server {',
    '    listen 80;',
    `    server_name ${host};`,
    loc,
    '}'
  ].join('\n');
}

/**
 * Pure: render the full managed nginx conf for the given apps.
 * @param {Array<{name:string,port:number,status:string,is_default:number}>} apps
 * @param {{baseDomain:string, ssl:{enabled?:boolean,cert?:string,key?:string}}} opts
 * @returns {string}
 */
function renderProxyConfig(apps, opts) {
  const { baseDomain, ssl } = opts;
  validateBaseDomain(baseDomain);

  const running = apps
    .filter(a => a.status === 'running' && a.port)
    .sort((a, b) => a.name.localeCompare(b.name));

  const blocks = running.map(a => renderServerBlock(`${a.name}.${baseDomain}`, a.port, ssl));

  const def = running.find(a => a.is_default);
  if (def) {
    blocks.push(renderServerBlock(`${baseDomain} www.${baseDomain}`, def.port, ssl));
  }

  if (blocks.length === 0) return HEADER + '\n';
  return HEADER + '\n' + blocks.join('\n\n') + '\n';
}

module.exports = { renderProxyConfig, validateBaseDomain, resolveBaseDomain };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: all 10 `proxy-config` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/proxy-manager.js server/src/test/unit/proxy-config.test.js
git commit -m "$(cat <<'EOF'
feat(proxy): pure nginx-conf renderer for app subdomains + root default

renderProxyConfig emits one HTTP server block per running app
(<name>.<baseDomain> -> 127.0.0.1:port) plus a root-domain block for the
designated default app. SSL form (443 + 80->443) renders only when cert+key
are configured. Pure / side-effect-free for unit testing.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `regenerate()` + proxy config keys

**Files:**
- Modify: `server/src/config/index.js:32-74`
- Modify: `server/src/services/proxy-manager.js` (add `regenerate`, update exports)
- Test: `server/src/test/integration/proxy-regenerate.test.js`

**Interfaces:**
- Consumes: `renderProxyConfig`/`resolveBaseDomain` (Task 2); `queries.getAllApps()` (Task 1).
- Produces: `ProxyManager.regenerate({ execFn } = {})` → `Promise<{ok, skipped?, reason?, message?}>`. Reads config live (`config.deployment.proxyEnabled|proxyConfFile|proxyReloadBinary|proxyBaseDomain|proxySsl*`). Never throws.

- [ ] **Step 1: Add config keys in `server/src/config/index.js`**

1a. Inside the `deployment` object (after `appPublicUrlTemplate`, ~line 56), add:

```js
    // Reverse-proxy: platform-managed nginx edge config (opt-in). When enabled,
    // the app regenerates <proxyConfFile> from all running apps and reloads
    // nginx. See docs/superpowers/specs/2026-07-18-nginx-reverse-proxy-design.md.
    proxyEnabled: process.env.PROXY_ENABLED === 'true',
    proxyConfFile: process.env.PROXY_CONF_FILE || '/etc/nginx/conf.d/microverse_apps.conf',
    proxyBaseDomain: process.env.PROXY_BASE_DOMAIN || '',
    proxyReloadBinary: process.env.NGINX_BIN || 'nginx',
    // SSL structure reservation (v1 does NOT issue certs):
    proxySslEnabled: process.env.PROXY_SSL_ENABLED === 'true',
    proxySslCert: process.env.PROXY_SSL_CERT || '',
    proxySslCertKey: process.env.PROXY_SSL_CERT_KEY || '',
```

1b. Inside the `auth` object (after `sessionSecret`, ~line 72), add:

```js
    sessionCookieSecure: process.env.SESSION_COOKIE_SECURE === 'true'
```

- [ ] **Step 2: Write the failing test**

Create `server/src/test/integration/proxy-regenerate.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { init, queries } = require('../helpers/setup');
const config = require('../../config');
const ProxyManager = require('../../services/proxy-manager');

function tmpConf() { return path.join(os.tmpdir(), `mvx-proxy-${process.pid}-${Math.floor(Math.random() * 1e9)}.conf`); }

// Save/restore the config knobs each test mutates so tests stay isolated.
function snapshot() {
  return {
    proxyEnabled: config.deployment.proxyEnabled,
    proxyBaseDomain: config.deployment.proxyBaseDomain,
    proxyConfFile: config.deployment.proxyConfFile,
    proxySslEnabled: config.deployment.proxySslEnabled,
    proxySslCert: config.deployment.proxySslCert,
    proxySslCertKey: config.deployment.proxySslCertKey
  };
}
function restore(s) { Object.assign(config.deployment, s); }

test('regenerate is a no-op when proxy disabled', async () => {
  const s = snapshot();
  config.deployment.proxyEnabled = false;
  try {
    const r = await ProxyManager.regenerate();
    assert.equal(r.skipped, true);
    assert.equal(r.reason, 'disabled');
  } finally { restore(s); }
});

test('regenerate skips with a warning when base domain is missing', async () => {
  const s = snapshot();
  config.deployment.proxyEnabled = true;
  config.deployment.proxyBaseDomain = '';
  // Also ensure no template-derived domain leaks in from the env:
  const prevTpl = config.deployment.appPublicUrlTemplate;
  config.deployment.appPublicUrlTemplate = '';
  try {
    const r = await ProxyManager.regenerate();
    assert.equal(r.ok, false);
    assert.equal(r.skipped, true);
    assert.equal(r.reason, 'no-base-domain');
  } finally {
    config.deployment.appPublicUrlTemplate = prevTpl;
    restore(s);
  }
});

test('regenerate writes conf and runs nginx -t then -s reload', async () => {
  const s = snapshot();
  const confFile = tmpConf();
  config.deployment.proxyEnabled = true;
  config.deployment.proxyBaseDomain = 'example.com';
  config.deployment.proxyConfFile = confFile;
  config.deployment.proxySslEnabled = false;
  await init();
  const a = await queries.createApp({ name: 'proxyren-' + Math.floor(Math.random() * 1e9), path: '/tmp/p', deploy_type: 'http-server', port: 3333, status: 'running' });
  const calls = [];
  const execFn = async (cmd) => { calls.push(cmd); return { stdout: '', stderr: '' }; };
  try {
    const r = await ProxyManager.regenerate({ execFn });
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(confFile));
    assert.match(fs.readFileSync(confFile, 'utf-8'), /server_name .*\.example\.com;/);
    assert.match(calls.join(' | '), /-t/);
    assert.match(calls.join(' | '), /-s reload/);
  } finally {
    try { fs.unlinkSync(confFile); } catch (_e) {}
    await queries.deleteApp(a.lastID).catch(() => {});
    restore(s);
  }
});

test('regenerate does NOT reload when nginx -t fails', async () => {
  const s = snapshot();
  const confFile = tmpConf();
  config.deployment.proxyEnabled = true;
  config.deployment.proxyBaseDomain = 'example.com';
  config.deployment.proxyConfFile = confFile;
  config.deployment.proxySslEnabled = false;
  await init();
  const execFn = async (cmd) => {
    if (cmd.includes(' -t')) {
      throw Object.assign(new Error('syntax error'), { stderr: 'nginx: syntax error' });
    }
    throw new Error('reload must not run when -t failed');
  };
  try {
    const r = await ProxyManager.regenerate({ execFn });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'test-failed');
  } finally {
    try { fs.unlinkSync(confFile); } catch (_e) {}
    restore(s);
  }
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `ProxyManager.regenerate is not a function`.

- [ ] **Step 4: Implement `regenerate` in `server/src/services/proxy-manager.js`**

4a. At the top of the file, add the config + db requires (after the existing `util` require):

```js
const config = require('../config');
const { queries } = require('../db');
```

4b. Before `module.exports`, add:

```js
function binError(bin, err, lead) {
  if (err.code === 'ENOENT' || /command not found|not recognized|127/.test(err.message || '')) {
    return `nginx binary not found ('${bin}')`;
  }
  return `${lead}: ${(err.stderr || err.stdout || err.message || '').trim().slice(-400)}`;
}

/**
 * Regenerate the managed edge-proxy conf from all apps, then test + reload nginx.
 * Never throws: every failure is caught and returned as { ok:false } + warning,
 * so app start/stop/delete are never blocked by a proxy problem.
 *
 * @param {{ execFn?: (cmd:string, opts:object) => Promise<{stdout:string,stderr:string}> }} scope
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, message?:string}>}
 */
async function regenerate(scope = {}) {
  const execFn = scope.execFn || ((cmd, opts) => execPromise(cmd, opts));

  if (!config.deployment.proxyEnabled) {
    return { ok: true, skipped: true, reason: 'disabled' };
  }

  const baseDomain = resolveBaseDomain({
    proxyBaseDomain: config.deployment.proxyBaseDomain,
    appPublicUrlTemplate: config.deployment.appPublicUrlTemplate
  });
  if (!baseDomain) {
    console.warn('⚠ [proxy] PROXY_ENABLED but no base domain (set PROXY_BASE_DOMAIN or APP_PUBLIC_URL_TEMPLATE). Skipping.');
    return { ok: false, skipped: true, reason: 'no-base-domain' };
  }

  const ssl = {
    enabled: config.deployment.proxySslEnabled,
    cert: config.deployment.proxySslCert,
    key: config.deployment.proxySslCertKey
  };

  let conf;
  try {
    const apps = await queries.getAllApps();
    conf = renderProxyConfig(apps, { baseDomain, ssl });
  } catch (err) {
    console.warn(`⚠ [proxy] render failed: ${err.message}`);
    return { ok: false, reason: 'render-failed', message: err.message };
  }

  const confFile = config.deployment.proxyConfFile;
  const bin = config.deployment.proxyReloadBinary;
  const EXEC_OPTS = { timeout: 15000, maxBuffer: 1024 * 1024 };

  try {
    const dir = path.dirname(confFile);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = confFile + '.tmp';
    fs.writeFileSync(tmp, conf.endsWith('\n') ? conf : conf + '\n', 'utf-8');
    fs.renameSync(tmp, confFile); // atomic replace
  } catch (err) {
    console.warn(`⚠ [proxy] could not write ${confFile}: ${err.message}`);
    return { ok: false, reason: 'write-failed', message: err.message };
  }

  // `nginx -t` validates the ENTIRE main config (incl. our include), not just
  // our file — so a bad vhost anywhere still blocks reload. Never reload on fail.
  try {
    await execFn(`"${bin}" -t`, EXEC_OPTS);
  } catch (err) {
    const msg = binError(bin, err, 'nginx -t failed');
    console.warn(`⚠ [proxy] ${msg} — config NOT reloaded.`);
    return { ok: false, reason: 'test-failed', message: msg };
  }

  try {
    await execFn(`"${bin}" -s reload`, EXEC_OPTS);
  } catch (err) {
    const msg = binError(bin, err, 'nginx reload failed');
    console.warn(`⚠ [proxy] ${msg}`);
    return { ok: false, reason: 'reload-failed', message: msg };
  }

  return { ok: true };
}
```

4c. Update `module.exports`:

```js
module.exports = { renderProxyConfig, validateBaseDomain, resolveBaseDomain, regenerate };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: all four `proxy-regenerate` tests PASS; everything else still green.

- [ ] **Step 6: Commit**

```bash
git add server/src/config/index.js server/src/services/proxy-manager.js server/src/test/integration/proxy-regenerate.test.js
git commit -m "$(cat <<'EOF'
feat(proxy): regenerate() writes conf + nginx -t/-s reload (opt-in)

ProxyManager.regenerate renders all running apps into the managed conf file,
atomic-replaces it, then reloads the system nginx. nginx -t gates reload so a
bad config never takes the edge down. Disabled / no-base-domain / nginx-absent
all degrade to no-op + warning, never blocking app lifecycle. Adds PROXY_*
config keys (SSL keys reserved, not issued).

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Lifecycle hooks — call `regenerate()` on start / stop / delete

**Files:**
- Modify: `server/src/services/deploy-manager.js:1-7, 76-100`
- Modify: `server/src/services/app-manager.js:1-7, 120-126`
- Test: `server/src/test/integration/default-app.test.js` (extend)

**Interfaces:**
- Consumes: `ProxyManager.regenerate()` (Task 3).
- Produces: start/stop/delete each trigger a proxy regeneration (best-effort).

- [ ] **Step 1: Wire the hooks**

1a. In `server/src/services/deploy-manager.js`, add the require with the others near the top (after `const NginxLifecycle = require('./nginx-lifecycle');`):

```js
const ProxyManager = require('./proxy-manager');
```

1b. In `DeployManager.deployApp`, after `await queries.updateAppStatus('running', appId);` (and before `return AppManager.getAppById(appId);`), insert:

```js
    // Best-effort: refresh the edge-proxy routes so this app's subdomain is
    // reachable. Never let a proxy problem block the deploy.
    try { await ProxyManager.regenerate(); } catch (e) { console.warn(`[proxy] regenerate after start failed: ${e.message}`); }
```

1c. In `DeployManager.stopApp`, after `await queries.updateAppStatus('stopped', appId);` (before `return`), insert:

```js
    try { await ProxyManager.regenerate(); } catch (e) { console.warn(`[proxy] regenerate after stop failed: ${e.message}`); }
```

1d. In `server/src/services/app-manager.js`, add the require near the top (after `const NpmLifecycle = require('./npm-lifecycle');`):

```js
const ProxyManager = require('./proxy-manager');
```

1e. In `AppManager.deleteApp`, after `await queries.deleteApp(id);` (before the closing comment/`return true;`), insert:

```js
    try { await ProxyManager.regenerate(); } catch (e) { console.warn(`[proxy] regenerate after delete failed: ${e.message}`); }
```

- [ ] **Step 2: Extend the test to prove the delete hook fires**

Append to `server/src/test/integration/default-app.test.js`:

```js
const AppManager = require('../../services/app-manager');

test('deleteApp triggers a proxy regenerate', async () => {
  await init();
  const a = await queries.createApp({ name: 'del-hook', path: '/tmp/dh', deploy_type: 'http-server', port: null, status: 'stopped' });
  const ProxyManager = require('../../services/proxy-manager');
  const orig = ProxyManager.regenerate;
  let called = false;
  ProxyManager.regenerate = async () => { called = true; return { ok: true }; };
  try {
    await AppManager.deleteApp(a.lastID);
    assert.equal(called, true, 'regenerate called on delete');
    // app actually gone from DB
    const rows = await queries.getAllApps();
    assert.ok(!rows.some(r => r.id === a.lastID));
  } finally {
    ProxyManager.regenerate = orig;
  }
});
```

- [ ] **Step 3: Run the tests**

Run: `npm test`
Expected: the new `deleteApp triggers a proxy regenerate` test PASSES; all others green. (start/stop hooks are symmetric one-liners; they require a real PM2 process to exercise, so they are covered by code review + the manual verification in Task 9.)

- [ ] **Step 4: Commit**

```bash
git add server/src/services/deploy-manager.js server/src/services/app-manager.js server/src/test/integration/default-app.test.js
git commit -m "$(cat <<'EOF'
feat(proxy): regenerate edge-proxy routes on app start/stop/delete

DeployManager.deployApp/stopApp and AppManager.deleteApp now best-effort call
ProxyManager.regenerate() so subdomain routes appear/disappear with the app.
Failures are warned and swallowed so lifecycle ops are never blocked.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `PUT/DELETE /api/apps/:id/default` + `/api/config` proxy fields

**Files:**
- Modify: `server/src/routes/index.js:9-18, 37-48, ~623`
- Test: `server/src/test/integration/proxy-default-route.test.js`

**Interfaces:**
- Consumes: `queries.setDefaultApp` / `queries.updateApp` (Task 1); `ProxyManager.regenerate` (Task 3); `AppManager.getAppById`.
- Produces: `PUT /api/apps/:id/default` (auth required) → sets single default, regenerates, returns the app row; `DELETE /api/apps/:id/default` → clears that app's default, regenerates; `GET /api/config` now also returns `proxyEnabled`, `proxyBaseDomain`.

- [ ] **Step 1: Write the failing test**

Create `server/src/test/integration/proxy-default-route.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request, adminAgent, queries } = require('../helpers/setup');
const ProxyManager = require('../../services/proxy-manager');

async function seed(name) {
  const a = await queries.createApp({ name, path: `/tmp/${name}`, deploy_type: 'http-server', port: 4001, status: 'running' });
  return a.lastID;
}

test('default routes require auth', async () => {
  const r1 = await request().put('/api/apps/1/default');
  assert.equal(r1.status, 401);
  const r2 = await request().delete('/api/apps/1/default');
  assert.equal(r2.status, 401);
});

test('GET /api/config exposes proxyEnabled + proxyBaseDomain', async () => {
  const res = await request().get('/api/config');
  assert.equal(res.status, 200);
  assert.ok('proxyEnabled' in res.body.data);
  assert.ok('proxyBaseDomain' in res.body.data);
});

test('PUT /default sets a single default and regenerates', async () => {
  const agent = await adminAgent();
  const idA = await seed('route-a');
  const idB = await seed('route-b');
  const orig = ProxyManager.regenerate;
  let called = 0;
  ProxyManager.regenerate = async () => { called++; return { ok: true }; };
  try {
    const r1 = await agent.put(`/api/apps/${idA}/default`);
    assert.equal(r1.status, 200);
    assert.equal(r1.body.data.is_default, 1);

    await agent.put(`/api/apps/${idB}/default`);
    const rows = await queries.getAllApps();
    assert.equal(rows.find(r => r.id === idA).is_default, 0);
    assert.equal(rows.find(r => r.id === idB).is_default, 1);
    assert.ok(called >= 2, 'regenerate called on each set');
  } finally {
    ProxyManager.regenerate = orig;
  }
});

test('DELETE /default clears the flag and regenerates', async () => {
  const agent = await adminAgent();
  const id = await seed('route-c');
  const orig = ProxyManager.regenerate;
  let called = false;
  ProxyManager.regenerate = async () => { called = true; return { ok: true }; };
  try {
    await agent.put(`/api/apps/${id}/default`);
    const r = await agent.delete(`/api/apps/${id}/default`);
    assert.equal(r.status, 200);
    const rows = await queries.getAllApps();
    assert.equal(rows.find(row => row.id === id).is_default, 0);
    assert.equal(called, true);
  } finally {
    ProxyManager.regenerate = orig;
  }
});

test('PUT /default on a missing app returns 404', async () => {
  const agent = await adminAgent();
  const r = await agent.put('/api/apps/999999/default');
  assert.equal(r.status, 404);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — 404 on `PUT /api/apps/1/default` (route doesn't exist yet).

- [ ] **Step 3: Wire the routes**

3a. In `server/src/routes/index.js`, add these requires near the top (after `const { flattenSingleTopDir } = require('../utils/flatten-zip-root');`):

```js
const { queries } = require('../db');
const ProxyManager = require('../services/proxy-manager');
```

3b. Extend `GET /config` (replace the handler body ~lines 37-48) to add the proxy fields:

```js
router.get('/config', (req, res) => {
  res.json({
    success: true,
    data: {
      upload: {
        maxFileSize: config.deployment.maxFileSize,
        maxFiles: config.deployment.maxFiles
      },
      appPublicUrlTemplate: config.deployment.appPublicUrlTemplate || null,
      proxyEnabled: !!config.deployment.proxyEnabled,
      proxyBaseDomain: config.deployment.proxyBaseDomain || null
    }
  });
});
```

3c. Add the two default routes immediately AFTER the `PUT /apps/:id/env` block (i.e., just before `// Get the current session user (protected)`):

```js
// Set this app as the root-domain default (reverse proxy). Single-default:
// clears any other app's flag first, then regenerates the edge config.
router.put('/apps/:id/default', async (req, res, next) => {
  try {
    await AppManager.getAppById(req.params.id); // 404 if missing
    const app = await queries.setDefaultApp(Number(req.params.id));
    try { await ProxyManager.regenerate(); } catch (e) { console.warn(`[proxy] regenerate after set-default failed: ${e.message}`); }
    res.json({ success: true, data: app });
  } catch (error) {
    if (error.message === 'App not found') {
      return res.status(404).json({ success: false, error: { message: error.message } });
    }
    next(error);
  }
});

// Clear this app's root-domain default, then regenerate.
router.delete('/apps/:id/default', async (req, res, next) => {
  try {
    await AppManager.getAppById(req.params.id);
    await queries.updateApp({ id: Number(req.params.id), is_default: 0 });
    try { await ProxyManager.regenerate(); } catch (e) { console.warn(`[proxy] regenerate after clear-default failed: ${e.message}`); }
    res.json({ success: true, data: { message: 'Default cleared' } });
  } catch (error) {
    if (error.message === 'App not found') {
      return res.status(404).json({ success: false, error: { message: error.message } });
    }
    next(error);
  }
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: all five `proxy-default-route` tests PASS; the existing `GET /api/config exposes appPublicUrlTemplate field` test still PASS (new fields are additive).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/index.js server/src/test/integration/proxy-default-route.test.js
git commit -m "$(cat <<'EOF'
feat(api): root-domain default-app endpoints + proxy fields in /api/config

PUT/DELETE /api/apps/:id/default (auth required) set/clear the single
root-domain default app and regenerate the edge proxy. GET /api/config
additionally exposes proxyEnabled + proxyBaseDomain for the UI.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Session hardening (`trust proxy`, rolling renewal, 7-day maxAge, secure cookie)

**Files:**
- Modify: `server/src/app.js:27-36`
- Test: `server/src/test/integration/session-hardening.test.js`

**Interfaces:**
- Produces: `app.set('trust proxy', 1)`; session `{ resave: true, rolling: true, maxAge: 7d, cookie.secure: SESSION_COOKIE_SECURE || (proxySslEnabled && production) }`. `SESSION_SECRET` is still required from `.env` (the existing warning stays).

- [ ] **Step 1: Write the failing test**

Create `server/src/test/integration/session-hardening.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../helpers/setup');

test('app trusts a single reverse-proxy hop', () => {
  const app = createApp();
  // trust proxy === 1 -> req.ip/protocol honor exactly one X-Forwarded-* layer
  assert.equal(app.get('trust proxy'), 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `app.get('trust proxy')` returns `false` (default), not `1`.

- [ ] **Step 3: Harden the session in `server/src/app.js`**

Replace the session block (currently lines 27-36):

```js
  const sessionSecret = config.auth.sessionSecret || crypto.randomBytes(32).toString('hex');
  if (!config.auth.sessionSecret) {
    console.warn('⚠ SESSION_SECRET not set — using a random ephemeral secret (sessions invalidate on restart). Set SESSION_SECRET in .env for stable sessions.');
  }
  // Trust exactly one reverse-proxy layer so req.ip / req.protocol reflect the
  // real client behind the edge nginx (and so X-Forwarded-Proto drives secure
  // cookies correctly).
  app.set('trust proxy', 1);
  const sessionCookieSecure = config.auth.sessionCookieSecure
    || (config.deployment.proxySslEnabled && config.server.nodeEnv === 'production');
  app.use(session({
    secret: sessionSecret,
    resave: true,             // rolling renewal requires resave
    saveUninitialized: false,
    rolling: true,            // refresh the cookie on every response -> active sessions stay alive
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: sessionCookieSecure,
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    }
  }));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: the `app trusts a single reverse-proxy hop` test PASS; all others green.

- [ ] **Step 5: Commit**

```bash
git add server/src/app.js server/src/test/integration/session-hardening.test.js
git commit -m "$(cat <<'EOF'
fix(auth): harden admin session (rolling renewal, 7d, trust proxy, secure cookie)

Sets trust proxy=1, switches to rolling 7-day sessions so active use no longer
expires at the old hard 8h cap, and makes the cookie Secure under HTTPS reverse
proxy (overridable via SESSION_COOKIE_SECURE). Fixes the 'keeps getting logged
out' symptom alongside a stable SESSION_SECRET in .env.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Frontend — root-domain default-app toggle

**Files:**
- Modify: `client/src/api/apps.js` (append two exports)
- Modify: `client/src/components/AppRow.jsx:1-11, 88-145`
- Modify: `client/src/pages/Dashboard.jsx:8, 74-82, 149-159`
- Modify: `client/src/i18n/locales/en.json` (`appCard`) and `client/src/i18n/locales/zh.json` (`appCard`)
- Test: manual — `cd client && npm run lint && npm run build`

**Interfaces:**
- Consumes: `GET /api/config` → `proxyEnabled`/`proxyBaseDomain` (already flowed via `AppConfigContext`); app row now carries `is_default`.
- Produces: a `Switch` on each running app row (only when proxy enabled) that sets/clears the root-domain default.

- [ ] **Step 1: Add the two API functions in `client/src/api/apps.js`**

Append before `export default api`:

```js
/**
 * Set this app as the root-domain default (reverse proxy).
 */
export const setAppDefault = async (id) => {
  const response = await api.put(`/apps/${id}/default`)
  return response.data.data
}

/**
 * Clear this app's root-domain default.
 */
export const clearAppDefault = async (id) => {
  const response = await api.delete(`/apps/${id}/default`)
  return response.data.data
}
```

- [ ] **Step 2: Add the handler in `client/src/pages/Dashboard.jsx`**

2a. Update the import (line 8) to include the two new functions:

```js
import { getAllApps, deleteApp, startApp, stopApp, restoreApp, setAppDefault, clearAppDefault } from '../api/apps'
```

2b. Add a handler after `handleDelete` (after line 82):

```js
  const handleToggleDefault = async (app, next) => {
    try {
      if (next) await setAppDefault(app.id)
      else await clearAppDefault(app.id)
      await loadApps(true)
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('messages.operationFailed'))
      await loadApps(true) // re-sync in case the Switch optimism was wrong
    }
  }
```

2c. Pass the handler to `AppRow` (add the prop inside the `<AppRow ... />` JSX, alongside the others):

```jsx
              onToggleDefault={handleToggleDefault}
```

- [ ] **Step 3: Render the Switch in `client/src/components/AppRow.jsx`**

3a. Update imports (line 3) to include `Switch`:

```js
import { Modal, Spin, Popconfirm, message, Switch } from 'antd'
```

3b. Update the component signature (line 11) to accept the new prop:

```js
function AppRow({ app, index, onStart, onStop, onDelete, onToggleDefault, startingId }) {
```

3c. Inside the `<div className="acts">…</div>` block, add the Switch right before the delete `Popconfirm` (i.e., after the `env` button block and before `<Popconfirm`):

```jsx
          {appConfig?.proxyEnabled && isRunning && app.port && (
            <span className="default-toggle">
              <Switch
                size="small"
                checked={!!app.is_default}
                onChange={(checked) => onToggleDefault(app, checked)}
              />
              <span className="default-toggle__label">{t('appCard.rootDefault')}</span>
            </span>
          )}
```

- [ ] **Step 4: Add i18n labels**

4a. In `client/src/i18n/locales/en.json`, inside the `"appCard"` object (e.g., after `"backup": "Backup"`):

```json
    "rootDefault": "Root domain"
```

4b. In `client/src/i18n/locales/zh.json`, inside the `"appCard"` object (after `"backup": "备份"`):

```json
    "rootDefault": "根域名"
```

(Mind the comma: `"backup": "Backup",` in en / `"backup": "备份",` in zh before adding the new key, since the new key is no longer last only if you keep backup last — place `rootDefault` last and ensure `backup` gets a trailing comma.)

- [ ] **Step 5: Lint + build**

Run: `cd client && npm run lint && npm run build`
Expected: lint clean, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add client/src/api/apps.js client/src/components/AppRow.jsx client/src/pages/Dashboard.jsx client/src/i18n/locales/en.json client/src/i18n/locales/zh.json
git commit -m "$(cat <<'EOF'
feat(ui): root-domain default-app toggle on running app rows

Adds a Switch (visible only when the reverse proxy is enabled and the app is
running) that sets/clears the root-domain default app via the new endpoints.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Login page — kill the password-field double underline

**Files:**
- Modify: `client/src/styles/index.css:59`

**Interfaces:** none (pure CSS).

- [ ] **Step 1: Add the CSS override**

In `client/src/styles/index.css`, immediately after the `.ant-input:focus, …` block (i.e., right after line 59), insert:

```css
/* Input.Password renders an inner .ant-input inside .ant-input-affix-wrapper.
   Both match the underline rule above, so the password field shows two lines.
   Strip the border from the wrapped inner input only — a plain <Input> has no
   affix-wrapper and keeps its single underline. */
.ant-input-affix-wrapper > .ant-input,
.ant-input-affix-wrapper input.ant-input {
  border: none !important;
  border-bottom: none !important;
  box-shadow: none !important;
}
```

- [ ] **Step 2: Build to confirm no syntax errors**

Run: `cd client && npm run build`
Expected: build succeeds.

- [ ] **Step 3: Manual visual check**

Open the login page (`npm run dev`, go to `/login`): the password field now shows exactly one underline, matching the username field.

- [ ] **Step 4: Commit**

```bash
git add client/src/styles/index.css
git commit -m "$(cat <<'EOF'
fix(ui): remove double underline under login password field

Input.Password's inner .ant-input inherits the global underline while its
affix-wrapper already draws one, doubling it. Suppress the inner input's
border only; plain Input is unaffected.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Docs, `.env.example`, changelog, prior-spec note

**Files:**
- Modify: `.env.example`
- Modify: `README.md`, `README.zh-CN.md`
- Modify: `PROGRESS.md`
- Modify: `docs/superpowers/specs/2026-07-18-domain-deploy-hardening-design.md`

**Interfaces:** none.

- [ ] **Step 1: Document the new env knobs in `.env.example`**

Append (with the existing comment style) near the `APP_PUBLIC_URL_TEMPLATE` block:

```bash
# Platform-managed nginx reverse proxy (opt-in). When PROXY_ENABLED=true, the
# platform writes per-app server blocks to PROXY_CONF_FILE (subdomain -> app
# port) and reloads nginx. Requires system nginx installed and write access to
# PROXY_CONF_FILE (its dir must be included by your nginx.conf — Debian/Ubuntu
# include /etc/nginx/conf.d/*.conf by default).
# PROXY_ENABLED=false
# PROXY_CONF_FILE=/etc/nginx/conf.d/microverse_apps.conf
# PROXY_BASE_DOMAIN=              # empty -> derived from APP_PUBLIC_URL_TEMPLATE
# SSL is reserved (structure only; v1 does NOT issue certs):
# PROXY_SSL_ENABLED=false
# PROXY_SSL_CERT=/etc/letsencrypt/live/<domain>/fullchain.pem
# PROXY_SSL_CERT_KEY=/etc/letsencrypt/live/<domain>/privkey.pem

# Force the session cookie Secure flag (default: follows PROXY_SSL_ENABLED in
# production). Set to false to log in over plain HTTP while testing.
# SESSION_COOKIE_SECURE=false
```

- [ ] **Step 2: Add a "Reverse proxy" subsection to both READMEs**

In `README.md` (and the matching place in `README.zh-CN.md`, translated), add a short subsection under the production/deployment area:

```markdown
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
```

- [ ] **Step 3: Add a changelog entry to `PROGRESS.md`**

Under the `[Unreleased]` heading (top of the changelog), add an entry summarizing: platform-managed nginx reverse proxy (subdomain routing + root-domain default app, opt-in, SSL reserved), session hardening, login double-underline fix. Reference the design doc.

- [ ] **Step 4: Note the superseded scope decision in the prior design doc**

In `docs/superpowers/specs/2026-07-18-domain-deploy-hardening-design.md`, at the top under the status line, add:

```markdown
> **Update 2026-07-18:** The "不做 nginx 反代/SSL/域名绑定（用户基建）" scope
> decision (lines 6, 215) is **superseded** by
> `docs/superpowers/specs/2026-07-18-nginx-reverse-proxy-design.md`, which adds
> a platform-managed nginx reverse proxy (subdomain routing + root-domain
> default app). SSL cert issuance remains out of scope; only the config
> structure is reserved.
```

- [ ] **Step 5: Commit**

```bash
git add .env.example README.md README.zh-CN.md PROGRESS.md docs/superpowers/specs/2026-07-18-domain-deploy-hardening-design.md
git commit -m "$(cat <<'EOF'
docs: reverse-proxy config + setup guide, changelog, supersede prior scope

Documents PROXY_* / SESSION_COOKIE_SECURE env knobs, the nginx include +
privilege setup, subdomain + root-domain-default usage, and the reserved (not
issued) SSL story. Notes that the new reverse-proxy spec supersedes the prior
'no reverse proxy' scope decision.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] **Backend tests:** `npm test` from repo root — all green (new: default-app, proxy-config, proxy-regenerate, proxy-default-route, session-hardening).
- [ ] **Frontend:** `cd client && npm run lint && npm run build` — clean.
- [ ] **Manual smoke (test server):** with `PROXY_ENABLED=true` + template set + nginx include in place — start an app → its subdomain proxies through; mark default → root domain proxies; stop → subdomain drops; `nginx -t` failure → no reload + warn + app still fine. Login session survives a server restart (with a stable `SESSION_SECRET`) and a >8h span; login page password field shows one underline.
