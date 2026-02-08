const multer = require('multer');
const path = require('path');
const fs = require('fs');

/**
 * Multer configuration for file uploads
 */

// File size limit: 50MB
const MAX_FILE_SIZE = 50 * 1024 * 1024;

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
    // Sanitize filename: remove path traversal characters
    const sanitized = file.originalname.replace(/[\/\\]/g, '_');
    cb(null, sanitized);
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

module.exports = {
  upload,
  MAX_FILE_SIZE,
  ALLOWED_EXTENSIONS
};
