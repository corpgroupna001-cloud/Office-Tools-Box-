// Signed admin sessions survive page refresh without storing the password in
// browser storage. Rotating ADMIN_PASSWORD or the service key invalidates them.
const crypto = require('node:crypto');
const COOKIE = 'ws_admin_session';
const TTL_SECONDS = 12 * 60 * 60;

function keyFor(env) {
  if (!env.ADMIN_PASSWORD || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return crypto.createHmac('sha256', env.SUPABASE_SERVICE_ROLE_KEY)
    .update('worksuite-admin-session-v1\0' + env.ADMIN_PASSWORD).digest();
}
function signature(value, key) {
  return crypto.createHmac('sha256', key).update(value).digest('base64url');
}
function equal(a, b) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function createSession(env, now = Date.now()) {
  const key = keyFor(env);
  if (!key) throw new Error('Admin session configuration missing');
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(now / 1000) + TTL_SECONDS, nonce: crypto.randomBytes(16).toString('hex'),
  })).toString('base64url');
  return `${payload}.${signature(payload, key)}`;
}
function validSession(cookieHeader, env, now = Date.now()) {
  const key = keyFor(env);
  if (!key) return false;
  const entry = String(cookieHeader || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  if (!entry) return false;
  const token = entry.slice(COOKIE.length + 1);
  if (token.length > 1024) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !equal(parts[1], signature(parts[0], key))) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    return Number.isInteger(payload.exp) && payload.exp > Math.floor(now / 1000);
  } catch { return false; }
}
function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${token ? TTL_SECONDS : 0}`;
}
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!req.headers.origin) return true; // non-browser clients can still use password auth
  try { return new URL(req.headers.origin).host === req.headers.host; }
  catch { return false; }
}
module.exports = { createSession, validSession, sessionCookie, sameOrigin, TTL_SECONDS };
