const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const GitLifecycle = require('../../services/git-lifecycle');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'microverse-git-repo-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fileUrl = (dir) => 'file://' + path.resolve(dir).replace(/\\/g, '/');

function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one');
  return [
    ['init', '-q', '-b', 'main'],
    ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'add', '.'],
    ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-qm', 'one']
  ].reduce((p, args) => p.then(() => GitLifecycle.gitExec(args, { cwd: dir })), Promise.resolve());
}

function commitTo(dir, content, message) {
  fs.writeFileSync(path.join(dir, 'a.txt'), content);
  return [
    ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'add', '.'],
    ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-qm', message]
  ].reduce((p, args) => p.then(() => GitLifecycle.gitExec(args, { cwd: dir })), Promise.resolve());
}

test('ensureRepo clones into a non-empty app dir and reports the commit', async () => {
  const src = path.join(tmp, 'src');
  await makeRepo(src);
  const appDir = path.join(tmp, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'existing.txt'), 'keep');
  const { cloned, commit } = await GitLifecycle.ensureRepo(appDir, {
    url: fileUrl(src),
    branch: 'main'
  });
  assert.equal(cloned, true);
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.equal(fs.readFileSync(path.join(appDir, 'a.txt'), 'utf8'), 'one');
  assert.equal(fs.readFileSync(path.join(appDir, 'existing.txt'), 'utf8'), 'keep');
  assert.equal(GitLifecycle.hasRepo(appDir), true);
});

test('ensureRepo reuses an existing repo and syncs a moved origin head', async () => {
  const src = path.join(tmp, 'src-sync');
  await makeRepo(src);
  const appDir = path.join(tmp, 'app-sync');

  const first = await GitLifecycle.ensureRepo(appDir, { url: fileUrl(src), branch: 'main' });
  assert.equal(first.cloned, true);

  await commitTo(src, 'two', 'two');

  // Second bind: same dir is already a repo, so origin is updated (set-url)
  // and the new head is checked out without dropping untracked files.
  fs.writeFileSync(path.join(appDir, 'keep.txt'), 'keep');
  const second = await GitLifecycle.ensureRepo(appDir, { url: fileUrl(src), branch: 'main' });
  assert.equal(second.cloned, false);
  assert.notEqual(second.commit, first.commit);
  assert.equal(second.commit, await GitLifecycle.currentHead(src));
  assert.equal(fs.readFileSync(path.join(appDir, 'a.txt'), 'utf8'), 'two');
  assert.equal(fs.readFileSync(path.join(appDir, 'keep.txt'), 'utf8'), 'keep');
});

test('fetchHead returns a new commit after the source advances', async () => {
  const src = path.join(tmp, 'src-fetch');
  await makeRepo(src);
  const appDir = path.join(tmp, 'app-fetch');
  await GitLifecycle.ensureRepo(appDir, { url: fileUrl(src), branch: 'main' });
  const before = await GitLifecycle.currentHead(appDir);

  await commitTo(src, 'two', 'two');

  const fetched = await GitLifecycle.fetchHead(appDir, 'main');
  assert.match(fetched, /^[0-9a-f]{40}$/);
  assert.notEqual(fetched, before);
  assert.equal(fetched, await GitLifecycle.currentHead(src));

  // The fetched commit is usable without a second network round-trip.
  await GitLifecycle.gitExec(['reset', '--hard', 'FETCH_HEAD'], { cwd: appDir });
  assert.equal(fs.readFileSync(path.join(appDir, 'a.txt'), 'utf8'), 'two');
});

test('remoteHead returns the branch sha without cloning', async () => {
  const src = path.join(tmp, 'src-remote');
  await makeRepo(src);

  const sha = await GitLifecycle.remoteHead({ url: fileUrl(src), branch: 'main' });
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(sha, await GitLifecycle.currentHead(src));

  const missing = await GitLifecycle.remoteHead({ url: fileUrl(src), branch: 'nope' });
  assert.equal(missing, null);

  // No working tree is created for a remote-head lookup.
  assert.equal(fs.existsSync(path.join(path.dirname(src), 'remote-clone')), false);
});

test('rejects option-injection url and branch values before invoking git', async () => {
  const appDir = path.join(tmp, 'app-unsafe');
  await assert.rejects(
    GitLifecycle.ensureRepo(appDir, { url: '--upload-pack=evil', branch: 'main' }),
    /invalid git/i
  );
  await assert.rejects(
    GitLifecycle.ensureRepo(appDir, { url: fileUrl(tmp), branch: '--upload-pack=evil' }),
    /invalid git/i
  );
  await assert.rejects(
    GitLifecycle.ensureRepo(appDir, { url: fileUrl(tmp), branch: 'ma\nin' }),
    /invalid git/i
  );
  assert.equal(GitLifecycle.hasRepo(appDir), false);
});
