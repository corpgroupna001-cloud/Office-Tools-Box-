// Shared request helpers for the /api handlers: body parsing that never
// throws, the signed-in caller from a Supabase access token, a constant-time
// secret check, and a DNS lookup that refuses private network addresses
// (used by server-side fetches of user-supplied URLs).
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

/**
 * The Supabase user behind `Authorization: Bearer <access token>`, or null.
 * Asks Supabase Auth, so a forged or expired token is refused.
 */
async function sessionUser(req, env) {
  env = env || process.env;
  const token = bearer(req);
  const url = env.SUPABASE_URL, key = env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!token || !url || !key) return null;
  try {
    const r = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch { return null; }
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

/** dns.lookup that fails for anything but public addresses. Pass as `lookup` to http(s).request. */
function publicLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err);
    const list = (addrs || []).filter(x => isPublicAddress(x.address));
    if (!list.length || list.length !== addrs.length) {
      const e = new Error('Blocked address'); e.code = 'EBLOCKED'; return callback(e);
    }
    if (options && options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

module.exports = { readJson, safeEqual, bearer, sessionUser, isPublicAddress, publicLookup };
