const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { message: 'Too many login attempts, try again later' } }
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.endsWith('/logs/stream'),
  message: { success: false, error: { message: 'Too many requests, slow down' } }
});

// Public GitHub webhooks: unauthenticated by design, so the per-IP ceiling is
// the only abuse control at the HTTP layer (HMAC verification per app is the
// real gate). 120/min is well above a busy repository's push volume.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { message: 'Too many webhook requests' } }
});

module.exports = { loginLimiter, apiLimiter, webhookLimiter };
