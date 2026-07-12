# 端口分配健壮性（双栈探测 + DB 感知）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `findAvailablePort` 返回的端口同时满足"不在任何 app 的 `app.port` 集合内"且"IPv4/IPv6 双栈空闲"，杜绝新增端口冲突。

**Architecture:** `ProcessManager.isPortAvailable` 改为双栈探测（分别绑 `0.0.0.0` 与 `::` `ipv6Only:true`）；`findAvailablePort` 新增 `options.exclude` 跳过已占用端口；新增 `queries.getAllClaimedPorts()`，由 `DeployManager` 在分配前取该集合注入 exclude。DB 感知留在 `DeployManager`，`ProcessManager` 维持无 DB 依赖。

**Tech Stack:** Node.js（`net` 模块）+ Express + sqlite3 + PM2。

## Global Constraints

- 数据库用 `sqlite3`（禁用 `better-sqlite3`）；所有 DB 调用 `await`。
- 路径一律用 Node `path` 模块。
- `ProcessManager` 不得引入 DB 依赖（分层约束）。
- 本轮不写自动化测试（沿用项目惯例，用户自测）；每个任务以手动验证 + commit 收尾。
- 代码与 commit message 用英文；UI 文案 N/A（纯后端）。
- schema 无改动（仅读 `apps.port` 列）。
- 不改既有"端口粘滞"语义（已分配端口的 app 不重新走分配）。
- 遗留 `logtest` 僵尸不动；不在本轮处理启动前复查 / 僵尸对账。

---

## File Structure

**修改**
- `server/src/db/index.js` — `queries` 内新增 `getAllClaimedPorts()`。
- `server/src/services/process-manager.js` — 抽 `probeBind` 私有方法；重写 `isPortAvailable` 为双栈；`findAvailablePort` 加 `options.exclude`。
- `server/src/services/deploy-manager.js` — 端口分配段取 `getAllClaimedPorts()` 注入 exclude。
- `PROGRESS.md` — 变更日志补一条。

---

### Task 1: getAllClaimedPorts 查询

**Files:**
- Modify: `server/src/db/index.js`（`getAllApps` 之后插入）

**Interfaces:**
- Produces: `queries.getAllClaimedPorts(): Promise<Array<{port:number}>>`

- [ ] **Step 1: 在 `getAllApps` 之后插入 `getAllClaimedPorts`**

把 `server/src/db/index.js` 内：
```js
  getAllApps: () => dbAll('SELECT * FROM apps ORDER BY created_at DESC'),

  getAppById: (id) => dbGet('SELECT * FROM apps WHERE id = ?', [id]),
```
改为：
```js
  getAllApps: () => dbAll('SELECT * FROM apps ORDER BY created_at DESC'),

  getAllClaimedPorts: () => dbAll('SELECT port FROM apps WHERE port IS NOT NULL'),

  getAppById: (id) => dbGet('SELECT * FROM apps WHERE id = ?', [id]),
```

- [ ] **Step 2: 手动验证查询返回所有非空 port**

```bash
cd server
node -e "const {queries}=require('./src/db');setTimeout(async()=>{console.log(await queries.getAllClaimedPorts());process.exit(0)},300)"
```
预期：返回当前 DB 中所有 `port` 非空的行（形如 `[ { port: 3000 }, ... ]`，至少含 `logtest` 的 3000）。`setTimeout` 是为等 `initDatabase()` 异步完成。

- [ ] **Step 3: 提交**

```bash
git add server/src/db/index.js
git commit -m "feat(db): add getAllClaimedPorts query"
```

---

### Task 2: ProcessManager 双栈探测 + findAvailablePort exclude

**Files:**
- Modify: `server/src/services/process-manager.js`（替换 `isPortAvailable` + `findAvailablePort`，新增 `probeBind`）

**Interfaces:**
- Consumes: 无
- Produces: `ProcessManager.probeBind(host, port, ipv6Only): Promise<boolean>`（私有）；`ProcessManager.isPortAvailable(port): Promise<boolean>`（双栈）；`ProcessManager.findAvailablePort(min, max, options={}): Promise<number>`（`options.exclude` 跳过）

- [ ] **Step 1: 替换 `isPortAvailable` 与 `findAvailablePort`，并新增 `probeBind`**

把 `server/src/services/process-manager.js` 内（文件末尾两段方法）：
```js
  /**
   * Check if a port is available
   */
  static async isPortAvailable(port) {
    return new Promise((resolve) => {
      const net = require('net');
      const server = net.createServer();

      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          resolve(false);
        } else {
          resolve(false);
        }
      });

      server.once('listening', () => {
        server.close();
        resolve(true);
      });

      server.listen(port);
    });
  }

  /**
   * Find an available port in range
   */
  static async findAvailablePort(minPort, maxPort) {
    for (let port = minPort; port <= maxPort; port++) {
      if (await this.isPortAvailable(port)) {
        return port;
      }
    }
    throw new Error('No available ports in range');
  }
```
替换为：
```js
  /**
   * Probe whether (host, port) can be bound. Resolves true on listen, false on
   * EADDRINUSE or any other bind error (treated as unavailable).
   */
  static probeBind(host, port, ipv6Only = false) {
    return new Promise((resolve) => {
      const net = require('net');
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close();
        resolve(true);
      });
      if (ipv6Only) {
        server.listen({ port, host, ipv6Only: true });
      } else {
        server.listen(port, host);
      }
    });
  }

  /**
   * Check if a port is free on BOTH IPv4 and IPv6. A single-stack listener
   * (e.g. http-server binding 0.0.0.0) is enough to make the port occupied —
   * previously we only probed one stack and missed the other.
   */
  static async isPortAvailable(port) {
    const v4 = await this.probeBind('0.0.0.0', port, false);
    if (!v4) return false;
    return this.probeBind('::', port, true);
  }

  /**
   * Find an available port in range, skipping any port in options.exclude
   * (ports already claimed by other apps). A port is returned only if it is
   * not excluded AND free on both stacks.
   */
  static async findAvailablePort(minPort, maxPort, options = {}) {
    const exclude = new Set(Array.isArray(options.exclude) ? options.exclude : []);
    for (let port = minPort; port <= maxPort; port++) {
      if (exclude.has(port)) continue;
      if (await this.isPortAvailable(port)) {
        return port;
      }
    }
    throw new Error('No available ports in range');
  }
```

- [ ] **Step 2: 手动验证双栈探测 + exclude**

```bash
cd server
node -e "
const net = require('net');
const ProcessManager = require('./src/services/process-manager');
const v4 = net.createServer().listen(3100, '0.0.0.0');
const v6 = net.createServer().listen({ port: 3101, host: '::', ipv6Only: true });
(async () => {
  console.log('v4-held 3100 free?', await ProcessManager.isPortAvailable(3100), '(expect false)');
  console.log('v6-held 3101 free?', await ProcessManager.isPortAvailable(3101), '(expect false)');
  console.log('free 3102 free?', await ProcessManager.isPortAvailable(3102), '(expect true)');
  console.log('find(3100,3110):', await ProcessManager.findAvailablePort(3100, 3110, {exclude:[]}), '(expect 3102)');
  console.log('find exclude 3102:', await ProcessManager.findAvailablePort(3100, 3110, {exclude:[3102]}), '(expect 3103)');
  v4.close(); v6.close(); process.exit(0);
})();
"
```
预期输出：
```
v4-held 3100 free? false (expect false)
v6-held 3101 free? false (expect false)
free 3102 free? true (expect true)
find(3100,3110): 3102 (expect 3102)
find exclude 3102: 3103 (expect 3103)
```
若 3102/3103 恰被本机其它进程占用，换用其它空闲端口复测即可；关键是"v4-held/v6-held 均 false、exclude 生效"。

- [ ] **Step 3: 提交**

```bash
git add server/src/services/process-manager.js
git commit -m "fix(pm2): dual-stack port probe + findAvailablePort honors exclude set"
```

---

### Task 3: DeployManager 接入 exclude + 端到端回归

**Files:**
- Modify: `server/src/services/deploy-manager.js`（`deployApp` 端口分配段）

**Interfaces:**
- Consumes: `queries.getAllClaimedPorts()`（Task 1）；`ProcessManager.findAvailablePort(min, max, {exclude})`（Task 2）

- [ ] **Step 1: 端口分配段取 claimed 集合并注入 exclude**

把 `server/src/services/deploy-manager.js` 内：
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
```
改为：
```js
    // Assign port if needed — both http-server and npm get a platform port.
    // npm apps receive it via the PORT env var (resolved below). Exclude ports
    // already claimed by other apps so two apps never share a port.
    if (!app.port) {
      const claimed = (await queries.getAllClaimedPorts()).map(r => r.port);
      const port = await ProcessManager.findAvailablePort(
        config.deployment.portRangeMin,
        config.deployment.portRangeMax,
        { exclude: claimed }
      );
      await AppManager.updateApp(appId, { port });
      app.port = port;
    }
```

- [ ] **Step 2: 手动验证端到端（DB 感知 + http-server 回归）**

起后端（如已在跑且为最新代码，跳过；否则）：
```bash
cd server && npm run dev   # 后台或另开终端
# 健康检查
curl -s http://localhost:5000/api/health
```

创建并启动两个 http-server app，确认拿到**不同**端口、且都不等于 logtest 的 3000：
```bash
curl -s -X POST http://localhost:5000/api/apps -H 'Content-Type: application/json' -d '{"name":"port-a","deploy_type":"http-server"}' >/dev/null
curl -s -X POST http://localhost:5000/api/apps -H 'Content-Type: application/json' -d '{"name":"port-b","deploy_type":"http-server"}' >/dev/null
mkdir -p ../apps/port-a ../apps/port-b
echo '<h1>A</h1>' > ../apps/port-a/index.html
echo '<h1>B</h1>' > ../apps/port-b/index.html

# 取两个 id
AID=$(node -e "const s=require('sqlite3').verbose();const db=new s.Database('../data/microverse.sqlite');db.get('SELECT id FROM apps WHERE name=\"port-a\"',(_,r)=>{console.log(r.id);db.close()})")
BID=$(node -e "const s=require('sqlite3').verbose();const db=new s.Database('../data/microverse.sqlite');db.get('SELECT id FROM apps WHERE name=\"port-b\"',(_,r)=>{console.log(r.id);db.close()})")

PA=$(curl -s -X POST http://localhost:5000/api/apps/$AID/start | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).data.port))")
PB=$(curl -s -X POST http://localhost:5000/api/apps/$BID/start | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).data.port))")
echo "port-a=$PA port-b=$PB"
echo "curl A:"; curl -s http://localhost:$PA
echo "curl B:"; curl -s http://localhost:$PB
```
预期：`PA != PB`；两者都 `!= 3000`；`curl` 分别返回 `<h1>A</h1>` 与 `<h1>B</h1>`；`pm2 list` 中 port-a、port-b 均 online。

再验证 DB 感知（B 必须跳过 A 已占用的端口——已被上一步隐式覆盖：两 app 拿到不同端口）。直接核对：
```bash
node -e "const s=require('sqlite3').verbose();const db=new s.Database('../data/microverse.sqlite');db.all('SELECT name,port FROM apps WHERE port IS NOT NULL ORDER BY port',(_,r)=>{console.log(r);db.close()})"
```
预期所有 app 的 port 两两不同（含 logtest 的 3000）。

- [ ] **Step 3: 清理本任务测试 app**

```bash
curl -s -X POST http://localhost:5000/api/apps/$AID/stop >/dev/null
curl -s -X POST http://localhost:5000/api/apps/$BID/stop >/dev/null
curl -s -X DELETE http://localhost:5000/api/apps/$AID >/dev/null
curl -s -X DELETE http://localhost:5000/api/apps/$BID >/dev/null
rm -rf ../apps/port-a ../apps/port-b
npx pm2 list   # 确认 port-a/port-b 已不在
```

- [ ] **Step 4: 提交**

```bash
git add server/src/services/deploy-manager.js
git commit -m "feat(deploy): exclude DB-claimed ports when assigning app port"
```

---

### Task 4: 文档同步

**Files:**
- Modify: `PROGRESS.md`

- [ ] **Step 1: PROGRESS.md 变更日志补一条**

在 `### [Unreleased] — 2026-07-12` 段（Phase 11 那段）的 `#### 补登` 之前，插入一个 `#### 修复` 小节：

```markdown
#### 修复
- 端口分配健壮性：`isPortAvailable` 改为 IPv4/IPv6 双栈探测（修复 Windows 下只探 IPv6、漏判 IPv4 占用导致的同端口并存）；`findAvailablePort` 新增 `exclude`，由 `DeployManager` 传入 DB 已占用端口集合（`getAllClaimedPorts`），杜绝把一个 app 的端口分给另一个 app。
```

- [ ] **Step 2: 手动验证文档无残留过期描述**

通读改动，确认未引入与现有"端口粘滞"描述冲突的措辞。

- [ ] **Step 3: 提交**

```bash
git add PROGRESS.md
git commit -m "docs: changelog — dual-stack port probe + DB-aware allocation"
```

---

## 完成判据（Definition of Done）

- `isPortAvailable(port)` 在 IPv4-only 占用、IPv6-only 占用两种情况下均返回 `false`（双栈空闲才 `true`）。
- `findAvailablePort(min, max, {exclude})` 跳过 `exclude` 集合与任一栈被占的端口；全占满时抛 `No available ports in range`。
- `DeployManager` 分配端口时注入 DB 已占用集合；两个 app 不会被分到同一端口，也不会分到 `logtest` 的 3000。
- 既有 http-server / npm 启停回归通过。
- `PROGRESS.md` 变更日志补一条，无过期描述。
