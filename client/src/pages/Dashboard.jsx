import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { message } from 'antd'
import { useTranslation } from 'react-i18next'
import EditorialShell from '../components/EditorialShell'
import AppRow from '../components/AppRow'
import LanguageSwitcher from '../components/LanguageSwitcher'
import { useAppConfig } from '../context/AppConfigContext'
import { getAllApps, deleteApp, startApp, stopApp, restoreApp, setAppDefault, clearAppDefault } from '../api/apps'

function Dashboard() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const appConfig = useAppConfig()
  const [apps, setApps] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [startingId, setStartingId] = useState(null)

  const loadApps = async (showRefreshing = false, silent = false) => {
    try {
      if (!silent) {
        if (showRefreshing) setRefreshing(true)
        else setLoading(true)
      }
      const data = await getAllApps()
      setApps(data)
    } catch (error) {
      if (!silent) {
        message.error(t('messages.operationFailed'))
      }
      console.error('Error loading apps:', error)
    } finally {
      if (!silent) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }

  useEffect(() => {
    loadApps()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Silent background refresh every 10s (no spinner; just updates app data incl. metrics).
  useEffect(() => {
    const timer = setInterval(() => loadApps(false, true), 10000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleStart = async (appId) => {
    setStartingId(appId)
    try {
      await startApp(appId)
      message.success(t('messages.appStarted'))
      await loadApps(true)
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('messages.operationFailed'))
    } finally {
      setStartingId(null)
    }
  }

  const handleStop = async (appId) => {
    try {
      await stopApp(appId)
      message.success(t('messages.appStopped'))
      await loadApps(true)
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('messages.operationFailed'))
    }
  }

  const handleDelete = async (appId) => {
    try {
      await deleteApp(appId)
      message.success(t('messages.appDeleted'))
      await loadApps(true)
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('messages.operationFailed'))
    }
  }

  const handleToggleDefault = async (app, next) => {
    try {
      if (next) await setAppDefault(app.id)
      else await clearAppDefault(app.id)
      await loadApps(true)
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('messages.operationFailed'))
      await loadApps(true) // re-sync in case the Switch optimism was wrong
    }
  }

  const fileInputRef = useRef(null)

  const handleRestore = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return
    try {
      await restoreApp(file)
      message.success(t('messages.restoreDone'))
      await loadApps(true)
    } catch (err) {
      message.error(err.response?.data?.error?.message || t('messages.restoreFailed'))
    }
  }

  const runningCount = apps.filter((a) => a.status === 'running').length
  const lead = t('dashboard.lead', { count: apps.length })
  const suffix = runningCount ? ' ' + t('dashboard.runningSuffix', { count: runningCount }) : ''

  const right = (
    <>
      <button
        className="nav-link"
        onClick={() => loadApps(true)}
        disabled={refreshing}
      >
        {t('dashboard.refreshApps')}
      </button>
      <button className="nav-link accent" onClick={() => navigate('/create')}>
        + {t('dashboard.createApp')}
      </button>
      <button className="nav-link" onClick={() => fileInputRef.current && fileInputRef.current.click()}>
        ↥ {t('dashboard.restore')}
      </button>
      {appConfig?.proxyEnabled && (
        <button className="nav-link" onClick={() => navigate('/routes')}>
          {t('proxyRoutes.title')}
        </button>
      )}
      {appConfig?.proxyEnabled && (
        <button className="nav-link" onClick={() => navigate('/domains')}>
          {t('proxyDomains.title')}
        </button>
      )}
      <LanguageSwitcher />
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip"
        style={{ display: 'none' }}
        onChange={handleRestore}
      />
    </>
  )

  return (
    <EditorialShell right={right}>
      {!loading && <div className="lead">{lead}{suffix}</div>}

      {loading ? (
        <div className="loading-line">{t('dashboard.loading')}</div>
      ) : apps.length === 0 ? (
        <div className="empty">
          <h2>{t('dashboard.noApps')}</h2>
          <p>{t('dashboard.noAppsDesc')}</p>
          <button
            className="text-link accent"
            style={{ marginTop: 20 }}
            onClick={() => navigate('/create')}
          >
            {t('dashboard.emptyCta')}
          </button>
        </div>
      ) : (
        <ul className="app-list">
          {apps.map((app, i) => (
            <AppRow
              key={app.id}
              app={app}
              index={i + 1}
              onStart={handleStart}
              onStop={handleStop}
              onDelete={handleDelete}
              onToggleDefault={handleToggleDefault}
              startingId={startingId}
            />
          ))}
        </ul>
      )}
    </EditorialShell>
  )
}

export default Dashboard
