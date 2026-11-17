const dotenv = require('dotenv');
const path = require('path');

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, '../../..', '.env') });

/**
 * Configuration management for Microverse
 * Loads settings from environment variables with sensible defaults
 */

// Strict integer env parsing: an UNSET or empty var takes the default, but a
// SET non-integer ("abc", "12abc", "5.5") throws at boot. The old
// `parseInt(x) || fallback` silently swallowed typos — APP_PORT_MIN=abc booted
// with 3000 and the operator never learned their .env was ignored.
const intFromEnv = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  if (!Number.isInteger(n)) {
    throw new Error(`Invalid ${name}: expected an integer, got "${raw}"`);
  }
  return n;
};

const config = {
  // Server configuration
  server: {
    port: intFromEnv('PORT', 5000),
    host: process.env.HOST || '0.0.0.0',
    nodeEnv: process.env.NODE_ENV || 'development'
  },

  // CORS configuration
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    credentials: true
  },

  // Database configuration
  database: {
    path: process.env.DB_PATH || path.join(__dirname, '../../..', 'data', 'microverse.sqlite')
  },

  // Application deployment configuration
  deployment: {
    // Port range for deployed apps
    portRangeMin: intFromEnv('APP_PORT_MIN', 3000),
    portRangeMax: intFromEnv('APP_PORT_MAX', 9000),

    // Default ports for different deploy types
    defaultHttpServerPort: 8080,
    defaultNpmPort: 3000,

    // File upload limits
    maxFileSize: intFromEnv('MAX_FILE_SIZE', 100 * 1024 * 1024), // 100MB
    maxFiles: intFromEnv('MAX_FILES', 100),

    // npm install / build timeouts (ms)
    npmInstallTimeoutMs: intFromEnv('NPM_INSTALL_TIMEOUT_MS', 300000),
    npmBuildTimeoutMs: intFromEnv('NPM_BUILD_TIMEOUT_MS', 300000),

    // Async deploy jobs: a 'running' job whose started_at is older than this
    // is treated as abandoned (crashed worker) and the next claim may take it
    // over. Default 2400000 (40 min) — >3x the worst-case deploy budget
    // (~11 min) so a slow-but-alive job is never stolen while running.
    deployJobStaleMs: intFromEnv('DEPLOY_JOB_STALE_MS', 2400000),

    // nginx binary path (default 'nginx' = PATH; set NGINX_BIN for non-PATH installs)
    nginxBin: process.env.NGINX_BIN || 'nginx',

    // Public URL template for deployed-app "open" links, e.g.
    //   https://{name}.yourdomain.com
    // {name} is replaced with the app name. Empty -> frontend falls back to
    // http://localhost:<port> (local dev).
    appPublicUrlTemplate: process.env.APP_PUBLIC_URL_TEMPLATE || '',

    // Reverse-proxy: platform-managed nginx edge config (opt-in). When enabled,
    // the app regenerates <proxyConfFile> from all running apps and reloads
    // nginx. See docs/superpowers/specs/2026-07-18-nginx-reverse-proxy-design.md.
    proxyEnabled: process.env.PROXY_ENABLED === 'true',
    proxyConfFile: process.env.PROXY_CONF_FILE || '/etc/nginx/conf.d/microverse_apps.conf',
    proxyBaseDomain: process.env.PROXY_BASE_DOMAIN || '',
    proxyReloadBinary: process.env.NGINX_BIN || 'nginx',
    // SSL structure reservation (v1 does NOT issue certs):
    proxySslEnabled: process.env.PROXY_SSL_ENABLED === 'true',
    proxySslCert: process.env.PROXY_SSL_CERT || '',
    proxySslCertKey: process.env.PROXY_SSL_CERT_KEY || '',

    // metrics sampler (resource monitoring): PM2 poll interval + per-app
    // retention cap (rows in the shared SQLite metrics table)
    metricsIntervalMs: intFromEnv('METRICS_INTERVAL_MS', 10000),
    metricsMaxSamples: intFromEnv('METRICS_MAX_SAMPLES', 180)
  },

  // PM2 configuration
  pm2: {
    instanceName: process.env.PM2_INSTANCE_NAME || 'microverse-server'
  },

  // Git-source deploys: binary used for clone/fetch, the per-command timeout,
  // and the age after which an unfinished sync is considered stale.
  git: {
    bin: process.env.GIT_BIN || 'git',
    timeoutMs: intFromEnv('GIT_TIMEOUT_MS', 120000),
    staleSyncMs: intFromEnv('GIT_STALE_SYNC_MS', 30 * 60 * 1000)
  },

  // Platform self-update (opt-in): pull SELF_UPDATE_REF from SELF_UPDATE_REMOTE,
  // build into client/dist.next, health-check, then swap dists + pm2 reload.
  selfUpdate: {
    enabled: process.env.SELF_UPDATE_ENABLED === 'true',
    ref: process.env.SELF_UPDATE_REF || 'main',
    remote: process.env.SELF_UPDATE_REMOTE || 'origin'
  },

  // Auth (single admin login)
  auth: {
    adminUsername: process.env.ADMIN_USERNAME || 'admin',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    sessionSecret: process.env.SESSION_SECRET || '',
    sessionCookieSecure: process.env.SESSION_COOKIE_SECURE === 'true'
  },

  // Session store: a shared sqlite file so sessions are visible to every PM2
  // cluster worker and survive restarts. express-session's default MemoryStore
  // is per-process, which causes intermittent 401s under cluster mode.
  session: {
    dbPath: process.env.SESSION_DB_PATH || path.join(__dirname, '../../..', 'data', 'sessions.sqlite')
  }
};

// Validate configuration (rules live in ./validate.js as a pure function so
// they are unit-testable). Throws immediately on invalid config — a bad
// environment must crash the boot, not fail later at request time.
const { validateConfig } = require('./validate');
validateConfig(config);

module.exports = config;
