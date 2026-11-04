# Microverse 本体自更新 — 设计

日期：2026-11-04
状态：待实现

## 背景

Microverse 目前更新本体只有一条手工路径（`git pull` → 按需 `install` / `build` → `pm2 reload`），
没有版本检查、没有回滚、也没有可见的更新过程。之前的实际做法是让 AI agent 整个重新部署一遍：
慢，而且 `data/` 与 `apps/` 是 gitignore 的——新克隆一份却忘记搬这两个目录就会丢数据。

部署形态：Ubuntu + PM2 cluster（`microverse-server`）+ 用户自管的 nginx 边缘；
代码是 git checkout，`data/` 和 `apps/` 位于仓库根目录且不被 git 跟踪。

## 目标

1. 页面能看到当前版本，并知道远端有没有新版本。
2. 管理员在页面点一下即可更新；更新过程可见（步骤 + 日志）。
3. 更新失败自动回滚到更新前的 commit，平台回到可用状态。
4. 更新期间已部署的应用不受影响。

## 非目标（v1 明确不做）

- **不改造成蓝绿 / release 目录 / 容器化**。理由见“关键决策 1”。
- 不引入 tag / release channel / beta 通道；以 `main` 分支 HEAD 为唯一版本源。
- 不做数据库迁移框架；只保证**增量 schema**（`CREATE TABLE IF NOT EXISTS`）向前兼容。
- 不做定时自动更新 / 无人值守更新；必须由管理员显式触发。
- 不自动恢复数据库内容（只做更新前备份，见“失败语义”）。
- 不支持 Windows 上的自更新动作（开发机可以看版本，但不能点更新）。
- 不涉及已部署应用本身的更新（那是另一个功能）。

## 关键决策（builder 按此实现）

1. **就地 git 更新 + 自动回滚，不搭蓝绿。**
   后端在 PM2 cluster 下 `reload` 本身就是零停机；前端构建改为“先构建到 `dist.next`，成功后原子换名”，
   已经消除了构建期间 UI 半坏的问题。再做 release 目录/symlink 需要迁移线上目录结构（数据路径、
   PM2 cwd、首次手工切换），收益只是更强的回滚隔离，v1 不值得。
   **约束：在整个 install/build 期间，正在使用的 `client/dist` 必须原地不动**（`app.js`
   每个请求都从这里读静态文件；提前改名会让管理界面 404，若此时 worker 重启还会只提供 API）。
   `dist` 只在“新构建已完整产出”之后做一次换名。
2. **版本 = `git rev-parse HEAD`（短 SHA），展示时附上 `package.json` 的 version。**
   仓库没有 tag，也不打算让用户为了更新去发版。
3. **更新动作必须由 detached 子进程执行。**
   当前 server 进程要 reload 自己，不能在自己进程里做 `git reset` / `npm install`。路由只做同步预检、
   写状态、返回 202，然后 `spawn(..., { detached: true, stdio: 'ignore' })`，helper 继续跑。
4. **默认关闭，`SELF_UPDATE_ENABLED=true` 才启用。**
   开发机、非 git 部署、PM2 不可用的环境里按钮不应存在。启用后预检仍会逐项校验。
5. **只允许在干净工作区、HEAD 与远端一致的 checkout 上更新。**
   有本地改动 / 本地未推送 commit 时拒绝更新（避免 `git reset --hard` 吞掉手工修改）。
6. **健康检查失败 = 回滚代码，不自动回滚数据库。**
   增量 schema 对旧代码向后兼容；备份只是保险，恢复需人工决定。
7. **更新检查与更新动作分离。**
   `GET /api/system/version` 只读（`git ls-remote`，5s 超时，结果落盘缓存 10 分钟，失败静默）；
   更新按钮只在检查通过且管理员点击后进入写路径。

## 架构

```
浏览器
  │  GET /api/system/version          (只读检查)
  │  POST /api/system/update          (预检 + spawn + 202)
  │  GET /api/system/update/status    (轮询状态/日志)
  ▼
server (PM2 cluster)
  │  写 data/update-state.json
  │  spawn detached: node scripts/self-update.js
  ▼
self-update helper (独立进程，不受 reload 影响)
  │  fetch → backup → git pull → npm install → staged build
  │  → pm2 reload → health check
  └─ 失败：git reset --hard <fromSha> → 恢复 dist → reload → 标记 rolled_back
```

### 新增文件

| 文件 | 职责 |
|---|---|
| `scripts/self-update.js` | 独立更新器；所有写操作、状态推进、回滚都在这里 |
| `server/src/services/update-manager.js` | 只读检查 + 预检 + spawn + 状态读取；纯函数（SHA 比较、状态解析）抽出来可单测 |
| `server/src/routes/update.js` | 受保护路由：`/system/version`、`/system/update`、`/system/update/status` |
| `client/src/components/UpdateBadge.jsx` | 版本标识 + “有新版本”标记 |
| `client/src/components/UpdateModal.jsx` | 版本对比、更新按钮、进度/日志/回滚结果 |

### 修改文件

- `server/src/routes/index.js`：`requireAuth` + `apiLimiter` 之后挂 `updateRouter`。
- `server/src/config/index.js`：新增 `selfUpdate.enabled/ref/remote`（见配置）。
- `server/src/docs/openapi.yaml`：新增三个端点。
- `client/package.json`：新增 `build:staging` 脚本。
- `.gitignore`：忽略 `data/update-state.json`、`data/update-check.json`、`data/update.lock`、
  `data/backups/`、`client/dist.next/`、`client/dist.prev/`（`*.log` / `*.sqlite` 已覆盖）。
- `.env.example` / `README.md`：说明开启条件与首次迁移。
- `client/src/api/apps.js` 或新增 `client/src/api/system.js`：三个请求封装。
- 前端 layout/nav：挂 `UpdateBadge`。
- i18n `en.json` / `zh.json`：新增文案。

## 更新检查

`GET /api/system/version`（需登录）返回：

```json
{
  "current": { "sha": "<full>", "shortSha": "<7>", "version": "1.0.0", "committedAt": "<iso>", "dirty": false },
  "latest": { "sha": "<full>", "shortSha": "<7>", "checkedAt": "<iso>" },
  "updateAvailable": true,
  "updateEnabled": true,
  "reason": null
}
```

规则：

- `current`：`git rev-parse HEAD`、`git log -1 --format=%cI`、`git status --porcelain --untracked-files=no`。
  **非 git 目录**或 git 不可用：`current` 为 `null`，`updateEnabled=false`，`reason` 说明原因。
- `latest`：`git ls-remote origin refs/heads/<SELF_UPDATE_REF>`，`execFile` + 5s 超时，不落成 git ref。
  失败时 `latest=null`，`reason='检查失败'`，但 `updateEnabled` 不受影响（仍可手工更新）。
- 缓存：`data/update-check.json`，10 分钟 TTL。多 worker 共享，避免每次打开页面都访问 GitHub。
  写入用“临时文件 + rename”，读取失败按无缓存处理。
- `updateAvailable = current && latest && current.sha !== latest.sha && !current.dirty`。
  如果 `current.sha` 不是 `latest.sha` 的祖先（本地有未推送提交），仍显示有差异，
  但 helper 在 fetch 后的权威预检会拒绝（不改任何文件）。
- `updateEnabled` 只有在“开关打开 + 非 Windows + 是 git 仓库 + `PM2_INSTANCE_NAME`
  在 `pm2 jlist` 中 online”时才为真；否则为 false，并在 `reason` 里说明是哪一条不满足。

## 更新预检（同步，在路由内）

按顺序校验，任一失败返回 400/409 并给出可读原因：

1. `SELF_UPDATE_ENABLED` 为真；`process.platform !== 'win32'`。
2. 没有正在运行的更新（见“锁与状态”）。
3. git 仓库存在，`git status --porcelain --untracked-files=no` 为空，且
   `git rev-parse --is-shallow-repository` 为 `false`（shallow clone 缺历史，无法可靠判断祖先关系）。
4. `pm2 jlist` 中存在 `PM2_INSTANCE_NAME` 且状态为 `online`。只检查 CLI 可解析不够：
   否则会等 pull/install/build 全部做完，才在 `pm2 reload` 失败并回滚。`exec_mode` 不强制
   cluster——fork 模式下 reload 等价于短暂 restart，仍可用。
5. 仓库根可写、`data/` 可写。
6. `git ls-remote` 成功，且远端 SHA 与本地 HEAD 不同（没有可更新内容时没必要启动 helper）。

**祖先 / 分叉判断不在路由里做。** `git ls-remote` 不下载对象，本地对象库里没有远端新 commit，
`git merge-base --is-ancestor HEAD <remoteSha>` 必然失败。路由只做上述廉价检查并返回 202；
helper 在 `git fetch` 之后做权威校验：`git merge-base --is-ancestor HEAD origin/<ref>`，
不满足（本地有未推送提交 / 分叉 / detached HEAD 与 ref 不符）则 `failed`，且不做任何修改。

**不要检查 `data/`、`apps/` 是否被 gitignore。** 运行时文件本来就是 untracked，
`git reset --hard` 只影响 tracked 文件，不会误伤它们。预检用 `--untracked-files=no`，
state/lock/check 这些新文件不会让工作区变“脏”。

预检通过后：

- 写 `data/update-state.json`：`status='running'`、`step='queued'`、`fromSha`、`toSha`、`startedAt`、`pid`。
- `res.status(202).json({ success: true, data: { status: 'running' } })`，在响应发出后用
  `setImmediate` 启动 helper，确保 202 先 flush。
- helper 参数只用服务端计算出的 SHA（正则 `^[0-9a-f]{7,40}$` 再校验一次），走 `execFile` 参数数组，
  不拼 shell。

## Helper 执行步骤与状态

`status` 取值：`idle | running | success | failed | rolled_back`。

| step | 动作 | 失败后 |
|---|---|---|
| `preflight` | 重新校验（防 TOCTOU） | `failed` |
| `fetch` | `git fetch origin <ref>` | `failed` |
| `backup` | `VACUUM INTO <config.database.dbPath 同目录>/backups/<ts>.sqlite`；清理残留的 `client/dist.next`、`client/dist.prev`。**不动正在使用的 `client/dist`**。 | `failed` |
| `pull` | `git merge --ff-only origin/<ref>` | `rolled_back`（通常无需回滚，但仍走统一路径） |
| `install` | `npm install --include=dev --no-audit --no-fund`（根目录，workspaces） | `rolled_back` |
| `build` | `npm run build:staging --workspace=client`；产出 `client/dist.next` 后原子换名（见下） | `rolled_back` |
| `reload` | `pm2 reload <PM2_INSTANCE_NAME>`（helper 自行解析 pm2；参数数组） | `rolled_back` |
| `health` | 轮询 `http://127.0.0.1:<PORT>/api/health`，1s 一次，最多 60s，要求 200 | `rolled_back` |
| `cleanup` | 工作区若只剩 `package-lock.json` 被改，`git checkout -- package-lock.json`；其他 tracked 改动只记 warning，不判失败 | 不适用 |

`npm install` 必须带 `--include=dev`：PM2 以 `NODE_ENV=production` 启动，普通 install 会跳过
vite 等构建期依赖。备份路径必须取 `config.database.dbPath`（支持 `DB_PATH` 覆盖），不能硬编码
`data/*.sqlite`；session 库不需要备份。

### 前端构建与 `dist` 生命周期

- 新增 `client/package.json` 脚本：`"build:staging": "vite build --outDir dist.next --emptyOutDir"`。
  不能写 `npm run build:client -- --outDir ...`——根脚本是
  `npm run build --workspace=client`，额外参数到不了 Vite，可能反而直接构建并清空 `client/dist`。
- `build` 成功后（此刻旧 `dist` 仍完整可用）：删除上一次残留的 `dist.prev`（若有）→
  `dist` 改名为 `dist.prev` → `dist.next` 改名为 `dist`。同一文件系统上的两次 rename，
  换名窗口是毫秒级。
- `health` 成功后：删除 `dist.prev`。回滚时：删除新 `dist`（若已换名）和 `dist.next`，
  `dist.prev` 改回 `dist`。
- `app.js` 在请求时读 `client/dist`，所以换名对静态文件立即生效；后端代码仍需 `pm2 reload`。
  整个 install/build 期间 `dist` 一直存在，worker 即使重启也不会退化成只提供 API。

### 回滚流程

1. `git reset --hard <fromSha>`（预检已保证工作区干净）。
2. 若已发生换名：删除新 `dist`；`client/dist.prev` 恢复为 `client/dist`；删除残留 `dist.next`。
3. 如果 lockfile 变了，重跑 `npm install --include=dev --no-audit --no-fund`（best-effort，失败只记日志）。
4. `pm2 reload <PM2_INSTANCE_NAME>`。
5. 再跑一次健康检查；通过 → `rolled_back`；仍失败 → `failed`，state 里写“需要人工介入”。

**数据库不回滚。** 更新前的备份路径写进 state，供人工恢复。破坏性 schema 变更不在自动更新承诺内。

### 锁与状态

- `data/update.lock`：JSON `{ pid, startedAt }`。启动 helper 前写入，结束时删除。
  PID 不存活或 `startedAt` 超过 2 小时视为 stale，可抢占。
- `data/update-state.json`：原子写（`state.tmp` → rename），字段：
  `status, step, fromSha, toSha, startedAt, finishedAt, error, logPath, pid`。
- `data/update.log`：helper 自己写（带时间戳）；`GET /update/status` 只返回最后 200 行，
  读取上限 64KB，防止大日志拖垮接口。
- PM2 reload 后新 worker 读同一份文件，所以进度在重启前后连续。

## API

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/api/system/version` | 版本 + 远端检查（缓存）；不写状态 |
| POST | `/api/system/update` | 同步预检 → 202 → spawn helper；失败 400，更新中 409 |
| GET | `/api/system/update/status` | `state` + `logTail`（最后 200 行） |

响应沿用 `{ success, data }` / `{ success: false, error: { message } }`。

## 前端

- 导航栏（或页脚）显示 `v1.0.0 · a45f8e7`；`updateAvailable` 时加一个圆点 + “有新版本”。
- 点击打开 Modal：
  - 当前 / 最新短 SHA，提交时间，GitHub compare 链接
    （`https://github.com/kuoluosaigai/microverse/compare/<from>...<to>`）。
  - 未启用时只展示版本，不显示更新按钮，并说明原因（非 git 部署 / 未开启）。
  - 按钮点击后显示步骤列表（preflight→fetch→backup→pull→install→build→reload→health）
    和日志尾部；每 2s 轮询 status。
  - 成功：提示后刷新页面；`rolled_back`/`failed`：红色提示 + 日志，禁止重复点击直到状态变为终态。
- 失败/网络错误轮询：静默重试；PM2 reload 瞬间的 502/连接失败不算更新失败。

## 安全

- 三个端点都在 `requireAuth` 之后；沿用 `apiLimiter`。
- helper 只接受服务端算出的 SHA，使用 `execFile` 参数数组，无 shell 拼接。
- 不接受客户端传入的 ref / 命令 / 路径。
- state / log 不写环境变量、cookie、数据库内容。
- 更新前 `git status` 必须干净，避免 `reset --hard` 破坏用户手工修改。

## 配置

```env
SELF_UPDATE_ENABLED=false   # 打开后页面才出现更新入口
SELF_UPDATE_REF=main        # 跟踪的分支
SELF_UPDATE_REMOTE=origin   # 远端名
```

`PM2_INSTANCE_NAME`（已有）必须与 PM2 实际进程名一致。

## 首次启用（鸡生蛋）

本功能本身必须先手工部署一次：`git pull` → `install` → `build` → `pm2 reload`，
然后在 `.env` 打开 `SELF_UPDATE_ENABLED=true` 并再 reload。之后才可以在页面更新。

## 失败模式

| 场景 | 结果 |
|---|---|
| 远端不可达 / GitHub 慢 | 检查显示失败；不影响现有更新按钮之外的功能；可用 SSH 手工更新 |
| 有本地改动 / 本地未推送提交 | 路由预检或 helper 权威预检拒绝，不改文件 |
| 平台不在 PM2 托管 / 进程名不匹配 | `updateEnabled=false`，页面只显示版本，不给更新按钮 |
| 依赖安装失败 | 回滚代码 + reload，`rolled_back`；`dist` 全程未动 |
| 前端构建失败 | `dist` 全程未动；删除 `dist.next`，回滚代码 + reload，`rolled_back` |
| reload 后健康检查失败 | 恢复 `dist.prev` → `dist`，回滚代码 + 二次 reload，`rolled_back` |
| 更新成功后 `npm install` 改了 lockfile | cleanup 自动 `git checkout -- package-lock.json`；不阻塞下次更新 |
| 更新成功后其他 tracked 文件变脏 | 仍算 `success`，state 里记 warning；下次更新前需人工清理 |
| 回滚也失败 | `failed` + 人工介入提示 |
| helper 进程被 kill | 锁 2 小时后 stale；state 停在进行中，需人工清理 |
| 两个管理员同时点 | 第二个请求 409 |

## 测试

- 单测：SHA/状态纯函数、状态文件原子读写、日志尾部截断、stale 锁判定、预检分支（mock
  `execFile`：非 git 目录 / dirty / 落后 / 分叉 / pm2 缺失）。
- 路由测试：未登录 401；关闭 400；更新中 409；预检通过 202 且只 spawn 一次（注入 fake spawn）。
- Helper 测试：用临时目录 + fake `git`/`npm`/`pm2` 脚本验证步骤顺序、失败回滚、状态机推进
  （不连真实 PM2/npm）。
- 手工验证（`docs/manual-verification.md` 追加）：
  1. 正常更新：点更新 → 步骤走完 → 版本变化 → 页面刷新。
  2. 构建失败注入（临时改 build 脚本 exit 1）→ 自动回滚 → 旧版本仍可访问。
  3. 健康检查失败注入（临时让 `/api/health` 500）→ 回滚。
  4. 更新期间已部署应用仍是 Live。

## 未来扩展（不在本轮）

- release 目录 + symlink 的蓝绿切换与即时回滚。
- tag/release channel。
- 数据库迁移框架。
- “有新版本”邮件/webhook 通知。
