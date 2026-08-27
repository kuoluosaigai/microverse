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

  // User queries (admin auth)
  getUserCount: () => dbGet('SELECT COUNT(*) AS count FROM users'),

  getUserByUsername: (username) => dbGet('SELECT * FROM users WHERE username = ?', [username]),

  createUser: (username, passwordHash) => dbRun(
    'INSERT INTO users (username, password_hash) VALUES (?, ?)',
    [username, passwordHash]
  )
};

module.exports = {
  db,
  queries,
  dbReady,
  dbAll,
  applyMigrations
};
