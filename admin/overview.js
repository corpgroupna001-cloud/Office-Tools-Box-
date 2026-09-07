/* ===========================================================================
 * Admin: Overview - today at a glance
 *
 * The first thing an admin sees after unlocking: who is in, who is late or
 * missing, leave waiting for a decision, and the loose ends (unmapped
 * biometric codes, people without a shift). Everything here comes from
 * actions the other tabs already use - att_daily_report, leave_list,
 * employees, att_unmapped - so the numbers agree with those tabs exactly.
 *
 * Like the other split-out tabs it listens for its own sidebar button and
 * for the admin-unlocked / admin-refresh events the page dispatches.
 * =========================================================================== */
(function () {
    'use strict';

    const esc = s => (window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s));
    const $ = id => document.getElementById(id);
    const IST = 'Asia/Kolkata';
    const fmtDM = new Intl.DateTimeFormat('en-GB', { timeZone: IST, day: '2-digit', month: 'short' });
    const fmtLong = new Intl.DateTimeFormat('en-GB', { timeZone: IST, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: IST, hour: 'numeric', minute: '2-digit', hour12: true });

    let report = null, leave = null, employees = null, unmapped = null;
    let showAll = false, loaded = false, loading = false;

    async function api(action, extra = {}) {
        const r = await fetch('/api/admin', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: adminPassword, action, ...extra }),
        });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.error || out.detail || `HTTP ${r.status}`);
        return out;
    }

    const BADGE = {
        'Present': 'present', 'No check-out': 'info', 'Absent': 'absent', 'On leave': 'leave',
        'Half day leave': 'leave', 'Holiday': 'holiday', 'Week-off': 'weekoff', 'Not yet': 'pending',
    };
    const t = iso => iso ? fmtTime.format(new Date(iso)) : '—';

    async function load() {
        if (!adminPassword || loading) return;
        loading = true;
        $('ov-date').textContent = `${fmtLong.format(new Date())} · IST`;
        const results = await Promise.allSettled([
            api('att_daily_report'),
            api('leave_list', { status: 'pending' }),
            api('employees'),
            api('att_unmapped'),
        ]);
        report = results[0].status === 'fulfilled' ? results[0].value : null;
        leave = results[1].status === 'fulfilled' ? results[1].value : null;
        employees = results[2].status === 'fulfilled' ? results[2].value : null;
        unmapped = results[3].status === 'fulfilled' ? results[3].value : null;
        loaded = true; loading = false;
        render(results.find(r => r.status === 'rejected'));
    }

    function render(failure) {
        const T = (report && report.totals) || {};
        const rows = (report && report.rows) || [];
        const emps = (employees && employees.employees) || [];

        // KPIs
        const total = emps.length || T.employees || 0;
        $('ov-emp').textContent = total;
        const wfh = emps.filter(e => e.is_wfh).length;
        $('ov-emp-sub').textContent = wfh ? `${wfh} work from home` : 'Across all companies';
        const present = (T.present || 0) + (T.no_checkout || 0);
        $('ov-present').innerHTML = `${present}<small>/ ${T.employees || total}</small>`;
        $('ov-present-sub').textContent = T.no_checkout ? `${T.no_checkout} still on the clock` : (T.punches ? `${T.punches} punches so far` : 'No punches yet today');
        $('ov-late').textContent = T.late || 0;
        $('ov-late-sub').textContent = T.early_out ? `${T.early_out} left early` : (T.late ? 'Past shift start + grace' : 'Nobody late so far');
        $('ov-absent').textContent = T.absent || 0;
        $('ov-absent-ico').className = 'ico ' + (T.absent ? 'bad' : 'ok');
        const bits = [];
        if (T.on_leave) bits.push(`${T.on_leave} on leave`);
        if (T.week_off) bits.push(`${T.week_off} week off`);
        if (T.holiday) bits.push(`${T.holiday} on holiday`);
        $('ov-absent-sub').textContent = bits.join(' · ') || (report && report.holiday ? `Holiday: ${report.holiday}` : 'Everyone accounted for');

        // Attendance table: the people who matter first (present/late, then absent), week-offs last.
        const rank = r => r.status === 'Present' || r.status === 'No check-out' ? (r.is_late ? 1 : 0) : r.status === 'Absent' ? 2 : r.status.includes('leave') ? 3 : 4;
        const sorted = rows.slice().sort((a, b) => rank(a) - rank(b) || String(a.full_name || '').localeCompare(String(b.full_name || '')));
        const list = showAll ? sorted : sorted.slice(0, 10);
        $('ov-att-sub').textContent = report ? `${rows.length} people · ${report.date}` : '';
        $('ov-att-body').innerHTML = list.map(r => {
            const st = r.status === 'Absent' && !r.is_working_day ? 'Week-off' : r.status;
            const label = st === 'On leave' || st === 'Half day leave' ? (r.leave_type || st) : st === 'Holiday' ? (r.holiday_name || 'Holiday') : st;
            return `<tr>
                <td><div class="who"><b>${esc(r.full_name || r.email || r.employee_code || '—')}</b>${r.is_wfh ? '<small>Work from home</small>' : ''}<small class="co">${esc(r.company || '')}</small></div></td>
                <td class="muted col-co">${esc(r.company || '—')}</td>
                <td class="muted">${esc(r.shift_name || '—')}</td>
                <td class="num">${t(r.first_in)}${r.is_late ? ` <span class="ws-badge late">+${r.late_minutes}m</span>` : ''}</td>
                <td class="num">${t(r.last_out)}</td>
                <td><span class="ws-badge ${BADGE[st] || 'mute'}">${esc(label)}</span></td>
            </tr>`;
        }).join('') || `<tr><td colspan="6"><div class="ws-empty"><b>${failure ? 'Could not load the report' : 'Nothing yet'}</b>${failure ? esc(failure.reason && failure.reason.message || '') : 'No profiles with attendance today.'}</div></td></tr>`;
        const more = $('ov-att-more');
        more.hidden = sorted.length <= 10;
        more.textContent = showAll ? 'Show fewer' : `Show all ${sorted.length}`;

        // Pending leave
        const reqs = (leave && leave.requests) || [];
        $('ov-link-leave').textContent = reqs.length ? `${reqs.length} pending` : '';
        $('ov-link-leave').className = 'stat' + (reqs.length ? ' new' : '');
        $('ov-leave').innerHTML = reqs.slice(0, 5).map(l => `<li>
            <div class="date"><b>${Number(String(l.start_date).slice(8, 10))}</b><span>${esc(fmtDM.format(new Date(l.start_date + 'T12:00:00+05:30')).slice(3))}</span></div>
            <div class="main"><b>${esc(l.full_name || l.email || '—')}</b><span>${esc(l.type_name)} · ${l.start_date === l.end_date ? '' : esc(fmtDM.format(new Date(l.start_date + 'T12:00:00+05:30')) + ' – ' + fmtDM.format(new Date(l.end_date + 'T12:00:00+05:30'))) + ' · '}${esc(l.day_part_label || '')}${l.days ? ` · ${l.days} day${l.days === 1 ? '' : 's'}` : ''}</span></div>
            <div class="right"><span class="ws-badge pending">Pending</span></div>
        </li>`).join('') || '<li><div class="ws-empty" style="width:100%"><b>Nothing waiting</b>Every request has a decision.</div></li>';

        // Needs attention
        const issues = [];
        const codes = (unmapped && unmapped.unmapped_codes) || [];
        if (codes.length) issues.push({ icon: 'fingerprint', text: `${codes.length} biometric code${codes.length > 1 ? 's' : ''} not bound to a person`, jump: 'roster', cls: 'warn' });
        if (T.no_shift) issues.push({ icon: 'clock', text: `${T.no_shift} ${T.no_shift > 1 ? 'people have' : 'person has'} no shift assigned`, jump: 'shifts', cls: 'warn' });
        if (T.mail_problem) issues.push({ icon: 'bell', text: `${T.mail_problem} punch email${T.mail_problem > 1 ? 's' : ''} did not send today`, jump: 'attendance', cls: 'bad' });
        const noPhoto = emps.filter(e => !e.avatar_url).length;
        if (noPhoto) issues.push({ icon: 'camera', text: `${noPhoto} ${noPhoto > 1 ? 'profiles have' : 'profile has'} no photo`, jump: 'employees', cls: 'mute' });
        if (T.unmapped_codes && !codes.length) issues.push({ icon: 'fingerprint', text: `${T.unmapped_codes} unknown code${T.unmapped_codes > 1 ? 's' : ''} punched today`, jump: 'roster', cls: 'warn' });
        $('ov-issues').innerHTML = issues.map(i => `<li>
            <span class="ws-avatar sm" style="background:var(--ws-surface-2);color:var(--ws-text-muted)"><span class="ic ic-${i.icon}" style="width:14px;height:14px"></span></span>
            <div class="main"><b style="white-space:normal">${esc(i.text)}</b></div>
            <div class="right"><button type="button" class="ws-btn sm" data-jump="${i.jump}">Open</button></div>
        </li>`).join('') || '<li><div class="ws-empty" style="width:100%"><b>All clear</b>No loose ends right now.</div></li>';

        // Companies
        const byCo = new Map();
        emps.forEach(e => { const k = e.company || 'No company'; byCo.set(k, (byCo.get(k) || 0) + 1); });
        const inBy = new Map();
        rows.forEach(r => { if (r.status === 'Present' || r.status === 'No check-out') { const k = r.company || 'No company'; inBy.set(k, (inBy.get(k) || 0) + 1); } });
        $('ov-companies').innerHTML = [...byCo.entries()].sort((a, b) => b[1] - a[1]).map(([co, n]) => `<li>
            <div class="main"><b>${esc(co)}</b><span>${inBy.get(co) || 0} in today</span></div>
            <div class="right"><b>${n}</b></div>
        </li>`).join('') || '<li><div class="ws-empty" style="width:100%">No employees yet.</div></li>';
    }

    // Jump buttons anywhere in the panel switch tabs through the sidebar buttons.
    document.addEventListener('click', e => {
        const b = e.target.closest('[data-jump]');
        if (!b) return;
        const tab = document.querySelector(`.admin-tab[data-tab="${b.dataset.jump}"]`);
        if (tab) tab.click();
    });
    $('ov-att-more').addEventListener('click', () => { showAll = !showAll; render(); });

    document.addEventListener('admin-unlocked', () => load().catch(() => {}));
    document.addEventListener('admin-refresh', e => { if (e.detail && e.detail.tab === 'overview') load().catch(() => {}); });
    document.querySelectorAll('.admin-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.tab === 'overview' && adminPassword && !loaded) load().catch(() => {});
        });
    });
})();
