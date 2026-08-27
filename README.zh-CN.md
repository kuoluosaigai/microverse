# <img src="client/public/favicon.svg" width="28" height="28" alt="Microverse" align="top"> Microverse

> 轻松部署和管理你的微型应用

**语言：** [English](README.md) | [中文](README.zh-CN.md)

一个基于 Web 的平台，用于部署和管理微型应用。通过单一的 Web 界面，你可以创建、上传并部署多个具有不同运行时环境（npm、http-server、nginx）的小型 Web 应用 —— 让那些零散的静态站点和微型 Node 服务有一个统一的归宿，而不是散落在十几个被遗忘的端口上。

## 功能特性

- 📁 **应用管理**：在专用目录中创建和组织应用
- 📤 **拖拽上传**：上传单个文件或 ZIP 压缩包（上传时自动解压）
- 🚀 **多种部署方式**：
  - `http-server` —— 适用于静态网站（需要 `index.html`）
  - `npm` —— 适用于 Node.js 应用（需要带 `start` 脚本的 `package.json`；启动时自动执行 `npm install` + 可选的 `npm run build`；平台会分配端口并注入 `PORT` 与你设置的环境变量）
  - `nginx` —— 适用于由 nginx 提供服务的静态网站（需已安装 nginx；若不在 `PATH` 中请设置 `NGINX_BIN`）
- 🔗 **集中式仪表板**：在一处查看并访问每个已部署的应用
- ⚙️ **端口管理**：在可配置的范围内自动分配端口（默认 3000–9000）
- 📊 **状态同步**：`Live`（运行中）/ `Idle`（已停止）状态，与 PM2 实际进程状态保持一致
- 🔒 **管理员登录**：仪表板和 API 由单一管理员会话保护（在 `.env` 中设置 `ADMIN_USERNAME`/`ADMIN_PASSWORD`；密码在首次启动时会被 bcrypt 哈希处理）
- 💾 **备份与恢复**：可将任意应用导出为 zip（文件 + 清单 + 环境变量），并在同一实例或另一实例上恢复。备份中包含环境变量（可能含有敏感信息），请妥善存储与分享
- 📜 **实时日志**：在专属日志页面流式查看每个应用的 PM2 stdout/stderr —— 打开时显示最近的日志历史，随后实时追加新行
- 📈 **资源监控**：每个应用的 CPU / 内存 / 运行时长 —— 在仪表板行内显示，并在专属监控页面提供 sparkline 历史曲线（每 10 秒采样一次）
- 🌐 **双语界面**：中英文一键切换，按浏览器持久化保存
- 🎨 **编辑式界面**：暖纸色背景、衬线/等宽字体、单一强调色 —— 刻意设计的非模板化外观（参见 [设计规范](docs/superpowers/specs/2026-06-28-editorial-ui-redesign-design.md)）

## 截图

**仪表板** —— 应用以带编号的编辑式行列呈现（图中处于 `Idle`（已停止）状态；运行中的应用会显示红色的 `Live`（运行中）状态标识和一个可点击的端口标签，点击即可打开已部署的应用）：

![Dashboard](docs/assets/dashboard.png)

**创建应用** —— 下划线输入框、细线选择控件、墨色提交按钮：

![Create App](docs/assets/create-app.png)

**上传文件** —— 纸张感拖拽区，显示当前的单文件大小上限（`100MB per file`，通过 `GET /api/config` 获取，由 `MAX_FILE_SIZE` 控制）：

![Upload Files](docs/assets/upload-files.png)

## 📚 文档

**初次接触 Microverse？** 从这里开始：
- 📖 [安装与使用指南](README.zh-CN.md) - 你正在阅读的就是
- 🚀 [快速开始指南](#快速开始) - 5 分钟内启动并运行

**面向开发者：**
- 🏗️ [架构与开发指南](CLAUDE.md) - 了解代码库架构
- 📋 [开发进度](PROGRESS.md) - 当前状态与路线图
- 🔄 [日常工作流指南](WORKFLOW.md) - 如何开始/结束你的工作日
- 📚 [文档索引](DOCS.md) - 完整的文档总览
- 🎨 [UI 设计规范](docs/superpowers/specs/2026-06-28-editorial-ui-redesign-design.md) - 编辑式重设计

## 快速开始

### 前置条件

- Node.js >= 18.0.0
- npm >= 9.0.0
- 已全局安装 [PM2](https://pm2.keymetrics.io/)（`npm install -g pm2`）；如果要做 `http-server` 静态部署，还需全局安装 `http-server`（`npm install -g http-server`）

### 安装

1. 克隆仓库：
```bash
git clone <repository-url>
cd microverse
```

2. 安装依赖：
```bash
npm run install:all
```

3. 创建环境配置：
```bash
cp .env.example .env
```

4. 启动开发服务器：
```bash
# Start both frontend and backend in development mode
npm run dev

# Or start them separately:
npm run dev:server  # Backend on http://localhost:5000
npm run dev:client  # Frontend on http://localhost:5173
```

5. 打开浏览器访问 `http://localhost:5173`

### 生产部署

在生产环境中，后端会从单一端口同时提供 API 服务和已构建的前端 UI，
因此你只需反向代理这一个端口到你的域名即可。

1. 构建前端：
```bash
npm run build:client
```

2. 在 `.env` 中至少设置以下生产环境变量：
```env
NODE_ENV=production
PORT=5000                            # the port your reverse proxy targets
SESSION_SECRET=<long random string>  # stable across restarts (else sessions reset)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<initial password>    # bcrypt-hashed on first boot, then ignored
```

3. 运行后端 —— 当 `NODE_ENV=production` 时，它还会同时提供 `client/dist` 的访问：
```bash
# directly
npm run start:server

# or under PM2 (cluster mode, zero-downtime reloads)
cd server
npm run pm2:start
```

4. 在 `:<PORT>` 前放置反向代理（nginx/caddy/…）以服务你的域名
   （用于 TLS 终结；如果你把已部署的应用暴露在子域名下，请将每个应用子域名映射到其分配的端口）。该代理属于你自己的基础设施；Microverse 并不管理它。

> 若要让已部署应用的 **Open**（打开）链接使用你的域名而非 `localhost`，
> 请设置 `APP_PUBLIC_URL_TEMPLATE`（参见 [配置](#配置)）。

### 反向代理（在 80 端口通过子域名访问）

应用默认监听高端口。若要通过 `http://<app>.yourdomain.com/` 在 80 端口访问它们，
请启用平台托管的反向代理：

1. 安装 nginx，并确保它的 `nginx.conf` 包含下方配置目录（Debian/Ubuntu 默认
   include `/etc/nginx/conf.d/*.conf`）。
2. 在 `.env` 中设置 `PROXY_ENABLED=true` 以及 `APP_PUBLIC_URL_TEMPLATE=http://{name}.yourdomain.com`
   （或设置 `PROXY_BASE_DOMAIN=yourdomain.com`）。
3. 为每个应用子域名添加 DNS 记录（或一条 `*.yourdomain.com` 通配记录）指向本服务器。
4. 以足够权限运行平台，使其能够写入 `PROXY_CONF_FILE` 并执行
   `nginx -s reload`（通常：PM2 进程以 root 运行，或处于 `nginx` 组中并对配置目录
   + pid 文件具有写权限）。

启动 / 停止 / 删除应用时，平台会自动重新生成并 reload 配置。你也可以在某个运行中的
应用所在行勾选**根域名默认应用**开关，让 `http://yourdomain.com/` 由它提供服务。SSL
结构已预留——当你提供证书路径（`PROXY_SSL_*`）时即生效；平台自身**不签发**证书，请
自行获取（例如 `certbot`）并在配置中指向它。

#### 自定义域名（任意域名 → 端口 / 应用）

除了自动生成的 `<app>.<base-domain>` 子域名，你还可以把任意外部域名映射到内部端口
（本机任意 web 服务）或某个 Microverse 应用。可在 `/routes` 页面（**域名映射**，仅当
`PROXY_ENABLED=true` 时出现在 Dashboard 导航中）管理，也可通过 API：

- `GET /api/proxy-routes` —— 列出自定义域名映射
- `POST /api/proxy-routes` —— 新建映射（`{ host, target_type: 'port'|'app', target_port?, target_app_id? }`）
- `PUT /api/proxy-routes/:id` —— 更新映射
- `DELETE /api/proxy-routes/:id` —— 删除映射

映射与自动子域名块写入同一个 `PROXY_CONF_FILE`，且渲染在自动块**之前**（显式配置优先）。
v1 仅 HTTP（`listen 80`），**不依赖** `PROXY_BASE_DOMAIN`——请把自定义域名的 DNS 解析到
本机，并确保系统 nginx 监听 80 且 include 该 conf 文件。指向应用的映射只有在该应用运行时
才路由；停用后不再路由（UI 显示「未运行」）。

### 更新现有部署

`data/*.sqlite`（应用、环境变量、管理员账户）和 `apps/`（已部署的应用文件）都被 gitignore 忽略，且数据库 schema 在启动时会自愈（`CREATE TABLE IF NOT EXISTS`），因此更新绝不会丢失数据，也无需任何迁移步骤。

```bash
git pull origin main

# only if dependencies changed in this update:
npm run install:all

# only if the frontend changed in this update:
npm run build:client

# reload the backend (PM2 cluster mode = zero downtime):
pm2 reload microverse-server
# (or restart however you run it)
```

正在运行的已部署应用（即由 PM2 托管的 http-server/nginx/npm 进程）
在平台更新期间会继续运行。

> **如果你之前为了提供前端服务而手动修改过 `server/src/app.js`**
> （例如通过某个自动化部署工具），现在仓库已官方支持此功能。
> 请在 pull 之前丢弃你的本地补丁，以免产生冲突：
> `git checkout -- server/src/app.js` 然后 `git pull`。

## 用法

### 创建应用

1. 点击顶部导航栏中的 **+ New app**（新建应用）
2. 输入唯一的应用名称（仅允许字母、数字、横线和下划线）
3. 选择部署类型：
   - **静态网站 (http-server)**：适用于 HTML/CSS/JS 静态网站
   - **Node.js 应用 (npm)**：适用于带 `package.json` `start` 脚本的 Node.js 应用（启动时会自动安装依赖并按需运行 build）
   - **Nginx**：适用于静态网站，由 nginx 提供服务（请另行安装 nginx；若不在 `PATH` 中请设置 `NGINX_BIN`）
4. 提交 —— 应用会以 `Idle`（已停止）状态出现在仪表板上

### 上传文件

1. 在应用所在行点击 **Upload**（上传）
2. 将文件拖到拖拽区（或点击选择），可以包含 `.zip` —— 压缩包会在上传时自动解压
3. 允许的类型：HTML、CSS、JS、JSON、TXT、MD、图片（JPG/PNG/GIF/SVG/ICO）、ZIP
4. 点击 **Upload Files**（上传文件）—— 你会回到仪表板

### 部署与访问

1. 在应用所在行点击 **Start**（启动）—— 会自动分配一个端口。对于 **npm** 应用，首次启动还会运行 `npm install`（如果存在 build 脚本，还会运行 `npm run build`），因此按钮会显示 **Starting…**（启动中…）直到进程真正上线。
2. 状态会切换为 **Live**（运行中），端口会变成可点击的标签
3. 点击端口标签，在 `http://localhost:<port>` 打开已部署的应用
4. 使用 **Stop**（停止）将其切回 **Idle**（已停止）

### 管理应用

- **Start（启动） / Stop（停止）**：通过 PM2 切换应用的进程
- **View Directory（查看部署目录）**：在模态框中查看已部署的文件
- **Upload（上传）**：添加或替换文件
- **Logs（日志）**：在专属页面打开应用的实时日志流（stdout/stderr，历史 + 实时）
- **Environment（环境变量，仅 npm）**：在 npm 应用所在行点击 **Environment** 以设置键值对环境变量（例如 `API_KEY`）。它们会在下次启动时注入 —— 修改后请重启。平台还会为每个 npm 应用分配端口，并以 `PORT` 暴露。
- **Delete（删除）**：删除应用（必须先停止；其 PM2 条目会被清理）
- **Refresh（刷新）**：重新获取应用列表；每次请求时通过 sync 端点与 PM2 状态进行对账

## 项目结构

```
microverse/
├── server/                 # Backend server
│   ├── src/
│   │   ├── server.js      # Process entry (listens + bootstraps)
│   │   ├── app.js         # createApp() — Express app factory (used by tests)
│   │   ├── config/        # Configuration management
│   │   ├── db/            # Database (SQLite via sqlite3)
│   │   ├── routes/        # API routes
│   │   ├── services/      # Business logic (AppManager / ProcessManager / DeployManager)
│   │   ├── middleware/    # Express middleware (errors, upload)
│   │   └── utils/         # Utility functions (path-helper)
│   └── package.json
├── client/                # Frontend application
│   ├── public/
│   │   └── favicon.svg    # Editorial grid mark
│   ├── src/
│   │   ├── pages/         # React pages (Dashboard, CreateApp, UploadFiles)
│   │   ├── components/    # EditorialShell, AppRow, LanguageSwitcher
│   │   ├── api/           # API client
│   │   ├── i18n/          # zh / en locales
│   │   └── styles/        # index.css (palette + antd neutralization) + editorial.css
│   └── package.json
├── apps/                  # Deployed applications directory (runtime data)
├── data/                  # Database files (runtime data)
└── package.json           # Root workspace configuration
```

## API 端点

所有端点均返回 `{ success, data }` 或 `{ success: false, error: { message } }`。

> 交互式 API 文档（Swagger UI）：`http://localhost:5000/api-docs` —— 原始规范位于 `GET /openapi.json`。

### 应用
- `GET /api/apps` - 列出所有应用
- `GET /api/apps/:id` - 按 ID 获取应用
- `POST /api/apps` - 创建应用（请求体：`{ name, deploy_type }`）
- `DELETE /api/apps/:id` - 删除应用（必须先停止）
- `POST /api/apps/:id/start` - 启动（分配端口，通过 PM2 启动）
- `POST /api/apps/:id/stop` - 停止
- `POST /api/apps/:id/restart` - 重启
- `POST /api/apps/:id/sync` - 将数据库状态与 PM2 实际进程状态对账
- `GET /api/apps/:id/files` - 列出应用的已部署文件
- `POST /api/apps/:id/upload` - 上传文件（`multipart/form-data`，字段名 `files`；ZIP 自动解压）
- `GET /api/apps/:id/logs/stream` - 实时日志流（SSE；先发送最近历史，再推送新行；`?lines=N`，默认 100）
- `GET /api/apps/:id/env` - 列出应用的环境变量
- `PUT /api/apps/:id/env` - 替换应用的环境变量（`{ env: [{ key, value }] }`；下次启动时生效）

### 反向代理（自定义域名映射）
- `GET /api/proxy-routes` - 列出自定义域名映射
- `POST /api/proxy-routes` - 新建映射（请求体：`{ host, target_type: 'port'|'app', target_port?, target_app_id? }`）
- `PUT /api/proxy-routes/:id` - 更新映射
- `DELETE /api/proxy-routes/:id` - 删除映射

### 系统
- `GET /api/health` - 健康检查
- `GET /api/config` - 公开的客户端配置（上传限制）
- `GET /` - 服务器信息

## 配置

将 `.env.example` 复制为 `.env` 并按需调整：

```env
# Server
PORT=5000
HOST=0.0.0.0
NODE_ENV=development

# CORS
CORS_ORIGIN=http://localhost:5173

# Database
# DB_PATH=./data/microverse.sqlite

# Deployed-app port range
APP_PORT_MIN=3000
APP_PORT_MAX=9000

# File upload limits
MAX_FILE_SIZE=104857600  # 100MB in bytes
MAX_FILES=100

# Deployed-app "Open" link template ({name} -> app name); unset -> http://localhost:<port>
# APP_PUBLIC_URL_TEMPLATE=https://{name}.yourdomain.com

# npm install / build timeouts (ms, default 300000)
NPM_INSTALL_TIMEOUT_MS=300000
NPM_BUILD_TIMEOUT_MS=300000

# Admin auth（单管理员）—— 注意事项见下方
ADMIN_USERNAME=admin
ADMIN_PASSWORD=            # 明文；仅在首次启动时用于生成 bcrypt 哈希，之后被忽略
SESSION_SECRET=            # 生产 / PM2 cluster 下必须设置（见下方）
# SESSION_COOKIE_SECURE=false   # 强制 cookie Secure；默认在 production 下跟随 PROXY_SSL_ENABLED
# SESSION_DB_PATH=data/sessions.sqlite   # 共享 session 存储（cluster 安全、重启不丢）

# nginx 二进制（默认 'nginx' = PATH）。nginx 部署类型 和 反向代理 reload 都用它。
# 必须指向真实存在的可执行文件——见下方说明。
NGINX_BIN=nginx

# PM2
PM2_INSTANCE_NAME=microverse-server

# Reverse proxy（平台托管的 nginx 边缘反代；opt-in）。见上方"反向代理"章节。
# PROXY_ENABLED=false
# PROXY_CONF_FILE=/etc/nginx/conf.d/microverse_apps.conf
# PROXY_BASE_DOMAIN=                # 留空 -> 从 APP_PUBLIC_URL_TEMPLATE 推导
# PROXY_SSL_ENABLED=false           # 仅 SSL 结构；v1 不签发证书
# PROXY_SSL_CERT=/etc/letsencrypt/live/<domain>/fullchain.pem
# PROXY_SSL_CERT_KEY=/etc/letsencrypt/live/<domain>/privkey.pem
```

> 单文件大小上限通过 `MAX_FILE_SIZE`（默认 100MB）配置，由上传中间件强制执行，并通过 `GET /api/config` 暴露给前端 UI。

**`SESSION_SECRET`——生产 / PM2 cluster 下必须设置。** 每个 worker 都从它派生 cookie 签名密钥；不设的话每个 worker 用不同的随机密钥，互相拒绝对方 cookie（偶发 `401 Authentication required` / 无故被登出）。填一串足够长的随机字符串即可。session 存在 `SESSION_DB_PATH`（sqlite）里，跨 worker 共享、重启不丢。

**`ADMIN_PASSWORD`——仅首次启动生效。** `.env` 里是明文，只在 `users` 表为空时用于生成 bcrypt 哈希写入 DB。管理员一旦存在，再改 `.env` 里的 `ADMIN_PASSWORD` **完全不生效**。要重置密码：在 `.env` 设好新值 → 删除 `users` 行（或整个 DB）→ 重启，`ensureAdmin` 会用当前 `.env` 重新建。

**`NGINX_BIN` 必须指向真实存在的 nginx 可执行文件。** 反向代理的校验与 reload（`nginx -t` / `nginx -s reload`）和 nginx 部署类型都靠它。若它指向一个不存在的路径（例如残留的 `nginx-wrapper.sh`），`nginx -t` 会失败，平台会回滚配置，应用子域名就会落到 nginx 默认的 "Welcome to nginx" 页。日志里的症状：`⚠ [proxy] nginx -t failed: ... not found`。修法：`which nginx` 拿到真实路径，把 `NGINX_BIN` 指过去（若 nginx 在 `PATH` 里，保持默认 `nginx` 即可）。

## 跨平台兼容性

设计为可在 Windows 和 Linux 上同样工作：

- **路径处理**：到处都使用 Node.js 的 `path` 模块（不使用字符串拼接的路径）
- **环境变量**：使用 `cross-env` 提供兼容 Windows 的脚本
- **文件操作**：使用 `fs` API 而非 shell 命令
- **PM2 + Windows**：PM2 的 fork 模式无法启动 `.cmd` 包装器（npm、http-server），因此 `ProcessManager` 会解析 JS 入口点（`http-server/bin/http-server`、`npm/bin/npm-cli.js`）并使用 `interpreter: 'node'` 运行它们
- **nginx 部署类型**：nginx 是系统二进制文件（不是 npm 包）。请设置 `NGINX_BIN`（默认 `nginx`）指向它；PM2 会以 `interpreter: 'none'` 和 `daemon off;` 启动它。每个应用自己的 `pid`/`error_log`/`access_log` 都会重定向到应用目录中，因此 nginx 不需要对其安装前缀有写权限。
- **数据库**：使用 `sqlite3` 包（不使用 `better-sqlite3`，因为它在 Windows 上存在编译问题）

## 开发

### 后端开发
```bash
cd server
npm run dev
```

### 前端开发
```bash
cd client
npm run dev
```

对前端进行 lint 与构建：
```bash
cd client
npm run lint    # ESLint, --max-warnings 0
npm run build   # Vite production build
```

### 测试

后端单元 + 集成测试（使用 Node 内置的 test runner）：

```bash
npm test
```

覆盖了纯辅助函数以及所有不依赖 PM2 的 API 端点（在隔离的临时数据库上测试）。依赖 PM2 的端点（start/stop/restart/sync/metrics/logs）仍为人工验证。

> 注意：测试套件使用 glob 形式的 test-runner 调用（`node --test "src/test/**/*.test.js"`），需要 Node ≥ 22；服务器运行时本身支持 Node ≥ 18（`engines.node`）。

### 数据库

SQLite 用于存储应用元数据。数据库文件会在首次启动服务器时自动创建于 `data/microverse.sqlite`。若要重置，删除该文件并重启服务器即可。

## 故障排查

### 端口已被占用
- 停止占用该端口的进程，或者在 `.env` 中修改 `PORT`

### 找不到 PM2 命令
```bash
npm install -g pm2
# or
npx pm2 list
```

### 数据库错误
```bash
rm data/microverse.sqlite   # Linux/Mac
del data\microverse.sqlite  # Windows
npm run dev:server
```

## 技术栈

- **后端**：Node.js + Express + SQLite（`sqlite3`）
- **前端**：React 18 + Vite + Ant Design 5 + react-i18next
- **进程管理**：PM2
- **跨平台**：`path` 模块、`cross-env`、与平台无关的 API

## 许可证

MIT © [kuoluosaigai](https://github.com/kuoluosaigai)

---

**组织**：[kuoluosaigai](https://github.com/kuoluosaigai) - 这个世界

**项目**：microverse - Deploy your micro worlds
