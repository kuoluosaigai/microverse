import { useCallback, useEffect, useRef, useState } from 'react'
import { Drawer } from 'antd'
import { useTranslation } from 'react-i18next'
import { getDeployStatus } from '../api/apps'

// v1 has no SSE for deploy logs (spec decision 6): while the drawer is open
// it polls GET /apps/:id/deploy — one endpoint carrying both the job summary
// and the bounded log tail. The poll must stop when the job reaches a terminal
// status and, above all, when the drawer closes.
const POLL_INTERVAL_MS = 2000

function DeployLogDrawer({ appId, appName, open, onClose }) {
  const { t } = useTranslation()
  const [job, setJob] = useState(null)
  const [logTail, setLogTail] = useState([])
  // Fatal-stop reason (401/404 etc.). Without it the poller dying silently
  // looks like "the log vanished" instead of a permission/resource failure.
  const [pollError, setPollError] = useState(null)
  // UpdateModal's pattern: a ref-based guard so in-flight polls cannot write
  // state after close/unmount, and a single interval handle that every stop
  // path clears.
  const intervalRef = useRef(null)
  const closedRef = useRef(false)
  // Keep `t` out of the poll's deps (UpdateModal.jsx:36-41): the language at
  // the moment the error renders, not the moment the poller was created.
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  const stopPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  const poll = useCallback(async () => {
    if (closedRef.current || appId == null) return
    try {
      const data = await getDeployStatus(appId)
      if (closedRef.current) return
      const next = data?.job ?? null
      setJob(next)
      setPollError(null)
      setLogTail(Array.isArray(data?.logTail) ? data.logTail : [])
      // Terminal (or the row vanished with the app): stop ticking but KEEP the
      // last tail on screen, so a finished deploy stays readable.
      if (!next || !next.live) {
        stopPolling()
        return
      }
    } catch (err) {
      if (closedRef.current) return
      // Same fault taxonomy as UpdateModal.poll: only a definitive 4xx means
      // polling can never succeed; network/5xx are transient, keep trying.
      const status = err?.response?.status
      const fatal = status === 400 || status === 401 || status === 403 || status === 404
      if (!fatal) return
      stopPolling()
      // UpdateModal shows the server text when it has one, else a local
      // fallback — a stopped poller must say why it stopped.
      setPollError(err.response?.data?.error?.message || tRef.current('appCard.deploy.pollError'))
    }
  }, [appId, stopPolling])

  useEffect(() => {
    if (!open || appId == null) return
    // Fresh open: drop the previous snapshot before the first fetch lands.
    setJob(null)
    setLogTail([])
    setPollError(null)
    closedRef.current = false
    poll()
    if (intervalRef.current === null) {
      intervalRef.current = window.setInterval(poll, POLL_INTERVAL_MS)
    }
    // Runs on close (open true→false), on appId change while open, and on
    // unmount: the only place the interval is guaranteed to die.
    return () => {
      closedRef.current = true
      stopPolling()
    }
  }, [open, appId, poll, stopPolling])

  const stepLabel = job?.step ? t(`appCard.deploy.step.${job.step}`) : ''

  return (
    <Drawer
      title={`${t('appCard.deploy.drawerTitle')}${appName ? ` — ${appName}` : ''}`}
      placement="right"
      width={640}
      open={open}
      onClose={onClose}
    >
      {pollError && (
        <div style={{ marginBottom: 12, color: '#cf1322', fontFamily: 'var(--mono)', fontSize: 12 }}>
          {`✖ ${pollError}`}
        </div>
      )}
      {job && job.live && (
        <div style={{ marginBottom: 12, color: 'var(--accent)', fontFamily: 'var(--mono)', fontSize: 12 }}>
          {`● ${t('appCard.deploy.live')}${stepLabel ? ` · ${stepLabel}` : ''}`}
        </div>
      )}
      {job && !job.live && job.status === 'failed' && (
        <div style={{ marginBottom: 12, color: '#cf1322', fontFamily: 'var(--mono)', fontSize: 12 }}>
          {`✖ ${job.message || '—'}`}
        </div>
      )}
      {logTail.length === 0 ? (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-3)' }}>
          {t('appCard.deploy.logEmpty')}
        </div>
      ) : (
        <pre
          style={{
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            fontFamily: 'var(--mono)',
            fontSize: 12,
            lineHeight: 1.7
          }}
        >
          {logTail.join('\n')}
        </pre>
      )}
    </Drawer>
  )
}

export default DeployLogDrawer
