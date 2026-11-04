import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Modal, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { getUpdateStatus, startSystemUpdate } from '../api/system'

const STEPS = [
  'preflight',
  'fetch',
  'backup',
  'pull',
  'install',
  'build',
  'reload',
  'health',
  'cleanup'
]
const COMPARE_BASE_URL = 'https://github.com/kuoluosaigai/microverse/compare'
const POLL_INTERVAL_MS = 2000
const RELOAD_DELAY_MS = 1500

function UpdateModal({ version, onClose }) {
  const { t } = useTranslation()
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState(null)
  // True only while a run is actually in progress in this view. Terminal
  // persisted states (success/failed/rolled_back) render their result with
  // this false so the action button stays reachable (retry/repair/new update).
  const [started, setStarted] = useState(false)
  const [state, setState] = useState(null)
  const [logTail, setLogTail] = useState([])
  const intervalRef = useRef(null)
  const closedRef = useRef(false)
  // An update was started or observed here; closing should refresh the badge.
  const ranRef = useRef(false)
  // Keep `t` out of effect deps: a language switch must not refetch/re-seed
  // the status on mount. Poll errors read the latest translator via this ref.
  const tRef = useRef(t)

  useEffect(() => {
    tRef.current = t
  }, [t])

  const incomplete = version?.incomplete || null

  const stopPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  const poll = useCallback(async () => {
    if (closedRef.current) return
    try {
      const data = await getUpdateStatus()
      if (closedRef.current) return
      const next = data?.state || null
      setState(next)
      setLogTail(Array.isArray(data?.logTail) ? data.logTail : [])
      if (next?.status && next.status !== 'idle') ranRef.current = true

      if (next?.status === 'success') {
        setStarted(false)
        stopPolling()
        // The updated build is served only after the manager reloads the
        // platform, so pull a fresh bundle once the server is back.
        window.setTimeout(() => {
          if (!closedRef.current) window.location.reload()
        }, RELOAD_DELAY_MS)
      } else if (next?.status === 'failed' || next?.status === 'rolled_back') {
        setStarted(false)
        stopPolling()
      }
    } catch (err) {
      if (closedRef.current) return
      // `pm2 reload` briefly drops the HTTP API while the update keeps
      // running. Transport errors (no response) and 5xx responses (including
      // 502/503/504 from the nginx edge) are transient, so keep polling. Only
      // a definitive 4xx means the request itself is invalid: stop and show it.
      const status = err?.response?.status
      const fatal = status === 400 || status === 401 || status === 403 || status === 404
      if (!fatal) return
      stopPolling()
      setStartError(err.response?.data?.error?.message || tRef.current('common.error'))
    }
  }, [stopPolling])

  const startPolling = useCallback(() => {
    if (closedRef.current) return
    if (intervalRef.current === null) {
      intervalRef.current = window.setInterval(poll, POLL_INTERVAL_MS)
    }
  }, [poll])

  // Reopen/refresh continuity: render the persisted state as-is and resume
  // polling only for a live run. `started` deliberately stays false for
  // terminal states so the button (retry/new update) remains reachable.
  // Recovery from an interrupted update is the exception: its state file still
  // says `running` but the server flags it as `incomplete` (dead pid), so it
  // must render as repairable rather than as an active run.
  useEffect(() => {
    let cancelled = false
    getUpdateStatus()
      .then((data) => {
        if (cancelled || closedRef.current) return
        const next = data?.state || null
        setState(next)
        setLogTail(Array.isArray(data?.logTail) ? data.logTail : [])
        if (next?.status && next.status !== 'idle') ranRef.current = true
        if (next?.status === 'running' && !incomplete) {
          setStarted(true)
          startPolling()
        }
      })
      .catch(() => {
        // Status is advisory; the update action itself still works.
      })
    return () => { cancelled = true }
  }, [startPolling, incomplete])

  useEffect(() => () => {
    closedRef.current = true
    stopPolling()
  }, [stopPolling])

  const handleUpdate = async () => {
    setStarting(true)
    setStartError(null)
    try {
      await startSystemUpdate()
      if (closedRef.current) return
      ranRef.current = true
      setStarted(true)
      setState({ status: 'running', step: 'queued' })
      startPolling()
      poll()
    } catch (err) {
      if (closedRef.current) return
      setStartError(err.response?.data?.error?.message || t('common.error'))
    } finally {
      // Never touch state after the modal was closed while starting.
      if (!closedRef.current) setStarting(false)
    }
  }

  const handleClose = () => {
    stopPolling()
    onClose(ranRef.current)
  }

  const current = version?.current || null
  const latest = version?.latest || null
  const compareUrl =
    current?.sha && latest?.sha
      ? `${COMPARE_BASE_URL}/${current.sha}...${latest.sha}`
      : null
  const incompleteStepLabel = incomplete?.step
    ? (STEPS.includes(incomplete.step) ? t(`update.steps.${incomplete.step}`) : incomplete.step)
    : null
  const upToDate = Boolean(latest) && !version?.updateAvailable && !incomplete
  // The action stays reachable after a terminal run: retry a failed/rolled-back
  // update and repair an interrupted one, even though `data/update-state.json`
  // keeps the last terminal state forever.
  const canUpdate = Boolean(
    version?.updateEnabled && (
      version?.updateAvailable ||
      incomplete ||
      state?.status === 'failed' ||
      state?.status === 'rolled_back'
    ))
  const actionLabel = incomplete
    ? t('update.repairButton')
    : state?.status === 'failed' || state?.status === 'rolled_back'
      ? t('update.retryButton')
      : t('update.button')

  return (
    <Modal
      title={t('update.title')}
      open
      onCancel={handleClose}
      width={640}
      destroyOnClose
      footer={<Button onClick={handleClose}>{t('update.close')}</Button>}
    >
      <div className="update-versions">
        <div>
          <Typography.Text type="secondary">{t('update.current')}: </Typography.Text>
          <Typography.Text code>
            {current ? `v${current.version} · ${current.shortSha}` : t('update.noVersion')}
          </Typography.Text>
        </div>
        <div>
          <Typography.Text type="secondary">{t('update.latest')}: </Typography.Text>
          {latest ? (
            compareUrl ? (
              <Typography.Link href={compareUrl} target="_blank" rel="noopener noreferrer">
                {latest.shortSha}
              </Typography.Link>
            ) : (
              <Typography.Text code>{latest.shortSha}</Typography.Text>
            )
          ) : (
            <Typography.Text type="secondary">{t('update.checkFailed')}</Typography.Text>
          )}
        </div>
      </div>

      {incomplete && (
        <Alert
          style={{ marginTop: 16 }}
          type="warning"
          showIcon
          message={t('update.incomplete', { step: incompleteStepLabel || '—' })}
        />
      )}

      {version?.updateEnabled === false ? (
        <Alert
          style={{ marginTop: 16 }}
          type="warning"
          showIcon
          message={t('update.disabled', { reason: version.reason || '' })}
        />
      ) : (
        <div style={{ marginTop: 16 }}>
          {version?.updateAvailable ? (
            <Alert type="info" showIcon message={t('update.available')} />
          ) : upToDate ? (
            <Alert type="success" showIcon message={t('update.upToDate')} />
          ) : null}
          <Typography.Paragraph style={{ marginTop: 12 }}>
            {t('update.confirm')}
          </Typography.Paragraph>
          {!started && canUpdate && (
            <Button
              type="primary"
              loading={starting}
              onClick={handleUpdate}
            >
              {actionLabel}
            </Button>
          )}
        </div>
      )}

      {startError && (
        <Alert style={{ marginTop: 16 }} type="error" showIcon message={startError} />
      )}

      {started && state?.status === 'running' && (
        <Alert
          style={{ marginTop: 16 }}
          type="info"
          showIcon
          message={t('update.status.running')}
        />
      )}
      {state?.status === 'success' && (
        <>
          <Alert
            style={{ marginTop: 16 }}
            type="success"
            showIcon
            message={t('update.status.success')}
            description={t('update.reloadSoon')}
          />
          {state.warning && (
            <Alert
              style={{ marginTop: 8 }}
              type="warning"
              showIcon
              message={state.warning}
            />
          )}
        </>
      )}
      {state?.status === 'rolled_back' && (
        <Alert
          style={{ marginTop: 16 }}
          type="warning"
          showIcon
          message={t('update.status.rolledBack')}
          description={state.error || state.warning || undefined}
        />
      )}
      {state?.status === 'failed' && (
        <Alert
          style={{ marginTop: 16 }}
          type="error"
          showIcon
          message={t('update.status.failed')}
          description={state.error || state.warning || undefined}
        />
      )}

      {state && state.status !== 'idle' && (
        <>
          <div style={{ marginTop: 16 }}>
            <ol className="update-steps">
              {STEPS.map((step) => (
                <li
                  key={step}
                  aria-current={state?.step === step ? 'step' : undefined}
                  style={state?.step === step ? { fontWeight: 600 } : undefined}
                >
                  {t(`update.steps.${step}`)}
                </li>
              ))}
            </ol>
          </div>
          <div style={{ marginTop: 16 }}>
            <Typography.Text strong>{t('update.log')}</Typography.Text>
            <pre style={{ maxHeight: 240, overflow: 'auto' }}>{logTail.join('\n')}</pre>
          </div>
        </>
      )}
    </Modal>
  )
}

export default UpdateModal
