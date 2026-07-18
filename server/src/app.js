const express = require('express');
const cors = require('cors');
const config = require('./config');
const { errorHandler, notFoundHandler } = require('./middleware/error-handler');
const routes = require('./routes');
const swaggerUi = require('swagger-ui-express');
const openApiSpec = require('./docs');
const session = require('express-session');
const sqlite3 = require('sqlite3');
const SQLiteStore = require('connect-sqlite3')(session);
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Ensure the DB initializes + schema runs (idempotent CREATE TABLE IF NOT EXISTS).
require('./db');

// Shared persistent session store (sqlite). Created once at module load so the
// sessions table is ready before any request, and so every createApp() instance
// in a process shares one connection. Under PM2 cluster each worker opens its
// own connection to this same file -> sessions are visible across workers and
// survive restarts (MemoryStore is per-process and caused intermittent 401s).
fs.mkdirSync(path.dirname(config.session.dbPath), { recursive: true });
const sessionStore = new SQLiteStore({ db: new sqlite3.Database(config.session.dbPath) });

/**
 * Build the Express app WITHOUT listening or bootstrapping background work.
 * server.js composes createApp() + listen + bootstrap; tests import createApp().
 */
function createApp() {
  const app = express();

  app.use(cors(config.cors));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const sessionSecret = config.auth.sessionSecret || crypto.randomBytes(32).toString('hex');
  if (!config.auth.sessionSecret) {
    console.warn('⚠ SESSION_SECRET not set — using a random ephemeral secret. Sessions will not survive restarts, and under PM2 cluster each worker signs with a different key (intermittent logouts/401s). Set SESSION_SECRET in .env.');
  }
  // Trust exactly one reverse-proxy layer so req.ip / req.protocol reflect the
  // real client behind the edge nginx (and so X-Forwarded-Proto drives secure
  // cookies correctly).
  app.set('trust proxy', 1);
  const sessionCookieSecure = config.auth.sessionCookieSecure
    || (config.deployment.proxySslEnabled && config.server.nodeEnv === 'production');
  app.use(session({
    store: sessionStore,
    secret: sessionSecret,
    resave: true,             // rolling renewal requires resave
    saveUninitialized: false,
    rolling: true,            // refresh the cookie on every response -> active sessions stay alive
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: sessionCookieSecure,
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    }
  }));

  if (config.server.nodeEnv === 'development') {
    app.use((req, res, next) => {
      console.log(`${req.method} ${req.path}`);
      next();
    });
  }

  app.use('/api', routes);

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
  app.get('/openapi.json', (req, res) => res.json(openApiSpec));

  // Production: serve the built frontend (client/dist) on this same port, with
  // an SPA fallback so deep links resolve to index.html. Dev uses Vite (5173 +
  // proxy), so this is NODE_ENV=production only. The fallback regex excludes
  // /api, /api-docs, /openapi.json so unknown API paths still JSON-404 via
  // notFoundHandler.
  if (config.server.nodeEnv === 'production') {
    const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
    if (fs.existsSync(clientDist)) {
      // Vite emits content-hashed assets under /assets/ — a given filename
      // never changes, so cache them a year + immutable. index.html and root
      // files (favicon etc.) stay on the default revalidate (max-age=0) so
      // clients pick up new builds immediately.
      const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
      app.use('/assets', express.static(path.join(clientDist, 'assets'), {
        maxAge: ONE_YEAR_MS,
        immutable: true,
      }));
      app.use(express.static(clientDist));
      const indexHtml = path.join(clientDist, 'index.html');
      app.get(/^(?!\/api|\/api-docs|\/openapi\.json).*/, (req, res) => {
        res.sendFile(indexHtml);
      });
    } else {
      console.warn('⚠ client/dist not found — run `npm run build:client`. Serving API only.');
      app.get('/', (req, res) => res.json({ name: 'Microverse Server', version: '1.0.0', status: 'running' }));
    }
  } else {
    app.get('/', (req, res) => res.json({ name: 'Microverse Server', version: '1.0.0', status: 'running' }));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
