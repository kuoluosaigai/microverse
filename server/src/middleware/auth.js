/**
 * requireAuth — allow only authenticated requests (req.session.user set).
 * Mounted in routes/index.js AFTER public routes, so it guards everything
 * registered below it.
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  return res.status(401).json({
    success: false,
    error: { message: 'Authentication required' }
  });
}

module.exports = { requireAuth };
