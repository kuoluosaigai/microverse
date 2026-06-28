import { useTranslation } from 'react-i18next'

function LanguageSwitcher() {
  const { i18n } = useTranslation()
  const current = i18n.language && i18n.language.startsWith('zh') ? 'zh' : 'en'

  return (
    <div className="lang-toggle">
      <button
        type="button"
        className={current === 'en' ? 'active' : ''}
        onClick={() => i18n.changeLanguage('en')}
      >
        EN
      </button>
      <span className="sep">/</span>
      <button
        type="button"
        className={current === 'zh' ? 'active' : ''}
        onClick={() => i18n.changeLanguage('zh')}
      >
        中
      </button>
    </div>
  )
}

export default LanguageSwitcher
