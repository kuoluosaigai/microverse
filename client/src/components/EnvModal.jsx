import { useState, useEffect } from 'react'
import { Modal, message } from 'antd'
import { useTranslation } from 'react-i18next'
import { getAppEnv, setAppEnv } from '../api/apps'

function EnvModal({ appId, open, onCancel }) {
  const { t } = useTranslation()
  const [rows, setRows] = useState([{ key: '', value: '' }])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    getAppEnv(appId)
      .then((data) => setRows(data && data.length ? data : [{ key: '', value: '' }]))
      .catch(() => message.error(t('appEnv.loadError')))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, appId])

  const update = (i, field, val) => {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [field]: val } : r)))
  }
  const addRow = () => setRows((rs) => [...rs, { key: '', value: '' }])
  const removeRow = (i) => setRows((rs) => rs.filter((_, idx) => idx !== i))

  const save = async () => {
    const keyRe = /^[A-Za-z_][A-Za-z0-9_]*$/
    const seen = new Set()
    for (const r of rows) {
      if (!r.key || !keyRe.test(r.key)) {
        message.error(t('appEnv.keyInvalid'))
        return
      }
      if (seen.has(r.key)) {
        message.error(t('appEnv.keyDuplicate'))
        return
      }
      seen.add(r.key)
    }
    setSaving(true)
    try {
      await setAppEnv(appId, rows)
      message.success(t('appEnv.saveSuccess'))
      onCancel()
    } catch (e) {
      message.error(e.response?.data?.error?.message || t('appEnv.saveError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={t('appEnv.title')}
      open={open}
      onCancel={onCancel}
      onOk={save}
      okText={t('appEnv.save')}
      confirmLoading={saving}
      cancelText={t('common.cancel')}
      width={560}
      destroyOnClose
    >
      {loading ? (
        <div className="env-hint">{t('common.loading')}</div>
      ) : (
        <>
          <ul className="env-list">
            {rows.map((r, i) => (
              <li className="env-row" key={i}>
                <input
                  className="env-key"
                  value={r.key}
                  onChange={(e) => update(i, 'key', e.target.value)}
                  placeholder={t('appEnv.keyPlaceholder')}
                />
                <input
                  className="env-val"
                  value={r.value || ''}
                  onChange={(e) => update(i, 'value', e.target.value)}
                  placeholder={t('appEnv.valuePlaceholder')}
                />
                <button className="env-del" type="button" onClick={() => removeRow(i)} title={t('common.delete')}>×</button>
              </li>
            ))}
          </ul>
          <button className="env-add" type="button" onClick={addRow}>+ {t('appEnv.addRow')}</button>
          <p className="env-hint">{t('appEnv.applyHint')}</p>
        </>
      )}
    </Modal>
  )
}

export default EnvModal
