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

-- Custom domain -> port/app reverse-proxy mappings (edge proxy, opt-in via PROXY_ENABLED)
CREATE TABLE IF NOT EXISTS proxy_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL UNIQUE,
  target_type TEXT NOT NULL CHECK(target_type IN ('port','app')),
  target_port INTEGER,
  target_app_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (target_app_id) REFERENCES apps(id) ON DELETE CASCADE,
  CHECK (
    (target_type='port' AND target_port IS NOT NULL AND target_app_id IS NULL) OR
    (target_type='app'  AND target_app_id IS NOT NULL AND target_port IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_proxy_routes_host ON proxy_routes(host);

-- Domain pool: pre-registered custom domains the admin can pick from when
-- creating a proxy_routes mapping. Purely a candidate list — only proxy_routes
-- (not this table) affects the rendered nginx config.
CREATE TABLE IF NOT EXISTS proxy_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_proxy_domains_host ON proxy_domains(host);
