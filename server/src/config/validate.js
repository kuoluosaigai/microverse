/**
 * Startup configuration validation — pure function over a config-shaped object
 * so it is unit-testable without env gymnastics. Throws on the FIRST invalid
 * value with an actionable message (config/index.js calls this at load time;
 * an invalid config must crash the boot immediately, not fail at request time).
 */
function validateConfig(config) {
  const { portRangeMin, portRangeMax } = config.deployment;

  if (!Number.isInteger(portRangeMin) || !Number.isInteger(portRangeMax)
    || portRangeMin < 1 || portRangeMax > 65535) {
    throw new Error(`Invalid app port range: APP_PORT_MIN/APP_PORT_MAX must be integers within 1..65535 (got ${portRangeMin}..${portRangeMax})`);
  }
  if (portRangeMin >= portRangeMax) {
    throw new Error('APP_PORT_MIN must be less than APP_PORT_MAX');
  }

  if (!Number.isInteger(config.server.port) || config.server.port < 1 || config.server.port > 65535) {
    throw new Error(`Invalid PORT: must be an integer between 1 and 65535 (got ${config.server.port})`);
  }

  // Production hard requirements.
  if (config.server.nodeEnv === 'production') {
    if (!config.auth.sessionSecret) {
      throw new Error('SESSION_SECRET is required when NODE_ENV=production: without it each PM2 cluster worker signs cookies with a different ephemeral key, causing intermittent 401s, and sessions die on every restart. Set SESSION_SECRET in .env (e.g. `openssl rand -hex 32`).');
    }
  }

  // Public URL template: optional, but when set it must be usable — the UI
  // builds "open app" links from it.
  const tpl = config.deployment.appPublicUrlTemplate;
  if (tpl) {
    if (!tpl.includes('{name}')) {
      throw new Error(`APP_PUBLIC_URL_TEMPLATE must contain the {name} placeholder (got "${tpl}")`);
    }
    if (!/^https?:\/\//i.test(tpl)) {
      throw new Error(`APP_PUBLIC_URL_TEMPLATE must start with http:// or https:// (got "${tpl}")`);
    }
  }

  // Reverse-proxy SSL: enabled means both cert paths must be present — the
  // emitted nginx server block references them verbatim and `nginx -t` would
  // fail at reload time otherwise (a much more confusing failure).
  if (config.deployment.proxySslEnabled) {
    if (!config.deployment.proxySslCert || !config.deployment.proxySslCertKey) {
      throw new Error('PROXY_SSL_ENABLED=true requires PROXY_SSL_CERT and PROXY_SSL_CERT_KEY to be set (v1 does not issue certificates — point these at your certbot/fullchain.pem and privkey.pem).');
    }
  }

  // Metrics sampler sanity: a non-positive interval/retention would spin or
  // store nothing.
  if (!(config.deployment.metricsIntervalMs > 0)) {
    throw new Error(`METRICS_INTERVAL_MS must be > 0 (got ${config.deployment.metricsIntervalMs})`);
  }
  if (!(config.deployment.metricsMaxSamples > 0)) {
    throw new Error(`METRICS_MAX_SAMPLES must be > 0 (got ${config.deployment.metricsMaxSamples})`);
  }
}

module.exports = { validateConfig };
