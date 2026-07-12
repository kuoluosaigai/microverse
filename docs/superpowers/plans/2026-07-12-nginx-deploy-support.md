# Nginx Deploy Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `nginx` schema placeholder into a working static-site deploy type (http-server's nginx counterpart) — each nginx app gets a port, a generated per-app config, and runs as a PM2-managed nginx process.

**Architecture:** New `NginxLifecycle` service mirrors the existing `NpmLifecycle` pattern — it owns config generation, binary resolution, and pre-flight checks. `DeployManager` calls it before launch; `ProcessManager` gains a `case 'nginx'` that launches nginx via PM2 with `interpreter: 'none'` and `daemon off;`. Reverse proxy / SSL / domain binding stay out of scope.

**Tech Stack:** Node.js, Express, PM2, nginx (system binary), React + Ant Design + react-i18next.

## Global Constraints

- **No test framework.** Per the approved spec, this feature does NOT introduce a test runner ("补测试覆盖" is a separate tech-debt task). Verify via `node -e` one-liners and `curl` against a running server. The pure units (`NginxLifecycle.generateConfig`, `testConfig`) are flagged for future unit tests.
- **Cross-platform paths:** always `path.join`, never string concatenation. App names are sanitized to `[a-zA-Z0-9-_]` by `path-helper` (no spaces in app dir names), but the project root may contain spaces, so nginx config paths are quoted.
- **Database is async (`sqlite3`):** always `await` query calls.
- **Commit on `main`** (this repo's established convention — every recent feature commit is on main).
- **Commit messages in English**, body ends with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- **Windows dev server:** restarting the backend leaves port 5000 bound; `taskkill /PID <pid> /F` the holder before relaunch (see `netstat -ano | findstr :5000`).
- **Error envelope:** `{ success, data }` or `{ success: false, error: { message } }`. Client-side deploy failures return 400.

## File Structure

**Create:**
- `server/src/services/nginx-lifecycle.js` — config generation, binary resolution, pre-flight (`resolveBinary` / `generateConfig` / `testConfig` / `probe`). One responsibility: nginx-specific orchestration outside PM2.

**Modify (backend):**
- `server/src/config/index.js` — add `deployment.nginxBin`.
- `server/src/services/app-manager.js` — nginx validation requires `index.html`.
- `server/src/services/process-manager.js` — add `case 'nginx'` (PM2 launch).
- `server/src/services/deploy-manager.js` — nginx branch (generate → test → start) + port comment.
- `server/src/app.js` — warn-only boot probe.
- `server/src/routes/index.js` — two new `isClientError` substrings.
- `server/src/docs/openapi.yaml` — description mentions nginx.
- `.env.example` — `NGINX_BIN`.

**Modify (frontend):**
- `client/src/pages/CreateApp.jsx` — drop `disabled`.
- `client/src/i18n/locales/en.json`, `zh.json` — `createApp.nginx` drops "(Coming Soon)".

**Modify (docs):**
- `PROGRESS.md`, `README.md`.

---

## Task 1: NginxLifecycle service + config wiring

**Files:**
- Create: `server/src/services/nginx-lifecycle.js`
- Modify: `server/src/config/index.js` (deployment block, ~line 46-48)
- Modify: `.env.example` (after line 25)

**Interfaces:**
- Consumes: `config.deployment.nginxBin` (defined in this task).
- Produces: `NginxLifecycle.resolveBinary()` → `string`; `generateConfig(appPath, name, port)` → `string` (config path); `testConfig(confPath)` → `Promise<{ok:boolean, message?:string}>`; `probe()` → `Promise<{ok:boolean, message?:string}>`. These exact names/signatures are used by Tasks 2.

- [ ] **Step 1: Add `nginxBin` to config**

In `server/src/config/index.js`, replace the deployment tail:

```js
    // npm install / build timeouts (ms)
    npmInstallTimeoutMs: parseInt(process.env.NPM_INSTALL_TIMEOUT_MS) || 300000,
    npmBuildTimeoutMs: parseInt(process.env.NPM_BUILD_TIMEOUT_MS) || 300000
  },
```

with:

```js
    // npm install / build timeouts (ms)
    npmInstallTimeoutMs: parseInt(process.env.NPM_INSTALL_TIMEOUT_MS) || 300000,
    npmBuildTimeoutMs: parseInt(process.env.NPM_BUILD_TIMEOUT_MS) || 300000,

    // nginx binary path (default 'nginx' = PATH; set NGINX_BIN for non-PATH installs)
    nginxBin: process.env.NGINX_BIN || 'nginx'
  },
```

- [ ] **Step 2: Add `NGINX_BIN` to `.env.example`**

Replace:

```env
# npm install / build timeouts (ms, default 300000 = 5 min)
NPM_INSTALL_TIMEOUT_MS=300000
NPM_BUILD_TIMEOUT_MS=300000

# PM2 Configuration
```

with:

```env
# npm install / build timeouts (ms, default 300000 = 5 min)
NPM_INSTALL_TIMEOUT_MS=300000
NPM_BUILD_TIMEOUT_MS=300000

# nginx binary path for the nginx deploy type (default 'nginx' = PATH)
# On Windows set the full path, e.g. NGINX_BIN=D:\nginx\nginx.exe
NGINX_BIN=nginx

# PM2 Configuration
```

- [ ] **Step 3: Create `server/src/services/nginx-lifecycle.js`**

Full file content:

```js
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const execPromise = util.promisify(exec);

/**
 * NginxLifecycle — config generation, binary resolution, and pre-flight checks
 * for the nginx deploy_type (static-site server). Mirrors the NpmLifecycle
 * pattern. Used by DeployManager (generate + test before launch) and
 * ProcessManager (binary path for the PM2 entry); app.js calls probe() at boot.
 */
class NginxLifecycle {
  /**
   * nginx binary path. Defaults to 'nginx' (PATH lookup); override via NGINX_BIN
   * for non-PATH installs (common on Windows: NGINX_BIN=D:\nginx\nginx.exe).
   */
  static resolveBinary() {
    return config.deployment.nginxBin;
  }

  /**
   * Render and write the per-app nginx server config. Persisted (not auto-deleted)
   * because nginx re-reads it on PM2 restart.
   *
   * pid / error_log / access_log MUST be redirected into the app dir — nginx's
   * default prefix (install dir, often Program Files on Windows) is not writable.
   * Paths are quoted because the project root may contain spaces.
   *
   * @param {string} appPath absolute app directory
   * @param {string} name app name (sanitized; used in the filename only)
   * @param {number} port platform-assigned port
   * @returns {string} absolute path to the written config
   */
  static generateConfig(appPath, name, port) {
    const confPath = path.join(appPath, `nginx.${name}.conf`);
    const conf = `worker_processes  1;
error_log  "${appPath}/nginx-error.log"  warn;
pid        "${appPath}/nginx.pid";

events { worker_connections 1024; }

http {
  access_log  "${appPath}/nginx-access.log";

  server {
    listen ${port};
    server_name _;
    root   "${appPath}";
    index  index.html;

    location / {
      try_files $uri $uri/ =404;
    }
  }
}
`;
    fs.writeFileSync(confPath, conf, 'utf-8');
    return confPath;
  }

  /**
   * Pre-flight: run `nginx -t -c <conf>`. One call covers two failure modes:
   *  - binary missing (ENOENT / exit 127)  -> 'nginx binary not found ...'
   *  - config syntax / path error          -> 'nginx config invalid: <stderr tail>'
   *
   * @returns {Promise<{ok: boolean, message?: string}>}
   */
  static async testConfig(confPath) {
    const bin = this.resolveBinary();
    try {
      await execPromise(`"${bin}" -t -c "${confPath}"`, {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      return { ok: true };
    } catch (err) {
      if (err.code === 'ENOENT' || /command not found|not recognized|127/.test(err.message || '')) {
        return { ok: false, message: 'nginx binary not found (set NGINX_BIN or add nginx to PATH)' };
      }
      const stderr = (err.stderr || err.stdout || err.message || '').trim();
      return { ok: false, message: 'nginx config invalid: ' + stderr.slice(-500) };
    }
  }

  /**
   * Boot probe: confirm the nginx binary exists/runs. Warn-only — http-server/npm
   * apps don't need it. Called from app.js at startup.
   *
   * @returns {Promise<{ok: boolean, message?: string}>}
   */
  static async probe() {
    const bin = this.resolveBinary();
    try {
      await execPromise(`"${bin}" -v`, { timeout: 10000 });
      return { ok: true };
    } catch (err) {
      if (err.code === 'ENOENT' || /command not found|not recognized|127/.test(err.message || '')) {
        return { ok: false, message: `nginx binary not found at '${bin}' (nginx deploy type unavailable; set NGINX_BIN or add nginx to PATH)` };
      }
      return { ok: false, message: `nginx probe failed: ${(err.stderr || err.message || '').trim().slice(-200)}` };
    }
  }
}

module.exports = NginxLifecycle;
```

- [ ] **Step 4: Verify `generateConfig` output and `probe` shape**

Run from the `server` directory (single-quoted `-e` so bash doesn't touch the JS quotes; `$uri` is literal in JS template strings):

```bash
cd server
node -e 'const N=require("./src/services/nginx-lifecycle");const fs=require("fs"),os=require("os"),path=require("path");const d=fs.mkdtempSync(path.join(os.tmpdir(),"ngx-"));const conf=N.generateConfig(d,"demo",4321);console.log(fs.readFileSync(conf,"utf-8"));N.probe().then(r=>{console.log("PROBE",JSON.stringify(r));fs.rmSync(d,{recursive:true,force:true});});'
```

Expected: the printed config contains `listen 4321;`, `root   "<tmpdir>/..."` (quoted absolute path), `pid        "<tmpdir>/.../nginx.pid"` (redirected into the temp dir), and a `PROBE {"ok":true,...}` line if nginx is installed OR `PROBE {"ok":false,"message":"nginx binary not found ..."}` if not. Either probe result is acceptable — what matters is it returns a JSON object without throwing.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/nginx-lifecycle.js server/src/config/index.js .env.example
git commit -m "feat(nginx): add NginxLifecycle service + NGINX_BIN config

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: nginx backend wiring (validation + start flow + probe + error mapping)

**Files:**
- Modify: `server/src/services/app-manager.js` (nginx case in `validateAppDeployment`, ~line 195)
- Modify: `server/src/services/process-manager.js` (top require + `case 'nginx'`, ~line 152)
- Modify: `server/src/services/deploy-manager.js` (top require + nginx branch + port comment)
- Modify: `server/src/app.js` (top require + boot probe in listen callback)
- Modify: `server/src/routes/index.js` (`isClientError` substrings in start handler)
- Modify: `server/src/docs/openapi.yaml` (line 7 description)

**Interfaces:**
- Consumes: `NginxLifecycle.{resolveBinary, generateConfig, testConfig, probe}` (Task 1).
- Produces: a working nginx deploy type — `POST /api/apps/:id/start` for an nginx app either serves static files (nginx installed) or returns a clean 400.

- [ ] **Step 1: nginx validation requires `index.html`**

In `server/src/services/app-manager.js`, replace:

```js
      case 'nginx':
        // For nginx, just check if there are any files
        break;
```

with:

```js
      case 'nginx':
        if (!files.includes('index.html')) {
          return { valid: false, message: 'Missing index.html for nginx deployment' };
        }
        break;
```

(The `'Missing'` substring is already in `isClientError`, so this maps to 400 with no route change.)

- [ ] **Step 2: Add `case 'nginx'` to ProcessManager**

In `server/src/services/process-manager.js`, add to the top requires (after `const os = require('os');`):

```js
const NginxLifecycle = require('./nginx-lifecycle');
```

Replace the placeholder:

```js
      case 'nginx':
        throw new Error('Nginx deployment not yet implemented');
```

with:

```js
      case 'nginx': {
        // Launch nginx as a PM2-managed process. nginx is a native binary (not a
        // JS entry / .cmd wrapper), so interpreter:'none' execs it directly — no
        // Windows PM2-fork-.cmd problem. `daemon off;` keeps the master in the
        // foreground so PM2 can track/restart/collect stderr.
        if (!port) {
          throw new Error('Port is required for nginx deployment');
        }
        if (!options.nginxConf) {
          throw new Error('nginx config path is required (options.nginxConf)');
        }
        const appsEntry = {
          name: name,
          script: NginxLifecycle.resolveBinary(),
          args: ['-c', options.nginxConf, '-g', 'daemon off;'],
          cwd: appPath,
          interpreter: 'none',
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

- [ ] **Step 3: nginx branch in DeployManager**

In `server/src/services/deploy-manager.js`, add to the top requires (after `const NpmLifecycle = require('./npm-lifecycle');`):

```js
const NginxLifecycle = require('./nginx-lifecycle');
```

Update the port comment (replace):

```js
    // Assign port if needed — both http-server and npm get a platform port.
    // npm apps receive it via the PORT env var (resolved below). Exclude ports
    // already claimed by other apps so two apps never share a port.
```

with:

```js
    // Assign port if needed — http-server, nginx, and npm all get a platform port.
    // npm apps receive it via the PORT env var (resolved below). Exclude ports
    // already claimed by other apps so two apps never share a port.
```

Replace the launch block:

```js
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

with:

```js
    // Start the process. For npm: install → build → resolve env → launch with env.
    // For nginx: generate the per-app config and pre-flight it (binary present +
    // config valid) before launch, so failures surface as clean 400s.
    if (app.deploy_type === 'npm') {
      await NpmLifecycle.install(app.path);
      await NpmLifecycle.build(app.path);
      const env = await NpmLifecycle.resolveEnv(appId, app.port);
      await ProcessManager.startProcess(app, { env });
    } else if (app.deploy_type === 'nginx') {
      const confPath = NginxLifecycle.generateConfig(app.path, app.name, app.port);
      const result = await NginxLifecycle.testConfig(confPath);
      if (!result.ok) {
        throw new Error(result.message);
      }
      await ProcessManager.startProcess(app, { nginxConf: confPath });
    } else {
      await ProcessManager.startProcess(app);
    }
```

- [ ] **Step 4: Warn-only boot probe in app.js**

In `server/src/app.js`, add to the top requires (after `const openApiSpec = require('./docs');`):

```js
const NginxLifecycle = require('./services/nginx-lifecycle');
```

Inside the `app.listen` callback, replace:

```js
  console.log('Press Ctrl+C to stop');
  console.log('');
});
```

with:

```js
  console.log('Press Ctrl+C to stop');
  console.log('');

  // Warn (don't block) if the nginx binary is unavailable — only the nginx
  // deploy type needs it; http-server/npm apps work without it.
  NginxLifecycle.probe().then(({ ok, message }) => {
    if (!ok) console.warn('⚠ ' + message);
  });
});
```

- [ ] **Step 5: Route error mapping**

In `server/src/routes/index.js`, in the `POST /apps/:id/start` handler's `isClientError` condition, add two substrings. Replace:

```js
    const isClientError =
      error.message.includes('already running') ||
      error.message.includes('Missing') ||
```

with:

```js
    const isClientError =
      error.message.includes('already running') ||
      error.message.includes('nginx binary not found') ||
      error.message.includes('nginx config invalid') ||
      error.message.includes('Missing') ||
```

- [ ] **Step 6: OpenAPI description mentions nginx**

In `server/src/docs/openapi.yaml`, replace line 7:

```yaml
    Deploy and manage static sites (http-server) and Node.js (npm) apps via PM2.
```

with:

```yaml
    Deploy and manage static sites (http-server, nginx) and Node.js (npm) apps via PM2.
```

(The `deploy_type` enums at lines 412 and 428 already include `nginx` — no change there.)

- [ ] **Step 7: Integration-verify the start flow**

Start the backend (free port 5000 first on Windows if a stale server holds it):

```bash
cd server && npm run dev    # background or separate terminal
```

If nginx is NOT installed, confirm the boot warning appears in the server log: `⚠ nginx binary not found ...`.

Create a nginx app and capture its id:

```bash
curl -s -X POST http://localhost:5000/api/apps -H "Content-Type: application/json" -d "{\"name\":\"ngxdemo\",\"deploy_type\":\"nginx\"}"
```

Expected: `{ success:true, data:{ ..., name:"ngxdemo", deploy_type:"nginx", status:"stopped" } }`. Note the `id`.

Negative case — start WITHOUT index.html → 400:

```bash
curl -s -X POST http://localhost:5000/api/apps/<id>/start
```

Expected: `{ success:false, error:{ message:"Missing index.html for nginx deployment" } }`.

Create the file, then branch on whether nginx is available:

```bash
# write index.html into the app dir (Windows Git Bash); app dir is apps/ngxdemo
mkdir -p ../apps/ngxdemo && echo "<h1>hello nginx</h1>" > ../apps/ngxdemo/index.html
```

**If nginx IS installed** (or `NGINX_BIN` set):

```bash
curl -s -X POST http://localhost:5000/api/apps/<id>/start
# Expected: { success:true, data:{ status:"running", port:<P>, ... } }
curl -s http://localhost:<P>
# Expected: <h1>hello nginx</h1>
curl -s -X POST http://localhost:5000/api/apps/<id>/stop
# Expected: { success:true, data:{ status:"stopped", ... } }
```

**If nginx is NOT installed** (the always-runnable path):

```bash
curl -s -X POST http://localhost:5000/api/apps/<id>/start
# Expected: { success:false, error:{ message:"nginx binary not found (set NGINX_BIN or add nginx to PATH)" } }
```

- [ ] **Step 8: Commit**

```bash
git add server/src/services/app-manager.js server/src/services/process-manager.js server/src/services/deploy-manager.js server/src/app.js server/src/routes/index.js server/src/docs/openapi.yaml
git commit -m "feat(nginx): wire nginx deploy type (validation, PM2 launch, probe, 400 mapping)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Frontend — enable nginx option + i18n label

**Files:**
- Modify: `client/src/pages/CreateApp.jsx` (line 64)
- Modify: `client/src/i18n/locales/en.json` (line 40)
- Modify: `client/src/i18n/locales/zh.json` (line 40)

**Interfaces:**
- Consumes: backend nginx deploy type (Task 2).
- Produces: nginx selectable in the Create App form with an honest label.

- [ ] **Step 1: Enable the nginx option**

In `client/src/pages/CreateApp.jsx`, replace:

```jsx
            <Option value="nginx" disabled>{t('createApp.nginx')}</Option>
```

with:

```jsx
            <Option value="nginx">{t('createApp.nginx')}</Option>
```

- [ ] **Step 2: English label**

In `client/src/i18n/locales/en.json`, replace:

```json
    "nginx": "Nginx (Coming Soon)",
```

with:

```json
    "nginx": "Nginx (Static Site)",
```

- [ ] **Step 3: Chinese label**

In `client/src/i18n/locales/zh.json`, replace:

```json
    "nginx": "Nginx (即将推出)",
```

with:

```json
    "nginx": "Nginx (静态站)",
```

(`appCard.deployTypes.nginx` already equals `"Nginx"` in both locales — no change needed there.)

- [ ] **Step 4: Verify lint passes**

```bash
cd client && npm run lint
```

Expected: no errors (`--max-warnings 0`). Then optionally start the client (`npm run dev`), open Create App, and confirm the nginx option is selectable and reads "Nginx (静态站)" / "Nginx (Static Site)" with no "Coming Soon".

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/CreateApp.jsx client/src/i18n/locales/en.json client/src/i18n/locales/zh.json
git commit -m "feat(nginx): enable nginx option in Create App + drop Coming Soon label

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Docs — PROGRESS.md + README.md

**Files:**
- Modify: `PROGRESS.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: all prior tasks done.

- [ ] **Step 1: Update PROGRESS.md**

(a) In "## 当前支持的部署类型", replace:

```markdown
- ❌ **Nginx** - 未实现（schema 中保留占位，前端 Select 中禁用）
```

with:

```markdown
- ✅ **Nginx** - 静态站可用（作为 PM2 进程 serve app 目录；需本机安装 nginx 并经 `NGINX_BIN` 或 PATH 提供）。反向代理 / SSL / 域名待后续迭代。
```

(b) In "### 🎯 Phase 12", replace the four-item block:

```markdown
### 🎯 Phase 12: Nginx 部署支持 (优先级: 低)
- [ ] Nginx 配置文件生成
- [ ] 反向代理设置
- [ ] SSL 证书管理
- [ ] 域名绑定
```

with:

```markdown
### ✅ Phase 12: Nginx 部署支持（静态站部分，2026-07-12）
- [x] Nginx 配置文件生成（静态站 server 块，pid/log 重定向到 app 目录）
- [x] nginx 作为 PM2 进程提供静态站服务（复用端口分配 / 启停 / 日志 / 同步）
- [ ] 反向代理设置（网关层，后续迭代）
- [ ] SSL 证书管理（后续迭代）
- [ ] 域名绑定（后续迭代）
```

(c) In the changelog "### [Unreleased] — 2026-07-12" block, under "#### 新增", add a bullet at the top of that section:

```markdown
- Phase 12（静态站部分）：`nginx` 部署类型落地——新增 `NginxLifecycle` 服务（配置生成 + `nginx -t` 预检 + 启动探针），`ProcessManager` 以 `interpreter:'none'` + `daemon off;` 经 PM2 托管 nginx；`NGINX_BIN` 配置；前端 Select 启用 nginx。SSL / 反向代理 / 域名仍待后续迭代。
```

(d) In "## 下一步计划" → "中期目标", tick nginx:

```markdown
1. ✅ Nginx 支持 (Phase 12，静态站部分)
```

(e) In "### ⚠️ 技术债", add one bullet (so the logs gap isn't filed as a bug later):

```markdown
- [ ] nginx app 的 SSE 日志页只能看到启动/致命错误（进 PM2 stderr）；nginx 运行时 access/error 写到 `<app>/nginx-*.log`，未接入 `LogManager`。后续让 LogManager 对 nginx app 改 tail 这些文件。
```

- [ ] **Step 2: Update README.md**

(a) Line ~14 (Features, deploy options), replace:

```markdown
  - `nginx` — placeholder (not yet implemented)
```

with:

```markdown
  - `nginx` — for static sites served by nginx (requires nginx installed; set `NGINX_BIN` if not on `PATH`)
```

(b) Line ~115 (Usage, deploy types), replace:

```markdown
   - **Nginx**: Coming soon
```

with:

```markdown
   - **Nginx**: For static sites, served by nginx (install nginx separately; set `NGINX_BIN` if not on `PATH`)
```

(c) In the Configuration `.env` block (~line 218-227), after the `NPM_BUILD_TIMEOUT_MS=300000` line, add:

```env
# nginx binary path for the nginx deploy type (default 'nginx' = PATH)
NGINX_BIN=nginx
```

(d) Line ~238 (Cross-Platform Compatibility, the PM2 + Windows bullet), append one line after it:

```markdown
- **nginx deploy type**: nginx is a system binary (not an npm package). Set `NGINX_BIN` (default `nginx`) to point at it; PM2 launches it with `interpreter: 'none'` and `daemon off;`. Per-app `pid`/`error_log`/`access_log` are redirected into the app directory so nginx doesn't need write access to its install prefix.
```

- [ ] **Step 3: Commit**

```bash
git add PROGRESS.md README.md
git commit -m "docs: nginx static-site deploy support (Phase 12 partial)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Done criteria

- nginx app can be created, uploaded with `index.html`, and started; if nginx is installed it serves on the assigned port, otherwise start returns a clean 400.
- The four failure modes (index.html missing, binary missing, config invalid, already running) all return 400 with a clear message.
- `npm run lint` (client) passes; server boots (with a warn-only line if nginx is absent).
- `PROGRESS.md` Phase 12 static-site items ticked; README no longer calls nginx a placeholder.
