const path = require('path');
const fs = require('fs');
const os = require('os');
const supertest = require('supertest');

// 1. Set env BEFORE any require that transitively loads server/src/db.
const tmpRoot = path.join(os.tmpdir(), `microverse-test-${process.pid}`);
fs.mkdirSync(path.join(tmpRoot, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmpRoot, 'apps'), { recursive: true });
process.env.DB_PATH = process.env.DB_PATH || path.join(tmpRoot, 'db', 'test.sqlite');
process.env.SESSION_DB_PATH = process.env.SESSION_DB_PATH || path.join(tmpRoot, 'db', 'test-sessions.sqlite');
process.env.APPS_DIR = process.env.APPS_DIR || path.join(tmpRoot, 'apps');
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-pass';
process.env.NODE_ENV = 'test';

// 2. NOW require app/db (they read the env above).
const { createApp } = require('../../app');
const { dbReady, queries } = require('../../db');
const AuthManager = require('../../services/auth-manager');

// 2b. Hard-suppress real PM2 CLI calls for every test that loads this helper.
// pm2 is a server dependency, so ProcessManager.pm2Exec resolves its JS entry
// even without a global install — an unguarded `pm2 jlist`/`pm2 delete` in a
// test would spawn a real PM2 daemon on the dev/CI machine. Plain property
// patch (not mock.method) so per-test mocks can still override it, and their
// mock.reset() restores THIS stub rather than the real implementation.
const ProcessManager = require('../../services/process-manager');
ProcessManager.pm2Exec = async () => {
  const err = new Error('pm2 CLI disabled in tests');
  err.code = 'ENOENT';
  throw err;
};

let _app = null;
function app() {
  if (!_app) _app = createApp();
  return _app;
}
function request() { return supertest(app()); }

// Seed the admin user (createApp does NOT call ensureAdmin). Call once per file.
async function init() {
  await dbReady;
  await AuthManager.ensureAdmin();
  return app();
}

// A supertest agent that is already logged in as the seeded admin. Each call
// uses a unique X-Forwarded-For IP so the login rate-limiter (5/15min/IP, keyed
// on req.ip; app sets `trust proxy` 1) doesn't trip when a single test file
// creates more than 5 agents in one process.
let _adminSeq = 0;
async function adminAgent() {
  await init();
  const agent = supertest.agent(app());
  _adminSeq += 1;
  await agent.post('/api/auth/login')
    .set('X-Forwarded-For', `10.99.${(_adminSeq >> 8) & 255}.${_adminSeq & 255}`)
    .send({ username: 'admin', password: 'test-pass' })
    .expect(200);
  return agent;
}

module.exports = { createApp, request, init, adminAgent, queries, dbReady };
