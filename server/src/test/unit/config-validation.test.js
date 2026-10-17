const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig } = require('../../config/validate');

function baseConfig(overrides = {}) {
  return {
    server: { port: 5000, nodeEnv: 'production', ...overrides.server },
    deployment: {
      portRangeMin: 3000,
      portRangeMax: 9000,
      appPublicUrlTemplate: '',
      proxySslEnabled: false,
      proxySslCert: '',
      proxySslCertKey: '',
      metricsIntervalMs: 10000,
      metricsMaxSamples: 180,
      ...overrides.deployment,
    },
    auth: { sessionSecret: 'test-secret', ...overrides.auth },
  };
}

test('a sane production config passes', () => {
  assert.doesNotThrow(() => validateConfig(baseConfig()));
});

test('development tolerates a missing SESSION_SECRET, production does not', () => {
  assert.doesNotThrow(() => validateConfig(baseConfig({ server: { nodeEnv: 'development' }, auth: { sessionSecret: '' } })));
  assert.throws(
    () => validateConfig(baseConfig({ auth: { sessionSecret: '' } })),
    /SESSION_SECRET is required when NODE_ENV=production/
  );
});

test('port range and PORT sanity', () => {
  assert.throws(() => validateConfig(baseConfig({ deployment: { portRangeMin: 9000, portRangeMax: 3000 } })), /APP_PORT_MIN must be less than/);
  assert.throws(() => validateConfig(baseConfig({ deployment: { portRangeMin: -5, portRangeMax: 9000 } })), /Invalid app port range/);
  assert.throws(() => validateConfig(baseConfig({ deployment: { portRangeMin: 3000, portRangeMax: 70000 } })), /Invalid app port range/);
  assert.throws(() => validateConfig(baseConfig({ server: { port: 0 } })), /Invalid PORT/);
  assert.throws(() => validateConfig(baseConfig({ server: { port: 99999 } })), /Invalid PORT/);
});

test('APP_PUBLIC_URL_TEMPLATE must contain {name} and be http(s)', () => {
  assert.doesNotThrow(() => validateConfig(baseConfig({ deployment: { appPublicUrlTemplate: 'https://{name}.example.com' } })));
  assert.doesNotThrow(() => validateConfig(baseConfig({ deployment: { appPublicUrlTemplate: '' } }))); // optional
  assert.throws(() => validateConfig(baseConfig({ deployment: { appPublicUrlTemplate: 'https://example.com' } })), /must contain the \{name\} placeholder/);
  assert.throws(() => validateConfig(baseConfig({ deployment: { appPublicUrlTemplate: 'ftp://{name}.example.com' } })), /must start with http/);
});

test('PROXY_SSL_ENABLED requires both cert paths', () => {
  assert.throws(
    () => validateConfig(baseConfig({ deployment: { proxySslEnabled: true } })),
    /PROXY_SSL_ENABLED=true requires PROXY_SSL_CERT and PROXY_SSL_CERT_KEY/
  );
  assert.throws(
    () => validateConfig(baseConfig({ deployment: { proxySslEnabled: true, proxySslCert: '/x/fullchain.pem' } })),
    /PROXY_SSL_ENABLED=true requires/
  );
  assert.doesNotThrow(() => validateConfig(baseConfig({
    deployment: { proxySslEnabled: true, proxySslCert: '/x/fullchain.pem', proxySslCertKey: '/x/privkey.pem' },
  })));
  // SSL enabled without the proxy itself is legitimate (external edge TLS).
  assert.doesNotThrow(() => validateConfig(baseConfig({
    server: { nodeEnv: 'development' },
    deployment: { proxySslEnabled: false },
  })));
});

test('metrics sampler knobs must be positive', () => {
  assert.throws(() => validateConfig(baseConfig({ deployment: { metricsIntervalMs: 0 } })), /METRICS_INTERVAL_MS/);
  assert.throws(() => validateConfig(baseConfig({ deployment: { metricsMaxSamples: -3 } })), /METRICS_MAX_SAMPLES/);
});
