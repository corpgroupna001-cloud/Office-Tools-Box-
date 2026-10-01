// @ts-check
// Shared request helpers for the /api handlers: body parsing that never
// throws, the signed-in caller from a Supabase access token (held to the same
// rules as the database's session gate), a constant-time secret check, and a
// DNS lookup that refuses private network addresses (used by server-side
// fetches of user-supplied URLs).
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');

/** The JSON body, or null when it is not valid JSON. */
function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) { try { const v = JSON.parse(req.body); return v && typeof v === 'object' ? v : null; } catch { return null; } }
  return {};
}

/** Constant-time comparison; hashing first makes the lengths equal. */
function safeEqual(a, b) {
  if (a == null || b == null || a === '' || b === '') return false;
  const h = v => crypto.createHash('sha256').update(String(v)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

function bearer(req) {
  return String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '').trim();
}

/** The claims inside a JWT, unverified: use only for a token Supabase Auth has just accepted. */
function tokenClaims(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); }
  catch { return null; }
}

/**
 * Who a Supabase access token belongs to, held to the same rules as the
 * database's session gate (supabase-access-control-migration.sql):
 *   - Supabase Auth accepts the token: signature, expiry, and a session that
 *     has not been signed out or ended;
 *   - an account with an authenticator app has done the second step (aal2);
 *   - the account is active (not pending approval, not offboarded).
 * -> { user, reason }: reason is null when allowed, else 'signed_out',
 *    'mfa_required', 'pending', 'inactive', 'no_profile' or 'unavailable'
 *    (the status could not be read: refused rather than guessed).
 * @param {string} token
 * @param {{ url?: string, key?: string, serviceKey?: string, request?: typeof fetch }} [opts]
 * @returns {Promise<{ user: any, reason: string | null }>}
 */
async function verifyToken(token, { url, key, serviceKey, request = fetch } = {}) {
  if (!token || !url || !key) return { user: null, reason: 'signed_out' };
  let user;
  try {
    const r = await request(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
    if (!r.ok) return { user: null, reason: 'signed_out' };
    user = await r.json();
  } catch { return { user: null, reason: 'signed_out' }; }
  if (!user || !user.id) return { user: null, reason: 'signed_out' };
  // Supabase Auth has just accepted this very token, so its claims can be read.
  const claims = tokenClaims(token) || {};
  if (claims.sub && claims.sub !== user.id) return { user: null, reason: 'signed_out' };
  const enrolled = (user.factors || []).some(f => f && f.status === 'verified');
  if (enrolled && claims.aal !== 'aal2') return { user: null, reason: 'mfa_required' };
  if (serviceKey) {
    try {
      const r = await request(`${url}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=status&limit=1`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
      if (!r.ok) return { user: null, reason: 'unavailable' };
      const [p] = /** @type {any[]} */ (await r.json());
      if (!p) return { user: null, reason: 'no_profile' };
      const status = p.status || 'active';
      if (status !== 'active') return { user: null, reason: status };
    } catch { return { user: null, reason: 'unavailable' }; }
  }
  return { user, reason: null };
}

/** HTTP status and body for a refused token, the same wording on every endpoint. */
function accessError(reason) {
  const MESSAGES = {
    signed_out: 'Your session has expired. Sign in again.',
    mfa_required: 'Enter the code from your authenticator app to continue.',
    pending: 'Your account is waiting for an administrator to approve it.',
    inactive: 'This account is no longer active.',
    no_profile: 'This account has no WorkSuite profile.',
    unavailable: 'Could not confirm your account right now. Try again in a moment.',
  };
  const status = reason === 'signed_out' ? 401 : reason === 'unavailable' ? 503 : 403;
  return { status, body: { error: reason === 'signed_out' ? 'not_signed_in' : 'ws_access:' + reason, message: MESSAGES[reason] || MESSAGES.signed_out } };
}

/**
 * verifyToken for `Authorization: Bearer <access token>` with the server's own configuration.
 * @param {any} req
 * @param {Record<string, string | undefined>} [env]
 * @param {typeof fetch} [request]
 */
async function sessionAccess(req, env, request = fetch) {
  env = env || process.env;
  return verifyToken(bearer(req), {
    url: env.SUPABASE_URL,
    key: env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    request,
  });
}

/**
 * The allowed Supabase user behind the request, or null (see verifyToken).
 * @param {any} req
 * @param {Record<string, string | undefined>} [env]
 * @param {typeof fetch} [request]
 */
async function sessionUser(req, env, request = fetch) {
  return (await sessionAccess(req, env, request)).user;
}

/** True for addresses on the public internet (not loopback, private, link-local, CGNAT, multicast, reserved). */
function isPublicAddress(ip) {
  if (!ip) return false;
  let a = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) || a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    a = mapped.length === 2 ? mapped[1]
      : [parseInt(mapped[1], 16) >> 8, parseInt(mapped[1], 16) & 255, parseInt(mapped[2], 16) >> 8, parseInt(mapped[2], 16) & 255].join('.');
  }
  if (net.isIPv4(a)) {
    const [x, y] = a.split('.').map(Number);
    if (x === 0 || x === 10 || x === 127 || x >= 224) return false;
    if (x === 169 && y === 254) return false;
    if (x === 172 && y >= 16 && y <= 31) return false;
    if (x === 192 && y === 168) return false;
    if (x === 100 && y >= 64 && y <= 127) return false;       // CGNAT
    if (x === 192 && y === 0) return false;                    // 192.0.0.0/24, 192.0.2.0/24
    if (x === 198 && (y === 18 || y === 19)) return false;     // benchmarking
    return true;
  }
  if (net.isIPv6(a)) {
    if (a === '::' || a === '::1') return false;
    if (/^f[cd]/.test(a)) return false;                        // fc00::/7 unique local
    if (/^fe[89ab]/.test(a)) return false;                     // fe80::/10 link local
    if (/^ff/.test(a)) return false;                           // multicast
    if (/^::ffff:/.test(a) || /^64:ff9b:/.test(a) || /^2001:db8:/.test(a)) return false;
    return true;
  }
  return false;
}

/**
 * dns.lookup that fails for anything but public addresses. Pass as `lookup` to http(s).request.
 * @param {string} hostname
 * @param {any} options
 * @param {Function} [callback]
 */
function publicLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  dns.lookup(hostname, { ...options, all: true }, (err, /** @type {any} */ addrs) => {
    if (err) return callback(err);
    const list = (addrs || []).filter(x => isPublicAddress(x.address));
    if (!list.length || list.length !== addrs.length) {
      const e = /** @type {Error & { code?: string }} */ (new Error('Blocked address')); e.code = 'EBLOCKED'; return callback(e);
    }
    if (options && options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

/** The caller's address as Vercel reports it (for rate limits; never for trust decisions). */
function clientIp(req) {
  const h = (req && req.headers) || {};
  const fwd = String(h['x-forwarded-for'] || '').split(',')[0].trim();
  return String(h['x-real-ip'] || fwd || (req.socket && req.socket.remoteAddress) || 'unknown').slice(0, 64);
}

module.exports = { readJson, safeEqual, bearer, tokenClaims, verifyToken, accessError, sessionAccess, sessionUser, clientIp, isPublicAddress, publicLookup };
