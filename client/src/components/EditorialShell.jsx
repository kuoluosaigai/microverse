import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import LanguageSwitcher from './LanguageSwitcher'
import { useAuth } from '../context/AuthContext'

function EditorialShell({ right, children }) {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { user, logout } = useAuth()

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  return (
    <div className="shell">
      <div className="shell-inner">
        <header className="topbar">
          <a
            className="wordmark"
            href="/"
            onClick={(e) => { e.preventDefault(); navigate('/') }}
          >
            Micro<em>verse</em>
          </a>
          <nav className="nav">
            {right ?? <LanguageSwitcher />}
            {user && (
              <button className="nav-link" onClick={handleLogout}>
                {user.username} · {t('auth.logout')}
              </button>
            )}
          </nav>
        </header>
        <main className="page">{children}</main>
      </div>
    </div>
  )
}

export default EditorialShell
