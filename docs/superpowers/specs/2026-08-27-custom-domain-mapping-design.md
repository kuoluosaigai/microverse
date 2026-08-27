# 通用自定义域名映射 — 设计文档

- **日期**: 2026-08-27
- **状态**: Approved (design)
- **范围**: 把「任意外部域名 → 内部端口 / 内部应用」做成通用能力。外部多个域名解析到本机 IP 后，nginx 边缘反代按 `Host` 头把 80 端口流量路由到内部任意端口的 web 服务（不限于 Microverse 应用）。管理面为 Web UI + 数据库；自定义域名 v1 仅 HTTP。
- **取代**: `docs/superpowers/specs/2026-07-18-nginx-reverse-proxy-design.md` 第 7、229 行「不支持 per-app 自定义域名（沿用全局 `{name}` 模板）」的范围决策。本设计在**保留**现有自动子域名（`<name>.<base>`）与根域名默认应用能力的基础上，**新增**显式的自定义域名映射表。
- **不在范围（v1）**: 自定义域名的 HTTPS / 证书签发（仅 HTTP，`listen 80`）；通配符域名（`*.example.com`）；非本机的上游（目标固定 `127.0.0.1`）；多用户。

## 背景

用户已把域名部署能力跑通（自动子域名 + 根域名默认应用），现在希望把「域名映射」从「按应用名自动推导子域名」推广为「任意域名 → 任意端口」的通用反代映射：外部多个域名指向同一台服务器，nginx 按 `Host` 路由到内部不同端口的 web 服务（可能是 Microverse 应用，也可能是机器上的 docker / python / 其它 nginx 等任意服务）。

当前实现（已逐条核对源码）：

- `server/src/services/proxy-manager.js`：`renderProxyConfig(apps, opts)` 为每个 running 应用渲染 `server_name <name>.<baseDomain>` → `127.0.0.1:<port>`，为 `is_default` 应用额外渲染根域名块；`regenerate()` 读 `getAllApps()` → 渲染 → 写 `PROXY_CONF_FILE` → `nginx -t` → `-s reload`，失败回滚、绝不抛。
- `server/src/db/schema.sql`：`apps` 表无自定义域名字段。
- `server/src/routes/index.js`：`PUT/DELETE /api/apps/:id/default` 直调 `queries` + `ProxyManager.regenerate()`；`GET /api/config` 下发 `proxyEnabled` / `proxyBaseDomain`。
- 前端：`client/src/pages/Dashboard.jsx` 主列表；`client/src/components/AppRow.jsx` 里「设为根域名默认应用」开关；`client/src/components/EditorialShell.jsx` 顶栏 `right` 传导航按钮（无全局菜单）；路由在 `client/src/App.jsx`。

## 关键决策（brainstorm 已确认）

1. **目标形式 = 端口 + 应用名两者。** 每条映射既可指向裸端口（`127.0.0.1:<port>`，任意 web 服务），也可指向某个 Microverse 应用（自动跟随其已分配端口）。
2. **管理面 = Web UI + 数据库。** 新增 `proxy_routes` 表 + CRUD API + 前端页面，改动即时 `nginx -t` + reload。
3. **HTTPS = v1 仅 HTTP。** 自定义域名只出 `listen 80` 块，不套用全局 `PROXY_SSL_*`（证书 per 域名，涉及 certbot，后续再说）。
4. **路线 A：扩展现有 `ProxyManager`。** 自定义域名只是更多 server 块，与自动子域名同写一个 `PROXY_CONF_FILE`，复用现有 render/`nginx -t`/reload/回滚/生命周期钩子。否决「独立 conf + 独立 manager」（两套 reload 纯重复）与「配置文件无 UI」（与管理面决策矛盾）。
5. **渲染优先级：自定义路由块在前。** nginx `server_name` 精确匹配按配置文件顺序先到先得，故自定义（显式配置）块排在自动子域名与根域名默认块之前，冲突时显式配置胜出。
6. **`baseDomain` 变为可选。** 自定义域名不依赖 `baseDomain`；缺失时只跳过自动子域名 + 根域名块，自定义块照常渲染。

## 架构

### 1. 数据模型（`server/src/db/schema.sql`）

新增表（`CREATE TABLE IF NOT EXISTS`，每次启动重跑 schema 即建好，**无需列迁移**）：

```sql
CREATE TABLE IF NOT EXISTS proxy_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL UNIQUE,                    -- 外部域名，如 a.example.com
  target_type TEXT NOT NULL CHECK(target_type IN ('port','app')),
  target_port INTEGER,                          -- target_type='port' 时必填
  target_app_id INTEGER,                        -- target_type='app' 时必填
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (target_app_id) REFERENCES apps(id) ON DELETE CASCADE,
  CHECK (
    (target_type='port' AND target_port IS NOT NULL) OR
    (target_type='app'  AND target_app_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_proxy_routes_host ON proxy_routes(host);
```

- `host` 用与 `baseDomain` 相同的白名单正则 `[\w.-]+` 校验（小写化后存），只允许合法域名；不允许通配符 / 路径 / scheme / 端口号。
- `target_type='app'` 通过 `target_app_id` 关联；删除应用时 `ON DELETE CASCADE` 自动清掉指向它的路由（`deleteApp` 已调用 `regenerate()`，无需额外钩子）。

### 2. 查询函数（`server/src/db/index.js`）

新增（全部 async，风格同现有 `queries`）：
- `listProxyRoutes()` → `SELECT * FROM proxy_routes ORDER BY id`（或按 host 排序）。
- `getProxyRouteById(id)` → 单行。
- `createProxyRoute({ host, target_type, target_port, target_app_id })`。
- `updateProxyRoute(id, { host, target_type, target_port, target_app_id })`（COALESCE 风格，仅更新提供的字段；注意 target 二选一语义见校验层）。
- `deleteProxyRoute(id)`。

### 3. `ProxyManager` 扩展（`server/src/services/proxy-manager.js`）

**纯渲染函数签名**：`renderProxyConfig(apps, routes, opts)`（新增 `routes` 入参）。

- `opts.baseDomain` 允许为空串：为空时跳过自动子域名 + 根域名块；`validateBaseDomain` 仅在 `baseDomain` 非空时调用。
- 渲染顺序：
  1. **自定义路由块（最前）**：遍历 `routes`
     - `target_type='port'`：`target_port` 取整校验 1–65535 → `renderServerBlock(host, port, null)`（`ssl=null` 强制仅 HTTP）。
     - `target_type='app'`：按 `target_app_id` 在 `apps` 里查，`status==='running' && port>0` 才出块，否则跳过（与自动子域名「停用即摘除」一致）。
  2. 自动子域名块（现有逻辑不变，按 name 排序）。
  3. 根域名默认应用块（现有逻辑不变）。
- `renderServerBlock(host, port, ssl)` 已存在；`ssl` 为 `null` 时仅渲染 `listen 80;` 单块（现有 HTTP-only 分支即可复用）。

**纯校验函数**（新增导出，单测友好）：`validateProxyRoute(input, { apps, existingHosts })`，返回规范化后的 `{ host, target_type, target_port, target_app_id }` 或抛描述性错误：
- `host`：非空、匹配 `[\w.-]+`、小写化；重复（含大小写不同）→ 抛「域名已存在」。
- `target_type`：必须是 `'port'` 或 `'app'`。
- `target_type='port'`：`target_port` 为 1–65535 整数，`target_app_id` 必须为空。
- `target_type='app'`：`target_app_id` 必须指向存在的应用，`target_port` 必须为空。

**`regenerate()`**：改读 `queries.getAllApps()` + `queries.listProxyRoutes()`，其余（`nginx -t` → reload → 回滚）不变。`baseDomain` 缺失但存在自定义路由时不再提前返回，正常渲染。

### 4. API（`server/src/routes/index.js`，受 `requireAuth` + `apiLimiter`）

- `GET /api/proxy-routes` → `{ success:true, data:[ ...routes ] }`，每条附 `target_app_name`（`target_type='app'` 时解析应用名）与 `resolved`（是否生效：port 型恒 true；app 型 = 该应用 running && 有 port），便于 UI 展示。
- `POST /api/proxy-routes` → 校验 → `createProxyRoute` → `ProxyManager.regenerate()`（try/catch，失败仅 warn）→ 201 返回新行。
- `PUT /api/proxy-routes/:id` → 校验 → `updateProxyRoute` → `regenerate()` → 返回更新行。
- `DELETE /api/proxy-routes/:id` → `deleteProxyRoute` → `regenerate()` → 200。

错误映射：host 非法 / target 非法 / app 不存在 → 400；重复 host → 400（消息含「已存在」）；路由不存在 → 404。`regenerate()` 失败沿用现有约定：CRUD 仍成功，映射已保存但未生效，记 `console.warn`（见「已知限制」）。

### 5. 前端 UI

- 新页面 `client/src/pages/ProxyRoutes.jsx`，路由 `client/src/App.jsx` 加 `<Route path="/routes" ...>`。
- 入口：`client/src/pages/Dashboard.jsx` 的 `right` 导航加「域名映射」按钮（`navigate('/routes')`），**仅当 `appConfig.proxyEnabled` 时显示**（复用 `AppConfigContext` 已暴露的 `proxyEnabled`）。
- 页面内容：
  - 映射列表：域名、目标类型徽标（端口 / 应用）、目标值（端口号 或 应用名）、生效状态（app 型未运行给「未运行」提示）、删除按钮。
  - 「添加映射」→ Modal 表单：`host` 输入、目标类型单选（端口 / 应用）、端口数字输入 或 应用下拉（复用 `getAllApps()`）；编辑复用同一表单回填。
- API 函数：`client/src/api/apps.js`（或新增 `client/src/api/proxy-routes.js`）加 `getProxyRoutes / createProxyRoute / updateProxyRoute / deleteProxyRoute`。
- i18n：`client/src/i18n/locales/{en,zh-CN}.json` 补文案。

### 6. 生成的 nginx 配置形态（新增部分，置于文件头部）

```nginx
# Managed by Microverse — do not edit by hand; regenerated on app lifecycle.

# 自定义域名映射（显式，优先于自动子域名；v1 仅 HTTP）
server {
    listen 80;
    server_name a.example.com;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }
}

# ... 之后是自动子域名块与根域名默认块（现有逻辑不变）
```

## 错误处理 / 边界

- **反代整体**：`PROXY_ENABLED=false` / nginx 缺失 / conf 路径不可写 / `nginx -t` 失败 → 全部降级 no-op + 警告，**不影响 CRUD 与应用启停**。
- **注入面**：`server_name` 仅来自白名单校验后的 `host`（`[\w.-]+`）或已校验的应用名；端口为 1–65535 整数。无用户自由文本进 conf。
- **app 型目标停用/未运行**：路由已保存但渲染时跳过该块（不产生指向停用应用的 server 块）；UI 显示「未运行」。
- **删除应用**：`ON DELETE CASCADE` 清掉指向它的路由；`deleteApp` 已调 `regenerate()`，配置自然不再含该路由。
- **删除应用后再重建同名应用**：`target_app_id` 已级联删除，不会错指向新应用。
- **`baseDomain` 缺失但存在自定义路由**：只渲染自定义块，跳过自动子域名与根域名块，不再提前 bail。
- **重复 host**：DB `UNIQUE` + 校验层双重拦截，大小写归一后判断。
- **未匹配 server_name**：仍落 nginx 默认 server（用户掌控）。

## 测试

**后端单元**（`server/src/test/unit/`，扩充 `proxy-config.test.js`）：
- 自定义 port 型 → 出 `listen 80` 单块，`server_name host`、`proxy_pass http://127.0.0.1:<port>`。
- 自定义 app 型且 running 有 port → 出块指向该 port。
- 自定义 app 型但 stopped / port=null / app 不存在 → 不出块。
- 自定义块在自动子域名块**之前**（优先级）。
- `baseDomain` 缺失 → 自定义块仍渲染，自动/根块跳过。
- `ssl.enabled=true` 时自定义块仍仅 HTTP（不出 443）。
- `validateProxyRoute`：非法 host / 重复 host / 非法 port / 未知 app 各抛描述性错误；合法输入返回规范化结果。

**后端集成**（`server/src/test/integration/`）：
- CRUD 需登录（未登录 401）；POST 成功返回新行；重复 host 400；非法 target 400；DELETE 后 `ProxyManager.regenerate` 被调用（mock）。

**手动验证**（环境相关）：
- 测试服务器 `PROXY_ENABLED=true`，`GET/POST /api/proxy-routes` 增一条 `some.example.com → 127.0.0.1:<port>` → `curl -H 'Host: some.example.com' http://127.0.0.1` 命中目标；删掉 → 不再路由；app 型目标停用 → 不再路由。`nginx -t` 失败时 nginx 不被 reload、平台日志告警、CRUD 仍成功。

## 已知限制 / 范围外

1. 自定义域名 v1 仅 HTTP；HTTPS 与证书（per 域名 / SAN / certbot）后续再做。
2. 不支持通配符域名（`*.example.com`）。
3. 目标固定 `127.0.0.1`，不支持代理到其它主机。
4. `regenerate()` 失败时 CRUD 仍成功但映射未生效，UI 暂不反馈 nginx reload 失败（沿用现有默认应用开关的静默 warn 约定）。
5. 依赖系统 nginx 已安装、可写 conf 目录、有 reload 权限；不满足时降级 no-op。

## 改动面 checklist（实现时用）

**后端**
- MOD `server/src/db/schema.sql` — 新增 `proxy_routes` 表 + 索引
- MOD `server/src/db/index.js` — `listProxyRoutes` / `getProxyRouteById` / `createProxyRoute` / `updateProxyRoute` / `deleteProxyRoute`
- MOD `server/src/services/proxy-manager.js` — `renderProxyConfig` 加 `routes` 入参 + 自定义块渲染 + `baseDomain` 可选化 + 新增 `validateProxyRoute` 导出；`regenerate` 读 routes
- MOD `server/src/routes/index.js` — `GET/POST /api/proxy-routes` + `PUT/DELETE /api/proxy-routes/:id`

**前端**
- NEW `client/src/pages/ProxyRoutes.jsx` + 路由 `App.jsx` + Dashboard 导航入口
- MOD `client/src/api/apps.js`（或 NEW `proxy-routes.js`）— 4 个 API 函数
- MOD `client/src/i18n/locales/{en,zh-CN}.json`

**测试**
- MOD `server/src/test/unit/proxy-config.test.js` — 自定义块 + 优先级 + baseDomain 可选 + HTTP-only + validate
- NEW `server/src/test/integration/proxy-routes.test.js` — CRUD 认证/校验/regenerate

**文档**
- NEW 本设计文档（已含）
- MOD `README.md` / `README.zh-CN.md` — 自定义域名用法 + DNS 指向说明
- MOD `PROGRESS.md` — 变更日志条目
- MOD `docs/superpowers/specs/2026-07-18-nginx-reverse-proxy-design.md` — 注明 per-app 自定义域名范围决策被本设计取代

**验证（端到端）**
- `npm test`（根）→ 全绿（含新增/扩充的 proxy 单测 + routes 集成测试）
- `cd client && npm run lint && npm run build` → 干净
- 测试服务器手动冒烟：自定义域名路由、优先级、app 型停用摘除、baseDomain 缺失仅渲染自定义块
