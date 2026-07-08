import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import EditorialShell from '../components/EditorialShell'
import { getAppById, appLogsStreamUrl } from '../api/apps'

function AppLogs() {
  const navigate = useNavigate()
  const { id } = useParams()
  const { t } = useTranslation()

  const [app, setApp] = useState(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [lines, setLines] = useState([])

  const scrollRef = useRef(null)
  const atBottomRef = useRef(true)

  // Resolve the app (for the title / load-failure handling).
  useEffect(() => {
    let alive = true
    getAppById(id)
      .then((a) => { if (alive) setApp(a) })
      .catch(() => { if (alive) setLoadFailed(true) })
    return () => { alive = false }
  }, [id])

  // Track whether the view is pinned to the bottom.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }, [])

  // Sticky auto-scroll on new lines.
  useEffect(() => {
    if (!atBottomRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  // Open the SSE stream: history first, then live lines.
  useEffect(() => {
    const es = new EventSource(appLogsStreamUrl(id))

    es.addEventListener('history', (e) => {
      const data = JSON.parse(e.data)
      setLines(Array.isArray(data.lines) ? data.lines : [])
    })
    es.addEventListener('line', (e) => {
      const data = JSON.parse(e.data)
      setLines((prev) => [...prev, { level: data.level, msg: data.msg, ts: data.ts }])
    })
    es.onerror = () => {
      // Connection-state UI (LIVE/IDLE/DISCONNECTED + retry) lands in Task 5.
    }

    return () => es.close()
  }, [id])

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
    </EditorialShell>
  )
}

export default AppLogs
