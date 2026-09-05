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
    let bxHooks = null;
    // Per-employee test results, by enroll number, so a re-render (Recheck)
    // does not wipe what the admin just learned. { ok, title, hint, match }
    const hookResults = new Map();

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

    /* The stored reason is a machine token - ours ('no_dialog') or Bitrix's
     * ('CANCELED'). Neither tells an admin what to go and do, so each one gets
     * a plain sentence and, where there is a concrete next step, a hint. */
    const REASONS = {
        not_configured: ['No webhook set in Vercel',
            'Add BITRIX_WEBHOOK_URL in Vercel and redeploy.'],
        no_dialog:      ['No group mapped',
            'Pick a group for this company above.'],
        bad_dialog:     ['Group id not understood', 'Expected something like sg14.'],
        empty:          ['Nothing to send', ''],
        timeout:        ['Bitrix did not answer in time',
            'Usually a slow portal. Try the test again.'],
        network:        ['Could not reach Bitrix',
            'Check the portal address in BITRIX_WEBHOOK_URL.'],
        // Bitrix's own codes. CANCELED is the one this setup hits first, and
        // its wording ("You cannot send messages to the specified chat") sends
        // people hunting through webhook scopes when the real cause is
        // membership: a webhook posts AS a user, and that user has to be in
        // the workgroup. sonet_group.get lists groups they can SEE, which is
        // not the same as groups they can post to - hence picking a listed
        // group and still being refused.
        CANCELED:       ['Not allowed to post in that group', 'MEMBERSHIP'],
        ACCESS_DENIED:  ['Not allowed to post in that group', 'MEMBERSHIP'],
        ERROR_CORE:     ['Bitrix refused the message', 'MEMBERSHIP'],
        INVALID_CHAT_ID:['No such chat', 'That group id does not exist on the portal.'],
        CHAT_ID_EMPTY:  ['No chat id sent', ''],
        NO_AUTH_FOUND:  ['Webhook not recognised',
            'The webhook was deleted or regenerated in Bitrix. Make a new one and update Vercel.'],
        INVALID_CREDENTIALS: ['Webhook not recognised',
            'The webhook was deleted or regenerated in Bitrix. Make a new one and update Vercel.'],
        expired_token:  ['Webhook expired', 'Create a fresh inbound webhook and update Vercel.'],
        insufficient_scope: ['Webhook is missing a permission',
            'Tick both Chat and Notifications (im) and Workgroups (sonet_group) on the webhook.'],
        QUERY_LIMIT_EXCEEDED: ['Bitrix rate limit hit',
            'About two requests a second is the ceiling. Wait a moment and retry.'],
        // Per-employee webhook tests.
        not_set:        ['Not set', 'Add BITRIX_HOOK_<enroll> in Vercel and redeploy.'],
        not_a_webhook_url: ['Not a webhook URL',
            'The value must look like https://<portal>.bitrix24.in/rest/<id>/<secret>/.'],
        bad_enroll:     ['Bad enroll number', ''],
    };
    function reasonText(reason) {
        const r = String(reason || '');
        if (REASONS[r]) return REASONS[r][0];
        if (/^http_\d+$/.test(r)) return 'Bitrix replied ' + r.slice(5);
        return r || 'Failed';
    }
    function reasonHint(reason) {
        const h = (REASONS[String(reason || '')] || [])[1] || '';
        if (h !== 'MEMBERSHIP') return h;
        // Name the actual account, so the admin knows who to add.
        const who = (bxData && bxData.connection && bxData.connection.name) || 'the webhook user';
        return `A webhook posts as a person, and ${who} is not a member of that workgroup. ` +
               `Open the group in Bitrix24, add ${who} to it, then test again.`;
    }

    const esc = s => (window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s));

    async function api(action, extra = {}) {
        const r = await fetch('/api/admin', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: adminPassword, action, ...extra }),
        });
        const data = await r.json();
        if (!r.ok) {
            // Keep the machine code alongside the prose: the code is what the
            // reason table can translate into a next step.
            const err = new Error(data.detail || data.error || 'Request failed');
            err.code = data.error || '';
            throw err;
        }
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
                `In Bitrix24: <b>Developer resources &rarr; Other &rarr; Inbound webhook</b>, tick <b>Chat and Notifications (im)</b> and ` +
                `<b>Workgroups (sonet_group)</b>, ` +
                `then paste the whole URL into Vercel as <b>BITRIX_WEBHOOK_URL</b> and redeploy.</p>`;
        } else if (d.connection && d.connection.ok) {
            conn.innerHTML =
                `<div class="ws-chip ok">Connected</div>` +
                `<span class="text-slate-300 text-xs font-bold ml-2">posts as ${esc(d.connection.name)}` +
                `${d.connection.portal ? ' on ' + esc(d.connection.portal.replace(/^https:\/\//, '')) : ''}</span>` +
                (d.groups_error
                    ? `<p class="text-amber-300 text-xs font-bold mt-2">Chats could not be listed (${esc(d.groups_error)}). ` +
                      `Add the <b>im</b> scope to the webhook, or type the id by hand.</p>`
                    : `<p class="text-slate-400 text-xs font-bold mt-2 leading-relaxed max-w-2xl">` +
                      `The menu lists the chats and workgroups <b>${esc(d.connection.name)}</b> belongs to \u2014 those are the ones ` +
                      `it can post to. Anything under \u201cNot joined\u201d will be refused until you add them to it in Bitrix24.</p>`);
        } else {
            const c = d.connection || {};
            conn.innerHTML =
                `<div class="ws-chip bad">Webhook rejected</div>` +
                `<p class="text-rose-300 text-xs font-bold mt-2">${esc(c.reason || '')}: ${esc(c.detail || '')}</p>`;
        }

        const rows = d.targets || [];
        document.getElementById('bx-body').innerHTML = rows.length ? rows.map(t => {
            const head = (d.headcount || {})[t.company] || 0;
            return `
            <tr data-company="${esc(t.company)}">
                <td><b>${esc(t.company)}</b>
                    <div class="text-[11px] text-slate-400 font-bold">${head} employee${head === 1 ? '' : 's'}${t.label ? ' · ' + esc(t.label) : ''}</div></td>
                <td>${groupPicker(t, d.groups || [])}</td>
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

    /* A datalist put the ID first, because that is how a browser renders
     * <option value="sg15">Guess the Technology</option> - so the menu read as
     * a column of sg-numbers and picking the right group meant already knowing
     * its number. A <select> shows the NAME, which is the only part a person
     * actually knows.
     *
     * The options are split in two because those halves behave differently.
     * The first half is what im.recent.get returned: conversations this
     * webhook is a participant of, which is exactly what im.message.add will
     * accept. The second half is workgroups it has not joined - still offered,
     * because an admin may be about to add it, but posting to one of those
     * comes back CANCELED, and a menu that hid that difference is what sent
     * the last attempt at "Guess the Technology". */
    function groupPicker(t, groups) {
        const cls = 'bx-dialog glass px-3 py-1.5 rounded-lg text-white font-bold focus:outline-none';
        const manual = t.dialog_id && !groups.some(g => g.dialog_id === t.dialog_id);
        if (!groups.length || t._manual) {
            // No list to choose from, or the admin asked to type one. An empty
            // menu would be worse than a text box.
            return `<input class="${cls} w-44" placeholder="chat287 or sg14" value="${esc(t.dialog_id || '')}">`;
        }
        const opt = g => `<option value="${esc(g.dialog_id)}"${g.dialog_id === t.dialog_id ? ' selected' : ''}>` +
            `${esc(g.name)}${g.members != null ? ` (${g.members})` : ''}</option>`;
        const inGroup = groups.filter(g => g.joined !== false);
        const outGroup = groups.filter(g => g.joined === false);
        return `<select class="${cls} w-64">` +
               `<option value=""${t.dialog_id ? '' : ' selected'}>— not posting —</option>` +
               (inGroup.length ? `<optgroup label="Can post here">${inGroup.map(opt).join('')}</optgroup>` : '') +
               (outGroup.length ? `<optgroup label="Not joined — will be refused">${outGroup.map(opt).join('')}</optgroup>` : '') +
               // A saved id missing from both lists must keep its own option,
               // or the next save would silently blank the mapping.
               (manual ? `<option value="${esc(t.dialog_id)}" selected>${esc(t.dialog_id)} — not in either list</option>` : '') +
               `<option value="__manual__">Type an id by hand…</option>` +
               `</select>` +
               (t.dialog_id ? `<div class="text-[11px] text-slate-400 font-bold mt-1">${esc(t.dialog_id)}</div>` : '');
    }

    /* This used to fall back to alert(), which threw a browser modal carrying a
     * raw URL and a JSON blob at the admin - unreadable, and a modal blocks the
     * page until it is dismissed. The panel has room to say it properly. */
    function notice(ok, title, hint) {
        const el = document.getElementById('bx-notice');
        if (!el) return;
        if (!title) { el.innerHTML = ''; return; }
        el.innerHTML =
            `<div class="glass rounded-2xl p-4 mb-4">` +
                `<div class="ws-chip ${ok ? 'ok' : 'bad'}">${esc(title)}</div>` +
                (hint ? `<p class="text-slate-300 text-xs font-bold mt-2 leading-relaxed max-w-2xl">${esc(hint)}</p>` : '') +
            `</div>`;
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function flash(tr, ok) {
        tr.style.transition = 'background .4s';
        tr.style.background = ok ? 'rgba(16,185,129,.18)' : 'rgba(244,63,94,.18)';
        setTimeout(() => { tr.style.background = ''; }, ok ? 700 : 1800);
    }

    async function save(tr) {
        const company = tr.dataset.company;
        const raw = tr.querySelector('.bx-dialog').value.trim();
        // The escape hatch is a menu entry, not a value: swap the row for a
        // text box and save nothing until something is actually typed.
        if (raw === '__manual__') {
            const t = (bxData.targets || []).find(x => x.company === company);
            if (t) { t._manual = true; renderBitrix();
                     const el = document.querySelector(`#bx-body tr[data-company="${CSS.escape(company)}"] .bx-dialog`);
                     if (el) el.focus(); }
            return;
        }
        const dialog  = raw;
        const enabled = tr.querySelector('.bx-enabled').checked;
        try {
            const out = await api('bitrix_save', { company, dialog_id: dialog, enabled });
            const t = (bxData.targets || []).find(x => x.company === company);
            if (t && out.target) Object.assign(t, out.target);
            renderBitrix();
            notice(null, '');
            flash(document.querySelector(`#bx-body tr[data-company="${CSS.escape(company)}"]`) || tr, true);
        } catch (e) {
            flash(tr, false);
            notice(false, 'Could not save that mapping', e.message);
        }
    }

    /* ---- per-employee webhooks -----------------------------------------
     * One Vercel env var, BITRIX_HOOK_<enroll>, per person. The API tells us
     * only whether each is set (and looks like a URL) - never the URL itself.
     * ------------------------------------------------------------------- */
    async function loadHooks() {
        if (!adminPassword) return;
        const body = document.getElementById('bx-hooks-body');
        body.innerHTML = '<tr><td colspan="6" class="p-8 text-center text-slate-400 font-bold animate-pulse">Reading the environment…</td></tr>';
        try {
            bxHooks = await api('bitrix_hooks');
            renderHooks();
        } catch (e) {
            document.getElementById('bx-hooks-summary').innerHTML =
                `<div class="ws-chip bad">Could not read the webhook list</div>`;
            body.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-rose-300 font-bold">${esc(e.message)}</td></tr>`;
        }
    }

    function renderHooks() {
        const d = bxHooks;
        if (!d) return;
        const s = d.summary || {};
        const missing = (s.total || 0) - (s.configured || 0);
        const sum = document.getElementById('bx-hooks-summary');
        const testable = (d.employees || []).filter(e => e.configured && e.valid).length;
        const tested = [...hookResults.values()];
        const passed = tested.filter(r => r.ok && r.match !== false).length;
        const failed = tested.filter(r => !r.ok).length;
        const mismatched = tested.filter(r => r.ok && r.match === false).length;
        sum.innerHTML =
            `<div class="flex flex-wrap items-center gap-2">` +
                `<div class="ws-chip ${missing === 0 ? 'ok' : 'warn'}">${s.configured || 0} of ${s.total || 0} employees have a webhook</div>` +
                (missing > 0 ? `<span class="text-slate-300 text-xs font-bold">${missing} still to add</span>` : '') +
                (s.invalid ? `<div class="ws-chip bad">${s.invalid} set but not a URL</div>` : '') +
                (tested.length
                    ? `<span class="text-slate-300 text-xs font-bold">tested ${tested.length}: ` +
                      `<span class="text-emerald-300">${passed} ok</span>` +
                      (mismatched ? `, <span class="text-amber-300">${mismatched} wrong person</span>` : '') +
                      (failed ? `, <span class="text-rose-300">${failed} failed</span>` : '') +
                      `</span>`
                    : '') +
                ((d.orphans || []).length
                    ? `<span class="text-amber-300 text-xs font-bold">${d.orphans.length} env var${d.orphans.length === 1 ? '' : 's'} match no enroll number: ${esc(d.orphans.join(', '))}</span>`
                    : '') +
                (testable
                    ? `<button type="button" id="bx-hooks-test-all" class="glass px-3 py-1.5 rounded-lg text-xs font-black text-slate-300 ml-auto">Test all ${testable}</button>`
                    : '') +
            `</div>`;

        const rows = d.employees || [];
        document.getElementById('bx-hooks-body').innerHTML = rows.length ? rows.map(e => {
            const status = !e.configured
                ? `<span class="ws-chip warn">Not set</span>`
                : (e.valid
                    ? `<span class="ws-chip ok">Set</span>`
                    : `<span class="ws-chip bad">Set — not a URL</span>`);
            const name = e.name
                ? esc(e.name)
                : `<span class="text-slate-500 italic">no name on device</span>`;
            const canTest = e.configured && e.valid;
            const test = canTest
                ? `<div class="flex items-start gap-2">` +
                      `<button type="button" class="bx-hook-test glass px-3 py-1.5 rounded-lg text-xs font-black text-slate-300 whitespace-nowrap" ` +
                              `data-enroll="${esc(e.enroll_no)}" data-name="${esc(e.name || '')}">Test</button>` +
                      `<span class="bx-hook-result" data-for="${esc(e.enroll_no)}">${hookResultHtml(hookResults.get(e.enroll_no))}</span>` +
                  `</div>`
                : `<span class="text-slate-500 text-xs font-bold">—</span>`;
            return `
            <tr data-enroll="${esc(e.enroll_no)}">
                <td class="font-mono text-white font-black">${esc(e.enroll_no)}</td>
                <td class="text-slate-200 font-bold">${name}${e.bound ? '' : ' <span class="text-slate-500 text-[11px]">(no account)</span>'}</td>
                <td class="text-slate-400 font-bold">${esc(e.company || '—')}</td>
                <td class="font-mono text-slate-400 text-[11px]">${esc(e.env_key)}</td>
                <td class="text-center">${status}</td>
                <td>${test}</td>
            </tr>`;
        }).join('') : '<tr><td colspan="6" class="p-8 text-center text-slate-400 font-bold">No enrolled employees yet.</td></tr>';
    }

    /* ---- testing one person's webhook ------------------------------------
     * The server calls Bitrix's read-only `profile` through that person's
     * BITRIX_HOOK_ and tells us who the webhook acts as. Nothing is sent to
     * anyone. The name that comes back is compared to the WorkSuite name, so
     * a URL pasted against the wrong enroll number is caught here rather
     * than by the wrong employee getting someone else's punches later.
     * -------------------------------------------------------------------- */
    function hookResultHtml(r) {
        if (!r) return '';
        if (r.pending) return `<span class="text-slate-400 text-xs font-bold animate-pulse">Testing…</span>`;
        const chip = r.ok ? (r.match === false ? 'warn' : 'ok') : 'bad';
        return `<span class="ws-chip ${chip}" title="${esc(r.hint || '')}">${esc(r.title)}</span>` +
               (r.sub ? `<div class="text-slate-400 text-[11px] font-bold mt-1">${esc(r.sub)}</div>` : '');
    }

    // Does the Bitrix name plausibly belong to the WorkSuite name? A shared
    // token of 3+ letters is enough - "Bharath" vs "Bharath Gurrala",
    // "Sirimilla Vinay" vs "Vinay Sirimilla". Unknown when we have no name to
    // compare, so an unlinked device entry is never flagged as a mismatch.
    function namesAgree(ours, theirs) {
        const toks = s => String(s || '').toLowerCase().split(/[^a-z]+/).filter(t => t.length >= 3);
        const a = toks(ours), b = new Set(toks(theirs));
        if (!a.length || !b.size) return null;
        return a.some(t => b.has(t));
    }

    async function testHook(enroll, ourName) {
        hookResults.set(enroll, { pending: true });
        paintHookResult(enroll);
        let r;
        try {
            const d = await api('bitrix_hook_test', { enroll });
            const u = d.bitrix_user || {};
            const match = namesAgree(ourName, u.name);
            r = {
                ok: true, match,
                title: match === false ? `Works — but this is ${u.name || 'someone else'}` : `OK · ${u.name || 'works'}`,
                sub: [u.id ? `user ${u.id}` : '', u.portal || ''].filter(Boolean).join(' · '),
                hint: match === false
                    ? `The webhook answers as "${u.name}", not "${ourName}". Check which person created it.`
                    : 'Read-only check: Bitrix confirmed the webhook and who it belongs to.',
            };
        } catch (e) {
            const code = (e && e.code) || '';
            r = { ok: false, title: code ? reasonText(code) : 'Failed',
                  hint: (reasonHint(code) || '') + (e.message ? ' ' + e.message : ''), sub: '' };
        }
        hookResults.set(enroll, r);
        paintHookResult(enroll);
        return r;
    }

    function paintHookResult(enroll) {
        const el = document.querySelector(`#bx-hooks-body .bx-hook-result[data-for="${CSS.escape(enroll)}"]`);
        if (el) el.innerHTML = hookResultHtml(hookResults.get(enroll));
        const btn = document.querySelector(`#bx-hooks-body .bx-hook-test[data-enroll="${CSS.escape(enroll)}"]`);
        if (btn) btn.disabled = !!(hookResults.get(enroll) || {}).pending;
    }

    document.getElementById('bx-hooks-body').addEventListener('click', ev => {
        const btn = ev.target.closest('.bx-hook-test');
        if (!btn || btn.disabled) return;
        testHook(btn.dataset.enroll, btn.dataset.name);
    });

    // Test every configured webhook, one at a time: Bitrix allows about two
    // requests a second per portal, and all of these hooks share one portal.
    document.getElementById('bx-hooks-summary').addEventListener('click', async ev => {
        const btn = ev.target.closest('#bx-hooks-test-all');
        if (!btn || btn.disabled || !bxHooks) return;
        const list = (bxHooks.employees || []).filter(e => e.configured && e.valid);
        btn.disabled = true;
        let n = 0;
        for (const e of list) {
            n += 1;
            btn.textContent = `Testing ${n} of ${list.length}…`;
            await testHook(e.enroll_no, e.name || '');
            await new Promise(r => setTimeout(r, 600));
        }
        renderHooks();   // refresh the ok / wrong person / failed tally
    });

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
            flash(tr, true);
            notice(true, 'Test message sent — check the group in Bitrix24', '');
        } catch (e) {
            flash(tr, false);
            // The API returns Bitrix's own code as `error`; api() puts the
            // description in the message, so translate the code we were given.
            const code = (e && e.code) || '';
            notice(false, code ? reasonText(code) : 'Test failed',
                   (reasonHint(code) || '') + (e.message ? '  (' + e.message + ')' : ''));
        } finally {
            btn.disabled = false; btn.textContent = label;
            // Refresh either way: a REJECTED test is logged too, and that row
            // is the most useful thing on the screen when something is wrong.
            if (bxLogs) loadLogs();
        }
    });
    document.getElementById('bx-reload').addEventListener('click', () => { loadBitrix(); loadHooks(); });
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
            if (!bxHooks) loadHooks();
        });
    });
})();
