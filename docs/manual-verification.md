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

## Platform self-update

- [ ] `SELF_UPDATE_ENABLED=true` + PM2 online → badge shows `v1.0.0 · <sha>`; remote ahead → “有新版本”。
- [ ] Click update → steps advance, log streams; page reloads into the new version.
- [ ] Inject a build failure → state `rolled_back`, old version still served, `client/dist` intact.
- [ ] Inject a health failure → state `rolled_back`, old version served after the second reload.
- [ ] During an update, a deployed app stays Live.
- [ ] `SELF_UPDATE_ENABLED=false` → badge shows version, no update button.

## 异步部署任务（Task 11 客户端：进度 / 禁用 / 日志抽屉）

> ⚠️ 以下每一项都是 **`[ ]` UNVERIFIED**：Task 11 只有 lint + build 两个机械信号通过，
> **没有任何一条经过真人点击 / 浏览器执行**（2026-11-20 实现时记录）。验证时逐条勾掉。

准备：`npm run dev`，浏览器开 Dashboard。用一个 npm 应用（install/build 慢，最能看清进度）。

- [ ] **提交即有反馈**：点 Start → toast 是「部署任务已开始…」而不是「启动成功」→ 行内状态列立刻变为
      `● 部署中 · <步骤文案>`，按钮文字随 step 前进（排队中 → 安装依赖 → 构建 → 启动进程 → 完成）。
- [ ] **禁用而非隐藏**：部署期间该行的 启动/停止/上传/环境变量/Git/删除/根域名开关 全部**置灰但位置保留**，
      列宽与停止态一致；查看目录/日志/监控/备份 仍可用（读操作不禁）。
- [ ] **刷新页面仍是"部署中"**：npm install 期间按 F5 → 重新登录后该行仍显示 `● 部署中`（状态来自服务端
      `deploy.live`，不是本地变量）。
- [ ] **失败行内可见**：制造一次失败（如 package.json 写一个会非零退出的 start 脚本）→ 行内出现
      `✖ <message>`，旁边有「看日志」→ 点击打开抽屉，`<pre>` 里能看到 npm 的真实输出（不是只有一行摘要）。
- [ ] **抽屉轮询开关**：部署中打开抽屉 → DevTools Network 每 ~2s 一次 `GET /api/apps/:id/deploy`；
      **任务结束（终态）后轮询自动停止**；任务进行中途直接关闭抽屉 → 轮询立即停止（Network 不再增长）。
- [ ] **成功收敛**：任务成功后的下一次 ≤10s 静默刷新里，`● 部署中` 徽章消失，行回到 `运行中`。
      终态摘要的 3 分钟时限**只作用于失败行**：失败行 3 分钟后 ✖ 摘要不再显示（等下一次刷新渲染时生效）。
- [ ] **GitModal Pull 不再谎报**（真 bug 的回归项）：绑定 Git 的应用点 Pull → **不再有立即弹出的
      "更新已拉取"**；按钮保持"拉取中…"并出现 step 行，直到服务端任务真的结束才报成功/失败，
      之后 git 摘要（deployedCommit/last_status）刷新一次。
- [ ] **GitModal 关闭清 timer**：Pull 进行中关闭 Git 对话框 → Network 里不再有 `/deploy` 轮询；
      重新打开对话框 → 若任务仍在跑会恢复轮询并再次收敛（webhook 触发的同步在跑时也会恢复观察）。
- [ ] **409 文案透传**：部署进行中在**另一个标签页**对同一应用点任何写操作（如停止）→ toast 显示的是
      服务端原句 `部署进行中（…），请等待完成后再…`，前端没有自己拼句子。
- [ ] **无 per-row 轮询**：Dashboard 页面 Network 时间线里，列表请求仍是 ~10s 一次（行进度靠既有的
      静默刷新），没有每行 2s 的请求风暴；只有打开着的日志抽屉有 2s 轮询。
- [ ] **非部署路径回归**：静态(http-server)应用启动、停止、重启、上传、备份、恢复、默认域名切换等
      一切与改动前行为一致（deploy 摘要为 null 时行渲染不变）。
