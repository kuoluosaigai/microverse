import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Layout,
  Typography,
  Upload,
  Button,
  Card,
  Space,
  message,
  List,
  Tag
} from 'antd'
import {
  InboxOutlined,
  ArrowLeftOutlined,
  CloudUploadOutlined
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { uploadFiles, getAppById } from '../api/apps'

const { Header, Content } = Layout
const { Title, Paragraph, Text } = Typography
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
        const appData = await getAppById(id)
        setApp(appData)
      } catch (error) {
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

      const files = fileList.map(file => file.originFileObj)
      const result = await uploadFiles(id, files)

      message.success(t('uploadFiles.uploadSuccess', { count: result.filesUploaded }))
      setFileList([])

      // Navigate back to dashboard after successful upload
      setTimeout(() => {
        navigate('/')
      }, 1500)
    } catch (error) {
      const errorMsg = error.response?.data?.error?.message || t('uploadFiles.uploadError')
      message.error(errorMsg)
    } finally {
      setUploading(false)
    }
  }

  const uploadProps = {
    multiple: true,
    fileList,
    beforeUpload: (file) => {
      // Add file to list without uploading immediately
      setFileList(prev => [...prev, {
        uid: file.uid,
        name: file.name,
        status: 'done',
        originFileObj: file
      }])
      return false // Prevent automatic upload
    },
    onRemove: (file) => {
      setFileList(prev => prev.filter(f => f.uid !== file.uid))
    },
    accept: '.html,.css,.js,.json,.txt,.md,.jpg,.jpeg,.png,.gif,.svg,.ico,.zip'
  }

  const getFileTypeTag = (fileName) => {
    const ext = fileName.split('.').pop().toLowerCase()
    const typeColors = {
      html: 'blue',
      css: 'purple',
      js: 'gold',
      json: 'cyan',
      zip: 'orange',
      jpg: 'green',
      jpeg: 'green',
      png: 'green',
      gif: 'green',
      svg: 'green',
      ico: 'green'
    }
    return <Tag color={typeColors[ext] || 'default'}>{ext.toUpperCase()}</Tag>
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ background: '#fff', padding: '0 24px', borderBottom: '1px solid #f0f0f0' }}>
        <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate('/')}
            style={{ marginRight: 16 }}
          >
            {t('common.back')}
          </Button>
          <Title level={3} style={{ margin: 0 }}>
            {t('uploadFiles.title')} {app && `- ${app.name}`}
          </Title>
        </div>
      </Header>

      <Content style={{ padding: '24px' }}>
        <div style={{ maxWidth: 800, margin: '0 auto' }}>
          <Card style={{ marginBottom: 24 }}>
            <Space direction="vertical" style={{ width: '100%' }} size="large">
              <div>
                <Title level={4}>{t('uploadFiles.uploadTitle')}</Title>
                <Paragraph type="secondary">
                  {t('uploadFiles.uploadDescription')}
                </Paragraph>
                <Paragraph type="secondary">
                  <Text strong>{t('uploadFiles.allowedTypes')}:</Text> {t('uploadFiles.allowedTypesValue')}
                  <br />
                  <Text strong>{t('uploadFiles.maxSize')}:</Text> {t('uploadFiles.maxSizeValue')}
                </Paragraph>
              </div>

              <Dragger {...uploadProps}>
                <p className="ant-upload-drag-icon">
                  <InboxOutlined />
                </p>
                <p className="ant-upload-text">
                  {t('uploadFiles.dragHint')}
                </p>
                <p className="ant-upload-hint">
                  {t('uploadFiles.dragDescription')}
                </p>
              </Dragger>

              {fileList.length > 0 && (
                <Card
                  title={`${t('uploadFiles.selectedFiles')} (${fileList.length})`}
                  size="small"
                  style={{ marginTop: 16 }}
                >
                  <List
                    size="small"
                    dataSource={fileList}
                    renderItem={file => (
                      <List.Item>
                        <Space>
                          {getFileTypeTag(file.name)}
                          <Text>{file.name}</Text>
                        </Space>
                      </List.Item>
                    )}
                  />
                </Card>
              )}

              <Button
                type="primary"
                size="large"
                icon={<CloudUploadOutlined />}
                onClick={handleUpload}
                loading={uploading}
                disabled={fileList.length === 0}
                block
              >
                {uploading ? t('uploadFiles.uploading') : t('uploadFiles.uploadButton')}
              </Button>
            </Space>
          </Card>

          {app && app.deploy_type === 'http-server' && (
            <Card>
              <Title level={5}>{t('uploadFiles.quickTipTitle')}</Title>
              <Paragraph type="secondary">
                {t('uploadFiles.quickTipStatic')}
              </Paragraph>
            </Card>
          )}
        </div>
      </Content>
    </Layout>
  )
}

export default UploadFiles
