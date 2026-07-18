const express = require('express');
const cors = require('cors');
const config = require('./config');
const { errorHandler, notFoundHandler } = require('./middleware/error-handler');
const routes = require('./routes');
const swaggerUi = require('swagger-ui-express');
const openApiSpec = require('./docs');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Ensure the DB initializes + schema runs (idempotent CREATE TABLE IF NOT EXISTS).
require('./db');

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
    console.warn('⚠ SESSION_SECRET not set — using a random ephemeral secret (sessions invalidate on restart). Set SESSION_SECRET in .env for stable sessions.');
  }
  app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 }
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
