const path = require('path');
const fs = require('fs');

/**
 * Upload filename hardening.
 *
 * sanitizeFilename: defangs an untrusted client-supplied name so it can only
 * ever be a single benign file inside the target directory:
 *  - NUL bytes and control characters removed (poison names like "a\x00b.html")
 *  - path separators neutralized, then path.basename as belt-and-suspenders
 *    (no "../", no absolute paths, no drive letters)
 *  - Windows-reserved characters <>:"|?* replaced, trailing dots/spaces
 *    stripped (both silently mangled or rejected by NTFS)
 *  - Windows device names (CON, NUL, COM1..LPT9) prefixed with "_"
 *  - "." / ".." / empty collapse to a fallback base name
 *  - byte-length capped at 255 (filesystem limit), extension preserved
 *
 * uniqueFilename: collision handling at write time — never silently overwrite
 * an existing file; produce "name (1).ext", "name (2).ext", ...
 */

const MAX_NAME_BYTES = 255;
// Windows reserves device names regardless of extension: "con", "con.txt" and
// "LPT9.tar.gz" are ALL device references — match the stem before the first dot.
const DEVICE_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

function sanitizeFilename(rawName, fallback = 'file') {
  let name = String(rawName == null ? '' : rawName);

  // NUL + C0/C1 control characters.
  name = name.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  // Separators -> '_' keeps the name readable while killing traversal.
  name = name.replace(/[\/\\]/g, '_');
  // Whatever survived, reduce to the last component (handles odd leftovers).
  name = path.basename(name);
  // Windows-reserved characters.
  name = name.replace(/[<>:"|?*]/g, '_');
  // Windows: names may not end in dots or spaces.
  name = name.replace(/[.\s]+$/, '');

  if (name === '' || name === '.' || name === '..') {
    name = fallback;
  }

  // Device names are reserved with ANY extension ("con.txt" included).
  if (DEVICE_NAME_RE.test(name)) {
    name = `_${name}`;
  }

  // Byte-cap the base so base + ext stays within filesystem limits.
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  const extBytes = Buffer.byteLength(ext, 'utf8');
  let baseBytes = Buffer.byteLength(base, 'utf8');
  if (baseBytes + extBytes > MAX_NAME_BYTES) {
    let truncated = base;
    while (Buffer.byteLength(truncated, 'utf8') > MAX_NAME_BYTES - extBytes) {
      truncated = truncated.slice(0, -1);
    }
    // Truncation may have re-exposed a trailing dot/space.
    truncated = truncated.replace(/[.\s]+$/, '');
    name = truncated + ext;
  }

  return name;
}

/**
 * Collision-free name for `name` inside `dir`.
 * `reserved` (optional Set) covers names already handed out for the CURRENT
 * request: multer fires every file part's filename() callback before the
 * earlier files' write streams have opened on disk, so an existsSync-only
 * check would miss same-request duplicates.
 */
function uniqueFilename(dir, name, reserved) {
  const taken = (n) => (reserved && reserved.has(n)) || fs.existsSync(path.join(dir, n));
  if (!taken(name)) {
    return name;
  }
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${base} (${i})${ext}`;
    if (!taken(candidate)) {
      return candidate;
    }
  }
  // Pathological collision storm — timestamp suffix is effectively unique.
  return `${base} (${Date.now()})${ext}`;
}

module.exports = { sanitizeFilename, uniqueFilename };
