const fs = require('fs');
const path = require('path');

/**
 * If `dir` contains exactly one entry and it is a directory, move that
 * directory's children up into `dir` and remove the now-empty wrapper.
 * Handles the common "zip wraps everything in a top-level folder" case
 * (GitHub/IDE-style zips). No-op otherwise (multiple top-level entries, or a
 * single file — ambiguous, leave as-is).
 *
 * Safe by construction: we only act when `dir`'s sole entry is the wrapper, so
 * there is nothing else at the top level to collide with during the hoist.
 *
 * @param {string} dir absolute directory path
 * @returns {string|null} the wrapper folder name if one was flattened, else null
 */
function flattenSingleTopDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_e) {
    return null;
  }
  if (entries.length !== 1 || !entries[0].isDirectory()) return null;

  const wrapperName = entries[0].name;
  const wrapper = path.join(dir, wrapperName);
  const children = fs.readdirSync(wrapper, { withFileTypes: true });
  for (const child of children) {
    fs.renameSync(path.join(wrapper, child.name), path.join(dir, child.name));
  }
  fs.rmdirSync(wrapper); // empty now
  return wrapperName;
}

module.exports = { flattenSingleTopDir };
