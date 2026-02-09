# Frontend Component Guidelines

> Component patterns and conventions for React components

---

## Component Structure

### Standard Component Template

```jsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, message } from 'antd'
import { IconName } from '@ant-design/icons'

function ComponentName({ prop1, prop2 }) {
  const { t } = useTranslation()
  const [state, setState] = useState(initialValue)

  const handleAction = async () => {
    try {
      // Action logic
      message.success(t('messages.success'))
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('messages.error'))
    }
  }

  return (
    <div>
      {/* Component JSX */}
    </div>
  )
}

export default ComponentName
```

---

## Internationalization (i18n)

### Using Translation Hook

```jsx
import { useTranslation } from 'react-i18next'

function MyComponent() {
  const { t } = useTranslation()

  return (
    <div>
      <h1>{t('page.title')}</h1>
      <Button>{t('common.submit')}</Button>
    </div>
  )
}
```

### Translation Keys Structure

```
common.*           - Shared text (buttons, actions)
dashboard.*        - Dashboard-specific
createApp.*        - Create app page
uploadFiles.*      - Upload page
appCard.*          - App card component
messages.*         - Toast messages
```

### Always Translate

- ✅ Page titles and headers
- ✅ Button labels
- ✅ Form labels and placeholders
- ✅ Validation messages
- ✅ Success/error messages
- ✅ Tooltips and hints
- ❌ Technical terms (API, JSON, etc.) - keep in English

---

## Ant Design Components

### Common Patterns

**Modal with Loading State**:
```jsx
const [modalVisible, setModalVisible] = useState(false)
const [loading, setLoading] = useState(false)

<Modal
  title={t('modal.title')}
  open={modalVisible}
  onCancel={() => setModalVisible(false)}
  footer={null}
>
  {loading ? (
    <Spin />
  ) : (
    <Content />
  )}
</Modal>
```

**Form with Validation**:
```jsx
const [form] = Form.useForm()

<Form
  form={form}
  onFinish={handleSubmit}
  layout="vertical"
>
  <Form.Item
    name="fieldName"
    label={t('form.label')}
    rules={[
      { required: true, message: t('form.required') },
      { pattern: /regex/, message: t('form.pattern') }
    ]}
  >
    <Input placeholder={t('form.placeholder')} />
  </Form.Item>
</Form>
```

**Message Notifications**:
```jsx
import { message } from 'antd'

// Success
message.success(t('messages.success'))

// Error (with fallback)
message.error(error.response?.data?.error?.message || t('messages.error'))

// Warning
message.warning(t('messages.warning'))
```

---

## API Integration

### Standard API Call Pattern

```jsx
import { useState } from 'react'
import { message } from 'antd'
import { apiFunction } from '../api/apps'

function MyComponent() {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState(null)

  const fetchData = async () => {
    try {
      setLoading(true)
      const result = await apiFunction()
      setData(result)
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('messages.error'))
    } finally {
      setLoading(false)
    }
  }

  return (
    // Component JSX
  )
}
```

---

## File Upload Components

### Using Ant Design Upload

```jsx
import { Upload, message } from 'antd'
import { InboxOutlined } from '@ant-design/icons'

const { Dragger } = Upload

function UploadComponent() {
  const [fileList, setFileList] = useState([])

  const uploadProps = {
    multiple: true,
    fileList,
    beforeUpload: (file) => {
      // Add to list without uploading
      setFileList(prev => [...prev, file])
      return false // Prevent auto-upload
    },
    onRemove: (file) => {
      setFileList(prev => prev.filter(f => f.uid !== file.uid))
    }
  }

  return (
    <Dragger {...uploadProps}>
      <p className="ant-upload-drag-icon">
        <InboxOutlined />
      </p>
      <p className="ant-upload-text">{t('upload.hint')}</p>
    </Dragger>
  )
}
```

---

## Navigation

### Using React Router

```jsx
import { useNavigate } from 'react-router-dom'

function MyComponent() {
  const navigate = useNavigate()

  const handleAction = () => {
    // Navigate to another page
    navigate('/path')

    // Navigate back
    navigate(-1)

    // Navigate with state
    navigate('/path', { state: { data } })
  }
}
```

---

## State Management

### Local State (useState)

Use for component-specific state:
- Form inputs
- Modal visibility
- Loading states
- UI toggles

```jsx
const [value, setValue] = useState(initialValue)
```

### Props

Pass data and callbacks to child components:

```jsx
<ChildComponent
  data={data}
  onAction={handleAction}
/>
```

---

## Common Patterns

### Conditional Rendering

```jsx
{isLoading ? (
  <Spin />
) : data.length === 0 ? (
  <EmptyState />
) : (
  <DataList data={data} />
)}
```

### Dropdown Menu

```jsx
import { Dropdown } from 'antd'

const menuItems = [
  {
    key: 'action1',
    label: t('menu.action1'),
    icon: <Icon />,
    onClick: handleAction1
  }
]

<Dropdown menu={{ items: menuItems }} trigger={['click']}>
  <Button icon={<MoreOutlined />}>
    {t('common.more')}
  </Button>
</Dropdown>
```

### Clickable Elements with Hover

```jsx
<Text
  code
  style={{
    cursor: 'pointer',
    color: '#1890ff',
    transition: 'all 0.3s'
  }}
  onClick={handleClick}
  onMouseEnter={(e) => {
    e.currentTarget.style.textDecoration = 'underline'
    e.currentTarget.style.color = '#40a9ff'
  }}
  onMouseLeave={(e) => {
    e.currentTarget.style.textDecoration = 'none'
    e.currentTarget.style.color = '#1890ff'
  }}
>
  Clickable Text
</Text>
```

---

## Best Practices

### DO ✅

- Always use `useTranslation()` for text
- Handle loading and error states
- Provide user feedback (messages, spinners)
- Use Ant Design components consistently
- Follow existing component patterns
- Add PropTypes or JSDoc for complex props

### DON'T ❌

- Hardcode text strings (use i18n)
- Forget error handling
- Leave console.log in production code
- Mix styling approaches (prefer Ant Design styles)
- Create duplicate components (reuse existing)
- Forget to cleanup event listeners in useEffect

---

## File Organization

```
client/src/
├── pages/              # Page components (routes)
│   ├── Dashboard.jsx
│   ├── CreateApp.jsx
│   └── UploadFiles.jsx
├── components/         # Reusable components
│   ├── AppCard.jsx
│   └── LanguageSwitcher.jsx
├── api/               # API client functions
│   └── apps.js
├── i18n/              # Internationalization
│   ├── index.js
│   └── locales/
│       ├── zh.json
│       └── en.json
└── styles/            # Global styles
```

---

## Testing Checklist

Before committing:

- [ ] Component renders without errors
- [ ] All translations work (switch language)
- [ ] Loading states display correctly
- [ ] Error messages show properly
- [ ] Forms validate correctly
- [ ] API calls handle errors gracefully
- [ ] Responsive on different screen sizes
- [ ] No console errors in browser
