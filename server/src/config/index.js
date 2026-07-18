const dotenv = require('dotenv');
const path = require('path');

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, '../../..', '.env') });

/**
 * Configuration management for Microverse
 * Loads settings from environment variables with sensible defaults
 */

const config = {
  // Server configuration
  server: {
    port: parseInt(process.env.PORT) || 5000,
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
    portRangeMin: parseInt(process.env.APP_PORT_MIN) || 3000,
    portRangeMax: parseInt(process.env.APP_PORT_MAX) || 9000,

    // Default ports for different deploy types
    defaultHttpServerPort: 8080,
    defaultNpmPort: 3000,

    // File upload limits
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 100 * 1024 * 1024, // 100MB
    maxFiles: parseInt(process.env.MAX_FILES) || 100,

    // npm install / build timeouts (ms)
    npmInstallTimeoutMs: parseInt(process.env.NPM_INSTALL_TIMEOUT_MS) || 300000,
    npmBuildTimeoutMs: parseInt(process.env.NPM_BUILD_TIMEOUT_MS) || 300000,

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

    // metrics sampler (resource monitoring): PM2 poll interval + ring-buffer cap
    metricsIntervalMs: parseInt(process.env.METRICS_INTERVAL_MS) || 10000,
    metricsMaxSamples: parseInt(process.env.METRICS_MAX_SAMPLES) || 180
  },

  // PM2 configuration
  pm2: {
    instanceName: process.env.PM2_INSTANCE_NAME || 'microverse-server'
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

// Validate configuration
const validateConfig = () => {
  const { portRangeMin, portRangeMax } = config.deployment;

  if (portRangeMin >= portRangeMax) {
    throw new Error('APP_PORT_MIN must be less than APP_PORT_MAX');
  }

  if (config.server.port < 1 || config.server.port > 65535) {
    throw new Error('Invalid PORT: must be between 1 and 65535');
  }
};

// Run validation
validateConfig();

module.exports = config;
