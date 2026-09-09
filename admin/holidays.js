/* ===========================================================================
 * Admin: Holidays - one list per company
 *
 * Split out like admin/bitrix.js: this file owns the Holidays tab end to end
 * and listens for tab clicks itself, so the switcher in admin/index.html
 * needed no change beyond the button.
 *
 * Why a card per company: the five companies do not close on the same days
 * (Jobways follows its US clients' calendar more than Hyderabad's), and one
 * long mixed table made "what does Genie Lamp get in October" a hunt. Each
 * card is that company's complete answer: its own list, its own add form,
 * its own Pre-fill. The Shared list stays for the few days everyone closes.
 * =========================================================================== */
(function () {
    'use strict';

    const esc = s => (window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s));
    const $ = id => document.getElementById(id);

    // Fixed order, so every company has a card before it has a holiday.
    // Mirrors HOLIDAY_COMPANIES in api/admin.js.
    const COMPANIES = [
        'Nova Sportsmart Private Limited',
        'Protathlitis Sportsmart LLP',
        'Jobways Point LLP',
        'Genie Lamp Private Limited',
        'Navyug Raise A Player Foundation',
    ];
    const SHARED = '';   // company '' == the shared list (NULL in the table)

    let data = null;     // { year, holidays: [...] }

    async function api(action, extra = {}) {
        const r = await adminFetch({
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ...extra }),
        });
        const out = await r.json();
        if (!r.ok) {
            const err = new Error(out.detail || out.error || 'Request failed');
            err.code = out.error || '';
            throw err;
        }
        return out;
    }

    const year = () => String($('hol-year').value || new Date().getFullYear());

    const WEEKDAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short' });
    const PRETTY  = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
    const dayOf = iso => WEEKDAY.format(new Date(iso + 'T12:00:00+05:30'));
    const prettyOf = iso => PRETTY.format(new Date(iso + 'T12:00:00+05:30'));

    async function load() {
        if (!adminAuthenticated) return;
        if (!$('hol-year').value) $('hol-year').value = new Date().getFullYear();
        $('hol-cards').innerHTML = '<div class="glass rounded-2xl p-8 text-center text-slate-400 font-bold animate-pulse">Loading…</div>';
        try {
            data = await api('holiday_list', { year: year() });
            render();
        } catch (e) {
            $('hol-cards').innerHTML = `<div class="glass rounded-2xl p-8 text-center text-rose-300 font-bold">${esc(e.message)}</div>`;
        }
    }

    function notice(ok, title, hint) {
        const el = $('hol-notice');
        if (!title) { el.innerHTML = ''; return; }
        el.innerHTML =
            `<div class="glass rounded-2xl p-4 mb-4">` +
                `<div class="ws-chip ${ok ? 'ok' : 'bad'}">${esc(title)}</div>` +
                (hint ? `<p class="text-slate-300 text-xs font-bold mt-2 leading-relaxed max-w-2xl">${esc(hint)}</p>` : '') +
            `</div>`;
    }

    function render() {
        if (!data) return;
        const rows = data.holidays || [];
        const byCompany = new Map();
        rows.forEach(h => {
            const key = h.company || SHARED;
            if (!byCompany.has(key)) byCompany.set(key, []);
            byCompany.get(key).push(h);
        });
        // Fixed companies first, then any other company that has rows (never
        // hidden), then the shared list last.
        const order = COMPANIES.slice();
        [...byCompany.keys()].forEach(k => { if (k !== SHARED && !order.includes(k)) order.push(k); });
        order.push(SHARED);

        const total = rows.filter(h => h.company).length;
        $('hol-summary').textContent = `${total} company holiday${total === 1 ? '' : 's'} in ${data.year}` +
            (byCompany.get(SHARED) ? ` · ${byCompany.get(SHARED).length} shared` : '');

        $('hol-cards').innerHTML = order.map(card).join('');
    }

    function card(company) {
        const list = ((data.holidays || []).filter(h => (h.company || SHARED) === company))
            .slice().sort((a, b) => a.holiday_date.localeCompare(b.holiday_date));
        const shared = company === SHARED;
        const title = shared ? 'Shared' : company;
        const sub = shared
            ? 'applies to every company without its own entry for that date'
            : `${list.length} holiday${list.length === 1 ? '' : 's'} in ${esc(data.year)}`;
        const today = new Date().toISOString().slice(0, 10);
        const body = list.length ? `
            <div class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead><tr><th>Date</th><th>Holiday</th><th>Type</th><th></th></tr></thead>
                    <tbody>${list.map(h => `
                        <tr${h.holiday_date < today ? ' style="opacity:.55"' : ''}>
                            <td class="text-white font-black whitespace-nowrap">${esc(prettyOf(h.holiday_date))}
                                <span class="text-slate-500 text-[11px] font-bold">${esc(dayOf(h.holiday_date))}</span></td>
                            <td class="text-slate-200 font-bold">${esc(h.name)}</td>
                            <td>${h.is_optional
                                ? '<span class="text-amber-300 text-xs font-black">Optional</span>'
                                : '<span class="text-violet-300 text-xs font-black">Public</span>'}</td>
                            <td class="text-right"><button type="button" data-hol-del="${h.id}" class="glass px-2.5 py-1 rounded-lg text-xs font-bold text-rose-300 hover:bg-rose-500/10">Delete</button></td>
                        </tr>`).join('')}</tbody>
                </table>
            </div>`
            : `<p class="px-4 py-5 text-center text-slate-500 text-xs font-bold">No holidays set for ${esc(title)} in ${esc(data.year)}.${shared ? '' : ' Add one below, or Pre-fill the year.'}</p>`;
        return `
            <div class="glass rounded-2xl overflow-hidden flex flex-col" data-company="${esc(company)}">
                <div class="px-4 py-3 flex items-center gap-2 border-b border-white/5">
                    <span class="ic ic-calendar"></span>
                    <h4 class="text-white font-black">${esc(title)}</h4>
                    <span class="text-[10px] uppercase tracking-widest ${shared ? 'text-violet-300' : 'text-slate-500'} font-black">${sub}</span>
                    ${shared ? '' : `<button type="button" class="hol-prefill glass px-2.5 py-1 rounded-lg text-[11px] font-black text-violet-200 ml-auto whitespace-nowrap">Pre-fill ${esc(data.year)}</button>`}
                </div>
                <div class="flex-1">${body}</div>
                <div class="px-3 py-3 border-t border-white/5 flex flex-wrap gap-2 items-center">
                    <input type="date" class="hol-date glass px-3 py-1.5 rounded-lg text-sm font-bold focus:outline-none" min="${esc(data.year)}-01-01" max="${esc(data.year)}-12-31">
                    <input type="text" class="hol-name glass flex-1 min-w-[140px] px-3 py-1.5 rounded-lg text-sm font-medium placeholder-slate-400 focus:outline-none" placeholder="Holiday name">
                    <label class="flex items-center gap-1.5 text-[11px] font-bold text-slate-300 cursor-pointer whitespace-nowrap">
                        <input type="checkbox" class="hol-optional w-4 h-4"> Optional
                    </label>
                    <button type="button" class="hol-add btn-primary text-white font-black px-4 py-1.5 rounded-lg text-sm">Add</button>
                </div>
            </div>`;
    }

    async function add(cardEl) {
        const company = cardEl.dataset.company;
        const date = cardEl.querySelector('.hol-date').value;
        const name = cardEl.querySelector('.hol-name').value.trim();
        const optional = cardEl.querySelector('.hol-optional').checked;
        if (!date || !name) {
            wsDialog.alert({ icon: 'ℹ️', title: 'Date and name needed', message: 'Pick a date and give the holiday a name.' });
            return;
        }
        if (!date.startsWith(year() + '-')) {
            wsDialog.alert({ icon: 'ℹ️', title: `That date is not in ${year()}`, message: 'Change the year at the top to add a holiday in another year.' });
            return;
        }
        try {
            const r = await api('holiday_save', { holiday: { holiday_date: date, name, company: company || null, is_optional: optional } });
            if (r.holiday) data.holidays.push(r.holiday);
            render();
            notice(null, '');
        } catch (e) {
            notice(false, e.code === 'A holiday is already set for that date.' ? e.code : 'Could not add the holiday', e.message);
        }
    }

    async function remove(id) {
        const h = (data.holidays || []).find(x => String(x.id) === String(id));
        const ok = await wsDialog.confirm({ icon: '🎉', danger: true, title: 'Delete this holiday?',
            message: `<b>${esc(h ? h.name : '')}</b> on ${esc(h ? prettyOf(h.holiday_date) : '')} goes back to being a working day for ${esc(h && h.company ? h.company : 'every company')}.`,
            okText: 'Delete' });
        if (!ok) return;
        try {
            await api('holiday_delete', { id });
            data.holidays = data.holidays.filter(x => String(x.id) !== String(id));
            render();
        } catch (e) {
            notice(false, 'Delete failed', e.message);
        }
    }

    async function prefill(companies, btn) {
        const label = btn.textContent;
        btn.disabled = true; btn.textContent = 'Adding…';
        try {
            const r = await api('holiday_prefill', { year: year(), companies });
            data = await api('holiday_list', { year: year() });
            render();
            notice(true,
                r.inserted ? `Added ${r.inserted} holiday${r.inserted === 1 ? '' : 's'}` : 'Nothing to add',
                r.inserted
                    ? `${companies.length ? companies.join(', ') : 'Every company'} now has the ${r.year} Telangana list. Delete the days that company stays open.`
                    : `Every date on the ${r.year} list was already there${r.skipped ? ` (${r.skipped} skipped)` : ''}.`);
        } catch (e) {
            notice(false, 'Pre-fill failed', e.message);
        } finally {
            btn.disabled = false; btn.textContent = label;
        }
    }

    $('hol-cards').addEventListener('click', ev => {
        const del = ev.target.closest('[data-hol-del]');
        if (del) return remove(del.dataset.holDel);
        const addBtn = ev.target.closest('.hol-add');
        if (addBtn) return add(addBtn.closest('[data-company]'));
        const pre = ev.target.closest('.hol-prefill');
        if (pre) return prefill([pre.closest('[data-company]').dataset.company], pre);
    });
    $('hol-cards').addEventListener('keydown', ev => {
        if (ev.key === 'Enter' && ev.target.classList.contains('hol-name')) add(ev.target.closest('[data-company]'));
    });
    $('hol-prefill-all').addEventListener('click', ev => prefill([], ev.currentTarget));
    $('hol-reload').addEventListener('click', load);
    $('hol-year').addEventListener('change', load);

    document.querySelectorAll('.admin-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            $('holidays-panel').classList.toggle('hidden', tab !== 'holidays');
            if (tab === 'holidays' && !data) load();
        });
    });
})();
