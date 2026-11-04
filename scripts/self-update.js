#!/usr/bin/env node
/**
 * Detached self-update runner.
 *
 * Spawned by `UpdateManager.startUpdate` as:
 *   node scripts/self-update.js --from <sha> --to <sha>
 *
 * Keeping this file in `scripts/` (rather than `server/src`) means it is not
 * loaded by the platform at boot; it only runs during an update, and through
 * `require.main === module` it can be imported by tests without side effects.
 */
const path = require('path');

const { runUpdate } = require(path.join(__dirname, '..', 'server', 'src', 'services', 'self-updater'));

const SHA_RE = /^[0-9a-f]{7,40}$/;

/**
 * Parse `--from <sha> --to <sha>`.
 * Both shas are mandatory and validated before they reach any command.
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ fromSha: string, toSha: string }}
 */
function parseArgs(argv = []) {
  const parsed = { fromSha: null, toSha: null };

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--from') {
      parsed.fromSha = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--to') {
      parsed.toSha = argv[i + 1];
      i += 1;
    }
  }

  if (!SHA_RE.test(parsed.fromSha || '') || !SHA_RE.test(parsed.toSha || '')) {
    throw new Error('invalid --from/--to sha');
  }

  return parsed;
}

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  runUpdate(args)
    .then((state) => {
      process.exit(state.status === 'success' ? 0 : 1);
    })
    .catch((err) => {
      console.error(err && err.message ? err.message : String(err));
      process.exit(1);
    });
}

module.exports = { parseArgs, runUpdate };
