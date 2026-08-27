# 域名池（提前录入可用域名）— 设计文档

- **日期**: 2026-08-28
- **状态**: Approved (design)
- **范围**: 在现有「自定义域名映射」（`proxy_routes`）之上，新增一个「域名池」能力：管理员可提前录入一批自己拥有的域名；在创建/编辑映射时，`host` 字段从纯文本框改为下拉可选（列出池内**未被占用**的域名），并**保留手动输入**任意域名。
- **依赖**: `docs/superpowers/specs/2026-08-27-custom-domain-mapping-design.md`（自定义域名映射）。
- **不在范围（v1）**: 域名池与自动子域名 `<app>.<baseDomain>` / 根域名默认应用的冲突检测；通配符域名；HTTPS 证书。

## 背景

自定义域名映射已上线：管理员在 `ProxyRoutes` 页面手动输入 `host` → 端口 / 应用。用户提出：既然能做域名映射，为何不额外支持「提前录入域名」——把已有域名先存起来，映射时通过下拉列表挑选可用的，避免每次手打、也避免记错域名；同时仍保留手动输入以支持临时域名。

## 关键决策（brainstorm 已确认）

1. **域名池存储 = UI 自服务管理。** 新建 `proxy_domains` 表 + 一个管理页面（增/删），全部在 Web UI 里操作，不改 `.env`、不重启。否决「环境变量预置」与「两者都要」。
2. **域名池只是候选清单，不影响 nginx 渲染。** 只有 `proxy_routes` 会进入 `PROXY_CONF_FILE`；池内域名未被映射时无任何反代效果。
3. **「可用」= 在池内且未被任何 `proxy_route` 占用。** 映射表单的下拉列出池内未占用的域名；编辑某条映射时额外保留该条当前 `host`。占用后域名仍留在池中（是清单，不是队列）；删除映射后域名自动恢复「可用」。
4. **映射表单用 `AutoComplete`。** 单一控件同时满足「下拉选择 + 自由输入」，沿用现有 `host` 校验（`^[\w.-]+$`）。
5. **域名池 CRUD 不触发 `regenerate()`。** 池变更不改变 nginx 配置。

## 架构

### 1. 数据模型（`server/src/db/schema.sql`）

新增表（`CREATE TABLE IF NOT EXISTS`，启动重跑 schema 即建好，无需列迁移）：

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

- `host` 用与 `proxy_routes.host` / `baseDomain` 相同的白名单 `^[\w.-]+$` 校验，`trim().toLowerCase()` 后入库。
- `UNIQUE` 约束保证池内域名不重复；与 `proxy_routes` 表独立，不设外键。

### 2. 查询函数（`server/src/db/index.js`）

新增（async，风格同现有 `queries`）：
- `listProxyDomains()` → `SELECT * FROM proxy_domains ORDER BY id`
- `createProxyDomain({ host })` → `INSERT INTO proxy_domains (host) VALUES (?)`
- `deleteProxyDomain(id)` → `DELETE FROM proxy_domains WHERE id = ?`

（无 update——池内域名就是个字符串，改 = 删 + 加；无 getById——POST 直接回 `{ id: lastID, host }`。）

### 3. `ProxyManager` 扩展（`server/src/services/proxy-manager.js`）

新增纯校验函数（导出，单测友好）：

```js
function validateProxyDomain(input = {}) {
  const host = String(input.host || '').trim().toLowerCase();
  if (!/^[\w.-]+$/.test(host)) {
    throw new Error('Invalid proxy domain: host must be a valid domain (letters, digits, dots, hyphens)');
  }
  return { host };
}
```

错误前缀 `Invalid proxy domain: `（与 `Invalid proxy route: ` 平行），便于路由映射为 400。

### 4. API（`server/src/routes/index.js`，受 `requireAuth` + `apiLimiter`）

- `GET /api/proxy-domains` → `{ success:true, data:[ ...rows ] }`
- `POST /api/proxy-domains` → 校验 → 重复 → 400「域名已存在」→ `createProxyDomain` → 201 返回 `{ id, host }`。**不**调 `regenerate()`。
- `DELETE /api/proxy-domains/:id` → 删除，`changes===0` → 404。**不**调 `regenerate()`。

错误映射：host 非法 → 400；重复 → 400（含「已存在」）；不存在 → 404。

### 5. 前端 UI

- 新页面 `client/src/pages/ProxyDomains.jsx`，路由 `/domains`（`App.jsx`）；入口在 `Dashboard.jsx` 导航「域名池」按钮，**仅 `appConfig.proxyEnabled` 时显示**（与「域名映射」并排）。页面 = 域名列表 + 添加输入 + 删除 Popconfirm，复用 `EditorialShell` 布局。
- 映射表单（`ProxyRoutes.jsx`）：`host` 字段 `<Input>` → `<AutoComplete>`，`options` = 池内域名里未被占用者（编辑时额外包含当前行 host），仍自由输入 + 原有 `pattern` 校验。可用性计算在前端完成：`domains.filter(d => !routes.some(r => r.host === d.host && r.id !== editingId))`。
- API 函数（`client/src/api/apps.js`）：`getProxyDomains` / `createProxyDomain` / `deleteProxyDomain`。
- i18n：`client/src/i18n/locales/{en,zh}.json` 新增 `proxyDomains` 块 + `proxyRoutes.hostAutoPlaceholder`。

## 错误处理 / 边界

- 重复 host：DB `UNIQUE` + 路由层双重拦截，`SQLITE_CONSTRAINT` 映射为 400（沿用 proxy-routes 的 race backstop）。
- host 大小写归一后再判重。
- 域名池为空时，映射表单退化为纯输入框（AutoComplete 无选项仍可自由输入）。
- 域名池完全独立于 nginx：增删池内域名不 reload、不触碰 conf 文件。

## 测试

**后端单元**（`server/src/test/unit/proxy-config.test.js` 追加）：
- `validateProxyDomain` 合法输入返回 `{ host }`（小写化）；非法 host 抛 `Invalid proxy domain`。

**后端集成**：
- `server/src/test/integration/proxy-domains-db.test.js`（新建）：表存在；create + list 往返；重复 host 违反 UNIQUE。
- `server/src/test/integration/proxy-domains-api.test.js`（新建）：未登录 401；POST 成功 201；重复 400；非法 host 400；DELETE 200；DELETE 不存在 404；POST/DELETE **不**调用 `regenerate`（mock 断言 called=false）。

## 改动面 checklist

**后端**
- MOD `server/src/db/schema.sql` — 新增 `proxy_domains` 表 + 索引
- MOD `server/src/db/index.js` — `listProxyDomains` / `createProxyDomain` / `deleteProxyDomain`
- MOD `server/src/services/proxy-manager.js` — 新增 `validateProxyDomain` 导出
- MOD `server/src/routes/index.js` — `GET/POST /api/proxy-domains` + `DELETE /api/proxy-domains/:id`

**前端**
- NEW `client/src/pages/ProxyDomains.jsx` + 路由 `App.jsx` + `Dashboard.jsx` 导航入口
- MOD `client/src/api/apps.js` — 3 个 API 函数
- MOD `client/src/pages/ProxyRoutes.jsx` — `host` 字段改 `AutoComplete`
- MOD `client/src/i18n/locales/{en,zh}.json`

**测试**
- MOD `server/src/test/unit/proxy-config.test.js`
- NEW `server/src/test/integration/proxy-domains-db.test.js`
- NEW `server/src/test/integration/proxy-domains-api.test.js`

**验证**
- `npm test`（根）→ 全绿
- `cd client && npm run lint && npm run build` → 干净
