const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate an env-var payload for PUT /apps/:id/env.
 * @returns {string|null} error message, or null when valid.
 */
function validateEnvEntries(env) {
  if (!Array.isArray(env)) return 'env must be an array of { key, value }';
  const seen = new Set();
  for (const entry of env) {
    if (!entry || typeof entry.key !== 'string' || !KEY_RE.test(entry.key)) {
      return `Invalid env key: ${entry && entry.key}`;
    }
    if (seen.has(entry.key)) return `Duplicate env key: ${entry.key}`;
    seen.add(entry.key);
  }
  return null;
}

module.exports = { validateEnvEntries };
