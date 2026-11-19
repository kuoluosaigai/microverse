# 部署任务异步化 — 设计

日期：2026-11-18
状态：已批准（人工确认于 2026-11-18，含决策 3「部署中禁用其它写操作」）

## 背景

一次 npm 应用的 start 会同步做：`pm2 jlist` 对账 → git fetch/reset/clean → `npm install`（上限 300s）
→ `npm run build`（上限 300s）→ `pm2 start` → nginx 边缘 reload。最坏预算约 11 分钟，**全部跑在
`POST /api/apps/:id/start` 这一个 HTTP 请求里**（`routes/apps.js:199`）。

2026-11-17 的性能排查已经修掉了"每次 start 都重装重构建"的三个闸门 bug（见
`perf(npm,git): stop reinstalling and rebuilding on every start`），修完之后**重复**部署只要 0.8s。
但**首次**部署（或依赖/源码真变了的那一次）仍然要几分钟，而这条链的形态没变：

- 前端 `startApp` 用 `timeout: 0` 死等（`client/src/api/apps.js:143`），`Dashboard.handleStart` 期间只有一个行内 spinner，没有任何进度。
- 请求穿过用户自管的 nginx 边缘；若 `proxy_read_timeout` 是默认 60s，**请求被掐断、服务端还在继续装**，
  用户看到失败，再点一次撞进"已部署中"，于是"等很久 → 报错 → 再点一次又好像很快"。
- 同一形态还有第二处：`POST /api/apps/:id/git/pull`（`routes/git.js:199` 注释明确写 "Synchronous by design"）
  也同步跑 fetch + install + build + restart。

仓库里已经有两套"长任务"先例，**互不一致**：

1. Git 同步：DB 行当单飞锁（`claimGitSync`/`finishGitSync`，`db/index.js:241`；`last_status` =
   `updating`/`success`/`failed`，`sync_started_at` 超过 `GIT_STALE_SYNC_MS` 视为弃单），webhook 走
   `triggerBackgroundSync` 这种 fire-and-forget（`git-lifecycle.js:552`）。
2. 本体自更新：文件锁 `data/update.lock` + state JSON（`status`/`step`/`pid`/`logPath`），由 **detached 子进程**
   执行（`update-manager.js` 的 `startUpdate` 在 570-574 行 `spawnDetached(..., {detached:true, stdio:'ignore'})`
   + `child.unref()`），`GET /api/system/update/status` 一次返回状态 + 有界日志尾巴，
   前端 `UpdateModal` 用 `setInterval` 轮询那一个端点（**没有 SSE**）。

`LogManager` 另有现成的追日志原语（`createTailer`，`log-manager.js:104`：`fs.watch` + 字节偏移 + 行缓冲）。

## 目标

1. 点 Start / Pull 之后**请求立刻返回**，不再出现分钟级挂起的 HTTP 请求，也不受边缘 nginx 读超时影响。
2. 用户随时看得见这个应用现在处在部署的哪一步（拉代码 / 装依赖 / 构建 / 启动），以及最终失败原因。
3. 失败时能看到 npm 的真实输出（不是只有一行 500 字节的错误摘要）——这是排查部署失败的主要依据。
4. 平台重启/刷新页面不会丢状态：任务状态存在服务端，重新拉一次列表就能看到"部署中 · 构建"。
5. 部署进行中，对同一个应用的其它写操作不会悄悄打架。

## 非目标（v1 明确不做）

- **不做 detached 子进程执行器**。理由见"关键决策 2"。
- **不做"取消部署"**。`npm install` 中途被杀只会留下可重入的半成品目录，但取消需要给 execFile 传信号、
  还要处理"已经 pm2 start 了"的分支；v1 用"部署中禁止其它写操作"代替（决策 3）。
- 不做跨应用的全局部署队列 / 并发度限制。单管理员平台，一次点一个；两个应用同时装依赖会互相拖慢，
  但那不是正确性问题。
- 不做自动重试 / 定时重试。失败就停在那儿等人看。
- 不为部署日志新建 SSE 通道（决策 6：沿用自更新已验证的"一次轮询带状态 + 尾巴"形状）。
- 不改上传链路（`POST /apps/:id/upload` 仍是同步请求）。100MB zip 在慢上行下同样会很久，
  但那是"链路速率决定"而不是"平台在算东西"，且已有 `server.requestTimeout = 10 * 60 * 1000`（`server.js:60`）兜着。
- 不动 deploy_type 的语义、不改 install/build 的 300s 超时配置。
- 不引入消息队列 / Redis / 工作流引擎。

## 反目标（做对了才算成功）

- 不能变成"请求返回快了，但状态永远停在 running"的假异步。任何路径（含进程被杀）都必须让任务收敛到终态。
- 不能为了进度把 npm 输出全量灌进数据库或内存数组。日志走文件 + 有界尾巴。
- 不能再造第三套与上述两个先例都不同的任务模型。
- 不能出现"用户按了停止，应用却启动了"这种静默互相覆盖。

## 约束

- **PM2 cluster（`instances: 'max'`）**：起任务的 worker 和下次请求落到的 worker 可能不是同一个
  → 任务状态必须放共享存储（SQLite 是唯一现成的共享写点，`metrics` 表就是为同样的问题存在的）。
- 部署逻辑与 `ProcessManager`（PM2 CLI）、`AppManager`、SQLite 深耦合，路由是唯一调用方
  （除 `routes/apps.js:199` 外只有 `scripts/diagnose-deploy-perf.js`）→ 收口点很小（已核实）。
- `data/` 与 `apps/` 是 gitignore 的仓库根目录；schema 只能增量（`CREATE TABLE IF NOT EXISTS`，服务每次启动重跑）。
- Windows 开发机 + Ubuntu 生产：路径、日志目录、进程信号都得跨平台。
- 单管理员、会话即权限，不引入新授权面。

## 关键决策（builder 按此实现）

### 1. `app_deploy_job` 覆盖 start 与 pull 两种慢操作，但**不接管** git 同步的语义

两条慢路径都进任务表，因为它们需要同一件东西：进度 + 日志 + 互斥 + 收敛。

但 **`app_git_source` 仍是 git 侧事实的唯一来源**：`deployed_commit`/`remote_commit`/`last_status`/`last_error`
继续由 `GitLifecycle.sync` 写，Git 对话框继续读它，webhook 的 `update_available` 逻辑一行不动。
新任务表只是"这个应用最近一次长操作跑到哪了、日志在哪"，**不重名单飞、不重写回滚**
（`runClaimedSync` 的 `claimGitSync` + 回滚照旧生效，任务行是它外面的一层观测与互斥壳）。

`kind ∈ {'start','pull'}`：

- `start` → 后台跑现有 `DeployManager.deployApp(appId)`（含它内部的 git claim）。
- `pull` → 后台跑现有 `GitLifecycle.sync(app)`（含它的 busy/up-to-date/success/failed 与回滚）。

代价：一次 pull 之后有两个地方能看状态（任务表 = 进度/日志，git 摘要 = 部署结果）。
收益：不为了统一而把已过测试的 git 单飞/回滚逻辑再改一遍 —— 这正是本次要消灭的"分钟级同步请求"，
不是要顺手重构 git 子系统。

### 2. 进程内后台任务，而不是 detached 子进程

自更新那套 detached 执行器能保证"平台 reload 之后任务还活着"。这里不采用，理由：

- 部署要调 PM2/npm/git CLI 与整套服务层，独立进程等于把平台再启一遍（另开 DB 连接、另一份 config、
  另一份 PM2 CLI 解析），孤儿进程的清理面比现在大。
- 它换来的唯一保证是"平台在部署途中被重启时任务不被打断"。而打断的后果是可重入的半成品 `node_modules`
  —— `installFingerprint` 只在 install 成功后落库（`npm-lifecycle.js` 的 `ensureBuilt`，已核实），
  所以重跑一次 start 就是正确修复。为一个可自愈的结果付双进程的复杂度不值。
- 仓库里离这个场景最近的先例是 `triggerBackgroundSync`（应用生命周期内的后台活 = 进程内 + DB 状态），
  不是自更新（平台重启自己 = 必须脱离父进程）。**语义上也该照前者做。**

打断的处理方式见决策 5：陈旧任务声明 + 启动时收敛，让"被中断"成为一个**可见的终态**而不是悬挂。
另外决策 8 让自更新在有活跃任务时直接被拒，把这个窗口缩到"管理员自己在此之前手动 reload 平台"。

### 3. 部署中，同一个应用的其它写操作一律 409（取代"取消"）

异步化把"部署中"从一个自然存在的状态（HTTP 请求还挂着）变成一个**可以关页面离开再回来**的状态，
于是必须显式定义其它写操作在窗口内的行为。规则一句话：

> 任务 `status ∈ {queued, running}` 且**未陈旧**时，对该应用的任何写操作返回 409，
> 消息带上当前 step；只读端点不受影响。

- 覆盖：`stop` / `restart` / `delete` / `upload` / `PUT env` / `PUT|DELETE default` /
  `PUT|DELETE git`（bind/unbind）/ `git/secret` / `git/pull`（或 start，二者互斥）。
  实现上是一个 `DeployJobs.assertIdle(appId)`，与已有的 `GitLifecycle.assertNotSyncing()` 同一形状、同一措辞
  （`'Update in progress'` → 409 的映射照抄）。
- **为什么是 409 而不是让 stop 变成取消**：`stopApp` 在应用还没起来时是幂等 no-op
  （`deploy-manager.js` 里 status≠running 直接返回成功），任务随后照样 `pm2 start` —— 用户按了停止、应用启动了，
  这是反目标。真正的取消需要一个协作式中断点 + "已经启动了就补一次 stop"的分支，v1 不做（见非目标）。
- **必须按"活性"判定，不能只看 status**：否则一次 worker 崩溃会让这个应用 409 到陈旧阈值（40 分钟）为止，
  把人锁死在自己的平台上。活性 = pid 还活着（`process.kill(pid, 0)`）且 `started_at` 未超陈旧阈值；
  不活的任务由决策 5 的收敛路径变终态，锁随之释放。
- 前端：`AppRow` 在 `deploy.status` 为活跃态时**禁用**启动/停止/删除/上传等入口（不是隐藏，保留位置稳定），
  并把 step 显示出来 —— 见决策 6 的草图。

### 4. 状态存储：`app_deploy_job`，一行一个应用（不是事件流）

```sql
CREATE TABLE IF NOT EXISTS app_deploy_job (
  app_id      INTEGER PRIMARY KEY,          -- 一个应用同时只有一个任务：当前或最近一次
  kind        TEXT NOT NULL,                -- 'start' | 'pull'
  status      TEXT NOT NULL,                -- queued|running|succeeded|failed
  step        TEXT,                         -- validate|git|install|build|launch|proxy|done
  message     TEXT,                         -- 失败摘要（终态时给 UI 行内显示）
  log_path    TEXT,                         -- data/deploy-logs/<app>-<epoch>.log
  pid         INTEGER,                      -- 起任务的进程；liveness 判断用
  started_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME,
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);
```

一行一应用的取舍：状态永远是"当前或最近一次"，与 `app_deploy_state`/`app_git_source` 的形状一致，
UI 与单飞声明都简单。部署历史（第几次、各步耗时）不进关系表 —— 历史在日志文件里，
`[deploy-perf]` 行本来就是给这个用的。

**单飞声明**（注意：与 `claimGitSync` 的 WHERE 条件方向相反，因为 `app_git_source` 在绑定时已经有行了，
而 `app_deploy_job` 在首次部署时**没有行**，纯 UPDATE 永远抢不到）：

```sql
-- 抢锁：没有行 或 已有行是终态/陈旧 → 插入或改写为 running
INSERT INTO app_deploy_job (app_id, kind, status, step, pid, started_at, log_path)
     VALUES (?, ?, 'running', 'queued', ?, ?, CURRENT_TIMESTAMP, ?)
ON CONFLICT(app_id) DO UPDATE
   SET kind=excluded.kind, status='running', step='queued', message=NULL,
       pid=excluded.pid, started_at=CURRENT_TIMESTAMP, log_path=excluded.log_path,
       finished_at=NULL
 WHERE app_deploy_job.status IN ('succeeded','failed')
    OR app_deploy_job.started_at < datetime('now', ?)   -- ?= '-<staleSeconds> seconds'
```

`dbRun` 的 `changes > 0` 即抢到；SQLite 单写者让这条语句本身就是原子的（cluster 多 worker 同抢只有一个赢）。
**先创建日志文件再抢锁，还是先抢锁再创建**都行，但只有赢家写状态，输家不得删文件。

陈旧阈值新增 `DEPLOY_JOB_STALE_MS`（默认 2400000 = 40 分钟，最坏预算 11 分钟的 3 倍多），
需要同时加进 `config/index.js` 与 `.env.example`。

### 5. 谁跑任务：`DeployManager.deployApp` 保持纯函数，新增 `DeployJobs` 负责包装

- `deploy-manager.js` **不改**它的编排语义（对账 → 校验 → 端口 → install/build → 启动 → 边缘 → 记账），
  只在它已有的 `[deploy-perf]` lap 处顺手把 step 名报给 `DeployJobs`。
- 新文件 `server/src/services/deploy-jobs.js`：`claim(appId, kind)` / `advance(appId, step)` /
  `finish(appId, {ok, message})` / `assertIdle(appId)` / `activeJob(appId)` / `tail(appId, {lines, bytes})` /
  `reconcileOnBoot()` / `newLogFile(app)`。它是任务状态与日志文件路径的**唯一**属主；
  `DeployManager` 不认识 HTTP。
- 路由层 `POST /api/apps/:id/start`：先做决策 7 的同步前置检查 → `claim` → `202` →
  后台跑 `deployApp`（fire-and-forget，形如 `triggerBackgroundSync`，异常一律收敛成 `finish({ok:false})`）。
  `POST .../git/pull` 同形状，后台跑 `GitLifecycle.sync`。

`DeployManager.deployApp` / `GitLifecycle.sync` 继续可以被别的调用方（诊断脚本、webhook、未来别的编排）
**同步 await** —— 异步化发生在路由边界，不是把服务层签名改成回调/事件。

### 6. 进度怎么到前端：一次轮询同时带状态和日志尾巴（照抄自更新已验证的形状）

- `AppManager.getAllApps()` / `getAppById()` 已经用 `Promise.all` 附带 `git` 摘要
  （`app-manager.js:133`、`app-manager.js:142`）→ **同样形状附带 `deploy`**：
  `{ kind, status, step, message, startedAt, finishedAt }`，无任务时为 `null`。
  于是 Dashboard 现有的 10s 静默刷新（`Dashboard.jsx:47-51`）就能拿到进度，不需要为每行新增轮询。
- 点 Start 后前端立刻刷一次列表进入"部署中"态；终态由下一次静默刷新收敛
  （可接受：状态存在服务端，刷新只是显示延迟）。
- **部署日志**：`GET /api/apps/:id/deploy` 一次返回 `{ job, logTail }`
  （`logTail` = 有界尾巴，复用 `UpdateManager.readLogTail` 的"最多 N 行 / M 字节"约束），
  日志抽屉打开时每 2s 轮询这一个端点，关掉即停。**v1 不做 SSE。**
  理由：自更新的 `UpdateModal` 已经是"轮询一个端点、里面带状态 + 日志尾巴"并且被设计成可用；
  仓库里唯一的 SSE（`routes/apps.js:343`）带着 `fs.watch`/timer 泄漏的精细清理约束
  （`routes/apps.js:387` 那段注释就是教训），为一个抽屉再引入一条流式通道不值得。
- 若将来要实时滚屏，再加 `GET /apps/:id/deploy/logs/stream`；现成的 `apiLimiter` 豁免是按
  `req.path.endsWith('/logs/stream')` 匹配的（`rate-limit.js:16`），届时自动生效。

UI 上用户看到的（沿用 AppRow 现有的 `git · <sha>` 小字摘要风格；活跃任务期间其它写入口禁用）：

```
my-app    ● 部署中 · 装依赖                    [■ 禁用] [■ 禁用] [日志]
my-app    ○ 停止   ✖ 装依赖失败 · 看日志        [启动]  [删除]   [日志]
my-app    ● 运行中                              [停止]  [删除]   [日志]   ← 任务终态摘要 3 分钟后不再显示
```

### 7. 哪些失败仍然是同步 4xx（别把"能立刻知道的事"塞进后台）

原则：**不需要动手就能判定的，保持同步返回原状态码；必须动手才知道的，才进任务。**

| 情况 | 现在 | 改为 |
|---|---|---|
| 应用不存在 | 404 | **404 不变** |
| 该应用已有活跃任务 / 平台正在自更新 | — | **409（新增）** |
| 状态对账后已是 running | 400 'already running' | **400 不变**（对账只是 0.2~1s 的 `jlist`，值得等） |
| 静态应用缺 `index.html` / npm 应用缺 `package.json`、无 start 脚本 | 400 | **400 不变**，但仅在**未绑 git** 时前置判定（见下） |
| git claim 被 webhook 后台同步占着 | 409 'Update in progress' | **409 不变**（用现成 `isSyncInProgress` 前置检查） |
| **git 应用缺入口文件** | 400 | **进任务**：文件是 clone 之后才存在的，先判无意义 |
| clone / fetch 失败 | 400（`git-start.test.js:378` 契约） | **进任务** → `202` 后 `failed`，`message` 带 git stderr 摘要 |
| `npm install` / `npm run build` 失败与超时 | 400 | **进任务** → `failed` + 日志尾巴 |
| `pm2 start` 失败、端口耗尽 | 500/400 | **进任务** → `failed` |

前置校验对 git 应用的例外要说清：`AppManager.validateAppDeployment` 今天在 `deployApp` 内部、
git prepare **之后**才跑（`deploy-manager.js:119`）—— 这个顺序是对的，路由层的同步前置校验必须
**跳过绑定了 git source 的应用**，否则会对着一个还没 clone 的空目录报"缺 index.html"。

**因此以下既有契约测试必须改（这是契约变更，不是回归）**：
`git-start.test.js:378`（clone 失败 400 → 202 + 任务 failed）、
`git-routes.test.js:181`（pull 200 + `data.status` → 202 + 任务/`git.last_status`）、
`git-routes.test.js:188`（pull 失败 400 → 202 + 任务 failed）。
其余 `deployApp` / `GitLifecycle.sync` 的服务层测试**不得**为了异步而改断言 —— 服务层语义没变。

### 8. 日志文件：捕获 install/build 的 stdout+stderr，带 ANSI 清理与尺寸上限

- 路径 `data/deploy-logs/<app-name>-<started epoch>.log`，与自更新的 `data/update.log` 同一套目录约定
  （相对仓库根，Windows/Linux 都用 `path.join`）。
- `NpmLifecycle.npmExec` 增加可选 `logFile`：给了就用 `fs.openSync(..., 'a')` + `stdio: ['ignore', fd, fd]`
  的 spawn 变体把输出**直接落文件**，不再走 `maxBuffer` 字符串；没给就保持现在的行为
  （测试与其他调用方不受影响）。这一步同时解决了另一个潜在问题：一次 `npm install` 的输出可能超过现有 4MB `maxBuffer`。
- **谁传 logFile**：`DeployJobs` 生成路径并往下传，`NpmLifecycle` 只认"给我一个 fd 就往里写"。
  这样 start 和 pull 两条路都自动有日志，而"路径的属主"仍然只有 `DeployJobs` 一个（回应决策 1 的分工）。
  `GitLifecycle.runClaimedSync` 把 `ensureBuilt` 调用点加上 `{ logFile }` 透传即可，不改它的回滚逻辑。
- 写入方是 npm 子进程自己（fd 继承），不是平台内存里的字符串 → 反"全量灌内存"自然满足。
- 读取端统一剥 ANSI 转义、只取尾部 N 行 / M 字节。
- 清理：每个应用保留最近 5 个日志文件，任务结束时删更旧的；不做时间维度清理（文件小、数量有界）。

### 9. 自更新与部署互相挡道

- `UpdateManager.preflight()` 增加一条：存在**活跃的**（未陈旧、pid 存活）部署任务 → 拒绝更新，
  提示"有应用正在部署"。否则 `pm2 reload` 会打断它（决策 2 已知的那个代价，至少让它可预期）。
- 反向：`DeployJobs.claim()` 时若 `data/update.lock` 是活的 → 拒绝 start/pull（"平台正在自更新"）。
  现成的 `UpdateManager.isUpdateRunning()`（含活锁判定 + state pid liveness）直接复用，不重写一份解析。

### 10. API 变更（破坏性，前端同步改）

| 端点 | 现在 | 改为 |
|---|---|---|
| `POST /api/apps/:id/start` | 200 + 完整 app（分钟级挂起） | **202** + `{app_id, kind, status:'running'}`；409 = 已有任务；400/404 见决策 7 |
| `POST /api/apps/:id/git/pull` | 200 + `{deployedCommit, status}` | **202** + `{app_id, kind:'pull', status:'running'}`；结果看 `git.last_status` 与任务 |
| `GET /api/apps` / `GET /api/apps/:id` | 附 `git` | 另附 `deploy`（无任务为 `null`） |
| `GET /api/apps/:id/deploy` | — | 新增：`{ job, logTail }` |

不留兼容的同步模式开关：两条路径都要维护，且"同步等 11 分钟"本身就是要消灭的东西。

前端改动点：`client/src/api/apps.js` 的 `startApp` 与 `pullAppGit`（第 122 行，注意不叫 `pullGitSource`）
改成"202 即成功 + 刷新列表"；`Dashboard.handleStart` 的 `startingId` 语义从"请求在飞"改成"任务在飞"
（后者由服务端状态决定，刷新页面也不会退回成"看起来没在部署"）；`AppRow.jsx` 增加 `deploy` 摘要 +
决策 3 的禁用逻辑；`GitModal` 的 Pull 改成提交任务 + 读 `git.last_status`。

文档同步：`server/src/docs/openapi.yaml`、`CLAUDE.md`（端点清单 + DeployJobs + 新配置项 + 部署中互斥语义）、
`docs/manual-verification.md`（新增异步部署的冒烟条目）。

## 还剩给 builder 的判断

- `DeployJobs` 各方法的内部结构与命名（本文件只钉职责边界与那几个必须存在的操作）。
- step 名与前端 i18n key 的对应表（`queued/validate/git/install/build/launch/proxy/done`，中英都要）。
- 日志文件"最近 5 个"的清理时机（任务开始时清 vs 结束时清），只要保证不会无界增长即可。
- 终态摘要在 UI 上停留多久（草图写了 3 分钟，实现可定）。
- 陈旧阈值若实测不合适，调 `DEPLOY_JOB_STALE_MS`，不需要改代码。

## 验证要点（写计划时展开成步骤）

1. 既有测试：除决策 7 明列的三条契约测试外，全绿；服务层测试断言不变。
2. 新增：注入慢 install 期间 `POST /start` 立即 202、列表里 step 依次推进、终态收敛、
   日志文件里有 npm 真实输出（ANSI 已剥）。
3. 新增：部署中调 stop/delete/upload/PUT env → 全 409 且消息带当前 step（决策 3 的表逐条覆盖）。
4. 新增：二次 start → 409；worker 被杀模拟（running + 死 pid）→ `reconcileOnBoot` 后变 failed，
   且**不阻塞**下一次 start（活性判定）。
5. 新增：陈旧阈值内/外的 claim 行为各一条；cluster 双 worker 同抢只有一个赢（用 `changes` 断言）。
6. 新增：pull 路径也有日志（决策 8 的透传不是只做了 start）。
7. 新增：有活跃任务时 `POST /api/system/update` 被拒；持活 `update.lock` 时 start 被拒（决策 9 双向）。
8. 手动冒烟（Windows 开发机 + 测试服务器各一次）：真实 npm 应用首次部署全程可见进度，
   关页面再开仍显示"部署中"，终态后应用可访问；中途手动 `pm2 reload` 平台后任务变 failed 且再点一次能成功。

---

## 实现勘误（Task 12 契约核对，2026-11-20 追加；本文件是当时的批准稿，正文不回改）

以 `server/src/utils/deploy-steps.js` 为唯一权威，实现落地后与本文件有两处出入：

- **step 词表**（决策 4 的 SQL 注释与"还剩给 builder 的判断"第 2 条）：实际是 **9 个值**，执行序为
  `queued, git, validate, install, build, nginx, launch, proxy, done`。
  与规格草案的差异：(a) `git` 在 `validate` **之前**（git-prepare 物理先于文件校验运行）；
  (b) `nginx` 是 Task 5 审查后**新增**的——不在本规格内：nginx 类应用的 `nginx -t` 预检原本没有自己的槽位，
  挂住时 UI 会显示"校验文件中"，与刚修掉的 git 冒名同属一类故障。见计划 Task 5b 的说明。
- **status 取值**（决策 4 的 SQL 注释写了 `queued|running|succeeded|failed`）：实现中**没有 `queued` 状态**——
  抢到 claim 即 `running`，排队等待由 `step='queued'` 表达（`schema.sql` 注释与 `claimDeployJob` 为准）。
