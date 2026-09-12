import {
  APPWRITE_ENDPOINT,
  APPWRITE_PROJECT_ID,
  APPWRITE_DATABASE_ID
} from '../config.js';

// ════════════════════════════════════════════════════════════════
// appwrite.js — the shared client
// ════════════════════════════════════════════════════════════════
// The SDK is vendored at js/lib/appwrite.js and loaded by a plain <script>
// tag before js/main.js, exactly as jsQR and face-api already are. It exposes
// window.Appwrite. That keeps the app buildless and offline-installable: a
// CDN import would break both.
// ════════════════════════════════════════════════════════════════

if (!window.Appwrite) {
  throw new Error(
    'The Appwrite SDK did not load. js/lib/appwrite.js must be included ' +
    'with a <script> tag before js/main.js.'
  );
}

export const {
  Client,
  Account,
  TablesDB,
  Teams,
  Functions,
  Query,
  ID,
  Permission,
  Role,
  AppwriteException
} = window.Appwrite;

export const client = new Client()
  .setEndpoint(APPWRITE_ENDPOINT)
  .setProject(APPWRITE_PROJECT_ID);

export const account = new Account(client);
export const tablesDB = new TablesDB(client);
export const teams = new Teams(client);
export const functions = new Functions(client);

export const DATABASE_ID = APPWRITE_DATABASE_ID;

/**
 * Turn an SDK error into something worth showing a person.
 *
 * Appwrite's own messages are accurate but written for developers; the ones
 * below are the cases staff actually hit at a gate terminal.
 */
export function describeError(err) {
  if (!err) return 'Something went wrong.';

  if (err instanceof AppwriteException) {
    if (err.code === 401) return 'Your session has expired. Please sign in again.';
    if (err.code === 403) return 'You do not have permission to do that.';
    if (err.code === 404) return 'That record no longer exists.';
    if (err.code === 409) return 'That record already exists.';
    if (err.code === 429) return 'Too many requests. Please wait a moment.';
    return err.message;
  }

  // A failed fetch with no response is almost always the network, not us.
  if (err.name === 'TypeError' && /fetch/i.test(err.message || '')) {
    return 'Cannot reach the server. Check your connection.';
  }
  return err.message || String(err);
}
