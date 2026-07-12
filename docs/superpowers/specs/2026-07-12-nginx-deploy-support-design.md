# Nginx 部署支持 — 设计文档

- **日期**: 2026-07-12
- **状态**: Approved (design)
- **范围**: Phase 12 的第一块——把 `nginx` 从 schema 占位变成可用的**静态站部署类型**（http-server 的 nginx 版）
- **不在范围**: 反向代理、SSL 证书、域名绑定（留给后续"网关层"迭代）

## 背景

`apps.deploy_type` 的 CHECK 约束早就允许 `nginx`（`schema.sql:8`），但全链路是占位：

- `process-manager.js:152` — `case 'nginx': throw new Error('Nginx deployment not yet implemented')`
- `app-manager.js:195` — nginx 校验只看"有没有文件"
- `CreateApp.jsx:64` — `<Option value="nginx" disabled>`
- README / PROGRESS 把它标为 placeholder

README 把 nginx 描述成"第三种部署类型"，但 PROGRESS Phase 12 又写成"反向代理 + SSL + 域名"的网关层——两者形态完全不同。本设计先交付前者形态（每 app 一个 nginx 静态站），后者作为独立子系统留待将来。

## 关键决策（两轮 brainstorm 已确认）

1. **nginx 的核心职责 = 静态站服务器**。每个 nginx app 分配一个端口，由 nginx 进程 serve 该 app 目录的静态文件；复用现有端口分配 / PM2 / 日志架构。SSL / 域名以后再说。
2. **nginx 二进制定位 = `NGINX_BIN` 环境变量（默认 `nginx` 走 PATH）+ 启动探针**。服务启动时 `nginx -v` 探一次，缺失仅 warn（不阻断，因为 http-server/npm app 用不到）。
3. **代码结构 = 新建 `NginxLifecycle` 服务**，对称镜像现有 `NpmLifecycle`。配置生成 / 二进制 / 预检逻辑独立，`ProcessManager` 保持纯"PM2 启动"职责。

## 架构

```
server/src/services/
├── npm-lifecycle.js        # 已有：install/build/resolveEnv
├── nginx-lifecycle.js      # 新增：resolveBinary / generateConfig / testConfig / probe
├── process-manager.js      # 改：新增 case 'nginx'
├── app-manager.js          # 改：nginx 校验改为要求 index.html
└── deploy-manager.js       # 改：nginx 分支（生成配置 → 预检 → startProcess）
```

### `NginxLifecycle` API（全部静态方法）

| 方法 | 职责 | 返回 / 抛错 |
|---|---|---|
| `resolveBinary()` | 返回 `config.deployment.nginxBin`（默认 `'nginx'`） | 字符串 |
| `generateConfig(appPath, name, port)` | 写 `<appPath>/nginx.<name>.conf`，返回路径。**持久化**（不自动删——PM2 restart 要重读） | 配置文件绝对路径 |
| `testConfig(confPath)` | 跑 `<bin> -t -c <conf>`，区分二进制缺失 vs 配置错 | `{ ok, message }`；调用方（deployApp）据 `ok` 抛 400 |
| `probe()` | 跑 `<bin> -v`，服务启动时调用 | `{ ok, message }`，仅 warn |

错误消息（供路由层 `isClientError` 字符串匹配）：
- 二进制缺失：`'nginx binary not found (set NGINX_BIN or add nginx to PATH)'`
- 配置错：`'nginx config invalid: <stderr 尾部约 500 字>'`

### 新增配置

`config/index.js` → `deployment.nginxBin = process.env.NGINX_BIN || 'nginx'`；`.env.example` 同步加 `NGINX_BIN=nginx` 一行 + 注释。

## nginx 配置模板

nginx 默认把 `pid` / `error_log` / `access_log` 写到安装前缀（Windows 下常是 `C:\nginx\` 或 Program Files，**不可写**）→ 启动必败。三个路径**必须**重定向到 app 目录。

```nginx
worker_processes  1;
error_log  "<APP>/nginx-error.log"  warn;
pid        "<APP>/nginx.pid";

events { worker_connections 1024; }

http {
  access_log  "<APP>/nginx-access.log";

  server {
    listen <PORT>;
    server_name _;
    root   "<APP>";
    index  index.html;

    location / {
      try_files $uri $uri/ =404;
    }
  }
}
```

- `<APP>` = app 绝对路径，**用引号包裹**（项目根可能含空格，如 `D:\My Code\...`；app 名已被 `path-helper` 过滤为 `[a-zA-Z0-9-_]`，目录名本身无空格）。
- `<PORT>` = 平台分配的端口。
- `temp_path` 系列**不加**（纯静态 GET 命中不到，YAGNI；未来支持上传再补）。
- 不设 `user` 指令（默认当前用户；绑非 80 端口无需 root）。

## ProcessManager 新增 nginx 分支

与 http-server / npm 的**两处关键差异**：

```js
case 'nginx': {
  if (!port) throw new Error('Port is required for nginx deployment');
  const appsEntry = {
    name,
    script: NginxLifecycle.resolveBinary(),                  // 系统二进制，不是 JS 入口
    args: ['-c', options.nginxConf, '-g', 'daemon off;'],     // 数组，避免空格/引号转义
    cwd: appPath,
    interpreter: 'none',   // ← 关键：直接 exec 二进制，不走 node
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 10,
    min_uptime: 1000
  };
  const configPath = this.writeEcosystemConfig(appPath, name, appsEntry);
  await execPromise(`pm2 start "${configPath}"`);
  return { success: true, message: `Process ${name} started` };
}
```

- `interpreter: 'none'`：nginx 是原生二进制，不是 `.cmd` 包装（**没有** Windows 的 PM2 fork `.cmd` 问题），PM2 直接 exec。
- `daemon off;`：让 nginx master 留在前台，PM2 才能跟踪 / 重启 / 收集 stderr。
- `args` 用数组（http-server / npm 用字符串）：`daemon off;` 含空格 + 路径，数组交给 PM2 切分，跨平台无引号地狱。

## 数据流（每个生命周期操作）

| 操作 | nginx 路径 | 改动 |
|---|---|---|
| **创建** `POST /apps` | `createApp` 已允许 nginx → 建 app 目录 + DB 行（status=stopped） | 无 |
| **上传** `POST /apps/:id/upload` | 文件落入 app 目录（含 ZIP 解压） | 无 |
| **校验** `validateAppDeployment` | nginx 分支：要求 `index.html`（缺则 start 前 400） | **改**：从"任意文件"→"要求 index.html" |
| **启动** `POST /apps/:id/start` | `deployApp` → 分配端口（已有逻辑）→ `generateConfig` → `testConfig` 预检 → `startProcess(app, {nginxConf})` → PM2 起 nginx | **新分支** |
| **停止 / 重启** | `stopProcess` / `restartProcess`（PM2 对 nginx master 发信号） | 无 |
| **同步状态** | `getProcessStatus`（PM2 jlist 查 nginx 进程） | 无 |
| **删除** | `deleteProcess` 清 PM2 残留（已有） | 无；`nginx.*.conf` / pid / log 留在 app 目录（同"不删 app 目录"现行策略） |

端口分配段（`deploy-manager.js:33-42`）已对任何无端口 app 生效，nginx 自动复用，只需把注释从 "both http-server and npm" 改成三者。

### `DeployManager.deployApp` nginx 分支

```js
if (app.deploy_type === 'nginx') {
  const confPath = NginxLifecycle.generateConfig(app.path, app.name, app.port);
  const result = NginxLifecycle.testConfig(confPath);
  if (!result.ok) throw new Error(result.message);   // 映射成 400
  await ProcessManager.startProcess(app, { nginxConf: confPath });
} else if (app.deploy_type === 'npm') {
  // …现有 install/build/resolveEnv/startProcess
} else {
  await ProcessManager.startProcess(app);  // http-server
}
```

## 错误处理

两层防御，错误信息对齐 npm 的"clean 400"风格：

| 时机 | 检查 | 失败处理 | HTTP |
|---|---|---|---|
| **服务启动**（`app.js` boot） | `NginxLifecycle.probe()` → `nginx -v` | 仅 `console.warn`（不阻断） | — |
| **start 前**（`deployApp` nginx 分支） | `generateConfig` → `testConfig()` → `nginx -t -c <conf>` | 抛错 → 400 | 400 |
| **start 前**（`validateAppDeployment`） | 要求 `index.html` | 抛 `'Missing index.html for nginx deployment'` → 400（已有 `'Missing'` 子串匹配） | 400 |

`routes/index.js` 的 start 处理器 `isClientError` 字符串列表新增两条：`'nginx binary not found'`、`'nginx config invalid'`（与现有 `'npm install failed'` 等同构）。

结果：nginx start 的 4 类失败（index.html 缺、二进制缺、配置错、already running）全部返回明确 400，前端 `message.error` 直接显示——与 npm 体验一致。

## 前端改动

- `CreateApp.jsx:64`：删掉 `<Option value="nginx" disabled>` 的 `disabled`。**唯一功能改动。**
- i18n（`client/src/i18n/locales/{zh,en}.json`）：
  - `appCard.deployTypes.nginx` = `"Nginx"`（zh/en 均已存在，**无需改**）。
  - `createApp.nginx` 现为 `"Nginx (Coming Soon)"` / `"Nginx (即将推出)"`——启用后**必须**改成 `"Nginx"`（或 `"Nginx (静态站)"`），否则灰显虽去掉、文案仍误导。
- `AppRow` / `Dashboard` / `UploadFiles` / `AppLogs`：**零改动**——端口 chip、启停、日志入口、上传、查看目录全是 deploy_type 无关的通用逻辑。Env 按钮正确地保持仅 npm 可见。
- `openapi.yaml`：`deploy_type` 枚举已含 nginx（schema 早就有），确认 CreateApp schema 描述不再说 "disabled"。

## 测试

本特性**不引入测试框架**（"补测试覆盖"是独立 tech-debt 任务，本轮未选）。手动测试矩阵：

```
前置：本机装 nginx 并加 PATH（或设 NGINX_BIN=D:\nginx\nginx.exe）

1. 创建 nginx app        → Dashboard 出现，Idle
2. 上传 index.html + 资源 → 查看目录可见
3. Start                 → 分配端口，状态 Live，点 port chip → 浏览器打开，nginx 返回 index.html
4. Logs 页                → 可见 nginx 启动信息
5. Stop / Restart / Sync  → 行为同 http-server
6. Delete（先 stop）      → 清理 PM2，nginx.*.conf 留在 app 目录

负向：
7. nginx 未装             → Start 返回 400 "nginx binary not found (set NGINX_BIN...)"
8. 未传 index.html 就 start → 400 "Missing index.html for nginx deployment"
9. 故意改坏 conf（手动）   → 400 "nginx config invalid: ..."
```

**自然可测单元**（待引入测试框架时优先覆盖）：`NginxLifecycle.generateConfig`（纯字符串模板——端口注入、路径转义、文件落盘）与 `testConfig` 的错误分类。

## 已知限制 / 范围外

1. **日志不全**：nginx 运行时 access / error 写到 `<app>/nginx-*.log` 文件，**不**进 PM2 日志。现有 SSE 日志页 tail PM2 out/err，所以 nginx app 只能看到启动 / 致命错误（配置解析、端口占用会进 stderr），看不到运行时 access 日志。未来可让 `LogManager` 对 nginx app 改 tail 它自己的日志文件。
2. **无 SSL / 域名绑定**——留给未来的"反向代理网关"范围。
3. **无环境变量注入**——Env 按钮仅 npm；静态文件本就用不到。
4. **temp_path 未重定向**——超大 POST body 在默认 temp 不可写时可能失败；纯静态 GET 命中不到，可接受。
5. **nginx 需单独安装**——不打包；启动探针 warn 提示。
6. **Windows 上 nginx 性能弱于 Linux**——上游已知，功能正常。

## 改动面 checklist（实现时用）

**新增**
- `server/src/services/nginx-lifecycle.js`

**后端改**
- `server/src/services/process-manager.js` — `case 'nginx'`
- `server/src/services/app-manager.js` — nginx 校验要求 `index.html`
- `server/src/services/deploy-manager.js` — nginx 分支 + 端口注释
- `server/src/config/index.js` — `deployment.nginxBin`
- `server/src/app.js` — boot probe（warn）
- `server/src/routes/index.js` — `isClientError` 新增两条子串
- `server/openapi.yaml` — 确认 deploy_type 描述
- `.env.example` — `NGINX_BIN`

**前端改**
- `client/src/pages/CreateApp.jsx` — 删 `disabled`
- `client/src/i18n/locales/{zh,en}.json` — `createApp.nginx` 去掉 "(Coming Soon)" 后缀（`appCard.deployTypes.nginx` 已存在）

**文档**
- `PROGRESS.md` — Phase 12 静态站部分勾选；SSL / 域名 / 反代仍待办
- `README.md` — nginx 从 "placeholder (not yet implemented)" 改为可用（静态站）
