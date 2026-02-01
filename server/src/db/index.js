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

    // Execute schema
    await dbExec(schema);

    console.log('✓ Database initialized successfully');
    console.log(`✓ Database path: ${DB_PATH}`);
  } catch (error) {
    console.error('✗ Database initialization failed:', error.message);
    throw error;
  }
}

// Initialize on module load
initDatabase().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

// Query functions
const queries = {
  // Apps queries
  getAllApps: () => dbAll('SELECT * FROM apps ORDER BY created_at DESC'),

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
        status = COALESCE(?, status)
      WHERE id = ?`,
      [params.path, params.deploy_type, params.port, params.status, params.id]
    );
    return result;
  },

  updateAppStatus: (status, id) => dbRun('UPDATE apps SET status = ? WHERE id = ?', [status, id]),

  deleteApp: (id) => dbRun('DELETE FROM apps WHERE id = ?', [id])
};

module.exports = {
  db,
  queries
};
