const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { init, queries } = require('../helpers/setup');
const config = require('../../config');
const ProxyManager = require('../../services/proxy-manager');

function tmpConf() { return path.join(os.tmpdir(), `mvx-proxy-${process.pid}-${Math.floor(Math.random() * 1e9)}.conf`); }

// Save/restore the config knobs each test mutates so tests stay isolated.
function snapshot() {
  return {
    proxyEnabled: config.deployment.proxyEnabled,
    proxyBaseDomain: config.deployment.proxyBaseDomain,
    proxyConfFile: config.deployment.proxyConfFile,
    proxySslEnabled: config.deployment.proxySslEnabled,
    proxySslCert: config.deployment.proxySslCert,
    proxySslCertKey: config.deployment.proxySslCertKey
  };
}
function restore(s) { Object.assign(config.deployment, s); }

test('regenerate is a no-op when proxy disabled', async () => {
  const s = snapshot();
  config.deployment.proxyEnabled = false;
  try {
    const r = await ProxyManager.regenerate();
    assert.equal(r.skipped, true);
    assert.equal(r.reason, 'disabled');
  } finally { restore(s); }
});

test('regenerate skips with a warning when base domain is missing', async () => {
  const s = snapshot();
  config.deployment.proxyEnabled = true;
  config.deployment.proxyBaseDomain = '';
  // Also ensure no template-derived domain leaks in from the env:
  const prevTpl = config.deployment.appPublicUrlTemplate;
  config.deployment.appPublicUrlTemplate = '';
  try {
    const r = await ProxyManager.regenerate();
    assert.equal(r.ok, false);
    assert.equal(r.skipped, true);
    assert.equal(r.reason, 'no-base-domain');
  } finally {
    config.deployment.appPublicUrlTemplate = prevTpl;
    restore(s);
  }
});

test('regenerate writes conf and runs nginx -t then -s reload', async () => {
  const s = snapshot();
  const confFile = tmpConf();
  config.deployment.proxyEnabled = true;
  config.deployment.proxyBaseDomain = 'example.com';
  config.deployment.proxyConfFile = confFile;
  config.deployment.proxySslEnabled = false;
  await init();
  const a = await queries.createApp({ name: 'proxyren-' + Math.floor(Math.random() * 1e9), path: '/tmp/p', deploy_type: 'http-server', port: 3333, status: 'running' });
  const calls = [];
  const execFn = async (cmd) => { calls.push(cmd); return { stdout: '', stderr: '' }; };
  try {
    const r = await ProxyManager.regenerate({ execFn });
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(confFile));
    assert.match(fs.readFileSync(confFile, 'utf-8'), /server_name .*\.example\.com;/);
    assert.match(calls.join(' | '), /-t/);
    assert.match(calls.join(' | '), /-s reload/);
  } finally {
    try { fs.unlinkSync(confFile); } catch (_e) {}
    await queries.deleteApp(a.lastID).catch(() => {});
    restore(s);
  }
});

test('regenerate does NOT reload when nginx -t fails', async () => {
  const s = snapshot();
  const confFile = tmpConf();
  config.deployment.proxyEnabled = true;
  config.deployment.proxyBaseDomain = 'example.com';
  config.deployment.proxyConfFile = confFile;
  config.deployment.proxySslEnabled = false;
  await init();
  const execFn = async (cmd) => {
    if (cmd.includes(' -t')) {
      throw Object.assign(new Error('syntax error'), { stderr: 'nginx: syntax error' });
    }
    throw new Error('reload must not run when -t failed');
  };
  try {
    const r = await ProxyManager.regenerate({ execFn });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'test-failed');
  } finally {
    try { fs.unlinkSync(confFile); } catch (_e) {}
    restore(s);
  }
});
