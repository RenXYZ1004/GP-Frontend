// ════════════════════════════════════════════════════════════════
// Central app configuration
// Single source of truth for values that used to be hard-coded in
// several files (index.html, the service layer, ...).
// ════════════════════════════════════════════════════════════════

// ── Backend: Appwrite ───────────────────────────────────────────
//
// The Apps Script Web App that used to serve this app is gone. It was slow
// for structural reasons: every request paid a cold Apps Script boot, and
// each read pulled a whole sheet into memory and scanned it linearly.
//
// Appwrite replaces it wholesale — database, accounts and the two functions.
// Most of the app now talks to the database directly through the Web SDK,
// with table permissions deciding what each role may do, so there is no API
// layer of our own in the middle. Only two things run as functions, because
// only two things cannot be trusted to a browser: allocating a Pass ID on the
// public application form, and holding the Gmail credentials.
//
// Both come from: Appwrite console → your project → Settings.
// Neither is a secret — the project id names the project, and the table
// permissions are what gate the data.
//
// The endpoint must name the region the project was created in. Appwrite
// Cloud is region-scoped: a project in one region does not answer on another
// region's host, and the bare https://cloud.appwrite.io/v1 predates regions
// entirely. Getting it wrong fails with "Project is not accessible in this
// region", which never mentions the endpoint being the problem.
//
// This project is in nyc. Keep it identical to APPWRITE_ENDPOINT in the
// backend's .env — the scripts and the browser must agree.
export const APPWRITE_ENDPOINT = 'https://nyc.cloud.appwrite.io/v1';
export const APPWRITE_PROJECT_ID = '6aa3644f002d36ff5977';

// Set in the backend's appwrite/schema.mjs. Change it in both or neither.
export const APPWRITE_DATABASE_ID = 'gatepass';

// Function ids, as declared in the backend's appwrite.json.
export const FN_SUBMIT_APPLICATION = 'submit-application';
export const FN_SEND_EMAIL = 'send-email';

// The one and only login page. Everything that needs a login sends the
// user here — there is no second, in-app login form.
//
// These are extensionless because vercel.json sets cleanUrls, which serves
// index.html at / and app.html at /app, and 308-redirects the .html form.
// They stay relative so the app still works when it is served from a
// subdirectory (the XAMPP layout in the README) rather than a domain root.
export const LOGIN_PAGE = './';

// Signed-in application shell.
export const APP_PAGE = './app.html';

// localStorage / sessionStorage keys.
export const STORAGE_KEYS = {
  session: 'pgp_session',
  browserAlive: 'pgp_browser_alive',
  students: 'pgp_students',
  logs: 'pgp_logs',
  tgp: 'pgp_tgp',
  users: 'pgp_users',
  emailQueue: 'pgp_email_queue',
  writeQueue: 'pgp_write_queue',
  lastSync: 'pgp_last_sync',
  theme: 'pgp_theme',
  sidebar: 'pgp_sidebar',
  gates: 'pgp_gates'
};

// Inactivity before the session is dropped (ms).
export const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Build the URL of the main login page, optionally carrying a notice
 * that index.html will surface inside the login modal.
 * @param {string} [notice] - human readable reason (e.g. "Session expired")
 * @returns {string}
 */
export function loginUrl(notice) {
  return notice ? `${LOGIN_PAGE}?notice=${encodeURIComponent(notice)}` : LOGIN_PAGE;
}
