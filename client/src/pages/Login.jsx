import { useState } from 'react'
import { useNavigate, Navigate } from 'react-router-dom'
import { Form, Input, Button, message } from 'antd'
import { useTranslation } from 'react-i18next'
import EditorialShell from '../components/EditorialShell'
import { useAuth } from '../context/AuthContext'

function Login() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { login, user } = useAuth()
  const [loading, setLoading] = useState(false)

  // Already authenticated → bounce to the dashboard.
  if (user) return <Navigate to="/" replace />

  const handleSubmit = async (values) => {
    try {
      setLoading(true)
      await login(values.username, values.password)
      message.success(t('auth.loginSuccess'))
      navigate('/')
    } catch (err) {
      message.error(err.response?.data?.error?.message || t('auth.loginError'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <EditorialShell>
      <h1 className="page-title">{t('auth.loginTitle')}</h1>
      <div className="lead">{t('auth.loginLead')}</div>
      <Form
        layout="vertical"
        onFinish={handleSubmit}
        className="ed-form"
        style={{ maxWidth: 360, marginTop: 28 }}
      >
        <Form.Item
          label={t('auth.username')}
          name="username"
          rules={[{ required: true, message: t('auth.usernameRequired') }]}
        >
          <Input autoComplete="username" />
        </Form.Item>
        <Form.Item
          label={t('auth.password')}
          name="password"
          rules={[{ required: true, message: t('auth.passwordRequired') }]}
        >
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item style={{ marginBottom: 0 }}>
          <Button type="primary" htmlType="submit" className="btn-ink" loading={loading}>
            {t('auth.submit')}
          </Button>
        </Form.Item>
      </Form>
    </EditorialShell>
  )
}

export default Login
