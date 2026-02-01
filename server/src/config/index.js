const dotenv = require('dotenv');
const path = require('path');

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, '../../..', '.env') });

/**
 * Configuration management for Microverse
 * Loads settings from environment variables with sensible defaults
 */

const config = {
  // Server configuration
  server: {
    port: parseInt(process.env.PORT) || 5000,
    host: process.env.HOST || '0.0.0.0',
    nodeEnv: process.env.NODE_ENV || 'development'
  },

  // CORS configuration
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    credentials: true
  },

  // Database configuration
  database: {
    path: process.env.DB_PATH || path.join(__dirname, '../../..', 'data', 'microverse.sqlite')
  },

  // Application deployment configuration
  deployment: {
    // Port range for deployed apps
    portRangeMin: parseInt(process.env.APP_PORT_MIN) || 3000,
    portRangeMax: parseInt(process.env.APP_PORT_MAX) || 9000,

    // Default ports for different deploy types
    defaultHttpServerPort: 8080,
    defaultNpmPort: 3000,

    // File upload limits
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 100 * 1024 * 1024, // 100MB
    maxFiles: parseInt(process.env.MAX_FILES) || 100
  },

  // PM2 configuration
  pm2: {
    instanceName: process.env.PM2_INSTANCE_NAME || 'microverse-server'
  }
};

// Validate configuration
const validateConfig = () => {
  const { portRangeMin, portRangeMax } = config.deployment;

  if (portRangeMin >= portRangeMax) {
    throw new Error('APP_PORT_MIN must be less than APP_PORT_MAX');
  }

  if (config.server.port < 1 || config.server.port > 65535) {
    throw new Error('Invalid PORT: must be between 1 and 65535');
  }
};

// Run validation
validateConfig();

module.exports = config;
