/* ===========================================================================
 * Admin: Biometric roster
 *
 * Split out like admin/bitrix.js and admin/payroll.js: admin/index.html is
 * already large and this owns its tab end to end - it listens for its own tab
 * clicks and shows/hides its own panel, so the page's switcher needs no change.
 *
 * The list comes from device_enrolments, which the punch webhook keeps fresh.
 * Binding an enrolment sets the code on the chosen account, which is what makes
 * that person's punches, calendar and payslip line up.
 * =========================================================================== */
(function () {
    'use strict';

    let data = null;

    const esc = s => (window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s));

    const IST = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short',
        hour: 'numeric', minute: '2-digit', hour12: true,
    });
    function stamp(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        return isNaN(d.getTime()) ? '—' : IST.format(d).replace(',', '');
    }

    async function api(action, extra = {}) {
        const r = await fetch('/api/admin', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: adminPassword, action, ...extra }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || d.error || 'Request failed');
        return d;
    }

    async function load() {
        if (!adminPassword) return;
        const body = document.getElementById('rost-body');
        body.innerHTML = '<tr><td colspan="6" class="p-8 text-center text-slate-400 font-bold animate-pulse">Reading the roster…</td></tr>';
        try {
            data = await api('roster_list');
            render();
        } catch (e) {
            document.getElementById('rost-summary').innerHTML = `<div class="ws-chip bad">Could not read the roster</div>`;
            body.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-rose-300 font-bold">${esc(e.message)}</td></tr>`;
        }
    }

    // The account picker: a <select> of everyone, so an admin picks a name
    // rather than typing an id. An account already holding a code is flagged,
    // because binding it here moves that code.
    function accountPicker(row, profiles) {
        const opts = profiles.map(p => {
            const held = p.employee_code && p.employee_code !== row.enroll_no
                ? ` — now ${esc(p.employee_code)}` : '';
            return `<option value="${esc(p.id)}"${p.id === row.user_id ? ' selected' : ''}>${esc(p.full_name || p.email)}${held}</option>`;
        }).join('');
        return `<select class="rost-pick glass px-3 py-1.5 rounded-lg text-white font-bold w-56 focus:outline-none" data-enroll="${esc(row.enroll_no)}">` +
               `<option value=""${row.user_id ? '' : ' selected'}>— not bound —</option>` + opts + `</select>`;
    }

    function render() {
        const d = data;
        if (!d) return;
        const sum = document.getElementById('rost-summary');
        const body = document.getElementById('rost-body');

        if (d.unavailable) {
            sum.innerHTML =
                `<div class="ws-chip warn">Roster not set up</div>` +
                `<p class="text-slate-400 text-xs font-bold mt-2 leading-relaxed max-w-2xl">${esc(d.detail || '')}<br>` +
                `Open <b>Supabase → SQL Editor</b>, paste <b>supabase-device-enrolments-migration.sql</b> from the repo and run it. ` +
                `Punches keep being stored in the meantime — the roster just is not being built yet.</p>`;
            body.innerHTML = '<tr><td colspan="6" class="p-8 text-center text-slate-400 font-bold">Nothing yet.</td></tr>';
            return;
        }

        const s = d.summary || {};
        sum.innerHTML =
            `<div class="flex flex-wrap items-center gap-2">` +
                `<div class="ws-chip ok">${s.bound || 0} bound</div>` +
                (s.unbound ? `<div class="ws-chip warn">${s.unbound} still to bind</div>` : '') +
                `<span class="text-slate-400 text-xs font-bold ml-auto">${s.total || 0} enrolment${s.total === 1 ? '' : 's'} on the reader</span>` +
            `</div>`;

        const q = (document.getElementById('rost-search').value || '').trim().toLowerCase();
        const unboundOnly = document.getElementById('rost-unbound').checked;
        let rows = d.rows || [];
        if (unboundOnly) rows = rows.filter(r => !r.user_id);
        if (q) rows = rows.filter(r => [r.enroll_no, r.device_name, r.staff_code, r.bound_name]
            .some(v => String(v || '').toLowerCase().includes(q)));

        body.innerHTML = rows.length ? rows.map(r => `
            <tr data-enroll="${esc(r.enroll_no)}">
                <td class="mono font-black text-white">${esc(r.enroll_no)}</td>
                <td class="font-bold">${esc(r.device_name || '—')}</td>
                <td class="mono text-slate-300">${esc(r.staff_code || '—')}</td>
                <td class="text-slate-400 font-bold">${r.punches == null ? '—' : r.punches}</td>
                <td class="text-slate-400 whitespace-nowrap">${esc(stamp(r.last_seen))}</td>
                <td>
                    ${accountPicker(r, d.profiles || [])}
                    ${r.user_id
                        ? `<div class="text-[11px] text-emerald-300 font-bold mt-1">${esc(r.bound_email || '')}</div>`
                        : ''}
                </td>
            </tr>`).join('') : '<tr><td colspan="6" class="p-8 text-center text-slate-400 font-bold">Nothing matches.</td></tr>';
    }

    function flash(tr, ok, note) {
        if (tr) {
            tr.style.transition = 'background .4s';
            tr.style.background = ok ? 'rgba(16,185,129,.18)' : 'rgba(244,63,94,.18)';
            setTimeout(() => { tr.style.background = ''; }, ok ? 700 : 1800);
        }
        if (note && !ok && typeof showToast === 'function') showToast(note, 'error');
    }

    async function onPick(sel) {
        const enroll = sel.dataset.enroll;
        const userId = sel.value;
        const tr = sel.closest('tr[data-enroll]');
        sel.disabled = true;
        try {
            if (userId) await api('roster_bind', { enroll_no: enroll, user_id: userId });
            else        await api('roster_unbind', { enroll_no: enroll });
            await load();               // re-read: a bind can move a code off another row
            flash(document.querySelector(`#rost-body tr[data-enroll="${CSS.escape(enroll)}"]`), true);
        } catch (e) {
            sel.disabled = false;
            flash(tr, false, e.message);
        }
    }

    document.getElementById('rost-body').addEventListener('change', ev => {
        if (ev.target.classList.contains('rost-pick')) onPick(ev.target);
    });
    document.getElementById('rost-reload').addEventListener('click', () => load());
    document.getElementById('rost-search').addEventListener('input', () => data && !data.unavailable && render());
    document.getElementById('rost-unbound').addEventListener('change', () => data && !data.unavailable && render());

    document.querySelectorAll('.admin-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            document.getElementById('roster-panel').classList.toggle('hidden', tab !== 'roster');
            if (tab === 'roster' && !data) load();
        });
    });
})();
