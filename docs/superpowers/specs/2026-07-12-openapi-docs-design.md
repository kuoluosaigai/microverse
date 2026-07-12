# Swagger / OpenAPI 文档设计

**日期**: 2026-07-12
**状态**: 已确认，待写实现计划
**相关**: PROGRESS 短期目标"添加 API 文档 (Swagger)"

## 背景与目标

Microverse 后端目前有 15 个 REST 端点（`/api` 下），无任何机器可读的 API 描述，文档散落在 README/CLAUDE.md 的文字描述里。目标是补一份**单一事实源**的 OpenAPI 规范 + 自带的交互式 Swagger UI，方便前端开发与外部消费者查阅、试调。

## 现状（事实依据）

- Express 4.18，Node ≥18，路由集中在 `server/src/routes/index.js`（已 524 行），`app.use('/api', routes)`。
- 统一响应信封：成功 `{success:true, data:T}`；失败 `{success:false, error:{message}}`。
- 无鉴权（本地平台）；本轮不引入鉴权。
- 无测试框架（手动验证）。
- 端点清单（15 个）：
  - System: `GET /health`、`GET /config`
  - Applications: `GET /apps`、`GET /apps/:id`、`POST /apps`、`DELETE /apps/:id`
  - Lifecycle: `POST /apps/:id/start`、`/stop`、`/restart`、`/sync`
  - Files & Env: `GET /apps/:id/files`、`POST /apps/:id/upload`（multipart）、`GET /apps/:id/env`、`PUT /apps/:id/env`
  - Logs: `GET /apps/:id/logs/stream`（SSE）

## 关键决策：Spec 来源 = 中央 openapi.yaml

- **采用**：手写单一 `openapi.yaml`，`swagger-ui-express` 启动时解析。
- **理由**：`routes/index.js` 已 524 行，JSDoc 注释（swagger-jsdoc）会让它涨到 ~1200 行；中央 YAML 让整个 API 面一目了然、易 diff，路由文件保持干净。
- **取舍**：spec 与实现靠人工保持同步（中央方案的固有取舍）。本轮把 15 个端点一次写全，后续新增端点时同步更新 spec。

## 架构

```
server/src/docs/openapi.yaml   ← 单一事实源（OpenAPI 3.0.3）
server/src/docs/index.js       ← js-yaml 解析 → 导出 spec 对象（~10 行）
server/src/app.js              ← 挂载 UI + 暴露原始 spec
```

纯文档层：**不改任何路由逻辑或响应体**，只新增 spec 文件 + UI 挂载。

## 依赖（新增，server）

- `swagger-ui-express` — 在指定路径挂载交互式 Swagger UI（Express 4 兼容）。
- `js-yaml` — 启动时把 YAML 解析成 JS 对象。

均为小体积、广泛使用的库。

## 接口与挂载

### `server/src/docs/index.js`（新增）

```js
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const specPath = path.join(__dirname, 'openapi.yaml');
const spec = yaml.load(fs.readFileSync(specPath, 'utf-8'));

module.exports = spec;
```

### `server/src/app.js`（修改：挂载 UI + 暴露 spec）

在 `app.use('/api', routes);` 之后、错误处理之前加：

```js
const swaggerUi = require('swagger-ui-express');
const openApiSpec = require('./docs');

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
app.get('/openapi.json', (req, res) => res.json(openApiSpec));
```

启动 banner（`app.listen` 回调内）加一行：

```js
console.log(`✓ API docs (Swagger UI): http://${config.server.host}:${config.server.port}/api-docs`);
```

## OpenAPI 3.0.3 spec 内容

- **servers**: `{url:/api}`（相对，便于 dev/prod 同一份 spec）。
- **tags**: `System`、`Applications`、`Lifecycle`、`Files & Env`、`Logs`。
- **components/schemas**（可复用）：
  - `App` — `{id, name, path, deploy_type, port, status, created_at, updated_at}`。
  - `AppCreateInput` — `{name:string, deploy_type:"http-server"|"npm"|"nginx"}`。
  - `EnvEntry` — `{key:string, value:string|null}`。
  - `EnvPutInput` — `{env: [EnvEntry]}`。
  - `ErrorResponse` — `{success:false, error:{message:string}}`。
  - `UploadResponse` — `{filesUploaded:number, files:[string]}`。
  - `FileEntry` — `{name:string, type:"file"|"directory"}`。
  - `HealthResponse` — `{status, timestamp, uptime}`（包在 `data` 内）。
  - `SuccessEnvelope`（泛化描述，data 为对应 schema）。
- **特殊端点描述**：
  - `POST /apps/:id/upload` — `requestBody: multipart/form-data`，字段 `files`（array of binary）。
  - `GET /apps/:id/logs/stream` — `responses.200.content["text/event-stream"]`，描述 SSE 事件：`history`（{lines}）、`line`（{level,msg,ts}）、`error`（{message}）；查询参数 `lines`（int，默认 100，上限 1000）。
- **错误响应**：按端点标注 `400`（校验/业务）、`404`（App not found）、`500`（服务端）。

## 挂载与可见性

- UI 路径：`/api-docs`。
- 原始 spec：`GET /openapi.json`。
- **所有环境可见**（与 API 本身无鉴权一致；本地平台）。如需仅 development 开放，可在挂载前加 `NODE_ENV` 判断——本轮默认始终开放。
- CORS 不受影响（UI 与 spec 同源，由后端自身 serve）。

## 受影响文件

- 新增：`server/src/docs/openapi.yaml`、`server/src/docs/index.js`。
- 修改：`server/src/app.js`（挂载）、`server/package.json`（依赖）。
- 文档：`README.md`（Usage 加 `/api-docs`）、`PROGRESS.md`（变更日志）。

## 测试（手动，本轮不写自动化测试）

1. `cd server && npm install`（安装新依赖）后 `npm run dev`，启动日志含 `/api-docs`。
2. 浏览器打开 `http://localhost:5000/api-docs`，确认 15 个端点全部渲染、分组与 schema 正确。
3. `curl http://localhost:5000/openapi.json` 返回合法 JSON；用 Swagger UI 加载无校验错误（即 spec 自洽）。
4. try-it-out 至少 3 个端点真实命中：`GET /health`、`POST /apps`（创建）、`GET /apps`。

## 完成判据

- `/api-docs` 渲染全部 15 个端点，tag 分组与 schema 正确。
- `/openapi.json` 为合法 OpenAPI 3.0.3（Swagger UI 加载无报错）。
- ≥3 个端点 try-it-out 真实命中后端。
- README / PROGRESS 同步。

## 非目标（YAGNI）

- 不做鉴权 / API key。
- 不做 spec 与代码的自动一致性校验（如契约测试）。
- 不改任何路由逻辑或响应体。
- 不把 spec 单独发布到 npm 或外部站点。
