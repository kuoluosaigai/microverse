const express = require('express');
const AuthManager = require('../services/auth-manager');
const { loginLimiter } = require('../middleware/rate-limit');

/**
 * Auth endpoints, split by protection level:
 *  - publicRouter: POST /auth/login — mounted BEFORE requireAuth
 *  - protectedRouter: GET /auth/me, POST /auth/logout — mounted AFTER
 */
const publicRouter = express.Router();
const protectedRouter = express.Router();

// Authenticate (public — must be registered BEFORE requireAuth)
publicRouter.post('/auth/login', loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: { message: 'username and password are required' }
      });
    }
    const user = await AuthManager.verifyCredentials(username, password);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: { message: 'Invalid credentials' }
      });
    }
    // Regenerate the session to defeat session fixation, then stamp the user.
    req.session.regenerate((err) => {
      if (err) {
        return res.status(500).json({ success: false, error: { message: 'Login failed' } });
      }
      req.session.user = user;
      res.json({ success: true, data: { user } });
    });
  } catch (err) {
    next(err);
  }
});

// Get the current session user (protected)
protectedRouter.get('/auth/me', (req, res) => {
  res.json({ success: true, data: { user: req.session.user } });
});

// Log out (protected) — destroy the session + clear the cookie
protectedRouter.post('/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ success: false, error: { message: 'Logout failed' } });
    }
    res.clearCookie('connect.sid'); // express-session default cookie name
    res.json({ success: true, data: { message: 'Logged out' } });
  });
});

module.exports = { publicRouter, protectedRouter };
