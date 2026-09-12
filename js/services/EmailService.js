import { functions, describeError } from './appwrite.js';
import { FN_SEND_EMAIL } from '../config.js';
import AuthService from './AuthService.js';

// ════════════════════════════════════════════════════════════════
// EmailService — parent notifications
// ════════════════════════════════════════════════════════════════
// Runs as a function because it holds the school's Gmail credentials, which
// must never reach a browser.
//
// The Vercel version guarded itself with an Origin header check and said so
// plainly: that "is not authentication ... The real fix is a signed caller
// token, which needs a change to how the client authenticates." This sends a
// short-lived Appwrite JWT, which the function verifies — so the endpoint
// that can put mail in a parent's inbox from the school's address now demands
// a real session.
// ════════════════════════════════════════════════════════════════

async function execute(payload) {
  // Functions cannot see the session cookie, so identity travels as a JWT the
  // browser mints per call.
  let jwt;
  try {
    jwt = await AuthService.jwt();
  } catch {
    // Surfaced rather than swallowed: the caller queues the email and retries
    // after the next sign-in, instead of silently dropping a parent alert.
    throw new Error('Your session has expired — sign in again to send email.');
  }

  let execution;
  try {
    execution = await functions.createExecution({
      functionId: FN_SEND_EMAIL,
      body: JSON.stringify(payload),
      async: false,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-appwrite-jwt': jwt
      }
    });
  } catch (err) {
    throw new Error(describeError(err));
  }

  let result = null;
  try { result = JSON.parse(execution.responseBody || '{}'); } catch { /* below */ }

  if (!result || !result.success) {
    // `error` carries the specific reason — Google's own text on a refusal —
    // while `message` is the generic "Email could not be sent." Preferring
    // `message` meant every failure looked identical and the real cause never
    // reached the screen.
    throw new Error(
      (result && (result.error || result.message)) ||
      'Email could not be sent.'
    );
  }
  return result;
}

export default class EmailService {
  /**
   * Send one parent notification.
   * @param {object} params - the message body the backend has always taken
   * @returns {Promise<object>} the backend's success payload
   * @throws {Error} carrying the most specific reason available
   */
  static send(params) {
    return execute(params);
  }

  /**
   * Ask whether mail *could* be sent, without sending any.
   *
   * "Email is broken" has several distinct causes — an expired refresh token,
   * a token minted against the wrong mailbox, missing configuration — and
   * this separates them without bothering a parent.
   */
  static check() {
    return execute({ selftest: true }).catch((err) => ({
      success: false,
      message: err.message
    }));
  }
}
