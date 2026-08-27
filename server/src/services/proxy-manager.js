const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);

const config = require('../config');
const { queries } = require('../db');

const HEADER = '# Managed by Microverse — do not edit by hand; regenerated on app lifecycle.';

/**
 * Validate a base domain. Only the whitelist passes — this is the one admin-
 * controlled string interpolated into nginx server_name, so it must be tame.
 * @param {string} baseDomain
 */
function validateBaseDomain(baseDomain) {
  if (!baseDomain || !/^[\w.-]+$/.test(baseDomain)) {
    throw new Error('Invalid or missing base domain for proxy config');
  }
}

/**
 * Pure: resolve the base domain from explicit config or the public URL template
 * (strip the `{name}.` prefix). Returns '' if neither yields one. Config values
 * are passed in (not imported) so this is unit-testable without the config singleton.
 */
function resolveBaseDomain({ proxyBaseDomain, appPublicUrlTemplate }) {
  if (proxyBaseDomain) return proxyBaseDomain;
  const tpl = appPublicUrlTemplate || '';
  const m = tpl.match(/^\w+:\/\/\{name\}\.([^\s/]+)/i);
  return m ? m[1] : '';
}

function locationBlock(port) {
  return [
    '    location / {',
    `      proxy_pass http://127.0.0.1:${port};`,
    '      proxy_http_version 1.1;',
    '      proxy_set_header Upgrade           $http_upgrade;',
    '      proxy_set_header Connection        "upgrade";',
    '      proxy_set_header Host              $host;',
    '      proxy_set_header X-Real-IP         $remote_addr;',
    '      proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;',
    '      proxy_set_header X-Forwarded-Proto $scheme;',
    '      proxy_read_timeout 3600s;',
    '    }'
  ].join('\n');
}

function renderServerBlock(host, port, ssl) {
  const loc = locationBlock(port);
  if (ssl && ssl.enabled && ssl.cert && ssl.key) {
    return [
      'server {',
      '    listen 80;',
      `    server_name ${host};`,
      '    return 301 https://$host$request_uri;',
      '}',
      'server {',
      '    listen 443 ssl;',
      `    server_name ${host};`,
      `    ssl_certificate     ${ssl.cert};`,
      `    ssl_certificate_key ${ssl.key};`,
      loc,
      '}'
    ].join('\n');
  }
  return [
    'server {',
    '    listen 80;',
    `    server_name ${host};`,
    loc,
    '}'
  ].join('\n');
}

/**
 * Pure: render the full managed nginx conf for the given apps + custom routes.
 * @param {Array<{name:string,port:number,status:string,is_default:number}>} apps
 * @param {Array<{host:string,target_type:string,target_port:number,target_app_id:number}>} routes
 * @param {{baseDomain:string, ssl:{enabled?:boolean,cert?:string,key?:string}}} opts
 * @returns {string}
 */
function renderProxyConfig(apps, routes = [], opts = {}) {
  const { baseDomain = '', ssl } = opts;
  if (baseDomain) validateBaseDomain(baseDomain);

  // Coerce port to a safe integer and skip apps whose port isn't a finite
  // positive integer — guards against a theoretical string-injection vector
  // from a manually-edited DB. Uses the coerced port (not a.port) downstream.
  const running = apps
    .map(a => ({ a, port: Math.floor(Number(a.port)) }))
    .filter(({ a, port }) => a.status === 'running' && Number.isFinite(port) && port > 0)
    .sort(({ a: x }, { a: y }) => x.name.localeCompare(y.name));

  const blocks = [];

  // 1. Custom routes first (explicit admin config wins over auto-generated
  //    subdomains on a name collision). Always HTTP-only in v1.
  const routesSorted = (routes || [])
    .filter(r => typeof r.host === 'string' && /^[\w.-]+$/.test(r.host))
    .sort((x, y) => x.host.localeCompare(y.host));
  for (const r of routesSorted) {
    let port = null;
    if (r.target_type === 'port') {
      const p = Math.floor(Number(r.target_port));
      if (Number.isFinite(p) && p >= 1 && p <= 65535) port = p;
    } else if (r.target_type === 'app') {
      const target = running.find(({ a }) => a.id === r.target_app_id);
      if (target) port = target.port;
    }
    if (port) blocks.push(renderServerBlock(r.host, port, null));
  }

  // 2. Auto subdomain + 3. root-domain default app blocks (only when a base
  //    domain is configured).
  if (baseDomain) {
    for (const { a, port } of running) {
      blocks.push(renderServerBlock(`${a.name}.${baseDomain}`, port, ssl));
    }
    const def = running.find(({ a }) => a.is_default);
    if (def) {
      blocks.push(renderServerBlock(`${baseDomain} www.${baseDomain}`, def.port, ssl));
    }
  }

  if (blocks.length === 0) return HEADER + '\n';
  return HEADER + '\n' + blocks.join('\n\n') + '\n';
}

/**
 * Validate + normalize a proxy-route input. Returns { host, target_type,
 * target_port, target_app_id } or throws a descriptive Error (prefix
 * "Invalid proxy route: " so routes can map it to a 400).
 * @param {{host?:string, target_type?:string, target_port?:any, target_app_id?:any}} input
 * @param {{apps?:Array<{id:number}>}} ctx apps list for target_type='app' existence check
 */
function validateProxyRoute(input = {}, ctx = {}) {
  const host = String(input.host || '').trim().toLowerCase();
  if (!/^[\w.-]+$/.test(host)) {
    throw new Error('Invalid proxy route: host must be a valid domain (letters, digits, dots, hyphens)');
  }
  const targetType = input.target_type;
  if (targetType !== 'port' && targetType !== 'app') {
    throw new Error("Invalid proxy route: target_type must be 'port' or 'app'");
  }
  if (targetType === 'port') {
    const port = Math.floor(Number(input.target_port));
    if (!Number.isFinite(port) || port < 1 || port > 65535 || input.target_app_id != null) {
      throw new Error('Invalid proxy route: port target requires target_port (1-65535) and no target_app_id');
    }
    return { host, target_type: 'port', target_port: port, target_app_id: null };
  }
  const appId = Math.floor(Number(input.target_app_id));
  if (!Number.isFinite(appId) || appId < 1 || input.target_port != null) {
    throw new Error('Invalid proxy route: app target requires target_app_id and no target_port');
  }
  if (!(ctx.apps || []).some(a => a.id === appId)) {
    throw new Error('Invalid proxy route: target app not found');
  }
  return { host, target_type: 'app', target_port: null, target_app_id: appId };
}

/**
 * Validate + normalize a proxy-domain (domain-pool) input. Returns { host } or
 * throws a descriptive Error (prefix "Invalid proxy domain: " so routes can map
 * it to a 400).
 * @param {{host?:string}} input
 */
function validateProxyDomain(input = {}) {
  const host = String(input.host || '').trim().toLowerCase();
  if (!/^[\w.-]+$/.test(host)) {
    throw new Error('Invalid proxy domain: host must be a valid domain (letters, digits, dots, hyphens)');
  }
  return { host };
}

function binError(bin, err, lead) {
  if (err.code === 'ENOENT' || /command not found|not recognized|127/.test(err.message || '')) {
    return `nginx binary not found ('${bin}')`;
  }
  return `${lead}: ${(err.stderr || err.stdout || err.message || '').trim().slice(-400)}`;
}

/**
 * Regenerate the managed edge-proxy conf from all apps, then test + reload nginx.
 * Never throws: every failure is caught and returned as { ok:false } + warning,
 * so app start/stop/delete are never blocked by a proxy problem.
 *
 * @param {{ execFn?: (cmd:string, opts:object) => Promise<{stdout:string,stderr:string}> }} scope
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, message?:string}>}
 */
async function regenerate(scope = {}) {
  const execFn = scope.execFn || ((cmd, opts) => execPromise(cmd, opts));

  if (!config.deployment.proxyEnabled) {
    return { ok: true, skipped: true, reason: 'disabled' };
  }

  const baseDomain = resolveBaseDomain({
    proxyBaseDomain: config.deployment.proxyBaseDomain,
    appPublicUrlTemplate: config.deployment.appPublicUrlTemplate
  });

  const ssl = {
    enabled: config.deployment.proxySslEnabled,
    cert: config.deployment.proxySslCert,
    key: config.deployment.proxySslCertKey
  };

  let conf;
  try {
    const [apps, routes] = await Promise.all([queries.getAllApps(), queries.listProxyRoutes()]);
    if (!baseDomain && routes.length === 0) {
      console.warn('⚠ [proxy] PROXY_ENABLED but no base domain and no custom routes. Skipping.');
      return { ok: false, skipped: true, reason: 'no-base-domain' };
    }
    conf = renderProxyConfig(apps, routes, { baseDomain, ssl });
  } catch (err) {
    console.warn(`⚠ [proxy] render failed: ${err.message}`);
    return { ok: false, reason: 'render-failed', message: err.message };
  }

  const confFile = config.deployment.proxyConfFile;
  const bin = config.deployment.proxyReloadBinary;
  const EXEC_OPTS = { timeout: 15000, maxBuffer: 1024 * 1024 };

  // Snapshot the prior conf (if any) so we can roll back if `nginx -t` rejects
  // the new render — a broken conf on disk would be loaded by the next nginx
  // restart. Best-effort read; absence is fine.
  let prior = null;
  try { prior = fs.readFileSync(confFile, 'utf-8'); } catch (_e) { /* no prior file */ }

  try {
    const dir = path.dirname(confFile);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = confFile + '.tmp';
    fs.writeFileSync(tmp, conf.endsWith('\n') ? conf : conf + '\n', 'utf-8');
    fs.renameSync(tmp, confFile); // atomic replace
  } catch (err) {
    console.warn(`⚠ [proxy] could not write ${confFile}: ${err.message}`);
    return { ok: false, reason: 'write-failed', message: err.message };
  }

  // `nginx -t` validates the ENTIRE main config (incl. our include), not just
  // our file — so a bad vhost anywhere still blocks reload. Never reload on fail.
  try {
    await execFn(`"${bin}" -t`, EXEC_OPTS);
  } catch (err) {
    // Roll back the on-disk conf so a broken render can't survive a future
    // nginx restart. Best-effort: this must never throw out of the catch.
    if (prior !== null) {
      try { fs.writeFileSync(confFile, prior, 'utf-8'); } catch (_e) { /* ignore */ }
    } else {
      try { fs.unlinkSync(confFile); } catch (_e) { /* ignore */ }
    }
    const msg = binError(bin, err, 'nginx -t failed');
    console.warn(`⚠ [proxy] ${msg} — config NOT reloaded.`);
    return { ok: false, reason: 'test-failed', message: msg };
  }

  try {
    await execFn(`"${bin}" -s reload`, EXEC_OPTS);
  } catch (err) {
    const msg = binError(bin, err, 'nginx reload failed');
    console.warn(`⚠ [proxy] ${msg}`);
    return { ok: false, reason: 'reload-failed', message: msg };
  }

  return { ok: true };
}

module.exports = { renderProxyConfig, validateBaseDomain, resolveBaseDomain, validateProxyRoute, validateProxyDomain, regenerate };
