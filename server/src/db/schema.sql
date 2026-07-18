-- Microverse Apps Table
-- Stores information about deployed applications

CREATE TABLE IF NOT EXISTS apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  deploy_type TEXT CHECK(deploy_type IN ('npm', 'http-server', 'nginx')),
  port INTEGER,
  is_default INTEGER NOT NULL DEFAULT 0,
  status TEXT CHECK(status IN ('running', 'stopped')) DEFAULT 'stopped',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_apps_name ON apps(name);
CREATE INDEX IF NOT EXISTS idx_apps_status ON apps(status);

-- Trigger to update updated_at timestamp
CREATE TRIGGER IF NOT EXISTS update_apps_timestamp
AFTER UPDATE ON apps
FOR EACH ROW
BEGIN
  UPDATE apps SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Per-app environment variables (injected into PM2 at start)
CREATE TABLE IF NOT EXISTS app_env (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
  UNIQUE(app_id, key)
);

CREATE INDEX IF NOT EXISTS idx_app_env_app_id ON app_env(app_id);

-- Admin user(s) for the admin login (single-admin in v1)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
