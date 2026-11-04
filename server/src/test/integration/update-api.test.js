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

test('POST /api/system/update maps a lost lock race to 409', async () => {
  const agent = await adminAgent();
  mock.method(UpdateManager, 'preflight', async () => ({ ok: true, fromSha: 'aaa', toSha: 'bbb' }));
  mock.method(UpdateManager, 'startUpdate', async () => ({ ok: false, httpStatus: 409, message: '已有更新正在进行' }));
  try {
    const res = await agent.post('/api/system/update');
    assert.equal(res.status, 409);
    assert.equal(res.body.success, false);
    assert.match(res.body.error.message, /正在进行/);
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
