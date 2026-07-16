const config = require('./config');
const { createApp } = require('./app');
const { dbReady } = require('./db');
const NginxLifecycle = require('./services/nginx-lifecycle');
const metricsSampler = require('./services/metrics-sampler');
const AuthManager = require('./services/auth-manager');

const app = createApp();

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

  NginxLifecycle.probe().then(({ ok, message }) => {
    if (!ok) console.warn('⚠ ' + message);
  });

  metricsSampler.start();

  dbReady.then(() => AuthManager.ensureAdmin()).catch(err => console.warn(`ensureAdmin failed: ${err.message}`));
});

function shutdown() {
  metricsSampler.stop();
  console.log('\nShutdown signal received: closing HTTP server');
  server.close(() => { console.log('HTTP server closed'); process.exit(0); });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
