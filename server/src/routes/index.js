const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rate-limit');
const systemRouter = require('./system');
const { publicRouter: authPublicRouter, protectedRouter: authProtectedRouter } = require('./auth');
const appsRouter = require('./apps');
const proxyRouter = require('./proxy');

/**
 * API route composition. Mount order is load-bearing and mirrors the original
 * single-file layout exactly:
 *   1. public: /health, /config, /auth/login (login carries its own limiter)
 *   2. requireAuth — everything below needs an admin session
 *   3. apiLimiter — generic per-IP ceiling (SSE exempt via its skip option)
 *   4. protected: /apps*, /proxy-routes, /proxy-domains, /auth/me, /auth/logout
 */
const router = express.Router();

// --- Public ---
router.use(systemRouter);
router.use(authPublicRouter);

// --- Auth gate + generic rate limit ---
router.use(requireAuth);
router.use(apiLimiter);

// --- Protected ---
router.use(appsRouter);
router.use(proxyRouter);
router.use(authProtectedRouter);

module.exports = router;
