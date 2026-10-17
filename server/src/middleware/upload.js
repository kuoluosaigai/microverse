const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { sanitizeFilename, uniqueInRequest } = require('../utils/sanitize-filename');

/**
 * Multer configuration for file uploads
 */

// File size limit — honors MAX_FILE_SIZE env (default 100MB, see config/index.js)
const MAX_FILE_SIZE = config.deployment.maxFileSize;

// Allowed file extensions
const ALLOWED_EXTENSIONS = [
  // Web files
  '.html', '.css', '.js', '.json', '.txt', '.md',
  // Images
  '.jpg', '.jpeg', '.png', '.gif', '.svg', '.ico',
  // Archives
  '.zip'
];

// Configure storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Destination will be set dynamically in the route
    cb(null, req.uploadPath);
  },
  filename: (req, file, cb) => {
    // Harden the client-supplied name (traversal, NUL/control chars, Windows
    // reserved names/chars, over-long names).
    //
    // CROSS-request collisions are intentional: re-uploading "index.html" is
    // how a user updates the file the app serves, so the sanitized name is
    // used as-is and the later write replaces the earlier one.
    //
    // SAME-request collisions get their own slot ("index (1).html"): multer
    // opens one write stream per part, and two parts sharing one path
    // interleave their bytes into a corrupt merge. The reserved-name Set lives
    // on req, so it spans exactly one request.
    if (!req._requestFilenames) req._requestFilenames = new Set();
    const name = uniqueInRequest(req._requestFilenames, sanitizeFilename(file.originalname));
    req._requestFilenames.add(name);
    cb(null, name);
  }
});

// File filter
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();

  if (ALLOWED_EXTENSIONS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`File type not allowed. Allowed types: ${ALLOWED_EXTENSIONS.join(', ')}`));
  }
};

// Create multer instance
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE
  }
});

// Separate multer instance for backup restore: single file, in-memory (no temp
// upload file on disk), same .zip-allowing filter + size limit as uploads.
const restoreUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE }
}).single('file');

module.exports = {
  upload,
  restoreUpload,
  MAX_FILE_SIZE,
  ALLOWED_EXTENSIONS
};
