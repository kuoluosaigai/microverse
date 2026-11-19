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
- Modify: `server/src/db/index.js`（给 `updateDeployJobStep` / `finishDeployJob` 加 **owner fencing**：WHERE 追加 `AND pid = ?`）
- Test: `server/src/test/unit/deploy-jobs-state.test.js`（新建）
- Test: `server/src/test/unit/deploy-job-claim.test.js`（补 fencing 两条断言）

**Interfaces:**
- Consumes: Task 1 的全部 `queries.*DeployJob*`、`config.deployment.deployJobStaleMs`
- Produces:
  - `DeployJobs.KINDS = { START: 'start', PULL: 'pull' }`
  - `DeployJobs.STEPS = ['queued','validate','git','install','build','launch','proxy','done']`
  - `DeployJobs.LOG_RETENTION = 5`
  - `DeployJobs.logDir() -> string`（`<repoRoot>/data/deploy-logs`）
  - `DeployJobs.claim(app, kind) -> Promise<{ ok: boolean, reason?: 'busy'|'updating'|'gone', job?: object }>`
    **抢到锁之后**才创建日志文件（`deploy-logs/<app.name>-<epochMs>.log`）并把路径写进 `job.log_path`；
    创建失败时 `log_path` 为 `null` 且**任务照常抢到**（Review Focus 4/5）—— 调用方永远不自己造文件。
    **抢锁查询抛错时按"没抢到"处理**：`SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT` → `{ ok:false, reason:'busy' }`；
    其它错误照常上抛（不能把真的 DB 故障伪装成"别人在部署"）。
    注意事实校正：node-sqlite3 的绑定**自带隐式 1000ms busy handler**（不是"完全没设"），
    所以争用时已经是"等 1 秒再抛"；`PRAGMA busy_timeout = 5000` 只是把这个既有等待放宽，
    捕获 `SQLITE_BUSY` 才是真正兜住这条路径的东西。
  - `DeployJobs.advance(appId, step) -> Promise<void>`（无活跃行时 no-op；只写自己 pid 的行）
  - `DeployJobs.finish(appId, { ok, message = null }) -> Promise<void>`（`ok` → `succeeded`/`failed` + `finished_at`；
    同样带 pid fencing）
  - `DeployJobs.pid` 概念：**fencing 的期望 pid 由 `DeployJobs` 内部用 `process.pid` 提供**，不进入调用方可见的签名
  - `DeployJobs.isLive(job, now = Date.now()) -> boolean`（同步：status 非终态 且 pid 存活 且 未陈旧）
  - `DeployJobs.activeJob(appId) -> Promise<object|null>`（非终态且 `isLive`）
  - `DeployJobs.assertIdle(appId, action) -> Promise<void>`（不空闲则抛 `Error`，`err.status = 409`，消息见下）
  - `DeployJobs.tail(appId, { lines = 200, maxBytes = 65536 }) -> Promise<string[]>`
  - `DeployJobs.pruneLogs(appName, keep = LOG_RETENTION) -> Promise<void>`

- [ ] **Step 0: 先写 fencing 与 busy 的失败测试**（Task 1 审查提出的两个真实缺口，不补就等于把
  "陈旧任务被偷走后原任务还在跑"的收尾权交给上一个主人，并把签名承诺的 `Promise<boolean>` 留在争用下会破的谎上）：

```js
test('finishDeployJob by a foreign pid does not terminate the current owner\'s job', ...)
  // A claim（pid=process.pid）→ 手工把行 pid 改成别的数模拟"被偷"→ 用原 pid 调 finish → 行仍 running
test('updateDeployJobStep by a foreign pid changes nothing', ...)
test('the db connection is opened with a busy_timeout so a contended writer waits instead of throwing', ...)
  // 读回 `PRAGMA busy_timeout`，断言 **>= 5000**：驱动自带 1000ms，所以"非 0"是不改代码也会绿的假绿灯
```

- [ ] **Step 1: 写失败测试** —— 断言以下行为（`ProcessManager.pm2Exec` 已由 helper stub，无需再管）：

```js
test('claim creates the log file and advances queued→…→done persisting each step', ...)
test('claim returns busy when a live job holds the app', ...)     // reason==='busy'
test('claim returns busy when the claim query throws SQLITE_BUSY', ...)
  // mock queries.claimDeployJob 抛 {code:'SQLITE_BUSY'} → {ok:false,reason:'busy'}，且不创建日志文件
test('claim rethrows an unrelated DB failure', ...)
  // mock 抛 {code:'SQLITE_CANTOPEN'} → 断言 claim 也抛（不得伪装成 busy）
test('claim returns updating when a live update.lock is held', ...) // reason==='updating'（复用 UpdateManager.isUpdateRunning，注入 scope 覆盖）
test('advance and finish are silent no-ops when the row vanished', ...)  // Review Focus 3
test('isLive is false for a dead pid even inside the stale window', ...) // Review Focus 1：mock process.kill 抛 ESRCH
test('isLive is false once the stale window passes despite a live pid', ...)
test('assertIdle throws a 409-stamped error naming the current step', ...)
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
Expected: PASS（17 tests = Step 0 的 3 条 + Step 1 的 14 条；此处原写 12 是我数漏了 Step 0）

- [ ] **Step 5: owner fencing + busy 等待（Task 1 审查提出的两个缺口）**
  1. `updateDeployJobStep` / `finishDeployJob` 的 `WHERE` 追加 `AND pid = ?`，期望值由 `DeployJobs` 内部用
     `process.pid` 提供，不进调用方签名。没有它，一个被判陈旧而偷走的任务的原主人仍能在自己跑完时把**新主人**的
     任务写成终态。
  2. 在 `server/src/db/index.js:27`（`PRAGMA foreign_keys = ON` 旁）加 `PRAGMA busy_timeout = 5000`。
     平台跑在 cluster 下且本特性会**主动提高**跨 worker 抢锁频率，而 node-sqlite3 默认没有 busy handler，
     争用时 `dbRun` 直接 reject，`claimDeployJob` 的 `Promise<boolean>` 契约多出签名外的第三种结果。
     设了它，争用写者会等待后拿到干净的 `changes===0` 失败；Task 2 的 `claim()` 仍保留把 `SQLITE_BUSY`
     映射成"没抢到"作为第二道防线（见 Interfaces）。**这是一处平台级改动**，影响所有写操作，因此必须单独说明：
     它只会把"立刻抛错"变成"最多等 5 秒后仍失败"，不引入新的失败模式。

- [ ] **Step 6: 提交**

```bash
git add server/src/services/deploy-jobs.js server/src/db/index.js server/src/test/unit/deploy-jobs-state.test.js server/src/test/unit/deploy-job-claim.test.js
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
test('reconcileOnBoot writes through the row\'s own pid, not the booting process\'s', ...)
  // 本任务的命门：造一行 pid=一个不存在的数，跑收敛，断言行真的变成 failed
  // （若实现误用了 DeployJobs.finish / process.pid，这条会红 —— 上一条"存活"测试无法暴露该错误）
test('listNonTerminalDeployJobs returns only running rows and [] when there are none', ...)
  // 补 Task 1 审查的 Minor 1：该查询是收敛的唯一入口，此前无提交测试
```

- [ ] **Step 2: 跑测试确认失败** — Run: `cd server && node --test src/test/unit/deploy-jobs-boot.test.js`；Expected: FAIL — `reconcileOnBoot is not a function`

- [ ] **Step 3: 实现并在 `server.js` 接线** —— 只收敛 `listNonTerminalDeployJobs()` 返回的行，`message` 固定中文 `部署被中断（平台重启）`（Task 11 的前端只显示，不翻译该字符串；与 `[git]` 那些 console 前缀同级）。调用处包 `.catch(err => console.warn(...))`，**启动不能因为收敛失败而死**。

  **必须绕开 `DeployJobs.finish`（Task 2 的接口事实，brief 里原本没写）**：Task 2 把 owner fencing 做成了查询层的无条件
  `AND pid = ?`，而 `finish()` 内部固定传 `process.pid` —— 重启后的新进程 pid 永远匹配不上崩溃者的行，
  用它收敛会一条都改不动。所以 `reconcileOnBoot` 直接调查询层并**显式传该行自己的 pid**：
  `queries.finishDeployJob(appId, { status: 'failed', message: '部署被中断（平台重启）', pid: row.pid })`
  —— 注意 pid 在第二个参数的对象**里面**（Task 2 落地后的真实签名），不是第三个位置参数。
  这样 fencing 仍是默认行为，只有"启动收敛"这一个例外用行自带的 pid 自我认证。

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS（6 tests，与 Step 1 列出的 6 个测试名一致）

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
  - 上报顺序固定为**真实执行顺序**，每步在它命名的那件工作即将开始之前上报：
    `[git] → validate → [install] → [build] → launch → [proxy]`（方括号按 deploy_type / git 绑定 / 指纹闸门出现）。
    **注意：git prepare 在 validate 之前跑**（`deploy-manager.js` 的既有编排如此），所以绑定 git 的应用
    第一个上报的步骤是 `git`，不是 `validate` —— 早先本任务写"以 validate 开头"是我对编排顺序的误记。
    把 `validate` 提前上报会让 UI 在几分钟的 clone/fetch 期间显示"校验文件中"，那是另一种谎。
  - **跳过的步骤一律不上报**（Ruling 1，见 Step 3 的两条测试）：install/build 被指纹闸门跳过时不报；
    `ProxyManager.regenerate()` 在 `PROXY_ENABLED=false` 时返回 `skipped`，此时**不报 `proxy`**。

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

### Task 5b: step 名收拢到叶子常量模块（Task 5 审查后追加）

**Files:**
- Create: `server/src/utils/deploy-steps.js`
- Modify: `server/src/services/deploy-jobs.js`（`STEPS`/`KINDS` 改为从这里取）
- Modify: `server/src/services/deploy-manager.js`、`server/src/services/npm-lifecycle.js`（上报处引用常量）
- Test: `server/src/test/unit/deploy-step-reporting.test.js`（断言常量即唯一来源）

**Interfaces:**
- Produces: `DEPLOY_STEPS`（有序数组）、`DEPLOY_STEP`（`{ QUEUED, VALIDATE, GIT, INSTALL, BUILD, LAUNCH, PROXY, DONE }`）、`DEPLOY_KINDS`
- Consumes: 无（叶子模块，不 require 任何 service）

- [ ] **Step 1: 写失败测试** —— 断言 service 层上报的字面量与 `DEPLOY_STEP` 同源：

```js
test('reported step names come from the shared constants, not per-file literals', ...)
test('deploy-steps is a leaf module: requiring it pulls in no services', ...)
  // 断言 require 该模块后 require.cache 里没有 deploy-jobs/deploy-manager（把"无环"钉成测试而不是注释）
```

- [ ] **Step 2: 跑测试确认失败** — Run: `cd server && node --test src/test/unit/deploy-step-reporting.test.js`；Expected: FAIL
- [ ] **Step 3: 建常量模块并替换三处字面量** —— 方向必须是 service → utils，绝不能反向（`deploy-jobs` 现在自己持有 `STEPS`，改为再导出）。
- [ ] **Step 4: 跑测试确认通过 + 全量回归** — Expected: 全绿，基线不掉
- [ ] **Step 5: 提交**

```bash
git add server/src/utils/deploy-steps.js server/src/services/deploy-jobs.js server/src/services/deploy-manager.js server/src/services/npm-lifecycle.js server/src/test/unit/deploy-step-reporting.test.js
git commit -m "refactor(deploy): give deploy steps one source of truth"
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

  **应用在"抢到锁之后、读回行之前"被删掉时，`claim()` 返回 `{ ok:false, reason:'gone' }`**（Task 2 落地的契约，
  见下方 Ruling）：路由按 404 处理，**不发 202、不起后台任务**。

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

  **upload 的保护位置（已核对代码，别凭直觉放）：** `POST /apps/:id/upload` **没有**把 multer 挂在路由中间件链上，
  而是在 handler 内部先 `req.uploadPath = app.path`、再手动 `upload.array('files')(req, res, cb)`（`routes/apps.js:471`）。
  所以保护放在 handler 顶部是**有效**的 —— 此刻 multer 还没打开任何写流，不会往应用目录落一个字节；
  放在 multer 回调之后就是彻底无效的保护。
  残留的取舍要写进注释而不是被当成 bug：客户端此时**已经在流式发送 body**，
  提前 409 并不能阻止对端继续传字节（Node 侧不读体、Express 直接结束响应，浏览器会把它当成上传失败）。
  v1 接受这个体验（部署中的上传本来就该被拒），不做 `100-continue` 之类的协商。

- [ ] **Step 4: 跑测试确认通过 + 全量回归** — Expected: PASS（12 tests）；全量绿

- [ ] **Step 5: 提交**

```bash
git add server/src/routes/apps.js server/src/routes/git.js server/src/test/integration/deploy-job-guard.test.js
git commit -m "feat(api): refuse app mutations while a deploy job is live"
```

---

### Task 7b: 让每个测试文件都落在临时库里（测试卫生，独立小任务）

**Files:**
- Modify: `server/src/test/unit/proxy-config.test.js`、`nginx-log-paths.test.js`、`port-allocation.test.js`、
  `process-manager-ecosystem.test.js`、`resolve-cli-module.test.js`、`app-name-validation.test.js`、
  `update-state.test.js`、`update-manager.test.js`、`self-updater-success.test.js`、`self-updater-rollback.test.js`、
  `git-lifecycle-repo.test.js`（**先逐个判定是否真的会打开库**，见 Step 1）
- Test: `server/src/test/unit/test-db-isolation.test.js`（新建）

**Interfaces:**
- Produces: 无对外接口；只保证一件事 —— 跑测试不会碰仓库的 `data/microverse.sqlite`。
- Consumes: `server/src/test/helpers/setup.js`（它把 `DB_PATH`/`APPS_DIR` 指到每次运行唯一的临时目录）

背景（Task 7 实现者发现、控制器复核）：仓库里已有正确范式 —— `npm-fingerprints.test.js:6-8` 在 require 任何
service 之前先 `require('../helpers/setup')`，并写明理由。但另有 11 个测试文件没有这一行，
其中至少 `proxy-config.test.js` 经 `services/proxy-manager` → `require('../db')` 真的打开了
`data/microverse.sqlite`（`db/index.js:6` 的回退路径），后果是测试能**创建/初始化开发者真实的库文件**，
并在并发运行时持有它的锁 —— 这正是 `node --test` 偶发 IPC flake 的来源。
对本计划剩余任务的实际威胁是：**"全量必须绿"这个回归信号本身在抖**，抖动的信号会掩盖真实回归。

- [ ] **Step 1: 先判定，别一视同仁** —— 逐个确认该文件是否真的会打开数据库再动它。
      已知反例：`git-lifecycle-repo.test.js` 是**故意**不 require setup 的 ——
      `git-lifecycle.js:8-15` 用惰性 `function db()` 正是为了"只测 git 原语的进程不开库、不往 stdout 打日志"。
      给它加 setup 反而违背既有设计。判定方法：跑该文件并断言 `data/microverse.sqlite` 未被创建或修改
      （用 mtime+size 快照，**不要**删除开发者的库）。

- [ ] **Step 2: 写失败测试** —— `test-db-isolation.test.js`：

```js
test('the whole suite never creates or modifies the repo data/microverse.sqlite', ...)
  // 做法：在本文件里先 snapshot（不存在则记 absent），再 fork 一个子进程跑若干"嫌疑"测试文件
  //（至少 proxy-config / nginx-log-paths / update-state），最后断言快照未变。
  // 关键：测试必须能因"某个文件漏了 setup 那一行"而变红 —— 先故意去掉一行验证它会红。
test('a unit test file that loads a service pulls in the temp-db helper first', ...)
  // 静态扫 src/test/**/*.test.js：凡是 require 了 src/services 或 src/db 或 src/app 的文件，
  // 必须在其之前 require '../helpers/setup'；显式白名单放过 git-lifecycle-repo.test.js 这种有意为之者，
  // 白名单里每一项都要写一句理由。
```

- [ ] **Step 3: 跑它确认失败** — Run: `cd server && node --test src/test/unit/test-db-isolation.test.js`；Expected: FAIL（列出真会开库的文件）
- [ ] **Step 4: 给判定为"真会开库"的文件补上 `require('../helpers/setup')`**（放在任何 service require 之前，注释照 `npm-fingerprints.test.js` 的写法）。补完重跑 Step 3。
- [ ] **Step 5: 全量回归 + 稳定性自检** — `cd server && npm test` 连续跑 3 次，Expected: 三次同数、全绿（证明信号不再抖）
- [ ] **Step 6: 提交**

```bash
git add server/src/test/
git commit -m "test: keep every test file off the developer's real sqlite file"
```

- [ ] **Step 7（控制者追加，单独 commit）：把 DB 启动噪声从测试进程关掉。**
  `db/index.js:21` 只给 "Database connected" 做了 `development` 门控，而 :83-84 的
  "Database initialized successfully" / "Database path: …" 与 :98 的 migration 提示**无条件打印**，
  于是每个加载 db 的测试子进程都往 stdout 写 2+ 行。仓库其实早已认定这会干扰测试运行器 ——
  `git-lifecycle.js:8-15` 的注释原话是"logs progress to stdout, which would corrupt the node test
  runner's IPC stream"，只是只在 require 侧规避、没在打印侧根治。
  要求：`NODE_ENV === 'test'` 时不打印这些启动提示（**不要**关掉开发/生产启动时用户期待的信息）；
  同时保证 Step 2 的隔离探针仍然有效 —— 它依赖 `Database path:` 这行，
  所以探针改为在**自己的子进程**里显式设 `NODE_ENV=development`，不依赖测试环境默认值。
  改完重做一次自证（摘掉 helper 那行 → 探针仍点名该文件变红）。

```bash
git add server/src/db/index.js server/src/test/unit/test-db-isolation.test.js
git commit -m "test: stop db boot logging from polluting the test runner's stdout"
```

---

### Task 8: `deploy` 摘要附带 + `GET /api/apps/:id/deploy`

**Files:**
- Modify: `server/src/services/app-manager.js:125-148`（`getAllApps` / `getAppById`）
- Modify: `server/src/routes/apps.js`（新增只读端点 + Task 6 遗留的三条未测分支）
- Modify: `server/src/services/deploy-jobs.js`（`finish` 写 `done`；busy-409 文案抽成唯一生产者）
- Modify: `server/src/db/index.js`（`updateDeployJobStep` 加终态守卫）
- Test: `server/src/test/integration/deploy-status-api.test.js`（新建）

**Interfaces:**
- Consumes: Task 1 `getDeployJobsByAppIds`、Task 2 `tail`、Task 3 的收敛结果
- Produces: 应用对象新增 `deploy` 字段：`{ kind, status, step, message, startedAt, finishedAt, live } | null`；
  `GET /api/apps/:id/deploy -> { success:true, data:{ job: <同上>, logTail: string[] } }`

- [ ] **Step 0: 先修 Task 6 审查查出的两个真缺陷**（都在本任务要动的文件里，另开一轮不划算）

```js
test('a succeeded job ends on the done step', ...)
  // finish({ok:true}) 之后行的 step 必须是 'done'，否则成功的任务永远停在最后跑过的那一步
test('a failed job keeps the step it failed on', ...)
  // 失败时不得盖掉 step —— Task 6 的 'install' 断言依赖这一点，不能回退
test('a late advance cannot overwrite a terminal row', ...)
  // 命门：report 是 fire-and-forget，且 node-sqlite3 不 serialize() 时并行执行语句 ——
  // finish 写完 done 之后，一次迟到的 advance('proxy') 仍可能落库把 step 盖回去。
  // 先 finish({ok:true})，再调 advance(appId,'proxy')，断言 step 仍是 'done'、changes===0。
```

实现要求：`updateDeployJobStep` 的 WHERE 追加 `AND status = 'running'`（终态守卫，与已有的 pid fence 并列）；
`finish(appId,{ok:true})` 同时写 `step='done'`；`finish(appId,{ok:false,...})` 保留原 step 不动。

  **一条反方意见与我的答复（不要因此改主意，除非你能证伪我的理由）**：
  第二位审查者主张 `done` 应由 `DeployRunner` 的成功路径写（`advance(DONE)` 再 `finish`），
  理由是"`finish()` 是 Task 2 的冻结文件、被 pull 共用，且 `reconcileOnBoot` 故意绕过它"。
  我判定仍然写在 `finish(ok:true)` 里，因为：
  ① 被 pull 共用恰恰是**优点** —— start 与 pull 共用一条语句，不会有第二种成功路径忘了写 `done`；
  ② `reconcileOnBoot` 走的是查询层（Task 3 已定），本来就碰不到 `finish()`，
     被中断的任务因此不会谎称 `done` —— 这正是我们想要的行为，不是反对理由；
  ③ 写在 `finish` 里是**同一条 UPDATE** 同时落 `status`/`step`/`finished_at`，
     不存在"先 finish 再 advance"之间的窗口；而 runner 方案在 `finish` 已经落库后被抢答的风险更高。

- [ ] **Step 0b: 把 busy-409 文案抽成唯一生产者**

Task 6 在 start 路由里手抄了一份 `assertIdle` 的消息格式且**少了 `· <step>`**，
于是同一种 409 现在有两个生产者、两种文案 —— Task 11 做 i18n 时必然漂移。
改成 `DeployJobs` 导出一个 `busyMessage(job, action)`（或等价形式），
`assertIdle` 与路由的 `claim` 失败分支共用它。补一条断言：两条路径产出的消息格式一致。

- [ ] **Step 0c: 补 Task 6 遗留的三条分支测试**（`routes/apps.js`，本任务正好动这个文件）

```js
test('claim reason gone yields 404 and never starts a background deploy', ...)
test('claim reason updating yields 409 with the self-update wording', ...)
test('an unknown app id yields 404 without claiming', ...)
```

- [ ] **Step 0d: 把 Task 6 的两条计时测试改成机器速度无关**（`deploy-async-start.test.js`）

两位审查者都指出 `elapsed < 200` 对 500ms 假睡眠这种形状**只会假红、不会假绿**，
但在高负载 CI 上会偶发。更稳的形状是让假 `deployApp` 等一个**由测试掌握的 deferred**：

```js
// 异步路由：202 立刻到达，与机器速度无关；
// 若有人改回 await：请求会一直挂到测试超时 ⇒ 确定性红。
test('POST /start returns 202 without waiting for the deploy to be released', ...)
```
同时修审查者点出的两处测试质量问题：
`deploy-async-start.test.js:128-129` 的注释把机制说成"ENOENT 回落到 DB 状态"，实际是下一行的
直接 `getProcessStatus → online` stub（按注释描述的机制，DB 会停在 `stopped`，测试根本到不了 400）；
`:206-207` 的 `row.status === 'stopped'` 是恒真断言（mock 的 deployApp 从未碰应用行，
`finish` 也不写 app 状态）—— 要么删掉要么换成有意义的断言。

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
test('getDeployJobsByAppIds returns one row per app and [] for an empty id list', ...)
  // Task 1 审查遗留的 Minor：这条查询是"摘要不产生 N+1"的唯一实现，此前只有冒烟、没有提交测试。
  // 空数组分支尤其重要 —— `IN ()` 是 SQL 语法错误，离出错只差一次重构。
```

- [ ] **Step 2: 跑测试确认失败** — Run: `cd server && node --test src/test/integration/deploy-status-api.test.js`；Expected: FAIL（无 `deploy` 字段）

- [ ] **Step 3: 实现** —— 附带形状与 `git` 摘要完全对称（`app-manager.js:133` 的 `Promise.all` + Map by id；`toGitSummary` 旁边放一个 `toDeploySummary`），camelCase 输出、`live` 用 `DeployJobs.isLive` 计算。

- [ ] **Step 4: 跑测试确认通过 + 全量回归** — Expected: PASS（13 tests = Step 0 的 3 + Step 0b 的 1 + Step 0c 的 3 + Step 1 的 7）；全量绿，且 Task 6 的 8 条异步测试必须原样绿

- [ ] **Step 5: 提交**

```bash
git add server/src/services/app-manager.js server/src/services/deploy-jobs.js server/src/db/index.js server/src/routes/apps.js server/src/test/integration/deploy-status-api.test.js
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

- [ ] **Step 0: 顺手补 Task 6 审查查出的 runner 覆盖缺口**（本任务正是 runner 的第二个用户，改动落在同一文件）

```js
test('a rejecting finish does not produce an unhandled rejection', ...)
  // Task 6 审查指出：把 deploy-runner.js 里 bookkeeping 的 .catch 整段删掉，全套测试仍绿 ——
  // 而"后台任务的异常收敛"正是本特性的核心不变式，这条腿现在没人守。
  // 做法：mock.method(DeployJobs,'finish') 让其 reject 一次，断言无 unhandledRejection，
  // 且行留在非终态（交由启动收敛兜底），不要求 finish 自己成功。
test('a thrown object with a hostile toString still converges to failed', ...)
  // messageFrom 里 String(error) 可能自己抛，从而跳过 finish ⇒ 行卡在 running 直到陈旧窗口。
  // 用 try/catch + 兜底字面量关掉这条离奇路径。
```

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

**步骤词表（Task 5/5b 落地后的真实值，比规格里多一个 `nginx`）**：
`queued → git → validate → install → build → nginx → launch → proxy → done`。
数组顺序 == 上报顺序 == 真实执行顺序，所以"第 N 步 / 共 M 步"可直接用 `indexOf(step) + 1`，
分母取 `DEPLOY_STEPS.length - 2`（去掉 `queued` 与 `done`）。
`nginx` 是 Task 5 审查后新增的：nginx 类应用的 `generateConfig`/`testConfig` 原本夹在 `validate` 与 `launch`
之间没有槽位，`nginx -t` 挂住时 UI 会显示"校验文件中" —— 与刚修掉的 git 冒名同一类故障。
中英双语都必须补：`appCard.deploy.step.nginx` = `预检 nginx 配置` / `validating nginx config`。

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
