import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Form, Input, Select, Button, Switch, Divider, message } from 'antd'
import { useTranslation } from 'react-i18next'
import EditorialShell from '../components/EditorialShell'
import { createApp } from '../api/apps'

const { Option } = Select

function CreateApp() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [form] = Form.useForm()
  const gitUrl = Form.useWatch('git_url', form)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (values) => {
    try {
      setLoading(true)
      await createApp(
        values.name,
        values.deploy_type,
        values.git_url
          ? {
              url: values.git_url,
              branch: values.git_branch || 'main',
              autoUpdate: values.git_auto_update !== false
            }
          : null
      )
      message.success(t('createApp.successMessage'))
      navigate('/')
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('createApp.errorMessage'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <EditorialShell>
      <button className="back-link" onClick={() => navigate('/')}>
        ← {t('common.back')}
      </button>
      <h1 className="page-title">{t('createApp.title')}</h1>
      <div className="lead">{t('createApp.helpText')}</div>

      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{ deploy_type: 'http-server' }}
        className="ed-form"
        style={{ maxWidth: 520, marginTop: 28 }}
      >
        <Form.Item
          label={t('createApp.appName')}
          name="name"
          rules={[
            { required: true, message: t('createApp.appNameRequired') },
            { pattern: /^[a-zA-Z0-9-_]+$/, message: t('createApp.appNamePattern') },
            { max: 64, message: t('createApp.appNameTooLong') },
          ]}
        >
          <Input placeholder={t('createApp.appNamePlaceholder')} />
        </Form.Item>

        <Form.Item
          label={t('createApp.deployType')}
          name="deploy_type"
          rules={[{ required: true, message: t('createApp.deployTypeRequired') }]}
        >
          <Select>
            <Option value="http-server">{t('createApp.staticSite')}</Option>
            <Option value="npm">{t('createApp.nodeApp')}</Option>
            <Option value="nginx">{t('createApp.nginx')}</Option>
          </Select>
        </Form.Item>

        <Divider orientation="start" plain>
          {t('createApp.gitSection')}
        </Divider>

        <Form.Item
          label={t('createApp.gitUrl')}
          name="git_url"
          extra={t('createApp.gitHelp')}
        >
          <Input placeholder={t('createApp.gitUrlPlaceholder')} />
        </Form.Item>

        {gitUrl && (
          <>
            <Form.Item
              label={t('createApp.gitBranch')}
              name="git_branch"
              initialValue="main"
            >
              <Input placeholder="main" />
            </Form.Item>

            <Form.Item
              label={t('createApp.gitAutoUpdate')}
              name="git_auto_update"
              valuePropName="checked"
              initialValue={true}
            >
              <Switch />
            </Form.Item>
          </>
        )}

        <Form.Item style={{ marginBottom: 0 }}>
          <Button
            type="primary"
            htmlType="submit"
            className="btn-ink"
            loading={loading}
          >
            {t('createApp.createButton')}
          </Button>
          <button
            type="button"
            className="text-link"
            style={{ marginLeft: 18 }}
            onClick={() => navigate('/')}
          >
            {t('common.cancel')}
          </button>
        </Form.Item>
      </Form>
    </EditorialShell>
  )
}

export default CreateApp
