# 应用备份/恢复（Phase 15）— 设计文档

- **日期**: 2026-07-13
- **状态**: Approved (design)
- **范围**: per-app 备份（导出 zip）+ 恢复（上传 zip 重建 app），含文件、元数据、环境变量。
- **不在范围**: 整系统备份、自动定时备份、增量备份、备份加密、跨大版本迁移。

## 背景

部署平台缺数据安全基线——一个 app 的文件 + 配置 + env 没法整体导出/迁移/灾备。Phase 15 列了备份/恢复作为一项。本设计交付 per-app 的 zip 备份/恢复。

## 关键决策（brainstorm 已确认）

1. **范围 = 单 app**（zip 下载 + zip 上传恢复）。
2. **恢复命名冲突 = 报错**（400，用户先改名/删除），不静默覆盖、不自重命名。
3. **架构 = manifest 内嵌 zip + 内存 buffer 备份 + 先校验再建 + 失败回滚**：复用现有 adm-zip（上传路径已在用）+ zip-slip 范式；内存 buffer 对 ≤~100MB 单管理员低频场景够用，不引入流式/临时文件依赖。

## zip 布局 + manifest 格式

zip 根：
```
microverse-manifest.json      ← 应用元数据
files/                         ← app 目录的全部内容
  index.html
  ...
```
用 `files/` 子目录隔离应用文件，避免 `microverse-manifest.json` 与应用同名文件冲突。

```json
{ "version": 1, "name": "my-app", "deploy_type": "http-server",
  "env": [ { "key": "API_KEY", "value": "..." } ] }
```
**只含** `name` / `deploy_type` / `env`（+ schema `version`）。**不含** `id` / `port` / `status` / `path` / 时间戳——实例相关，恢复时重定。

## 架构：新 `BackupManager` 服务

`server/src/services/backup-manager.js`（镜像 NpmLifecycle/AuthManager 模式），两个静态方法：

| 方法 | 职责 |
|---|---|
| `createBackup(app)` | 读 `getAppEnv(app.id)`；建 adm-zip：`addLocalFolder(app.path, 'files')`（目录不存在则跳过）+ `addFile('microverse-manifest.json', manifestJson)`；`toBuffer()` 返回 `{ buffer, filename: '<name>-backup.zip' }`。 |
| `restoreBackup(zipBuffer)` | 解析 manifest → 校验 → 建 app → 解压 → 还原 env；任一步失败回滚。返回新 app。 |

### `restoreBackup` 流程（先校验，再建，失败回滚）

```
1. adm-zip 打开 buffer；取 microverse-manifest.json entry → JSON.parse
   - 缺 manifest / 解析失败 → throw 'Invalid backup file: missing or corrupt manifest'
2. 校验：
   - name 匹配 /^[a-zA-Z0-9-_]+$/，否则 throw 'Invalid app name in backup'
   - deploy_type ∈ {npm, http-server, nginx}，否则 throw 'Invalid deploy_type in backup'
   - getAppByName(name) 已存在 → throw "App '<name>' already exists; rename or delete it first"
3. AppManager.createApp(name, deploy_type) → 新 app 行 + 空目录
4. 解压：整个 zip 解到临时目录（zip-slip 防护：每条 entry 必须落在临时根内，复用上传路由范式）
5. 把临时目录的 files/* 移进 app.path；删临时目录
6. manifest.env 非空 → AppManager.setAppEnv(newId, env)
7. 返回新 app（status=stopped，createApp 默认）
```
**回滚**：步骤 4–6 任一抛错 → `deleteApp(newId)` + `fs.rmSync(app.path, {recursive:true})` + 清临时目录，再向上抛（路由映射成 400/500）。不留孤儿。

## 端点（都自动在 requireAuth 后 = admin only）

### `GET /api/apps/:id/backup`
解析 app（404）→ `BackupManager.createBackup(app)` →
```js
res.set({
  'Content-Type': 'application/zip',
  'Content-Disposition': `attachment; filename="${name}-backup.zip"`
});
res.send(buffer);
```

### `POST /api/apps/restore`
单文件 multipart（字段名 `file`），**memoryStorage**（zip 进 `req.file.buffer`）→ `BackupManager.restoreBackup(req.file.buffer)` → 201 返回新 app。路由 `try/catch` 把 BackupManager 的校验错误映射成 400（`Invalid backup` / `already exists` / `Invalid app name` / `Invalid deploy_type`），其余 500。

> 复用 adm-zip（已在依赖）+ 上传路由的 zip-slip 范式。memoryStorage 不落临时上传文件；解压临时目录在 restoreBackup 内自管。

## 前端

### Backup 下载（AppRow 按钮）
- AppRow 加 "Backup" 按钮。点击 → 临时 `<a href={backupAppUrl(id)} download>` 程序化点击触发下载。同源 → session cookie 自动带上。
- `api/apps.js` 加 `backupAppUrl(id)` → `/api/apps/<id>/backup`（镜像 `appLogsStreamUrl` 的 URL-only 模式）。
- 错误（罕见，app 不存在/读失败）降级成浏览器 JSON，v1 可接受。

### Restore（Dashboard 入口）
- Dashboard topbar `right` 加 "Restore" 按钮（挨着 "+ New app"）。
- 点击 → 隐藏 `<input type="file" accept=".zip">` → 选文件 → `restoreApp(file)`（FormData，字段名 `file`）→ 成功 `message.success` + 重新加载列表；失败（400 冲突/非法）`message.error` 显示后端消息。
- `api/apps.js` 加 `restoreApp(file)` → POST `/apps/restore`，返回新 app。

### i18n（zh/en）
- `appCard.backup`（按钮）、`dashboard.restore`（按钮）、`messages.backupDone`、`messages.restoreDone`、`messages.restoreFailed`。

## 错误处理

| 场景 | 后端 | 前端 |
|---|---|---|
| 备份：app 不存在 | 404 | 浏览器 JSON（罕见） |
| 备份：目录读/zip 失败 | 500 | 浏览器 JSON（罕见） |
| 恢复：非法 zip / 缺 manifest / 非法 name\|deploy_type | 400（明确消息） | `message.error` |
| 恢复：同名冲突 | 400 "App 'X' already exists..." | `message.error` |
| 恢复：解压/env 失败 | 回滚 + 500 | `message.error` |

所有端点在 `requireAuth` 后（admin only）。

## 测试

本特性**不引入测试框架**。手动测试矩阵：

```
1. http-server app + index.html + 资源 → Backup → 下载 <name>-backup.zip
2. 解压检查：microverse-manifest.json（name/deploy_type/env）+ files/index.html
3. 删除该 app → Restore 同一 zip → app 重新出现（stopped），文件 + env 还原
4. 冲突：同名时 restore → 400
5. 非法：传非 zip / 无 manifest 的 zip → 400
6. 空 app 备份 → 仅 manifest 的 zip → 恢复 → 空 app
```
**自然可测单元**（待测试框架）：manifest 解析/校验、restoreBackup 的回滚路径。

## 已知限制 / 范围外

1. 备份 + 恢复均把 zip 放内存（受 app 体积约束 ≤~100MB；单管理员、低频）。
2. 仅 per-app（无整系统备份）。
3. port/status 不保留（实例相关；恢复后 stopped，首次 start 重定端口）。
4. 备份下载错误降级成浏览器 JSON（罕见；v1 不做 toast）。
5. 恢复不自动启动（stopped）。

## 改动面 checklist（实现时用）

**后端**
- NEW `server/src/services/backup-manager.js`
- `server/src/routes/index.js` — `GET /apps/:id/backup` + `POST /apps/restore`（memoryStorage 单文件 multer，字段名 `file`）
- `server/src/docs/openapi.yaml` — 两个端点

**前端**
- `client/src/api/apps.js` — `backupAppUrl(id)`、`restoreApp(file)`
- `client/src/components/AppRow.jsx` — Backup 按钮 + 下载
- `client/src/pages/Dashboard.jsx` — Restore 按钮 + 隐藏 file input
- `client/src/i18n/locales/{zh,en}.json` — 新键

**文档**
- `PROGRESS.md` — Phase 15 勾选备份/恢复；顺手把 Phase 14 多用户项改"不做"（前一特性推迟的 doc 债）
- `README.md` — 提一句备份/恢复
