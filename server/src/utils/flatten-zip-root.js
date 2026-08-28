const fs = require('fs');
const path = require('path');

/**
 * Iteratively hoist a zip's leading single-directory wrappers up into `dir`.
 *
 * GitHub/IDE zips often wrap their contents in a top-level folder, and that
 * folder can nest several levels deep (e.g. `repo-main/dist/index.html`). As
 * long as `dir` contains exactly one non-ignored entry and it is a directory,
 * that level is unambiguous to unwrap: hoist its children up into `dir`, drop
 * the now-empty wrapper, and repeat. Stop at the first level that is NOT a lone
 * directory (multiple non-ignored entries, a single file, or empty) — that's
 * ambiguous, so leave it as-is rather than guess which folder is the web root.
 *
 * `ignore` is a Set of top-level names to skip (platform-managed entries like
 * `node_modules` that legitimately live alongside the wrapper and must not stop
 * the unwrap).
 *
 * Safe by construction: each step only acts when the sole non-ignored entry is
 * the wrapper, so there is nothing else at that level to collide with.
 *
 * @param {string} dir absolute directory path
 * @param {Set<string>} [ignore] top-level names to ignore (default empty)
 * @returns {string|null} the unwrapped path prefix (e.g. 'repo-main/dist') if
 *   any wrappers were flattened, else null. Joined with '/' so it matches the
 *   forward-slash entry names adm-zip reports.
 */
function flattenTopDirs(dir, ignore = new Set()) {
  const stripped = [];
  for (;;) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_e) {
      return null;
    }
    const candidates = entries.filter((e) => !ignore.has(e.name));
    if (candidates.length !== 1 || !candidates[0].isDirectory()) break;

    const wrapper = path.join(dir, candidates[0].name);
    const children = fs.readdirSync(wrapper, { withFileTypes: true });
    for (const child of children) {
      fs.renameSync(path.join(wrapper, child.name), path.join(dir, child.name));
    }
    fs.rmdirSync(wrapper); // empty now
    stripped.push(candidates[0].name);
  }
  return stripped.length > 0 ? stripped.join('/') : null;
}

module.exports = { flattenTopDirs };
