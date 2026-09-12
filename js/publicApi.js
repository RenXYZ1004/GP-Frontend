import {
  APPWRITE_ENDPOINT,
  APPWRITE_PROJECT_ID,
  APPWRITE_DATABASE_ID,
  FN_SUBMIT_APPLICATION,
  FN_SUBMIT_TGP
} from './config.js';

// ════════════════════════════════════════════════════════════════
// publicApi.js — the two forms parents fill in
// ════════════════════════════════════════════════════════════════
// newForm.html and tgpForm.html are open to anyone and are reached from the
// landing page. Neither visitor is signed in, and neither may write to the
// database directly — the table permissions see to that, which is the point.
// Both post to an Appwrite function instead, and the function decides.
//
// Deliberately plain fetch rather than the Appwrite SDK: these pages are
// loaded by parents on phones, and the SDK is 540 KB for what amounts to one
// POST. The execution endpoint is simple enough to call directly.
// ════════════════════════════════════════════════════════════════

/**
 * Run an Appwrite function and return what it answered.
 *
 * Two layers of failure to keep apart: the execution itself failing (network,
 * unknown function), and the function running fine but reporting a problem
 * with the submission. Only the first is thrown as a transport error; the
 * second is the function's own JSON, handed back for the form to render.
 */
async function execute(functionId, payload) {
  const url = `${String(APPWRITE_ENDPOINT).replace(/\/$/, '')}` +
    `/functions/${functionId}/executions`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Appwrite-Project': APPWRITE_PROJECT_ID
      },
      body: JSON.stringify({
        body: JSON.stringify(payload),
        async: false,
        method: 'POST',
        headers: { 'content-type': 'application/json' }
      })
    });
  } catch (_) {
    throw new Error(
      'Could not reach the server. Check your internet connection and try again.'
    );
  }

  let execution;
  try {
    execution = await response.json();
  } catch (_) {
    throw new Error(
      'The server sent a reply the form could not read. Please try again, ' +
      'or contact the school office.'
    );
  }

  if (!response.ok) {
    // Appwrite's own refusal — an unknown function id, or the project not
    // allowing this origin.
    throw new Error(
      execution && execution.message
        ? execution.message
        : `The server returned HTTP ${response.status}. Please try again.`
    );
  }

  // A function that crashed leaves responseBody empty and puts the reason in
  // its logs, which a parent cannot see and should not be shown.
  if (!execution.responseBody) {
    throw new Error(
      'The server could not process the form. Please try again, or contact ' +
      'the school office.'
    );
  }

  try {
    return JSON.parse(execution.responseBody);
  } catch (_) {
    throw new Error(
      'The server sent a reply the form could not read. Please try again, ' +
      'or contact the school office.'
    );
  }
}

/** Permanent gatepass application. Answers { success, passId, message, duplicate }. */
export function submitApplication(data) {
  return execute(FN_SUBMIT_APPLICATION, data);
}

/** Temporary pass request. Answers { success, id, message, duplicate }. */
export function submitTGP(data) {
  return execute(FN_SUBMIT_TGP, data);
}

/**
 * The gates a visitor may pick from, active ones only.
 *
 * Read straight from the table rather than through a function: the gates
 * table is readable by anyone, because a gate name is painted on a sign at
 * the entrance. Both forms fall back to their hard-coded list if this fails,
 * so it never blocks an application.
 *
 * @returns {Promise<string[]>} gate names, or [] if none are configured
 */
export async function listGates() {
  // The route is /tablesdb/…, not /databases/… — the latter is the older
  // collections API and answers 404 here. The SDK builds this itself; this
  // file hand-rolls it to avoid loading 540 KB on a parent's phone.
  const url = `${String(APPWRITE_ENDPOINT).replace(/\/$/, '')}` +
    `/tablesdb/${APPWRITE_DATABASE_ID}/tables/gates/rows`;

  const res = await fetch(url, {
    headers: { 'X-Appwrite-Project': APPWRITE_PROJECT_ID },
    cache: 'no-store'
  });
  if (!res.ok) throw new Error(`Gates unavailable (HTTP ${res.status}).`);

  const body = await res.json();
  return (body.rows ?? [])
    .filter((g) => String(g.Status || 'active').toLowerCase() === 'active')
    .map((g) => g.GateName)
    .filter(Boolean);
}
