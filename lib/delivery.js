// @ts-check
// The delivery retry queue (supabase-delivery-queue-migration.sql, F-06).
//
//   enqueue(db, job)                   one job per idempotency key; asking again finds the first
//   runDue(db, transports, opts)       claim what is due, send each through its channel, record the outcome
//   classify(channel, out)             { ok, permanent, error } from a transport's answer
//
// A transport is `async payload => ({ ok, reason?, detail?, statusCode? })`:
// sendMail for email, a Bitrix post, a web push. Each job is one message on
// one channel, so a failing channel never holds up the others. Nothing here
// sends anything by itself; the callers hand in the transports (and tests
// hand in mocks).
'use strict';

const { rpc } = require('./service-rpc');

/** Email reasons that sending again cannot fix (lib/mailer.js); an administrator fixes the cause and retries. */
const EMAIL_PERMANENT = new Set(['no_recipient', 'bad_recipient', 'bad_reply_to', 'no_subject', 'no_body', 'no_email',
  'no_company', 'unknown_company', 'email_coming_soon', 'sender_not_configured', 'smtp_not_configured']);
/** Bitrix answers worth trying again (lib/bitrix.js reasons and Bitrix's own error codes). */
const BITRIX_TRANSIENT = new Set(['timeout', 'network', 'deadline', 'error', 'http_429', 'QUERY_LIMIT_EXCEEDED',
  'INTERNAL_SERVER_ERROR', 'OVERLOAD_LIMIT', 'OPERATION_TIME_LIMIT']);

/**
 * @param {string} channel
 * @param {any} out
 * @returns {{ ok: boolean, permanent: boolean, error: string | null }}
 */
function classify(channel, out) {
  if (out && out.ok) return { ok: true, permanent: false, error: null };
  // A company with no Bitrix group: nothing to deliver to. Done, with a note, rather than a failure to review.
  if (channel === 'bitrix' && out && out.reason === 'no_group') return { ok: true, permanent: false, error: 'no_group: no Bitrix group for this company, nothing to send' };
  const reason = String((out && out.reason) || 'error');
  const detail = String((out && out.detail) || '');
  const error = `${reason}${detail ? ': ' + detail : ''}`.slice(0, 1000);
  let permanent;
  if (channel === 'email') {
    // An SMTP 5xx reply is the server refusing this message for good; anything else (timeouts, 4xx, TLS) may pass later.
    permanent = EMAIL_PERMANENT.has(reason) || (reason === 'smtp_send_failed' && /(^|\D)5\d\d[ -]/.test(detail));
  } else if (channel === 'bitrix') {
    permanent = !(BITRIX_TRANSIENT.has(reason) || /^http_5\d\d$/.test(reason));
  } else if (channel === 'push') {
    const code = Number(out && out.statusCode);
    permanent = reason === 'no_subscription' || code === 400 || code === 404 || code === 410 || code === 413;
  } else permanent = true;
  return { ok: false, permanent, error };
}

/**
 * @typedef {{ url?: string, key?: string, request?: typeof fetch }} Db
 * @typedef {{ key: string, channel: 'email'|'bitrix'|'push', kind: string, payload: any, company?: string|null,
 *             source_table?: string|null, source_id?: string|number|null, attempts?: number, error?: string|null,
 *             dead?: boolean, expires_at?: string|null, max_attempts?: number }} Job
 */

/**
 * Queue a message. `attempts`/`error`/`dead` record a first attempt the caller already made.
 * @param {Db} db
 * @param {Job} job
 * @returns {Promise<{ ok: boolean, missing?: boolean, job?: any, created?: boolean }>}
 */
async function enqueue(db, job) {
  const r = await rpc('ws_delivery_enqueue', {
    p_key: job.key, p_channel: job.channel, p_kind: job.kind, p_payload: job.payload || {},
    p_company: job.company || null, p_source_table: job.source_table || null,
    p_source_id: job.source_id == null ? null : String(job.source_id),
    p_attempts: job.attempts || 0, p_error: job.error || null, p_dead: !!job.dead,
    p_expires_at: job.expires_at || null, p_max_attempts: job.max_attempts || 5,
  }, db);
  if (!r.ok) return { ok: false, missing: !!r.missing };
  return { ok: true, job: r.data, created: !!(r.data && r.data.created) };
}

/** Record a first attempt's outcome: nothing to queue when it went out. */
async function recordFirstAttempt(db, job, out) {
  const c = classify(job.channel, out);
  if (c.ok) return { ok: true, queued: false };
  const q = await enqueue(db, { ...job, attempts: 1, error: c.error, dead: c.permanent });
  return { ok: q.ok, missing: q.missing, queued: q.ok, permanent: c.permanent, job: q.job };
}

/**
 * Send one message now, through the queue: queued once per key, then claimed
 * and sent here. A key that was queued before is not sent again
 * ({ duplicate: true }). Before migration 24 ({ missing: true }) the caller
 * sends the old way.
 * @param {Db} db
 * @param {Job} job
 * @param {(payload: any, job: any) => Promise<any>} send
 */
async function deliverNow(db, job, send) {
  const q = await enqueue(db, job);
  if (!q.ok) return { missing: !!q.missing, sent: false };
  if (!q.created) return { duplicate: true, sent: q.job && q.job.status === 'sent', status: q.job && q.job.status };
  const c = await rpc('ws_delivery_claim', { p_limit: 1, p_lease_seconds: 60, p_id: q.job.id }, db);
  const claimed = c.ok && Array.isArray(c.data) ? c.data[0] : null;
  if (!claimed) return { queued: true, sent: false };          // someone else took it; it goes out once either way
  let out;
  try { out = await send(claimed.payload || {}, claimed); }
  catch (e) { out = { ok: false, reason: 'error', detail: String((e && e.message) || e).slice(0, 300) }; }
  const cl = classify(job.channel, out);
  const r = await rpc('ws_delivery_result', { p_id: claimed.id, p_attempt: claimed.attempts, p_ok: cl.ok, p_error: cl.error, p_permanent: cl.permanent }, db);
  return { sent: cl.ok, out, status: r.ok && r.data ? r.data.status : null };
}

/**
 * Send what is due. Claims a few jobs at a time while there is time left, and
 * sends each through its channel's transport. `onResult(job, outcome)` writes
 * the result back where the message came from (an attendance row's status).
 * @param {Db} db
 * @param {Record<string, (payload: any, job: any) => Promise<any>>} transports
 * @param {{ deadlineAt?: number, batch?: number, maxJobs?: number, leaseSeconds?: number, concurrency?: number,
 *           onResult?: (job: any, outcome: any) => Promise<void> | void, now?: () => number }} [opts]
 */
async function runDue(db, transports, opts = {}) {
  const now = opts.now || Date.now;
  const deadlineAt = opts.deadlineAt || now() + 15000;
  const batch = opts.batch || 4, maxJobs = opts.maxJobs || 40;
  const report = { available: true, claimed: 0, sent: 0, failed: 0, dead: 0, stale: 0, stopped_at_budget: false };
  while (report.claimed < maxJobs) {
    if (now() >= deadlineAt) { report.stopped_at_budget = true; break; }
    const c = await rpc('ws_delivery_claim', { p_limit: Math.min(batch, maxJobs - report.claimed), p_lease_seconds: opts.leaseSeconds || 120 }, db);
    if (!c.ok) { report.available = false; /** @type {any} */ (report).missing = !!c.missing; break; }
    const jobs = Array.isArray(c.data) ? c.data : [];
    if (!jobs.length) break;
    report.claimed += jobs.length;
    // The channels of one batch go out side by side: a slow mail server does not hold up a Bitrix line.
    await Promise.all(jobs.map(async job => {
      const send = transports[job.channel];
      let out;
      try { out = send ? await send(job.payload || {}, job) : { ok: false, reason: 'no_transport', detail: `nothing sends ${job.channel} here` }; }
      catch (e) { out = { ok: false, reason: 'error', detail: String((e && e.message) || e).slice(0, 300) }; }
      const cl = classify(job.channel, out);
      if (out && out.reason === 'no_transport') cl.permanent = true;
      const r = await rpc('ws_delivery_result', { p_id: job.id, p_attempt: job.attempts, p_ok: cl.ok, p_error: cl.error, p_permanent: cl.permanent }, db);
      const after = r.ok ? r.data : null;
      const status = after ? after.status : (cl.ok ? 'sent' : 'failed');
      if (after && after.stale) report.stale++;
      if (status === 'sent') report.sent++; else if (status === 'dead') report.dead++; else report.failed++;
      if (opts.onResult) {
        try { await opts.onResult(job, { ...cl, status, attempts: job.attempts, out }); } catch { /* bookkeeping only */ }
      }
    }));
  }
  return report;
}

module.exports = { classify, enqueue, recordFirstAttempt, deliverNow, runDue, EMAIL_PERMANENT, BITRIX_TRANSIENT };
