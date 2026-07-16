const path = require('path');
const fs = require('fs');

/**
 * Cross-platform path utilities for Microverse
 * Provides consistent path handling across Windows and Linux
 */

// Get project root directory
const getProjectRoot = () => {
  return path.resolve(__dirname, '../../..');
};

// Get apps directory
const getAppsDir = () => {
  return process.env.APPS_DIR || path.join(getProjectRoot(), 'apps');
};

// Get data directory
const getDataDir = () => {
  return path.join(getProjectRoot(), 'data');
};

// Get app-specific directory
const getAppDir = (appName) => {
  if (!appName) {
    throw new Error('App name is required');
  }

  // Sanitize app name to prevent path traversal
  const sanitized = appName.replace(/[^a-zA-Z0-9-_]/g, '');
  if (sanitized !== appName) {
    throw new Error('Invalid app name: only alphanumeric, dash, and underscore allowed');
  }

  return path.join(getAppsDir(), sanitized);
};

// Ensure directory exists
const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
};

// Check if path is within allowed directory (security check)
const isPathSafe = (targetPath, allowedRoot) => {
  const normalized = path.normalize(targetPath);
  const relative = path.relative(allowedRoot, normalized);

  // Path should not start with '..' (no parent directory access)
  return !relative.startsWith('..') && !path.isAbsolute(relative);
};

// Get safe file path within app directory
const getSafeAppFilePath = (appName, filename) => {
  const appDir = getAppDir(appName);
  const filePath = path.join(appDir, filename);

  if (!isPathSafe(filePath, appDir)) {
    throw new Error('Path traversal attempt detected');
  }

  return filePath;
};

module.exports = {
  getProjectRoot,
  getAppsDir,
  getDataDir,
  getAppDir,
  ensureDir,
  isPathSafe,
  getSafeAppFilePath
};
