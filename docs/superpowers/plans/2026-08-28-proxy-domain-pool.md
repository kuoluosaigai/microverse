# 域名池（提前录入可用域名）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增「域名池」：管理员可提前录入一批域名，映射应用时 `host` 字段用下拉选择未占用域名（保留手动输入）。

**Architecture:** 新增 `proxy_domains` 表存域名池；`proxy-manager.js` 新增 `validateProxyDomain` 纯校验；`routes/index.js` 新增 `GET/POST/DELETE /api/proxy-domains`（不触发 regenerate）；前端新增 `ProxyDomains` 页面 + 映射表单 `host` 改 `AutoComplete`。

**Tech Stack:** Node.js + Express + sqlite3 + PM2（后端）；React + Vite + Ant Design + i18next（前端）；测试用 `node:test` + `node:assert/strict` + supertest。

**Spec:** `docs/superpowers/specs/2026-08-28-proxy-domain-pool-design.md`

## Global Constraints

- 数据库用 `sqlite3`（**不是** better-sqlite3）；所有 DB 操作异步且 `await`。
- 域名池 CRUD **绝不**调用 `ProxyManager.regenerate()`（池不改变 nginx 配置）。
- `host` 白名单 `^[\w.-]+$`，入库前 `trim().toLowerCase()`。
- `validateProxyDomain` 抛错消息以 `Invalid proxy domain: ` 开头（与 `Invalid proxy route: ` 平行）。
- 错误映射沿用现有约定：非法/重复 → 400，不存在 → 404；`SQLITE_CONSTRAINT` → 400。
- i18n 语言文件是 `client/src/i18n/locales/en.json` 与 `zh.json`（**不是** zh-CN.json）；locale 代码为 `zh`。
- 测试运行方式：根目录 `npm test`（等价 `npm test --workspace=server`）；单文件 `cd server && node --test <file>`。
- 测试 helpers 从 `../helpers/setup` 导入 `init` / `queries` / `request` / `adminAgent`（均已存在）。

---

### Task 1: 数据模型与查询函数

**Files:**
- Modify: `server/src/db/schema.sql`（追加 `proxy_domains` 表 + 索引）
- Modify: `server/src/db/index.js`（`queries` 对象内新增 3 个函数）
- Test: `server/src/test/integration/proxy-domains-db.test.js`（新建）

**Interfaces:**
- Produces: `queries.listProxyDomains()` → `Promise<Array<row>>`；`queries.createProxyDomain({host})` → `Promise<{lastID,changes}>`；`queries.deleteProxyDomain(id)` → `Promise<{changes}>`。row 字段：`id, host, created_at`。后续 Task 2 依赖这些签名。

- [ ] **Step 1: 写失败的测试**

新建 `server/src/test/integration/proxy-domains-db.test.js`：

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { init, queries } = require('../helpers/setup');
const { dbAll } = require('../../db');

test('proxy_domains table exists after init', async () => {
  await init();
  const tables = await dbAll(`SELECT name FROM sqlite_master WHERE type='table' AND name='proxy_domains'`);
  assert.equal(tables.length, 1, 'proxy_domains table present');
});

test('createProxyDomain + listProxyDomains round-trip', async () => {
  await init();
  const r = await queries.createProxyDomain({ host: 'a.example.com' });
  const rows = await queries.listProxyDomains();
  const row = rows.find(x => x.id === r.lastID);
  assert.ok(row);
  assert.equal(row.host, 'a.example.com');
  await queries.deleteProxyDomain(r.lastID);
});

test('deleteProxyDomain removes the row', async () => {
  await init();
  const r = await queries.createProxyDomain({ host: 'gone.example.com' });
  await queries.deleteProxyDomain(r.lastID);
  const rows = await queries.listProxyDomains();
  assert.ok(!rows.some(x => x.id === r.lastID), 'row removed');
});

test('duplicate host violates UNIQUE', async () => {
  await init();
  const r = await queries.createProxyDomain({ host: 'dup.example.com' });
  await assert.rejects(
    () => queries.createProxyDomain({ host: 'dup.example.com' }),
    /UNIQUE constraint failed/i
  );
  await queries.deleteProxyDomain(r.lastID);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && node --test src/test/integration/proxy-domains-db.test.js`
Expected: FAIL — `proxy_domains` 表不存在 / `queries.listProxyDomains` is not a function。

- [ ] **Step 3: 实现 schema 与查询**

在 `server/src/db/schema.sql` 末尾（`proxy_routes` 表与索引之后）追加：

```sql
-- Domain pool: pre-registered custom domains the admin can pick from when
-- creating a proxy_routes mapping. Purely a candidate list — only proxy_routes
-- (not this table) affects the rendered nginx config.
CREATE TABLE IF NOT EXISTS proxy_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_proxy_domains_host ON proxy_domains(host);
```

在 `server/src/db/index.js` 的 `queries` 对象内、`// User queries (admin auth)` 之前插入：

```js
  // Proxy domain queries (pre-registered domain pool for custom-domain mapping)
  listProxyDomains: () => dbAll('SELECT * FROM proxy_domains ORDER BY id'),

  createProxyDomain: (params) => dbRun(
    'INSERT INTO proxy_domains (host) VALUES (?)',
    [params.host]
  ),

  deleteProxyDomain: (id) => dbRun('DELETE FROM proxy_domains WHERE id = ?', [id]),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && node --test src/test/integration/proxy-domains-db.test.js`
Expected: PASS（4 项）。

- [ ] **Step 5: 提交**

```bash
git add server/src/db/schema.sql server/src/db/index.js server/src/test/integration/proxy-domains-db.test.js
git commit -m "feat(db): add proxy_domains table and queries for domain pool"
```

---

### Task 2: 校验 + CRUD API 端点

**Files:**
- Modify: `server/src/services/proxy-manager.js`（新增 `validateProxyDomain` + 导出）
- Modify: `server/src/routes/index.js`（新增 3 个端点）
- Modify: `server/src/test/unit/proxy-config.test.js`（追加 `validateProxyDomain` 用例）
- Test: `server/src/test/integration/proxy-domains-api.test.js`（新建）

**Interfaces:**
- Consumes: `queries.listProxyDomains / createProxyDomain / deleteProxyDomain`（Task 1）。
- Produces: `ProxyManager.validateProxyDomain(input)` → `{host}` 或抛错；`GET /api/proxy-domains`、`POST /api/proxy-domains`、`DELETE /api/proxy-domains/:id`。Task 3/4 前端依赖这些。

- [ ] **Step 1: 写失败的测试**

在 `server/src/test/unit/proxy-config.test.js` 顶部 require 增加 `validateProxyDomain`：

```js
const { renderProxyConfig, validateBaseDomain, resolveBaseDomain, validateProxyRoute, validateProxyDomain } = require('../../services/proxy-manager');
```

在文件末尾追加：

```js
test('validateProxyDomain normalizes and lowercases a valid host', () => {
  assert.deepEqual(validateProxyDomain({ host: 'A.Example.COM' }), { host: 'a.example.com' });
});

test('validateProxyDomain rejects invalid host', () => {
  assert.throws(() => validateProxyDomain({ host: 'bad host' }), /Invalid proxy domain/);
  assert.throws(() => validateProxyDomain({ host: '' }), /Invalid proxy domain/);
  assert.throws(() => validateProxyDomain({ host: 'a b;c' }), /Invalid proxy domain/);
});
```

新建 `server/src/test/integration/proxy-domains-api.test.js`：

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request, adminAgent } = require('../helpers/setup');
const ProxyManager = require('../../services/proxy-manager');

test('proxy-domains endpoints require auth', async () => {
  const r = await request().get('/api/proxy-domains');
  assert.equal(r.status, 401);
  const p = await request().post('/api/proxy-domains').send({ host: 'x.example.com' });
  assert.equal(p.status, 401);
});

test('POST creates a domain and does NOT regenerate', async () => {
  const agent = await adminAgent();
  const orig = ProxyManager.regenerate;
  let called = false;
  ProxyManager.regenerate = async () => { called = true; return { ok: true }; };
  try {
    const r = await agent.post('/api/proxy-domains').send({ host: 'A.Example.COM' });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.host, 'a.example.com');
    assert.ok(r.body.data.id);
    assert.equal(called, false);
  } finally {
    ProxyManager.regenerate = orig;
  }
});

test('POST rejects duplicate host (case-insensitive) and invalid host', async () => {
  const agent = await adminAgent();
  await agent.post('/api/proxy-domains').send({ host: 'dup.example.com' });
  const dup = await agent.post('/api/proxy-domains').send({ host: 'DUP.EXAMPLE.COM' });
  assert.equal(dup.status, 400);
  const bad = await agent.post('/api/proxy-domains').send({ host: 'bad host' });
  assert.equal(bad.status, 400);
});

test('GET lists domains', async () => {
  const agent = await adminAgent();
  await agent.post('/api/proxy-domains').send({ host: 'list.example.com' });
  const r = await agent.get('/api/proxy-domains');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
  assert.ok(r.body.data.some(x => x.host === 'list.example.com'));
});

test('DELETE removes a domain and does NOT regenerate; missing -> 404', async () => {
  const agent = await adminAgent();
  const created = await agent.post('/api/proxy-domains').send({ host: 'del.example.com' });
  const id = created.body.data.id;

  const orig = ProxyManager.regenerate;
  let called = false;
  ProxyManager.regenerate = async () => { called = true; return { ok: true }; };
  try {
    const del = await agent.delete(`/api/proxy-domains/${id}`);
    assert.equal(del.status, 200);
    assert.equal(called, false);
  } finally {
    ProxyManager.regenerate = orig;
  }

  const missing = await agent.delete('/api/proxy-domains/999999');
  assert.equal(missing.status, 404);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && node --test src/test/unit/proxy-config.test.js`
Expected: FAIL — `validateProxyDomain is not a function`。

Run: `cd server && node --test src/test/integration/proxy-domains-api.test.js`
Expected: FAIL — 404（端点未注册）。

- [ ] **Step 3: 实现校验与端点**

在 `server/src/services/proxy-manager.js` 的 `validateProxyRoute` 函数之后新增：

```js
/**
 * Validate + normalize a proxy-domain (domain-pool) input. Returns { host } or
 * throws a descriptive Error (prefix "Invalid proxy domain: " so routes can map
 * it to a 400).
 * @param {{host?:string}} input
 */
function validateProxyDomain(input = {}) {
  const host = String(input.host || '').trim().toLowerCase();
  if (!/^[\w.-]+$/.test(host)) {
    throw new Error('Invalid proxy domain: host must be a valid domain (letters, digits, dots, hyphens)');
  }
  return { host };
}
```

`module.exports` 改为：

```js
module.exports = { renderProxyConfig, validateBaseDomain, resolveBaseDomain, validateProxyRoute, validateProxyDomain, regenerate };
```

在 `server/src/routes/index.js` 中，`DELETE /proxy-routes/:id` 路由之后、`GET /auth/me` 之前插入：

```js
// List pre-registered domains (domain pool for custom-domain mapping)
router.get('/proxy-domains', async (req, res, next) => {
  try {
    const rows = await queries.listProxyDomains();
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});

// Add a domain to the pool (does NOT touch nginx — pool is a candidate list only)
router.post('/proxy-domains', async (req, res, next) => {
  try {
    const domain = ProxyManager.validateProxyDomain(req.body);
    const existing = await queries.listProxyDomains();
    if (existing.some(d => d.host === domain.host)) {
      return res.status(400).json({ success: false, error: { message: 'Domain already exists' } });
    }
    const result = await queries.createProxyDomain(domain);
    res.status(201).json({ success: true, data: { id: result.lastID, host: domain.host } });
  } catch (error) {
    if (error.message.startsWith('Invalid proxy domain')) {
      return res.status(400).json({ success: false, error: { message: error.message } });
    }
    if (error.code === 'SQLITE_CONSTRAINT') {
      return res.status(400).json({ success: false, error: { message: 'Domain already exists' } });
    }
    next(error);
  }
});

// Remove a domain from the pool
router.delete('/proxy-domains/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const result = await queries.deleteProxyDomain(id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: { message: 'Domain not found' } });
    }
    res.json({ success: true, data: { message: 'Domain deleted' } });
  } catch (error) { next(error); }
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && node --test src/test/unit/proxy-config.test.js`
Expected: PASS（含既有 + 新增）。

Run: `cd server && node --test src/test/integration/proxy-domains-api.test.js`
Expected: PASS（5 项）。

- [ ] **Step 5: 提交**

```bash
git add server/src/services/proxy-manager.js server/src/routes/index.js server/src/test/unit/proxy-config.test.js server/src/test/integration/proxy-domains-api.test.js
git commit -m "feat(api): add proxy-domains CRUD endpoints"
```

---

### Task 3: 前端域名池页面 + 导航 + i18n

**Files:**
- Modify: `client/src/api/apps.js`（追加 3 个 API 函数）
- Create: `client/src/pages/ProxyDomains.jsx`
- Modify: `client/src/App.jsx`（加路由 + import）
- Modify: `client/src/pages/Dashboard.jsx`（导航入口）
- Modify: `client/src/i18n/locales/en.json`、`client/src/i18n/locales/zh.json`

**Interfaces:**
- Consumes: `GET/POST/DELETE /api/proxy-domains`（Task 2）；`useAppConfig().proxyEnabled`（已有）。
- Produces: 页面 `/domains` 与 `getProxyDomains / createProxyDomain / deleteProxyDomain` 导出。Task 4 依赖 `getProxyDomains`。

- [ ] **Step 1: 添加 API 函数**

在 `client/src/api/apps.js` 末尾（`deleteProxyRoute` 之后、`export default api` 之前）追加：

```js
/**
 * Domain pool (pre-registered custom domains for mapping).
 */
export const getProxyDomains = async () => {
  const response = await api.get('/proxy-domains')
  return response.data.data
}

export const createProxyDomain = async (host) => {
  const response = await api.post('/proxy-domains', { host })
  return response.data.data
}

export const deleteProxyDomain = async (id) => {
  const response = await api.delete(`/proxy-domains/${id}`)
  return response.data.data
}
```

- [ ] **Step 2: 新建页面**

新建 `client/src/pages/ProxyDomains.jsx`：

```jsx
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Form, Input, Popconfirm, message } from 'antd'
import { useTranslation } from 'react-i18next'
import EditorialShell from '../components/EditorialShell'
import LanguageSwitcher from '../components/LanguageSwitcher'
import { useAppConfig } from '../context/AppConfigContext'
import { getProxyDomains, createProxyDomain, deleteProxyDomain } from '../api/apps'

function ProxyDomains() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const appConfig = useAppConfig()
  const [domains, setDomains] = useState([])
  const [loading, setLoading] = useState(true)
  const [form] = Form.useForm()

  const load = async () => {
    try {
      setDomains(await getProxyDomains())
    } catch {
      message.error(t('proxyDomains.loadError'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const add = async () => {
    const values = await form.validateFields()
    try {
      await createProxyDomain(values.host.trim())
      message.success(t('proxyDomains.created'))
      form.resetFields()
      await load()
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('proxyDomains.saveError'))
    }
  }

  const remove = async (id) => {
    try {
      await deleteProxyDomain(id)
      message.success(t('proxyDomains.deleted'))
      await load()
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('proxyDomains.deleteError'))
    }
  }

  const right = (
    <>
      <button className="nav-link" onClick={() => navigate('/routes')}>{t('proxyRoutes.title')}</button>
      <button className="nav-link" onClick={() => navigate('/')}>{t('common.back')}</button>
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
      <div className="lead">{t('proxyDomains.lead')}</div>

      <Form form={form} layout="inline" className="domain-add">
        <Form.Item name="host" rules={[
          { required: true, message: t('proxyDomains.hostRequired') },
          { pattern: /^[\w.-]+$/, message: t('proxyDomains.hostInvalid') }
        ]}>
          <Input placeholder={t('proxyDomains.hostPlaceholder')} style={{ width: 260 }} onPressEnter={add} />
        </Form.Item>
        <button type="button" className="nav-link accent" onClick={add}>+ {t('proxyDomains.add')}</button>
      </Form>

      {loading ? (
        <div className="loading-line">{t('common.loading')}</div>
      ) : domains.length === 0 ? (
        <div className="empty">
          <h2>{t('proxyDomains.empty')}</h2>
          <p>{t('proxyDomains.emptyDesc')}</p>
        </div>
      ) : (
        <ul className="app-list">
          {domains.map((d, i) => (
            <li className="app-row" key={d.id}>
              <div className="num">{String(i + 1).padStart(2, '0')}</div>
              <div className="name">{d.host}</div>
              <div className="acts">
                <Popconfirm title={t('proxyDomains.deleteTitle')} onConfirm={() => remove(d.id)} okText={t('common.yes')} cancelText={t('common.no')}>
                  <button className="act">{t('common.delete')}</button>
                </Popconfirm>
              </div>
            </li>
          ))}
        </ul>
      )}
    </EditorialShell>
  )
}

export default ProxyDomains
```

- [ ] **Step 3: 注册路由**

修改 `client/src/App.jsx`：加 import：

```js
import ProxyDomains from './pages/ProxyDomains'
```

在 `<Route element={<RequireAuth />}>` 块内、`/routes` 之后加：

```jsx
<Route path="/domains" element={<ErrorBoundary compact><ProxyDomains /></ErrorBoundary>} />
```

- [ ] **Step 4: 添加导航入口**

修改 `client/src/pages/Dashboard.jsx`：在 `right` 里、现有 `proxyEnabled && navigate('/routes')` 按钮之后、`<LanguageSwitcher />` 之前插入：

```jsx
{appConfig?.proxyEnabled && (
  <button className="nav-link" onClick={() => navigate('/domains')}>
    {t('proxyDomains.title')}
  </button>
)}
```

- [ ] **Step 5: 添加 i18n 文案**

`client/src/i18n/locales/en.json` 顶层新增 `proxyDomains`（放在 `proxyRoutes` 之后即可）：

```json
"proxyDomains": {
  "title": "Domain Pool",
  "lead": "Pre-registered domains available for mapping",
  "add": "Add domain",
  "host": "Domain",
  "hostPlaceholder": "app.example.com",
  "hostRequired": "Enter a domain",
  "hostInvalid": "Letters, digits, dots and hyphens only",
  "empty": "No domains in the pool yet",
  "emptyDesc": "Pre-register domains here, then pick them from the dropdown when creating a mapping.",
  "deleteTitle": "Remove domain",
  "created": "Domain added",
  "deleted": "Domain removed",
  "loadError": "Failed to load domains",
  "saveError": "Failed to add domain",
  "deleteError": "Failed to remove domain"
}
```

`client/src/i18n/locales/zh.json` 顶层新增对应中文 `proxyDomains`：

```json
"proxyDomains": {
  "title": "域名池",
  "lead": "提前录入、可供映射选择的域名",
  "add": "添加域名",
  "host": "域名",
  "hostPlaceholder": "app.example.com",
  "hostRequired": "请输入域名",
  "hostInvalid": "仅允许字母、数字、点和连字符",
  "empty": "域名池还是空的",
  "emptyDesc": "在这里提前录入域名，创建映射时即可从下拉列表中选择。",
  "deleteTitle": "移除域名",
  "created": "域名已添加",
  "deleted": "域名已移除",
  "loadError": "加载域名失败",
  "saveError": "添加域名失败",
  "deleteError": "移除域名失败"
}
```

- [ ] **Step 6: 构建 + lint 校验**

Run: `cd client && npm run lint && npm run build`
Expected: 干净通过。

- [ ] **Step 7: 提交**

```bash
git add client/src/api/apps.js client/src/pages/ProxyDomains.jsx client/src/App.jsx client/src/pages/Dashboard.jsx client/src/i18n/locales/en.json client/src/i18n/locales/zh.json
git commit -m "feat(ui): add domain pool page"
```

---

### Task 4: 映射表单下拉选择（AutoComplete）+ i18n

**Files:**
- Modify: `client/src/pages/ProxyRoutes.jsx`（`host` 字段 `<Input>` → `<AutoComplete>`；`load` 一并拉取域名池）
- Modify: `client/src/i18n/locales/en.json`、`client/src/i18n/locales/zh.json`（`proxyRoutes.hostAutoPlaceholder`）

**Interfaces:**
- Consumes: `getProxyDomains`（Task 3）；已有 `getProxyRoutes` / `getAllApps`。
- Produces: 映射表单 `host` 字段下拉可选池内未占用域名，仍可手动输入。

- [ ] **Step 1: 改表单**

修改 `client/src/pages/ProxyRoutes.jsx`：

顶部 import：把 `Input` 替换为 `AutoComplete`（保留其它）：

```js
import { Modal, Form, AutoComplete, Radio, Select, InputNumber, Popconfirm, message } from 'antd'
```

从 API 追加 `getProxyDomains`：

```js
import { getAllApps, getProxyRoutes, createProxyRoute, updateProxyRoute, deleteProxyRoute, getProxyDomains } from '../api/apps'
```

组件内新增 state 与 load 逻辑：新增 `const [domains, setDomains] = useState([])`；把 `load` 改为：

```js
  const load = async () => {
    try {
      const [r, a, d] = await Promise.all([getProxyRoutes(), getAllApps(), getProxyDomains()])
      setRoutes(r)
      setApps(a)
      setDomains(d)
    } catch {
      message.error(t('proxyRoutes.loadError'))
    } finally {
      setLoading(false)
    }
  }
```

在 `submit` 定义之后、`remove` 定义之前新增可用域名计算：

```js
  // Pool domains not already claimed by a mapping (the row being edited keeps its
  // own host so it stays selectable while editing). Available = pool − mapped.
  const availableDomains = domains
    .filter(d => !routes.some(r => r.host === d.host && r.id !== (editing && editing.id)))
    .map(d => ({ value: d.host }))
```

把表单里的 `host` `Form.Item` 内容由：

```jsx
<Input placeholder={t('proxyRoutes.hostPlaceholder')} />
```

替换为：

```jsx
<AutoComplete
  options={availableDomains}
  placeholder={t('proxyRoutes.hostAutoPlaceholder')}
  allowClear
  filterOption={(input, option) => (option.value || '').includes(input)}
/>
```

- [ ] **Step 2: 添加 i18n**

`en.json` 的 `proxyRoutes` 块内、`hostPlaceholder` 之后加：

```json
"hostAutoPlaceholder": "Pick a domain or type one (app.example.com)",
```

`zh.json` 的 `proxyRoutes` 块内、`hostPlaceholder` 之后加：

```json
"hostAutoPlaceholder": "从域名池选择或手动输入（app.example.com）",
```

- [ ] **Step 3: 构建 + lint 校验**

Run: `cd client && npm run lint && npm run build`
Expected: 干净通过。

- [ ] **Step 4: 提交**

```bash
git add client/src/pages/ProxyRoutes.jsx client/src/i18n/locales/en.json client/src/i18n/locales/zh.json
git commit -m "feat(ui): domain pool dropdown in mapping form"
```

---

## 端到端验证（全部任务完成后）

- `npm test`（根）→ 全绿（含新增 proxy-domains-db / proxy-domains-api / proxy-config 用例）。
- `cd client && npm run lint && npm run build` → 干净。

## 手动冒烟（测试服务器，实现完成后）

1. `.env` 设 `PROXY_ENABLED=true`。
2. 在「域名池」页面录入 `foo.example.com`、`bar.example.com`。
3. 打开「域名映射」→ 添加映射 → `host` 下拉应列出 `foo.example.com`、`bar.example.com`，也可手动输入任意其它域名。
4. 把 `foo.example.com` 映射到某端口后，再次添加映射时 `foo.example.com` 不再出现在下拉里，`bar.example.com` 仍在。
