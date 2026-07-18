// Canonical app-name format. Shared by AppManager.createApp (covers POST /apps
// and restore, which calls createApp) and by validateManifest, so the create
// and restore paths can't drift. path-helper.getAppDir retains its own
// defensive check as a backstop; if that is ever consolidated, route it here.
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
