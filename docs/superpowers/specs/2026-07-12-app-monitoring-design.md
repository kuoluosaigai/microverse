# 应用监控（Phase 13，资源监控部分）— 设计文档

- **日期**: 2026-07-12
- **状态**: Approved (design)
- **范围**: Phase 13 的第一块——把 PM2 已有的 per-app CPU/内存/运行时长暴露成 API + 在 UI 展示（Dashboard 行内当前值 + 独立 Metrics 页历史曲线）。
- **不在范围**: 部署应用的请求统计 / 错误率（需反向代理网关，已随 SSL/域名推迟）、平台自身 API 统计、告警系统。

## 背景

Phase 13 列了 4 项（资源 / 请求 / 错误率 / 告警），但可行性差很大：

- **资源监控**：`ProcessManager.getProcessStatus()` 已经在返回每个运行中 app 的 `{ pid, uptime, memory, cpu }`（PM2 的 `monit`/`pm2_env`）。采集层已具备，只差暴露 + 展示。
- **请求统计 / 错误率**：平台**不在部署应用的流量路径上**（每个 app 直连自己的端口），拿不到它们的 HTTP 请求/错误数据，除非做反向代理网关（SSL/域名那轮已否决）或解析 nginx access log（仅限 nginx app）。本轮不做。
- **告警**：建立在上述之上，且需通知渠道（邮件/webhook）。本轮不做。

故 v1 只做资源监控——独立、可用、零外部依赖、数据现成。

## 关键决策（brainstorm 已确认）

1. **范围 = 仅资源监控仪表盘**（CPU/内存/uptime per app）。
2. **展示位置 = Dashboard 行内当前值 + 独立 Metrics 页历史曲线**（两者都要）。
3. **架构 = 后台采样器 + 轮询端点 + 手写 SVG 火花线**：
   - 后台 `MetricsSampler`（10s/tick，单次 `pm2 jlist` 拿全部进程）把 PM2 和请求路径解耦——`/api/apps` 只读内存，零 PM2 调用。
   - 低频（10s）轮询远比 SSE 简单且够用（metrics 不是 logs 那种高频行流）。
   - 内存环形缓冲（默认 180 样本 = 30min）对"临时运维数据"足够；重启清空可接受。
   - 手写 SVG 火花线零依赖，契合 editorial 克制美学（recharts 那种带坐标轴/tooltip 的精致图反而会打架）。

## 架构

### 新增 `MetricsSampler` 服务（单例）

`server/src/services/metrics-sampler.js`，导出单例实例（非类）。

```
// 内存状态
// buffers: Map<appName, Sample[]>
// Sample = { ts: number(epoch ms), cpu: number(%), memory: number(bytes), uptimeMs: number }
```

| 方法 | 职责 |
|---|---|
| `start()` | 启 `setInterval`（默认 10s）。每 tick 调一次 `ProcessManager.getAllProcessStatus()`，把每个进程的最新 Sample 推入其缓冲；超过 `metricsMaxSamples`（默认 180）则 `shift()` 掉最旧。PM2 调用失败 → `console.warn` + 跳过本 tick，不抛、不停。 |
| `stop()` | 清 interval（graceful shutdown / 测试用）。 |
| `getLatest(name)` | 返回该 app 最新 Sample 或 `null`（停止/未跑过）。 |
| `getHistory(name)` | 返回该 app 的 Sample 数组（可能为 `[]`）。 |

接入：`app.js` 的 `listen` 回调里 `metricsSampler.start()`；现有 `SIGTERM`/`SIGINT` 处理器加 `metricsSampler.stop()`（同 nginx probe 接入点）。

> 每 tick 只调一次 PM2（`pm2 jlist` 一次拿全量进程），不是每 app 一次。

### ProcessManager 抽 `getAllProcessStatus()`

新增静态方法 `getAllProcessStatus()` → `Array<{ name, status, pid, uptime, memory, cpu }>`：调一次 `pm2 jlist`，解析全量。现有 `getProcessStatus(appName)` 改为 `getAllProcessStatus().find(p => p.name === appName)`（DRY，消除 jlist 解析重复）。采样器用 `getAllProcessStatus()`。

## 数据流

```
PM2  ──(10s, getAllProcessStatus)──▶  MetricsSampler 内存环形缓冲
                                          │
                          getLatest(name) │ getHistory(name)
                                          ▼
   GET /api/apps            (每 app 附带 metrics 最新快照)  ── Dashboard 行内值
   GET /api/apps/:id/metrics  (返回 history 数组)          ── Metrics 页曲线
```

- 停止的 app：PM2 jlist 里没有 → 不产生新样本；旧缓冲保留（曲线停在最后一点）。
- 服务重启 → 内存清空，历史从零开始填。
- 非 app 的 PM2 进程（如 microverse-server）也会被采样存下，但 API 按 app 名查，永不暴露——无副作用，内存可忽略。

## 端点

### 改 `GET /api/apps`（向后兼容、加性字段）

每个 app 附带：
```json
"metrics": { "ts": 1234567890, "cpu": 12.3, "memory": 87900160, "uptimeMs": 360000 } | null
```
由 `metricsSampler.getLatest(app.name)` 取最新 Sample（含 uptimeMs）。`GET /api/apps/:id` 同样附带，保持一致。

**附加位置**：在 `routes/index.js` 的 `GET /apps` 和 `GET /apps/:id` 处理器里调 `metricsSampler.getLatest()` 并挂到每个 app 上——**不在 AppManager 里做**，保持 AppManager 只管 DB/CRUD、不依赖运行时采样器。

### 新增 `GET /api/apps/:id/metrics`

解析 app（不存在 404），返回：
```json
{ "success": true, "data": [ { "ts":..., "cpu":..., "memory":..., "uptimeMs":... }, ... ] }
```
无样本 → `data: []`。

## 配置

`config.deployment` 加两项（+ `.env.example`）：
- `metricsIntervalMs = parseInt(process.env.METRICS_INTERVAL_MS) || 10000`
- `metricsMaxSamples = parseInt(process.env.METRICS_MAX_SAMPLES) || 180`

## 前端

### Dashboard 行内值 + 自动刷新

- `AppRow` 对 **running 且有 metrics** 的 app 显示紧凑 mono 单元格：`12% · 84M`（CPU% · 内存）；非 running 留空。
- `Dashboard` 加 **静默自动刷新**：`setInterval(() => loadApps(false), 10000)`，卸载时清掉。`loadApps(false)` 不触发 refreshing spinner。背景轮询只更新 apps 数据，与 `startingId` 等本地态无冲突。

### 新 Metrics 页（`/apps/:id/metrics`）

- 新路由（`App.jsx`）+ 新页 `AppMetrics.jsx`，结构镜像 `AppLogs`（EditorialShell + 返回链 + 标题 + 内容区）。
- 每 10s 轮询 `GET /api/apps/:id/metrics`，history 数组进 state。
- **数值卡**：CPU %、内存（格式化 MB/GB）、运行时长（格式化 `1h 23m`），取最后一条样本。
- **火花线**：CPU 一条、内存一条（量纲不同，独立两图）。
- 状态：加载中 / 空态（app 从未跑过）/ 有数据。
- `AppRow` 加 **Metrics** 动作按钮（Logs 旁）。

### 新 `Sparkline` 组件（`client/src/components/Sparkline.jsx`）

手写 SVG，零依赖：
- props：`data: number[]`、`width=120`、`height=32`、`color`（CSS 变量）、可选 `max`（CPU 固定 0–100；内存用数据自身 max）。
- `<polyline>` 缩放到 min/max；`data.length < 2` 画平线。
- editorial：1.5px 细线、单色 accent、无坐标轴/网格（最新值由数值卡承担）。
- ~30–40 行。

### API 客户端 + i18n

- `client/src/api/apps.js` 加 `getAppMetrics(id)`。
- i18n（zh/en）新键：`appCard.metrics`（按钮）、Metrics 页标题/数值卡标签/空态。

## 错误处理

- **后端**：采样器 PM2 调用失败 → `warn` + 跳过 tick（不停、不抛）；端点 app 不存在 → 404，无样本 → `[]`/`null`。
- **前端**：轮询失败 → 保留上一次数据、下次 tick 自动重试；显示轻量 "stale" 小标记（不做 logs 页 LIVE/DISCONNECTED 状态机——metrics 轮询天然自愈）。

## 测试

本特性**不引入测试框架**（"补测试覆盖"是独立 tech-debt 任务）。手动测试矩阵：

```
1. 起 http-server + npm app 各一个
2. Dashboard → running app 行内出现 CPU%·MEM，每 10s 更新
3. 点 Metrics → 数值卡 + 火花线，每 10s 追加新点
4. Stop 一个 app → 行内值冻结/消失；Metrics 页停在最后一段历史
5. 重启后端 → 历史清空，~30s 后重新填起来
6. 负向：从未跑过的 app → Metrics 页空态；Dashboard 无行内值
```

**自然可测单元**（待引入测试框架）：`Sparkline` 的点缩放纯函数、`MetricsSampler` 的环形缓冲 cap 行为。

## 已知限制 / 范围外

1. **内存 only**：重启清空历史，约 30s 重新填满（metrics 是临时运维数据，非权威状态）。
2. PM2 的 `cpu` 是滚动窗口均值，较粗（PM2 自身特性）。
3. Dashboard 每 10s 后台轮询是常驻（廉价）流量。
4. 火花线无时间轴刻度（刻意克制；"现在"由数值卡承担）。
5. 请求统计 / 错误率 / 告警——本轮明确不做（需网关层或平台 API 中间件，见背景）。

## 改动面 checklist（实现时用）

**后端新增**
- `server/src/services/metrics-sampler.js`

**后端改**
- `server/src/services/process-manager.js` — `getAllProcessStatus()`，`getProcessStatus` 委托
- `server/src/routes/index.js` — `GET /apps`、`GET /apps/:id` 附 metrics；新增 `GET /apps/:id/metrics`
- `server/src/app.js` — `metricsSampler.start()` + stop on SIGTERM/SIGINT
- `server/src/config/index.js` + `.env.example` — `METRICS_INTERVAL_MS`、`METRICS_MAX_SAMPLES`
- `server/src/docs/openapi.yaml` — `App.metrics` 字段 + 新 endpoint

**前端新增**
- `client/src/pages/AppMetrics.jsx`
- `client/src/components/Sparkline.jsx`

**前端改**
- `client/src/App.jsx` — `/apps/:id/metrics` 路由
- `client/src/components/AppRow.jsx` — Metrics 按钮 + 行内值单元格
- `client/src/pages/Dashboard.jsx` — 10s 自动刷新
- `client/src/api/apps.js` — `getAppMetrics(id)`
- `client/src/i18n/locales/{zh,en}.json` — 新键
- `client/src/styles/editorial.css` — metrics 单元格 + 火花线样式

**文档**
- `PROGRESS.md` — Phase 13 部分勾选（资源监控）；请求/错误/告警仍待办
- `README.md` — Features 提一句 metrics 仪表盘
