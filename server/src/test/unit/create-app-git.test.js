const { test, before, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { queries, dbReady } = require('../helpers/setup');
const AppManager = require('../../services/app-manager');
const pathHelper = require('../../utils/path-helper');

before(async () => { await dbReady; });

test('createApp with gitOptions inserts the source in one call', async () => {
  const app = await AppManager.createApp('create-git-a', 'npm', {
    url: 'https://github.com/o/r',
    branch: 'main',
    autoUpdate: true
  });
  // The app returned to the caller is the enriched shape (git attached), but
  // the webhook secret is intentionally never part of that shape.
  assert.equal(app.git.url, 'https://github.com/o/r');
  assert.equal(app.git.auto_update, 1);
  assert.equal(app.git.webhook_secret, undefined);

  const row = await queries.getAppGitSource(app.id);
  assert.match(row.webhook_secret, /^[0-9a-f]{64}$/);
  assert.equal(row.branch, 'main');
  assert.equal(row.auto_update, 1);
});

test('gitOptions default to branch main and autoUpdate true', async () => {
  const app = await AppManager.createApp('create-git-defaults', 'npm', {
    url: 'https://github.com/o/r'
  });
  assert.equal(app.git.url, 'https://github.com/o/r');
  assert.equal(app.git.branch, 'main');
  assert.equal(app.git.auto_update, 1);
});

test('without gitOptions the app is created with git null', async () => {
  const app = await AppManager.createApp('create-git-plain', 'npm');
  assert.equal(app.git, null);
  assert.equal(await queries.getAppGitSource(app.id), undefined);
});

test('invalid git URL rejects before creating an app', async () => {
  await assert.rejects(
    () => AppManager.createApp('create-git-b', 'npm', { url: 'file:///tmp/x' }),
    /https/
  );
  assert.equal(await queries.getAppByName('create-git-b'), undefined);
  assert.equal(fs.existsSync(pathHelper.getAppDir('create-git-b')), false);
});

test('invalid git branch rejects before creating an app', async () => {
  await assert.rejects(
    () => AppManager.createApp('create-git-branch', 'npm', {
      url: 'https://github.com/o/r',
      branch: 'bad..branch'
    }),
    /Invalid git branch/
  );
  assert.equal(await queries.getAppByName('create-git-branch'), undefined);
});

test('failed source insert does not delete a pre-existing non-empty directory', async () => {
  const dir = pathHelper.getAppDir('create-git-c');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');

  // force the source insert to fail
  mock.method(queries, 'upsertAppGitSource', async () => {
    throw new Error('source insert boom');
  });
  try {
    await assert.rejects(
      () => AppManager.createApp('create-git-c', 'npm', { url: 'https://github.com/o/r' }),
      /source insert boom/
    );
  } finally {
    mock.restoreAll();
  }

  assert.equal(fs.existsSync(path.join(dir, 'keep.txt')), true);
  assert.deepEqual(fs.readdirSync(dir), ['keep.txt']);
  assert.equal(await queries.getAppByName('create-git-c'), undefined);
});

test('failed source insert removes a directory it created', async () => {
  const dir = pathHelper.getAppDir('create-git-d');
  assert.equal(fs.existsSync(dir), false);

  mock.method(queries, 'upsertAppGitSource', async () => {
    throw new Error('source insert boom');
  });
  try {
    await assert.rejects(
      () => AppManager.createApp('create-git-d', 'npm', { url: 'https://github.com/o/r' }),
      /source insert boom/
    );
  } finally {
    mock.restoreAll();
  }

  assert.equal(fs.existsSync(dir), false);
  assert.equal(await queries.getAppByName('create-git-d'), undefined);
});

test('failed source insert removes a pre-existing empty directory', async () => {
  const dir = pathHelper.getAppDir('create-git-e');
  fs.mkdirSync(dir, { recursive: true });

  mock.method(queries, 'upsertAppGitSource', async () => {
    throw new Error('source insert boom');
  });
  try {
    await assert.rejects(
      () => AppManager.createApp('create-git-e', 'npm', { url: 'https://github.com/o/r' }),
      /source insert boom/
    );
  } finally {
    mock.restoreAll();
  }

  assert.equal(fs.existsSync(dir), false);
  assert.equal(await queries.getAppByName('create-git-e'), undefined);
});
