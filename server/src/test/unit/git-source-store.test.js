const { test, before } = require('node:test');
const assert = require('node:assert/strict');
// setup must load first: it sets DB_PATH/APPS_DIR before server/src/db is required.
const { queries, dbReady } = require('../helpers/setup');
const { dbRun } = require('../../db');
const AppManager = require('../../services/app-manager');

before(async () => { await dbReady; });

function source(appId, webhookSecret) {
  return {
    appId,
    url: 'https://github.com/o/r.git',
    branch: 'main',
    autoUpdate: true,
    webhookSecret
  };
}

test('upsert + get returns the source', async () => {
  const app = await AppManager.createApp('git-store-a', 'npm');
  await queries.upsertAppGitSource(source(app.id, 's1'));
  const row = await queries.getAppGitSource(app.id);
  assert.equal(row.url, 'https://github.com/o/r.git');
  assert.equal(row.auto_update, 1);
  assert.equal(row.branch, 'main');
  assert.equal(row.webhook_secret, 's1');
  assert.equal(row.last_status, 'idle');
  assert.equal(row.deployed_commit, null);
});

test('re-binding with only a new url preserves branch, auto_update, and secret', async () => {
  const app = await AppManager.createApp('git-store-a2', 'npm');
  await queries.upsertAppGitSource({
    appId: app.id,
    url: 'https://github.com/o/r.git',
    branch: 'dev',
    autoUpdate: false,
    webhookSecret: 'keep-me'
  });

  await queries.upsertAppGitSource({ appId: app.id, url: 'https://github.com/o/other.git' });

  const row = await queries.getAppGitSource(app.id);
  assert.equal(row.url, 'https://github.com/o/other.git');
  assert.equal(row.branch, 'dev');
  assert.equal(row.auto_update, 0);
  assert.equal(row.webhook_secret, 'keep-me');
});

test('re-binding with explicit values updates branch and auto_update', async () => {
  const app = await AppManager.createApp('git-store-a3', 'npm');
  await queries.upsertAppGitSource(source(app.id, 's9'));

  await queries.upsertAppGitSource({
    appId: app.id,
    url: 'https://github.com/o/r.git',
    branch: 'release/2',
    autoUpdate: false,
    webhookSecret: 's10'
  });

  const row = await queries.getAppGitSource(app.id);
  assert.equal(row.branch, 'release/2');
  assert.equal(row.auto_update, 0);
  assert.equal(row.webhook_secret, 's10');
});

test('claimGitSync is exclusive until the claim goes stale', async () => {
  const app = await AppManager.createApp('git-store-b', 'npm');
  await queries.upsertAppGitSource(source(app.id, 's2'));
  assert.equal(await queries.claimGitSync(app.id, 60_000), true);
  assert.equal(await queries.claimGitSync(app.id, 60_000), false);
  await dbRun(`UPDATE app_git_source SET sync_started_at = datetime('now', '-2 minutes') WHERE app_id = ?`, [app.id]);
  assert.equal(await queries.claimGitSync(app.id, 60_000), true);

  const row = await queries.getAppGitSource(app.id);
  assert.equal(row.last_status, 'updating');
  assert.ok(row.sync_started_at);
});

test('finishGitSync stores the commit and clears the claim', async () => {
  const app = await AppManager.createApp('git-store-c', 'npm');
  await queries.upsertAppGitSource(source(app.id, 's3'));
  assert.equal(await queries.claimGitSync(app.id, 60_000), true);

  await queries.finishGitSync(app.id, { status: 'success', deployedCommit: 'abc', remoteCommit: 'def' });
  let row = await queries.getAppGitSource(app.id);
  assert.equal(row.last_status, 'success');
  assert.equal(row.deployed_commit, 'abc');
  assert.equal(row.remote_commit, 'def');
  assert.equal(row.sync_started_at, null);
  assert.ok(row.synced_at);
  const syncedAt = row.synced_at;

  // Omitted commit values are preserved (COALESCE) on a later failure.
  await queries.finishGitSync(app.id, { status: 'failed', error: 'boom' });
  row = await queries.getAppGitSource(app.id);
  assert.equal(row.last_status, 'failed');
  assert.equal(row.last_error, 'boom');
  assert.equal(row.deployed_commit, 'abc');
  assert.equal(row.remote_commit, 'def');
  assert.equal(row.synced_at, syncedAt);
});

test('markGitUpdateAvailable does not clobber a fresh updating claim', async () => {
  const app = await AppManager.createApp('git-store-d', 'npm');
  await queries.upsertAppGitSource(source(app.id, 's4'));
  assert.equal(await queries.claimGitSync(app.id, 60_000), true);

  await queries.markGitUpdateAvailable(app.id, 60_000);
  assert.equal((await queries.getAppGitSource(app.id)).last_status, 'updating');

  // Once the claim is stale it is safe to advertise an update.
  await dbRun(`UPDATE app_git_source SET sync_started_at = datetime('now', '-2 minutes') WHERE app_id = ?`, [app.id]);
  await queries.markGitUpdateAvailable(app.id, 60_000);
  assert.equal((await queries.getAppGitSource(app.id)).last_status, 'update_available');
});

test('deleting the app cascades app_git_source', async () => {
  const app = await AppManager.createApp('git-store-e', 'npm');
  await queries.upsertAppGitSource(source(app.id, 's5'));
  assert.ok(await queries.getAppGitSource(app.id));

  await queries.deleteApp(app.id);
  assert.equal(await queries.getAppGitSource(app.id), undefined);
});

test('AppManager.getAppById attaches git or null', async () => {
  const plain = await AppManager.createApp('git-store-f', 'npm');
  assert.equal((await AppManager.getAppById(plain.id)).git, null);

  const wired = await AppManager.createApp('git-store-g', 'npm');
  await queries.upsertAppGitSource({
    appId: wired.id,
    url: 'https://github.com/o/r.git',
    branch: 'dev',
    autoUpdate: false,
    webhookSecret: 's6'
  });

  const loaded = await AppManager.getAppById(wired.id);
  assert.equal(loaded.git.url, 'https://github.com/o/r.git');
  assert.equal(loaded.git.branch, 'dev');
  assert.equal(loaded.git.auto_update, 0);
  assert.equal(loaded.git.deployed_commit, null);
  assert.equal(loaded.git.remote_commit, null);
  assert.equal(loaded.git.synced_at, null);
  assert.equal(loaded.git.last_status, 'idle');
  assert.equal(loaded.git.last_error, null);
  // The webhook secret must not leak through the generic app shape.
  assert.equal(loaded.git.webhook_secret, undefined);

  // Existing app fields are untouched.
  assert.equal(loaded.name, 'git-store-g');
  assert.equal(loaded.deploy_type, 'npm');
});

test('AppManager.getAllApps attaches git per app in one read', async () => {
  const plain = await AppManager.createApp('git-store-h', 'npm');
  const wired = await AppManager.createApp('git-store-i', 'npm');
  await queries.upsertAppGitSource(source(wired.id, 's7'));

  const apps = await AppManager.getAllApps();
  const byId = new Map(apps.map(a => [a.id, a]));
  assert.equal(byId.get(plain.id).git, null);
  assert.equal(byId.get(wired.id).git.url, 'https://github.com/o/r.git');
});

test('resetGitSourceProgress clears deployed state and setGitAutoUpdate toggles the flag', async () => {
  const app = await AppManager.createApp('git-store-j', 'npm');
  await queries.upsertAppGitSource(source(app.id, 's8'));
  await queries.claimGitSync(app.id, 60_000);
  await queries.finishGitSync(app.id, { status: 'success', deployedCommit: 'abc', remoteCommit: 'def' });

  await queries.setGitAutoUpdate(app.id, false);
  assert.equal((await queries.getAppGitSource(app.id)).auto_update, 0);

  await queries.setGitRemoteCommit(app.id, 'fed');
  assert.equal((await queries.getAppGitSource(app.id)).remote_commit, 'fed');

  await queries.resetGitSourceProgress(app.id);
  const row = await queries.getAppGitSource(app.id);
  assert.equal(row.deployed_commit, null);
  assert.equal(row.remote_commit, null);
  assert.equal(row.synced_at, null);
  assert.equal(row.last_status, 'idle');
  assert.equal(row.last_error, null);
  assert.equal(row.sync_started_at, null);
  // Binding details survive a progress reset.
  assert.equal(row.url, 'https://github.com/o/r.git');
  assert.equal(row.webhook_secret, 's8');

  await queries.deleteAppGitSource(app.id);
  assert.equal(await queries.getAppGitSource(app.id), undefined);
});
