import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal, Spin, Popconfirm, message } from 'antd'
import { FolderFilled, FileOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { getAppFiles } from '../api/apps'
import EnvModal from './EnvModal'

function AppRow({ app, index, onStart, onStop, onDelete, startingId }) {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const isRunning = app.status === 'running'

  const [dirOpen, setDirOpen] = useState(false)
  const [files, setFiles] = useState([])
  const [loadingDir, setLoadingDir] = useState(false)
  const [envOpen, setEnvOpen] = useState(false)
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
    if (app.port && isRunning) {
      window.open(`http://localhost:${app.port}`, '_blank', 'noopener,noreferrer')
    }
  }

  const typeLabel = t(`appCard.deployTypes.${app.deploy_type}`) || app.deploy_type

  return (
    <>
      <li className="app-row">
        <div className="num">{String(index).padStart(2, '0')}</div>
        <div>
          <div className="name">{app.name}</div>
          <div className="sub">{typeLabel}</div>
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
        <div className="kind">{app.deploy_type}</div>
        <div className={`status ${isRunning ? 'live' : 'idle'}`}>
          {t(`appCard.status.${app.status}`)}
        </div>
        <div className="acts">
          {isRunning ? (
            <button className="act" onClick={() => onStop(app.id)}>
              {t('appCard.stop')}
            </button>
          ) : (
            <button className="act" onClick={() => onStart(app.id)} disabled={starting}>
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
          <button
            className="act"
            onClick={() => navigate(`/apps/${app.id}/upload`)}
          >
            {t('appCard.upload')}
          </button>
          {app.deploy_type === 'npm' && (
            <button className="act" onClick={() => setEnvOpen(true)}>
              {t('appCard.env')}
            </button>
          )}
          <Popconfirm
            title={t('appCard.deleteTitle')}
            description={t('appCard.deleteConfirm')}
            onConfirm={() => onDelete(app.id)}
            okText={t('common.yes')}
            cancelText={t('common.no')}
            disabled={isRunning}
          >
            <button className="act" disabled={isRunning}>
              {t('appCard.delete')}
            </button>
          </Popconfirm>
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

      {app.deploy_type === 'npm' && (
        <EnvModal appId={app.id} open={envOpen} onCancel={() => setEnvOpen(false)} />
      )}
    </>
  )
}

export default AppRow
