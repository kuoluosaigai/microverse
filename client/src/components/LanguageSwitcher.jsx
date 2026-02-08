import { Dropdown } from 'antd'
import { GlobalOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

function LanguageSwitcher() {
  const { i18n } = useTranslation()

  const languages = [
    { key: 'zh', label: '中文', icon: '🇨🇳' },
    { key: 'en', label: 'English', icon: '🇺🇸' }
  ]

  const currentLanguage = languages.find(lang => lang.key === i18n.language) || languages[1]

  const handleLanguageChange = ({ key }) => {
    i18n.changeLanguage(key)
  }

  const items = languages.map(lang => ({
    key: lang.key,
    label: (
      <span>
        <span style={{ marginRight: 8 }}>{lang.icon}</span>
        {lang.label}
      </span>
    )
  }))

  return (
    <Dropdown
      menu={{ items, onClick: handleLanguageChange, selectedKeys: [currentLanguage.key] }}
      trigger={['click']}
    >
      <div
        style={{
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          padding: '4px 12px',
          borderRadius: '4px',
          transition: 'background-color 0.3s'
        }}
        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f0f0f0'}
        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
      >
        <GlobalOutlined style={{ fontSize: 16, marginRight: 8 }} />
        <span style={{ marginRight: 4 }}>{currentLanguage.icon}</span>
        <span>{currentLanguage.label}</span>
      </div>
    </Dropdown>
  )
}

export default LanguageSwitcher
