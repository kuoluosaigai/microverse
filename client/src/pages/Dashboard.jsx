import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Layout, Typography, Button, Row, Col, Space, message, Spin } from 'antd'
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import AppCard from '../components/AppCard'
import LanguageSwitcher from '../components/LanguageSwitcher'
import { getAllApps, deleteApp, startApp, stopApp } from '../api/apps'

const { Header, Content } = Layout
const { Title } = Typography

function Dashboard() {
  const navigate = useNavigate()
  const { t } = useTranslation()
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
      message.error(t('messages.operationFailed'))
      console.error('Error loading apps:', error)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    loadApps()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleStart = async (appId) => {
    try {
      await startApp(appId)
      message.success(t('messages.appStarted'))
      await loadApps(true)
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('messages.operationFailed'))
    }
  }

  const handleStop = async (appId) => {
    try {
      await stopApp(appId)
      message.success(t('messages.appStopped'))
      await loadApps(true)
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('messages.operationFailed'))
    }
  }

  const handleDelete = async (appId) => {
    try {
      await deleteApp(appId)
      message.success(t('messages.appDeleted'))
      await loadApps(true)
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('messages.operationFailed'))
    }
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ background: '#fff', padding: '0 24px', borderBottom: '1px solid #f0f0f0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: '100%' }}>
          <Title level={3} style={{ margin: 0 }}>
            {t('common.appName')}
          </Title>
          <Space>
            <LanguageSwitcher />
            <Button
              icon={<ReloadOutlined spin={refreshing} />}
              onClick={() => loadApps(true)}
              disabled={refreshing}
            >
              {t('dashboard.refreshApps')}
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => navigate('/create')}
            >
              {t('dashboard.createApp')}
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
              {t('dashboard.noApps')}
            </Title>
            <p style={{ color: '#999', marginBottom: 24 }}>
              {t('dashboard.noAppsDesc')}
            </p>
            <Button
              type="primary"
              size="large"
              icon={<PlusOutlined />}
              onClick={() => navigate('/create')}
            >
              {t('dashboard.createApp')}
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
