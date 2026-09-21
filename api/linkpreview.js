// Link preview for chat — fetches a URL server-side (browsers can't, CORS)
// and returns its Open Graph title / description / image so the chat can
// render a little preview card under messages containing links.
//
// Signed-in callers only (Authorization: Bearer <Supabase access token>).
// Every connection, including each redirect hop, goes through publicLookup,
// which refuses loopback / private / link-local / CGNAT addresses at connect
// time, so neither a redirect nor a DNS name pointing inward reaches the
// internal network.
const http = require('http');
const https = require('https');
const net = require('net');
const { sessionUser, publicLookup, isPublicAddress } = require('../lib/request-auth');

const CACHE = new Map(); // url -> { at, data } per warm lambda

function pick(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');
}

/** GET one URL through the public-only lookup; follows up to 3 redirects itself. Resolves { status, ctype, html, finalUrl }. */
function fetchHead(startUrl, deadline) {
  return new Promise((resolve, reject) => {
    const go = (u, hops) => {
      if (Date.now() > deadline) return reject(new Error('timeout'));
      // Node skips `lookup` for IP literals, so check those here.
      const host = u.hostname.replace(/^\[|\]$/g, '');
      if (net.isIP(host) && !isPublicAddress(host)) return reject(new Error('blocked address'));
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(u, {
        method: 'GET', lookup: publicLookup, timeout: Math.max(500, deadline - Date.now()),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WorkSuiteBot/1.0; link preview)', 'Accept': 'text/html,application/xhtml+xml' },
      }, res => {
        const loc = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
          res.resume();
          if (hops >= 3) return reject(new Error('too many redirects'));
          let next; try { next = new URL(loc, u); } catch { return reject(new Error('bad redirect')); }
          if (!/^https?:$/.test(next.protocol)) return reject(new Error('bad redirect'));
          return go(next, hops + 1);
        }
        const ctype = String(res.headers['content-type'] || '');
        if (!ctype.includes('text/html')) { res.destroy(); return resolve({ status: res.statusCode, ctype, html: '', finalUrl: u }); }
        let html = '', got = 0;
        res.setEncoding('utf8');
        res.on('data', chunk => {
          got += chunk.length; html += chunk;
          // og tags live in <head>; read at most ~400 KB
          if (got >= 400_000 || html.includes('</head>')) { res.destroy(); resolve({ status: res.statusCode, ctype, html, finalUrl: u }); }
        });
        res.on('end', () => resolve({ status: res.statusCode, ctype, html, finalUrl: u }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    };
    go(startUrl, 0);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const raw = String(req.query.url || '');
  let url;
  try { url = new URL(raw); } catch { return res.status(400).json({ error: 'invalid url' }); }
  if (!/^https?:$/.test(url.protocol)) return res.status(400).json({ error: 'http/https only' });
  if (url.username || url.password) return res.status(400).json({ error: 'credentials in url' });

  if (!(await sessionUser(req))) return res.status(401).json({ error: 'Sign in to load link previews' });
  // Per-user responses: never let a shared cache keep them.
  res.setHeader('Cache-Control', 'private, max-age=1800');

  const cached = CACHE.get(url.href);
  if (cached && Date.now() - cached.at < 30 * 60_000) return res.status(200).json(cached.data);

  const fallback = { url: url.href, host: url.hostname, title: url.hostname, description: null, image: null };
  try {
    const r = await fetchHead(url, Date.now() + 6000);
    if (!r.html) { CACHE.set(url.href, { at: Date.now(), data: fallback }); return res.status(200).json(fallback); }
    const html = r.html;
    const og = (prop) => pick(html, [
      new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${prop}["']`, 'i'),
      new RegExp(`<meta[^>]+name=["']twitter:${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
    ]);

    let image = og('image');
    try { image = image ? new URL(decodeEntities(image), r.finalUrl).href : null; } catch { image = null; }
    if (image && !/^https?:/.test(image)) image = null;

    const data = {
      url: url.href,
      host: url.hostname,
      title: decodeEntities(og('title') || pick(html, [/<title[^>]*>([^<]+)<\/title>/i]) || url.hostname),
      description: decodeEntities(og('description') || pick(html, [/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i])),
      image
    };
    if (CACHE.size > 500) CACHE.clear();
    CACHE.set(url.href, { at: Date.now(), data });
    return res.status(200).json(data);
  } catch (e) {
    return res.status(200).json(fallback); // graceful — card just shows the domain
  }
};

module.exports.fetchHead = fetchHead;
