import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal, Form, Input, Radio, Select, InputNumber, Popconfirm, message } from 'antd'
import { useTranslation } from 'react-i18next'
import EditorialShell from '../components/EditorialShell'
import LanguageSwitcher from '../components/LanguageSwitcher'
import { useAppConfig } from '../context/AppConfigContext'
import { getAllApps, getProxyRoutes, createProxyRoute, updateProxyRoute, deleteProxyRoute } from '../api/apps'

function ProxyRoutes() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const appConfig = useAppConfig()
  const [routes, setRoutes] = useState([])
  const [apps, setApps] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null) // null = closed; {} = create; {..row} = edit
  const [form] = Form.useForm()

  const load = async () => {
    try {
      const [r, a] = await Promise.all([getProxyRoutes(), getAllApps()])
      setRoutes(r)
      setApps(a)
    } catch {
      message.error(t('proxyRoutes.loadError'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openCreate = () => { form.resetFields(); setEditing({}) }
  const openEdit = (row) => {
    setEditing(row)
    form.setFieldsValue({
      host: row.host,
      target_type: row.target_type,
      target_port: row.target_port,
      target_app_id: row.target_app_id
    })
  }

  const submit = async () => {
    const values = await form.validateFields()
    const payload = {
      host: values.host.trim(),
      target_type: values.target_type,
      target_port: values.target_type === 'port' ? values.target_port : null,
      target_app_id: values.target_type === 'app' ? values.target_app_id : null
    }
    try {
      if (editing && editing.id) await updateProxyRoute(editing.id, payload)
      else await createProxyRoute(payload)
      message.success(t(editing && editing.id ? 'proxyRoutes.updated' : 'proxyRoutes.created'))
      setEditing(null)
      await load()
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('proxyRoutes.saveError'))
    }
  }

  const remove = async (id) => {
    try {
      await deleteProxyRoute(id)
      message.success(t('proxyRoutes.deleted'))
      await load()
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('proxyRoutes.deleteError'))
    }
  }

  const right = (
    <>
      <button className="nav-link" onClick={() => navigate('/')}>{t('common.back')}</button>
      <button className="nav-link accent" onClick={openCreate}>+ {t('proxyRoutes.addRoute')}</button>
      <LanguageSwitcher />
    </>
  )

  if (!appConfig?.proxyEnabled) {
    return (
      <EditorialShell right={<LanguageSwitcher />}>
        <div className="empty"><h2>{t('proxyRoutes.disabledTitle')}</h2></div>
      </EditorialShell>
    )
  }

  return (
    <EditorialShell right={right}>
      <div className="lead">{t('proxyRoutes.lead')}</div>
      {loading ? (
        <div className="loading-line">{t('common.loading')}</div>
      ) : routes.length === 0 ? (
        <div className="empty">
          <h2>{t('proxyRoutes.empty')}</h2>
          <p>{t('proxyRoutes.emptyDesc')}</p>
        </div>
      ) : (
        <ul className="app-list">
          {routes.map((r, i) => {
            const target = r.target_type === 'port'
              ? `127.0.0.1:${r.target_port}`
              : (r.target_app_name || `#${r.target_app_id}`)
            const live = r.target_type === 'port' || r.resolved
            return (
              <li className="app-row" key={r.id}>
                <div className="num">{String(i + 1).padStart(2, '0')}</div>
                <div>
                  <div className="name">{r.host}</div>
                  <div className="sub">{t(r.target_type === 'port' ? 'proxyRoutes.targetPort' : 'proxyRoutes.targetApp')}</div>
                </div>
                <div className="port">
                  <span className="lbl">{t('proxyRoutes.target')}</span>
                  <span className="port-chip">{target}</span>
                </div>
                <div className={`status ${live ? 'live' : 'idle'}`}>
                  {live ? t('proxyRoutes.live') : t('proxyRoutes.idle')}
                </div>
                <div className="acts">
                  <button className="act" onClick={() => openEdit(r)}>{t('proxyRoutes.edit')}</button>
                  <Popconfirm title={t('proxyRoutes.deleteTitle')} onConfirm={() => remove(r.id)} okText={t('common.yes')} cancelText={t('common.no')}>
                    <button className="act">{t('common.delete')}</button>
                  </Popconfirm>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <Modal
        title={t(editing && editing.id ? 'proxyRoutes.editTitle' : 'proxyRoutes.addTitle')}
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={submit}
        okText={t('proxyRoutes.save')}
        cancelText={t('common.cancel')}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="host" label={t('proxyRoutes.host')} rules={[
            { required: true, message: t('proxyRoutes.hostRequired') },
            { pattern: /^[\w.-]+$/, message: t('proxyRoutes.hostInvalid') }
          ]}>
            <Input placeholder={t('proxyRoutes.hostPlaceholder')} />
          </Form.Item>
          <Form.Item name="target_type" label={t('proxyRoutes.targetType')} initialValue="port" rules={[{ required: true }]}>
            <Radio.Group>
              <Radio value="port">{t('proxyRoutes.targetPort')}</Radio>
              <Radio value="app">{t('proxyRoutes.targetApp')}</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.target_type !== b.target_type}>
            {({ getFieldValue }) =>
              getFieldValue('target_type') === 'app' ? (
                <Form.Item name="target_app_id" label={t('proxyRoutes.targetApp')} rules={[{ required: true, message: t('proxyRoutes.appRequired') }]}>
                  <Select placeholder={t('proxyRoutes.appPlaceholder')} options={apps.map(a => ({ value: a.id, label: a.name }))} />
                </Form.Item>
              ) : (
                <Form.Item name="target_port" label={t('proxyRoutes.targetPort')} rules={[{ required: true, message: t('proxyRoutes.portRequired') }]}>
                  <InputNumber min={1} max={65535} style={{ width: '100%' }} placeholder="8080" />
                </Form.Item>
              )
            }
          </Form.Item>
        </Form>
      </Modal>
    </EditorialShell>
  )
}

export default ProxyRoutes
