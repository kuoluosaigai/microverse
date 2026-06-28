# Editorial UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the default Antd template UI of the Microverse client with a deliberate editorial aesthetic (warm paper, serif display, mono small-caps meta, numbered rows, single deep-red accent) across Dashboard, CreateApp, UploadFiles, and the shared shell — without changing any feature behavior.

**Architecture:** Hybrid — keep Antd 5 for Modal/Popconfirm/Upload/Select/Form internals but neutralize its default look via `ConfigProvider` token overrides + a global CSS layer. Build two custom components (`EditorialShell`, `AppRow`) for the signature editorial surfaces and replace `AppCard`. Palette and type live as CSS variables in `index.css`; component classes live in `editorial.css`.

**Tech Stack:** React 18, Vite 5, Antd 5 (`ConfigProvider` theme tokens), react-i18next, react-router-dom 6. No new dependencies.

## Global Constraints

- **No backend or API changes.** `client/src/api/apps.js` is untouched.
- **No new dependencies.** Use only what's in `client/package.json` (antd, @ant-design/icons, react, react-router-dom, react-i18next).
- **Accent is a single CSS variable** `--accent: #A8341E` (defined once in `index.css`); Antd `colorPrimary` token also `#A8341E`.
- **Palette tokens** (verbatim from spec): `--paper #F4EFE6`, `--surface #FBF7F0`, `--ink #1A1714`, `--ink-2 #6B5F4D`, `--ink-3 #8A7E6B`, `--rule #D8CFBF`, `--accent #A8341E`, `--idle #A89C88`, `--paper-hover #EDE6D8`.
- **Type:** serif = `Georgia, 'Times New Roman', serif`; mono = `ui-monospace, 'SF Mono', Menlo, Consolas, monospace`.
- **Feature parity required:** list / create / delete / start / stop / upload (+ZIP) / view directory / port-click-open / i18n zh-en / refresh must all still work after the redesign.
- **Lint gate:** `cd client && npm run lint` must pass with `--max-warnings 0` after every task.
- **No `AppCard.jsx` left dangling** — it is deleted in Task 6 once `AppRow` replaces it.
- **Commit after every task.**

### Verification approach (read this)

There is no unit-test framework in this project and the spec scopes to "only reskin" — introducing one is out of scope (YAGNI). Each task's test cycle is therefore:

1. `cd client && npm run lint` — must exit 0, zero warnings.
2. `cd client && npm run dev` (run in background) — open the printed Vite URL and click through the task's deliverable.
3. Commit only after both pass.

For run-through steps that need backend data, start the server too: `npm run dev:server` from the repo root.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `client/src/styles/index.css` | CSS variables (palette/type), base reset, Antd CSS neutralization overrides | Rewrite |
| `client/src/styles/editorial.css` | Editorial component classes (shell, topbar, wordmark, nav, app-row, fields, buttons, dropzone, note, lang-toggle) | Create |
| `client/src/main.jsx` | Import `editorial.css` after `index.css` | Modify (1 line) |
| `client/src/App.jsx` | `ConfigProvider` theme tokens (accent, radius, fonts, surfaces) | Modify |
| `client/src/components/EditorialShell.jsx` | Shared centered shell: wordmark + nav + page column | Create |
| `client/src/components/LanguageSwitcher.jsx` | `EN / 中` mono toggle (replaces flag dropdown) | Rewrite |
| `client/src/components/AppRow.jsx` | Numbered app row + directory Modal + port-click + Popconfirm delete (replaces AppCard) | Create |
| `client/src/components/AppCard.jsx` | (removed — superseded by AppRow) | Delete (Task 6) |
| `client/src/pages/Dashboard.jsx` | Use shell; render AppRow list; empty/loading states | Rewrite |
| `client/src/pages/CreateApp.jsx` | Use shell; restyle form (underline fields, hairline select, ink submit) | Rewrite |
| `client/src/pages/UploadFiles.jsx` | Use shell; restyle dragger + file list + tip note | Rewrite |
| `client/src/i18n/locales/en.json` | Copy: status `Live`/`Idle`, lead, emptyCta, loading | Modify |
| `client/src/i18n/locales/zh.json` | Copy: 运行中/已停止, lead, emptyCta, loading | Modify |

---

## Task 1: Global styles — palette, base, Antd neutralization

**Files:**
- Rewrite: `client/src/styles/index.css`
- Create: `client/src/styles/editorial.css`
- Modify: `client/src/main.jsx`

**Interfaces:**
- Produces: CSS variables `--paper --surface --ink --ink-2 --ink-3 --rule --accent --idle --paper-hover` on `:root`; editorial classes consumed by later tasks: `.shell .shell-inner .topbar .wordmark .nav .nav-link(.accent) .page .lead .app-list .app-row(.num/.name/.sub/.port/.lbl/.port-chip/.kind/.status.live/.status.idle/.acts/.act) .text-link(.accent) .field-wrap .field-label .ant-input(underline) .btn-ink .empty .loading-line .dropzone(.dz-text/.dz-hint) .note .file-list .file-row(.num/.ext/.fname) .lang-toggle(.sep) .ed-form .page-title .back-link`

- [ ] **Step 1: Rewrite `client/src/styles/index.css`**

```css
/* ===== Microverse — Editorial base ===== */

:root {
  --paper: #F4EFE6;
  --surface: #FBF7F0;
  --ink: #1A1714;
  --ink-2: #6B5F4D;
  --ink-3: #8A7E6B;
  --rule: #D8CFBF;
  --accent: #A8341E;
  --idle: #A89C88;
  --paper-hover: #EDE6D8;

  --serif: Georgia, 'Times New Roman', serif;
  --mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

html, body, #root { min-height: 100vh; }

body {
  background: var(--paper);
  color: var(--ink);
  font-family: var(--serif);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

::selection { background: var(--accent); color: var(--paper); }

/* ===== Antd neutralization (token layer can't do these) ===== */

/* Transparent cards / layouts so paper shows through */
.ant-card,
.ant-card-body,
.ant-layout,
.ant-layout-content { background: transparent !important; }

/* Tags -> italic status words (kept for any stray usage) */
.ant-tag { background: transparent !important; border: none !important;
  font-family: var(--serif); font-style: italic; font-size: 13px; padding: 0; }

/* Inputs: underline field, no chunky box */
.ant-input, .ant-input-affix-wrapper {
  background: transparent !important;
  border: none !important;
  border-bottom: 1px solid var(--rule) !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  padding: 6px 0 !important;
  font-family: var(--serif) !important;
  color: var(--ink) !important;
}
.ant-input:focus, .ant-input-focused,
.ant-input-affix-wrapper:focus, .ant-input-affix-wrapper-focused {
  border-bottom-color: var(--ink) !important;
  box-shadow: none !important;
}

/* Select: hairline underline */
.ant-select .ant-select-selector {
  background: transparent !important;
  border: none !important;
  border-bottom: 1px solid var(--rule) !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  font-family: var(--serif) !important;
}
.ant-select-focused .ant-select-selector { border-bottom-color: var(--ink) !important; }
.ant-select-dropdown { font-family: var(--serif) !important; }

/* Form labels: mono small-caps */
.ed-form .ant-form-item-label > label {
  font-family: var(--mono) !important;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 10.5px !important;
  color: var(--ink-3) !important;
}
.ed-form .ant-form-item { margin-bottom: 26px; }

/* Modal: paper surface */
.ant-modal-content {
  background: var(--surface) !important;
  border: 1px solid var(--rule);
  border-radius: 0 !important;
  font-family: var(--serif) !important;
}
.ant-modal-header { background: transparent !important; }
.ant-modal-title { font-family: var(--serif) !important; font-weight: 600 !important; }

/* Popconfirm / popover: paper */
.ant-popover-inner { background: var(--surface) !important; border: 1px solid var(--rule); border-radius: 0; }

/* Message: paper */
.ant-message-notice-content { background: var(--ink) !important; color: var(--paper) !important;
  border-radius: 0 !important; font-family: var(--mono); letter-spacing: 0.04em; }
.ant-message-notice-content .anticon { color: var(--paper) !important; }

/* Dragger: dashed paper frame (base; .dropzone adds layout) */
.ant-upload.ant-upload-drag .ant-upload-drag-container,
.ant-upload-drag {
  background: transparent !important;
  border: 1.5px dashed var(--rule) !important;
  border-radius: 0 !important;
}
.ant-upload.ant-upload-drag .ant-upload-btn { padding: 40px 20px !important; }
.ant-upload.ant-upload-drag:hover { border-color: var(--ink) !important; }
```

- [ ] **Step 2: Create `client/src/styles/editorial.css`**

```css
/* ===== Microverse — Editorial components ===== */

.shell { min-height: 100vh; background: var(--paper); }
.shell-inner { max-width: 1100px; margin: 0 auto; padding: 0 32px; }

.topbar {
  display: flex; align-items: baseline; justify-content: space-between;
  padding: 26px 0 18px; border-bottom: 1.5px solid var(--ink);
}
.wordmark {
  font-family: var(--serif); font-size: 30px; font-weight: 700;
  letter-spacing: -0.02em; line-height: 1; color: var(--ink);
  text-decoration: none; cursor: pointer;
}
.wordmark em { color: var(--accent); font-style: italic; font-weight: 400; }

.nav { display: flex; align-items: baseline; gap: 26px; }
.nav-link {
  font-family: var(--mono); font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.14em; color: var(--ink); background: none; border: none;
  border-bottom: 1px solid transparent; padding: 0 0 2px; cursor: pointer;
  transition: border-color .15s, color .15s;
}
.nav-link:hover { border-bottom-color: var(--ink); }
.nav-link.accent { color: var(--accent); }
.nav-link.accent:hover { border-bottom-color: var(--accent); }
.nav-link:disabled { color: var(--ink-3); cursor: default; border-bottom-color: transparent; }

.page { padding: 26px 0 80px; }

.page-title { font-family: var(--serif); font-size: 30px; font-weight: 700;
  letter-spacing: -0.02em; margin: 18px 0 4px; }
.back-link {
  font-family: var(--mono); font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.12em; color: var(--ink-2); background: none; border: none;
  cursor: pointer; padding: 0; margin-top: 6px;
}
.back-link:hover { color: var(--accent); }

.lead { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase;
  letter-spacing: 0.16em; color: var(--ink-3); margin: 18px 0 4px; }

/* ----- App list / rows ----- */
.app-list { list-style: none; }
.app-row {
  display: grid;
  grid-template-columns: 40px minmax(180px,1fr) 140px 150px 80px 1fr;
  align-items: center; gap: 18px;
  padding: 22px 8px; border-bottom: 1px solid var(--rule);
  transition: background .15s;
}
.app-row:hover { background: var(--paper-hover); }
.app-row .num { font-family: var(--mono); font-size: 12px; color: var(--accent); }
.app-row .name { font-family: var(--serif); font-size: 22px; font-weight: 400;
  letter-spacing: -0.01em; color: var(--ink); }
.app-row .sub { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase;
  letter-spacing: 0.1em; color: var(--ink-3); margin-top: 4px; }
.app-row .port { font-family: var(--mono); font-size: 13px; color: var(--ink); }
.app-row .port .lbl { color: var(--ink-3); margin-right: 8px; font-size: 10.5px;
  text-transform: uppercase; letter-spacing: 0.1em; }
.port-chip { font-family: var(--mono); font-size: 12px; color: var(--accent);
  border: 1px solid var(--rule); border-radius: 3px; padding: 2px 8px; cursor: pointer;
  transition: background .15s; }
.port-chip:hover { background: var(--surface); }
.app-row .kind { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase;
  letter-spacing: 0.12em; color: var(--ink-3); }
.app-row .status { font-family: var(--serif); font-size: 13px; font-style: italic; }
.app-row .status.live { color: var(--accent); }
.app-row .status.idle { color: var(--idle); }
.app-row .acts { display: flex; gap: 18px; justify-content: flex-end; }
.act {
  font-family: var(--mono); font-size: 10.5px; text-transform: uppercase;
  letter-spacing: 0.08em; color: var(--ink-2); background: none; border: none;
  border-bottom: 1px solid transparent; padding: 0 0 1px; cursor: pointer;
  transition: color .15s, border-color .15s;
}
.act:hover { color: var(--accent); border-bottom-color: var(--accent); }
.act:disabled { color: var(--rule); cursor: not-allowed; }

/* ----- Text links / buttons ----- */
.text-link {
  font-family: var(--mono); font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.1em; color: var(--ink); background: none; border: none;
  border-bottom: 1px solid transparent; padding: 0 0 2px; cursor: pointer;
  transition: border-color .15s, color .15s;
}
.text-link:hover { border-bottom-color: var(--ink); }
.text-link.accent { color: var(--accent); }
.text-link.accent:hover { border-bottom-color: var(--accent); }

.btn-ink.ant-btn, button.btn-ink {
  background: var(--ink) !important; color: var(--paper) !important;
  border: none !important; border-radius: 0 !important;
  font-family: var(--mono) !important; font-size: 11px !important;
  text-transform: uppercase; letter-spacing: 0.1em; height: 40px; padding: 0 22px;
  cursor: pointer; box-shadow: none !important;
}
.btn-ink.ant-btn:hover { opacity: 0.85; }
.btn-ink.ant-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* ----- Empty / loading ----- */
.empty { text-align: center; padding: 120px 0; }
.empty h2 { font-family: var(--serif); font-size: 22px; font-weight: 400; color: var(--ink-2); }
.empty p { font-family: var(--mono); font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.1em; color: var(--ink-3); margin-top: 10px; }
.loading-line { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase;
  letter-spacing: 0.16em; color: var(--ink-3); padding: 80px 0; text-align: center; }

/* ----- Forms ----- */
.field-wrap { margin-bottom: 26px; }
.field-label { display: block; font-family: var(--mono); font-size: 10.5px;
  text-transform: uppercase; letter-spacing: 0.12em; color: var(--ink-3); margin-bottom: 6px; }

/* ----- Upload ----- */
.dropzone { text-align: center; }
.dropzone .dz-text { font-family: var(--serif); font-size: 16px; color: var(--ink-2); }
.dropzone .dz-hint { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase;
  letter-spacing: 0.1em; color: var(--ink-3); margin-top: 8px; }
.file-list { list-style: none; margin-top: 22px; }
.file-row {
  display: grid; grid-template-columns: 30px 70px 1fr; align-items: center; gap: 16px;
  padding: 12px 8px; border-bottom: 1px solid var(--rule);
}
.file-row .num { font-family: var(--mono); font-size: 11px; color: var(--accent); }
.file-row .ext { font-family: var(--mono); font-size: 10px; text-transform: uppercase;
  color: var(--ink-3); border: 1px solid var(--rule); border-radius: 3px; padding: 1px 7px;
  text-align: center; }
.file-row .fname { font-family: var(--serif); font-size: 15px; color: var(--ink); }

.note { border: 1px solid var(--rule); background: var(--surface); padding: 18px 22px; margin-top: 26px; }
.note h4 { font-family: var(--serif); font-size: 15px; font-weight: 600; margin-bottom: 6px; }
.note p { font-family: var(--serif); font-size: 14px; color: var(--ink-2); line-height: 1.6; }

/* ----- Language toggle ----- */
.lang-toggle { font-family: var(--mono); font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.08em; display: flex; align-items: baseline; gap: 6px; }
.lang-toggle button { background: none; border: none; border-bottom: 1px solid transparent;
  padding: 0 0 2px; cursor: pointer; font-family: inherit; font-size: inherit;
  letter-spacing: inherit; text-transform: inherit; color: var(--ink-2);
  transition: color .15s, border-color .15s; }
.lang-toggle button.active { color: var(--accent); border-bottom-color: var(--accent); }
.lang-toggle .sep { color: var(--ink-3); }

/* ----- Responsive: collapse the row on small screens ----- */
@media (max-width: 760px) {
  .app-row { grid-template-columns: 30px 1fr; row-gap: 10px; }
  .app-row .port, .app-row .kind, .app-row .status { grid-column: 2; }
  .app-row .acts { grid-column: 1 / -1; justify-content: flex-start; flex-wrap: wrap; }
}
```

- [ ] **Step 3: Wire `editorial.css` into `client/src/main.jsx`**

Add the import directly below the existing `index.css` import (line 5):

```jsx
import './styles/index.css'
import './styles/editorial.css'
```

(Full file for clarity:)

```jsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import './styles/index.css'
import './styles/editorial.css'
import './i18n'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
```

- [ ] **Step 4: Lint + run-through**

Run: `cd client && npm run lint`
Expected: exit 0, no warnings.

Run: `cd client && npm run dev` (background), open the Vite URL.
Expected: page background is warm paper (`#F4EFE6`), Antd default blue is gone from any visible control, text is serif. (Components still use old layout until later tasks — that's fine; we're only verifying the global layer here.)

- [ ] **Step 5: Commit**

```bash
git add client/src/styles/index.css client/src/styles/editorial.css client/src/main.jsx
git commit -m "feat(ui): editorial global styles — palette, type, antd neutralization"
```

---

## Task 2: Antd theme tokens via ConfigProvider

**Files:**
- Modify: `client/src/App.jsx`

**Interfaces:**
- Produces: an Antd `ConfigProvider` theme where `colorPrimary = #A8341E`, `borderRadius = 0`, `fontFamily = serif`, surfaces neutralized. Consumed by all Antd components used in later tasks (Button, Modal, Popconfirm, Select, Form, Upload, Message).

- [ ] **Step 1: Replace `client/src/App.jsx`**

```jsx
import { Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import { useTranslation } from 'react-i18next'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import Dashboard from './pages/Dashboard'
import CreateApp from './pages/CreateApp'
import UploadFiles from './pages/UploadFiles'

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

function App() {
  const { i18n } = useTranslation()
  const antdLocale = i18n.language === 'zh' ? zhCN : enUS

  return (
    <ConfigProvider locale={antdLocale} theme={theme}>
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
```

- [ ] **Step 2: Lint + run-through**

Run: `cd client && npm run lint` → exit 0.
Run dev: open a Modal-triggering flow if possible (e.g. dashboard "view directory" once Task 5 exists). For now verify the app still boots with no console errors and Antd controls (e.g. the create-page select, once Task 7 is done) render in serif with red focus — exact check deferred to later tasks; here just confirm no regression: app loads, routes work.

- [ ] **Step 3: Commit**

```bash
git add client/src/App.jsx
git commit -m "feat(ui): antd ConfigProvider tokens — accent red, zero radius, serif"
```

---

## Task 3: EditorialShell component

**Files:**
- Create: `client/src/components/EditorialShell.jsx`

**Interfaces:**
- Consumes: `react-router-dom` `useNavigate`; `LanguageSwitcher` (Task 4).
- Produces: default export `EditorialShell({ right, children })` — renders `.shell > .shell-inner > header.topbar (a.wordmark + nav.nav={right ?? <LanguageSwitcher/>}) + main.page={children}`. Clicking the wordmark navigates to `/`.

- [ ] **Step 1: Create `client/src/components/EditorialShell.jsx`**

```jsx
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
```

- [ ] **Step 2: Lint**

Run: `cd client && npm run lint` → exit 0.
(Note: `LanguageSwitcher` still exists with its old implementation from Task 4's perspective; it is rewritten in the next task. The import resolves either way.)

- [ ] **Step 3: Commit**

```bash
git add client/src/components/EditorialShell.jsx
git commit -m "feat(ui): EditorialShell — shared wordmark + nav + page column"
```

---

## Task 4: LanguageSwitcher as `EN / 中` toggle

**Files:**
- Rewrite: `client/src/components/LanguageSwitcher.jsx`

**Interfaces:**
- Consumes: `react-i18next` `useTranslation` (`i18n.changeLanguage`, `i18n.language`).
- Produces: default export `LanguageSwitcher()` rendering `.lang-toggle` with two `<button>`s (`EN`, `中`) and a `.sep` `/`; active button gets class `active`.

- [ ] **Step 1: Rewrite `client/src/components/LanguageSwitcher.jsx`**

```jsx
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
```

- [ ] **Step 2: Lint + run-through**

Run: `cd client && npm run lint` → exit 0.
Run dev: open the app. The header right shows `EN / 中`; clicking `中` switches all copy to Chinese, `EN` back to English; the active side is red + underlined.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/LanguageSwitcher.jsx
git commit -m "feat(ui): LanguageSwitcher as EN/中 mono toggle"
```

---

## Task 5: AppRow component (replaces AppCard)

**Files:**
- Create: `client/src/components/AppRow.jsx`
- Modify: `client/src/i18n/locales/en.json` (status copy)
- Modify: `client/src/i18n/locales/zh.json` (status copy)

**Interfaces:**
- Consumes: `react-router-dom` `useNavigate`; `react-i18next` `useTranslation`; `getAppFiles` from `../api/apps`; Antd `Popconfirm`, `Modal`, `Spin`.
- Produces: default export `AppRow({ app, index, onStart, onStop, onDelete })`. Renders an `<li class="app-row">` with columns: num (01-padded `index`), name+sub(type label), port (lbl + chip-or-plain), kind (`app.deploy_type`), status (Live/Idle via i18n), acts (Start/Stop, View Directory, Upload, Delete-with-Popconfirm). Plus a restyled directory `Modal`.

- [ ] **Step 1: Update status copy in `client/src/i18n/locales/en.json`**

In the `appCard.status` object, replace:

```json
    "status": {
      "running": "Live",
      "stopped": "Idle"
    },
```

- [ ] **Step 2: Update status copy in `client/src/i18n/locales/zh.json`**

```json
    "status": {
      "running": "运行中",
      "stopped": "已停止"
    },
```

- [ ] **Step 3: Create `client/src/components/AppRow.jsx`**

```jsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal, Spin, Popconfirm } from 'antd'
import { FolderFilled, FileOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { getAppFiles } from '../api/apps'

function AppRow({ app, index, onStart, onStop, onDelete }) {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const isRunning = app.status === 'running'

  const [dirOpen, setDirOpen] = useState(false)
  const [files, setFiles] = useState([])
  const [loadingDir, setLoadingDir] = useState(false)

  const openDir = async () => {
    setDirOpen(true)
    setLoadingDir(true)
    try {
      setFiles(await getAppFiles(app.id))
    } catch {
      setFiles([])
    } finally {
      setLoadingDir(false)
    }
  }

  const openPort = () => {
    if (app.port && isRunning) {
      window.open(`http://localhost:${app.port}`, '_blank', 'noopener,noreferrer')
    }
  }

  const typeLabel = t(`appCard.deployTypes.${app.deploy_type}`) || app.deploy_type

  return (
    <>
      <li className="app-row">
        <div className="num">{String(index).padStart(2, '0')}</div>
        <div>
          <div className="name">{app.name}</div>
          <div className="sub">{typeLabel}</div>
        </div>
        <div className="port">
          {app.port ? (
            <>
              <span className="lbl">Port</span>
              {isRunning ? (
                <span
                  className="port-chip"
                  onClick={openPort}
                  title={t('appCard.clickToOpen')}
                >
                  {app.port} ↗
                </span>
              ) : (
                <span>{app.port}</span>
              )}
            </>
          ) : (
            <span className="lbl">—</span>
          )}
        </div>
        <div className="kind">{app.deploy_type}</div>
        <div className={`status ${isRunning ? 'live' : 'idle'}`}>
          {t(`appCard.status.${app.status}`)}
        </div>
        <div className="acts">
          {isRunning ? (
            <button className="act" onClick={() => onStop(app.id)}>
              {t('appCard.stop')}
            </button>
          ) : (
            <button className="act" onClick={() => onStart(app.id)}>
              {t('appCard.start')}
            </button>
          )}
          <button className="act" onClick={openDir}>
            {t('appCard.viewDirectory')}
          </button>
          <button
            className="act"
            onClick={() => navigate(`/apps/${app.id}/upload`)}
          >
            {t('appCard.upload')}
          </button>
          <Popconfirm
            title={t('appCard.deleteTitle')}
            description={t('appCard.deleteConfirm')}
            onConfirm={() => onDelete(app.id)}
            okText={t('common.yes')}
            cancelText={t('common.no')}
            disabled={isRunning}
          >
            <button className="act" disabled={isRunning}>
              {t('appCard.delete')}
            </button>
          </Popconfirm>
        </div>
      </li>

      <Modal
        title={t('appCard.directoryTitle')}
        open={dirOpen}
        onCancel={() => setDirOpen(false)}
        footer={null}
        width={560}
      >
        {loadingDir ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Spin />
          </div>
        ) : files.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <div className="loading-line">{t('appCard.directoryEmpty')}</div>
          </div>
        ) : (
          <ul className="file-list">
            {files.map((f, i) => (
              <li className="file-row" key={f.name}>
                <div className="num">{String(i + 1).padStart(2, '0')}</div>
                <div className="ext">
                  {f.type === 'directory' ? 'DIR' : (f.name.split('.').pop() || 'FILE').toUpperCase()}
                </div>
                <div className="fname">
                  {f.type === 'directory' ? (
                    <FolderFilled style={{ color: 'var(--ink-3)', marginRight: 8 }} />
                  ) : (
                    <FileOutlined style={{ color: 'var(--ink-3)', marginRight: 8 }} />
                  )}
                  {f.name}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </>
  )
}

export default AppRow
```

- [ ] **Step 4: Lint + run-through**

Run: `cd client && npm run lint` → exit 0.
(`AppRow` is not yet rendered until Task 6 — that's fine; lint confirms it compiles. Do not wire it into Dashboard yet.)

- [ ] **Step 5: Commit**

```bash
git add client/src/components/AppRow.jsx client/src/i18n/locales/en.json client/src/i18n/locales/zh.json
git commit -m "feat(ui): AppRow component (replaces AppCard) + Live/Idle copy"
```

---

## Task 6: Dashboard restyle + delete AppCard

**Files:**
- Rewrite: `client/src/pages/Dashboard.jsx`
- Modify: `client/src/i18n/locales/en.json` (add lead/emptyCta/loading)
- Modify: `client/src/i18n/locales/zh.json` (add lead/emptyCta/loading)
- Delete: `client/src/components/AppCard.jsx`

**Interfaces:**
- Consumes: `EditorialShell`, `AppRow`, `LanguageSwitcher`, API `getAllApps/deleteApp/startApp/stopApp`, `useTranslation`, `useNavigate`.
- Produces: a Dashboard that renders `EditorialShell` with a right-nav of (Refresh, + New app, LanguageSwitcher), a `.lead` line, and either a loading line, an empty state with a CTA, or a `<ul class="app-list">` of `AppRow`s.

- [ ] **Step 1: Add dashboard copy to `client/src/i18n/locales/en.json`**

Replace the `dashboard` block with:

```json
  "dashboard": {
    "title": "Applications Dashboard",
    "createApp": "New app",
    "refreshApps": "Refresh",
    "lead": "Deployed applications — {{count}}",
    "runningSuffix": "· {{count}} running",
    "noApps": "No applications yet",
    "noAppsDesc": "Create your first application to deploy and manage it here.",
    "emptyCta": "Create your first app →",
    "loading": "Loading…"
  },
```

- [ ] **Step 2: Add dashboard copy to `client/src/i18n/locales/zh.json`**

```json
  "dashboard": {
    "title": "应用仪表板",
    "createApp": "新建应用",
    "refreshApps": "刷新",
    "lead": "已部署应用 — {{count}}",
    "runningSuffix": "· {{count}} 个运行中",
    "noApps": "暂无应用",
    "noAppsDesc": "创建你的第一个应用，在此部署与管理。",
    "emptyCta": "创建第一个应用 →",
    "loading": "加载中…"
  },
```

- [ ] **Step 3: Rewrite `client/src/pages/Dashboard.jsx`**

```jsx
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { message } from 'antd'
import { useTranslation } from 'react-i18next'
import EditorialShell from '../components/EditorialShell'
import AppRow from '../components/AppRow'
import LanguageSwitcher from '../components/LanguageSwitcher'
import { getAllApps, deleteApp, startApp, stopApp } from '../api/apps'

function Dashboard() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [apps, setApps] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadApps = async (showRefreshing = false) => {
    try {
      if (showRefreshing) setRefreshing(true)
      else setLoading(true)
      const data = await getAllApps()
      setApps(data)
    } catch (error) {
      message.error(t('messages.operationFailed'))
      console.error('Error loading apps:', error)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    loadApps()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleStart = async (appId) => {
    try {
      await startApp(appId)
      message.success(t('messages.appStarted'))
      await loadApps(true)
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('messages.operationFailed'))
    }
  }

  const handleStop = async (appId) => {
    try {
      await stopApp(appId)
      message.success(t('messages.appStopped'))
      await loadApps(true)
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('messages.operationFailed'))
    }
  }

  const handleDelete = async (appId) => {
    try {
      await deleteApp(appId)
      message.success(t('messages.appDeleted'))
      await loadApps(true)
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('messages.operationFailed'))
    }
  }

  const runningCount = apps.filter((a) => a.status === 'running').length
  const lead = t('dashboard.lead', { count: apps.length })
  const suffix = runningCount ? ' ' + t('dashboard.runningSuffix', { count: runningCount }) : ''

  const right = (
    <>
      <button
        className="nav-link"
        onClick={() => loadApps(true)}
        disabled={refreshing}
      >
        {t('dashboard.refreshApps')}
      </button>
      <button className="nav-link accent" onClick={() => navigate('/create')}>
        + {t('dashboard.createApp')}
      </button>
      <LanguageSwitcher />
    </>
  )

  return (
    <EditorialShell right={right}>
      {!loading && <div className="lead">{lead}{suffix}</div>}

      {loading ? (
        <div className="loading-line">{t('dashboard.loading')}</div>
      ) : apps.length === 0 ? (
        <div className="empty">
          <h2>{t('dashboard.noApps')}</h2>
          <p>{t('dashboard.noAppsDesc')}</p>
          <button
            className="text-link accent"
            style={{ marginTop: 20 }}
            onClick={() => navigate('/create')}
          >
            {t('dashboard.emptyCta')}
          </button>
        </div>
      ) : (
        <ul className="app-list">
          {apps.map((app, i) => (
            <AppRow
              key={app.id}
              app={app}
              index={i + 1}
              onStart={handleStart}
              onStop={handleStop}
              onDelete={handleDelete}
            />
          ))}
        </ul>
      )}
    </EditorialShell>
  )
}

export default Dashboard
```

- [ ] **Step 4: Delete `client/src/components/AppCard.jsx`**

Run: `git rm client/src/components/AppCard.jsx`

- [ ] **Step 5: Lint + full run-through**

Run: `cd client && npm run lint` → exit 0 (confirms no dangling import of AppCard).
Run: from repo root `npm run dev` (both server + client). Open the client URL.
Expected:
- Header: `Micro`*verse*` wordmark left; `Refresh / + New app / EN·中` right.
- Lead line: `DEPLOYED APPLICATIONS — N · M RUNNING`.
- Each app: numbered row, serif name, mono type sub, port chip (clickable when running — opens `http://localhost:<port>`), `Live`/`Idle` italic status, action links.
- Click Start/Stop → status flips, toast appears.
- Click "View Directory" → paper Modal lists files.
- Click "Upload" → routes to upload page (restyled in Task 8; still functional).
- Click "Delete" on a stopped app → Popconfirm (red OK) → confirms → app removed.
- Empty state (delete all): serif heading + CTA link.
- Language toggle switches all copy.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/Dashboard.jsx client/src/i18n/locales/en.json client/src/i18n/locales/zh.json client/src/components/AppCard.jsx
git commit -m "feat(ui): editorial Dashboard + AppRow list; remove AppCard"
```

---

## Task 7: CreateApp restyle

**Files:**
- Rewrite: `client/src/pages/CreateApp.jsx`

**Interfaces:**
- Consumes: `EditorialShell`, Antd `Form/Input/Select/Button`, `createApp` API, `useTranslation`, `useNavigate`.
- Produces: a CreateApp page using the shell, a back link, serif page title, lead, and a restyled `Form` (className `ed-form`) with underline `Input`, hairline `Select`, and an ink submit `Button` (className `btn-ink`).

- [ ] **Step 1: Rewrite `client/src/pages/CreateApp.jsx`**

```jsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Form, Input, Select, Button, message } from 'antd'
import { useTranslation } from 'react-i18next'
import EditorialShell from '../components/EditorialShell'
import { createApp } from '../api/apps'

const { Option } = Select

function CreateApp() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (values) => {
    try {
      setLoading(true)
      await createApp(values.name, values.deploy_type)
      message.success(t('createApp.successMessage'))
      navigate('/')
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('createApp.errorMessage'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <EditorialShell>
      <button className="back-link" onClick={() => navigate('/')}>
        ← {t('common.back')}
      </button>
      <h1 className="page-title">{t('createApp.title')}</h1>
      <div className="lead">{t('createApp.helpText')}</div>

      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{ deploy_type: 'http-server' }}
        className="ed-form"
        style={{ maxWidth: 520, marginTop: 28 }}
      >
        <Form.Item
          label={t('createApp.appName')}
          name="name"
          rules={[
            { required: true, message: t('createApp.appNameRequired') },
            { pattern: /^[a-zA-Z0-9-_]+$/, message: t('createApp.appNamePattern') },
          ]}
        >
          <Input placeholder={t('createApp.appNamePlaceholder')} />
        </Form.Item>

        <Form.Item
          label={t('createApp.deployType')}
          name="deploy_type"
          rules={[{ required: true, message: t('createApp.deployTypeRequired') }]}
        >
          <Select>
            <Option value="http-server">{t('createApp.staticSite')}</Option>
            <Option value="npm">{t('createApp.nodeApp')}</Option>
            <Option value="nginx" disabled>{t('createApp.nginx')}</Option>
          </Select>
        </Form.Item>

        <Form.Item style={{ marginBottom: 0 }}>
          <Button
            type="primary"
            htmlType="submit"
            className="btn-ink"
            loading={loading}
          >
            {t('createApp.createButton')}
          </Button>
          <button
            type="button"
            className="text-link"
            style={{ marginLeft: 18 }}
            onClick={() => navigate('/')}
          >
            {t('common.cancel')}
          </button>
        </Form.Item>
      </Form>
    </EditorialShell>
  )
}

export default CreateApp
```

- [ ] **Step 2: Lint + run-through**

Run: `cd client && npm run lint` → exit 0.
Run dev: from `/` click `+ New app`.
Expected: serif title, mono back link + lead, underline name input, hairline deploy-type select (http-server default, nginx disabled), ink "Create Application" button + Cancel text-link. Submit with valid name → toast → back to dashboard with the new app. Submit empty → inline validation error. Pattern violation (e.g. `my app`) → pattern error.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/CreateApp.jsx
git commit -m "feat(ui): editorial CreateApp — underline fields, hairline select, ink submit"
```

---

## Task 8: UploadFiles restyle

**Files:**
- Rewrite: `client/src/pages/UploadFiles.jsx`

**Interfaces:**
- Consumes: `EditorialShell`, Antd `Upload/Button/message`, `uploadFiles`/`getAppById` API, `useTranslation`, `useNavigate`/`useParams`.
- Produces: an upload page using the shell, back link, serif title `Upload — {app.name}`, a restyled `Dragger` (className `dropzone`) with serif `.dz-text` + mono `.dz-hint`, a `.file-list` of `.file-row`s (numbered, ext tag, filename), an ink upload `Button`, and a paper `.note` quick-tip for http-server apps.

- [ ] **Step 1: Rewrite `client/src/pages/UploadFiles.jsx`**

```jsx
import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Upload, Button, message } from 'antd'
import { useTranslation } from 'react-i18next'
import EditorialShell from '../components/EditorialShell'
import { uploadFiles, getAppById } from '../api/apps'

const { Dragger } = Upload

function UploadFiles() {
  const navigate = useNavigate()
  const { id } = useParams()
  const { t } = useTranslation()
  const [fileList, setFileList] = useState([])
  const [uploading, setUploading] = useState(false)
  const [app, setApp] = useState(null)

  useEffect(() => {
    const loadApp = async () => {
      try {
        setApp(await getAppById(id))
      } catch {
        message.error(t('uploadFiles.loadAppError'))
        navigate('/')
      }
    }
    loadApp()
  }, [id, navigate, t])

  const handleUpload = async () => {
    if (fileList.length === 0) {
      message.warning(t('uploadFiles.noFilesSelected'))
      return
    }
    try {
      setUploading(true)
      const files = fileList.map((f) => f.originFileObj)
      const result = await uploadFiles(id, files)
      message.success(t('uploadFiles.uploadSuccess', { count: result.filesUploaded }))
      setFileList([])
      setTimeout(() => navigate('/'), 1200)
    } catch (error) {
      message.error(error.response?.data?.error?.message || t('uploadFiles.uploadError'))
    } finally {
      setUploading(false)
    }
  }

  const uploadProps = {
    multiple: true,
    fileList,
    beforeUpload: (file) => {
      setFileList((prev) => [
        ...prev,
        { uid: file.uid, name: file.name, status: 'done', originFileObj: file },
      ])
      return false
    },
    onRemove: (file) => {
      setFileList((prev) => prev.filter((f) => f.uid !== file.uid))
    },
    accept: '.html,.css,.js,.json,.txt,.md,.jpg,.jpeg,.png,.gif,.svg,.ico,.zip',
  }

  const extOf = (name) => (name.split('.').pop() || 'FILE').toUpperCase()

  return (
    <EditorialShell>
      <button className="back-link" onClick={() => navigate('/')}>
        ← {t('common.back')}
      </button>
      <h1 className="page-title">
        {t('uploadFiles.title')}{app ? ` — ${app.name}` : ''}
      </h1>
      <div className="lead">{t('uploadFiles.uploadDescription')}</div>

      <div style={{ maxWidth: 720, marginTop: 28 }}>
        <Dragger {...uploadProps} className="dropzone">
          <div className="dz-text">{t('uploadFiles.dragHint')}</div>
          <div className="dz-hint">{t('uploadFiles.dragDescription')}</div>
        </Dragger>

        {fileList.length > 0 && (
          <ul className="file-list">
            {fileList.map((file, i) => (
              <li className="file-row" key={file.uid}>
                <div className="num">{String(i + 1).padStart(2, '0')}</div>
                <div className="ext">{extOf(file.name)}</div>
                <div className="fname">{file.name}</div>
              </li>
            ))}
          </ul>
        )}

        <div style={{ marginTop: 26 }}>
          <Button
            type="primary"
            className="btn-ink"
            icon={null}
            onClick={handleUpload}
            loading={uploading}
            disabled={fileList.length === 0}
          >
            {uploading ? t('uploadFiles.uploading') : t('uploadFiles.uploadButton')}
          </Button>
        </div>

        {app && app.deploy_type === 'http-server' && (
          <div className="note">
            <h4>{t('uploadFiles.quickTipTitle')}</h4>
            <p>{t('uploadFiles.quickTipStatic')}</p>
          </div>
        )}
      </div>
    </EditorialShell>
  )
}

export default UploadFiles
```

- [ ] **Step 2: Lint + run-through**

Run: `cd client && npm run lint` → exit 0.
Run dev: from a dashboard app row click "Upload".
Expected: serif `Upload — {name}` title, back link, dashed paper drop zone (drag a file or click → file picker). Selected files render as numbered rows with ext tags. "Upload Files" ink button disabled until a file is chosen; uploading shows loading; success toast then returns to dashboard. For an http-server app, a paper `.note` quick-tip appears. Drop a `.zip` → on upload it extracts server-side (verify via "View Directory" showing extracted files).

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/UploadFiles.jsx
git commit -m "feat(ui): editorial UploadFiles — paper dropzone, file rows, note tip"
```

---

## Task 9: Final verification + production build

**Files:** none (verification only)

- [ ] **Step 1: Lint the whole client**

Run: `cd client && npm run lint`
Expected: exit 0, zero warnings.

- [ ] **Step 2: Production build**

Run: `cd client && npm run build`
Expected: build succeeds (Vite emits `dist/`), no errors.

- [ ] **Step 3: Full click-through (both languages)**

Run: from repo root `npm run dev`. Open the client URL. Repeat the full flow once in English and once in Chinese (toggle `EN / 中`):
1. Dashboard loads, lead line + numbered rows correct.
2. `+ New app` → create `demo-static` (http-server) → back to dashboard, row `01` appears `Idle`.
3. Upload an `index.html` (+ a `.zip` to test extraction) → success → back.
4. Start the app → `Live`, port chip clickable, opens `http://localhost:<port>` showing the HTML.
5. View Directory → Modal lists files.
6. Stop → `Idle`. Delete → Popconfirm → confirm → row gone.
7. Create an `npm` app, upload a `package.json` with a `start` script, start it → `Live`.
8. Toggle to `中` — all copy Chinese, layout intact; toggle back.

- [ ] **Step 4: Commit any final touch-ups (if none, skip)**

```bash
git add -A
git commit -m "chore(ui): editorial redesign — final verification" --allow-empty
```

---

## Done

The Microverse client now reads as a deliberate editorial product: warm paper, serif display, mono small-caps meta, numbered rows, a single deep-red accent — with identical feature behavior to before. The accent is one CSS variable (`--accent`) and one Antd token (`colorPrimary`) away from a different hue if desired later.
