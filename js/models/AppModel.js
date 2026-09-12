import ApiService from '../services/ApiService.js';
import AuthService from '../services/AuthService.js';
import { uploadPhotoLocally } from '../utils.js';
import { SESSION_TIMEOUT_MS } from '../config.js';

// ════════════════════════════════════════════════════════════════
// AppModel — Data Layer with the gatepass API + localStorage Cache
// ════════════════════════════════════════════════════════════════
// Data flows:
//   READ:  API → localStorage cache → Views
//   WRITE: Views → API + localStorage cache
//   OFFLINE: Falls back to localStorage cache automatically
// ════════════════════════════════════════════════════════════════

// Read a JSON value from localStorage without ever throwing.
// A single corrupt entry used to break the whole app at construction time.
function readCache(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback;
    return parsed ?? fallback;
  } catch (err) {
    console.warn(`[AppModel] Corrupt cache for "${key}" — resetting.`, err);
    try { localStorage.removeItem(key); } catch (_) { }
    return fallback;
  }
}

// Write a JSON value to localStorage without ever throwing.
//
// The students array outgrew the 5 MB origin quota: most records still carry
// their photo inline as a base64 data URI, and localStorage counts UTF-16, so
// the array measures ~8.4 MB. setItem then threw QuotaExceededError on every
// single sync — and because the cache write runs inside syncFromSheet's try
// block, that throw was caught there as a *sync failure*, so the freshly
// fetched students were never rendered and the app kept showing whatever stale
// cache predated the overflow. A cache miss must degrade to "not cached", not
// take the sync down with it.
function writeCache(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn(`[AppModel] Could not cache "${key}" — ${err.name}. Continuing without it.`, err);
    return false;
  }
}

// The cached copy of a student drops an inline data-URI photo and keeps a
// photo that is already a URL (a few dozen characters). Inline photos are ~90%
// of the payload; without them the array is well under quota. Nothing is lost
// on screen — this.students keeps every photo in memory for the session, and
// the next sync refetches them.
//
// The key is deleted, not blanked. JSON.stringify omits undefined, so such a
// record reloads with photo === undefined, which mapStudentToSheet passes
// through as an absent Photo column — and Apps Script's updateRow keeps the
// cell it already has. Caching '' instead would mean that editing a student
// before the first sync completed wrote that '' back and destroyed the photo.
function withoutInlinePhotos(students) {
  return students.map(s => {
    if (typeof s.photo !== 'string' || !s.photo.startsWith('data:')) return s;
    const { photo, ...rest } = s;
    return rest;
  });
}

export default class AppModel {
  constructor() {
    // Load cached data from localStorage (instant load)
    this.students = readCache('pgp_students', []);
    this.exitLogs = readCache('pgp_logs', []);
    this.tgp = readCache('pgp_tgp', []);
    this.users = readCache('pgp_users', []);
    this.gates = readCache('pgp_gates', []);
    this.emailQueue = readCache('pgp_email_queue', []);

    // Session management
    const profile = readCache('pgp_session', null);
    const browserAlive = sessionStorage.getItem('pgp_browser_alive');
    this.currentUser = (profile && browserAlive) ? profile : null;
    if (profile && !browserAlive) localStorage.removeItem('pgp_session');

    // Sync state
    this.lastSyncTime = parseInt(localStorage.getItem('pgp_last_sync') || '0');
    this.syncStatus = 'idle'; // 'idle' | 'syncing' | 'error'
    this.isOnline = navigator.onLine;
    this.lastDataHash = null; // Change detection for sync optimization

    // Session timeout — configured in js/config.js
    this.SESSION_TIMEOUT = SESSION_TIMEOUT_MS;

    // Offline write queue (for writes that failed due to no internet)
    this.writeQueue = readCache('pgp_write_queue', []);
  }

  // ════════════════════════════════════════════════════════════
  // SYNC ENGINE — Pulls fresh data from the gatepass API
  // ════════════════════════════════════════════════════════════

  async syncFromSheet() {
    this.syncStatus = 'syncing';
    try {
      const data = await ApiService.getAll();

      // Change detection: compare hash before updating
      const newHash = this.computeDataHash(data);
      const hasChanged = newHash !== this.lastDataHash;
      this.lastDataHash = newHash;

      // Map Sheet columns to frontend field names
      this.students = (data.students || []).map(s => this.mapStudentFromSheet(s));
      this.exitLogs = (data.scan_logs || []).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      this.tgp = data.temporary_passes || [];
      this.users = data.users || [];
      this.gates = (data.gates || []).map(g => this.mapGateFromSheet(g));

      // Cache to localStorage
      this.cacheAll();
      this.lastSyncTime = Date.now();
      localStorage.setItem('pgp_last_sync', this.lastSyncTime.toString());
      this.syncStatus = 'idle';
      this.isOnline = true;

      // Process any queued offline writes
      await this.processWriteQueue();

      return { success: true, changed: hasChanged };
    } catch (err) {
      console.error('Sync failed:', err);
      this.syncStatus = 'error';
      this.isOnline = false;
      return { success: false, changed: false };
    }
  }

  // ── Field Mapping: API → Frontend ─────────────────────────
  //
  // Grade and section share one stored column, `GradeAndSection`, holding
  // "Grade 7 - Determination" — or just "Grade 7" when no section is on file,
  // which is the case for all but one existing record.
  //
  // This used to read s.Grade and s.Section. Neither column has ever existed:
  // the backend returns whatever headers the store actually has, so both were
  // always undefined and every student rendered with an empty grade. Reading
  // the column that exists is the fix; the old names are still accepted so a
  // payload that happens to carry them is not ignored.
  mapStudentFromSheet(s) {
    const combined = String(s.GradeAndSection || '');
    const [parsedGrade, parsedSection] = combined.split(' - ');

    const grade = String(s.Grade || parsedGrade || '').trim();
    const section = String(s.Section || parsedSection || '').trim();
    const fullSection = section ? `${grade} - ${section}` : grade;

    return {
      id: String(s.PassID || ''),
      pgp: String(s.PassID || ''),
      studid: String(s.StudentID || ''),
      name: s.CompleteName || '',
      grade: grade,
      section: section,
      fullSection,
      schoolYear: String(s.SchoolYear || ''),
      // Stored as 'QRtoken'. 'QRToken' is accepted because older code wrote
      // that spelling, and dropping it would invalidate a live pass.
      qrToken: String(s.QRtoken || s.QRToken || ''),
      arrangements: s.Arrangements || '',
      preferredGate: s.PreferredGate || '',
      vehicleDetails: s.VehicleDetails || '',
      parentName: s.ParentName || '',
      parentEmail: s.ParentEmail || '',
      phone: String(s.ParentMobile || ''),
      address: s.Address || '',
      // Photo is normally a Vercel Blob URL. Accept the common alternate
      // field names too, so older Sheets rows still display correctly.
      photo: s.Photo || s.photo || s.PhotoURL || s.photoUrl || '',
      status: s.Status || 'active',
      faceDescriptor: s.FaceDescriptor || ''
    };
  }

  // ── Field Mapping: Frontend → API ─────────────────────────
  //
  // This used to emit Grade and Section as separate keys. No such columns
  // exist, and the backend builds a row from the columns it knows, so both
  // were discarded on every write — a student's grade and section never
  // persisted at all. They are joined into the column that does exist.
  mapStudentToSheet(s) {
    const grade = s.grade || '';
    const section = s.section || '';

    return {
      PassID: s.pgp || s.id || '',
      StudentID: s.studid || '',
      CompleteName: s.name || '',
      GradeAndSection: section ? `${grade} - ${section}` : grade,
      SchoolYear: s.schoolYear || '',
      Arrangements: s.arrangements || '',
      ParentName: s.parentName || '',
      ParentEmail: s.parentEmail || '',
      ParentMobile: s.phone || '',
      PreferredGate: s.preferredGate || '',
      VehicleDetails: s.vehicleDetails || '',
      Address: s.address || '',
      // Photo is a persistent URL after upload. undefined means the value was
      // dropped from the localStorage cache to fit the quota, not that the
      // student has no photo — leaving the key out makes Apps Script's
      // updateRow keep whatever the cell already holds rather than blanking it.
      Photo: s.photo === undefined ? undefined : (s.photo || ''),
      Status: s.status || 'active',
      FaceDescriptor: s.faceDescriptor || '',
      // One key, one column. The duplicate 'QRToken' spelling that used to sit
      // beside this was writing to nothing, because no such column existed —
      // which is why the scanner's token check in AppController never had a
      // token to check against.
      QRtoken: s.qrToken || ''
    };
  }

  // ── Name Helpers ──────────────────────────────────────────
  buildFullName(last, first, mid) {
    const parts = [];
    if (last) parts.push(last + ',');
    if (first) parts.push(first);
    if (mid) parts.push(mid.charAt(0) + '.');
    return parts.join(' ') || 'Unknown';
  }

  extractGrade(section) {
    // "Grade 7 - Diligence" → "Grade 7"
    const match = section.match(/^(.*?)\s*-/);
    return match ? match[1].trim() : section;
  }

  extractSection(section) {
    // "Grade 7 - Diligence" → "Diligence"
    const match = section.match(/-\s*(.+)$/);
    return match ? match[1].trim() : '';
  }

  // ── Cache all data to localStorage ────────────────────────
  cacheAll() {
    writeCache('pgp_students', withoutInlinePhotos(this.students));
    writeCache('pgp_logs', this.exitLogs);
    writeCache('pgp_tgp', this.tgp);
    writeCache('pgp_users', this.users);
    writeCache('pgp_gates', this.gates);
  }

  // ── Gate Field Mapping ────────────────────────────────────
  mapGateFromSheet(g) {
    return {
      id: String(g.GateID || ''),
      name: String(g.GateName || ''),
      assignedGuard: String(g.AssignedGuard || ''),
      status: String(g.Status || 'active')
    };
  }

  mapGateToSheet(g) {
    return {
      GateID: g.id || '',
      GateName: g.name || '',
      AssignedGuard: g.assignedGuard || '',
      Status: g.status || 'active'
    };
  }

  getActiveGates() {
    return this.gates.filter(g => g.status === 'active');
  }

  // ── Change Detection ─────────────────────────────────────
  computeDataHash(data) {
    const str = JSON.stringify({
      studentCount: (data.students || []).length,
      logCount: (data.scan_logs || []).length,
      tgpCount: (data.temporary_passes || []).length,
      userCount: (data.users || []).length,
      firstStudent: (data.students || [])[0]?.PassID || '',
      lastStudent: (data.students || []).slice(-1)[0]?.PassID || '',
      firstLog: (data.scan_logs || [])[0]?.id || '',
      lastLog: (data.scan_logs || []).slice(-1)[0]?.id || '',
      // Include a snapshot of statuses for edit detection
      statusSnapshot: (data.students || []).map(s => s.Status || '').join(',')
    });
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return hash;
  }

  // ════════════════════════════════════════════════════════════
  // OFFLINE WRITE QUEUE
  // ════════════════════════════════════════════════════════════

  async queueWrite(action, data) {
    this.writeQueue.push({ action, data, timestamp: Date.now() });
    writeCache('pgp_write_queue', this.writeQueue);
  }

  async processWriteQueue() {
    if (this.writeQueue.length === 0) return;
    console.log(`Processing ${this.writeQueue.length} queued writes...`);

    const remaining = [];
    for (const item of this.writeQueue) {
      try {
        if (item.action === 'addStudent') await ApiService.addStudent(item.data);
        else if (item.action === 'addLog') await ApiService.addLog(item.data);
        else if (item.action === 'addTGP') await ApiService.addTGP(item.data);
        else if (item.action === 'updateTGPStatus') await ApiService.updateTGPStatus(item.data.id, item.data.status);
        else if (item.action === 'updateStudentStatus') await ApiService.updateStudentStatus(item.data.id, item.data.status);
        else if (item.action === 'updateStudent') await ApiService.updateStudent(item.data);
        else if (item.action === 'removeStudent') await ApiService.removeStudent(item.data.id);
        console.log('Queued write sent:', item.action);
        // Add delay to prevent rate limiting from backend when processing large queues
        await new Promise(resolve => setTimeout(resolve, 800));
      } catch (err) {
        console.error('Queued write failed:', err);
        const errMsg = (err.message || err.toString()).toLowerCase();
        // Drop the item if it's a permanent error (like row not found) to prevent infinite loops
        if (errMsg.includes('not found')) {
          console.warn(`Dropping permanently failed write action: ${item.action}`);
        } else {
          item.retries = (item.retries || 0) + 1;
          if (item.retries > 5) {
            console.warn(`Dropping write action ${item.action} after 5 failed retries.`);
          } else {
            console.log('Keeping in queue for retry...');
            remaining.push(item);
          }
        }
      }
    }
    this.writeQueue = remaining;
    writeCache('pgp_write_queue', this.writeQueue);
  }

  // ════════════════════════════════════════════════════════════
  // STUDENT CRUD — Writes to Sheet + updates local cache
  // ════════════════════════════════════════════════════════════

  async addStudent(student) {
    // Upload image bytes first. Only the returned Blob URL is cached and sent to Sheets.
    if (student.photo instanceof Blob) {
      const filenameBase = student.pgp || student.studid || student.id;
      student.photo = await uploadPhotoLocally(filenameBase, student.photo);
    }

    // Add to local cache immediately
    this.students.push(student);
    writeCache('pgp_students', withoutInlinePhotos(this.students));

    // Write to Sheet
    const sheetData = this.mapStudentToSheet(student);
    try {
      await ApiService.addStudent(sheetData);
    } catch (err) {
      console.error('Failed to write student to Sheet, queuing...', err);
      await this.queueWrite('addStudent', sheetData);
    }
  }

  async removeStudent(id) {
    this.students = this.students.filter(s => s.id !== id);
    writeCache('pgp_students', withoutInlinePhotos(this.students));

    try {
      await ApiService.removeStudent(id);
    } catch (err) {
      console.error('Failed to remove student from Sheet, queuing...', err);
      await this.queueWrite('removeStudent', { id });
    }
  }

  getStudentByPassId(id) {
    return this.students.find(s => s.id === id || s.pgp === id);
  }

  getStudentByStudId(studid) {
    return this.students.find(s => s.studid === studid || s.id === studid);
  }

  async updateStudentStatus(id, status) {
    const student = this.students.find(s => s.id === id || s.pgp === id);
    if (student) {
      student.status = status;
      writeCache('pgp_students', withoutInlinePhotos(this.students));

      // Always send the pgp value (= PassID in Sheet) for reliable backend lookup
      const sheetId = student.pgp || student.id;
      try {
        await ApiService.updateStudentStatus(sheetId, status);
      } catch (err) {
        console.error('Failed to update status on Sheet, queuing...', err);
        await this.queueWrite('updateStudentStatus', { id: sheetId, status });
      }
    }
  }

  async updateStudent(updatedStudent) {
    const idx = this.students.findIndex(s => s.id === updatedStudent.id);
    if (idx === -1) return;

    // Upload image bytes first. Only the returned Blob URL is cached and sent to Sheets.
    if (updatedStudent.photo instanceof Blob) {
      const current = this.students[idx];
      const filenameBase = updatedStudent.pgp || current.pgp || updatedStudent.studid || current.studid || updatedStudent.id;
      updatedStudent.photo = await uploadPhotoLocally(filenameBase, updatedStudent.photo);
    }

    // Merge updates into local cache
    this.students[idx] = { ...this.students[idx], ...updatedStudent };
    writeCache('pgp_students', withoutInlinePhotos(this.students));

    // Write full row to Sheet
    const sheetData = this.mapStudentToSheet(this.students[idx]);


    try {
      await ApiService.updateStudent(sheetData);
    } catch (err) {
      console.error('Failed to update student on Sheet, queuing...', err);
      await this.queueWrite('updateStudent', sheetData);
    }
  }

  async archiveStudent(id) {
    await this.updateStudentStatus(id, 'archived');
  }

  // ════════════════════════════════════════════════════════════
  // EXIT LOG CRUD
  // ════════════════════════════════════════════════════════════

  async addExitLog(logEntry) {
    this.exitLogs.unshift(logEntry);
    writeCache('pgp_logs', this.exitLogs);

    try {
      await ApiService.addLog(logEntry);
    } catch (err) {
      console.error('Failed to write log to Sheet, queuing...', err);
      await this.queueWrite('addLog', logEntry);
    }
  }

  async clearLogs() {
    this.exitLogs = [];
    writeCache('pgp_logs', this.exitLogs);
  }

  // ════════════════════════════════════════════════════════════
  // EMAIL QUEUE
  // ════════════════════════════════════════════════════════════

  async addEmailToQueue(emailParams) {
    this.emailQueue.push(emailParams);
    writeCache('pgp_email_queue', this.emailQueue);
  }

  async removeEmailFromQueue(index) {
    this.emailQueue.splice(index, 1);
    writeCache('pgp_email_queue', this.emailQueue);
  }

  // ════════════════════════════════════════════════════════════
  // TGP CRUD
  // ════════════════════════════════════════════════════════════

  async addTGP(tgpEntry) {
    this.tgp.unshift(tgpEntry);
    writeCache('pgp_tgp', this.tgp);

    try {
      await ApiService.addTGP(tgpEntry);
    } catch (err) {
      console.error('Failed to write TGP to Sheet, queuing...', err);
      await this.queueWrite('addTGP', tgpEntry);
    }
  }

  async updateTGPStatus(id, status) {
    const pass = this.tgp.find(t => t.id === id);
    if (pass) {
      pass.status = status;
      writeCache('pgp_tgp', this.tgp);

      try {
        await ApiService.updateTGPStatus(id, status);
      } catch (err) {
        console.error('Failed to update TGP status on Sheet, queuing...', err);
        await this.queueWrite('updateTGPStatus', { id, status });
      }
    }
  }

  getTGP(id) {
    return this.tgp.find(t => t.id === id);
  }

  // ════════════════════════════════════════════════════════════
  // GATE CRUD
  // ════════════════════════════════════════════════════════════

  async addGate(gate) {
    this.gates.push(gate);
    writeCache('pgp_gates', this.gates);
    await ApiService.addGate(this.mapGateToSheet(gate));
  }

  async updateGate(gate) {
    const idx = this.gates.findIndex(g => g.id === gate.id);
    if (idx !== -1) this.gates[idx] = gate;
    writeCache('pgp_gates', this.gates);
    await ApiService.updateGate(this.mapGateToSheet(gate));
  }

  async removeGate(id) {
    this.gates = this.gates.filter(g => g.id !== id);
    writeCache('pgp_gates', this.gates);
    await ApiService.removeGate(id);
  }

  // ════════════════════════════════════════════════════════════
  // AUTHENTICATION — Supabase Auth
  // ════════════════════════════════════════════════════════════

  /**
   * Sign in. Supabase verifies the password and returns a signed JWT; the
   * API then resolves the role server-side from that token.
   *
   * The sheet-backed predecessor downloaded every user row — password hashes
   * included — and compared them in client JS, so any user could read the
   * whole table from DevTools and the role was whatever the client claimed.
   * The browser now never sees a hash and never decides its own role.
   */
  async authenticateUser(username, password) {
    // AuthService owns the whole exchange: it signs in, reads the profile row
    // keyed on the account id, and refuses an account with no profile or an
    // inactive one — cleaning up the session in either case, so a half
    // authenticated state cannot be left behind.
    const profile = await AuthService.signIn(username, password);

    const userPayload = {
      username: profile.username,
      name: profile.name,
      role: profile.role,
      gate: profile.gate || '',
      accountId: profile.accountId,
      loginTime: new Date().toISOString(),
      lastActivity: Date.now()
    };

    this.currentUser = userPayload;
    localStorage.setItem('pgp_session', JSON.stringify(userPayload));
    sessionStorage.setItem('pgp_browser_alive', '1');
    return userPayload;
  }

  /**
   * Re-establish the app-level user from a live Appwrite session.
   *
   * The cached pgp_session payload only drives what the UI draws. This is the
   * check that matters on load: if Appwrite no longer recognises the session,
   * the cached copy is stale and the user is signed out. Permissions are
   * enforced server-side regardless, so a tampered cache changes the menu and
   * nothing else.
   */
  async restoreSession() {
    let profile;
    try {
      profile = await AuthService.loadProfile();
    } catch (err) {
      // OfflineError. The cached session stands: a gate terminal that loses
      // its connection must keep scanning, and the queued writes flush when
      // it comes back. Only the server saying no ends a session.
      console.warn('[AppModel] Could not revalidate the session offline.', err);
      return this.currentUser;
    }

    if (!profile || String(profile.status).toLowerCase() !== 'active') {
      this.logout();
      return null;
    }

    const cached = readCache('pgp_session', {}) || {};
    const userPayload = {
      username: profile.username,
      name: profile.name,
      role: profile.role,
      gate: profile.gate || '',
      accountId: profile.accountId,
      loginTime: cached.loginTime || new Date().toISOString(),
      lastActivity: Date.now()
    };

    this.currentUser = userPayload;
    localStorage.setItem('pgp_session', JSON.stringify(userPayload));
    sessionStorage.setItem('pgp_browser_alive', '1');
    return userPayload;
  }

  login(userPayload) {
    userPayload.loginTime = new Date().toISOString();
    userPayload.lastActivity = Date.now();
    this.currentUser = userPayload;
    localStorage.setItem('pgp_session', JSON.stringify(userPayload));
    sessionStorage.setItem('pgp_browser_alive', '1');
  }

  logout() {
    this.currentUser = null;
    localStorage.removeItem('pgp_session');
    sessionStorage.removeItem('pgp_browser_alive');

    // Drop the Supabase tokens too, or the next sign-in would silently reuse
    // the previous user's session. Fire-and-forget: logout must not be able
    // to fail, least of all at a gate terminal with no connectivity.
    AuthService.signOut().catch(() => {});
  }

  // ── Theme / Sidebar / Session ─────────────────────────────
  getTheme() { return localStorage.getItem('pgp_theme') || null; }
  setTheme(theme) {
    if (theme) localStorage.setItem('pgp_theme', theme);
    else localStorage.removeItem('pgp_theme');
  }

  getSidebarCollapsed() { return localStorage.getItem('pgp_sidebar') === 'collapsed'; }
  setSidebarCollapsed(c) { localStorage.setItem('pgp_sidebar', c ? 'collapsed' : 'expanded'); }

  updateActivity() {
    if (!this.currentUser) return;
    this.currentUser.lastActivity = Date.now();
    localStorage.setItem('pgp_session', JSON.stringify(this.currentUser));
  }

  isSessionExpired() {
    if (!this.currentUser || !this.currentUser.lastActivity) return true;
    return (Date.now() - this.currentUser.lastActivity) > this.SESSION_TIMEOUT;
  }
}
