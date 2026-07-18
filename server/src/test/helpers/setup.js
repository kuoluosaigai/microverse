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

// A supertest agent that is already logged in as the seeded admin.
async function adminAgent() {
  await init();
  const agent = supertest.agent(app());
  await agent.post('/api/auth/login')
    .send({ username: 'admin', password: 'test-pass' })
    .expect(200);
  return agent;
}

module.exports = { createApp, request, init, adminAgent, queries, dbReady };
