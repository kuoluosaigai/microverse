const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Get database path from environment or use default
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../..', 'data', 'microverse.sqlite');

// Ensure data directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Initialize database connection
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('✗ Database connection failed:', err.message);
    throw err;
  }

  if (process.env.NODE_ENV === 'development') {
    console.log('✓ Database connected');
  }
});

// Enable foreign keys
db.run('PRAGMA foreign_keys = ON');

// Promise wrapper for database operations
const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
};

const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const dbExec = (sql) => {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
};

// Initialize database schema
async function initDatabase() {
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    await dbExec(schema);
    await applyMigrations();

    console.log('✓ Database initialized successfully');
    console.log(`✓ Database path: ${DB_PATH}`);
  } catch (error) {
    console.error('✗ Database initialization failed:', error.message);
    throw error;
  }
}

// Additive column migrations. CREATE TABLE IF NOT EXISTS will not add columns
// to an existing table, so each new column needs an ALTER guarded by presence.
// Idempotent: safe on fresh DBs (column already in schema) and existing DBs.
async function applyMigrations() {
  const cols = await dbAll(`PRAGMA table_info(apps)`);
  if (!cols.some(c => c.name === 'is_default')) {
    await dbExec(`ALTER TABLE apps ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0`);
    console.log('✓ Migration: added apps.is_default column');
  }
}

// Initialize on module load; expose the promise so callers (e.g. AuthManager
// seeding at boot) can await schema readiness before querying.
const dbReady = initDatabase().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

// Query functions
const queries = {
  // Apps queries
  getAllApps: () => dbAll('SELECT * FROM apps ORDER BY created_at DESC'),

  getAllClaimedPorts: () => dbAll('SELECT port FROM apps WHERE port IS NOT NULL'),

  getAppById: (id) => dbGet('SELECT * FROM apps WHERE id = ?', [id]),

  getAppByName: (name) => dbGet('SELECT * FROM apps WHERE name = ?', [name]),

  createApp: async (params) => {
    const result = await dbRun(
      'INSERT INTO apps (name, path, deploy_type, port, status) VALUES (?, ?, ?, ?, ?)',
      [params.name, params.path, params.deploy_type, params.port, params.status]
    );
    return result;
  },

  updateApp: async (params) => {
    const result = await dbRun(
      `UPDATE apps SET
        path = COALESCE(?, path),
        deploy_type = COALESCE(?, deploy_type),
        port = COALESCE(?, port),
        status = COALESCE(?, status),
        is_default = COALESCE(?, is_default)
      WHERE id = ?`,
      [params.path, params.deploy_type, params.port, params.status, params.is_default, params.id]
    );
    return result;
  },

  // Clear every app's default flag (used inside setDefaultApp's transaction).
  clearDefaultApp: () => dbRun('UPDATE apps SET is_default = 0 WHERE is_default = 1'),

  // Single-default: atomically clear all, then set one. Returns the updated row.
  setDefaultApp: async (id) => {
    await dbRun('BEGIN TRANSACTION');
    try {
      await dbRun('UPDATE apps SET is_default = 0 WHERE is_default = 1');
      await dbRun('UPDATE apps SET is_default = 1 WHERE id = ?', [id]);
      await dbRun('COMMIT');
    } catch (err) {
      await dbRun('ROLLBACK').catch(() => { /* ignore rollback failure */ });
      throw err;
    }
    return dbGet('SELECT * FROM apps WHERE id = ?', [id]);
  },

  updateAppStatus: (status, id) => dbRun('UPDATE apps SET status = ? WHERE id = ?', [status, id]),

  deleteApp: (id) => dbRun('DELETE FROM apps WHERE id = ?', [id]),

  getAppEnv: (appId) => dbAll(
    'SELECT key, value FROM app_env WHERE app_id = ? ORDER BY id',
    [appId]
  ),

  setAppEnv: async (appId, entries) => {
    // Atomic replace: delete all, then insert. sqlite3 runs statements in
    // order on a single connection, so awaited dbRun calls serialize.
    await dbRun('BEGIN TRANSACTION');
    try {
      await dbRun('DELETE FROM app_env WHERE app_id = ?', [appId]);
      for (const entry of entries) {
        await dbRun(
          'INSERT INTO app_env (app_id, key, value) VALUES (?, ?, ?)',
          [appId, entry.key, entry.value === undefined ? null : entry.value]
        );
      }
      await dbRun('COMMIT');
    } catch (err) {
      await dbRun('ROLLBACK').catch(() => { /* ignore rollback failure */ });
      throw err;
    }
    return dbAll('SELECT key, value FROM app_env WHERE app_id = ? ORDER BY id', [appId]);
  },

  // Git-source queries (see app_git_source in schema.sql)
  getAppGitSource: (appId) => dbGet('SELECT * FROM app_git_source WHERE app_id = ?', [appId]),

  getAllAppGitSources: () => dbAll('SELECT * FROM app_git_source'),

  // Bind (or re-bind) the app's source. An omitted webhook_secret keeps the
  // stored one, so a re-bind that only changes url/branch does not rotate it.
  upsertAppGitSource: ({ appId, url, branch, autoUpdate, webhookSecret }) => dbRun(
    `INSERT INTO app_git_source (app_id, url, branch, auto_update, webhook_secret)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(app_id) DO UPDATE SET
       url = excluded.url,
       branch = excluded.branch,
       auto_update = excluded.auto_update,
       webhook_secret = COALESCE(excluded.webhook_secret, app_git_source.webhook_secret),
       updated_at = CURRENT_TIMESTAMP`,
    [appId, url, branch || 'main', autoUpdate === undefined ? 1 : (autoUpdate ? 1 : 0), webhookSecret ?? null]
  ),

  setGitRemoteCommit: (appId, sha) => dbRun(
    'UPDATE app_git_source SET remote_commit = ?, updated_at = CURRENT_TIMESTAMP WHERE app_id = ?',
    [sha, appId]
  ),

  setGitAutoUpdate: (appId, enabled) => dbRun(
    'UPDATE app_git_source SET auto_update = ?, updated_at = CURRENT_TIMESTAMP WHERE app_id = ?',
    [enabled ? 1 : 0, appId]
  ),

  // Drop deployment progress (new repo/branch binding) but keep the binding.
  resetGitSourceProgress: (appId) => dbRun(
    `UPDATE app_git_source SET
       deployed_commit = NULL,
       remote_commit = NULL,
       synced_at = NULL,
       last_status = 'idle',
       last_error = NULL,
       sync_started_at = NULL,
       updated_at = CURRENT_TIMESTAMP
     WHERE app_id = ?`,
    [appId]
  ),

  // Exclusive cross-worker sync claim: succeeds only when no other sync holds
  // a fresh claim. A claim older than staleMs is considered abandoned (crashed
  // worker) and may be stolen.
  claimGitSync: async (appId, staleMs) => {
    const modifier = `-${Math.max(1, Math.floor(staleMs / 1000))} seconds`;
    const result = await dbRun(
      `UPDATE app_git_source
          SET last_status = 'updating', sync_started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE app_id = ?
          AND (last_status != 'updating'
               OR sync_started_at IS NULL
               OR sync_started_at < datetime('now', ?))`,
      [appId, modifier]
    );
    return result.changes > 0;
  },

  // Record the outcome of a claimed sync and release the claim. Omitted commit
  // values keep their stored value; synced_at only advances on success.
  finishGitSync: (appId, { status, error, deployedCommit, remoteCommit } = {}) => dbRun(
    `UPDATE app_git_source SET
       last_status = ?,
       last_error = ?,
       deployed_commit = COALESCE(?, deployed_commit),
       remote_commit = COALESCE(?, remote_commit),
       synced_at = CASE WHEN ? IS NOT NULL THEN CURRENT_TIMESTAMP ELSE synced_at END,
       sync_started_at = NULL,
       updated_at = CURRENT_TIMESTAMP
     WHERE app_id = ?`,
    [status, error ?? null, deployedCommit ?? null, remoteCommit ?? null, deployedCommit ?? null, appId]
  ),

  // Advertise a new remote commit without clobbering a fresh in-flight sync.
  // staleMs is config.git.staleSyncMs when called from the webhook handler.
  markGitUpdateAvailable: (appId, staleMs = 30 * 60 * 1000) => {
    const modifier = `-${Math.max(1, Math.floor(staleMs / 1000))} seconds`;
    return dbRun(
      `UPDATE app_git_source
          SET last_status = 'update_available', updated_at = CURRENT_TIMESTAMP
        WHERE app_id = ?
          AND (last_status != 'updating'
               OR sync_started_at IS NULL
               OR sync_started_at < datetime('now', ?))`,
      [appId, modifier]
    );
  },

  deleteAppGitSource: (appId) => dbRun('DELETE FROM app_git_source WHERE app_id = ?', [appId]),

  // npm install/build fingerprint state (see app_deploy_state in schema.sql)
  getAppDeployState: (appId) => dbGet(
    'SELECT install_fp, build_fp FROM app_deploy_state WHERE app_id = ?',
    [appId]
  ),

  // Upsert either or both fingerprints; passing null/undefined for a column
  // keeps the stored value (COALESCE), so install-success can persist before
  // build-success does. NULL build_fp cannot be re-set to null this way — fine,
  // build_fp only moves forward once a build runs.
  setUpDeployState: async (appId, { installFp, buildFp }) => dbRun(
    `INSERT INTO app_deploy_state (app_id, install_fp, build_fp) VALUES (?, ?, ?)
     ON CONFLICT(app_id) DO UPDATE SET
       install_fp = COALESCE(excluded.install_fp, app_deploy_state.install_fp),
       build_fp   = COALESCE(excluded.build_fp, app_deploy_state.build_fp),
       updated_at = CURRENT_TIMESTAMP`,
    [appId, installFp ?? null, buildFp ?? null]
  ),

  // Metrics queries (shared store for the cluster — see metrics table in schema.sql)
  insertMetric: (appName, sample) => dbRun(
    'INSERT INTO metrics (app_name, ts, cpu, memory, uptime_ms) VALUES (?, ?, ?, ?, ?)',
    [appName, sample.ts, sample.cpu, sample.memory, sample.uptimeMs == null ? null : sample.uptimeMs]
  ),

  getLatestMetric: (appName) => dbGet(
    'SELECT ts, cpu, memory, uptime_ms FROM metrics WHERE app_name = ? ORDER BY ts DESC, id DESC LIMIT 1',
    [appName]
  ),

  getMetricHistory: (appName) => dbAll(
    'SELECT ts, cpu, memory, uptime_ms FROM metrics WHERE app_name = ? ORDER BY ts ASC, id ASC',
    [appName]
  ),

  // Remove every sample for an app. The FK cascade covers databases created
  // with the current schema; this explicit delete also covers DBs whose metrics
  // table predates the FK (CREATE TABLE IF NOT EXISTS never rebuilds it).
  deleteMetricsForApp: (appName) => dbRun('DELETE FROM metrics WHERE app_name = ?', [appName]),

  // Keep only the newest `keep` samples for an app (ring-buffer semantics).
  pruneMetrics: (appName, keep) => dbRun(
    `DELETE FROM metrics WHERE app_name = ? AND id NOT IN (
       SELECT id FROM metrics WHERE app_name = ? ORDER BY ts DESC, id DESC LIMIT ?
     )`,
    [appName, appName, keep]
  ),

  // Proxy route queries (custom domain -> port/app mappings)
  listProxyRoutes: () => dbAll('SELECT * FROM proxy_routes ORDER BY id'),

  getProxyRouteById: (id) => dbGet('SELECT * FROM proxy_routes WHERE id = ?', [id]),

  createProxyRoute: (params) => dbRun(
    'INSERT INTO proxy_routes (host, target_type, target_port, target_app_id) VALUES (?, ?, ?, ?)',
    [params.host, params.target_type, params.target_port ?? null, params.target_app_id ?? null]
  ),

  updateProxyRoute: (id, params) => dbRun(
    'UPDATE proxy_routes SET host = ?, target_type = ?, target_port = ?, target_app_id = ? WHERE id = ?',
    [params.host, params.target_type, params.target_port ?? null, params.target_app_id ?? null, id]
  ),

  deleteProxyRoute: (id) => dbRun('DELETE FROM proxy_routes WHERE id = ?', [id]),

  // Proxy domain queries (pre-registered domain pool for custom-domain mapping)
  listProxyDomains: () => dbAll('SELECT * FROM proxy_domains ORDER BY id'),

  createProxyDomain: (params) => dbRun(
    'INSERT INTO proxy_domains (host) VALUES (?)',
    [params.host]
  ),

  deleteProxyDomain: (id) => dbRun('DELETE FROM proxy_domains WHERE id = ?', [id]),

  // User queries (admin auth)
  getUserCount: () => dbGet('SELECT COUNT(*) AS count FROM users'),

  getUserByUsername: (username) => dbGet('SELECT * FROM users WHERE username = ?', [username]),

  // Idempotent seed: under PM2 cluster several workers call ensureAdmin at boot
  // and all may pass the count check before any insert lands. ON CONFLICT makes
  // the duplicate inserts no-ops (changes=0) instead of UNIQUE-constraint errors.
  createUser: (username, passwordHash) => dbRun(
    'INSERT INTO users (username, password_hash) VALUES (?, ?) ON CONFLICT(username) DO NOTHING',
    [username, passwordHash]
  )
};

module.exports = {
  db,
  queries,
  dbReady,
  dbAll,
  dbRun,
  applyMigrations
};
