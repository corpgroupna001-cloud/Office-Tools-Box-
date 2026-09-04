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

    // The shift picker for a second role: the same shifts the payroll fetched.
    function shiftOptions(selected) {
        return ((payrollData && payrollData.shifts) || [])
            .map(sh => `<option value="${sh.id}"${String(sh.id) === String(selected) ? ' selected' : ''}>${escapeHtml(sh.name)}</option>`).join('');
    }

    // A person's total for the header: primary gross (if rated) + second role.
    function rowGross(e) {
        return (e.has_rate ? (e.gross || 0) : 0) + (e.second_role && e.second_role.gross || 0);
    }

    function renderSalary() {
        const d = payrollData;
        if (!d) return;
        const rows = visibleEmployees('pay-company');

        const rated = rows.filter(e => e.has_rate || (e.second_role && e.second_role.has_rate));
        const gross = Math.round(rows.reduce((a, e) => a + rowGross(e), 0) * 100) / 100;
        document.getElementById('pay-summary').innerHTML =
            `<div class="text-2xl font-black text-white leading-none">${payMoney(gross, 'INR')}</div>` +
            `<div class="text-[11px] uppercase tracking-widest text-slate-400 font-black mt-1">` +
            `${rated.length} of ${rows.length} rated · ${d.month}</div>`;

        document.getElementById('pay-tbody').innerHTML = rows.length ? rows.map(e => {
            const r2 = e.second_role;
            const main = `
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
                <td class="text-right whitespace-nowrap">
                    ${r2 ? '' : `<button type="button" class="role2-add glass px-2.5 py-1.5 rounded-lg text-xs font-black text-slate-300" title="This person has a second job paid separately">+ 2nd role</button>`}
                    <button type="button" class="pay-clear glass px-3 py-1.5 rounded-lg text-xs font-black text-slate-300" ${e.has_rate ? '' : 'disabled style="opacity:.3"'}>Clear</button>
                </td>
            </tr>`;
            const second = r2 ? `
            <tr data-uid="${e.id}" class="role2-row">
                <td class="pl-6 text-slate-300 font-bold"><span class="text-slate-500">↳ 2nd role</span> ${escapeHtml(r2.label)}</td>
                <td class="text-slate-500 text-xs font-bold">paid separately</td>
                <td class="text-slate-300 font-bold">${escapeHtml(r2.shift_name || '—')}</td>
                <td class="text-right font-black text-white">${r2.days_present}</td>
                <td class="text-right">
                    <input type="number" min="0" step="0.01" class="role2-rate glass px-3 py-1.5 rounded-lg text-right text-white font-bold w-28 focus:outline-none"
                           value="${r2.rate == null ? '' : r2.rate}" placeholder="rate">
                </td>
                <td class="text-right font-black ${r2.has_rate ? 'text-emerald-300' : 'text-slate-500'}">${payMoney(r2.gross, r2.currency)}</td>
                <td class="text-right"><button type="button" class="role2-clear glass px-3 py-1.5 rounded-lg text-xs font-black text-rose-300">Remove</button></td>
            </tr>` : '';
            return main + second;
        }).join('')
            : '<tr><td colspan="7" class="p-8 text-center text-slate-400 font-bold">Nobody in this company.</td></tr>';
    }

    // The inline editor for adding a second role, injected under a row on demand.
    function role2EditorRow(e) {
        return `
        <tr data-uid="${e.id}" class="role2-edit">
          <td colspan="7" class="p-3" style="background:rgba(255,255,255,0.03);">
            <div class="flex flex-wrap items-end gap-3">
              <div><label class="block text-[10px] uppercase tracking-widest text-slate-400 font-black mb-1">Second role</label>
                <input class="r2-label glass px-3 py-1.5 rounded-lg text-white font-bold w-40 focus:outline-none" placeholder="e.g. Jobways"></div>
              <div><label class="block text-[10px] uppercase tracking-widest text-slate-400 font-black mb-1">Shift</label>
                <select class="r2-shift glass px-3 py-1.5 rounded-lg text-white font-bold focus:outline-none"><option value="">— pick a shift —</option>${shiftOptions('')}</select></div>
              <div><label class="block text-[10px] uppercase tracking-widest text-slate-400 font-black mb-1">Per-day rate</label>
                <input type="number" min="0" step="0.01" class="r2-rate glass px-3 py-1.5 rounded-lg text-right text-white font-bold w-28 focus:outline-none" placeholder="rate"></div>
              <button type="button" class="r2-save btn-primary text-white font-black px-4 py-2 rounded-lg text-sm">Save role</button>
              <button type="button" class="r2-cancel glass px-4 py-2 rounded-lg text-sm font-bold text-slate-300">Cancel</button>
            </div>
          </td>
        </tr>`;
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
        const prime = ev.target.closest('.pay-rate');
        if (prime) { const tr = prime.closest('tr'); return savePayRate(tr.dataset.uid, prime.value.trim(), tr); }
        const r2 = ev.target.closest('.role2-rate');
        if (r2) {
            const tr = r2.closest('tr');
            const emp = payrollData.employees.find(x => x.id === tr.dataset.uid);
            if (emp && emp.second_role) saveRole2(emp, { rate: r2.value.trim() }, tr);
        }
    });
    document.getElementById('pay-tbody').addEventListener('click', ev => {
        const clear = ev.target.closest('.pay-clear');
        if (clear && !clear.disabled) { const tr = clear.closest('tr'); return savePayRate(tr.dataset.uid, '', tr); }

        // Reveal the "add a second role" editor under this employee's row.
        const add = ev.target.closest('.role2-add');
        if (add) {
            const tr = add.closest('tr');
            if (tr.nextElementSibling && tr.nextElementSibling.classList.contains('role2-edit')) return;
            const emp = payrollData.employees.find(x => x.id === tr.dataset.uid);
            tr.insertAdjacentHTML('afterend', role2EditorRow(emp));
            return;
        }
        const cancel = ev.target.closest('.r2-cancel');
        if (cancel) { cancel.closest('tr.role2-edit')?.remove(); return; }

        // Save a new second role from the inline editor.
        const save = ev.target.closest('.r2-save');
        if (save) {
            const edit = save.closest('tr.role2-edit');
            const emp = payrollData.employees.find(x => x.id === edit.dataset.uid);
            const label = edit.querySelector('.r2-label').value.trim();
            const shift = edit.querySelector('.r2-shift').value;
            const rate  = edit.querySelector('.r2-rate').value.trim();
            if (!label)  { alert('Give the second role a name.'); return; }
            if (!shift)  { alert('Pick the shift for the second role.'); return; }
            if (rate === '') { alert('Enter the second role\'s per-day rate.'); return; }
            saveRole2(emp, { label, shift_id: shift, rate }, edit, true);
            return;
        }

        // Remove a second role.
        const rem = ev.target.closest('.role2-clear');
        if (rem) {
            const tr = rem.closest('tr');
            clearRole2(payrollData.employees.find(x => x.id === tr.dataset.uid), tr);
            return;
        }
    });

    // Save or update a person's second role, then re-render so the header
    // total and the row agree without a full month refetch.
    async function saveRole2(emp, patch, tr, isNew) {
        const cur = emp.second_role || {};
        const label = patch.label != null ? patch.label : cur.label;
        const shiftId = patch.shift_id != null ? patch.shift_id : cur.shift_id;
        const rate = patch.rate != null ? patch.rate : (cur.rate == null ? '' : cur.rate);
        try {
            const r = await fetch('/api/admin', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: adminPassword, action: 'pay_role2_set',
                    user_id: emp.id, label, shift_id: shiftId, per_day_rate: rate }),
            });
            const data = await r.json();
            if (data && data.unavailable) { alert(data.detail); return; }
            if (!r.ok) throw new Error(data.detail || data.error || 'Save failed');
            // Recompute the second-role days locally: worked days on that
            // shift's working days. We have the codes string and the month.
            const sh = (payrollData.shifts || []).find(x => String(x.id) === String(shiftId));
            emp.second_role = {
                label, shift_id: shiftId ? Number(shiftId) : null,
                shift_name: sh ? sh.name : null,
                rate: Number(rate),
                days_present: role2Days(emp, shiftId),
                gross: null, has_rate: true, currency: emp.currency || 'INR',
            };
            emp.second_role.gross = Math.round(Number(rate) * emp.second_role.days_present * 100) / 100;
            renderSalary();
        } catch (e) {
            if (tr) { tr.style.background = 'rgba(244,63,94,.18)'; setTimeout(() => { tr.style.background = ''; }, 1600); }
            alert(e.message);
        }
    }

    // Worked days that fall on the chosen shift's working days. The month grid
    // is a codes string (P/L/... per day, from day 1); the shift's working
    // days come from payrollData.shifts is name-only, so we ask the shift's
    // days off the calendar model instead: recompute from the codes + weekday.
    function role2Days(emp, shiftId) {
        const shift = (payrollData.shifts || []).find(x => String(x.id) === String(shiftId));
        const days = (shift && shift.working_days) ? shift.working_days.map(Number) : [1,2,3,4,5,6,7];
        const codes = emp.codes || '';
        let n = 0;
        for (let i = 0; i < codes.length; i++) {
            const worked = codes[i] === 'P' || codes[i] === 'L';
            if (!worked) continue;
            // day (i+1) of payrollData.month → ISO weekday
            const iso = `${payrollData.month}-${String(i + 1).padStart(2, '0')}`;
            const wd = new Date(iso + 'T12:00:00+05:30').getDay(); // 0=Sun..6=Sat
            const isoWd = wd === 0 ? 7 : wd;
            if (days.includes(isoWd)) n++;
        }
        return n;
    }

    async function clearRole2(emp, tr) {
        try {
            const r = await fetch('/api/admin', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: adminPassword, action: 'pay_role2_clear', user_id: emp.id }),
            });
            if (!r.ok) { const d = await r.json(); throw new Error(d.detail || d.error || 'Remove failed'); }
            emp.second_role = null;
            renderSalary();
        } catch (e) {
            if (tr) { tr.style.background = 'rgba(244,63,94,.18)'; setTimeout(() => { tr.style.background = ''; }, 1600); }
            alert(e.message);
        }
    }
    document.getElementById('cal-reload').addEventListener('click', () => loadPayroll(document.getElementById('cal-month').value));
    document.getElementById('pay-reload').addEventListener('click', () => loadPayroll(document.getElementById('pay-month').value));
    document.getElementById('cal-company').addEventListener('change', renderCalendar);
    document.getElementById('pay-company').addEventListener('change', renderSalary);
    document.getElementById('pay-export').addEventListener('click', () => {
        if (!payrollData) return;
        const rows = visibleEmployees('pay-company');
        const q = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
        const head = ['Employee','Email','Company','Shift','Days present','Per-day rate','Gross',
                      '2nd role','2nd shift','2nd days','2nd rate','2nd gross','Currency','Month'];
        const csv = [head.join(',')]
            .concat(rows.map(e => {
                const r2 = e.second_role;
                return [e.name, e.email, e.company || '', e.shift_name || '',
                        e.totals.daysPresent, e.rate == null ? '' : e.rate, e.gross == null ? '' : e.gross,
                        r2 ? r2.label : '', r2 ? (r2.shift_name || '') : '', r2 ? r2.days_present : '',
                        r2 ? r2.rate : '', r2 ? (r2.gross == null ? '' : r2.gross) : '',
                        e.currency, payrollData.month].map(q).join(',');
            }))
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
