# Admin Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the admin UI + API behind a single admin login (express-session + bcryptjs, env-seeded `users` table) so the open admin surface (server binds 0.0.0.0) is protected.

**Architecture:** A `users` table seeded once at boot from `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars (bcrypt-hashed, never stored plaintext). `express-session` (in-memory; single PM2 fork process) holds the login in an httpOnly `sameSite=lax` cookie. A `requireAuth` middleware — mounted via Express registration ordering so public routes (`health`, `config`, `auth/login`) sit before it and everything after is protected. Frontend uses an `AuthContext` + `/login` page + a layout-route guard.

**Tech Stack:** Node.js, Express, `express-session`, `bcryptjs` (pure JS — NOT native `bcrypt`, which has Windows build issues like better-sqlite3), React + Ant Design + react-i18next.

## Global Constraints

- **No test framework.** Verify via `node -e` (backend units) and `curl` (backend integration) and `npm run lint` (frontend). Absence of jest is NOT a defect.
- **Use `bcryptjs`, never `bcrypt`** (Windows native-compile risk — same category as the banned better-sqlite3).
- **Cross-platform paths:** `path.join` everywhere.
- **Database is async (`sqlite3`):** always `await` query calls.
- **Commit on `main`** (repo convention). English commit messages ending `Co-Authored-By: Claude <noreply@anthropic.com>`.
- **`req.session.user` shape** (the contract between login and `requireAuth`): `{ id: number, username: string }` — set on login, read by `requireAuth`, returned by `/auth/me`. Never includes `password_hash`.
- **Windows dev server:** restarting the backend leaves port 5000 bound; `netstat -ano | findstr :5000` → `taskkill //PID <pid> //F` (MSYS double-slash form) before relaunch.
- **Auth cookie is the existing axios instance** (`client/src/api/apps.js` exports default `api`); the new `api/auth.js` reuses it. `withCredentials: true` is added to that instance.

## File Structure

**Create (backend):** `server/src/services/auth-manager.js` (`ensureAdmin` seed + `verifyCredentials`); `server/src/middleware/auth.js` (`requireAuth`).
**Create (frontend):** `client/src/context/AuthContext.jsx`; `client/src/pages/Login.jsx`; `client/src/api/auth.js`.

**Modify (backend):** `server/src/db/schema.sql` (users table); `server/src/db/index.js` (3 user queries + export `dbReady`); `server/src/config/index.js` + `.env.example`; `server/src/app.js` (session middleware + `ensureAdmin` on `dbReady`); `server/src/routes/index.js` (auth routes + `requireAuth` ordering); `server/src/docs/openapi.yaml`; `server/package.json`.

**Modify (frontend):** `client/src/App.jsx` (AuthProvider + `/login` + `RequireAuth` layout route); `client/src/components/EditorialShell.jsx` (logout control); `client/src/api/apps.js` (`withCredentials`); `client/src/i18n/locales/{zh,en}.json`.

**Modify (docs):** `PROGRESS.md`, `README.md`.

---

## Task 1: Backend data layer — deps + config + schema + queries + AuthManager

**Files:**
- Modify: `server/package.json` (install `bcryptjs`, `express-session`)
- Modify: `server/src/config/index.js`
- Modify: `.env.example`
- Modify: `server/src/db/schema.sql`
- Modify: `server/src/db/index.js`
- Create: `server/src/services/auth-manager.js`

**Interfaces:**
- Produces: `config.auth.{adminUsername, adminPassword, sessionSecret}`; `queries.getUserCount()` / `getUserByUsername(username)` / `createUser(username, passwordHash)`; `dbReady` (exported promise from db); `AuthManager.ensureAdmin()` (idempotent seed) + `AuthManager.verifyCredentials(username, password)` → `Promise<{id, username} | null>`. Consumed by Task 2.

- [ ] **Step 1: Install dependencies**

```bash
cd server && npm install bcryptjs express-session
```
Expected: both added to `server/package.json` dependencies (pure-JS, no native build).

- [ ] **Step 2: Add `config.auth`**

In `server/src/config/index.js`, add a new top-level block inside the `config` object (after the `pm2:` block, before the closing `};` of `config`):

```js
  // Auth (single admin login)
  auth: {
    adminUsername: process.env.ADMIN_USERNAME || 'admin',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    sessionSecret: process.env.SESSION_SECRET || ''
  }
```

(Preceding `pm2:` block ends with `instanceName: process.env.PM2_INSTANCE_NAME || 'microverse-server'` — add a comma after it.)

- [ ] **Step 3: Add auth vars to `.env.example`**

Append (after the PM2 block):

```env

# Admin auth (single admin login). ADMIN_PASSWORD is used ONCE on first boot
# to seed a bcrypt-hashed row in the users table; after that it is ignored.
ADMIN_USERNAME=admin
ADMIN_PASSWORD=
# Session cookie secret. Unset = random ephemeral secret (sessions invalidate on restart).
SESSION_SECRET=
```

- [ ] **Step 4: Add the `users` table to `schema.sql`**

Append to `server/src/db/schema.sql`:

```sql

-- Admin user(s) for the admin login (single-admin in v1)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

- [ ] **Step 5: Add user queries + export `dbReady`**

In `server/src/db/index.js`:

(a) Replace the module-load init block:

```js
// Initialize on module load
initDatabase().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
```

with:

```js
// Initialize on module load; expose the promise so callers (e.g. AuthManager
// seeding at boot) can await schema readiness before querying.
const dbReady = initDatabase().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
```

(b) Inside the `queries` object, add (after `setAppEnv`):

```js
  ,

  // User queries (admin auth)
  getUserCount: () => dbGet('SELECT COUNT(*) AS count FROM users'),

  getUserByUsername: (username) => dbGet('SELECT * FROM users WHERE username = ?', [username]),

  createUser: (username, passwordHash) => dbRun(
    'INSERT INTO users (username, password_hash) VALUES (?, ?)',
    [username, passwordHash]
  )
```

(c) Update the export:

```js
module.exports = {
  db,
  queries,
  dbReady
};
```

- [ ] **Step 6: Create `server/src/services/auth-manager.js`**

```js
const bcrypt = require('bcryptjs');
const { queries } = require('../db');
const config = require('../config');

/**
 * AuthManager — single-admin auth: idempotent seeding + credential verification.
 * Used by app.js (ensureAdmin at boot) and routes (verifyCredentials on login).
 */
class AuthManager {
  /**
   * Seed an admin user from ADMIN_USERNAME/ADMIN_PASSWORD if the users table is
   * empty. Idempotent: no-op once any user exists. The env password is used once
   * to create a bcrypt hash; subsequent boots ignore the env vars.
   */
  static async ensureAdmin() {
    try {
      const row = await queries.getUserCount();
      if (row && row.count > 0) return; // an admin already exists

      const username = config.auth.adminUsername;
      const password = config.auth.adminPassword;
      if (!password) {
        console.warn('⚠ No admin user and ADMIN_PASSWORD not set — admin login unavailable. Set ADMIN_PASSWORD in .env and restart.');
        return;
      }
      const passwordHash = await bcrypt.hash(password, 10);
      await queries.createUser(username, passwordHash);
      console.log(`✓ Admin user '${username}' seeded. (To change the password, delete the users row and restart with a new ADMIN_PASSWORD.)`);
    } catch (err) {
      // Never crash boot over seeding — warn and continue.
      console.warn(`ensureAdmin failed: ${err.message}`);
    }
  }

  /**
   * Verify username/password against the DB. Returns the safe user object
   * (no password_hash) on success, or null on bad username/password.
   * @returns {Promise<{id:number, username:string} | null>}
   */
  static async verifyCredentials(username, password) {
    const user = await queries.getUserByUsername(username);
    if (!user) return null;
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return null;
    return { id: user.id, username: user.username };
  }
}

module.exports = AuthManager;
```

- [ ] **Step 7: Verify (no DB write)**

```bash
cd server
node -e '
const bcrypt = require("bcryptjs");
const am = require("./src/services/auth-manager");
if (typeof am.ensureAdmin !== "function") throw new Error("ensureAdmin missing");
if (typeof am.verifyCredentials !== "function") throw new Error("verifyCredentials missing");
const { queries, dbReady } = require("./src/db");
if (typeof queries.getUserCount !== "function") throw new Error("getUserCount missing");
if (typeof queries.getUserByUsername !== "function") throw new Error("getUserByUsername missing");
if (typeof queries.createUser !== "function") throw new Error("createUser missing");
if (!dbReady || typeof dbReady.then !== "function") throw new Error("dbReady not a promise");
const hash = bcrypt.hashSync("secret", 10);
if (!bcrypt.compareSync("secret", hash)) throw new Error("bcrypt true-compare failed");
if (bcrypt.compareSync("wrong", hash)) throw new Error("bcrypt false-compare failed");
console.log("AuthManager + bcryptjs + db queries OK");
'
```

Expected: `AuthManager + bcryptjs + db queries OK`.

- [ ] **Step 8: Commit**

```bash
git add server/package.json server/package-lock.json server/src/config/index.js .env.example server/src/db/schema.sql server/src/db/index.js server/src/services/auth-manager.js
git commit -m "feat(auth): users table + AuthManager (ensureAdmin/verifyCredentials) + config

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Backend HTTP layer — session + requireAuth + auth routes + openapi

**Files:**
- Create: `server/src/middleware/auth.js`
- Modify: `server/src/app.js` (session middleware + `ensureAdmin` on `dbReady`)
- Modify: `server/src/routes/index.js` (auth routes + `requireAuth` registration ordering)
- Modify: `server/src/docs/openapi.yaml`

**Interfaces:**
- Consumes: Task 1's `AuthManager.{ensureAdmin, verifyCredentials}`, `config.auth`, `dbReady`.
- Produces: working login flow — `POST /api/auth/login` (public), `POST /api/auth/logout` + `GET /api/auth/me` (protected), all `/api/apps*` protected; unauthenticated → 401.

- [ ] **Step 1: Create `server/src/middleware/auth.js`**

```js
/**
 * requireAuth — allow only authenticated requests (req.session.user set).
 * Mounted in routes/index.js AFTER public routes, so it guards everything
 * registered below it.
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  return res.status(401).json({
    success: false,
    error: { message: 'Authentication required' }
  });
}

module.exports = { requireAuth };
```

- [ ] **Step 2: Add session middleware + `ensureAdmin` to `app.js`**

In `server/src/app.js`:

(a) Add requires at the top (after `const metricsSampler = require('./services/metrics-sampler');`):

```js
const session = require('express-session');
const crypto = require('crypto');
const AuthManager = require('./services/auth-manager');
const { dbReady } = require('./db');
```

(b) Add the session middleware AFTER `app.use(express.urlencoded(...))` and BEFORE the dev request-logging middleware (i.e. right after the `express.urlencoded` line):

```js
// Session (admin auth). SESSION_SECRET falls back to a random ephemeral secret
// (sessions then invalidate on every restart — set SESSION_SECRET in .env).
const sessionSecret = config.auth.sessionSecret || crypto.randomBytes(32).toString('hex');
if (!config.auth.sessionSecret) {
  console.warn('⚠ SESSION_SECRET not set — using a random ephemeral secret (sessions invalidate on restart). Set SESSION_SECRET in .env for stable sessions.');
}
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 } // 8h
}));
```

(c) Inside the `app.listen` callback, after `metricsSampler.start();`, add:

```js

  // Seed the admin user once the DB schema is ready.
  dbReady.then(() => AuthManager.ensureAdmin()).catch(err => console.warn(`ensureAdmin failed: ${err.message}`));
```

- [ ] **Step 3: Add auth routes + `requireAuth` ordering in `routes/index.js`**

In `server/src/routes/index.js`:

(a) Add requires at the top (after `const metricsSampler = require('../services/metrics-sampler');`):

```js
const AuthManager = require('../services/auth-manager');
const { requireAuth } = require('../middleware/auth');
```

(b) Immediately AFTER the `GET /config` handler and BEFORE the `// Get all applications` / `router.get('/apps', ...)` handler, insert the public login route + the requireAuth gate:

```js
// Authenticate (public — must be registered BEFORE requireAuth)
router.post('/auth/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: { message: 'username and password are required' }
      });
    }
    const user = await AuthManager.verifyCredentials(username, password);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: { message: 'Invalid credentials' }
      });
    }
    // Regenerate the session to defeat session fixation, then stamp the user.
    req.session.regenerate((err) => {
      if (err) {
        return res.status(500).json({ success: false, error: { message: 'Login failed' } });
      }
      req.session.user = user;
      res.json({ success: true, data: { user } });
    });
  } catch (err) {
    next(err);
  }
});

// Everything below requires an authenticated session.
router.use(requireAuth);
```

(c) At the very end of the router (after the `PUT /apps/:id/env` handler, before `module.exports = router;`), add the protected auth routes:

```js
// Get the current session user (protected)
router.get('/auth/me', (req, res) => {
  res.json({ success: true, data: { user: req.session.user } });
});

// Log out (protected) — destroy the session + clear the cookie
router.post('/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ success: false, error: { message: 'Logout failed' } });
    }
    res.clearCookie('connect.sid'); // express-session default cookie name
    res.json({ success: true, data: { message: 'Logged out' } });
  });
});

module.exports = router;
```

(If `module.exports = router;` already exists at the end, the new routes go just above it — don't duplicate the export.)

- [ ] **Step 4: OpenAPI — auth note + auth endpoints**

In `server/src/docs/openapi.yaml`:

(a) Update the top `description:` (the block quoting the envelope) — append one line to it:

```yaml
    All `/apps` endpoints require an authenticated admin session (`POST /api/auth/login`); missing/invalid session → HTTP 401.
```

(b) Add the auth operations. Place them among the other paths (e.g. before the `/apps` paths), mirroring the existing operation style (`tags`, `operationId`, `parameters`, `responses`):

```yaml
  /auth/login:
    post:
      tags: [Auth]
      operationId: login
      summary: Admin login
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [username, password]
              properties:
                username: { type: string }
                password: { type: string, format: password }
      responses:
        '200':
          description: Authenticated; session cookie set
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, example: true }
                  data:
                    type: object
                    properties:
                      user:
                        type: object
                        properties:
                          id: { type: integer }
                          username: { type: string }
        '400':
          description: Missing username/password
        '401':
          description: Invalid credentials
  /auth/me:
    get:
      tags: [Auth]
      operationId: getMe
      summary: Current session user
      responses:
        '200':
          description: Current user
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, example: true }
                  data:
                    type: object
                    properties:
                      user:
                        type: object
                        properties:
                          id: { type: integer }
                          username: { type: string }
        '401':
          description: Not authenticated
  /auth/logout:
    post:
      tags: [Auth]
      operationId: logout
      summary: Destroy the admin session
      responses:
        '200':
          description: Logged out
```

(Match the content-type key style used elsewhere in the file for `application/json`.)

- [ ] **Step 5: Integration-verify via curl**

Free port 5000 if held. Boot with admin creds (the env password seeds the admin on first boot):

```bash
cd server
ADMIN_USERNAME=admin ADMIN_PASSWORD=test123 npm run dev   # background or separate terminal
```

In the boot log, confirm: `✓ Admin user 'admin' seeded.` Then (using a cookie jar):

```bash
# unauthenticated → 401
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5000/api/apps
# Expected: 401

# wrong password → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" -d '{"username":"admin","password":"wrong"}'
# Expected: 401

# correct login → 200 + Set-Cookie, saved to cookies.txt
curl -s -c cookies.txt -w "\n%{http_code}\n" -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" -d '{"username":"admin","password":"test123"}'
# Expected: {"success":true,"data":{"user":{"id":...,"username":"admin"}}} then 200

# authenticated → 200
curl -s -b cookies.txt -o /dev/null -w "%{http_code}\n" http://localhost:5000/api/apps
# Expected: 200

# logout → 200
curl -s -b cookies.txt -o /dev/null -w "%{http_code}\n" -X POST http://localhost:5000/api/auth/logout
# Expected: 200

# session destroyed → 401
curl -s -b cookies.txt -o /dev/null -w "%{http_code}\n" http://localhost:5000/api/apps
# Expected: 401
```

Also confirm the openapi still parses: `curl -s http://localhost:5000/openapi.json -o /dev/null -w "%{http_code}\n"` → `200`. Leave port 5000 free after.

- [ ] **Step 6: Commit**

```bash
git add server/src/middleware/auth.js server/src/app.js server/src/routes/index.js server/src/docs/openapi.yaml
git commit -m "feat(auth): session + requireAuth + login/logout/me routes

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Frontend auth — AuthContext + Login + route guard + logout

**Files:**
- Create: `client/src/context/AuthContext.jsx`
- Create: `client/src/api/auth.js`
- Create: `client/src/pages/Login.jsx`
- Modify: `client/src/api/apps.js` (add `withCredentials: true`)
- Modify: `client/src/App.jsx` (AuthProvider + `/login` route + `RequireAuth` layout route)
- Modify: `client/src/components/EditorialShell.jsx` (logout control)
- Modify: `client/src/i18n/locales/en.json` + `zh.json`

**Interfaces:**
- Consumes: Task 2's `/auth/login`, `/auth/logout`, `/auth/me`.
- Produces: a login flow — unauthenticated visitors hit `/login`; authenticated users see the app with a logout control.

- [ ] **Step 1: Add `withCredentials` to the axios instance**

In `client/src/api/apps.js`, add `withCredentials: true` to the `axios.create({...})` options (so the session cookie is sent on every request):

```js
const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json'
  }
})
```

- [ ] **Step 2: Create `client/src/api/auth.js`**

```js
import api from './apps'

/**
 * Admin login. Returns { id, username } on success; throws on 401.
 */
export const login = async (username, password) => {
  const response = await api.post('/auth/login', { username, password })
  return response.data.data.user
}

/**
 * Destroy the admin session.
 */
export const logout = async () => {
  await api.post('/auth/logout')
}

/**
 * Current session user, or throws 401 if unauthenticated.
 */
export const getMe = async () => {
  const response = await api.get('/auth/me')
  return response.data.data.user
}
```

- [ ] **Step 3: Create `client/src/context/AuthContext.jsx`**

```jsx
import { createContext, useContext, useState, useEffect } from 'react'
import { login as apiLogin, logout as apiLogout, getMe } from '../api/auth'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [checking, setChecking] = useState(true)

  // On mount: probe the session. 401 → user null (silent, normal "logged out").
  useEffect(() => {
    getMe()
      .then((u) => setUser(u))
      .catch(() => setUser(null))
      .finally(() => setChecking(false))
  }, [])

  const login = async (username, password) => {
    const u = await apiLogin(username, password)
    setUser(u)
    return u
  }

  const logout = async () => {
    await apiLogout()
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, checking, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
```

- [ ] **Step 4: Create `client/src/pages/Login.jsx`**

```jsx
import { useState } from 'react'
import { useNavigate, Navigate } from 'react-router-dom'
import { Form, Input, Button, message } from 'antd'
import { useTranslation } from 'react-i18next'
import EditorialShell from '../components/EditorialShell'
import { useAuth } from '../context/AuthContext'

function Login() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { login, user } = useAuth()
  const [loading, setLoading] = useState(false)

  // Already authenticated → bounce to the dashboard.
  if (user) return <Navigate to="/" replace />

  const handleSubmit = async (values) => {
    try {
      setLoading(true)
      await login(values.username, values.password)
      message.success(t('auth.loginSuccess'))
      navigate('/')
    } catch (err) {
      message.error(err.response?.data?.error?.message || t('auth.loginError'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <EditorialShell>
      <h1 className="page-title">{t('auth.loginTitle')}</h1>
      <div className="lead">{t('auth.loginLead')}</div>
      <Form
        layout="vertical"
        onFinish={handleSubmit}
        className="ed-form"
        style={{ maxWidth: 360, marginTop: 28 }}
      >
        <Form.Item
          label={t('auth.username')}
          name="username"
          rules={[{ required: true, message: t('auth.usernameRequired') }]}
        >
          <Input autoComplete="username" />
        </Form.Item>
        <Form.Item
          label={t('auth.password')}
          name="password"
          rules={[{ required: true, message: t('auth.passwordRequired') }]}
        >
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item style={{ marginBottom: 0 }}>
          <Button type="primary" htmlType="submit" className="btn-ink" loading={loading}>
            {t('auth.submit')}
          </Button>
        </Form.Item>
      </Form>
    </EditorialShell>
  )
}

export default Login
```

- [ ] **Step 5: Wire AuthProvider + routes + `RequireAuth` in `App.jsx`**

In `client/src/App.jsx`:

(a) Update the imports — replace:

```jsx
import { Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import { useTranslation } from 'react-i18next'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import Dashboard from './pages/Dashboard'
import CreateApp from './pages/CreateApp'
import UploadFiles from './pages/UploadFiles'
import AppLogs from './pages/AppLogs'
```

with:

```jsx
import { Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import { useTranslation } from 'react-i18next'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import Dashboard from './pages/Dashboard'
import CreateApp from './pages/CreateApp'
import UploadFiles from './pages/UploadFiles'
import AppLogs from './pages/AppLogs'
import AppMetrics from './pages/AppMetrics'
import Login from './pages/Login'
import { AuthProvider, useAuth } from './context/AuthContext'
```

(b) Add the `RequireAuth` layout component between `theme` and `function App()`:

```jsx
function RequireAuth() {
  const { user, checking } = useAuth()
  const { t } = useTranslation()
  if (checking) {
    return <div className="loading-line">{t('common.loading')}</div>
  }
  if (!user) {
    return <Navigate to="/login" replace />
  }
  return <Outlet />
}
```

(c) Replace the `return (...)` JSX inside `function App()` with:

```jsx
  return (
    <ConfigProvider locale={antdLocale} theme={theme}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireAuth />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/create" element={<CreateApp />} />
            <Route path="/apps/:id/upload" element={<UploadFiles />} />
            <Route path="/apps/:id/logs" element={<AppLogs />} />
            <Route path="/apps/:id/metrics" element={<AppMetrics />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </ConfigProvider>
  )
```

- [ ] **Step 6: Add the logout control to `EditorialShell.jsx`**

Replace the whole file with:

```jsx
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import LanguageSwitcher from './LanguageSwitcher'
import { useAuth } from '../context/AuthContext'

function EditorialShell({ right, children }) {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { user, logout } = useAuth()

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  return (
    <div className="shell">
      <div className="shell-inner">
        <header className="topbar">
          <a
            className="wordmark"
            href="/"
            onClick={(e) => { e.preventDefault(); navigate('/') }}
          >
            Micro<em>verse</em>
          </a>
          <nav className="nav">
            {right ?? <LanguageSwitcher />}
            {user && (
              <button className="nav-link" onClick={handleLogout}>
                {user.username} · {t('auth.logout')}
              </button>
            )}
          </nav>
        </header>
        <main className="page">{children}</main>
      </div>
    </div>
  )
}

export default EditorialShell
```

- [ ] **Step 7: Add i18n keys (zh + en)**

In `client/src/i18n/locales/zh.json`, add a new top-level section (e.g. after `"common"`):

```json
  "auth": {
    "loginTitle": "登录",
    "loginLead": "管理员登录以管理应用",
    "username": "用户名",
    "password": "密码",
    "submit": "登录",
    "usernameRequired": "请输入用户名",
    "passwordRequired": "请输入密码",
    "loginSuccess": "登录成功",
    "loginError": "登录失败",
    "logout": "登出"
  },
```

In `client/src/i18n/locales/en.json`, mirror it:

```json
  "auth": {
    "loginTitle": "Sign in",
    "loginLead": "Admin sign-in to manage apps",
    "username": "Username",
    "password": "Password",
    "submit": "Sign in",
    "usernameRequired": "Enter your username",
    "passwordRequired": "Enter your password",
    "loginSuccess": "Signed in",
    "loginError": "Sign-in failed",
    "logout": "Sign out"
  },
```

- [ ] **Step 8: Verify lint + JSON**

```bash
cd client && npm run lint
```
Expected: no errors (`--max-warnings 0`). Then confirm both locales parse:

```bash
node -e "JSON.parse(require('fs').readFileSync('src/i18n/locales/zh.json','utf-8'));JSON.parse(require('fs').readFileSync('src/i18n/locales/en.json','utf-8'));console.log('locales OK')"
```
Expected: `locales OK`.

- [ ] **Step 9: Commit**

```bash
git add client/src/context/AuthContext.jsx client/src/api/auth.js client/src/pages/Login.jsx client/src/api/apps.js client/src/App.jsx client/src/components/EditorialShell.jsx client/src/i18n/locales/en.json client/src/i18n/locales/zh.json
git commit -m "feat(auth): login page + AuthContext + route guard + logout control

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Docs — PROGRESS + README

**Files:**
- Modify: `PROGRESS.md`
- Modify: `README.md`

- [ ] **Step 1: Update `PROGRESS.md`**

(a) Replace the Phase 14 block:

```markdown
### 🎯 Phase 14: 用户系统 (优先级: 低)
- [ ] 用户注册/登录
- [ ] JWT 认证
- [ ] 权限管理
- [ ] 多用户应用隔离
```

with:

```markdown
### ✅ Phase 14: 用户系统（单管理员登录部分，2026-07-12）
- [x] 单管理员登录（`users` 表 + bcryptjs + express-session；env 播种；requireAuth 罩住 `/api/apps*`；前端登录页 + 路由守卫 + 登出）
- [ ] 多用户 / 注册（按需；users 表已在）
- [ ] JWT / 细粒度权限（按需）
- [ ] 多用户应用隔离（需 owner 列 + 每查询过滤；按需）
```

(b) In the changelog "### [Unreleased] — 2026-07-12" block, under "#### 新增", prepend:

```markdown
- Phase 14（单管理员登录部分）：新增 `users` 表 + `AuthManager`（ensureAdmin env 播种 + bcryptjs 校验）+ `express-session`（httpOnly、sameSite=lax）+ `requireAuth` 中间件（罩住 `/api/apps*`，公开 `/health` `/config` `/auth/login`）+ `POST /api/auth/login` `POST /auth/logout` `GET /auth/me`；前端 `AuthContext` + 登录页 + `RequireAuth` 路由守卫 + EditorialShell 登出。多用户/JWT/多租户待后续按需。
```

(c) In "## 下一步计划" → "长期目标", tick the user-system line:

```markdown
1. ✅ 用户系统 (Phase 14，单管理员登录部分)
```

- [ ] **Step 2: Update `README.md`**

In the Features list, add a bullet after "📊 **Status Sync**":

```markdown
- 🔒 **Admin Login**: the dashboard and API are gated behind a single admin session (set `ADMIN_USERNAME`/`ADMIN_PASSWORD` in `.env`; the password is bcrypt-hashed on first boot)
```

- [ ] **Step 3: Commit**

```bash
git add PROGRESS.md README.md
git commit -m "docs: admin auth (Phase 14 partial, single-admin login)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Done criteria

- With `ADMIN_USERNAME`/`ADMIN_PASSWORD` set, boot seeds the admin (log line); unauthenticated `/api/apps` → 401; login → 200 + cookie; authenticated `/api/apps` → 200; logout → subsequent 401.
- Frontend: fresh load redirects to `/login`; correct credentials enter the dashboard; the topbar shows `<user> · 登出`; logout returns to `/login`.
- `npm run lint` (client) passes; openapi parses (`/openapi.json` 200).
- `PROGRESS.md` Phase 14 single-admin item ticked; README mentions the admin login. Multi-user / JWT / multi-tenant remain explicitly deferred.
