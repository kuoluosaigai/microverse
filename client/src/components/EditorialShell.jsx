import { useNavigate } from 'react-router-dom'
import LanguageSwitcher from './LanguageSwitcher'

function EditorialShell({ right, children }) {
  const navigate = useNavigate()

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
          <nav className="nav">{right ?? <LanguageSwitcher />}</nav>
        </header>
        <main className="page">{children}</main>
      </div>
    </div>
  )
}

export default EditorialShell
