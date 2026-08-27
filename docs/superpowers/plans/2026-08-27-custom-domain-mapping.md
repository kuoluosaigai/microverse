# 通用自定义域名映射 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增「任意外部域名 → 内部端口 / 内部应用」的通用反向代理映射，管理面为 Web UI + 数据库，自定义域名 v1 仅 HTTP。

**Architecture:** 在现有 `ProxyManager` 的 nginx 边缘反代上扩展：新增 `proxy_routes` 表存映射，`renderProxyConfig` 增渲染自定义 server 块（排在最前、显式优先），`regenerate` 一并读取并写入同一 conf 文件。前端新增 `/routes` 页面。

**Tech Stack:** Node.js + Express + sqlite3 + PM2（后端）；React + Vite + Ant Design + i18next（前端）；测试用 `node:test` + `node:assert/strict` + supertest。

## Global Constraints

- 数据库用 `sqlite3`（**不是** better-sqlite3）；所有 DB 操作异步且 `await`。
- 自定义域名块**仅 HTTP**（`listen 80`，无 `listen 443`），即使 `PROXY_SSL_ENABLED=true` 也不套 SSL。
- 自定义路由块排在**自动子域名块与根域名块之前**（nginx 精确 `server_name` 先到先得，显式优先）。
- `renderProxyConfig` 中 `baseDomain` 变为可选：为空串时跳过自动子域名 + 根域名块，但**仍渲染自定义路由块**。
- `host` 白名单 `^[\w.-]+$`，入库前 `trim().toLowerCase()`。
- `validateProxyRoute` 抛出的错误消息统一以 `Invalid proxy route: ` 开头。
- `regenerate()` 失败**绝不阻断 CRUD**（try/catch + `console.warn`），沿用现有约定。
- i18n 语言文件是 `client/src/i18n/locales/en.json` 与 `zh.json`（**不是** zh-CN.json）；locale 代码为 `zh`。
- 测试运行方式：根目录 `npm test`（等价 `npm test --workspace=server`）；单文件 `cd server && node --test <file>`。

---

### Task 1: 数据模型与查询函数

**Files:**
- Modify: `server/src/db/schema.sql`（追加 `proxy_routes` 表 + 索引）
- Modify: `server/src/db/index.js`（`queries` 对象内新增 5 个函数）
- Test: `server/src/test/integration/proxy-routes-db.test.js`（新建）

**Interfaces:**
- Produces: `queries.listProxyRoutes()` → `Promise<Array<row>>`；`queries.getProxyRouteById(id)` → `Promise<row|undefined>`；`queries.createProxyRoute({host,target_type,target_port,target_app_id})` → `Promise<{lastID,changes}>`；`queries.updateProxyRoute(id, {host,target_type,target_port,target_app_id})` → `Promise<{changes}>`；`queries.deleteProxyRoute(id)` → `Promise<{changes}>`。row 字段：`id, host, target_type, target_port, target_app_id, created_at, updated_at`。后续 Task 2/3 依赖这些签名。

- [ ] **Step 1: 写失败的测试**

新建 `server/src/test/integration/proxy-routes-db.test.js`：

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { init, queries } = require('../helpers/setup');
const { dbAll } = require('../../db');

test('proxy_routes table exists after init', async () => {
  await init();
  const tables = await dbAll(`SELECT name FROM sqlite_master WHERE type='table' AND name='proxy_routes'`);
  assert.equal(tables.length, 1, 'proxy_routes table present');
});

test('createProxyRoute + listProxyRoutes round-trip', async () => {
  await init();
  const r = await queries.createProxyRoute({ host: 'a.example.com', target_type: 'port', target_port: 8080, target_app_id: null });
  const rows = await queries.listProxyRoutes();
  const row = rows.find(x => x.id === r.lastID);
  assert.ok(row);
  assert.equal(row.host, 'a.example.com');
  assert.equal(row.target_type, 'port');
  assert.equal(row.target_port, 8080);
  assert.equal(row.target_app_id, null);
  await queries.deleteProxyRoute(r.lastID);
});

test('updateProxyRoute updates fields', async () => {
  await init();
  const r = await queries.createProxyRoute({ host: 'upd.example.com', target_type: 'port', target_port: 8080, target_app_id: null });
  await queries.updateProxyRoute(r.lastID, { host: 'upd.example.com', target_type: 'port', target_port: 9090, target_app_id: null });
  const rows = await queries.listProxyRoutes();
  assert.equal(rows.find(x => x.id === r.lastID).target_port, 9090);
  await queries.deleteProxyRoute(r.lastID);
});

test('duplicate host violates UNIQUE', async () => {
  await init();
  const r = await queries.createProxyRoute({ host: 'dup.example.com', target_type: 'port', target_port: 8080, target_app_id: null });
  await assert.rejects(
    () => queries.createProxyRoute({ host: 'dup.example.com', target_type: 'port', target_port: 9090, target_app_id: null }),
    /UNIQUE constraint failed/i
  );
  await queries.deleteProxyRoute(r.lastID);
});

test('CHECK rejects port target with no target_port', async () => {
  await init();
  await assert.rejects(
    () => queries.createProxyRoute({ host: 'noport.example.com', target_type: 'port', target_port: null, target_app_id: null }),
    /CHECK constraint failed/i
  );
});

test('ON DELETE CASCADE removes routes pointing at a deleted app', async () => {
  await init();
  const a = await queries.createApp({ name: 'route-cascade', path: '/tmp/rc', deploy_type: 'http-server', port: 3001, status: 'running' });
  const r = await queries.createProxyRoute({ host: 'cascade.example.com', target_type: 'app', target_port: null, target_app_id: a.lastID });
  await queries.deleteApp(a.lastID);
  const rows = await queries.listProxyRoutes();
  assert.ok(!rows.some(x => x.id === r.lastID), 'route removed when app deleted');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && node --test src/test/integration/proxy-routes-db.test.js`
Expected: FAIL — `proxy_routes` 表不存在 / `queries.listProxyRoutes` is not a function。

- [ ] **Step 3: 实现 schema 与查询**

在 `server/src/db/schema.sql` 末尾追加（在 `users` 表之后）：

```sql
-- Custom domain -> port/app reverse-proxy mappings (edge proxy, opt-in via PROXY_ENABLED)
CREATE TABLE IF NOT EXISTS proxy_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL UNIQUE,
  target_type TEXT NOT NULL CHECK(target_type IN ('port','app')),
  target_port INTEGER,
  target_app_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (target_app_id) REFERENCES apps(id) ON DELETE CASCADE,
  CHECK (
    (target_type='port' AND target_port IS NOT NULL AND target_app_id IS NULL) OR
    (target_type='app'  AND target_app_id IS NOT NULL AND target_port IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_proxy_routes_host ON proxy_routes(host);
```

在 `server/src/db/index.js` 的 `queries` 对象内、`// User queries (admin auth)` 之前插入：

```js
  // Proxy route queries (custom domain -> port/app mappings)
  listProxyRoutes: () => dbAll('SELECT * FROM proxy_routes ORDER BY id'),

  getProxyRouteById: (id) => dbGet('SELECT * FROM proxy_routes WHERE id = ?', [id]),

  createProxyRoute: (params) => dbRun(
    'INSERT INTO proxy_routes (host, target_type, target_port, target_app_id) VALUES (?, ?, ?, ?)',
    [params.host, params.target_type, params.target_port ?? null, params.target_app_id ?? null]
  ),

  updateProxyRoute: (id, params) => dbRun(
    'UPDATE proxy_routes SET host = ?, target_type = ?, target_port = ?, target_app_id = ? WHERE id = ?',
    [params.host, params.target_type, params.target_port ?? null, params.target_app_id ?? null, id]
  ),

  deleteProxyRoute: (id) => dbRun('DELETE FROM proxy_routes WHERE id = ?', [id]),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && node --test src/test/integration/proxy-routes-db.test.js`
Expected: PASS（6 项）。

- [ ] **Step 5: 提交**

```bash
git add server/src/db/schema.sql server/src/db/index.js server/src/test/integration/proxy-routes-db.test.js
git commit -m "feat(db): add proxy_routes table and queries for custom domain mapping"
```

---

### Task 2: ProxyManager 渲染与校验

**Files:**
- Modify: `server/src/services/proxy-manager.js`（`renderProxyConfig` 加 routes 入参、`validateProxyRoute` 新增、`baseDomain` 可选化、`regenerate` 读 routes）
- Modify: `server/src/test/unit/proxy-config.test.js`（改既有调用 + 新增用例）

**Interfaces:**
- Consumes: `queries.listProxyRoutes()`（Task 1）。
- Produces: `renderProxyConfig(apps, routes, opts)` → `string`；`validateProxyRoute(input, { apps })` → `{host,target_type,target_port,target_app_id}` 或抛 `Error`（前缀 `Invalid proxy route: `）。`module.exports` 增 `validateProxyRoute`。Task 3 依赖这两个导出。

- [ ] **Step 1: 写失败的测试**

在 `server/src/test/unit/proxy-config.test.js` 顶部 require 增加 `validateProxyRoute`：

```js
const { renderProxyConfig, validateBaseDomain, resolveBaseDomain, validateProxyRoute } = require('../../services/proxy-manager');
```

在文件末尾追加以下用例：

```js
const route = (over) => ({ id: 1, host: 'a.example.com', target_type: 'port', target_port: 8080, target_app_id: null, ...over });

test('custom port route renders an HTTP block', () => {
  const conf = renderProxyConfig([], [route()], { baseDomain: 'x.com', ssl: {} });
  assert.match(conf, /server_name a\.example\.com;/);
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:8080;/);
  assert.match(conf, /listen 80;/);
  assert.doesNotMatch(conf, /listen 443/);
});

test('custom app route follows a running app port', () => {
  const app = { id: 42, name: 'target', port: 3333, status: 'running', is_default: 0 };
  const conf = renderProxyConfig([app], [route({ target_type: 'app', target_app_id: 42, target_port: null })], { baseDomain: 'x.com', ssl: {} });
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:3333;/);
});

test('custom app route skips stopped / missing app', () => {
  const stopped = { id: 42, name: 'target', port: 3333, status: 'stopped', is_default: 0 };
  const confStopped = renderProxyConfig([stopped], [route({ target_type: 'app', target_app_id: 42, target_port: null })], { baseDomain: 'x.com', ssl: {} });
  assert.doesNotMatch(confStopped, /server_name a\.example\.com;/);

  const missing = renderProxyConfig([], [route({ target_type: 'app', target_app_id: 999, target_port: null })], { baseDomain: 'x.com', ssl: {} });
  assert.doesNotMatch(missing, /server_name a\.example\.com;/);
});

test('custom routes render before auto subdomain blocks', () => {
  const app = { id: 1, name: 'zeta', port: 3001, status: 'running', is_default: 0 };
  const conf = renderProxyConfig([app], [route()], { baseDomain: 'x.com', ssl: {} });
  const ic = conf.indexOf('a.example.com');
  const ia = conf.indexOf('zeta.x.com');
  assert.ok(ic > -1 && ia > -1 && ic < ia, 'custom before auto');
});

test('custom routes render even when baseDomain is empty', () => {
  const conf = renderProxyConfig([], [route()], { baseDomain: '', ssl: {} });
  assert.match(conf, /server_name a\.example\.com;/);
  assert.doesNotMatch(conf, /\.x\.com;/);
});

test('custom route stays HTTP-only even when ssl enabled', () => {
  const conf = renderProxyConfig([], [route()], { baseDomain: 'x.com', ssl: { enabled: true, cert: '/c.pem', key: '/k.pem' } });
  assert.match(conf, /server_name a\.example\.com;/);
  assert.doesNotMatch(conf, /listen 443/);
});

test('validateProxyRoute normalizes a port route', () => {
  const out = validateProxyRoute({ host: 'A.Example.COM', target_type: 'port', target_port: '8080' }, { apps: [] });
  assert.deepEqual(out, { host: 'a.example.com', target_type: 'port', target_port: 8080, target_app_id: null });
});

test('validateProxyRoute normalizes an app route', () => {
  const out = validateProxyRoute({ host: 'app.example.com', target_type: 'app', target_app_id: 7 }, { apps: [{ id: 7, name: 'x' }] });
  assert.deepEqual(out, { host: 'app.example.com', target_type: 'app', target_port: null, target_app_id: 7 });
});

test('validateProxyRoute rejects bad input', () => {
  assert.throws(() => validateProxyRoute({ host: 'bad host', target_type: 'port', target_port: 80 }, {}), /Invalid proxy route/);
  assert.throws(() => validateProxyRoute({ host: 'x.com', target_type: 'wat', target_port: 80 }, {}), /Invalid proxy route/);
  assert.throws(() => validateProxyRoute({ host: 'x.com', target_type: 'port', target_port: 0 }, {}), /Invalid proxy route/);
  assert.throws(() => validateProxyRoute({ host: 'x.com', target_type: 'port', target_port: 99999 }, {}), /Invalid proxy route/);
  assert.throws(() => validateProxyRoute({ host: 'x.com', target_type: 'app', target_app_id: 999 }, { apps: [] }), /Invalid proxy route/);
  assert.throws(() => validateProxyRoute({ host: 'x.com', target_type: 'app' }, { apps: [{ id: 1 }] }), /Invalid proxy route/);
});
```

同时，把既有的 `missing or invalid baseDomain throws` 测试（原 `proxy-config.test.js:56-61`）整体替换为：

```js
test('empty baseDomain with no custom routes -> header-only; invalid baseDomain throws', () => {
  const empty = renderProxyConfig([app()], [], { baseDomain: '', ssl: {} });
  assert.match(empty, /Managed by Microverse/);
  assert.doesNotMatch(empty, /server \{/);
  assert.throws(() => renderProxyConfig([app()], [], { baseDomain: 'bad domain', ssl: {} }));
  assert.throws(() => validateBaseDomain(''));
  assert.throws(() => validateBaseDomain('a b;c'));
});
```

并把文件中**其余**所有两参调用 `renderProxyConfig(<expr>, { baseDomain` 改为三参 `renderProxyConfig(<expr>, [], { baseDomain`（在第二参数位插入 `[]`）。涉及：running app -> one HTTP…、stopped app and portless…、default running app…、default flag is ignored…、multiple running apps…、no running apps…、ssl enabled with cert+key…、ssl enabled but missing… 这些用例。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && node --test src/test/unit/proxy-config.test.js`
Expected: FAIL — `validateProxyRoute is not a function`；`renderProxyConfig` 尚未接受 `routes`，自定义用例不产出预期输出。

- [ ] **Step 3: 实现**

修改 `server/src/services/proxy-manager.js`：

`renderProxyConfig` 整体替换为：

```js
/**
 * Pure: render the full managed nginx conf for the given apps + custom routes.
 * @param {Array<{name:string,port:number,status:string,is_default:number}>} apps
 * @param {Array<{host:string,target_type:string,target_port:number,target_app_id:number}>} routes
 * @param {{baseDomain:string, ssl:{enabled?:boolean,cert?:string,key?:string}}} opts
 * @returns {string}
 */
function renderProxyConfig(apps, routes = [], opts = {}) {
  const { baseDomain = '', ssl } = opts;
  if (baseDomain) validateBaseDomain(baseDomain);

  // Coerce port to a safe integer and skip apps whose port isn't a finite
  // positive integer — guards against a theoretical string-injection vector
  // from a manually-edited DB. Uses the coerced port (not a.port) downstream.
  const running = apps
    .map(a => ({ a, port: Math.floor(Number(a.port)) }))
    .filter(({ a, port }) => a.status === 'running' && Number.isFinite(port) && port > 0)
    .sort(({ a: x }, { a: y }) => x.name.localeCompare(y.name));

  const blocks = [];

  // 1. Custom routes first (explicit admin config wins over auto-generated
  //    subdomains on a name collision). Always HTTP-only in v1.
  const routesSorted = (routes || []).slice().sort((x, y) => x.host.localeCompare(y.host));
  for (const r of routesSorted) {
    let port = null;
    if (r.target_type === 'port') {
      const p = Math.floor(Number(r.target_port));
      if (Number.isFinite(p) && p >= 1 && p <= 65535) port = p;
    } else if (r.target_type === 'app') {
      const target = running.find(({ a }) => a.id === r.target_app_id);
      if (target) port = target.port;
    }
    if (port) blocks.push(renderServerBlock(r.host, port, null));
  }

  // 2. Auto subdomain + 3. root-domain default app blocks (only when a base
  //    domain is configured).
  if (baseDomain) {
    for (const { a, port } of running) {
      blocks.push(renderServerBlock(`${a.name}.${baseDomain}`, port, ssl));
    }
    const def = running.find(({ a }) => a.is_default);
    if (def) {
      blocks.push(renderServerBlock(`${baseDomain} www.${baseDomain}`, def.port, ssl));
    }
  }

  if (blocks.length === 0) return HEADER + '\n';
  return HEADER + '\n' + blocks.join('\n\n') + '\n';
}
```

在 `renderServerBlock` 定义之后、`regenerate` 之前新增：

```js
/**
 * Validate + normalize a proxy-route input. Returns { host, target_type,
 * target_port, target_app_id } or throws a descriptive Error (prefix
 * "Invalid proxy route: " so routes can map it to a 400).
 * @param {{host?:string, target_type?:string, target_port?:any, target_app_id?:any}} input
 * @param {{apps?:Array<{id:number}>}} ctx apps list for target_type='app' existence check
 */
function validateProxyRoute(input = {}, ctx = {}) {
  const host = String(input.host || '').trim().toLowerCase();
  if (!/^[\w.-]+$/.test(host)) {
    throw new Error('Invalid proxy route: host must be a valid domain (letters, digits, dots, hyphens)');
  }
  const targetType = input.target_type;
  if (targetType !== 'port' && targetType !== 'app') {
    throw new Error("Invalid proxy route: target_type must be 'port' or 'app'");
  }
  if (targetType === 'port') {
    const port = Math.floor(Number(input.target_port));
    if (!Number.isFinite(port) || port < 1 || port > 65535 || input.target_app_id != null) {
      throw new Error('Invalid proxy route: port target requires target_port (1-65535) and no target_app_id');
    }
    return { host, target_type: 'port', target_port: port, target_app_id: null };
  }
  const appId = Math.floor(Number(input.target_app_id));
  if (!Number.isFinite(appId) || appId < 1 || input.target_port != null) {
    throw new Error('Invalid proxy route: app target requires target_app_id and no target_port');
  }
  if (!(ctx.apps || []).some(a => a.id === appId)) {
    throw new Error('Invalid proxy route: target app not found');
  }
  return { host, target_type: 'app', target_port: null, target_app_id: appId };
}
```

修改 `regenerate()`：把「读 apps → render」那段替换为（同时把原来的 `no-base-domain` 提前返回移到 try 块内、并仅在无自定义路由时才触发）：

```js
  let conf;
  try {
    const [apps, routes] = await Promise.all([queries.getAllApps(), queries.listProxyRoutes()]);
    if (!baseDomain && routes.length === 0) {
      console.warn('⚠ [proxy] PROXY_ENABLED but no base domain and no custom routes. Skipping.');
      return { ok: false, skipped: true, reason: 'no-base-domain' };
    }
    conf = renderProxyConfig(apps, routes, { baseDomain, ssl });
  } catch (err) {
    console.warn(`⚠ [proxy] render failed: ${err.message}`);
    return { ok: false, reason: 'render-failed', message: err.message };
  }
```

并删除原先 try 块上方那段 `if (!baseDomain) { ... return { ok:false, skipped:true, reason:'no-base-domain' } }`（`resolveBaseDomain` 调用保持不变，仍在上方）。

最后，`module.exports` 追加 `validateProxyRoute`：

```js
module.exports = { renderProxyConfig, validateBaseDomain, resolveBaseDomain, validateProxyRoute, regenerate };
```

同时修改 `server/src/test/integration/proxy-regenerate.test.js`：在 `regenerate skips with a warning when base domain is missing` 测试内 `const s = snapshot();` 之后加一行 `await init();`（新 `regenerate` 会先读 `listProxyRoutes()`，需等 `dbReady`，否则可能 `no such table: proxy_routes`）。完整变为：

```js
test('regenerate skips with a warning when base domain is missing', async () => {
  const s = snapshot();
  await init();
  config.deployment.proxyEnabled = true;
  ...
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && node --test src/test/unit/proxy-config.test.js`
Expected: PASS（含既有 + 新增用例）。

再确认没有破坏集成测试：

Run: `cd server && node --test src/test/integration/proxy-regenerate.test.js`
Expected: PASS（`no-base-domain` 路径仍因空 routes 触发）。

- [ ] **Step 5: 提交**

```bash
git add server/src/services/proxy-manager.js server/src/test/unit/proxy-config.test.js server/src/test/integration/proxy-regenerate.test.js
git commit -m "feat(proxy): render custom domain routes and add validateProxyRoute"
```

---

### Task 3: CRUD API 端点

**Files:**
- Modify: `server/src/routes/index.js`（新增 4 个端点）
- Test: `server/src/test/integration/proxy-routes-api.test.js`（新建）

**Interfaces:**
- Consumes: `ProxyManager.validateProxyRoute`、`ProxyManager.regenerate`（Task 2）；`queries.listProxyRoutes / getProxyRouteById / createProxyRoute / updateProxyRoute / deleteProxyRoute`（Task 1）。
- Produces: `GET /api/proxy-routes`、`POST /api/proxy-routes`、`PUT /api/proxy-routes/:id`、`DELETE /api/proxy-routes/:id`。Task 4 前端依赖这些。

- [ ] **Step 1: 写失败的测试**

新建 `server/src/test/integration/proxy-routes-api.test.js`：

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request, adminAgent, queries } = require('../helpers/setup');
const ProxyManager = require('../../services/proxy-manager');

async function seedApp(name) {
  const a = await queries.createApp({ name, path: `/tmp/${name}`, deploy_type: 'http-server', port: 4001, status: 'running' });
  return a.lastID;
}

test('proxy-routes endpoints require auth', async () => {
  const r = await request().get('/api/proxy-routes');
  assert.equal(r.status, 401);
  const p = await request().post('/api/proxy-routes').send({});
  assert.equal(p.status, 401);
});

test('POST creates a port route and regenerates', async () => {
  const agent = await adminAgent();
  const orig = ProxyManager.regenerate;
  let called = false;
  ProxyManager.regenerate = async () => { called = true; return { ok: true }; };
  try {
    const r = await agent.post('/api/proxy-routes').send({ host: 'a.example.com', target_type: 'port', target_port: 8080 });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.host, 'a.example.com');
    assert.equal(r.body.data.target_port, 8080);
    assert.equal(called, true);
  } finally {
    ProxyManager.regenerate = orig;
  }
});

test('POST rejects duplicate host and invalid target', async () => {
  const agent = await adminAgent();
  await agent.post('/api/proxy-routes').send({ host: 'dup.example.com', target_type: 'port', target_port: 8080 });
  const dup = await agent.post('/api/proxy-routes').send({ host: 'dup.example.com', target_type: 'port', target_port: 9090 });
  assert.equal(dup.status, 400);
  const bad = await agent.post('/api/proxy-routes').send({ host: 'bad.example.com', target_type: 'app', target_app_id: 999999 });
  assert.equal(bad.status, 400);
});

test('GET lists routes with target_app_name + resolved', async () => {
  const agent = await adminAgent();
  const id = await seedApp('resolve-me');
  await agent.post('/api/proxy-routes').send({ host: 'resolve.example.com', target_type: 'app', target_app_id: id });
  const r = await agent.get('/api/proxy-routes');
  assert.equal(r.status, 200);
  const row = r.body.data.find(x => x.host === 'resolve.example.com');
  assert.ok(row);
  assert.equal(row.target_app_name, 'resolve-me');
  assert.equal(row.resolved, true);
});

test('PUT updates a route and regenerates; DELETE removes and regenerates', async () => {
  const agent = await adminAgent();
  const created = await agent.post('/api/proxy-routes').send({ host: 'edit.example.com', target_type: 'port', target_port: 8080 });
  const id = created.body.data.id;
  const orig = ProxyManager.regenerate;
  let called = 0;
  ProxyManager.regenerate = async () => { called++; return { ok: true }; };
  try {
    const up = await agent.put(`/api/proxy-routes/${id}`).send({ host: 'edit.example.com', target_type: 'port', target_port: 9090 });
    assert.equal(up.status, 200);
    assert.equal(up.body.data.target_port, 9090);

    const del = await agent.delete(`/api/proxy-routes/${id}`);
    assert.equal(del.status, 200);
    assert.ok(called >= 2, 'regenerate called on update and delete');
  } finally {
    ProxyManager.regenerate = orig;
  }
});

test('PUT/DELETE on a missing route returns 404', async () => {
  const agent = await adminAgent();
  const up = await agent.put('/api/proxy-routes/999999').send({ host: 'x.example.com', target_type: 'port', target_port: 80 });
  assert.equal(up.status, 404);
  const del = await agent.delete('/api/proxy-routes/999999');
  assert.equal(del.status, 404);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && node --test src/test/integration/proxy-routes-api.test.js`
Expected: FAIL — 404（端点未注册）。

- [ ] **Step 3: 实现端点**

在 `server/src/routes/index.js` 中，`DELETE /apps/:id/default` 路由之后、`GET /auth/me` 之前插入：

```js
// List custom domain mappings (reverse-proxy routes)
router.get('/proxy-routes', async (req, res, next) => {
  try {
    const routes = await queries.listProxyRoutes();
    const apps = await queries.getAllApps();
    const byId = new Map(apps.map(a => [a.id, a]));
    const data = routes.map(r => {
      const app = r.target_app_id != null ? byId.get(r.target_app_id) : null;
      return {
        ...r,
        target_app_name: app ? app.name : null,
        resolved: r.target_type === 'port' ? true : !!(app && app.status === 'running' && app.port)
      };
    });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

// Create a custom domain mapping
router.post('/proxy-routes', async (req, res, next) => {
  try {
    const apps = await queries.getAllApps();
    const route = ProxyManager.validateProxyRoute(req.body, { apps });
    const existing = await queries.listProxyRoutes();
    if (existing.some(r => r.host === route.host)) {
      return res.status(400).json({ success: false, error: { message: 'Domain already exists' } });
    }
    const result = await queries.createProxyRoute(route);
    try { await ProxyManager.regenerate(); } catch (e) { console.warn(`[proxy] regenerate failed: ${e.message}`); }
    const created = await queries.getProxyRouteById(result.lastID);
    res.status(201).json({ success: true, data: created });
  } catch (error) {
    if (error.message.startsWith('Invalid proxy route')) {
      return res.status(400).json({ success: false, error: { message: error.message } });
    }
    next(error);
  }
});

// Update a custom domain mapping
router.put('/proxy-routes/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const apps = await queries.getAllApps();
    const route = ProxyManager.validateProxyRoute(req.body, { apps });
    const existing = await queries.listProxyRoutes();
    if (existing.some(r => r.host === route.host && r.id !== id)) {
      return res.status(400).json({ success: false, error: { message: 'Domain already exists' } });
    }
    const result = await queries.updateProxyRoute(id, route);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: { message: 'Route not found' } });
    }
    try { await ProxyManager.regenerate(); } catch (e) { console.warn(`[proxy] regenerate failed: ${e.message}`); }
    const row = await queries.getProxyRouteById(id);
    res.json({ success: true, data: row });
  } catch (error) {
    if (error.message.startsWith('Invalid proxy route')) {
      return res.status(400).json({ success: false, error: { message: error.message } });
    }
    next(error);
  }
});

// Delete a custom domain mapping
router.delete('/proxy-routes/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const result = await queries.deleteProxyRoute(id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: { message: 'Route not found' } });
    }
    try { await ProxyManager.regenerate(); } catch (e) { console.warn(`[proxy] regenerate failed: ${e.message}`); }
    res.json({ success: true, data: { message: 'Route deleted' } });
  } catch (error) { next(error); }
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && node --test src/test/integration/proxy-routes-api.test.js`
Expected: PASS（6 项）。

- [ ] **Step 5: 提交**

```bash
git add server/src/routes/index.js server/src/test/integration/proxy-routes-api.test.js
git commit -m "feat(api): add proxy-routes CRUD endpoints"
```

---

### Task 4: 前端页面 + 导航 + i18n

**Files:**
- Create: `client/src/pages/ProxyRoutes.jsx`
- Modify: `client/src/api/apps.js`（追加 4 个 API 函数）
- Modify: `client/src/App.jsx`（加路由）
- Modify: `client/src/pages/Dashboard.jsx`（导航入口，仅 `proxyEnabled` 时显示）
- Modify: `client/src/i18n/locales/en.json`、`client/src/i18n/locales/zh.json`

**Interfaces:**
- Consumes: `GET/POST/PUT/DELETE /api/proxy-routes`（Task 3）；`getAllApps`（已有）；`useAppConfig().proxyEnabled`（已有）。
- Produces: 页面 `/routes` 与 `getProxyRoutes / createProxyRoute / updateProxyRoute / deleteProxyRoute` 导出。

- [ ] **Step 1: 添加 API 函数**

在 `client/src/api/apps.js` 末尾（`clearAppDefault` 之后、`export default api` 之前）追加：

```js
/**
 * Custom domain mappings (reverse-proxy routes).
 */
export const getProxyRoutes = async () => {
  const response = await api.get('/proxy-routes')
  return response.data.data
}

export const createProxyRoute = async (payload) => {
  const response = await api.post('/proxy-routes', payload)
  return response.data.data
}

export const updateProxyRoute = async (id, payload) => {
  const response = await api.put(`/proxy-routes/${id}`, payload)
  return response.data.data
}

export const deleteProxyRoute = async (id) => {
  const response = await api.delete(`/proxy-routes/${id}`)
  return response.data.data
}
```

- [ ] **Step 2: 新建页面**

新建 `client/src/pages/ProxyRoutes.jsx`：

```jsx
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal, Form, Input, Radio, Select, InputNumber, Popconfirm, message } from 'antd'
import { useTranslation } from 'react-i18next'
import EditorialShell from '../components/EditorialShell'
import LanguageSwitcher from '../components/LanguageSwitcher'
import { useAppConfig } from '../context/AppConfigContext'
import { getAllApps, getProxyRoutes, createProxyRoute, updateProxyRoute, deleteProxyRoute } from '../api/apps'

function ProxyRoutes() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const appConfig = useAppConfig()
  const [routes, setRoutes] = useState([])
  const [apps, setApps] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null) // null = closed; {} = create; {..row} = edit
  const [form] = Form.useForm()

  const load = async () => {
    try {
      const [r, a] = await Promise.all([getProxyRoutes(), getAllApps()])
      setRoutes(r)
      setApps(a)
    } catch {
      message.error(t('proxyRoutes.loadError'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openCreate = () => { form.resetFields(); setEditing({}) }
  const openEdit = (row) => {
    setEditing(row)
    form.setFieldsValue({
      host: row.host,
      target_type: row.target_type,
      target_port: row.target_port,
      target_app_id: row.target_app_id
    })
  }

  const submit = async () => {
    const values = await form.validateFields()
    const payload = {
      host: values.host.trim(),
      target_type: values.target_type,
      target_port: values.target_type === 'port' ? values.target_port : null,
      target_app_id: values.target_type === 'app' ? values.target_app_id : null
    }
    try {
      if (editing && editing.id) await updateProxyRoute(editing.id, payload)
      else await createProxyRoute(payload)
      message.success(t(editing && editing.id ? 'proxyRoutes.updated' : 'proxyRoutes.created'))
      setEditing(null)
      await load()
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('proxyRoutes.saveError'))
    }
  }

  const remove = async (id) => {
    try {
      await deleteProxyRoute(id)
      message.success(t('proxyRoutes.deleted'))
      await load()
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('proxyRoutes.deleteError'))
    }
  }

  const right = (
    <>
      <button className="nav-link" onClick={() => navigate('/')}>{t('common.back')}</button>
      <button className="nav-link accent" onClick={openCreate}>+ {t('proxyRoutes.addRoute')}</button>
      <LanguageSwitcher />
    </>
  )

  if (!appConfig?.proxyEnabled) {
    return (
      <EditorialShell right={<LanguageSwitcher />}>
        <div className="empty"><h2>{t('proxyRoutes.disabledTitle')}</h2></div>
      </EditorialShell>
    )
  }

  return (
    <EditorialShell right={right}>
      <div className="lead">{t('proxyRoutes.lead')}</div>
      {loading ? (
        <div className="loading-line">{t('common.loading')}</div>
      ) : routes.length === 0 ? (
        <div className="empty">
          <h2>{t('proxyRoutes.empty')}</h2>
          <p>{t('proxyRoutes.emptyDesc')}</p>
        </div>
      ) : (
        <ul className="app-list">
          {routes.map((r, i) => {
            const target = r.target_type === 'port'
              ? `127.0.0.1:${r.target_port}`
              : (r.target_app_name || `#${r.target_app_id}`)
            const live = r.target_type === 'port' || r.resolved
            return (
              <li className="app-row" key={r.id}>
                <div className="num">{String(i + 1).padStart(2, '0')}</div>
                <div>
                  <div className="name">{r.host}</div>
                  <div className="sub">{t(r.target_type === 'port' ? 'proxyRoutes.targetPort' : 'proxyRoutes.targetApp')}</div>
                </div>
                <div className="port">
                  <span className="lbl">{t('proxyRoutes.target')}</span>
                  <span className="port-chip">{target}</span>
                </div>
                <div className={`status ${live ? 'live' : 'idle'}`}>
                  {live ? t('proxyRoutes.live') : t('proxyRoutes.idle')}
                </div>
                <div className="acts">
                  <button className="act" onClick={() => openEdit(r)}>{t('proxyRoutes.edit')}</button>
                  <Popconfirm title={t('proxyRoutes.deleteTitle')} onConfirm={() => remove(r.id)} okText={t('common.yes')} cancelText={t('common.no')}>
                    <button className="act">{t('common.delete')}</button>
                  </Popconfirm>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <Modal
        title={t(editing && editing.id ? 'proxyRoutes.editTitle' : 'proxyRoutes.addTitle')}
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={submit}
        okText={t('proxyRoutes.save')}
        cancelText={t('common.cancel')}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="host" label={t('proxyRoutes.host')} rules={[
            { required: true, message: t('proxyRoutes.hostRequired') },
            { pattern: /^[\w.-]+$/, message: t('proxyRoutes.hostInvalid') }
          ]}>
            <Input placeholder={t('proxyRoutes.hostPlaceholder')} />
          </Form.Item>
          <Form.Item name="target_type" label={t('proxyRoutes.targetType')} initialValue="port" rules={[{ required: true }]}>
            <Radio.Group>
              <Radio value="port">{t('proxyRoutes.targetPort')}</Radio>
              <Radio value="app">{t('proxyRoutes.targetApp')}</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.target_type !== b.target_type}>
            {({ getFieldValue }) =>
              getFieldValue('target_type') === 'app' ? (
                <Form.Item name="target_app_id" label={t('proxyRoutes.targetApp')} rules={[{ required: true, message: t('proxyRoutes.appRequired') }]}>
                  <Select placeholder={t('proxyRoutes.appPlaceholder')} options={apps.map(a => ({ value: a.id, label: a.name }))} />
                </Form.Item>
              ) : (
                <Form.Item name="target_port" label={t('proxyRoutes.targetPort')} rules={[{ required: true, message: t('proxyRoutes.portRequired') }]}>
                  <InputNumber min={1} max={65535} style={{ width: '100%' }} placeholder="8080" />
                </Form.Item>
              )
            }
          </Form.Item>
        </Form>
      </Modal>
    </EditorialShell>
  )
}

export default ProxyRoutes
```

- [ ] **Step 3: 注册路由**

修改 `client/src/App.jsx`：加 import 与路由项。

```js
import ProxyRoutes from './pages/ProxyRoutes'
```

在 `<Route element={<RequireAuth />}>` 块内、`/apps/:id/metrics` 之后加：

```jsx
<Route path="/routes" element={<ErrorBoundary compact><ProxyRoutes /></ErrorBoundary>} />
```

- [ ] **Step 4: 添加导航入口**

修改 `client/src/pages/Dashboard.jsx`：

顶部加 import：

```js
import { useAppConfig } from '../context/AppConfigContext'
```

组件内加：

```js
const appConfig = useAppConfig()
```

在 `right` 里、`<LanguageSwitcher />` 之前插入：

```jsx
{appConfig?.proxyEnabled && (
  <button className="nav-link" onClick={() => navigate('/routes')}>
    {t('proxyRoutes.title')}
  </button>
)}
```

- [ ] **Step 5: 添加 i18n 文案**

`client/src/i18n/locales/en.json` 顶层新增 `proxyRoutes`（放在 `messages` 之前即可）：

```json
"proxyRoutes": {
  "title": "Domains",
  "lead": "Custom domains → internal port / app",
  "addRoute": "Add mapping",
  "empty": "No domain mappings yet",
  "emptyDesc": "Point an external domain at a port or an app running on this server.",
  "disabledTitle": "Reverse proxy is disabled (set PROXY_ENABLED=true)",
  "host": "Domain",
  "hostPlaceholder": "app.example.com",
  "hostRequired": "Enter a domain",
  "hostInvalid": "Letters, digits, dots and hyphens only",
  "targetType": "Target type",
  "target": "Target",
  "targetPort": "Port",
  "targetApp": "Application",
  "portRequired": "Enter a port (1-65535)",
  "appRequired": "Select an application",
  "appPlaceholder": "Select an application",
  "addTitle": "Add domain mapping",
  "editTitle": "Edit domain mapping",
  "edit": "Edit",
  "save": "Save",
  "deleteTitle": "Delete mapping",
  "live": "Live",
  "idle": "Not running",
  "created": "Mapping created",
  "updated": "Mapping updated",
  "deleted": "Mapping deleted",
  "loadError": "Failed to load mappings",
  "saveError": "Failed to save mapping",
  "deleteError": "Failed to delete mapping"
}
```

`client/src/i18n/locales/zh.json` 顶层新增对应中文 `proxyRoutes`：

```json
"proxyRoutes": {
  "title": "域名映射",
  "lead": "自定义域名 → 内部端口 / 应用",
  "addRoute": "添加映射",
  "empty": "还没有域名映射",
  "emptyDesc": "把外部域名指向本机上的某个端口或应用。",
  "disabledTitle": "反向代理未启用（请设 PROXY_ENABLED=true）",
  "host": "域名",
  "hostPlaceholder": "app.example.com",
  "hostRequired": "请输入域名",
  "hostInvalid": "仅允许字母、数字、点和连字符",
  "targetType": "目标类型",
  "target": "目标",
  "targetPort": "端口",
  "targetApp": "应用",
  "portRequired": "请输入端口（1-65535）",
  "appRequired": "请选择应用",
  "appPlaceholder": "请选择应用",
  "addTitle": "添加域名映射",
  "editTitle": "编辑域名映射",
  "edit": "编辑",
  "save": "保存",
  "deleteTitle": "删除映射",
  "live": "生效中",
  "idle": "未运行",
  "created": "映射已创建",
  "updated": "映射已更新",
  "deleted": "映射已删除",
  "loadError": "加载映射失败",
  "saveError": "保存映射失败",
  "deleteError": "删除映射失败"
}
```

- [ ] **Step 6: 构建 + lint 校验**

Run: `cd client && npm run lint && npm run build`
Expected: 干净通过（无 ESLint 错误、构建成功）。

- [ ] **Step 7: 提交**

```bash
git add client/src/pages/ProxyRoutes.jsx client/src/api/apps.js client/src/App.jsx client/src/pages/Dashboard.jsx client/src/i18n/locales/en.json client/src/i18n/locales/zh.json
git commit -m "feat(ui): add custom domain mapping page"
```

---

### Task 5: 文档与端到端验证

**Files:**
- Modify: `.env.example`（补 PROXY_* 说明，标注自定义域名需 DNS + nginx listen 80）
- Modify: `README.md`、`README.zh-CN.md`（自定义域名用法）
- Modify: `PROGRESS.md`（变更日志）
- Modify: `docs/superpowers/specs/2026-07-18-nginx-reverse-proxy-design.md`（注明 per-app 自定义域名范围决策被新 spec 取代）

- [ ] **Step 1: 更新文档**

`.env.example`：在 `PROXY_*` 段补充一句「自定义域名映射（`/routes` 页面或 `/api/proxy-routes`）同样写入 `PROXY_CONF_FILE`；需自行把域名 DNS 解析到本机，并确保系统 nginx 监听 80 且 include 该 conf 文件」。

`README.md` / `README.zh-CN.md`：在反向代理章节追加「自定义域名 → 端口/应用」用法说明（含 API 端点列表与 `/routes` 页面入口）。

`PROGRESS.md`：追加一条变更日志：新增通用自定义域名映射（`proxy_routes` 表 + CRUD + `/routes` 页面 + 自定义块仅 HTTP）。

`docs/superpowers/specs/2026-07-18-nginx-reverse-proxy-design.md`：在第 7、229 行处加一句「per-app 自定义域名范围决策已被 `2026-08-27-custom-domain-mapping-design.md` 取代」。

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: 全绿（含 proxy-config、proxy-regenerate、proxy-routes-db、proxy-routes-api 等）。

- [ ] **Step 3: 前端校验**

Run: `cd client && npm run lint && npm run build`
Expected: 干净通过。

- [ ] **Step 4: 提交**

```bash
git add .env.example README.md README.zh-CN.md PROGRESS.md docs/superpowers/specs/2026-07-18-nginx-reverse-proxy-design.md
git commit -m "docs: document custom domain mapping"
```

---

## 手动冒烟（测试服务器，实现完成后）

1. `.env` 设 `PROXY_ENABLED=true` + `PROXY_BASE_DOMAIN=<dom>`；确保系统 nginx include `/etc/nginx/conf.d/*.conf` 且监听 80。
2. `curl -X POST .../api/proxy-routes` 增一条 `some.example.com → 127.0.0.1:<port>`。
3. `curl -H 'Host: some.example.com' http://127.0.0.1` 命中目标端口；删掉后不再路由。
4. app 型目标：停用应用后，该映射不再路由（UI 显示「未运行」）。
5. `baseDomain` 缺省时，仅渲染自定义路由块（自动子域名/根域名块跳过）。
