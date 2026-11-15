import { useState, useEffect, useCallback, useRef } from 'react'
import { Modal, Form, Input, Switch, Button, Divider, Spin, message } from 'antd'
import { useTranslation } from 'react-i18next'
import {
  getAppGit,
  bindAppGit,
  unbindAppGit,
  rotateAppGitSecret,
  checkAppGit,
  pullAppGit
} from '../api/apps'

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

  // Async operations can settle after the modal closed (destroyOnClose unmounts
  // the Form). Writing to an unconnected form logs a React warning, so only
  // sync fields while the modal is actually open.
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  }, [open])

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
    if (!open) return
    setShowSecret(false)
    load()
  }, [open, load])

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text)
      message.success(t('git.copied'))
    } catch {
      message.error(t('messages.operationFailed'))
    }
  }

  const save = async (values) => {
    setSaving(true)
    try {
      const data = await bindAppGit(appId, {
        url: values.url.trim(),
        branch: values.branch?.trim() || 'main',
        autoUpdate: !!values.autoUpdate
      })
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

  const pull = async () => {
    // Guard against a second click landing while the first pull is running:
    // the server would answer 409 anyway, but the loading state must win.
    if (pulling) return
    setPulling(true)
    try {
      await pullAppGit(appId)
      message.success(t('git.pullSuccess'))
      await load()
      onChanged?.()
    } catch (error) {
      message.error(errorMessage(error, t('git.pullFailed')))
    } finally {
      setPulling(false)
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
          <Form form={form} layout="vertical" onFinish={save}>
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
                  disabled={busy}
                >
                  {pulling ? t('git.pulling') : t('git.pull')}
                </Button>
              </div>
            </>
          )}
        </>
      </Spin>
    </Modal>
  )
}

export default GitModal
