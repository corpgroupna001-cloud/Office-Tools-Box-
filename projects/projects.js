/* ============================================================================
   Projects — list (cards / table), create/edit with members, and a project
   workspace with Overview / Tasks / Board / Files / Calendar / Activity /
   Members tabs. Progress is derived from the project's tasks, never typed in.
   Everything goes through Supabase behind RLS via the shared WSCrm runtime.

   URLs:  /projects/            list         /projects/?id=<uuid>   record
          /projects/?new=1      list + new-project dialog
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'projects', crumb: 'Projects' });
    const sb = ctx.sb, me = ctx.user;

    const SELECT = 'id, company, name, description, owner_id, manager_id, status, priority, start_date, due_date, completed_at, contact_id, deal_id, board_id, tags, archived_at, created_by, created_at, updated_at';
    const TASK_SELECT = 'id, title, status, priority, assignee_id, project_id, board_id, board_column_id, position, due_date, due_time, completed_at, archived_at, created_by, created_at';
    const STATUS_OPTS = Object.entries(L.PROJECT_STATUS).map(([k, v]) => ({ value: k, label: v.label }));
    const PRIORITY_OPTS = Object.entries(L.PRIORITY).map(([k, v]) => ({ value: k, label: v.label }));
    let unsubscribe = null;
    let routeSeq = 0;               // guards against a slow list load finishing after the user opened a record

    /* ------------------------------------------------------------ routing */
    function route() {
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        const id = C.param('id');
        if (id) return showRecord(id);
        return showList();
    }
    window.addEventListener('popstate', route);
    function go(url) { history.pushState(null, '', url); route(); }
    function on(sel, fn) { const el = view.querySelector(sel); if (el) el.addEventListener('click', fn); }

    /* ------------------------------------------------------------ helpers */
    async function membersFor(projectIds) {
        if (!projectIds.length) return [];
        const r = await sb.from('project_members').select('project_id, user_id, role, added_by, created_at').in('project_id', projectIds);
        if (r.error) { if (!C.isMissingSchema(r.error)) console.warn('[projects] members', r.error); return []; }
        return r.data || [];
    }
    async function progressTasksFor(projectIds) {
        if (!projectIds.length) return [];
        const r = await sb.from('tasks').select('id, project_id, completed_at, archived_at').in('project_id', projectIds).is('archived_at', null);
        if (r.error) { if (!C.isMissingSchema(r.error)) console.warn('[projects] tasks', r.error); return []; }
        return r.data || [];
    }
    function dueChip(p) {
        if (!p.due_date) return '<span class="muted">No due date</span>';
        if (p.status === 'completed' || p.status === 'cancelled') return `<span class="crm-due completed">${esc(L.fmtDate(p.due_date, { short: true }))}</span>`;
        const st = L.taskDueState({ due_date: p.due_date });
        const label = st === 'overdue' ? `Overdue · ${L.fmtDate(p.due_date, { short: true })}` : st === 'today' ? 'Due today' : `Due ${L.fmtDate(p.due_date, { short: true })}`;
        return `<span class="crm-due ${st}">${esc(label)}</span>`;
    }
    function progressHtml(prog, withText) {
        return `<div class="ws-bar" title="${prog.done} of ${prog.total} tasks done"><i style="width:${prog.pct}%"></i></div>${withText ? `<span class="muted" style="font-size:12.5px">${prog.done} of ${prog.total} task${prog.total === 1 ? '' : 's'} done · ${prog.pct}%</span>` : ''}`;
    }
    function canEditProject(p, memberIds) {
        return L.canEdit({ owner_id: p.owner_id, manager_id: p.manager_id, created_by: p.created_by, member_ids: memberIds || [] }, me);
    }

    /* ------------------------------------------------------- project form */
    function projectFields() {
        return [
            { name: 'name', label: 'Project name', type: 'text', required: true, full: true },
            { name: 'description', label: 'Description', type: 'textarea', full: true, rows: 3 },
            { name: 'owner_id', label: 'Owner', type: 'people', none: null },
            { name: 'manager_id', label: 'Project manager', type: 'people', none: 'Not assigned' },
            { name: 'status', label: 'Status', type: 'select', options: STATUS_OPTS, required: true },
            { name: 'priority', label: 'Priority', type: 'select', options: PRIORITY_OPTS, required: true },
            { name: 'start_date', label: 'Start date', type: 'date' },
            { name: 'due_date', label: 'Due date', type: 'date', validate: (v, all) => v && all.start_date && L.dayNumber(v) < L.dayNumber(all.start_date) ? 'Due date is before the start date' : '' },
            { name: 'contact_id', label: 'Related contact', type: 'entity', entity: 'contact', placeholder: 'Search contacts' },
            { name: 'deal_id', label: 'Related deal', type: 'entity', entity: 'deal', placeholder: 'Search deals' },
            { name: 'tags', label: 'Tags', type: 'tags', full: true },
            { name: 'members', label: 'Members', type: 'peoples', full: true },
        ];
    }
    async function syncMembers(projectId, wantIds, currentIds) {
        const want = new Set((wantIds || []).filter(Boolean)), cur = new Set(currentIds || []);
        const add = [...want].filter(id => !cur.has(id)), rm = [...cur].filter(id => !want.has(id));
        if (add.length) await C.q(sb.from('project_members').insert(add.map(id => ({ project_id: projectId, user_id: id, role: 'member', added_by: me.id }))));
        if (rm.length) await C.q(sb.from('project_members').delete().eq('project_id', projectId).in('user_id', rm));
        return add;
    }
    async function openProjectEditor(project, currentMemberIds, onSaved) {
        const isNew = !project;
        return C.formModal({
            title: isNew ? 'New project' : 'Edit project', size: 'wide', fields: projectFields(),
            values: isNew ? { status: 'planning', priority: 'normal', owner_id: me.id, manager_id: me.id, members: [] } : { ...project, members: currentMemberIds || [] },
            submitLabel: isNew ? 'Create project' : 'Save changes',
            onSubmit: async v => {
                const row = {
                    name: v.name.trim(), description: v.description || null, owner_id: v.owner_id || me.id, manager_id: v.manager_id || null,
                    status: v.status, priority: v.priority, start_date: v.start_date || null, due_date: v.due_date || null,
                    contact_id: v.contact_id || null, deal_id: v.deal_id || null, tags: v.tags || [],
                    completed_at: v.status === 'completed' ? (project && project.completed_at) || L.todayIST() : null,
                };
                let saved;
                if (isNew) {
                    const ins = await C.q(sb.from('projects').insert({ ...row, created_by: me.id }).select('id').single());
                    // The database trigger creates the project's board; re-fetch to pick up board_id.
                    saved = (await C.q(sb.from('projects').select(SELECT).eq('id', ins.data.id).single())).data;
                } else {
                    saved = (await C.q(sb.from('projects').update(row).eq('id', project.id).select(SELECT).single())).data;
                }
                try {
                    const added = await syncMembers(saved.id, v.members, isNew ? [] : currentMemberIds);
                    added.forEach(id => C.pushNotify({ to: id, title: 'Added to a project', body: saved.name, url: `/projects/?id=${saved.id}`, tag: 'project' }));
                } catch (e) { C.toast('Project saved, but members could not be updated: ' + e.message, 'bad'); }
                if (saved.manager_id && saved.manager_id !== me.id && (isNew || saved.manager_id !== project.manager_id)) C.pushNotify({ to: saved.manager_id, title: 'You manage a project', body: saved.name, url: `/projects/?id=${saved.id}`, tag: 'project' });
                C.toast(isNew ? 'Project created' : 'Project saved', 'ok');
                if (onSaved) onSaved(saved);
                return saved;
            },
        });
    }
    async function changeStatus(p, status, after) {
        try {
            await C.q(sb.from('projects').update({ status, completed_at: status === 'completed' ? (p.completed_at || L.todayIST()) : null }).eq('id', p.id));
            C.toast(`Project marked ${L.PROJECT_STATUS[status].label.toLowerCase()}`, 'ok');
            if (after) after();
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function setArchived(p, archived, after) {
        if (archived && !await C.confirm({ title: `Archive ${p.name}?`, message: 'The project is hidden from lists but keeps its tasks, files and history. You can restore it later.', okText: 'Archive', danger: true })) return;
        try {
            await C.q(sb.from('projects').update({ archived_at: archived ? new Date().toISOString() : null }).eq('id', p.id));
            C.toast(archived ? 'Project archived' : 'Project restored', 'ok');
            if (after) after();
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function deleteProject(p) {
        if (!await C.confirm({ title: 'Delete this project permanently?', message: 'Its board is removed and its tasks lose the project link (they are kept). Archiving is usually the better choice.', okText: 'Delete permanently', danger: true })) return;
        try { await C.q(sb.from('projects').delete().eq('id', p.id)); C.toast('Project deleted', 'ok'); go('/projects/'); }
        catch (e) { C.toast(e.message, 'bad'); }
    }
    function statusMenuItems(p, after) {
        return STATUS_OPTS.filter(o => o.value !== p.status).map(o => ({ label: `Mark ${o.label.toLowerCase()}`, icon: 'check', onClick: () => changeStatus(p, o.value, after) }));
    }

    /* --------------------------------------------------------------- list */
    let listState = { seg: 'active', q: '', person: '', priority: '', mine: false, mode: 'cards', rows: [], members: [], tasks: [] };
    try { listState.mode = localStorage.getItem('ws-projects-mode') === 'table' ? 'table' : 'cards'; } catch (e) { /* private mode */ }

    async function fetchProjects() {
        let b = sb.from('projects').select(SELECT).order('updated_at', { ascending: false }).limit(500);
        if (listState.seg === 'archived') b = b.not('archived_at', 'is', null);
        else {
            b = b.is('archived_at', null);
            if (listState.seg !== 'all') b = b.eq('status', listState.seg);
        }
        if (listState.priority) b = b.eq('priority', listState.priority);
        const { data } = await C.q(b);
        const rows = data || [];
        const ids = rows.map(r => r.id);
        const [members, tasks] = await Promise.all([membersFor(ids), progressTasksFor(ids)]);
        listState.members = members; listState.tasks = tasks;
        return rows;
    }
    function memberIds(projectId) { return listState.members.filter(m => m.project_id === projectId).map(m => m.user_id); }
    function progressOf(projectId) { return L.projectProgress(listState.tasks.filter(t => t.project_id === projectId)); }
    function filterRows(rows) {
        const q = listState.q.trim().toLowerCase();
        return rows.filter(r => {
            const mids = memberIds(r.id);
            if (listState.mine && !(r.owner_id === me.id || r.manager_id === me.id || mids.includes(me.id))) return false;
            if (listState.person && !(r.owner_id === listState.person || r.manager_id === listState.person)) return false;
            if (!q) return true;
            return [r.name, r.description, (r.tags || []).join(' '), C.personName(r.manager_id), C.personName(r.owner_id)].some(v => v && String(v).toLowerCase().includes(q));
        });
    }
    async function showList() {
        const myRoute = ++routeSeq;
        // Deep links: ?status=active|planning|on_hold|completed|all|archived selects the segment.
        { const st = C.param('status'); if (st && ['active', 'planning', 'on_hold', 'completed', 'all', 'archived'].includes(st)) { listState.seg = st; C.setParam('status', null, true); } }
        WSShell.setCrumb('Projects');
        document.title = 'Projects · WorkSuite';
        view.innerHTML = `
            <div class="ws-page-head">
                <div><p class="ws-eyebrow">Collaboration</p><h1>Projects</h1><p>Plan work, assign your team and track progress from the tasks that get done.</p></div>
                <div class="actions"><button type="button" class="ws-btn primary" id="new-btn">${C.icon('plus')}<span>New project</span></button></div>
            </div>
            <div class="crm-toolbar">
                <div class="crm-seg" id="seg" role="tablist">
                    ${[['active', 'Active'], ['planning', 'Planning'], ['on_hold', 'On hold'], ['completed', 'Completed'], ['all', 'All'], ['archived', 'Archived']].map(([k, l]) => `<button type="button" role="tab" data-seg="${k}" class="${listState.seg === k ? 'on' : ''}" aria-selected="${listState.seg === k}">${l}</button>`).join('')}
                </div>
                <div class="crm-search grow">${C.icon('search', 'sm')}<input type="search" id="q" placeholder="Search projects…" aria-label="Search projects"></div>
                <select id="f-person" aria-label="Owner or project manager"><option value="">Anyone</option>${C.peopleOptions('', { none: null })}</select>
                <select id="f-priority" aria-label="Priority"><option value="">Any priority</option>${PRIORITY_OPTS.map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join('')}</select>
                <label class="crm-check" style="min-height:38px"><input type="checkbox" id="f-mine"> Mine</label>
                <span class="crm-count" id="count"></span>
                <div class="crm-seg" id="mode"><button type="button" data-mode="cards" class="${listState.mode === 'cards' ? 'on' : ''}" title="Cards">${C.icon('board', 'sm')}</button><button type="button" data-mode="table" class="${listState.mode === 'table' ? 'on' : ''}" title="Table">${C.icon('tasks', 'sm')}</button></div>
            </div>
            <div id="list"></div>`;
        const listEl = view.querySelector('#list');
        C.skeletonRows(listEl, 6);
        view.querySelector('#q').value = listState.q;
        view.querySelector('#f-person').value = listState.person;
        view.querySelector('#f-priority').value = listState.priority;
        view.querySelector('#f-mine').checked = listState.mine;
        on('#new-btn', () => openProjectEditor(null, [], p => go(`/projects/?id=${p.id}`)));

        let tbl = null;
        function rowMenu(btn, r) {
            const after = reload;
            C.menu(btn, [
                { label: 'Open', icon: 'arrow', onClick: () => go(`/projects/?id=${r.id}`) },
                { label: 'Edit', icon: 'edit', onClick: () => openProjectEditor(r, memberIds(r.id), after) },
                ...(r.archived_at ? [] : statusMenuItems(r, after)),
                'sep',
                r.archived_at ? { label: 'Restore', icon: 'refresh', onClick: () => setArchived(r, false, after) } : { label: 'Archive', icon: 'trash', danger: true, onClick: () => setArchived(r, true, after) },
            ]);
        }
        function cardHtml(r) {
            const prog = progressOf(r.id);
            return `<a class="ws-card hover emp-card" href="/projects/?id=${esc(r.id)}" data-open="${esc(r.id)}" style="flex-direction:column;align-items:stretch;gap:10px">
                <div style="display:flex;align-items:flex-start;gap:8px">
                    <div style="flex:1;min-width:0"><b style="font-size:15px;font-weight:600;display:block;overflow-wrap:anywhere">${esc(r.name)}</b>
                    <span class="muted" style="font-size:12.5px;display:block;margin-top:2px">${esc(r.description ? r.description.replace(/\s+/g, ' ').slice(0, 90) : '')}</span></div>
                    <button type="button" class="ws-btn sm icon" data-menu="${esc(r.id)}" aria-label="Actions">${C.icon('more')}</button>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">${C.statusBadge(L.PROJECT_STATUS, r.status)}${C.priorityBadge(r.priority)}${dueChip(r)}</div>
                ${progressHtml(prog, true)}
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px">
                    <span class="muted">PM:</span>${C.personHtml(r.manager_id, { link: false, none: 'Not assigned' })}<span class="spacer" style="flex:1"></span>${C.avatarsHtml(memberIds(r.id), 4)}
                </div>
            </a>`;
        }
        function paint() {
            const rows = filterRows(listState.rows);
            view.querySelector('#count').textContent = `${rows.length} project${rows.length === 1 ? '' : 's'}`;
            view.querySelectorAll('#seg [data-seg]').forEach(b => { b.classList.toggle('on', b.dataset.seg === listState.seg); b.setAttribute('aria-selected', b.dataset.seg === listState.seg); });
            view.querySelectorAll('#mode [data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === listState.mode));
            if (!rows.length) {
                tbl = null;
                C.empty(listEl, listState.q || listState.person || listState.priority || listState.mine ? 'No projects match' : listState.seg === 'archived' ? 'No archived projects' : 'No projects yet',
                    listState.q ? 'Try a different search or clear the filters.' : 'Create a project to plan work and track progress.',
                    listState.q || listState.seg === 'archived' ? '' : `<button type="button" class="ws-btn primary" onclick="document.getElementById('new-btn').click()">${C.icon('plus')}<span>New project</span></button>`);
                return;
            }
            if (listState.mode === 'cards') {
                tbl = null;
                listEl.innerHTML = `<div class="emp-grid" style="grid-template-columns:repeat(auto-fill,minmax(290px,1fr))">${rows.map(cardHtml).join('')}</div>`;
                return;
            }
            if (!listEl.querySelector('.crm-table-wrap')) { tbl = null; listEl.innerHTML = '<div class="ws-card flush"><div id="table"></div></div>'; }
            const tableEl = listEl.querySelector('#table');
            const columns = [
                { key: 'name', label: 'Project', lead: true, render: r => `<span class="primary-text">${esc(r.name)}</span><span class="sub">${esc([C.personName(r.manager_id, 'No PM'), (r.tags || []).join(', ')].filter(Boolean).join(' · '))}</span>` },
                { key: 'status', label: 'Status', render: r => C.statusBadge(L.PROJECT_STATUS, r.status) },
                { key: 'priority', label: 'Priority', value: r => L.PRIORITY[r.priority] ? L.PRIORITY[r.priority].rank : 0, render: r => C.priorityBadge(r.priority) },
                { key: 'manager_id', label: 'Project manager', value: r => C.personName(r.manager_id), render: r => C.personHtml(r.manager_id, { link: false, none: 'Not assigned' }) },
                { key: 'members', label: 'Members', sort: false, hideMobile: true, render: r => C.avatarsHtml(memberIds(r.id), 5) || '<span class="muted">—</span>' },
                { key: 'progress', label: 'Progress', value: r => progressOf(r.id).pct, render: r => { const p = progressOf(r.id); return `<div style="min-width:120px">${progressHtml(p, false)}<span class="muted" style="font-size:12px">${p.done}/${p.total} · ${p.pct}%</span></div>`; } },
                { key: 'due_date', label: 'Due', render: r => dueChip(r) },
                { key: 'actions', label: '', sort: false, cls: 'actions', render: r => `<button type="button" class="ws-btn sm icon" data-menu="${esc(r.id)}" aria-label="Actions">${C.icon('more')}</button>` },
            ];
            if (!tbl) tbl = C.table(tableEl, { columns, rows, sort: { key: 'due_date', dir: 'asc' }, pageSize: 50, onRow: r => go(`/projects/?id=${r.id}`), empty: { title: 'No projects' } });
            else tbl.update(rows);
        }
        async function reload() {
            try { listState.rows = await fetchProjects(); paint(); }
            catch (e) { C.errorState(listEl, e, reload); }
        }
        listEl.addEventListener('click', e => {
            const b = e.target.closest('[data-menu]');
            if (b) { e.preventDefault(); e.stopPropagation(); const r = listState.rows.find(x => x.id === b.dataset.menu); if (r) rowMenu(b, r); return; }
            const a = e.target.closest('a[data-open]');
            if (a) { e.preventDefault(); go(`/projects/?id=${a.dataset.open}`); }
        });
        view.querySelector('#seg').addEventListener('click', e => { const b = e.target.closest('[data-seg]'); if (!b) return; listState.seg = b.dataset.seg; reload(); });
        view.querySelector('#mode').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (!b) return; listState.mode = b.dataset.mode; try { localStorage.setItem('ws-projects-mode', listState.mode); } catch (err) { /* ignore */ } paint(); });
        view.querySelector('#q').addEventListener('input', C.debounce(() => { listState.q = view.querySelector('#q').value; paint(); }, 180));
        view.querySelector('#f-person').addEventListener('change', e => { listState.person = e.target.value; paint(); });
        view.querySelector('#f-priority').addEventListener('change', e => { listState.priority = e.target.value; reload(); });
        view.querySelector('#f-mine').addEventListener('change', e => { listState.mine = e.target.checked; paint(); });
        await reload();
        if (C.param('new') === '1') { C.setParam('new', null, true); openProjectEditor(null, [], p => go(`/projects/?id=${p.id}`)); }
    }

    /* ------------------------------------------------------------- record */
    async function showRecord(id) {
        const myRoute = ++routeSeq;
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        C.loading(view, 'Loading project…');
        let p;
        try { p = (await C.q(sb.from('projects').select(SELECT).eq('id', id).maybeSingle())).data; }
        catch (e) { return C.errorState(view, e, () => showRecord(id)); }
        if (!p) { view.innerHTML = `<a class="crm-back" href="/projects/">${C.icon('arrow')}All projects</a>`; C.empty(view.appendChild(document.createElement('div')), 'Project not found', 'It may have been deleted, or you may not have access to it.'); return; }
        const lk = await C.lookups();
        const taskStatusMap = Object.fromEntries(lk.taskStatuses.map(s => [s.key, s]));
        document.title = `${p.name} · Projects · WorkSuite`;
        WSShell.setCrumb(p.name);

        let members = await membersFor([id]);
        let tasks = [];
        let events = [];
        let columns = [];
        async function loadTasks() {
            const r = await sb.from('tasks').select(TASK_SELECT).eq('project_id', id).is('archived_at', null).order('position').order('created_at');
            tasks = r.error ? [] : (r.data || []);
        }
        async function loadEvents() {
            events = await C.related('calendar_events', 'project_id', id, 'id, title, starts_at, ends_at, event_type, status, owner_id, all_day', b => b.order('starts_at', { ascending: true }));
        }
        async function loadColumns() {
            if (!p.board_id) { columns = []; return; }
            const r = await sb.from('board_columns').select('id, board_id, name, position, maps_to_status, color, wip_limit').eq('board_id', p.board_id).order('position');
            columns = r.error ? [] : (r.data || []);
        }
        await Promise.all([loadTasks(), loadEvents(), loadColumns()]);
        const [contactLabel, dealLabel] = await Promise.all([p.contact_id ? C.entityLabel('contact', p.contact_id) : '', p.deal_id ? C.entityLabel('deal', p.deal_id) : '']);

        const mids = () => members.map(m => m.user_id);
        const canEdit = () => canEditProject(p, mids());
        const canManageMembers = () => ctx.isManager || p.owner_id === me.id || p.manager_id === me.id || p.created_by === me.id;
        const prog = () => L.projectProgress(tasks);

        function headHtml() {
            const pr = prog();
            return `
                <a class="crm-back" href="/projects/" data-nav>${C.icon('arrow')}All projects</a>
                <div class="crm-record-head">
                    <span class="ws-avatar xl" style="background:var(--ws-primary-soft);color:var(--ws-primary)">${C.icon('folder', 'lg')}</span>
                    <div class="titles">
                        <h1>${esc(p.name)}</h1>
                        <div class="meta">
                            ${C.statusBadge(L.PROJECT_STATUS, p.status)}${C.priorityBadge(p.priority)}${dueChip(p)}
                            ${p.archived_at ? C.badge('mute', 'Archived') : ''}
                            <span>PM: ${C.personHtml(p.manager_id, { none: 'Not assigned' })}</span>
                            <span>Owner: ${C.personHtml(p.owner_id)}</span>
                            ${p.contact_id ? C.entityChip('contact', p.contact_id, contactLabel) : ''}${p.deal_id ? C.entityChip('deal', p.deal_id, dealLabel) : ''}
                        </div>
                        <div style="margin-top:10px;max-width:420px" id="head-progress">${progressHtml(pr, true)}</div>
                    </div>
                    <div class="actions">
                        ${canEdit() ? `<button type="button" class="ws-btn" id="edit-btn">${C.icon('edit')}<span>Edit</span></button>` : ''}
                        <button type="button" class="ws-btn" id="task-btn">${C.icon('tasks')}<span>New task</span></button>
                        <button type="button" class="ws-btn" id="meet-btn">${C.icon('calendar')}<span>Schedule</span></button>
                        ${canEdit() ? `<button type="button" class="ws-btn primary" id="status-btn">${C.icon('check')}<span>Status</span></button>` : ''}
                        <button type="button" class="ws-btn icon" id="more-btn" aria-label="More actions">${C.icon('more')}</button>
                    </div>
                </div>`;
        }
        view.innerHTML = headHtml() + `
            <div id="tabs"></div>
            <section class="crm-tabpanel" data-panel="overview"><div id="overview"></div></section>
            <section class="crm-tabpanel" data-panel="tasks" hidden><div id="tasks-panel"></div></section>
            <section class="crm-tabpanel" data-panel="board" hidden><div id="board-panel"></div></section>
            <section class="crm-tabpanel" data-panel="files" hidden><div class="ws-card"><div class="crm-section-title"><h3>Files</h3></div><div id="documents"></div></div></section>
            <section class="crm-tabpanel" data-panel="calendar" hidden><div id="calendar-panel"></div></section>
            <section class="crm-tabpanel" data-panel="activity" hidden><div class="ws-card"><div id="activity"></div></div></section>
            <section class="crm-tabpanel" data-panel="members" hidden><div id="members-panel"></div></section>`;

        view.querySelector('[data-nav]').addEventListener('click', e => { e.preventDefault(); go('/projects/'); });
        const tabItems = [
            { key: 'overview', label: 'Overview' }, { key: 'tasks', label: 'Tasks', count: tasks.filter(t => !t.completed_at).length },
            { key: 'board', label: 'Board' }, { key: 'files', label: 'Files' }, { key: 'calendar', label: 'Calendar', count: events.filter(e => e.status !== 'cancelled').length },
            { key: 'activity', label: 'Activity' }, { key: 'members', label: 'Members', count: members.length },
        ];
        const loaded = {};
        const tabs = C.tabs(view.querySelector('#tabs'), tabItems, { hash: true, onChange: k => loadTab(k) });

        /* ---- overview ---- */
        let overviewFeed = null;
        function renderOverview() {
            const el = view.querySelector('#overview');
            const today = L.todayIST();
            const counts = L.taskCounts(tasks, today);
            const upcoming = events.filter(e => e.status !== 'cancelled' && new Date(e.ends_at) >= new Date()).slice(0, 4);
            el.innerHTML = `
                <div class="crm-kpis">
                    <div class="crm-kpi"><div class="lbl">Open tasks</div><div class="val">${counts.open}</div><div class="sub">${counts.total} total</div></div>
                    <div class="crm-kpi ${counts.overdue ? 'bad' : ''}"><div class="lbl">Overdue</div><div class="val">${counts.overdue}</div><div class="sub ${counts.overdue ? 'bad' : ''}">${counts.due_today} due today</div></div>
                    <div class="crm-kpi ok"><div class="lbl">Completed</div><div class="val">${counts.completed}</div><div class="sub">${prog().pct}% of tasks</div></div>
                    <div class="crm-kpi"><div class="lbl">Upcoming meetings</div><div class="val">${upcoming.length}</div><div class="sub">${events.filter(e => e.status !== 'cancelled').length} scheduled in total</div></div>
                </div>
                <div class="crm-detail">
                    <div class="ws-stack">
                        <div class="ws-card">
                            <div class="crm-section-title"><h3>About this project</h3></div>
                            ${p.description ? `<div class="crm-desc" style="margin-bottom:16px">${C.linkify(C.nl2br(p.description))}</div>` : '<p class="muted" style="margin:0 0 16px;font-size:13.5px">No description yet.</p>'}
                            <dl class="crm-props">
                                <div><dt>Status</dt><dd>${C.statusBadge(L.PROJECT_STATUS, p.status)}</dd></div>
                                <div><dt>Priority</dt><dd>${C.priorityBadge(p.priority)}</dd></div>
                                <div><dt>Start date</dt><dd>${esc(L.fmtDate(p.start_date) || '—')}</dd></div>
                                <div><dt>Due date</dt><dd>${esc(L.fmtDate(p.due_date) || '—')}</dd></div>
                                <div><dt>Completed</dt><dd>${esc(L.fmtDate(p.completed_at) || '—')}</dd></div>
                                <div><dt>Progress</dt><dd>${progressHtml(prog(), true)}</dd></div>
                                <div><dt>Owner</dt><dd>${C.personHtml(p.owner_id)}</dd></div>
                                <div><dt>Project manager</dt><dd>${C.personHtml(p.manager_id, { none: 'Not assigned' })}</dd></div>
                                <div><dt>Related contact</dt><dd>${p.contact_id ? C.entityChip('contact', p.contact_id, contactLabel) : '—'}</dd></div>
                                <div><dt>Related deal</dt><dd>${p.deal_id ? C.entityChip('deal', p.deal_id, dealLabel) : '—'}</dd></div>
                                <div><dt>Tags</dt><dd>${C.tagsHtml(p.tags) || '—'}</dd></div>
                                <div><dt>Created</dt><dd>${esc(L.fmtDateTime(p.created_at))} by ${esc(C.personName(p.created_by))}</dd></div>
                                <div><dt>Project ID</dt><dd class="muted" style="font-size:12px">${esc(p.id)}</dd></div>
                            </dl>
                        </div>
                        <div class="ws-card">
                            <div class="crm-section-title"><h3>Post an update</h3></div>
                            <div id="composer"></div>
                            <div id="recent-activity"></div>
                        </div>
                    </div>
                    <div class="ws-stack">
                        <div class="ws-card">
                            <div class="crm-section-title"><h3>Team</h3><div class="right"><button type="button" class="ws-btn sm ghost" data-tab-go="members">Manage</button></div></div>
                            ${members.length ? `<ul class="crm-list compact">${members.map(m => `<li>${C.avatarHtml(m.user_id)}<div class="main"><b><a href="/employees/?id=${esc(m.user_id)}">${esc(C.personName(m.user_id))}</a></b><span>${m.role === 'manager' ? 'Manager' : 'Member'}</span></div></li>`).join('')}</ul>` : '<p class="muted" style="margin:0;font-size:13.5px">No members yet.</p>'}
                        </div>
                        <div class="ws-card">
                            <div class="crm-section-title"><h3>Upcoming</h3></div>
                            ${upcoming.length ? `<ul class="crm-list compact">${upcoming.map(e => `<li>${C.icon('calendar')}<div class="main"><b><a href="/calendar/?id=${esc(e.id)}">${esc(e.title)}</a></b><span>${esc(L.fmtDateTime(e.starts_at))}</span></div></li>`).join('')}</ul>` : '<p class="muted" style="margin:0;font-size:13.5px">No upcoming meetings.</p>'}
                        </div>
                        <div class="ws-card">
                            <div class="crm-section-title"><h3>Due soon</h3></div>
                            ${(() => { const soon = tasks.filter(t => !t.completed_at && t.due_date).sort((a, b) => L.dayNumber(a.due_date) - L.dayNumber(b.due_date)).slice(0, 5); return soon.length ? `<ul class="crm-list compact">${soon.map(t => `<li>${C.icon('tasks')}<div class="main"><b><a href="/tasks/?id=${esc(t.id)}">${esc(t.title)}</a></b><span>${C.personName(t.assignee_id)}</span></div><div class="right">${C.dueHtml(t, today)}</div></li>`).join('')}</ul>` : '<p class="muted" style="margin:0;font-size:13.5px">Nothing due.</p>'; })()}
                        </div>
                    </div>
                </div>`;
            el.querySelector('[data-tab-go]').addEventListener('click', e => tabs.set(e.currentTarget.dataset.tabGo));
            overviewFeed = C.activityFeed(el.querySelector('#recent-activity'), { entity_type: 'project', entity_id: id, project_id: id, limit: 8 });
            C.comments(el.querySelector('#composer'), { entity_type: 'project', entity_id: id, placeholder: 'Post a project update… use @ to mention a colleague', onPosted: () => { overviewFeed.reload(); if (loaded.activity) loaded.activity.reload(); } });
        }

        /* ---- tasks ---- */
        const taskFilter = { status: '', assignee: '' };
        function renderTasksTab() {
            const el = view.querySelector('#tasks-panel');
            if (!el.querySelector('#tasks-table')) {
                el.innerHTML = `<div class="ws-card flush">
                    <div class="ws-card-head"><h3>Tasks</h3><div class="right" style="display:flex;gap:8px;flex-wrap:wrap">
                        <select id="tf-status" aria-label="Status"><option value="">All statuses</option><option value="open">Open</option>${lk.taskStatuses.map(s => `<option value="${esc(s.key)}">${esc(s.label)}</option>`).join('')}</select>
                        <select id="tf-assignee" aria-label="Assignee"><option value="">Anyone</option><option value="me">Me</option><option value="none">Unassigned</option>${C.peopleOptions('', { none: null })}</select>
                        <button type="button" class="ws-btn sm primary" id="task-btn-2">${C.icon('plus')}<span>New task</span></button></div></div>
                    <div id="tasks-table"></div></div>`;
                el.querySelector('#tf-status').addEventListener('change', e => { taskFilter.status = e.target.value; paintTasks(); });
                el.querySelector('#tf-assignee').addEventListener('change', e => { taskFilter.assignee = e.target.value; paintTasks(); });
                el.querySelector('#task-btn-2').addEventListener('click', newTask);
                el.querySelector('#tasks-table').addEventListener('change', async e => {
                    const cb = e.target.closest('input[data-done]'); if (!cb) return;
                    const t = tasks.find(x => x.id === cb.dataset.done); if (!t) return;
                    const doneKey = (lk.taskStatuses.find(s => s.is_done) || { key: 'completed' }).key;
                    const openKey = (lk.taskStatuses.find(s => !s.is_done) || { key: 'todo' }).key;
                    try { await C.q(sb.from('tasks').update({ status: cb.checked ? doneKey : openKey }).eq('id', t.id)); C.toast(cb.checked ? 'Task completed' : 'Task reopened', 'ok'); await refreshTasks(); }
                    catch (err) { cb.checked = !cb.checked; C.toast(err.message, 'bad'); }
                });
            }
            paintTasks();
        }
        let tasksTable = null;
        function paintTasks() {
            const el = view.querySelector('#tasks-table'); if (!el) return;
            const rows = tasks.filter(t => {
                if (taskFilter.status === 'open' && t.completed_at) return false;
                if (taskFilter.status && taskFilter.status !== 'open' && t.status !== taskFilter.status) return false;
                if (taskFilter.assignee === 'me' && t.assignee_id !== me.id) return false;
                if (taskFilter.assignee === 'none' && t.assignee_id) return false;
                if (taskFilter.assignee && !['me', 'none'].includes(taskFilter.assignee) && t.assignee_id !== taskFilter.assignee) return false;
                return true;
            });
            const columns = [
                { key: 'done', label: '', sort: false, cls: 'checkcol', render: t => `<input type="checkbox" data-done="${esc(t.id)}" aria-label="Mark complete"${t.completed_at ? ' checked' : ''}>` },
                { key: 'title', label: 'Task', lead: true, render: t => `<span class="primary-text"${t.completed_at ? ' style="text-decoration:line-through;color:var(--ws-text-muted)"' : ''}>${esc(t.title)}</span>` },
                { key: 'status', label: 'Status', render: t => C.statusBadge(taskStatusMap, t.status) },
                { key: 'priority', label: 'Priority', value: t => L.PRIORITY[t.priority] ? L.PRIORITY[t.priority].rank : 0, render: t => C.priorityBadge(t.priority) },
                { key: 'assignee_id', label: 'Assignee', value: t => C.personName(t.assignee_id), render: t => C.personHtml(t.assignee_id, { link: false }) },
                { key: 'due_date', label: 'Due', render: t => C.dueHtml(t) },
            ];
            if (!tasksTable || !el.firstElementChild) tasksTable = C.table(el, { columns, rows, sort: { key: 'due_date', dir: 'asc' }, pageSize: 50, onRow: t => { location.href = `/tasks/?id=${t.id}`; }, empty: { title: tasks.length ? 'No tasks match' : 'No tasks yet', sub: tasks.length ? 'Change the filters to see more.' : 'Add the first task to this project.' } });
            else tasksTable.update(rows);
        }

        /* ---- board ---- */
        let board = null;
        function columnFor(t) {
            if (t.board_column_id && columns.some(c => c.id === t.board_column_id)) return t.board_column_id;
            const byStatus = columns.find(c => c.maps_to_status === t.status);
            return (byStatus || columns[0] || {}).id || null;
        }
        async function createBoard() {
            try {
                const b = (await C.q(sb.from('boards').insert({ name: p.name, kind: 'project', project_id: id, created_by: me.id }).select('id').single())).data;
                await C.q(sb.from('board_columns').insert(lk.taskStatuses.map(s => ({ board_id: b.id, name: s.label, position: s.sort_order, maps_to_status: s.key, color: s.color }))));
                await C.q(sb.from('projects').update({ board_id: b.id }).eq('id', id));
                p.board_id = b.id;
                await loadColumns();
                C.toast('Board created', 'ok');
                renderBoard();
            } catch (e) { C.toast(e.message, 'bad'); }
        }
        function renderBoard() {
            const el = view.querySelector('#board-panel');
            if (!p.board_id) {
                el.innerHTML = '';
                C.empty(el, 'This project has no board yet', 'Create one to plan tasks as cards in columns.', canEdit() ? `<button type="button" class="ws-btn primary" id="mk-board">${C.icon('plus')}<span>Create board</span></button>` : '');
                const mk = el.querySelector('#mk-board'); if (mk) mk.addEventListener('click', createBoard);
                return;
            }
            if (!columns.length) { el.innerHTML = ''; C.empty(el, 'The board has no columns', 'Add columns in the Boards module.', `<a class="ws-btn" href="/boards/?id=${esc(p.board_id)}">${C.icon('board')}<span>Open in Boards</span></a>`); return; }
            if (!el.querySelector('#kb')) {
                el.innerHTML = `<div class="crm-toolbar"><span class="crm-count">Drag cards between columns to change their status. Keyboard: Space to pick up, arrows to move, Enter to drop.</span><span class="spacer"></span><a class="ws-btn sm" href="/boards/?id=${esc(p.board_id)}">${C.icon('board')}<span>Open in Boards</span></a></div><div id="kb"></div>`;
            }
            const kbEl = el.querySelector('#kb');
            const cards = tasks.filter(t => !t.completed_at || columns.some(c => c.maps_to_status === t.status)).map(t => ({ id: t.id, columnId: columnFor(t), position: Number(t.position) || 0, t }));
            const cols = columns.map(c => ({ id: c.id, name: c.name, color: c.color, wipLimit: c.wip_limit || null }));
            const renderCard = c => `<div class="t">${esc(c.t.title)}</div><div class="f">${C.priorityBadge(c.t.priority)}${c.t.due_date ? C.dueHtml(c.t) : ''}<span class="spacer"></span>${c.t.assignee_id ? C.avatarHtml(c.t.assignee_id) : ''}</div>`;
            if (!board || !kbEl.querySelector('.kb-col')) {
                board = WSKanban.mount(kbEl, {
                    columns: cols, cards, renderCard, emptyText: 'No tasks',
                    onMove: async ({ card, toColumnId, position }) => {
                        await C.q(sb.from('tasks').update({ board_id: p.board_id, board_column_id: toColumnId, position }).eq('id', card.id));
                        await refreshTasks(true);
                    },
                    onCardClick: c => { location.href = `/tasks/?id=${c.id}`; },
                    onAddCard: colId => C.openTaskEditor({ defaults: { project_id: id, board_id: p.board_id, board_column_id: colId, position: L.positionBetween(Math.max(0, ...cards.filter(c => c.columnId === colId).map(c => c.position)), null) }, onSaved: () => refreshTasks() }),
                    canDrag: () => canEdit(),
                });
            } else board.update({ columns: cols, cards });
        }

        /* ---- calendar ---- */
        function renderCalendarTab() {
            const el = view.querySelector('#calendar-panel');
            const items = [
                ...events.filter(e => e.status !== 'cancelled').map(e => ({ kind: 'event', at: e.starts_at, day: L.istDate(e.starts_at), e })),
                ...tasks.filter(t => t.due_date && !t.completed_at).map(t => ({ kind: 'task', at: L.isoAtIST(t.due_date, t.due_time || '09:00'), day: t.due_date, t })),
                ...(p.due_date && !['completed', 'cancelled'].includes(p.status) ? [{ kind: 'deadline', at: L.isoAtIST(p.due_date, '18:00'), day: p.due_date }] : []),
            ].sort((a, b) => new Date(a.at) - new Date(b.at));
            const today = L.todayIST();
            let html = `<div class="ws-card"><div class="crm-section-title"><h3>Project calendar</h3><div class="right"><a class="ws-btn sm" href="/calendar/">${C.icon('calendar')}<span>Full calendar</span></a><button type="button" class="ws-btn sm primary" id="meet-btn-2">${C.icon('plus')}<span>Schedule</span></button></div></div>`;
            if (!items.length) html += '<div class="ws-empty"><b>Nothing scheduled</b><div>Meetings, task due dates and the project deadline appear here.</div></div>';
            else {
                let day = null;
                html += '<div class="cal-agenda">';
                items.forEach(it => {
                    if (it.day !== day) { day = it.day; html += `<div class="day-h${day === today ? ' today' : ''}">${day === today ? 'Today · ' : ''}${esc(L.fmtDate(day))}${L.dayNumber(day) < L.dayNumber(today) ? ' <span class="muted" style="text-transform:none;letter-spacing:0">(past)</span>' : ''}</div><ul class="crm-list compact">`; }
                    if (it.kind === 'event') html += `<li><span class="crm-dot pending"></span><div class="main"><b><a href="/calendar/?id=${esc(it.e.id)}">${esc(it.e.title)}</a></b><span>${it.e.all_day ? 'All day' : esc(L.fmtTime(it.e.starts_at) + ' – ' + L.fmtTime(it.e.ends_at))} · ${esc(L.EVENT_TYPE[it.e.event_type] ? L.EVENT_TYPE[it.e.event_type].label : it.e.event_type)}</span></div><div class="right">${C.avatarHtml(it.e.owner_id)}</div></li>`;
                    else if (it.kind === 'task') html += `<li><span class="crm-dot late"></span><div class="main"><b><a href="/tasks/?id=${esc(it.t.id)}">${esc(it.t.title)}</a></b><span>Task due${it.t.due_time ? ' at ' + esc(L.fmtTime(it.at)) : ''} · ${esc(C.personName(it.t.assignee_id))}</span></div><div class="right">${C.dueHtml(it.t, today)}</div></li>`;
                    else html += `<li><span class="crm-dot absent"></span><div class="main"><b>Project deadline</b><span>${esc(p.name)} is due</span></div></li>`;
                    const next = items[items.indexOf(it) + 1];
                    if (!next || next.day !== day) html += '</ul>';
                });
                html += '</div>';
            }
            el.innerHTML = html + '</div>';
            el.querySelector('#meet-btn-2').addEventListener('click', newMeeting);
        }

        /* ---- members ---- */
        function renderMembersTab() {
            const el = view.querySelector('#members-panel');
            const manage = canManageMembers();
            const exclude = new Set([...mids()]);
            el.innerHTML = `<div class="ws-card flush">
                <div class="ws-card-head"><h3>Members</h3>${manage ? `<div class="right" style="display:flex;gap:8px;flex-wrap:wrap"><select id="add-member" aria-label="Add member"><option value="">Add a colleague…</option>${C.peopleOptions('', { none: null, people: C.activePeople().filter(x => !exclude.has(x.id)) })}</select></div>` : ''}</div>
                <div class="crm-table-wrap"><table class="ws-table cards"><thead><tr><th>Person</th><th>Role</th><th>Added</th>${manage ? '<th></th>' : ''}</tr></thead><tbody>
                ${[...(p.owner_id ? [{ user_id: p.owner_id, role: 'owner' }] : []), ...(p.manager_id && p.manager_id !== p.owner_id ? [{ user_id: p.manager_id, role: 'pm' }] : []), ...members.filter(m => m.user_id !== p.owner_id && m.user_id !== p.manager_id)].map(m => `<tr>
                    <td class="lead" data-label="Person"><a class="crm-person link" href="/employees/?id=${esc(m.user_id)}">${C.avatarHtml(m.user_id)}<span class="nm">${esc(C.personName(m.user_id))}</span></a></td>
                    <td data-label="Role">${m.role === 'owner' ? C.badge('pending', 'Owner') : m.role === 'pm' ? C.badge('leave', 'Project manager') : manage ? `<select data-role="${esc(m.user_id)}" aria-label="Role"><option value="member"${m.role === 'member' ? ' selected' : ''}>Member</option><option value="manager"${m.role === 'manager' ? ' selected' : ''}>Manager</option></select>` : C.badge(m.role === 'manager' ? 'leave' : 'mute', m.role === 'manager' ? 'Manager' : 'Member')}</td>
                    <td data-label="Added"><span class="muted">${m.created_at ? esc(L.fmtDate(m.created_at)) + ' by ' + esc(C.personName(m.added_by)) : '—'}</span></td>
                    ${manage ? `<td class="actions">${m.role === 'owner' || m.role === 'pm' ? '' : `<button type="button" class="ws-btn sm icon" data-remove="${esc(m.user_id)}" aria-label="Remove">${C.icon('x')}</button>`}</td>` : ''}
                </tr>`).join('') || `<tr><td colspan="4" class="muted" style="text-align:center;padding:24px">No members yet.</td></tr>`}
                </tbody></table></div></div>`;
            if (!manage) return;
            el.querySelector('#add-member').addEventListener('change', async e => {
                const uid = e.target.value; if (!uid) return;
                try {
                    await C.q(sb.from('project_members').insert({ project_id: id, user_id: uid, role: 'member', added_by: me.id }));
                    C.pushNotify({ to: uid, title: 'Added to a project', body: p.name, url: `/projects/?id=${id}`, tag: 'project' });
                    C.toast('Member added', 'ok'); members = await membersFor([id]); tabs.setCount('members', members.length); renderMembersTab(); renderOverview();
                } catch (err) { C.toast(err.message, 'bad'); }
            });
            if (el.dataset.bound) return;            // the delegated handlers below are bound once per panel element
            el.dataset.bound = '1';
            el.addEventListener('change', async e => {
                const s = e.target.closest('select[data-role]'); if (!s) return;
                try { await C.q(sb.from('project_members').update({ role: s.value }).eq('project_id', id).eq('user_id', s.dataset.role)); C.toast('Role updated', 'ok'); members = await membersFor([id]); }
                catch (err) { C.toast(err.message, 'bad'); renderMembersTab(); }
            });
            el.addEventListener('click', async e => {
                const b = e.target.closest('[data-remove]'); if (!b) return;
                if (!await C.confirm({ title: `Remove ${C.personName(b.dataset.remove)} from the project?`, message: 'Their tasks stay assigned to them.', okText: 'Remove', danger: true })) return;
                try { await C.q(sb.from('project_members').delete().eq('project_id', id).eq('user_id', b.dataset.remove)); C.toast('Member removed', 'ok'); members = await membersFor([id]); tabs.setCount('members', members.length); renderMembersTab(); renderOverview(); }
                catch (err) { C.toast(err.message, 'bad'); }
            });
        }

        function loadTab(k) {
            if (k === 'overview' && !loaded.overview) { loaded.overview = true; renderOverview(); }
            if (k === 'tasks') { loaded.tasks = true; renderTasksTab(); }
            if (k === 'board') { loaded.board = true; renderBoard(); }
            if (k === 'files' && !loaded.files) loaded.files = C.documents(view.querySelector('#documents'), { entity_type: 'project', entity_id: id, canEdit: true });
            if (k === 'calendar') { loaded.calendar = true; renderCalendarTab(); }
            if (k === 'activity' && !loaded.activity) loaded.activity = C.activityFeed(view.querySelector('#activity'), { entity_type: 'project', entity_id: id, project_id: id, limit: 100 });
            if (k === 'members') { loaded.members = true; renderMembersTab(); }
        }
        loadTab(tabs.active);

        async function refreshTasks(silent) {
            await loadTasks();
            tabs.setCount('tasks', tasks.filter(t => !t.completed_at).length);
            const hp = view.querySelector('#head-progress'); if (hp) hp.innerHTML = progressHtml(prog(), true);
            if (loaded.overview) renderOverview();
            if (loaded.tasks) paintTasks();
            if (loaded.board && !silent) renderBoard();
            if (loaded.calendar) renderCalendarTab();
        }
        const refreshDebounced = C.debounce(async () => { await refreshTasks(); if (loaded.activity) loaded.activity.reload(); }, 600);
        if (myRoute !== routeSeq) return;        // the user has already navigated elsewhere
        unsubscribe = C.subscribe('project-tasks', [{ event: '*', table: 'tasks', filter: `project_id=eq.${id}` }], () => refreshDebounced());

        /* ---- actions ---- */
        function newTask() { return C.openTaskEditor({ defaults: { project_id: id, board_id: p.board_id || undefined, title: '' }, onSaved: () => refreshTasks() }); }
        function newMeeting() { return C.openEventEditor({ defaults: { project_id: id, title: `${p.name} meeting`, participants: mids().filter(u => u !== me.id) }, onSaved: async () => { await loadEvents(); tabs.setCount('calendar', events.filter(e => e.status !== 'cancelled').length); if (loaded.overview) renderOverview(); if (loaded.calendar) renderCalendarTab(); } }); }
        on('#edit-btn', () => openProjectEditor(p, mids(), () => showRecord(id)));
        on('#task-btn', newTask);
        on('#meet-btn', newMeeting);
        on('#status-btn', e => C.menu(e.currentTarget, statusMenuItems(p, () => showRecord(id))));
        on('#more-btn', e => {
            const items = [
                { label: 'Open board in Boards', icon: 'board', href: p.board_id ? `/boards/?id=${p.board_id}` : '/boards/' },
                { label: 'Copy link', icon: 'link', onClick: () => { navigator.clipboard && navigator.clipboard.writeText(location.origin + `/projects/?id=${id}`).then(() => C.toast('Link copied', 'ok'), () => {}); } },
            ];
            if (canEdit()) { items.push('sep'); items.push(p.archived_at ? { label: 'Restore project', icon: 'refresh', onClick: () => setArchived(p, false, () => showRecord(id)) } : { label: 'Archive project', icon: 'trash', danger: true, onClick: () => setArchived(p, true, () => showRecord(id)) }); }
            if (ctx.isManager) items.push({ label: 'Delete permanently', icon: 'trash', danger: true, onClick: () => deleteProject(p) });
            C.menu(e.currentTarget, items);
        });
    }

    route();
})();
