const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const LogManager = require('../../services/log-manager');

test('getLogPaths: nginx app returns app-dir nginx logs when present', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nginx-logs-'));
  fs.writeFileSync(path.join(dir, 'nginx-access.log'), 'GET / 200\n');
  fs.writeFileSync(path.join(dir, 'nginx-error.log'), 'warn line\n');
  try {
    const paths = await LogManager.getLogPaths({ name: 'x', deploy_type: 'nginx', path: dir });
    assert.equal(paths.outPath, path.join(dir, 'nginx-access.log'));
    assert.equal(paths.errPath, path.join(dir, 'nginx-error.log'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getLogPaths: nginx app with no log files returns nulls', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nginx-logs-'));
  try {
    const paths = await LogManager.getLogPaths({ name: 'x', deploy_type: 'nginx', path: dir });
    assert.equal(paths.outPath, null);
    assert.equal(paths.errPath, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
