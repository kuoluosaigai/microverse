/**
 * Names of platform-managed entries that live inside an app directory and must
 * survive a zip re-upload: npm's installed dependencies and nginx's per-app
 * config/pid/log files. Everything else in the directory is treated as user
 * content and is removed when a zip upload replaces the app.
 */
function platformManagedNames(app) {
  return new Set([
    'node_modules',
    `nginx.${app.name}.conf`,
    'nginx.pid',
    'nginx-access.log',
    'nginx-error.log',
  ]);
}

/**
 * Compute which pre-existing app-directory entries to delete on a zip upload.
 *
 * @param {object} app the app row ({ name, ... })
 * @param {string[]} before app-dir listing captured before this upload wrote anything
 * @param {string[]} incoming filenames written by this upload (kept)
 * @returns {string[]} names to remove (stale user content)
 */
function staleFilesToRemove(app, before, incoming) {
  const keep = platformManagedNames(app);
  for (const name of incoming) keep.add(name);
  return before.filter((name) => !keep.has(name));
}

module.exports = { staleFilesToRemove, platformManagedNames };
