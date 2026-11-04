# Platform Self-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin check for and apply a platform update from the web UI, with a detached updater, health check, and automatic rollback.

**Architecture:** A protected read-only endpoint compares local git HEAD with `git ls-remote`. `POST /api/system/update` runs cheap preflight checks, writes `data/update-state.json`, and spawns `scripts/self-update.js` detached. The helper performs fetch → DB backup → ff-only pull → `npm install --include=dev` → staged client build → `pm2 reload` → health check, and rolls the code back on failure. The UI polls a status endpoint for progress.

**Tech Stack:** Node.js (CommonJS, `node:test` + `supertest`), Express, PM2 cluster, React + Ant Design, Vite.

**Spec:** `docs/superpowers/specs/2026-11-04-self-update-design.md`

## Global Constraints

- No new npm dependencies. Use `node:child_process`, `node:http`, `node:test`, and the existing `sqlite3` package.
- Every external command uses `execFile` with an argument array — never shell-string interpolation of computed values.
- All filesystem paths use `path.join`; never concatenate separators.
- API responses use `{ success: true, data }` / `{ success: false, error: { message } }`.
- `SELF_UPDATE_ENABLED` defaults to `false`. The update action is disabled on Windows and unless `PM2_INSTANCE_NAME` is `online` in `pm2 jlist`.
- The live `client/dist` directory MUST NOT be moved during install/build. Only swap it after `vite build` has fully produced `client/dist.next`.
- `npm install` always passes `--include=dev --no-audit --no-fund` (the platform runs with `NODE_ENV=production`).
- Runtime artifacts (`data/update-state.json`, `data/update-check.json`, `data/update.lock`, `data/backups/`, `client/dist.next/`, `client/dist.prev/`) stay untracked.
- Update state values are exactly: `idle | running | success | failed | rolled_back`.

## Review Focus

1. **Two updates at once / a crashed helper** — the second `POST` must return 409, and a dead helper's lock must go stale after 2 hours instead of wedging updates forever. Covered by Task 2 (`isLockStale`), Task 3 (409 route test), Task 5 (dead-PID lock test).
2. **Shallow clones and local commits** — `merge-base --is-ancestor` cannot work without history/objects; the helper must refuse instead of fast-forwarding into a broken state. Covered by Task 2 (shallow preflight) and Task 4 (ancestry failure).
3. **Untracked update artifacts read as a dirty tree** — `git status --porcelain` lists `?? data/update-state.json`; cleanup and preflight must use `--untracked-files=no`. Covered by Task 5.
4. **PM2 reload window** — during a cluster reload, `/api/health` may briefly refuse connections; the health poll must retry until its deadline instead of rolling back on the first error. Covered by Task 5 (`pollHealth`).
5. **Interrupted dist swap** — a killed helper can leave `dist.next`/`dist.prev` behind; the next run must clean them and the server must keep serving the existing `dist`. Covered by Task 4 (backup stale-cleanup + swap test).

---

### Task 1: Config and update-state primitives

**Files:**
- Modify: `server/src/config/index.js` (after the `pm2` block, around line 93)
- Create: `server/src/services/update-manager.js`
- Test: `server/src/test/unit/update-state.test.js`

**Interfaces:**
- Produces:
  - `config.selfUpdate = { enabled: boolean, ref: string, remote: string }`
  - `UpdateManager.getPaths(repoRoot?) -> { repoRoot, statePath, lockPath, checkPath, logPath, backupsDir }`
  - `UpdateManager.parseRemoteSha(stdout: string) -> string|null`
  - `UpdateManager.computeUpdateAvailable(current, latest) -> boolean`
  - `UpdateManager.isLockStale(lock, nowMs, isPidAlive) -> boolean`
  - `UpdateManager.readState(statePath) -> object|null`
  - `UpdateManager.writeState(statePath, state) -> void` (atomic tmp+rename)
  - `UpdateManager.readLogTail(logPath, { maxLines?, maxBytes? }) -> string[]`

- [ ] **Step 1: Write the failing tests**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const UpdateManager = require('../../services/update-manager');

function tmpPaths() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-update-'));
  return UpdateManager.getPaths(repoRoot);
}

test('parseRemoteSha returns the sha from an ls-remote line', () => {
  assert.equal(UpdateManager.parseRemoteSha('abc1234\trefs/heads/main\n'), 'abc1234');
  assert.equal(UpdateManager.parseRemoteSha('abc1234\trefs/heads/main'), 'abc1234');
  assert.equal(UpdateManager.parseRemoteSha(''), null);
  assert.equal(UpdateManager.parseRemoteSha('nope refs/heads/main'), null);
});

test('computeUpdateAvailable ignores dirty trees and missing data', () => {
  const current = { sha: 'aaa', dirty: false };
  assert.equal(UpdateManager.computeUpdateAvailable(current, { sha: 'bbb' }), true);
  assert.equal(UpdateManager.computeUpdateAvailable(current, { sha: 'aaa' }), false);
  assert.equal(UpdateManager.computeUpdateAvailable({ sha: 'aaa', dirty: true }, { sha: 'bbb' }), false);
  assert.equal(UpdateManager.computeUpdateAvailable(null, { sha: 'bbb' }), false);
  assert.equal(UpdateManager.computeUpdateAvailable(current, null), false);
});

test('isLockStale treats missing, dead, old, and malformed locks as stale', () => {
  const now = Date.parse('2026-11-05T00:00:00Z');
  const alive = () => true;
  const dead = () => false;
  assert.equal(UpdateManager.isLockStale(null, now, alive), true);
  assert.equal(UpdateManager.isLockStale({ pid: 1, startedAt: '2026-11-05T00:00:00Z' }, now, dead), true);
  assert.equal(UpdateManager.isLockStale({ pid: 1, startedAt: '2026-11-05T00:00:00Z' }, now, alive), false);
  assert.equal(UpdateManager.isLockStale(
    { pid: 1, startedAt: '2026-11-04T21:00:00Z' }, now, alive), true);
  assert.equal(UpdateManager.isLockStale({ pid: 1 }, now, alive), true);
});

test('writeState is atomic and readState tolerates missing/corrupt files', () => {
  const paths = tmpPaths();
  UpdateManager.writeState(paths.statePath, { status: 'running', step: 'queued' });
  assert.deepEqual(UpdateManager.readState(paths.statePath), { status: 'running', step: 'queued' });
  assert.equal(fs.existsSync(paths.statePath + '.tmp'), false);
  fs.writeFileSync(paths.statePath, '{not json');
  assert.equal(UpdateManager.readState(paths.statePath), null);
  assert.equal(UpdateManager.readState(path.join(paths.repoRoot, 'missing.json')), null);
});

test('readLogTail caps lines and bytes', () => {
  const paths = tmpPaths();
  fs.writeFileSync(paths.logPath, Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n'));
  const tail = UpdateManager.readLogTail(paths.logPath);
  assert.equal(tail.length, 200);
  assert.equal(tail[0], 'line 100');
  assert.equal(tail[199], 'line 299');

  fs.writeFileSync(paths.logPath, ('x'.repeat(100) + '\n').repeat(2000));
  const longTail = UpdateManager.readLogTail(paths.logPath);
  assert.equal(longTail.length, 200);
  assert.ok(longTail.join('\n').length <= 64 * 1024);
  assert.deepEqual(UpdateManager.readLogTail(path.join(paths.repoRoot, 'nope.log')), []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test src/test/unit/update-state.test.js`
Expected: FAIL with `Cannot find module '../../services/update-manager'`.

- [ ] **Step 3: Implement the config block and `update-manager.js` primitives**

In `server/src/config/index.js`, add after the `pm2` object:

```js
selfUpdate: {
  enabled: process.env.SELF_UPDATE_ENABLED === 'true',
  ref: process.env.SELF_UPDATE_REF || 'main',
  remote: process.env.SELF_UPDATE_REMOTE || 'origin'
},
```

In `server/src/services/update-manager.js`, export a class with the seven static methods above.
Implementation notes (choose these exact behaviors):
- `getPaths(repoRoot = require('../utils/path-helper').getProjectRoot())` returns absolute paths under `<repoRoot>/data/`; `backupsDir` is `<repoRoot>/data/backups`.
- `readState` returns `null` for missing files or `JSON.parse` errors.
- `writeState` writes `statePath + '.tmp'` with `JSON.stringify(state, null, 2)` then `fs.renameSync`; create the parent directory first.
- `readLogTail` reads at most the last `maxBytes` (default `65536`) of the file, splits on `\n`, drops a possibly-truncated first line when the file was truncated, and returns the last `maxLines` (default `200`) non-empty lines.
- `isLockStale` returns true when the lock is null, has no numeric `pid`, `isPidAlive(pid)` is false, `startedAt` is absent/unparseable, or `nowMs - Date.parse(startedAt) > 2 * 60 * 60 * 1000`.
- `parseRemoteSha` accepts `<hex-sha><TAB><ref>`; return `null` if the first field is not `/^[0-9a-f]{7,40}$/`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && node --test src/test/unit/update-state.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/config/index.js server/src/services/update-manager.js server/src/test/unit/update-state.test.js
git commit -m "feat(update): add self-update config and state primitives"
```

---

### Task 2: Version check and synchronous preflight

**Files:**
- Modify: `server/src/services/update-manager.js`
- Test: `server/src/test/unit/update-manager.test.js`

**Interfaces:**
- Consumes: Task 1 primitives.
- Produces:
  - `UpdateManager.execFileAsync(file, args, options?) -> Promise<{ stdout, stderr }>`
  - `UpdateManager.getCurrentVersion() -> { sha, shortSha, version, committedAt, dirty } | null`
  - `UpdateManager.getLatestVersion({ now?, paths? }) -> { sha, shortSha, checkedAt } | null`
  - `UpdateManager.isPm2Online() -> Promise<boolean>`
  - `UpdateManager.isShallowRepository() -> Promise<boolean>`
  - `UpdateManager.isPlatformSupported(platform?) -> boolean`
  - `UpdateManager.isUpdateRunning(now?) -> boolean` (a live lock, or a `running` state whose pid is alive)
  - `UpdateManager.getIncompleteUpdate({ paths? }) -> { step, startedAt, fromSha, toSha } | null` (a `running` state whose pid is dead)
  - `UpdateManager.getVersionInfo() -> { current, latest, updateAvailable, updateEnabled, incomplete, reason }`
  - `UpdateManager.preflight() -> { ok: true, fromSha, toSha } | { ok: false, httpStatus, message }`

- [ ] **Step 1: Write the failing tests**

```js
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const UpdateManager = require('../../services/update-manager');
const ProcessManager = require('../../services/process-manager');
const config = require('../../config');

const SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);

function tmpPaths() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-update-'));
  return UpdateManager.getPaths(repoRoot);
}

function stubGit(overrides = {}) {
  return mock.method(UpdateManager, 'execFileAsync', async (file, args) => {
    const cmd = args.join(' ');
    if (overrides[cmd]) return overrides[cmd];
    switch (cmd) {
      case 'rev-parse --is-inside-work-tree': return { stdout: 'true\n', stderr: '' };
      case 'rev-parse HEAD': return { stdout: SHA + '\n', stderr: '' };
      case 'log -1 --format=%cI': return { stdout: '2026-11-01T00:00:00+00:00\n', stderr: '' };
      case 'status --porcelain --untracked-files=no': return { stdout: '', stderr: '' };
      case 'rev-parse --is-shallow-repository': return { stdout: 'false\n', stderr: '' };
      default: return { stdout: '', stderr: '' };
    }
  });
}

test('current version is null for a non-git directory', async () => {
  mock.method(UpdateManager, 'execFileAsync', async () => {
    throw new Error('not a git repository');
  });
  try {
    assert.equal(await UpdateManager.getCurrentVersion(), null);
  } finally { mock.reset(); }
});

test('current version reports dirty status', async () => {
  stubGit({ 'status --porcelain --untracked-files=no': { stdout: ' M package.json\n', stderr: '' } });
  try {
    const v = await UpdateManager.getCurrentVersion();
    assert.equal(v.sha, SHA);
    assert.equal(v.shortSha, SHA.slice(0, 7));
    assert.equal(v.dirty, true);
  } finally { mock.reset(); }
});

test('latest version is cached for 10 minutes', async () => {
  const paths = tmpPaths();
  const calls = [];
  mock.method(UpdateManager, 'execFileAsync', async (file, args) => {
    calls.push(args.join(' '));
    return { stdout: `${NEW_SHA}\trefs/heads/main\n`, stderr: '' };
  });
  try {
    const t0 = Date.parse('2026-11-05T00:00:00Z');
    const first = await UpdateManager.getLatestVersion({ now: t0, paths });
    assert.equal(first.sha, NEW_SHA);
    assert.equal(calls.length, 1);
    const second = await UpdateManager.getLatestVersion({ now: t0 + 60_000, paths });
    assert.equal(second.sha, NEW_SHA);
    assert.equal(calls.length, 1);
    await UpdateManager.getLatestVersion({ now: t0 + 11 * 60_000, paths });
    assert.equal(calls.length, 2);
  } finally { mock.reset(); }
});

test('pm2 online requires the configured process to be online', async () => {
  mock.method(ProcessManager, 'pm2Exec', async () => ({
    stdout: JSON.stringify([{ name: config.pm2.instanceName, pm2_env: { status: 'online' } }]),
    stderr: ''
  }));
  try { assert.equal(await UpdateManager.isPm2Online(), true); } finally { mock.reset(); }

  mock.method(ProcessManager, 'pm2Exec', async () => ({
    stdout: JSON.stringify([{ name: config.pm2.instanceName, pm2_env: { status: 'stopped' } }]),
    stderr: ''
  }));
  try { assert.equal(await UpdateManager.isPm2Online(), false); } finally { mock.reset(); }
});

test('preflight rejects a shallow repository', async () => {
  stubGit({
    'rev-parse --is-shallow-repository': { stdout: 'true\n', stderr: '' },
  });
  const orig = config.selfUpdate.enabled;
  config.selfUpdate.enabled = true;
  mock.method(UpdateManager, 'isPm2Online', async () => true);
  mock.method(UpdateManager, 'isUpdateRunning', () => false);
  mock.method(UpdateManager, 'getLatestVersion', async () => ({ sha: NEW_SHA, shortSha: NEW_SHA.slice(0, 7), checkedAt: new Date().toISOString() }));
  try {
    const r = await UpdateManager.preflight();
    assert.equal(r.ok, false);
    assert.match(r.message, /shallow/);
  } finally { mock.reset(); config.selfUpdate.enabled = orig; }
});

test('preflight returns from/to shas when all checks pass', async () => {
  stubGit();
  const orig = config.selfUpdate.enabled;
  config.selfUpdate.enabled = true;
  mock.method(UpdateManager, 'isPm2Online', async () => true);
  mock.method(UpdateManager, 'isUpdateRunning', () => false);
  mock.method(UpdateManager, 'getLatestVersion', async () => ({ sha: NEW_SHA, shortSha: NEW_SHA.slice(0, 7), checkedAt: new Date().toISOString() }));
  try {
    const r = await UpdateManager.preflight();
    assert.deepEqual(r, { ok: true, fromSha: SHA, toSha: NEW_SHA });
  } finally { mock.reset(); config.selfUpdate.enabled = orig; }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test src/test/unit/update-manager.test.js`
Expected: FAIL — `getCurrentVersion is not a function` (or similar).

- [ ] **Step 3: Implement the methods**

Implementation notes:
- `execFileAsync` wraps `util.promisify(execFile)` with `{ maxBuffer: 10 * 1024 * 1024, timeout: 10000, ...options }`.
- `getCurrentVersion`: run `git rev-parse --is-inside-work-tree`, `git rev-parse HEAD`, `git log -1 --format=%cI`, `git status --porcelain --untracked-files=no` with `cwd = pathHelper.getProjectRoot()`. Return `null` if any fails. `version` is `require('../../../package.json').version` (path from `server/src/services/` to repo root).
- `getLatestVersion`: read `paths.checkPath`. If it parses and `now - Date.parse(checkedAt) < 10 * 60 * 1000`, return it. Otherwise run `git ls-remote <config.selfUpdate.remote> refs/heads/<config.selfUpdate.ref>` with `timeout: 5000`; parse with `parseRemoteSha`; on any error return `null`. Persist `{ sha, shortSha, checkedAt }` with `writeState(paths.checkPath, ...)` best-effort.
- `isPm2Online`: `ProcessManager.pm2Exec(['jlist'], { timeout: 10000 })`, `JSON.parse(stdout)`, find `name === config.pm2.instanceName`, return `pm2_env.status === 'online'`; return `false` on any error.
- `isShallowRepository`: `git rev-parse --is-shallow-repository`; return stdout trim === `'true'`; return `false` on error.
- `isPlatformSupported(platform = process.platform)` returns `platform !== 'win32'`.
- `isUpdateRunning(now = Date.now())`: return true when either the lock is live (`!isLockStale(lock, now, pidAlive)`) or the state file says `running` and its `pid` is alive (the lock can lag a freshly spawned helper).
- `getIncompleteUpdate({ paths } = {})`: return `null` unless state is `running`; return `null` when its pid is alive; otherwise return `{ step, startedAt, fromSha, toSha }`. Never throws.
- `preflight` order and messages: disabled → 400 `'自更新未开启 (SELF_UPDATE_ENABLED)'`; platform → 400 `'当前平台不支持自更新'`; running → 409 `'已有更新正在进行'`; non-git → 400 `'平台不是 git 部署，无法自更新'`; dirty → 400 `'工作区有未提交改动'`; shallow → 400 `'git 仓库是 shallow clone，无法安全判断祖先关系'`; latest null → 400 `'无法获取远端版本'`; pm2 offline → 400 `'PM2 进程未在线（检查 PM2_INSTANCE_NAME）'`; same sha without an incomplete state → 400 `'已经是最新版本'`; same sha **with** `getIncompleteUpdate()` non-null → `{ ok:true, fromSha: current.sha, toSha: current.sha }` (repair run); else `{ ok:true, fromSha, toSha }`.
- `getVersionInfo` never throws: wrap in try/catch and return `{ current:null, latest:null, updateAvailable:false, updateEnabled:false, incomplete:null, reason: err.message }`. `updateEnabled = config.selfUpdate.enabled && isPlatformSupported() && Boolean(current) && await isPm2Online()` (a non-git deploy has `current === null`, so it cannot update). `reason` names the first unmet condition (`dirty` → `'工作区有未提交改动'`).

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && node --test src/test/unit/update-manager.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/update-manager.js server/src/test/unit/update-manager.test.js
git commit -m "feat(update): check versions and preflight platform updates"
```

---

### Task 3: Protected update routes

**Files:**
- Create: `server/src/routes/update.js`
- Modify: `server/src/routes/index.js` (mount after `proxyRouter`)
- Test: `server/src/test/integration/update-api.test.js`

**Interfaces:**
- Consumes: `UpdateManager.getVersionInfo()`, `preflight()`, `startUpdate({ fromSha, toSha })`, `getUpdateStatus()`.
- Produces: `GET /api/system/version`, `POST /api/system/update`, `GET /api/system/update/status`.
  `UpdateManager.startUpdate` and `getUpdateStatus` are implemented here as thin wrappers around Task 1 primitives:
  - `startUpdate({ fromSha, toSha, paths? }) -> { ok:true, pid } | { ok:false, httpStatus, message }`
    (validates both SHAs, claims the lock atomically with `wx`, writes state, spawns)
  - `getUpdateStatus() -> { state, logTail }` with `state` defaulting to `{ status:'idle' }`.

- [ ] **Step 1: Write the failing tests**

```js
const { test, before, mock } = require('node:test');
const assert = require('node:assert/strict');
const { request, init, adminAgent } = require('../helpers/setup');
const UpdateManager = require('../../services/update-manager');

before(async () => { await init(); });

test('GET /api/system/version requires auth', async () => {
  const res = await request().get('/api/system/version');
  assert.equal(res.status, 401);
});

test('GET /api/system/version returns the manager payload', async () => {
  const agent = await adminAgent();
  const payload = {
    current: { sha: 'abc', shortSha: 'abc', version: '1.0.0', committedAt: null, dirty: false },
    latest: null, updateAvailable: false, updateEnabled: false, reason: '未开启'
  };
  mock.method(UpdateManager, 'getVersionInfo', async () => payload);
  try {
    const res = await agent.get('/api/system/version');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true, data: payload });
  } finally { mock.reset(); }
});

test('POST /api/system/update maps a failed preflight to its status', async () => {
  const agent = await adminAgent();
  mock.method(UpdateManager, 'preflight', async () => ({ ok: false, httpStatus: 409, message: '已有更新正在进行' }));
  try {
    const res = await agent.post('/api/system/update');
    assert.equal(res.status, 409);
    assert.equal(res.body.success, false);
    assert.match(res.body.error.message, /正在进行/);
  } finally { mock.reset(); }
});

test('POST /api/system/update starts once and returns 202', async () => {
  const agent = await adminAgent();
  mock.method(UpdateManager, 'preflight', async () => ({ ok: true, fromSha: 'aaa', toSha: 'bbb' }));
  let starts = 0;
  mock.method(UpdateManager, 'startUpdate', async (args) => {
    starts += 1;
    assert.deepEqual(args, { fromSha: 'aaa', toSha: 'bbb' });
    return { ok: true, pid: 4242 };
  });
  try {
    const res = await agent.post('/api/system/update');
    assert.equal(res.status, 202);
    assert.equal(res.body.data.status, 'running');
    assert.equal(res.body.data.pid, 4242);
    assert.equal(starts, 1);
  } finally { mock.reset(); }
});

test('GET /api/system/update/status returns state and log tail', async () => {
  const agent = await adminAgent();
  mock.method(UpdateManager, 'getUpdateStatus', async () => ({
    state: { status: 'success', step: 'health' }, logTail: ['done']
  }));
  try {
    const res = await agent.get('/api/system/update/status');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.state.status, 'success');
    assert.deepEqual(res.body.data.logTail, ['done']);
  } finally { mock.reset(); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test src/test/integration/update-api.test.js`
Expected: FAIL with 404 (route not mounted) / `startUpdate is not a function`.

- [ ] **Step 3: Implement the router, mount it, and add the two manager methods**

`server/src/routes/update.js`:

```js
const express = require('express');
const UpdateManager = require('../services/update-manager');

const router = express.Router();

router.get('/system/version', async (req, res, next) => {
  try {
    res.json({ success: true, data: await UpdateManager.getVersionInfo() });
  } catch (error) { next(error); }
});

router.post('/system/update', async (req, res, next) => {
  try {
    const pre = await UpdateManager.preflight();
    if (!pre.ok) {
      return res.status(pre.httpStatus).json({ success: false, error: { message: pre.message } });
    }
    const started = await UpdateManager.startUpdate({ fromSha: pre.fromSha, toSha: pre.toSha });
    if (!started.ok) {
      return res.status(started.httpStatus).json({ success: false, error: { message: started.message } });
    }
    res.status(202).json({ success: true, data: { status: 'running', pid: started.pid } });
  } catch (error) { next(error); }
});

router.get('/system/update/status', async (req, res, next) => {
  try {
    res.json({ success: true, data: await UpdateManager.getUpdateStatus() });
  } catch (error) { next(error); }
});

module.exports = router;
```

In `server/src/routes/index.js`, import `updateRouter` and add `router.use(updateRouter);` after `router.use(proxyRouter);`.

In `update-manager.js`:

```js
// final shape (see the landed implementation for the full body):
// static async startUpdate({ fromSha, toSha, paths = this.getPaths() }) {
//   validate SHAs -> claim lock with { flag: 'wx' } (409 on a live lock)
//   -> write running/queued state -> spawnDetached -> on error/!pid write failed + drop lock
//   -> rewrite lock with child.pid -> return { ok:true, pid }
// }
static spawnDetached(file, args, options) {
  const { spawn } = require('child_process');
  return spawn(file, args, options);
}

static async getUpdateStatus() {
  const paths = this.getPaths();
  return {
    state: this.readState(paths.statePath) || { status: 'idle' },
    logTail: this.readLogTail(paths.logPath)
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && node --test src/test/integration/update-api.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/update.js server/src/routes/index.js server/src/services/update-manager.js server/src/test/integration/update-api.test.js
git commit -m "feat(update): expose protected version and update endpoints"
```

---

### Task 4: Detached updater — success path

**Files:**
- Create: `server/src/services/self-updater.js`
- Create: `scripts/self-update.js`
- Modify: `client/package.json` (add `build:staging`)
- Modify: `.gitignore` (runtime artifacts)
- Test: `server/src/test/unit/self-updater-success.test.js`
- Test: `server/src/test/unit/self-update-cli.test.js`

**Interfaces:**
- Consumes: Task 1 `UpdateManager.getPaths/writeState/readState/isLockStale`; `ProcessManager.getNpmCliPath()` and `ProcessManager.pm2Exec()`.
- Produces:
  - `runUpdate(options) -> Promise<state>`
  - `pollHealth({ request, now, sleep, port, timeoutMs, intervalMs }) -> Promise<boolean>`
  - `parseArgs(argv) -> { fromSha, toSha }` (throws on invalid)
  - Option keys: `repoRoot, paths, dbPath, port, pm2Name, ref, remote, fromSha, toSha, healthTimeoutMs, healthIntervalMs, runCommand, runNpm, runPm2, backupDb, healthCheck, now, sleep, isPidAlive`.
  - `STEPS = ['preflight','fetch','backup','pull','install','build','reload','health','cleanup']`.

- [ ] **Step 1: Write the failing tests**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runUpdate, pollHealth } = require('../../services/self-updater');
const UpdateManager = require('../../services/update-manager');

const FROM = 'a'.repeat(40);
const TO = 'b'.repeat(40);

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-self-update-'));
  fs.mkdirSync(path.join(repoRoot, 'client', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'client', 'dist', 'index.html'), 'old');
  fs.mkdirSync(path.join(repoRoot, 'data'), { recursive: true });
  return { repoRoot, paths: UpdateManager.getPaths(repoRoot) };
}

function successDeps(calls, { buildImpl } = {}) {
  return {
    fromSha: FROM,
    toSha: TO,
    runCommand: async (file, args) => {
      const cmd = `${file} ${args.join(' ')}`;
      calls.push(cmd);
      if (cmd.includes('rev-parse HEAD')) return { stdout: FROM + '\n', stderr: '' };
      if (cmd.includes('status --porcelain --untracked-files=no')) return { stdout: '', stderr: '' };
      if (cmd.includes('rev-parse --is-shallow-repository')) return { stdout: 'false\n', stderr: '' };
      if (cmd.includes('rev-parse origin/main')) return { stdout: TO + '\n', stderr: '' };
      if (cmd.includes('ls-remote')) return { stdout: `${TO}\trefs/heads/main\n`, stderr: '' };
      if (cmd.includes('merge-base --is-ancestor')) return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    },
    runNpm: async (args) => {
      calls.push(`npm ${args.join(' ')}`);
      if (args.includes('build:staging')) {
        if (buildImpl) return buildImpl();
        fs.mkdirSync(path.join(fixtureRoot, 'client', 'dist.next'), { recursive: true });
        fs.writeFileSync(path.join(fixtureRoot, 'client', 'dist.next', 'index.html'), 'new');
      }
      return { stdout: '', stderr: '' };
    },
    runPm2: async (args) => { calls.push(`pm2 ${args.join(' ')}`); return { stdout: '', stderr: '' }; },
    backupDb: async () => { calls.push('backupDb'); },
    healthCheck: async () => true,
    now: () => Date.parse('2026-11-05T00:00:00Z'),
    sleep: async () => {},
    isPidAlive: () => false
  };
}

let fixtureRoot;

test('successful update walks the steps in order and swaps dist', async () => {
  const { repoRoot, paths } = fixture();
  fixtureRoot = repoRoot;
  const calls = [];
  const state = await runUpdate({ ...successDeps(calls), repoRoot, paths });
  assert.equal(state.status, 'success');
  assert.equal(fs.readFileSync(path.join(repoRoot, 'client', 'dist', 'index.html'), 'utf8'), 'new');
  assert.equal(fs.existsSync(path.join(repoRoot, 'client', 'dist.next')), false);
  assert.equal(fs.existsSync(path.join(repoRoot, 'client', 'dist.prev')), false);
  assert.equal(fs.existsSync(paths.lockPath), false);
  assert.deepEqual(
    calls.filter(c => /git fetch|merge-base|git merge --ff-only|npm install|build:staging|pm2 reload/.test(c)),
    [
      'git fetch origin main',
      'git merge-base --is-ancestor HEAD origin/main',
      'git merge --ff-only origin/main',
      'npm install --include=dev --no-audit --no-fund',
      'npm run build:staging --workspace=client',
      'pm2 reload microverse-server'
    ]
  );
});

test('stale dist.next/dist.prev are cleaned before building', async () => {
  const { repoRoot, paths } = fixture();
  fixtureRoot = repoRoot;
  fs.mkdirSync(path.join(repoRoot, 'client', 'dist.next'));
  fs.mkdirSync(path.join(repoRoot, 'client', 'dist.prev'));
  const calls = [];
  const state = await runUpdate({ ...successDeps(calls), repoRoot, paths });
  assert.equal(state.status, 'success');
  assert.equal(fs.existsSync(path.join(repoRoot, 'client', 'dist.prev')), false);
});

test('pollHealth retries transient errors until the deadline', async () => {
  let attempts = 0;
  let t = 0;
  const ok = await pollHealth({
    port: 5000,
    timeoutMs: 5000,
    intervalMs: 1000,
    now: () => t,
    sleep: async () => { t += 1000; },
    request: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('ECONNREFUSED');
      return 200;
    }
  });
  assert.equal(ok, true);
  assert.equal(attempts, 3);
});
```

`server/src/test/unit/self-update-cli.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../../../../scripts/self-update');

test('parseArgs reads --from/--to and rejects invalid shas', () => {
  assert.deepEqual(parseArgs(['--from', 'abc1234', '--to', 'def5678']), { fromSha: 'abc1234', toSha: 'def5678' });
  assert.throws(() => parseArgs(['--from', 'nope', '--to', 'def5678']), /invalid/i);
  assert.throws(() => parseArgs(['--from', 'abc1234']), /invalid/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test src/test/unit/self-updater-success.test.js src/test/unit/self-update-cli.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the success path**

Implementation notes:
- `runUpdate` merges defaults with the caller's options, then:
  1. Acquire `paths.lockPath` (`{ pid: process.pid, startedAt: ISO }`). A non-stale existing lock is accepted only when it was claimed by the spawning route: `lock.pid === process.pid || lock.pid === process.ppid`. Otherwise write a `failed` state `'另一个更新正在进行中'` and return it. Always rewrite the lock with `process.pid` before running any step.
  2. Write the initial `running` state and append a timestamped line per step to `paths.logPath` (`fs.appendFileSync`).
  3. `preflight`: `git rev-parse --is-inside-work-tree`, `git status --porcelain --untracked-files=no` empty, `git rev-parse --is-shallow-repository` is `false`, `git rev-parse HEAD` equals `fromSha`.
  4. `fetch`: `git fetch <remote> <ref>` (timeout 120000); `git merge-base --is-ancestor HEAD <remote>/<ref>` (timeout 60000) — on non-zero exit throw `'本地提交与远端分叉，拒绝更新'`; `git rev-parse <remote>/<ref>` becomes the effective `toSha` and is written to state.
  5. `backup`: `backupDb(dbPath, path.join(backupsDir, '<ISO-with-colons-replaced>.sqlite'))` best-effort (skip if the DB file does not exist); `fs.rmSync(dist.next/dist.prev, { recursive:true, force:true })`.
  6. `pull`: `git merge --ff-only <remote>/<ref>`.
  7. `install`: `runNpm(['install','--include=dev','--no-audit','--no-fund'], { cwd: repoRoot, timeout: 15*60*1000 })`.
  8. `build`: `runNpm(['run','build:staging','--workspace=client'], { cwd: repoRoot, timeout: 15*60*1000 })`; then swap `dist → dist.prev` (if `dist` exists), `dist.next → dist`.
  9. `reload`: `runPm2(['reload', pm2Name], { timeout: 60000 })` (default `process-manager.pm2Exec`).
  10. `health`: `pollHealth` with the configured port/timeouts; false throws.
  11. `cleanup`: run `git status --porcelain --untracked-files=no`; if the only line matches `/^\s*M\s+package-lock\.json$/`, run `git checkout -- package-lock.json`; any other lines become `state.warning` (do not fail). Remove `dist.prev`. Set `status:'success'`, `finishedAt`.
  12. `finally`: remove the lock file.
- `runUpdate` must never throw: catch every error, roll back per Task 5 rules, and return the final state.
- Default `runCommand` uses `execFile` with `maxBuffer: 16 * 1024 * 1024`.
- Default `runNpm`: `ProcessManager.getNpmCliPath()`; if it returns a path other than `'npm'`, run `process.execPath [npmCli, ...args]`, else run `npm` with `args`.
- Default `runPm2`: `ProcessManager.pm2Exec(args, options)`.
- Default `backupDb(dbPath, destPath)`: open `dbPath` with the existing `sqlite3` package and run `VACUUM INTO ?` with `destPath`, then close. Skip (log only) when `dbPath` does not exist.
- Default `healthCheck` is `pollHealth({ port, timeoutMs: healthTimeoutMs, intervalMs: healthIntervalMs, request: httpGetStatus })`; `httpGetStatus` uses `http.get` with `timeout: 2000` and resolves `res.statusCode`.
- Defaults when the caller omits them: `repoRoot = pathHelper.getProjectRoot()`, `paths = UpdateManager.getPaths(repoRoot)`, `dbPath = config.database.path`, `port = config.server.port`, `pm2Name = config.pm2.instanceName`, `ref = config.selfUpdate.ref`, `remote = config.selfUpdate.remote`, `healthTimeoutMs = 60000`, `healthIntervalMs = 1000`.
- Before the lock check, `runUpdate` must not run any command.
- `scripts/self-update.js`: `parseArgs` validates both shas against `/^[0-9a-f]{7,40}$/` and throws `'invalid --from/--to sha'` otherwise. When `require.main === module`, call `runUpdate({ fromSha, toSha })` and `process.exit(state.status === 'success' ? 0 : 1)`.
- `client/package.json`: add `"build:staging": "vite build --outDir dist.next --emptyOutDir"`.
- `.gitignore`: add `data/update-state.json`, `data/update-check.json`, `data/update.lock`, `data/backups/`, `client/dist.next/`, `client/dist.prev/`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && node --test src/test/unit/self-updater-success.test.js src/test/unit/self-update-cli.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/self-updater.js scripts/self-update.js client/package.json .gitignore server/src/test/unit/self-updater-success.test.js server/src/test/unit/self-update-cli.test.js
git commit -m "feat(update): add detached self-updater success path"
```

---

### Task 5: Rollback and recovery paths

**Files:**
- Modify: `server/src/services/self-updater.js`
- Test: `server/src/test/unit/self-updater-rollback.test.js`

**Interfaces:**
- Consumes: Task 4 `runUpdate` options/deps.
- Produces: same `runUpdate`; failure behavior per the spec.

- [ ] **Step 1: Write the failing tests**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runUpdate } = require('../../services/self-updater');
const UpdateManager = require('../../services/update-manager');

const FROM = 'a'.repeat(40);
const TO = 'b'.repeat(40);

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-rollback-'));
  fs.mkdirSync(path.join(repoRoot, 'client', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'client', 'dist', 'index.html'), 'old');
  fs.mkdirSync(path.join(repoRoot, 'data'), { recursive: true });
  return { repoRoot, paths: UpdateManager.getPaths(repoRoot) };
}

function deps(repoRoot, calls, overrides = {}) {
  return {
    repoRoot,
    paths: UpdateManager.getPaths(repoRoot),
    fromSha: FROM,
    toSha: TO,
    runCommand: async (file, args) => {
      const cmd = `${file} ${args.join(' ')}`;
      calls.push(cmd);
      if (overrides.fail && cmd.includes(overrides.fail)) throw new Error('boom');
      if (cmd.includes('rev-parse HEAD')) return { stdout: FROM + '\n', stderr: '' };
      if (cmd.includes('status --porcelain --untracked-files=no')) return { stdout: '', stderr: '' };
      if (cmd.includes('rev-parse --is-shallow-repository')) return { stdout: 'false\n', stderr: '' };
      if (cmd.includes('rev-parse origin/main')) return { stdout: TO + '\n', stderr: '' };
      if (cmd.includes('merge-base --is-ancestor')) return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    },
    runNpm: async (args) => {
      calls.push(`npm ${args.join(' ')}`);
      if (overrides.failNpm && args.includes(overrides.failNpm)) throw new Error('npm failed');
      if (args.includes('build:staging')) {
        fs.mkdirSync(path.join(repoRoot, 'client', 'dist.next'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'client', 'dist.next', 'index.html'), 'new');
      }
      return { stdout: '', stderr: '' };
    },
    runPm2: async (args) => { calls.push(`pm2 ${args.join(' ')}`); return { stdout: '', stderr: '' }; },
    backupDb: async () => {},
    healthCheck: async () => overrides.health !== false,
    now: () => Date.parse('2026-11-05T00:00:00Z'),
    sleep: async () => {},
    isPidAlive: overrides.isPidAlive || (() => false)
  };
}

test('build failure rolls code back and leaves dist untouched', async () => {
  const { repoRoot } = fixture();
  const calls = [];
  const state = await runUpdate(deps(repoRoot, calls, { failNpm: 'build:staging' }));
  assert.equal(state.status, 'rolled_back');
  assert.ok(calls.includes(`git reset --hard ${FROM}`));
  assert.equal(fs.readFileSync(path.join(repoRoot, 'client', 'dist', 'index.html'), 'utf8'), 'old');
  assert.equal(fs.existsSync(path.join(repoRoot, 'client', 'dist.next')), false);
  assert.equal(calls.filter(c => c.includes('pm2 reload')).length, 1);
});

test('health failure restores dist.prev and reloads twice', async () => {
  const { repoRoot } = fixture();
  const calls = [];
  let healthCalls = 0;
  const state = await runUpdate({
    ...deps(repoRoot, calls),
    healthCheck: async () => { healthCalls += 1; return healthCalls > 1; }
  });
  assert.equal(state.status, 'rolled_back');
  assert.equal(fs.readFileSync(path.join(repoRoot, 'client', 'dist', 'index.html'), 'utf8'), 'old');
  assert.equal(fs.existsSync(path.join(repoRoot, 'client', 'dist.prev')), false);
  assert.equal(calls.filter(c => c.includes('pm2 reload')).length, 2);
});

test('diverged history fails before any file is touched', async () => {
  const { repoRoot } = fixture();
  const calls = [];
  const state = await runUpdate({
    ...deps(repoRoot, calls),
    runCommand: async (file, args) => {
      const cmd = `${file} ${args.join(' ')}`;
      calls.push(cmd);
      if (cmd.includes('rev-parse HEAD')) return { stdout: FROM + '\n', stderr: '' };
      if (cmd.includes('status --porcelain')) return { stdout: '', stderr: '' };
      if (cmd.includes('merge-base --is-ancestor')) throw new Error('exit 1');
      return { stdout: '', stderr: '' };
    }
  });
  assert.equal(state.status, 'failed');
  assert.ok(!calls.some(c => c.includes('git merge --ff-only')));
  assert.equal(fs.readFileSync(path.join(repoRoot, 'client', 'dist', 'index.html'), 'utf8'), 'old');
});

test('cleanup restores a lone lockfile modification', async () => {
  const { repoRoot } = fixture();
  const calls = [];
  let statusCalls = 0;
  const state = await runUpdate({
    ...deps(repoRoot, calls),
    runCommand: async (file, args) => {
      const cmd = `${file} ${args.join(' ')}`;
      calls.push(cmd);
      if (cmd.includes('status --porcelain --untracked-files=no')) {
        statusCalls += 1;
        return { stdout: statusCalls === 1 ? '' : ' M package-lock.json\n', stderr: '' };
      }
      if (cmd.includes('rev-parse HEAD')) return { stdout: FROM + '\n', stderr: '' };
      if (cmd.includes('rev-parse origin/main')) return { stdout: TO + '\n', stderr: '' };
      return { stdout: '', stderr: '' };
    }
  });
  assert.equal(state.status, 'success');
  assert.ok(calls.includes('git checkout -- package-lock.json'));
  assert.equal(state.warning, null);
});

test('cleanup ignores untracked state files (uses --untracked-files=no)', async () => {
  const { repoRoot } = fixture();
  const calls = [];
  const state = await runUpdate({
    ...deps(repoRoot, calls),
    runCommand: async (file, args) => {
      const cmd = `${file} ${args.join(' ')}`;
      calls.push(cmd);
      if (cmd.includes('status --porcelain') && !cmd.includes('--untracked-files=no')) {
        return { stdout: '?? data/update-state.json\n', stderr: '' };
      }
      if (cmd.includes('rev-parse HEAD')) return { stdout: FROM + '\n', stderr: '' };
      if (cmd.includes('rev-parse origin/main')) return { stdout: TO + '\n', stderr: '' };
      return { stdout: '', stderr: '' };
    }
  });
  assert.equal(state.status, 'success');
  assert.equal(state.warning, null);
  assert.ok(calls.some(c => c.includes('status --porcelain --untracked-files=no')));
});

test('a live lock refuses to start; a dead lock proceeds', async () => {
  const { repoRoot, paths } = fixture();
  fs.writeFileSync(paths.lockPath, JSON.stringify({ pid: 999, startedAt: '2026-11-05T00:00:00Z' }));
  const calls = [];
  const denied = await runUpdate(deps(repoRoot, calls, { isPidAlive: () => true }));
  assert.equal(denied.status, 'failed');
  assert.match(denied.error, /正在进行/);
  assert.equal(calls.length, 0);

  const resumed = await runUpdate(deps(repoRoot, calls, { isPidAlive: () => false }));
  assert.equal(resumed.status, 'success');
});

test('inherits a lock claimed by the spawning parent', async () => {
  const { repoRoot, paths } = fixture();
  fs.writeFileSync(paths.lockPath, JSON.stringify({ pid: process.ppid, startedAt: '2026-11-05T00:00:00Z' }));
  const calls = [];
  const state = await runUpdate(deps(repoRoot, calls, { isPidAlive: () => true }));
  assert.equal(state.status, 'success');
});

test('pollHealth gives up at the deadline', async () => {
  let t = 0;
  const { pollHealth } = require('../../services/self-updater');
  const ok = await pollHealth({
    port: 5000, timeoutMs: 3000, intervalMs: 1000,
    now: () => t, sleep: async () => { t += 1000; },
    request: async () => { throw new Error('refused'); }
  });
  assert.equal(ok, false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test src/test/unit/self-updater-rollback.test.js`
Expected: FAIL — rollback not implemented (status `failed`/wrong dist).

- [ ] **Step 3: Implement rollback and recovery**

Implementation notes:
- Wrap pull/install/build/reload/health in one `try`. On error, run rollback:
  1. `git reset --hard <fromSha>` (timeout 60000).
  2. `restoreDist`: remove `dist`, rename `dist.prev → dist` when present, remove `dist.next`.
  3. Best-effort `runNpm(['install','--include=dev','--no-audit','--no-fund'])` (swallow errors; log them).
  4. `runPm2(['reload', pm2Name], { timeout: 60000 })`.
  5. Re-run `healthCheck`. Final status `rolled_back` if it returns true, else `failed` with `error` explaining manual intervention. Always set `finishedAt` and remove the lock in `finally`.
- Failures in `preflight`/`fetch`/`backup` do NOT roll back; set `status:'failed'` and return (nothing was modified).
- The lock check happens before writing any state or running any command.
- `status` on a lock conflict is `failed` with `error: '另一个更新正在进行中'` (no commands run).
- Cleanup always runs `git status --porcelain --untracked-files=no`; never a bare `git status --porcelain`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && node --test src/test/unit/self-updater-rollback.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/self-updater.js server/src/test/unit/self-updater-rollback.test.js
git commit -m "feat(update): roll back code and dist when an update fails"
```

---

### Task 6: Client version badge, update modal, and i18n

**Files:**
- Create: `client/src/api/system.js`
- Create: `client/src/components/UpdateBadge.jsx`
- Create: `client/src/components/UpdateModal.jsx`
- Modify: `client/src/components/EditorialShell.jsx`
- Modify: `client/src/i18n/locales/en.json`
- Modify: `client/src/i18n/locales/zh.json`

**Interfaces:**
- Consumes: `GET /api/system/version`, `POST /api/system/update`, `GET /api/system/update/status`.
- Produces:
  - `getSystemVersion()`, `startSystemUpdate()`, `getUpdateStatus()` in `client/src/api/system.js`
  - `<UpdateBadge />` rendered in the shell nav.

- [ ] **Step 1: Add the API client**

```js
import axios from 'axios'

const api = axios.create({ baseURL: '/api', withCredentials: true, timeout: 10000 })

export const getSystemVersion = async () => (await api.get('/system/version')).data.data

export const startSystemUpdate = async () => {
  const response = await api.post('/system/update', {}, { timeout: 30000 })
  return response.data.data
}

export const getUpdateStatus = async () => (await api.get('/system/update/status')).data.data
```

- [ ] **Step 2: Add i18n keys**

Add to both locale files under a new top-level `"update"` object:

```
title, current, latest, available, upToDate, disabled, button, confirm,
checkFailed, noVersion, status.running, status.success, status.rolledBack,
status.failed, log, reloadSoon, close, steps.preflight, steps.fetch,
steps.backup, steps.pull, steps.install, steps.build, steps.reload,
steps.health, steps.cleanup
```

English values (Chinese mirror): `title: "Platform update"`, `current: "Current"`, `latest: "Latest"`, `available: "A new version is available"`, `upToDate: "Up to date"`, `disabled: "Update is not available: {{reason}}"`, `button: "Update now"`, `confirm: "The platform will rebuild and restart. Running apps are not affected."`, `checkFailed: "Could not check the remote version"`, `noVersion: "Version unavailable"`, `status.running: "Updating…"`, `status.success: "Update complete"`, `status.rolledBack: "Update failed and was rolled back"`, `status.failed: "Update failed — manual intervention required"`, `log: "Log"`, `reloadSoon: "Reloading…"`, `close: "Close"`, `steps.*` as human labels.

- [ ] **Step 3: Implement `UpdateBadge.jsx`**

Behavior:
- On mount, call `getSystemVersion()`; on failure keep `version` null and render nothing.
- Render a `button` with class `nav-link`. When `version.current` exists, show
  `v{version.current.version} · {version.current.shortSha}`; otherwise show
  `t('update.noVersion')`.
- If `updateAvailable`, prefix a `<span aria-hidden>●</span>` and the label `t('update.available')`.
- Clicking opens `<UpdateModal version={version} onClose={...} />`.
- Refresh the version when the modal closes after an update.

- [ ] **Step 4: Implement `UpdateModal.jsx`**

Behavior:
- Props: `version`, `onClose`.
- Shows current/latest short shas and a GitHub compare link
  (`https://github.com/kuoluosaigai/microverse/compare/<from>...<to>`).
- When `version.updateEnabled` is false, show `t('update.disabled', { reason })` and no action button.
- Otherwise show a confirm text and an “Update now” button. On click:
  - `await startSystemUpdate()`; then poll `getUpdateStatus()` every 2000 ms.
  - Render a static step list (`preflight…cleanup`) with `status.step` highlighted, plus `<pre style={{ maxHeight: 240, overflow: 'auto' }}>{logTail.join('\n')}</pre>`.
  - Polling treats network errors as transient (keep polling).
  - Terminal states: `success` → show success + `window.location.reload()` after 1500 ms; `rolled_back` / `failed` → show the error/warning and stop polling.
  - Clear the interval on unmount.
- Use Ant Design `Modal`, `Button`, `Alert`, `Typography`.

- [ ] **Step 5: Mount the badge in the shell**

In `client/src/components/EditorialShell.jsx`, render `<UpdateBadge />` inside `<nav className="nav">` before `{right ?? <LanguageSwitcher />}`.

- [ ] **Step 6: Verify lint and build**

Run: `cd client && npm run lint && npm run build`
Expected: both exit 0. (`build` must not leave `client/dist` broken — it is the normal build, not a staged one.)

- [ ] **Step 7: Commit**

```bash
git add client/src/api/system.js client/src/components/UpdateBadge.jsx client/src/components/UpdateModal.jsx client/src/components/EditorialShell.jsx client/src/i18n/locales/en.json client/src/i18n/locales/zh.json
git commit -m "feat(update): add version badge and in-app update dialog"
```

---

### Task 7: Documentation, OpenAPI, and verification notes

**Files:**
- Modify: `server/src/docs/openapi.yaml`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/manual-verification.md`

**Interfaces:**
- Documents the endpoints from Task 3 and the env vars from Task 1.

- [ ] **Step 1: Add the OpenAPI paths**

Under `paths:`, add:

```yaml
  /system/version:
    get:
      tags: [System]
      summary: Platform version and update availability
      operationId: getSystemVersion
      security: [{ sessionAuth: [] }]
      responses:
        '200': { description: Version info, content: { application/json: { schema: { type: object } } } }
        '401': { description: Not authenticated }
  /system/update:
    post:
      tags: [System]
      summary: Start a platform self-update
      operationId: startSystemUpdate
      security: [{ sessionAuth: [] }]
      responses:
        '202': { description: Update started }
        '400': { description: Update unavailable or preflight failed }
        '401': { description: Not authenticated }
        '409': { description: Update already running }
  /system/update/status:
    get:
      tags: [System]
      summary: Update progress and log tail
      operationId: getSystemUpdateStatus
      security: [{ sessionAuth: [] }]
      responses:
        '200': { description: Update state }
        '401': { description: Not authenticated }
```

Match the file's existing security scheme name (check `components.securitySchemes` before writing; use the same key as the `/apps` paths).

- [ ] **Step 2: Document env vars in `.env.example`**

Add near the PM2 section:

```env
# Platform self-update (opt-in). Requires a git checkout, PM2-managed process,
# and SELF_UPDATE_ENABLED=true. See README "Updating the platform from the UI".
SELF_UPDATE_ENABLED=false
SELF_UPDATE_REF=main
SELF_UPDATE_REMOTE=origin
```

- [ ] **Step 3: Add a README section**

Under “Updating an existing deployment”, add a subsection “Updating from the UI” covering:
- Requirements (git checkout, PM2 process online, `SELF_UPDATE_ENABLED=true`, non-Windows).
- What the helper does (backup DB, ff-only pull, install, staged build, reload, health check, rollback).
- The chicken-and-egg first deployment (deploy this feature manually once, then enable).
- Additive-schema-only limitation and that the DB is backed up but not auto-restored.
- Link to the spec.

- [ ] **Step 4: Add manual verification items**

Append to `docs/manual-verification.md`:

```markdown
## Platform self-update

- [ ] `SELF_UPDATE_ENABLED=true` + PM2 online → badge shows `v1.0.0 · <sha>`; remote ahead → “有新版本”.
- [ ] Click update → steps advance, log streams; page reloads into the new version.
- [ ] Inject a build failure → state `rolled_back`, old version still served, `client/dist` intact.
- [ ] Inject a health failure → state `rolled_back`, old version served after the second reload.
- [ ] During an update, a deployed app stays Live.
- [ ] `SELF_UPDATE_ENABLED=false` → badge shows version, no update button.
```

- [ ] **Step 5: Verify the OpenAPI file parses and the server suite passes**

Run: `cd server && node -e "require('./src/docs')" && npm test`
Expected: no YAML error; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/docs/openapi.yaml .env.example README.md docs/manual-verification.md
git commit -m "docs: document platform self-update"
```
