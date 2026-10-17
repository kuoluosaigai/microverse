const express = require('express');
const ProxyManager = require('../services/proxy-manager');
const { queries } = require('../db');

/**
 * Reverse-proxy management endpoints (all protected — mounted AFTER requireAuth):
 * custom domain -> port/app mappings, and the pre-registered domain pool.
 */
const router = express.Router();

// List custom domain mappings (reverse-proxy routes)
router.get('/proxy-routes', async (req, res, next) => {
  try {
    const routes = await queries.listProxyRoutes();
    const apps = await queries.getAllApps();
    const byId = new Map(apps.map(a => [a.id, a]));
    const data = routes.map(r => {
      const app = r.target_app_id != null ? byId.get(r.target_app_id) : null;
      return {
        ...r,
        target_app_name: app ? app.name : null,
        resolved: r.target_type === 'port' ? true : !!(app && app.status === 'running' && app.port)
      };
    });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

// Create a custom domain mapping
router.post('/proxy-routes', async (req, res, next) => {
  try {
    const apps = await queries.getAllApps();
    const route = ProxyManager.validateProxyRoute(req.body, { apps });
    const existing = await queries.listProxyRoutes();
    if (existing.some(r => r.host === route.host)) {
      return res.status(400).json({ success: false, error: { message: 'Domain already exists' } });
    }
    const result = await queries.createProxyRoute(route);
    try { await ProxyManager.regenerate(); } catch (e) { console.warn(`[proxy] regenerate failed: ${e.message}`); }
    const created = await queries.getProxyRouteById(result.lastID);
    res.status(201).json({ success: true, data: created });
  } catch (error) {
    if (error.message.startsWith('Invalid proxy route')) {
      return res.status(400).json({ success: false, error: { message: error.message } });
    }
    if (error.code === 'SQLITE_CONSTRAINT') {
      return res.status(400).json({ success: false, error: { message: 'Domain already exists' } });
    }
    next(error);
  }
});

// Update a custom domain mapping
router.put('/proxy-routes/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const apps = await queries.getAllApps();
    const route = ProxyManager.validateProxyRoute(req.body, { apps });
    const existing = await queries.listProxyRoutes();
    if (existing.some(r => r.host === route.host && r.id !== id)) {
      return res.status(400).json({ success: false, error: { message: 'Domain already exists' } });
    }
    const result = await queries.updateProxyRoute(id, route);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: { message: 'Route not found' } });
    }
    try { await ProxyManager.regenerate(); } catch (e) { console.warn(`[proxy] regenerate failed: ${e.message}`); }
    const row = await queries.getProxyRouteById(id);
    res.json({ success: true, data: row });
  } catch (error) {
    if (error.message.startsWith('Invalid proxy route')) {
      return res.status(400).json({ success: false, error: { message: error.message } });
    }
    if (error.code === 'SQLITE_CONSTRAINT') {
      return res.status(400).json({ success: false, error: { message: 'Domain already exists' } });
    }
    next(error);
  }
});

// Delete a custom domain mapping
router.delete('/proxy-routes/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const result = await queries.deleteProxyRoute(id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: { message: 'Route not found' } });
    }
    try { await ProxyManager.regenerate(); } catch (e) { console.warn(`[proxy] regenerate failed: ${e.message}`); }
    res.json({ success: true, data: { message: 'Route deleted' } });
  } catch (error) { next(error); }
});

// List pre-registered domains (domain pool for custom-domain mapping)
router.get('/proxy-domains', async (req, res, next) => {
  try {
    const rows = await queries.listProxyDomains();
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
});

// Add a domain to the pool (does NOT touch nginx — pool is a candidate list only)
router.post('/proxy-domains', async (req, res, next) => {
  try {
    const domain = ProxyManager.validateProxyDomain(req.body);
    const existing = await queries.listProxyDomains();
    if (existing.some(d => d.host === domain.host)) {
      return res.status(400).json({ success: false, error: { message: 'Domain already exists' } });
    }
    const result = await queries.createProxyDomain(domain);
    res.status(201).json({ success: true, data: { id: result.lastID, host: domain.host } });
  } catch (error) {
    if (error.message.startsWith('Invalid proxy domain')) {
      return res.status(400).json({ success: false, error: { message: error.message } });
    }
    if (error.code === 'SQLITE_CONSTRAINT') {
      return res.status(400).json({ success: false, error: { message: 'Domain already exists' } });
    }
    next(error);
  }
});

// Remove a domain from the pool
router.delete('/proxy-domains/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const result = await queries.deleteProxyDomain(id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: { message: 'Domain not found' } });
    }
    res.json({ success: true, data: { message: 'Domain deleted' } });
  } catch (error) { next(error); }
});

module.exports = router;
