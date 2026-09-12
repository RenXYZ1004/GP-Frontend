/**
 * Caller check for /api/upload-photo.
 *
 * It once also guarded /api/send-email and /api/mailer. Those moved to Cloud
 * Functions in the GP-Backend project, where they now sit behind a verified
 * Supabase session — the "real fix" this comment used to describe as pending.
 * Photo upload stayed on Vercel because the photos themselves live in Vercel
 * Blob, so this guard stayed with it.
 *
 * The endpoint sits on a public URL with nothing in front of it and writes
 * into the school's Blob store, so without a check anyone who knew the URL
 * could fill the storage quota. There is no server-side session on this side
 * of the app to check against, so what the guard can check without one is:
 *
 *   1. the request came from a page served by this same deployment, and
 *   2. one caller cannot hammer the endpoint.
 *
 * WHAT THIS IS NOT: authentication. A crafted request can set any Origin it
 * likes, and the rate limit lives in one lambda instance's memory, so it is
 * per-instance and resets on a cold start. This raises the cost of drive-by
 * and browser-based abuse; it does not make the endpoint private. Making it
 * private would mean having the browser send its Supabase token here too, and
 * verifying it the way the backend does.
 *
 * Origin handling is deliberately conservative so it cannot break a working
 * deployment: a request whose Origin/Referer is present but foreign is
 * rejected, while a request carrying neither header is allowed through and
 * only rate limited. Set STRICT_ORIGIN=1 in Vercel once you have confirmed
 * mail still sends, and the headerless case is rejected too.
 */

// requests per window, per client IP, per lambda instance.
// Bulk gate-pass delivery sends one request per student about twice a second,
// so the ceiling has to clear a whole school's worth of passes in one run.
const DEFAULT_LIMIT = 400;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;

const hits = new Map();

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function originOf(value) {
  const raw = clean(value);
  if (!raw) return '';
  try {
    return new URL(raw).origin;
  } catch (_) {
    return '';
  }
}

/**
 * Every origin this deployment accepts as its own.
 * The request's own Host is included, so preview URLs and any custom domain
 * the school later points at the project keep working with no config change.
 */
function allowedOrigins(req) {
  const list = new Set();

  const host = clean(req.headers && req.headers.host);
  if (host) {
    list.add(`https://${host}`);
    if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) list.add(`http://${host}`);
  }

  const configured = originOf(process.env.APP_BASE_URL);
  if (configured) list.add(configured);

  clean(process.env.ALLOWED_ORIGINS)
    .split(',')
    .map(entry => originOf(entry.trim()))
    .filter(Boolean)
    .forEach(entry => list.add(entry));

  return list;
}

function clientIp(req) {
  const forwarded = clean(req.headers && req.headers['x-forwarded-for']);
  if (forwarded) return forwarded.split(',')[0].trim();
  return clean(req.headers && req.headers['x-real-ip']) ||
    (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Drop expired buckets so a long-lived instance does not accumulate one entry
 * per IP it has ever seen.
 */
function sweep(now, windowMs) {
  for (const [key, bucket] of hits) {
    if (now - bucket.start > windowMs) hits.delete(key);
  }
}

function rateLimit(req, name, limit, windowMs) {
  const now = Date.now();
  if (hits.size > 500) sweep(now, windowMs);

  const key = `${name}:${clientIp(req)}`;
  const bucket = hits.get(key);

  if (!bucket || now - bucket.start > windowMs) {
    hits.set(key, { start: now, count: 1 });
    return { ok: true };
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    return { ok: false, retryAfter: Math.ceil((bucket.start + windowMs - now) / 1000) };
  }
  return { ok: true };
}

/**
 * Check one request. Returns { ok: true } when it may proceed, or
 * { ok: false, status, message } describing the refusal.
 *
 * @param {object}  req
 * @param {object} [options]
 * @param {string} [options.name]      bucket name, so one endpoint's traffic
 *                                     does not exhaust another's allowance
 * @param {number} [options.limit]     requests per window per IP
 * @param {number} [options.windowMs]  window length
 */
function checkRequest(req, options = {}) {
  const name = options.name || 'default';
  const limit = options.limit || DEFAULT_LIMIT;
  const windowMs = options.windowMs || DEFAULT_WINDOW_MS;

  const headers = (req && req.headers) || {};
  const origin = originOf(headers.origin) || originOf(headers.referer);
  const allowed = allowedOrigins(req);

  if (origin) {
    if (!allowed.has(origin)) {
      return {
        ok: false,
        status: 403,
        message: 'This endpoint only accepts requests from the e-gatepass site.'
      };
    }
  } else if (clean(process.env.STRICT_ORIGIN) === '1') {
    return {
      ok: false,
      status: 403,
      message: 'This endpoint only accepts requests from the e-gatepass site.'
    };
  }

  const limited = rateLimit(req, name, limit, windowMs);
  if (!limited.ok) {
    return {
      ok: false,
      status: 429,
      retryAfter: limited.retryAfter,
      message: `Too many requests. Try again in ${limited.retryAfter} seconds.`
    };
  }

  return { ok: true };
}

/**
 * Apply the check and, when it fails, write the refusal to the response.
 * Returns true when the caller should stop.
 */
function rejected(req, res, options) {
  const verdict = checkRequest(req, options);
  if (verdict.ok) return false;

  if (verdict.retryAfter) res.setHeader('Retry-After', String(verdict.retryAfter));
  res.status(verdict.status).json({ success: false, message: verdict.message, error: verdict.message });
  return true;
}

module.exports = { checkRequest, rejected, allowedOrigins, clientIp };
