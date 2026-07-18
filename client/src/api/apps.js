import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json'
  }
})

// Response interceptor for error handling
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response) {
      // 401 is expected (e.g. AuthContext's getMe probe when logged out) and is
      // handled by callers via .catch — don't log it as an error.
      if (error.response.status !== 401) {
        console.error('API Error:', error.response.data)
      }
    } else if (error.request) {
      // Request made but no response
      console.error('Network Error:', error.message)
    } else {
      // Something else happened
      console.error('Error:', error.message)
    }
    return Promise.reject(error)
  }
)

/**
 * Get all applications
 */
export const getAllApps = async () => {
  const response = await api.get('/apps')
  return response.data.data
}

/**
 * Get application by ID
 */
export const getAppById = async (id) => {
  const response = await api.get(`/apps/${id}`)
  return response.data.data
}

/**
 * Create a new application
 */
export const createApp = async (name, deployType) => {
  const response = await api.post('/apps', {
    name,
    deploy_type: deployType
  })
  return response.data.data
}

/**
 * Delete an application
 */
export const deleteApp = async (id) => {
  const response = await api.delete(`/apps/${id}`)
  return response.data.data
}

/**
 * Start an application
 */
export const startApp = async (id) => {
  // npm apps run install/build before launch — can take minutes. Disable the
  // default 10s axios timeout so the request survives the full lifecycle.
  const response = await api.post(`/apps/${id}/start`, {}, { timeout: 0 })
  return response.data.data
}

/**
 * Stop an application
 */
export const stopApp = async (id) => {
  const response = await api.post(`/apps/${id}/stop`)
  return response.data.data
}

/**
 * Upload files to an application
 */
export const uploadFiles = async (id, files) => {
  const formData = new FormData()

  if (Array.isArray(files)) {
    files.forEach(file => {
      formData.append('files', file)
    })
  } else {
    formData.append('files', files)
  }

  const response = await api.post(`/apps/${id}/upload`, formData, {
    headers: {
      'Content-Type': 'multipart/form-data'
    }
  })

  return response.data.data
}

/**
 * Get application files/directory listing
 */
export const getAppFiles = async (id) => {
  const response = await api.get(`/apps/${id}/files`)
  return response.data.data
}

/**
 * Get an application's resource-metrics history (resource samples, newest last).
 */
export const getAppMetrics = async (id) => {
  const response = await api.get(`/apps/${id}/metrics`)
  return response.data.data
}

/**
 * Get an application's environment variables
 */
export const getAppEnv = async (id) => {
  const response = await api.get(`/apps/${id}/env`)
  return response.data.data
}

/**
 * Replace an application's environment variables
 * @param {number} id
 * @param {Array<{key: string, value: string}>} env
 */
export const setAppEnv = async (id, env) => {
  const response = await api.put(`/apps/${id}/env`, { env })
  return response.data.data
}

/**
 * Get public client configuration (upload limits, etc.)
 */
export const getConfig = async () => {
  const response = await api.get('/config')
  return response.data.data
}

/**
 * EventSource URL for an app's live log stream (SSE).
 * EventSource can't use axios; the consumer opens this URL directly.
 */
export const appLogsStreamUrl = (id, lines = 100) =>
  `/api/apps/${id}/logs/stream?lines=${lines}`

/**
 * Backup-download URL for an app. Consumed via a programmatic <a download> click
 * (same-origin → session cookie rides automatically; no axios/blob needed).
 */
export const backupAppUrl = (id) => `/api/apps/${id}/backup`

/**
 * Restore an app from a backup zip (multipart field 'file'). Returns the new app.
 */
export const restoreApp = async (file) => {
  const form = new FormData()
  form.append('file', file)
  // Clear the instance's default JSON Content-Type so the browser sets
  // multipart/form-data WITH a boundary; a hand-set header omits the boundary
  // and multer rejects the body ("Multipart: Boundary not found").
  const response = await api.post('/apps/restore', form, {
    headers: { 'Content-Type': null }
  })
  return response.data.data
}

/**
 * Set this app as the root-domain default (reverse proxy).
 */
export const setAppDefault = async (id) => {
  const response = await api.put(`/apps/${id}/default`)
  return response.data.data
}

/**
 * Clear this app's root-domain default.
 */
export const clearAppDefault = async (id) => {
  const response = await api.delete(`/apps/${id}/default`)
  return response.data.data
}

export default api
