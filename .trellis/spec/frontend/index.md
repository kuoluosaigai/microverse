# Frontend Development Guidelines

> Best practices for frontend development in this project.

---

## Overview

This directory contains guidelines for frontend development. Fill in each file with your project's specific conventions.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | To fill |
| [Component Guidelines](./component-guidelines.md) | Component patterns, props, composition | ✅ Complete |
| [Hook Guidelines](./hook-guidelines.md) | Custom hooks, data fetching patterns | To fill |
| [State Management](./state-management.md) | Local state, global state, server state | To fill |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | To fill |
| [Type Safety](./type-safety.md) | Type patterns, validation | To fill |

---

## Key Patterns

### Internationalization (i18n)

This project uses `react-i18next` for translations:

```jsx
import { useTranslation } from 'react-i18next'

function MyComponent() {
  const { t } = useTranslation()

  return <h1>{t('page.title')}</h1>
}
```

### API Integration

```jsx
import { useState } from 'react'
import { apiFunction } from '../api/apps'
import { message } from 'antd'

function MyComponent() {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)

  const fetchData = async () => {
    try {
      setLoading(true)
      const result = await apiFunction()
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('messages.error'))
    } finally {
      setLoading(false)
    }
  }
}
```

### Ant Design Usage

All UI components use Ant Design:
- Consistent component library
- Built-in i18n support (zh_CN / en_US)
- Standardized message notifications

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
