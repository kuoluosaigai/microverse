import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Layout, Typography, Button, Row, Col, Space, message, Spin } from 'antd'
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import AppCard from '../components/AppCard'
import { getAllApps, deleteApp, startApp, stopApp } from '../api/apps'

const { Header, Content } = Layout
const { Title } = Typography

function Dashboard() {
  const navigate = useNavigate()
  const [apps, setApps] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadApps = async (showRefreshing = false) => {
    try {
      if (showRefreshing) {
        setRefreshing(true)
      } else {
        setLoading(true)
      }

      const data = await getAllApps()
      setApps(data)
    } catch (error) {
      message.error('Failed to load applications')
      console.error('Error loading apps:', error)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    loadApps()
  }, [])

  const handleStart = async (appId) => {
    try {
      await startApp(appId)
      message.success('Application started successfully')
      await loadApps(true)
    } catch (error) {
      message.error(error.response?.data?.error?.message || 'Failed to start application')
    }
  }

  const handleStop = async (appId) => {
    try {
      await stopApp(appId)
      message.success('Application stopped successfully')
      await loadApps(true)
    } catch (error) {
      message.error(error.response?.data?.error?.message || 'Failed to stop application')
    }
  }

  const handleDelete = async (appId) => {
    try {
      await deleteApp(appId)
      message.success('Application deleted successfully')
      await loadApps(true)
    } catch (error) {
      message.error(error.response?.data?.error?.message || 'Failed to delete application')
    }
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ background: '#fff', padding: '0 24px', borderBottom: '1px solid #f0f0f0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: '100%' }}>
          <Title level={3} style={{ margin: 0 }}>
            Microverse
          </Title>
          <Space>
            <Button
              icon={<ReloadOutlined spin={refreshing} />}
              onClick={() => loadApps(true)}
              disabled={refreshing}
            >
              Refresh
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => navigate('/create')}
            >
              Create App
            </Button>
          </Space>
        </div>
      </Header>

      <Content style={{ padding: '24px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '100px 0' }}>
            <Spin size="large" />
          </div>
        ) : apps.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '100px 0' }}>
            <Title level={4} type="secondary">
              No applications yet
            </Title>
            <p style={{ color: '#999', marginBottom: 24 }}>
              Create your first application to get started
            </p>
            <Button
              type="primary"
              size="large"
              icon={<PlusOutlined />}
              onClick={() => navigate('/create')}
            >
              Create App
            </Button>
          </div>
        ) : (
          <Row gutter={[16, 16]}>
            {apps.map(app => (
              <Col key={app.id} xs={24} sm={12} lg={8} xl={6}>
                <AppCard
                  app={app}
                  onStart={handleStart}
                  onStop={handleStop}
                  onDelete={handleDelete}
                />
              </Col>
            ))}
          </Row>
        )}
      </Content>
    </Layout>
  )
}

export default Dashboard
