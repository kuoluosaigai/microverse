const NAME_RE = /^[a-zA-Z0-9-_]+$/;
const VALID_DEPLOY_TYPES = ['npm', 'http-server', 'nginx'];

/**
 * Validate a backup manifest object (name + deploy_type).
 * @returns {string|null} error message, or null when valid.
 */
function validateManifest(manifest) {
  if (!manifest || typeof manifest.name !== 'string' || !NAME_RE.test(manifest.name)) {
    return 'Invalid app name in backup';
  }
  if (!VALID_DEPLOY_TYPES.includes(manifest.deploy_type)) {
    return 'Invalid deploy_type in backup';
  }
  return null;
}

module.exports = { validateManifest, VALID_DEPLOY_TYPES };
