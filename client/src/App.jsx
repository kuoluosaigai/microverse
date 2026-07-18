import { Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import { useTranslation } from 'react-i18next'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import Dashboard from './pages/Dashboard'
import CreateApp from './pages/CreateApp'
import UploadFiles from './pages/UploadFiles'
import AppLogs from './pages/AppLogs'
import AppMetrics from './pages/AppMetrics'
import Login from './pages/Login'
import ErrorBoundary from './components/ErrorBoundary'
import { AuthProvider, useAuth } from './context/AuthContext'
import { AppConfigProvider } from './context/AppConfigContext'

const theme = {
  token: {
    colorPrimary: '#A8341E',
    colorText: '#1A1714',
    colorTextSecondary: '#6B5F4D',
    colorBorder: '#D8CFBF',
    colorBgContainer: '#FBF7F0',
    borderRadius: 0,
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: 14,
    controlHeight: 38,
    wireframe: false,
  },
  components: {
    Layout: { headerBg: 'transparent', bodyBg: 'transparent' },
    Card: { colorBgContainer: 'transparent' },
    Button: { primaryShadow: 'none', defaultShadow: 'none' },
    Modal: { contentBg: '#FBF7F0', headerBg: '#FBF7F0' },
    Select: { optionSelectedBg: '#EDE6D8' },
    Popconfirm: { colorText: '#1A1714' },
  },
}

function RequireAuth() {
  const { user, checking } = useAuth()
  const { t } = useTranslation()
  if (checking) {
    return <div className="loading-line">{t('common.loading')}</div>
  }
  if (!user) {
    return <Navigate to="/login" replace />
  }
  return <Outlet />
}

function App() {
  const { i18n } = useTranslation()
  const antdLocale = i18n.language === 'zh' ? zhCN : enUS

  return (
    <ConfigProvider locale={antdLocale} theme={theme}>
      <AppConfigProvider>
        <AuthProvider>
          <ErrorBoundary>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route element={<RequireAuth />}>
                <Route path="/" element={<ErrorBoundary compact><Dashboard /></ErrorBoundary>} />
                <Route path="/create" element={<ErrorBoundary compact><CreateApp /></ErrorBoundary>} />
                <Route path="/apps/:id/upload" element={<ErrorBoundary compact><UploadFiles /></ErrorBoundary>} />
                <Route path="/apps/:id/logs" element={<ErrorBoundary compact><AppLogs /></ErrorBoundary>} />
                <Route path="/apps/:id/metrics" element={<ErrorBoundary compact><AppMetrics /></ErrorBoundary>} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </ErrorBoundary>
        </AuthProvider>
      </AppConfigProvider>
    </ConfigProvider>
  )
}

export default App
