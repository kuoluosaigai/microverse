# 本体自更新 — 真机演练清单

目的：把 `docs/manual-verification.md` 里 "Platform self-update" 那 6 条空复选框，在一台真的
Ubuntu + PM2 cluster 机器上验掉，并且**验的是失败路径**（回滚），不只是 happy path。

自更新的执行体是 8 步（`server/src/services/self-updater.js`）：
`preflight → fetch → backup → pull → install → build → reload → health`，失败则回滚代码 + `dist` 并二次 reload。
它**只在 Linux 上可执行**（`update-manager.js:277` 显式拒绝 win32），所以这份清单必须在服务器上跑。

> 约定：`REPO` = 仓库根目录（如 `/home/ubuntu/microverse`），`NAME` = `PM2_INSTANCE_NAME`（默认 `microverse-server`）。

---

## 阶段 0：只读前提检查

全部通过才继续；任何一条不过，先修环境，**不要点更新按钮**。

```bash
cd "$REPO"
git rev-parse --is-shallow-repository          # 必须是 false，shallow 会被 preflight 拒绝
git status --porcelain --untracked-files=no    # 必须为空（只有已跟踪文件的改动算脏；data/ apps/ .env 未跟踪不影响）
git remote get-url origin                       # 确认是 HTTPS+GCM 还是 SSH，pull 得通
pm2 list | grep microverse-server               # 必须是 online，且名字与 PM2_INSTANCE_NAME 一致
grep -E "^SELF_UPDATE|^PM2_INSTANCE|^PORT" .env
ls -la data/                                     # 可写；已存在 update-state.json/update.lock 的话先看内容
```

观察点先开两个终端，整场演练都盯着：

```bash
tail -f "$REPO/data/update.log"
watch -n1 "cat $REPO/data/update-state.json 2>/dev/null; echo; pm2 list | grep -E 'microverse|app'"
```

**先确认没有应用正在部署**：目前（本清单撰写时）部署仍是同步请求，平台 reload 会把在跑的
`npm install` 打断。等所有应用状态稳定再开始。

> 演练会真的替换服务器上的代码。失败注入用**测试分支**，绝不推给 `main`。
> `SELF_UPDATE_REF` 指到测试分支即可，验完改回 `main`。

---

## 阶段 1：flag 关闭时的表现（对应清单第 6 条）

`.env` 里 `SELF_UPDATE_ENABLED=false`（或没有这一行），`pm2 reload "$NAME"` 后打开管理页：

- [ ] 顶栏 badge 显示版本号 + 短 sha，形如 `v1.0.0 · a1b2c3d`
- [ ] badge 上**没有**可点的更新入口
- [ ] `GET /api/system/version` 的响应里 `reason` = `自更新未开启 (SELF_UPDATE_ENABLED)`

```bash
curl -s -b "connect.sid=<你的会话cookie>" localhost:5000/api/system/version | head -c 600
```

---

## 阶段 2：开启 + 制造一个"可更新"状态

```bash
# .env
SELF_UPDATE_ENABLED=true
SELF_UPDATE_REF=main            # 本阶段用 main：只验"检测到新版本"和 badge 变化
pm2 reload "$NAME"
```

远端造一个无害的、可 ff 的新提交（只动文档，避免影响运行时）：

```bash
cd "$REPO" && git pull --ff-only         # 确保本地与 origin/main 同步
# 在另一台机器/或本仓库临时分支上提交一个 docs 改动并推到 main：
echo "- rehearsal $(date -Is)" >> README.md && git commit -aqm "chore: self-update rehearsal commit" && git push origin HEAD:main
```

- [ ] 刷新页面 → badge 出现"有新版本"
- [ ] `GET /api/system/version` 里 `updateAvailable=true`，`fromSha`/`toSha` 是两个不同的 sha
- [ ] 版本检查有 10 分钟缓存：刚 push 时若没立刻出现，等缓存过期或重启 worker 再看（**这是预期行为，不是 bug**）

---

## 阶段 3：happy path 真更新一次（清单第 1、2 条）

页面上点更新，全程盯 `update-state.json` 与 `update.log`：

- [ ] `status` 立刻变 `running`，`step` 依次推进：`preflight → fetch → backup → pull → install → build → reload → health → cleanup`
- [ ] `data/backups/<时间戳>.sqlite` 出现（SQLite `VACUUM INTO` 的一致性快照）
- [ ] 构建期间 `client/dist` **原地不动**，产物先进 `client/dist.next`，成功后才换名
      （构建时另开一个终端 `ls -la client/` 能看到 `dist.next` 存在而 `dist` 仍是旧内容）
- [ ] 页面 reload 后进入新版本：badge 的 sha 变成了阶段 2 push 的那个 sha
- [ ] `GET /api/system/version` 的 `current.sha == toSha`，`updateAvailable` 回到 false
- [ ] `data/update.lock` 已删除；`update-state.json` 的 `status` 是 `success`
- [ ] `pm2 list` 只有 `NAME` 被 reload（uptime 归零），部署中的应用进程**没有**被重启
- [ ] `data/` 与 `apps/` 内容完好（它们不被 git 跟踪，本就不该被动过）：`ls apps/ && sqlite3 data/microverse.sqlite 'select count(*) from apps;'`

顺手验清单第 4 条：**更新期间已部署应用保持可访问** —— 更新过程中在另一个终端
`curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:<应用端口>/` 持续应 200。

---

## 阶段 4：注入 build 失败，验回滚（清单第 3 条）

用测试分支注入，`main` 不动：

```bash
git checkout -b rehearsal/broken-build
# 让 client 的构建脚本必失败（跨平台，不依赖 shell 特性）
node -e 'const p="client/package.json";const j=require("./"+p);j.scripts.build="node -e \\"process.exit(1)\\"";require("fs").writeFileSync(p,JSON.stringify(j,null,2)+"\n")'
git commit -aqm "rehearsal: break client build" && git push -u origin rehearsal/broken-build
```

`.env` 改 `SELF_UPDATE_REF=rehearsal/broken-build`，`pm2 reload "$NAME"`，记录当前 sha：

```bash
git rev-parse HEAD; sha1sum client/dist/index.html   # 记下"更新前"的代码 sha 与 dist 指纹
```

页面点更新，然后核对：

- [ ] 步骤停在 `build` 并失败；`update.log` 里有 npm 的真实报错尾巴
- [ ] 状态最终是 `rolled_back`（不是 success，也不是长期 `running`）
- [ ] `git rev-parse HEAD` **回到更新前的 sha**（代码 reset 成功）
- [ ] `sha1sum client/dist/index.html` 与更新前一致，且 `client/dist.next`/`client/dist.prev` 已被清理
- [ ] 平台仍然可用：`curl -s localhost:5000/api/health` 返回 200，管理页能打开、版本没变
- [ ] `data/update.lock` 已释放，可以再点一次更新（不必重启平台）

**这一步是唯一没把库退回的地方**（设计如此：只备份不自动恢复库）。确认 `data/backups/` 里那份
`.sqlite` 存在且能读：`sqlite3 data/backups/<stamp>.sqlite 'select count(*) from apps;'`。

---

## 阶段 5：注入 health 失败，验二次 reload 回滚（清单第 4 条）

比 build 失败更危险：代码已经拉下来、已经 reload 过、平台**正在跑新代码**，只是健康检查不过。

```bash
git checkout rehearsal/broken-build && git checkout -b rehearsal/broken-health
# 把 /api/health 改成 503（健康检查只认 200，见 self-updater.js:104 httpGetStatus）
# 编辑 server/src/routes/system.js 让 health 返回 res.status(503)...
git commit -aqm "rehearsal: break health endpoint" && git push -u origin rehearsal/broken-health
```

`.env` 指向 `rehearsal/broken-health`，reload 平台，点更新，核对：

- [ ] 步骤走到 `reload` 成功、`health` 失败（健康轮询窗口 60s、每 1s 一次 —— **这 60s 里平台是真 503**，
      只在测试机上做）
- [ ] 回滚做了**两次 reload**（回滚代码后再 reload 回到旧版本），最终 `status=rolled_back`
- [ ] `git rev-parse HEAD` 回到更新前 sha；`curl -s localhost:5000/api/health` 重新 200
- [ ] 管理页恢复可用，版本显示回旧 sha
- [ ] 若回滚后健康仍不过：状态应是 `failed` 并明确写"需人工介入"，而不是 success ——
      这条只在你想连它一起验时做（把 `.env` 的 `PORT` 改成一个没监听的端口再走一遍）

清理测试分支并把 ref 改回：

```bash
git checkout main && git pull --ff-only
git push origin --delete rehearsal/broken-build rehearsal/broken-health
git branch -D rehearsal/broken-build rehearsal/broken-health
sed -i 's/^SELF_UPDATE_REF=.*/SELF_UPDATE_REF=main/' .env && pm2 reload "$NAME"
```

---

## 阶段 6：中断修复路径（设计里有、清单里没验过的一条）

演练中难免留一个 `running` 状态在盘上，值得顺手确认"可修复"不是纸面承诺：

- [ ] 更新途中 `kill -9` 掉 helper 进程（`update-state.json` 里的 `pid`）→ 刷新页面后
      `GET /api/system/version` 报 `incomplete`（带当时停在的 `step`），而不是永远"更新中"
- [ ] 按同一 sha 再点一次更新能跑通（preflight 允许"被中断的同 sha 修复重跑"）
- [ ] 若代码停在半更新态：手动 `git status` 干净化后（`git checkout -- .`，**不要** `git clean -fdx`，
      会连 `data/` 里未跟踪的东西一起删）再点更新

---

## 逃生舱（演练搞砸时）

```bash
cd "$REPO"
cat data/update-state.json                       # 看它自认为停在哪一步、pid 是谁
pm2 list                                          # 平台是否 online
git reset --hard <fromSha>                        # fromSha 见 state JSON
rm -f data/update.lock                            # 只在确认没有 helper 进程存活时删
rm -rf client/dist && cp -a client/dist.prev client/dist 2>/dev/null || npm --prefix client run build
pm2 reload "$NAME"
```

数据库回滚（只有确认代码回滚后库版本不匹配时才做；additive schema 下通常不需要）：

```bash
pm2 stop "$NAME" && cp data/microverse.sqlite data/microverse.sqlite.broken && \
  cp data/backups/<stamp>.sqlite data/microverse.sqlite && pm2 start "$NAME"
```

---

## 演练结束后

1. 把 `docs/manual-verification.md` 的 6 个复选框按实际结果勾掉/注明（哪条验不过，写清现象）。
2. 任何一条与代码预期不符的，记在这里并回报，不要静默修改代码去"凑过"。
3. `SELF_UPDATE_ENABLED` 是否常开，由你定：常开的代价是页面上一颗能改服务器的按钮。
