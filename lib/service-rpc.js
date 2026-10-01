// @ts-check
// Calling a database function with the service key, for the /api handlers.
//
//   const r = await rpc('ws_rate_hit', { p_key, p_window_seconds, p_max }, { url, key });
//   r.ok      the function ran (HTTP 2xx)
//   r.data    what it returned
//   r.missing the function does not exist yet (its migration has not run)
//   r.status / r.error  otherwise
//
// It never throws: a network failure is { ok: false, status: 0 }, so callers
// decide explicitly whether to refuse (codes, sign-ups) or carry on.

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {{ url?: string, key?: string, request?: typeof fetch }} opts
 * @returns {Promise<{ ok: boolean, status: number, data?: any, error?: string, missing?: boolean }>}
 */
async function rpc(name, args, { url, key, request = fetch }) {
  if (!url || !key) return { ok: false, status: 0, error: 'Supabase server config missing' };
  let r;
  try {
    r = await request(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {}),
    });
  } catch (e) {
    return { ok: false, status: 0, error: (e && e.message) || 'network error' };
  }
  const text = await r.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (r.ok) return { ok: true, status: r.status, data };
  const code = data && typeof data === 'object' ? data.code : '';
  return {
    ok: false, status: r.status,
    error: (data && typeof data === 'object' && (data.message || data.hint)) || String(text).slice(0, 200),
    missing: code === 'PGRST202' || code === '42883',
  };
}

module.exports = { rpc };
