import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Form, Input, Popconfirm, message } from 'antd'
import { useTranslation } from 'react-i18next'
import EditorialShell from '../components/EditorialShell'
import LanguageSwitcher from '../components/LanguageSwitcher'
import { useAppConfig } from '../context/AppConfigContext'
import { getProxyDomains, createProxyDomain, deleteProxyDomain } from '../api/apps'

function ProxyDomains() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const appConfig = useAppConfig()
  const [domains, setDomains] = useState([])
  const [loading, setLoading] = useState(true)
  const [form] = Form.useForm()

  const load = async () => {
    try {
      setDomains(await getProxyDomains())
    } catch {
      message.error(t('proxyDomains.loadError'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const add = async () => {
    const values = await form.validateFields()
    try {
      await createProxyDomain(values.host.trim())
      message.success(t('proxyDomains.created'))
      form.resetFields()
      await load()
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('proxyDomains.saveError'))
    }
  }

  const remove = async (id) => {
    try {
      await deleteProxyDomain(id)
      message.success(t('proxyDomains.deleted'))
      await load()
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('proxyDomains.deleteError'))
    }
  }

  const right = (
    <>
      <button className="nav-link" onClick={() => navigate('/routes')}>{t('proxyRoutes.title')}</button>
      <button className="nav-link" onClick={() => navigate('/')}>{t('common.back')}</button>
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
      <div className="lead">{t('proxyDomains.lead')}</div>

      <Form form={form} layout="inline" className="domain-add">
        <Form.Item name="host" rules={[
          { required: true, message: t('proxyDomains.hostRequired') },
          { pattern: /^[\w.-]+$/, message: t('proxyDomains.hostInvalid') }
        ]}>
          <Input placeholder={t('proxyDomains.hostPlaceholder')} style={{ width: 260 }} onPressEnter={add} />
        </Form.Item>
        <button type="button" className="nav-link accent" onClick={add}>+ {t('proxyDomains.add')}</button>
      </Form>

      {loading ? (
        <div className="loading-line">{t('common.loading')}</div>
      ) : domains.length === 0 ? (
        <div className="empty">
          <h2>{t('proxyDomains.empty')}</h2>
          <p>{t('proxyDomains.emptyDesc')}</p>
        </div>
      ) : (
        <ul className="app-list">
          {domains.map((d, i) => (
            <li className="app-row" key={d.id}>
              <div className="num">{String(i + 1).padStart(2, '0')}</div>
              <div className="name">{d.host}</div>
              <div className="acts">
                <Popconfirm title={t('proxyDomains.deleteTitle')} onConfirm={() => remove(d.id)} okText={t('common.yes')} cancelText={t('common.no')}>
                  <button className="act">{t('common.delete')}</button>
                </Popconfirm>
              </div>
            </li>
          ))}
        </ul>
      )}
    </EditorialShell>
  )
}

export default ProxyDomains
