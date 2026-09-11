// ICE servers for WebRTC calls, handed to a signed-in browser by GET /api/ice.
//
// STUN (free, public) finds the direct path between two browsers, which works
// for most home and office networks. Behind strict corporate firewalls or
// symmetric NATs the media has to be relayed through a TURN server, so the
// credentials for one come from whichever provider is configured, first match
// wins. All three have a free option (SETUP.md, "Calls"):
//
//   Cloudflare Realtime TURN   CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN
//   Metered (Open Relay)       METERED_TURN_DOMAIN + METERED_TURN_API_KEY
//   Your own coturn            TURN_URLS + TURN_SECRET (time-limited REST credentials)
//                              or TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL (static)
//
// Credentials are short-lived and fetched per user, so a leaked browser copy
// expires on its own. A provider that fails falls through to the next one and
// finally to STUN only: a call on an open network still connects.
'use strict';
const crypto = require('node:crypto');

const STUN = { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] };
const DEFAULT_TTL = 12 * 3600;
const CACHE = new Map();                  // userId -> { at, value }: one warm function instance reuses a fresh answer
const CACHE_MS = 10 * 60 * 1000;

function splitUrls(s) {
  return String(s || '').split(/[\s,]+/).map(x => x.trim()).filter(Boolean);
}

/** coturn's "TURN REST API" (use-auth-secret): username = expiry:user, credential = base64(HMAC-SHA1(secret, username)). */
function coturnCredentials(secret, userId, ttlSec, nowSec) {
  const username = `${Math.floor(nowSec) + ttlSec}:${userId}`;
  const credential = crypto.createHmac('sha1', String(secret)).update(username).digest('base64');
  return { username, credential };
}

/**
 * Normalise a provider's answer into a clean RTCIceServer[]: accepts an array
 * or a single object, drops entries without urls, and drops port-53 URLs,
 * which browsers refuse to use.
 */
function normalise(list) {
  const arr = Array.isArray(list) ? list : (list && typeof list === 'object' ? [list] : []);
  const out = [];
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls || s.url]).filter(u => typeof u === 'string' && /^(stun|turns?):/i.test(u))
      .filter(u => !/:53(\?|$)/.test(u));
    if (!urls.length) continue;
    const entry = { urls };
    if (s.username) entry.username = String(s.username);
    if (s.credential) entry.credential = String(s.credential);
    out.push(entry);
  }
  return out;
}

const hasRelay = servers => servers.some(s => s.urls.some(u => /^turns?:/i.test(u)) && s.username && s.credential);

async function cloudflare(env, ttl, fetchImpl) {
  const key = env.CLOUDFLARE_TURN_KEY_ID, token = env.CLOUDFLARE_TURN_API_TOKEN;
  if (!key || !token) return null;
  const base = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(key)}/credentials`;
  const opts = { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl }) };
  // generate-ice-servers answers an RTCIceServer[]; the older generate endpoint a single object.
  for (const path of ['/generate-ice-servers', '/generate']) {
    const r = await fetchImpl(base + path, opts);
    if (!r.ok) continue;
    const servers = normalise((await r.json()).iceServers);
    if (servers.length) return servers;
  }
  return null;
}

async function metered(env, fetchImpl) {
  const domain = String(env.METERED_TURN_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!domain || !env.METERED_TURN_API_KEY) return null;
  const r = await fetchImpl(`https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(env.METERED_TURN_API_KEY)}`);
  if (!r.ok) return null;
  const servers = normalise(await r.json());
  return servers.length ? servers : null;
}

function ownServer(env, userId, ttl, nowSec) {
  const urls = splitUrls(env.TURN_URLS);
  if (!urls.length) return null;
  let username = env.TURN_USERNAME, credential = env.TURN_CREDENTIAL;
  if (env.TURN_SECRET) ({ username, credential } = coturnCredentials(env.TURN_SECRET, userId, ttl, nowSec));
  if (!username || !credential) return null;
  return normalise([{ urls, username, credential }]);
}

/**
 * iceServersFor(userId, env?, { fetchImpl, now }?) ->
 *   { iceServers: RTCIceServer[], ttl, relay: boolean, provider: 'cloudflare'|'metered'|'coturn'|'static'|'stun' }
 */
async function iceServersFor(userId, env = process.env, { fetchImpl = globalThis.fetch, now = Date.now, cache = true } = {}) {
  const ttl = Math.min(Math.max(Number(env.TURN_TTL_SECONDS) || DEFAULT_TTL, 600), 48 * 3600);
  const hit = cache && CACHE.get(userId);
  if (hit && now() - hit.at < CACHE_MS) return hit.value;

  const attempts = [
    ['cloudflare', () => cloudflare(env, ttl, fetchImpl)],
    ['metered', () => metered(env, fetchImpl)],
    [env.TURN_SECRET ? 'coturn' : 'static', async () => ownServer(env, userId, ttl, now() / 1000)],
  ];
  let value = null;
  for (const [provider, get] of attempts) {
    try {
      const servers = await get();
      if (servers && servers.length) {
        // Keep public STUN alongside a provider that only returned TURN.
        const withStun = servers.some(s => s.urls.some(u => /^stun:/i.test(u))) ? servers : [STUN, ...servers];
        value = { iceServers: withStun, ttl, relay: hasRelay(servers), provider };
        break;
      }
    } catch { /* try the next provider */ }
  }
  value = value || { iceServers: [STUN], ttl, relay: false, provider: 'stun' };
  if (cache && value.provider !== 'stun') CACHE.set(userId, { at: now(), value });
  return value;
}

module.exports = { iceServersFor, coturnCredentials, normalise, STUN };
