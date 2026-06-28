import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { message } from 'antd'
import { useTranslation } from 'react-i18next'
import EditorialShell from '../components/EditorialShell'
import AppRow from '../components/AppRow'
import LanguageSwitcher from '../components/LanguageSwitcher'
import { getAllApps, deleteApp, startApp, stopApp } from '../api/apps'

function Dashboard() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [apps, setApps] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadApps = async (showRefreshing = false) => {
    try {
      if (showRefreshing) setRefreshing(true)
      else setLoading(true)
      const data = await getAllApps()
      setApps(data)
    } catch (error) {
      message.error(t('messages.operationFailed'))
      console.error('Error loading apps:', error)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    loadApps()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleStart = async (appId) => {
    try {
      await startApp(appId)
      message.success(t('messages.appStarted'))
      await loadApps(true)
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('messages.operationFailed'))
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
      <LanguageSwitcher />
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
            />
          ))}
        </ul>
      )}
    </EditorialShell>
  )
}

export default Dashboard
