/* ===========================================================================
 * Admin: attendance tools - email delivery check, attendance-day recompute
 *
 * Split out like admin/bitrix.js: this file owns the two cards at the bottom
 * of the Attendance tab end to end and listens for the tab click itself, so
 * the switcher in admin/index.html needed no change.
 *
 * Nothing here sees a password, a mailbox password or a webhook: the page
 * only ever asks the admin API to check or to act.
 * =========================================================================== */
(function () {
    'use strict';

    const esc = s => (window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s));
    const $ = id => document.getElementById(id);

    async function api(action, extra = {}) {
        const r = await fetch('/api/admin', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: adminPassword, action, ...extra }),
        });
        const data = await r.json();
        if (!r.ok) {
            const err = new Error(data.detail || data.error || 'Request failed');
            err.code = data.error || '';
            throw err;
        }
        return data;
    }

    /* ---- email ------------------------------------------------------- */
    let mailData = null;

    const MAIL_REASON = {
        smtp_not_configured:    'SMTP_HOST / SMTP_PASS are not set in Vercel',
        sender_not_configured:  'mailbox env var not set in Vercel',
        email_coming_soon:      'no mailbox provisioned yet',
        unknown_company:        'company not in the mailbox table (lib/mailer.js)',
        no_company:             'no company',
        smtp_send_failed:       'the mail server refused it',
        no_recipient:           'no email address on the profile',
    };

    async function loadMail() {
        if (!adminPassword) return;
        const box = $('mail-status');
        try {
            mailData = await api('mail_status');
        } catch (e) {
            box.innerHTML = `<div class="ws-chip bad">Could not check the mail setup</div>` +
                            `<p class="text-rose-300 text-xs font-bold mt-2">${esc(e.message)}</p>`;
            return;
        }
        const d = mailData;
        const smtpOk = d.smtp && d.smtp.host && d.smtp.pass;
        const t = (d.last7 && d.last7.tally) || {};
        const sent = t.sent || 0, failed = t.failed || 0, pending = t.pending || 0;
        const reasons = Object.entries((d.last7 && d.last7.failure_reasons) || {});
        box.innerHTML =
            `<div class="flex flex-wrap items-center gap-2 mb-3">` +
                (smtpOk ? `<div class="ws-chip ok">SMTP configured</div>`
                        : `<div class="ws-chip bad">SMTP not configured</div>`) +
                `<div class="ws-chip ${failed ? 'bad' : 'info'}">last 7 days: ${sent} sent` +
                    `${failed ? ` · ${failed} failed` : ''}${pending ? ` · ${pending} pending` : ''}</div>` +
                (t.unmapped ? `<span class="text-slate-400 text-xs font-bold">${t.unmapped} from unmapped codes (no one to email)</span>` : '') +
                (t.skipped ? `<span class="text-slate-400 text-xs font-bold">${t.skipped} skipped (old, or bound after the fact)</span>` : '') +
            `</div>` +
            (reasons.length
                ? `<p class="text-rose-300 text-xs font-bold mb-3">Failures: ${reasons.map(([k, n]) => `${esc(k)} (${n})`).join(', ')}</p>`
                : '') +
            `<div class="flex flex-wrap gap-2">` +
            (d.companies || []).map(c => {
                const chip = c.ok ? 'ok' : (c.reason === 'email_coming_soon' ? 'warn' : 'bad');
                const why = c.ok ? esc(c.from) : esc(MAIL_REASON[c.reason] || c.detail || c.reason || 'cannot send');
                return `<div class="glass rounded-xl px-3 py-2" title="${esc(c.detail || '')}">` +
                       `<div class="flex items-center gap-2"><span class="ws-chip ${chip}">${c.ok ? 'Can send' : (c.reason === 'email_coming_soon' ? 'Coming soon' : 'Cannot send')}</span>` +
                       `<b class="text-slate-200 text-xs">${esc(c.company)}</b>` +
                       `<span class="text-slate-500 text-[11px] font-bold">${c.people} people</span></div>` +
                       `<div class="text-[11px] text-slate-400 font-bold mt-1">${c.env ? esc(c.env) + ' · ' : ''}${why}</div>` +
                       `</div>`;
            }).join('') +
            `</div>`;

        const sel = $('mail-test-company');
        const cur = sel.value;
        sel.innerHTML = (d.companies || []).filter(c => c.ok || c.people)
            .map(c => `<option value="${esc(c.company)}"${c.company === cur ? ' selected' : ''}>${esc(c.company)}</option>`).join('');
    }

    $('mail-test-send').addEventListener('click', async () => {
        const btn = $('mail-test-send'), out = $('mail-test-result');
        const to = $('mail-test-to').value.trim();
        const company = $('mail-test-company').value;
        if (!to) { out.className = 'text-xs font-bold text-amber-300'; out.textContent = 'Type the address to send to.'; return; }
        btn.disabled = true; out.className = 'text-xs font-bold text-slate-400'; out.textContent = 'Sending…';
        try {
            const r = await api('mail_test', { to, company });
            out.className = 'text-xs font-bold text-emerald-300';
            out.textContent = `Sent from ${r.from} — check ${to} (and its spam folder).`;
        } catch (e) {
            out.className = 'text-xs font-bold text-rose-300';
            out.textContent = `${MAIL_REASON[e.code] || e.code || 'Failed'}: ${e.message}`;
        } finally { btn.disabled = false; }
    });

    /* ---- attendance-day recompute ------------------------------------ */
    let lastCheck = null;

    function istToday() {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    }
    function daysAgo(n) {
        const d = new Date(istToday() + 'T12:00:00+05:30'); d.setUTCDate(d.getUTCDate() - n);
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    }
    const IST_T = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    const EV = { LOGIN: 'Login', BREAK_OUT: 'Break out', BREAK_IN: 'Break in', LOGOUT: 'Logout' };
    const label = x => `${x.log_date.slice(5)} · ${x.direction} · ${EV[x.event_type] || x.event_type || '—'}`;

    async function runRecompute(apply) {
        const out = $('recompute-result');
        const from = $('recompute-from').value || daysAgo(14);
        const to = $('recompute-to').value || istToday();
        $('recompute-check').disabled = true; $('recompute-apply').disabled = true;
        out.className = 'text-xs font-bold text-slate-400'; out.textContent = apply ? 'Applying…' : 'Checking…';
        try {
            const r = await api('att_recompute', { from, to, apply });
            lastCheck = r;
            if (apply) {
                out.className = 'text-xs font-bold ' + (r.failed ? 'text-rose-300' : 'text-emerald-300');
                out.textContent = `Relabelled ${r.patched} punch${r.patched === 1 ? '' : 'es'}` +
                    (r.failed ? `, ${r.failed} failed` : '') +
                    (r.remaining ? ` — ${r.remaining} more to go, run Apply again` : '') + '.';
                // The report above is now stale; its own Refresh button knows how to reload it.
                const refresh = $('att-refresh');
                if (refresh) refresh.click();
            } else {
                out.className = 'text-xs font-bold ' + (r.changes ? 'text-amber-300' : 'text-emerald-300');
                out.textContent = r.changes
                    ? `${r.changes} of ${r.scanned} punches (${r.people} people) would change.`
                    : `All ${r.scanned} punches already follow the current rules.`;
            }
            const wrap = $('recompute-sample'), tb = $('recompute-tbody');
            const sample = r.sample || [];
            wrap.classList.toggle('hidden', !sample.length);
            tb.innerHTML = sample.map(c => `
                <tr>
                    <td class="font-mono text-slate-300">${esc(c.employee_code || '—')}</td>
                    <td class="text-slate-200 font-bold whitespace-nowrap">${esc(IST_T.format(new Date(c.log_datetime)).replace(',', ''))}</td>
                    <td class="text-rose-300 font-bold">${esc(label(c.before))}</td>
                    <td class="text-emerald-300 font-bold">${esc(label(c.after))}</td>
                </tr>`).join('');
            const canApply = !apply && r.changes > 0;
            $('recompute-apply').disabled = !canApply;
            $('recompute-apply').style.opacity = canApply ? '' : '.4';
        } catch (e) {
            out.className = 'text-xs font-bold text-rose-300';
            out.textContent = e.message;
        } finally {
            $('recompute-check').disabled = false;
        }
    }
    $('recompute-check').addEventListener('click', () => runRecompute(false));
    $('recompute-apply').addEventListener('click', () => {
        if (!lastCheck || !lastCheck.changes) return;
        runRecompute(true);
    });

    /* ---- wiring ------------------------------------------------------- */
    let loaded = false;
    document.querySelectorAll('.admin-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.tab !== 'attendance' || loaded || !adminPassword) return;
            loaded = true;
            if (!$('recompute-from').value) $('recompute-from').value = daysAgo(14);
            if (!$('recompute-to').value) $('recompute-to').value = istToday();
            loadMail();
        });
    });
})();
