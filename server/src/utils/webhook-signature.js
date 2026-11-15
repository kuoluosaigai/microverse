const crypto = require('node:crypto');

/**
 * Verify a webhook signature header of the form `sha256=<hex>` against the
 * HMAC-SHA256 of the raw request body.
 *
 * The HMAC must be computed over the exact bytes received (not a re-serialized
 * JSON object), so callers should pass the raw body buffer.
 *
 * @param {Buffer|string} rawBody
 * @param {string} secret
 * @param {string|undefined} header
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, secret, header) {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  // An empty secret would make every request forgeable; treat it as unconfigured.
  if (typeof secret !== 'string' || secret.length === 0) return false;

  const provided = header.slice('sha256='.length);
  // Buffer.from(x, 'hex') silently ignores invalid/odd-length hex, so gate it.
  if (!/^[0-9a-fA-F]+$/.test(provided)) return false;

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody ?? '', 'utf8');
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  const providedBuf = Buffer.from(provided, 'hex');

  if (providedBuf.length !== expected.length) return false;
  return crypto.timingSafeEqual(providedBuf, expected);
}

module.exports = { verifyWebhookSignature };
