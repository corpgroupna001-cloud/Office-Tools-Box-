// Link preview for chat — fetches a URL server-side (browsers can't, CORS)
// and returns its Open Graph title / description / image so the chat can
// render a little preview card under messages containing links.

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const raw = String(req.query.url || '');
  let url;
  try { url = new URL(raw); } catch { return res.status(400).json({ error: 'invalid url' }); }
  if (!/^https?:$/.test(url.protocol)) return res.status(400).json({ error: 'http/https only' });

  // Light SSRF guard — block obvious internal targets
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') ||
    /^(10\.|127\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '[::1]' || host.startsWith('[fc') || host.startsWith('[fd') || host.startsWith('[fe80')
  ) {
    return res.status(400).json({ error: 'blocked host' });
  }

  const cached = CACHE.get(url.href);
  if (cached && Date.now() - cached.at < 30 * 60_000) {
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json(cached.data);
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url.href, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WorkSuiteBot/1.0; link preview)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    clearTimeout(timer);
    const ctype = r.headers.get('content-type') || '';
    if (!ctype.includes('text/html')) {
      const data = { url: url.href, host: url.hostname, title: url.hostname, description: null, image: null };
      CACHE.set(url.href, { at: Date.now(), data });
      return res.status(200).json(data);
    }
    // Read at most ~400 KB — og tags live in <head>
    const reader = r.body.getReader();
    let html = '', got = 0;
    const dec = new TextDecoder();
    while (got < 400_000) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      html += dec.decode(value, { stream: true });
      if (html.includes('</head>')) break;
    }
    try { reader.cancel(); } catch {}

    const og = (prop) => pick(html, [
      new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${prop}["']`, 'i'),
      new RegExp(`<meta[^>]+name=["']twitter:${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
    ]);

    let image = og('image');
    if (image && image.startsWith('/')) image = url.origin + image;

    const data = {
      url: url.href,
      host: url.hostname,
      title: decodeEntities(og('title') || pick(html, [/<title[^>]*>([^<]+)<\/title>/i]) || url.hostname),
      description: decodeEntities(og('description') || pick(html, [/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i])),
      image
    };
    CACHE.set(url.href, { at: Date.now(), data });
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json(data);
  } catch (e) {
    const data = { url: url.href, host: url.hostname, title: url.hostname, description: null, image: null };
    return res.status(200).json(data); // graceful — card just shows the domain
  }
};
