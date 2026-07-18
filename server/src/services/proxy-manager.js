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
    '      proxy_set_header Host              $host;',
    '      proxy_set_header X-Real-IP         $remote_addr;',
    '      proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;',
    '      proxy_set_header X-Forwarded-Proto $scheme;',
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
 * Pure: render the full managed nginx conf for the given apps.
 * @param {Array<{name:string,port:number,status:string,is_default:number}>} apps
 * @param {{baseDomain:string, ssl:{enabled?:boolean,cert?:string,key?:string}}} opts
 * @returns {string}
 */
function renderProxyConfig(apps, opts) {
  const { baseDomain, ssl } = opts;
  validateBaseDomain(baseDomain);

  const running = apps
    .filter(a => a.status === 'running' && a.port)
    .sort((a, b) => a.name.localeCompare(b.name));

  const blocks = running.map(a => renderServerBlock(`${a.name}.${baseDomain}`, a.port, ssl));

  const def = running.find(a => a.is_default);
  if (def) {
    blocks.push(renderServerBlock(`${baseDomain} www.${baseDomain}`, def.port, ssl));
  }

  if (blocks.length === 0) return HEADER + '\n';
  return HEADER + '\n' + blocks.join('\n\n') + '\n';
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
  if (!baseDomain) {
    console.warn('⚠ [proxy] PROXY_ENABLED but no base domain (set PROXY_BASE_DOMAIN or APP_PUBLIC_URL_TEMPLATE). Skipping.');
    return { ok: false, skipped: true, reason: 'no-base-domain' };
  }

  const ssl = {
    enabled: config.deployment.proxySslEnabled,
    cert: config.deployment.proxySslCert,
    key: config.deployment.proxySslCertKey
  };

  let conf;
  try {
    const apps = await queries.getAllApps();
    conf = renderProxyConfig(apps, { baseDomain, ssl });
  } catch (err) {
    console.warn(`⚠ [proxy] render failed: ${err.message}`);
    return { ok: false, reason: 'render-failed', message: err.message };
  }

  const confFile = config.deployment.proxyConfFile;
  const bin = config.deployment.proxyReloadBinary;
  const EXEC_OPTS = { timeout: 15000, maxBuffer: 1024 * 1024 };

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

module.exports = { renderProxyConfig, validateBaseDomain, resolveBaseDomain, regenerate };
