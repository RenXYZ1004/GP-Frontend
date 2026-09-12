import { account, tablesDB, DATABASE_ID, Query, describeError } from './appwrite.js';

// ════════════════════════════════════════════════════════════════
// AuthService — Appwrite Auth
// ════════════════════════════════════════════════════════════════
// The sheet-backed version authenticated in the browser: AppModel downloaded
// every row of the users sheet and compared SHA-256 hashes in client JS. The
// hashes were readable in DevTools and the role was whatever the client said
// it was.
//
// Appwrite holds the credentials and issues a session cookie. The role comes
// from the profiles table, and — this is the part that matters — it is not
// the browser's claim that grants anything. Table permissions are checked by
// the server against team membership, so a tampered role in localStorage
// changes what the UI draws and nothing else.
// ════════════════════════════════════════════════════════════════

// Staff sign in with a bare username; Appwrite Auth is email-based. Usernames
// without an '@' are mapped onto the school domain so nobody has to learn a
// new login. The backend's appwrite/seed.mjs uses the same rule — change one
// and sign-in silently stops matching.
const USERNAME_DOMAIN = 'southville.edu.ph';

function toEmail(username) {
  const name = String(username).trim();
  return name.includes('@') ? name : `${name}@${USERNAME_DOMAIN}`;
}

/** Raised when the server could not be reached — not a rejected session. */
export class OfflineError extends Error {
  constructor() {
    super('Cannot reach the server.');
    this.name = 'OfflineError';
  }
}

/**
 * Did this fail because the network is down, rather than because the server
 * said no? A fetch that never got a response has no Appwrite status code.
 */
function isOffline(err) {
  if (!navigator.onLine) return true;
  if (!err) return false;
  if (typeof err.code === 'number' && err.code > 0) return false;
  return err.name === 'TypeError' || /fetch|network/i.test(err.message || '');
}

export default class AuthService {

  /**
   * Sign in and return the app-level profile.
   * @returns {Promise<{username,name,role,gate,accountId}>}
   * @throws {Error} with a message fit to show on screen
   */
  static async signIn(username, password) {
    // An existing session would make createEmailPasswordSession fail with a
    // 409 rather than switching user, which is what happens when someone
    // hands the gate terminal over without signing out.
    try { await account.deleteSession({ sessionId: 'current' }); } catch { /* none */ }

    try {
      await account.createEmailPasswordSession({
        email: toEmail(username),
        password
      });
    } catch (err) {
      throw new Error(describeError(err));
    }

    const profile = await this.loadProfile();
    if (!profile) {
      // Credentials were right but there is no profile row, so no role and no
      // permissions. Leaving the session open would show an empty broken app.
      await this.signOut();
      throw new Error('This account has no gatepass profile. Ask an administrator.');
    }
    if (String(profile.status).toLowerCase() !== 'active') {
      await this.signOut();
      throw new Error('This account is not active.');
    }
    return profile;
  }

  /**
   * The signed-in user's profile, or null when the session is genuinely over.
   *
   * @throws {OfflineError} when the server could not be reached at all.
   *
   * The distinction matters more than it looks. A gate terminal loses its
   * connection routinely, and this app is meant to keep scanning through it.
   * Treating "cannot reach Appwrite" the same as "not signed in" would sign a
   * guard out mid-shift the moment the wifi dropped. Only an answer from the
   * server — a 401 — ends a session.
   */
  static async loadProfile() {
    let user;
    try {
      user = await account.get();
    } catch (err) {
      if (isOffline(err)) throw new OfflineError();
      return null;
    }

    try {
      // The profile row id IS the account id, so this is a direct read rather
      // than a query.
      const row = await tablesDB.getRow({
        databaseId: DATABASE_ID,
        tableId: 'profiles',
        rowId: user.$id
      });
      return {
        accountId: user.$id,
        email: user.email,
        username: row.username,
        name: row.name || user.name || row.username,
        role: row.role,
        gate: row.gate || '',
        status: row.status || 'active'
      };
    } catch (err) {
      if (isOffline(err)) throw new OfflineError();
      return null;
    }
  }

  static async signOut() {
    try {
      await account.deleteSession({ sessionId: 'current' });
    } catch (err) {
      // Best effort. A failure here must still let the terminal be handed
      // over — most likely cause is being offline, and the session is already
      // unusable in that state.
      console.warn('[AuthService] Remote sign-out failed.', err);
    }
  }

  static async isSignedIn() {
    try {
      await account.get();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A short-lived JWT proving who the caller is, for the send-email function.
   *
   * Functions cannot see the session cookie, so the browser mints this and
   * sends it in a header; the function asks Appwrite whose it is.
   */
  static async jwt() {
    const { jwt } = await account.createJWT();
    return jwt;
  }

  static async changePassword(oldPassword, newPassword) {
    try {
      await account.updatePassword({ password: newPassword, oldPassword });
    } catch (err) {
      throw new Error(describeError(err));
    }
  }
}
