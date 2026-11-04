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
  const [started, setStarted] = useState(false)
  const [state, setState] = useState(null)
  const [logTail, setLogTail] = useState([])
  const intervalRef = useRef(null)

  const stopPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  useEffect(() => stopPolling, [stopPolling])

  const poll = useCallback(async () => {
    try {
      const data = await getUpdateStatus()
      const next = data?.state || null
      setState(next)
      setLogTail(Array.isArray(data?.logTail) ? data.logTail : [])

      if (next?.status === 'success') {
        stopPolling()
        // The updated build is served only after the manager reloads the
        // platform, so pull a fresh bundle once the server is back.
        window.setTimeout(() => window.location.reload(), RELOAD_DELAY_MS)
      } else if (next?.status === 'failed' || next?.status === 'rolled_back') {
        stopPolling()
      }
    } catch {
      // Transient by design: `pm2 reload` briefly drops the HTTP API while the
      // update keeps running. Treat connection errors as "not ready yet".
    }
  }, [stopPolling])

  const handleUpdate = async () => {
    setStarting(true)
    setStartError(null)
    try {
      await startSystemUpdate()
      setStarted(true)
      setState({ status: 'running', step: 'queued' })
      intervalRef.current = window.setInterval(poll, POLL_INTERVAL_MS)
      poll()
    } catch (err) {
      setStartError(err.response?.data?.error?.message || t('common.error'))
    } finally {
      setStarting(false)
    }
  }

  const handleClose = () => {
    stopPolling()
    onClose(started)
  }

  const current = version?.current || null
  const latest = version?.latest || null
  const compareUrl =
    current?.sha && latest?.sha
      ? `${COMPARE_BASE_URL}/${current.sha}...${latest.sha}`
      : null

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

      {version?.updateEnabled === false ? (
        <Alert
          style={{ marginTop: 16 }}
          type="warning"
          showIcon
          message={t('update.disabled', { reason: version.reason || '' })}
        />
      ) : (
        <div style={{ marginTop: 16 }}>
          <Alert
            type={version?.updateAvailable ? 'info' : 'success'}
            showIcon
            message={version?.updateAvailable ? t('update.available') : t('update.upToDate')}
          />
          <Typography.Paragraph style={{ marginTop: 12 }}>
            {t('update.confirm')}
          </Typography.Paragraph>
          {!started && (
            <Button type="primary" loading={starting} onClick={handleUpdate}>
              {t('update.button')}
            </Button>
          )}
        </div>
      )}

      {startError && (
        <Alert style={{ marginTop: 16 }} type="error" showIcon message={startError} />
      )}

      {state?.status === 'running' && (
        <Alert
          style={{ marginTop: 16 }}
          type="info"
          showIcon
          message={t('update.status.running')}
        />
      )}
      {state?.status === 'success' && (
        <Alert
          style={{ marginTop: 16 }}
          type="success"
          showIcon
          message={t('update.status.success')}
          description={t('update.reloadSoon')}
        />
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

      {started && (
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
