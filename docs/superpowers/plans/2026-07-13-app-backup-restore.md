# App Backup/Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-app backup (download a zip of files + manifest) and restore (upload a zip to recreate the app with files + env), with name-conflict errors and rollback on failure.

**Architecture:** A `BackupManager` service (`createBackup` → adm-zip buffer; `restoreBackup` → validate manifest, create app, extract `files/` into the app dir same-volume, restore env, roll back on any failure). Two routes (`GET /apps/:id/backup`, `POST /apps/restore`) reuse adm-zip + the upload route's zip-slip guard. Frontend: a per-row Backup button (anchor download) and a Dashboard Restore button (hidden file input → FormData POST).

**Tech Stack:** Node.js, Express, adm-zip (already a dependency), multer (memoryStorage for restore), React + Ant Design + react-i18next.

## Global Constraints

- **No test framework.** Verify via `node -e` (backend unit) and `curl` (backend integration) and `npm run lint` (frontend). Absence of jest is NOT a defect.
- **Cross-volume safety:** this machine's project is on `D:` and `os.tmpdir()` is on `C:` — `fs.renameSync` across them throws EXDEV. Any temp dir used during restore MUST live under the apps directory (same volume as the target app dir), not `os.tmpdir()`.
- **Reuse adm-zip** (already in `server/package.json`); do NOT add archiver/jszip.
- **zip-slip guard:** every zip entry must resolve inside its extraction root (same pattern as the upload route). Reuse it verbatim for restore.
- **Database is async (`sqlite3`):** always `await` query calls.
- **Commit on `main`** (repo convention). English commit messages ending `Co-Authored-By: Claude <noreply@anthropic.com>`.
- **Auth:** both new endpoints sit after `router.use(requireAuth)` → admin-only automatically.
- **Manifest shape** (the contract between createBackup and restoreBackup): `{ version:1, name:string, deploy_type:'npm'|'http-server'|'nginx', env:[{key,value}] }`. Excludes id/port/status/path/timestamps.

## File Structure

**Create (backend):** `server/src/services/backup-manager.js` (`createBackup` + `restoreBackup`).
**Modify (backend):** `server/src/middleware/upload.js` (add a `restoreUpload` memoryStorage single-file multer); `server/src/routes/index.js` (GET `/apps/:id/backup` + POST `/apps/restore`); `server/src/docs/openapi.yaml`.
**Modify (frontend):** `client/src/api/apps.js` (`backupAppUrl`, `restoreApp`); `client/src/components/AppRow.jsx` (Backup button); `client/src/pages/Dashboard.jsx` (Restore button + hidden file input); `client/src/i18n/locales/{zh,en}.json`.
**Modify (docs):** `PROGRESS.md`, `README.md`.

---

## Task 1: BackupManager service + restoreUpload multer

**Files:**
- Create: `server/src/services/backup-manager.js`
- Modify: `server/src/middleware/upload.js` (export `restoreUpload`)

**Interfaces:**
- Produces: `BackupManager.createBackup(app)` → `Promise<{buffer:Buffer, filename:string}>`; `BackupManager.restoreBackup(zipBuffer)` → `Promise<app>` (throws on invalid/conflict, rolls back on extract failure). `restoreUpload` (multer single('file') memoryStorage middleware). Consumed by Task 2.

- [ ] **Step 1: Add `restoreUpload` to the upload middleware**

In `server/src/middleware/upload.js`, append before `module.exports`:

```js
// Separate multer instance for backup restore: single file, in-memory (no temp
// upload file on disk), same .zip-allowing filter + size limit as uploads.
const restoreUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE }
}).single('file');
```

And update the export:

```js
module.exports = {
  upload,
  restoreUpload,
  MAX_FILE_SIZE,
  ALLOWED_EXTENSIONS
};
```

- [ ] **Step 2: Create `server/src/services/backup-manager.js`**

Full file content:

```js
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const { queries } = require('../db');
const AppManager = require('./app-manager');
const pathHelper = require('../utils/path-helper');

const MANIFEST_NAME = 'microverse-manifest.json';
const VALID_DEPLOY_TYPES = ['npm', 'http-server', 'nginx'];
const NAME_RE = /^[a-zA-Z0-9-_]+$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * BackupManager — per-app backup (zip export) + restore (zip import).
 * Reuses adm-zip + the upload route's zip-slip guard pattern.
 */
class BackupManager {
  /**
   * Build a backup zip: microverse-manifest.json + files/ (app dir contents).
   * @param {{id:number,name:string,deploy_type:string,path:string}} app
   * @returns {Promise<{buffer:Buffer, filename:string}>}
   */
  static async createBackup(app) {
    const env = await queries.getAppEnv(app.id); // [{key, value}]
    const manifest = {
      version: 1,
      name: app.name,
      deploy_type: app.deploy_type,
      env
    };
    const zip = new AdmZip();
    zip.addFile(MANIFEST_NAME, JSON.stringify(manifest, null, 2));
    if (fs.existsSync(app.path)) {
      zip.addLocalFolder(app.path, 'files');
    }
    return { buffer: zip.toBuffer(), filename: `${app.name}-backup.zip` };
  }

  /**
   * Restore an app from a backup zip buffer. Validates the manifest, creates the
   * app, extracts files/ into the app dir, restores env. Rolls back (deletes the
   * partial app row + dir + temp) on any failure after creation.
   * @param {Buffer} zipBuffer
   * @returns {Promise<object>} the restored app
   */
  static async restoreBackup(zipBuffer) {
    let zip;
    try {
      zip = new AdmZip(zipBuffer);
    } catch (_e) {
      throw new Error('Invalid backup file: not a valid zip');
    }

    const entry = zip.getEntry(MANIFEST_NAME);
    if (!entry) {
      throw new Error('Invalid backup file: missing manifest');
    }
    let manifest;
    try {
      manifest = JSON.parse(entry.getData().toString('utf-8'));
    } catch (_e) {
      throw new Error('Invalid backup file: corrupt manifest');
    }
    if (!manifest || typeof manifest.name !== 'string' || !NAME_RE.test(manifest.name)) {
      throw new Error('Invalid app name in backup');
    }
    if (!VALID_DEPLOY_TYPES.includes(manifest.deploy_type)) {
      throw new Error('Invalid deploy_type in backup');
    }
    const existing = await queries.getAppByName(manifest.name);
    if (existing) {
      throw new Error(`App '${manifest.name}' already exists; rename or delete it first`);
    }

    // Create the app row + empty dir.
    const newApp = await AppManager.createApp(manifest.name, manifest.deploy_type);

    // Temp dir UNDER the apps dir (same volume as the target → rename won't EXDEV).
    let tmpDir;
    try {
      tmpDir = fs.mkdtempSync(path.join(pathHelper.getAppsDir(), '.restore-'));

      // zip-slip guard: every entry must resolve inside tmpDir before extracting.
      const safeRoot = path.resolve(tmpDir);
      for (const e of zip.getEntries()) {
        const target = path.resolve(tmpDir, e.entryName);
        if (target !== safeRoot && !target.startsWith(safeRoot + path.sep)) {
          throw new Error(`Unsafe zip entry path: ${e.entryName}`);
        }
      }
      zip.extractAllTo(tmpDir, true);

      // Move files/* into the app dir (same-volume rename).
      const filesRoot = path.join(tmpDir, 'files');
      if (fs.existsSync(filesRoot)) {
        for (const itemName of fs.readdirSync(filesRoot)) {
          fs.renameSync(path.join(filesRoot, itemName), path.join(newApp.path, itemName));
        }
      }

      // Restore env (validate keys with the same rule as PUT /apps/:id/env).
      if (Array.isArray(manifest.env) && manifest.env.length > 0) {
        const entries = manifest.env
          .filter(e => e && typeof e.key === 'string' && ENV_KEY_RE.test(e.key))
          .map(e => ({ key: e.key, value: e.value === undefined ? null : e.value }));
        if (entries.length > 0) {
          await AppManager.setAppEnv(newApp.id, entries);
        }
      }
    } catch (err) {
      // Rollback: remove the partial app row + dir, then rethrow.
      try { await AppManager.deleteApp(newApp.id); } catch (_e) { /* best-effort */ }
      try { fs.rmSync(newApp.path, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
      throw err;
    } finally {
      try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
    }

    return queries.getAppById(newApp.id);
  }
}

module.exports = BackupManager;
```

- [ ] **Step 3: Verify `createBackup` (no DB write — fake app id)**

```bash
cd server
node -e '
const fs=require("fs"),os=require("os"),path=require("path");
const BM=require("./src/services/backup-manager");
const AdmZip=require("adm-zip");
const { restoreUpload }=require("./src/middleware/upload");
if (typeof BM.createBackup!=="function"||typeof BM.restoreBackup!=="function") throw new Error("methods missing");
if (typeof restoreUpload!=="function") throw new Error("restoreUpload missing");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"bk-"));
fs.writeFileSync(path.join(dir,"index.html"),"<h1>hi</h1>");
const fakeApp={id:999999,name:"selftest",deploy_type:"http-server",path:dir};
BM.createBackup(fakeApp).then(({buffer,filename})=>{
  if(filename!=="selftest-backup.zip") throw new Error("filename: "+filename);
  const zip=new AdmZip(buffer);
  const man=JSON.parse(zip.getEntry("microverse-manifest.json").getData().toString());
  if(man.name!=="selftest"||man.deploy_type!=="http-server"||!Array.isArray(man.env)) throw new Error("manifest: "+JSON.stringify(man));
  if(!zip.getEntry("files/index.html")) throw new Error("files/index.html missing");
  console.log("createBackup OK ->",filename, buffer.length+" bytes");
  fs.rmSync(dir,{recursive:true,force:true});
});
'
```

Expected: `createBackup OK -> selftest-backup.zip <N> bytes`. (Uses a fake app id 999999 so `getAppEnv` returns `[]` — no DB write. `restoreBackup` is exercised end-to-end in Task 2's curl.)

- [ ] **Step 4: Commit**

```bash
git add server/src/services/backup-manager.js server/src/middleware/upload.js
git commit -m "feat(backup): BackupManager (createBackup/restoreBackup) + restoreUpload multer

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Backup/restore routes + openapi

**Files:**
- Modify: `server/src/routes/index.js` (require BackupManager + restoreUpload; GET `/apps/:id/backup`; POST `/apps/restore`)
- Modify: `server/src/docs/openapi.yaml`

**Interfaces:**
- Consumes: Task 1's `BackupManager` + `restoreUpload`.
- Produces: `GET /api/apps/:id/backup` (zip download) + `POST /api/apps/restore` (zip upload → new app).

- [ ] **Step 1: Add the backup-download route**

In `server/src/routes/index.js`, add to the top requires (after `const metricsSampler = require('../services/metrics-sampler');`):

```js
const BackupManager = require('../services/backup-manager');
const { restoreUpload } = require('../middleware/upload');
```

Add the backup-download route in the protected section (after the `GET /apps/:id/metrics` handler is fine — any spot after `router.use(requireAuth)`):

```js
// Download a backup zip of an app (files + manifest)
router.get('/apps/:id/backup', async (req, res, next) => {
  try {
    const app = await AppManager.getAppById(req.params.id);
    const { buffer, filename } = await BackupManager.createBackup(app);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`
    });
    res.send(buffer);
  } catch (error) {
    if (error.message === 'App not found') {
      return res.status(404).json({ success: false, error: { message: error.message } });
    }
    next(error);
  }
});
```

- [ ] **Step 2: Add the restore-upload route**

Add (also in the protected section — e.g. right after the backup-download route):

```js
// Restore an app from a backup zip (multipart field 'file')
router.post('/apps/restore', (req, res, next) => {
  restoreUpload(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ success: false, error: { message: err.message } });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: { message: 'No backup file provided' } });
    }
    try {
      const app = await BackupManager.restoreBackup(req.file.buffer);
      res.status(201).json({ success: true, data: app });
    } catch (error) {
      const isClientError = ['Invalid backup file', 'Invalid app name', 'Invalid deploy_type', 'already exists']
        .some(s => error.message.includes(s));
      if (isClientError) {
        return res.status(400).json({ success: false, error: { message: error.message } });
      }
      next(error);
    }
  });
});
```

> Route ordering: `POST /apps/restore` is one segment after `/apps`. No existing route shadows it (`POST /apps` is the create route at exactly `/apps`; the `POST /apps/:id/{start,stop,...}` routes are two segments). Safe.

- [ ] **Step 3: OpenAPI — add the two endpoints**

In `server/src/docs/openapi.yaml`, add (among the other paths, mirroring existing style; both inherit the top-level "requires authentication" note):

```yaml
  /apps/{id}/backup:
    get:
      tags: [Applications]
      operationId: backupApp
      summary: Download a backup zip of an app
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: integer }
      responses:
        '200':
          description: Backup zip (files + microverse-manifest.json)
          content:
            application/zip:
              schema: { type: string, format: binary }
        '404':
          description: App not found
  /apps/restore:
    post:
      tags: [Applications]
      operationId: restoreApp
      summary: Restore an app from a backup zip
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              properties:
                file: { type: string, format: binary }
      responses:
        '201':
          description: App restored (status stopped)
          content:
            application/json:
              schema:
                type: object
                properties:
                  success: { type: boolean, example: true }
                  data: { $ref: '#/components/schemas/App' }
        '400':
          description: Invalid backup / name conflict / missing file
```

(Match the content-type key style used elsewhere in the file for `application/json` / `multipart/form-data`.)

- [ ] **Step 4: Integration-verify via curl**

Free port 5000 if held, boot with admin creds, log in, save the cookie jar. Then against a real app (create one + give it an index.html):

```bash
cd server
ADMIN_USERNAME=admin ADMIN_PASSWORD=test123 npm run dev   # background
```

```bash
# login
curl -s -c cookies.txt -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" -d '{"username":"admin","password":"test123"}'

# create a throwaway app + file
curl -s -b cookies.txt -X POST http://localhost:5000/api/apps \
  -H "Content-Type: application/json" -d '{"name":"bktest","deploy_type":"http-server"}'
mkdir -p ../apps/bktest && echo "<h1>backup me</h1>" > ../apps/bktest/index.html

# backup -> save zip (expect 200 + application/zip)
curl -s -b cookies.txt -o bktest-backup.zip -w "%{http_code} %{content_type}\n" \
  http://localhost:5000/api/apps/<id>/backup
# Expected: 200 application/zip

# inspect the zip: manifest + files/index.html
node -e "const z=new(require('adm-zip'))('bktest-backup.zip');console.log(z.getEntries().map(e=>e.entryName));console.log('manifest name:', JSON.parse(z.getEntry('microverse-manifest.json').getData().toString()).name)"
# Expected entries include: microverse-manifest.json, files/index.html ; manifest name: bktest

# delete the app, then restore the zip -> 201 + new app (stopped)
curl -s -b cookies.txt -X DELETE http://localhost:5000/api/apps/<id>
curl -s -b cookies.txt -X POST http://localhost:5000/api/apps/restore \
  -F "file=@bktest-backup.zip" -w "\n%{http_code}\n"
# Expected: {"success":true,"data":{...,"name":"bktest","status":"stopped"}} then 201
# Confirm files restored: ls ../apps/bktest (index.html present)

# conflict: restore the SAME zip again -> 400
curl -s -o /dev/null -w "%{http_code}\n" -b cookies.txt -X POST http://localhost:5000/api/apps/restore -F "file=@bktest-backup.zip"
# Expected: 400

# invalid: upload a non-zip -> 400
echo "not a zip" > notazip.txt
curl -s -o /dev/null -w "%{http_code}\n" -b cookies.txt -X POST http://localhost:5000/api/apps/restore -F "file=@notazip.txt"
# Expected: 400
```

Clean up: delete the restored `bktest` app + temp files; free port 5000.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/index.js server/src/docs/openapi.yaml
git commit -m "feat(backup): GET /apps/:id/backup + POST /apps/restore routes

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Frontend — Backup button + Dashboard Restore entry + api + i18n

**Files:**
- Modify: `client/src/api/apps.js` (`backupAppUrl`, `restoreApp`)
- Modify: `client/src/components/AppRow.jsx` (Backup button)
- Modify: `client/src/pages/Dashboard.jsx` (Restore button + hidden file input)
- Modify: `client/src/i18n/locales/en.json` + `zh.json`

**Interfaces:**
- Consumes: Task 2's two endpoints.

- [ ] **Step 1: Add `backupAppUrl` + `restoreApp` to the API client**

In `client/src/api/apps.js`, add (e.g. after `appLogsStreamUrl`):

```js
/**
 * Backup-download URL for an app. Consumed via a programmatic <a download> click
 * (same-origin → session cookie rides automatically; no axios/blob needed).
 */
export const backupAppUrl = (id) => `/api/apps/${id}/backup`

/**
 * Restore an app from a backup zip (multipart field 'file'). Returns the new app.
 */
export const restoreApp = async (file) => {
  const form = new FormData()
  form.append('file', file)
  const response = await api.post('/apps/restore', form, {
    headers: { 'Content-Type': 'multipart/form-data' }
  })
  return response.data.data
}
```

- [ ] **Step 2: Add the Backup button in `AppRow.jsx`**

In `client/src/components/AppRow.jsx`, add an import at the top (after `import { getAppFiles } from '../api/apps'`):

```jsx
import { getAppFiles, backupAppUrl } from '../api/apps'
```

Add a Backup button in the `acts` div, right after the Upload button:

```jsx
          <button
            className="act"
            onClick={() => navigate(`/apps/${app.id}/upload`)}
          >
            {t('appCard.upload')}
          </button>
          <button
            className="act"
            onClick={() => {
              const a = document.createElement('a')
              a.href = backupAppUrl(app.id)
              a.download = `${app.name}-backup.zip`
              document.body.appendChild(a)
              a.click()
              document.body.removeChild(a)
            }}
          >
            {t('appCard.backup')}
          </button>
```

- [ ] **Step 3: Add the Restore button + hidden file input in `Dashboard.jsx`**

In `client/src/pages/Dashboard.jsx`, add `useRef` to the React import and import `restoreApp`:

```jsx
import { useState, useRef } from 'react'
```
(change the existing `import { useState, useEffect } from 'react'` to `import { useState, useEffect, useRef } from 'react'`)

and in the api import line add `restoreApp`:

```jsx
import { getAllApps, deleteApp, startApp, stopApp, restoreApp } from '../api/apps'
```

Inside the `Dashboard` component, add a ref + handler (near `handleDelete`):

```jsx
  const fileInputRef = useRef(null)

  const handleRestore = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return
    try {
      await restoreApp(file)
      message.success(t('messages.restoreDone'))
      await loadApps(true)
    } catch (err) {
      message.error(err.response?.data?.error?.message || t('messages.restoreFailed'))
    }
  }
```

Add a Restore button to the `right` nav (after the "+ New app" button) and a hidden file input (e.g. just before `</> ` closing the fragment — anywhere in the returned JSX):

```jsx
      <>
        <button
          className="nav-link"
          onClick={() => loadApps(true)}
          disabled={refreshing}
        >
          {t('dashboard.refreshApps')}
        </button>
        <button className="nav-link" onClick={() => navigate('/create')}>
          + {t('dashboard.createApp')}
        </button>
        <button className="nav-link" onClick={() => fileInputRef.current && fileInputRef.current.click()}>
          ↥ {t('dashboard.restore')}
        </button>
        <LanguageSwitcher />
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip"
          style={{ display: 'none' }}
          onChange={handleRestore}
        />
      </>
```

- [ ] **Step 4: Add i18n keys (zh + en)**

In `client/src/i18n/locales/zh.json`:
- inside `appCard`, add: `"backup": "备份",`
- inside `dashboard`, add: `"restore": "恢复",`
- inside `messages`, add: `"restoreDone": "应用已恢复",` and `"restoreFailed": "恢复失败",`

In `client/src/i18n/locales/en.json`:
- inside `appCard`: `"backup": "Backup",`
- inside `dashboard`: `"restore": "Restore",`
- inside `messages`: `"restoreDone": "App restored",` and `"restoreFailed": "Restore failed",`

(Mind trailing commas to keep both files valid JSON — add each key after the last existing key in its section.)

- [ ] **Step 5: Verify lint + JSON**

```bash
cd client && npm run lint
```
Expected: no errors (`--max-warnings 0`). Then:

```bash
node -e "JSON.parse(require('fs').readFileSync('src/i18n/locales/zh.json','utf-8'));JSON.parse(require('fs').readFileSync('src/i18n/locales/en.json','utf-8'));console.log('locales OK')"
```
Expected: `locales OK`.

- [ ] **Step 6: Commit**

```bash
git add client/src/api/apps.js client/src/components/AppRow.jsx client/src/pages/Dashboard.jsx client/src/i18n/locales/en.json client/src/i18n/locales/zh.json
git commit -m "feat(backup): Backup download button + Dashboard Restore entry

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Docs — PROGRESS + README

**Files:**
- Modify: `PROGRESS.md`
- Modify: `README.md`

- [ ] **Step 1: Update `PROGRESS.md`**

(a) In "### ✅ Phase 15: 优化和增强 (优先级: 低)" (or "### 🎯 Phase 15" if not yet retitled), tick the backup/restore item. Replace:

```markdown
- [ ] 应用备份和恢复
```

with:

```markdown
- [x] 应用备份和恢复（per-app zip 导出/导入；manifest 含 name/deploy_type/env；恢复同名报 400、失败回滚）
```

(If the Phase 15 heading is still `### 🎯 Phase 15: 优化和增强 (优先级: 低)`, leave the heading — only tick the item.)

(b) In the changelog "### [Unreleased]" block (create one dated 2026-07-13 if needed), under "#### 新增", prepend:

```markdown
- Phase 15（部分）：per-app 备份/恢复——`BackupManager`（zip 导出含 `microverse-manifest.json` + `files/`；恢复先校验再建、失败回滚、同名报 400）+ `GET /api/apps/:id/backup` + `POST /api/apps/restore`；前端 AppRow Backup 下载按钮 + Dashboard Restore 入口。
```

(c) **Doc debt from the auth feature:** in "### ✅ Phase 14：用户系统（单管理员登录部分，2026-07-12）", change the three deferred multi-user items from "按需" to "不做" to reflect the user's decision that multi-user is permanently out of scope. Replace:

```markdown
- [ ] 多用户 / 注册（按需；users 表已在）
- [ ] JWT / 细粒度权限（按需）
- [ ] 多用户应用隔离（需 owner 列 + 每查询过滤；按需）
```

with:

```markdown
- [ ] ~~多用户 / 注册~~（不做——单管理员即完整范围）
- [ ] ~~JWT / 细粒度权限~~（不做）
- [ ] ~~多用户应用隔离~~（不做）
```

- [ ] **Step 2: Update `README.md`**

In the Features list, add a bullet after the "🔒 **Admin Login**" bullet:

```markdown
- 💾 **Backup & Restore**: export any app as a zip (files + manifest + env) and restore it on the same or another instance
```

- [ ] **Step 3: Commit**

```bash
git add PROGRESS.md README.md
git commit -m "docs: app backup/restore (Phase 15 partial); mark Phase 14 multi-user as won't-do

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Done criteria

- `GET /api/apps/:id/backup` returns a zip with `microverse-manifest.json` (name/deploy_type/env) + `files/` (app contents).
- `POST /api/apps/restore` recreates the app (stopped), restores files + env; rolls back on failure.
- Restore of a zip whose name already exists → 400; invalid zip / missing manifest → 400.
- AppRow has a Backup button (downloads zip); Dashboard has a Restore button (file picker → upload).
- `npm run lint` (client) passes; openapi parses.
- `PROGRESS.md` Phase 15 backup item ticked; Phase 14 multi-user items marked won't-do; README mentions backup/restore.
