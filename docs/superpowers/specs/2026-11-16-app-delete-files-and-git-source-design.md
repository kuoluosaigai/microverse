# 应用文件可选删除 + Git 源部署刷新 — 设计文档

- **日期**: 2026-11-16
- **状态**: Draft (design)
- **范围**: 两件事一起做，但相互独立：
  1. 删除应用时可选「同时删除应用目录」（默认保留）。
  2. 应用可绑定 Git 仓库（所有 deploy_type 通用）；GitHub push webhook 实时触发拉取、安装、构建、重启；每个应用一个「自动更新」开关（默认开），并提供手动检查 / 拉取。
- **典型场景**: `https://github.com/foXerw/personal-blog`（Astro，npm 类型）。发布文章 = 本地写 Markdown → `git push`。Microverse 收到 webhook 后自动完成 `npm install --include=dev` → `npm run build` → 重启，站点秒级更新。博客仓库本身不需要改。
- **不在范围（v1）**:
  - 私有仓库 / SSH / token 凭据管理（仅公开 `https://` 仓库）。
  - Git 子目录部署（仓库根 = 应用根）。
  - 拉取 GitHub Actions 构建产物（已确认在 Microverse 服务器上构建源码）。
  - 现有上传型应用的文件自动迁移（绑定仓库后会拉取并覆盖仓库跟踪的文件）。
  - 多用户 / 权限模型（仍单管理员）。
  - 修复「备份包含 `node_modules`」的既有问题（本设计只额外排除 `.git`）。

## 背景（已核对源码）

- `AppManager.deleteApp(id)` 删除 PM2 进程与 DB 行后**刻意保留** `apps/<name>/` 目录，注释写明为防止数据丢失。`DeployManager.deleteApp` 先做 `reconcileStatus`，运行中拒绝删除，删除后重新生成边缘代理配置。
- 现有 deploy_type：`http-server`（静态）、`npm`（install/build/start）、`nginx`（静态）。`DeployManager.deployApp` 对 npm 使用 `NpmLifecycle` 的 install/build 指纹（`app_deploy_state` 表），停止再启动不会重复安装/构建。
- 路由组合 `server/src/routes/index.js`：public routers → `requireAuth` → `apiLimiter` → protected routers。`app.js` 全局 `express.json()` 在 `app.use('/api', routes)` 之前。
- 生产部署是 Ubuntu + PM2 **cluster**（多 worker）+ nginx 边缘。任何跨请求的「单飞」状态不能放进程内存，需要 DB 或文件锁（自更新已有 `data/update.lock` 先例）。
- 博客仓库现状：Astro 5，`npm run build`（D2 预渲染 + Astro build + Pagefind），`npm start` 跑 `server.mjs` 静态服务；push main 触发 GitHub Actions 部署 GitHub Pages（`deploy.yml`）。Microverse 上目前是上传源码的 npm 应用。

## 关键决策（brainstorm 已确认）

1. **更新触发 = GitHub Webhook 实时触发**（用户选择）。另提供手动「检查更新 / 拉取更新」按钮作为兜底。
2. **构建位置 = Microverse 服务器拉源码构建**（用户选择），复用现有 npm 部署管线与指纹缓存。
3. **Git 源与 deploy_type 解耦**（用户选择所有类型都支持）：npm / http-server / nginx 都可绑定。拉取后的动作按类型不同：npm 需要 install/build/restart；静态类型只需要更新文件。
4. **自动更新 = 每应用一个开关，默认开**（用户选择）。关掉后 webhook 只记录「有新版本」。
5. **Git 源存独立表 `app_git_source`**（`CREATE TABLE IF NOT EXISTS`，无需列迁移），避免给 `apps` 表加多列和 CHECK 迁移。
6. **Webhook 用 GitHub 标准 HMAC-SHA256 签名**（`X-Hub-Signature-256`），每应用独立 secret，不依赖平台登录态。
7. **跨 worker 单飞用 DB 条件更新抢占**（`last_status='updating'` + `sync_started_at` 过期可抢占），不用进程内存锁。
8. **更新失败回滚到上一个 commit** 并尽力重建旧版本；不回滚 DB 之外的东西。
9. **删除文件默认不勾选**（保守默认），勾选后整目录删除（含 `.git` / `node_modules`）。

## 用户可见行为

### A. 删除应用

- 删除按钮不再用 `Popconfirm`，改为自定义 `Modal`：
  - 标题「删除应用」；正文说明「应用记录和 PM2 进程会被删除」。
  - 复选框「同时删除应用文件」默认**不勾**；勾选后显示警示文案「文件不可恢复，建议先备份」。
  - 运行中应用仍禁止删除（按钮 disabled，服务端同样拒绝）。
- 勾选删除时，整个 `apps/<name>/` 目录被移除（含 `.git`、`node_modules`、nginx 产物）。
- 不勾选时行为与现在完全一致：目录保留，便于之后重建同名应用或手工取数据。

### B. Git 源

#### 创建应用

`CreateApp` 表单在 deploy_type 下方增加可选区块：

- 「Git 仓库 URL」文本框（留空 = 普通上传应用）。
- 「分支」文本框，默认 `main`，仅填了 URL 时显示。
- 「自动更新」Switch，默认开。
- 表单提交时把三个字段一并发给 `POST /api/apps`；创建只落库，不 clone（首次 Start 时 clone，避免创建请求被网络拖住）。

#### 已有应用绑定仓库

`AppRow` 增加「Git」按钮（仅 Git 应用显示 repo 摘要；非 Git 应用也显示按钮用于绑定），打开 `GitModal`：

- 表单：仓库 URL、分支、自动更新开关；保存 = `PUT /api/apps/:id/git`。
- 只读区：已部署 commit（短 SHA + 完整 SHA tooltip）、最近同步时间、最近状态（idle / updating / success / failed / update available）、最近错误。
- Webhook 配置区：完整 Webhook URL（`<平台地址>/api/webhooks/github/<appId>`）+ secret（默认掩码，可显示/复制）；「重新生成 secret」按钮（需在 GitHub 同步更新）。
- 操作按钮：「检查更新」（`POST .../git/check`，`git ls-remote` 对比远端 HEAD）、「拉取更新」（`POST .../git/pull`）。
- 「解除绑定」：`DELETE .../git`，保留当前文件，应用变回普通上传应用。

#### 应用列表展示

- Git 应用在名称下方显示 `git · <短 SHA>`；状态为 `update_available` 时显示「有新版本」提示；`updating` 时更新按钮禁用并显示「更新中」。
- 上传按钮对 Git 应用隐藏（服务端也拒绝上传）。

#### 启动行为

`DeployManager.deployApp` 在 validate 之前，对 Git 应用执行一段受保护的 git 前置阶段：

1. **先抢占同步锁**（与 `GitLifecycle.sync` 共用 `claimGitSync`）。已有更新在跑 → 409「Update in progress」；锁覆盖整个 start 流程（git → install/build → 进程启动），避免 start 与 webhook 同步并发写同一个目录。
2. 若无 `.git`（从未 clone）：必须 clone（无论自动更新开关）。clone 失败 → 400，应用不启动。
3. 若已有 `.git` 且自动更新开启：fetch + reset 到远端最新。**fetch 失败但本地 checkout 存在时继续启动**（记录 `last_error` 说明使用了本地版本），不阻断重启；GitHub 短暂不可达不应让已停止的站点起不来。
4. 若已有 `.git` 且自动更新关闭：直接用本地 checkout，不联网。
5. git 阶段成功后更新 `deployed_commit`=HEAD、`synced_at`；之后仍执行原有 validate → port → install/build（指纹门控）→ start。
6. 整段结束后释放抢占：进程成功启动 → `success`；任一阶段失败 → `failed` + 错误信息（`deployed_commit` 保留 git 阶段实际检出的 SHA）。

#### 同步流水线

`GitLifecycle.sync(app, { reason })`：

1. **DB 抢占**：`UPDATE app_git_source SET last_status='updating', sync_started_at=CURRENT_TIMESTAMP WHERE app_id=? AND (last_status != 'updating' OR sync_started_at < now - STALE_MS)`；`changes=0` → 已有更新在跑，本次不执行（webhook 只记录 `remote_commit`，手动拉取返回 409）。
   - 同步开始时用 PM2 真值（`reconcileStatus`）判断应用是否 running，记作 `wasRunning`。
   - 更新期间**允许 Stop**（停止后不再重启），**拒绝 Start / Restart / Delete**（409，见「同步期间的其他操作」）。
2. 确保仓库存在（clone：`git init` → `remote add/set-url` → `fetch --depth 1 origin <branch>` → `checkout -B <branch> FETCH_HEAD`）。`init` 方式可安全用于非空目录（绑定已有上传应用时覆盖 tracked 文件，保留未跟踪文件）。
3. `git fetch --depth 1 origin <branch>`；`newSha = git rev-parse FETCH_HEAD`。
4. `newSha === deployed_commit` 且仓库工作区干净 → 标记 `success`（up to date），结束。
5. 记录 `prevSha = git rev-parse HEAD`。
6. `git reset --hard FETCH_HEAD` + `git clean -fd`（**不加 `-x`**：保留 `.gitignore` 的 `node_modules` / `dist` 等）。
7. npm 类型：`NpmLifecycle.install` + `build`（树指纹必然变化，指纹门控自然触发；成功后写回 `app_deploy_state`）。其他类型跳过。
8. 成功：更新 `deployed_commit=newSha`、`synced_at`、`last_status='success'`、清空 `last_error`；若原本 running **且此刻仍 running**（用户可能在构建期间点了 Stop）且是 npm → `ProcessManager.restartProcess`（不重跑 install/build）；静态类型不需要重启（文件已更新）。
9. 若更新过程中 `remote_commit` 又变了（另一条 webhook 打到别的 worker）且自动更新开启 → 循环再跑一轮（最多 3 轮）。
10. `finally` 释放抢占（把 `last_status` 从 updating 改为 success/failed/update_available）。

**失败与回滚**：

- git 网络/仓库错误：不 reset，记录 `failed` + 错误信息，`deployed_commit` 不变。
- install/build 失败（已 reset 到新 commit）：
  1. 记录错误。
  2. `git reset --hard prevSha`，再尽力 `install + build` 恢复旧产物（npm 类型）。
  3. 不重启进程（运行中的旧进程继续服务；静态类型若已覆盖文件，则旧文件已由 reset 恢复）。
  4. `last_status='failed'`，保留 `last_error`；`deployed_commit` 保持 `prevSha`。
  5. 若回滚重建也失败，错误信息同时包含原始错误与回滚错误，`last_status='failed'`。
- **重启失败**（git 与构建都成功，但 `restartProcess` 失败）：**不回滚**（新版本已正确构建，回滚只会丢掉一次成功发布），保留 `deployed_commit=newSha`，`last_status='failed'`，`last_error='Restart failed: ...'`。下一次 Start 会使用新代码。
- 平台在更新中重启：抢占过期（`STALE_MS`，默认 30 分钟）后可被下一次更新抢占，UI 显示 updating 直到下次动作；不做启动时无条件清理（cluster 下会误伤其他 worker 正在进行的更新）。

#### 同步期间的其他操作

- `last_status='updating'` 且 `sync_started_at` 未过期时：
  - **Start / Restart → 409**「Update in progress」。
  - **Delete（无论是否删文件）→ 409**。删目录会与 git/npm 正在写入冲突，并级联删掉抢占行。
  - **Stop → 允许**。同步继续更新代码/构建，但结束时不重启（见上）。
- 若 `last_status='updating'` 已过期（超过 `GIT_STALE_SYNC_MS`），上述 guard 不再拦截，下一次操作可直接抢占并继续。

#### 检查更新（手动兜底）

`POST /api/apps/:id/git/check`：

- `git ls-remote origin refs/heads/<branch>` 取远端 SHA，写入 `remote_commit`。
- 返回 `{ remoteCommit, deployedCommit, upToDate, lastStatus, lastError }`。
- 不改变工作区。

#### Webhook

端点：`POST /api/webhooks/github/:appId`（公开，不需要 session）。

校验顺序：

1. body 为 raw JSON（限制 2MB）；`X-GitHub-Event`。
2. `ping` → 200 `{ok:true}`。
3. 非 `push` → 204。
4. 应用不存在 / 未绑定 Git → 404。
5. `X-Hub-Signature-256` = `sha256=<hex>`；用 `crypto.timingSafeEqual` 对比 `HMAC-SHA256(rawBody, webhook_secret)`。失败 → 401。
6. `payload.ref` 必须等于 `refs/heads/<branch>`；`payload.repository.clone_url` 或 `html_url` 规范化（去 `.git`、大小写不敏感）后必须等于配置 URL。不匹配 → 202 `{ ok:true, ignored:true }`（不泄露信息，GitHub 不会重试非 2xx）。
7. `payload.after`（新 commit SHA）写入 `remote_commit`。
8. `auto_update=1` → 触发后台同步（不 await），立即 202 `{ ok:true, message:'update queued' }`；若抢占失败（已有更新在跑），同样 202，等当前一轮结束后由 `remote_commit` 对比自然再跑。
9. `auto_update=0` → `last_status='update_available'`，立即 202。

限流：webhook 路由单独 `rate-limit`，例如 120 次/分钟/IP；不套用登录态 API 的 100/min 限流。挂载方式：在全局 `express.json()` **之前**用 `express.raw({ type: 'application/json', limit: '2mb' })` 挂 webhook router，从而保留 raw body 用于签名验证。

#### GitHub 仓库配置（部署文档）

在仓库 Settings → Webhooks → Add webhook：

- Payload URL: `https://<平台公网地址>/api/webhooks/github/<appId>`
- Content type: `application/json`
- Secret: 从 GitModal 复制
- Events: 仅 `push`

平台本身需公网可达；生产 nginx 需把 `/api/webhooks/` 转发到 5000（与现有 `/api` 相同即可）。

## 数据模型

```sql
-- Per-app Git source (source of truth for git-backed apps).
CREATE TABLE IF NOT EXISTS app_git_source (
  app_id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  auto_update INTEGER NOT NULL DEFAULT 1,
  webhook_secret TEXT NOT NULL,
  deployed_commit TEXT,
  remote_commit TEXT,
  synced_at DATETIME,
  -- idle | updating | success | failed | update_available
  last_status TEXT NOT NULL DEFAULT 'idle',
  last_error TEXT,
  sync_started_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);
```

- `app_git_source` 是新增表，每次启动重跑 schema 即可建好，无需 ALTER。
- `apps` 表不改。API 返回的 app 对象通过 `AppManager.attachGitSource()`（一次 `LEFT JOIN` 或批量查询）附加：
  ```js
  git: {
    url, branch, auto_update, deployed_commit, remote_commit,
    synced_at, last_status, last_error
  } | null
  ```
  `git === null` 即上传型应用，前端不显示 Git 相关 UI。

查询函数（`server/src/db/index.js`，全部 async）：

- `getAppGitSource(appId)`
- `upsertAppGitSource({ appId, url, branch, autoUpdate, webhookSecret })`
- `claimGitSync(appId, staleMs)` → 条件 UPDATE + 返回 changes
- `finishGitSync(appId, { status, error, deployedCommit, remoteCommit })`
- `setGitRemoteCommit(appId, sha)`
- `setGitAutoUpdate(appId, enabled)`
- `deleteAppGitSource(appId)`
- `sweepInterruptedGitSyncs(staleMs)`（可选：仅用于把过期 updating 置为 failed，不在启动时无条件调用）

## 接口

所有受保护接口沿用 `requireAuth` + `apiLimiter`。

### `DELETE /api/apps/:id?deleteFiles=true|false`

- 默认 `false`。
- 服务端流程：`reconcileStatus` → 运行中拒绝（400）→ Git 同步进行中拒绝（409）→ `ProcessManager.deleteProcess`（best-effort）→ 若 `deleteFiles`：校验路径 → `fs.rmSync(app.path, { recursive: true, force: true })` → DB 删除 → `ProxyManager.regenerate()`。
- 路径安全：`path.resolve(app.path)` 必须在 `path.resolve(APPS_DIR)` 之下且不等于 `APPS_DIR`；否则 400，不删除任何东西。
- 文件删除失败 → 500/400，DB 行保留，可重试。
- 成功：`{ success: true, data: { message, filesDeleted: boolean } }`。

### `GET /api/apps/:id/git`

返回 `{ url, branch, autoUpdate, webhookUrl, webhookSecret, deployedCommit, remoteCommit, syncedAt, lastStatus, lastError }`；未绑定 404。`webhookUrl` 由请求的协议/Host 推导（`req.protocol` + `req.get('host')`），便于本地和线上复用。

### `PUT /api/apps/:id/git`

body `{ url, branch?, autoUpdate? }`。校验 URL/分支；首次绑定生成 32 字节 hex secret；修改 URL 保留 secret（用户只需更新 webhook URL 中的 appId，不变）。返回同上。已有更新在跑时允许改配置，但下一轮生效。

- DB 是唯一事实源：每次 git 操作前都 `git remote set-url origin <url>`，所以改配置后下一次 Start/Pull 自动切换仓库。
- **URL 或分支变化时清空** `deployed_commit` / `remote_commit` / `synced_at` / `last_error`，`last_status='idle'` —— 旧仓库的 SHA 不能冒充新仓库的已部署版本。
- 只改 `autoUpdate` 不清空。
- 前端在 URL/分支变化时提示「下一次启动/更新会把工作区切换到新仓库，仓库跟踪的文件会被覆盖，建议先备份」。

### `DELETE /api/apps/:id/git`

解除绑定：删 `app_git_source` 行；保留工作区（含 `.git`）。返回 `{ success:true }`。之后应用是普通上传应用（用户可自行删除目录或重新上传）。运行中允许解除（不影响进程）。

### `POST /api/apps/:id/git/secret`

重新生成 secret，返回同上（含新 secret）。

### `POST /api/apps/:id/git/check`

返回 `{ remoteCommit, deployedCommit, upToDate }`。git 失败 → 400 + 可读错误。

### `POST /api/apps/:id/git/pull`

- 抢占失败（已有更新）→ 409 `{ message: 'Update already in progress' }`。
- 后台执行？**同步执行**：等待同步完成再返回（可能 1-5 分钟，npm 构建）。前端单独用 `timeout: 0`。
- 成功 → `{ success:true, data:{ deployedCommit, lastStatus } }`；失败 → 400 + `lastError`（前端展示）。

### `POST /api/webhooks/github/:appId`

见上。响应码：200 ping / 204 非 push / 202 接收（含忽略）/ 401 签名错误 / 404 应用或绑定不存在 / 429 限流。

### `POST /api/apps`（扩展）

body 可选 `git_url`、`git_branch`、`git_auto_update`。三者存在时在同一流程中创建 source 行。`createApp(name, deployType, gitOptions)` 保持向后兼容（旧调用不传即可）。

- **回滚范围**：source 行插入失败时删除本次创建的 app 行；目录**只在本次请求新建时才删除**。`createApp` 今天会复用已存在的 `apps/<name>/`（`ensureDir` 不报错），这个目录可能是「删除应用时保留的文件」，不能因为创建失败就 `rm -rf`。
- 实现：创建前记录 `dirExisted = fs.existsSync(appPath)` 与目录是否为空；回滚时仅当 `!dirExisted` 或创建前为空时删除目录。

## 服务层

新增 `server/src/services/git-lifecycle.js`：

- `gitExec(args, { cwd })` — `execFile(config.git.bin, args, { cwd, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })`，唯一 git 调用入口，参数数组、永不 shell。
- `validateRepoUrl(url)` / `validateBranch(branch)`（见下）。
- `hasRepo(appPath)` / `ensureRepo(appPath, source)`
- `remoteHead(appPath, branch)` — `ls-remote`
- `sync(app, { reason })` — 抢占 → 拉取 → 构建 → 重启/回滚，返回 `{ status, deployedCommit, error }`。
- `check(app)` / `pull(app)` 薄封装。
- 供 webhook 调用的 `triggerBackgroundSync(appId)`：不 await，失败只记 DB/日志。

`DeployManager` 扩展：

- `deployApp`：git 源前置 clone/fetch（见上），再走原流程。
- `pullGit(appId)` / `checkGit(appId)`：需要 app 行，转调 GitLifecycle。
- `deleteApp(appId, { deleteFiles })` 透传。
- 重启逻辑：复用 `ProcessManager.restartProcess(app.name)`（已有），避免触发 `DeployManager.restartApp` 的完整校验/重建。

`AppManager` 扩展：

- `deleteApp(id, { deleteFiles })`：文件删除 + 路径校验。
- `attachGitSource(app)` / `getGitSource(id)`。
- 创建时绑定 source。

## 校验与安全

- **仓库 URL**：仅 `https://`；正则 `^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._~%\-\/@]+(?:\.git)?$`；拒绝空白、控制字符、`file://`、`ext::`、`ssh://`、`git://`、以 `-` 开头。变更 URL 时重新校验。
- **分支**：`^[A-Za-z0-9._/-]{1,200}$`，不以 `-` 或 `/` 开头，不含 `..`（防参数注入与路径穿越；git 参数始终走数组）。
- **Webhook**：签名 timing-safe；raw body 2MB 上限；单独限流；不返回敏感信息；仓库/分支不匹配返回 202.
- **删除目录**：resolved path 必须严格位于 `APPS_DIR` 内；用 `path.relative` 判断不以 `..` 开头且非空。
- **上传**：Git 应用拒绝 `POST /apps/:id/upload`（400），`platformManagedNames` 增加 `.git`，保证 zip 替换清理不会删掉仓库。
- **备份**：`BackupManager.createBackup` 的 `addLocalFolder` 过滤 `.git`（避免把仓库历史/凭据打进去）；还原出的应用是普通上传应用（manifest 不包含 git 源）。文档里注明。
- **文件列表**：`getAppFiles` 过滤 `.git`（不展示内部目录）。
- **删除应用 + Git 源**：`app_git_source` 级联删除。

## 前端改动

- `client/src/pages/CreateApp.jsx`：新增 Git 区块（URL / 分支 / 自动更新），依赖 URL 非空。
- `client/src/components/GitModal.jsx`（新）：绑定/编辑、状态展示、webhook 信息、检查/拉取/解绑/轮换 secret。
- `client/src/components/AppRow.jsx`：
  - Git 摘要 +「Git」按钮；
  - Git 应用隐藏「上传」；
  - 删除改为带复选框的 Modal（默认不删文件）。
- `client/src/pages/Dashboard.jsx`：`handleDelete(id, deleteFiles)`、`handleGitPull` / `handleGitCheck` 后刷新列表。
- `client/src/pages/UploadFiles.jsx`：Git 应用显示提示并阻止上传（路由直达时）。
- `client/src/api/apps.js`：deleteApp 加 query、git 相关 5 个调用、createApp 携带可选 git 字段、拉取更新 `timeout: 0`。
- `client/src/i18n/locales/{zh,en}.json`：新增文案（删除文件、Git 区块、状态、错误）。
- `server/src/docs/openapi.yaml`：新增/扩展端点与 schema。
- `CLAUDE.md`：新增 GitLifecycle、webhook、`app_git_source`、删除文件选项、配置项。

## 配置

`server/src/config/index.js` 新增：

```js
git: {
  bin: process.env.GIT_BIN || 'git',
  timeoutMs: intFromEnv('GIT_TIMEOUT_MS', 120000),
  staleSyncMs: intFromEnv('GIT_STALE_SYNC_MS', 30 * 60 * 1000)
}
```

- 不设功能总开关：git 二进制不存在时，绑定/启动会返回可读错误（`git` 不可用）。
- `GIT_BIN` 类似 `NGINX_BIN`，用于非 PATH 安装。

## 测试计划

服务端用 `node --test` + `supertest`（现有风格）。

单元：

- `validate-git-url.test.js`：合法/非法 URL、分支、CRLF/控制字符、`-` 开头。
- `webhook-signature.test.js`：HMAC 正确/错误、timing-safe 比较封装。
- `git-lifecycle.test.js`（临时目录 + 本地裸仓库）：
  - 首次 clone（init + fetch + checkout）；
  - 第二次 fetch 无变化 → up to date；
  - 新 commit → reset 后文件更新；
  - 构建失败 → 回滚到 prevSha；
  - 抢占：第二次调用在 updating 时返回 busy；过期后可抢占。
  - 测试中允许 `file://` 仓库 URL（通过 `validateRepoUrl(url, { allowFile: true })` 或 `NODE_ENV=test` 门控），生产仍拒绝。
- `delete-app-files.test.js`：勾选删除 → 目录消失；不勾 → 保留；路径越界 → 拒绝；运行中 → 拒绝。
- `stale-files.test.js` 扩展：`.git` 被保留。
- `backup-manifest` / `backup`：`.git` 不进入备份。

集成（supertest，mock 掉 ProcessManager / GitLifecycle 外部调用）：

- `POST /api/apps` 带 git 字段 → 返回 `git` 对象；非法 URL → 400。
- `PUT/GET/DELETE /api/apps/:id/git` 流程。
- webhook：ping 200、错误签名 401、分支/仓库不匹配 202、正确签名 + auto off → `update_available`、auto on → 调用同步（mock）。
- `POST /git/pull` 更新中 → 409。
- `DELETE /api/apps/:id?deleteFiles=true` → 目录删除；`false` → 保留。

手工端到端（文档步骤）：

1. 创建/绑定 `personal-blog`（npm，公开 HTTPS）。
2. Start，确认安装构建成功。
3. 在 GitHub 配置 webhook（secret + push event）。
4. 推一篇新文章 → 观察 GitModal 状态 `updating` → `success`，站点出现新文章。
5. 推一个会导致构建失败的 commit → 状态 `failed`，站点仍是旧内容（回滚生效）。

## 风险与注意

- **构建期间服务内容可能短暂混合**：npm 应用运行中构建时，`dist` 正在被重写。缓解：构建完成后统一重启；博客构建通常 <1 分钟。若要零抖动需要蓝绿目录，v1 不做。
- **`git clean -fd` 会删除未跟踪且未被仓库忽略的文件**（例如之前在 Git 应用里上传的文件）。这是 Git 源的预期语义；UI 已隐藏上传入口。
- **绑定已有上传应用是覆盖性的**：仓库跟踪的文件会覆盖同名上传文件；未跟踪文件保留。UI 提示先备份。
- **Webhook 依赖公网可达 + 用户手工配置 secret**；配置错误时靠手动「检查更新」兜底。
- **Secret 明文存 DB**（单管理员部署，与现有 session/DB 安全模型一致）。
- **PM2 cluster 跨 worker 并发**：用 DB 条件更新抢占，不依赖进程内存；stale 抢占阈值需大于最长合法构建时间（默认 30 分钟）。
- **GitHub 重试/重复投递**：同一 SHA 幂等（第二次直接 up to date），并发投递由抢占 + `remote_commit` 兜底。
- **首次 clone 大小**：`--depth 1` 限制历史，但仓库当前快照仍可能较大；博客规模无问题。
- **平台自身的 nginx 反代**：webhook 路径在 `/api` 下，现有转发规则已覆盖；若只转发了特定前缀，需要补 `/api/webhooks/`。

## 实施顺序（供 plan 参考）

1. 删除文件选项（小，先落地）。
2. DB 表 + 查询 + AppManager/API 绑定（先只读/配置，不跑同步）。
3. GitLifecycle clone/fetch/sync + 手动 check/pull。
4. Webhook 路由 + 签名/匹配/抢占。
5. 前端 CreateApp / GitModal / AppRow / 删除 Modal。
6. 集成到 deployApp（启动时 clone/auto-fetch）。
7. 文档（CLAUDE.md、OpenAPI、.env.example、博客部署说明）。
8. 测试补齐 + 手工端到端。
