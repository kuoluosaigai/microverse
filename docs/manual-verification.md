# 手动验证清单

> 四个特性（nginx 部署 / 资源监控 / 管理员认证 / 备份恢复）在开发机上**未做完整 happy-path 验证**的项（那台机器没装 PM2/nginx，前端浏览器流只过了 lint）。已验证的（后端 curl/node-e/lint、负向路径、数据形状）不在此列。
>
> 建立时间：2026-07-13。全部验证完成后可删除本文件。

## 🔧 前置准备（验证前先满足）

- **PM2** 全局装好（平台本身的前置）
- **http-server** 全局（静态站部署用）
- **nginx** 装好 + `NGINX_BIN` 指向它（仅 nginx 特性需要）
- 一个浏览器（auth + 备份恢复的 UI 验证）

---

## 1️⃣ 备份/恢复 — **最优先**（有个 Critical 修复没在浏览器验过）

修复 `c06ffd9` 是按 axios 源码推的、没真点过，**必须浏览器确认**：

- [ ] 浏览器点 **Restore**，选一个备份 zip → **确认能成功恢复**（multipart-boundary Critical 的真实验证；失败会报 "Multipart: Boundary not found"）
- [ ] 浏览器点 **Backup** → 确认 zip 下载下来；解压看 `microverse-manifest.json`（name/deploy_type/env）+ `files/`
- [ ] 完整闭环：备份某 app → 删除 → 用 zip 恢复 → app 回来、文件 + env 都在

## 2️⃣ 管理员认证（需浏览器）

- [ ] 设 `ADMIN_USERNAME`/`ADMIN_PASSWORD` 启动 → 日志见 "Admin user seeded"
- [ ] 浏览器：错密码 → 报错；对密码 → 进 Dashboard + DevTools 见 Set-Cookie
- [ ] 刷新页面 → 会话保持（不用重新登录）
- [ ] 点登出 → 回 `/login`
- [ ] 未登录直接访问 → 自动跳 `/login`；登录页控制台**无红色 401 报错**

## 3️⃣ 资源监控（需 PM2 + 一个运行中的应用）

- [ ] 启动一个 app → 打开 **Metrics 页** → 确认 CPU/内存火花线随时间**真的增长**
- [ ] Dashboard 行内 CPU/内存值出现、每 10s 刷新
- [ ] 停掉一个 app → Metrics 页**停在最后真实样本**（不下穿到 0——online 过滤修复 `0230b44` 的验证）
- [ ] 重启后端 → 历史清空、约 30s 后重新填起来

## 4️⃣ Nginx 部署（需 nginx）

- [ ] 创建 nginx app → 上传 index.html → start → `curl http://localhost:<端口>` → **确认 nginx 真的 serve 出 index.html**
- [ ] （Windows）生成的配置路径是正斜杠——可顺手 `nginx -t -c <生成的 conf>` 确认能通过（修复 `988df71`）

---

**最该先做的**：第 1 项的浏览器 Restore（唯一一个已知"修了但没验过"的 Critical）。其余三项是"功能没在装齐依赖的机器上跑过 happy path"，属常规冒烟。
