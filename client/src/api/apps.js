import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
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
      // Server responded with error status
      console.error('API Error:', error.response.data)
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
  const response = await api.post(`/apps/${id}/start`)
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

export default api
