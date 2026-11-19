const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFilePromise = promisify(execFile);

// This file is the DB-isolation fence for the whole suite. It deliberately
// requires NOTHING that can load src/db itself (no helpers/setup, no services)
// — a fence that opened the real database to check for leaks would be a joke.
//
// Two independent detectors:
//  1. Dynamic: run suspect test files as child processes with DB_PATH scrubbed
//     from the env (exactly how the dev machine hits the fallback at
//     src/db/index.js:6), and prove none of them opens <repo>/data/*.sqlite —
//     both by the db module's own init log line and by a size+mtime snapshot
//     of the real files. The snapshot alone is NOT enough: opening an
//     already-initialized DB runs only `CREATE TABLE IF NOT EXISTS` no-ops
//     and leaves the file byte-identical, so the log-line probe is what
//     catches "the file was opened at all".
//  2. Static: scan every *.test.js for module-load paths to src/db and require
//     that helpers/setup (which points DB_PATH at a per-run temp dir) is
//     required BEFORE the first such load — the house pattern documented in
//     npm-fingerprints.test.js:6-8.

const UNIT_DIR = __dirname;
const SRC_DIR = path.resolve(__dirname, '..', '..'); // server/src
const SERVER_DIR = path.resolve(SRC_DIR, '..'); // server
const REPO_ROOT = path.resolve(SERVER_DIR, '..');
const DB_INDEX = path.join(SRC_DIR, 'db', 'index.js');
const SETUP_HELPER = path.join(SRC_DIR, 'test', 'helpers', 'setup.js');
const REAL_DB = path.join(REPO_ROOT, 'data', 'microverse.sqlite');
const REAL_SESSIONS_DB = path.join(REPO_ROOT, 'data', 'sessions.sqlite');

// ---------------------------------------------------------------------------
// Minimal JS scanner: find every require('<literal>') with its brace/paren/
// bracket depth and source index. Comments, string/template literals and
// regex literals are skipped, so neither a commented-out `require('../db')`
// nor prose mentioning require() can create a phantom edge. Depth 0 means the
// call runs at module load time; a require at depth > 0 sits inside a function
// body (like git-lifecycle's lazy `function db()`) and does NOT load the
// target when the module is merely required.
// Known, accepted limits: mis-detecting a division sign as a regex start can
// hide code up to end-of-line (no require can span lines bare), and template
// literals with nested backticks inside ${...} are skipped conservatively.
// ---------------------------------------------------------------------------
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await'
]);

function scanRequires(code) {
  const out = [];
  const n = code.length;
  let i = 0;
  let depth = 0;
  // What the previous token was, decides whether '/' opens a regex literal
  // (operator position) or divides (value position).
  let prevKind = 'start'; // 'start' | 'value' | 'operator'
  const isIdentChar = (c) => /[\w$]/.test(c);

  while (i < n) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') i++;
    } else if (c === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '"' || c === "'") {
      i = skipQuoted(code, i, c);
      prevKind = 'value';
    } else if (c === '`') {
      i = skipQuoted(code, i, c);
      prevKind = 'value';
    } else if (c === '/' && prevKind !== 'value') {
      i = skipRegexLiteral(code, i);
      prevKind = 'value';
    } else if (isIdentChar(c)) {
      let j = i;
      while (j < n && isIdentChar(code[j])) j++;
      const word = code.slice(i, j);
      if (word === 'require') {
        const call = readRequireLiteral(code, j);
        if (call) {
          out.push({ spec: call.spec, depth, index: i });
          i = call.end;
          prevKind = 'value';
          continue;
        }
      }
      prevKind = REGEX_KEYWORDS.has(word) ? 'operator' : 'value';
      i = j;
    } else if (c === '(' || c === '[' || c === '{') {
      depth++;
      prevKind = 'operator';
      i++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      prevKind = 'operator';
      i++;
    } else {
      i++;
      // punctuation/whitespace: '/' after e.g. ')' or a number is division,
      // but numbers/parens already set 'value'/'operator' above; keep as-is
      // for ',' '=' ':' etc. which correctly leave operator position.
      if (',=:[!&|?;+-*%~^<>'.includes(c)) prevKind = 'operator';
    }
  }
  return out;
}

// Skip a string/template literal starting at the quote char; returns index after it.
function skipQuoted(code, i, quote) {
  const n = code.length;
  i++;
  while (i < n) {
    if (code[i] === '\\') { i += 2; continue; }
    if (code[i] === quote) return i + 1;
    if (quote !== '`' && code[i] === '\n') return i; // unterminated single-line string
    i++;
  }
  return i;
}

// Skip a regex literal starting at '/'; stops at closing '/' (outside a
// character class) or at end-of-line, then consumes flags.
function skipRegexLiteral(code, i) {
  const n = code.length;
  i++;
  let inClass = false;
  while (i < n) {
    const c = code[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '\n') return i; // regex literals cannot span lines; bail out
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      i++;
      while (i < n && /[gimsuyvd]/.test(code[i])) i++;
      return i;
    }
    i++;
  }
  return i;
}

// After the `require` identifier: match optional '(' + whitespace + one string
// literal + whitespace + ')'. Returns the spec or null (non-literal argument).
function readRequireLiteral(code, j) {
  const n = code.length;
  while (j < n && /\s/.test(code[j])) j++;
  if (code[j] !== '(') return null;
  j++;
  while (j < n && /\s/.test(code[j])) j++;
  const q = code[j];
  if (q !== '"' && q !== "'") return null;
  let k = j + 1;
  let spec = '';
  while (k < n && code[k] !== q) {
    if (code[k] === '\\') { spec += code[k + 1]; k += 2; continue; }
    spec += code[k];
    k++;
  }
  k++; // closing quote
  while (k < n && /\s/.test(code[k])) k++;
  if (code[k] !== ')') return null;
  return { spec, end: k + 1 };
}

function resolveLocal(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base + '.js', path.join(base, 'index.js'), base]) {
    try { if (fs.statSync(c).isFile()) return c; } catch (_e) { /* keep looking */ }
  }
  return null;
}

// Transitive set of modules that loading `file` pulls in. `loadTimeOnly` (used
// for src modules) follows depth-0 requires; a module whose load-time closure
// contains src/db/index.js opens the database the moment it is required.
const closureCache = new Map();
function loadClosure(file) {
  if (closureCache.has(file)) return closureCache.get(file);
  closureCache.set(file, new Set()); // cycle guard; back edges are rare and
  const result = new Set();          // only ever shorten closures, never extend
  let code;
  try { code = fs.readFileSync(file, 'utf8'); } catch (_e) { code = ''; }
  for (const r of scanRequires(code)) {
    if (r.depth !== 0) continue;
    const dep = resolveLocal(file, r.spec);
    if (!dep || dep === file) continue;
    result.add(dep);
    for (const d of loadClosure(dep)) result.add(d);
  }
  closureCache.set(file, result);
  return result;
}

function loadsDb(dep) {
  return dep === DB_INDEX || loadClosure(dep).has(DB_INDEX);
}

function listTestFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTestFiles(p));
    else if (entry.name.endsWith('.test.js')) out.push(p);
  }
  return out.sort();
}

// Files deliberately kept OFF helpers/setup. Each entry is an ASSERTION, not a
// free pass: the scan fails if the file ever gains a require (at any depth)
// whose closure loads src/db — meaning the reason below no longer holds — or
// if someone adds the setup require anyway, silently undoing the design.
const DELIBERATE_NO_HELPER = {
  'git-lifecycle-repo.test.js':
    'services/git-lifecycle.js keeps db access behind a lazy function db() ' +
    '(see its header comment) so a process exercising only the pure git ' +
    'primitives never opens the DB and never writes db init logs to stdout ' +
    '(which would corrupt node --test IPC); requiring helpers/setup here ' +
    'would load src/db and defeat that design.'
};

// ---------------------------------------------------------------------------
// Test 1 — dynamic: run suspect files as isolated children and prove the real
// data files stay untouched and unopened.
// ---------------------------------------------------------------------------
const DYNAMIC_SUSPECTS = [
  'proxy-config.test.js',      // the confirmed leak (proxy-manager -> ../db)
  'nginx-log-paths.test.js',   // loads log-manager, chain must stay db-free
  'update-state.test.js',      // loads update-manager, chain must stay db-free
  'git-lifecycle-repo.test.js' // the deliberate no-helper file: must stay clean
];

function snapshot(file) {
  try {
    const st = fs.statSync(file);
    return `present:${st.size}:${Math.round(st.mtimeMs)}`;
  } catch (_e) {
    return 'absent';
  }
}

test('the whole suite never creates or modifies the repo data/microverse.sqlite', async () => {
  for (const f of DYNAMIC_SUSPECTS) {
    assert.ok(fs.existsSync(path.join(UNIT_DIR, f)), `suspect file ${f} must exist`);
  }
  const before = { db: snapshot(REAL_DB), sessions: snapshot(REAL_SESSIONS_DB) };

  // Scrub the fallback-defining vars so a child WITHOUT helpers/setup resolves
  // DB_PATH to <repo>/data/microverse.sqlite (the exact failure mode under
  // test); a child WITH setup sets its own temp path and is unaffected.
  const env = { ...process.env };
  delete env.DB_PATH;
  delete env.SESSION_DB_PATH;
  delete env.APPS_DIR;
  delete env.NODE_ENV;

  const results = await Promise.all(DYNAMIC_SUSPECTS.map((f) => {
    const target = path.join(UNIT_DIR, f);
    return execFilePromise(process.execPath, [target], {
      cwd: SERVER_DIR,
      env,
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024
    })
      .then((r) => ({ f, out: `${r.stdout}\n${r.stderr}` }))
      .catch((e) => ({ f, out: `${e.stdout || ''}\n${e.stderr || ''}`, error: e }));
  }));

  const failed = results.filter((r) => r.error);
  assert.deepEqual(failed.map((r) => r.f), [], 'suspect test file failed when run standalone (see stderr below):\n' +
    failed.map((r) => `${r.f}:\n${r.out}`).join('\n'));

  const openers = [];
  for (const r of results) {
    // src/db/index.js:84 unconditionally logs the path it connected to; any
    // child naming the repo's real file opened the developer's database.
    const m = r.out.match(/Database path:\s*(.+)/);
    const resolved = m ? path.resolve(m[1].trim()) : null;
    if (resolved && resolved.toLowerCase() === REAL_DB.toLowerCase()) {
      openers.push(`${r.f} connected to ${resolved}`);
    }
    // Belt and braces: any other mention of the real file (error text, etc).
    const lower = r.out.toLowerCase();
    if (lower.includes(REAL_DB.toLowerCase()) && !openers.some((o) => o.startsWith(r.f))) {
      openers.push(`${r.f} output references ${REAL_DB}`);
    }
  }
  assert.deepEqual(openers, [], 'these test files opened the developer\'s real sqlite file');

  // Creation (fresh checkout) or modification of the real files is likewise a
  // hard failure. Read-only opens of an already-initialized DB are invisible
  // here — that is why the log-line probe above is load-bearing.
  const after = { db: snapshot(REAL_DB), sessions: snapshot(REAL_SESSIONS_DB) };
  assert.equal(after.db, before.db,
    `running the suspect tests changed ${path.relative(REPO_ROOT, REAL_DB)} ` +
    `(before: ${before.db}, after: ${after.db}) — tests must never touch the real database`);
  assert.equal(after.sessions, before.sessions,
    `running the suspect tests changed ${path.relative(REPO_ROOT, REAL_SESSIONS_DB)} ` +
    `(before: ${before.sessions}, after: ${after.sessions})`);
});

// ---------------------------------------------------------------------------
// Test 2 — static: every *.test.js whose require graph loads src/db at module
// load must pull in helpers/setup first (it sets DB_PATH to a temp dir before
// anything opens a connection).
// ---------------------------------------------------------------------------
test('a unit test file that loads a service pulls in the temp-db helper first', () => {
  const testFiles = listTestFiles(path.join(SRC_DIR, 'test'));
  assert.ok(testFiles.length > 30, 'sanity: the scan must see the whole test tree');

  const problems = [];
  const seenWhitelist = new Set();

  for (const file of testFiles) {
    const base = path.basename(file);
    const code = fs.readFileSync(file, 'utf8');
    const reqs = scanRequires(code);

    const setupReqs = reqs.filter((r) => r.depth === 0 && resolveLocal(file, r.spec) === SETUP_HELPER);
    const setupIdx = setupReqs.length ? Math.min(...setupReqs.map((r) => r.index)) : Infinity;

    // Any require in a TEST file counts — even one inside a callback still
    // runs with DB_PATH unset if setup was never required at module load.
    const dbReaching = reqs.filter((r) => {
      const dep = resolveLocal(file, r.spec);
      return dep && dep !== SETUP_HELPER && loadsDb(dep);
    });

    if (Object.prototype.hasOwnProperty.call(DELIBERATE_NO_HELPER, base)) {
      seenWhitelist.add(base);
      if (setupReqs.length > 0) {
        problems.push(`${base} is listed as deliberately NOT using helpers/setup, ` +
          `but it requires it anyway — the lazy-db design it protects is being undone`);
      }
      if (dbReaching.length > 0) {
        problems.push(`${base} is whitelisted ("${DELIBERATE_NO_HELPER[base]}") but now ` +
          `reaches src/db through: ${dbReaching.map((r) => r.spec).join(', ')} — the whitelist entry is stale`);
      }
      continue;
    }

    if (dbReaching.length > 0 && !Number.isFinite(setupIdx)) {
      problems.push(`${base} requires ${JSON.stringify([...new Set(dbReaching.map((r) => r.spec))])} ` +
        `which loads src/db at module load, but never requires ../helpers/setup — ` +
        `this file can open the developer's real data/microverse.sqlite`);
    } else if (dbReaching.length > 0 && dbReaching.some((r) => r.index < setupIdx)) {
      problems.push(`${base} requires a src/db-loading module before ../helpers/setup; ` +
        `DB_PATH must point at a temp dir BEFORE anything requires the db chain`);
    }
  }

  for (const name of Object.keys(DELIBERATE_NO_HELPER)) {
    assert.ok(seenWhitelist.has(name), `whitelist entry ${name} matches no test file — stale whitelist`);
  }
  assert.deepEqual(problems, [], 'test files must isolate the database they open (see helpers/setup)');
});
