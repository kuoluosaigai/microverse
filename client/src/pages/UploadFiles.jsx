import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Upload, Button, message } from 'antd'
import { useTranslation } from 'react-i18next'
import EditorialShell from '../components/EditorialShell'
import { uploadFiles, getAppById } from '../api/apps'

const { Dragger } = Upload

function UploadFiles() {
  const navigate = useNavigate()
  const { id } = useParams()
  const { t } = useTranslation()
  const [fileList, setFileList] = useState([])
  const [uploading, setUploading] = useState(false)
  const [app, setApp] = useState(null)

  useEffect(() => {
    const loadApp = async () => {
      try {
        setApp(await getAppById(id))
      } catch {
        message.error(t('uploadFiles.loadAppError'))
        navigate('/')
      }
    }
    loadApp()
  }, [id, navigate, t])

  const handleUpload = async () => {
    if (fileList.length === 0) {
      message.warning(t('uploadFiles.noFilesSelected'))
      return
    }
    try {
      setUploading(true)
      const files = fileList.map((f) => f.originFileObj)
      const result = await uploadFiles(id, files)
      message.success(t('uploadFiles.uploadSuccess', { count: result.filesUploaded }))
      setFileList([])
      setTimeout(() => navigate('/'), 1200)
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('uploadFiles.uploadError'))
    } finally {
      setUploading(false)
    }
  }

  const uploadProps = {
    multiple: true,
    fileList,
    beforeUpload: (file) => {
      setFileList((prev) => [
        ...prev,
        { uid: file.uid, name: file.name, status: 'done', originFileObj: file },
      ])
      return false
    },
    onRemove: (file) => {
      setFileList((prev) => prev.filter((f) => f.uid !== file.uid))
    },
    accept: '.html,.css,.js,.json,.txt,.md,.jpg,.jpeg,.png,.gif,.svg,.ico,.zip',
  }

  const extOf = (name) => (name.split('.').pop() || 'FILE').toUpperCase()

  return (
    <EditorialShell>
      <button className="back-link" onClick={() => navigate('/')}>
        ← {t('common.back')}
      </button>
      <h1 className="page-title">
        {t('uploadFiles.title')}{app ? ` — ${app.name}` : ''}
      </h1>
      <div className="lead">{t('uploadFiles.uploadDescription')}</div>

      <div style={{ maxWidth: 720, marginTop: 28 }}>
        <Dragger {...uploadProps} className="dropzone">
          <div className="dz-text">{t('uploadFiles.dragHint')}</div>
          <div className="dz-hint">{t('uploadFiles.dragDescription')}</div>
        </Dragger>

        {fileList.length > 0 && (
          <ul className="file-list">
            {fileList.map((file, i) => (
              <li className="file-row" key={file.uid}>
                <div className="num">{String(i + 1).padStart(2, '0')}</div>
                <div className="ext">{extOf(file.name)}</div>
                <div className="fname">{file.name}</div>
              </li>
            ))}
          </ul>
        )}

        <div style={{ marginTop: 26 }}>
          <Button
            type="primary"
            className="btn-ink"
            icon={null}
            onClick={handleUpload}
            loading={uploading}
            disabled={fileList.length === 0}
          >
            {uploading ? t('uploadFiles.uploading') : t('uploadFiles.uploadButton')}
          </Button>
        </div>

        {app && app.deploy_type === 'http-server' && (
          <div className="note">
            <h4>{t('uploadFiles.quickTipTitle')}</h4>
            <p>{t('uploadFiles.quickTipStatic')}</p>
          </div>
        )}
      </div>
    </EditorialShell>
  )
}

export default UploadFiles
