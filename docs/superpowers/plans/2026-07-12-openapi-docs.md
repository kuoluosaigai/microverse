# Swagger / OpenAPI 文档实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为现有 15 个 REST 端点提供单一事实源的 OpenAPI 3.0.3 规范（中央 `openapi.yaml`）+ 后端自带的交互式 Swagger UI（`/api-docs`），纯文档层、不改任何路由逻辑。

**Architecture:** 新增 `server/src/docs/openapi.yaml`（完整 spec）+ `server/src/docs/index.js`（js-yaml 启动时解析为对象）；`app.js` 用 `swagger-ui-express` 挂载 `/api-docs`，并暴露 `GET /openapi.json`。

**Tech Stack:** Node.js + Express 4.18 + `swagger-ui-express` + `js-yaml`。

## Global Constraints

- 纯文档层：**不改任何路由逻辑、响应体或 DB schema**，只新增 spec 文件 + UI 挂载。
- 路径一律用 Node `path` 模块。
- `openapi.yaml` 是**唯一事实源**；与实现靠人工保持同步。
- OpenAPI 版本固定 **3.0.3**（工具链支持最广）。
- 本轮不写自动化测试（项目惯例），手动验证 + commit 收尾。
- 代码与 commit message 用英文；spec 描述可英文。
- UI 所有环境可见（与 API 本身无鉴权一致）。
- 枚举值以 schema.sql 为准：`deploy_type ∈ {npm, http-server, nginx}`，`status ∈ {running, stopped}`。

---

## File Structure

**新增**
- `server/src/docs/openapi.yaml` — 完整 OpenAPI 3.0.3 spec（15 端点 + 可复用 schema）。
- `server/src/docs/index.js` — js-yaml 解析 yaml，导出 spec 对象。

**修改**
- `server/package.json` — 新增 `swagger-ui-express`、`js-yaml` 依赖。
- `server/src/app.js` — 顶部 require 两个模块；`/api` 路由后挂载 `/api-docs` + `/openapi.json`；启动 banner 加一行。
- `README.md` — Usage 加 `/api-docs`。
- `PROGRESS.md` — 变更日志补一条。

---

### Task 1: 安装依赖 + 完整 openapi.yaml + loader + 挂载 UI

**Files:**
- Modify: `server/package.json`（dependencies 追加两项）
- Create: `server/src/docs/openapi.yaml`
- Create: `server/src/docs/index.js`
- Modify: `server/src/app.js`（顶部 require + 路由后挂载 + banner）

**Interfaces:**
- Produces: `require('./docs')` → OpenAPI spec 对象；`GET /api-docs` → Swagger UI；`GET /openapi.json` → spec JSON。

- [ ] **Step 1: `server/package.json` 的 `dependencies` 追加两项**

在 `"sqlite3": "^5.1.7"` 之后加：
```json
    ,
    "swagger-ui-express": "^5.0.1",
    "js-yaml": "^4.1.0"
```

- [ ] **Step 2: 安装依赖**

```bash
cd server && npm install
```
预期：`added N packages`，`package.json` 与 `package-lock.json` 更新。

- [ ] **Step 3: 创建 `server/src/docs/index.js`**

```js
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const specPath = path.join(__dirname, 'openapi.yaml');
const spec = yaml.load(fs.readFileSync(specPath, 'utf-8'));

module.exports = spec;
```

- [ ] **Step 4: 创建 `server/src/docs/openapi.yaml`（完整 spec）**

```yaml
openapi: 3.0.3
info:
  title: Microverse API
  version: 1.0.0
  description: |
    Microverse — a cross-platform micro-application deployment platform.
    Deploy and manage static sites (http-server) and Node.js (npm) apps via PM2.

    All responses use the envelope:
    `{ success: boolean, data?: <T>, error?: { message: string } }`.
  license:
    name: MIT
servers:
  - url: /api
    description: API root (relative — works in dev and prod)
tags:
  - name: System
    description: Health and public configuration
  - name: Applications
    description: Application CRUD
  - name: Lifecycle
    description: Start / stop / restart / sync
  - name: Files & Env
    description: File listing, upload, and environment variables
  - name: Logs
    description: Log streaming
paths:
  /health:
    get:
      tags: [System]
      summary: Health check
      operationId: getHealth
      responses:
        '200':
          description: Server is healthy
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, example: true }
                  data: { $ref: '#/components/schemas/HealthData' }
  /config:
    get:
      tags: [System]
      summary: Public client configuration (upload limits)
      operationId: getConfig
      responses:
        '200':
          description: Public config
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, example: true }
                  data: { $ref: '#/components/schemas/ConfigData' }
  /apps:
    get:
      tags: [Applications]
      summary: List all applications
      operationId: listApps
      responses:
        '200':
          description: App list
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, example: true }
                  data:
                    type: array
                    items: { $ref: '#/components/schemas/App' }
    post:
      tags: [Applications]
      summary: Create a new application
      operationId: createApp
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/AppCreateInput' }
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, example: true }
                  data: { $ref: '#/components/schemas/App' }
        '400':
          description: Missing fields / invalid deploy_type / name already exists
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }
  /apps/{id}:
    get:
      tags: [Applications]
      summary: Get an application by ID
      operationId: getApp
      parameters: [{ $ref: '#/components/parameters/AppId' }]
      responses:
        '200':
          description: The application
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, example: true }
                  data: { $ref: '#/components/schemas/App' }
        '404':
          description: App not found
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }
    delete:
      tags: [Applications]
      summary: Delete an application (must be stopped first)
      operationId: deleteApp
      parameters: [{ $ref: '#/components/parameters/AppId' }]
      responses:
        '200':
          description: Deleted
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, example: true }
                  data:
                    type: object
                    properties:
                      message: { type: string, example: "App deleted successfully" }
        '400':
          description: Cannot delete a running app
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }
        '404':
          description: App not found
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }
  /apps/{id}/start:
    post:
      tags: [Lifecycle]
      summary: Start an application (npm apps run install/build first)
      operationId: startApp
      parameters: [{ $ref: '#/components/parameters/AppId' }]
      responses:
        '200':
          description: Started (running)
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, example: true }
                  data: { $ref: '#/components/schemas/App' }
        '400':
          description: Already running, missing start script, npm install/build failure/timeout, invalid package.json
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }
        '404':
          description: App not found
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }
        '500':
          description: Server error
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }
  /apps/{id}/stop:
    post:
      tags: [Lifecycle]
      summary: Stop a running application
      operationId: stopApp
      parameters: [{ $ref: '#/components/parameters/AppId' }]
      responses:
        '200':
          description: Stopped
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, example: true }
                  data: { $ref: '#/components/schemas/App' }
        '400':
          description: App is not running
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }
        '404':
          description: App not found
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }
  /apps/{id}/restart:
    post:
      tags: [Lifecycle]
      summary: Restart a running application
      operationId: restartApp
      parameters: [{ $ref: '#/components/parameters/AppId' }]
      responses:
        '200':
          description: Restarted
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, example: true }
                  data: { $ref: '#/components/schemas/App' }
        '400':
          description: App is not running
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }
        '404':
          description: App not found
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }
  /apps/{id}/sync:
    post:
      tags: [Lifecycle]
      summary: Sync app status with the actual PM2 process state
      operationId: syncApp
      parameters: [{ $ref: '#/components/parameters/AppId' }]
      responses:
        '200':
          description: Synced
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, example: true }
                  data: { $ref: '#/components/schemas/App' }
        '404':
          description: App not found
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }
  /apps/{id}/files:
    get:
      tags: [Files & Env]
      summary: List files in an application's deploy directory
      operationId: listFiles
      parameters: [{ $ref: '#/components/parameters/AppId' }]
      responses:
        '200':
          description: File list
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, example: true }
                  data:
                    type: array
                    items: { $ref: '#/components/schemas/FileEntry' }
        '404':
          description: App not found
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }
  /apps/{id}/upload:
    post:
      tags: [Files & Env]
      summary: Upload files (multipart). ZIPs auto-extract with zip-slip guard.
      operationId: uploadFiles
      parameters: [{ $ref: '#/components/parameters/AppId' }]
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              properties:
                files:
                  type: array
                  items: { type: string, format: binary }
      responses:
        '200':
          description: Files uploaded
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, example: true }
                  data: { $ref: '#/components/schemas/UploadResponse' }
        '400':
          description: No files / file too large / ZIP extraction failed
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }
        '404':
          description: App not found
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }
  /apps/{id}/env:
    get:
      tags: [Files & Env]
      summary: List an application's environment variables
      operationId: getAppEnv
      parameters: [{ $ref: '#/components/parameters/AppId' }]
      responses:
        '200':
          description: Env entries
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, example: true }
                  data:
                    type: array
                    items: { $ref: '#/components/schemas/EnvEntry' }
        '404':
          description: App not found
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }
    put:
      tags: [Files & Env]
      summary: Replace an application's environment variables (applies on next start)
      operationId: setAppEnv
      parameters: [{ $ref: '#/components/parameters/AppId' }]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/EnvPutInput' }
      responses:
        '200':
          description: Saved env entries
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, example: true }
                  data:
                    type: array
                    items: { $ref: '#/components/schemas/EnvEntry' }
        '400':
          description: Invalid key / duplicate key / env not an array
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }
        '404':
          description: App not found
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }
  /apps/{id}/logs/stream:
    get:
      tags: [Logs]
      summary: Stream an app's PM2 logs as SSE (recent history, then live)
      operationId: streamLogs
      parameters:
        - { $ref: '#/components/parameters/AppId' }
        - name: lines
          in: query
          required: false
          schema: { type: integer, default: 100, maximum: 1000, minimum: 1 }
          description: Number of history lines per stream
      responses:
        '200':
          description: |
            Server-Sent Events stream (`text/event-stream`). Events:
            `history` — `{ lines: [{level, msg}] }` (out then err);
            `line` — `{ level: "out"|"err", msg, ts }` (live);
            `error` — `{ message }`.
            A `: ping` comment is sent every 15s as keep-alive.
          content:
            text/event-stream:
              schema:
                type: string
        '404':
          description: App not found
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }
components:
  parameters:
    AppId:
      name: id
      in: path
      required: true
      schema: { type: integer }
      description: Application ID
  schemas:
    App:
      type: object
      properties:
        id: { type: integer, example: 7 }
        name: { type: string, example: "my-app" }
        path: { type: string, example: "/data/microverse/apps/my-app" }
        deploy_type:
          type: string
          enum: [npm, http-server, nginx]
          example: "npm"
        port: { type: integer, nullable: true, example: 3000 }
        status:
          type: string
          enum: [running, stopped]
          example: "running"
        created_at: { type: string, example: "2026-07-12 03:25:59" }
        updated_at: { type: string, example: "2026-07-12 03:26:23" }
    AppCreateInput:
      type: object
      required: [name, deploy_type]
      properties:
        name: { type: string, example: "my-app" }
        deploy_type:
          type: string
          enum: [npm, http-server, nginx]
          example: "npm"
    EnvEntry:
      type: object
      required: [key]
      properties:
        key: { type: string, example: "API_KEY" }
        value: { type: string, nullable: true, example: "secret123" }
    EnvPutInput:
      type: object
      required: [env]
      properties:
        env:
          type: array
          items: { $ref: '#/components/schemas/EnvEntry' }
    ErrorResponse:
      type: object
      properties:
        success: { type: boolean, example: false }
        error:
          type: object
          required: [message]
          properties:
            message: { type: string, example: "App not found" }
    UploadResponse:
      type: object
      properties:
        filesUploaded: { type: integer, example: 2 }
        files:
          type: array
          items: { type: string }
          example: ["index.html", "server.js"]
    FileEntry:
      type: object
      properties:
        name: { type: string, example: "index.html" }
        type:
          type: string
          enum: [file, directory]
          example: "file"
    HealthData:
      type: object
      properties:
        status: { type: string, example: "ok" }
        timestamp: { type: string, format: date-time }
        uptime: { type: number, example: 21.302 }
    ConfigData:
      type: object
      properties:
        upload:
          type: object
          properties:
            maxFileSize: { type: integer, example: 104857600 }
            maxFiles: { type: integer, example: 100 }
```

- [ ] **Step 5: `server/src/app.js` 顶部加 require**

在 `const routes = require('./routes');` 之后加：
```js
const swaggerUi = require('swagger-ui-express');
const openApiSpec = require('./docs');
```

- [ ] **Step 6: `server/src/app.js` 在 `/api` 路由后挂载 UI + 原始 spec**

在 `app.use('/api', routes);` 之后、根端点 `app.get('/', ...)` 之前插入：
```js
// API documentation (Swagger UI) + raw OpenAPI spec
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
app.get('/openapi.json', (req, res) => res.json(openApiSpec));
```

- [ ] **Step 7: 启动 banner 加一行**

在 `app.listen` 回调里，`✓ API available at ...` 这行之后加：
```js
      console.log(`✓ API docs (Swagger UI): http://${config.server.host}:${config.server.port}/api-docs`);
```

- [ ] **Step 8: 手动验证**

```bash
cd server && npm run dev   # 后台或另开终端
# 1) 启动日志含 /api-docs（且服务正常启动 = yaml 解析无误）
curl -s http://localhost:5000/api/health
# 2) UI 页面返回 HTML
curl -s -o /dev/null -w "api-docs HTTP=%{http_code}\n" http://localhost:5000/api-docs
# 3) 原始 spec 合法、路径数 = 15
curl -s http://localhost:5000/openapi.json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('openapi:',j.openapi);console.log('paths:',Object.keys(j.paths).length);console.log('schemas:',Object.keys(j.components.schemas).length)})"
```
预期：`api-docs HTTP=200`；`openapi: 3.0.3`；`paths: 15`；`schemas:` 至少 9 个（App/AppCreateInput/EnvEntry/EnvPutInput/ErrorResponse/UploadResponse/FileEntry/HealthData/ConfigData）。

可选深检（联网装 lint 工具）：
```bash
cd server && npx -y @redocly/cli@latest lint src/docs/openapi.yaml 2>&1 | tail -5
```
预期无 error。

- [ ] **Step 9: 提交**

```bash
git add server/package.json server/package-lock.json server/src/docs/openapi.yaml server/src/docs/index.js server/src/app.js
git commit -m "feat(docs): OpenAPI 3.0.3 spec + Swagger UI at /api-docs"
```

---

### Task 2: 文档同步（README + PROGRESS）

**Files:**
- Modify: `README.md`
- Modify: `PROGRESS.md`

- [ ] **Step 1: README 的 Usage / API 段补一行 Swagger UI**

在 `README.md` 合适位置（`## API Endpoints` 段开头或 Usage 段）加一行：
```markdown
> Interactive API docs (Swagger UI): `http://localhost:5000/api-docs` — raw spec at `GET /openapi.json`.
```

- [ ] **Step 2: PROGRESS.md 变更日志补一条**

在 `### [Unreleased] — 2026-07-12` 段的 `#### 修复` 之前，`#### 新增` 列表内追加一条：
```markdown
- Swagger / OpenAPI 文档：中央 `openapi.yaml`（3.0.3，15 端点 + 可复用 schema）+ `swagger-ui-express` 在 `/api-docs` 提供交互式 UI；`GET /openapi.json` 暴露原始 spec。
```

并在"短期目标"里把"添加 API 文档 (Swagger)"标记为已完成（删去或加 ✅）。

- [ ] **Step 3: 手动验证文档无残留过期描述**

通读两处改动，确认未与现有描述冲突。

- [ ] **Step 4: 提交**

```bash
git add README.md PROGRESS.md
git commit -m "docs: README/PROGRESS — Swagger UI at /api-docs"
```

---

## 完成判据（Definition of Done）

- `GET /api-docs` 返回 Swagger UI（HTTP 200，HTML）。
- `GET /openapi.json` 返回合法 OpenAPI 3.0.3，`paths` 恰好 15 个，枚举值与 schema.sql 一致（deploy_type/status）。
- 服务正常启动（证明 yaml 可解析）。
- README / PROGRESS 同步，无过期描述。
- 纯文档层：路由逻辑、响应体、DB schema 均未改动（`git diff` 应只含 docs/app.js/package.json/README/PROGRESS）。
