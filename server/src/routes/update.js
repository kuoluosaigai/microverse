const express = require('express');
const UpdateManager = require('../services/update-manager');

/**
 * Platform self-update endpoints (all protected — mounted AFTER requireAuth):
 * read the displayed version, start a detached update run, and poll its state.
 */
const router = express.Router();

router.get('/system/version', async (req, res, next) => {
  try {
    res.json({ success: true, data: await UpdateManager.getVersionInfo() });
  } catch (error) { next(error); }
});

router.post('/system/update', async (req, res, next) => {
  try {
    const pre = await UpdateManager.preflight();
    if (!pre.ok) {
      return res.status(pre.httpStatus).json({ success: false, error: { message: pre.message } });
    }
    const { pid } = await UpdateManager.startUpdate({ fromSha: pre.fromSha, toSha: pre.toSha });
    res.status(202).json({ success: true, data: { status: 'running', pid } });
  } catch (error) { next(error); }
});

router.get('/system/update/status', async (req, res, next) => {
  try {
    res.json({ success: true, data: await UpdateManager.getUpdateStatus() });
  } catch (error) { next(error); }
});

module.exports = router;
