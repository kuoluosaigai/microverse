const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);

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

module.exports = { renderProxyConfig, validateBaseDomain, resolveBaseDomain };
