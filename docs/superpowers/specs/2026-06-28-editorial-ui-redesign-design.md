# Microverse UI Redesign — Editorial Direction

**Date:** 2026-06-28
**Status:** Approved direction (B / Editorial), spacious density, deep-red accent
**Scope:** Frontend (`client/`) visual redesign only. No backend behavior changes.

## Context

Microverse's current UI is default Ant Design (`#1890ff` primary, `Header`/`Content`/`Row`+`Card` grid, `Tag color="success"`, inline hover styles, standard `Dragger`). It reads as a generic AI-generated Antd template. This redesign moves it to a deliberate **editorial / commercial** aesthetic: warm paper, serif display type, numbered rows, a single confident accent, hairline rules.

Four backend bugs were fixed as a prerequisite (see *Completed prerequisites*); they are out of scope for this spec beyond being done.

## Goals

- Replace the Antd default look with a consistent editorial visual language across **all** client pages (Dashboard, CreateApp, UploadFiles) and shared shell.
- Keep every existing feature working identically: list/create/delete/start/stop apps, file upload + ZIP extraction, view directory, port-click-to-open, i18n (zh/en), refresh.
- Make the accent color and core palette single-source (CSS variables) so it's trivially swappable later.

## Non-goals

- No dark mode in this pass (editorial is inherently light/paper; a tinted "ink" dark variant can follow).
- No new features (batch operations, grouping, etc.) — only restyle.
- No backend or API changes.
- No removal of Ant Design as a dependency — it stays for Modal/Popconfirm/Upload/Select internals; we override its tokens and wrap custom components around the signature surfaces.

## Visual language

### Palette (CSS variables)

| Token | Value | Use |
|---|---|---|
| `--paper` | `#F4EFE6` | page background |
| `--surface` | `#FBF7F0` | raised surfaces (modals, drop zone) |
| `--ink` | `#1A1714` | primary text |
| `--ink-2` | `#6B5F4D` | secondary text |
| `--ink-3` | `#8A7E6B` | meta / captions |
| `--rule` | `#D8CFBF` | hairline dividers |
| `--accent` | `#A8341E` | wordmark italic, active nav, Live status, primary action links |
| `--idle` | `#A89C88` | stopped/idle status |
| `--paper-hover` | `#EDE6D8` | row hover |

### Typography

- **Serif display** (`Georgia, 'Times New Roman', serif`): wordmark, app names, page titles, status words (Live/Idle).
- **Mono small-caps** (`ui-monospace, SF Mono, Menlo, Consolas, monospace`, `text-transform: uppercase`, `letter-spacing: 0.12em`, reduced size): nav links, meta labels (PORT / TYPE / CREATED), section leads, numbers.
- This serif × mono contrast is the editorial signature.

### Density

Spacious: numbered rows ~72px tall, generous whitespace, large serif app names.

## Layout

### Shared shell (`EditorialShell`)

- Centered `max-width: 1100px` on `--paper`.
- **Top bar:** large serif wordmark `Micro` + italic accent `verse` on the left; right side = mono uppercase nav text-links with hairline underline on hover (New app, Refresh, language toggle `EN / 中`). The active/primary action (New app) renders in `--accent`.
- A `1.5px solid var(--ink)` rule under the header.
- Page content below, same centered width.

### Dashboard

- Lead line: mono small-caps `DEPLOYED APPLICATIONS — N` (and `— N RUNNING`).
- Apps rendered as **numbered rows** (not cards), columns: `№ | name + type-sub | port | kind | status | actions`.
  - `01` in accent mono.
  - App name in large serif; below it a mono small-caps sub-label of deploy type.
  - Port in mono; running port is a clickable accent-colored chip (opens `http://localhost:<port>`), stopped port is plain mono.
  - Status: serif italic `Live` (accent) / `Idle` (`--idle`).
  - Actions appear right-aligned on row hover: Open ↗ / Stop or Start / Files / Delete (Popconfirm wraps Delete; Delete disabled while running).
  - Hairline `--rule` between rows; row hover = `--paper-hover`.
- **Empty state:** centered serif statement + accent text-link `Create your first app →`.
- Loading: a mono `LOADING…` line, not a big spinner.

### CreateApp

- Centered narrow column (~560px) on paper.
- Serif page title; mono small-caps lead label; `Back` as a mono text-link with `←`.
- Form inputs restyled: transparent background, hairline `--rule` underline (focus = `--ink` underline), no chunky Antd card border, no large rounded fields.
- Deploy type as a hairline-bordered Antd `Select`, restyled (transparent bg, `--rule` underline, mono option text); `nginx` option stays disabled.
- Submit = ink-filled button (solid `--ink` background, `--paper` text); Cancel = plain mono text-link.

### UploadFiles

- Paper, centered ~760px.
- Serif title `Upload — {app name}`; `Back` mono text-link.
- Drop zone: a `--rule` dashed-border framed area (not Antd's blue Dragger), mono hint text, accent on hover/drag.
- Selected files as the same numbered-row treatment as the Dashboard list, with a mono extension tag (no rainbow Antd tags).
- Upload button = ink-filled or accent text-link.
- Quick-tip card (http-server) becomes a hairline-bordered paper note with a serif heading.

## Component plan

New / changed client files:

- `client/src/styles/index.css` — add the palette + typography CSS variables, base resets, Antd neutralization overrides (buttons → ink/accent text buttons, tags → italic status words, inputs → hairline underline, cards → transparent, popovers/modals → paper surface).
- `client/src/styles/editorial.css` — editorial component classes (`.wordmark`, `.nav-link`, `.app-row`, `.num`, `.lead`, `.rule`, `.text-link`, `.field-underline`).
- `client/src/components/EditorialShell.jsx` — shared top bar + centered column + rule. Replaces the repeated `Layout`/`Header` boilerplate in each page.
- `client/src/components/AppRow.jsx` — replaces `AppCard`. Renders the numbered row; owns the directory Modal + port-click + action handlers (logic lifted from `AppCard`, restyled).
- `client/src/pages/Dashboard.jsx` — use `EditorialShell`; render `AppRow` list instead of `Row`/`Col`/`Card`; reworded empty + loading states.
- `client/src/pages/CreateApp.jsx` — use `EditorialShell`; restyle form fields per above.
- `client/src/pages/UploadFiles.jsx` — use `EditorialShell`; restyle dragger + file list.
- `client/src/components/LanguageSwitcher.jsx` — render as a mono `EN / 中` text-link toggle, no flag-emoji dropdown.
- `client/src/App.jsx` — `ConfigProvider` token overrides: `colorPrimary = var(--accent)`, `borderRadius = 0`, `fontFamily` serif/sans, neutralized control heights; keep antd locale.
- `client/src/i18n/locales/{zh,en}.json` — minor copy: status labels `Live`/`Idle` (zh: `运行中`/`已停止` may stay, but rendered as serif italic), `Create your first app →`, `LOADING…`. No structural i18n changes.

## Migration / approach

- Implement in this order: (1) `index.css` palette + Antd token overrides in `App.jsx`; (2) `EditorialShell`; (3) `AppRow` + Dashboard; (4) CreateApp; (5) UploadFiles; (6) LanguageSwitcher + copy polish.
- Keep all existing API calls (`client/src/api/apps.js`) unchanged.
- Verify each page after its step by running the app (`/run` or `npm run dev`) and clicking through: list, create, upload (incl. ZIP), start, port-open, stop, view directory, delete, language switch.

## Completed prerequisites (backend)

Already fixed in this session, not part of the UI work:

- `npm` deploy type now resolves `npm/bin/npm-cli.js` + `interpreter: 'node'` (Windows `.cmd` fix).
- `resolveCliModule()` shared helper; hardcoded `C:\Users\User\…` path removed.
- `AppManager.deleteApp` now calls `ProcessManager.deleteProcess` to clean PM2 orphans.
- Upload route validates zip entries against `app.path` before extraction (zip-slip guard).

## Out of scope / future

- Dark ("ink") variant.
- Batch start/stop, app grouping/tags.
- Exposing `syncAllAppsStatus` as a route/UI action.
