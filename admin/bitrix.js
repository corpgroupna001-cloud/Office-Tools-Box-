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
        } finally { btn.disabled = false; btn.textContent = label; }
    });
    document.getElementById('bx-reload').addEventListener('click', () => loadBitrix());

    document.querySelectorAll('.admin-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            document.getElementById('bitrix-panel').classList.toggle('hidden', tab !== 'bitrix');
            if (tab === 'bitrix' && !bxData) loadBitrix();
        });
    });
})();
