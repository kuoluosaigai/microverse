const path = require('path');

/**
 * Upload filename hardening.
 *
 * sanitizeFilename defangs an untrusted client-supplied name so it can only
 * ever be a single benign file inside the target directory:
 *  - NUL bytes and control characters removed (poison names like "a\x00b.html")
 *  - path separators neutralized, then path.basename as belt-and-suspenders
 *    (no "../", no absolute paths, no drive letters)
 *  - Windows-reserved characters <>:"|?* replaced, trailing dots/spaces
 *    stripped (both silently mangled or rejected by NTFS)
 *  - Windows device names (CON, NUL, COM1..LPT9) prefixed with "_"
 *  - "." / ".." / empty collapse to a fallback base name
 *  - byte-length capped at 255 (filesystem limit), extension preserved when it
 *    leaves room for a non-empty base
 *
 * Two uploads that collide on a name are treated differently depending on where
 * the collision comes from:
 *  - different REQUESTS collide on purpose: re-uploading "index.html" is how a
 *    user updates the file the app serves, so the later write replaces the
 *    earlier one. Nothing outside the caller's own app directory can be reached
 *    (traversal is removed above), so overwriting only ever touches the user's
 *    own content.
 *  - two parts of the SAME REQUEST must not share a path: multer opens one write
 *    stream per part, and concurrent streams into one file interleave their
 *    bytes into a corrupt merge (observed: "<h1>first</h1>>" — the tail of the
 *    longer part left under the shorter one). `uniqueInRequest` hands the later
 *    part its own name, so nothing is mangled or silently dropped.
 */

const MAX_NAME_BYTES = 255;
// Room kept free inside the cap for the " (n)" collision counter, so the
// counter is never the part that gets truncated away — a candidate that stopped
// growing would make uniqueInRequest hand back the same name forever.
const COUNTER_RESERVE_BYTES = 16;
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

  name = capToBytes(name, fallback);

  // Device names are reserved with ANY extension ("con.txt" included). Done
  // after the cap: the "_" prefix adds a single ASCII byte to a name that is
  // already capped, and no capped name can start with a device stem that the
  // prefix would push back over the limit.
  if (DEVICE_NAME_RE.test(name)) {
    name = `_${name}`;
  }

  return name || fallback;
}

/**
 * Truncate `name` to MAX_NAME_BYTES UTF-8 bytes, keeping the extension when
 * there is room for a non-empty base.
 *
 * Terminates for EVERY input. The old loop shrank the base while holding the
 * extension fixed, so an over-long extension — "a." + 300 chars, where
 * path.extname() returns those 301 bytes — made the budget negative and the
 * condition `byteLength(truncated) > 255 - 301` could never become false: an
 * unbounded, purely client-controlled string hung the worker forever (the
 * event loop never returns, so the whole process stops serving).
 */
function capToBytes(name, fallback) {
  if (Buffer.byteLength(name, 'utf8') <= MAX_NAME_BYTES) {
    return name;
  }

  // An extension that alone fills the component can never leave room for a
  // base — treat the whole name as one blob instead.
  let ext = path.extname(name);
  if (Buffer.byteLength(ext, 'utf8') >= MAX_NAME_BYTES) {
    ext = '';
  }
  const budget = MAX_NAME_BYTES - Buffer.byteLength(ext, 'utf8');

  // Walk whole code points (never single UTF-16 units) so truncation cannot
  // leave a lone surrogate behind.
  let base = '';
  let used = 0;
  for (const ch of name.slice(0, name.length - ext.length)) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > budget) break;
    base += ch;
    used += size;
  }

  // Truncation may have re-exposed a trailing dot/space. A result that still
  // STARTS with a dot (".html".repeat(70) -> ".html.html…") is kept as is: a
  // dot-leading name is a legal, single-component file — hidden on POSIX, but
  // it cannot traverse anywhere, and inventing a prefix here would only make
  // the deployed filename differ from the one the user uploaded.
  let out = (base + ext).replace(/[.\s]+$/, '');
  if (out === '' || out === '.' || out === '..') {
    out = fallback;
  }
  return out;
}

/**
 * Give `name` a slot no earlier part of the SAME request already claimed.
 *
 * `reserved` is a per-request Set owned by the caller: multer calls filename()
 * once per part, in part order, and opens a write stream per part. Two parts
 * landing on one path would interleave their bytes into a corrupt merge, so the
 * later part gets "base (1).ext", "base (2).ext", ...
 *
 * The disk is deliberately NOT consulted — that is what makes re-uploading a
 * file in a NEW request replace it (see the module header).
 *
 * Always returns a name within MAX_NAME_BYTES, and always terminates: the
 * counter is written into a head that was shortened first, so it can never be
 * truncated away (a candidate that stopped growing would spin forever).
 */
function uniqueInRequest(reserved, name) {
  if (!reserved || !reserved.has(name)) return name;

  let ext = path.extname(name);
  // An extension that leaves no room for "base (n)" is dropped outright.
  if (Buffer.byteLength(ext, 'utf8') >= MAX_NAME_BYTES - COUNTER_RESERVE_BYTES) {
    ext = '';
  }
  const headBudget = MAX_NAME_BYTES - Buffer.byteLength(ext, 'utf8') - COUNTER_RESERVE_BYTES;

  let head = '';
  let used = 0;
  for (const ch of name.slice(0, name.length - ext.length)) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > headBudget) break;
    head += ch;
    used += size;
  }
  if (head === '') head = 'file';

  for (let i = 1; ; i += 1) {
    const candidate = `${head} (${i})${ext}`;
    if (!reserved.has(candidate)) return candidate;
  }
}

module.exports = { sanitizeFilename, uniqueInRequest, MAX_NAME_BYTES };
