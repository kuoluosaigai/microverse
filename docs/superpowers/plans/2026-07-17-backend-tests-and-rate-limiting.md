# 后端自动化测试 + 请求限流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a backend test safety net (`node:test` unit + `supertest` integration for non-PM2 endpoints) and request rate limiting (`express-rate-limit` login + API) to the Microverse server.

**Architecture:** Two test layers — pure-logic unit tests for helpers, and API integration tests via `supertest` against `createApp()` with a per-process temp SQLite + temp apps dir. Three minimal seams enable testing: split `app.js` into `createApp()` + `server.js`, an `APPS_DIR` env override, and extraction of three inline validators (`isSafeEntry`, `validateEnvEntries`, `validateManifest`) into `utils/`. Rate limiting adds a `loginLimiter` (5/15min) on `/auth/login` and an `apiLimiter` (100/min, SSE-exempt) after `requireAuth`.

**Tech Stack:** Node.js >=18 built-in `node:test` + `node:assert/strict`; `supertest` (devDep); `express-rate-limit` (dep). CommonJS. Workspace `server/`.

**Spec:** `docs/superpowers/specs/2026-07-17-backend-tests-and-rate-limiting-design.md`

## Global Constraints

- Node `>=18.0.0` (engines floor already set). Use built-in `node:test` — do NOT add Jest/vitest/mocha.
- All paths via `path` module; CommonJS (`require`/`module.exports`); no `"type":"module"`.
- DB is `sqlite3` (never `better-sqlite3`); all queries `await`ed.
- Error responses keep shape `{ success:false, error:{ message } }`.
- Tests run per-file in separate processes (`node --test` default) → file-level isolation. Set `process.env.DB_PATH`/`APPS_DIR`/`ADMIN_PASSWORD` before any `require` that transitively loads `server/src/db`.
- Never test PM2 endpoints (`start`/`stop`/`restart`/`sync`/`metrics`/`logs/stream` handler behavior) — they need the PM2 daemon and are out of scope.
- Commits on `main`; commit messages English, end with `Co-Authored-By: Claude <noreply@anthropic.com>`.

---

## File Structure

**Created:**
- `server/src/server.js` — process entry: `createApp()` + listen + bootstrap (metricsSampler, ensureAdmin, nginx probe, signals).
- `server/src/middleware/rate-limit.js` — `loginLimiter`, `apiLimiter`.
- `server/src/utils/validate-zip.js` — `isSafeEntry(root, entryName)`.
- `server/src/utils/validate-env.js` — `validateEnvEntries(env)`.
- `server/src/utils/validate-manifest.js` — `validateManifest(manifest)`.
- `server/src/test/helpers/setup.js` — env isolation + test helpers.
- `server/src/test/unit/{port-allocation,zip-slip,env-validation,backup-manifest}.test.js`
- `server/src/test/integration/{health-config,apps-crud,env,auth,backup-restore,rate-limit-login,rate-limit-api,rate-limit-sse}.test.js`

**Modified:**
- `server/src/app.js` — export `createApp()` (drop listen/bootstrap).
- `server/src/utils/path-helper.js` — `getAppsDir()` reads `APPS_DIR` env.
- `server/src/services/backup-manager.js` — use `validateManifest`.
- `server/src/routes/index.js` — use `isSafeEntry` + `validateEnvEntries`; mount limiters.
- `server/package.json` — dev/start → `src/server.js`; +`test` script; +`supertest` devDep; +`express-rate-limit` dep.
- `package.json` (root) — +`test` script.
- `.env.example` — +`APPS_DIR` comment.
- `PROGRESS.md`, `README.md`.

---

## Task 1: Walking skeleton — test harness + `createApp`/`server` split + `APPS_DIR`

**Files:**
- Modify: `server/src/app.js`, `server/src/utils/path-helper.js`, `server/package.json`, `package.json`, `.env.example`
- Create: `server/src/server.js`, `server/src/test/helpers/setup.js`, `server/src/test/integration/health-config.test.js`

**Interfaces:**
- Produces: `app.js` exports `{ createApp }`; `path-helper.getAppsDir()` honors `process.env.APPS_DIR`; `test/helpers/setup.js` exports `{ request, init, adminAgent, createApp, queries, dbReady }`; npm scripts `test` (root + server).

- [ ] **Step 1: Install deps**

Run:
```bash
npm install express-rate-limit --workspace=server --save
npm install supertest --workspace=server --save-dev
```
Expected: both added to `server/package.json` (`express-rate-limit` under `dependencies`, `supertest` under a new `devDependencies`).

- [ ] **Step 2: Add npm scripts**

Edit `server/package.json` `scripts` — change `dev`/`start` to `src/server.js` and add `test`:
```json
"dev": "cross-env NODE_ENV=development node src/server.js",
"start": "cross-env NODE_ENV=production node src/server.js",
"test": "node --test src/test/",
```
Edit root `package.json` `scripts` — add:
```json
"test": "npm test --workspace=server"
```

- [ ] **Step 3: Rewrite `server/src/app.js` to export `createApp()`**

Replace the entire file content with:
```js
const express = require('express');
const cors = require('cors');
const config = require('./config');
const { errorHandler, notFoundHandler } = require('./middleware/error-handler');
const routes = require('./routes');
const swaggerUi = require('swagger-ui-express');
const openApiSpec = require('./docs');
const session = require('express-session');
const crypto = require('crypto');

// Ensure the DB initializes + schema runs (idempotent CREATE TABLE IF NOT EXISTS).
require('./db');

/**
 * Build the Express app WITHOUT listening or bootstrapping background work.
 * server.js composes createApp() + listen + bootstrap; tests import createApp().
 */
function createApp() {
  const app = express();

  app.use(cors(config.cors));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const sessionSecret = config.auth.sessionSecret || crypto.randomBytes(32).toString('hex');
  if (!config.auth.sessionSecret) {
    console.warn('⚠ SESSION_SECRET not set — using a random ephemeral secret (sessions invalidate on restart). Set SESSION_SECRET in .env for stable sessions.');
  }
  app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 }
  }));

  if (config.server.nodeEnv === 'development') {
    app.use((req, res, next) => {
      console.log(`${req.method} ${req.path}`);
      next();
    });
  }

  app.use('/api', routes);

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
  app.get('/openapi.json', (req, res) => res.json(openApiSpec));

  app.get('/', (req, res) => {
    res.json({ name: 'Microverse Server', version: '1.0.0', status: 'running' });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
```

- [ ] **Step 4: Create `server/src/server.js` (entry + bootstrap)**

Create the file:
```js
const config = require('./config');
const { createApp } = require('./app');
const { dbReady } = require('./db');
const NginxLifecycle = require('./services/nginx-lifecycle');
const metricsSampler = require('./services/metrics-sampler');
const AuthManager = require('./services/auth-manager');

const app = createApp();

const server = app.listen(config.server.port, config.server.host, () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║   Microverse Server                    ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');
  console.log(`✓ Server running on http://${config.server.host}:${config.server.port}`);
  console.log(`✓ Environment: ${config.server.nodeEnv}`);
  console.log(`✓ API available at http://${config.server.host}:${config.server.port}/api`);
  console.log(`✓ API docs (Swagger UI): http://${config.server.host}:${config.server.port}/api-docs`);
  console.log('');
  console.log('Press Ctrl+C to stop');
  console.log('');

  NginxLifecycle.probe().then(({ ok, message }) => {
    if (!ok) console.warn('⚠ ' + message);
  });

  metricsSampler.start();

  dbReady.then(() => AuthManager.ensureAdmin()).catch(err => console.warn(`ensureAdmin failed: ${err.message}`));
});

function shutdown() {
  metricsSampler.stop();
  console.log('\nShutdown signal received: closing HTTP server');
  server.close(() => { console.log('HTTP server closed'); process.exit(0); });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

- [ ] **Step 5: Make `getAppsDir()` honor `APPS_DIR`**

In `server/src/utils/path-helper.js`, change `getAppsDir` to:
```js
getAppsDir() {
  return process.env.APPS_DIR || path.join(getProjectRoot(), 'apps');
}
```
(Leave `getProjectRoot`, `getAppDir`, `ensureDir` unchanged.)

- [ ] **Step 6: Document `APPS_DIR` in `.env.example`**

Append (commented) near the other deployment vars:
```
# Apps storage directory (default: <projectRoot>/apps). Tests override this.
# APPS_DIR=
```

- [ ] **Step 7: Create `server/src/test/helpers/setup.js`**

```js
const path = require('path');
const fs = require('fs');
const os = require('os');
const supertest = require('supertest');

// 1. Set env BEFORE any require that transitively loads server/src/db.
const tmpRoot = path.join(os.tmpdir(), `microverse-test-${process.pid}`);
fs.mkdirSync(path.join(tmpRoot, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmpRoot, 'apps'), { recursive: true });
process.env.DB_PATH = process.env.DB_PATH || path.join(tmpRoot, 'db', 'test.sqlite');
process.env.APPS_DIR = process.env.APPS_DIR || path.join(tmpRoot, 'apps');
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-pass';
process.env.NODE_ENV = 'test';

// 2. NOW require app/db (they read the env above).
const { createApp } = require('../../app');
const { dbReady, queries } = require('../../db');
const AuthManager = require('../../services/auth-manager');

let _app = null;
function app() {
  if (!_app) _app = createApp();
  return _app;
}
function request() { return supertest(app()); }

// Seed the admin user (createApp does NOT call ensureAdmin). Call once per file.
async function init() {
  await dbReady;
  await AuthManager.ensureAdmin();
  return app();
}

// A supertest agent that is already logged in as the seeded admin.
async function adminAgent() {
  await init();
  const agent = supertest.agent(app());
  await agent.post('/api/auth/login')
    .send({ username: 'admin', password: 'test-pass' })
    .expect(200);
  return agent;
}

module.exports = { createApp, request, init, adminAgent, queries, dbReady };
```

- [ ] **Step 8: Write the health/config integration test**

Create `server/src/test/integration/health-config.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request } = require('../helpers/setup');

test('GET /api/health returns ok', async () => {
  const res = await request().get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.status, 'ok');
});

test('GET /api/config exposes upload limits', async () => {
  const res = await request().get('/api/config');
  assert.equal(res.status, 200);
  assert.ok(res.body.data.upload.maxFileSize > 0);
  assert.ok(res.body.data.upload.maxFiles > 0);
});
```

- [ ] **Step 9: Run the test — verify pass**

Run: `npm test`
Expected: 2 tests pass (health, config). No PM2 daemon activity (these are public routes).

- [ ] **Step 10: Smoke-test the server split**

Run: `npm run dev:server` (background or separate terminal), wait ~2s, then `curl -s http://localhost:5000/api/health`.
Expected: `{"success":true,"data":{"status":"ok",...}}`. Stop the server (`taskkill` the PID on Windows per known port-5000 issue).
This confirms `server.js` boots identically to the old `app.js`.

- [ ] **Step 11: Commit**

```bash
git add server/src/app.js server/src/server.js server/src/utils/path-helper.js \
        server/src/test/helpers/setup.js server/src/test/integration/health-config.test.js \
        server/package.json package.json .env.example package-lock.json
git commit -m "$(cat <<'EOF'
test: establish node:test harness, split createApp/server, add APPS_DIR

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Port-allocation unit tests

**Files:**
- Create: `server/src/test/unit/port-allocation.test.js`

**Interfaces:**
- Consumes: `ProcessManager.isPortAvailable(port)` (static, async→bool), `ProcessManager.findAvailablePort(minPort, maxPort, { exclude })` (static, async→number, throws `/No available ports/`). Both already exist and are PM2-free.

- [ ] **Step 1: Write the tests**

Create `server/src/test/unit/port-allocation.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const ProcessManager = require('../../services/process-manager');

test('isPortAvailable: free port -> true', async () => {
  const srv = net.createServer();
  const port = await new Promise((resolve) => {
    srv.listen(0, '0.0.0.0', () => resolve(srv.address().port));
  });
  await new Promise((r) => srv.close(r));
  assert.equal(await ProcessManager.isPortAvailable(port), true);
});

test('isPortAvailable: occupied port -> false', async () => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '0.0.0.0', r));
  const port = srv.address().port;
  try {
    assert.equal(await ProcessManager.isPortAvailable(port), false);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('findAvailablePort returns a free port within range', async () => {
  const port = await ProcessManager.findAvailablePort(40000, 40100);
  assert.ok(port >= 40000 && port <= 40100);
  assert.equal(await ProcessManager.isPortAvailable(port), true);
});

test('findAvailablePort: fully-excluded range -> throws', async () => {
  const all = new Set();
  for (let p = 40000; p <= 40005; p++) all.add(p);
  await assert.rejects(
    () => ProcessManager.findAvailablePort(40000, 40005, { exclude: all }),
    /No available ports/
  );
});
```

- [ ] **Step 2: Run and verify pass**

Run: `npm test`
Expected: port-allocation tests pass (4). Full suite still green.

- [ ] **Step 3: Commit**

```bash
git add server/src/test/unit/port-allocation.test.js
git commit -m "test: port allocation helpers (isPortAvailable, findAvailablePort)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Extract `isSafeEntry` + zip-slip unit test + wire upload route

**Files:**
- Create: `server/src/utils/validate-zip.js`, `server/src/test/unit/zip-slip.test.js`
- Modify: `server/src/routes/index.js` (the upload zip-slip block ~L513-520)

**Interfaces:**
- Produces: `isSafeEntry(root, entryName)` → `boolean` (true iff `path.resolve(root, entryName)` equals or is inside `path.resolve(root)`).

- [ ] **Step 1: Write the failing unit test**

Create `server/src/test/unit/zip-slip.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { isSafeEntry } = require('../../utils/validate-zip');

const root = path.resolve(__dirname, 'sample-app');

test('entry inside root is safe', () => {
  assert.equal(isSafeEntry(root, 'index.html'), true);
  assert.equal(isSafeEntry(root, 'sub/dir/a.js'), true);
});

test('entry resolving exactly to root is safe', () => {
  assert.equal(isSafeEntry(root, '.'), true);
});

test('zip-slip traversal is unsafe', () => {
  assert.equal(isSafeEntry(root, '../secret'), false);
  assert.equal(isSafeEntry(root, '../../etc/passwd'), false);
  assert.equal(isSafeEntry(root, 'sub/../../../etc/passwd'), false);
});

test('sibling with shared prefix is unsafe', () => {
  assert.equal(isSafeEntry(root, '../sample-app-evil/x'), false);
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `npm test --workspace=server -- src/test/unit/zip-slip.test.js` (or `cd server && node --test src/test/unit/zip-slip.test.js`)
Expected: FAIL — `Cannot find module '../../utils/validate-zip'`.

- [ ] **Step 3: Implement `isSafeEntry`**

Create `server/src/utils/validate-zip.js`:
```js
const path = require('path');

/**
 * True iff entryName resolves strictly inside root (no zip-slip traversal).
 * Guards against sibling directories sharing a prefix (root + path.sep).
 */
function isSafeEntry(root, entryName) {
  const safeRoot = path.resolve(root);
  const target = path.resolve(root, entryName);
  return target === safeRoot || target.startsWith(safeRoot + path.sep);
}

module.exports = { isSafeEntry };
```

- [ ] **Step 4: Run — verify pass**

Run: `cd server && node --test src/test/unit/zip-slip.test.js`
Expected: 4 tests pass.

- [ ] **Step 5: Wire the upload route to use `isSafeEntry`**

In `server/src/routes/index.js`:
- Add to the requires at top: `const { isSafeEntry } = require('../utils/validate-zip');`
- Replace this inline block inside the upload zip handler:
```js
            const safeRoot = path.resolve(app.path);
            const entries = zip.getEntries();
            for (const entry of entries) {
              const entryTarget = path.resolve(app.path, entry.entryName);
              if (entryTarget !== safeRoot && !entryTarget.startsWith(safeRoot + path.sep)) {
                throw new Error(`Unsafe zip entry path: ${entry.entryName}`);
              }
            }
```
with:
```js
            const entries = zip.getEntries();
            for (const entry of entries) {
              if (!isSafeEntry(app.path, entry.entryName)) {
                throw new Error(`Unsafe zip entry path: ${entry.entryName}`);
              }
            }
```

- [ ] **Step 6: Run full suite — verify still green**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/utils/validate-zip.js server/src/test/unit/zip-slip.test.js server/src/routes/index.js
git commit -m "refactor: extract isSafeEntry zip-slip guard + unit test

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Extract `validateEnvEntries` + env-validation unit test + wire PUT env route

**Files:**
- Create: `server/src/utils/validate-env.js`, `server/src/test/unit/env-validation.test.js`
- Modify: `server/src/routes/index.js` (PUT `/apps/:id/env` validation block ~L584-608)

**Interfaces:**
- Produces: `validateEnvEntries(env)` → `string|null` (error message, or null when valid). Rules: must be array; each `entry.key` matches `/^[A-Za-z_][A-Za-z0-9_]*$/`; no duplicate keys.

- [ ] **Step 1: Write the failing unit test**

Create `server/src/test/unit/env-validation.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateEnvEntries } = require('../../utils/validate-env');

test('valid entries return null', () => {
  assert.equal(validateEnvEntries([{ key: 'A' }, { key: 'B_CD', value: '1' }]), null);
  assert.equal(validateEnvEntries([]), null);
});

test('non-array is rejected', () => {
  assert.match(validateEnvEntries('x'), /array/);
  assert.match(validateEnvEntries(undefined), /array/);
});

test('invalid key format is rejected', () => {
  assert.match(validateEnvEntries([{ key: '1bad' }]), /Invalid env key/);
  assert.match(validateEnvEntries([{ key: 'a-b' }]), /Invalid env key/);
  assert.match(validateEnvEntries([{ key: '' }]), /Invalid env key/);
});

test('duplicate key is rejected', () => {
  assert.match(validateEnvEntries([{ key: 'A' }, { key: 'A' }]), /Duplicate env key/);
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd server && node --test src/test/unit/env-validation.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `validateEnvEntries`**

Create `server/src/utils/validate-env.js`:
```js
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate an env-var payload for PUT /apps/:id/env.
 * @returns {string|null} error message, or null when valid.
 */
function validateEnvEntries(env) {
  if (!Array.isArray(env)) return 'env must be an array of { key, value }';
  const seen = new Set();
  for (const entry of env) {
    if (!entry || typeof entry.key !== 'string' || !KEY_RE.test(entry.key)) {
      return `Invalid env key: ${entry && entry.key}`;
    }
    if (seen.has(entry.key)) return `Duplicate env key: ${entry.key}`;
    seen.add(entry.key);
  }
  return null;
}

module.exports = { validateEnvEntries };
```

- [ ] **Step 4: Run — verify pass**

Run: `cd server && node --test src/test/unit/env-validation.test.js`
Expected: 4 tests pass.

- [ ] **Step 5: Wire the PUT env route**

In `server/src/routes/index.js`:
- Add to requires: `const { validateEnvEntries } = require('../utils/validate-env');`
- In `PUT /apps/:id/env`, replace this block:
```js
    const { env } = req.body;
    if (!Array.isArray(env)) {
      return res.status(400).json({
        success: false,
        error: { message: 'env must be an array of { key, value }' }
      });
    }

    const keyRe = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const seen = new Set();
    for (const entry of env) {
      if (!entry || typeof entry.key !== 'string' || !keyRe.test(entry.key)) {
        return res.status(400).json({
          success: false,
          error: { message: `Invalid env key: ${entry && entry.key}` }
        });
      }
      if (seen.has(entry.key)) {
        return res.status(400).json({
          success: false,
          error: { message: `Duplicate env key: ${entry.key}` }
        });
      }
      seen.add(entry.key);
    }
```
with:
```js
    const { env } = req.body;
    const envError = validateEnvEntries(env);
    if (envError) {
      return res.status(400).json({ success: false, error: { message: envError } });
    }
```

- [ ] **Step 6: Run full suite — verify green**

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/utils/validate-env.js server/src/test/unit/env-validation.test.js server/src/routes/index.js
git commit -m "refactor: extract validateEnvEntries + unit test

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Extract `validateManifest` + backup-manifest unit test + wire BackupManager

**Files:**
- Create: `server/src/utils/validate-manifest.js`, `server/src/test/unit/backup-manifest.test.js`
- Modify: `server/src/services/backup-manager.js` (manifest validation ~L64-69)

**Interfaces:**
- Produces: `validateManifest(manifest)` → `string|null`. Rules: `manifest.name` is a string matching `/^[a-zA-Z0-9-_]+$/`; `manifest.deploy_type` ∈ `['npm','http-server','nginx']`.

- [ ] **Step 1: Write the failing unit test**

Create `server/src/test/unit/backup-manifest.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateManifest } = require('../../utils/validate-manifest');

test('valid manifest returns null', () => {
  assert.equal(validateManifest({ name: 'my-app', deploy_type: 'http-server' }), null);
  assert.equal(validateManifest({ name: 'a_b-1', deploy_type: 'npm' }), null);
});

test('missing/invalid name is rejected', () => {
  assert.match(validateManifest({ deploy_type: 'npm' }), /Invalid app name/);
  assert.match(validateManifest({ name: 'bad name!', deploy_type: 'npm' }), /Invalid app name/);
  assert.match(validateManifest({ name: 'a/b', deploy_type: 'npm' }), /Invalid app name/);
});

test('invalid deploy_type is rejected', () => {
  assert.match(validateManifest({ name: 'ok', deploy_type: 'docker' }), /Invalid deploy_type/);
  assert.match(validateManifest({ name: 'ok' }), /Invalid deploy_type/);
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd server && node --test src/test/unit/backup-manifest.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `validateManifest`**

Create `server/src/utils/validate-manifest.js`:
```js
const NAME_RE = /^[a-zA-Z0-9-_]+$/;
const VALID_DEPLOY_TYPES = ['npm', 'http-server', 'nginx'];

/**
 * Validate a backup manifest object (name + deploy_type).
 * @returns {string|null} error message, or null when valid.
 */
function validateManifest(manifest) {
  if (!manifest || typeof manifest.name !== 'string' || !NAME_RE.test(manifest.name)) {
    return 'Invalid app name in backup';
  }
  if (!VALID_DEPLOY_TYPES.includes(manifest.deploy_type)) {
    return 'Invalid deploy_type in backup';
  }
  return null;
}

module.exports = { validateManifest, VALID_DEPLOY_TYPES };
```

- [ ] **Step 4: Run — verify pass**

Run: `cd server && node --test src/test/unit/backup-manifest.test.js`
Expected: 3 tests pass.

- [ ] **Step 5: Wire BackupManager**

In `server/src/services/backup-manager.js`:
- Add to requires: `const { validateManifest } = require('../utils/validate-manifest');`
- Replace this block:
```js
    if (!manifest || typeof manifest.name !== 'string' || !NAME_RE.test(manifest.name)) {
      throw new Error('Invalid app name in backup');
    }
    if (!VALID_DEPLOY_TYPES.includes(manifest.deploy_type)) {
      throw new Error('Invalid deploy_type in backup');
    }
```
with:
```js
    const manifestError = validateManifest(manifest);
    if (manifestError) throw new Error(manifestError);
```
- Remove the now-unused `VALID_DEPLOY_TYPES` (L9) and `NAME_RE` (L10) constants — they were referenced only by the extracted block. (`MANIFEST_NAME` L8 and `ENV_KEY_RE` L11 stay; the latter is used at L104.)

- [ ] **Step 6: Run full suite — verify green**

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/utils/validate-manifest.js server/src/test/unit/backup-manifest.test.js server/src/services/backup-manager.js
git commit -m "refactor: extract validateManifest + unit test

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Integration tests — apps CRUD + env

**Files:**
- Create: `server/src/test/integration/apps-crud.test.js`, `server/src/test/integration/env.test.js`

**Interfaces:**
- Consumes: `setup.adminAgent()` (logged-in supertest agent), `setup.queries` (to flip `status` for the running-app delete case without PM2).

- [ ] **Step 1: Write `apps-crud.test.js`**

Create `server/src/test/integration/apps-crud.test.js`:
```js
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { adminAgent, queries, dbReady } = require('../helpers/setup');

let agent;
before(async () => { await dbReady; agent = await adminAgent(); });

test('POST /api/apps creates an app', async () => {
  const res = await agent.post('/api/apps').send({ name: 'crud-app', deploy_type: 'http-server' });
  assert.equal(res.status, 201);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.name, 'crud-app');
  assert.equal(res.body.data.status, 'stopped');
});

test('POST /api/apps rejects missing fields', async () => {
  const res = await agent.post('/api/apps').send({ name: 'no-type' });
  assert.equal(res.status, 400);
});

test('POST /api/apps rejects duplicate name', async () => {
  await agent.post('/api/apps').send({ name: 'dup-app', deploy_type: 'http-server' });
  const res = await agent.post('/api/apps').send({ name: 'dup-app', deploy_type: 'http-server' });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /already exists/);
});

test('GET /api/apps lists apps', async () => {
  const res = await agent.get('/api/apps');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data));
  assert.ok(res.body.data.some(a => a.name === 'crud-app'));
});

test('GET /api/apps/:id 404 for missing', async () => {
  const res = await agent.get('/api/apps/999999');
  assert.equal(res.status, 404);
});

test('DELETE /api/apps/:id 404 for missing', async () => {
  const res = await agent.delete('/api/apps/999999');
  assert.equal(res.status, 404);
});

test('DELETE /api/apps/:id rejects a running app (no PM2 needed)', async () => {
  const created = await agent.post('/api/apps').send({ name: 'running-app', deploy_type: 'http-server' });
  await queries.updateAppStatus(created.body.data.id, 'running');
  const res = await agent.delete(`/api/apps/${created.body.data.id}`);
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /Cannot delete running app/);
  // cleanup
  await queries.updateAppStatus(created.body.data.id, 'stopped');
  await agent.delete(`/api/apps/${created.body.data.id}`).expect(200);
});
```

- [ ] **Step 2: Write `env.test.js`**

Create `server/src/test/integration/env.test.js`:
```js
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { adminAgent, dbReady } = require('../helpers/setup');

let agent, appId;
before(async () => {
  await dbReady;
  agent = await adminAgent();
  const res = await agent.post('/api/apps').send({ name: 'env-app', deploy_type: 'npm' });
  appId = res.body.data.id;
});

test('PUT then GET env round-trips', async () => {
  const put = await agent.put(`/api/apps/${appId}/env`).send({
    env: [{ key: 'API_KEY', value: 'sekret' }, { key: 'PORT_OFFSET', value: '1' }]
  });
  assert.equal(put.status, 200);
  const get = await agent.get(`/api/apps/${appId}/env`);
  assert.equal(get.status, 200);
  const keys = get.body.data.map(e => e.key).sort();
  assert.deepEqual(keys, ['API_KEY', 'PORT_OFFSET']);
});

test('PUT env rejects invalid key', async () => {
  const res = await agent.put(`/api/apps/${appId}/env`).send({ env: [{ key: '1bad' }] });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /Invalid env key/);
});

test('PUT env rejects duplicate key', async () => {
  const res = await agent.put(`/api/apps/${appId}/env`).send({
    env: [{ key: 'DUP' }, { key: 'DUP' }]
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /Duplicate env key/);
});

test('GET env 404 for missing app', async () => {
  const res = await agent.get('/api/apps/999999/env');
  assert.equal(res.status, 404);
});
```

- [ ] **Step 3: Run — verify pass**

Run: `npm test`
Expected: apps-crud (7) + env (4) pass; whole suite green. (Each file is its own process, so app-name collisions across files don't occur.)

- [ ] **Step 4: Commit**

```bash
git add server/src/test/integration/apps-crud.test.js server/src/test/integration/env.test.js
git commit -m "test: integration tests for apps CRUD and env endpoints

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: Integration tests — auth (login / me / logout)

**Files:**
- Create: `server/src/test/integration/auth.test.js`

**Interfaces:**
- Consumes: `setup.request()` (unauthenticated), `setup.adminAgent()` (authenticated), `setup.init()`.

- [ ] **Step 1: Write `auth.test.js`**

Create `server/src/test/integration/auth.test.js`:
```js
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { request, init, adminAgent } = require('../helpers/setup');

before(async () => { await init(); });

test('GET /api/apps without session -> 401', async () => {
  const res = await request().get('/api/apps');
  assert.equal(res.status, 401);
});

test('POST /api/auth/login missing fields -> 400', async () => {
  const res = await request().post('/api/auth/login').send({ username: 'admin' });
  assert.equal(res.status, 400);
});

test('POST /api/auth/login wrong password -> 401', async () => {
  const res = await request().post('/api/auth/login').send({ username: 'admin', password: 'nope' });
  assert.equal(res.status, 401);
  assert.equal(res.body.success, false);
});

test('login -> me -> logout flow', async () => {
  const agent = await adminAgent();
  const me = await agent.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.data.user.username, 'admin');

  const out = await agent.post('/api/auth/logout');
  assert.equal(out.status, 200);

  const meAfter = await agent.get('/api/auth/me');
  assert.equal(meAfter.status, 401);
});
```
> This file makes 3 login attempts total — under the login limit introduced in Task 9. It runs in its own process.

- [ ] **Step 2: Run — verify pass**

Run: `npm test`
Expected: auth tests pass; suite green. (≤3 login attempts here, under the login limit introduced in Task 9.)

- [ ] **Step 3: Commit**

```bash
git add server/src/test/integration/auth.test.js
git commit -m "test: integration tests for auth login/me/logout

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: Integration tests — backup / restore roundtrip

**Files:**
- Create: `server/src/test/integration/backup-restore.test.js`

**Interfaces:**
- Consumes: `setup.adminAgent()`. Uses `GET /api/apps/:id/backup` (zip body) and `POST /api/apps/restore` (multipart field `file`).

- [ ] **Step 1: Write `backup-restore.test.js`**

Create `server/src/test/integration/backup-restore.test.js`:
```js
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { adminAgent, dbReady } = require('../helpers/setup');

let agent;
before(async () => { await dbReady; agent = await adminAgent(); });

test('backup -> delete -> restore roundtrip', async () => {
  const created = await agent.post('/api/apps').send({ name: 'bk-app', deploy_type: 'http-server' });
  const id = created.body.data.id;

  const bk = await agent.get(`/api/apps/${id}/backup`);
  assert.equal(bk.status, 200);
  assert.equal(bk.headers['content-type'], 'application/zip');
  const zipBuffer = bk.body;

  await agent.delete(`/api/apps/${id}`).expect(200);

  const restore = await agent.post('/api/apps/restore')
    .attach('file', zipBuffer, 'bk-app-backup.zip');
  assert.equal(restore.status, 201);
  assert.equal(restore.body.data.name, 'bk-app');
  assert.equal(restore.body.data.deploy_type, 'http-server');

  await agent.delete(`/api/apps/${restore.body.data.id}`).expect(200);
});

test('restore a name that already exists -> 400', async () => {
  const created = await agent.post('/api/apps').send({ name: 'bk-conflict', deploy_type: 'http-server' });
  const bk = await agent.get(`/api/apps/${created.body.data.id}/backup`).expect(200);
  const restore = await agent.post('/api/apps/restore')
    .attach('file', bk.body, 'bk-conflict-backup.zip');
  assert.equal(restore.status, 400);
  assert.match(restore.body.error.message, /already exists/);
  await agent.delete(`/api/apps/${created.body.data.id}`).expect(200);
});

test('restore non-zip -> 400', async () => {
  const restore = await agent.post('/api/apps/restore')
    .attach('file', Buffer.from('not a zip'), 'x.zip');
  assert.equal(restore.status, 400);
});
```

> Note: supertest reads binary bodies into a Buffer at `res.body` when not JSON. If `res.body` comes back as a string in your supertest version, use `bk.buffer` instead.

- [ ] **Step 2: Run — verify pass**

Run: `npm test`
Expected: backup-restore tests pass; suite green.

- [ ] **Step 3: Commit**

```bash
git add server/src/test/integration/backup-restore.test.js
git commit -m "test: integration tests for backup/restore roundtrip

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: Rate limiting — middleware + wiring + integration test

**Files:**
- Create: `server/src/middleware/rate-limit.js`, `server/src/test/integration/rate-limit-login.test.js`, `server/src/test/integration/rate-limit-api.test.js`, `server/src/test/integration/rate-limit-sse.test.js`
- Modify: `server/src/routes/index.js` (mount `loginLimiter` on `/auth/login`; mount `apiLimiter` after `requireAuth`)

**Interfaces:**
- Produces: `middleware/rate-limit.js` exports `{ loginLimiter, apiLimiter }`. `loginLimiter`: 5 req / 15min / IP. `apiLimiter`: 100 req / min / IP, `skip` for `req.path.endsWith('/logs/stream')`. Both emit `{ success:false, error:{ message } }` on 429.

- [ ] **Step 1: Create the middleware**

Create `server/src/middleware/rate-limit.js`:
```js
const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { message: 'Too many login attempts, try again later' } }
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.endsWith('/logs/stream'),
  message: { success: false, error: { message: 'Too many requests, slow down' } }
});

module.exports = { loginLimiter, apiLimiter };
```

- [ ] **Step 2: Wire the limiters into routes**

In `server/src/routes/index.js`:
- Add to requires: `const { loginLimiter, apiLimiter } = require('../middleware/rate-limit');`
- Change the login route registration from:
```js
router.post('/auth/login', async (req, res, next) => {
```
to:
```js
router.post('/auth/login', loginLimiter, async (req, res, next) => {
```
- Immediately after `router.use(requireAuth);` (L76), add:
```js
// Generic per-IP ceiling on authenticated API traffic (SSE exempt via skip).
router.use(apiLimiter);
```

- [ ] **Step 3: Write the rate-limit integration tests (3 files, one process each)**

The limiter is a module singleton, so its in-memory store is shared across all tests in a process. To stop one scenario's exhaustion from poisoning another's login, each scenario lives in its own file — `node --test` runs each file in a separate process, giving each a fresh store.

Create `server/src/test/integration/rate-limit-login.test.js`:
```js
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { createApp, init } = require('../helpers/setup');

before(async () => { await init(); });

test('login limiter: 6th attempt within window -> 429', async () => {
  const agent = supertest.agent(createApp());
  for (let i = 0; i < 5; i++) {
    await agent.post('/api/auth/login')
      .send({ username: 'admin', password: 'test-pass' })
      .expect(200);
  }
  const blocked = await agent.post('/api/auth/login')
    .send({ username: 'admin', password: 'test-pass' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.success, false);
});
```

Create `server/src/test/integration/rate-limit-api.test.js`:
```js
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { createApp, init } = require('../helpers/setup');

before(async () => { await init(); });

test('api limiter: 101st request within window -> 429', async () => {
  const agent = supertest.agent(createApp());
  await agent.post('/api/auth/login')
    .send({ username: 'admin', password: 'test-pass' })
    .expect(200);
  for (let i = 0; i < 100; i++) {
    await agent.get('/api/apps').expect(200);
  }
  const blocked = await agent.get('/api/apps');
  assert.equal(blocked.status, 429);
});
```

Create `server/src/test/integration/rate-limit-sse.test.js`:
```js
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { createApp, init } = require('../helpers/setup');

before(async () => { await init(); });

test('api limiter exempts SSE (skip) — reaches handler (404), not 429', async () => {
  const agent = supertest.agent(createApp());
  await agent.post('/api/auth/login')
    .send({ username: 'admin', password: 'test-pass' })
    .expect(200);
  // Exhaust the API limiter (a normal route would now 429).
  for (let i = 0; i < 101; i++) {
    await agent.get('/api/apps');
  }
  // /logs/stream is skipped by apiLimiter → passes to the handler → 404 on a missing app.
  const streamRes = await agent.get('/api/apps/999999/logs/stream');
  assert.equal(streamRes.status, 404);
});
```

- [ ] **Step 4: Run — verify pass**

Run: `npm test`
Expected: rate-limit tests pass (login 429, api 429, SSE 404-not-429). Other integration files still green (each fires well under 100 API reqs / under 5 logins, and runs in its own process).

- [ ] **Step 5: Commit**

```bash
git add server/src/middleware/rate-limit.js server/src/routes/index.js \
        server/src/test/integration/rate-limit-login.test.js \
        server/src/test/integration/rate-limit-api.test.js \
        server/src/test/integration/rate-limit-sse.test.js
git commit -m "feat: request rate limiting (login 5/15m, api 100/m, SSE exempt)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: Docs — PROGRESS.md + README.md

**Files:**
- Modify: `PROGRESS.md`, `README.md`

- [ ] **Step 1: Update `PROGRESS.md`**

- In **Phase 15** list, add a checked item: `- [x] 请求限流（login 5/15min + API 100/min，SSE 豁免）`.
- In **技术债**, change `- [ ] 需要添加请求限流` to `- [x] 需要添加请求限流（已实现：login + API 限流）`.
- In **技术债**, change `- [ ] 缺少单元测试 / 集成测试（目前仅手动测试）` to `- [~] 后端单元/集成测试已建立（node:test + supertest，覆盖非 PM2 端点）；PM2 端点仍手动` (partial).
- In **测试覆盖率**, change `- 自动化测试: ❌ 未实现` to `- 自动化测试: ✅ 后端（单元 + 非 PM2 端点集成）；运行: \`npm test\``.
- Add a changelog entry under a new `### [Unreleased] — 2026-07-17` section (above the existing one):
```
#### 新增
- 后端自动化测试（node:test）：纯逻辑单元测试（端口分配/zip-slip/env 校验/manifest 校验）+ supertest 集成测试（health/config/apps CRUD/auth/env/backup-restore/限流）。PM2 端点仍手动。
- 请求限流：`loginLimiter`（5/15min/IP 防爆破）+ `apiLimiter`（100/min/IP，SSE 豁免），429 沿用统一错误体。
#### 重构
- `app.js` 拆出 `createApp()` + 新 `server.js` 入口（测试可 import；启动行为不变）。
- `APPS_DIR` env（`path-helper.getAppsDir`）支持测试重定向 app 目录。
- 提取 `utils/{validate-zip,validate-env,validate-manifest}.js` 纯函数并单测。
```

- [ ] **Step 2: Update `README.md`**

Add a short "### Run tests" subsection under the existing Development/Scripts area:
```markdown
### Tests

Backend unit + integration tests (Node's built-in test runner):

```bash
npm test
```

Covers pure helpers and all non-PM2 API endpoints against an isolated temp DB. PM2-dependent endpoints (start/stop/restart/sync/metrics/logs) are still manually verified.
```

- [ ] **Step 3: Commit**

```bash
git add PROGRESS.md README.md
git commit -m "docs: record backend tests + rate limiting; add test instructions

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Verification (end-to-end)

After Task 10:
1. `npm test` from the repo root — entire suite green (unit + integration).
2. `npm run dev` — server boots from `server.js`; manually: log in, create an app, upload a file, back up + restore it.
3. Login brute-force check: hit `POST /api/auth/login` 6 times rapidly (e.g. via the browser/curl) — the 6th returns 429 with the standard error body.
4. Confirm no regression in PM2 flows by starting/stopping an http-server app manually (not covered by automated tests).

## Notes for implementers

- `node --test` runs each `*.test.js` in its own process — that is the isolation guarantee; do not add cross-file state.
- If a supertest binary body lands as a string rather than a Buffer, use `res.buffer` (supertest ≥3).
- Keep the login limit (5/15min) in mind: integration tests that log in must stay under 5 attempts per file. They do.
- The `createApp`/`server` split is behavior-preserving; `server.js` reproduces the exact bootstrap order of the old `app.js` (listen → nginx probe → metricsSampler → ensureAdmin; SIGTERM/SIGINT → stop sampler + close).
