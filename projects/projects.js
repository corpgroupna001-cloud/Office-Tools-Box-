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
    const C = window.WSCrm, L = C.L, esc = C.esc, B = window.WSB24;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'projects', crumb: 'Projects', layout: 'b24' });
    const sb = ctx.sb, me = ctx.user;

    const BASE = 'id, company, name, description, owner_id, manager_id, status, priority, start_date, due_date, completed_at, contact_id, deal_id, board_id, tags, archived_at, created_by, created_at, updated_at';
    const cols = await B.columns('projects', BASE + ', privacy, number, avatar_color', BASE);
    const SELECT = cols.select;
    const TASK_SELECT = 'id, title, status, priority, assignee_id, project_id, board_id, board_column_id, position, due_date, due_time, completed_at, archived_at, created_by, created_at';
    const STATUS_OPTS = Object.entries(L.PROJECT_STATUS).map(([k, v]) => ({ value: k, label: v.label }));
    const PRIORITY_OPTS = Object.entries(L.PRIORITY).map(([k, v]) => ({ value: k, label: v.label }));
    let unsubscribe = null;
    let routeSeq = 0;               // guards against a slow list load finishing after the user opened a record

    /* ------------------------------------------------------------ routing */
    function route() {
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        const id = C.param('id');
        if (id === 'new') return showCreate();
        if (id) return showRecord(id);
        if (page.mode === 'list') return refreshList(true);
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
            ...(cols.full ? [{ name: 'privacy', label: 'Privacy', type: 'select', required: true, options: [{ value: 'public', label: 'Open: anyone in the company can join' }, { value: 'private', label: 'Private: visible, people ask to join' }, { value: 'secret', label: 'Secret: only members see it' }] }] : []),
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
            values: isNew ? { status: 'planning', priority: 'normal', owner_id: me.id, manager_id: me.id, members: [], privacy: 'public' } : { ...project, members: currentMemberIds || [] },
            submitLabel: isNew ? 'Create project' : 'Save changes',
            onSubmit: async v => {
                const row = {
                    name: v.name.trim(), description: v.description || null, owner_id: v.owner_id || me.id, manager_id: v.manager_id || null,
                    status: v.status, priority: v.priority, start_date: v.start_date || null, due_date: v.due_date || null,
                    contact_id: v.contact_id || null, deal_id: v.deal_id || null, tags: v.tags || [],
                    ...(cols.full ? { privacy: v.privacy || 'public' } : {}),
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
        try { await C.q(sb.from('projects').delete().eq('id', p.id)); C.toast('Project deleted', 'ok'); if (WSShell.inSlider) { WSShell.sliderMessage('deleted', { id: p.id }); WSShell.closeSlider(); } else go('/projects/'); }
        catch (e) { C.toast(e.message, 'bad'); }
    }
    function statusMenuItems(p, after) {
        return STATUS_OPTS.filter(o => o.value !== p.status).map(o => ({ label: `Mark ${o.label.toLowerCase()}`, icon: 'check', onClick: () => changeStatus(p, o.value, after) }));
    }

    /* ----------------------------------------------- list (workspace layout) */
    const page = { mode: null, grid: null, filter: null, view: 'list', members: [], tasks: [], myIds: [], requests: new Set(), reloadView: null };
    const PRIVACY = { public: { label: 'Open', color: 'ok', hint: 'Anyone in the company can see it and join' }, private: { label: 'Private', color: 'warn', hint: 'Everyone sees it; people ask to join' }, secret: { label: 'Secret', color: 'mute', hint: 'Only members know it exists' } };
    const openProject = id => B.openRecord(`/projects/?id=${id}`, () => refreshList(true));
    const PCOLORS = ['#39a8ef', '#ffa900', '#7bd500', '#9b7cf5', '#f76fa6', '#2fc6f6', '#ff5752', '#47e4c2'];
    // Only a hex colour reaches the style attribute.
    function projColor(p) { if (/^#[0-9a-f]{6}$/i.test(p.avatar_color || '')) return p.avatar_color; let n = 0; for (const ch of String(p.id)) n = (n * 31 + ch.charCodeAt(0)) >>> 0; return PCOLORS[n % PCOLORS.length]; }
    function projAvatar(p, cls) { return `<span class="b24-proj-av${cls ? ' ' + cls : ''}" style="background:${projColor(p)}">${esc(L.initials(p.name))}</span>`; }
    function privacyBadge(p) { const x = PRIVACY[p.privacy || 'public']; return x ? `<span title="${esc(x.hint)}">${C.badge(x.color, x.label)}</span>` : ''; }
    function myRole(p) {
        if (p.owner_id === me.id) return 'Owner';
        if (p.manager_id === me.id) return 'Project manager';
        const m = page.members.find(x => x.project_id === p.id && x.user_id === me.id);
        return m ? ({ manager: 'Manager', moderator: 'Moderator', owner: 'Owner' }[m.role] || 'Member') : '';
    }
    function memberIdsOf(pid) { return page.members.filter(m => m.project_id === pid).map(m => m.user_id); }
    function progressOfP(pid) { return L.projectProgress(page.tasks.filter(t => t.project_id === pid)); }
    function joinHtml(p) {
        if (!cols.full || myRole(p) || p.archived_at) return '';
        if ((p.privacy || 'public') === 'public') return `<button type="button" class="ws-btn sm" data-join="${esc(p.id)}">Join</button>`;
        if (p.privacy === 'private') return page.requests.has(p.id) ? '<span class="muted" style="font-size:12.5px">Request sent</span>' : `<button type="button" class="ws-btn sm" data-ask="${esc(p.id)}">Request to join</button>`;
        return '';
    }
    async function loadMine() {
        const [m, r] = await Promise.all([
            sb.from('project_members').select('project_id').eq('user_id', me.id).limit(2000),
            cols.full ? sb.from('project_join_requests').select('project_id').eq('user_id', me.id).eq('status', 'pending') : Promise.resolve({ data: [] }),
        ]);
        page.myIds = (m.data || []).map(x => x.project_id);
        page.requests = new Set((r.data || []).map(x => x.project_id));
    }
    const mineOr = () => [`owner_id.eq.${me.id}`, `manager_id.eq.${me.id}`, page.myIds.length ? `id.in.(${page.myIds.join(',')})` : null].filter(Boolean).join(',');
    function stateApply(b, v) {
        if (v === 'active') return b.not('status', 'in', '(completed,cancelled)');
        if (v === 'completed') return b.eq('status', 'completed');
        return b;
    }
    function filterFields() {
        return [
            { key: 'state', title: 'State', type: 'select', apply: stateApply, options: [{ value: 'active', label: 'In progress' }, { value: 'completed', label: 'Completed' }, { value: 'archived', label: 'Archived' }] },
            { key: 'mine', title: 'My projects', type: 'check', checkLabel: 'Only projects I am in', apply: b => b.or(mineOr()) },
            ...(cols.full ? [
                { key: 'privacy', title: 'Privacy', type: 'select', options: Object.entries(PRIVACY).map(([value, x]) => ({ value, label: x.label })) },
                { key: 'joinable', title: 'Open to join', type: 'check', checkLabel: 'Projects I can join', default: false, apply: b => { b = b.in('privacy', ['public', 'private']); return page.myIds.length ? b.not('id', 'in', `(${page.myIds.join(',')})`).neq('owner_id', me.id) : b.neq('owner_id', me.id); } },
            ] : []),
            { key: 'status', title: 'Status', type: 'select', options: STATUS_OPTS, default: false },
            { key: 'manager', title: 'Project manager', type: 'user', column: 'manager_id', options: B.peopleOptions() },
            { key: 'owner', title: 'Owner', type: 'user', column: 'owner_id', options: B.peopleOptions(), none: false, default: false },
            { key: 'priority', title: 'Priority', type: 'select', options: PRIORITY_OPTS, default: false },
            { key: 'due', title: 'Deadline', type: 'date', column: 'due_date' },
            { key: 'tag', title: 'Tag', type: 'text', default: false, apply: (b, v) => b.contains('tags', [String(v).trim()]) },
        ];
    }
    const PRESETS = [
        { key: 'mine', title: 'My projects', values: { mine: true, state: 'active' } },
        { key: 'active', title: 'Projects in progress', values: { state: 'active' } },
        ...(cols.full ? [{ key: 'join', title: 'Open to join', values: { joinable: true, state: 'active' } }] : []),
        { key: 'completed', title: 'Completed projects', values: { state: 'completed' } },
        { key: 'archived', title: 'Archived projects', values: { state: 'archived' } },
        { key: 'all', title: 'All projects', values: {} },
    ];
    function scoped(b) {
        const v = page.filter.get().values;
        b = v.state === 'archived' ? b.not('archived_at', 'is', null) : b.is('archived_at', null);
        return page.filter.apply(b, { searchColumns: ['name', 'description'] });
    }
    async function withExtras(rows) {
        const ids = rows.map(r => r.id);
        const [mem, tsk] = await Promise.all([membersFor(ids), progressTasksFor(ids)]);
        page.members = mem; page.tasks = tsk;
        return rows;
    }

    async function showList() {
        page.mode = 'list';
        WSShell.setCrumb('Projects');
        document.title = 'Projects · WorkSuite';
        view.innerHTML = B.titleBar({ title: 'Projects', createLabel: 'Create' }) + `
            <div class="b24-toolbar">
                <div class="b24-views" role="tablist" aria-label="View"><button type="button" role="tab" data-view="list">List</button><button type="button" role="tab" data-view="tiles">Tiles</button></div>
                <div class="b24-counters" id="counters"></div>
            </div>
            <div id="body"></div>`;
        await loadMine();
        page.filter = WSFilter.mount(view.querySelector('[data-filter]'), { id: 'projects', fields: filterFields(), presets: PRESETS, defaultPreset: 'mine', me: me.id, onChange: () => refreshList() });
        view.querySelector('[data-create]').addEventListener('click', () => B.openRecord('/projects/?id=new', () => refreshList(true)));
        view.querySelector('.b24-toolbar').addEventListener('click', e => {
            const b = e.target.closest('[data-view]');
            if (b) { try { localStorage.setItem('ws-projects-view', b.dataset.view); } catch (err) { /* private mode */ } return mountView(b.dataset.view); }
            if (e.target.closest('[data-counter="requests"]')) openRequests();
        });
        let v = 'list'; try { v = localStorage.getItem('ws-projects-view') || (localStorage.getItem('ws-projects-mode') === 'cards' ? 'tiles' : 'list'); } catch (e) { /* private mode */ }
        if (['list', 'tiles'].includes(C.param('view'))) v = C.param('view');   // deep link: ?view=tiles
        mountView(v === 'tiles' ? 'tiles' : 'list');
        loadCounters();
        if (C.param('new') === '1') { C.setParam('new', null, true); B.openRecord('/projects/?id=new', () => refreshList(true)); }
    }
    function mountView(kind) {
        page.view = kind;
        view.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('on', b.dataset.view === kind); b.setAttribute('aria-selected', String(b.dataset.view === kind)); });
        if (page.grid) { page.grid.destroy(); page.grid = null; }
        page.reloadView = null;
        const body = view.querySelector('#body'); body.innerHTML = '';
        if (kind === 'tiles') return mountTiles(body);
        mountGrid(body);
    }
    async function refreshList(quiet) {
        if (page.mode !== 'list') return;
        await loadMine();
        loadCounters();
        if (page.grid) return quiet ? page.grid.refresh() : page.grid.reload();
        if (page.reloadView) return page.reloadView();
    }
    async function loadCounters() {
        const el = view.querySelector('#counters'); if (!el || !cols.full) return;
        const r = await sb.from('project_join_requests').select('id, user_id').eq('status', 'pending').neq('user_id', me.id).limit(500);
        const n = r.error ? 0 : (r.data || []).length;
        el.innerHTML = n ? `<button type="button" class="b24-counter red" data-counter="requests"><span class="n">${n}</span>Requests to join</button>` : '';
    }
    async function openRequests() {
        const r = await sb.from('project_join_requests').select('id, project_id, user_id, message, created_at').eq('status', 'pending').neq('user_id', me.id).order('created_at');
        const list = r.data || [];
        const pr = list.length ? await sb.from('projects').select('id, name').in('id', [...new Set(list.map(x => x.project_id))]) : { data: [] };
        const pname = id => ((pr.data || []).find(p => p.id === id) || {}).name || 'Project';
        const body = document.createElement('div');
        body.innerHTML = list.length ? `<ul class="crm-list">${list.map(x => `<li>${C.avatarHtml(x.user_id)}<div class="main"><b>${esc(C.personName(x.user_id))} → ${esc(pname(x.project_id))}</b><span>${esc(x.message || 'No message')} · ${esc(L.fmtRelative(x.created_at))}</span></div><div class="right"><button type="button" class="ws-btn sm primary" data-ok="${esc(x.id)}">Accept</button> <button type="button" class="ws-btn sm" data-no="${esc(x.id)}">Decline</button></div></li>`).join('')}</ul>` : '<div class="ws-empty">No requests waiting.</div>';
        const m = C.modal({ title: 'Requests to join', body, size: 'wide', actions: [{ label: 'Done', primary: true, close: true }], onClose: () => refreshList(true) });
        body.addEventListener('click', async e => {
            const b = e.target.closest('[data-ok], [data-no]'); if (!b) return;
            const ok = !!b.dataset.ok, id = b.dataset.ok || b.dataset.no;
            try { await C.q(sb.from('project_join_requests').update({ status: ok ? 'approved' : 'rejected' }).eq('id', id)); b.closest('li').remove(); C.toast(ok ? 'Request accepted' : 'Request declined', 'ok'); }
            catch (err) { C.toast(err.message, 'bad'); }
        });
        return m;
    }
    async function joinProject(p) {
        try { await C.q(sb.from('project_members').insert({ project_id: p.id, user_id: me.id, role: 'member', added_by: me.id })); C.toast(`You joined ${p.name}`, 'ok'); refreshList(true); }
        catch (e) { C.toast(e.message, 'bad'); }
    }
    async function askToJoin(p) {
        await C.formModal({ title: `Request to join ${p.name}`, fields: [{ name: 'message', label: 'Message to the project team (optional)', type: 'textarea', full: true }], submitLabel: 'Send request',
            onSubmit: async v => { await C.q(sb.from('project_join_requests').insert({ project_id: p.id, user_id: me.id, message: v.message || null })); C.toast('Request sent', 'ok'); refreshList(true); } });
    }
    async function leaveProject(p) {
        if (!await C.confirm({ title: `Leave ${p.name}?`, message: 'Your tasks in the project stay assigned to you.', okText: 'Leave' })) return;
        try { await C.q(sb.from('project_members').delete().eq('project_id', p.id).eq('user_id', me.id)); C.toast('You left the project', 'ok'); refreshList(true); }
        catch (e) { C.toast(e.message, 'bad'); }
    }
    function projectMenu(p) {
        const role = myRole(p);
        const items = [{ label: 'Open', icon: 'arrow', onClick: () => openProject(p.id) }];
        if (cols.full && !role && !p.archived_at && (p.privacy || 'public') === 'public') items.push({ label: 'Join', icon: 'plus', onClick: () => joinProject(p) });
        if (cols.full && !role && p.privacy === 'private' && !page.requests.has(p.id)) items.push({ label: 'Request to join', icon: 'mail', onClick: () => askToJoin(p) });
        if (role === 'Member' || role === 'Moderator' || role === 'Manager') items.push({ label: 'Leave project', icon: 'logout', onClick: () => leaveProject(p) });
        if (canEditProject(p, memberIdsOf(p.id))) {
            items.push({ label: 'Edit', icon: 'edit', onClick: () => openProjectEditor(p, memberIdsOf(p.id), () => refreshList(true)) });
            if (!p.archived_at) items.push(...statusMenuItems(p, () => refreshList(true)));
            items.push('sep', p.archived_at ? { label: 'Restore', icon: 'refresh', onClick: () => setArchived(p, false, () => refreshList(true)) } : { label: 'Archive', icon: 'trash', onClick: () => setArchived(p, true, () => refreshList(true)) });
        }
        return items;
    }
    function mountGrid(body) {
        const host = document.createElement('div'); body.appendChild(host);
        page.grid = WSGrid.mount(host, {
            id: 'projects', sort: { key: 'updated_at', dir: 'desc' },
            columns: [
                ...(cols.full ? [{ key: 'number', title: 'ID', width: 70, render: p => esc(p.number == null ? '' : p.number) }] : []),
                { key: 'name', title: 'Project', width: 300, render: p => `<span class="b24-who">${projAvatar(p)}<span><a href="/projects/?id=${esc(p.id)}" data-open>${esc(p.name)}</a>${p.description ? `<span class="sub">${esc(p.description.replace(/\s+/g, ' ').slice(0, 80))}</span>` : ''}</span></span>` },
                { key: 'updated_at', title: 'Activity date', width: 130, render: p => `<span class="muted">${esc(L.fmtRelative(p.updated_at))}</span>` },
                { key: 'members', title: 'Members', width: 150, sortable: false, render: p => C.avatarsHtml([p.owner_id, p.manager_id].filter(Boolean).concat(memberIdsOf(p.id)).filter((x, i, a) => a.indexOf(x) === i), 5) },
                { key: 'role', title: 'My role', width: 130, sortable: false, render: p => esc(myRole(p)) || joinHtml(p) },
                ...(cols.full ? [{ key: 'privacy', title: 'Privacy', width: 110, render: privacyBadge }] : []),
                { key: 'progress', title: 'Progress', width: 150, sortable: false, render: p => { const pr = progressOfP(p.id); return `<div style="min-width:110px">${progressHtml(pr, false)}<span class="muted" style="font-size:12px">${pr.done}/${pr.total} · ${pr.pct}%</span></div>`; } },
                { key: 'status', title: 'Status', width: 120, render: p => C.statusBadge(L.PROJECT_STATUS, p.status) },
                { key: 'due_date', title: 'Deadline', width: 150, render: p => dueChip(p) },
                { key: 'manager_id', title: 'Project manager', width: 170, default: false, render: p => C.personHtml(p.manager_id, { link: false, none: 'Not assigned' }) },
                { key: 'priority', title: 'Priority', width: 110, default: false, render: p => C.priorityBadge(p.priority) },
                { key: 'created_at', title: 'Created', width: 120, default: false, render: p => esc(L.fmtDate(p.created_at, { short: true })) },
                { key: 'tags', title: 'Tags', width: 160, default: false, sortable: false, render: p => C.tagsHtml(p.tags) },
            ],
            load: async ({ offset, limit, sort }) => {
                let b = scoped(sb.from('projects').select(SELECT));
                b = sort ? b.order(sort.key, { ascending: sort.dir === 'asc', nullsFirst: false }) : b.order('updated_at', { ascending: false });
                return withExtras((await C.q(b.range(offset, offset + limit - 1))).data || []);
            },
            count: async () => (await C.q(scoped(sb.from('projects').select('id', { count: 'exact', head: true })))).count || 0,
            onOpen: p => openProject(p.id),
            rowMenu: projectMenu,
            empty: { title: 'No projects here', sub: 'Change the filter, or create a project for your team.' },
        });
    }
    function mountTiles(body) {
        page.reloadView = async () => {
            body.innerHTML = '<div class="b24-area pad"><div class="ws-empty">Loading…</div></div>';
            try {
                const rows = await withExtras((await C.q(scoped(sb.from('projects').select(SELECT)).order('updated_at', { ascending: false }).limit(200))).data || []);
                if (!rows.length) { body.innerHTML = '<div class="b24-area pad"></div>'; C.empty(body.firstElementChild, 'No projects here', 'Change the filter, or create a project for your team.'); return; }
                body.innerHTML = `<div class="b24-tiles">${rows.map(p => { const pr = progressOfP(p.id); return `<article class="b24-tile" data-id="${esc(p.id)}">
                    <div class="top">${projAvatar(p, 'lg')}<div class="t"><a href="/projects/?id=${esc(p.id)}" data-open>${esc(p.name)}</a><span>${esc(myRole(p) || (cols.full ? PRIVACY[p.privacy || 'public'].label + ' project' : ''))}</span></div><button type="button" class="g-rowmenu" data-tile-menu="${esc(p.id)}" aria-label="Actions">☰</button></div>
                    <div class="badges">${C.statusBadge(L.PROJECT_STATUS, p.status)}${cols.full ? privacyBadge(p) : ''}${dueChip(p)}</div>
                    ${progressHtml(pr, true)}
                    <div class="foot">${C.avatarsHtml([p.owner_id, p.manager_id].filter(Boolean).concat(memberIdsOf(p.id)).filter((x, i, a) => a.indexOf(x) === i), 5)}<span class="grow"></span>${joinHtml(p)}</div>
                </article>`; }).join('')}</div>`;
                body.querySelectorAll('[data-tile-menu]').forEach(b => b.addEventListener('click', () => { const p = rows.find(x => x.id === b.dataset.tileMenu); if (p) C.menu(b, projectMenu(p)); }));
                page.tileRows = rows;
            } catch (e) { C.errorState(body, e, page.reloadView); }
        };
        page.reloadView();
    }
    view.addEventListener('click', e => {
        if (page.mode !== 'list') return;
        const rows = (page.grid ? page.grid.rows() : page.tileRows) || [];
        const j = e.target.closest('[data-join]'); if (j) { const p = rows.find(x => x.id === j.dataset.join); if (p) joinProject(p); return; }
        const q = e.target.closest('[data-ask]'); if (q) { const p = rows.find(x => x.id === q.dataset.ask); if (p) askToJoin(p); return; }
        const a = e.target.closest('a[data-open]');
        if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        const id = new URL(a.href, location.href).searchParams.get('id');
        if (id) openProject(id);
    });

    /* ------------------------------------------- new project (Bitrix24-style create page) */
    async function showCreate() {
        routeSeq++;
        page.mode = 'create';
        if (page.grid) { page.grid.destroy(); page.grid = null; }
        page.reloadView = null;
        document.title = 'New project · WorkSuite';
        WSShell.setCrumb('New project');
        C.loading(view, 'Opening…');
        const hasGoal = (await B.columns('projects', 'id, goal', 'id')).full;       // the goal column comes with supabase-b24-migration.sql
        let color = PCOLORS[Math.floor(Math.random() * PCOLORS.length)];
        let introHidden = false; try { introHidden = localStorage.getItem('ws-proj-intro') === 'hidden'; } catch (e) { /* private mode */ }
        view.innerHTML = `
            <div class="b24-pnew">
                <div class="b24-pnew-card">
                    <div class="b24-pnew-name">${cols.full ? `<button type="button" class="b24-pnew-av" data-color style="--c:${color}" title="Change the colour" aria-label="Change the project colour">P</button>` : ''}<div data-name style="flex:1;min-width:0"></div></div>
                    ${introHidden ? '' : '<div class="b24-pnew-intro" data-intro><b>WorkSuite projects</b>One place for the team\'s tasks, files, discussion and deadlines. Add colleagues now or later; the project board is ready as soon as you create it.<button type="button" data-intro-x aria-label="Hide this note">×</button></div>'}
                    <div data-main></div>
                    ${cols.full ? `<div class="b24-pnew-label">Privacy</div><div class="b24-privacy" role="radiogroup" aria-label="Privacy">${Object.entries(PRIVACY).map(([k, x]) => `<label><input type="radio" name="privacy" value="${k}"${k === 'public' ? ' checked' : ''}><span><b>${esc(x.label)}</b>${esc(x.hint)}</span></label>`).join('')}</div>` : ''}
                    <details class="b24-pnew-more"><summary>Other</summary><div data-more></div></details>
                </div>
                <div class="b24-new-foot"><button type="button" class="b24-btn-create" data-save>Create project</button><button type="button" class="b24-new-cancel" data-cancel>Cancel</button><span class="b24-new-err" data-err role="alert" hidden></span></div>
            </div>`;
        const nameForm = C.form([{ name: 'name', label: 'Project name', type: 'text', required: true, placeholder: 'Project name' }], { name: C.param('name') || '' });
        const mainForm = C.form([
            ...(hasGoal ? [{ name: 'goal', label: 'Project goal', type: 'text', full: true, placeholder: 'What should this project achieve?' }] : []),
            { name: 'description', label: 'Description', type: 'textarea', full: true, rows: 3, placeholder: 'Project details, visible to everyone who can see the project' },
            { name: 'owner_id', label: 'Project owner', type: 'people', none: null },
            { name: 'manager_id', label: 'Project manager', type: 'people', none: 'Not assigned' },
            ...(cols.full ? [{ name: 'moderators', label: 'Project moderators', type: 'peoples', full: true, hint: 'Moderators look after the project with the owner: they approve requests to join and keep it tidy.' }] : []),
            { name: 'members', label: 'Project members', type: 'peoples', full: true },
        ], { owner_id: me.id, manager_id: me.id, members: [], moderators: [] });
        const moreForm = C.form([
            { name: 'status', label: 'Status', type: 'select', options: STATUS_OPTS, required: true },
            { name: 'priority', label: 'Priority', type: 'select', options: PRIORITY_OPTS, required: true },
            { name: 'start_date', label: 'Start date', type: 'date' },
            { name: 'due_date', label: 'Deadline', type: 'date', validate: (v, all) => v && all.start_date && L.dayNumber(v) < L.dayNumber(all.start_date) ? 'The deadline is before the start date' : '' },
            { name: 'contact_id', label: 'Related contact', type: 'entity', entity: 'contact', placeholder: 'Search contacts' },
            { name: 'deal_id', label: 'Related deal', type: 'entity', entity: 'deal', placeholder: 'Search deals' },
            { name: 'tags', label: 'Tags', type: 'tags', full: true },
        ], { status: 'planning', priority: 'normal', contact_id: C.param('contact_id') || null, deal_id: C.param('deal_id') || null });
        view.querySelector('[data-name]').appendChild(nameForm.el);
        view.querySelector('[data-main]').appendChild(mainForm.el);
        view.querySelector('[data-more]').appendChild(moreForm.el);
        const av = view.querySelector('[data-color]'), nameInput = nameForm.field('name').el;
        const syncAv = () => { if (av) av.textContent = L.initials(nameInput.value || 'P') || 'P'; };
        nameInput.addEventListener('input', syncAv);
        if (av) av.addEventListener('click', () => { color = PCOLORS[(PCOLORS.indexOf(color) + 1) % PCOLORS.length]; av.style.setProperty('--c', color); });
        const ix = view.querySelector('[data-intro-x]');
        if (ix) ix.addEventListener('click', () => { view.querySelector('[data-intro]').remove(); try { localStorage.setItem('ws-proj-intro', 'hidden'); } catch (e) { /* private mode */ } });
        const errEl = view.querySelector('[data-err]'), btn = view.querySelector('[data-save]');
        async function save() {
            errEl.hidden = true;
            const okAll = [nameForm.validate(), mainForm.validate(), moreForm.validate()].every(Boolean);
            if (!okAll) { if (!moreForm.validate()) view.querySelector('.b24-pnew-more').open = true; errEl.textContent = 'Fill in the fields marked in red.'; errEl.hidden = false; return; }
            const v = { ...nameForm.get(), ...mainForm.get(), ...moreForm.get() };
            const privacy = (view.querySelector('input[name="privacy"]:checked') || {}).value || 'public';
            const row = {
                name: v.name.trim(), description: v.description || null, owner_id: v.owner_id || me.id, manager_id: v.manager_id || null,
                status: v.status, priority: v.priority, start_date: v.start_date || null, due_date: v.due_date || null,
                contact_id: v.contact_id || null, deal_id: v.deal_id || null, tags: v.tags || [], completed_at: v.status === 'completed' ? L.todayIST() : null,
                ...(cols.full ? { privacy, avatar_color: color } : {}), ...(hasGoal ? { goal: v.goal ? String(v.goal).trim() || null : null } : {}),
            };
            btn.disabled = true; btn.textContent = 'Creating…';
            try {
                const id = (await C.q(sb.from('projects').insert({ ...row, created_by: me.id }).select('id').single())).data.id;
                const mods = cols.full ? (v.moderators || []) : [];
                const people = [...new Set([...(v.members || []), ...mods])].filter(Boolean);
                try {
                    // The owner and creator may already be on the project (a database trigger adds them): never add anyone twice.
                    if (people.length) await C.q(sb.from('project_members').upsert(people.map(u => ({ project_id: id, user_id: u, role: mods.includes(u) ? 'moderator' : 'member', added_by: me.id })), { onConflict: 'project_id,user_id', ignoreDuplicates: true }));
                    people.filter(u => u !== me.id).forEach(u => C.pushNotify({ to: u, title: 'Added to a project', body: row.name, url: `/projects/?id=${id}`, tag: 'project' }));
                } catch (e) { C.toast(`Project created, but people could not be added: ${e.message}`, 'bad'); }
                if (row.manager_id && row.manager_id !== me.id) C.pushNotify({ to: row.manager_id, title: 'You manage a project', body: row.name, url: `/projects/?id=${id}`, tag: 'project' });
                C.toast('Project created', 'ok');
                B.afterCreate('/projects/', id);
            } catch (e) { errEl.textContent = e.message; errEl.hidden = false; btn.disabled = false; btn.textContent = 'Create project'; }
        }
        btn.addEventListener('click', save);
        view.querySelector('[data-cancel]').addEventListener('click', () => B.leaveCreate('/projects/'));
        view.querySelector('.b24-pnew').addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); } });
        syncAv();
        nameInput.focus();
    }

    /* ------------------------------------------------------------- record */
    async function showRecord(id) {
        const myRoute = ++routeSeq;
        page.mode = 'record';
        if (page.grid) { page.grid.destroy(); page.grid = null; }
        page.reloadView = null;
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        C.loading(view, 'Loading project…');
        let p;
        try { p = (await C.q(sb.from('projects').select(SELECT).eq('id', id).maybeSingle())).data; }
        catch (e) { return C.errorState(view, e, () => showRecord(id)); }
        if (myRoute !== routeSeq) return;                    // navigated away while it loaded
        if (!p) { view.innerHTML = `<a class="crm-back" href="/projects/">${C.icon('arrow')}All projects</a>`; C.empty(view.appendChild(document.createElement('div')), 'Project not found', 'It may have been deleted, or you may not have access to it.'); return; }
        const lk = await C.lookups();
        const taskStatusMap = Object.fromEntries(lk.taskStatuses.map(s => [s.key, s]));
        document.title = `${p.name} · Projects · WorkSuite`;
        WSShell.setCrumb(p.name);

        let members = await membersFor([id]);
        if (myRoute !== routeSeq) return;
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
        if (myRoute !== routeSeq) return;

        const mids = () => members.map(m => m.user_id);
        const canEdit = () => canEditProject(p, mids());
        // The same people project_members_manage lets in (moderators approve join requests, which a trigger turns into members).
        const canManageMembers = () => ctx.isManager || p.owner_id === me.id || p.manager_id === me.id || p.created_by === me.id;
        const prog = () => L.projectProgress(tasks);

        function headHtml() {
            const pr = prog();
            const role = p.owner_id === me.id ? 'Owner' : p.manager_id === me.id ? 'Project manager' : (() => { const m = members.find(x => x.user_id === me.id); return m ? ({ manager: 'Manager', moderator: 'Moderator', owner: 'Owner' }[m.role] || 'Member') : ''; })();
            return `
                <div class="b24-card-head">
                    <h1 class="b24-card-title">${projAvatar(p, 'lg')}<span class="t">${esc(p.name)}</span>${cols.full && p.number != null ? `<span class="num">#${esc(p.number)}</span>` : ''}</h1>
                    <div class="sub">${C.statusBadge(L.PROJECT_STATUS, p.status)} ${cols.full ? privacyBadge(p) : ''} ${C.priorityBadge(p.priority)} ${dueChip(p)} ${p.archived_at ? C.badge('mute', 'Archived') : ''} ${role ? `· You: ${esc(role)}` : ''} ${p.contact_id ? C.entityChip('contact', p.contact_id, contactLabel) : ''}${p.deal_id ? C.entityChip('deal', p.deal_id, dealLabel) : ''}</div>
                    <div class="acts">
                        ${WSShell.inSlider ? '' : `<a class="b24-btn-card" href="/projects/" data-nav>${C.icon('arrow')}<span>All projects</span></a>`}
                        ${!role && cols.full && !p.archived_at && (p.privacy || 'public') === 'public' ? '<button type="button" class="b24-btn-create" id="join-btn">Join</button>' : ''}
                        ${!role && cols.full && !p.archived_at && p.privacy === 'private' ? '<button type="button" class="b24-btn-create" id="ask-btn">Request to join</button>' : ''}
                        <button type="button" class="b24-btn-card" id="task-btn">${C.icon('tasks')}<span>New task</span></button>
                        <button type="button" class="b24-btn-card" id="meet-btn">${C.icon('calendar')}<span>Schedule</span></button>
                        ${canEdit() ? `<button type="button" class="b24-btn-card" id="edit-btn">${C.icon('edit')}<span>Edit</span></button>` : ''}
                        ${canEdit() ? `<button type="button" class="b24-btn-card" id="status-btn">${C.icon('check')}<span>Status</span></button>` : ''}
                        <button type="button" class="b24-btn-card round" id="more-btn" aria-label="More actions">${C.icon('more')}</button>
                    </div>
                </div>
                <div class="b24-area b24-proj-progress" id="head-progress">${progressHtml(pr, true)}</div>`;
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

        const navBtn = view.querySelector('[data-nav]');
        if (navBtn) navBtn.addEventListener('click', e => { e.preventDefault(); history.pushState(null, '', '/projects/'); showList(); });
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
        async function loadJoinRequests(el) {
            const r = await sb.from('project_join_requests').select('id, user_id, message, created_at').eq('project_id', id).eq('status', 'pending').order('created_at');
            const list = r.error ? [] : (r.data || []);
            const box = document.createElement('div');
            box.className = 'ws-card flush';
            box.style.marginTop = '12px';
            box.innerHTML = `<div class="ws-card-head"><h3>Requests to join</h3><span class="sub">${list.length}</span></div>` + (list.length
                ? `<ul class="crm-list" style="padding:0 20px 12px">${list.map(x => `<li>${C.avatarHtml(x.user_id)}<div class="main"><b>${esc(C.personName(x.user_id))}</b><span>${esc(x.message || 'No message')} · ${esc(L.fmtRelative(x.created_at))}</span></div><div class="right"><button type="button" class="ws-btn sm primary" data-req-ok="${esc(x.id)}">Accept</button> <button type="button" class="ws-btn sm" data-req-no="${esc(x.id)}">Decline</button></div></li>`).join('')}</ul>`
                : '<div class="ws-empty" style="padding:14px">No requests waiting.</div>');
            el.appendChild(box);
            box.addEventListener('click', async e => {
                const b = e.target.closest('[data-req-ok], [data-req-no]'); if (!b) return;
                const ok = !!b.dataset.reqOk;
                try {
                    await C.q(sb.from('project_join_requests').update({ status: ok ? 'approved' : 'rejected' }).eq('id', b.dataset.reqOk || b.dataset.reqNo));
                    C.toast(ok ? 'Request accepted' : 'Request declined', 'ok');
                    members = await membersFor([id]); tabs.setCount('members', members.length); renderMembersTab();
                } catch (err) { C.toast(err.message, 'bad'); }
            });
        }
        function renderMembersTab() {
            const el = view.querySelector('#members-panel');
            const manage = canManageMembers();
            const exclude = new Set([...mids()]);
            el.innerHTML = `<div class="ws-card flush">
                <div class="ws-card-head"><h3>Members</h3>${manage ? `<div class="right" style="display:flex;gap:8px;flex-wrap:wrap"><select id="add-member" aria-label="Add member"><option value="">Add a colleague…</option>${C.peopleOptions('', { none: null, people: C.activePeople().filter(x => !exclude.has(x.id)) })}</select></div>` : ''}</div>
                <div class="crm-table-wrap"><table class="ws-table cards"><thead><tr><th>Person</th><th>Role</th><th>Added</th>${manage ? '<th></th>' : ''}</tr></thead><tbody>
                ${[...(p.owner_id ? [{ user_id: p.owner_id, role: 'owner' }] : []), ...(p.manager_id && p.manager_id !== p.owner_id ? [{ user_id: p.manager_id, role: 'pm' }] : []), ...members.filter(m => m.user_id !== p.owner_id && m.user_id !== p.manager_id)].map(m => `<tr>
                    <td class="lead" data-label="Person"><a class="crm-person link" href="/employees/?id=${esc(m.user_id)}">${C.avatarHtml(m.user_id)}<span class="nm">${esc(C.personName(m.user_id))}</span></a></td>
                    <td data-label="Role">${m.role === 'owner' ? C.badge('pending', 'Owner') : m.role === 'pm' ? C.badge('leave', 'Project manager') : manage ? `<select data-role="${esc(m.user_id)}" aria-label="Role"><option value="member"${m.role === 'member' ? ' selected' : ''}>Member</option><option value="moderator"${m.role === 'moderator' ? ' selected' : ''}>Moderator</option><option value="manager"${m.role === 'manager' ? ' selected' : ''}>Manager</option></select>` : C.badge(m.role === 'manager' || m.role === 'moderator' ? 'leave' : 'mute', m.role === 'manager' ? 'Manager' : m.role === 'moderator' ? 'Moderator' : 'Member')}</td>
                    <td data-label="Added"><span class="muted">${m.created_at ? esc(L.fmtDate(m.created_at)) + ' by ' + esc(C.personName(m.added_by)) : '—'}</span></td>
                    ${manage ? `<td class="actions">${m.role === 'owner' || m.role === 'pm' ? '' : `<button type="button" class="ws-btn sm icon" data-remove="${esc(m.user_id)}" aria-label="Remove">${C.icon('x')}</button>`}</td>` : ''}
                </tr>`).join('') || `<tr><td colspan="4" class="muted" style="text-align:center;padding:24px">No members yet.</td></tr>`}
                </tbody></table></div></div>`;
            if (manage && cols.full) loadJoinRequests(el);
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
                try {
                    const r = await C.q(sb.from('project_members').update({ role: s.value }).eq('project_id', id).eq('user_id', s.dataset.role).select('user_id'));
                    if (!(r.data || []).length) throw new Error('Only the project owner, its manager or a workspace manager can change roles.');
                    C.toast('Role updated', 'ok'); members = await membersFor([id]);
                }
                catch (err) { C.toast(err.message, 'bad'); renderMembersTab(); }
            });
            el.addEventListener('click', async e => {
                const b = e.target.closest('[data-remove]'); if (!b) return;
                if (!await C.confirm({ title: `Remove ${C.personName(b.dataset.remove)} from the project?`, message: 'Their tasks stay assigned to them.', okText: 'Remove', danger: true })) return;
                try {
                    const r = await C.q(sb.from('project_members').delete().eq('project_id', id).eq('user_id', b.dataset.remove).select('user_id'));
                    if (!(r.data || []).length) throw new Error('Only the project owner, its manager or a workspace manager can remove members.');
                    C.toast('Member removed', 'ok'); members = await membersFor([id]); tabs.setCount('members', members.length); renderMembersTab(); renderOverview(); }
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
        on('#join-btn', async () => { await joinProject(p); showRecord(id); });
        on('#ask-btn', () => askToJoin(p));
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
