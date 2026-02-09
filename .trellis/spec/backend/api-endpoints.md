# Backend API Endpoints

> API endpoints documentation for Microverse backend

---

## Applications Management

### GET /api/apps
Get all applications.

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "app-name",
      "path": "/path/to/app",
      "deploy_type": "http-server",
      "port": 3000,
      "status": "running",
      "created_at": "2026-01-01 00:00:00",
      "updated_at": "2026-01-01 00:00:00"
    }
  ]
}
```

### GET /api/apps/:id
Get application by ID.

**Response**: Same as single item in GET /api/apps

### POST /api/apps
Create new application.

**Request**:
```json
{
  "name": "app-name",
  "deploy_type": "http-server"
}
```

**Response**: Created application object

### DELETE /api/apps/:id
Delete application (must be stopped first).

**Response**:
```json
{
  "success": true,
  "data": { "message": "App deleted successfully" }
}
```

---

## Application Control

### POST /api/apps/:id/start
Start application with PM2.

**Response**: Updated application object with port and status

### POST /api/apps/:id/stop
Stop application.

**Response**: Updated application object

### POST /api/apps/:id/restart
Restart application.

**Response**: Updated application object

### POST /api/apps/:id/sync
Sync application status with PM2.

**Response**: Updated application object

---

## File Management

### POST /api/apps/:id/upload
Upload files to application directory.

**Request**: multipart/form-data with field `files`

**Features**:
- Multiple file upload
- ZIP file auto-extraction
- File size limit: 50MB per request
- Allowed types: HTML, CSS, JS, JSON, TXT, MD, Images, ZIP

**Response**:
```json
{
  "success": true,
  "data": {
    "filesUploaded": 3,
    "files": ["index.html", "style.css", "script.js"]
  }
}
```

### GET /api/apps/:id/files
Get list of files in application directory.

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "name": "index.html",
      "type": "file",
      "path": "/full/path/to/file"
    },
    {
      "name": "assets",
      "type": "directory",
      "path": "/full/path/to/directory"
    }
  ]
}
```

---

## Health Check

### GET /api/health
Server health check.

**Response**:
```json
{
  "success": true,
  "data": {
    "status": "ok",
    "timestamp": "2026-01-01T00:00:00.000Z",
    "uptime": 1234.5678
  }
}
```

---

## Error Responses

All endpoints return errors in this format:

```json
{
  "success": false,
  "error": {
    "message": "Error description"
  }
}
```

**Common Status Codes**:
- 200: Success
- 201: Created
- 400: Bad request / Validation error
- 404: Resource not found
- 500: Server error
- 501: Not implemented
