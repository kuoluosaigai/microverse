# Backend Development Guidelines

> Best practices for backend development in this project.

---

## Overview

This directory contains guidelines for backend development. Fill in each file with your project's specific conventions.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | To fill |
| [Database Guidelines](./database-guidelines.md) | ORM patterns, queries, migrations | To fill |
| [Error Handling](./error-handling.md) | Error types, handling strategies | To fill |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | To fill |
| [Logging Guidelines](./logging-guidelines.md) | Structured logging, log levels | To fill |
| [API Endpoints](./api-endpoints.md) | Complete API documentation | ✅ Complete |

---

## Key Patterns

### Async Database Operations

This project uses `sqlite3` (NOT `better-sqlite3`). All database queries return Promises:

```javascript
// In db/index.js
const queries = {
  getAllApps: () => dbAll('SELECT * FROM apps'),    // Returns Promise<Array>
  getAppById: (id) => dbGet('SELECT * ...', [id])   // Returns Promise<Object>
}

// In services - always use await
const apps = await queries.getAllApps()  // ✓ Correct
```

### Service Layer Pattern

```javascript
// Services are static classes
class AppManager {
  static async createApp(name, deployType) {
    // Business logic
    return await queries.createApp({...})
  }
}
```

### Route Handler Pattern

```javascript
router.get('/apps', async (req, res, next) => {
  try {
    const apps = await AppManager.getAllApps()
    res.json({ success: true, data: apps })
  } catch (error) {
    next(error)  // Global error handler catches it
  }
})
```

---

## How to Fill These Guidelines

For each guideline file:

1. Document your project's **actual conventions** (not ideals)
2. Include **code examples** from your codebase
3. List **forbidden patterns** and why
4. Add **common mistakes** your team has made

The goal is to help AI assistants and new team members understand how YOUR project works.

---

**Language**: All documentation should be written in **English**.
