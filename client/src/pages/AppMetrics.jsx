import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import EditorialShell from '../components/EditorialShell'
import Sparkline from '../components/Sparkline'
import { getAppById, getAppMetrics } from '../api/apps'

const POLL_MS = 10000

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatUptime(ms) {
  if (!ms || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function AppMetrics() {
  const navigate = useNavigate()
  const { id } = useParams()
  const { t } = useTranslation()

  const [app, setApp] = useState(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [history, setHistory] = useState([])
  const [stale, setStale] = useState(false)

  // Resolve the app once.
  useEffect(() => {
    let alive = true
    getAppById(id)
      .then((a) => { if (alive) setApp(a) })
      .catch(() => { if (alive) setLoadFailed(true) })
    return () => { alive = false }
  }, [id])

  // Poll metrics every POLL_MS; keep last data + flag stale on error.
  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const data = await getAppMetrics(id)
        if (alive) { setHistory(data); setStale(false) }
      } catch {
        if (alive) setStale(true)
      }
    }
    poll()
    const timer = setInterval(poll, POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [id])

  const latest = history.length > 0 ? history[history.length - 1] : null

  if (loadFailed) {
    return (
      <EditorialShell>
        <div className="empty">
          <h2>{t('appMetrics.loadError')}</h2>
        </div>
      </EditorialShell>
    )
  }

  return (
    <EditorialShell>
      <button className="back-link" onClick={() => navigate('/')}>
        ← {t('common.back')}
      </button>
      <h1 className="page-title">
        {t('appMetrics.title')}{app ? ` — ${app.name}` : ''}
      </h1>
      <div className="lead">
        {t('appMetrics.lead')}
        {stale && <span className="metrics-stale"> · {t('appMetrics.stale')}</span>}
      </div>

      <div className="metrics-tiles">
        <div className="metric-tile">
          <div className="metric-label">{t('appMetrics.cpu')}</div>
          <div className="metric-value">{latest ? `${latest.cpu.toFixed(1)}%` : '—'}</div>
        </div>
        <div className="metric-tile">
          <div className="metric-label">{t('appMetrics.memory')}</div>
          <div className="metric-value">{latest ? formatBytes(latest.memory) : '—'}</div>
        </div>
        <div className="metric-tile">
          <div className="metric-label">{t('appMetrics.uptime')}</div>
          <div className="metric-value">{latest ? formatUptime(latest.uptimeMs) : '—'}</div>
        </div>
      </div>

      {history.length === 0 ? (
        <div className="metrics-empty">{t('appMetrics.empty')}</div>
      ) : (
        <div className="metrics-charts">
          <div className="metric-chart">
            <div className="metric-chart-label">{t('appMetrics.cpu')}</div>
            <Sparkline data={history.map((h) => h.cpu)} max={100} />
          </div>
          <div className="metric-chart">
            <div className="metric-chart-label">{t('appMetrics.memory')}</div>
            <Sparkline data={history.map((h) => h.memory)} />
          </div>
        </div>
      )}
    </EditorialShell>
  )
}

export default AppMetrics
