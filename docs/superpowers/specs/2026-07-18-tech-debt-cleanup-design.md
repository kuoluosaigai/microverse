# 技术债清扫 — 设计文档

- **日期**: 2026-07-18
- **状态**: Approved (design)
- **范围**: 四项遗留技术债——应用名校验、TOCTOU 端口竞态、nginx 日志接入 LogManager、前端 Error Boundary。
- **不在范围**: Windows 双栈端口探测盲区（YAGNI，对平台托管 app 无影响）、`MAX_FILE_SIZE` 同步（config 默认值与 `.env.example` 已一致，无需动作）、数据库迁移系统、批量操作、CLI 等更大的 Phase 15 收尾项。

## 背景

PROGRESS.md 的"技术债"清单共 6 项。逐条核源码后，2 项为伪命题/已解决、4 项有真实价值。本设计交付那 4 项，全部为小到中型改动，互不依赖，可独立实现与测试。

## 关键决策（brainstorm 已确认）

1. **范围 = 4 项**：应用名校验、TOCTOU 端口竞态、nginx 日志、Error Boundary。前两项是安全/正确性，后两项是可观测性/健壮性。
2. **SQL 注入是伪命题**：所有查询走参数化 `?` 占位符（见 `db/index.js`），真正的安全洞是**应用名未校验**——name 流入文件系统路径、nginx 配置文件名、PM2 进程名。
3. **应用名校验放应用层，不放 schema CHECK**：`schema.sql` 用 `CREATE TABLE IF NOT EXISTS`，对既有库不生效（项目无迁移系统）；故统一在 `AppManager.createApp` + `validateManifest` 强制，DB 仅保留 `UNIQUE`。
4. **TOCTOU 用进程内 mutex，只锁端口分配临界区**：单实例单管理员场景，进程内串行化足够；不锁整个 `deployApp` 以免 `npm install`（可能数分钟）阻塞后续 deploy。
5. **nginx 日志按 deploy_type 分流**：`LogManager.getLogPaths` 收 app 对象而非 appName，nginx 返回 app 目录下的 `nginx-*.log`。
6. **Error Boundary 顶层 + 每页**：一个可复用 `<ErrorBoundary>` 组件，`compact` 变体用于页内降级；顶层兜底整页、每页兜底单页，单页崩溃不拖垮整个会话。

## 探查结论（实现前提，已逐条核对源码）

### 应用名
- **后端无校验**：`AppManager.createApp`（`app-manager.js` L17–47）只检查 `name` 非空 + `deployType` 在枚举内，**无格式/长度校验**。
- **前端已有部分校验**：`CreateApp.jsx` L48–51 已有 `{ pattern: /^[a-zA-Z0-9-_]+$/ }`，但**无长度上限**。
- **name 的下游用途**（注入面）：
  - 文件系统路径 `apps/<name>`（`pathHelper.getAppDir`）→ 路径穿越（`../foo`）。
  - nginx 配置文件名 `nginx.<name>.conf`（`nginx-lifecycle.js` L38）+ 配置体 `server_name`/root 无关，但文件名含空格/特殊字符会坏。
  - PM2 进程名 = `app.name`（`process-manager.js`）→ 含空格/分号可能干扰 `pm2 ... <name>` 子命令。
- **restore 覆盖**：`BackupManager.restoreBackup` → `AppManager.createApp(manifest.name, ...)`（L72）。校验放进 `createApp` 则 restore 自动覆盖；额外在 `validateManifest` 早失败（创建前）更稳。
- **DB**：`apps.name TEXT NOT NULL UNIQUE`（`schema.sql` L6），无格式 CHECK；既有库不会因改 schema 而生效，故不依赖它。

### TOCTOU
- **临界区**：`deploy-manager.js` `deployApp` L34–43——`getAllClaimedPorts()` 读 → `findAvailablePort(...)` 选 → `updateApp(appId,{port})` 写。两次并发 `deployApp`（两个无端口 app 同时 start）可读到同一 claimed 集合、选到同一端口。
- **现有兜底**：`findAvailablePort` 的 `exclude` 已排除 DB 已占用端口，但**不含本次并发尚未写回的端口**——正是 TOCTOU。
- **概率**：低（用户驱动 + PM2 启动慢），但修复成本极低，值得做。

### nginx 日志
- **现状**：`LogManager.getLogPaths(appName)`（`log-manager.js` L22）只解析 PM2 的 `pm_out_log_path`/`pm_err_log_path`。nginx 以 `daemon off;` 经 PM2 托管时，PM2 只能捕获其前台输出（启动/致命错误）；运行时的 access/error 写到 nginx 配置里指定的 `<app>/nginx-access.log` 与 `<app>/nginx-error.log`（`nginx-lifecycle.js` L46–53），LogManager 看不见。
- **后果**：nginx app 的日志页几乎为空，只有启动报错。
- **路由侧**：SSE 路由（`routes/index.js` logs/stream）已经 `getAppById` 拿到完整 app 对象，可直接透传给 `getLogPaths`。

### Error Boundary
- **现状**：`main.jsx` 在 `StrictMode`/`BrowserRouter` 内直接渲染 `<App/>`；`App.jsx` 无任何错误边界。任何页面 render 抛错 → 整个 React 树卸载 → 白屏。
- **约束**：React 错误边界必须是 class 组件。
- **放置**：顶层边界包在 `App.jsx` 的 `<Routes>` 外、`ConfigProvider` 内（兜底页吃到 antd 主题/locale）；每页边界包在各 page 组件外（`Dashboard`/`CreateApp`/`UploadFiles`/`AppLogs`/`AppMetrics`）。

## 架构

### 1. 应用名校验

**新增** `server/src/utils/validate-app-name.js`（纯函数，可单测）：
```js
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
// validateAppName(name) -> string|null  (返回错误文案 key 或 null)
```
- 字符集 = 字母数字 + `_` + `-`（对齐 README 与前端既有 pattern）。
- 长度 1–64（目录名、PM2 进程名、nginx 配置文件名均绰绰有余）。

**挂载点**：
- `AppManager.createApp(name, deployType)`：在现有非空/枚举校验之后加 `validateAppName`，不通过 → throw（路由映射 400）。**这一处同时覆盖 create 与 restore**（restore 走 createApp）。
- `utils/validate-manifest.js` `validateManifest`：加同名校验，使 restore 在**创建 app 之前**就失败（更干净的回滚）。
- 前端 `CreateApp.jsx`：pattern 规则补 `{ max: 64 }`（antd `rules` 加一条 max），文案补"最长 64 字符"。

**错误映射**：沿用路由层现有模式——service throw → route catch → 400 + `{ success:false, error:{ message } }`；前端 `CreateApp` 已有 `message.error(error.response?.data?.error?.message ...)` 兜底。

### 2. TOCTOU 端口竞态

**实现**：`deploy-manager.js` 模块级极简 promise 链串行化（不引依赖）：
```js
let chain = Promise.resolve();
// task 串行执行：下一次调用等上一次（无论成败）结束才开始。
function runExclusive(task) {
  const run = chain.then(task, task);    // 同一 fn 作 onFulfilled/onRejected → 只调用一次
  chain = run.then(() => {}, () => {});  // 吞掉错误，保证链不断、不污染下次
  return run;
}
```
临界区包法：
```js
if (!app.port) {
  app.port = await runExclusive(async () => {
    const claimed = (await queries.getAllClaimedPorts()).map(r => r.port);
    const p = await ProcessManager.findAvailablePort(
      config.deployment.portRangeMin, config.deployment.portRangeMax,
      { exclude: claimed }
    );
    await AppManager.updateApp(appId, { port: p });
    return p;
  });
}
```
**只锁这一段**；`npm install`/`build`/`startProcess` 仍在锁外（它们不竞态端口）。

**行为**：并发 `deployApp` 在端口分配处排队；选到端口写库后释放，下一个进来时 `getAllClaimedPorts` 已能看到刚写入的端口。PM2 启动慢不再是竞态来源。

**边界**：锁是进程内的（单实例足够）；锁内不 await 任何慢操作，持锁时间为毫秒级。

### 3. nginx 日志接入 LogManager

**签名变更**：`LogManager.getLogPaths(appName)` → `getLogPaths(app)`（`app` = `{ name, deploy_type, path }`）。
```js
static async getLogPaths(app) {
  if (app.deploy_type === 'nginx') {
    const dir = app.path;
    const access = path.join(dir, 'nginx-access.log');
    const error  = path.join(dir, 'nginx-error.log');
    return {
      outPath: fs.existsSync(access) ? access : null,  // access → 普通/out 级别
      errPath: fs.existsSync(error)  ? error  : null,  // error  → 红色/err 级别
    };
  }
  // 非 nginx：原 PM2 逻辑（用 app.name）
  ...
}
```
- access_log → out 级别（正常色），error_log → err 级别（红色），沿用现有 SSE 双流语义。
- **调用方**：`routes/index.js` logs/stream 路由把 `getLogPaths(app.name)` 改为 `getLogPaths(app)`。
- `readHistory` / `createTailer` 不变（它们按 filePath 工作，与 deploy_type 无关）。

### 4. 前端 Error Boundary

**新增** `client/src/components/ErrorBoundary.jsx`（class 组件）：
- props：`children`、可选 `compact`（true = 页内小卡片；false/默认 = 整页）。
- `static getDerivedStateFromError` → 置 `hasError`。
- `componentDidCatch` → `console.error`（生产可扩展上报，YAGNI 暂不上报）。
- 兜底 UI（editorial 风格，serif 标题）：
  - 整页：`<EditorialShell>` 包一个居中块——标题 `t('error.boundary.title')`（"出错了 / Something went wrong"）+ 文案 + "Reload" 按钮（`location.reload()`）；`import.meta.env.DEV` 下用 mono 块显示 `error.stack`。
  - compact：页内卡片——一行文案 + "返回 Dashboard"（`navigate('/')`）+ "Reload"。
- 需要 i18n key：`error.boundary.title` / `.description` / `.reload` / `.back`（加入 `locales/{zh,en}.json`）。

**挂载**：
- 顶层：`App.jsx` 在 `<ConfigProvider>` 内、`<AuthProvider>` 外（或内，二者皆可；放 `ConfigProvider` 直接到子）包一个 `<ErrorBoundary>` 整页兜底——建议包在 `<Routes>` 外。
- 每页：5 个 page 组件各自的 `element={<X/>}` 改为 `element={<ErrorBoundary compact><X/></ErrorBoundary>}`（或包在 `RequireAuth` 的 `<Outlet/>` 处统一包一层——但 per-page 更精确）。实现时取更简洁的一种：在 `App.jsx` 路由表里包。

## 错误处理 / 边界

- 应用名校验：非法名 → 400 + 统一错误体；restore 同名/非法 manifest → 400（已有路径，新增名格式失败同样 400，回滚不变）。
- TOCTOU 锁：锁内抛错（如端口区间满）正常向上传播，`portAllocChain.catch(()=>{})` 保证链不断、不污染下一次。
- nginx 日志：app 目录下无 `nginx-*.log`（app 从未启动过）→ 返回 `{outPath:null, errPath:null}`，SSE 只推空历史，不报错。
- Error Boundary：兜底页本身避免依赖可能崩的上下文（用纯 HTML + editorial class，不强依赖 antd 组件树）；`componentDidCatch` 吞错不重抛，避免循环。

## 测试

**后端单元（`server/src/test/unit/`，沿用 node:test）**：
- `app-name-validation.test.js`：`validateAppName` —— 合法名（`my-app`、`app_1`、`A`）/ 非法名（空、`../x`、`a b`、`a;b`、65 字符、`a.b`）/ 边界（正好 64 字符合法、65 非法）。
- TOCTOU：纯逻辑的 `runExclusive` 串行性可单测（并发触发 N 次，断言临界区互斥）。

**后端集成（`server/src/test/integration/`，supertest + 临时 DB）**：
- `apps-crud.test.js` 扩展：`POST /apps` 非法名 → 400（`../x`、`a b`、超长）。
- `backup-restore.test.js` 扩展：manifest name 非法 → 400（早失败，不创建 app）。

**前端**：手动验证（沿用项目"前端手动测试"约定）——Error Boundary：临时在某 page throw → 看到页内卡片而非白屏；非法名输入 → 前端即时拦截。

**手动端到端**：
- 应用名：`curl POST /api/apps -d '{"name":"../pwn"}'` → 400。
- TOCTOU：两个无端口 app 并发 `start` → 端口不重复（PM2 手动）。
- nginx 日志：起一个 nginx app，访问其端口产生 access 日志 → 日志页能看到 access 行（PM2 手动）。
- Error Boundary：dev 下在某 page 临时 throw → compact 卡片；顶层 throw → 整页兜底。

## 已知限制 / 范围外

1. 不加 schema 层 CHECK 约束（无迁移系统，对既有库无效）；DB 仅靠 `UNIQUE` + 应用层校验。
2. TOCTOU 锁为进程内，多实例部署需换分布式锁（单实例 YAGNI）。
3. Error Boundary 不捕获事件处理器里的错误（React 限制；那些已被各页面的 try/catch + `message.error` 覆盖）。
4. nginx 日志只接 access/error 两个固定文件；若未来 nginx 配置改日志路径，需同步 `LogManager`。
5. 不引入 TypeScript / 前端组件测试框架。

## 改动面 checklist（实现时用）

**后端**
- NEW `server/src/utils/validate-app-name.js` — `validateAppName`
- MOD `server/src/services/app-manager.js` — `createApp` 调 `validateAppName`
- MOD `server/src/utils/validate-manifest.js` — `validateManifest` 调 `validateAppName`
- MOD `server/src/services/deploy-manager.js` — 端口分配临界区进 `runExclusive` 串行
- MOD `server/src/services/log-manager.js` — `getLogPaths(app)` 按 `deploy_type` 分流
- MOD `server/src/routes/index.js` — logs/stream 路由传 `app` 对象

**前端**
- NEW `client/src/components/ErrorBoundary.jsx` — class 组件 + `compact` 变体
- MOD `client/src/App.jsx` — 顶层边界 + 每页 `compact` 包裹
- MOD `client/src/pages/CreateApp.jsx` — name 规则加 `{ max: 64 }`
- MOD `client/src/i18n/locales/{zh,en}.json` — `error.boundary.*` keys + createApp 长度提示

**测试**
- NEW `server/src/test/unit/app-name-validation.test.js`
- MOD `server/src/test/unit/` — TOCTOU `runExclusive` 串行性单测（或并入 deploy 相关测试）
- MOD `server/src/test/integration/apps-crud.test.js` — 非法名 400
- MOD `server/src/test/integration/backup-restore.test.js` — 非法 manifest name 400

**文档**
- MOD `PROGRESS.md` — 技术债勾选这 4 项；变更日志加 `[Unreleased] — 2026-07-18` 条目

**验证（端到端）**
- `npm test`（根）→ 全绿（含新增 app 名单测 + 集成断言）
- `npm run dev` 手动冒烟：非法名被前后端双拦、Error Boundary 兜底、nginx app 日志可见、并发 start 端口不撞
