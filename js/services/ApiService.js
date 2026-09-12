import { tablesDB, functions, DATABASE_ID, Query, describeError } from './appwrite.js';
import { FN_SUBMIT_APPLICATION } from '../config.js';
import AuthService from './AuthService.js';

// ════════════════════════════════════════════════════════════════
// ApiService — the data layer, talking to Appwrite directly
// ════════════════════════════════════════════════════════════════
// Method names carry over from the Apps Script client this replaced, so the
// ~24 call sites in AppModel and SettingsController did not move.
//
// There is no API of our own in between any more. Reads and writes go to
// Appwrite from the browser, and the table permissions in the backend's
// appwrite/schema.mjs decide what each role may do — checked by the server
// against team membership, not by the code below. A guard's browser can ask
// to delete a student; the request is refused.
//
// Row ids are the natural identifiers (a student's row id IS its PassID),
// which is why every write here is a direct addressed operation rather than a
// search-then-modify. It is also why a duplicate PassID is now impossible —
// the sheet's addRow appended unconditionally and put one student on four
// rows.
// ════════════════════════════════════════════════════════════════

export class AuthRequiredError extends Error {
  constructor(message) {
    super(message || 'Your session has expired. Please sign in again.');
    this.name = 'AuthRequiredError';
  }
}

// Appwrite caps a single listRows call well below the size of the student
// table, so every read pages. Left unpaged, the app would quietly show the
// first 25 students and look like it had lost the rest.
const PAGE_SIZE = 100;

/** Strip Appwrite's bookkeeping so views see only their own fields. */
function clean(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('$')) continue;
    out[key] = value === null || value === undefined ? '' : value;
  }
  return out;
}

function wrap(err) {
  if (err && (err.code === 401 || err.type === 'general_unauthorized_scope')) {
    return new AuthRequiredError();
  }
  return new Error(describeError(err));
}

/** Every row of a table, paged through with a cursor. */
async function listAll(tableId, queries = []) {
  const rows = [];
  let cursor = null;

  try {
    for (;;) {
      const page = await tablesDB.listRows({
        databaseId: DATABASE_ID,
        tableId,
        queries: [
          ...queries,
          Query.limit(PAGE_SIZE),
          ...(cursor ? [Query.cursorAfter(cursor)] : [])
        ]
      });

      const batch = page.rows ?? [];
      rows.push(...batch.map(clean));

      if (batch.length < PAGE_SIZE) break;
      cursor = batch[batch.length - 1].$id;
    }
  } catch (err) {
    throw wrap(err);
  }
  return rows;
}

async function upsert(tableId, rowId, data) {
  try {
    const row = await tablesDB.upsertRow({
      databaseId: DATABASE_ID,
      tableId,
      rowId: String(rowId),
      data
    });
    return clean(row);
  } catch (err) {
    throw wrap(err);
  }
}

async function patch(tableId, rowId, data) {
  try {
    const row = await tablesDB.updateRow({
      databaseId: DATABASE_ID,
      tableId,
      rowId: String(rowId),
      data
    });
    return clean(row);
  } catch (err) {
    throw wrap(err);
  }
}

async function drop(tableId, rowId) {
  try {
    await tablesDB.deleteRow({
      databaseId: DATABASE_ID,
      tableId,
      rowId: String(rowId)
    });
    return { deleted: rowId };
  } catch (err) {
    throw wrap(err);
  }
}

export default class ApiService {

  // ── Bulk fetch ────────────────────────────────────────────
  // One round trip per table, all in flight together. The Apps Script backend
  // fetched all five sheets sequentially.
  static async getAll() {
    const [students, scan_logs, temporary_passes, users, gates] = await Promise.all([
      this.getStudents(),
      this.getLogs(),
      this.getTGP(),
      this.getUsers(),
      this.getGates()
    ]);
    return { students, scan_logs, temporary_passes, users, gates };
  }

  // ── Students ──────────────────────────────────────────────
  static getStudents() {
    return listAll('students', [Query.orderAsc('PassID')]);
  }

  static addStudent(student) {
    return upsert('students', student.PassID, student);
  }

  static updateStudent(student) {
    // PassID is the row id; sending it as a field too is harmless and keeps
    // the record self-describing.
    return patch('students', student.PassID, student);
  }

  static updateStudentStatus(id, status) {
    return patch('students', id, { Status: status });
  }

  static removeStudent(id) {
    return drop('students', id);
  }

  // ── Scan Logs ─────────────────────────────────────────────
  static getLogs() {
    return listAll('scan_logs', [Query.orderDesc('timestamp')]);
  }

  static addLog(logEntry) {
    return upsert('scan_logs', logEntry.id, logEntry);
  }

  // ── Temporary Gate Passes ─────────────────────────────────
  static getTGP() {
    return listAll('temporary_passes', [Query.orderDesc('createdAt')]);
  }

  static addTGP(tgp) {
    return upsert('temporary_passes', tgp.id, tgp);
  }

  // The Apps Script client sent this as a GET, which meant a mutation on a
  // cacheable verb. Same method name, real update.
  static updateTGPStatus(id, status) {
    return patch('temporary_passes', id, { status });
  }

  // ── Users ─────────────────────────────────────────────────
  // Reads the profiles table. There is no password column to leak — Appwrite
  // Auth holds credentials, which is the hole this closed.
  static getUsers() {
    return listAll('profiles', [Query.orderAsc('username')]);
  }

  // ── Gates ─────────────────────────────────────────────────
  static getGates() {
    return listAll('gates', [Query.orderAsc('GateID')]);
  }

  static addGate(gate) {
    return upsert('gates', gate.GateID, gate);
  }

  static updateGate(gate) {
    return patch('gates', gate.GateID, gate);
  }

  static removeGate(id) {
    return drop('gates', id);
  }

  // ── Public application form ───────────────────────────────
  /**
   * The one call that runs as a function rather than a direct write.
   *
   * A parent is not signed in, and the Pass ID has to be allocated without
   * two simultaneous applications receiving the same number — neither of
   * which a browser can be trusted with.
   */
  static async submitApplication(application) {
    try {
      const execution = await functions.createExecution({
        functionId: FN_SUBMIT_APPLICATION,
        body: JSON.stringify(application),
        async: false,
        method: 'POST',
        headers: { 'content-type': 'application/json' }
      });

      try {
        return JSON.parse(execution.responseBody || '{}');
      } catch {
        throw new Error('The application server returned an unreadable response.');
      }
    } catch (err) {
      throw new Error(describeError(err));
    }
  }

  // ── Account maintenance ───────────────────────────────────
  static changePassword(oldPassword, newPassword) {
    return AuthService.changePassword(oldPassword, newPassword);
  }
}
