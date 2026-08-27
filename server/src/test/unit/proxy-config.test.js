const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderProxyConfig, validateBaseDomain, resolveBaseDomain, validateProxyRoute } = require('../../services/proxy-manager');

const app = (over) => ({ name: 'sticky', port: 3001, status: 'running', is_default: 0, ...over });

test('running app -> one HTTP server block on <name>.<base>', () => {
  const conf = renderProxyConfig([app()], [], { baseDomain: 'kuoluosaigai.com', ssl: {} });
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
  const stopped = renderProxyConfig([app({ status: 'stopped' })], [], { baseDomain: 'x.com', ssl: {} });
  assert.doesNotMatch(stopped, /server_name/);

  const portless = renderProxyConfig([app({ port: null })], [], { baseDomain: 'x.com', ssl: {} });
  assert.doesNotMatch(portless, /server_name/);
});

test('default running app gets an extra root-domain block', () => {
  const conf = renderProxyConfig([app({ is_default: 1 })], [], { baseDomain: 'kuoluosaigai.com', ssl: {} });
  assert.match(conf, /server_name kuoluosaigai\.com www\.kuoluosaigai\.com;/);
});

test('default flag is ignored when the app is not running', () => {
  const conf = renderProxyConfig([app({ is_default: 1, status: 'stopped' })], [], { baseDomain: 'x.com', ssl: {} });
  assert.doesNotMatch(conf, /server_name x\.com www\.x\.com/);
});

test('multiple running apps are emitted sorted by name', () => {
  const conf = renderProxyConfig(
    [app({ name: 'zeta' }), app({ name: 'alpha' })],
    [],
    { baseDomain: 'x.com', ssl: {} }
  );
  const ia = conf.indexOf('alpha.x.com');
  const iz = conf.indexOf('zeta.x.com');
  assert.ok(ia > -1 && iz > -1 && ia < iz, 'alpha before zeta');
});

test('no running apps -> header-only (no server block)', () => {
  const conf = renderProxyConfig([], [], { baseDomain: 'x.com', ssl: {} });
  assert.match(conf, /Managed by Microverse/);
  assert.doesNotMatch(conf, /server \{/);
});

test('empty baseDomain with no custom routes -> header-only; invalid baseDomain throws', () => {
  const empty = renderProxyConfig([app()], [], { baseDomain: '', ssl: {} });
  assert.match(empty, /Managed by Microverse/);
  assert.doesNotMatch(empty, /server \{/);
  assert.throws(() => renderProxyConfig([app()], [], { baseDomain: 'bad domain', ssl: {} }));
  assert.throws(() => validateBaseDomain(''));
  assert.throws(() => validateBaseDomain('a b;c'));
});

test('ssl enabled with cert+key -> 443 ssl block + 80->443 redirect', () => {
  const conf = renderProxyConfig([app()], [], {
    baseDomain: 'x.com',
    ssl: { enabled: true, cert: '/c.pem', key: '/k.pem' }
  });
  assert.match(conf, /listen 443 ssl;/);
  assert.match(conf, /ssl_certificate\s+\/c\.pem;/);
  assert.match(conf, /ssl_certificate_key\s+\/k\.pem;/);
  assert.match(conf, /return 301 https:\/\/\$host\$request_uri;/);
});

test('ssl enabled but missing cert/key falls back to HTTP-only', () => {
  const conf = renderProxyConfig([app()], [], { baseDomain: 'x.com', ssl: { enabled: true } });
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

const route = (over) => ({ id: 1, host: 'a.example.com', target_type: 'port', target_port: 8080, target_app_id: null, ...over });

test('custom port route renders an HTTP block', () => {
  const conf = renderProxyConfig([], [route()], { baseDomain: 'x.com', ssl: {} });
  assert.match(conf, /server_name a\.example\.com;/);
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:8080;/);
  assert.match(conf, /listen 80;/);
  assert.doesNotMatch(conf, /listen 443/);
});

test('custom app route follows a running app port', () => {
  const app = { id: 42, name: 'target', port: 3333, status: 'running', is_default: 0 };
  const conf = renderProxyConfig([app], [route({ target_type: 'app', target_app_id: 42, target_port: null })], { baseDomain: 'x.com', ssl: {} });
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:3333;/);
});

test('custom app route skips stopped / missing app', () => {
  const stopped = { id: 42, name: 'target', port: 3333, status: 'stopped', is_default: 0 };
  const confStopped = renderProxyConfig([stopped], [route({ target_type: 'app', target_app_id: 42, target_port: null })], { baseDomain: 'x.com', ssl: {} });
  assert.doesNotMatch(confStopped, /server_name a\.example\.com;/);

  const missing = renderProxyConfig([], [route({ target_type: 'app', target_app_id: 999, target_port: null })], { baseDomain: 'x.com', ssl: {} });
  assert.doesNotMatch(missing, /server_name a\.example\.com;/);
});

test('custom routes render before auto subdomain blocks', () => {
  const app = { id: 1, name: 'zeta', port: 3001, status: 'running', is_default: 0 };
  const conf = renderProxyConfig([app], [route()], { baseDomain: 'x.com', ssl: {} });
  const ic = conf.indexOf('a.example.com');
  const ia = conf.indexOf('zeta.x.com');
  assert.ok(ic > -1 && ia > -1 && ic < ia, 'custom before auto');
});

test('custom routes render even when baseDomain is empty', () => {
  const conf = renderProxyConfig([], [route()], { baseDomain: '', ssl: {} });
  assert.match(conf, /server_name a\.example\.com;/);
  assert.doesNotMatch(conf, /\.x\.com;/);
});

test('custom route stays HTTP-only even when ssl enabled', () => {
  const conf = renderProxyConfig([], [route()], { baseDomain: 'x.com', ssl: { enabled: true, cert: '/c.pem', key: '/k.pem' } });
  assert.match(conf, /server_name a\.example\.com;/);
  assert.doesNotMatch(conf, /listen 443/);
});

test('validateProxyRoute normalizes a port route', () => {
  const out = validateProxyRoute({ host: 'A.Example.COM', target_type: 'port', target_port: '8080' }, { apps: [] });
  assert.deepEqual(out, { host: 'a.example.com', target_type: 'port', target_port: 8080, target_app_id: null });
});

test('validateProxyRoute normalizes an app route', () => {
  const out = validateProxyRoute({ host: 'app.example.com', target_type: 'app', target_app_id: 7 }, { apps: [{ id: 7, name: 'x' }] });
  assert.deepEqual(out, { host: 'app.example.com', target_type: 'app', target_port: null, target_app_id: 7 });
});

test('validateProxyRoute rejects bad input', () => {
  assert.throws(() => validateProxyRoute({ host: 'bad host', target_type: 'port', target_port: 80 }, {}), /Invalid proxy route/);
  assert.throws(() => validateProxyRoute({ host: 'x.com', target_type: 'wat', target_port: 80 }, {}), /Invalid proxy route/);
  assert.throws(() => validateProxyRoute({ host: 'x.com', target_type: 'port', target_port: 0 }, {}), /Invalid proxy route/);
  assert.throws(() => validateProxyRoute({ host: 'x.com', target_type: 'port', target_port: 99999 }, {}), /Invalid proxy route/);
  assert.throws(() => validateProxyRoute({ host: 'x.com', target_type: 'app', target_app_id: 999 }, { apps: [] }), /Invalid proxy route/);
  assert.throws(() => validateProxyRoute({ host: 'x.com', target_type: 'app' }, { apps: [{ id: 1 }] }), /Invalid proxy route/);
});
