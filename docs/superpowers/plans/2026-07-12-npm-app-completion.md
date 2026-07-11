# npm 应用支持完善（Phase 11）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 npm 应用从"能跑"到"开箱即用"——上传后 start 时自动 `npm install` + 可选 `npm run build`，校验 `start` 脚本，支持自定义环境变量（DB + UI + PM2 注入），平台为 npm 应用分配端口并注入 `PORT`。

**Architecture:** 新增 `NpmLifecycle` 服务封装 install/build/resolveEnv；`DeployManager.deployApp` 对 npm 类型按序调用 install → build → resolveEnv → startProcess(env)；新增 `app_env` 表存环境变量；前端新增独立 `EnvModal` 组件 + Dashboard 的 `startingId` 反馈态。

**Tech Stack:** Node.js + Express + sqlite3 + PM2（后端）；React + Vite + Ant Design + react-i18next（前端）。

## Global Constraints

- 数据库用 `sqlite3`（**禁用** `better-sqlite3`）；所有 DB 调用 `await`。
- 路径一律用 Node `path` 模块，禁止字符串拼接路径。
- Windows 兼容：`npm install` / `npm run build` 走 `child_process.exec`（shell 可执行 `.cmd`）；PM2 启动继续走已解析的 JS 入口 + `interpreter: 'node'`。
- schema 用 `CREATE TABLE IF NOT EXISTS`（增量，**不删库**）。
- env 明文存储（本地平台）；env 在 PM2 启动时烘焙，改完需 restart 才生效。
- **测试**：本轮不写自动化测试（用户自测）。每个任务以手动验证 + commit 收尾。
- 代码与 commit message 用英文；UI 文案中英双语。
- 安装超时默认 300s，可由 `NPM_INSTALL_TIMEOUT_MS` / `NPM_BUILD_TIMEOUT_MS` 配置。
- **关键不变式**：install/build 任一失败 → 不启动 PM2、status 保持 `stopped`。

---

## File Structure

**新增**
- `server/src/services/npm-lifecycle.js` — npm 生命周期（readPackageJson / install / build / resolveEnv）
- `client/src/components/EnvModal.jsx` — 环境变量编辑器（antd Modal + editorial 输入）

**修改**
- `server/src/db/schema.sql` — 追加 `app_env` 表
- `server/src/db/index.js` — `getAppEnv` / `setAppEnv`
- `server/src/config/index.js` — 两个 npm 超时配置
- `server/src/services/app-manager.js` — npm `start` 脚本校验 + `getAppEnv`/`setAppEnv` 转发
- `server/src/services/deploy-manager.js` — npm install/build/port/env 编排
- `server/src/services/process-manager.js` — `startProcess(app, options)` 注入 env + 抽 `writeEcosystemConfig`
- `server/src/routes/index.js` — `GET`/`PUT /apps/:id/env`
- `client/src/api/apps.js` — `startApp` 关超时 + `getAppEnv`/`setAppEnv`
- `client/src/pages/Dashboard.jsx` — `startingId` 反馈态
- `client/src/components/AppRow.jsx` — Start 启动态 + Env 按钮（npm 专属）
- `client/src/i18n/locales/zh.json`、`en.json` — env + starting 文案
- `client/src/styles/editorial.css` — env 编辑器样式
- `PROGRESS.md`、`README.md`、`CLAUDE.md`、`.env.example` — 文档同步

---

### Task 1: app_env 表 + DB 查询

**Files:**
- Modify: `server/src/db/schema.sql`（末尾追加）
- Modify: `server/src/db/index.js`（`queries` 对象内追加）

**Interfaces:**
- Produces: `queries.getAppEnv(appId): Promise<Array<{key, value}>>`；`queries.setAppEnv(appId, entries): Promise<Array<{key, value}>>`（entries: `[{key, value}]`，原子整体替换）

- [ ] **Step 1: schema.sql 末尾追加 app_env 表**

```sql

-- Per-app environment variables (injected into PM2 at start)
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

CREATE INDEX IF NOT EXISTS idx_app_env_app_id ON app_env(app_id);
```

- [ ] **Step 2: db/index.js 的 queries 对象内，在 `deleteApp` 之后追加两个查询**

在 `deleteApp: (id) => dbRun('DELETE FROM apps WHERE id = ?', [id])` 之后加入：

```js
  getAppEnv: (appId) => dbAll(
    'SELECT key, value FROM app_env WHERE app_id = ? ORDER BY id',
    [appId]
  ),

  setAppEnv: async (appId, entries) => {
    // Atomic replace: delete all, then insert. sqlite3 runs statements in
    // order on a single connection, so awaited dbRun calls serialize.
    await dbRun('BEGIN TRANSACTION');
    try {
      await dbRun('DELETE FROM app_env WHERE app_id = ?', [appId]);
      for (const entry of entries) {
        await dbRun(
          'INSERT INTO app_env (app_id, key, value) VALUES (?, ?, ?)',
          [appId, entry.key, entry.value === undefined ? null : entry.value]
        );
      }
      await dbRun('COMMIT');
    } catch (err) {
      await dbRun('ROLLBACK').catch(() => { /* ignore rollback failure */ });
      throw err;
    }
    return dbAll('SELECT key, value FROM app_env WHERE app_id = ? ORDER BY id', [appId]);
  }
```

- [ ] **Step 3: 手动验证表已创建（不删库）**

`db/index.js` 的 `initDatabase()` 每次启动都执行 schema，且 `app_env` 用 `CREATE TABLE IF NOT EXISTS`，所以重启服务器即自动建表，**无需删库、不丢现有应用数据**：
```bash
cd server && npm run dev
```
启动日志应含 `✓ Database initialized successfully`。Ctrl+C 停止。

确认表存在：
```bash
node -e "const s=require('sqlite3').verbose();const db=new s.Database('../data/microverse.sqlite');db.all(\"SELECT name FROM sqlite_master WHERE type='table' AND name='app_env'\",(_,r)=>{console.log(r);db.close()})"
```
预期：`[ { name: 'app_env' } ]`

- [ ] **Step 4: 提交**

```bash
git add server/src/db/schema.sql server/src/db/index.js
git commit -m "feat(db): add app_env table + getAppEnv/setAppEnv queries"
```

---

### Task 2: npm 超时配置 + NpmLifecycle 服务

**Files:**
- Modify: `server/src/config/index.js`（`deployment` 段追加两项）
- Create: `server/src/services/npm-lifecycle.js`

**Interfaces:**
- Consumes: `queries.getAppEnv(appId)`（Task 1）；`config.deployment.npmInstallTimeoutMs` / `npmBuildTimeoutMs`
- Produces: `NpmLifecycle.readPackageJson(appPath): object`（缺失/损坏抛错）；`NpmLifecycle.install(appPath): Promise<void>`；`NpmLifecycle.build(appPath): Promise<void>`（无 build 脚本则 no-op）；`NpmLifecycle.resolveEnv(appId, port): Promise<object>`

- [ ] **Step 1: config/index.js 的 deployment 段追加两项**

在 `maxFiles: parseInt(process.env.MAX_FILES) || 100` 之后（`deployment` 对象闭合 `}` 之前）追加：

```js
    ,

    // npm install / build timeouts (ms)
    npmInstallTimeoutMs: parseInt(process.env.NPM_INSTALL_TIMEOUT_MS) || 300000,
    npmBuildTimeoutMs: parseInt(process.env.NPM_BUILD_TIMEOUT_MS) || 300000
```

- [ ] **Step 2: 创建 server/src/services/npm-lifecycle.js**

```js
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const { queries } = require('../db');
const config = require('../config');

const execPromise = util.promisify(exec);

/**
 * NpmLifecycle — npm app install / build / env resolution.
 * Used by DeployManager for npm deploy_type.
 */
class NpmLifecycle {
  /**
   * Read and parse an app's package.json.
   * @throws {Error} 'package.json not found' or 'Invalid package.json: ...'
   */
  static readPackageJson(appPath) {
    const pkgPath = path.join(appPath, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      throw new Error('package.json not found');
    }
    try {
      return JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    } catch (err) {
      throw new Error('Invalid package.json: ' + err.message);
    }
  }

  /**
   * Run `npm install` in the app directory.
   * exec runs through the shell, so the npm .cmd wrapper works on Windows.
   */
  static async install(appPath) {
    try {
      await execPromise('npm install', {
        cwd: appPath,
        timeout: config.deployment.npmInstallTimeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (err) {
      if (err.killed || /TIMEDOUT/i.test(err.message || '')) {
        throw new Error('npm install timed out');
      }
      throw new Error('npm install failed: ' + (err.stderr || err.stdout || err.message).slice(-500));
    }
  }

  /**
   * Run `npm run build` if a build script exists; otherwise no-op.
   */
  static async build(appPath) {
    const pkg = this.readPackageJson(appPath);
    if (!pkg.scripts || typeof pkg.scripts.build !== 'string') {
      return;
    }
    try {
      await execPromise('npm run build', {
        cwd: appPath,
        timeout: config.deployment.npmBuildTimeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (err) {
      if (err.killed || /TIMEDOUT/i.test(err.message || '')) {
        throw new Error('npm run build timed out');
      }
      throw new Error('build failed: ' + (err.stderr || err.stdout || err.message).slice(-500));
    }
  }

  /**
   * Resolve the env object for PM2: user-defined vars + platform-forced PORT.
   * PORT is always set to the platform-assigned port (user cannot override).
   */
  static async resolveEnv(appId, port) {
    const rows = await queries.getAppEnv(appId);
    const env = {};
    for (const r of rows) {
      env[r.key] = r.value === null ? '' : r.value;
    }
    env.PORT = String(port);
    return env;
  }
}

module.exports = NpmLifecycle;
```

- [ ] **Step 3: 手动验证 readPackageJson + resolveEnv 逻辑**

```bash
cd server
node -e "
const N=require('./src/services/npm-lifecycle');
console.log('missing:', (()=>{try{N.readPackageJson('C:/nope')}catch(e){return e.message}})());
const fs=require('fs');const os=require('os');const p=require('path');
const d=p.join(os.tmpdir(),'mvtest-'+process.pid);fs.mkdirSync(d,{recursive:true});
fs.writeFileSync(p.join(d,'package.json'),JSON.stringify({scripts:{start:'node .',build:'echo build'}}}));
console.log('pkg:',Object.keys(N.readPackageJson(d).scripts));
N.resolveEnv(999,3210).then(e=>{console.log('env.PORT forced:',e.PORT==='3210');fs.rmSync(d,{recursive:true})});
"
```
预期：
```
missing: package.json not found
pkg: [ 'start', 'build' ]
env.PORT forced: true
```

- [ ] **Step 4: 提交**

```bash
git add server/src/config/index.js server/src/services/npm-lifecycle.js
git commit -m "feat(npm): NpmLifecycle service — readPackageJson/install/build/resolveEnv"
```

---

### Task 3: ProcessManager — env 注入 + writeEcosystemConfig 抽取

**Files:**
- Modify: `server/src/services/process-manager.js`（`startProcess` 签名 + 两处分支 + 新增私有方法）

**Interfaces:**
- Consumes: 无新依赖
- Produces: `ProcessManager.startProcess(app, options = {})`（`options.env` 注入 PM2）；`ProcessManager.writeEcosystemConfig(appPath, name, appsEntry)`（私有，返回 configPath）

- [ ] **Step 1: 修改 startProcess 签名与 npm 分支**

把 `static async startProcess(app) {` 改为 `static async startProcess(app, options = {}) {`。

替换 `case 'npm': { ... }` 整个分支为：

```js
      case 'npm': {
        // Start npm application. On Windows, `npm` is a .cmd wrapper that PM2
        // fork mode can't launch, so resolve the JS entry and run it with node.
        const npmCliPath = this.getNpmCliPath();
        const resolvedJs = npmCliPath !== 'npm';

        try {
          const appsEntry = {
            name: name,
            script: npmCliPath,
            args: 'start',
            cwd: appPath,
            interpreter: resolvedJs ? 'node' : 'none',
            exec_mode: 'fork',
            autorestart: true
          };
          // Inject resolved env (PORT + user vars) for npm apps.
          if (options.env && typeof options.env === 'object') {
            appsEntry.env = options.env;
          }

          const configPath = this.writeEcosystemConfig(appPath, name, appsEntry);
          await execPromise(`pm2 start "${configPath}"`);

          return { success: true, message: `Process ${name} started` };
        } catch (error) {
          throw new Error(`Failed to start process: ${error.message}`);
        }
      }
```

- [ ] **Step 2: 替换 http-server 分支为同样使用 writeEcosystemConfig**

替换 `case 'http-server':` 内的整个 try 块（从 `const httpServerPath = this.getHttpServerPath();` 到该 case 的 `return { success: true, message: ... }` 与其 catch）为：

```js
      case 'http-server':
        if (!port) {
          throw new Error('Port is required for http-server deployment');
        }

        try {
          const httpServerPath = this.getHttpServerPath();
          const appsEntry = {
            name: name,
            script: httpServerPath,
            args: `. -p ${port}`,
            cwd: appPath,
            interpreter: 'node',
            exec_mode: 'fork',
            autorestart: true,
            max_restarts: 10,
            min_uptime: 1000
          };

          const configPath = this.writeEcosystemConfig(appPath, name, appsEntry);
          await execPromise(`pm2 start "${configPath}"`);

          return { success: true, message: `Process ${name} started` };
        } catch (error) {
          throw new Error(`Failed to start process: ${error.message}`);
        }
```

- [ ] **Step 3: 在 getNpmCliPath() 之后、startProcess 之前，新增 writeEcosystemConfig 私有方法**

```js
  /**
   * Write a temporary PM2 ecosystem config and schedule its deletion.
   * Shared by all deploy types to avoid duplicated write+cleanup code.
   * Returns the config file path (caller runs `pm2 start <path>`).
   */
  static writeEcosystemConfig(appPath, name, appsEntry) {
    const ecosystemConfig = { apps: [appsEntry] };
    const configPath = path.join(appPath, `pm2.${name}.config.js`);
    fs.writeFileSync(
      configPath,
      `module.exports = ${JSON.stringify(ecosystemConfig, null, 2)}`
    );
    // PM2 reads the file synchronously during start; 5s is enough, then clean up.
    setTimeout(() => {
      try {
        if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
      } catch (_err) { /* ignore */ }
    }, 5000);
    return configPath;
  }
```

- [ ] **Step 4: 手动验证 http-server 回归（未破坏既有流程）**

确保现有一个 http-server 应用可正常启动（回归检查）。如无现成应用，创建一个：
```bash
cd server && npm run dev   # 后端
# 另开终端：
curl -s -X POST http://localhost:5000/api/apps -H 'Content-Type: application/json' -d '{"name":"regression-static","deploy_type":"http-server"}'
mkdir -p ../apps/regression-static && echo '<h1>ok</h1>' > ../apps/regression-static/index.html
curl -s -X POST http://localhost:5000/api/apps/<id>/start
npx pm2 list   # 应看到 regression-static 为 online
curl -s http://localhost:<port>   # <h1>ok</h1>
curl -s -X POST http://localhost:5000/api/apps/<id>/stop
```
预期：启动成功、可访问、可停止，且 `apps/regression-static/` 下 `pm2.regression-static.config.js` 5 秒后消失。

- [ ] **Step 5: 提交**

```bash
git add server/src/services/process-manager.js
git commit -m "refactor(pm2): startProcess accepts options.env; extract writeEcosystemConfig"
```

---

### Task 4: AppManager — start 脚本校验 + env 转发

**Files:**
- Modify: `server/src/services/app-manager.js`（顶部 require + `validateAppDeployment` npm 分支 + 两个转发方法）

**Interfaces:**
- Consumes: `NpmLifecycle.readPackageJson`（Task 2）；`queries.getAppEnv` / `queries.setAppEnv`（Task 1）
- Produces: `AppManager.validateAppDeployment` npm 分支现校验 `scripts.start`；`AppManager.getAppEnv(id)` / `AppManager.setAppEnv(id, entries)`

- [ ] **Step 1: app-manager.js 顶部 require NpmLifecycle**

在 `const ProcessManager = require('./process-manager');` 之后加：

```js
const NpmLifecycle = require('./npm-lifecycle');
```

- [ ] **Step 2: 替换 validateAppDeployment 的 npm 分支**

把 `validateAppDeployment` 内：
```js
      case 'npm':
        if (!files.includes('package.json')) {
          return { valid: false, message: 'Missing package.json for npm deployment' };
        }
        break;
```
替换为：

```js
      case 'npm': {
        let pkg;
        try {
          pkg = NpmLifecycle.readPackageJson(app.path);
        } catch (err) {
          return { valid: false, message: err.message };
        }
        if (!pkg.scripts || typeof pkg.scripts.start !== 'string' || !pkg.scripts.start.trim()) {
          return { valid: false, message: 'Missing start script in package.json' };
        }
        break;
      }
```

- [ ] **Step 3: 在 deleteApp 之后（getAppFiles 之前）追加两个 env 转发方法**

```js
  /**
   * Get environment variables for an app (forwarded to queries).
   */
  static async getAppEnv(id) {
    await this.getAppById(id); // throws 'App not found' if missing
    return queries.getAppEnv(id);
  }

  /**
   * Replace environment variables for an app (forwarded to queries).
   * entries: [{ key, value }]
   */
  static async setAppEnv(id, entries) {
    await this.getAppById(id);
    return queries.setAppEnv(id, entries);
  }
```

- [ ] **Step 4: 手动验证 start 脚本校验**

```bash
cd server && npm run dev
# 另开终端，创建一个无 start 脚本的 npm app：
curl -s -X POST http://localhost:5000/api/apps -H 'Content-Type: application/json' -d '{"name":"no-start","deploy_type":"npm"}'
mkdir -p ../apps/no-start && echo '{"name":"no-start","scripts":{}}' > ../apps/no-start/package.json
curl -s -X POST http://localhost:5000/api/apps/<id>/start
```
预期：400，`error.message === "Missing start script in package.json"`。

- [ ] **Step 5: 提交**

```bash
git add server/src/services/app-manager.js
git commit -m "feat(appmgr): validate npm start script + getAppEnv/setAppEnv forwarders"
```

---

### Task 5: DeployManager — npm install/build/port/env 编排

**Files:**
- Modify: `server/src/services/deploy-manager.js`（顶部 require + `deployApp` 重写端口分配与启动分支）

**Interfaces:**
- Consumes: `NpmLifecycle`（Task 2）；`ProcessManager.startProcess(app, {env})`（Task 3）
- Produces: npm 应用 start 时执行 install → build → resolveEnv → startProcess(env)，并分配端口

- [ ] **Step 1: deploy-manager.js 顶部 require NpmLifecycle**

在 `const ProcessManager = require('./process-manager');` 之后加：

```js
const NpmLifecycle = require('./npm-lifecycle');
```

- [ ] **Step 2: 重写 deployApp 的端口分配与启动逻辑**

把 `deployApp` 内，从 `// Assign port if needed` 到 `await queries.updateAppStatus('running', appId);` 之前的 `// Start the process` 段，整体替换。即把：

```js
    // Assign port if needed
    if (app.deploy_type === 'http-server' && !app.port) {
      const port = await ProcessManager.findAvailablePort(
        config.deployment.portRangeMin,
        config.deployment.portRangeMax
      );

      await AppManager.updateApp(appId, { port });
      app.port = port;
    }

    // Start the process
    await ProcessManager.startProcess(app);
```

替换为：

```js
    // Assign port if needed — both http-server and npm get a platform port.
    // npm apps receive it via the PORT env var (resolved below).
    if (!app.port) {
      const port = await ProcessManager.findAvailablePort(
        config.deployment.portRangeMin,
        config.deployment.portRangeMax
      );
      await AppManager.updateApp(appId, { port });
      app.port = port;
    }

    // Start the process. For npm: install → build → resolve env → launch with env.
    if (app.deploy_type === 'npm') {
      await NpmLifecycle.install(app.path);
      await NpmLifecycle.build(app.path);
      const env = await NpmLifecycle.resolveEnv(appId, app.port);
      await ProcessManager.startProcess(app, { env });
    } else {
      await ProcessManager.startProcess(app);
    }
```

- [ ] **Step 3: 手动验证端到端 npm 部署**

准备一个最小 npm 应用（监听 PORT）：
```bash
cd server && npm run dev   # 后端
# 另开终端：
curl -s -X POST http://localhost:5000/api/apps -H 'Content-Type: application/json' -d '{"name":"npm-demo","deploy_type":"npm"}'
mkdir -p ../apps/npm-demo
cat > ../apps/npm-demo/package.json <<'EOF'
{ "name": "npm-demo", "version": "1.0.0", "scripts": { "start": "node server.js" } }
EOF
cat > ../apps/npm-demo/server.js <<'EOF'
const http=require('http');
const s=http.createServer((req,res)=>res.end('hello from '+process.env.PORT+' key='+process.env.API_KEY));
s.listen(process.env.PORT||3000);
EOF
# 先设一个 env 变量（需 Task 6 的路由；若尚未实现，可跳过 API_KEY 验证，先只验 install + PORT）
curl -s -X PUT http://localhost:5000/api/apps/<id>/env -H 'Content-Type: application/json' -d '{"env":[{"key":"API_KEY","value":"secret123"}]}'
curl -s -X POST http://localhost:5000/api/apps/<id>/start
```
预期：start 返回 `success:true`，`data.port` 已分配（如 3000），`data.status==="running"`。`apps/npm-demo/node_modules` 目录已生成。
```bash
npx pm2 list                       # npm-demo online
curl -s http://localhost:<port>     # hello from <port> key=secret123
```
若 Task 6 尚未实现，先省略 PUT env 与 `key=` 校验，仅验证 install + PORT 注入（`hello from <port> key=`）。

- [ ] **Step 4: 提交**

```bash
git add server/src/services/deploy-manager.js
git commit -m "feat(deploy): npm install/build/resolveEnv on start + port assignment"
```

---

### Task 6: env API 路由

**Files:**
- Modify: `server/src/routes/index.js`（`module.exports` 之前追加两条路由）

**Interfaces:**
- Consumes: `AppManager.getAppEnv` / `AppManager.setAppEnv`（Task 4）
- Produces: `GET /api/apps/:id/env` → `[{key,value}]`；`PUT /api/apps/:id/env`（body `{env:[{key,value}]}`，校验 key 正则 + 去重）

- [ ] **Step 1: routes/index.js 的 `module.exports = router;` 之前追加**

```js
// Get application environment variables
router.get('/apps/:id/env', async (req, res, next) => {
  try {
    const env = await AppManager.getAppEnv(req.params.id);
    res.json({ success: true, data: env });
  } catch (error) {
    if (error.message === 'App not found') {
      return res.status(404).json({ success: false, error: { message: error.message } });
    }
    next(error);
  }
});

// Replace application environment variables
router.put('/apps/:id/env', async (req, res, next) => {
  try {
    const { env } = req.body;
    if (!Array.isArray(env)) {
      return res.status(400).json({
        success: false,
        error: { message: 'env must be an array of { key, value }' }
      });
    }

    const keyRe = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const seen = new Set();
    for (const entry of env) {
      if (!entry || typeof entry.key !== 'string' || !keyRe.test(entry.key)) {
        return res.status(400).json({
          success: false,
          error: { message: `Invalid env key: ${entry && entry.key}` }
        });
      }
      if (seen.has(entry.key)) {
        return res.status(400).json({
          success: false,
          error: { message: `Duplicate env key: ${entry.key}` }
        });
      }
      seen.add(entry.key);
    }

    const entries = env.map(e => ({ key: e.key, value: e.value === undefined ? null : e.value }));
    const result = await AppManager.setAppEnv(req.params.id, entries);
    res.json({ success: true, data: result });
  } catch (error) {
    if (error.message === 'App not found') {
      return res.status(404).json({ success: false, error: { message: error.message } });
    }
    next(error);
  }
});
```

- [ ] **Step 2: 手动验证 env 路由**

```bash
cd server && npm run dev
# 另开终端（用 Task 5 的 npm-demo 或任意 app id）：
curl -s http://localhost:5000/api/apps/<id>/env                      # [] 或既有
curl -s -X PUT http://localhost:5000/api/apps/<id>/env \
  -H 'Content-Type: application/json' \
  -d '{"env":[{"key":"API_KEY","value":"abc"},{"key":"NODE_ENV","value":"dev"}]}'
curl -s http://localhost:5000/api/apps/<id>/env                      # 两行
# 非法 key：
curl -s -X PUT http://localhost:5000/api/apps/<id>/env -H 'Content-Type: application/json' -d '{"env":[{"key":"1bad","value":"x"}]}'
# 重复 key：
curl -s -X PUT http://localhost:5000/api/apps/<id>/env -H 'Content-Type: application/json' -d '{"env":[{"key":"A","value":"1"},{"key":"A","value":"2"}]}'
```
预期：PUT 成功返回数组；GET 返回两项；非法 key 返回 400 `Invalid env key: 1bad`；重复返回 400 `Duplicate env key: A`。

- [ ] **Step 3: 提交**

```bash
git add server/src/routes/index.js
git commit -m "feat(api): GET/PUT /apps/:id/env with key validation"
```

---

### Task 7: 前端 api 客户端

**Files:**
- Modify: `client/src/api/apps.js`（`startApp` 关超时；新增 `getAppEnv` / `setAppEnv`）

**Interfaces:**
- Produces: `startApp(id)`（无 axios 超时）；`getAppEnv(id): Promise<Array>`；`setAppEnv(id, env): Promise<Array>`

- [ ] **Step 1: 修改 startApp，关闭超时**

把：
```js
export const startApp = async (id) => {
  const response = await api.post(`/apps/${id}/start`)
  return response.data.data
}
```
替换为：

```js
export const startApp = async (id) => {
  // npm apps run install/build before launch — can take minutes. Disable the
  // default 10s axios timeout so the request survives the full lifecycle.
  const response = await api.post(`/apps/${id}/start`, {}, { timeout: 0 })
  return response.data.data
}
```

- [ ] **Step 2: 在 getAppFiles 之后追加两个 env 客户端函数**

```js
/**
 * Get an application's environment variables
 */
export const getAppEnv = async (id) => {
  const response = await api.get(`/apps/${id}/env`)
  return response.data.data
}

/**
 * Replace an application's environment variables
 * @param {number} id
 * @param {Array<{key: string, value: string}>} env
 */
export const setAppEnv = async (id, env) => {
  const response = await api.put(`/apps/${id}/env`, { env })
  return response.data.data
}
```

- [ ] **Step 3: 手动验证 lint + build**

```bash
cd client && npm run lint && npm run build
```
预期：lint 0 warning，build 成功。

- [ ] **Step 4: 提交**

```bash
git add client/src/api/apps.js
git commit -m "feat(client): startApp disables timeout; add getAppEnv/setAppEnv"
```

---

### Task 8: EnvModal 组件 + i18n + 样式

**Files:**
- Create: `client/src/components/EnvModal.jsx`
- Modify: `client/src/i18n/locales/zh.json`、`client/src/i18n/locales/en.json`
- Modify: `client/src/styles/editorial.css`（末尾追加 env 样式）

**Interfaces:**
- Produces: 默认导出 `EnvModal`，props `{ appId, open, onCancel }`

- [ ] **Step 1: 创建 client/src/components/EnvModal.jsx**

```jsx
import { useState, useEffect } from 'react'
import { Modal, message } from 'antd'
import { useTranslation } from 'react-i18next'
import { getAppEnv, setAppEnv } from '../api/apps'

function EnvModal({ appId, open, onCancel }) {
  const { t } = useTranslation()
  const [rows, setRows] = useState([{ key: '', value: '' }])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    getAppEnv(appId)
      .then((data) => setRows(data && data.length ? data : [{ key: '', value: '' }]))
      .catch(() => message.error(t('appEnv.loadError')))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, appId])

  const update = (i, field, val) => {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [field]: val } : r)))
  }
  const addRow = () => setRows((rs) => [...rs, { key: '', value: '' }])
  const removeRow = (i) => setRows((rs) => rs.filter((_, idx) => idx !== i))

  const save = async () => {
    const keyRe = /^[A-Za-z_][A-Za-z0-9_]*$/
    const seen = new Set()
    for (const r of rows) {
      if (!r.key || !keyRe.test(r.key)) {
        message.error(t('appEnv.keyInvalid'))
        return
      }
      if (seen.has(r.key)) {
        message.error(t('appEnv.keyDuplicate'))
        return
      }
      seen.add(r.key)
    }
    setSaving(true)
    try {
      await setAppEnv(appId, rows)
      message.success(t('appEnv.saveSuccess'))
      onCancel()
    } catch (e) {
      message.error(e.response?.data?.error?.message || t('appEnv.saveError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={t('appEnv.title')}
      open={open}
      onCancel={onCancel}
      onOk={save}
      okText={t('appEnv.save')}
      confirmLoading={saving}
      cancelText={t('common.cancel')}
      width={560}
      destroyOnClose
    >
      {loading ? (
        <div className="env-hint">{t('common.loading')}</div>
      ) : (
        <>
          <ul className="env-list">
            {rows.map((r, i) => (
              <li className="env-row" key={i}>
                <input
                  className="env-key"
                  value={r.key}
                  onChange={(e) => update(i, 'key', e.target.value)}
                  placeholder={t('appEnv.keyPlaceholder')}
                />
                <input
                  className="env-val"
                  value={r.value || ''}
                  onChange={(e) => update(i, 'value', e.target.value)}
                  placeholder={t('appEnv.valuePlaceholder')}
                />
                <button className="env-del" type="button" onClick={() => removeRow(i)} title={t('common.delete')}>×</button>
              </li>
            ))}
          </ul>
          <button className="env-add" type="button" onClick={addRow}>+ {t('appEnv.addRow')}</button>
          <p className="env-hint">{t('appEnv.applyHint')}</p>
        </>
      )}
    </Modal>
  )
}

export default EnvModal
```

- [ ] **Step 2: zh.json 增补文案**

在 `appLogs` 段之后（`messages` 段之前）插入新的 `appEnv` 段：

```json
  "appEnv": {
    "title": "环境变量",
    "keyPlaceholder": "KEY",
    "valuePlaceholder": "value",
    "addRow": "新增",
    "save": "保存",
    "saveSuccess": "环境变量已保存",
    "saveError": "保存环境变量失败",
    "loadError": "加载环境变量失败",
    "keyInvalid": "变量名非法（仅字母/数字/下划线，不以数字开头）",
    "keyDuplicate": "存在重复的变量名",
    "applyHint": "环境变量在下次启动时生效（修改后需重启应用）。"
  },
```

在 `appCard` 段内 `"logs": "日志",` 之后加：

```json
    "env": "环境变量",
    "starting": "启动中…",
```

- [ ] **Step 3: en.json 增补对应文案**

在 `appLogs` 段之后插入：

```json
  "appEnv": {
    "title": "Environment",
    "keyPlaceholder": "KEY",
    "valuePlaceholder": "value",
    "addRow": "Add row",
    "save": "Save",
    "saveSuccess": "Environment saved",
    "saveError": "Failed to save environment",
    "loadError": "Failed to load environment",
    "keyInvalid": "Invalid key (letters/digits/underscore only, not starting with a digit)",
    "keyDuplicate": "Duplicate key",
    "applyHint": "Environment applies on next start (restart the app after changing)."
  },
```

在 `appCard` 段内 `"logs": "Logs",` 之后加：

```json
    "env": "Environment",
    "starting": "Starting…",
```

- [ ] **Step 4: editorial.css 末尾追加 env 编辑器样式**

```css

/* ----- Env editor ----- */
.env-list { list-style: none; margin: 8px 0 0; }
.env-row {
  display: grid; grid-template-columns: 170px 1fr 32px; align-items: center; gap: 12px;
  padding: 10px 0; border-bottom: 1px solid var(--rule);
}
.env-key, .env-val {
  font-family: var(--mono); font-size: 12px; color: var(--ink);
  background: none; border: none; border-bottom: 1px solid var(--rule);
  padding: 4px 2px; outline: none; transition: border-color .15s;
  min-width: 0;
}
.env-key:focus, .env-val:focus { border-bottom-color: var(--accent); }
.env-del {
  font-family: var(--mono); font-size: 15px; color: var(--ink-3);
  background: none; border: none; cursor: pointer; transition: color .15s; padding: 0;
}
.env-del:hover { color: var(--accent); }
.env-add {
  font-family: var(--mono); font-size: 10.5px; text-transform: uppercase;
  letter-spacing: 0.1em; color: var(--ink-2); background: none; border: none;
  border-bottom: 1px solid transparent; cursor: pointer; margin-top: 14px; padding: 0 0 1px;
  transition: color .15s, border-color .15s;
}
.env-add:hover { color: var(--accent); border-bottom-color: var(--accent); }
.env-hint { font-family: var(--serif); font-size: 13px; color: var(--ink-3); margin-top: 16px; line-height: 1.6; }
```

- [ ] **Step 5: 手动验证 lint**

```bash
cd client && npm run lint
```
预期：0 warning（EnvModal 此时未被引用，但 lint 不报未使用组件）。

- [ ] **Step 6: 提交**

```bash
git add client/src/components/EnvModal.jsx client/src/i18n/locales/zh.json client/src/i18n/locales/en.json client/src/styles/editorial.css
git commit -m "feat(client): EnvModal component + i18n + editorial styles"
```

---

### Task 9: Dashboard startingId + AppRow 接线

**Files:**
- Modify: `client/src/pages/Dashboard.jsx`（`startingId` state + 传入 AppRow）
- Modify: `client/src/components/AppRow.jsx`（import EnvModal + Start 启动态 + Env 按钮）

**Interfaces:**
- Consumes: `EnvModal`（Task 8）；`appCard.starting` / `appCard.env`（Task 8 i18n）

- [ ] **Step 1: Dashboard.jsx 增加 startingId**

在 `const [refreshing, setRefreshing] = useState(false)` 之后加：

```js
  const [startingId, setStartingId] = useState(null)
```

把 `handleStart` 整体替换为：

```js
  const handleStart = async (appId) => {
    setStartingId(appId)
    try {
      await startApp(appId)
      message.success(t('messages.appStarted'))
      await loadApps(true)
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('messages.operationFailed'))
    } finally {
      setStartingId(null)
    }
  }
```

在 `<AppRow ... />` 上加 `startingId={startingId}`：

```jsx
            <AppRow
              key={app.id}
              app={app}
              index={i + 1}
              onStart={handleStart}
              onStop={handleStop}
              onDelete={handleDelete}
              startingId={startingId}
            />
```

- [ ] **Step 2: AppRow.jsx 接收 startingId + import EnvModal**

把 `function AppRow({ app, index, onStart, onStop, onDelete }) {` 改为：

```jsx
function AppRow({ app, index, onStart, onStop, onDelete, startingId }) {
```

在 `import { getAppFiles } from '../api/apps'` 之后加：

```jsx
import EnvModal from './EnvModal'
```

在 `const [loadingDir, setLoadingDir] = useState(false)` 之后加：

```jsx
  const [envOpen, setEnvOpen] = useState(false)
  const starting = startingId === app.id
```

- [ ] **Step 3: AppRow 的 Start 按钮加启动态**

把：
```jsx
            <button className="act" onClick={() => onStart(app.id)}>
              {t('appCard.start')}
            </button>
```
替换为：

```jsx
            <button className="act" onClick={() => onStart(app.id)} disabled={starting}>
              {starting ? t('appCard.starting') : t('appCard.start')}
            </button>
```

- [ ] **Step 4: AppRow 的 acts 区加 Env 按钮（npm 专属）**

在 Upload 按钮之后、`<Popconfirm` 之前插入：

```jsx
          {app.deploy_type === 'npm' && (
            <button className="act" onClick={() => setEnvOpen(true)}>
              {t('appCard.env')}
            </button>
          )}
```

- [ ] **Step 5: AppRow 末尾渲染 EnvModal**

在目录 `<Modal>...</Modal>` 之后、组件闭合 `</>` 之前加：

```jsx
      {app.deploy_type === 'npm' && (
        <EnvModal appId={app.id} open={envOpen} onCancel={() => setEnvOpen(false)} />
      )}
```

- [ ] **Step 6: 手动验证 lint + build + 点击流**

```bash
cd client && npm run lint && npm run build
```
预期：0 warning，build 成功。

启动前后端（`npm run dev`），在浏览器：
- 创建一个 npm 应用（Task 5 的 npm-demo）与一个 http-server 应用。
- npm 应用行应有 **Environment** 按钮；http-server 行**无**此按钮。
- 点 Environment → 弹窗，加一行 `API_KEY=secret123`，保存 → 成功提示。
- 点 Start → 按钮变 **启动中…** 且不可点；install/build 完成后变回 Stop，端口 chip 可点击打开。
- 改 env 后需 restart 才生效（提示文案已说明）。

- [ ] **Step 7: 提交**

```bash
git add client/src/pages/Dashboard.jsx client/src/components/AppRow.jsx
git commit -m "feat(client): wire EnvModal + Start loading state for npm apps"
```

---

### Task 10: 文档同步

**Files:**
- Modify: `PROGRESS.md`、`README.md`、`CLAUDE.md`、`.env.example`

- [ ] **Step 1: PROGRESS.md**

- "当前状态" 的"最后更新"改为 `2026-07-12`；状态行追加"npm 自动 install/build + 环境变量管理"。
- `### 🎯 Phase 11` 标题改为 `### ✅ Phase 11: npm 应用支持完善 (2026-07-12)`，四项 `[ ]` 改为 `[x]`，并补一条 `[x] 平台为 npm 应用分配端口并注入 PORT`。
- "待实现功能"上方"当前支持的部署类型"段，把 npm 行的括注 `(依赖安装 / 构建步骤仍未自动化)` 改为 `(上传后 start 时自动 npm install + 可选 build，端口由平台分配，env 可配置)`。
- 变更日志新增：
  ```
  ### [Unreleased] — 2026-07-12
  #### 新增
  - Phase 11：npm 应用 start 时自动 `npm install` + 可选 `npm run build`；`NpmLifecycle` 服务
  - 环境变量管理：`app_env` 表 + `GET/PUT /api/apps/:id/env` + 前端 `EnvModal`
  - 平台为 npm 应用分配端口并注入 `PORT`；npm 应用在 Dashboard 出现可点击端口 chip
  - npm `start` 脚本校验（缺脚本在 start 前 400 拒绝，不再崩溃后才暴露）
  - `ProcessManager.writeEcosystemConfig` 抽取，消除重复
  - start 请求关闭 axios 超时；Dashboard 增加 `startingId` 启动反馈态
  #### 补登（2026-07-09 之后、本条之前未入账）
  - SSE 日志流断连资源泄漏加固（`90f5cc4` `1a99842` `34aa08d`）
  ```

- [ ] **Step 2: README.md**

- Features 列表里 `npm` 描述补："自动 install 与可选 build、平台分配端口、可配置环境变量"。
- `## API Endpoints` 的 Applications 段追加：
  ```
  - `GET /api/apps/:id/env` - List an app's environment variables
  - `PUT /api/apps/:id/env` - Replace an app's environment variables (`{ env: [{ key, value }] }`)
  ```
- `## Configuration` 的 env 示例追加：
  ```env
  # npm install / build timeouts (ms, default 300000)
  NPM_INSTALL_TIMEOUT_MS=300000
  NPM_BUILD_TIMEOUT_MS=300000
  ```
- Usage 段补一小节"环境变量"：npm 应用行点 Environment 编辑，下次启动生效。

- [ ] **Step 3: CLAUDE.md**

- "Deployment Types" 的 `npm` 行改为：`npm - Node.js apps (requires package.json with a start script; auto-runs npm install + optional npm run build on start; receives platform-assigned PORT + user env vars)`。
- "Database schema changes" 段补注：增量表用 `CREATE TABLE IF NOT EXISTS`（如 `app_env`），无需删库。
- "Key Files to Modify" → "Adding new deploy type" 不变；新增一句：注入 env 见 `ProcessManager.startProcess(app, { env })` 与 `NpmLifecycle.resolveEnv`。

- [ ] **Step 4: .env.example**

在 PM2 段之前（或末尾）追加：

```env
# npm install / build timeouts (ms, default 300000 = 5 min)
NPM_INSTALL_TIMEOUT_MS=300000
NPM_BUILD_TIMEOUT_MS=300000
```

- [ ] **Step 5: 手动验证文档无残留过期描述**

通读四处改动，确认无"未实现/未自动化"等过期措辞残留。

- [ ] **Step 6: 提交**

```bash
git add PROGRESS.md README.md CLAUDE.md .env.example
git commit -m "docs: sync Phase 11 (npm install/build, env vars, port injection)"
```

---

## 完成判据（Definition of Done）

- npm 应用：创建 → 上传（含 package.json + start 脚本）→ Start，自动 install(+build)，分配端口，`PM2 online`，`curl http://localhost:<port>` 返回应用响应且 `process.env.PORT` 为平台端口。
- 缺 `start` 脚本 → Start 返回 400 `Missing start script in package.json`，不启动。
- install/build 失败或超时 → 400 + stderr 末尾，status 保持 stopped。
- env：`GET/PUT /api/apps/:id/env` 工作；key 非法/重复 400；PUT 后 next start 注入 `process.env`。
- UI：npm 行有 Environment 按钮（http-server 无）；Start 有"启动中…"态；env 弹窗可增删改存。
- http-server 回归未破坏。
- 文档四处同步，无过期描述。
