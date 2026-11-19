import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal, Spin, Checkbox, message, Switch } from 'antd'
import { FolderFilled, FileOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { getAppFiles, backupAppUrl } from '../api/apps'
import { useAppConfig } from '../context/AppConfigContext'
import { buildAppUrl, buildRootUrl } from '../utils/app-url'
import EnvModal from './EnvModal'
import GitModal from './GitModal'
import DeployLogDrawer from './DeployLogDrawer'

// Mirror of the server's utils/deploy-steps ladder: array order == report
// order == real execution order, so indexOf is a safe "phase N of M" index
// and the denominator drops the `queued`/`done` bookends. Keep in sync with
// the server — a step missing from the i18n tables renders as a raw key.
const DEPLOY_STEPS = ['queued', 'git', 'validate', 'install', 'build', 'nginx', 'launch', 'proxy', 'done']

// Terminal (failed) summaries stop being shown this long after the job
// finished (spec decision 6 sketch: "任务终态摘要 3 分钟后不再显示"; the
// duration is an implementation choice). Re-evaluated on every render, which
// the Dashboard's 10s silent refresh guarantees — no timer here.
const DEPLOY_SUMMARY_TTL_MS = 3 * 60 * 1000

// SQLite CURRENT_TIMESTAMP is UTC without a zone marker (GitModal.formatTime
// does the same fix-up). Unparseable/missing ⇒ treated as fresh, so a
// formatting surprise hides nothing.
const isFreshTerminal = (finishedAt) => {
  if (!finishedAt) return true
  const raw = String(finishedAt)
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const ms = new Date(iso.endsWith('Z') ? iso : `${iso}Z`).getTime()
  if (Number.isNaN(ms)) return true
  return Date.now() - ms < DEPLOY_SUMMARY_TTL_MS
}

function AppRow({ app, index, onStart, onStop, onDelete, onToggleDefault, startingId, onRefresh }) {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const appConfig = useAppConfig()
  const isRunning = app.status === 'running'
  // `deploy` is attached by the server to every list/detail app object; the
  // create-app response omits it entirely (undefined, not null) — stay
  // defensive.
  const deploy = app.deploy ?? null
  const deploying = Boolean(deploy && deploy.live)
  const deployFailedInline = Boolean(
    deploy && !deploy.live && deploy.status === 'failed' && isFreshTerminal(deploy.finishedAt)
  )
  const stepIndex = deploy && deploy.step ? DEPLOY_STEPS.indexOf(deploy.step) : -1
  const busyTitle = deploying ? t('appCard.deploy.busy') : undefined

  const [dirOpen, setDirOpen] = useState(false)
  const [files, setFiles] = useState([])
  const [loadingDir, setLoadingDir] = useState(false)
  const [envOpen, setEnvOpen] = useState(false)
  const [gitOpen, setGitOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [deployLogOpen, setDeployLogOpen] = useState(false)
  const starting = startingId === app.id

  const openDir = async () => {
    setDirOpen(true)
    setLoadingDir(true)
    try {
      setFiles(await getAppFiles(app.id))
    } catch {
      message.error(t('appCard.loadDirectoryError'))
      setDirOpen(false)
    } finally {
      setLoadingDir(false)
    }
  }

  const openPort = () => {
    if (!app.port || !isRunning) return
    // The root-domain default app opens at the base domain (e.g. yourdomain.com),
    // not its {name} subdomain — matches what the reverse proxy actually serves.
    const rootUrl = app.is_default && appConfig?.proxyEnabled
      ? buildRootUrl({ template: appConfig?.appPublicUrlTemplate, proxyBaseDomain: appConfig?.proxyBaseDomain })
      : null
    const url = rootUrl || buildAppUrl(app, appConfig?.appPublicUrlTemplate) || `http://localhost:${app.port}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const typeLabel = t(`appCard.deployTypes.${app.deploy_type}`) || app.deploy_type

  const memShort = (bytes) => {
    if (!bytes && bytes !== 0) return ''
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}K`
    return `${Math.round(bytes / (1024 * 1024))}M`
  }

  return (
    <>
      <li className="app-row">
        <div className="num">{String(index).padStart(2, '0')}</div>
        <div>
          <div className="name">{app.name}</div>
          <div className="sub">{typeLabel}</div>
          {app.git && (
            <div className="sub" style={{ textTransform: 'none', marginTop: 2 }}>
              {'git · '}
              {app.git.deployed_commit ? app.git.deployed_commit.slice(0, 7) : '—'}
              {app.git.last_status === 'update_available' && (
                <span
                  style={{
                    color: 'var(--accent)',
                    border: '1px solid var(--accent)',
                    borderRadius: 3,
                    padding: '1px 6px',
                    marginLeft: 8
                  }}
                >
                  {t('appCard.gitUpdateAvailable')}
                </span>
              )}
            </div>
          )}
          {deployFailedInline && (
            <div className="sub" style={{ textTransform: 'none', marginTop: 2 }}>
              <span style={{ color: '#cf1322' }}>{`✖ ${deploy.message || '—'}`}</span>
              <button
                className="text-link"
                style={{ marginLeft: 8 }}
                onClick={() => setDeployLogOpen(true)}
              >
                {t('appCard.deploy.log')}
              </button>
            </div>
          )}
        </div>
        <div className="port">
          {app.port ? (
            <>
              <span className="lbl">Port</span>
              {isRunning ? (
                <span
                  className="port-chip"
                  onClick={openPort}
                  title={t('appCard.clickToOpen')}
                >
                  {app.port} ↗
                </span>
              ) : (
                <span>{app.port}</span>
              )}
            </>
          ) : (
            <span className="lbl">—</span>
          )}
        </div>
        <div className="metrics">
          {isRunning && app.metrics ? (
            <span>{app.metrics.cpu.toFixed(1)}% · {memShort(app.metrics.memory)}</span>
          ) : (
            <span className="lbl">—</span>
          )}
        </div>
        <div className="kind">{app.deploy_type}</div>
        <div
          className={`status ${deploying || isRunning ? 'live' : 'idle'}`}
          title={
            deploying && stepIndex >= 0
              ? t('appCard.deploy.progress', { current: stepIndex + 1, total: DEPLOY_STEPS.length - 2 })
              : undefined
          }
        >
          {deploying
            ? `● ${t('appCard.deploy.live')}${deploy.step ? ` · ${t(`appCard.deploy.step.${deploy.step}`)}` : ''}`
            : t(`appCard.status.${app.status}`)}
        </div>
        <div className="acts">
          {isRunning ? (
            <button className="act" onClick={() => onStop(app.id)} disabled={deploying} title={busyTitle}>
              {t('appCard.stop')}
            </button>
          ) : (
            <button
              className="act"
              onClick={() => onStart(app.id)}
              disabled={starting || deploying}
              title={busyTitle}
            >
              {starting ? t('appCard.starting') : t('appCard.start')}
            </button>
          )}
          <button className="act" onClick={openDir}>
            {t('appCard.viewDirectory')}
          </button>
          <button className="act" onClick={() => navigate(`/apps/${app.id}/logs`)}>
            {t('appCard.logs')}
          </button>
          <button className="act" onClick={() => navigate(`/apps/${app.id}/metrics`)}>
            {t('appCard.metrics')}
          </button>
          {!app.git && (
            <button
              className="act"
              onClick={() => navigate(`/apps/${app.id}/upload`)}
              disabled={deploying}
              title={busyTitle}
            >
              {t('appCard.upload')}
            </button>
          )}
          <button
            className="act"
            onClick={() => {
              const a = document.createElement('a')
              a.href = backupAppUrl(app.id)
              a.download = `${app.name}-backup.zip`
              document.body.appendChild(a)
              a.click()
              document.body.removeChild(a)
            }}
          >
            {t('appCard.backup')}
          </button>
          {app.deploy_type === 'npm' && (
            <button
              className="act"
              onClick={() => setEnvOpen(true)}
              disabled={deploying}
              title={busyTitle}
            >
              {t('appCard.env')}
            </button>
          )}
          <button
            className="act"
            onClick={() => setGitOpen(true)}
            disabled={deploying}
            title={busyTitle}
          >
            {t('appCard.git')}
          </button>
          {appConfig?.proxyEnabled && isRunning && app.port && (
            <span className="default-toggle" title={busyTitle}>
              <Switch
                size="small"
                checked={!!app.is_default}
                disabled={deploying}
                onChange={(checked) => onToggleDefault(app, checked)}
              />
              <span className="default-toggle__label">{t('appCard.rootDefault')}</span>
            </span>
          )}
          <button
            className="act"
            onClick={() => setDeleteOpen(true)}
            disabled={isRunning || deploying}
            title={busyTitle}
          >
            {t('appCard.delete')}
          </button>
        </div>
      </li>

      <Modal
        title={t('appCard.directoryTitle')}
        open={dirOpen}
        onCancel={() => setDirOpen(false)}
        footer={null}
        width={560}
      >
        {loadingDir ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Spin />
          </div>
        ) : files.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <div className="loading-line">{t('appCard.directoryEmpty')}</div>
          </div>
        ) : (
          <ul className="file-list">
            {files.map((f, i) => (
              <li className="file-row" key={`${f.type}-${f.name}`}>
                <div className="num">{String(i + 1).padStart(2, '0')}</div>
                <div className="ext">
                  {f.type === 'directory' ? 'DIR' : (f.name.split('.').pop() || 'FILE').toUpperCase()}
                </div>
                <div className="fname">
                  {f.type === 'directory' ? (
                    <FolderFilled style={{ color: 'var(--ink-3)', marginRight: 8 }} />
                  ) : (
                    <FileOutlined style={{ color: 'var(--ink-3)', marginRight: 8 }} />
                  )}
                  {f.name}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      <Modal
        title={t('appCard.deleteTitle')}
        open={deleteOpen}
        onOk={() => {
          setDeleteOpen(false)
          onDelete(app.id, deleteFiles)
          setDeleteFiles(false)
        }}
        onCancel={() => {
          setDeleteOpen(false)
          setDeleteFiles(false)
        }}
        okText={t('common.yes')}
        cancelText={t('common.no')}
        okButtonProps={{ danger: true, disabled: isRunning }}
      >
        <p>{t('appCard.deleteConfirm')}</p>
        <Checkbox
          checked={deleteFiles}
          onChange={(e) => setDeleteFiles(e.target.checked)}
        >
          {t('appCard.deleteFilesLabel')}
        </Checkbox>
        {deleteFiles && (
          <p style={{ marginTop: 12, marginBottom: 0, color: 'var(--accent)' }}>
            {t('appCard.deleteFilesWarning')}
          </p>
        )}
      </Modal>

      {app.deploy_type === 'npm' && (
        <EnvModal appId={app.id} open={envOpen} onCancel={() => setEnvOpen(false)} />
      )}

      <GitModal
        open={gitOpen}
        app={app}
        onClose={() => setGitOpen(false)}
        onChanged={() => onRefresh?.()}
      />

      <DeployLogDrawer
        appId={app.id}
        appName={app.name}
        open={deployLogOpen}
        onClose={() => setDeployLogOpen(false)}
      />

    </>
  )
}

export default AppRow
