const express = require('express');
const cors = require('cors');
const config = require('./config');
const { errorHandler, notFoundHandler } = require('./middleware/error-handler');
const routes = require('./routes');
const swaggerUi = require('swagger-ui-express');
const openApiSpec = require('./docs');
const NginxLifecycle = require('./services/nginx-lifecycle');
const metricsSampler = require('./services/metrics-sampler');
const session = require('express-session');
const crypto = require('crypto');
const AuthManager = require('./services/auth-manager');
const { dbReady } = require('./db');

// Initialize database
require('./db');

/**
 * Microverse Server Application
 */

const app = express();

// Middleware
app.use(cors(config.cors));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session (admin auth). SESSION_SECRET falls back to a random ephemeral secret
// (sessions then invalidate on every restart — set SESSION_SECRET in .env).
const sessionSecret = config.auth.sessionSecret || crypto.randomBytes(32).toString('hex');
if (!config.auth.sessionSecret) {
  console.warn('⚠ SESSION_SECRET not set — using a random ephemeral secret (sessions invalidate on restart). Set SESSION_SECRET in .env for stable sessions.');
}
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 } // 8h
}));

// Request logging in development
if (config.server.nodeEnv === 'development') {
  app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
  });
}

// API routes
app.use('/api', routes);

// API documentation (Swagger UI) + raw OpenAPI spec
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));
app.get('/openapi.json', (req, res) => res.json(openApiSpec));

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Microverse Server',
    version: '1.0.0',
    status: 'running'
  });
});

// Error handlers (must be last)
app.use(notFoundHandler);
app.use(errorHandler);

// Start server
const server = app.listen(config.server.port, config.server.host, () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║   Microverse Server                    ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');
  console.log(`✓ Server running on http://${config.server.host}:${config.server.port}`);
  console.log(`✓ Environment: ${config.server.nodeEnv}`);
  console.log(`✓ API available at http://${config.server.host}:${config.server.port}/api`);
  console.log(`✓ API docs (Swagger UI): http://${config.server.host}:${config.server.port}/api-docs`);
  console.log('');
  console.log('Press Ctrl+C to stop');
  console.log('');

  // Warn (don't block) if the nginx binary is unavailable — only the nginx
  // deploy type needs it; http-server/npm apps work without it.
  NginxLifecycle.probe().then(({ ok, message }) => {
    if (!ok) console.warn('⚠ ' + message);
  });

  // Start the resource-metrics sampler (10s default; decouples PM2 from requests).
  metricsSampler.start();

  // Seed the admin user once the DB schema is ready.
  dbReady.then(() => AuthManager.ensureAdmin()).catch(err => console.warn(`ensureAdmin failed: ${err.message}`));
});

// Graceful shutdown
process.on('SIGTERM', () => {
  metricsSampler.stop();
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  metricsSampler.stop();
  console.log('\nSIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

module.exports = app;
