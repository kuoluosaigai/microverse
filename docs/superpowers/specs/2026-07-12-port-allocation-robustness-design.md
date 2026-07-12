# 端口分配健壮性（双栈探测 + DB 感知）设计

**日期**: 2026-07-12
**状态**: 已确认，待写实现计划
**相关**: Phase 11 验收时发现（`logtest` 僵尸与 npm 应用同占 3000）

## 背景与问题

Phase 11 端到端实测时发现：遗留的 `logtest`（http-server）PM2 进程仍占着 3000，而新启动的 npm 应用也被分配到 3000，两者"同时持有"同一端口，`localhost` 在 IPv4/IPv6 间解析不同会命中不同应用，行为不确定。

根因有两处（均在 `server/src/services/process-manager.js`）：

1. **单栈探测**：`isPortAvailable(port)` 调用 `server.listen(port)` 时**未指定 host**，在 Windows 上默认只绑 IPv6（`::`）。于是 IPv4 侧的监听器（如 http-server 绑的 `0.0.0.0:3000`）不会与之冲突 → 误判为空闲。

2. **不感知 DB**：`findAvailablePort(min, max)` 从不查询数据库，不知道某端口已被另一个 app 的 `app.port` 占用。若该 app 的 PM2 进程恰好不在监听（僵尸 / 已死），探测会放行，把同一端口分给新 app。

## 目标（本轮范围 — 仅"新分配时防冲突"）

让 `findAvailablePort` 返回的端口满足：

- **(G1) 不在任何 app 的 `app.port` 集合内**（DB 感知）。
- **(G2) IPv4 与 IPv6 双栈均空闲**（双栈探测）。

满足这两条即杜绝新增的端口冲突。

## 非目标（显式不做，YAGNI）

- 启动前对"本应用已分配端口"的可用性复查 / 自动重分配（PM2 静默 `EADDRINUSE` → 明确 400 那类增强，本轮不做）。
- 僵尸检测对账（DB 标 running 但实际无监听器，如 `logtest`）。
- 清理既有 `logtest` 僵尸（属用户既有数据）。

> 遗留 `logtest` 不受本次改动影响：它仍占 3000，而 3000 在 DB 集合内 → 修复后新 app 会跳过 3000，自然不再冲突。

## 架构与分层

保持现有分层不变（`ProcessManager` 不依赖 DB）：

```
DeployManager.deployApp
   ├── queries.getAllClaimedPorts()          // 新增：DB 层
   └── ProcessManager.findAvailablePort(min, max, { exclude })   // 改签名
            └── isPortAvailable(port)         // 重写：双栈
```

DB 感知由 `DeployManager`（已持有 DB 访问）注入；`ProcessManager` 仍只做 PM2 + 端口探测，无 DB 依赖。

## 接口

### `queries.getAllClaimedPorts()` — 新增（`server/src/db/index.js`）

```js
getAllClaimedPorts: () => dbAll('SELECT port FROM apps WHERE port IS NOT NULL')
```

返回 `Array<{port:number}>`。调用方自行 `.map(r => r.port)`。

### `ProcessManager.isPortAvailable(port)` — 重写（双栈）

`server/src/services/process-manager.js`。空闲 = IPv4 与 IPv6 均可绑定：

- 尝试绑 `0.0.0.0:port`；失败（`EADDRINUSE`）→ IPv4 占用 → 返回 `false`。
- 尝试绑 `::0:port` 且 `ipv6Only: true`（仅测 IPv6 栈，不与 IPv4 串味）；失败 → IPv6 占用 → 返回 `false`。
- 两次均能 `listening` → 各自 `close()` → 返回 `true`。

实现要点：封装一个 `probeBind(host, port, ipv6Only)` 私有 Promise；两次串行 `await`。`ipv6Only` 仅在 host 为 `::` 时传 `true`，`0.0.0.0` 不传。

> 用 `ipv6Only:true` 的原因：让 IPv6 探测只反映 IPv6 栈本身是否被占，而不与 IPv4 探测互相干扰；两次独立测试即可覆盖"任一栈被占"。

### `ProcessManager.findAvailablePort(minPort, maxPort, options = {})` — 改签名

```js
static async findAvailablePort(minPort, maxPort, options = {}) {
  const exclude = new Set(Array.isArray(options.exclude) ? options.exclude : []);
  for (let port = minPort; port <= maxPort; port++) {
    if (exclude.has(port)) continue;
    if (await this.isPortAvailable(port)) return port;
  }
  throw new Error('No available ports in range');
}
```

向后兼容：`options` 可省略（既有 `findAvailablePort(min, max)` 调用不受影响，目前仅 `DeployManager` 一处调用点）。

### `DeployManager.deployApp` — 分配段加 exclude

`server/src/services/deploy-manager.js`，仅端口分配段：

```js
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

其余编排（install/build/resolveEnv/startProcess）不变。

## 行为保证

- 新分配端口满足 G1 + G2。
- "端口粘滞"语义不变：已分配端口在 `if (!app.port)` 短路，不重新分配。
- 全部端口被占满时仍抛 `No available ports in range`（500，由全局处理器）——与本轮范围一致，不改错误码。

## 受影响文件

- `server/src/db/index.js` — 新增 `getAllClaimedPorts`。
- `server/src/services/process-manager.js` — 重写 `isPortAvailable`；`findAvailablePort` 加 `exclude`；抽 `probeBind` 私有方法。
- `server/src/services/deploy-manager.js` — 端口分配段传入 exclude。
- `PROGRESS.md`（+ 可选 `CLAUDE.md`）— 同步一条变更说明。

## 测试（手动，本轮不写自动化测试）

1. **双栈占用**：用两个 `node` 一次性进程分别绑 `0.0.0.0:3100`（IPv4）与 `[::]:3101` 且 `ipv6Only:true`（IPv6），断言 `findAvailablePort(3100, 3110, {exclude:[]})` 跳过两者并返回 3102。
2. **DB 感知**：在 `apps` 表插入两条带 port 的记录（如 3200、3201，status 随意），断言新分配跳过 3200/3201（即便这俩端口实际空闲）。
3. **回归**：起一个 http-server app，确认仍能正常分配端口、启动、`curl`、停止；既有 npm 应用流程不受影响。
4. 复测后清理所有临时 app 与进程。

## 完成判据

- `findAvailablePort` 在 IPv4-only 占用、IPv6-only 占用、DB 已占用三种情况下均不返回该端口。
- 既有 http-server / npm 启停回归通过。
- `PROGRESS.md` 变更日志补一条。
