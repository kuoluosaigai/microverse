import axios from 'axios'

const api = axios.create({ baseURL: '/api', withCredentials: true, timeout: 10000 })

export const getSystemVersion = async () => (await api.get('/system/version')).data.data

export const startSystemUpdate = async () => {
  const response = await api.post('/system/update', {}, { timeout: 30000 })
  return response.data.data
}

export const getUpdateStatus = async () => (await api.get('/system/update/status')).data.data
