# Domain Deploy Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five changes from real domain-deployed usage feedback — auto-flatten a zip's single top-level folder, configurable subdomain open-app links, commit production-mode static frontend serving (replacing the uncommitted openclaw patch), real `ecosystem.config.js` + rewritten Production/Updating docs, and a Chinese README.

**Architecture:** Backend changes follow the existing `utils/` + service/route pattern with `node:test` TDD; the subdomain link is a config field surfaced via `/api/config` + a small frontend context; production static serving is `NODE_ENV=production`-only in `app.js`; docs are manual. No new runtime dependencies.

**Tech Stack:** Node.js + Express + sqlite3; node:test + supertest; React 18 + Ant Design 5 + react-i18next; PM2.

**Spec:** [docs/superpowers/specs/2026-07-18-domain-deploy-hardening-design.md](../specs/2026-07-18-domain-deploy-hardening-design.md)

## Global Constraints

- Tests require Node ≥ 22 (glob runner); server runtime supports Node ≥ 18.
- `sqlite3` only (never `better-sqlite3`); all paths via Node `path` module.
- No new runtime dependencies.
- Backend tests via `npm test --workspace=server`; frontend lint `cd client && npm run lint` (--max-warnings 0), build `cd client && npm run build`.
- Frontend has no component-test framework — frontend changes are manually verified (project convention).
- The frontend context for client config is named `AppConfigContext` (NOT `ConfigContext`) to avoid clashing with antd's `ConfigProvider` already imported in `App.jsx`.
- Commits on `main`; conventional messages + `Co-Authored-By: Claude <noreply@anthropic.com>` trailer.

---

## File Structure

**Backend:**
- `server/src/utils/flatten-zip-root.js` (new) — `flattenSingleTopDir(dir)` pure helper.
- `server/src/utils/app-url.js` already exists? No — the URL builder is frontend (see below).
- `server/src/config/index.js` (mod) — add `deployment.appPublicUrlTemplate`.
- `server/src/routes/index.js` (mod) — upload route calls `flattenSingleTopDir`; `/config` adds `appPublicUrlTemplate`.
- `server/src/app.js` (mod) — production static serving + SPA fallback; `/` conditional.
- `server/ecosystem.config.js` (new) — PM2 cluster template.
- `.env.example` (mod) — `APP_PUBLIC_URL_TEMPLATE` doc.

**Frontend:**
- `client/src/context/AppConfigContext.jsx` (new) — fetches `/api/config` once.
- `client/src/utils/app-url.js` (new) — `buildAppUrl(app, template)`.
- `client/src/App.jsx` (mod) — wrap `<AppConfigProvider>`.
- `client/src/components/AppRow.jsx` (mod) — `openPort` uses `buildAppUrl`.

**Tests:**
- `server/src/test/unit/flatten-zip-root.test.js` (new).
- `server/src/test/integration/health-config.test.js` (mod) — `appPublicUrlTemplate` field + `/` JSON regression.

**Docs:**
- `README.md` (mod) — Production + Updating sections, language switcher.
- `README.zh-CN.md` (new) — Chinese translation.
- `PROGRESS.md` (mod) — changelog.

---

## Task 1: ZIP auto-flatten single top-level folder

**Files:**
- Create: `server/src/utils/flatten-zip-root.js`
- Create: `server/src/test/unit/flatten-zip-root.test.js`
- Modify: `server/src/routes/index.js` (upload route zip block ~L513–547; requires ~L16)

**Interfaces:**
- Produces: `flattenSingleTopDir(dir) -> boolean` (true if a single top-level dir was hoisted).

- [ ] **Step 1: Write the failing unit test**

Create `server/src/test/unit/flatten-zip-root.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { flattenSingleTopDir } = require('../../utils/flatten-zip-root');

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flatten-'));
}

test('flattens a single top-level directory', () => {
  const dir = makeDir();
  const wrapper = path.join(dir, 'mysite');
  fs.mkdirSync(path.join(wrapper, 'css'), { recursive: true });
  fs.writeFileSync(path.join(wrapper, 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(wrapper, 'css', 'x.css'), 'body{}');
  try {
    const flattened = flattenSingleTopDir(dir);
    assert.equal(flattened, true);
    assert.ok(fs.existsSync(path.join(dir, 'index.html')), 'index.html hoisted');
    assert.ok(fs.existsSync(path.join(dir, 'css', 'x.css')), 'nested dir hoisted');
    assert.ok(!fs.existsSync(wrapper), 'wrapper removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no-op when multiple top-level entries', () => {
  const dir = makeDir();
  fs.mkdirSync(path.join(dir, 'a'));
  fs.mkdirSync(path.join(dir, 'b'));
  try {
    assert.equal(flattenSingleTopDir(dir), false);
    assert.ok(fs.existsSync(path.join(dir, 'a')));
    assert.ok(fs.existsSync(path.join(dir, 'b')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no-op when the single entry is a file', () => {
  const dir = makeDir();
  fs.writeFileSync(path.join(dir, 'index.html'), 'x');
  try {
    assert.equal(flattenSingleTopDir(dir), false);
    assert.ok(fs.existsSync(path.join(dir, 'index.html')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no-op (false) when directory does not exist', () => {
  assert.equal(flattenSingleTopDir(path.join(os.tmpdir(), 'flatten-nonexistent-xyz')), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=server`
Expected: FAIL — `Cannot find module '../../utils/flatten-zip-root'`.

- [ ] **Step 3: Write the util**

Create `server/src/utils/flatten-zip-root.js`:
```js
const fs = require('fs');
const path = require('path');

/**
 * If `dir` contains exactly one entry and it is a directory, move that
 * directory's children up into `dir` and remove the now-empty wrapper.
 * Handles the common "zip wraps everything in a top-level folder" case
 * (GitHub/IDE-style zips). No-op otherwise (multiple top-level entries, or a
 * single file — ambiguous, leave as-is).
 *
 * Safe by construction: we only act when `dir`'s sole entry is the wrapper, so
 * there is nothing else at the top level to collide with during the hoist.
 * @param {string} dir absolute directory path
 * @returns {boolean} true if a wrapper was flattened
 */
function flattenSingleTopDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_e) {
    return false;
  }
  if (entries.length !== 1 || !entries[0].isDirectory()) return false;

  const wrapper = path.join(dir, entries[0].name);
  const children = fs.readdirSync(wrapper, { withFileTypes: true });
  for (const child of children) {
    fs.renameSync(path.join(wrapper, child.name), path.join(dir, child.name));
  }
  fs.rmdirSync(wrapper); // empty now
  return true;
}

module.exports = { flattenSingleTopDir };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace=server`
Expected: PASS — all four `flatten-zip-root` cases green.

- [ ] **Step 5: Wire into the upload route**

In `server/src/routes/index.js`, add the require near the other util requires (~L16):
```js
const { flattenSingleTopDir } = require('../utils/flatten-zip-root');
```
In the upload route's zip block, call it right after extraction. Locate this line (inside `if (path.extname(file.filename).toLowerCase() === '.zip')`):
```js
            zip.extractAllTo(app.path, true);

            // Get list of extracted files
```
Change to:
```js
            zip.extractAllTo(app.path, true);

            // If the zip wrapped everything in a single top-level folder
            // (common with GitHub/IDE zips), hoist its contents up one level
            // so index.html etc. land directly under the app directory.
            flattenSingleTopDir(app.path);

            // Get list of extracted files
```

- [ ] **Step 6: Run the full backend suite**

Run: `npm test --workspace=server`
Expected: PASS — no regressions.

- [ ] **Step 7: Commit**

```bash
git -C /d/code/microverse add server/src/utils/flatten-zip-root.js \
        server/src/test/unit/flatten-zip-root.test.js \
        server/src/routes/index.js
git -C /d/code/microverse commit -m "$(cat <<'EOF'
feat: auto-flatten a zip's single top-level folder on upload

When an uploaded zip wraps its contents in one top-level directory (common
with GitHub/IDE zips), hoist that directory's children into the app dir so
index.html lands at the top and deploy validation passes. No-op for zips
with multiple top-level entries or a single file. Backups/restores are
unaffected (their zip shape is fixed).

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Subdomain open-app links (backend + frontend)

**Files:**
- Modify: `server/src/config/index.js` (`deployment` block ~L32–55)
- Modify: `server/src/routes/index.js` (`GET /config` ~L36–46)
- Modify: `.env.example` (upload-limits area ~L22–24)
- Modify: `server/src/test/integration/health-config.test.js` (append)
- Create: `client/src/context/AppConfigContext.jsx`
- Create: `client/src/utils/app-url.js`
- Modify: `client/src/App.jsx` (wrap provider)
- Modify: `client/src/components/AppRow.jsx` (`openPort` ~L33–37)

**Interfaces:**
- Backend produces: `/api/config` now also returns `appPublicUrlTemplate: string | null`.
- Frontend produces: `useAppConfig()` → the config object (or null while loading); `buildAppUrl(app, template) -> string | null`.

- [ ] **Step 1: Add the config field**

In `server/src/config/index.js`, inside the `deployment` object (after the `nginxBin` line, before `metricsIntervalMs`), add:
```js
    // Public URL template for deployed-app "open" links, e.g.
    //   https://{name}.yourdomain.com
    // {name} is replaced with the app name. Empty -> frontend falls back to
    // http://localhost:<port> (local dev).
    appPublicUrlTemplate: process.env.APP_PUBLIC_URL_TEMPLATE || '',
```

- [ ] **Step 2: Surface it on /api/config**

In `server/src/routes/index.js`, replace the `GET /config` handler:
```js
// Public client configuration (upload limits, etc.)
router.get('/config', (req, res) => {
  res.json({
    success: true,
    data: {
      upload: {
        maxFileSize: config.deployment.maxFileSize,
        maxFiles: config.deployment.maxFiles
      },
      appPublicUrlTemplate: config.deployment.appPublicUrlTemplate || null
    }
  });
});
```

- [ ] **Step 3: Document the env var**

In `.env.example`, after the `MAX_FILES=100` line, add:
```
# Public URL template for deployed-app "open" links. {name} -> app name.
# Set when exposing apps via subdomains behind a reverse proxy, e.g.:
#   APP_PUBLIC_URL_TEMPLATE=https://{name}.yourdomain.com
# Unset -> links use http://localhost:<port> (local dev).
# APP_PUBLIC_URL_TEMPLATE=
```

- [ ] **Step 4: Add the integration assertion**

Append to `server/src/test/integration/health-config.test.js`:
```js
test('GET /api/config exposes appPublicUrlTemplate field', async () => {
  const res = await request().get('/api/config');
  assert.equal(res.status, 200);
  assert.ok('appPublicUrlTemplate' in res.body.data, 'appPublicUrlTemplate present');
  // unset in tests -> null
  assert.equal(res.body.data.appPublicUrlTemplate, null);
});
```

- [ ] **Step 5: Run backend tests**

Run: `npm test --workspace=server`
Expected: PASS — new assertion green; no regressions.

- [ ] **Step 6: Create the frontend URL builder**

Create `client/src/utils/app-url.js`:
```js
/**
 * Build the "open app" URL from the public template, or null to fall back.
 * The template (e.g. "https://{name}.yourdomain.com") has {name} replaced by
 * the app name; the result is validated with new URL() so a malformed
 * template/name never produces a broken link.
 * @param {{name:string}} app
 * @param {string} template
 * @returns {string|null}
 */
export function buildAppUrl(app, template) {
  if (!template || !template.includes('{name}')) return null
  try {
    return new URL(template.replace('{name}', app.name)).toString()
  } catch (_e) {
    return null
  }
}
```

- [ ] **Step 7: Create the client-config context**

Create `client/src/context/AppConfigContext.jsx`:
```jsx
import { createContext, useContext, useState, useEffect } from 'react'
import { getConfig } from '../api/apps'

const AppConfigContext = createContext(null)

// Fetches /api/config once on mount and exposes it. null while loading or if
// the fetch fails (consumers fall back to defaults).
export function AppConfigProvider({ children }) {
  const [config, setConfig] = useState(null)

  useEffect(() => {
    getConfig()
      .then((c) => setConfig(c))
      .catch(() => setConfig(null))
  }, [])

  return (
    <AppConfigContext.Provider value={config}>
      {children}
    </AppConfigContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAppConfig() {
  return useContext(AppConfigContext)
}
```

- [ ] **Step 8: Wrap the app with the provider**

In `client/src/App.jsx`, add the import (with the other context import):
```jsx
import { AppConfigProvider } from './context/AppConfigContext'
```
Wrap the tree so `<AppConfigProvider>` sits inside antd's `<ConfigProvider>` and outside `<AuthProvider>`:
```jsx
    <ConfigProvider locale={antdLocale} theme={theme}>
      <AppConfigProvider>
        <AuthProvider>
          <ErrorBoundary>
            <Routes>
              ...routes unchanged...
            </Routes>
          </ErrorBoundary>
        </AuthProvider>
      </AppConfigProvider>
    </ConfigProvider>
```

- [ ] **Step 9: Use the template in AppRow.openPort**

In `client/src/components/AppRow.jsx`, add the imports (with the existing imports at top):
```jsx
import { useAppConfig } from '../context/AppConfigContext'
import { buildAppUrl } from '../utils/app-url'
```
Inside the component (after `const { t } = useTranslation()`), read the template:
```jsx
  const appConfig = useAppConfig()
```
Replace the `openPort` function:
```jsx
  const openPort = () => {
    if (!app.port || !isRunning) return
    const url = buildAppUrl(app, appConfig?.appPublicUrlTemplate) || `http://localhost:${app.port}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }
```

- [ ] **Step 10: Lint + build the client**

Run: `cd /d/code/microverse/client && npm run lint`
Expected: PASS (0 warnings).
Run: `cd /d/code/microverse/client && npm run build`
Expected: build succeeds.

- [ ] **Step 11: Commit**

```bash
git -C /d/code/microverse add server/src/config/index.js \
        server/src/routes/index.js \
        .env.example \
        server/src/test/integration/health-config.test.js \
        client/src/utils/app-url.js \
        client/src/context/AppConfigContext.jsx \
        client/src/App.jsx \
        client/src/components/AppRow.jsx
git -C /d/code/microverse commit -m "$(cat <<'EOF'
feat: configurable subdomain open-app links (APP_PUBLIC_URL_TEMPLATE)

Add APP_PUBLIC_URL_TEMPLATE (e.g. https://{name}.yourdomain.com) surfaced via
/api/config; the frontend AppConfigContext fetches it and AppRow.openPort
builds the link with buildAppUrl() (new URL() validated; falls back to
http://localhost:<port> when unset or malformed). Lets a domain-deployed
instance point app links at subdomains instead of localhost.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Backend production-mode frontend serving

**Files:**
- Modify: `server/src/app.js` (requires at top; `/` route ~L48–50)
- Modify: `server/src/test/integration/health-config.test.js` (append `/` regression)

**Interfaces:**
- In `NODE_ENV=production` with `client/dist` present: the backend serves the built UI at `/` (and SPA fallback for deep links) on the same port as the API. Non-production behavior unchanged.

- [ ] **Step 1: Add requires**

In `server/src/app.js`, add at the top with the other requires (after `const crypto = require('crypto');`):
```js
const fs = require('fs');
const path = require('path');
```

- [ ] **Step 2: Replace the `/` route with the production-conditional block**

In `server/src/app.js`, locate:
```js
  app.get('/', (req, res) => {
    res.json({ name: 'Microverse Server', version: '1.0.0', status: 'running' });
  });

  app.use(notFoundHandler);
```
Replace with:
```js
  // Production: serve the built frontend (client/dist) on this same port, with
  // an SPA fallback so deep links resolve to index.html. Dev uses Vite (5173 +
  // proxy), so this is NODE_ENV=production only. The fallback regex excludes
  // /api, /api-docs, /openapi.json so unknown API paths still JSON-404 via
  // notFoundHandler.
  if (config.server.nodeEnv === 'production') {
    const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
    if (fs.existsSync(clientDist)) {
      app.use(express.static(clientDist));
      const indexHtml = path.join(clientDist, 'index.html');
      app.get(/^(?!\/api|\/api-docs|\/openapi\.json).*/, (req, res) => {
        res.sendFile(indexHtml);
      });
    } else {
      console.warn('⚠ client/dist not found — run `npm run build:client`. Serving API only.');
      app.get('/', (req, res) => res.json({ name: 'Microverse Server', version: '1.0.0', status: 'running' }));
    }
  } else {
    app.get('/', (req, res) => res.json({ name: 'Microverse Server', version: '1.0.0', status: 'running' }));
  }

  app.use(notFoundHandler);
```

- [ ] **Step 3: Add a regression test for the non-production `/` route**

Append to `server/src/test/integration/health-config.test.js`:
```js
test('GET / returns server info JSON (non-production)', async () => {
  const res = await request().get('/');
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Microverse Server');
  assert.equal(res.body.status, 'running');
});
```

- [ ] **Step 4: Run the full backend suite**

Run: `npm test --workspace=server`
Expected: PASS — new `/` regression green; no regressions (tests run with NODE_ENV=test → else branch).

- [ ] **Step 5: Manually verify production serving**

Run: `npm run build:client` then `NODE_ENV=production node server/src/server.js` (from repo root). Open `http://localhost:5000/` → the UI loads; navigate to a deep link like `/apps/1/logs` and refresh → still the UI (SPA fallback); `http://localhost:5000/api/health` → JSON; an unknown `http://localhost:5000/api/nope` → JSON 404 (not index.html). Stop the server afterward.

- [ ] **Step 6: Commit**

```bash
git -C /d/code/microverse add server/src/app.js \
        server/src/test/integration/health-config.test.js
git -C /d/code/microverse commit -m "$(cat <<'EOF'
feat: serve built frontend in production (single-port deploy)

In NODE_ENV=production, serve client/dist with an SPA fallback (excluding
/api, /api-docs, /openapi.json) so the backend exposes API + UI on one port
and a single reverse proxy target suffices. Dev still uses Vite. Falls back
to the JSON info route if client/dist is missing. /api/health remains the
health check.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: ecosystem.config.js + README Production/Updating rewrite

**Files:**
- Create: `server/ecosystem.config.js`
- Modify: `README.md` (Production Deployment section ~L90–107; insert Updating section; Configuration note)

**No automated test.** Verification: `npm run pm2:start` syntax (dry), and the README renders/links correctly.

- [ ] **Step 1: Create the PM2 ecosystem file**

Create `server/ecosystem.config.js`:
```js
// PM2 ecosystem for production. Run from the server/ directory:
//   npm run pm2:start        # start (cluster mode, one worker per core)
//   npm run pm2:logs
//   pm2 reload microverse-server   # zero-downtime reload after an update
//
// PORT / CORS_ORIGIN / ADMIN_* / SESSION_SECRET etc. are read from the repo
// root .env by server/src/config on each worker boot.
module.exports = {
  apps: [
    {
      name: 'microverse-server',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 'max',          // cluster: one worker per core (or set a number)
      exec_mode: 'cluster',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '512M'
    }
  ]
};
```

- [ ] **Step 2: Rewrite the README "Production Deployment" section**

In `README.md`, replace the entire `### Production Deployment` block (the 3 numbered steps about building frontend + `cd server && npm run pm2:start` + `npm run pm2:logs`) with:
```markdown
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
```

- [ ] **Step 3: Insert an "Updating" section after Production Deployment**

In `README.md`, immediately after the `### Production Deployment` section (before `## Usage`), insert:
```markdown
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
```

- [ ] **Step 4: Add a Configuration note for APP_PUBLIC_URL_TEMPLATE**

In `README.md`, inside the `.env` code fence of the `## Configuration` section (after `MAX_FILES=100`), add:
```env
# Deployed-app "Open" link template ({name} -> app name); unset -> http://localhost:<port>
# APP_PUBLIC_URL_TEMPLATE=https://{name}.yourdomain.com
```

- [ ] **Step 5: Sanity-check the ecosystem file loads**

Run: `cd /d/code/microverse/server && node -e "console.log(require('./ecosystem.config.js').apps[0].name)"`
Expected: prints `microverse-server` (validates the JS parses + exports the expected shape). Do NOT actually start PM2.

- [ ] **Step 6: Commit**

```bash
git -C /d/code/microverse add server/ecosystem.config.js README.md
git -C /d/code/microverse commit -m "$(cat <<'EOF'
docs: real ecosystem.config.js + Production/Updating deploy guide

Add a committed PM2 ecosystem (cluster mode) so npm run pm2:start works out of
the box. Rewrite the README Production section around single-port API+UI
serving, add an Updating section (git pull -> rebuild-if-needed -> pm2 reload,
data is gitignored + schema self-heals), and note the APP_PUBLIC_URL_TEMPLATE
config. Explicitly tell users who hand-patched app.js for static serving to
drop the local patch before pulling.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Chinese README

**Files:**
- Create: `README.zh-CN.md`
- Modify: `README.md` (language switcher line under the top tagline)

**No automated test.** Verification: content mirrors the (updated) English README; links valid.

- [ ] **Step 1: Add the language switcher to the English README**

In `README.md`, immediately under the top blockquote line (`> Deploy and manage your micro applications with ease`), add:
```markdown

**Languages:** [English](README.md) | [中文](README.zh-CN.md)
```

- [ ] **Step 2: Create the Chinese README**

Create `README.zh-CN.md` as a full Simplified-Chinese translation of the **current** (post-Task-4) `README.md`, mirroring its structure and headings section-for-section (intro, Features, Screenshots, Documentation, Quick Start, Production Deployment, Updating an existing deployment, Usage, Project Structure, API Endpoints, Configuration, Cross-Platform, Development, Tests, Troubleshooting, Technology Stack, License). The second line (under the title/tagline) must be:
```markdown

**语言：** [English](README.md) | [中文](README.zh-CN.md)
```
Keep all code blocks, commands, env var names, file paths, and API paths verbatim (English) — translate only prose. Translate the feature list and section bodies into natural Simplified Chinese. Use the existing `client/src/i18n/locales/zh.json` wording for UI-facing terms (e.g. 静态网站 / Node.js 应用 / Nginx) for consistency.

- [ ] **Step 3: Verify links + structure**

Open `README.zh-CN.md` and confirm: (a) every relative link/anchor matches the English README's; (b) the screenshot image paths (`docs/assets/*.png`) are unchanged; (c) the Production/Updating sections reflect the new single-port + `pm2 reload` + drop-local-patch guidance.

- [ ] **Step 4: Commit**

```bash
git -C /d/code/microverse add README.md README.zh-CN.md
git -C /d/code/microverse commit -m "$(cat <<'EOF'
docs: add Chinese README (README.zh-CN.md) + language switcher

Full Simplified-Chinese translation mirroring the English README, with a
language switcher at the top of both. Code/commands/paths kept verbatim;
prose translated; UI terms aligned with the zh locale.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: PROGRESS.md changelog + final verification

**Files:**
- Modify: `PROGRESS.md`

- [ ] **Step 1: Add the changelog entry**

In `PROGRESS.md`, at the top of the `## 变更日志` section (above the existing `### [Unreleased] — 2026-07-18` tech-debt-cleanup block), insert:
```markdown
### [Unreleased] — 2026-07-18 (domain deploy hardening)
#### 新增
- ZIP 自动去顶层目录：上传解压后若只有一个顶层文件夹则抬层（`utils/flatten-zip-root.js`），解决"zip 多套一层目录导致 index.html 校验失败"。
- 子域名外链：`APP_PUBLIC_URL_TEMPLATE`（如 `https://{name}.yourdomain.com`）经 `/api/config` 下发；前端 `AppConfigContext` + `buildAppUrl()`（`new URL()` 校验，失败退回 localhost）。
- 后端生产模式托管前端：`NODE_ENV=production` 时 `app.js` 挂 `express.static(client/dist)` + SPA fallback（排除 `/api` 等），单端口同吐 API+UI（替代此前未提交的 openclaw 补丁）。
- 提交真实 `server/ecosystem.config.js`（PM2 cluster 模式），`npm run pm2:start` 开箱即用。
- 中文 README（`README.zh-CN.md`）+ 顶部语言切换。
#### 文档
- README 重写"生产部署"段（单端口 + 反代）、新增"更新已部署实例"章节（`git pull` → 按需 `install:all`/`build:client` → `pm2 reload`；丢弃本地 app.js 补丁指引）。
```

- [ ] **Step 2: Run the whole backend suite + client lint/build**

Run: `npm test --workspace=server`
Expected: PASS — all tests green.
Run: `cd /d/code/microverse/client && npm run lint && npm run build`
Expected: lint 0 warnings, build succeeds.

- [ ] **Step 3: Commit**

```bash
git -C /d/code/microverse add PROGRESS.md
git -C /d/code/microverse commit -m "$(cat <<'EOF'
docs: changelog for domain deploy hardening (zip flatten, subdomain links, prod UI, ecosystem, zh README)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Verification Summary (end of plan)

After all tasks:
- `npm test --workspace=server` → all green (new flatten unit tests, /config field assertion, `/` regression).
- `cd client && npm run lint && npm run build` → clean.
- Manual smoke (`npm run dev`): upload a zip with a top-level wrapper folder → app dir has `index.html` at top, app starts. Set `APP_PUBLIC_URL_TEMPLATE=https://{name}.example.com` → port chip opens the subdomain; unset → localhost.
- Manual smoke (production): `npm run build:client && NODE_ENV=production node server/src/server.js` → `/` serves UI, deep links survive refresh, `/api/*` still JSON.
- `node -e "require('./server/ecosystem.config.js')"` → loads.
