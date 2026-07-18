// PM2 ecosystem for production. Run from the server/ directory:
//   npm run pm2:start        # start (cluster mode, one worker per core)
//   npm run pm2:logs
//   pm2 reload microverse-server   # zero-downtime reload after an update
//
// PORT / CORS_ORIGIN / ADMIN_* / SESSION_SECRET etc. are read from the repo
// root .env by server/src/config on each worker boot.
module.exports = {
  apps: [
    {
      name: 'microverse-server',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 'max',          // cluster: one worker per core (or set a number)
      exec_mode: 'cluster',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '512M'
    }
  ]
};
