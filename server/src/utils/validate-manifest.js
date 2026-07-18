const { isValidAppName } = require('./validate-app-name');
const VALID_DEPLOY_TYPES = ['npm', 'http-server', 'nginx'];

/**
 * Validate a backup manifest object (name + deploy_type).
 * @returns {string|null} error message, or null when valid.
 */
function validateManifest(manifest) {
  // Message kept identical to before so the restore route's 400 matcher
  // (which looks for 'Invalid app name') still fires.
  if (!isValidAppName(manifest && manifest.name)) {
    return 'Invalid app name in backup';
  }
  if (!VALID_DEPLOY_TYPES.includes(manifest.deploy_type)) {
    return 'Invalid deploy_type in backup';
  }
  return null;
}

module.exports = { validateManifest, VALID_DEPLOY_TYPES };
