const bcrypt = require('bcryptjs');
const { queries } = require('../db');
const config = require('../config');

/**
 * AuthManager — single-admin auth: idempotent seeding + credential verification.
 * Used by app.js (ensureAdmin at boot) and routes (verifyCredentials on login).
 */
class AuthManager {
  /**
   * Seed an admin user from ADMIN_USERNAME/ADMIN_PASSWORD if the users table is
   * empty. Idempotent: no-op once any user exists. The env password is used once
   * to create a bcrypt hash; subsequent boots ignore the env vars.
   */
  static async ensureAdmin() {
    try {
      const row = await queries.getUserCount();
      if (row && row.count > 0) return; // an admin already exists

      const username = config.auth.adminUsername;
      const password = config.auth.adminPassword;
      if (!password) {
        console.warn('⚠ No admin user and ADMIN_PASSWORD not set — admin login unavailable. Set ADMIN_PASSWORD in .env and restart.');
        return;
      }
      const passwordHash = await bcrypt.hash(password, 10);
      await queries.createUser(username, passwordHash);
      console.log(`✓ Admin user '${username}' seeded. (To change the password, delete the users row and restart with a new ADMIN_PASSWORD.)`);
    } catch (err) {
      // Never crash boot over seeding — warn and continue.
      console.warn(`ensureAdmin failed: ${err.message}`);
    }
  }

  /**
   * Verify username/password against the DB. Returns the safe user object
   * (no password_hash) on success, or null on bad username/password.
   * @returns {Promise<{id:number, username:string} | null>}
   */
  static async verifyCredentials(username, password) {
    const user = await queries.getUserByUsername(username);
    if (!user) return null;
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return null;
    return { id: user.id, username: user.username };
  }
}

module.exports = AuthManager;
