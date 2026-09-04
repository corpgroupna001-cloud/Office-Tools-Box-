/* ===========================================================================
 * Admin: Bitrix24 group mapping
 *
 * Split out like admin/payroll.js, and for the same reasons: admin/index.html
 * is already ~2,900 lines, and this file owns its tab end to end - it listens
 * for tab clicks itself and shows/hides its own panel - so wiring it needed no
 * change to the switcher in the page.
 *
 * Nothing here ever sees the webhook URL. That is a credential and stays in
 * the Vercel environment; the page only ever asks the admin API to act.
 * =========================================================================== */
(function () {
    'use strict';

    let bxData = null;
    let bxLogs = null;

    /* ---- the delivery log ------------------------------------------------
     * Sends used to leave no trace outside Vercel's function log, so "did the
     * 09:31 punch actually reach the Jobways group?" was unanswerable from
     * here. Every send now goes through bitrix.sendAndLog and lands in
     * bitrix_log, successes included - a log that only records failures can't
     * tell silence apart from a system that was never asked to send.
     * -------------------------------------------------------------------- */

    const IST_STAMP = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short',
        hour: 'numeric', minute: '2-digit', hour12: true,
    });
    function stamp(iso) {
        const d = new Date(iso);
        return isNaN(d.getTime()) ? '\u2014' : IST_STAMP.format(d).replace(',', '');
    }
    function ago(iso) {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        const mins = Math.round((Date.now() - d.getTime()) / 60000);
        if (mins < 1)  return 'just now';
        if (mins < 60) return mins + 'm ago';
        const hrs = Math.round(mins / 60);
        if (hrs < 24)  return hrs + 'h ago';
        return Math.round(hrs / 24) + 'd ago';
    }

    const KIND = {
        punch: { label: 'Punch',  chip: 'info' },
        leave: { label: 'Leave',  chip: 'warn' },
        test:  { label: 'Test',   chip: '' },
    };

    // The stored reason is a machine token; an admin should not have to guess
    // what 'bad_dialog' means or which of the two ends is at fault.
    function reasonText(reason) {
        const r = String(reason || '');
        if (r === 'not_configured') return 'No webhook set in Vercel';
        if (r === 'no_dialog')      return 'No group mapped';
        if (r === 'bad_dialog')     return 'Group id not understood';
        if (r === 'empty')          return 'Nothing to send';
        if (r === 'timeout')        return 'Bitrix did not answer in time';
        if (r === 'network')        return 'Could not reach Bitrix';
        if (/^http_\d+$/.test(r))   return 'Bitrix replied ' + r.slice(5);
        return r || 'Failed';
    }

    const esc = s => (window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s));

    async function api(action, extra = {}) {
        const r = await fetch('/api/admin', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: adminPassword, action, ...extra }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.detail || data.error || 'Request failed');
        return data;
    }

    async function loadBitrix() {
        if (!adminPassword) return;
        const body = document.getElementById('bx-body');
        body.innerHTML = '<tr><td colspan="4" class="p-8 text-center text-slate-400 font-bold animate-pulse">Checking the connection…</td></tr>';
        try {
            bxData = await api('bitrix_status');
            renderBitrix();
        } catch (e) {
            document.getElementById('bx-conn').innerHTML =
                `<div class="ws-chip bad">Could not reach the admin API</div>`;
            body.innerHTML = `<tr><td colspan="4" class="p-8 text-center text-rose-300 font-bold">${esc(e.message)}</td></tr>`;
        }
    }

    function renderBitrix() {
        const d = bxData;
        if (!d) return;
        const conn = document.getElementById('bx-conn');

        if (!d.configured) {
            conn.innerHTML =
                `<div class="ws-chip warn">Not connected</div>` +
                `<p class="text-slate-400 text-xs font-bold mt-2 leading-relaxed max-w-2xl">${esc(d.detail)}<br>` +
                `In Bitrix24: <b>Developer resources &rarr; Other &rarr; Inbound webhook</b>, tick the <b>im</b> and <b>sonet_group</b> scopes, ` +
                `then paste the whole URL into Vercel as <b>BITRIX_WEBHOOK_URL</b> and redeploy.</p>`;
        } else if (d.connection && d.connection.ok) {
            conn.innerHTML =
                `<div class="ws-chip ok">Connected</div>` +
                `<span class="text-slate-300 text-xs font-bold ml-2">posts as ${esc(d.connection.name)}` +
                `${d.connection.portal ? ' on ' + esc(d.connection.portal.replace(/^https:\/\//, '')) : ''}</span>` +
                (d.groups_error
                    ? `<p class="text-amber-300 text-xs font-bold mt-2">Groups could not be listed (${esc(d.groups_error)}). ` +
                      `Add the <b>sonet_group</b> scope to the webhook, or type the group id by hand.</p>`
                    : '');
        } else {
            const c = d.connection || {};
            conn.innerHTML =
                `<div class="ws-chip bad">Webhook rejected</div>` +
                `<p class="text-rose-300 text-xs font-bold mt-2">${esc(c.reason || '')}: ${esc(c.detail || '')}</p>`;
        }

        // A datalist means the admin picks a real group instead of hunting for
        // a numeric id, but can still type one if the scope is missing.
        document.getElementById('bx-groups').innerHTML = (d.groups || [])
            .map(g => `<option value="${esc(g.dialog_id)}">${esc(g.name)}${g.members != null ? ` · ${g.members} members` : ''}</option>`)
            .join('');

        const rows = d.targets || [];
        document.getElementById('bx-body').innerHTML = rows.length ? rows.map(t => {
            const head = (d.headcount || {})[t.company] || 0;
            const named = (d.groups || []).find(g => g.dialog_id === t.dialog_id);
            return `
            <tr data-company="${esc(t.company)}">
                <td><b>${esc(t.company)}</b>
                    <div class="text-[11px] text-slate-400 font-bold">${head} employee${head === 1 ? '' : 's'}${t.label ? ' · ' + esc(t.label) : ''}</div></td>
                <td>
                    <input class="bx-dialog glass px-3 py-1.5 rounded-lg text-white font-bold w-40 focus:outline-none"
                           list="bx-groups" placeholder="not posting"
                           value="${esc(t.dialog_id || '')}">
                    ${named ? `<div class="text-[11px] text-emerald-300 font-bold mt-1">${esc(named.name)}</div>` : ''}
                </td>
                <td class="text-center">
                    <input type="checkbox" class="bx-enabled w-4 h-4" ${t.enabled ? 'checked' : ''}
                           ${t.dialog_id ? '' : 'disabled'} title="Pause without losing the mapping">
                </td>
                <td class="text-right">
                    <button type="button" class="bx-test glass px-3 py-1.5 rounded-lg text-xs font-black text-slate-300"
                            ${t.dialog_id ? '' : 'disabled style="opacity:.3"'}>Send test</button>
                </td>
            </tr>`;
        }).join('') : '<tr><td colspan="4" class="p-8 text-center text-slate-400 font-bold">No companies found.</td></tr>';
    }

    async function loadLogs() {
        if (!adminPassword) return;
        const body = document.getElementById('bx-log-body');
        body.innerHTML = '<tr><td colspan="6" class="p-8 text-center text-slate-400 font-bold animate-pulse">Reading the log\u2026</td></tr>';
        try {
            bxLogs = await api('bitrix_logs', {
                only_failures: document.getElementById('bx-log-fails').checked,
                limit: Number(document.getElementById('bx-log-limit').value) || 60,
            });
            renderLogs();
        } catch (e) {
            document.getElementById('bx-log-summary').innerHTML =
                `<div class="ws-chip bad">Could not read the log</div>`;
            body.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-rose-300 font-bold">${esc(e.message)}</td></tr>`;
        }
    }

    function renderLogs() {
        const d = bxLogs;
        if (!d) return;
        const sum  = document.getElementById('bx-log-summary');
        const body = document.getElementById('bx-log-body');

        // An empty table would read as "nothing was ever sent", which is a very
        // different thing from "the log table does not exist yet".
        if (d.unavailable) {
            sum.innerHTML =
                `<div class="ws-chip warn">Log not set up</div>` +
                `<p class="text-slate-400 text-xs font-bold mt-2 leading-relaxed max-w-2xl">${esc(d.detail || '')}<br>` +
                `Open <b>Supabase &rarr; SQL Editor</b>, paste <b>supabase-bitrix-log-migration.sql</b> from the repo and run it. ` +
                `Messages still send in the meantime \u2014 they just are not being written down.</p>`;
            body.innerHTML = '<tr><td colspan="6" class="p-8 text-center text-slate-400 font-bold">Nothing recorded yet.</td></tr>';
            return;
        }

        const s = d.summary || {};
        // null means the count query itself did not answer - which is not the
        // same as zero, and must not be printed as "0 sent" on a screen whose
        // whole job is telling the admin whether messages are getting through.
        const known  = s.last_24h != null && s.failures_24h != null;
        const failing = known && s.failures_24h > 0;
        sum.innerHTML =
            `<div class="flex flex-wrap items-center gap-2">` +
                (known
                    ? `<div class="ws-chip ${failing ? 'bad' : 'ok'}">${s.last_24h} sent in the last 24h` +
                          `${failing ? ` \u00b7 ${s.failures_24h} failed` : ''}</div>`
                    : `<div class="ws-chip warn">Could not count the last 24h</div>`) +
                (s.last_sent_at
                    ? `<span class="text-slate-300 text-xs font-bold">last success ${esc(stamp(s.last_sent_at))} (${esc(ago(s.last_sent_at))})</span>`
                    : `<span class="text-amber-300 text-xs font-bold">no successful send on record</span>`) +
                `<span class="text-slate-400 text-xs font-bold ml-auto">showing ${s.shown || 0} attempt${s.shown === 1 ? '' : 's'}</span>` +
            `</div>`;

        const rows = d.rows || [];
        if (!rows.length) {
            body.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-slate-400 font-bold">${
                document.getElementById('bx-log-fails').checked
                    ? 'No failures \u2014 every recent message went through.'
                    : 'Nothing sent yet.'
            }</td></tr>`;
            return;
        }

        body.innerHTML = rows.map((x, i) => {
            const k = KIND[x.kind] || { label: x.kind || '?', chip: '' };
            const named = (bxData && (bxData.groups || []).find(g => g.dialog_id === x.dialog_id)) || null;
            return `
            <tr class="bx-log-row cursor-pointer" data-i="${i}" title="Click to see the message that was sent">
                <td class="whitespace-nowrap"><b>${esc(stamp(x.created_at))}</b>
                    <div class="text-[11px] text-slate-400 font-bold">${esc(ago(x.created_at))}</div></td>
                <td><span class="ws-chip ${k.chip}">${esc(k.label)}</span></td>
                <td class="text-slate-300 font-bold">${esc(x.company || '\u2014')}</td>
                <td class="text-slate-300 font-bold">${esc(named ? named.name : (x.dialog_id || '\u2014'))}</td>
                <td>${x.ok
                    ? `<span class="text-emerald-300 font-black text-xs">Sent</span>`
                    : `<span class="text-rose-300 font-black text-xs">${esc(reasonText(x.reason))}</span>` +
                      (x.detail ? `<div class="text-[11px] text-slate-400 font-bold">${esc(x.detail)}</div>` : '')
                }</td>
                <td class="text-right text-slate-400 font-bold">${x.lines == null ? '\u2014' : x.lines}</td>
            </tr>
            <tr class="bx-log-msg hidden" data-for="${i}">
                <td colspan="6" class="p-0">
                    <pre class="m-3 p-3 rounded-xl text-[11px] text-slate-300 font-bold whitespace-pre-wrap"
                         style="background:rgba(255,255,255,0.04)">${esc(x.message || '(no message recorded)')}</pre>
                </td>
            </tr>`;
        }).join('');
    }

    // Admin has no showToast (the dashboard does), and a bare reference to an
    // undeclared identifier throws rather than reading as falsy - so typeof.
    function flash(tr, ok, note) {
        tr.style.transition = 'background .4s';
        tr.style.background = ok ? 'rgba(16,185,129,.18)' : 'rgba(244,63,94,.18)';
        setTimeout(() => { tr.style.background = ''; }, ok ? 700 : 1800);
        if (!note) return;
        if (typeof showToast === 'function') showToast(note, ok ? 'success' : 'error');
        else if (!ok) alert(note);
    }

    async function save(tr) {
        const company = tr.dataset.company;
        const dialog  = tr.querySelector('.bx-dialog').value.trim();
        const enabled = tr.querySelector('.bx-enabled').checked;
        try {
            const out = await api('bitrix_save', { company, dialog_id: dialog, enabled });
            const t = (bxData.targets || []).find(x => x.company === company);
            if (t && out.target) Object.assign(t, out.target);
            renderBitrix();
            flash(document.querySelector(`#bx-body tr[data-company="${CSS.escape(company)}"]`) || tr, true);
        } catch (e) {
            flash(tr, false, e.message);
        }
    }

    document.getElementById('bx-body').addEventListener('change', ev => {
        const tr = ev.target.closest('tr[data-company]');
        if (tr && (ev.target.classList.contains('bx-dialog') || ev.target.classList.contains('bx-enabled'))) save(tr);
    });
    document.getElementById('bx-body').addEventListener('click', async ev => {
        const btn = ev.target.closest('.bx-test');
        if (!btn || btn.disabled) return;
        const tr = btn.closest('tr[data-company]');
        const label = btn.textContent;
        btn.disabled = true; btn.textContent = 'Sending…';
        try {
            await api('bitrix_test', { dialog_id: tr.querySelector('.bx-dialog').value.trim() });
            flash(tr, true, 'Test message sent — check the group');
        } catch (e) {
            flash(tr, false, e.message);
        } finally {
            btn.disabled = false; btn.textContent = label;
            // Refresh either way: a REJECTED test is logged too, and that row
            // is the most useful thing on the screen when something is wrong.
            if (bxLogs) loadLogs();
        }
    });
    document.getElementById('bx-reload').addEventListener('click', () => loadBitrix());
    document.getElementById('bx-log-reload').addEventListener('click', () => loadLogs());
    document.getElementById('bx-log-fails').addEventListener('change', () => loadLogs());
    document.getElementById('bx-log-limit').addEventListener('change', () => loadLogs());
    document.getElementById('bx-log-body').addEventListener('click', ev => {
        const tr = ev.target.closest('.bx-log-row');
        if (!tr) return;
        const msg = document.querySelector(`#bx-log-body .bx-log-msg[data-for="${CSS.escape(tr.dataset.i)}"]`);
        if (msg) msg.classList.toggle('hidden');
    });

    document.querySelectorAll('.admin-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            document.getElementById('bitrix-panel').classList.toggle('hidden', tab !== 'bitrix');
            if (tab !== 'bitrix') return;
            // Status first: the log renders group NAMES by looking them up in
            // bxData.groups, and falls back to the raw id when it is not there.
            if (!bxData) loadBitrix().then(loadLogs);
            else if (!bxLogs) loadLogs();
        });
    });
})();
