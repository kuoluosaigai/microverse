# 后端自动化测试 + 请求限流 — 设计文档

- **日期**: 2026-07-17
- **状态**: Approved (design)
- **范围**: 后端 `node:test` 单元测试 + `supertest` 集成测试（非 PM2 端点）+ `express-rate-limit` 登录/API 限流。
- **不在范围**: PM2 端点自动测试、前端组件测试、Redis 限流存储、Jest、前端 Error Boundary。

## 背景

PROGRESS.md 技术债列了两项：①"缺少单元/集成测试（目前仅手动测试）"；②"需要添加请求限流"。单管理员登录已暴露在公网端口 5000，而 `POST /api/auth/login` 无任何限流 = 可被爆破。本设计交付最小可行的**后端测试安全网** + **限流**，保护已有功能不被回归、并封住登录爆破面。

## 关键决策（brainstorm 已确认）

1. **范围 = 仅后端**（前端保持手动测试；后端是 bug 风险所在，投入产出比最高）。
2. **不覆盖 PM2 端点**：`start`/`stop`/`restart`/`sync`/`metrics`/`logs/stream` 仍手动验证（ProcessManager 与 PM2 daemon 强耦合，打桩成本高）。
3. **框架 = `node:test`**（Node 18+ 内置，零新运行时依赖；项目已要求 `node >=18`）。
4. **限流**：登录 `5 次/15min/IP`（防爆破）+ 已认证 API `100 次/min/IP`（防滥用），内存存储（单实例单管理员够用）。

## 探查结论（实现前提，已逐条核对源码）

- **app 目录路径硬编码**于 `server/src/utils/path-helper.js#getAppsDir`（L15-17：`path.join(getProjectRoot(), 'apps')`），无 env 覆盖入口 → 需新增 `APPS_DIR` env。使用方：`app-manager.js`、`backup-manager.js`。
- **DB 模块** `server/src/db/index.js`：L6 **直接**读 `process.env.DB_PATH`（**不经 config**）；加载时 `initDatabase()` 读 `schema.sql` 建表（全 `CREATE TABLE IF NOT EXISTS`）；导出 `{ db, queries, dbReady }`。`queries` 含测试所需方法（`getAllApps`/`getAppById`/`getAppByName`/`createApp`/`deleteApp`/`getAppEnv`/`setAppEnv`/`getUserCount`/`getUserByUsername`/`createUser` 等）。
  - 因此测试 env 必须在 **require `server/src/db`（或传递性引入它的 `app.js`/`app-manager`/`auth-manager`）之前**设置；`config/index.js:5` 的 `dotenv.config()` 默认**不覆盖已存在的 `process.env`**，故先设 env 再 require 是安全的。
- **端口助手**：`ProcessManager.isPortAvailable(port)`（static，L292）、`findAvailablePort(minPort, maxPort, { exclude })`（static，L303，接受 exclude 集合）、`probeBind`（L271）均纯 `net`、**不依赖 PM2 daemon**，可直接单测。
- **零现有测试基建**：`server/**/*.test.js` / test 目录 / jest·vitest·mocha 配置均为 0；`server/package.json` 无 `test` 脚本，且**无 `devDependencies` 字段**。
- **SSE 在 `requireAuth` 之后注册**（`routes/index.js` L363，分界 L76），全局 `apiLimiter` 会命中它 → 须用 `skip` 显式排除 `/logs/stream`。
- **ProcessManager 用 `child_process.exec` 跑 `pm2 ...`，不在模块加载时连 daemon** → 测试 `import createApp` 安全，只有真正命中 start/stop 才碰 PM2。

## 架构

### 测试两层

**Layer A — 纯逻辑单元测试**（`server/src/test/unit/`，无 DB/PM2）
- `port-allocation.test.js`：`isPortAvailable`（空闲端口 → true；自占端口 → false）、`findAvailablePort`（区间首个空闲、`exclude` 跳过已占用、区间满 → 抛 `No available ports in range`）。
- `zip-slip.test.js`：提取出的 `isSafeEntry(root, entryName)`（entry 绝对路径须落在 root 内；越界返回 false）。
- `env-validation.test.js`：提取出的 `validateEnvEntries(entries)`（合法 key 通过；非法字符 / 重复 key 返回错误）。
- `backup-manifest.test.js`：`BackupManager` 的 manifest 序列化 + name/deploy_type 校验路径（纯逻辑部分）。

**Layer B — API 集成测试**（`server/src/test/integration/`，`supertest` + 临时 DB）
- `health-config.test.js`：`GET /health`、`GET /config`（公开，无需登录）。
- `apps-crud.test.js`：`POST /apps`（创建 / 缺字段 400 / 重复名 400）、`GET /apps`、`GET /apps/:id`、`DELETE /apps/:id`（404 / running 时 400）。
- `auth.test.js`：`POST /auth/login`（缺字段 400 / 错误凭据 401 / 正确凭据 200 且种 session）、`GET /auth/me`（未登录 401 / 登录后返回 user）、`POST /auth/logout`。
- `env.test.js`：`GET/PUT /apps/:id/env`（非法 key 400 / 重复 key 400 / 404 / 正常替换）。
- `backup-restore.test.js`：`GET /apps/:id/backup`（zip 下载）、`POST /apps/restore`（201 / 同名冲突 400 / 非法 zip 400）。
- `rate-limit.test.js`：
  - login 连发 `max+1`（6）次 → 第 6 次 429（同 IP，supertest 默认 127.0.0.1）。
  - 已认证 API 连发 `max+1`（101）次 → 第 101 次 429（in-process，毫秒级）。
  - **SSE 豁免**：先用普通端点打满 API 限额（触发 429），再以已登录 agent 请求 `/apps/9999/logs/stream`（不存在的 app）→ 返回 **404 而非 429**，证明 `skip` 放行（绕开 PM2：404 来自 `getAppById`，仅在 limiter 放行后才到达）。

### 必要的最小重构（seams）

1. **`app.js` 拆分** — 抽出 `createApp()` 返回 express 实例（**不 listen、不启 `metricsSampler`、不 `ensureAdmin`、不发 nginx probe、不注册 SIGTERM/SIGINT**）；新建 `server/src/server.js` 作为入口（`createApp()` + `app.listen` + `metricsSampler.start()` + `dbReady.then(ensureAdmin)` + nginx probe + 信号处理）。
   - 动因：当前 `app.js` 模块加载即 listen 并启动后台任务，`supertest` 无法 import；这是 Express 测试标准拆法。
   - `package.json` 的 `dev`/`start` 改指 `src/server.js`；启动行为与原 `app.js` 完全一致，dev/start 不回归。
2. **`APPS_DIR` env** — `utils/path-helper.js#getAppsDir` 改为 `process.env.APPS_DIR || path.join(getProjectRoot(), 'apps')`。同步 `.env.example` 注释项。仅此一处改动，`app-manager.js` 无需动。
3. **提取纯函数到 `server/src/utils/`**（顺带消除路由内联、提升可读性 + 可测性）：
   - `validate-zip.js`：`isSafeEntry(root, entryName)` —— 从上传路由（`routes/index.js` L513–520 内联逻辑）提取，路由改调用之。
   - `validate-env.js`：`validateEnvEntries(entries)` —— 从 PUT env 路由（L592–608 内联逻辑）提取，路由改调用之。

### 测试基础设施

- **`server/src/test/helpers/setup.js`**：在每个测试文件**第一行** require。它：
  - 在 require 任何业务模块**之前**设置 `process.env.DB_PATH` / `APPS_DIR` / `ADMIN_USERNAME` / `ADMIN_PASSWORD` 指向 `os.tmpdir()/microverse-test-<pid>/` 下每进程独立子目录（一个临时 sqlite + 一个临时 apps 目录）。
  - 导出：`createApp`（重构后）、`request`（绑定到 createApp 的 supertest agent）、`queries` / `dbReady`、`loginRequest(agent, ...)`（登录并保留 session cookie 的辅助）、`resetTables()`（清 apps/app_env，便于 beforeEach）。
- **隔离**：`node --test` 默认每个测试文件独立子进程 → 文件级隔离，无跨文件模块缓存；文件内用 `beforeEach` 清表或用唯一 app name 避免串。

## 限流设计

### 新增 `server/src/middleware/rate-limit.js`

```js
const rateLimit = require('express-rate-limit');

// 登录防爆破
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { message: 'Too many login attempts, try again later' } }
});

// 已认证 API 防滥用（豁免 SSE 长连接）
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.endsWith('/logs/stream'),
  message: { success: false, error: { message: 'Too many requests, slow down' } }
});

module.exports = { loginLimiter, apiLimiter };
```

### 挂载（`routes/index.js`）

- `loginLimiter`：仅作用于 `POST /auth/login`（L46，公开段）—— 作为该路由的中间件前置。
- `apiLimiter`：挂在 `router.use(requireAuth)`（L76）**之后**，覆盖全部鉴权端点；`skip` 已排除 SSE。
- **store**：默认内存（单实例、单管理员）；重启重置可接受。多实例部署再换 store（YAGNI）。

### 429 响应

沿用统一 `{ success:false, error:{ message } }`（上面 `message` 已对齐），前端 `message.error` 无需改动即可显示。

## 依赖与脚本

- **新增 `server` 生产依赖**：`express-rate-limit`。
- **新增 `server` devDependency**：`supertest`（仅测试）。`node:test` + `node:assert` 内置，无新运行时依赖。
- **`server/package.json`**：`dev`/`start` 改为 `node src/server.js`；新增 `"test": "node --test src/test/"`。
- **根 `package.json`**：新增 `"test": "npm test --workspace=server"`。

## 覆盖矩阵

| 端点 / 逻辑 | 测试方式 |
|---|---|
| `GET /health` · `GET /config` | 集成 |
| apps CRUD · `files` · `env` GET/PUT | 集成 |
| `auth/login` · `auth/me` · `auth/logout` | 集成（含限流） |
| `backup` · `restore` | 集成 |
| 限流（login / API / SSE 豁免） | 集成 |
| 端口分配 · zip-slip · env 校验 · manifest | 单元 |
| `start`/`stop`/`restart`/`sync`/`metrics`/`logs/stream` | 手动（PM2） |

## 错误处理 / 边界

- 限流命中 → 429 + 统一 JSON。
- SSE 豁免 → 长连接不被误限、不挤占普通 API 配额。
- 测试 DB 隔离 → 每进程独立临时 sqlite，schema 自动建表；落 `os.tmpdir` 无需手动清理。
- `createApp` 重构后 `server.js` 启动序列与原 `app.js` 严格一致（listen → metricsSampler → ensureAdmin → nginx probe + 信号），保证 dev/start 不回归。

## 已知限制 / 范围外

1. PM2 端点无自动测试（手动）；端口分配的 DB 部分（`getAllClaimedPorts`）可测但不在本范围强求。
2. 内存限流存储重启重置；多实例部署需换 store（单实例 YAGNI）。
3. 不引入 TypeScript / Error Boundary / Redis / Jest。
4. `CLAUDE.md`（根）L101 的 path 示例（`path.join(__dirname,'apps',name)`）与真实实现（`projectRoot/apps`）不一致——属既有文档漂移，本特性不动它，实现以代码为准。

## 改动面 checklist（实现时用）

**后端 — 重构 seams**
- MOD `server/src/app.js` — 拆出 `createApp()`，移除 listen/bootstrap
- NEW `server/src/server.js` — 入口（createApp + listen + metricsSampler + ensureAdmin + nginx probe + SIGTERM/SIGINT）
- MOD `server/src/utils/path-helper.js` — `getAppsDir` 读 `APPS_DIR` env
- NEW `server/src/utils/validate-zip.js` — `isSafeEntry`
- NEW `server/src/utils/validate-env.js` — `validateEnvEntries`
- MOD `server/src/routes/index.js` — 上传处用 `isSafeEntry`；PUT env 用 `validateEnvEntries`；挂 `loginLimiter` + `apiLimiter`
- NEW `server/src/middleware/rate-limit.js`
- MOD `server/package.json` — dev/start → `src/server.js`；+ `test` 脚本；+ `express-rate-limit` dep；+ `supertest` devDep
- MOD `.env.example` — + `APPS_DIR` 注释项

**测试**
- NEW `server/src/test/helpers/setup.js`
- NEW `server/src/test/unit/{port-allocation,zip-slip,env-validation,backup-manifest}.test.js`
- NEW `server/src/test/integration/{health-config,apps-crud,auth,env,backup-restore,rate-limit}.test.js`

**根**
- MOD `package.json` — + `"test": "npm test --workspace=server"`

**文档**
- MOD `PROGRESS.md` — Phase 15 勾选"请求限流"（新增条目）；技术债勾选"单元/集成测试"（标记部分完成）+ 移除"请求限流"项
- MOD `README.md` — 加 "Run tests" 一句
- MOD `server/src/docs/openapi.yaml` —（可选）给 login + 鉴权端点补 429 响应

**验证（端到端）**
- `npm run install:all`（装 supertest + express-rate-limit）
- `npm test`（根）→ 全绿；单测秒级、集成测试用临时 DB
- `npm run dev` 手动冒烟：登录、创建 app、上传、备份/恢复、故意连点登录 6 次 → 第 6 次 429
