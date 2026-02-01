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
import { createApp } from '../api/apps'

const { Header, Content } = Layout
const { Title, Paragraph } = Typography
const { Option } = Select

function CreateApp() {
  const navigate = useNavigate()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (values) => {
    try {
      setLoading(true)
      await createApp(values.name, values.deploy_type)
      message.success('Application created successfully')
      navigate('/')
    } catch (error) {
      message.error(error.response?.data?.error?.message || 'Failed to create application')
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
            Back
          </Button>
          <Title level={3} style={{ margin: 0 }}>
            Create Application
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
                label="Application Name"
                name="name"
                rules={[
                  { required: true, message: 'Please enter an application name' },
                  { pattern: /^[a-zA-Z0-9-_]+$/, message: 'Only alphanumeric, dash, and underscore allowed' }
                ]}
              >
                <Input
                  placeholder="my-app"
                  size="large"
                />
              </Form.Item>

              <Form.Item
                label="Deployment Type"
                name="deploy_type"
                rules={[{ required: true, message: 'Please select a deployment type' }]}
              >
                <Select size="large">
                  <Option value="http-server">
                    Static Site (http-server)
                  </Option>
                  <Option value="npm">
                    Node.js Application (npm)
                  </Option>
                  <Option value="nginx" disabled>
                    Nginx (Coming Soon)
                  </Option>
                </Select>
              </Form.Item>

              <Paragraph type="secondary" style={{ marginBottom: 24 }}>
                After creating the app, you'll need to upload your files before deploying.
              </Paragraph>

              <Form.Item>
                <Space>
                  <Button
                    type="primary"
                    htmlType="submit"
                    size="large"
                    loading={loading}
                  >
                    Create Application
                  </Button>
                  <Button
                    size="large"
                    onClick={() => navigate('/')}
                  >
                    Cancel
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
