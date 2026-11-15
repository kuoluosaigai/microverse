/**
 * Validation and normalization for git deployment sources.
 *
 * Production accepts public `https://` repositories only. `file://` is
 * accepted solely when `allowFile: true`, which exists so tests can point at
 * local repositories — it must never be enabled from user input.
 *
 * All validators return an error message string or `null` when valid, matching
 * the style of utils/validate-env.js and utils/validate-manifest.js.
 */

// Host (letters/digits/dots/hyphens, optional :port) then a path of safe URL
// characters. The path may end in `.git`. Query strings/fragments are not
// supported (webhook remotes don't need them and they complicate normalization).
const HTTPS_URL_RE = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._~%\-/@]+(?:\.git)?$/;
const FILE_URL_RE = /^file:\/\/\/.+$/;

// Control characters and any whitespace. Rejected because the URL is passed as
// an argument to `git clone`: newlines/NULs and stray spaces are classic
// command/argument-injection vectors.
const UNSAFE_CHARS_RE = /[\u0000-\u001f\u007f\s]/;

const URL_ERROR = 'Git URL must be an https:// repository URL';
const INVALID_CHARS_ERROR = 'Git URL contains invalid characters';

/**
 * Validate a git repository URL.
 * @param {*} url
 * @param {{ allowFile?: boolean }} options
 * @returns {string|null} error message, or null when valid.
 */
function validateGitUrl(url, { allowFile = false } = {}) {
  if (typeof url !== 'string' || url.length === 0) return URL_ERROR;
  // Values starting with '-' would be parsed as an option by git.
  if (url.startsWith('-')) return URL_ERROR;
  if (UNSAFE_CHARS_RE.test(url)) return INVALID_CHARS_ERROR;

  if (HTTPS_URL_RE.test(url)) return null;
  if (allowFile && FILE_URL_RE.test(url)) return null;
  return URL_ERROR;
}

const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const BRANCH_ERROR = 'Invalid git branch name';

/**
 * Validate a git branch / ref name. Conservative subset: no leading '-' or
 * '/', and no '..' (prevents revision-range and option injection).
 * @param {*} branch
 * @returns {string|null} error message, or null when valid.
 */
function validateGitBranch(branch) {
  if (typeof branch !== 'string' || !BRANCH_RE.test(branch)) return BRANCH_ERROR;
  if (branch.startsWith('-') || branch.startsWith('/')) return BRANCH_ERROR;
  if (branch.includes('..')) return BRANCH_ERROR;
  return null;
}

/**
 * Canonical form used to detect "same repository" links.
 * Order matters: strip trailing slashes first, then a trailing `.git`.
 * @param {string} url
 * @returns {string}
 */
function normalizeGitUrl(url) {
  return url.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
}

module.exports = { validateGitUrl, normalizeGitUrl, validateGitBranch };
