# 开发进度跟踪

## 当前状态

**版本**: v1.0.0（package.json；其后已追加文件上传、i18n、editorial UI 改版等特性，尚未打新 tag）
**最后更新**: 2026-07-09
**状态**: ✅ 核心功能 + 文件上传 + 双语 + editorial UI 均已完成，可用于生产（nginx 类型除外）

## 已完成功能

### ✅ Phase 1: 项目初始化 (2026-02-01)
- [x] 项目目录结构搭建
- [x] npm workspaces 配置
- [x] .gitignore 配置
- [x] 依赖包安装和配置

### ✅ Phase 2: 后端核心功能 (2026-02-02)
- [x] Express 服务器搭建
- [x] SQLite 数据库集成 (使用 sqlite3)
- [x] 数据库 schema 设计和初始化
- [x] RESTful API 实现
  - [x] GET /api/health - 健康检查
  - [x] GET /api/config - 对外客户端配置（上传限制等）
  - [x] GET /api/apps - 获取应用列表
  - [x] GET /api/apps/:id - 获取单个应用
  - [x] POST /api/apps - 创建应用
  - [x] DELETE /api/apps/:id - 删除应用（先清理 PM2 残留进程）
  - [x] POST /api/apps/:id/start - 启动应用
  - [x] POST /api/apps/:id/stop - 停止应用
  - [x] POST /api/apps/:id/restart - 重启应用
  - [x] POST /api/apps/:id/sync - 同步 PM2 实际状态
  - [x] GET /api/apps/:id/files - 查看部署目录文件列表
  - [x] POST /api/apps/:id/upload - 文件上传（含 ZIP 自动解压）
- [x] PM2 进程管理集成
- [x] 跨平台路径处理工具 (`path-helper`)
- [x] 配置管理系统（env 驱动，启动校验）
- [x] 错误处理中间件

### ✅ Phase 3: 前端核心功能 (2026-02-02)
- [x] React + Vite 项目搭建
- [x] Ant Design 集成（ConfigProvider token 覆写）
- [x] Dashboard / CreateApp / UploadFiles 页面
- [x] API 客户端封装 (`client/src/api/apps.js`)
- [x] 前后端集成（Vite proxy 配置）

### ✅ Phase 4: 部署和文档 (2026-02-02)
- [x] PM2 ecosystem 配置
- [x] 环境变量配置模板 (.env.example)
- [x] README.md / CLAUDE.md / PROGRESS.md 等文档体系
- [x] 跨平台兼容性测试 (Windows)
- [x] Git 仓库推送到 GitHub

### ✅ Phase 5: 文件上传功能 (2026-02-09)
- [x] 后端文件上传 API (`POST /api/apps/:id/upload`)
  - [x] 多文件上传（multer，字段名 `files`）
  - [x] ZIP 文件自动解压（adm-zip）
  - [x] 文件大小 / 数量限制（`MAX_FILE_SIZE`、`MAX_FILES`）
  - [x] zip-slip 路径穿越防护（2026-06-28 加固）
- [x] 前端上传界面（UploadFiles）
  - [x] 拖拽 + 点击上传
  - [x] 文件类型 / 扩展名展示
  - [x] 上传后返回 Dashboard
- [x] 对外暴露配置：`GET /api/config` 把 `MAX_FILE_SIZE` 同步到 UI（2026-06-29）

### ✅ Phase 6: 国际化 (i18n) (2026-02-09)
- [x] react-i18next 集成
- [x] 中 / 英双语 (`client/src/i18n/locales/{zh,en}.json`)
- [x] `LanguageSwitcher` 切换，浏览器本地持久化

### ✅ Phase 7: 交互完善 (2026-02-09)
- [x] 端口号可点击，直接打开 `http://localhost:<port>`
- [x] 查看部署目录（Modal 文件列表）

### ✅ Phase 8: 后端加固 (2026-06-28)
- [x] `npm` 部署类型：解析 `npm/bin/npm-cli.js` + `interpreter: 'node'`（修复 Windows 下 PM2 fork 不能跑 `.cmd`）
- [x] `resolveCliModule()` 共享助手，移除硬编码的 `C:\Users\User\…` 路径
- [x] `AppManager.deleteApp` 调用 `ProcessManager.deleteProcess` 清理 PM2 残留
- [x] 上传路由 zip-slip 校验：解压前校验每个 entry 落在 app 目录内

### ✅ Phase 9: Editorial UI 改版 (2026-06-28 ~ 2026-06-29)
> 设计文档：[docs/superpowers/specs/2026-06-28-editorial-ui-redesign-design.md](docs/superpowers/specs/2026-06-28-editorial-ui-redesign-design.md)
- [x] 调色板 + 排版 CSS 变量、antd 中性化覆写 (`styles/index.css`)
- [x] editorial 组件类 (`styles/editorial.css`)
- [x] `EditorialShell` 共享顶栏 + 居中栏 + 分割线
- [x] Dashboard 改为编号行列表（`AppRow` 替换 `AppCard`）
- [x] CreateApp 下划线输入 / 发丝边 Select / 墨色提交按钮
- [x] UploadFiles 纸张拖拽区 + 编号文件行
- [x] `LanguageSwitcher` 改为 `EN / 中` mono 切换
- [x] editorial favicon + README 截图
- [x] `Live / Idle` serif italic 状态文案

## 当前支持的部署类型

- ✅ **Static Site (http-server)** - 完全可用（自动端口分配、PM2 进程管理、启停）
- ✅ **Node.js (npm)** - 可用（Windows 兼容性已于 2026-06-28 修复；依赖安装 / 构建步骤仍未自动化）
- ❌ **Nginx** - 未实现（schema 中保留占位，前端 Select 中禁用）

## 待实现功能

### ✅ Phase 10: 日志管理 (2026-07-09)
- [x] 后端日志接口
  - [x] GET /api/apps/:id/logs/stream - SSE（历史 + 实时）
  - [x] 15s 心跳保活；app 不存在返回 404 JSON
- [x] 前端日志查看
  - [x] 独立页面 /apps/:id/logs（AppLogs）
  - [x] 实时追加 + 粘性自动滚动 + 跳到最新
  - [x] LIVE/IDLE/DISCONNECTED 状态 + 手动重试
  - [x] stderr accent 着色

### 🎯 Phase 11: npm 应用支持完善 (优先级: 中)
- [ ] 上传后自动 `npm install`
- [ ] 构建步骤支持 (`npm run build`)
- [ ] package.json start 脚本校验加强
- [ ] 环境变量管理

### 🎯 Phase 12: Nginx 部署支持 (优先级: 低)
- [ ] Nginx 配置文件生成
- [ ] 反向代理设置
- [ ] SSL 证书管理
- [ ] 域名绑定

### 🎯 Phase 13: 应用监控 (优先级: 低)
- [ ] CPU/内存使用监控
- [ ] 请求统计
- [ ] 错误率监控
- [ ] 告警系统

### 🎯 Phase 14: 用户系统 (优先级: 低)
- [ ] 用户注册/登录
- [ ] JWT 认证
- [ ] 权限管理
- [ ] 多用户应用隔离

### 🎯 Phase 15: 优化和增强 (优先级: 低)
- [ ] 数据库迁移系统
- [ ] 应用备份和恢复
- [ ] 批量操作支持
- [ ] 应用模板系统
- [ ] 命令行工具 (CLI)

## 已知问题和技术债

### 🐛 Bug
- 无已知严重 bug

### ⚠️ 技术债
- [ ] 缺少单元测试 / 集成测试（目前仅手动测试）
- [ ] API 文档可用 Swagger/OpenAPI 规范化
- [ ] 前端缺少错误边界 (Error Boundary)
- [ ] 需要添加请求限流
- [ ] 输入验证、SQL 注入防护等安全性增强
- [ ] `MAX_FILE_SIZE` 默认值在 config 与 .env.example 间需保持同步

### 💡 改进建议
- [ ] 添加 TypeScript 支持
- [ ] 实现数据库连接池
- [ ] 添加缓存层 (Redis)
- [ ] 实现 WebSocket 实时更新
- [ ] 优化前端性能（代码分割、懒加载）
- [ ] 暗色（"ink"）主题变体

## 测试覆盖率

- 后端 API: ✅ 手动测试通过
- 前端组件: ✅ 手动测试通过
- 集成测试: ✅ 完整流程测试通过（创建 / 上传 / 启动 / 端口打开 / 停止 / 查看目录 / 删除 / 切换语言）
- 自动化测试: ❌ 未实现

## 性能指标

> 以下为 v1.0.0 初始环境（Windows 11, Node.js v24.13.0）下的参考值，非最新实测：

- API 响应时间: < 100ms (平均)
- 应用启动时间: 2–5 秒
- 前端首屏加载: < 1 秒 (开发模式)
- 数据库查询: < 10ms

## 下一步计划

**立即任务**:
1. 补充基础单元 / 集成测试

**短期目标**:
1. 完善 npm 应用部署 (Phase 11) — 自动依赖安装 / 构建
2. 添加 API 文档 (Swagger)

**中期目标**:
1. Nginx 支持 (Phase 12)
2. 应用监控仪表盘 (Phase 13)
3. 性能优化

**长期目标**:
1. 用户系统 (Phase 14)
2. 完整测试覆盖
3. 生产环境部署指南

## 贡献者

- 开发: Claude + Human Developer (kuoluosaigai)
- 测试: Manual Testing
- 文档: Claude + Human Developer

## 变更日志

### [Unreleased] — 2026-07-09
#### 新增
- 日志管理（Phase 10）：`GET /api/apps/:id/logs/stream` SSE（最近 N 行历史 + 实时推送）；`LogManager` 服务（解析 PM2 日志路径 + `fs.watch` 增量 tail，按字节偏移、行缓冲、轮转重置）；前端 `AppLogs` 页面（粘性自动滚动、LIVE/IDLE/DISCONNECTED + 重试、stderr 红色）；AppRow 新增 Logs 入口。
#### 移除
- `ProcessManager.getProcessLogs`（死代码，被 LogManager 取代）。

### [Unreleased] — 2026-06-28 ~ 2026-06-29
#### 新增
- Editorial UI 全面改版（EditorialShell / AppRow / 编号行 / serif × mono / 纸张暖色 / 单一红色强调）
- `GET /api/config` 对外暴露上传限制
- editorial favicon、README 截图
#### 修复
- `npm` 部署类型在 Windows + PM2 fork 模式下无法启动（改为解析 JS 入口 + `interpreter: 'node'`）
- 移除硬编码的 `C:\Users\User\…` 路径，统一走 `resolveCliModule()`
- `AppManager.deleteApp` 不清理 PM2 残留进程
- 上传解压 zip-slip 路径穿越漏洞

### [Unreleased] — 2026-02-09 ~ 2026-02-10
#### 新增
- 文件上传 + ZIP 自动解压 + 拖拽 UI (`POST /api/apps/:id/upload`)
- 中英双语 i18n（react-i18next，浏览器持久化）
- 查看部署目录文件列表 (`GET /api/apps/:id/files` + Modal)
- 端口号可点击直接打开已部署应用
- `POST /api/apps/:id/restart` 重启端点
- API 端点 / 组件规范 spec 文档 (`.trellis/spec`, `docs/superpowers/specs`)

### [1.0.0] - 2026-02-02
#### 新增
- 完整的前后端架构（Express + SQLite(sqlite3) + PM2；React + Vite + Ant Design）
- RESTful API（CRUD / 启停 / 同步 / 健康检查）
- Static site (http-server) 部署支持，自动端口分配
- 跨平台兼容性（Windows/Linux）
- 文档体系：README / CLAUDE / PROGRESS / WORKFLOW / QUICK-REF / DOCS
#### 修复
- Windows 下 PM2 + http-server 兼容性问题
- better-sqlite3 编译问题（替换为 sqlite3）

---

**更新说明**:
- 本文档应在每次重要进度更新后同步修改
- 完成任务时将对应项目标记为 [x]
- 添加新功能时更新"待实现功能"部分
- 发现 bug 时添加到"已知问题"部分
