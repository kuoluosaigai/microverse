import { Component } from 'react'
import { Button } from 'antd'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import EditorialShell from './EditorialShell'

// Compact fallback: inline card for a single crashed page (nav stays alive).
function CompactFallback({ error, reload }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <div className="ed-error-fallback compact">
      <div className="page-title">{t('errorBoundary.title')}</div>
      <div className="lead" style={{ marginTop: 8 }}>{t('errorBoundary.description')}</div>
      <div className="ed-error-actions" style={{ marginTop: 20 }}>
        <Button className="btn-ink" onClick={reload}>{t('errorBoundary.reload')}</Button>
        <button className="text-link" onClick={() => navigate('/')}>{t('errorBoundary.back')}</button>
      </div>
      {import.meta.env.DEV && error?.stack && (
        <pre className="ed-error-stack">{error.stack}</pre>
      )}
    </div>
  )
}

// Full fallback: whole-page editorial shell when the top-level tree crashes.
function FullFallback({ error, reload }) {
  const { t } = useTranslation()
  return (
    <EditorialShell>
      <div className="ed-error-fallback">
        <h1 className="page-title">{t('errorBoundary.title')}</h1>
        <div className="lead" style={{ marginTop: 8 }}>{t('errorBoundary.description')}</div>
        <div className="ed-error-actions" style={{ marginTop: 24 }}>
          <Button className="btn-ink" onClick={reload}>{t('errorBoundary.reload')}</Button>
        </div>
        {import.meta.env.DEV && error?.stack && (
          <pre className="ed-error-stack">{error.stack}</pre>
        )}
      </div>
    </EditorialShell>
  )
}

class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    // Log only — no remote reporting (YAGNI). Info contains the component stack.
    console.error('ErrorBoundary caught:', error, info)
  }

  reload = () => {
    this.setState({ hasError: false, error: null })
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      const Fallback = this.props.compact ? CompactFallback : FullFallback
      return <Fallback error={this.state.error} reload={this.reload} />
    }
    return this.props.children
  }
}

export default ErrorBoundary
