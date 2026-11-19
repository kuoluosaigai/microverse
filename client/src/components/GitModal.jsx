import { useState, useEffect, useCallback, useRef } from 'react'
import { Modal, Form, Input, Switch, Button, Divider, Spin, message } from 'antd'
import { useTranslation } from 'react-i18next'
import {
  getAppGit,
  bindAppGit,
  unbindAppGit,
  rotateAppGitSecret,
  checkAppGit,
  pullAppGit,
  getDeployStatus
} from '../api/apps'
import DeployLogDrawer from './DeployLogDrawer'

// Poll cadence for a submitted pull job (UpdateModal's cadence). The route
// that returned 202 owns nothing further — the job row is the only reporter.
const PULL_POLL_INTERVAL_MS = 2000

const shortSha = (sha) => (sha ? sha.slice(0, 7) : '—')

// SQLite CURRENT_TIMESTAMP is UTC without a timezone marker; parse it as UTC so
// the operator sees their local time instead of a value shifted by their offset.
const formatTime = (value) => {
  if (!value) return '—'
  const raw = String(value)
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const date = new Date(iso.endsWith('Z') ? iso : `${iso}Z`)
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString()
}

const errorMessage = (error, fallback) =>
  error?.response?.data?.error?.message || fallback

// Mirrors the server's normalizeGitUrl so cosmetic differences (case, trailing
// slash, `.git`) do not trigger a pointless overwrite warning.
const normalizeUrl = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')

function GitModal({ open, app, onClose, onChanged }) {
  const { t } = useTranslation()
  const [form] = Form.useForm()
  const appId = app?.id

  const [source, setSource] = useState(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [unbinding, setUnbinding] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [checking, setChecking] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [showSecret, setShowSecret] = useState(false)
  // Pull is async now (202 + deploy job): these track the in-flight job's
  // summary, whether it ended failed (→ log entry), and the log drawer.
  const [pullJob, setPullJob] = useState(null)
  const [pullFailed, setPullFailed] = useState(false)
  const [pullLogOpen, setPullLogOpen] = useState(false)
  const intervalRef = useRef(null)
  // 'job': we submitted this pull (its deploy row is the truth);
  // 'git': we are only watching a sync someone else started (webhook), so
  // the git summary's last_status is the only thing that may be trusted.
  const pullOwnerRef = useRef(null)
  // UpdateModal.jsx:36-41 idiom: the interval captures the pollPull created
  // at start, so convergence toasts must read `t` through a ref — otherwise
  // switching language mid-pull toasts in the OLD language.
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  // Async operations can settle after the modal closed (destroyOnClose unmounts
  // the Form). Writing to an unconnected form logs a React warning, so only
  // sync fields while the modal is actually open.
  const openRef = useRef(open)

  // The pull poller's single timer. Every stop path runs through here, and the
  // close effect below plus the unmount effect are its guaranteed deleters.
  const stopPullPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  // AppRow can unmount while the modal is open (route change, app deleted in
  // another tab's refresh): without this the interval would outlive the tree.
  useEffect(() => () => {
    openRef.current = false
    stopPullPolling()
  }, [stopPullPolling])

  const fillForm = useCallback(
    (data) => {
      if (!openRef.current) return
      form.setFieldsValue({
        url: data?.url || '',
        branch: data?.branch || 'main',
        autoUpdate: data ? !!data.autoUpdate : true
      })
    },
    [form]
  )

  const load = useCallback(async () => {
    if (!appId) return
    setLoading(true)
    try {
      const data = await getAppGit(appId)
      setSource(data)
      fillForm(data)
    } catch (error) {
      if (error?.response?.status === 404) {
        // No source bound yet: the modal doubles as the bind form.
        setSource(null)
        fillForm(null)
      } else {
        message.error(errorMessage(error, t('messages.operationFailed')))
      }
    } finally {
      setLoading(false)
    }
  }, [appId, fillForm, t])

  useEffect(() => {
    openRef.current = open
    if (!open) {
      // Closed: stop any pull poll and drop the task state. Reopening
      // re-derives it from the server (load → lastStatus 'updating' → resume),
      // so a pull that finished while closed — or was started elsewhere —
      // cannot desync the UI.
      stopPullPolling()
      setPulling(false)
      setPullJob(null)
      pullOwnerRef.current = null
      return
    }
    setShowSecret(false)
    setPullFailed(false)
    setPullLogOpen(false)
    load()
  }, [open, load, stopPullPolling])

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text)
      message.success(t('git.copied'))
    } catch {
      message.error(t('messages.operationFailed'))
    }
  }

  const save = async (payload) => {
    setSaving(true)
    try {
      const data = await bindAppGit(appId, payload)
      setSource(data)
      fillForm(data)
      message.success(t('git.saveSuccess'))
      onChanged?.()
    } catch (error) {
      message.error(errorMessage(error, t('messages.operationFailed')))
    } finally {
      setSaving(false)
    }
  }

  const submit = (values) => {
    const payload = {
      url: values.url.trim(),
      branch: values.branch?.trim() || 'main',
      autoUpdate: !!values.autoUpdate
    }
    // Changing the repository or branch makes the NEXT start/update switch the
    // worktree: repo-tracked files are overwritten. Warn before committing that.
    const urlChanged = source && normalizeUrl(payload.url) !== normalizeUrl(source.url)
    const branchChanged = source && payload.branch !== (source.branch || 'main')
    if (!urlChanged && !branchChanged) {
      save(payload)
      return
    }
    Modal.confirm({
      title: t('git.rebindConfirmTitle'),
      content: t('git.rebindConfirm'),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      onOk: () => save(payload)
    })
  }

  const confirmUnbind = () => {
    Modal.confirm({
      title: t('git.unbind'),
      content: t('git.unbindConfirm'),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        setUnbinding(true)
        try {
          await unbindAppGit(appId)
          setSource(null)
          fillForm(null)
          onChanged?.()
        } catch (error) {
          message.error(errorMessage(error, t('messages.operationFailed')))
        } finally {
          setUnbinding(false)
        }
      }
    })
  }

  const confirmRegenerate = () => {
    Modal.confirm({
      title: t('git.regenerate'),
      content: t('git.regenerateConfirm'),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        setRotating(true)
        try {
          const data = await rotateAppGitSecret(appId)
          setSource(data)
          setShowSecret(false)
          message.success(t('common.success'))
        } catch (error) {
          message.error(errorMessage(error, t('messages.operationFailed')))
        } finally {
          setRotating(false)
        }
      }
    })
  }

  const check = async () => {
    setChecking(true)
    try {
      const result = await checkAppGit(appId)
      if (result.upToDate) message.success(t('git.checkUpToDate'))
      else message.info(t('git.checkBehind'))
    } catch (error) {
      message.error(errorMessage(error, t('messages.operationFailed')))
    } finally {
      setChecking(false)
    }
  }

  // Pull is a background deploy job now: POST …/git/pull answers 202 the
  // moment the platform claims the job, and the response body says nothing
  // about the outcome. Convergence therefore happens ONLY through polling —
  // reporting success here was the old bug (a 2xx toast before anything had
  // been fetched).
  const settlePull = useCallback((ok) => {
    // `pullOwnerRef.current` doubles as the one-shot claim: concurrent
    // in-flight polls (fetch slower than the 2s tick) must not settle — and
    // toast — twice. The first settle revokes the claim synchronously.
    if (pullOwnerRef.current === null) return
    stopPullPolling()
    pullOwnerRef.current = null
    setPulling(false)
    setPullJob(null)
    if (ok) {
      setPullFailed(false)
      message.success(tRef.current('git.pullSuccess'))
    } else {
      setPullFailed(true)
      message.error(tRef.current('git.pullFailed'))
    }
    // Refresh the git summary (deployed commit / last_status) after the job —
    // never before it converges.
    load()
    onChanged?.()
  }, [stopPullPolling, load, onChanged])

  const pollPull = useCallback(async () => {
    if (!openRef.current || pullOwnerRef.current === null) {
      // Closed, or a sibling in-flight poll already settled this run.
      stopPullPolling()
      return
    }
    try {
      if (pullOwnerRef.current === 'git') {
        // Watching a sync we did not submit (webhook-triggered, or resumed
        // after reopen): the git summary is the only truth to converge on.
        const data = await getAppGit(appId)
        if (!openRef.current) {
          stopPullPolling()
          return
        }
        setSource(data)
        fillForm(data)
        if (data?.lastStatus === 'updating') return
        settlePull(data?.lastStatus !== 'failed')
        return
      }
      // Owner 'job': our pull claimed the deploy row before the 202 was sent,
      // so the row is authoritative until it stops being ours.
      const data = await getDeployStatus(appId)
      if (!openRef.current) {
        stopPullPolling()
        return
      }
      const job = data?.job ?? null
      if (job && job.kind === 'pull') {
        // KNOWN GAP, not handled here (comment only — honest wording): if
        // OUR pull converged and another tab claimed a NEW pull for the same
        // app within this one-fetch-delay window, this branch sees the
        // INTRUDER's live pull row, keeps polling, and settles with the
        // INTRUDER's outcome as if it were ours. The handover below covers
        // only non-pull replacements (kind mismatch) or a vanished row; a
        // pull→pull takeover is indistinguishable from ours because neither
        // the 202 body nor the summary carries a job identity — the real fix
        // is a server-side job id and is out of this task's scope.
        setPullJob(job.live ? job : null)
        if (!job.live) settlePull(job.status === 'succeeded')
        return
      }
      // Row gone (app deleted — the next getAppGit 404 ends it) or already
      // taken over by a NEWER job OF ANOTHER KIND, which implies ours
      // finished unseen: hand convergence to the git summary. (Pull→pull
      // takeover is NOT this branch — see the known gap above.)
      pullOwnerRef.current = 'git'
    } catch (error) {
      if (!openRef.current) {
        stopPullPolling()
        return
      }
      // Same taxonomy as UpdateModal.poll: transport/5xx are transient (keep
      // polling); only a definitive 4xx is fatal, and its server-produced
      // message is shown as-is.
      const status = error?.response?.status
      const fatal = status === 400 || status === 401 || status === 403 || status === 404
      if (!fatal) return
      stopPullPolling()
      pullOwnerRef.current = null
      setPulling(false)
      setPullJob(null)
      message.error(errorMessage(error, tRef.current('git.pullFailed')))
    }
  }, [appId, stopPullPolling, settlePull, fillForm])

  const startPullPolling = useCallback(() => {
    if (!openRef.current) return
    if (intervalRef.current === null) {
      intervalRef.current = window.setInterval(pollPull, PULL_POLL_INTERVAL_MS)
    }
  }, [pollPull])

  // Resume polling for an already-live sync (webhook running, or a pull
  // submitted in another session) discovered on load — UpdateModal's rule:
  // only active runs re-arm the timer, terminal states never do.
  useEffect(() => {
    if (!open || pulling) return
    if (source?.lastStatus === 'updating') {
      pullOwnerRef.current = 'git'
      setPulling(true)
      startPullPolling()
    }
  }, [open, pulling, source, startPullPolling])

  const pull = async () => {
    // Local re-entry guard only — true exclusion is the server's deploy-job
    // claim (a second pull answers 409), so never treat this as a lock.
    if (pulling) return
    setPulling(true)
    setPullFailed(false)
    try {
      await pullAppGit(appId)
      if (!openRef.current) return
      pullOwnerRef.current = 'job'
      startPullPolling()
      pollPull()
    } catch (error) {
      if (!openRef.current) return
      setPulling(false)
      // 409 busy texts have ONE producer (DeployJobs.busyMessage) — display
      // them verbatim, never re-assemble the sentence client-side.
      message.error(errorMessage(error, t('git.pullFailed')))
    }
  }

  const busy = saving || unbinding || rotating || checking || pulling

  return (
    <Modal
      title={`${t('git.title')}${app?.name ? ` — ${app.name}` : ''}`}
      open={open}
      onCancel={onClose}
      footer={null}
      width={640}
      destroyOnClose
    >
      <Spin spinning={loading}>
        <>
          <Form form={form} layout="vertical" onFinish={submit}>
            <Form.Item
              label={t('git.url')}
              name="url"
              rules={[
                { required: true, whitespace: true, message: t('git.urlRequired') }
              ]}
            >
              <Input placeholder="https://github.com/user/repo" />
            </Form.Item>

            <Form.Item label={t('git.branch')} name="branch">
              <Input placeholder="main" />
            </Form.Item>

            <Form.Item
              label={t('git.autoUpdate')}
              name="autoUpdate"
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>

            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <Button
                type="primary"
                htmlType="submit"
                className="btn-ink"
                loading={saving}
              >
                {t('git.save')}
              </Button>
              {source && (
                <Button danger onClick={confirmUnbind} loading={unbinding}>
                  {t('git.unbind')}
                </Button>
              )}
              {!source && (
                <span className="env-hint" style={{ marginTop: 0 }}>
                  {t('git.notBound')}
                </span>
              )}
            </div>
          </Form>

          {source && (
            <>
              <Divider orientation="start" plain>
                {t('git.status')}
              </Divider>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '160px 1fr',
                  rowGap: 8,
                  fontFamily: 'var(--mono)',
                  fontSize: 12
                }}
              >
                <span className="metric-label">{t('git.deployedCommit')}</span>
                <span title={source.deployedCommit || ''}>
                  {shortSha(source.deployedCommit)}
                </span>
                <span className="metric-label">{t('git.remoteCommit')}</span>
                <span title={source.remoteCommit || ''}>
                  {shortSha(source.remoteCommit)}
                </span>
                <span className="metric-label">{t('git.syncedAt')}</span>
                <span>{formatTime(source.syncedAt)}</span>
                <span className="metric-label">{t('git.status')}</span>
                <span>{t(`git.statusLabels.${source.lastStatus || 'idle'}`)}</span>
                {source.lastError && (
                  <>
                    <span className="metric-label">{t('git.lastError')}</span>
                    <span style={{ color: '#cf1322' }}>{source.lastError}</span>
                  </>
                )}
              </div>

              <Divider orientation="start" plain>
                {t('git.webhookUrl')}
              </Divider>

              <div style={{ marginBottom: 16 }}>
                <Input
                  readOnly
                  value={source.webhookUrl || ''}
                  addonAfter={
                    <Button
                      type="link"
                      size="small"
                      onClick={() => copyText(source.webhookUrl || '')}
                    >
                      {t('git.copy')}
                    </Button>
                  }
                />
              </div>

              <div className="metric-label" style={{ marginBottom: 8 }}>
                {t('git.webhookSecret')}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Input
                  readOnly
                  type={showSecret ? 'text' : 'password'}
                  value={source.webhookSecret || ''}
                />
                <Button onClick={() => setShowSecret((v) => !v)}>
                  {showSecret ? t('git.hide') : t('git.show')}
                </Button>
                <Button onClick={() => copyText(source.webhookSecret || '')}>
                  {t('git.copy')}
                </Button>
              </div>

              <div style={{ marginTop: 16, textAlign: 'right' }}>
                <Button danger onClick={confirmRegenerate} loading={rotating}>
                  {t('git.regenerate')}
                </Button>
              </div>

              <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
                <Button onClick={check} loading={checking} disabled={busy}>
                  {t('git.check')}
                </Button>
                <Button
                  type="primary"
                  onClick={pull}
                  loading={pulling}
                  disabled={busy || source.lastStatus === 'updating'}
                >
                  {pulling ? t('git.pulling') : t('git.pull')}
                </Button>
              </div>

              {pulling && pullJob?.step && (
                <div
                  style={{
                    marginTop: 12,
                    color: 'var(--accent)',
                    fontFamily: 'var(--mono)',
                    fontSize: 12
                  }}
                >
                  {`● ${t('appCard.deploy.live')} · ${t(`appCard.deploy.step.${pullJob.step}`)}`}
                </div>
              )}

              {pullFailed && (
                <div style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
                  <span style={{ color: '#cf1322', fontFamily: 'var(--mono)', fontSize: 12 }}>
                    {`✖ ${t('git.pullFailed')}`}
                  </span>
                  <Button size="small" onClick={() => setPullLogOpen(true)}>
                    {t('appCard.deploy.log')}
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      </Spin>

      <DeployLogDrawer
        appId={appId}
        appName={app?.name}
        open={pullLogOpen}
        onClose={() => setPullLogOpen(false)}
      />
    </Modal>
  )
}

export default GitModal
