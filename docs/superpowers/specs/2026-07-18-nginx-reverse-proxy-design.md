# 平台托管 Nginx 反向代理 — 设计文档

- **日期**: 2026-07-18
- **状态**: Approved (design)
- **范围**: 让平台自动生成并 reload 系统级 nginx 反向代理配置，把每个运行中应用的子域名路由到其端口，并支持把根域名指向某个"默认应用"；生命周期变更自动重生成；SSL 配置结构预留（不签发证书）。同批顺带：会话加固（修复无故被登出）、登录页密码框双下划线 CSS 修复。
- **取代**: `docs/superpowers/specs/2026-07-18-domain-deploy-hardening-design.md` 第 6、215 行"不做 nginx 反代/SSL/域名绑定（用户基建）"的范围决策。本设计将其修订为：**平台托管 app 路由用的 nginx 反代配置**（用户的系统 nginx 仍是底座，平台只写被 include 的子配置并 reload）。
- **不在范围（v1）**: 自动 Let's Encrypt / certbot 证书签发（仅留配置位 + 配置形态）；per-app 自定义域名（沿用全局 `{name}` 模板）；平台 UI 自身 server 块的托管（用户一次性自行配置，极少变化）；多用户。

## 背景

用户域名部署后反馈（2026-07-18）：

1. 应用 `sticky-notes` 的"打开"链接是 `http://sticky-notes.kuoluosaigai.com/`，但浏览器打不开。根因：`APP_PUBLIC_URL_TEMPLATE` 只装饰 UI 链接的 `href`（`client/src/utils/app-url.js:10`、`client/src/components/AppRow.jsx:36-40`），平台**从不**把子域名映射到端口，也**不**生成任何反代配置。要让子域名可访问，必须有 DNS 记录 + 一个监听 80/443、把子域名 `proxy_pass` 到应用端口的反向代理。
2. 用户希望能用 80 端口、甚至根域名 `http://kuoluosaigai.com/` 访问应用。架构上平台直接 `listen 80` 不合理（需 root、只能一个进程独占）；正确做法是应用跑高端口、80/443 交给边缘反代统一路由。
3. 服务器 `kuoluosaigai.com` 本身就是专门用来测试本平台的，用户授权"你来好好设计一把"。

结论：把"nginx 反代"从"用户基建"提升为"平台托管"——平台按应用端口自动生成 nginx server 块并 reload，应用经域名/80 访问开箱即用。

## 关键决策（brainstorm 已确认）

1. **路线 A：管理系统 nginx 的 app 路由配置。** 平台把所有 running app 的 server 块写进一个受控 conf 文件（默认 `/etc/nginx/conf.d/microverse_apps.conf`），`nginx -t` 通过后 `nginx -s reload`。Debian/Ubuntu 默认 `include /etc/nginx/conf.d/*.conf;`，故通常零额外配置；其它发行版需一次性确保 include。复用现有 `NGINX_BIN` 与 `NginxLifecycle` 的 exec/test 模式。否决路线 B（自起专属 nginx 实例占 80/443：root/能力位 + 与系统 nginx 共存冲突 + SSL 更麻烦）与路线 C（Node http-proxy：重造轮子、性能/SSL/静态均不如 nginx）。
2. **域名模型沿用全局模板。** 每个 running app 生成 `server_name <appname>.<baseDomain>;`。`baseDomain` 优先取 `PROXY_BASE_DOMAIN`，未设则从 `APP_PUBLIC_URL_TEMPLATE` 推导（去掉 `{name}.` 前缀，如 `http://{name}.kuoluosaigai.com` → `kuoluosaigai.com`）。模板未配置 → 反代功能不生成子域名块（功能事实上关闭）。
3. **根域名默认应用机制（v1 纳入）。** `apps` 表新增 `is_default` 列；设为默认且 running 的应用额外生成 `server_name <baseDomain> www.<baseDomain>;` 根域名块，`proxy_pass` 到其端口。"单默认"由 service 层保证（设默认前先把全部 `is_default=0`）。UI 提供单选开关。
4. **纯 opt-in。** 新增 `PROXY_ENABLED`（默认 `false`）。未启用 → 零行为变化，纯本地开发不受影响。
5. **生命周期触发的幂等全量重生成。** 单一 `ProxyManager.regenerate()` 读所有 apps → 渲染全部块 → 写文件 → `nginx -t` → reload。start / stop / delete / 设默认 / 取消默认 后调用。增量编辑比全量渲染更易出错，故选全量。
6. **SSL 仅预留结构。** `PROXY_SSL_ENABLED`（默认 `false`）+ `PROXY_SSL_CERT` / `PROXY_SSL_CERT_KEY` 配置位。`true` 时渲染 `listen 443 ssl;` + 证书路径 + 80→443 跳转块；**v1 不签发证书**，证书由用户后续自行获取（certbot 等）。
7. **会话加固（问题 2）。** `app.set('trust proxy', 1)`；express-session 改 `resave: true` + `rolling: true`（活动即续期），`maxAge` 调至 7 天，production 下 `cookie.secure` 跟随 `PROXY_SSL_ENABLED`（可被 `SESSION_COOKIE_SECURE` 覆盖）。仍需用户在 `.env` 设固定 `SESSION_SECRET`（配置层，代码无法替代）。
8. **登录 CSS（问题 4）。** `index.css:45` 选择器同时给 `.ant-input` 与 `.ant-input-affix-wrapper` 加 `border-bottom`，`Input.Password` 内层 `.ant-input` 嵌在 affix-wrapper 内导致双线叠加；在 affix-wrapper 内层 input 上去掉 `border-bottom` 即可，普通 `Input` 不受影响。

## 探查结论（已逐条核对源码）

- **外链现状**：`client/src/utils/app-url.js:10` `buildAppUrl` 仅替换 `{name}` 并用 `new URL()` 校验；`AppRow.jsx:36-40` `openPort` 用其结果或退回 `localhost:<port>`。后端 `config/index.js:56` `appPublicUrlTemplate`、`routes/index.js` `GET /api/config` 下发。
- **端口分配**：`server/src/services/process-manager.js:303-312` `findAvailablePort(min,max,{exclude})`；`deploy-manager.js:40-55` 临界区分配并写 `apps.port`，首次分配后跨重启保留。无手动指定端口入口。
- **既有 nginx 基建**：`server/src/services/nginx-lifecycle.js` 提供 `resolveBinary()` / `generateConfig()` / `testConfig()`（`nginx -t -c`）/ `probe()`（`nginx -v`），服务的是 `nginx` 部署类型（每应用当静态服务器跑高端口，`server_name _`、`root <appPath>`、`listen <port>`），**与边缘反代无关**，但 exec/test/binary 解析模式可照搬。
- **生命周期钩子**：`DeployManager.deployApp`（start，`deploy-manager.js:23`）、`stopApp`（:85）、`restartApp`（:105）；`AppManager.deleteApp`（`app-manager.js:103`，要求先 stop）。
- **DB**：`apps` 表无 `is_default`/域名字段（`schema.sql:4-13`）；`db/index.js initDatabase()` 用 `dbExec(schema)` 跑 `schema.sql`，`CREATE TABLE IF NOT EXISTS` 不会给已存在表加列 → 新列需幂等 `ALTER TABLE` 迁移。`updateApp`（`db/index.js:109-120`）用 COALESCE 更新 path/deploy_type/port/status。
- **会话现状**：`app.js:27-36`，`secret = SESSION_SECRET || 随机`，`resave:false, saveUninitialized:false, cookie:{ httpOnly, sameSite:'lax', maxAge:8h }`，未设 `trust proxy`、无 `secure`。前端唯一跳转源 `App.jsx:39-49` `RequireAuth`，仅整页刷新时 `getMe()` 401 才跳；无"偶发 401 即登出"拦截器。
- **登录 CSS 现状**：`client/src/styles/index.css:44-59`；`Login.jsx:45` `<Input>`（用户名，单线）vs `:52` `<Input.Password>`（affix-wrapper 包内层 input，双线）。

## 架构

### 1. 配置（`server/src/config/index.js` + `.env.example`）

`deployment` 下新增：
```js
proxyEnabled: process.env.PROXY_ENABLED === 'true',                         // 默认 false
proxyConfFile: process.env.PROXY_CONF_FILE || '/etc/nginx/conf.d/microverse_apps.conf',
proxyBaseDomain: process.env.PROXY_BASE_DOMAIN || '',                        // 空 → 从模板推导
proxyReloadBinary: process.env.NGINX_BIN || 'nginx',                         // 复用
// SSL 预留（v1 不签发）：
proxySslEnabled: process.env.PROXY_SSL_ENABLED === 'true',
proxySslCert: process.env.PROXY_SSL_CERT || '',
proxySslCertKey: process.env.PROXY_SSL_CERT_KEY || '',
```
`auth` 下新增：
```js
sessionCookieSecure: process.env.SESSION_COOKIE_SECURE === 'true'            // 显式覆盖；否则随 PROXY_SSL_ENABLED
```
会话 `maxAge` 调整为 `7 * 24 * 60 * 60 * 1000`（7 天）。

### 2. 数据模型 + 幂等迁移

`schema.sql` `apps` 表加列定义（供全新库）：`is_default INTEGER NOT NULL DEFAULT 0`。
`db/index.js initDatabase()` 在 `dbExec(schema)` 之后追加幂等迁移（引入该代码库的最小迁移机制）：
```js
const cols = await dbAll(`PRAGMA table_info(apps)`);
if (!cols.some(c => c.name === 'is_default')) {
  await dbExec(`ALTER TABLE apps ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0`);
}
```
`db/index.js queries` 新增/扩展：
- `updateApp` COALESCE 列表追加 `is_default = COALESCE(?, is_default)`（取消单个 app 默认用 `updateApp({ id, is_default: 0 })` 即可，无需单独 query）。
- `clearDefaultApp()`：`UPDATE apps SET is_default = 0 WHERE is_default = 1`（全局清空，仅在 `setDefaultApp` 事务内用）。
- `setDefaultApp(id)`：事务内先 `clearDefaultApp()` 再 `UPDATE apps SET is_default = 1 WHERE id = ?`（保证单默认）。
- `getAllApps` 已 `SELECT *`，自动含新列（前端经现有 `GET /api/apps` 即可读到 `is_default`）。

### 3. `ProxyManager` 服务（新文件 `server/src/services/proxy-manager.js`）

**纯渲染函数**（不碰文件系统，单测友好）：
```js
/**
 * @param {Array} apps 全部应用（含 name/port/status/is_default）
 * @param {{ baseDomain:string, ssl:{enabled,cert,key} }} opts
 * @returns {string} 完整 nginx conf（可能为空字符串——无 running app 时）
 */
function renderProxyConfig(apps, opts) { /* 见 §4 形态 */ }
```
- 仅 `status==='running' && port>0` 的应用出子域名块。
- `is_default===1 && running && port>0` 的应用额外出根域名块；若无符合条件的默认应用，则不出根域名块。
- `opts.ssl.enabled` 为真且 cert/key 非空 → 每个块同时出 443 ssl + 80→443 跳转；否则仅 `listen 80;`。
- `baseDomain` 缺失 → 抛错（调用方在 `proxyBaseDomain` 与模板都缺时应直接跳过整体重生成并告警）。

**`regenerate()`**（异步，外部调用入口）：
1. `config.deployment.proxyEnabled` 为假 → 直接返回（no-op）。
2. 解析 `baseDomain`：`proxyBaseDomain` 或从 `appPublicUrlTemplate` 推导；都缺 → 告警 + 返回。
3. 读 `queries.getAllApps()` → `renderProxyConfig(...)`。
4. 写 `proxyConfFile`（`fs.writeFileSync`，临时文件 + rename 原子替换）。
5. `nginx -t`（用 `proxyReloadBinary`，`testConfig` 复用 `nginx-lifecycle` 模式，`-t` 测整份主配置）。
   - 不过 → **不 reload**，返回 `{ ok:false, message }`，仅日志；不抛、不阻断 app 生命周期。
6. `nginx -s reload` → 返回 `{ ok:true }`。
- 任意 fs/exec 异常（路径不可写、nginx 缺失）→ catch → 告警 + 返回 `{ ok:false }`，**绝不向上抛**。

### 4. 生成的 nginx 配置形态（v1 仅 HTTP 示例）

```nginx
# Managed by Microverse — do not edit by hand; regenerated on app lifecycle.
# SSL: disabled (set PROXY_SSL_ENABLED=true + PROXY_SSL_CERT/_KEY).

server {
    listen 80;
    server_name sticky-notes.kuoluosaigai.com;
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name kuoluosaigai.com www.kuoluosaigai.com;   /* 默认应用 */
    location / { proxy_pass http://127.0.0.1:3001; /* 同上 headers */ }
}
```
SSL 启用形态（结构预留）：
```nginx
server {
    listen 80;
    server_name sticky-notes.kuoluosaigai.com;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    server_name sticky-notes.kuoluosaigai.com;
    ssl_certificate     /etc/letsencrypt/.../fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/.../privkey.pem;
    location / { proxy_pass http://127.0.0.1:3001; /* headers */ }
}
```

### 5. 集成钩子

在以下操作成功后调用 `await ProxyManager.regenerate()`，用 try/catch 包裹，失败仅 `console.warn`，**不阻断主操作**：
- `DeployManager.deployApp`（start 末尾，状态置 running 之后）
- `DeployManager.stopApp`
- `AppManager.deleteApp`（DB 删除之后）
- 设置/取消默认应用（`routes/index.js` 的 `PUT/DELETE /api/apps/:id/default` handler 内，DB 写之后）

### 6. API + UI

- `PUT /api/apps/:id/default`（受 `requireAuth`）：调 `queries.setDefaultApp(id)` → `ProxyManager.regenerate()` → 返回更新后的 app。
- `DELETE /api/apps/:id/default`（受 `requireAuth`）：调 `queries.updateApp({ id, is_default: 0 })`（仅把该 app 的默认取消）→ `regenerate()`。
- `GET /api/config` 增发 `proxyEnabled`、`proxyBaseDomain`。
- 前端 `AppRow`（或详情页）：当 `appConfig.proxyEnabled` 且 `app.status==='running'` 且有 `app.port` 时，显示"设为根域名默认应用"单选开关（`is_default` 当前态回填）；切换调上述接口并刷新列表。

### 7. 会话加固（`server/src/app.js:27-36`）

```js
app.set('trust proxy', 1);
const secure = config.auth.sessionCookieSecure || (config.deployment.proxySslEnabled && config.server.nodeEnv === 'production');
app.use(session({
  secret: sessionSecret,
  resave: true,            // rolling 续期需要
  saveUninitialized: false,
  rolling: true,           // 每次响应刷新 cookie，活动即续命
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: 7 * 24 * 60 * 60 * 1000   // 7 天
  }
}));
```
`SESSION_SECRET` 仍需用户在 `.env` 设（保留现有 `app.js:27-30` 警告）。

### 8. 登录页 CSS（`client/src/styles/index.css`，紧随 :59 追加）

```css
/* Input.Password 的内层 .ant-input 嵌在 affix-wrapper 内，会和 wrapper 的
   border-bottom 叠加出双下划线；只关掉被包裹的内层 input 的下划线，
   普通 <Input>（无 affix-wrapper）不受影响。 */
.ant-input-affix-wrapper > .ant-input,
.ant-input-affix-wrapper input.ant-input {
  border: none !important;
  border-bottom: none !important;
  box-shadow: none !important;
}
```

## 错误处理 / 边界

- **反代整体**：`PROXY_ENABLED=false` / `baseDomain` 缺失 / nginx 缺失 / conf 路径不可写 / `nginx -t` 失败 → 全部降级为 no-op + 警告日志，**不影响 app 启停与删除**。`nginx -t` 不过绝不 reload（避免搞挂整个 nginx）。
- **注入面**：`server_name` 仅来自已校验的 app 名（`[A-Za-z0-9_-]`，`utils/validate-app-name.js`）+ 配置 `baseDomain`；端口为整数；`baseDomain` 渲染前用域名字符白名单校验（`[\w.-]+`）。无用户自由文本进 conf。
- **下划线应用名**：子域名含 `_` 非严格 RFC（多数 DNS/反代可用），沿用既有文档提示，不强制禁止。
- **单默认一致性**：`setDefaultApp` 事务内清空再置位；删除默认应用时 `deleteApp` 后的 `regenerate()` 自然不再出根块（DB 已无该行）。
- **停止的应用**：不出 server 块 → 其子域名落到 nginx 默认 server（不路由到该 app）。
- **未匹配 server_name**：落到 nginx 默认 server（UI 块或默认页），由用户掌控。
- **会话**：`trust proxy` 仅信任一层反代（单机部署模型）；`secure=true` 下若实际未走 HTTPS 会导致浏览器拒收 cookie → 用 `SESSION_COOKIE_SECURE=false` 可显式回退。
- **迁移幂等**：`PRAGMA table_info` 检测，重复执行与全新库均安全。

## 测试

**后端单元**（`server/src/test/unit/`）：
- `proxy-config.test.js`（纯渲染）：
  - 一个 running app + port → 出一个 80 块，`server_name <name>.<base>`，`proxy_pass http://127.0.0.1:<port>`。
  - stopped app → 不出块。
  - running 但 `port=null` → 不出块。
  - `is_default=1` running → 额外出根块（`server_name <base> www.<base>`）。
  - 多 running app → 每个一块、顺序稳定。
  - `baseDomain` 缺失 → 抛错。
  - `ssl.enabled=true` + cert/key → 出 443 ssl 块 + 80→443 跳转；cert/key 缺 → 回退 HTTP-only（不渲染 ssl）。
- `migration.test.js`（如可隔离 DB）：已有库执行迁移 → `is_default` 列存在、默认 0；重复执行不报错。

**后端集成**（`server/src/test/integration/`）：
- `proxy-default.test.js`：`PUT /api/apps/:id/default` 需登录（未登录 401）；置默认后 `is_default=1` 且其它 app 归零；`DELETE` 后归零；start/stop/后端 mock `ProxyManager.regenerate` 被调用。

**手动验证**（环境相关）：
- 测试服务器：`PROXY_ENABLED=true` + 已配 `APP_PUBLIC_URL_TEMPLATE=http://{name}.<dom>`，确保系统 nginx include conf.d。跑一个 http-server app → `curl -H 'Host: <name>.<dom>' http://127.0.0.1` 命中 app（或浏览器+DNS 通）。设默认 app → 根域名命中。停 app → 子域名不再路由。`nginx -t` 失败时 nginx 不被 reload、平台日志告警、app 仍正常启停。
- 会话：设固定 `SESSION_SECRET` → 重启 server 不掉登录；连续使用超过原 8h 仍保持；HTTPS 下 cookie 带 `Secure`。
- CSS：登录页密码框仅一条下划线，与用户名框一致。

## 已知限制 / 范围外

1. v1 不自动签发 SSL 证书（仅渲染结构）；用户需自行获取证书并填 `PROXY_SSL_CERT/_KEY`。
2. 不托管平台 UI 自身的 server 块；根域名若被默认应用占用，UI 需另置子域名/端口。
3. 单实例、单管理员部署模型；`trust proxy` 仅信任一层。
4. 不支持 per-app 自定义域名（沿用全局 `{name}` 模板）。
5. 反代依赖系统 nginx 已安装、可写 conf 目录、有 reload 权限（通常需 root 或 nginx 组 + pid 写权限）；不满足时功能降级为 no-op。

## 改动面 checklist（实现时用）

**后端**
- NEW `server/src/services/proxy-manager.js` — `renderProxyConfig` + `regenerate`
- MOD `server/src/config/index.js` — `proxy*` / `sessionCookieSecure`；会话 `maxAge`
- MOD `server/src/db/schema.sql` — `apps.is_default` 列
- MOD `server/src/db/index.js` — 幂等 `is_default` 迁移；`updateApp` COALESCE 加 `is_default`；`clearDefaultApp` / `setDefaultApp` / `getDefaultApp`
- MOD `server/src/services/deploy-manager.js` — start/stop 末尾调 `regenerate`
- MOD `server/src/services/app-manager.js` — `deleteApp` 后调 `regenerate`（设置/取消默认的 DB 写在 routes 直调 `queries`，无需新 AppManager 方法）
- MOD `server/src/routes/index.js` — `PUT/DELETE /api/apps/:id/default`；`GET /api/config` 增发 `proxyEnabled`/`proxyBaseDomain`
- MOD `server/src/app.js` — `trust proxy` + session `resave/rolling/maxAge/secure`
- MOD `.env.example` — `PROXY_*` / `SESSION_COOKIE_SECURE`

**前端**
- MOD `client/src/context/AppConfigContext.jsx` — 暴露 `proxyEnabled` / `proxyBaseDomain`
- MOD `client/src/components/AppRow.jsx` — "设为根域名默认应用" 开关 + 调接口
- MOD `client/src/styles/index.css` — affix-wrapper 内层 input 去 border-bottom
- MOD `client/src/i18n/locales/{en,zh-CN}.json` — 开关文案

**测试**
- NEW `server/src/test/unit/proxy-config.test.js`
- NEW/ MOD 迁移与 default 接口集成测试

**文档**
- NEW 本设计文档（已含）
- MOD `README.md` / `README.zh-CN.md` — `PROXY_*` 配置 + "一次性确保 nginx include conf.d" + "SSL 暂不自动签发"
- MOD `PROGRESS.md` — 变更日志条目
- MOD `docs/superpowers/specs/2026-07-18-domain-deploy-hardening-design.md` — 注明反代范围决策被本设计取代

**验证（端到端）**
- `npm test`（根）→ 全绿（含新增 proxy-config 单测 + default 接口集成测试）
- `cd client && npm run lint && npm run build` → 干净
- 测试服务器手动冒烟：子域名路由、根域名默认应用、停用摘除、SSL 结构、会话续期、登录页单下划线
