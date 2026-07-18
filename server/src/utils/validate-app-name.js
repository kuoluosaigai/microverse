// Canonical app-name format. Used by AppManager.createApp (covers POST /apps
// and restore, which calls createApp) and by validateManifest. Kept in one
// place so the create path and the restore path can't drift.
// name flows into a filesystem path (apps/<name>), an nginx config filename
// (nginx.<name>.conf) and a PM2 process name — so the charset is tight and
// length-capped.
const APP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * @param {string} name
 * @returns {boolean}
 */
function isValidAppName(name) {
  return typeof name === 'string' && APP_NAME_RE.test(name);
}

module.exports = { isValidAppName, APP_NAME_RE };
