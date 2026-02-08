import { Card, Tag, Button, Space, Typography, Popconfirm } from 'antd'
import { useNavigate } from 'react-router-dom'
import {
  PlayCircleOutlined,
  StopOutlined,
  DeleteOutlined,
  FolderOutlined,
  CloudUploadOutlined
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

const { Text } = Typography

function AppCard({ app, onStart, onStop, onDelete }) {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const isRunning = app.status === 'running'

  const getStatusColor = (status) => {
    return status === 'running' ? 'success' : 'default'
  }

  const getDeployTypeLabel = (type) => {
    return t(`appCard.deployTypes.${type}`) || type
  }

  return (
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
          </Space>
        </div>
      </Space>
    </Card>
  )
}

export default AppCard
