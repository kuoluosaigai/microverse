import { Card, Tag, Button, Space, Typography, Popconfirm } from 'antd'
import {
  PlayCircleOutlined,
  StopOutlined,
  DeleteOutlined,
  FolderOutlined
} from '@ant-design/icons'

const { Text, Paragraph } = Typography

function AppCard({ app, onStart, onStop, onDelete }) {
  const isRunning = app.status === 'running'

  const getStatusColor = (status) => {
    return status === 'running' ? 'success' : 'default'
  }

  const getDeployTypeLabel = (type) => {
    const labels = {
      'http-server': 'Static Site',
      'npm': 'Node.js',
      'nginx': 'Nginx'
    }
    return labels[type] || type
  }

  return (
    <Card
      hoverable
      title={
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Text strong>{app.name}</Text>
          <Tag color={getStatusColor(app.status)}>
            {app.status}
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
          <Text type="secondary">Type: </Text>
          <Text>{getDeployTypeLabel(app.deploy_type)}</Text>
        </div>

        {app.port && (
          <div>
            <Text type="secondary">Port: </Text>
            <Text code>{app.port}</Text>
          </div>
        )}

        <div>
          <Text type="secondary">Created: </Text>
          <Text>{new Date(app.created_at).toLocaleDateString()}</Text>
        </div>

        <div style={{ marginTop: 16 }}>
          <Space>
            {isRunning ? (
              <Button
                size="small"
                icon={<StopOutlined />}
                onClick={() => onStop(app.id)}
              >
                Stop
              </Button>
            ) : (
              <Button
                type="primary"
                size="small"
                icon={<PlayCircleOutlined />}
                onClick={() => onStart(app.id)}
              >
                Start
              </Button>
            )}

            <Popconfirm
              title="Delete application"
              description="Are you sure you want to delete this app?"
              onConfirm={() => onDelete(app.id)}
              okText="Yes"
              cancelText="No"
              disabled={isRunning}
            >
              <Button
                danger
                size="small"
                icon={<DeleteOutlined />}
                disabled={isRunning}
              >
                Delete
              </Button>
            </Popconfirm>
          </Space>
        </div>
      </Space>
    </Card>
  )
}

export default AppCard
