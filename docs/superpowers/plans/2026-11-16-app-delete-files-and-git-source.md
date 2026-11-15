# App File Deletion Option + Git-Source Deploys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin optionally delete an app's files when deleting the app, and let any app bind a public Git repo whose GitHub push webhook pulls, rebuilds, and restarts the deployment.

**Architecture:** A new `app_git_source` table stores repo URL/branch/webhook secret/deployed SHA/sync state. `GitLifecycle` is the only module that invokes `git` (always `execFile` with an argument array). GitHub webhooks are verified with per-app HMAC-SHA256 and trigger a cross-worker single-flight sync claimed through a conditional DB update. npm apps reuse `NpmLifecycle` install/build fingerprints; failures roll the working tree back to the previous commit. The frontend adds a delete-files checkbox, Git fields on Create, and a `GitModal` for binding/status/manual sync.

**Tech Stack:** Node.js (CommonJS, `node:test` + `supertest`), Express, SQLite (`sqlite3`, async), PM2, React + Ant Design, Vite, i18next.

**Spec:** `docs/superpowers/specs/2026-11-16-app-delete-files-and-git-source-design.md`

## Global Constraints

- No new npm dependencies. Use `node:child_process`, `node:crypto`, `node:test`, and the existing `sqlite3` / `supertest`.
- Every `git` invocation uses `execFile(bin, argsArray, ...)` — never a shell string. Reject URL/branch values starting with `-`.
- All filesystem paths use `path.join` / `path.resolve`; never concatenate separators.
- SQLite queries are async; always `await`.
- API responses use `{ success: true, data }` / `{ success: false, error: { message } }`.
- `deleteFiles` defaults to `false`; `auto_update` defaults to `1` (true).
- Git URLs are public `https://` only. Branches default to `main`. SSH/private repos are out of scope.
- `GIT_STALE_SYNC_MS` defaults to 30 minutes; webhook body limit is 2MB; webhook rate limit is 120/min/IP.
- Sync state values are exactly: `idle | updating | success | failed | update_available`.
- Git apps reject uploads. `.git` is preserved by zip stale-cleanup, excluded from file listings and backups.
- Sync single-flight is the DB conditional update `claimGitSync` — never process memory (PM2 cluster).
- UI copy is added to both `client/src/i18n/locales/zh.json` and `en.json`.

## Review Focus

1. **Start when GitHub is unreachable** — an existing checkout must still start (record the fetch error), while a first-ever clone failure must fail the start. Covered by Task 6 (`prepareForStart` tests).
2. **Stop during a sync** — the sync must finish building but must not restart a process the user stopped. Covered by Task 5 (`wasRunning` / still-running test).
3. **Concurrent lifecycle ops** — Start/Restart/Delete while `last_status='updating'` and the claim is fresh must return 409; an expired claim must not block. Covered by Tasks 2 (claim) and 6 (guard tests).
4. **Webhook mismatch or duplicate delivery** — wrong repo/branch, wrong signature, ping, and a repeat of the same SHA must never trigger a build. Covered by Task 9.
5. **Pre-existing app directory** — deleting an app may leave files that a later create reuses; a failed Git bind must never `rm -rf` those files, and `git reset --hard` on a non-empty dir must still work. Covered by Tasks 4 and 7.

---

### Task 1: Optional app-directory deletion

**Files:**
- Modify: `server/src/services/app-manager.js` (`deleteApp`, around line 100)
- Modify: `server/src/services/deploy-manager.js` (`deleteApp`, around line 190)
- Modify: `server/src/routes/apps.js` (DELETE route, around line 148)
- Test: `server/src/test/unit/delete-app-files.test.js`
- Test: `server/src/test/integration/delete-app-files-route.test.js`

**Interfaces:**
- Consumes: `pathHelper.getAppsDir()`, `queries.updateApp`, existing `ProcessManager.deleteProcess` / `ProxyManager.regenerate`.
- Produces:
  - `AppManager.deleteApp(id, { deleteFiles?: boolean, skipProxyRegenerate?: boolean }): Promise<true>`
  - `DeployManager.deleteApp(appId, { deleteFiles?: boolean }): Promise<true>`
  - `DELETE /api/apps/:id?deleteFiles=true` → `{ success: true, data: { message, filesDeleted } }`

- [ ] **Step 1: Write the failing service tests**

Create `server/src/test/unit/delete-app-files.test.js` with `before(async () => { await dbReady; })` and these cases (mock `ProcessManager.deleteProcess` to resolve and `ProxyManager.regenerate` to resolve):

```js
test('deleteFiles=true removes the app directory', async () => {
  const app = await AppManager.createApp('del-files-yes', 'http-server');
  fs.writeFileSync(path.join(app.path, 'index.html'), '<h1>x</h1>');
  await AppManager.deleteApp(app.id, { deleteFiles: true });
  assert.equal(fs.existsSync(app.path), false);
});

test('deleteFiles=false keeps the app directory', async () => {
  const app = await AppManager.createApp('del-files-no', 'http-server');
  fs.writeFileSync(path.join(app.path, 'index.html'), '<h1>x</h1>');
  await AppManager.deleteApp(app.id);
  assert.equal(fs.existsSync(app.path), true);
  fs.rmSync(app.path, { recursive: true, force: true });
});

test('refuses to delete a directory outside APPS_DIR', async () => {
  const app = await AppManager.createApp('del-files-outside', 'http-server');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-outside-'));
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  await queries.updateApp({ id: app.id, path: outside });
  await assert.rejects(
    () => AppManager.deleteApp(app.id, { deleteFiles: true }),
    /outside APPS_DIR/
  );
  assert.equal(fs.existsSync(path.join(outside, 'keep.txt')), true);
  assert.ok(await queries.getAppById(app.id), 'DB row survives the refusal');
  fs.rmSync(outside, { recursive: true, force: true });
  fs.rmSync(app.path, { recursive: true, force: true });
  await queries.deleteApp(app.id);
});

test('refuses to delete a running app', async () => {
  const app = await AppManager.createApp('del-files-running', 'http-server');
  await queries.updateAppStatus('running', app.id);
  await assert.rejects(
    () => AppManager.deleteApp(app.id, { deleteFiles: true }),
    /Cannot delete running app/
  );
  assert.equal(fs.existsSync(app.path), true);
  fs.rmSync(app.path, { recursive: true, force: true });
  await queries.deleteApp(app.id);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && node --test src/test/unit/delete-app-files.test.js`
Expected: FAIL — `deleteFiles` is not honored (directory still exists), or the outside-path refusal never throws.

- [ ] **Step 3: Implement the option**

In `AppManager.deleteApp`, destructure `deleteFiles = false`. After `ProcessManager.deleteProcess` and before `queries.deleteApp`, when `deleteFiles` is true:

```js
const appsRoot = path.resolve(pathHelper.getAppsDir());
const target = path.resolve(app.path);
const rel = path.relative(appsRoot, target);
if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
  throw new Error('Refusing to delete a directory outside APPS_DIR');
}
fs.rmSync(target, { recursive: true, force: true });
```

`DeployManager.deleteApp(appId, options = {})` passes `deleteFiles: !!options.deleteFiles` into `AppManager.deleteApp` together with the existing `skipProxyRegenerate` flag.

In the route, parse `const deleteFiles = req.query.deleteFiles === 'true';`, pass it to `DeployManager.deleteApp`, and return `data: { message: 'App deleted successfully', filesDeleted: deleteFiles }`. Map `Refusing to delete` to 400.

- [ ] **Step 4: Run the service tests**

Run: `cd server && node --test src/test/unit/delete-app-files.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the route integration test**

Create `server/src/test/integration/delete-app-files-route.test.js` using `adminAgent()`: create an app via `AppManager.createApp`, write a file, then:

```js
await agent.delete(`/api/apps/${app.id}?deleteFiles=true`).expect(200);
assert.equal(fs.existsSync(app.path), false);
```

Add a second app deleted without the query param and assert its directory still exists.

- [ ] **Step 6: Run related tests**

Run: `cd server && node --test src/test/unit/delete-app-files.test.js src/test/integration/delete-app-files-route.test.js src/test/integration/default-app.test.js`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/app-manager.js server/src/services/deploy-manager.js server/src/routes/apps.js server/src/test/unit/delete-app-files.test.js server/src/test/integration/delete-app-files-route.test.js
git commit -m "feat(apps): optionally delete app files with the app"
```

---

### Task 2: Git-source table, queries, and app enrichment

**Files:**
- Modify: `server/src/db/schema.sql`
- Modify: `server/src/db/index.js` (queries block)
- Modify: `server/src/services/app-manager.js` (`getAllApps`, `getAppById`)
- Test: `server/src/test/unit/git-source-store.test.js`

**Interfaces:**
- Produces (all in `queries`):
  - `getAppGitSource(appId): Promise<Row|undefined>`
  - `getAllAppGitSources(): Promise<Row[]>`
  - `upsertAppGitSource({ appId, url, branch, autoUpdate, webhookSecret }): Promise<void>`
  - `setGitRemoteCommit(appId, sha): Promise<void>`
  - `setGitAutoUpdate(appId, enabled): Promise<void>`
  - `resetGitSourceProgress(appId): Promise<void>`
  - `claimGitSync(appId, staleMs): Promise<boolean>`
  - `finishGitSync(appId, { status, error?, deployedCommit?, remoteCommit? }): Promise<void>`
  - `markGitUpdateAvailable(appId): Promise<void>`
  - `deleteAppGitSource(appId): Promise<void>`
- Produces: every app object returned by `AppManager.getAppById` / `getAllApps` carries `git: { url, branch, auto_update, deployed_commit, remote_commit, synced_at, last_status, last_error } | null`.

- [ ] **Step 1: Write the failing store tests**

Create `server/src/test/unit/git-source-store.test.js`:

```js
test('upsert + get returns the source', async () => {
  const app = await AppManager.createApp('git-store-a', 'npm');
  await queries.upsertAppGitSource({ appId: app.id, url: 'https://github.com/o/r.git', branch: 'main', autoUpdate: true, webhookSecret: 's1' });
  const row = await queries.getAppGitSource(app.id);
  assert.equal(row.url, 'https://github.com/o/r.git');
  assert.equal(row.auto_update, 1);
});

test('claimGitSync is exclusive until the claim goes stale', async () => {
  const app = await AppManager.createApp('git-store-b', 'npm');
  await queries.upsertAppGitSource({ appId: app.id, url: 'https://github.com/o/r.git', branch: 'main', autoUpdate: true, webhookSecret: 's2' });
  assert.equal(await queries.claimGitSync(app.id, 60_000), true);
  assert.equal(await queries.claimGitSync(app.id, 60_000), false);
  await dbRun(`UPDATE app_git_source SET sync_started_at = datetime('now', '-2 minutes') WHERE app_id = ?`, [app.id]);
  assert.equal(await queries.claimGitSync(app.id, 60_000), true);
});

test('finishGitSync stores the commit and clears the claim', async () => {
  // claim -> finish success with deployedCommit 'abc'
  // assert last_status 'success', deployed_commit 'abc', sync_started_at null, synced_at not null
});

test('markGitUpdateAvailable does not clobber a fresh updating claim', async () => {
  // upsert, claim, markGitUpdateAvailable -> last_status stays 'updating'
});

test('deleting the app cascades app_git_source', async () => {
  // create + upsert + queries.deleteApp -> getAppGitSource undefined
});

test('AppManager.getAppById attaches git or null', async () => {
  // one plain app -> git === null; one with source -> git.url matches
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && node --test src/test/unit/git-source-store.test.js`
Expected: FAIL — `app_git_source` table / query functions do not exist.

- [ ] **Step 3: Add the table**

Append to `server/src/db/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS app_git_source (
  app_id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  auto_update INTEGER NOT NULL DEFAULT 1,
  webhook_secret TEXT NOT NULL,
  deployed_commit TEXT,
  remote_commit TEXT,
  synced_at DATETIME,
  last_status TEXT NOT NULL DEFAULT 'idle',
  last_error TEXT,
  sync_started_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);
```

- [ ] **Step 4: Implement the queries**

Add `dbRun` to `server/src/db/index.js`'s `module.exports` (the tests need a raw update to age a claim), then implement the queries. Use `COALESCE` so omitted commit values are preserved. `claimGitSync` is:

```js
claimGitSync: async (appId, staleMs) => {
  const modifier = `-${Math.max(1, Math.floor(staleMs / 1000))} seconds`;
  const result = await dbRun(
    `UPDATE app_git_source
        SET last_status = 'updating', sync_started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE app_id = ?
        AND (last_status != 'updating'
             OR sync_started_at IS NULL
             OR sync_started_at < datetime('now', ?))`,
    [appId, modifier]
  );
  return result.changes > 0;
}
```

`finishGitSync` sets `last_status`, `last_error`, `deployed_commit = COALESCE(?, deployed_commit)`, `remote_commit = COALESCE(?, remote_commit)`, `synced_at = CASE WHEN ? IS NOT NULL THEN CURRENT_TIMESTAMP ELSE synced_at END`, and clears `sync_started_at`.

`markGitUpdateAvailable` sets `last_status='update_available'` only when the row is not a fresh update: reuse the same stale predicate (pass `config.git.staleSyncMs` from the caller, or inline the stale default). Prefer a query signature `markGitUpdateAvailable(appId, staleMs)`.

- [ ] **Step 5: Enrich app objects**

In `AppManager.getAllApps`, fetch `queries.getAllAppGitSources()` once and map by `app_id`; attach `git` (null when absent). In `getAppById`, fetch `queries.getAppGitSource(id)` and attach the same shape. Keep the raw row field names (`auto_update`) inside the `git` object exactly as the API will expose them.

- [ ] **Step 6: Run the tests**

Run: `cd server && node --test src/test/unit/git-source-store.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/db/schema.sql server/src/db/index.js server/src/services/app-manager.js server/src/test/unit/git-source-store.test.js
git commit -m "feat(git): add app_git_source storage and app enrichment"
```

---

### Task 3: Config, Git-source validation, and webhook signatures

**Files:**
- Modify: `server/src/config/index.js`
- Create: `server/src/utils/validate-git-source.js`
- Create: `server/src/utils/webhook-signature.js`
- Test: `server/src/test/unit/validate-git-source.test.js`
- Test: `server/src/test/unit/webhook-signature.test.js`

**Interfaces:**
- Produces:
  - `config.git = { bin: string, timeoutMs: number, staleSyncMs: number }`
  - `validateGitUrl(url, { allowFile = false } = {}): string | null` (error message or null)
  - `normalizeGitUrl(url): string` (lowercase, strip trailing `/`, strip `.git`)
  - `validateGitBranch(branch): string | null`
  - `verifyWebhookSignature(rawBody: Buffer|string, secret: string, header: string|undefined): boolean`

- [ ] **Step 1: Write the failing validation tests**

`validate-git-source.test.js` must assert:

```js
assert.equal(validateGitUrl('https://github.com/foXerw/personal-blog'), null);
assert.equal(validateGitUrl('https://github.com/foXerw/personal-blog.git'), null);
assert.match(validateGitUrl('http://github.com/a/b'), /https/);
assert.match(validateGitUrl('git@github.com:a/b.git'), /https/);
assert.match(validateGitUrl('file:///tmp/repo'), /https/);
assert.match(validateGitUrl('--upload-pack=evil'), /https/);
assert.match(validateGitUrl('https://github.com/a/b\nrm -rf /'), /invalid/i);
assert.equal(validateGitUrl('file:///tmp/repo', { allowFile: true }), null);
assert.equal(validateGitBranch('main'), null);
assert.equal(validateGitBranch('release/1.2'), null);
assert.match(validateGitBranch('-x'), /invalid/i);
assert.match(validateGitBranch('a..b'), /invalid/i);
assert.equal(normalizeGitUrl('https://GitHub.com/FoXerw/Personal-Blog.git/'), 'https://github.com/foxerw/personal-blog');
```

`webhook-signature.test.js`: compute a correct header with `crypto.createHmac('sha256', 'secret').update(body).digest('hex')`, assert `verifyWebhookSignature` returns true with `sha256=<hex>`, false for wrong hex, missing header, wrong prefix, and a different body.

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && node --test src/test/unit/validate-git-source.test.js src/test/unit/webhook-signature.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`validateGitUrl`: reject non-string, leading `-`, control/whitespace characters. Accept `/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._~%\-/@]+(?:\.git)?$/`. When `allowFile`, also accept `/^file:\/\/\/.+$/`.

`validateGitBranch`: `/^[A-Za-z0-9._/-]{1,200}$/`, not starting with `-` or `/`, and no `..`.

`normalizeGitUrl`: `url.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '')`.

`verifyWebhookSignature`: header must start with `sha256=`; compute the HMAC over the raw body; compare equal-length buffers with `crypto.timingSafeEqual`.

Config additions after the PM2 block:

```js
git: {
  bin: process.env.GIT_BIN || 'git',
  timeoutMs: intFromEnv('GIT_TIMEOUT_MS', 120000),
  staleSyncMs: intFromEnv('GIT_STALE_SYNC_MS', 30 * 60 * 1000)
}
```

- [ ] **Step 4: Run the tests**

Run: `cd server && node --test src/test/unit/validate-git-source.test.js src/test/unit/webhook-signature.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/config/index.js server/src/utils/validate-git-source.js server/src/utils/webhook-signature.js server/src/test/unit/validate-git-source.test.js server/src/test/unit/webhook-signature.test.js
git commit -m "feat(git): validate repo sources and verify webhook signatures"
```

---

### Task 4: GitLifecycle repository primitives

**Files:**
- Create: `server/src/services/git-lifecycle.js`
- Test: `server/src/test/unit/git-lifecycle-repo.test.js`

**Interfaces:**
- Produces:
  - `GitLifecycle.gitExec(args, { cwd, timeoutMs } = {}): Promise<{ stdout, stderr }>`
  - `GitLifecycle.hasRepo(appPath): boolean`
  - `GitLifecycle.ensureRepo(appPath, { url, branch }): Promise<{ cloned: boolean, commit: string }>`
  - `GitLifecycle.currentHead(appPath): Promise<string>`
  - `GitLifecycle.fetchHead(appPath, branch): Promise<string>` — fetch then `rev-parse FETCH_HEAD`
  - `GitLifecycle.remoteHead({ url, branch }): Promise<string | null>` — `ls-remote --heads`

- [ ] **Step 1: Write the failing repo tests**

Create a helper in the test that builds a source repo with `gitExec`:

```js
function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one');
  return [
    ['init', '-q'],
    ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'add', '.'],
    ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-qm', 'one'],
  ].reduce((p, args) => p.then(() => GitLifecycle.gitExec(args, { cwd: dir })), Promise.resolve());
}
```

Tests:

```js
test('ensureRepo clones into a non-empty app dir and reports the commit', async () => {
  const src = path.join(tmp, 'src');
  await makeRepo(src);
  const appDir = path.join(tmp, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'existing.txt'), 'keep');
  const { commit } = await GitLifecycle.ensureRepo(appDir, { url: 'file://' + src.replace(/\\/g, '/'), branch: 'main' });
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.equal(fs.readFileSync(path.join(appDir, 'a.txt'), 'utf8'), 'one');
  assert.equal(fs.readFileSync(path.join(appDir, 'existing.txt'), 'utf8'), 'keep');
});

test('fetchHead returns a new commit after the source advances', async () => {
  // commit 'two' in src, then fetchHead -> different sha, and reset --hard later sees 'two'
});

test('remoteHead returns the branch sha without cloning', async () => {
  // assert sha matches currentHead(src)
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test src/test/unit/git-lifecycle-repo.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the primitives**

- `gitExec` uses `execFilePromise(config.git.bin, args, { cwd, timeout: timeoutMs || config.git.timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })`. Errors become `Error('git ' + args[0] + ' failed: ' + (err.stderr || err.message).slice(-500))`.
- Add a private `assertSafeArg(value)` rejecting values starting with `-` or containing control characters; use it for `url` and `branch`.
- `ensureRepo`: if no `.git`, `git init -q`; then `git remote get-url origin` (ignore failure), `git remote add origin <url>` or `git remote set-url origin <url>`; `git fetch --depth 1 origin <branch>`; `git checkout -B <branch> FETCH_HEAD`; return `{ cloned: !hadRepo, commit: await currentHead(appPath) }`.
- `fetchHead`: `git fetch --depth 1 origin <branch>` then `git rev-parse FETCH_HEAD` trimmed.
- `remoteHead`: `git ls-remote --heads <url> refs/heads/<branch>`, parse the first field; return null when empty.

- [ ] **Step 4: Run the tests**

Run: `cd server && node --test src/test/unit/git-lifecycle-repo.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/git-lifecycle.js server/src/test/unit/git-lifecycle-repo.test.js
git commit -m "feat(git): add clone/fetch primitives"
```

---

### Task 5: Sync pipeline with rollback and cross-worker claim

**Files:**
- Modify: `server/src/services/npm-lifecycle.js` (add `ensureBuilt`)
- Modify: `server/src/services/deploy-manager.js` (replace inline npm block with `ensureBuilt`)
- Modify: `server/src/services/git-lifecycle.js`
- Test: `server/src/test/unit/git-lifecycle-sync.test.js`
- Test: `server/src/test/unit/npm-deploy-skip.test.js` (regression only)

**Interfaces:**
- Consumes: Task 2 queries, Task 4 primitives, `NpmLifecycle.install/build/needsInstall/needsBuild`, `ProcessManager.getProcessStatus/restartProcess`.
- Produces:
  - `NpmLifecycle.ensureBuilt(appId, appPath): Promise<void>`
  - `GitLifecycle.check(app, source): Promise<{ remoteCommit, deployedCommit, upToDate }>`
  - `GitLifecycle.sync(app, { reason } = {}): Promise<{ status, deployedCommit, error }>` — `status` is `busy | up-to-date | success | failed`
  - `GitLifecycle.pull(app): Promise<{ status, deployedCommit, error }>`
  - `GitLifecycle.isSyncInProgress(appId): Promise<boolean>` (fresh claim only)
  - `GitLifecycle.assertNotSyncing(appId): Promise<void>` (throws `Error('Update in progress')`)

- [ ] **Step 1: Write the failing sync tests**

`git-lifecycle-sync.test.js` uses temp repos and mocks. Cases:

```js
test('sync updates files, stores the commit, and restarts a running npm app', async () => {
  // app: npm + git source with deployed_commit = old sha
  // mock ProcessManager.getProcessStatus -> { exists: true, status: 'online' }
  // mock ProcessManager.restartProcess to record the call
  // mock NpmLifecycle.ensureBuilt to resolve
  // add commit 'two' to src; await GitLifecycle.sync(app)
  // assert status 'success', file content 'two', restart called once,
  //        getAppGitSource.deployed_commit === new sha
});

test('sync does not restart when the app was stopped during the build', async () => {
  // getProcessStatus first call online (wasRunning), second call online=false OR
  // queries.updateAppStatus('stopped') from the ensureBuilt mock
  // assert restartProcess not called
});

test('build failure rolls back to the previous commit and stores failed', async () => {
  // ensureBuilt throws 'build failed: boom'
  // assert currentHead === prev sha, source.last_status 'failed',
  //        last_error contains 'boom', deployed_commit stays prev
});

test('restart failure keeps the new commit and reports failed', async () => {
  // ensureBuilt resolves, restartProcess throws
  // assert deployed_commit === new sha, last_status 'failed'
});

test('a same-SHA sync is up-to-date and runs no install/build', async () => {
  // ensureBuilt mock records calls; assert 0 and status 'up-to-date'
});

test('second sync is busy while the first claim is fresh', async () => {
  // claim directly, then GitLifecycle.sync -> status 'busy'
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test src/test/unit/git-lifecycle-sync.test.js`
Expected: FAIL — `sync` / `ensureBuilt` not defined.

- [ ] **Step 3: Extract `NpmLifecycle.ensureBuilt`**

Move the existing install/build block from `DeployManager.deployApp` verbatim into:

```js
static async ensureBuilt(appId, appPath) {
  const state = await queries.getAppDeployState(appId);
  const mustInstall = this.needsInstall(appPath, state && state.install_fp);
  if (mustInstall) {
    await this.install(appPath);
    await queries.setUpDeployState(appId, { installFp: this.installFingerprint(appPath) });
  }
  if (mustInstall || this.needsBuild(appPath, state && state.build_fp)) {
    await this.build(appPath);
    await queries.setUpDeployState(appId, { buildFp: this.buildFingerprint(appPath) });
  }
}
```

Replace the inline block in `DeployManager.deployApp` with `await NpmLifecycle.ensureBuilt(appId, app.path);`. Run `npm-deploy-skip.test.js` to confirm no behavior change.

- [ ] **Step 4: Implement `check` and `sync`**

`check(app, source)` returns `deployedCommit = source.deployed_commit`, `remoteCommit = await remoteHead(source)`, `upToDate = remoteCommit === deployedCommit`; on `ls-remote` failure throw a readable error.

`sync(app, { reason = 'manual' } = {})` reads the source row itself (`queries.getAppGitSource(app.id)`, returns `{ status: 'failed', error: 'Not a Git-sourced app' }` when absent):

1. If `!(await queries.claimGitSync(app.id, config.git.staleSyncMs))` → `{ status: 'busy' }`.
2. Read `wasRunning` from `ProcessManager.getProcessStatus(app.name)` (PM2 unreachable → DB `app.status === 'running'`).
3. `ensureRepo` if needed; `newSha = await fetchHead(app.path, source.branch)`.
4. If `newSha === source.deployed_commit` → finish `success` and return `up-to-date`.
5. `prevSha = await currentHead(app.path)`.
6. `git reset --hard FETCH_HEAD`, `git clean -fd` (never `-x`).
7. If `app.deploy_type === 'npm'` → `await NpmLifecycle.ensureBuilt(app.id, app.path)`.
8. On success: re-check running (`getProcessStatus` online); if `wasRunning && stillRunning && deploy_type === 'npm'` → `restartProcess`. Then `finishGitSync(success, deployedCommit=newSha)`. If restart throws: `finishGitSync(failed, error='Restart failed: ...', deployedCommit=newSha)`, return failed — **no rollback**.
9. On build/git error: `git reset --hard prevSha`, best-effort `ensureBuilt` again (npm only), `finishGitSync(failed, error, deployedCommit=prevSha)`, return failed.
10. Wrap the whole claimed section in `try/finally`; `finishGitSync` clears `sync_started_at`.
11. After a success, if the source's `remote_commit` is set and differs from `newSha`, loop once more (max 3 attempts) — this coalesces a webhook that landed on another worker mid-build.

`isSyncInProgress(appId)`: read the row; true only when `last_status === 'updating'` and `sync_started_at` is newer than `Date.now() - config.git.staleSyncMs` (parse SQLite UTC as `new Date(row.sync_started_at + 'Z')`). `assertNotSyncing` throws when true.

- [ ] **Step 5: Run the sync + regression tests**

Run: `cd server && node --test src/test/unit/git-lifecycle-sync.test.js src/test/unit/npm-deploy-skip.test.js src/test/unit/npm-fingerprints.test.js`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/npm-lifecycle.js server/src/services/deploy-manager.js server/src/services/git-lifecycle.js server/src/test/unit/git-lifecycle-sync.test.js
git commit -m "feat(git): sync repos with fingerprint-gated rebuild and rollback"
```

---

### Task 6: Start integration and lifecycle guards

**Files:**
- Modify: `server/src/services/git-lifecycle.js` (`prepareForStart`)
- Modify: `server/src/services/deploy-manager.js` (`deployApp`, `restartApp`, `deleteApp`)
- Modify: `server/src/routes/apps.js` (409 mapping on start/restart/delete)
- Test: `server/src/test/unit/git-start.test.js`

**Interfaces:**
- Produces:
  - `GitLifecycle.prepareForStart(app, source): Promise<{ commit: string, warning: string|null }>`
  - `DeployManager.deployApp(appId)` claims the sync row before install/build and releases it after start.
  - All of Start/Restart/Delete throw `Error('Update in progress')` when `assertNotSyncing` is fresh.

- [ ] **Step 1: Write the failing tests**

`git-start.test.js` mocks `GitLifecycle.prepareForStart`, `ProcessManager.startProcess`, `ProcessManager.getProcessStatus`, `ProxyManager.regenerate`, and `NpmLifecycle.ensureBuilt`.

```js
test('start claims and releases the git source on success', async () => {
  // app with git source; prepareForStart resolves { commit: 'sha1', warning: null }
  // await DeployManager.deployApp(app.id)
  // assert source.last_status 'success', deployed_commit 'sha1', sync_started_at null
});

test('start releases the claim as failed when prepareForStart throws', async () => {
  // prepareForStart rejects 'git clone failed'; assert last_status 'failed'
});

test('start still starts when fetch failed but a checkout exists', async () => {
  // prepareForStart resolves { commit: 'sha1', warning: 'fetch failed' }
  // assert startProcess called and last_status 'success'
});

test('start/restart/delete reject a fresh updating claim', async () => {
  // claimGitSync directly, then assert DeployManager.deployApp/restartApp/deleteApp reject /Update in progress/
});

test('an expired updating claim does not block start', async () => {
  // set sync_started_at 2 hours ago; deployApp succeeds
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test src/test/unit/git-start.test.js`
Expected: FAIL — deploy does not touch the git source.

- [ ] **Step 3: Implement `prepareForStart`**

```js
static async prepareForStart(app, source) {
  if (!this.hasRepo(app.path)) {
    const { commit } = await this.ensureRepo(app.path, source); // clone is mandatory
    return { commit, warning: null };
  }
  if (!source.auto_update) {
    return { commit: await this.currentHead(app.path), warning: null };
  }
  try {
    const commit = await this.fetchHead(app.path, source.branch);
    await this.gitExec(['reset', '--hard', 'FETCH_HEAD'], { cwd: app.path });
    await this.gitExec(['clean', '-fd'], { cwd: app.path });
    return { commit, warning: null };
  } catch (err) {
    return { commit: await this.currentHead(app.path), warning: `fetch failed: ${err.message}` };
  }
}
```

- [ ] **Step 4: Wire `deployApp`**

First move the existing `if (app.status === 'running') throw new Error('App is already running')` check **above** the Git phase (a start must not fetch/reset files under a live process). Then, after `reconcileStatus` and before `validateAppDeployment`, claim the source and hold the claim through the entire start:

```js
const source = await queries.getAppGitSource(appId);
let gitClaimed = false;
let gitCommit = null;
if (source) {
  gitClaimed = await queries.claimGitSync(appId, config.git.staleSyncMs);
  if (!gitClaimed) throw new Error('Update in progress');
  try {
    const prepared = await GitLifecycle.prepareForStart(app, source);
    gitCommit = prepared.commit;
    if (prepared.warning) console.warn(`[git] ${app.name}: ${prepared.warning}`);
  } catch (err) {
    await queries.finishGitSync(appId, { status: 'failed', error: err.message });
    throw err;
  }
}
try {
  // existing validate -> port -> ensureBuilt -> startProcess -> updateAppStatus -> proxy
  if (gitClaimed) await queries.finishGitSync(appId, { status: 'success', deployedCommit: gitCommit });
  return AppManager.getAppById(appId);
} catch (err) {
  if (gitClaimed) await queries.finishGitSync(appId, { status: 'failed', error: err.message, deployedCommit: gitCommit });
  throw err;
}
```

Do **not** call `finishGitSync` inside the prepare block; it clears the claim, and the rest of the start must still own the directory. The claim is released exactly once, in the success/error paths above.

- [ ] **Step 5: Add guards**

- `deployApp`: the claim itself rejects concurrent Start.
- `restartApp`: `await GitLifecycle.assertNotSyncing(appId);` after `reconcileStatus`.
- `deleteApp`: `await GitLifecycle.assertNotSyncing(appId);` before `reconcileStatus` (add `deleteFiles` passthrough here).
- Routes: map `error.message === 'Update in progress'` to 409 in start/restart/delete.

- [ ] **Step 6: Run the tests**

Run: `cd server && node --test src/test/unit/git-start.test.js src/test/unit/deploy-status-reconcile.test.js src/test/unit/delete-app-files.test.js`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/git-lifecycle.js server/src/services/deploy-manager.js server/src/routes/apps.js server/src/test/unit/git-start.test.js
git commit -m "feat(git): pull on start and guard lifecycle ops during sync"
```

---

### Task 7: Create-with-Git, upload guard, and `.git` handling

**Files:**
- Modify: `server/src/services/app-manager.js` (`createApp`, `getAppFiles`)
- Modify: `server/src/routes/apps.js` (`POST /apps`, `POST /apps/:id/upload`)
- Modify: `server/src/utils/stale-files.js`
- Modify: `server/src/services/backup-manager.js` (`createBackup`)
- Test: `server/src/test/unit/create-app-git.test.js`
- Test: `server/src/test/unit/git-app-files.test.js`

**Interfaces:**
- Consumes: Task 2 queries, Task 3 validators.
- Produces:
  - `AppManager.createApp(name, deployType, gitOptions = null)` where `gitOptions = { url, branch = 'main', autoUpdate = true }`
  - `POST /api/apps` accepts optional `git_url`, `git_branch`, `git_auto_update`
  - Uploads to a Git-sourced app return 400 `Git source apps must be updated from the repository`
  - `.git` is preserved by `staleFilesToRemove`, hidden by `getAppFiles`, excluded from backups

- [ ] **Step 1: Write the failing tests**

`create-app-git.test.js`:

```js
test('createApp with gitOptions inserts the source in one call', async () => {
  const app = await AppManager.createApp('create-git-a', 'npm', { url: 'https://github.com/o/r', branch: 'main', autoUpdate: true });
  assert.equal(app.git.url, 'https://github.com/o/r');
  assert.equal(app.git.auto_update, 1);
  assert.match(app.git.webhook_secret, /^[0-9a-f]{64}$/);
});

test('invalid git URL rejects before creating an app', async () => {
  await assert.rejects(() => AppManager.createApp('create-git-b', 'npm', { url: 'file:///tmp/x' }), /https/);
  assert.equal(await queries.getAppByName('create-git-b'), undefined);
});

test('failed source insert does not delete a pre-existing non-empty directory', async () => {
  const dir = pathHelper.getAppDir('create-git-c');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
  // force the source insert to fail by stubbing queries.upsertAppGitSource to reject
  await assert.rejects(() => AppManager.createApp('create-git-c', 'npm', { url: 'https://github.com/o/r' }));
  assert.equal(fs.existsSync(path.join(dir, 'keep.txt')), true);
});
```

`git-app-files.test.js`: create an app with git source; write `.git/HEAD` and `index.html`; assert `getAppFiles` has no `.git`; `staleFilesToRemove(app, ['.git','index.html','node_modules'], ['x.zip'])` keeps `.git`; `BackupManager.createBackup` zip has no entry containing `.git`; upload route returns 400.

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && node --test src/test/unit/create-app-git.test.js src/test/unit/git-app-files.test.js`
Expected: FAIL.

- [ ] **Step 3: Extend `createApp`**

Validate optional git fields (`validateGitUrl` / `validateGitBranch`). Record `dirExisted` and `dirWasEmpty` before `ensureDir`. Insert the app, then `upsertAppGitSource` with `crypto.randomBytes(32).toString('hex')` as the secret. On source-insert failure: `queries.deleteApp(id)`; remove the directory **only if `!dirExisted || dirWasEmpty`**; rethrow.

`POST /apps` passes `git_url ? { url: git_url, branch: git_branch || 'main', autoUpdate: git_auto_update !== false } : null`.

- [ ] **Step 4: Implement upload/list/backup/stale handling**

- Upload route: before setting `req.uploadPath`, `if (await queries.getAppGitSource(app.id)) return 400`.
- `staleFilesToRemove`'s `platformManagedNames` set adds `'.git'`.
- `getAppFiles` filters `file.name === '.git'`.
- `BackupManager.createBackup`: `zip.addLocalFolder(app.path, 'files', (entryPath) => !entryPath.split(/[\\/]/).includes('.git'))`.

- [ ] **Step 5: Run the tests**

Run: `cd server && node --test src/test/unit/create-app-git.test.js src/test/unit/git-app-files.test.js src/test/unit/flatten-zip-root.test.js src/test/unit/backup-manifest.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/app-manager.js server/src/routes/apps.js server/src/utils/stale-files.js server/src/services/backup-manager.js server/src/test/unit/create-app-git.test.js server/src/test/unit/git-app-files.test.js
git commit -m "feat(git): bind repos on create and protect .git"
```

---

### Task 8: Protected Git API routes

**Files:**
- Create: `server/src/routes/git.js`
- Modify: `server/src/routes/index.js`
- Test: `server/src/test/integration/git-routes.test.js`

**Interfaces:**
- Consumes: Task 2 queries, Task 3 validators, Task 5 `check/pull`, Task 6 guards.
- Produces (all admin-only, mounted after `appsRouter`):
  - `GET /api/apps/:id/git`
  - `PUT /api/apps/:id/git` body `{ url, branch?, autoUpdate? }`
  - `DELETE /api/apps/:id/git`
  - `POST /api/apps/:id/git/secret`
  - `POST /api/apps/:id/git/check`
  - `POST /api/apps/:id/git/pull`

- [ ] **Step 1: Write the failing integration tests**

`git-routes.test.js` uses `adminAgent()` and mocks `GitLifecycle.pull`/`check`.

```js
test('PUT then GET returns url, branch, auto update, webhook url and secret', async () => {
  const app = await AppManager.createApp('routes-git-a', 'npm');
  const agent = await adminAgent();
  const put = await agent.put(`/api/apps/${app.id}/git`).send({ url: 'https://github.com/o/r', branch: 'main', autoUpdate: true }).expect(200);
  assert.match(put.body.data.webhookSecret, /^[0-9a-f]{64}$/);
  const get = await agent.get(`/api/apps/${app.id}/git`).expect(200);
  assert.match(get.body.data.webhookUrl, new RegExp(`/api/webhooks/github/${app.id}$`));
});

test('changing the URL or branch clears deployed progress', async () => {
  // seed source with deployed_commit 'old'; PUT a new URL
  // assert deployedCommit null, lastStatus 'idle', remoteCommit null
});

test('PUT rejects a non-https URL', async () => {
  await agent.put(`/api/apps/${app.id}/git`).send({ url: 'ssh://x/y' }).expect(400);
});

test('pull returns 409 while a fresh claim exists', async () => {
  // claim directly; POST pull -> 409
});

test('unbind keeps the app and its files', async () => {
  // DELETE git; assert 200, app still exists, source undefined
});

test('rotating the secret returns a different value', async () => {
  // POST secret twice; assert different
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test src/test/integration/git-routes.test.js`
Expected: FAIL — 404 for `/api/apps/:id/git`.

- [ ] **Step 3: Implement the router**

- `GET`: 404 when no source; build `webhookUrl` from `${req.protocol}://${req.get('host')}/api/webhooks/github/${app.id}`; return camelCase fields plus `webhookSecret`.
- `PUT`: require `url`; validate; if new source → generate a 32-byte hex secret and insert; else update. If URL or branch changed → `resetGitSourceProgress`; auto-update-only change → `setGitAutoUpdate`. Return the GET shape.
- `DELETE`: `deleteAppGitSource`; return `{ success: true }`.
- `POST /secret`: regenerate and return the GET shape.
- `POST /check`: `GitLifecycle.check(app, source)`.
- `POST /pull`: call `GitLifecycle.pull(app)`; `busy` → 409, `failed` → 400 with `error`.
- Map `App not found` → 404, `Update in progress` → 409, validation messages → 400.
- Mount `router.use(gitRouter)` after `appsRouter` in `routes/index.js` (inside the protected section).

- [ ] **Step 4: Run the tests**

Run: `cd server && node --test src/test/integration/git-routes.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/git.js server/src/routes/index.js server/src/test/integration/git-routes.test.js
git commit -m "feat(git): expose repo binding and manual sync endpoints"
```

---

### Task 9: GitHub webhook endpoint

**Files:**
- Create: `server/src/routes/webhooks.js`
- Modify: `server/src/middleware/rate-limit.js` (add `webhookLimiter`)
- Modify: `server/src/app.js` (trust proxy ordering + raw-body mount)
- Modify: `server/src/services/git-lifecycle.js` (`triggerBackgroundSync`)
- Test: `server/src/test/integration/github-webhook.test.js`

**Interfaces:**
- Consumes: Task 2 queries, Task 3 signature util, Task 5 `sync`.
- Produces:
  - `webhookLimiter` (120/min/IP)
  - `POST /api/webhooks/github/:appId` with responses: 200 ping, 204 non-push, 202 accepted/ignored, 400 malformed JSON, 401 bad signature, 404 unknown app/source, 429 rate-limited
  - `GitLifecycle.triggerBackgroundSync(appId): void` — fire-and-forget; logs and records failures in the DB via `sync`.

- [ ] **Step 1: Write the failing webhook tests**

`github-webhook.test.js` (use `request()` without auth; create app + source via services):

```js
function sign(body, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}
const payload = (over = {}) => Buffer.from(JSON.stringify({
  ref: 'refs/heads/main',
  after: 'a'.repeat(40),
  repository: { clone_url: 'https://github.com/o/r.git', html_url: 'https://github.com/o/r' },
  ...over,
}));

test('ping returns 200', ...);
test('non-push event returns 204', ...);
test('bad signature returns 401', ...);
test('wrong repo or branch returns 202 ignored and records nothing', ...);
test('valid push with auto_update=0 records update_available and does not sync', ...);
test('valid push with auto_update=1 calls sync once', ...); // mock GitLifecycle.sync or spy triggerBackgroundSync
test('duplicate delivery of the same SHA is idempotent', ...); // sync sees same head -> up-to-date; assert no second build
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test src/test/integration/github-webhook.test.js`
Expected: FAIL — 404 for `/api/webhooks/github/:id`.

- [ ] **Step 3: Implement the limiter and mount**

`middleware/rate-limit.js` adds:

```js
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { message: 'Too many webhook requests' } }
});
```

In `createApp()` (`server/src/app.js`): move `app.set('trust proxy', 1)` above the route mounts, then **before** `app.use(express.json())`:

```js
const webhookRouter = require('./routes/webhooks');
app.use('/api/webhooks', webhookLimiter, express.raw({ type: 'application/json', limit: '2mb' }), webhookRouter);
```

Keep `app.use('/api', routes)` after `express.json()` so protected routes are unchanged.

- [ ] **Step 4: Implement the handler**

Order: event header → ping/non-push → load app + source (404) → signature (401) → JSON parse (400) → repo/branch match (202 ignored, no DB write) → `setGitRemoteCommit(after)` → auto on: `triggerBackgroundSync(app.id)`, 202; auto off: `markGitUpdateAvailable(app.id, config.git.staleSyncMs)`, 202.

Never `await` sync in the request. `triggerBackgroundSync` catches everything and logs `[git] background sync failed for <app>: <message>`.

- [ ] **Step 5: Run the tests**

Run: `cd server && node --test src/test/integration/github-webhook.test.js src/test/integration/rate-limit-api.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/webhooks.js server/src/middleware/rate-limit.js server/src/app.js server/src/services/git-lifecycle.js server/src/test/integration/github-webhook.test.js
git commit -m "feat(git): trigger syncs from signed GitHub push webhooks"
```

---

### Task 10: Frontend delete-files checkbox

**Files:**
- Modify: `client/src/api/apps.js` (`deleteApp`)
- Modify: `client/src/pages/Dashboard.jsx` (`handleDelete`)
- Modify: `client/src/components/AppRow.jsx` (delete modal)
- Modify: `client/src/i18n/locales/zh.json`, `en.json`
- Verify: lint + build

**Interfaces:**
- Produces: `deleteApp(id, deleteFiles = false)` sends `?deleteFiles=true`; `onDelete(appId, deleteFiles)`.

- [ ] **Step 1: Update the API client**

```js
export const deleteApp = async (id, deleteFiles = false) => {
  const response = await api.delete(`/apps/${id}`, {
    params: deleteFiles ? { deleteFiles: true } : {}
  })
  return response.data.data
}
```

- [ ] **Step 2: Replace the delete `Popconfirm` in `AppRow.jsx`**

Add `deleteOpen` and `deleteFiles` state. The delete button opens a `Modal` with:

- title `t('appCard.deleteTitle')`
- body: `t('appCard.deleteConfirm')`, a `<Checkbox checked={deleteFiles} onChange={e => setDeleteFiles(e.target.checked)}>` labeled `t('appCard.deleteFilesLabel')`, and a warning line shown only when checked (`t('appCard.deleteFilesWarning')`).
- `onOk={() => { setDeleteOpen(false); onDelete(app.id, deleteFiles); setDeleteFiles(false) }}`, `okButtonProps={{ danger: true }}`, `disabled` while running.

- [ ] **Step 3: Update Dashboard**

`handleDelete = async (appId, deleteFiles) => { await deleteApp(appId, deleteFiles); ... }` and pass it through unchanged.

- [ ] **Step 4: Add i18n strings**

zh:

```json
"deleteFilesLabel": "同时删除应用文件",
"deleteFilesWarning": "文件不可恢复，建议先备份。"
```

en:

```json
"deleteFilesLabel": "Also delete app files",
"deleteFilesWarning": "Files cannot be recovered. Back up first if unsure."
```

- [ ] **Step 5: Verify**

Run: `cd client && npm run lint && npm run build`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add client/src/api/apps.js client/src/pages/Dashboard.jsx client/src/components/AppRow.jsx client/src/i18n/locales/zh.json client/src/i18n/locales/en.json
git commit -m "feat(client): offer optional app-file deletion"
```

---

### Task 11: Frontend Git API client and Create form

**Files:**
- Modify: `client/src/api/apps.js`
- Modify: `client/src/pages/CreateApp.jsx`
- Modify: `client/src/i18n/locales/zh.json`, `en.json`
- Verify: lint + build

**Interfaces:**
- Produces:
  - `getAppGit(id)`
  - `bindAppGit(id, { url, branch, autoUpdate })` (PUT)
  - `unbindAppGit(id)` (DELETE)
  - `rotateAppGitSecret(id)` (POST)
  - `checkAppGit(id)` (POST)
  - `pullAppGit(id)` (POST, `timeout: 0`)
  - `createApp(name, deployType, git)` sends `git_url` / `git_branch` / `git_auto_update`

- [ ] **Step 1: Add the API functions**

Follow the existing axios patterns. `pullAppGit` must pass `{ timeout: 0 }`; the others keep the default.

- [ ] **Step 2: Extend CreateApp**

Use `const gitUrl = Form.useWatch('git_url', form)`. After the deploy-type item add:

- `git_url` Input (`placeholder` `https://github.com/user/repo`, optional).
- When `gitUrl` is non-empty: `git_branch` Input with initial value `main`, and `git_auto_update` Switch (`valuePropName="checked"`) with initial value `true`.
- Submit: `createApp(values.name, values.deploy_type, values.git_url ? { url: values.git_url, branch: values.git_branch || 'main', autoUpdate: values.git_auto_update !== false } : null)`.

- [ ] **Step 3: Add i18n strings**

Keys: `createApp.gitSection`, `createApp.gitUrl`, `createApp.gitUrlPlaceholder`, `createApp.gitBranch`, `createApp.gitAutoUpdate`, `createApp.gitHelp` with concise zh/en values (e.g. 自动更新：仓库有新提交时自动拉取、构建并重启。).

- [ ] **Step 4: Verify**

Run: `cd client && npm run lint && npm run build`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add client/src/api/apps.js client/src/pages/CreateApp.jsx client/src/i18n/locales/zh.json client/src/i18n/locales/en.json
git commit -m "feat(client): bind a Git source when creating an app"
```

---

### Task 12: GitModal, app-row integration, and upload guard

**Files:**
- Create: `client/src/components/GitModal.jsx`
- Modify: `client/src/components/AppRow.jsx`
- Modify: `client/src/pages/Dashboard.jsx`
- Modify: `client/src/pages/UploadFiles.jsx`
- Modify: `client/src/i18n/locales/zh.json`, `en.json`
- Verify: lint + build

**Interfaces:**
- Consumes: Task 11 API functions; app objects now carry `git`.
- Produces: `GitModal({ open, app, onClose, onChanged })`.

- [ ] **Step 1: Build `GitModal`**

On open, call `getAppGit(app.id)` and populate URL/branch/auto-update. Render:

- Form fields (URL, branch, auto-update) + Save (`bindAppGit`) + Unbind (`Modal.confirm` → `unbindAppGit`).
- Status block: deployed commit (short SHA, full in `title`), `remoteCommit`, `syncedAt`, `lastStatus` (translated), `lastError` (red text).
- Webhook block: read-only Input with `webhookUrl`, a masked secret Input with a show/hide toggle and copy button, and "Regenerate secret" (confirm → `rotateAppGitSecret`).
- Buttons: "Check for updates" (`checkAppGit`, show whether up to date), "Pull update" (`pullAppGit` with a loading state, then refresh status and call `onChanged`).
- Error handling uses Ant Design `message.error` with the server message.

- [ ] **Step 2: Integrate into AppRow**

- Add a Git button (`t('appCard.git')`) that opens `GitModal` (`onChanged` → `onRefresh` prop).
- When `app.git` exists: show `git · <first 7 chars>` under the name, show a small badge when `last_status === 'update_available'`, and hide the Upload button.
- Add `onRefresh` to the AppRow props and pass `loadApps(true)` from Dashboard.
- Dashboard: import `pullAppGit` only if a quick action is added; otherwise no extra handler.

- [ ] **Step 3: UploadFiles guard**

If `app.git`, render a notice (`t('upload.gitDisabled')`) and do not render the upload form.

- [ ] **Step 4: Add i18n strings**

zh/en for: `appCard.git`, `appCard.gitUpdateAvailable`, `git.title`, `git.url`, `git.branch`, `git.autoUpdate`, `git.save`, `git.unbind`, `git.unbindConfirm`, `git.webhookUrl`, `git.webhookSecret`, `git.copy`, `git.show`, `git.hide`, `git.regenerate`, `git.regenerateConfirm`, `git.check`, `git.pull`, `git.pulling`, `git.status`, `git.deployedCommit`, `git.remoteCommit`, `git.syncedAt`, `git.lastError`, `git.notBound`, `git.saveSuccess`, `git.pullSuccess`, `git.pullFailed`, `git.checkUpToDate`, `git.checkBehind`, `upload.gitDisabled`, and status labels (`git.statusLabels.idle|updating|success|failed|update_available`).

- [ ] **Step 5: Verify**

Run: `cd client && npm run lint && npm run build`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/GitModal.jsx client/src/components/AppRow.jsx client/src/pages/Dashboard.jsx client/src/pages/UploadFiles.jsx client/src/i18n/locales/zh.json client/src/i18n/locales/en.json
git commit -m "feat(client): manage Git sources and sync status"
```

---

### Task 13: Docs, OpenAPI, and full verification

**Files:**
- Modify: `CLAUDE.md`
- Modify: `server/src/docs/openapi.yaml`
- Modify: `.env.example`
- Verify: full server tests, client lint, client build

**Interfaces:**
- Documents: `app_git_source`, `GitLifecycle`, webhook endpoint/security, `app_git_source` API, `deleteFiles`, `GIT_BIN` / `GIT_TIMEOUT_MS` / `GIT_STALE_SYNC_MS`, GitHub webhook setup steps.

- [ ] **Step 1: Update CLAUDE.md**

Add to the services list: `GitLifecycle` (clone/fetch/sync/rollback, DB-claimed single-flight, webhook). Add to API endpoints: the six `/git` endpoints, webhook, DELETE query. Add to config: `GIT_BIN`, `GIT_TIMEOUT_MS`, `GIT_STALE_SYNC_MS`. Add a note that git apps reject uploads and `.git` is excluded from backups/listings. Add the GitHub webhook setup (payload URL `/api/webhooks/github/<appId>`, content type JSON, secret from GitModal, push events only).

- [ ] **Step 2: Update OpenAPI**

Add `AppGitSource` schema; add paths for GET/PUT/DELETE `/api/apps/{id}/git`, POST `/git/secret`, `/git/check`, `/git/pull`, and the public webhook; add `deleteFiles` query param to DELETE `/api/apps/{id}`. Keep the existing `{ success, data|error }` envelope.

- [ ] **Step 3: Update `.env.example`**

```bash
# Git source deploys (see CLAUDE.md)
# GIT_BIN=git
# GIT_TIMEOUT_MS=120000
# GIT_STALE_SYNC_MS=1800000
```

- [ ] **Step 4: Run everything**

```bash
cd server && npm test
cd ../client && npm run lint && npm run build
```

Expected: all server tests pass; lint and build succeed.

- [ ] **Step 5: Manual end-to-end with the blog (documented in the commit/PR notes)**

1. Create an `npm` app named `blog` with Git URL `https://github.com/foXerw/personal-blog`.
2. Start it; confirm install/build/start succeed.
3. Copy the webhook URL + secret from GitModal into GitHub → Settings → Webhooks (push only).
4. Push a new post; watch `lastStatus` move `updating` → `success` and the site show the post.
5. Push a commit that breaks the build; confirm `lastStatus=failed`, the site still serves the previous version, and `deployed_commit` stayed on the old SHA.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md server/src/docs/openapi.yaml .env.example
git commit -m "docs: document git-source deploys and optional file deletion"
```

---

## Plan self-review

- **Spec coverage:** delete option (Task 1/10), `app_git_source` (Task 2), validation/signature (Task 3), clone/fetch (Task 4), sync/rollback/claim (Task 5), start/guards (Task 6), create/upload/backup/file listing (Task 7), protected routes (Task 8), webhook (Task 9), frontend (Tasks 10-12), docs/verification (Task 13). Not covered by code: private repos, git subdirectories, GitHub Actions artifacts — all explicit non-goals.
- **Type consistency:** `claimGitSync(appId, staleMs)`, `finishGitSync(appId, { status, error, deployedCommit, remoteCommit })`, `GitLifecycle.sync/pull/prepareForStart`, `NpmLifecycle.ensureBuilt(appId, appPath)`, and `git` enrichment shape are used identically across tasks.
- **Review Focus tests:** each of the five lines names its owning task test.
