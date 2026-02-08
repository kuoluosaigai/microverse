import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Layout,
  Typography,
  Form,
  Input,
  Select,
  Button,
  Card,
  Space,
  message
} from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { createApp } from '../api/apps'

const { Header, Content } = Layout
const { Title, Paragraph } = Typography
const { Option } = Select

function CreateApp() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (values) => {
    try {
      setLoading(true)
      await createApp(values.name, values.deploy_type)
      message.success(t('createApp.successMessage'))
      navigate('/')
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('createApp.errorMessage'))
    } finally {
      setLoading(false)
    }
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
            {t('createApp.title')}
          </Title>
        </div>
      </Header>

      <Content style={{ padding: '24px' }}>
        <div style={{ maxWidth: 600, margin: '0 auto' }}>
          <Card>
            <Form
              form={form}
              layout="vertical"
              onFinish={handleSubmit}
              initialValues={{ deploy_type: 'http-server' }}
            >
              <Form.Item
                label={t('createApp.appName')}
                name="name"
                rules={[
                  { required: true, message: t('createApp.appNameRequired') },
                  { pattern: /^[a-zA-Z0-9-_]+$/, message: t('createApp.appNamePattern') }
                ]}
              >
                <Input
                  placeholder={t('createApp.appNamePlaceholder')}
                  size="large"
                />
              </Form.Item>

              <Form.Item
                label={t('createApp.deployType')}
                name="deploy_type"
                rules={[{ required: true, message: t('createApp.deployTypeRequired') }]}
              >
                <Select size="large">
                  <Option value="http-server">
                    {t('createApp.staticSite')}
                  </Option>
                  <Option value="npm">
                    {t('createApp.nodeApp')}
                  </Option>
                  <Option value="nginx" disabled>
                    {t('createApp.nginx')}
                  </Option>
                </Select>
              </Form.Item>

              <Paragraph type="secondary" style={{ marginBottom: 24 }}>
                {t('createApp.helpText')}
              </Paragraph>

              <Form.Item>
                <Space>
                  <Button
                    type="primary"
                    htmlType="submit"
                    size="large"
                    loading={loading}
                  >
                    {t('createApp.createButton')}
                  </Button>
                  <Button
                    size="large"
                    onClick={() => navigate('/')}
                  >
                    {t('common.cancel')}
                  </Button>
                </Space>
              </Form.Item>
            </Form>
          </Card>
        </div>
      </Content>
    </Layout>
  )
}

export default CreateApp
