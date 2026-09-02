/* ===========================================================================
 * Admin: month calendar + salary
 *
 * Split out of admin/index.html, which was already 2,900 lines. This file
 * owns its own two tabs end to end — it listens for tab clicks itself and
 * shows/hides its own panels — so adding it needed no change to the tab
 * switcher in the page, and changing it never means re-uploading 170 KB of
 * HTML.
 *
 * It relies on two globals declared by the inline script above it:
 *   adminPassword  (let, script-level -> shared global lexical scope)
 *   escapeHtml     (function declaration -> global)
 * Loaded WITHOUT defer immediately after that script, so both exist and the
 * DOM is already parsed by the time this runs.
 * =========================================================================== */
(function () {
    'use strict';

    // ================= CALENDAR + SALARY =================
    // One fetch feeds both tabs: pay_list and cal_month return the same
    // payload, so asking twice would just be two identical round trips.
    let payrollData = null;

    const payMoney = (n, cur) => n == null || !isFinite(Number(n))
        ? '—'
        : (cur === 'INR' || !cur ? '₹' : '')
          + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          + (cur && cur !== 'INR' ? ' ' + cur : '');

    const CODE_TO_STATUS = { P:'present', L:'late', A:'absent', V:'leave',
                             H:'holiday', W:'weekoff', T:'pending', F:'future' };
    const DAY_LETTER = ['', 'M', 'T', 'W', 'T', 'F', 'S', 'S'];

    function isoWeekday(dateStr) {
        const n = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short' })
            .format(new Date(dateStr + 'T12:00:00+05:30'));
        return ({ Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6, Sun:7 })[n] || 1;
    }

    async function loadPayroll(month) {
        if (!adminPassword) return;
        const m = month
            || document.getElementById('cal-month').value
            || document.getElementById('pay-month').value
            || new Date().toISOString().slice(0, 7);
        document.getElementById('cal-body').innerHTML =
            '<tr><td colspan="40" class="p-8 text-center text-slate-400 font-bold animate-pulse">Loading…</td></tr>';
        document.getElementById('pay-tbody').innerHTML =
            '<tr><td colspan="7" class="p-8 text-center text-slate-400 font-bold animate-pulse">Loading…</td></tr>';
        try {
            const r = await fetch('/api/admin', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: adminPassword, action: 'pay_list', month: m })
            });
            const data = await r.json();
            if (!r.ok) throw new Error(data.detail || data.error || 'Load failed');
            payrollData = data;
            document.getElementById('cal-month').value = data.month;
            document.getElementById('pay-month').value = data.month;
            fillCompanyFilters(data.employees);
            renderCalendar();
            renderSalary();
        } catch (e) {
            const msg = `<tr><td colspan="40" class="p-8 text-center text-rose-300 font-bold">${escapeHtml(e.message)}</td></tr>`;
            document.getElementById('cal-body').innerHTML = msg;
            document.getElementById('pay-tbody').innerHTML = msg.replace('40', '7');
        }
    }

    function fillCompanyFilters(emps) {
        const names = [...new Set(emps.map(e => e.company).filter(Boolean))].sort();
        ['cal-company', 'pay-company'].forEach(id => {
            const sel = document.getElementById(id);
            const keep = sel.value;
            sel.innerHTML = '<option value="">All companies</option>' +
                names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
            sel.value = keep;
        });
    }

    function visibleEmployees(filterId) {
        if (!payrollData) return [];
        const c = document.getElementById(filterId).value;
        return c ? payrollData.employees.filter(e => e.company === c) : payrollData.employees;
    }

    function renderCalendar() {
        const d = payrollData;
        if (!d) return;
        const legend = d.legend || {};

        document.getElementById('cal-legend').innerHTML = ['present','late','absent','leave','holiday','weekoff']
            .map(k => `<span class="cal-key"><i style="background:${legend[k] ? legend[k].color : '#888'}"></i>${escapeHtml(legend[k] ? legend[k].label : k)}</span>`)
            .join('');

        document.getElementById('cal-head').innerHTML =
            '<tr><th class="cal-name">Employee</th>' +
            d.dates.map(dt => {
                const wd = isoWeekday(dt);
                const weekend = wd >= 6 ? ' cal-wend' : '';
                return `<th class="cal-d${weekend}"><span>${DAY_LETTER[wd]}</span>${Number(dt.slice(8))}</th>`;
            }).join('') +
            '<th class="cal-tot">P</th><th class="cal-tot">A</th><th class="cal-tot">L</th></tr>';

        const rows = visibleEmployees('cal-company');
        document.getElementById('cal-body').innerHTML = rows.length ? rows.map(e => {
            const cells = d.dates.map((dt, i) => {
                const code = e.codes[i] || 'F';
                const key = CODE_TO_STATUS[code] || 'future';
                const meta = legend[key] || { label: key, color: '#888' };
                const t = e.times[dt];
                const note = e.notes[dt];
                const title = [
                    dt + ' · ' + meta.label,
                    t ? `In ${t[0] || '—'} · Out ${t[1] || '—'}` + (t[2] ? ` · ${t[2]} min late` : '') : null,
                    note || null,
                ].filter(Boolean).join('\n');
                const faded = key === 'future' ? ' style="opacity:.25"' : '';
                return `<td class="cal-c"${faded} title="${escapeHtml(title)}">` +
                       `<span style="background:${meta.color}"></span></td>`;
            }).join('');
            return `<tr><td class="cal-name" title="${escapeHtml(e.company || '')}">` +
                   `<b>${escapeHtml(e.name)}</b>` +
                   (e.is_wfh ? ' <span class="cal-wfh">🏠</span>' : '') +
                   `</td>${cells}` +
                   `<td class="cal-tot">${e.totals.present + e.totals.late}</td>` +
                   `<td class="cal-tot cal-bad">${e.totals.absent || ''}</td>` +
                   `<td class="cal-tot cal-warn">${e.totals.late || ''}</td></tr>`;
        }).join('') : '<tr><td colspan="40" class="p-8 text-center text-slate-400 font-bold">Nobody in this company.</td></tr>';
    }

    function renderSalary() {
        const d = payrollData;
        if (!d) return;
        const rows = visibleEmployees('pay-company');

        const withRate = rows.filter(e => e.has_rate);
        const gross = Math.round(withRate.reduce((a, e) => a + (e.gross || 0), 0) * 100) / 100;
        document.getElementById('pay-summary').innerHTML =
            `<div class="text-2xl font-black text-white leading-none">${payMoney(gross, 'INR')}</div>` +
            `<div class="text-[11px] uppercase tracking-widest text-slate-400 font-black mt-1">` +
            `${withRate.length} of ${rows.length} rated · ${d.month}</div>`;

        document.getElementById('pay-tbody').innerHTML = rows.length ? rows.map(e => `
            <tr data-uid="${e.id}">
                <td><b>${escapeHtml(e.name)}</b><div class="text-[11px] text-slate-400 font-bold">${escapeHtml(e.email || '')}</div></td>
                <td class="text-slate-300 font-bold">${escapeHtml(e.company || '—')}</td>
                <td class="text-slate-300 font-bold">${escapeHtml(e.shift_name || '—')}${e.shift_assigned ? '' : ' <span class="text-slate-500">(default)</span>'}</td>
                <td class="text-right font-black text-white">${e.totals.daysPresent}</td>
                <td class="text-right">
                    <input type="number" min="0" step="0.01" class="pay-rate glass px-3 py-1.5 rounded-lg text-right text-white font-bold w-28 focus:outline-none"
                           value="${e.rate == null ? '' : e.rate}" placeholder="not set">
                </td>
                <td class="text-right font-black ${e.has_rate ? 'text-emerald-300' : 'text-slate-500'}">${payMoney(e.gross, e.currency)}</td>
                <td class="text-right"><button type="button" class="pay-clear glass px-3 py-1.5 rounded-lg text-xs font-black text-slate-300" ${e.has_rate ? '' : 'disabled style="opacity:.3"'}>Clear</button></td>
            </tr>`).join('')
            : '<tr><td colspan="7" class="p-8 text-center text-slate-400 font-bold">Nobody in this company.</td></tr>';
    }

    async function savePayRate(uid, value, tr) {
        const blank = value === '' || value == null;
        try {
            const r = await fetch('/api/admin', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    password: adminPassword,
                    action: blank ? 'pay_clear_rate' : 'pay_set_rate',
                    user_id: uid, per_day_rate: blank ? undefined : value
                })
            });
            const data = await r.json();
            if (!r.ok) throw new Error(data.detail || data.error || 'Save failed');
            // Recompute locally so the row and the header total agree at once,
            // without another full month fetch.
            const emp = payrollData.employees.find(e => e.id === uid);
            if (emp) {
                emp.rate = blank ? null : Number(value);
                emp.has_rate = !blank;
                emp.gross = blank ? null : Math.round(Number(value) * emp.totals.daysPresent * 100) / 100;
            }
            renderSalary();
            const row = document.querySelector(`#pay-tbody tr[data-uid="${uid}"]`);
            if (row) { row.style.transition = 'background .5s'; row.style.background = 'rgba(16,185,129,.18)';
                       setTimeout(() => { row.style.background = ''; }, 700); }
        } catch (e) {
            if (tr) { tr.style.background = 'rgba(244,63,94,.18)'; setTimeout(() => { tr.style.background = ''; }, 1600); }
            alert(e.message);
        }
    }

    document.getElementById('pay-tbody').addEventListener('change', ev => {
        const input = ev.target.closest('.pay-rate');
        if (!input) return;
        const tr = input.closest('tr');
        savePayRate(tr.dataset.uid, input.value.trim(), tr);
    });
    document.getElementById('pay-tbody').addEventListener('click', ev => {
        const btn = ev.target.closest('.pay-clear');
        if (!btn || btn.disabled) return;
        const tr = btn.closest('tr');
        savePayRate(tr.dataset.uid, '', tr);
    });
    document.getElementById('cal-reload').addEventListener('click', () => loadPayroll(document.getElementById('cal-month').value));
    document.getElementById('pay-reload').addEventListener('click', () => loadPayroll(document.getElementById('pay-month').value));
    document.getElementById('cal-company').addEventListener('change', renderCalendar);
    document.getElementById('pay-company').addEventListener('change', renderSalary);
    document.getElementById('pay-export').addEventListener('click', () => {
        if (!payrollData) return;
        const rows = visibleEmployees('pay-company');
        const csv = [['Employee','Email','Company','Shift','Days present','Per-day rate','Gross','Currency','Month'].join(',')]
            .concat(rows.map(e => [e.name, e.email, e.company || '', e.shift_name || '',
                                   e.totals.daysPresent, e.rate == null ? '' : e.rate,
                                   e.gross == null ? '' : e.gross, e.currency, payrollData.month]
                .map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')))
            .join('\n');
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
        const a = document.createElement('a');
        a.href = url; a.download = `salary-${payrollData.month}.csv`; a.click();
        URL.revokeObjectURL(url);
    });

    // This file owns the calendar and salary panels, so it also owns hiding
    // them when any other tab is picked. The switcher in the page does not
    // know they exist.
    document.querySelectorAll('.admin-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            document.getElementById('calendar-panel').classList.toggle('hidden', tab !== 'calendar');
            document.getElementById('salary-panel').classList.toggle('hidden',   tab !== 'salary');
            if ((tab === 'calendar' || tab === 'salary') && !payrollData) loadPayroll();
        });
    });
})();
