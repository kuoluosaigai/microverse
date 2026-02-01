# 🌍 Microverse

> Deploy and manage your micro applications with ease

A web-based platform for deploying and managing micro applications. Create, upload, and deploy multiple small web applications with different runtime environments (npm, http-server, nginx) through a simple web interface.

## Features

- 📁 **Application Management**: Create and organize applications in dedicated directories
- 📤 **Easy Upload**: Upload web applications via web interface (supports zip files and direct upload)
- 🚀 **Multiple Deploy Options**:
  - npm start (for Node.js applications)
  - http-server (for static files)
  - nginx (for advanced configurations)
- 🔗 **Route Management**: View and access all deployed applications from a central dashboard
- ⚙️ **Port Management**: Automatic or manual port allocation
- 📊 **Status Monitoring**: Real-time application status tracking

## 📚 Documentation

**New to Microverse?** Start here:
- 📖 [Installation & Usage Guide](README.md) - You're here! Learn how to install and use Microverse
- 🚀 [Quick Start Guide](#quick-start) - Get up and running in 5 minutes

**For Developers:**
- 🏗️ [Architecture & Development Guide](CLAUDE.md) - Understand the codebase architecture
- 📋 [Development Progress](PROGRESS.md) - Current status and roadmap
- 🔄 [Daily Workflow Guide](WORKFLOW.md) - How to start/end your workday
- 📚 [Documentation Index](DOCS.md) - Complete documentation overview

## Quick Start

### Prerequisites

- Node.js >= 18.0.0
- npm >= 9.0.0

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd microverse
```

2. Install dependencies:
```bash
npm run install:all
```

3. Create environment configuration:
```bash
cp .env.example .env
```

4. Start development servers:
```bash
# Start both frontend and backend in development mode
npm run dev

# Or start them separately:
npm run dev:server  # Backend on http://localhost:5000
npm run dev:client  # Frontend on http://localhost:5173
```

5. Open your browser and navigate to `http://localhost:5173`

### Production Deployment

1. Build the frontend:
```bash
npm run build:client
```

2. Start the backend with PM2:
```bash
cd server
npm run pm2:start
```

3. Monitor the application:
```bash
cd server
npm run pm2:logs
```

## Usage

### Creating an Application

1. Click "Create App" button on the dashboard
2. Enter a unique application name (alphanumeric, dash, and underscore only)
3. Select deployment type:
   - **Static Site (http-server)**: For HTML/CSS/JS static websites
   - **Node.js (npm)**: For Node.js applications with package.json
   - **Nginx**: Coming soon
4. Click "Create Application"

### Deploying an Application

1. After creating an app, upload your files (feature to be implemented)
2. Click "Start" button on the app card
3. The application will be assigned a port automatically
4. Access your application at `http://localhost:<port>`

### Managing Applications

- **Start**: Start a stopped application
- **Stop**: Stop a running application
- **Delete**: Remove an application (must be stopped first)
- **Refresh**: Update the status of all applications

## Project Structure

```
microverse/
├── server/                 # Backend server
│   ├── src/
│   │   ├── app.js         # Express application entry point
│   │   ├── config/        # Configuration management
│   │   ├── db/            # Database (SQLite)
│   │   ├── routes/        # API routes
│   │   ├── services/      # Business logic
│   │   ├── middleware/    # Express middleware
│   │   └── utils/         # Utility functions
│   └── package.json
├── client/                # Frontend application
│   ├── src/
│   │   ├── pages/         # React pages
│   │   ├── components/    # React components
│   │   ├── api/           # API client
│   │   └── styles/        # CSS styles
│   └── package.json
├── apps/                  # Deployed applications directory
├── data/                  # Database files
└── package.json           # Root workspace configuration
```

## API Endpoints

### Applications
- `GET /api/apps` - Get all applications
- `GET /api/apps/:id` - Get application by ID
- `POST /api/apps` - Create a new application
- `DELETE /api/apps/:id` - Delete an application
- `POST /api/apps/:id/start` - Start an application
- `POST /api/apps/:id/stop` - Stop an application
- `POST /api/apps/:id/upload` - Upload files to an application (coming soon)

### System
- `GET /api/health` - Health check endpoint
- `GET /` - Server information

## Configuration

The application can be configured using environment variables. Copy `.env.example` to `.env` and adjust the values:

```env
# Server Configuration
PORT=5000
HOST=0.0.0.0
NODE_ENV=development

# CORS Configuration
CORS_ORIGIN=http://localhost:5173

# Application Deployment Configuration
APP_PORT_MIN=3000
APP_PORT_MAX=9000

# File Upload Limits
MAX_FILE_SIZE=104857600  # 100MB
MAX_FILES=100
```

## Cross-Platform Compatibility

This project is designed to work on both Windows and Linux:

- **Path handling**: Uses Node.js `path` module for cross-platform compatibility
- **Environment variables**: Uses `cross-env` for setting environment variables
- **File operations**: Uses Node.js fs APIs instead of shell commands
- **Process management**: PM2 supports both Windows and Linux

## Development

### Backend Development
```bash
cd server
npm run dev
```

### Frontend Development
```bash
cd client
npm run dev
```

### Database

The application uses SQLite for data storage. The database file is created automatically at `data/microverse.sqlite` when the server starts for the first time.

To reset the database, simply delete the `data/microverse.sqlite` file and restart the server.

## Troubleshooting

### Port already in use
If you get a "port already in use" error, either:
- Stop the process using that port
- Change the PORT in your `.env` file

### PM2 commands not found
Install PM2 globally:
```bash
npm install -g pm2
```

Or use npx:
```bash
npx pm2 list
```

### Database errors
Delete the database file and restart:
```bash
rm data/microverse.sqlite  # Linux/Mac
del data\microverse.sqlite  # Windows
npm run dev:server
```

## Technology Stack

- **Backend**: Node.js + Express + SQLite (better-sqlite3)
- **Frontend**: React 18 + Vite + Ant Design
- **Process Management**: PM2
- **Database**: SQLite
- **Cross-Platform**: path module, cross-env, platform-agnostic APIs

## License

MIT © [kuoluosaigai](https://github.com/kuoluosaigai)

---

**Organization**: [kuoluosaigai](https://github.com/kuoluosaigai) - 这个世界

**Project**: microverse - Deploy your micro worlds
