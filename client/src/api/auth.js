import api from './apps'

/**
 * Admin login. Returns { id, username } on success; throws on 401.
 */
export const login = async (username, password) => {
  const response = await api.post('/auth/login', { username, password })
  return response.data.data.user
}

/**
 * Destroy the admin session.
 */
export const logout = async () => {
  await api.post('/auth/logout')
}

/**
 * Current session user, or throws 401 if unauthenticated.
 */
export const getMe = async () => {
  const response = await api.get('/auth/me')
  return response.data.data.user
}
