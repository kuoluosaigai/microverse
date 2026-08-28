const fs = require('fs');
const path = require('path');

/**
 * Iteratively hoist a zip's leading single-directory wrappers up into `dir`.
 *
 * GitHub/IDE zips often wrap their contents in a top-level folder, and that
 * folder can nest several levels deep (e.g. `repo-main/dist/index.html`). As
 * long as `dir` contains exactly one entry and it is a directory, that level is
 * unambiguous to unwrap: hoist its children up into `dir`, drop the now-empty
 * wrapper, and repeat. Stop at the first level that is NOT a lone directory
 * (multiple entries, a single file, or empty) — that's ambiguous, so leave it
 * as-is rather than guess which folder is the web root.
 *
 * Safe by construction: each step only acts when the sole entry is the wrapper,
 * so there is nothing else at that level to collide with during the hoist.
 *
 * @param {string} dir absolute directory path
 * @returns {string|null} the unwrapped path prefix (e.g. 'repo-main/dist') if
 *   any wrappers were flattened, else null. Joined with '/' so it matches the
 *   forward-slash entry names adm-zip reports.
 */
function flattenTopDirs(dir) {
  const stripped = [];
  for (;;) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_e) {
      return null;
    }
    if (entries.length !== 1 || !entries[0].isDirectory()) break;

    const wrapper = path.join(dir, entries[0].name);
    const children = fs.readdirSync(wrapper, { withFileTypes: true });
    for (const child of children) {
      fs.renameSync(path.join(wrapper, child.name), path.join(dir, child.name));
    }
    fs.rmdirSync(wrapper); // empty now
    stripped.push(entries[0].name);
  }
  return stripped.length > 0 ? stripped.join('/') : null;
}

module.exports = { flattenTopDirs };
