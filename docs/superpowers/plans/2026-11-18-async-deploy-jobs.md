# 部署任务异步化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `POST /api/apps/:id/start` 与 `POST /api/apps/:id/git/pull` 里分钟级的 install/build 工作移出 HTTP 请求，改成可查询、可收敛、带日志的后台部署任务。

**Architecture:** 新增 `app_deploy_job`（一行一应用）作为"这个应用最近一次长操作"的共享状态，`DeployJobs` 服务独占它的状态机与日志文件路径；`DeployManager.deployApp` / `GitLifecycle.sync` 的编排语义与可 await 性不变，只多接受 `{ onStep, logFile }` 两个可选回调/路径，异步只发生在路由边界。执行体仍是**起任务的那个 worker 进程内**的 fire-and-forget promise（照 `triggerBackgroundSync` 的形状），进程被杀留下的悬挂由"pid 活性 + 陈旧阈值 + 启动时收敛"三条兜底闭合。

**Tech Stack:** Node.js CommonJS、Express 4、`sqlite3`（异步封装，非 better-sqlite3）、PM2 CLI、React 18 + Vite + antd、`node --test` + supertest。

**Spec:** `docs/superpowers/specs/2026-11-18-async-deploy-jobs-design.md`（本计划的每条决策都引它的"决策 N"）

## Global Constraints

- 不新增任何 npm 依赖；只用仓库里已有的模块。
- 数据库只用 `sqlite3`，`server/src/db/index.js` 里的 `dbRun`/`dbGet`/`dbAll` 全部返回 Promise —— 一律 `await`。
- Schema 只能增量：`CREATE TABLE IF NOT EXISTS`，禁止破坏性变更、禁止删库重建（`server.js` 每次启动重跑 schema）。
- 所有路径拼接用 `path` 模块；不得出现 `/` 或 `\` 字面量拼接。
- 跨平台：pid 存活判断只用 `process.kill(pid, 0)`，不用信号语义；不得假设 POSIX-only 二进制。
- 应用名字符集固定为 `^[A-Za-z0-9_-]{1,64}$`（`utils/validate-app-name.js`），所以 `<app-name>` 可直接用于日志文件名。
- API 响应信封不变：成功 `{ success: true, data }`，失败 `{ success: false, error: { message } }`。
- 新对外文案（HTTP 错误消息、UI 文案）中英双语都要有：i18n key 同时写进 `client/src/i18n/locales/en.json` 与 `zh.json`。
- 测试禁止真的调 PM2：`server/src/test/helpers/setup.js` 已经把 `ProcessManager.pm2Exec` 硬stub 成抛 `ENOENT`，per-test 用 `mock.method` 覆盖。
- 服务层测试**不得**为了异步改断言（决策 7）；只有本计划明列的三条路由契约测试允许改。
- commit message 结尾保留 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- 全量测试命令：`cd server && npm test`（基线 345 pass）；前端：`cd client && npm run lint`。

## Review Focus

规格隐含、但没有任何一个任务的测试天然覆盖的失效模式 —— 每条在括号里标出负责它的任务，实现时必须有对应测试：

1. **陈旧阈值内的死 pid**：worker 崩溃后应用必须**立刻**可再次部署，而不是 409 到 40 分钟为止（Task 2 `isLive`、Task 3 `reconcileOnBoot`、Task 7 路由级）。
2. **绑定 git 的应用在 clone 前目录是空的**：同步前置校验必须跳过它，否则会误报"缺 index.html"（Task 6 的前置检查）。
3. **写状态时应用已被删除**（`ON DELETE CASCADE` 连带删了任务行）：所有任务状态写入必须是静默 no-op，不抛错、不复活行（Task 2）。
4. **日志目录不可写**：部署必须照常跑完，只是没有日志（`logTail` 为空数组），绝不能因为日志失败让部署失败（Task 2 建目录失败 + `tail` 缺失，Task 4 装不上日志不影响安装成功）。
5. **两个 cluster worker 同时抢同一个应用**：只有一个 claim 成功，输家不得创建、删除或截断赢家的日志文件（Task 2 —— 日志文件的创建归 `claim` 所有）。

---

### Task 1: `app_deploy_job` 表与抢锁查询

**Files:**
- Modify: `server/src/db/schema.sql`（文件末尾追加，跟在 `app_git_source` 之后）
- Modify: `server/src/db/index.js`（`queries` 对象内，`// Git-source queries` 分组之前插入新分组）
- Modify: `server/src/config/index.js:60` 附近（`deployment` 块内新增一项）
- Modify: `.env.example`（`NPM_BUILD_TIMEOUT_MS` 之后）
- Test: `server/src/test/unit/deploy-job-claim.test.js`（新建）

**Interfaces:**
- Consumes: 无（本任务是最底层）
- Produces:
  - `config.deployment.deployJobStaleMs: number`（默认 `2400000`）
  - `queries.claimDeployJob({ appId, kind, pid, logPath, staleMs }) -> Promise<boolean>` — `true` = 抢到
  - `queries.getDeployJob(appId) -> Promise<object|null>`（列名 snake_case）
  - `queries.updateDeployJobStep(appId, step) -> Promise<void>`
  - `queries.finishDeployJob(appId, { status, message }) -> Promise<void>`
  - `queries.listNonTerminalDeployJobs() -> Promise<Array>`（`reconcileOnBoot` 的候选集）
  - `queries.getDeployJobsByAppIds(appIds) -> Promise<Array>`（Task 7 附带摘要用，禁止 N+1）
  - 行形状：`{ app_id, kind, status, step, message, log_path, pid, started_at, finished_at }`

- [ ] **Step 1: 写失败测试** —— `deploy-job-claim.test.js`，用 `require('../helpers/setup')` 拿到 `queries`/`dbReady`，`AppManager.createApp` 造应用。断言：

```js
test('claimDeployJob inserts a row on the very first claim (no pre-existing row)', ...)
  // 期望 ok===true，随后 getDeployJob 返回 status='running'、kind 正确、finished_at 为 null
test('claimDeployJob refuses while another live job holds the app', ...)
  // 第一次 claim 成功后立刻再 claim → false，且第二次不得覆盖第一次的 pid/log_path
test('claimDeployJob takes over a terminal job and clears message/finished_at', ...)
  // finishDeployJob({status:'failed',message:'x'}) 后再 claim → true，message 为 null
test('claimDeployJob steals a job older than staleMs', ...)
  // 用 started_at 手工改旧（见 Step 3 的测试钩子），staleMs=1000 → true
test('claimDeployJob does not steal a job inside the stale window', ...)
test('finish/updateStep on a missing row are no-ops that do not throw', ...)
  // 直接 queries.finishDeployJob(999999, {...}) 不抛；对不应用行 updateDeployJobStep 的 changes===0
test('deleting the app cascades the job row away', ...)
  // 建 job → queries.deleteApp(appId) → getDeployJob 返回 null
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test src/test/unit/deploy-job-claim.test.js`
Expected: FAIL — `queries.claimDeployJob is not a function`

- [ ] **Step 3: 实现** —— schema 用规格决策 4 的建表语句原文（注释里写清"一行一应用 + `last_status` 语义 + 为什么不能照抄 `claimGitSync` 的 WHERE"）。
  **对规格的一处偏离（我的判断，不是规格内容）**：`status` 枚举取 `running|succeeded|failed`，去掉规格里写的 `queued` —— claim 成功的那一刻任务就已经在跑，`queued` 会是一个永远没有写入方的死值；"排队中"这层含义由 `step='queued'` 表达。`claimDeployJob` 用决策 4 的 `INSERT ... ON CONFLICT(app_id) DO UPDATE ... WHERE status IN ('succeeded','failed') OR started_at < datetime('now', ?)`，返回 `changes > 0`。陈旧秒数换算照 `claimGitSync`（`db/index.js:241-253`）的 `-${Math.max(1, Math.floor(staleMs/1000))} seconds`。

- [ ] **Step 4: 再跑测试确认通过**（"陈旧窗口"两条测试需要一个把 `started_at` 改旧的手段 —— 直接用 `dbRun("UPDATE app_deploy_job SET started_at = datetime('now','-9999 seconds') WHERE app_id=?")`，不要为测试在生产代码里开口子）

Run: `cd server && node --test src/test/unit/deploy-job-claim.test.js`
Expected: PASS（7 tests）

- [ ] **Step 5: 配置项 + 全量回归 + 提交**

```bash
cd server && npm test
git add server/src/db/schema.sql server/src/db/index.js server/src/config/index.js .env.example server/src/test/unit/deploy-job-claim.test.js
git commit -m "feat(db): add app_deploy_job table and single-flight claim queries"
```

---

### Task 2: `DeployJobs` —— 状态机与日志文件属主

**Files:**
- Create: `server/src/services/deploy-jobs.js`
- Test: `server/src/test/unit/deploy-jobs-state.test.js`（新建）

**Interfaces:**
- Consumes: Task 1 的全部 `queries.*DeployJob*`、`config.deployment.deployJobStaleMs`
- Produces:
  - `DeployJobs.KINDS = { START: 'start', PULL: 'pull' }`
  - `DeployJobs.STEPS = ['queued','validate','git','install','build','launch','proxy','done']`
  - `DeployJobs.LOG_RETENTION = 5`
  - `DeployJobs.logDir() -> string`（`<repoRoot>/data/deploy-logs`）
  - `DeployJobs.claim(app, kind) -> Promise<{ ok: boolean, reason?: 'busy'|'updating', job?: object }>`
    **抢到锁之后**才创建日志文件（`deploy-logs/<app.name>-<epochMs>.log`）并把路径写进 `job.log_path`；
    创建失败时 `log_path` 为 `null` 且**任务照常抢到**（Review Focus 4/5）—— 调用方永远不自己造文件。
  - `DeployJobs.advance(appId, step) -> Promise<void>`（无活跃行时 no-op）
  - `DeployJobs.finish(appId, { ok, message = null }) -> Promise<void>`（`ok` → `succeeded`/`failed` + `finished_at`）
  - `DeployJobs.isLive(job, now = Date.now()) -> boolean`（同步：status 非终态 且 pid 存活 且 未陈旧）
  - `DeployJobs.activeJob(appId) -> Promise<object|null>`（非终态且 `isLive`）
  - `DeployJobs.assertIdle(appId, action) -> Promise<void>`（不空闲则抛 `Error`，`err.status = 409`，消息见下）
  - `DeployJobs.tail(appId, { lines = 200, maxBytes = 65536 }) -> Promise<string[]>`
  - `DeployJobs.pruneLogs(appName, keep = LOG_RETENTION) -> Promise<void>`

- [ ] **Step 1: 写失败测试** —— 断言以下行为（`ProcessManager.pm2Exec` 已由 helper stub，无需再管）：

```js
test('claim creates the log file and advances queued→…→done persisting each step', ...)
test('claim returns busy when a live job holds the app', ...)     // reason==='busy'
test('claim returns updating when a live update.lock is held', ...) // reason==='updating'（复用 UpdateManager.isUpdateRunning，注入 scope 覆盖）
test('advance and finish are silent no-ops when the row vanished', ...)  // Review Focus 3：claim 后手工删应用再 advance/finish 不抛
test('isLive is false for a dead pid even inside the stale window', ...) // Review Focus 1：mock process.kill 抛 ESRCH
test('isLive is false once the stale window passes despite a live pid', ...)
test('assertIdle throws a 409-stamped error naming the current step', ...)
  // err.status===409；message 含 step 名与 kind
test('tail strips ANSI escapes and caps lines and bytes', ...)
test('tail returns [] when the log file does not exist', ...)      // Review Focus 4
test('claim still succeeds with log_path=null when the log directory cannot be created', ...)
  // 把 data/deploy-logs 做成一个普通文件 → ok===true 且 job.log_path===null，不抛（Review Focus 4）
test('a losing claim creates no log file at all', ...)
  // 已有活任务时再 claim → ok===false，且日志目录里没有新文件（Review Focus 5）
test('pruneLogs keeps the newest N and leaves other apps alone', ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test src/test/unit/deploy-jobs-state.test.js`
Expected: FAIL — `Cannot find module '../../services/deploy-jobs'`

- [ ] **Step 3: 实现 `server/src/services/deploy-jobs.js`** —— 单一 class + 模块导出（照 `npm-lifecycle.js` 的形状）。要点：ANSI 剥离与"有界尾巴"从 `update-manager.js:128 readLogTail` 的实现方式取（读尾部字节再切行，**不要**整文件读进内存）；`isPidAlive(pid)` 单独一个私有方法方便测试注入；409 消息固定为 `` `部署进行中（${kind} · ${step}），请等待完成后再${action}` `` 形式，英文在 Task 11 的 i18n 里对应。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --test src/test/unit/deploy-jobs-state.test.js`
Expected: PASS（12 tests）

- [ ] **Step 5: 提交**

```bash
git add server/src/services/deploy-jobs.js server/src/test/unit/deploy-jobs-state.test.js
git commit -m "feat(deploy): add DeployJobs owning job state and log files"
```

---

### Task 3: 启动时收敛悬挂任务

**Files:**
- Modify: `server/src/services/deploy-jobs.js`（新增 `reconcileOnBoot()`）
- Modify: `server/src/server.js:41`（`dbReady.then(...)` 块内，`AuthManager.ensureAdmin()` 之后）
- Test: `server/src/test/unit/deploy-jobs-boot.test.js`（新建）

**Interfaces:**
- Consumes: Task 2 的 `DeployJobs`、Task 1 的 `queries.listNonTerminalDeployJobs()`
- Produces: `DeployJobs.reconcileOnBoot({ now = Date.now(), isPidAlive } = {}) -> Promise<{ converged: number }>`

- [ ] **Step 1: 写失败测试**

```js
test('reconcileOnBoot converges a dead-pid running job to failed with the interruption message', ...)
test('reconcileOnBoot leaves a live job alone (another cluster worker owns it)', ...)
  // pid = process.pid（必然存活）→ status 仍 running，converged===0
test('reconcileOnBoot converges a live-pid job only once it is stale', ...)
test('reconcileOnBoot reports a count and is idempotent when run twice', ...)
```

- [ ] **Step 2: 跑测试确认失败** — Run: `cd server && node --test src/test/unit/deploy-jobs-boot.test.js`；Expected: FAIL — `reconcileOnBoot is not a function`

- [ ] **Step 3: 实现并在 `server.js` 接线** —— 只收敛 `listNonTerminalDeployJobs()` 返回的行，`message` 固定中文 `部署被中断（平台重启）`（Task 11 的前端只显示，不翻译该字符串；与 `[git]` 那些 console 前缀同级）。调用处包 `.catch(err => console.warn(...))`，**启动不能因为收敛失败而死**。

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add server/src/services/deploy-jobs.js server/src/server.js server/src/test/unit/deploy-jobs-boot.test.js
git commit -m "feat(deploy): converge interrupted deploy jobs at boot"
```

---

### Task 4: npm 输出落文件（`NpmLifecycle` 接受 logFile）

**Files:**
- Modify: `server/src/services/npm-lifecycle.js`（`npmExec`、`install`、`build`、`ensureBuilt`）
- Test: `server/src/test/unit/npm-output-capture.test.js`（新建）

**Interfaces:**
- Consumes: Task 2 的 `DeployJobs`
- Produces:
  - `NpmLifecycle.npmExec(args, { cwd, timeout, maxBuffer, logFile })`
  - `NpmLifecycle.install(appPath, { logFile } = {})`、`NpmLifecycle.build(appPath, { logFile } = {})`
  - `NpmLifecycle.ensureBuilt(appId, appPath, { force = false, logFile = null } = {})`

- [ ] **Step 1: 写失败测试**

```js
test('install with logFile streams npm stdout and stderr into the file', ...)
  // 用真实 node -e 造一个假 npm（mock NpmLifecycle.npmExec 不方便测 fd 继承）：
  // 直接测 npmExec —— args 走 process.execPath 时先注入一个可控 runner
test('install without logFile keeps returning stderr in the thrown message', ...)
  // 现有失败摘要行为（500 字符尾巴）不得回退：npm install failed: ... 仍可读
test('a failing install still writes its output to the log file', ...)
test('logFile is passed down from ensureBuilt to install and build', ...)
  // 断言两个被 mock 的方法收到同一个 logFile
test('an unopenable log file degrades to no logging, not a failed install', ...)
  // Review Focus 4
```

- [ ] **Step 2: 跑测试确认失败** — Run: `cd server && node --test src/test/unit/npm-output-capture.test.js`；Expected: FAIL（输出没进文件）

- [ ] **Step 3: 实现** —— 有 `logFile` 时改用 `spawn` + `stdio: ['ignore', fd, fd]`（`fs.openSync(logFile,'a')`，`finally` 里 `closeSync`），保留 `timeout` 与失败时的错误摘要（无 `maxBuffer` 可用，所以错误消息改从日志文件尾巴取，用 `DeployJobs.tail` 之外的本地小函数读最后 N 字节以免反向依赖）。**注意 `DeployJobs → NpmLifecycle` 不得形成 require 环**：读尾巴的函数放 `npm-lifecycle.js` 内部。

- [ ] **Step 4: 跑测试确认通过 + 全量回归** — `cd server && node --test src/test/unit/npm-output-capture.test.js && npm test`；Expected: PASS；全量 345+ 全绿（`npm-deploy-gating.test.js` 那 4 条尤其不能松动）

- [ ] **Step 5: 提交**

```bash
git add server/src/services/npm-lifecycle.js server/src/test/unit/npm-output-capture.test.js
git commit -m "feat(npm): capture install/build output into a job log file"
```

---

### Task 5: 服务层上报进度（不改编排语义）

**Files:**
- Modify: `server/src/services/deploy-manager.js`（`deployApp` 签名 + 现有 lap 点）
- Modify: `server/src/services/npm-lifecycle.js`（`ensureBuilt` 的 `onStep`）
- Test: `server/src/test/unit/deploy-step-reporting.test.js`（新建）

**Interfaces:**
- Consumes: 无新依赖（只加可选参数）
- Produces:
  - `DeployManager.deployApp(appId, { onStep = null, logFile = null } = {})`
  - `NpmLifecycle.ensureBuilt(appId, appPath, { force = false, logFile = null, onStep = null } = {})`
  - 上报顺序固定：`validate → [git] → [install] → [build] → launch → proxy`（方括号按 deploy_type/git 绑定出现）

- [ ] **Step 1: 写失败测试**

```js
test('deployApp reports steps in order for an http-server app', ...)
  // 期望 ['validate','launch','proxy']（无 git、无 install/build）
test('deployApp reports git/install/build for a git-bound npm app', ...)
  // 期望以 'validate' 开头、含 'git','install','build','launch','proxy'，顺序单调
test('deployApp without options behaves exactly as before', ...)
  // 现有全部服务层测试不改断言仍绿（Global Constraints）
test('a throwing onStep does not fail the deploy', ...)
```

- [ ] **Step 2: 跑测试确认失败** — Run: `cd server && node --test src/test/unit/deploy-step-reporting.test.js`；Expected: FAIL（收不到 onStep 调用）

- [ ] **Step 3: 实现** —— 复用已有的 `perf.lap(...)` 位置：lap 之后紧跟一次 `report('install')` 之类的调用（写一个 `const report = (s) => { try { onStep && onStep(s); } catch (_e) {} }` 局部函数），不新增第四处计时代码。

- [ ] **Step 4: 跑测试确认通过 + 全量回归** — Expected: PASS（4 tests）；全量绿

- [ ] **Step 5: 提交**

```bash
git add server/src/services/deploy-manager.js server/src/services/npm-lifecycle.js server/src/test/unit/deploy-step-reporting.test.js
git commit -m "feat(deploy): let deployApp report its progress steps to a caller"
```

---

### Task 6: `POST /apps/:id/start` 改 202 + 同步前置检查

**Files:**
- Modify: `server/src/routes/apps.js:197-243`
- Create: `server/src/services/deploy-runner.js`
- Test: `server/src/test/integration/deploy-async-start.test.js`（新建）

**Interfaces:**
- Consumes: Task 2 的 `DeployJobs.claim`（返回 `job.log_path`）/ `advance` / `finish`；Task 5 的 `DeployManager.deployApp(appId, { onStep, logFile })`
- Produces:
  - `DeployRunner.startBackground(app, kind, job, workFn) -> void`（fire-and-forget；`job` 为 Task 2 `claim` 的返回行，`workFn(ctx)` 收到 `ctx = { report: (step) => void, logFile: job.log_path }`，其中 `report` 内部就是 `(step) => DeployJobs.advance(app.id, step)`；任何异常收敛成 `finish({ok:false})`，绝不产生 unhandled rejection）
  - **命名钉死**：`DeployRunner` 对外只有 `report`，`deployApp`/`sync` 的参数名只有 `onStep`。路由里写 `deployApp(app.id, { onStep: ctx.report, logFile: ctx.logFile })`，不要发明第三个名字。
  - HTTP：`202 { success:true, data:{ app_id, kind, status:'running' } }`；`409`（任务忙 / git claim 忙 / 平台自更新中）；`400`（app 不存在以外的既有 4xx，见 Step 1）；`404`

- [ ] **Step 1: 写失败测试**（`adminAgent()`；`DeployManager.deployApp` 用 `mock.method` 换成可控延迟的假实现）

```js
test('POST /start returns 202 immediately while install is still running', ...)
  // 假 deployApp 挂起 500ms，断言响应在 200ms 内到达且 status===202
test('a second start while the job is live returns 409', ...)
test('already-running app still returns 400 synchronously', ...)
  // mock ProcessManager.getProcessStatus → {exists:true,status:'online'}
test('a static app missing index.html still gets 400 synchronously', ...)
test('a git-bound app does NOT get a synchronous missing-file 400', ...)
  // Review Focus 2：绑定 git 的 http-server 应用，目录为空 → 202（校验在 clone 之后）
test('git claim held by a background sync still yields 409 Update in progress', ...)
test('the job converges to failed with the npm message when deployApp rejects', ...)
test('deployApp rejection never produces an unhandled rejection', ...)
  // 监听 process.on('unhandledRejection') 并在异步收敛后断言没触发
```

- [ ] **Step 2: 跑测试确认失败** — Run: `cd server && node --test src/test/integration/deploy-async-start.test.js`；Expected: FAIL（现在返回 200/400）

- [ ] **Step 3: 实现** —— 路由里先做决策 7 的同步前置（顺序：取应用 → `DeployJobs.assertIdle` → 对账 + already-running → 未绑 git 才 `validateAppDeployment` → `isSyncInProgress` → `claim` → `202` → `startBackground`）。原 `isClientError` 那一长串字符串匹配**保留**给同步前置用，但 install/build/git 类失败从这条路径消失（它们已在后台）。`deploy-runner.js` 独立成文件，因为路由文件已经 660 行，且 webhook 侧未来可复用。

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS（8 tests）

- [ ] **Step 5: 全量回归** — `cd server && npm test`；Expected: 除 `git-start.test.js:378` 外全绿 —— 该测试断言 `POST /start` → 400，克隆失败现在必然进后台。**改它**（决策 7 明列的契约变更）：改成断言 `202` + 轮询到任务 `failed` 且 `message` 含 `git fetch failed`，并在测试名里点明这是契约变更。

- [ ] **Step 6: 提交**

```bash
git add server/src/routes/apps.js server/src/services/deploy-runner.js server/src/test/integration/deploy-async-start.test.js server/src/test/unit/git-start.test.js
git commit -m "feat(api): start returns 202 and runs the deploy as a job"
```

---

### Task 7: 部署中禁止其它写操作（决策 3 的 409 表）

**Files:**
- Modify: `server/src/routes/apps.js`（`stop:245`、`restart:271`、`delete:164`、`upload:444`、`PUT env:612`、`PUT|DELETE default:633/648`、`POST sync:303` 不加）
- Modify: `server/src/routes/git.js`（`PUT:~80`、`DELETE:~140`、`secret:~160`、`check` 不加）
- Test: `server/src/test/integration/deploy-job-guard.test.js`（新建）

**Interfaces:**
- Consumes: Task 2 `DeployJobs.assertIdle` / `activeJob`
- Produces: 上述端点在活跃任务期间统一 `409 { success:false, error:{ message } }`

- [ ] **Step 1: 写失败测试** —— 先手工 `DeployJobs.claim` 造一个活跃任务，然后逐条打：

```js
test.each([stop, restart, delete, put-env, put-default, git-put-bind, git-unbind, git-rotate-secret])
  '<method> on an app with a live deploy job returns 409 naming the step', ...)
test('read endpoints keep working during a live job', ...)
  // GET /apps、GET /apps/:id、GET /apps/:id/files 全 200（部署中还能看东西）
test('POST /apps/:id/sync is intentionally NOT guarded', ...)
  // 钉住这个决定：它只是按 PM2 真相回写 status，与任务不冲突
test('the guard lifts as soon as the job finishes', ...)
  // finish(ok) 后 stop 恢复 200
test('a dead-pid job does not hold the guard', ...)
  // Review Focus 1 的路由级表现：pid=不存在的数 → 写操作放行
```

- [ ] **Step 2: 跑测试确认失败** — Run: `cd server && node --test src/test/integration/deploy-job-guard.test.js`；Expected: FAIL（现在全部 200）

- [ ] **Step 3: 实现** —— 每个受保护 handler 在业务动作之前 `await DeployJobs.assertIdle(app.id, '<动作中文名>')`；错误映射沿用各文件里既有的 `if (error.message === 'Update in progress') return sendError(res, 409, ...)` 形状：新增 `err.status === 409` 的通用分支（`apps.js` 里在 `next(error)` 之前判 `error.status === 409`）。`deleteApp` 的保护必须放在 `AppManager.deleteApp` 之前，否则 CASCADE 会连着任务行一起删（决策 3 的原由）。

- [ ] **Step 4: 跑测试确认通过 + 全量回归** — Expected: PASS（12 tests）；全量绿

- [ ] **Step 5: 提交**

```bash
git add server/src/routes/apps.js server/src/routes/git.js server/src/test/integration/deploy-job-guard.test.js
git commit -m "feat(api): refuse app mutations while a deploy job is live"
```

---

### Task 8: `deploy` 摘要附带 + `GET /api/apps/:id/deploy`

**Files:**
- Modify: `server/src/services/app-manager.js:125-148`（`getAllApps` / `getAppById`）
- Modify: `server/src/routes/apps.js`（新增只读端点）
- Test: `server/src/test/integration/deploy-status-api.test.js`（新建）

**Interfaces:**
- Consumes: Task 1 `getDeployJobsByAppIds`、Task 2 `tail`、Task 3 的收敛结果
- Produces: 应用对象新增 `deploy` 字段：`{ kind, status, step, message, startedAt, finishedAt, live } | null`；
  `GET /api/apps/:id/deploy -> { success:true, data:{ job: <同上>, logTail: string[] } }`

- [ ] **Step 1: 写失败测试**

```js
test('GET /apps attaches deploy=null for an untouched app', ...)
test('GET /apps/:id exposes the live job step', ...)
test('deploy summary survives a terminal job (message shown after failure)', ...)
test('the summary is one query, not one per app', ...)
  // 计数 dbRun/dbGet 调用或预置 3 个应用断言总查询数不随应用数增长
test('GET /apps/:id/deploy returns the bounded ANSI-stripped tail', ...)
test('GET /apps/:id/deploy returns an empty logTail when no log exists yet', ...)  // Review Focus 4
test('GET /apps/:id/deploy on an unknown app is 404', ...)
```

- [ ] **Step 2: 跑测试确认失败** — Run: `cd server && node --test src/test/integration/deploy-status-api.test.js`；Expected: FAIL（无 `deploy` 字段）

- [ ] **Step 3: 实现** —— 附带形状与 `git` 摘要完全对称（`app-manager.js:133` 的 `Promise.all` + Map by id；`toGitSummary` 旁边放一个 `toDeploySummary`），camelCase 输出、`live` 用 `DeployJobs.isLive` 计算。

- [ ] **Step 4: 跑测试确认通过 + 全量回归** — Expected: PASS（7 tests）；全量绿

- [ ] **Step 5: 提交**

```bash
git add server/src/services/app-manager.js server/src/routes/apps.js server/src/test/integration/deploy-status-api.test.js
git commit -m "feat(api): expose deploy job state and log tail to the client"
```

---

### Task 9: `POST /apps/:id/git/pull` 改 202（`kind='pull'`）

**Files:**
- Modify: `server/src/routes/git.js:199-225`
- Modify: `server/src/services/git-lifecycle.js`（`sync`/`runClaimedSync`/`syncAttempt` 接受 `ctx`；`ensureBuilt` 调用点透传 `logFile`/`onStep`）
- Test: `server/src/test/integration/deploy-async-pull.test.js`（新建）
- Modify: `server/src/test/integration/git-routes.test.js:181,188`

**Interfaces:**
- Consumes: Task 2/4/5 与 Task 6 的 `DeployRunner.startBackground`
- Produces: `GitLifecycle.sync(app, { reason, logFile = null, onStep = null } = {})`；`POST .../git/pull -> 202 { app_id, kind:'pull', status:'running' }`

- [ ] **Step 1: 写失败测试**

```js
test('POST /git/pull returns 202 while the sync is still running', ...)
test('a pull while a start job holds the app is 409', ...)
test('pull writes its npm output into the job log file', ...)
  // 决策 8 的透传在 pull 路径也成立（Review Focus：别让日志只有 start 有）
test('app_git_source still owns the outcome: last_status/deployed_commit/last_error', ...)
  // 后台 sync 成功后 git 摘要仍是真相来源，任务行只报进度
test('rollback path still runs and its output lands in the same log', ...)
```

- [ ] **Step 2: 跑测试确认失败** — Run: `cd server && node --test src/test/integration/deploy-async-pull.test.js`；Expected: FAIL

- [ ] **Step 3: 实现** —— 路由与 start 同形状；`GitLifecycle` 的回滚/busy/claim 逻辑一行不动，只把 `ctx` 透到 `ensureBuilt`。**两条既有契约测试按决策 7 改**：`git-routes.test.js:181`（200 + `data.status` → 202 + 之后从 `git.last_status` 读 `success`）、`:188`（400 → 202 + 任务 `failed`，`message` 含原错误）。

- [ ] **Step 4: 跑测试确认通过 + 全量回归** — Expected: PASS；`git-lifecycle-sync.test.js` 的 14 条服务层断言必须**不改**仍绿

- [ ] **Step 5: 提交**

```bash
git add server/src/routes/git.js server/src/services/git-lifecycle.js server/src/test/integration/deploy-async-pull.test.js server/src/test/integration/git-routes.test.js
git commit -m "feat(git): run manual pull as a deploy job"
```

---

### Task 10: 与本体自更新互相挡道（决策 9）

**Files:**
- Modify: `server/src/services/update-manager.js:402+`（`preflight`）
- Modify: `server/src/services/deploy-jobs.js`（`claim` 里的 `reason:'updating'` 接上真实锁）
- Test: `server/src/test/unit/update-deploy-exclusion.test.js`（新建）

**Interfaces:**
- Consumes: `UpdateManager.isUpdateRunning()`（已存在，`update-manager.js:333`）、Task 2 `DeployJobs.activeJob`
- Produces: preflight 拒绝消息 `有应用正在部署（<app> · <step>），请等待完成`；claim 拒绝（`reason:'updating'`）

- [ ] **Step 1: 写失败测试**

```js
test('preflight refuses an update while a deploy job is live', ...)
test('preflight allows the update once the job is dead-pid stale', ...)   // Review Focus 1
test('claiming a deploy job is refused while update.lock is live', ...)
test('claiming succeeds when the lock is stale', ...)
```

- [ ] **Step 2: 跑测试确认失败** — Run: `cd server && node --test src/test/unit/update-deploy-exclusion.test.js`；Expected: FAIL

- [ ] **Step 3: 实现** —— 注意 `deploy-jobs ↔ update-manager` 的 require 方向：`update-manager` 引 `deploy-jobs`（新边），`deploy-jobs` 用**惰性 require**（照 `git-lifecycle.js:13-15` 的 `function db()` 先例）取 `UpdateManager`，避免环。

- [ ] **Step 4: 跑测试确认通过 + 全量回归** — Expected: PASS（4 tests）；自更新那 54 条测试全绿

- [ ] **Step 5: 提交**

```bash
git add server/src/services/update-manager.js server/src/services/deploy-jobs.js server/src/test/unit/update-deploy-exclusion.test.js
git commit -m "feat(update): refuse updates while an app deploy is in flight"
```

---

### Task 11: 前端 —— 202 语义、进度摘要、禁用入口、日志抽屉

**Files:**
- Modify: `client/src/api/apps.js`（`startApp:140`、`pullAppGit:122` 去掉 `timeout: 0`；新增 `getDeployStatus`）
- Modify: `client/src/pages/Dashboard.jsx:53-64`（`handleStart`）
- Modify: `client/src/components/AppRow.jsx:114-150`（状态摘要 + 禁用）
- Create: `client/src/components/DeployLogDrawer.jsx`
- Modify: `client/src/components/GitModal.jsx`（Pull 改提交任务）
- Modify: `client/src/i18n/locales/{en,zh}.json`
- Test: 无 JS 测试框架 → 检查是 `npm run lint` + `npm run build` + Step 5 的手动清单

**Interfaces:**
- Consumes: Task 8 的 `app.deploy` 与 `GET /api/apps/:id/deploy`
- Produces: i18n key `appCard.deploy.<step>`、`appCard.deployFailed`、`appCard.deployLog`、`appCard.deployBusy`、`messages.deployStarted`

- [ ] **Step 1: 实现 api 层** —— `startApp`/`pullAppGit` 不再 `timeout: 0`（202 秒回），新增 `getDeployStatus(id)`。

- [ ] **Step 2: 实现 AppRow** —— `deploy.live` 时状态列显示 `● 部署中 · <step 文案>`，其它写入口 `disabled`（不隐藏，保持列宽稳定，规格决策 6 的草图）；`!live && deploy.status==='failed'` 时行内显示 `✖ message` + 一个"日志"入口。`Dashboard.handleStart` 改成 `await startApp(id)` 后立即 `loadApps(true)`，`startingId` 的清除改由服务端 `deploy.live` 决定（刷新页面也回得来）。

- [ ] **Step 3: 实现 DeployLogDrawer** —— 打开时每 2s 轮询 `GET /api/apps/:id/deploy`，`<pre>` 渲染 `logTail`，任务终态后停止轮询并保留最后一段输出。关闭抽屉必须 `clearInterval`（照 `UpdateModal.jsx:91` 的既有做法）。

- [ ] **Step 4: lint + build**

Run: `cd client && npm run lint && npm run build`
Expected: 0 error（warning 不得新增）；build 成功产出 `client/dist`

- [ ] **Step 5: 手动走查（本地 `npm run dev`）** —— 依次确认：启动 npm 应用后按钮立刻禁用且显示 step；**刷新页面后仍是"部署中"**；失败后行内出现 message 且抽屉里能看到 npm 真实输出；成功 3 分钟后摘要消失；非部署状态一切如旧。

- [ ] **Step 6: 提交**

```bash
git add client/src/api/apps.js client/src/pages/Dashboard.jsx client/src/components/AppRow.jsx client/src/components/DeployLogDrawer.jsx client/src/components/GitModal.jsx client/src/i18n/locales/en.json client/src/i18n/locales/zh.json
git commit -m "feat(client): show deploy job progress and gate actions while deploying"
```

---

### Task 12: 契约文档与验收清单

**Files:**
- Modify: `server/src/docs/openapi.yaml`（`/apps/{id}/start`、`/apps/{id}/git/pull` 响应改 202；新增 `/apps/{id}/deploy`）
- Modify: `CLAUDE.md`（端点清单、新服务 `DeployJobs`/`DeployRunner`、`DEPLOY_JOB_STALE_MS`、"部署中写操作 409"语义、Git-source 段落里 pull 变异步）
- Modify: `docs/manual-verification.md`（新增异步部署冒烟条目）

- [ ] **Step 1: 更新 openapi.yaml** —— 三个端点的 `202` 响应 schema、新 GET 端点；确认 `/openapi.json` 起服务后能加载（`cd server && node -e "require('./src/docs')"` 不抛）。

- [ ] **Step 2: 更新 CLAUDE.md** —— 保持该文件现有风格（一段一条、给出文件名与关键函数名）。必须写进去的三条：任务状态在 SQLite 共享（cluster 语义）、"部署中除只读外一律 409"、"start/pull 是 202，结果从 `app.deploy` 与 `app.git` 读"。

- [ ] **Step 3: 加手动验收条目**（`docs/manual-verification.md`）：真实 npm 应用首次部署全程可见进度；部署中删除被拒；kill 掉 worker 后重启平台 → 任务显示"被中断"且能立即重新部署；pull 失败时日志抽屉里有 npm 原文。

- [ ] **Step 4: 全量回归** — `cd server && npm test`；Expected: 全绿（无 fail）

- [ ] **Step 5: 提交并推送**

```bash
git add server/src/docs/openapi.yaml CLAUDE.md docs/manual-verification.md
git commit -m "docs: document async deploy jobs and their API contract"
git push origin main
```

---

## 已知遗留（本计划**不**解决，实现时不要顺手改）

- **cluster 下端口分配的 TOCTOU**：`deploy-manager.js:20` 的 `createExclusive()` 是进程内锁，而生产是 `instances:'max'` —— 两个 worker 同时给不同应用挑端口仍可能撞上同一个。现有 `getAllClaimedPorts()` 排除集把窗口缩到很小但没消除。修法是 DB 唯一约束 + 重试，属另一件事。
- 上传（`POST /apps/:id/upload`）仍是同步长请求，见规格非目标。
- `DEPLOY_JOB_STALE_MS` 默认 40 分钟是"最坏预算 11 分钟 × 3"的推算值，上线后按真实分布调，不改代码。
