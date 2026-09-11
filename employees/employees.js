/* ============================================================================
   Employees — "Find employee" in the Bitrix24 layout: a filterable list (or
   tiles) over the existing `profiles` table, with presets for the active
   team, people who have not signed in yet, who is online now and (for
   managers) offboarded people. The profile page gathers what WorkSuite
   already knows about a person: employment details, departments, shift,
   attendance and leave (only for people allowed to see them), tasks,
   projects, calendar, activity, and a Message button into Messenger.

   URLs:  /employees/            directory     /employees/?id=<uuid>   profile
          /employees/?view=tiles                /employees/structure/   company structure
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc, B = window.WSB24;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'employees', crumb: 'Employees' });
    const sb = ctx.sb, me = ctx.user;

    const FULL = 'id, full_name, email, avatar_url, company, company2, department, job_title, employee_code, phone, joining_date, manager_id, status, is_wfh, shift_id, shift2_id, last_seen_at, app_role';
    const ROLE = { manager: { label: 'Manager', color: 'pending' }, admin: { label: 'Admin', color: 'leave' } };
    const EMP_STATUS = { active: { label: 'Active', color: 'present' }, inactive: { label: 'Offboarded', color: 'weekoff' } };
    const ONLINE_MS = 2 * 60000;
    const isOnline = iso => window.wsIsOnlineByLastSeen ? window.wsIsOnlineByLastSeen(iso) : (iso && (Date.now() - new Date(iso).getTime()) < 60000);
    const nameOf = p => p.full_name || (p.email || '').split('@')[0] || 'Unknown';
    const pref = (k, d) => { try { return localStorage.getItem(k) || d; } catch (e) { return d; } };
    const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } };
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
        return p.last_seen_at ? `Last seen ${L.fmtRelative(p.last_seen_at)}` : 'Not signed in yet';
    }
    const avatar = (p, cls) => `<span class="ws-avatar${cls ? ' ' + cls : ''}" style="position:relative">${p.avatar_url ? `<img src="${esc(p.avatar_url)}" alt="">` : esc(L.initials(nameOf(p)))}${onlineDot(p)}</span>`;

    /* ------------------------------------------------------------ routing */
    const page = { grid: null, filter: null, mode: 'list' };
    function route() {
        if (page.grid) { page.grid.destroy(); page.grid = null; }
        if (page.filter) { page.filter.destroy(); page.filter = null; }
        const id = C.param('id');
        return id ? showProfile(id) : showDirectory();
    }
    window.addEventListener('popstate', route);
    function go(url) { history.pushState(null, '', url); route(); }

    /* ---------------------------------------------------------- directory */
    const quote = v => `"${String(v).replace(/["\\]/g, '\\$&')}"`;
    function scoped(b) {
        const v = page.filter ? page.filter.get().values : {};
        // Offboarded people are for managers; everyone else always sees the active team.
        const st = ctx.isManager ? (v.status || '') : 'active';
        if (st === 'active') b = b.or('status.is.null,status.eq.active');
        else if (st) b = b.eq('status', st);
        return page.filter ? page.filter.apply(b, { searchColumns: ['full_name', 'email', 'employee_code', 'job_title', 'department'] }) : b;
    }
    function personMenu(p) {
        const items = [{ label: 'Open profile', icon: 'user', onClick: () => go(`/employees/?id=${p.id}`) }];
        if (p.id !== me.id) items.push({ label: 'Message', icon: 'chat', onClick: () => { location.href = `/chat/#thread=${p.id}`; } });
        items.push({ label: 'Assign a task', icon: 'tasks', onClick: () => C.openTaskEditor({ defaults: { assignee_id: p.id } }) },
                   { label: 'Schedule a meeting', icon: 'calendar', onClick: () => C.openEventEditor({ defaults: { participants: p.id === me.id ? [] : [p.id], title: p.id === me.id ? '' : `Meeting with ${nameOf(p)}` } }) });
        if (p.email) items.push({ label: 'Send an email', icon: 'mail', onClick: () => { location.href = `mailto:${p.email}`; } });
        if (ctx.isAdmin) items.push('sep', { label: 'Edit in the admin console', icon: 'shield', onClick: () => { location.href = '/wsm-admin'; } });
        return items;
    }
    async function showDirectory() {
        document.title = 'Employees · WorkSuite';
        WSShell.setCrumb('Employees');
        view.classList.remove('b24-legacy-panel');
        let mode = pref('ws-emp-view', 'list');
        if (['list', 'tiles'].includes(C.param('view'))) mode = C.param('view');
        page.mode = mode === 'tiles' || mode === 'grid' ? 'tiles' : 'list';
        const companies = Array.from(new Set([...(window.WSCompanies ? WSCompanies.companies : []), ...people.map(p => p.company).filter(Boolean)])).sort();
        const depts = Array.from(new Set(people.map(p => (p.department || '').trim()).filter(Boolean))).sort();
        view.innerHTML = B.titleBar({ title: 'Employees', createLabel: ctx.isAdmin ? 'Invite' : '' })
            + `<div class="b24-toolbar emp-toolbar">
                <div class="b24-views" role="tablist" aria-label="View"><button type="button" role="tab" data-view="list">List</button><button type="button" role="tab" data-view="tiles">Tiles</button></div>
                <span class="grow"></span>
                <button type="button" class="emp-online-chip" data-online title="Show who is online"><i></i><span data-online-n>…</span></button>
                <span class="crm-count" data-total></span>
            </div>
            <div id="body"></div>`;
        page.filter = WSFilter.mount(view.querySelector('[data-filter]'), {
            id: 'employees', me: me.id, defaultPreset: 'active', placeholder: 'Find employee',
            presets: [
                { key: 'active', title: 'Employees', values: {} },
                { key: 'invited', title: 'Not signed in yet', values: { invited: true } },
                { key: 'online', title: 'Online now', values: { online: true } },
                { key: 'wfh', title: 'Working from home', values: { wfh: true } },
                ...(ctx.isManager ? [{ key: 'offboarded', title: 'Offboarded', values: { status: 'inactive' } }] : []),
            ],
            fields: [
                { key: 'company', title: 'Company', type: 'select', options: companies.map(c => ({ value: c, label: c })), apply: (b, v) => b.or(`company.eq.${quote(v)},company2.eq.${quote(v)}`) },
                { key: 'department', title: 'Department', type: 'select', options: depts.map(d => ({ value: d, label: d })) },
                { key: 'job_title', title: 'Position', type: 'text' },
                { key: 'manager', title: 'Reports to', type: 'user', column: 'manager_id', options: B.peopleOptions(), none: false },
                ...(ctx.isManager ? [{ key: 'status', title: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Offboarded' }], apply: b => b }] : []),
                { key: 'wfh', title: 'Works from home', type: 'check', column: 'is_wfh' },
                { key: 'invited', title: 'Not signed in yet', type: 'check', apply: b => b.is('last_seen_at', null) },
                { key: 'online', title: 'Online now', type: 'check', apply: b => b.gte('last_seen_at', new Date(Date.now() - ONLINE_MS).toISOString()) },
                { key: 'joined', title: 'Joined', type: 'date', column: 'joining_date' },
            ],
            onChange: () => mountBody(),
        });
        const inv = view.querySelector('[data-create]');
        if (inv) inv.addEventListener('click', () => { location.href = '/wsm-admin'; });
        view.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { page.mode = b.dataset.view; setPref('ws-emp-view', page.mode); C.setParam('view', null, true); mountBody(); }));
        view.querySelector('[data-online]').addEventListener('click', () => page.filter.set({ online: true }, 'online'));
        mountBody();
        countOnline();
    }
    async function countOnline() {
        const el = view.querySelector('[data-online-n]'); if (!el) return;
        try {
            const r = await sb.from('profiles').select('id', { count: 'exact', head: true }).gte('last_seen_at', new Date(Date.now() - ONLINE_MS).toISOString()).or('status.is.null,status.eq.active');
            el.textContent = `${r.count || 0} online now`;
        } catch (e) { el.textContent = 'Online now'; }
    }
    function mountBody() {
        const body = view.querySelector('#body'); if (!body) return;
        if (page.grid) { page.grid.destroy(); page.grid = null; }
        body.innerHTML = '';
        view.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('on', b.dataset.view === page.mode); b.setAttribute('aria-selected', b.dataset.view === page.mode ? 'true' : 'false'); });
        const host = document.createElement('div'); body.appendChild(host);
        const total = view.querySelector('[data-total]');
        C.q(scoped(sb.from('profiles').select('id', { count: 'exact', head: true }))).then(r => { if (total) total.textContent = `${r.count || 0} ${r.count === 1 ? 'person' : 'people'}`; }).catch(() => {});
        if (page.mode === 'tiles') return mountTiles(host);
        page.grid = WSGrid.mount(host, {
            id: 'employees', sort: { key: 'full_name', dir: 'asc' },
            columns: [
                { key: 'full_name', title: 'Name', width: 290, render: p => `<span class="b24-who">${avatar(p)}<span><a href="/employees/?id=${esc(p.id)}" data-emp="${esc(p.id)}">${esc(nameOf(p))}</a><span class="sub">${esc(p.email || '')}</span></span></span>` },
                { key: 'job_title', title: 'Position', width: 170, render: p => esc(p.job_title || '') },
                { key: 'department', title: 'Department', width: 160, render: p => esc(p.department || '') },
                { key: 'company', title: 'Company', width: 190, render: p => esc(p.company || '') + (p.company2 ? `<span class="sub">also ${esc(p.company2)}</span>` : '') },
                { key: 'phone', title: 'Phone', width: 140, default: false, render: p => (p.phone ? `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : '') },
                { key: 'email', title: 'Email', width: 210, default: false, render: p => (p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : '') },
                { key: 'manager_id', title: 'Reports to', width: 180, render: p => (p.manager_id ? C.personHtml(p.manager_id, { link: false }) : '') },
                { key: 'employee_code', title: 'Code', width: 100, default: false, render: p => esc(p.employee_code || '') },
                { key: 'status', title: 'Status', width: 140, render: p => C.statusBadge(EMP_STATUS, p.status || 'active') + (p.is_wfh ? ' ' + C.badge('info', 'WFH') : '') },
                { key: 'joining_date', title: 'Joined', width: 120, default: false, render: p => esc(L.fmtDate(p.joining_date) || '') },
                { key: 'last_seen_at', title: 'Last seen', width: 150, render: p => (isOnline(p.last_seen_at) ? C.badge('present', 'Online') : `<span class="muted">${esc(p.last_seen_at ? L.fmtRelative(p.last_seen_at) : 'Not signed in yet')}</span>`) },
            ],
            load: async ({ offset, limit, sort }) => {
                let b = scoped(sb.from('profiles').select(FULL));
                b = sort ? b.order(sort.key, { ascending: sort.dir === 'asc', nullsFirst: false }) : b.order('full_name');
                return (await C.q(b.range(offset, offset + limit - 1))).data || [];
            },
            count: async () => (await C.q(scoped(sb.from('profiles').select('id', { count: 'exact', head: true })))).count || 0,
            onOpen: p => go(`/employees/?id=${p.id}`),
            rowMenu: personMenu,
            empty: { title: 'No one matches', sub: 'Try another name, or clear the filter.' },
        });
        host.addEventListener('click', e => {
            const a = e.target.closest('a[data-emp]'); if (!a || e.metaKey || e.ctrlKey) return;
            e.preventDefault(); go(`/employees/?id=${a.dataset.emp}`);
        });
    }
    async function mountTiles(host) {
        const PAGE = 60;
        let offset = 0, rows = [];
        host.innerHTML = '<div data-empty hidden></div><div class="b24-tiles emp-tiles" data-cards></div><div class="dv-more" data-more hidden><button type="button" class="ws-btn">Show more</button></div>';
        const cards = host.querySelector('[data-cards]'), more = host.querySelector('[data-more]'), empty = host.querySelector('[data-empty]');
        const tile = p => `<article class="b24-tile emp-tile" data-id="${esc(p.id)}">
                <div class="top">${avatar(p, 'lg')}<div class="t"><a href="/employees/?id=${esc(p.id)}" data-emp="${esc(p.id)}">${esc(nameOf(p))}</a><span>${esc(p.job_title || p.email || '')}</span></div><button type="button" class="g-rowmenu" data-tile-menu aria-label="Actions for ${esc(nameOf(p))}">☰</button></div>
                <div class="emp-meta"><span>${esc(p.department || '')}</span><span>${esc(p.company || '')}</span></div>
                <div class="foot">${C.statusBadge(EMP_STATUS, p.status || 'active')}${p.is_wfh ? C.badge('info', 'WFH') : ''}<span class="grow"></span><span class="muted" style="font-size:12px">${esc(lastSeen(p))}</span></div>
            </article>`;
        async function next() {
            const b = scoped(sb.from('profiles').select(FULL)).order('full_name');
            const data = (await C.q(b.range(offset, offset + PAGE))).data || [];
            const got = data.slice(0, PAGE); offset += got.length; rows = rows.concat(got);
            cards.insertAdjacentHTML('beforeend', got.map(tile).join(''));
            more.hidden = data.length <= PAGE;
            if (!rows.length) { empty.hidden = false; C.empty(empty, 'No one matches', 'Try another name, or clear the filter.'); }
        }
        try { await next(); } catch (e) { empty.hidden = false; return C.errorState(empty, e, () => mountTiles(host)); }
        more.querySelector('button').addEventListener('click', () => next().catch(e => C.toast(e.message, 'bad')));
        cards.addEventListener('click', e => {
            const t = e.target.closest('.emp-tile'); if (!t) return;
            const p = rows.find(r => r.id === t.dataset.id); if (!p) return;
            const m = e.target.closest('[data-tile-menu]');
            if (m) return C.menu(m, personMenu(p));
            if (e.target.closest('a') && (e.metaKey || e.ctrlKey)) return;
            e.preventDefault(); go(`/employees/?id=${p.id}`);
        });
    }

    /* ------------------------------------------------------------ profile */
    async function showProfile(id) {
        view.classList.add('b24-legacy-panel');
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
                                <div id="emp-depts-row" hidden><dt>In the company structure</dt><dd id="emp-depts"></dd></div>
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

        // Departments from the company structure (once supabase-b24-migration.sql is in).
        (async () => {
            const r = await sb.from('department_members').select('role, position, department:departments(id, name)').eq('user_id', p.id);
            const rows = r.error ? [] : (r.data || []).filter(x => x.department);
            const row = view.querySelector('#emp-depts-row'); if (!row || !rows.length) return;
            row.hidden = false;
            view.querySelector('#emp-depts').innerHTML = rows.map(x => `<a href="/employees/structure/?dept=${esc(x.department.id)}">${esc(x.department.name)}</a>${x.role !== 'member' ? ` <span class="muted">(${x.role === 'head' ? 'head' : 'deputy'})</span>` : ''}${x.position ? ` <span class="muted">· ${esc(x.position)}</span>` : ''}`).join('<br>');
        })();
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
