# Tech Debt Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve four remaining tech-debt items — app-name input validation, TOCTOU port-allocation race, nginx access/error logs wired into LogManager, and a top-level + per-page React ErrorBoundary.

**Architecture:** All four are small, independent changes. Backend items follow the existing `utils/` pure-function + service/route pattern with `node:test` TDD; the ErrorBoundary is a React class component (no frontend test framework — manually verified, matching project convention). No new runtime dependencies.

**Tech Stack:** Node.js + Express + sqlite3; node:test + supertest; React 18 + Ant Design 5 + react-i18next.

**Spec:** [docs/superpowers/specs/2026-07-18-tech-debt-cleanup-design.md](../specs/2026-07-18-tech-debt-cleanup-design.md)

## Global Constraints

- Tests require Node ≥ 22 (glob runner `node --test src/test/`); server runtime supports Node ≥ 18.
- Use the `sqlite3` package only (never `better-sqlite3`).
- All filesystem paths via Node `path` module; cross-platform.
- No new runtime dependencies — TOCTOU serialization is a local `utils/` helper; nginx-log branching uses the existing `fs` module.
- Backend tests run via `npm test` (root) → `npm test --workspace=server`.
- Frontend has no component-test framework; verify the ErrorBoundary manually (project convention).
- Commits on `main`; conventional commit messages, end with `Co-Authored-By: Claude <noreply@anthropic.com>`.

---

## File Structure

**Backend — new utils:**
- `server/src/utils/validate-app-name.js` — canonical app-name regex + `isValidAppName(name)` (single source of truth for create + restore).
- `server/src/utils/serialize.js` — `createExclusive()` factory returning a promise-chained `exclusive(task)` serializer (testable in isolation).

**Backend — modified:**
- `server/src/services/app-manager.js` — `createApp` calls `isValidAppName` (covers POST /apps AND restore, since restore calls `createApp`).
- `server/src/utils/validate-manifest.js` — delegates name check to `isValidAppName` (preserves existing message string so restore's 400 mapping is unchanged).
- `server/src/services/deploy-manager.js` — module-level `exclusive = createExclusive()`; wraps the port-allocation critical section only.
- `server/src/services/log-manager.js` — `getLogPaths(app)` (was `getLogPaths(appName)`); branches on `deploy_type === 'nginx'`.
- `server/src/routes/index.js` — logs/stream route passes `app` object instead of `app.name`.

**Backend — tests:**
- `server/src/test/unit/app-name-validation.test.js` (new) — `isValidAppName` cases.
- `server/src/test/unit/serialize.test.js` (new) — `createExclusive` mutual-exclusion + post-error liveness.
- `server/src/test/unit/nginx-log-paths.test.js` (new) — nginx branch of `getLogPaths` (temp dir, no PM2).
- `server/src/test/integration/apps-crud.test.js` (modified) — invalid + over-long name → 400.
- `server/src/test/integration/backup-restore.test.js` (modified) — invalid manifest name → 400.

**Frontend — new:**
- `client/src/components/ErrorBoundary.jsx` — class boundary with `compact` prop; editorial full + compact fallbacks.

**Frontend — modified:**
- `client/src/App.jsx` — top-level boundary wrapping `<Routes>`; per-page `compact` boundaries.
- `client/src/pages/CreateApp.jsx` — add `{ max: 64 }` rule.
- `client/src/i18n/locales/{zh,en}.json` — `errorBoundary.*` keys + `createApp.appNameTooLong`.
- `client/src/styles/editorial.css` — `.ed-error-*` fallback styles.

**Docs:**
- `PROGRESS.md` — tick the 4 tech-debt items; add `[Unreleased] — 2026-07-18` changelog entry.

---

## Task 1: App-name validation (backend + frontend)

**Files:**
- Create: `server/src/utils/validate-app-name.js`
- Create: `server/src/test/unit/app-name-validation.test.js`
- Modify: `server/src/services/app-manager.js` (createApp, ~L17–47)
- Modify: `server/src/utils/validate-manifest.js` (whole file)
- Modify: `server/src/test/integration/apps-crud.test.js` (append tests)
- Modify: `server/src/test/integration/backup-restore.test.js` (append test)
- Modify: `client/src/pages/CreateApp.jsx` (Form.Item rules, ~L48–51)
- Modify: `client/src/i18n/locales/zh.json`, `client/src/i18n/locales/en.json`

**Interfaces:**
- Produces: `isValidAppName(name) -> boolean` (from `utils/validate-app-name`); regex `^[A-Za-z0-9_-]{1,64}$`.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing unit test**

Create `server/src/test/unit/app-name-validation.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isValidAppName } = require('../../utils/validate-app-name');

test('accepts valid names', () => {
  assert.equal(isValidAppName('my-app'), true);
  assert.equal(isValidAppName('app_1'), true);
  assert.equal(isValidAppName('A'), true);
  assert.equal(isValidAppName('a'.repeat(64)), true); // boundary: exactly 64
});

test('rejects empty / non-string', () => {
  assert.equal(isValidAppName(''), false);
  assert.equal(isValidAppName(null), false);
  assert.equal(isValidAppName(undefined), false);
  assert.equal(isValidAppName(42), false);
});

test('rejects path-traversal / injection / disallowed chars', () => {
  assert.equal(isValidAppName('../pwn'), false);
  assert.equal(isValidAppName('a b'), false);
  assert.equal(isValidAppName('a;b'), false);
  assert.equal(isValidAppName('a.b'), false);
  assert.equal(isValidAppName('a/b'), false);
});

test('rejects over-long names', () => {
  assert.equal(isValidAppName('a'.repeat(65)), false); // boundary: 65
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=server`
Expected: FAIL — `Cannot find module '../../utils/validate-app-name'`.

- [ ] **Step 3: Write the util**

Create `server/src/utils/validate-app-name.js`:
```js
// Canonical app-name format. Used by AppManager.createApp (covers POST /apps
// and restore, which calls createApp) and by validateManifest. Kept in one
// place so the create path and the restore path can't drift.
// name flows into a filesystem path (apps/<name>), an nginx config filename
// (nginx.<name>.conf) and a PM2 process name — so the charset is tight and
// length-capped.
const APP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * @param {string} name
 * @returns {boolean}
 */
function isValidAppName(name) {
  return typeof name === 'string' && APP_NAME_RE.test(name);
}

module.exports = { isValidAppName, APP_NAME_RE };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace=server`
Expected: PASS — all `app-name-validation` cases green.

- [ ] **Step 5: Wire into AppManager.createApp**

In `server/src/services/app-manager.js`, add the require near the top (after the existing requires):
```js
const { isValidAppName } = require('../utils/validate-app-name');
```
In `createApp(name, deployType)`, insert the format check right after the `if (!name || !deployType)` block and before the deploy_type enum check:
```js
    if (!isValidAppName(name)) {
      throw new Error('Invalid app name: use only letters, numbers, dashes, and underscores (max 64)');
    }
```
(The message contains "Invalid" so the POST /apps route maps it to 400, and "Invalid app name" so the restore route's client-error matcher also maps it to 400.)

- [ ] **Step 6: Refactor validateManifest to share the rule**

Replace the entire contents of `server/src/utils/validate-manifest.js`:
```js
const { isValidAppName } = require('./validate-app-name');
const VALID_DEPLOY_TYPES = ['npm', 'http-server', 'nginx'];

/**
 * Validate a backup manifest object (name + deploy_type).
 * @returns {string|null} error message, or null when valid.
 */
function validateManifest(manifest) {
  // Message kept identical to before so the restore route's 400 matcher
  // (which looks for 'Invalid app name') still fires.
  if (!isValidAppName(manifest && manifest.name)) {
    return 'Invalid app name in backup';
  }
  if (!VALID_DEPLOY_TYPES.includes(manifest.deploy_type)) {
    return 'Invalid deploy_type in backup';
  }
  return null;
}

module.exports = { validateManifest, VALID_DEPLOY_TYPES };
```

- [ ] **Step 7: Add integration tests for invalid create**

In `server/src/test/integration/apps-crud.test.js`, append after the "rejects duplicate name" test:
```js
test('POST /api/apps rejects an invalid name', async () => {
  const res = await agent.post('/api/apps').send({ name: '../pwn', deploy_type: 'http-server' });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /Invalid app name/);
});

test('POST /api/apps rejects an over-long name', async () => {
  const res = await agent.post('/api/apps').send({ name: 'a'.repeat(65), deploy_type: 'http-server' });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /Invalid app name/);
});
```

- [ ] **Step 8: Add integration test for invalid manifest name on restore**

In `server/src/test/integration/backup-restore.test.js`, append at the end of the file:
```js
test('restore a backup with an invalid manifest name -> 400', async () => {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile(
    'microverse-manifest.json',
    JSON.stringify({ name: '../bad', deploy_type: 'http-server', env: [] })
  );
  const restore = await agent.post('/api/apps/restore')
    .attach('file', zip.toBuffer(), 'bad.zip');
  assert.equal(restore.status, 400);
  assert.match(restore.body.error.message, /Invalid app name/);
});
```

- [ ] **Step 9: Run the full backend suite**

Run: `npm test --workspace=server`
Expected: PASS — all existing tests plus the four new ones.

- [ ] **Step 10: Frontend — add length cap + i18n string**

In `client/src/pages/CreateApp.jsx`, change the `name` Form.Item `rules` array to add a max rule:
```jsx
          rules={[
            { required: true, message: t('createApp.appNameRequired') },
            { pattern: /^[a-zA-Z0-9-_]+$/, message: t('createApp.appNamePattern') },
            { max: 64, message: t('createApp.appNameTooLong') },
          ]}
```
In `client/src/i18n/locales/zh.json`, inside the `createApp` object add (after `appNamePattern`):
```json
    "appNameTooLong": "应用名称不能超过 64 个字符",
```
In `client/src/i18n/locales/en.json`, inside the `createApp` object add (after `appNamePattern`):
```json
    "appNameTooLong": "App name must be 64 characters or fewer",
```

- [ ] **Step 11: Lint the client**

Run: `cd client && npm run lint`
Expected: PASS (0 warnings).

- [ ] **Step 12: Commit**

```bash
git add server/src/utils/validate-app-name.js \
        server/src/test/unit/app-name-validation.test.js \
        server/src/services/app-manager.js \
        server/src/utils/validate-manifest.js \
        server/src/test/integration/apps-crud.test.js \
        server/src/test/integration/backup-restore.test.js \
        client/src/pages/CreateApp.jsx \
        client/src/i18n/locales/zh.json \
        client/src/i18n/locales/en.json
git commit -m "$(cat <<'EOF'
feat: validate app name format on create + restore

Add a shared isValidAppName util (^[A-Za-z0-9_-]{1,64}$) and enforce it in
AppManager.createApp (covers POST /apps and restore, which calls createApp)
and in validateManifest. Frontend CreateApp adds a 64-char max rule. Closes
the path-traversal / config-injection surface since name flows into the
apps dir, the nginx config filename, and the PM2 process name.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: TOCTOU port-allocation serialization

**Files:**
- Create: `server/src/utils/serialize.js`
- Create: `server/src/test/unit/serialize.test.js`
- Modify: `server/src/services/deploy-manager.js` (require + module-level `exclusive`; port block ~L31–43)

**Interfaces:**
- Produces: `createExclusive() -> (task: () => Promise<T>) => Promise<T>`; tasks run strictly one at a time, chain survives a throwing task.
- Consumes: nothing.

- [ ] **Step 1: Write the failing unit test**

Create `server/src/test/unit/serialize.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createExclusive } = require('../../utils/serialize');

test('runs overlapping tasks strictly one at a time', async () => {
  const exclusive = createExclusive();
  let active = 0;
  let maxActive = 0;
  const task = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active -= 1;
  };
  await Promise.all(Array.from({ length: 6 }, () => exclusive(task)));
  assert.equal(maxActive, 1);
});

test('preserves order (FIFO)', async () => {
  const exclusive = createExclusive();
  const order = [];
  await Promise.all([
    exclusive(async () => { order.push('a'); }),
    exclusive(async () => { order.push('b'); }),
    exclusive(async () => { order.push('c'); }),
  ]);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('propagates errors AND keeps the chain alive for the next task', async () => {
  const exclusive = createExclusive();
  await assert.rejects(() => exclusive(async () => { throw new Error('boom'); }), /boom/);
  const result = await exclusive(async () => 42); // chain not poisoned
  assert.equal(result, 42);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=server`
Expected: FAIL — `Cannot find module '../../utils/serialize'`.

- [ ] **Step 3: Write the util**

Create `server/src/utils/serialize.js`:
```js
/**
 * Returns an `exclusive(task)` function that runs each task strictly after the
 * previous one settles (success or failure). Used to serialize a critical
 * section (e.g. port allocation) without a dependency.
 *
 * - `chain.then(task, task)` passes the same fn as both onFulfilled and
 *   onRejected, so the next task always runs once after the previous settles.
 * - The trailing `.then(()=>{}, ()=>{})` swallows errors so a failed task can
 *   never break the chain for subsequent callers.
 *
 * Each call to createExclusive() has independent chain state, so tests are
 * isolated from each other and from DeployManager's instance.
 * @returns {(task: () => Promise<any>) => Promise<any>}
 */
function createExclusive() {
  let chain = Promise.resolve();
  return function exclusive(task) {
    const run = chain.then(task, task);
    chain = run.then(() => {}, () => {});
    return run;
  };
}

module.exports = { createExclusive };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace=server`
Expected: PASS — all three `serialize` cases green.

- [ ] **Step 5: Wire into DeployManager**

In `server/src/services/deploy-manager.js`, add the require + module-level serializer near the top (after the existing requires, before the class):
```js
const { createExclusive } = require('../utils/serialize');

// Serializes the port-allocation critical section across concurrent deployApp
// calls so two never read the same "claimed" set and pick the same port.
// Process-local: sufficient for the single-instance, single-admin deployment.
const exclusive = createExclusive();
```
Replace the port-allocation block (currently):
```js
    if (!app.port) {
      const claimed = (await queries.getAllClaimedPorts()).map(r => r.port);
      const port = await ProcessManager.findAvailablePort(
        config.deployment.portRangeMin,
        config.deployment.portRangeMax,
        { exclude: claimed }
      );
      await AppManager.updateApp(appId, { port });
      app.port = port;
    }
```
with:
```js
    if (!app.port) {
      // Serialize the read-claimed -> pick -> write critical section. Two
      // concurrent starts can no longer pick the same free port. npm
      // install / build / startProcess stay outside the lock — they don't
      // contend on port selection and can be slow.
      app.port = await exclusive(async () => {
        const claimed = (await queries.getAllClaimedPorts()).map(r => r.port);
        const port = await ProcessManager.findAvailablePort(
          config.deployment.portRangeMin,
          config.deployment.portRangeMax,
          { exclude: claimed }
        );
        await AppManager.updateApp(appId, { port });
        return port;
      });
    }
```

- [ ] **Step 6: Run the full backend suite**

Run: `npm test --workspace=server`
Expected: PASS — no regressions; serialize tests green.

- [ ] **Step 7: Commit**

```bash
git add server/src/utils/serialize.js \
        server/src/test/unit/serialize.test.js \
        server/src/services/deploy-manager.js
git commit -m "$(cat <<'EOF'
fix: serialize port allocation to close TOCTOU race

Concurrent deployApp calls could read the same claimed-port set and both
pick the same free port. Add a dependency-free createExclusive() serializer
and wrap only the read-claimed -> findAvailablePort -> updateApp critical
section (npm install/build/start stay unlocked). Process-local, which is
sufficient for single-instance single-admin.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: nginx logs via LogManager

**Files:**
- Modify: `server/src/services/log-manager.js` (`getLogPaths`, ~L22–44)
- Modify: `server/src/routes/index.js` (logs/stream, ~L431)
- Create: `server/src/test/unit/nginx-log-paths.test.js`

**Interfaces:**
- Changes: `LogManager.getLogPaths(appName)` → `LogManager.getLogPaths(app)` where `app = { name, deploy_type, path }`. Non-nginx behavior unchanged (uses `app.name`); nginx returns `{outPath, errPath}` pointing at `<app.path>/nginx-{access,error}.log`.

- [ ] **Step 1: Write the failing unit test (nginx branch, no PM2)**

Create `server/src/test/unit/nginx-log-paths.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const LogManager = require('../../services/log-manager');

test('getLogPaths: nginx app returns app-dir nginx logs when present', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nginx-logs-'));
  fs.writeFileSync(path.join(dir, 'nginx-access.log'), 'GET / 200\n');
  fs.writeFileSync(path.join(dir, 'nginx-error.log'), 'warn line\n');
  try {
    const paths = await LogManager.getLogPaths({ name: 'x', deploy_type: 'nginx', path: dir });
    assert.equal(paths.outPath, path.join(dir, 'nginx-access.log'));
    assert.equal(paths.errPath, path.join(dir, 'nginx-error.log'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getLogPaths: nginx app with no log files returns nulls', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nginx-logs-'));
  try {
    const paths = await LogManager.getLogPaths({ name: 'x', deploy_type: 'nginx', path: dir });
    assert.equal(paths.outPath, null);
    assert.equal(paths.errPath, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=server`
Expected: FAIL — `getLogPaths` currently expects a string `appName`, so passing an object makes `proc.name === appName` always false and it falls through to the `~/.pm2/logs` path; the asserts on `nginx-access.log` paths fail.

- [ ] **Step 3: Change getLogPaths signature + add nginx branch**

In `server/src/services/log-manager.js`, replace `getLogPaths(appName)` (the whole method, L22–44) with:
```js
  /**
   * Resolve log file paths for an app.
   *  - nginx apps: the per-app nginx-access.log / nginx-error.log in the app
   *    dir (nginx writes there because its install prefix isn't writable).
   *  - other apps: PM2's out/err paths via `pm2 jlist`, falling back to
   *    ~/.pm2/logs/<name>-{out,error}.log when the file exists there.
   * Returns { outPath, errPath } where either may be null (no file yet).
   * Never throws for "no logs".
   *
   * @param {{name:string, deploy_type:string, path:string}} app
   */
  static async getLogPaths(app) {
    if (app.deploy_type === 'nginx') {
      const access = path.join(app.path, 'nginx-access.log');
      const error = path.join(app.path, 'nginx-error.log');
      return {
        outPath: fs.existsSync(access) ? access : null,
        errPath: fs.existsSync(error) ? error : null,
      };
    }

    const appName = app.name;
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
```

- [ ] **Step 4: Update the route to pass the app object**

In `server/src/routes/index.js`, in the logs/stream handler (~L431), change:
```js
    const paths = await LogManager.getLogPaths(app.name);
```
to:
```js
    const paths = await LogManager.getLogPaths(app);
```

- [ ] **Step 5: Run the full backend suite**

Run: `npm test --workspace=server`
Expected: PASS — nginx-log-paths tests green; no regressions (non-nginx path unchanged in behavior).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/log-manager.js \
        server/src/routes/index.js \
        server/src/test/unit/nginx-log-paths.test.js
git commit -m "$(cat <<'EOF'
feat: surface nginx access/error logs in the logs page

LogManager.getLogPaths now takes the app object and branches on deploy_type:
nginx apps get their per-app nginx-access.log (out level) and nginx-error.log
(err level) instead of the empty PM2 stdout/stderr. The logs/stream route
passes the already-fetched app. Non-nginx apps behave exactly as before.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Frontend ErrorBoundary (top-level + per-page)

> **Note:** The project has no frontend component-test framework (by convention, the client is manually verified). This task has no automated test — verification is the manual step below.

**Files:**
- Create: `client/src/components/ErrorBoundary.jsx`
- Modify: `client/src/App.jsx`
- Modify: `client/src/i18n/locales/zh.json`, `client/src/i18n/locales/en.json`
- Modify: `client/src/styles/editorial.css`

**Interfaces:**
- Produces: `<ErrorBoundary compact?>` — wraps children; on a render error in its subtree, shows an editorial fallback (full page by default, compact inline card with `compact`).

- [ ] **Step 1: Add i18n keys**

In `client/src/i18n/locales/zh.json`, add a new top-level section (e.g. after the `common` block):
```json
  "errorBoundary": {
    "title": "出错了",
    "description": "页面渲染时发生错误，请尝试刷新。",
    "reload": "刷新",
    "back": "返回仪表板"
  },
```
In `client/src/i18n/locales/en.json`, add the matching section:
```json
  "errorBoundary": {
    "title": "Something went wrong",
    "description": "This page hit an error while rendering. Try reloading.",
    "reload": "Reload",
    "back": "Back to dashboard"
  },
```
(Place each block as a sibling of `common`/`auth`/… — keep the JSON valid, trailing-comma-free.)

- [ ] **Step 2: Add fallback CSS**

Append to `client/src/styles/editorial.css`:
```css
/* ErrorBoundary fallbacks */
.ed-error-fallback { text-align: left; }
.ed-error-fallback.compact { padding: 24px 0; }
.ed-error-actions { display: flex; align-items: center; gap: 18px; }
.ed-error-stack {
  margin-top: 18px;
  padding: 12px 14px;
  background: #F2EDE2;
  border: 1px solid #D8CFBF;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow: auto;
}
```

- [ ] **Step 3: Create the ErrorBoundary component**

Create `client/src/components/ErrorBoundary.jsx`:
```jsx
import { Component } from 'react'
import { Button } from 'antd'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import EditorialShell from './EditorialShell'

// Compact fallback: inline card for a single crashed page (nav stays alive).
function CompactFallback({ error, reload }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <div className="ed-error-fallback compact">
      <div className="page-title">{t('errorBoundary.title')}</div>
      <div className="lead" style={{ marginTop: 8 }}>{t('errorBoundary.description')}</div>
      <div className="ed-error-actions" style={{ marginTop: 20 }}>
        <Button className="btn-ink" onClick={reload}>{t('errorBoundary.reload')}</Button>
        <button className="text-link" onClick={() => navigate('/')}>{t('errorBoundary.back')}</button>
      </div>
      {import.meta.env.DEV && error?.stack && (
        <pre className="ed-error-stack">{error.stack}</pre>
      )}
    </div>
  )
}

// Full fallback: whole-page editorial shell when the top-level tree crashes.
function FullFallback({ error, reload }) {
  const { t } = useTranslation()
  return (
    <EditorialShell>
      <div className="ed-error-fallback">
        <h1 className="page-title">{t('errorBoundary.title')}</h1>
        <div className="lead" style={{ marginTop: 8 }}>{t('errorBoundary.description')}</div>
        <div className="ed-error-actions" style={{ marginTop: 24 }}>
          <Button className="btn-ink" onClick={reload}>{t('errorBoundary.reload')}</Button>
        </div>
        {import.meta.env.DEV && error?.stack && (
          <pre className="ed-error-stack">{error.stack}</pre>
        )}
      </div>
    </EditorialShell>
  )
}

class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    // Log only — no remote reporting (YAGNI). Info contains the component stack.
    console.error('ErrorBoundary caught:', error, info)
  }

  reload = () => {
    this.setState({ hasError: false, error: null })
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      const Fallback = this.props.compact ? CompactFallback : FullFallback
      return <Fallback error={this.state.error} reload={this.reload} />
    }
    return this.props.children
  }
}

export default ErrorBoundary
```

- [ ] **Step 4: Wire top-level + per-page boundaries in App.jsx**

In `client/src/App.jsx`, add the import with the other component imports:
```jsx
import ErrorBoundary from './components/ErrorBoundary'
```
Wrap `<Routes>` (inside `<AuthProvider>`, inside `<ConfigProvider>`) with a top-level boundary:
```jsx
      <AuthProvider>
        <ErrorBoundary>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<RequireAuth />}>
              <Route path="/" element={<ErrorBoundary compact><Dashboard /></ErrorBoundary>} />
              <Route path="/create" element={<ErrorBoundary compact><CreateApp /></ErrorBoundary>} />
              <Route path="/apps/:id/upload" element={<ErrorBoundary compact><UploadFiles /></ErrorBoundary>} />
              <Route path="/apps/:id/logs" element={<ErrorBoundary compact><AppLogs /></ErrorBoundary>} />
              <Route path="/apps/:id/metrics" element={<ErrorBoundary compact><AppMetrics /></ErrorBoundary>} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ErrorBoundary>
      </AuthProvider>
```
(The top-level `ErrorBoundary` catches anything that escapes a page; the per-page `compact` boundary downgrades a single page crash to an inline card so navigation keeps working. `Login` is intentionally unwrapped — it's tiny and outside `RequireAuth`.)

- [ ] **Step 5: Lint + build the client**

Run: `cd client && npm run lint`
Expected: PASS (0 warnings).
Run: `cd client && npm run build`
Expected: build succeeds.

- [ ] **Step 6: Manually verify both boundaries**

Run `npm run dev`. With the client open:
- **Per-page (compact):** temporarily add `throw new Error('boom')` as the first line of, e.g., `AppMetrics.jsx`'s component body, save, and open `/apps/1/metrics`. Expected: an inline editorial error card with Reload + "Back to dashboard", top nav still works. Remove the throw afterward.
- **Top-level (full):** temporarily throw inside `App.jsx` itself (e.g. just inside the `App()` body, before the `return`). Expected: the full-page editorial fallback with Reload. Remove the throw afterward.
- Confirm the dev-stack `<pre>` shows when throwing in dev.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/ErrorBoundary.jsx \
        client/src/App.jsx \
        client/src/i18n/locales/zh.json \
        client/src/i18n/locales/en.json \
        client/src/styles/editorial.css
git commit -m "$(cat <<'EOF'
feat(client): top-level + per-page ErrorBoundary

Add an editorial ErrorBoundary (class component) with a compact inline
variant. Wrap Routes once at the top level and wrap each authenticated
page in the compact variant, so a single page's render error degrades to
an inline card instead of white-screening the app. Dev builds show the
stack; production shows Reload / Back-to-dashboard.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Docs + final verification

**Files:**
- Modify: `PROGRESS.md`

- [ ] **Step 1: Update PROGRESS.md tech-debt section**

In `PROGRESS.md`, in the "### ⚠️ 技术债" list:
- Change `- [ ] 前端缺少错误边界 (Error Boundary)` to `- [x] 前端错误边界 (Error Boundary)（顶层 + 每页）`.
- Change the TOCTOU item `- [ ] 并发 deployApp 的 TOCTOU…` to start with `- [x]` and append `（已修复：deploy-manager 端口分配临界区进程内串行化）`.
- Change the nginx-logs item `- [ ] nginx app 的 SSE 日志页…` to `- [x]` and append `（已修复：LogManager 按 deploy_type 分流，nginx 返回 nginx-*.log）`.
- For the input-validation item `- [ ] 输入验证、SQL 注入防护等安全性增强`, change to `- [x] 应用名格式校验（防路径穿越/配置注入）；SQL 注入为伪命题（查询全参数化）`.

- [ ] **Step 2: Add a changelog entry**

In `PROGRESS.md`, at the top of the "## 变更日志" section, add a new block (above the existing `### [Unreleased] — 2026-07-17`):
```markdown
### [Unreleased] — 2026-07-18
#### 技术债清扫
- 应用名校验：新增 `utils/validate-app-name.js`（`^[A-Za-z0-9_-]{1,64}$`），在 `AppManager.createApp`（覆盖 POST /apps 与 restore）+ `validateManifest` 强制；前端 CreateApp 加 64 字符上限。堵路径穿越/配置注入面（SQL 注入为伪命题——查询全参数化）。
- TOCTOU 端口竞态：`deploy-manager` 用依赖无关的 `utils/serialize.js#createExclusive` 串行化"读 claimed → 选端口 → 写库"临界区；install/build/start 仍在锁外。
- nginx 日志接入：`LogManager.getLogPaths(app)` 按 `deploy_type` 分流，nginx app 的日志页现在显示 `nginx-access.log`（普通）/`nginx-error.log`（红色）；非 nginx 行为不变。
- 前端 ErrorBoundary：class 组件 + `compact` 变体，顶层包 Routes、每页各包一层；单页 render 报错降级为页内卡片而非白屏。
```

- [ ] **Step 3: Run the whole backend suite + client lint/build**

Run: `npm test`
Expected: PASS — all unit + integration tests green.
Run: `cd client && npm run lint && npm run build`
Expected: lint 0 warnings, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add PROGRESS.md
git commit -m "$(cat <<'EOF'
docs: record tech-debt cleanup (app name, TOCTOU, nginx logs, error boundary)

Tick the four resolved tech-debt items in PROGRESS.md and add a changelog
entry for the 2026-07-18 sweep.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Verification Summary (end of plan)

After all tasks:
- `npm test` → all backend unit + integration tests pass.
- `cd client && npm run lint && npm run build` → clean.
- Manual smoke (`npm run dev`):
  - `curl -X POST /api/apps -d '{"name":"../pwn","deploy_type":"http-server"}'` (authed) → 400.
  - Per-page ErrorBoundary card visible when a page throws; full-page fallback when App throws.
  - (PM2) Two portless apps started concurrently → distinct ports; an nginx app's logs page shows access/error lines.
