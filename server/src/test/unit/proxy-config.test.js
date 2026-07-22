const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderProxyConfig, validateBaseDomain, resolveBaseDomain } = require('../../services/proxy-manager');

const app = (over) => ({ name: 'sticky', port: 3001, status: 'running', is_default: 0, ...over });

test('running app -> one HTTP server block on <name>.<base>', () => {
  const conf = renderProxyConfig([app()], { baseDomain: 'kuoluosaigai.com', ssl: {} });
  assert.match(conf, /server_name sticky\.kuoluosaigai\.com;/);
  assert.match(conf, /listen 80;/);
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:3001;/);
  assert.match(conf, /proxy_set_header X-Forwarded-Proto \$scheme;/);
  // WebSocket upgrade — without these the edge proxy drops the handshake
  // (browser sees "Unexpected response code: 200" instead of 101).
  assert.match(conf, /proxy_http_version 1\.1;/);
  assert.match(conf, /proxy_set_header Upgrade\s+\$http_upgrade;/);
  assert.match(conf, /proxy_set_header Connection\s+"upgrade";/);
  assert.match(conf, /proxy_read_timeout 3600s;/);
  assert.doesNotMatch(conf, /listen 443/);
});

test('stopped app and portless running app produce no server block', () => {
  const stopped = renderProxyConfig([app({ status: 'stopped' })], { baseDomain: 'x.com', ssl: {} });
  assert.doesNotMatch(stopped, /server_name/);

  const portless = renderProxyConfig([app({ port: null })], { baseDomain: 'x.com', ssl: {} });
  assert.doesNotMatch(portless, /server_name/);
});

test('default running app gets an extra root-domain block', () => {
  const conf = renderProxyConfig([app({ is_default: 1 })], { baseDomain: 'kuoluosaigai.com', ssl: {} });
  assert.match(conf, /server_name kuoluosaigai\.com www\.kuoluosaigai\.com;/);
});

test('default flag is ignored when the app is not running', () => {
  const conf = renderProxyConfig([app({ is_default: 1, status: 'stopped' })], { baseDomain: 'x.com', ssl: {} });
  assert.doesNotMatch(conf, /server_name x\.com www\.x\.com/);
});

test('multiple running apps are emitted sorted by name', () => {
  const conf = renderProxyConfig(
    [app({ name: 'zeta' }), app({ name: 'alpha' })],
    { baseDomain: 'x.com', ssl: {} }
  );
  const ia = conf.indexOf('alpha.x.com');
  const iz = conf.indexOf('zeta.x.com');
  assert.ok(ia > -1 && iz > -1 && ia < iz, 'alpha before zeta');
});

test('no running apps -> header-only (no server block)', () => {
  const conf = renderProxyConfig([], { baseDomain: 'x.com', ssl: {} });
  assert.match(conf, /Managed by Microverse/);
  assert.doesNotMatch(conf, /server \{/);
});

test('missing or invalid baseDomain throws', () => {
  assert.throws(() => renderProxyConfig([app()], { baseDomain: '', ssl: {} }));
  assert.throws(() => renderProxyConfig([app()], { baseDomain: 'bad domain', ssl: {} }));
  assert.throws(() => validateBaseDomain(''));
  assert.throws(() => validateBaseDomain('a b;c'));
});

test('ssl enabled with cert+key -> 443 ssl block + 80->443 redirect', () => {
  const conf = renderProxyConfig([app()], {
    baseDomain: 'x.com',
    ssl: { enabled: true, cert: '/c.pem', key: '/k.pem' }
  });
  assert.match(conf, /listen 443 ssl;/);
  assert.match(conf, /ssl_certificate\s+\/c\.pem;/);
  assert.match(conf, /ssl_certificate_key\s+\/k\.pem;/);
  assert.match(conf, /return 301 https:\/\/\$host\$request_uri;/);
});

test('ssl enabled but missing cert/key falls back to HTTP-only', () => {
  const conf = renderProxyConfig([app()], { baseDomain: 'x.com', ssl: { enabled: true } });
  assert.doesNotMatch(conf, /listen 443/);
  assert.match(conf, /listen 80;/);
});

test('resolveBaseDomain prefers explicit, else derives from template', () => {
  assert.equal(resolveBaseDomain({ proxyBaseDomain: 'a.com', appPublicUrlTemplate: '' }), 'a.com');
  assert.equal(resolveBaseDomain({ proxyBaseDomain: '', appPublicUrlTemplate: 'http://{name}.b.com' }), 'b.com');
  assert.equal(resolveBaseDomain({ proxyBaseDomain: '', appPublicUrlTemplate: 'https://{name}.sub.c.io' }), 'sub.c.io');
  assert.equal(resolveBaseDomain({ proxyBaseDomain: '', appPublicUrlTemplate: '' }), '');
  assert.equal(resolveBaseDomain({ proxyBaseDomain: '', appPublicUrlTemplate: 'noscheme-{name}.c.com' }), '');
});
