import { Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import Dashboard from './pages/Dashboard'
import CreateApp from './pages/CreateApp'

function App() {
  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: '#1890ff',
        },
      }}
    >
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/create" element={<CreateApp />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ConfigProvider>
  )
}

export default App
