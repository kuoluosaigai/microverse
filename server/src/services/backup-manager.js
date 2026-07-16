const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const { queries } = require('../db');
const AppManager = require('./app-manager');
const pathHelper = require('../utils/path-helper');
const { validateManifest } = require('../utils/validate-manifest');
const { isSafeEntry } = require('../utils/validate-zip');

const MANIFEST_NAME = 'microverse-manifest.json';
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
    const manifestError = validateManifest(manifest);
    if (manifestError) throw new Error(manifestError);
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
      for (const e of zip.getEntries()) {
        if (!isSafeEntry(tmpDir, e.entryName)) {
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
