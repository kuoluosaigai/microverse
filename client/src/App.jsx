import { Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import { useTranslation } from 'react-i18next'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import Dashboard from './pages/Dashboard'
import CreateApp from './pages/CreateApp'
import UploadFiles from './pages/UploadFiles'

function App() {
  const { i18n } = useTranslation()
  const antdLocale = i18n.language === 'zh' ? zhCN : enUS

  return (
    <ConfigProvider
      locale={antdLocale}
      theme={{
        token: {
          colorPrimary: '#1890ff',
        },
      }}
    >
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/create" element={<CreateApp />} />
        <Route path="/apps/:id/upload" element={<UploadFiles />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ConfigProvider>
  )
}

export default App
