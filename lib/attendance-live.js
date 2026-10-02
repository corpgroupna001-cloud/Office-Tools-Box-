// @ts-check
// Which punches count (F-04). An approved "wrong time" correction adds the
// right punch and marks the wrong one superseded_by it: the device's own
// record is kept as evidence, but no day, report or payroll counts it.
//
// liveFilter() is the PostgREST filter every read that builds days appends:
// '&superseded_by=is.null' once supabase-attendance-corrections-migration.sql
// has added the column, '' before it (every punch counts, as before). It asks
// once per server instance.
'use strict';

/** @type {Map<string, Promise<string>>} */
const cache = new Map();

/**
 * @param {{ url?: string, key?: string, request?: typeof fetch }} db
 * @returns {Promise<string>}
 */
function liveFilter({ url, key, request = fetch }) {
  if (!url || !key) return Promise.resolve('');
  const hit = cache.get(url);
  if (hit) return hit;
  const p = (async () => {
    try {
      const r = await request(`${url}/rest/v1/attendance_logs?select=superseded_by&limit=0`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
      if (r.ok) return '&superseded_by=is.null';
      if (r.status === 400) return '';                 // no such column yet
      throw new Error(`probe answered ${r.status}`);
    } catch {
      cache.delete(url);                                // ask again next time
      return '';
    }
  })();
  cache.set(url, p);
  return p;
}

module.exports = { liveFilter, _cache: cache };
