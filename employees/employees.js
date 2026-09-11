/* ============================================================================
   Employees — a directory over the existing `profiles` table (no second
   employee database) with a profile page that gathers what WorkSuite already
   knows about a person: employment details, shift, attendance and leave
   (only for people allowed to see them), tasks, projects, calendar, activity,
   and a Message button into Messenger.

   URLs:  /employees/            directory     /employees/?id=<uuid>   profile
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'employees', crumb: 'Employees' });
    const sb = ctx.sb, me = ctx.user;

    const FULL = 'id, full_name, email, avatar_url, company, company2, department, job_title, employee_code, phone, joining_date, manager_id, status, is_wfh, shift_id, shift2_id, last_seen_at, app_role';
    const ROLE = { manager: { label: 'Manager', color: 'pending' }, admin: { label: 'Admin', color: 'leave' } };
    const EMP_STATUS = { active: { label: 'Active', color: 'present' }, inactive: { label: 'Offboarded', color: 'weekoff' } };
    const isOnline = iso => window.wsIsOnlineByLastSeen ? window.wsIsOnlineByLastSeen(iso) : (iso && (Date.now() - new Date(iso).getTime()) < 60000);
    const nameOf = p => p.full_name || (p.email || '').split('@')[0] || 'Unknown';
    let people = ctx.people.slice();
    let shifts = null;

    async function loadPeople() {
        try {
            const { data, error } = await sb.from('profiles').select(FULL).order('full_name').limit(1000);
            if (error) throw error;
            people = (data || []).map(p => ({ ...p, name: nameOf(p) }));
        } catch (e) {
            console.warn('[employees] profiles', e);
            people = ctx.people.slice();
        }
        return people;
    }
    async function loadShifts() {
        if (shifts) return shifts;
        try { const r = await sb.from('shifts').select('*'); shifts = r.error ? [] : (r.data || []); } catch (e) { shifts = []; }
        return shifts;
    }
    const clock = t => { if (!t) return ''; const hh = Number(String(t).slice(0, 2)), mm = String(t).slice(3, 5); return `${hh % 12 || 12}:${mm} ${hh >= 12 ? 'PM' : 'AM'}`; };
    const DAYS = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };
    function describeShift(s) {
        if (!s) return 'No shift configured';
        const days = (s.working_days || []).slice().sort().map(d => DAYS[d]).join(', ');
        const overnight = s.end_time <= s.start_time ? ' (+1 day)' : '';
        return `${s.name} · ${clock(s.start_time)} – ${clock(s.end_time)}${overnight}${days ? ' · ' + days : ''}`;
    }
    function onlineDot(p, cls) { return `<span class="emp-online${isOnline(p.last_seen_at) ? ' on' : ''}${cls ? ' ' + cls : ''}" title="${isOnline(p.last_seen_at) ? 'Online' : 'Offline'}"></span>`; }
    function lastSeen(p) {
        if (isOnline(p.last_seen_at)) return 'Online now';
        return p.last_seen_at ? `Last seen ${L.fmtRelative(p.last_seen_at)}` : 'Never signed in';
    }

    /* ------------------------------------------------------------ routing */
    function route() { const id = C.param('id'); return id ? showProfile(id) : showDirectory(); }
    window.addEventListener('popstate', route);
    function go(url) { history.pushState(null, '', url); route(); }

    /* ---------------------------------------------------------- directory */
    const dir = { q: '', company: '', dept: '', status: 'active', wfh: false, mode: (() => { try { return localStorage.getItem('ws-emp-view') || 'grid'; } catch (e) { return 'grid'; } })() };
    function filtered() {
        const q = dir.q.trim().toLowerCase();
        return people.filter(p => {
            const st = p.status || 'active';
            if (dir.status && st !== dir.status) return false;
            if (dir.company && p.company !== dir.company && p.company2 !== dir.company) return false;
            if (dir.dept && (p.department || '') !== dir.dept) return false;
            if (dir.wfh && !p.is_wfh) return false;
            if (q && ![p.full_name, p.email, p.employee_code, p.department, p.job_title, p.company].some(v => v && String(v).toLowerCase().includes(q))) return false;
            return true;
        }).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    }
    async function showDirectory() {
        document.title = 'Employees · WorkSuite';
        WSShell.setCrumb('Employees');
        C.loading(view, 'Loading the team…');
        await loadPeople();
        const companies = Array.from(new Set([...(window.WSCompanies ? WSCompanies.companies : []), ...people.map(p => p.company).filter(Boolean)]));
        const depts = Array.from(new Set(people.map(p => p.department).filter(Boolean))).sort();
        view.innerHTML = `
            <div class="ws-page-head">
                <div><p class="ws-eyebrow">People</p><h1>Employees</h1><p>Everyone across the group, with their team, shift and what they are working on.</p></div>
                <div class="actions">
                    <div class="crm-seg" role="group" aria-label="View">
                        <button type="button" data-mode="grid" class="${dir.mode === 'grid' ? 'on' : ''}">${C.icon('board', 'sm')}<span>Grid</span></button>
                        <button type="button" data-mode="list" class="${dir.mode === 'list' ? 'on' : ''}">${C.icon('tasks', 'sm')}<span>List</span></button>
                    </div>
                    ${ctx.isAdmin ? `<a class="ws-btn" href="/wsm-admin">${C.icon('shield')}<span>Admin console</span></a>` : ''}
                </div>
            </div>
            <div class="crm-toolbar">
                <div class="crm-search grow">${C.icon('search', 'sm')}<input type="search" id="q" placeholder="Search name, email, code, department, title…" aria-label="Search employees"></div>
                <select id="f-company" aria-label="Company"><option value="">All companies</option>${companies.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select>
                <select id="f-dept" aria-label="Department"><option value="">All departments</option>${depts.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('')}</select>
                <select id="f-status" aria-label="Status"><option value="active">Active</option>${ctx.isManager ? '<option value="inactive">Offboarded</option><option value="">All</option>' : ''}</select>
                <label class="crm-check" style="min-height:38px"><input type="checkbox" id="f-wfh"> WFH only</label>
                <span class="crm-count" id="count"></span>
            </div>
            <div id="list"></div>`;
        view.querySelector('#q').value = dir.q; view.querySelector('#f-company').value = dir.company; view.querySelector('#f-dept').value = dir.dept;
        view.querySelector('#f-status').value = ctx.isManager ? dir.status : 'active'; view.querySelector('#f-wfh').checked = dir.wfh;
        const listEl = view.querySelector('#list');
        let tbl = null;
        function paint() {
            const rows = filtered();
            view.querySelector('#count').textContent = `${rows.length} ${rows.length === 1 ? 'person' : 'people'}`;
            if (dir.mode === 'grid') {
                tbl = null;
                if (!rows.length) return C.empty(listEl, 'No one matches', 'Try a different search or clear the filters.');
                listEl.innerHTML = `<div class="emp-grid">${rows.map(p => `
                    <a class="ws-card emp-card" href="/employees/?id=${esc(p.id)}" data-emp="${esc(p.id)}">
                        <span class="ws-avatar lg">${p.avatar_url ? `<img src="${esc(p.avatar_url)}" alt="">` : esc(L.initials(nameOf(p)))}${onlineDot(p)}</span>
                        <span class="info"><b>${esc(nameOf(p))}</b><span>${esc([p.job_title, p.department].filter(Boolean).join(' · ') || (p.email || ''))}</span><span>${esc(p.company || 'Company not set')}${p.status === 'inactive' ? ' · Offboarded' : ''}</span></span>
                    </a>`).join('')}</div>`;
                listEl.querySelectorAll('[data-emp]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); go(`/employees/?id=${a.dataset.emp}`); }));
                return;
            }
            if (!listEl.querySelector('.ws-card.flush')) { listEl.innerHTML = '<div class="ws-card flush"><div id="table"></div></div>'; tbl = null; }
            const tableEl = listEl.querySelector('#table');
            const columns = [
                { key: 'full_name', label: 'Name', lead: true, value: p => nameOf(p), render: p => `<div class="who"><span class="ws-avatar" style="position:relative">${p.avatar_url ? `<img src="${esc(p.avatar_url)}" alt="">` : esc(L.initials(nameOf(p)))}${onlineDot(p)}</span><div><span class="primary-text">${esc(nameOf(p))}</span><span class="sub">${esc(p.email || '')}</span></div></div>` },
                { key: 'employee_code', label: 'Code', hideMobile: true, render: p => esc(p.employee_code || '—') },
                { key: 'department', label: 'Department', render: p => esc(p.department || '—') },
                { key: 'job_title', label: 'Job title', render: p => esc(p.job_title || '—') },
                { key: 'company', label: 'Company', render: p => esc(p.company || '—') + (p.company2 ? `<span class="sub">also ${esc(p.company2)}</span>` : '') },
                { key: 'manager_id', label: 'Manager', value: p => C.personName(p.manager_id, '—'), render: p => p.manager_id ? C.personHtml(p.manager_id, { link: false }) : '<span class="muted">—</span>' },
                { key: 'status', label: 'Status', render: p => C.statusBadge(EMP_STATUS, p.status || 'active') + (p.is_wfh ? ' ' + C.badge('info', 'WFH') : '') },
                { key: 'joining_date', label: 'Joined', hideMobile: true, render: p => esc(L.fmtDate(p.joining_date) || '—') },
                { key: 'last_seen_at', label: 'Online', render: p => isOnline(p.last_seen_at) ? C.badge('present', 'Online') : `<span class="muted">${esc(p.last_seen_at ? L.fmtRelative(p.last_seen_at) : '—')}</span>` },
            ];
            if (!tbl) tbl = C.table(tableEl, { columns, rows, sort: { key: 'full_name', dir: 'asc' }, pageSize: 50, onRow: p => go(`/employees/?id=${p.id}`), empty: { title: 'No one matches', sub: 'Try a different search or clear the filters.' } });
            else tbl.update(rows);
        }
        view.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
            dir.mode = b.dataset.mode; try { localStorage.setItem('ws-emp-view', dir.mode); } catch (e) { /* fine */ }
            view.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x === b));
            listEl.innerHTML = ''; paint();
        }));
        view.querySelector('#q').addEventListener('input', C.debounce(e => { dir.q = e.target.value; paint(); }, 150));
        view.querySelector('#f-company').addEventListener('change', e => { dir.company = e.target.value; paint(); });
        view.querySelector('#f-dept').addEventListener('change', e => { dir.dept = e.target.value; paint(); });
        view.querySelector('#f-status').addEventListener('change', e => { dir.status = e.target.value; paint(); });
        view.querySelector('#f-wfh').addEventListener('change', e => { dir.wfh = e.target.checked; paint(); });
        paint();
    }

    /* ------------------------------------------------------------ profile */
    async function showProfile(id) {
        C.loading(view, 'Loading profile…');
        let p;
        try {
            const r = await sb.from('profiles').select(FULL).eq('id', id).maybeSingle();
            if (r.error && String(r.error.code) === '42703') { const r2 = await sb.from('profiles').select('id, full_name, email, avatar_url, company, last_seen_at').eq('id', id).maybeSingle(); if (r2.error) throw r2.error; p = r2.data; }
            else { if (r.error) throw r.error; p = r.data; }
        } catch (e) { return C.errorState(view, C.friendly(e), () => showProfile(id)); }
        if (!p) { view.innerHTML = `<a class="crm-back" href="/employees/">${C.icon('arrow')}All employees</a>`; return C.empty(view.appendChild(document.createElement('div')), 'Employee not found'); }
        if (!people.length || !people.find(x => x.id === id)) await loadPeople();
        const self = p.id === me.id;
        const priv = L.canSeePrivate({ id: me.id, role: me.role, company: me.company, company2: me.company2 }, p);
        const name = nameOf(p);
        document.title = `${name} · Employees · WorkSuite`;
        WSShell.setCrumb(name);
        const reports = people.filter(x => x.manager_id === p.id && (x.status || 'active') !== 'inactive');
        await loadShifts();
        const shift = window.WSCompanies ? WSCompanies.resolveShift(p, shifts) : shifts.find(s => String(s.id) === String(p.shift_id));
        const shift2 = p.shift2_id ? shifts.find(s => String(s.id) === String(p.shift2_id)) : null;

        view.innerHTML = `
            <a class="crm-back" href="/employees/" data-nav>${C.icon('arrow')}All employees</a>
            <div class="crm-record-head">
                <span class="ws-avatar xl" style="position:relative">${p.avatar_url ? `<img src="${esc(p.avatar_url)}" alt="">` : esc(L.initials(name))}${onlineDot(p)}</span>
                <div class="titles">
                    <h1>${esc(name)}</h1>
                    <div class="meta">
                        ${p.job_title || p.department ? `<span>${esc([p.job_title, p.department].filter(Boolean).join(' · '))}</span>` : ''}
                        ${p.company ? C.badge('info', p.company) : ''}${p.company2 ? ' ' + C.badge('info', p.company2) : ''}
                        ${C.statusBadge(EMP_STATUS, p.status || 'active')}
                        ${p.is_wfh ? C.badge('leave', 'Work from home') : ''}
                        ${p.app_role && ROLE[p.app_role] ? C.statusBadge(ROLE, p.app_role) : ''}
                        <span class="muted">${esc(lastSeen(p))}</span>
                    </div>
                </div>
                <div class="actions">
                    ${self ? `<a class="ws-btn" href="/#profile">${C.icon('edit')}<span>Edit profile</span></a>` : `<a class="ws-btn primary" href="/chat/#thread=${esc(p.id)}">${C.icon('chat')}<span>Message</span></a>`}
                    ${p.email ? `<a class="ws-btn" href="mailto:${esc(p.email)}">${C.icon('mail')}<span>Email</span></a>` : ''}
                    ${p.phone ? `<a class="ws-btn" href="tel:${esc(p.phone)}">${C.icon('phone')}<span>Call</span></a>` : ''}
                    <button type="button" class="ws-btn" id="task-btn">${C.icon('tasks')}<span>Assign task</span></button>
                    <button type="button" class="ws-btn" id="meet-btn">${C.icon('calendar')}<span>Meeting</span></button>
                    ${ctx.isAdmin ? `<a class="ws-btn icon" href="/wsm-admin" title="Admin console" aria-label="Admin console">${C.icon('shield')}</a>` : ''}
                </div>
            </div>
            <div id="tabs"></div>
            <section class="crm-tabpanel" data-panel="overview">
                <div class="crm-detail">
                    <div class="ws-stack">
                        <div class="ws-card">
                            <div class="crm-section-title"><h3>Employment</h3></div>
                            <dl class="crm-props">
                                <div><dt>Email</dt><dd>${p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : '—'}</dd></div>
                                <div><dt>Phone</dt><dd>${p.phone ? `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : '—'}</dd></div>
                                <div><dt>Employee code</dt><dd>${esc(p.employee_code || '—')}</dd></div>
                                <div><dt>Company</dt><dd>${esc(p.company || '—')}${p.company2 ? `<br><span class="muted">Secondary: ${esc(p.company2)}</span>` : ''}</dd></div>
                                <div><dt>Department</dt><dd>${esc(p.department || '—')}</dd></div>
                                <div><dt>Job title</dt><dd>${esc(p.job_title || '—')}</dd></div>
                                <div><dt>Reports to</dt><dd>${p.manager_id ? C.personHtml(p.manager_id) : '—'}</dd></div>
                                <div><dt>Joining date</dt><dd>${esc(L.fmtDate(p.joining_date) || '—')}</dd></div>
                                <div><dt>Employment status</dt><dd>${C.statusBadge(EMP_STATUS, p.status || 'active')}</dd></div>
                                <div><dt>Work location</dt><dd>${p.is_wfh ? 'Work from home' : 'Office'}</dd></div>
                                <div><dt>Shift</dt><dd>${esc(describeShift(shift))}${shift && shift.company_default ? '<br><span class="muted">Company default</span>' : ''}</dd></div>
                                ${shift2 ? `<div><dt>Second shift</dt><dd>${esc(describeShift(shift2))}${p.company2 ? `<br><span class="muted">for ${esc(p.company2)}</span>` : ''}</dd></div>` : ''}
                            </dl>
                            ${ctx.isAdmin ? `<p class="muted" style="font-size:12.5px;margin:14px 0 0">Payroll, salary and offboarding are managed in the <a class="crm-link" href="/wsm-admin">Admin console</a>.</p>` : ''}
                        </div>
                        ${reports.length ? `<div class="ws-card"><div class="crm-section-title"><h3>Direct reports</h3><span class="crm-count">${reports.length}</span></div><ul class="crm-list compact">${reports.map(r => `<li>${C.avatarHtml(r)}<div class="main"><b><a href="/employees/?id=${esc(r.id)}" data-nav>${esc(nameOf(r))}</a></b><span>${esc([r.job_title, r.department].filter(Boolean).join(' · ') || r.email || '')}</span></div></li>`).join('')}</ul></div>` : ''}
                    </div>
                    <div class="ws-stack">
                        <div class="ws-card"><div class="crm-section-title"><h3>Open tasks</h3></div><div id="ov-tasks"></div></div>
                        <div class="ws-card"><div class="crm-section-title"><h3>Next 7 days</h3></div><div id="ov-events"></div></div>
                    </div>
                </div>
            </section>
            ${priv ? `<section class="crm-tabpanel" data-panel="attendance" hidden>
                <div class="ws-card flush"><div class="ws-card-head"><h3>Attendance</h3><div class="right"><input type="month" id="att-month" aria-label="Month" style="min-height:34px;padding:4px 8px"></div></div><div id="attendance"></div></div>
                <div class="ws-card flush" style="margin-top:16px"><div class="ws-card-head"><h3>Leave requests</h3></div><div id="leave"></div></div>
            </section>` : ''}
            <section class="crm-tabpanel" data-panel="tasks" hidden><div class="ws-card flush"><div class="ws-card-head"><h3>Tasks</h3><div class="right"><button type="button" class="ws-btn sm primary" id="task-btn-2">${C.icon('plus')}<span>Assign task</span></button></div></div><div id="tasks"></div></div></section>
            <section class="crm-tabpanel" data-panel="projects" hidden><div class="ws-card flush"><div class="ws-card-head"><h3>Projects</h3></div><div id="projects"></div></div></section>
            <section class="crm-tabpanel" data-panel="calendar" hidden><div class="ws-card flush"><div class="ws-card-head"><h3>Upcoming 30 days</h3><div class="right"><a class="ws-btn sm" href="/calendar/">${C.icon('calendar')}<span>Open calendar</span></a></div></div><div id="events"></div></div></section>
            <section class="crm-tabpanel" data-panel="activity" hidden><div class="ws-card"><div id="activity"></div></div></section>`;
        view.querySelectorAll('[data-nav]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); go(a.getAttribute('href')); }));

        const tabItems = [{ key: 'overview', label: 'Overview' }];
        if (priv) tabItems.push({ key: 'attendance', label: 'Attendance & leave' });
        tabItems.push({ key: 'tasks', label: 'Tasks' }, { key: 'projects', label: 'Projects' }, { key: 'calendar', label: 'Calendar' }, { key: 'activity', label: 'Activity' });
        const loaded = {};
        const tabs = C.tabs(view.querySelector('#tabs'), tabItems, { hash: true, onChange: loadTab });
        const lk = await C.lookups();
        const taskStatus = Object.fromEntries(lk.taskStatuses.map(s => [s.key, s]));

        // Overview widgets
        (async () => {
            const el = view.querySelector('#ov-tasks');
            const rows = await C.related('tasks', 'assignee_id', p.id, 'id, title, status, priority, due_date, completed_at, archived_at', b => b.is('archived_at', null).is('completed_at', null).order('due_date', { ascending: true, nullsFirst: false }).limit(6));
            if (!rows.length) return C.empty(el, 'No open tasks');
            el.innerHTML = `<ul class="crm-list compact">${rows.map(t => `<li>${C.icon('tasks')}<div class="main"><b><a href="/tasks/?id=${esc(t.id)}">${esc(t.title)}</a></b><span>${esc(taskStatus[t.status] ? taskStatus[t.status].label : t.status)}</span></div><div class="right">${C.dueHtml(t)}</div></li>`).join('')}</ul>`;
        })();
        (async () => {
            const el = view.querySelector('#ov-events');
            const rows = await upcomingEvents(p.id, 7);
            if (!rows.length) return C.empty(el, 'Nothing scheduled');
            el.innerHTML = `<ul class="crm-list compact">${rows.slice(0, 6).map(e => `<li>${C.icon('calendar')}<div class="main"><b><a href="/calendar/?id=${esc(e.id)}">${esc(e.title)}</a></b><span>${esc(e.all_day ? L.fmtDate(e.starts_at) : L.fmtDateTime(e.starts_at))}</span></div></li>`).join('')}</ul>`;
        })();

        async function upcomingEvents(userId, days) {
            const from = new Date().toISOString(), to = new Date(Date.now() + days * 86400000).toISOString();
            try {
                const [own, part] = await Promise.all([
                    sb.from('calendar_events').select('id, title, starts_at, ends_at, all_day, event_type, status, owner_id').eq('owner_id', userId).eq('status', 'scheduled').gte('ends_at', from).lte('starts_at', to).order('starts_at').limit(100),
                    sb.from('event_participants').select('event:calendar_events(id, title, starts_at, ends_at, all_day, event_type, status, owner_id)').eq('user_id', userId).limit(200),
                ]);
                const map = new Map();
                (own.data || []).forEach(e => map.set(e.id, e));
                (part.data || []).map(r => r.event).filter(e => e && e.status === 'scheduled' && e.ends_at >= from && e.starts_at <= to).forEach(e => map.set(e.id, e));
                return Array.from(map.values()).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
            } catch (e) { return []; }
        }

        function loadTab(k) {
            if (loaded[k]) return; loaded[k] = true;
            if (k === 'attendance') { renderAttendance(); renderLeave(); }
            if (k === 'tasks') renderTasks();
            if (k === 'projects') renderProjects();
            if (k === 'calendar') renderEvents();
            if (k === 'activity') C.activityFeed(view.querySelector('#activity'), { actor_id: p.id, withComments: false, limit: 50 });
        }
        async function renderTasks() {
            const el = view.querySelector('#tasks'); C.skeletonRows(el, 4);
            const rows = await C.related('tasks', 'assignee_id', p.id, 'id, title, status, priority, due_date, completed_at, archived_at, project_id, created_at', b => b.is('archived_at', null).limit(300));
            rows.sort((a, b) => (a.completed_at ? 1 : 0) - (b.completed_at ? 1 : 0) || String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));
            C.table(el, {
                rows, onRow: t => { location.href = `/tasks/?id=${t.id}`; },
                columns: [
                    { key: 'title', label: 'Task', lead: true, render: t => `<span class="primary-text">${esc(t.title)}</span>` },
                    { key: 'status', label: 'Status', render: t => C.statusBadge(taskStatus, t.status) },
                    { key: 'priority', label: 'Priority', render: t => C.priorityBadge(t.priority) },
                    { key: 'due_date', label: 'Due', render: t => C.dueHtml(t) },
                ],
                empty: { title: 'No tasks assigned', sub: self ? 'Tasks assigned to you will appear here.' : `Assign ${name} a task from the button above.` },
            });
        }
        async function renderProjects() {
            const el = view.querySelector('#projects'); C.skeletonRows(el, 3);
            const cols = 'id, name, status, priority, due_date, owner_id, manager_id, archived_at';
            let rows = [];
            try {
                const [mem, own, mgr] = await Promise.all([
                    sb.from('project_members').select('role, project:projects(' + cols + ')').eq('user_id', p.id),
                    sb.from('projects').select(cols).eq('owner_id', p.id).is('archived_at', null),
                    sb.from('projects').select(cols).eq('manager_id', p.id).is('archived_at', null),
                ]);
                const map = new Map();
                (own.data || []).forEach(x => map.set(x.id, { ...x, role: 'Owner' }));
                (mgr.data || []).forEach(x => { if (!map.has(x.id)) map.set(x.id, { ...x, role: 'Project manager' }); });
                (mem.data || []).map(r => r.project && { ...r.project, role: r.role === 'manager' ? 'Project manager' : 'Member' }).filter(x => x && !x.archived_at).forEach(x => { if (!map.has(x.id)) map.set(x.id, x); });
                rows = Array.from(map.values());
            } catch (e) { return C.errorState(el, C.friendly(e)); }
            C.table(el, {
                rows, onRow: r => { location.href = `/projects/?id=${r.id}`; },
                columns: [
                    { key: 'name', label: 'Project', lead: true, render: r => `<span class="primary-text">${esc(r.name)}</span>` },
                    { key: 'role', label: 'Role', render: r => esc(r.role) },
                    { key: 'status', label: 'Status', render: r => C.statusBadge(L.PROJECT_STATUS, r.status) },
                    { key: 'due_date', label: 'Due', render: r => esc(L.fmtDate(r.due_date) || '—') },
                ],
                empty: { title: 'No projects', sub: `${self ? 'You are' : name + ' is'} not on any project yet.` },
            });
        }
        async function renderEvents() {
            const el = view.querySelector('#events'); C.skeletonRows(el, 3);
            const rows = await upcomingEvents(p.id, 30);
            C.table(el, {
                rows, onRow: e => { location.href = `/calendar/?id=${e.id}`; },
                columns: [
                    { key: 'title', label: 'Event', lead: true, render: e => `<span class="primary-text">${esc(e.title)}</span>` },
                    { key: 'event_type', label: 'Type', render: e => C.statusBadge(L.EVENT_TYPE, e.event_type) },
                    { key: 'starts_at', label: 'When', render: e => esc(e.all_day ? L.fmtDate(e.starts_at) + ' · all day' : L.fmtDateTime(e.starts_at)) },
                    { key: 'owner_id', label: 'Organiser', value: e => C.personName(e.owner_id), render: e => C.personHtml(e.owner_id, { link: false }) },
                ],
                empty: { title: 'Nothing in the next 30 days' },
            });
        }
        async function renderAttendance() {
            const el = view.querySelector('#attendance'); const monthInput = view.querySelector('#att-month');
            monthInput.value = L.todayIST().slice(0, 7);
            async function load() {
                C.skeletonRows(el, 5);
                const ym = monthInput.value || L.todayIST().slice(0, 7);
                const from = `${ym}-01`; const to = L.addDays(L.dateRange('month', new Date(`${ym}-15T12:00:00+05:30`)).to, 0);
                try {
                    const r = await sb.from('attendance_logs').select('id, log_date, log_time, log_datetime, direction, event_type, source, location_address')
                        .eq('user_id', p.id).gte('log_date', from).lte('log_date', to).order('log_datetime', { ascending: false }).limit(500);
                    if (r.error) throw r.error;
                    const logs = r.data || [];
                    if (!logs.length) return C.empty(el, self ? 'No punches this month' : 'No attendance visible', self ? '' : 'Either nothing was recorded, or you do not have permission to view this person\'s attendance.');
                    const days = new Map();
                    logs.forEach(l => {
                        const d = days.get(l.log_date) || { log_date: l.log_date, punches: 0, first_in: null, last_out: null, sources: new Set(), place: null };
                        d.punches++;
                        if (l.direction === 'IN' && (!d.first_in || l.log_datetime < d.first_in)) d.first_in = l.log_datetime;
                        if (l.direction === 'OUT' && (!d.last_out || l.log_datetime > d.last_out)) d.last_out = l.log_datetime;
                        if (l.source) d.sources.add(l.source); if (l.location_address && !d.place) d.place = l.location_address;
                        days.set(l.log_date, d);
                    });
                    const rows = Array.from(days.values()).sort((a, b) => b.log_date.localeCompare(a.log_date));
                    C.table(el, {
                        rows, key: 'log_date', sort: { key: 'log_date', dir: 'desc' },
                        columns: [
                            { key: 'log_date', label: 'Date', lead: true, render: d => `<span class="primary-text">${esc(L.fmtDate(d.log_date))}</span>` },
                            { key: 'first_in', label: 'First in', render: d => d.first_in ? esc(L.fmtTime(d.first_in)) : '<span class="muted">—</span>' },
                            { key: 'last_out', label: 'Last out', render: d => d.last_out ? esc(L.fmtTime(d.last_out)) : C.badge('late', 'No check-out') },
                            { key: 'punches', label: 'Punches', num: true, render: d => String(d.punches) },
                            { key: 'sources', label: 'Source', hideMobile: true, render: d => esc(Array.from(d.sources).map(s => s === 'selfie' ? 'Selfie (WFH)' : s).join(', ') || 'Biometric') + (d.place ? `<span class="sub">${esc(d.place)}</span>` : '') },
                        ],
                        empty: { title: 'No punches this month' },
                    });
                } catch (e) { C.errorState(el, C.friendly(e), load); }
            }
            monthInput.addEventListener('change', load);
            load();
        }
        async function renderLeave() {
            const el = view.querySelector('#leave'); C.skeletonRows(el, 3);
            try {
                const r = await sb.from('leave_requests').select('id, start_date, end_date, day_part, reason, status, created_at, decided_at, leave_type:leave_types(code, name)').eq('user_id', p.id).order('start_date', { ascending: false }).limit(100);
                if (r.error) throw r.error;
                const LV = { pending: { label: 'Pending', color: 'pending' }, approved: { label: 'Approved', color: 'present' }, rejected: { label: 'Rejected', color: 'absent' }, cancelled: { label: 'Cancelled', color: 'mute' } };
                C.table(el, {
                    rows: r.data || [], sort: { key: 'start_date', dir: 'desc' },
                    columns: [
                        { key: 'start_date', label: 'Dates', lead: true, render: x => `<span class="primary-text">${esc(L.fmtDate(x.start_date))}${x.end_date !== x.start_date ? ' – ' + esc(L.fmtDate(x.end_date)) : ''}</span>${x.day_part !== 'full' ? `<span class="sub">${esc(x.day_part.replace('_', ' '))}</span>` : ''}` },
                        { key: 'type', label: 'Type', value: x => x.leave_type ? x.leave_type.name : '', render: x => esc(x.leave_type ? x.leave_type.name : '—') },
                        { key: 'status', label: 'Status', render: x => C.statusBadge(LV, x.status) },
                        { key: 'reason', label: 'Reason', hideMobile: true, render: x => esc(x.reason || '—') },
                    ],
                    empty: { title: 'No leave requests', sub: self ? 'Apply for leave from My Attendance.' : '' },
                });
            } catch (e) { C.errorState(el, C.friendly(e)); }
        }
        loadTab(tabs.active);

        const assign = () => C.openTaskEditor({ defaults: { assignee_id: p.id }, onSaved: () => { loaded.tasks = false; if (tabs.active === 'tasks') loadTab('tasks'); showProfile(id); } });
        view.querySelector('#task-btn').addEventListener('click', assign);
        view.querySelector('#task-btn-2').addEventListener('click', assign);
        view.querySelector('#meet-btn').addEventListener('click', () => C.openEventEditor({ defaults: { participants: self ? [] : [p.id], title: self ? '' : `Meeting with ${name}` }, onSaved: () => showProfile(id) }));
    }

    route();
})();
