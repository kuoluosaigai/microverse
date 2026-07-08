import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import EditorialShell from '../components/EditorialShell'
import { getAppById, appLogsStreamUrl } from '../api/apps'

const IDLE_AFTER_MS = 10000

function AppLogs() {
  const navigate = useNavigate()
  const { id } = useParams()
  const { t } = useTranslation()

  const [app, setApp] = useState(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [lines, setLines] = useState([])
  const [status, setStatus] = useState('live')      // 'live' | 'idle' | 'disconnected'
  const [showJump, setShowJump] = useState(false)

  const scrollRef = useRef(null)
  const atBottomRef = useRef(true)
  const lastLineAtRef = useRef(Date.now())
  const [streamTick, setStreamTick] = useState(0)   // bump to force a fresh EventSource

  // Resolve the app.
  useEffect(() => {
    let alive = true
    getAppById(id)
      .then((a) => { if (alive) setApp(a) })
      .catch(() => { if (alive) setLoadFailed(true) })
    return () => { alive = false }
  }, [id])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    atBottomRef.current = atBottom
    setShowJump(!atBottom && lines.length > 0)
  }, [lines.length])

  // Sticky auto-scroll.
  useEffect(() => {
    if (!atBottomRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  // Open the SSE stream; re-open whenever streamTick changes (Retry).
  useEffect(() => {
    setStatus('live')
    const es = new EventSource(appLogsStreamUrl(id))

    const markLive = () => {
      lastLineAtRef.current = Date.now()
      setStatus('live')
    }

    es.addEventListener('open', () => setStatus('live'))
    es.addEventListener('history', (e) => {
      const data = JSON.parse(e.data)
      setLines(Array.isArray(data.lines) ? data.lines : [])
      markLive()
    })
    es.addEventListener('line', (e) => {
      const data = JSON.parse(e.data)
      setLines((prev) => [...prev, { level: data.level, msg: data.msg, ts: data.ts }])
      markLive()
    })
    es.onerror = () => setStatus('disconnected')

    return () => es.close()
  }, [id, streamTick])

  // LIVE vs IDLE: no line for IDLE_AFTER_MS while connected => idle.
  useEffect(() => {
    const timer = setInterval(() => {
      setStatus((prev) => {
        if (prev === 'disconnected') return prev
        return Date.now() - lastLineAtRef.current > IDLE_AFTER_MS ? 'idle' : 'live'
      })
    }, 3000)
    return () => clearInterval(timer)
  }, [])

  const jumpToLatest = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    atBottomRef.current = true
    setShowJump(false)
  }

  const retry = () => setStreamTick((n) => n + 1)

  const statusKey = {
    live: 'statusLive',
    idle: 'statusIdle',
    disconnected: 'statusDisconnected',
  }[status]

  if (loadFailed) {
    return (
      <EditorialShell>
        <div className="empty">
          <h2>{t('appLogs.loadError')}</h2>
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
        {t('appLogs.title')}{app ? ` — ${app.name}` : ''}
      </h1>
      <div className="lead">{t('appLogs.lead')}</div>

      <div className="log-view" ref={scrollRef} onScroll={handleScroll}>
        {lines.length === 0 ? (
          <div className="log-empty">{t('appLogs.empty')}</div>
        ) : (
          lines.map((l, i) => (
            <div key={i} className={`log-line log-${l.level}`}>{l.msg}</div>
          ))
        )}
      </div>

      <div className="log-toolbar">
        <span className={`log-status ${status}`}>
          {t(`appLogs.${statusKey}`)}
          {status === 'disconnected' && (
            <button className="log-jump" style={{ marginLeft: 12 }} onClick={retry}>
              {t('appLogs.retry')}
            </button>
          )}
        </span>
        {showJump && (
          <button className="log-jump" onClick={jumpToLatest}>
            {t('appLogs.jumpLatest')}
          </button>
        )}
      </div>
    </EditorialShell>
  )
}

export default AppLogs
