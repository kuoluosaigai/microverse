const path = require('path');

/**
 * True iff entryName resolves strictly inside root (no zip-slip traversal).
 * Guards against sibling directories sharing a prefix (root + path.sep).
 */
function isSafeEntry(root, entryName) {
  const safeRoot = path.resolve(root);
  const target = path.resolve(root, entryName);
  return target === safeRoot || target.startsWith(safeRoot + path.sep);
}

module.exports = { isSafeEntry };
