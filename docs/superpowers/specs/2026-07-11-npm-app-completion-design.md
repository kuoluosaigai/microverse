# npm 应用支持完善（Phase 11）设计

> 日期：2026-07-11
> 阶段：Phase 11 — npm 应用支持完善
> 状态：已确认，待实现

## 背景与问题

当前 npm 应用从上传到启动的链路存在缺口，导致"能跑"但非"开箱即用"：

1. **无 `npm install`** —— 上传后 `node_modules` 缺失，`npm start` 因模块找不到而崩溃；DB 却已标 `running`，要等下次 sync 才暴露。
2. **无构建步骤** —— 需要 `npm run build` 才能运行的应用（编译产物型）无法部署。
3. **`start` 脚本校验缺失** —— `AppManager.validateAppDeployment` 仅检查 `package.json` 存在，不校验 `scripts.start`（与 CLAUDE.md 文档描述不符）。缺 start 脚本时，PM2 启动失败给出的是令人困惑的错误。
4. **无环境变量管理** —— PM2 ecosystem 支持 `env:{}` 但未启用；应用无法接收 `PORT`、API key 等配置。
5. **npm 应用无端口** —— `DeployManager` 仅给 http-server 分配端口；npm 应用自绑端口易冲突，且 Dashboard 上没有可点击的端口 chip。

## 范围

**本轮纳入**：install（同步）、build（可选）、start 脚本校验、自定义 env（DB + UI + 注入）、npm 应用端口分配 + PORT 注入。

**本轮不做**：自动/集成测试（用户自测）；后台任务与进度流；http-server 的 env 注入（范围仅 npm）；env 加密/掩码（本地平台，明文存储）。

## 关键决策

| 决策 | 选择 | 理由 |
|---|---|---|
| install/build 执行模型 | Start 时同步执行 | 不引入后台任务/状态模型；平台定位小型应用，多数 install <30s |
| env 范围 | 完整：DB 存储 + UI 编辑 + PM2 注入 | 完整覆盖 Phase 11"环境变量管理" |
| 端口 | 平台为 npm 应用分配并注入 `PORT` | 与 http-server 一致；Dashboard 出现可点击 chip；避免冲突 |
| 逻辑落点 | 新增 `NpmLifecycle` 服务 | install/build/env 内聚可测；DeployManager 不膨胀；与现有三服务分层一致 |
| env 存储语义 | 整体替换（DELETE + INSERT） | 语义最简，无 upsert 单 key 复杂度 |
| env 编辑器 UI | 独立 `EnvModal` 组件 | AppRow 已偏满；独立文件聚焦 |

## 后端设计

### 1. Schema（`server/src/db/schema.sql`，增量追加）

```sql
CREATE TABLE IF NOT EXISTS app_env (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
  UNIQUE(app_id, key)
);
```

`db.js` 已执行 `PRAGMA foreign_keys = ON`，删除 app 时 env 自动级联删除。`CREATE TABLE IF NOT EXISTS` 保证增量，无需删库。

### 2. DB 查询（`server/src/db/index.js` 追加）

- `getAppEnv(appId)` → `dbAll('SELECT key, value FROM app_env WHERE app_id = ? ORDER BY id', [appId])`，返回 `[{ key, value }]`
- `setAppEnv(appId, entries)` → 事务（`BEGIN` / `COMMIT`，失败 `ROLLBACK`）内先 `DELETE FROM app_env WHERE app_id = ?` 再批量 `INSERT`，保证原子替换。用现有 `dbRun` 顺序 await 即可（sqlite3 单连接按序执行），无需 `db.serialize`。
- 删除走 FK 级联，不另设 query。

### 3. 新服务 `server/src/services/npm-lifecycle.js`

静态方法：

- `readPackageJson(appPath)` → 读 `path.join(appPath, 'package.json')`，`JSON.parse`。缺失抛 `package.json not found`，JSON 损坏抛 `Invalid package.json`。供 AppManager 与本服务共用，避免重复读。
- `install(appPath)` → `execPromise('npm install', { cwd: appPath, timeout: NPM_INSTALL_TIMEOUT_MS })`。超时默认 300000（300s），可由 `NPM_INSTALL_TIMEOUT_MS` 环境变量配置。失败时抛 `npm install failed: <stderr 末尾 500 字>`。
- `build(appPath)` → `readPackageJson` 取 `scripts.build`；存在则 `execPromise('npm run build', { cwd: appPath, timeout: NPM_BUILD_TIMEOUT_MS || 300000 })`，失败抛 `build failed: <stderr 末尾>`；不存在则 no-op 返回。
- `resolveEnv(appId, port)` → `await queries.getAppEnv(appId)`，合并为 `{ PORT: String(port), ...userEnv }`。**PORT 强制**：若 userEnv 含 `PORT`，平台分配值覆盖之（不允许可执行文件绕过平台端口）。

### 4. `AppManager.validateAppDeployment`（加强 npm 分支）

npm 分支改为：
- 存在 `package.json`
- `NpmLifecycle.readPackageJson(appPath)` 成功
- `scripts.start` 为非空字符串

否则返回 `{ valid: false, message: 'Missing start script in package.json' }`（或对应缺失项）。

### 5. `DeployManager.deployApp` 编排

```
const app = await AppManager.getAppById(appId)
const validation = await AppManager.validateAppDeployment(appId)   // 现已校验 start 脚本
if (!validation.valid) throw new Error(validation.message)
if (app.status === 'running') throw new Error('App is already running')

// 端口分配：http-server 与 npm 都分配（npm 新增）
if (!app.port) {
  const port = await ProcessManager.findAvailablePort(min, max)
  await AppManager.updateApp(appId, { port })
  app.port = port
}

if (app.deploy_type === 'npm') {
  await NpmLifecycle.install(app.path)
  await NpmLifecycle.build(app.path)
  const env = await NpmLifecycle.resolveEnv(appId, app.port)
  await ProcessManager.startProcess(app, { env })
} else {
  await ProcessManager.startProcess(app)   // http-server 不变
}

await queries.updateAppStatus('running', appId)
return AppManager.getAppById(appId)
```

### 6. `ProcessManager.startProcess(app, options = {})`

- npm 分支：ecosystemConfig.apps[0] 增加 `env: options.env || {}`。
- http-server 分支：不变（`-p` 端口已够；不注入 env）。
- 抽私有 `writeEcosystemConfig(appPath, name, config)`，消除 npm/http-server 两处重复的"写临时 config + setTimeout 5s 删除"代码。

### 7. 路由（`server/src/routes/index.js`）

- `GET /api/apps/:id/env` → `{ success: true, data: [{ key, value }] }`（明文）
- `PUT /api/apps/:id/env` → body `{ env: [{ key, value }, ...] }`。路由层校验：每个 key 非空且匹配 `/^[A-Za-z_][A-Za-z0-9_]*$/`、无重复。通过则 `AppManager.setAppEnv(id, entries)`（AppManager 转发到 queries）。返回更新后的 env 列表。
- `POST /apps/:id/start` 路由不变；install/build 在 DeployManager 内部。

### 8. 配置（`server/src/config/index.js`）

新增可选项：
- `NPM_INSTALL_TIMEOUT_MS`（默认 300000）
- `NPM_BUILD_TIMEOUT_MS`（默认 300000）

## 前端设计

### 1. `client/src/api/apps.js`

- `startApp(id)` 改为 `api.post(\`/apps/${id}/start\`, {}, { timeout: 0 })` —— 关掉 axios 超时（install/build 可能数分钟）。
- 新增 `getAppEnv(id)` → `GET /apps/:id/env`；`setAppEnv(id, env)` → `PUT /apps/:id/env`（body `{ env }`）。

### 2. `client/src/pages/Dashboard.jsx`

- 新增 `startingId` state（null 或 appId）。`handleStart` 开头 `setStartingId(appId)`，`finally` 清空。
- 传 `startingId` 给 AppRow。

### 3. `client/src/components/AppRow.jsx`

- 接收 `startingId`；`const starting = startingId === app.id`。Start 按钮 `disabled={starting}`，文案切换为 `t('appCard.starting')`。
- 端口 chip 无需改（`app.port` 驱动，npm 分配端口后自动出现）。
- 新增 Env 按钮，仅 `app.deploy_type === 'npm'` 时渲染，打开 EnvModal。

### 4. 新组件 `client/src/components/EnvModal.jsx`

- props：`open`、`onCancel`、`appId`。
- 打开时 `getAppEnv` 加载，渲染 key/value 行（editorial 下划线输入 + 发丝边），支持增删行。
- 保存前前端校验（key 非空、正则、无重复）→ `setAppEnv` → 成功 message + 关闭。
- 底部说明：env 在下次启动时生效（改完需 restart）。
- 复用 `editorial.css` 既有类，必要时加少量 key/value 行样式。

### 5. i18n（`zh.json` / `en.json`）

- `appCard.starting`：启动中… / Starting…
- `appCard.env`：环境变量 / Environment
- `appEnv` 段：`title`、`keyPlaceholder`（如 KEY）、`valuePlaceholder`（如 value）、`addRow`（+ 新增）、`save`、`saveSuccess`、`saveError`、`loadError`、`keyInvalid`、`keyDuplicate`、`applyHint`（"环境变量在下次启动时生效"）

## 数据流

- **启动 npm 应用**：route → `deployApp` → 校验 start 脚本 → 分配端口 → `npm install` → `npm run build`（可选）→ `resolveEnv`（PORT + 用户 env）→ PM2 以 env 启动 `npm start` → DB 标 running。
- **env 编辑**：PUT /env → `setAppEnv`（整体替换）→ DB。env 在 PM2 启动时烘焙；改 env **不热生效，需 restart**（UI 注明）。
- **删除 app**：删 apps 行 → app_env 级联删除。

## 错误处理

| 场景 | 处理 | HTTP |
|---|---|---|
| 缺 `scripts.start` | validateAppDeployment 返回 invalid | 400 `Missing start script in package.json` |
| `npm install` 失败 | 抛带 stderr 末尾的错 | 400 `npm install failed: <tail>` |
| `npm install` 超时 | exec timeout 抛错 | 400 `npm install timed out` |
| `npm run build` 失败/超时 | 同上 | 400 `build failed: <tail>` |
| env key 非法/重复 | 路由层校验 | 400 |
| PM2 启动失败 | 现有路径 | 500 |
| start 请求耗时长 | install/build 期间请求挂起；v1 不做后台任务 | — |

**关键不变式**：install/build 任一失败 → 不启动 PM2、status 保持 stopped。不会出现"DB 标 running 实际崩溃"的老问题。

## 不在本轮范围

- 自动化测试（用户自测；后续可补 Jest + NpmLifecycle 单元测试）
- install/build 进度 SSE 流（同步模型下用户只看到"启动中…"）
- env 加密 / 掩码 / 密钥管理
- http-server 的 env 注入
- 重新 install 的跳过优化（如 node_modules 已新鲜则跳过）—— 每次启动都跑 `npm install`，幂等且正确

## 涉及文件清单

**新增**
- `server/src/services/npm-lifecycle.js`
- `client/src/components/EnvModal.jsx`

**修改**
- `server/src/db/schema.sql`（追加 app_env 表）
- `server/src/db/index.js`（getAppEnv / setAppEnv）
- `server/src/services/app-manager.js`（validateAppDeployment npm 分支 + setAppEnv 转发）
- `server/src/services/deploy-manager.js`（deployApp 编排 + npm 端口分配）
- `server/src/services/process-manager.js`（startProcess env 参数 + writeEcosystemConfig 抽取）
- `server/src/routes/index.js`（GET/PUT env 路由）
- `server/src/config/index.js`（两个超时配置）
- `client/src/api/apps.js`（startApp 超时 + env API）
- `client/src/pages/Dashboard.jsx`（startingId）
- `client/src/components/AppRow.jsx`（Env 按钮 + starting 态）
- `client/src/i18n/locales/zh.json`、`en.json`（env + starting 文案）
- `client/src/styles/editorial.css`（env 行样式，按需）
