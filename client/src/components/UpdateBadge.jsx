import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getSystemVersion } from '../api/system'
import UpdateModal from './UpdateModal'

/**
 * Nav badge showing the running platform version. Renders nothing when the
 * version probe fails (or returns nothing) so a non-git or offline deployment
 * simply has no badge instead of an error.
 */
function UpdateBadge() {
  const { t } = useTranslation()
  const [version, setVersion] = useState(null)
  const [modalOpen, setModalOpen] = useState(false)

  const loadVersion = useCallback(() => {
    getSystemVersion()
      .then((data) => setVersion(data || null))
      .catch(() => setVersion(null))
  }, [])

  useEffect(() => {
    loadVersion()
  }, [loadVersion])

  if (!version) return null

  const closeModal = (refresh) => {
    setModalOpen(false)
    if (refresh) loadVersion()
  }

  return (
    <>
      <button type="button" className="nav-link" onClick={() => setModalOpen(true)}>
        {version.updateAvailable && (
          <>
            <span aria-hidden>●</span> {t('update.available')}{' · '}
          </>
        )}
        {version.current
          ? `v${version.current.version} · ${version.current.shortSha}`
          : t('update.noVersion')}
      </button>
      {modalOpen && <UpdateModal version={version} onClose={closeModal} />}
    </>
  )
}

export default UpdateBadge
