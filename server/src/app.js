const express = require('express');
const cors = require('cors');
const config = require('./config');
const { errorHandler, notFoundHandler } = require('./middleware/error-handler');
const routes = require('./routes');
const swaggerUi = require('swagger-ui-express');
const openApiSpec = require('./docs');
const session = require('express-session');
const crypto = require('crypto');

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

  app.get('/', (req, res) => {
    res.json({ name: 'Microverse Server', version: '1.0.0', status: 'running' });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
