import { createContext, useContext, useState, useEffect } from 'react'
import { getConfig } from '../api/apps'

const AppConfigContext = createContext(null)

// Fetches /api/config once on mount and exposes it. null while loading or if
// the fetch fails (consumers fall back to defaults).
export function AppConfigProvider({ children }) {
  const [config, setConfig] = useState(null)

  useEffect(() => {
    getConfig()
      .then((c) => setConfig(c))
      .catch(() => setConfig(null))
  }, [])

  return (
    <AppConfigContext.Provider value={config}>
      {children}
    </AppConfigContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAppConfig() {
  return useContext(AppConfigContext)
}
