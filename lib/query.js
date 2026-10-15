'use strict';
/* ===========================================================================
 * Query-string access without url.parse()
 *
 * On Vercel, req.query is a lazy getter that builds itself the first time it
 * is read, with the legacy url.parse(req.url, true). On Node 24 that prints
 * DEP0169 ("url.parse() behavior is not standardized ...") to stderr, which
 * Vercel's log view shows as an Error on every cold start.
 *
 * queryOf() reads the same req.url with the WHATWG URL API instead, so the
 * result is the same data. A plain req.query value - the dev server and the
 * tests set one - is used as is, so nothing about local behaviour changes.
 * Repeated keys keep their last value; the app only ever reads single ones.
 * =========================================================================== */

const EMPTY = Object.freeze({});
const cache = new WeakMap();

function queryOf(req) {
  if (!req || typeof req !== 'object') return EMPTY;
  const d = Object.getOwnPropertyDescriptor(req, 'query');
  if (d && 'value' in d) return d.value && typeof d.value === 'object' ? d.value : EMPTY;
  if (cache.has(req)) return cache.get(req);
  let q = EMPTY;
  try {
    q = Object.fromEntries(new URL(String(req.url || '/'), 'http://localhost').searchParams);
  } catch { /* an unparseable url has no query */ }
  cache.set(req, q);
  return q;
}

/** One query parameter as a string, '' when absent. */
function queryParam(req, name) {
  const v = queryOf(req)[name];
  return v == null ? '' : String(Array.isArray(v) ? v[v.length - 1] : v);
}

module.exports = { queryOf, queryParam };
