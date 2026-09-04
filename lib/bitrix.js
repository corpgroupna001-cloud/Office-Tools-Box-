/* ===========================================================================
 * Bitrix24 REST client
 *
 * Talks to an INBOUND WEBHOOK, whose URL is itself the credential:
 *     https://<portal>.bitrix24.com/rest/<user_id>/<secret>/<method>.json
 *
 * Bitrix's own documentation is blunt about this - "do not pass the webhook
 * URL to third parties or publish it in client-side code" - so the whole URL
 * lives in BITRIX_WEBHOOK_URL on the server and never reaches a browser. That
 * is also why posting to Bitrix from the attendance page goes through a
 * server route instead of being called directly from the page.
 *
 * Everything here FAILS SOFT. A punch that is stored, emailed and shown on
 * the calendar has done its job; if Bitrix is down, rate-limiting us, or
 * simply not configured yet, that must not turn into a 500 for the biometric
 * reader, which would make the vendor retry the whole batch.
 * =========================================================================== */

const TIMEOUT_MS = 4000;   // the punch handler has ~10s total and other work to do

/** The portal base, with exactly one trailing slash, or null if unset. */
function webhookBase() {
  const raw = String(process.env.BITRIX_WEBHOOK_URL || '').trim();
  if (!raw) return null;
  if (!/^https:\/\/[^/]+\/rest\/\d+\/[^/]+/.test(raw)) return null;
  return raw.replace(/\/+$/, '') + '/';
}

/** True when a webhook is configured. Cheap enough to call per punch. */
function isConfigured() {
  return webhookBase() !== null;
}

/**
 * A URL is safe to log only with the secret cut out of it. The secret is the
 * segment after /rest/<user_id>/.
 */
function redact(url) {
  return String(url || '').replace(/(\/rest\/\d+\/)[^/]+/, '$1***');
}

/**
 * One REST call. Never throws: the caller gets { ok, result } or
 * { ok: false, reason, detail }.
 */
async function call(method, params = {}) {
  const base = webhookBase();
  if (!base) {
    return { ok: false, reason: 'not_configured',
             detail: 'BITRIX_WEBHOOK_URL is not set, or is not a /rest/<id>/<secret>/ URL.' };
  }
  const url = `${base}${method}.json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = null; }

    if (!r.ok || !body) {
      return { ok: false, reason: 'http_' + r.status,
               detail: `${redact(url)} -> ${r.status} ${text.slice(0, 200)}` };
    }
    // Bitrix reports failures in the BODY with a 200 status as often as not.
    if (body.error) {
      return { ok: false, reason: body.error,
               detail: body.error_description || String(body.error) };
    }
    return { ok: true, result: body.result };
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
    return { ok: false, reason: aborted ? 'timeout' : 'network',
             detail: String((e && e.message) || e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Post into a workgroup chat.
 *
 * DIALOG_ID takes three shapes and only one of them is a group:
 *     "sgNN"   a workgroup / project chat   <- what we want
 *     "chatNN" an ordinary chat
 *     "123"    a person
 * A bare number would quietly direct-message user 14 instead of posting to
 * group 14, so anything without a prefix is normalised to sg.
 */
async function sendGroupMessage({ dialogId, message }) {
  const id = String(dialogId || '').trim();
  if (!id) return { ok: false, reason: 'no_dialog', detail: 'No group configured for this company.' };
  const dialog = /^(sg|chat)\d+$/i.test(id) ? id
               : /^\d+$/.test(id)          ? 'sg' + id
               : null;
  if (!dialog) {
    return { ok: false, reason: 'bad_dialog',
             detail: `"${id}" is not a group id. Expected sg14, chat14 or 14.` };
  }
  const text = String(message || '').trim();
  if (!text) return { ok: false, reason: 'empty', detail: 'Nothing to send.' };

  return call('im.message.add', { DIALOG_ID: dialog, MESSAGE: text.slice(0, 8000) });
}

/** The portal's workgroups, so the admin can pick from a list. */
async function listGroups() {
  const r = await call('sonet_group.get', { ORDER: { NAME: 'ASC' } });
  if (!r.ok) return r;
  const rows = Array.isArray(r.result) ? r.result : [];
  return { ok: true, result: rows.map(g => ({
    id: String(g.ID),
    dialog_id: 'sg' + g.ID,
    name: g.NAME,
    members: g.NUMBER_OF_MEMBERS != null ? Number(g.NUMBER_OF_MEMBERS) : null,
  })) };
}

/** Who the webhook acts as - the quickest proof that it works at all. */
async function whoAmI() {
  const r = await call('profile');
  if (!r.ok) return r;
  const p = r.result || {};
  return { ok: true, result: {
    id: p.ID, name: [p.NAME, p.LAST_NAME].filter(Boolean).join(' ') || p.LOGIN,
    admin: !!p.ADMIN, portal: (webhookBase() || '').split('/rest/')[0],
  } };
}

module.exports = { call, sendGroupMessage, listGroups, whoAmI, isConfigured, redact };
