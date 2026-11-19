import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json'
  }
})

// Multipart uploads are bounded by the link speed, not by server work: a 100MB
// zip takes minutes on a slow uplink. The 10s default above aborts uploads that
// were still progressing normally, so upload/restore get a generous cap instead
// (still finite, so a dead connection eventually fails rather than hanging).
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000

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
 * Create a new application. `git` (optional) binds a Git source in the same
 * request so first deploy is driven by the repository.
 * @param {string} name
 * @param {string} deployType
 * @param {{url: string, branch?: string, autoUpdate?: boolean}|null} [git]
 */
export const createApp = async (name, deployType, git) => {
  const payload = {
    name,
    deploy_type: deployType
  }
  if (git) {
    payload.git_url = git.url
    payload.git_branch = git.branch
    payload.git_auto_update = git.autoUpdate
  }
  const response = await api.post('/apps', payload)
  return response.data.data
}

/**
 * Get an app's Git binding (404 when no source is bound).
 */
export const getAppGit = async (id) => {
  const response = await api.get(`/apps/${id}/git`)
  return response.data.data
}

/**
 * Bind or re-bind the app's Git source.
 * @param {number} id
 * @param {{url: string, branch?: string, autoUpdate?: boolean}} source
 */
export const bindAppGit = async (id, { url, branch, autoUpdate }) => {
  const response = await api.put(`/apps/${id}/git`, { url, branch, autoUpdate })
  return response.data.data
}

/**
 * Remove the app's Git binding (deployed files are untouched).
 */
export const unbindAppGit = async (id) => {
  const response = await api.delete(`/apps/${id}/git`)
  return response.data.data
}

/**
 * Rotate the webhook secret (binding and deploy progress stay).
 */
export const rotateAppGitSecret = async (id) => {
  const response = await api.post(`/apps/${id}/git/secret`)
  return response.data.data
}

/**
 * Compare the deployed commit with the remote branch head (no worktree changes).
 */
export const checkAppGit = async (id) => {
  const response = await api.post(`/apps/${id}/git/check`)
  return response.data.data
}

/**
 * Pull the branch, rebuild and restart. This is now a background deploy job:
 * the request returns 202 the moment the platform claims the job, so the
 * default 10s axios timeout applies again (a hang here is a real hang).
 */
export const pullAppGit = async (id) => {
  const response = await api.post(`/apps/${id}/git/pull`, {})
  return response.data.data
}

/**
 * Delete an application
 */
export const deleteApp = async (id, deleteFiles = false) => {
  const response = await api.delete(`/apps/${id}`, {
    params: deleteFiles ? { deleteFiles: true } : {}
  })
  return response.data.data
}

/**
 * Start an application. Deploys are background jobs now: this answers 202 as
 * soon as the job is claimed (install/build/launch happen off the request), so
 * the default 10s timeout stays on — progress arrives via the app list's
 * `deploy` summary and getDeployStatus.
 */
export const startApp = async (id) => {
  const response = await api.post(`/apps/${id}/start`, {})
  return response.data.data
}

/**
 * Current deploy job + bounded log tail for an app:
 * `{ job: {kind,status,step,message,startedAt,finishedAt,live}|null, logTail: string[] }`.
 * Poll this (no SSE for deploy logs).
 */
export const getDeployStatus = async (id) => {
  const response = await api.get(`/apps/${id}/deploy`)
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
    timeout: UPLOAD_TIMEOUT_MS,
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
    timeout: UPLOAD_TIMEOUT_MS,
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

/**
 * Custom domain mappings (reverse-proxy routes).
 */
export const getProxyRoutes = async () => {
  const response = await api.get('/proxy-routes')
  return response.data.data
}

export const createProxyRoute = async (payload) => {
  const response = await api.post('/proxy-routes', payload)
  return response.data.data
}

export const updateProxyRoute = async (id, payload) => {
  const response = await api.put(`/proxy-routes/${id}`, payload)
  return response.data.data
}

export const deleteProxyRoute = async (id) => {
  const response = await api.delete(`/proxy-routes/${id}`)
  return response.data.data
}

/**
 * Domain pool (pre-registered custom domains for mapping).
 */
export const getProxyDomains = async () => {
  const response = await api.get('/proxy-domains')
  return response.data.data
}

export const createProxyDomain = async (host) => {
  const response = await api.post('/proxy-domains', { host })
  return response.data.data
}

export const deleteProxyDomain = async (id) => {
  const response = await api.delete(`/proxy-domains/${id}`)
  return response.data.data
}

export default api
