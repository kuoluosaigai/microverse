# 域名部署加固 — 设计文档

- **日期**: 2026-07-18
- **状态**: Approved (design)
- **范围**: 五项服务于"域名部署自洽 + 更新干净 + 文档对齐"的工作——ZIP 自动去顶层目录、子域名外链配置、后端生产模式托管前端（替代 openclaw 未提交补丁）、生产部署文档重写 + 提交 `ecosystem.config.js`、中文 README。
- **不在范围**: 多用户、JWT、nginx 反代/SSL/域名绑定本身（用户的反代基建，不归平台管）、per-app 自定义外链（YAGNI，全局模板已覆盖"子域名 = 应用名"场景）。

## 背景

用户实际用域名部署后反馈三个问题，并触发一项部署一致性发现：

1. **ZIP 多套一层目录**：很多打包工具会把内容放进一个顶层文件夹（如 `mysite/index.html`），上传解压后变成 `<app>/mysite/index.html`，导致 `index.html` 校验失败，用户得手动重压。
2. **域名外链**：平台经域名访问时，已部署应用的"打开"链接写死 `http://localhost:${port}`，无法用域名。用户用**子域名映射**（每个应用一个子域，由其反代转发到各端口）。
3. **更新机制**：用户已部署（systemd → PM2 cluster → `server/src/server.js` :8080），改完代码要重新推送并更新，需要明确流程。
4. **部署一致性发现（关键）**：用户图里 `node` 进程在 :8080 托管 `client/dist`，但仓库 `app.js` **没有**静态托管逻辑（端口默认 5000）。差距来自 openclaw 给 `app.js` 加的一段未提交补丁（`express.static(client/dist)` + `app.get('*')` SPA fallback）。这意味着 `git pull` 改 `app.js` 时可能与本地补丁冲突，补丁也可能丢失。根治：把"后端生产模式托管前端"做成正式提交，本地补丁变为多余。

## 关键决策（brainstorm 已确认）

1. **ZIP 去顶层**：只在"解压后 app 目录恰好只有一个顶层条目且是目录"时抬一层；其余不动。纯函数 + 上传路由调用。备份/恢复不受影响（其 zip 结构固定）。
2. **子域名外链**：全局 env `APP_PUBLIC_URL_TEMPLATE`（如 `https://{name}.yourdomain.com`），`{name}` 替换应用名；经 `/api/config` 下发；前端有模板则用、无则退回 `localhost`。**前端用 `new URL()` 校验生成结果**，拼不出合法 URL 就退回 localhost。应用名已是 `[A-Za-z0-9_-]`，URL 安全、无注入面。
3. **后端托管前端 = 仅 production**：dev 仍走 Vite（5173 + proxy）。生产挂 `express.static(client/dist)` + SPA fallback（排除 `/api`、`/api-docs`、`/openapi.json`）；`client/dist` 不存在则打日志跳过。
4. **`/` 路由让位**：生产模式下 `/` 服务 `index.html`（健康检查走已有的 `/api/health`）；非生产保留现有 JSON `{name,version,status}`。
5. **`ecosystem.config.js` 提交**：cluster 模式模板，让 `npm run pm2:start` 开箱即用（用户已有自己的，但仓库补上对文档/复用有利）。
6. **中文 README**：新增 `README.zh-CN.md` 全量翻译；主 README 顶部加语言切换链接。
7. **更新流程文档化**：README 加 "Updating an existing deployment" 章节，并明确 openclaw 补丁用户需 `git checkout -- server/src/app.js` 丢弃本地补丁再 pull。

## 探查结论（已逐条核对源码）

### ZIP 解压（现状）
`routes/index.js` 上传路由 L507–547：对每个 `.zip` 做 zip-slip 校验（`isSafeEntry`）→ `zip.extractAllTo(app.path, true)` → 收集文件名。**解压后无任何"抬层"处理**。若 zip 顶层是单目录，`index.html` 落在二级，`AppManager.validateAppDeployment`（`files.includes('index.html')`）失败。

### 外链（现状）
`AppRow.jsx` L33–37 `openPort()` 写死 `window.open(\`http://localhost:${app.port}\`, ...)`。前端通过 `/api/config` 拿上传限制（`UploadFiles` 里各自 fetch），目前无共享 config 上下文。

### 静态托管（现状 + 分歧）
`app.js` L18–56：仅挂 `/api`、`/api-docs`、`/openapi.json`、`/`（JSON）、`notFoundHandler`、`errorHandler`。**无 `express.static`、无 `sendFile`、未 `require('fs')/'path'`**。`grep` 全 `server/` 确认零静态托管。→ openclaw 补丁是纯本地未提交改动。

### PM2
`server/package.json` 有 `pm2:start: pm2 start ecosystem.config.js`，但 `server/ecosystem.config.js` **不存在**（未提交）。用户用自己的 ecosystem（cluster 模式）。

### 配置下发
`GET /api/config`（`routes/index.js` L36–46）公开、返回 `{ upload: { maxFileSize, maxFiles } }`。可在此加 `appPublicUrlTemplate`。`config/index.js` 加 `deployment.appPublicUrlTemplate`。

## 架构

### 1. ZIP 自动去顶层目录

**新增** `server/src/utils/flatten-zip-root.js`（纯函数，可单测）：
```js
const fs = require('fs');
const path = require('path');

/**
 * If `dir` contains exactly one entry and it is a directory, move that
 * directory's children up into `dir` and remove the now-empty wrapper.
 * Handles the common "zip wraps everything in a top-level folder" case
 * (GitHub/IDE-style zips). No-op otherwise (multiple top-level entries,
 * or a single file — ambiguous, leave as-is).
 *
 * Safe by construction: we only act when `dir`'s sole entry is the wrapper,
 * so there is nothing else at the top level to collide with during hoist.
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

**挂载**：`routes/index.js` 上传路由，在 `zip.extractAllTo(app.path, true)` 之后调用 `flattenSingleTopDir(app.path)`（zip-slip 校验在 extractAllTo 之前不变）。

### 2. 子域名外链

**后端**：
- `config/index.js` `deployment` 加：`appPublicUrlTemplate: process.env.APP_PUBLIC_URL_TEMPLATE || ''`。
- `routes/index.js` `GET /config` 返回体加：`appPublicUrlTemplate: config.deployment.appPublicUrlTemplate || null`。
- `.env.example` 加注释项：`# APP_PUBLIC_URL_TEMPLATE=https://{name}.yourdomain.com`。

**前端**：
- 新增 `client/src/context/ConfigContext.jsx`：挂载时 fetch 一次 `/api/config`，暴露 `{ appPublicUrlTemplate, maxFileSize, maxFiles, loading }`。`App.jsx` 在 `AuthProvider` 外（或内）包一层 `<ConfigProvider>`。
- 新增 `client/src/utils/app-url.js`（纯函数）：
  ```js
  export function buildAppUrl(app, template) {
    if (template && template.includes('{name}')) {
      try {
        return new URL(template.replace('{name}', app.name)).toString();
      } catch (_e) { /* invalid → fall back */ }
    }
    return null;
  }
  ```
- `AppRow.jsx` `openPort()`：
  ```js
  const openPort = () => {
    if (!app.port || !isRunning) return;
    const url = buildAppUrl(app, appPublicUrlTemplate) || `http://localhost:${app.port}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };
  ```
  （`appPublicUrlTemplate` 从 `useConfig()` 取。）

**校验语义**：`new URL()` 解析失败 → 返回 null → 退回 localhost。应用名 `[A-Za-z0-9_-]` 对 URL/路径安全；子域名场景下划线会带进子域名，文档提示优先用连字符。

### 3. 后端生产模式托管前端

**改** `server/src/app.js`：
- 顶部 `require('fs')` + `require('path')`。
- 把现有 `app.get('/', ...JSON)` 包进条件，并新增 production 静态托管块（在 `/openapi.json` 之后、`notFoundHandler` 之前）：
  ```js
  if (config.server.nodeEnv === 'production') {
    const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
    if (fs.existsSync(clientDist)) {
      app.use(express.static(clientDist));
      const indexHtml = path.join(clientDist, 'index.html');
      // SPA fallback: anything not under the API/docs prefixes → index.html.
      // Unknown /api/* still falls through to notFoundHandler (JSON 404).
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
  ```
- `__dirname` 在 `app.js`（`server/src/`）下，`../../client/dist` = 仓库根 `client/dist`。

**行为**：
- 生产 + dist 存在 → 单端口同时吐 API + UI；深链（如 `/apps/1/logs`）回 index.html 交给 React Router。
- 生产 + dist 缺失 → 打日志，`/` 返回 JSON（API 照常）。
- dev → 完全不变（Vite 5173 + proxy）。

### 4. 生产部署文档 + ecosystem.config.js

**新增** `server/ecosystem.config.js`（提交）：
```js
module.exports = {
  apps: [{
    name: 'microverse-server',
    script: 'src/server.js',
    cwd: __dirname,
    instances: 'max',          // cluster: one worker per core (or set a number)
    exec_mode: 'cluster',
    env: { NODE_ENV: 'production' },
    max_memory_restart: '512M'
  }]
};
```
（PORT/CORS/ADMIN_PASSWORD 等仍走仓库根 `.env`，由 `config` 的 dotenv 加载。）

**改** `README.md`：
- 重写 "Production Deployment"：构建前端 → `NODE_ENV=production` 跑 `server/src/server.js`（或 `cd server && npm run pm2:start` 用 cluster）→ 后端单端口同时吐 API+UI → 域名用反代指过来（反代基建由用户自管）。删去对"分开托管前端"的假设。
- 新增 "Updating an existing deployment" 章节：
  ```
  git pull origin main
  # 仅当依赖变了：npm run install:all
  # 前端变了：npm run build:client
  pm2 reload microverse-server   # cluster 模式零停机
  ```
  并写明：**若你曾手动改 `server/src/app.js` 加静态托管（如经 openclaw），先 `git checkout -- server/src/app.js` 丢弃本地补丁再 pull**——仓库现已官方支持。
- 说明 `data/*.sqlite` 与 `apps/` 是 gitignored，更新不丢数据；schema 启动自愈，无迁移步骤。

### 5. 中文 README

**新增** `README.zh-CN.md`：全量翻译（特性/快速开始/使用/API/配置/跨平台/开发/排错/技术栈）。`README.md` 顶部加：
```
**Languages:** [English](README.md) | [中文](README.zh-CN.md)
```
`README.zh-CN.md` 顶部加反向链接。

## 错误处理 / 边界

- ZIP 去顶层：`readdirSync` 失败（目录不存在）→ 返回 false（no-op）；非单目录 → no-op。
- 外链：模板缺 `{name}` → 不替换、`new URL` 校验；解析失败 → 退回 localhost。模板未配置 → null → 退回 localhost（本地开发行为不变）。
- 静态托管：production + dist 缺失 → 不崩，API 照常，打日志。SPA fallback 不吞 `/api/*`（regex 排除）。
- `ecosystem.config.js`：cluster 模式下 `pm2 reload` 零停机；`.env` 由 dotenv 在 worker 内加载。

## 测试

**后端单元**（`server/src/test/unit/`）：
- `flatten-zip-root.test.js`：单顶层目录（含文件 + 嵌套子目录）→ 抬层成功；多顶层条目 → no-op；单文件 → no-op；目录不存在 → no-op。

**后端集成**（`server/src/test/integration/`）：
- `health-config.test.js` 扩展：`GET /config` 返回 `appPublicUrlTemplate`（默认 null；可通过 env 设值验证，但测试进程 env 已固定，断言字段存在即可）。

**手动验证**（环境相关 / 前端，沿用项目约定）：
- ZIP 去顶层：上传一个"套了顶层文件夹"的 zip → app 目录顶层直接是 `index.html`，能 start。
- 外链：设 `APP_PUBLIC_URL_TEMPLATE=https://{name}.example.com` → 端口 chip 打开 `https://<appname>.example.com`；不设 → 仍是 localhost。
- 静态托管：`NODE_ENV=production` + `npm run build:client` + 启动 → `http://localhost:5000/` 出 UI；深链刷新不 404；`/api/health` 仍是 JSON。
- ecosystem：`cd server && npm run pm2:start` → cluster 起来；`pm2 reload microverse-server` 零停机。

## 已知限制 / 范围外

1. 外链模板只支持 `{name}` 单占位符（子域名 = 应用名场景）。per-app 自定义外链（DB 字段 + UI）为 YAGNI，未做。
2. 子域名带下划线（应用名含 `_`）非 RFC 严格；多数 DNS/反代可用，文档提示优先连字符，不强制禁止（避免破坏既有带 `_` 应用）。
3. 静态托管仅 production；生产 + dist 缺失只警告不重建（不替用户跑构建）。
4. 不做 nginx 反代/SSL/域名绑定（用户基建）。
5. 中文 README 为人工翻译，与英文 README 内容对齐；后续改动需双向同步（可接受）。

## 改动面 checklist（实现时用）

**后端**
- NEW `server/src/utils/flatten-zip-root.js`
- MOD `server/src/routes/index.js` — 上传路由解压后调 `flattenSingleTopDir`；`GET /config` 加 `appPublicUrlTemplate`
- MOD `server/src/config/index.js` — `deployment.appPublicUrlTemplate`
- MOD `server/src/app.js` — production 静态托管 + SPA fallback；`/` 路由条件化
- NEW `server/ecosystem.config.js`
- MOD `.env.example` — `# APP_PUBLIC_URL_TEMPLATE=...`

**前端**
- NEW `client/src/context/ConfigContext.jsx`
- NEW `client/src/utils/app-url.js` — `buildAppUrl`
- MOD `client/src/App.jsx` — 包 `<ConfigProvider>`
- MOD `client/src/components/AppRow.jsx` — `openPort` 用 `buildAppUrl` + `useConfig`

**测试**
- NEW `server/src/test/unit/flatten-zip-root.test.js`
- MOD `server/src/test/integration/health-config.test.js` — 断言 `appPublicUrlTemplate` 字段

**文档**
- NEW `README.zh-CN.md`
- MOD `README.md` — 生产部署重写 + Updating 章节 + 语言切换链接
- MOD `PROGRESS.md` — 变更日志加 `[Unreleased] — 2026-07-18 (domain deploy hardening)` 条目

**验证（端到端）**
- `npm test`（根）→ 全绿（含新增 flatten 单测 + config 字段断言）
- `cd client && npm run lint && npm run build` → 干净
- 手动冒烟：套层 zip 上传、外链模板、production UI 托管、ecosystem cluster 起停
