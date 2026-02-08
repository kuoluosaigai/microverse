import { Card, Tag, Button, Space, Typography, Popconfirm, Dropdown, Modal, List, message } from 'antd'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  PlayCircleOutlined,
  StopOutlined,
  DeleteOutlined,
  FolderOutlined,
  CloudUploadOutlined,
  MoreOutlined,
  FileOutlined,
  FolderFilled
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { getAppFiles } from '../api/apps'

const { Text } = Typography

function AppCard({ app, onStart, onStop, onDelete }) {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const isRunning = app.status === 'running'
  const [directoryModalVisible, setDirectoryModalVisible] = useState(false)
  const [directoryFiles, setDirectoryFiles] = useState([])
  const [loadingDirectory, setLoadingDirectory] = useState(false)

  const getStatusColor = (status) => {
    return status === 'running' ? 'success' : 'default'
  }

  const getDeployTypeLabel = (type) => {
    return t(`appCard.deployTypes.${type}`) || type
  }

  const handleViewDirectory = async () => {
    try {
      setLoadingDirectory(true)
      setDirectoryModalVisible(true)
      const files = await getAppFiles(app.id)
      setDirectoryFiles(files)
    } catch (error) {
      message.error(t('appCard.loadDirectoryError'))
      setDirectoryModalVisible(false)
    } finally {
      setLoadingDirectory(false)
    }
  }

  const moreMenuItems = [
    {
      key: 'viewDirectory',
      label: t('appCard.viewDirectory'),
      icon: <FolderOutlined />,
      onClick: handleViewDirectory
    }
  ]

  return (
    <>
      <Card
        hoverable
        title={
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Text strong>{app.name}</Text>
            <Tag color={getStatusColor(app.status)}>
              {t(`appCard.status.${app.status}`)}
            </Tag>
          </Space>
        }
        extra={<FolderOutlined />}
        styles={{
          body: { paddingTop: 16 }
        }}
      >
      <Space direction="vertical" style={{ width: '100%' }}>
        <div>
          <Text type="secondary">{t('appCard.type')}: </Text>
          <Text>{getDeployTypeLabel(app.deploy_type)}</Text>
        </div>

        {app.port && (
          <div>
            <Text type="secondary">{t('appCard.port')}: </Text>
            <Text code>{app.port}</Text>
          </div>
        )}

        <div>
          <Text type="secondary">{t('appCard.created')}: </Text>
          <Text>{new Date(app.created_at).toLocaleDateString()}</Text>
        </div>

        <div style={{ marginTop: 16 }}>
          <Space wrap>
            <Button
              size="small"
              icon={<CloudUploadOutlined />}
              onClick={() => navigate(`/apps/${app.id}/upload`)}
            >
              {t('appCard.upload')}
            </Button>

            {isRunning ? (
              <Button
                size="small"
                icon={<StopOutlined />}
                onClick={() => onStop(app.id)}
              >
                {t('appCard.stop')}
              </Button>
            ) : (
              <Button
                type="primary"
                size="small"
                icon={<PlayCircleOutlined />}
                onClick={() => onStart(app.id)}
              >
                {t('appCard.start')}
              </Button>
            )}

            <Popconfirm
              title={t('appCard.deleteTitle')}
              description={t('appCard.deleteConfirm')}
              onConfirm={() => onDelete(app.id)}
              okText={t('common.yes')}
              cancelText={t('common.no')}
              disabled={isRunning}
            >
              <Button
                danger
                size="small"
                icon={<DeleteOutlined />}
                disabled={isRunning}
              >
                {t('appCard.delete')}
              </Button>
            </Popconfirm>

            <Dropdown menu={{ items: moreMenuItems }} trigger={['click']}>
              <Button size="small" icon={<MoreOutlined />}>
                {t('appCard.more')}
              </Button>
            </Dropdown>
          </Space>
        </div>
      </Space>
    </Card>

    <Modal
      title={t('appCard.directoryTitle')}
      open={directoryModalVisible}
      onCancel={() => setDirectoryModalVisible(false)}
      footer={null}
      width={600}
    >
      {loadingDirectory ? (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <Text type="secondary">{t('common.loading')}</Text>
        </div>
      ) : directoryFiles.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <FolderOutlined style={{ fontSize: 48, color: '#ccc', marginBottom: 16 }} />
          <div>
            <Text type="secondary">{t('appCard.directoryEmpty')}</Text>
          </div>
        </div>
      ) : (
        <List
          dataSource={directoryFiles}
          renderItem={file => (
            <List.Item>
              <List.Item.Meta
                avatar={
                  file.type === 'directory' ? (
                    <FolderFilled style={{ fontSize: 24, color: '#faad14' }} />
                  ) : (
                    <FileOutlined style={{ fontSize: 24, color: '#1890ff' }} />
                  )
                }
                title={file.name}
                description={t(`appCard.fileTypes.${file.type}`)}
              />
            </List.Item>
          )}
        />
      )}
    </Modal>
  </>
  )
}

export default AppCard
