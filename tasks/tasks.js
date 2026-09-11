/* ============================================================================
   Tasks — My Tasks / All / Created by me / Overdue / Due today / Completed in
   list or Kanban form, plus a task record page with subtasks, watchers,
   attachments and a comment thread. Everything runs through Supabase behind
   RLS via the shared WSCrm runtime; status history is written by the
   database triggers.

   URLs:  /tasks/                 list (default view: mine)
          /tasks/?view=overdue    a specific view   (mine|all|created|overdue|today|completed)
          /tasks/?display=kanban  list or kanban
          /tasks/?id=<uuid>       record
          /tasks/?new=1           list + new-task dialog
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc, h = C.h, B = window.WSB24;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'tasks', crumb: 'Tasks', layout: 'b24' });
    const sb = ctx.sb, me = ctx.user;
    const lk = await C.lookups();
    const STATUS = lk.taskStatus;
    const DONE_KEY = (lk.taskStatuses.find(s => s.is_done) || { key: 'completed' }).key;
    const OPEN_KEY = (lk.taskStatuses.find(s => !s.is_done) || { key: 'todo' }).key;
    const BASE = 'id, company, title, description, status, priority, assignee_id, project_id, board_id, board_column_id, position, parent_task_id, contact_id, lead_id, deal_id, start_date, due_date, due_time, reminder_at, completed_at, estimate_hours, tags, archived_at, created_by, created_at, updated_at';
    const [cols, tplProbe] = await Promise.all([B.columns('tasks', BASE + ', number', BASE), sb.from('task_templates').select('id').limit(1)]);
    const SELECT = cols.select;
    const hasTemplates = !tplProbe.error;
    const VIEWS = [
        { key: 'mine', label: 'My Tasks' }, { key: 'all', label: 'All Tasks' }, { key: 'created', label: 'Created by Me' },
        { key: 'overdue', label: 'Overdue' }, { key: 'today', label: 'Due Today' }, { key: 'completed', label: 'Completed' },
    ];
    let unsubscribe = null;

    /* ------------------------------------------------------------ routing */
    let recordSeq = 0;                     // bumped on every navigation, so a slow task load cannot land on the next page
    function route() {
        recordSeq++;
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
    function isDone(t) { return !!t.completed_at; }
    function subtitle(t) {
        const bits = [];
        if (t.project_id) bits.push(C.entityChip('project', t.project_id, names.project[t.project_id] || 'Project'));
        if (t.contact_id) bits.push(C.entityChip('contact', t.contact_id, names.contact[t.contact_id] || 'Contact'));
        if (t.deal_id) bits.push(C.entityChip('deal', t.deal_id, names.deal[t.deal_id] || 'Deal'));
        if (t.lead_id) bits.push(C.entityChip('lead', t.lead_id, names.lead[t.lead_id] || 'Lead'));
        return bits.join(' ');
    }
    // Plain-text version of the linked-record chips for kanban cards (no links inside a draggable card).
    function chipText(t) { return esc([t.project_id && names.project[t.project_id], t.contact_id && names.contact[t.contact_id], t.deal_id && names.deal[t.deal_id], t.lead_id && names.lead[t.lead_id]].filter(Boolean).join(' · ')); }
    // Names of linked records, fetched once per page so rows carry a label and not a bare id.
    const names = { project: {}, contact: {}, deal: {}, lead: {} };
    async function resolveNames(rows) {
        const want = { project: ['projects', 'name', 'project_id'], contact: ['crm_contacts', 'full_name', 'contact_id'], deal: ['crm_deals', 'title', 'deal_id'], lead: ['crm_leads', 'name', 'lead_id'] };
        await Promise.all(Object.entries(want).map(async ([k, [table, col, fk]]) => {
            const ids = Array.from(new Set(rows.map(r => r[fk]).filter(id => id && !names[k][id])));
            if (!ids.length) return;
            const r = await sb.from(table).select(`id, ${col}`).in('id', ids);
            (r.data || []).forEach(x => { names[k][x.id] = x[col]; });
        }));
    }

    /* ------------------------------------------------------------ actions */
    /** PostgREST returns zero rows (no error) when RLS refuses an update; treat that as a permission error. */
    async function mustUpdate(builder, expected) {
        const { data } = await C.q(builder.select('id'));
        const n = (data || []).length;
        if (!n) throw new Error('You do not have permission to change this task.');
        if (expected && n < expected) C.toast(`${expected - n} task${expected - n > 1 ? 's were' : ' was'} skipped: no permission`, 'bad');
        return n;
    }
    async function setDone(t, done, after) {
        try {
            await mustUpdate(sb.from('tasks').update({ status: done ? DONE_KEY : OPEN_KEY }).eq('id', t.id));
            C.toast(done ? 'Task completed' : 'Task reopened', 'ok');
            WSShell.refreshUnread();
            if (after) after();
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function assignToMe(t, after) {
        try {
            await mustUpdate(sb.from('tasks').update({ assignee_id: me.id }).eq('id', t.id));
            C.toast('Assigned to you', 'ok'); WSShell.refreshUnread(); if (after) after();
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function setArchived(t, archived, after) {
        if (archived && !await C.confirm({ title: `Archive "${t.title}"?`, message: 'Archived tasks disappear from lists and boards but keep their comments and history. You can restore them from the archived filter.', okText: 'Archive', danger: true })) return;
        try {
            await mustUpdate(sb.from('tasks').update({ archived_at: archived ? new Date().toISOString() : null }).eq('id', t.id));
            C.toast(archived ? 'Task archived' : 'Task restored', 'ok'); WSShell.refreshUnread(); if (after) after();
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function deleteTask(t) {
        if (!await C.confirm({ title: 'Delete this task permanently?', message: 'Subtasks, comments and attachments links are removed with it. Archiving keeps the history.', okText: 'Delete permanently', danger: true })) return;
        try { await C.q(sb.from('tasks').delete().eq('id', t.id)); C.toast('Task deleted', 'ok'); WSShell.refreshUnread(); if (WSShell.inSlider) { WSShell.sliderMessage('deleted', { id: t.id }); WSShell.closeSlider(); } else go('/tasks/'); }
        catch (e) { C.toast(e.message, 'bad'); }
    }
    async function duplicateTask(t) {
        try {
            const copy = { title: `Copy of ${t.title}`, description: t.description, status: OPEN_KEY, priority: t.priority, assignee_id: t.assignee_id, project_id: t.project_id, contact_id: t.contact_id, lead_id: t.lead_id, deal_id: t.deal_id, start_date: t.start_date, due_date: t.due_date, due_time: t.due_time, estimate_hours: t.estimate_hours, tags: t.tags || [], created_by: me.id };
            const { data } = await C.q(sb.from('tasks').insert(copy).select('id').single());
            C.toast('Task duplicated', 'ok'); go(`/tasks/?id=${data.id}`);
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function loadAssignees(taskId) {
        const r = await sb.from('task_assignees').select('user_id').eq('task_id', taskId);
        return (r.data || []).map(x => x.user_id);
    }
    async function editTask(t, after) {
        const assignees = await loadAssignees(t.id);
        return C.openTaskEditor({ task: t, assignees, onSaved: after });
    }
    /* ----------------------------------------------- list (workspace layout) */
    const page = { mode: null, grid: null, board: null, filter: null, view: 'list', role: 'ongoing', onlyIds: null, month: null, ganttStart: null };
    const today = L.todayIST();
    const NONE_ID = '00000000-0000-0000-0000-000000000000';
    const openTask = id => B.openRecord(`/tasks/?id=${id}`, () => refreshList(true));
    const roleIds = { assisting: [], following: [] };
    async function loadRoleIds() {
        const [a, w] = await Promise.all([
            sb.from('task_assignees').select('task_id').eq('user_id', me.id).limit(3000),
            sb.from('task_watchers').select('task_id').eq('user_id', me.id).limit(3000),
        ]);
        roleIds.assisting = (a.data || []).map(x => x.task_id);
        roleIds.following = (w.data || []).map(x => x.task_id);
    }
    const ROLES = [['ongoing', 'Ongoing'], ['assisting', 'Assisting'], ['created', 'Set by me'], ['following', 'Following'], ['all', 'All tasks']];
    function roleApply(b, role) {
        if (role === 'ongoing') return b.eq('assignee_id', me.id);
        if (role === 'assisting') return b.in('id', roleIds.assisting.length ? roleIds.assisting : [NONE_ID]);
        if (role === 'created') return b.eq('created_by', me.id);
        if (role === 'following') return b.in('id', roleIds.following.length ? roleIds.following : [NONE_ID]);
        return b;
    }
    function stateApply(b, v) {
        if (v === 'open') return b.is('completed_at', null);
        if (v === 'done') return b.not('completed_at', 'is', null);
        if (v === 'overdue') return b.is('completed_at', null).lt('due_date', today);
        return b;
    }
    let projectOpts = [];
    function filterFields() {
        return [
            { key: 'state', title: 'State', type: 'select', apply: stateApply, options: [{ value: 'open', label: 'In progress' }, { value: 'overdue', label: 'Overdue' }, { value: 'done', label: 'Completed' }, { value: 'archived', label: 'Recycle bin' }] },
            { key: 'due', title: 'Deadline', type: 'date', column: 'due_date' },
            { key: 'responsible', title: 'Responsible', type: 'user', column: 'assignee_id', options: B.peopleOptions() },
            { key: 'creator', title: 'Created by', type: 'user', column: 'created_by', options: B.peopleOptions(), none: false },
            { key: 'project', title: 'Project', type: 'select', column: 'project_id', options: projectOpts },
            { key: 'priority', title: 'Priority', type: 'select', options: Object.entries(L.PRIORITY).map(([value, p]) => ({ value, label: p.label })) },
            { key: 'status', title: 'Status', type: 'multiselect', options: lk.taskStatuses.map(s => ({ value: s.key, label: s.label })), default: false },
            { key: 'created', title: 'Created', type: 'date', column: 'created_at', datetime: true, default: false },
            { key: 'tag', title: 'Tag', type: 'text', default: false, apply: (b, v) => b.contains('tags', [String(v).trim()]) },
        ];
    }
    const PRESETS = [
        { key: 'progress', title: 'In progress', values: { state: 'open' } },
        { key: 'overdue', title: 'Overdue', values: { state: 'overdue' } },
        { key: 'high', title: 'High priority', values: { state: 'open', priority: 'high' } },
        { key: 'completed', title: 'Completed', values: { state: 'done' } },
        { key: 'bin', title: 'Recycle bin', values: { state: 'archived' } },
        { key: 'all', title: 'All tasks', values: {} },
    ];
    function scoped(b, o) {
        const v = page.filter.get().values;
        b = v.state === 'archived' ? b.not('archived_at', 'is', null) : b.is('archived_at', null);
        if (!(o && o.noRole)) b = roleApply(b, page.role);
        if (page.onlyIds) b = b.in('id', page.onlyIds.length ? page.onlyIds : [NONE_ID]);
        return page.filter.apply(b, { searchColumns: ['title', 'description'] });
    }
    const VIEW_LIST = [['list', 'List'], ['deadline', 'Deadline'], ['planner', 'Planner'], ['calendar', 'Calendar'], ['gantt', 'Gantt'], ['kanban', 'Kanban']];

    async function showList() {
        page.mode = 'list';
        WSShell.setCrumb('Tasks');
        document.title = 'Tasks · WorkSuite';
        const pr = await sb.from('projects').select('id, name').is('archived_at', null).order('name').limit(300);
        projectOpts.splice(0, projectOpts.length, ...(pr.data || []).map(p => ({ value: p.id, label: p.name })));
        (pr.data || []).forEach(p => { names.project[p.id] = p.name; });
        const r0 = C.param('role'); if (ROLES.some(r => r[0] === r0)) page.role = r0;
        const v0 = C.param('view'); if (v0 === 'mine') page.role = 'ongoing'; else if (v0 === 'created') page.role = 'created'; else if (v0 === 'all') page.role = 'all';
        // Older links (the CRM dashboard, bookmarks): /tasks/?view=overdue|today|completed open that filter.
        const urlFilter = { overdue: ['overdue', { state: 'overdue' }], today: [null, { state: 'open', due: { kind: 'today' } }], completed: ['completed', { state: 'done' }] }[v0];
        if (urlFilter) page.role = 'all';
        view.innerHTML = B.titleBar({ title: 'Tasks', createLabel: 'Create', createMenu: hasTemplates }) + `
            <div class="b24-toolbar">
                <div class="b24-views" role="tablist" aria-label="Role">${ROLES.map(([k, t]) => `<button type="button" role="tab" data-role="${k}">${esc(t)}<span class="b24-n" data-rc="${k}"></span></button>`).join('')}</div>
                <div class="b24-counters" id="counters"></div>
                <span class="grow"></span>
                <div class="b24-views" role="tablist" aria-label="View">${VIEW_LIST.map(([k, t]) => `<button type="button" role="tab" data-view="${k}">${esc(t)}</button>`).join('')}</div>
            </div>
            <div id="only" hidden></div>
            <div id="body"></div>`;
        page.filter = WSFilter.mount(view.querySelector('[data-filter]'), { id: 'tasks', fields: filterFields(), presets: PRESETS, defaultPreset: 'progress', me: me.id, onChange: () => refreshList() });
        if (urlFilter) { C.setParam('view', null, true); page.filter.set(urlFilter[1], urlFilter[0]); }
        const create = () => B.openRecord('/tasks/?id=new', () => refreshList());
        view.querySelector('[data-create]').addEventListener('click', create);
        const more = view.querySelector('[data-create-menu]');
        if (more) more.addEventListener('click', () => C.menu(more, [
            { label: 'Create from a template…', icon: 'star', onClick: pickTemplate },
            { label: 'Task templates', icon: 'edit', onClick: manageTemplates },
        ]));
        view.querySelector('.b24-toolbar').addEventListener('click', e => {
            const r = e.target.closest('[data-role]');
            if (r) { page.role = r.dataset.role; C.setParam('role', page.role === 'ongoing' ? null : page.role, true); syncTabs(); return refreshList(); }
            const vb = e.target.closest('[data-view]');
            if (vb) { try { localStorage.setItem('ws-tasks-view', vb.dataset.view); } catch (err) { /* private mode */ } mountView(vb.dataset.view); }
            const c = e.target.closest('[data-counter]');
            if (c && c.dataset.counter === 'overdue') { page.role = 'ongoing'; syncTabs(); page.filter.set({ state: 'overdue' }); }
            if (c && c.dataset.counter === 'comments') { page.onlyIds = page.commentIds || []; showOnly(); refreshList(); }
        });
        await loadRoleIds();
        syncTabs();
        let v = VIEW_LIST.some(x => x[0] === C.param('display')) ? C.param('display') : null;   // deep link: ?display=deadline|planner|calendar|gantt|kanban|list
        if (!v) { try { v = localStorage.getItem('ws-tasks-view') || 'list'; } catch (e) { v = 'list'; } }
        if (!VIEW_LIST.some(x => x[0] === v)) v = 'list';
        mountView(v);
        loadCounters();
        if (C.param('new') === '1') { C.setParam('new', null, true); create(); }
    }
    function syncTabs() {
        view.querySelectorAll('[data-role]').forEach(b => { b.classList.toggle('on', b.dataset.role === page.role); b.setAttribute('aria-selected', String(b.dataset.role === page.role)); });
    }
    function showOnly() {
        const el = view.querySelector('#only');
        el.hidden = !page.onlyIds;
        el.innerHTML = page.onlyIds ? `<div class="b24-area pad b24-only">Showing ${page.onlyIds.length} task${page.onlyIds.length === 1 ? '' : 's'} with new comments. <button type="button" class="b24-link" data-clear-only>Show all</button></div>` : '';
        const b = el.querySelector('[data-clear-only]'); if (b) b.addEventListener('click', () => { page.onlyIds = null; showOnly(); refreshList(); });
    }
    function mountView(kind) {
        page.view = kind;
        view.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('on', b.dataset.view === kind); b.setAttribute('aria-selected', String(b.dataset.view === kind)); });
        if (page.grid) { page.grid.destroy(); page.grid = null; }
        if (page.board) { page.board.destroy(); page.board = null; }
        const body = view.querySelector('#body'); body.innerHTML = '';
        ({ list: mountGrid, deadline: mountDeadline, planner: mountPlanner, calendar: mountCalendar, gantt: mountGantt, kanban: mountStatusBoard })[kind](body);
    }
    function refreshList(quiet) {
        if (page.mode !== 'list') return;
        loadCounters();
        if (page.grid) return quiet ? page.grid.refresh() : page.grid.reload();
        if (page.reloadView) return page.reloadView();
    }
    async function loadCounters() {
        const el = view.querySelector('#counters'); if (!el) return;
        const head = () => sb.from('tasks').select('id', { count: 'exact', head: true }).is('archived_at', null).is('completed_at', null);
        try {
            const results = await Promise.all([
                head().eq('assignee_id', me.id).lt('due_date', today),
                ...ROLES.map(([k]) => roleApply(head(), k)),
            ]);
            const n = r => (r && !r.error && r.count) || 0;
            ROLES.forEach(([k], i) => { const s = view.querySelector(`[data-rc="${k}"]`); if (s) s.textContent = n(results[i + 1]) || ''; });
            const overdue = n(results[0]);
            const comments = await newCommentIds();
            page.commentIds = comments;
            el.innerHTML = `<button type="button" class="b24-counter${overdue ? ' red' : ''}" data-counter="overdue"><span class="n">${overdue}</span>Overdue</button>
                ${comments ? `<button type="button" class="b24-counter${comments.length ? ' green' : ''}" data-counter="comments"><span class="n">${comments.length}</span>New comments</button>` : ''}`;
        } catch (e) { el.innerHTML = ''; }
    }
    /** Tasks I work on with comments from others since I last opened them (needs task_views). */
    async function newCommentIds() {
        const mine = await sb.from('tasks').select('id').is('archived_at', null).or(`assignee_id.eq.${me.id},created_by.eq.${me.id}`).limit(500);
        const ids = [...new Set((mine.data || []).map(x => x.id).concat(roleIds.assisting, roleIds.following))].slice(0, 500);
        if (!ids.length) return [];
        const since = new Date(Date.now() - 30 * 86400000).toISOString();
        const [cm, seen] = await Promise.all([
            sb.from('comments').select('entity_id, created_at, author_id').eq('entity_type', 'task').in('entity_id', ids).gte('created_at', since).limit(2000),
            sb.from('task_views').select('task_id, viewed_at').eq('user_id', me.id).in('task_id', ids),
        ]);
        if (seen.error) return null;
        const last = new Map((seen.data || []).map(v => [v.task_id, v.viewed_at]));
        const out = new Set();
        (cm.data || []).forEach(c => { if (c.author_id !== me.id && (!last.has(c.entity_id) || c.created_at > last.get(c.entity_id))) out.add(c.entity_id); });
        return [...out];
    }

    /* ----- List ----- */
    function mountGrid(body) {
        const host = document.createElement('div'); body.appendChild(host);
        page.reloadView = null;
        const people = [{ value: '', label: 'Not assigned' }].concat(B.peopleOptions());
        const saveField = key => async (t, v) => { await mustUpdate(sb.from('tasks').update({ [key]: v }).eq('id', t.id)); WSShell.refreshUnread(); };
        page.grid = WSGrid.mount(host, {
            id: 'tasks', sort: { key: 'due_date', dir: 'asc' },
            columns: [
                ...(cols.full ? [{ key: 'number', title: 'ID', width: 70, render: t => esc(t.number == null ? '' : t.number) }] : []),
                { key: 'title', title: 'Name', width: 340, render: t => `<span class="b24-task${isDone(t) ? ' done' : ''}"><input type="checkbox" data-done="${esc(t.id)}"${isDone(t) ? ' checked' : ''} aria-label="Complete"><span><a href="/tasks/?id=${esc(t.id)}" data-open>${esc(t.title)}</a>${chipText(t) ? `<span class="sub">${chipText(t)}</span>` : ''}</span></span>`, edit: { type: 'text', save: saveField('title') } },
                { key: 'due_date', title: 'Deadline', width: 160, render: t => C.dueHtml(t, today), edit: { type: 'date', save: saveField('due_date') } },
                { key: 'assignee_id', title: 'Responsible', width: 180, render: t => C.personHtml(t.assignee_id, { link: false }), edit: { type: 'people', options: people, save: saveField('assignee_id') } },
                { key: 'created_by', title: 'Created by', width: 170, render: t => C.personHtml(t.created_by, { link: false }) },
                { key: 'status', title: 'Status', width: 140, render: t => C.statusBadge(STATUS, t.status), edit: { type: 'select', options: lk.taskStatuses.map(s => ({ value: s.key, label: s.label })), save: saveField('status') } },
                { key: 'priority', title: 'Priority', width: 110, render: t => C.priorityBadge(t.priority), edit: { type: 'select', options: Object.entries(L.PRIORITY).map(([value, p]) => ({ value, label: p.label })), save: saveField('priority') } },
                { key: 'project_id', title: 'Project', width: 170, render: t => t.project_id ? esc(names.project[t.project_id] || 'Project') : '' },
                { key: 'updated_at', title: 'Activity date', width: 130, render: t => `<span class="muted">${esc(L.fmtRelative(t.updated_at))}</span>` },
                { key: 'start_date', title: 'Start', width: 120, default: false, render: t => esc(L.fmtDate(t.start_date) || ''), edit: { type: 'date', save: saveField('start_date') } },
                { key: 'estimate_hours', title: 'Estimate, h', width: 110, align: 'right', default: false, render: t => esc(t.estimate_hours == null ? '' : t.estimate_hours) },
                { key: 'created_at', title: 'Created', width: 120, default: false, render: t => esc(L.fmtDate(t.created_at, { short: true })) },
                { key: 'tags', title: 'Tags', width: 160, default: false, sortable: false, render: t => C.tagsHtml(t.tags) },
            ],
            load: async ({ offset, limit, sort }) => {
                let b = scoped(sb.from('tasks').select(SELECT));
                b = sort ? b.order(sort.key, { ascending: sort.dir === 'asc', nullsFirst: false }) : b.order('due_date', { ascending: true, nullsFirst: false });
                const rows = (await C.q(b.order('created_at', { ascending: false }).range(offset, offset + limit - 1))).data || [];
                await resolveNames(rows);
                return rows;
            },
            count: async () => (await C.q(scoped(sb.from('tasks').select('id', { count: 'exact', head: true })))).count || 0,
            onOpen: t => openTask(t.id),
            rowMenu: t => {
                const items = [{ label: 'Open', icon: 'arrow', onClick: () => openTask(t.id) }, { label: 'Edit', icon: 'edit', onClick: () => editTask(t, () => refreshList(true)) }];
                items.push(isDone(t) ? { label: 'Resume', icon: 'refresh', onClick: () => setDone(t, false, () => refreshList(true)) } : { label: 'Complete', icon: 'check', onClick: () => setDone(t, true, () => refreshList(true)) });
                if (t.assignee_id !== me.id) items.push({ label: 'Take it', icon: 'user', onClick: () => assignToMe(t, () => refreshList(true)) });
                items.push({ label: 'Copy', icon: 'plus', onClick: () => duplicateTask(t) });
                items.push('sep', t.archived_at ? { label: 'Restore', icon: 'refresh', onClick: () => setArchived(t, false, () => refreshList(true)) } : { label: 'Move to recycle bin', icon: 'trash', danger: true, onClick: () => setArchived(t, true, () => refreshList(true)) });
                return items;
            },
            bulk: [
                { label: 'Complete', icon: 'check', run: async (ids, o) => bulkPatch(ids, o, { status: DONE_KEY }, 'Completed') },
                { label: 'Change responsible', icon: 'user', run: async (ids, o) => { const v = await B.pick('Change responsible', { type: 'people', label: 'Responsible', none: 'Not assigned' }, ''); if (v === undefined) return false; return bulkPatch(ids, o, { assignee_id: v || null }, 'Responsible changed'); } },
                { label: 'Set deadline', icon: 'calendar', run: async (ids, o) => { const v = await B.pick('Set deadline', { type: 'date', label: 'Deadline' }, today); if (v === undefined) return false; return bulkPatch(ids, o, { due_date: v || null }, 'Deadline set'); } },
                { label: 'Priority', icon: 'star', run: async (ids, o) => { const v = await B.pick('Set priority', { type: 'select', label: 'Priority', required: true, options: Object.entries(L.PRIORITY).map(([value, p]) => ({ value, label: p.label })) }, 'high'); if (!v) return false; return bulkPatch(ids, o, { priority: v }, 'Priority set'); } },
                { label: 'Move to recycle bin', icon: 'trash', danger: true, run: async (ids, o) => { if (!await C.confirm({ title: o.all ? 'Move every task in this filter to the recycle bin?' : `Move ${ids.length} task${ids.length > 1 ? 's' : ''} to the recycle bin?`, message: 'They keep their comments and history and can be restored from the Recycle bin filter.', okText: 'Move', danger: true })) return false; return bulkPatch(ids, o, { archived_at: new Date().toISOString() }, 'Moved to the recycle bin'); } },
            ],
            empty: { title: 'No tasks here', sub: 'Change the role tab or the filter, or create a task.' },
        });
        host.addEventListener('change', async e => {
            const cb = e.target.closest('[data-done]'); if (!cb) return;
            const rows = page.grid.rows(); const t = rows.find(x => x.id === cb.dataset.done); if (!t) return;
            await setDone(t, cb.checked, () => refreshList(true));
        });
    }
    async function bulkPatch(ids, o, patch, msg) {
        let b = sb.from('tasks').update(patch);
        b = o.all ? scoped(b) : b.in('id', ids);
        await mustUpdate(b, o.all ? null : ids.length);
        C.toast(msg, 'ok'); WSShell.refreshUnread();
    }
    async function loadRows(extra) {
        let b = scoped(sb.from('tasks').select(SELECT));
        if (extra) b = extra(b);
        const rows = (await C.q(b.order('due_date', { ascending: true, nullsFirst: false }).limit(600))).data || [];
        await resolveNames(rows);
        return rows;
    }
    function taskCard(t) {
        return `<div class="b24-kcard"><a class="t" href="/tasks/?id=${esc(t.id)}" data-open>${esc(t.title)}</a>${chipText(t) ? `<div class="org">${chipText(t)}</div>` : ''}<div class="meta">${t.assignee_id ? C.avatarHtml(t.assignee_id, 'sm') : ''}${C.dueHtml(t, today)}${t.priority === 'high' || t.priority === 'urgent' ? C.priorityBadge(t.priority) : ''}</div></div>`;
    }

    /* ----- Deadline: Kanban by due period ----- */
    function weekEnd(offsetWeeks) { const dow = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7; return L.addDays(today, 6 - dow + 7 * (offsetWeeks || 0)); }
    const DEADLINES = [
        { id: 'overdue', name: 'Overdue', hex: '#ff5752' }, { id: 'today', name: 'Due today', hex: '#ffa900' }, { id: 'week', name: 'Due this week', hex: '#2fc6f6' },
        { id: 'next', name: 'Due next week', hex: '#39a8ef' }, { id: 'none', name: 'No deadline', hex: '#a8adb4' }, { id: 'later', name: 'Due in over two weeks', hex: '#9b7cf5' },
    ];
    function bucketOf(t) {
        if (!t.due_date) return 'none';
        if (t.due_date < today) return 'overdue';
        if (t.due_date === today) return 'today';
        if (t.due_date <= weekEnd(0)) return 'week';
        if (t.due_date <= weekEnd(1)) return 'next';
        return 'later';
    }
    function dateFor(bucket) { return { today, week: weekEnd(0), next: weekEnd(1), later: L.addDays(weekEnd(1), 7), none: null }[bucket]; }
    function mountDeadline(body) {
        body.innerHTML = '<div class="b24-board-area"><div id="kb"></div></div>';
        page.board = WSKanban.mount(body.querySelector('#kb'), {
            columns: [], cards: [], renderCard: c => taskCard(c.task), emptyText: 'Nothing here',
            canDrag: () => true,
            onCardClick: (c, e) => { if (e) e.preventDefault(); openTask(c.task.id); },
            onMove: async ({ card, toColumnId }) => {
                if (toColumnId === 'overdue') throw new Error('Pick a new deadline instead: drop the task on Today or a later column.');
                if (toColumnId === 'week' && weekEnd(0) === today) throw new Error('This week ends today: drop the task on Due today or Due next week.');
                await mustUpdate(sb.from('tasks').update({ due_date: dateFor(toColumnId) }).eq('id', card.task.id));
                C.toast(toColumnId === 'none' ? 'Deadline removed' : `Deadline: ${L.fmtDate(dateFor(toColumnId))}`, 'ok');
                page.reloadView(); WSShell.refreshUnread();
            },
        });
        page.reloadView = async () => {
            try {
                const rows = await loadRows(b => b.is('completed_at', null));
                page.board.update({ columns: DEADLINES, cards: rows.map((t, i) => ({ id: t.id, columnId: bucketOf(t), position: i, task: t })) });
            } catch (e) { C.errorState(body, e, page.reloadView); }
        };
        page.reloadView();
    }

    /* ----- Planner: my own board (task_planner) ----- */
    const PLANNER = [{ id: 'new', name: 'New tasks', hex: '#2fc6f6' }, { id: 'today', name: 'Do today', hex: '#ffa900' }, { id: 'week', name: 'This week', hex: '#7bd500' }, { id: 'later', name: 'Later', hex: '#9b7cf5' }];
    function mountPlanner(body) {
        body.innerHTML = '<div class="b24-board-area"><div id="kb"></div></div>';
        let plan = new Map();
        page.board = WSKanban.mount(body.querySelector('#kb'), {
            columns: [], cards: [], renderCard: c => taskCard(c.task), emptyText: 'Drop tasks here',
            onCardClick: (c, e) => { if (e) e.preventDefault(); openTask(c.task.id); },
            onMove: async ({ card, toColumnId, position }) => {
                await C.q(sb.from('task_planner').upsert({ user_id: me.id, task_id: card.task.id, stage: toColumnId, position, updated_at: new Date().toISOString() }, { onConflict: 'user_id,task_id' }));
                plan.set(card.task.id, { stage: toColumnId, position });
            },
        });
        page.reloadView = async () => {
            try {
                const p = await sb.from('task_planner').select('task_id, stage, position').eq('user_id', me.id);
                if (p.error) { body.innerHTML = `<div class="b24-area pad"><div class="crm-notice">${C.icon('lock')}<div><b>The planner needs the latest database update.</b><br>An administrator needs to run <code>supabase-b24-migration.sql</code>.</div></div></div>`; return; }
                plan = new Map((p.data || []).map(x => [x.task_id, x]));
                // The planner is personal: open tasks I am responsible for or assisting on.
                const rows = await loadRows(b => b.is('completed_at', null));
                const mineRows = rows.filter(t => t.assignee_id === me.id || roleIds.assisting.includes(t.id) || page.role !== 'ongoing');
                page.board.update({ columns: PLANNER, cards: mineRows.map((t, i) => { const x = plan.get(t.id); return { id: t.id, columnId: x ? x.stage : 'new', position: x ? Number(x.position) : i, task: t }; }) });
            } catch (e) { C.errorState(body, e, page.reloadView); }
        };
        page.reloadView();
    }

    /* ----- Calendar: tasks on their deadlines ----- */
    function mountCalendar(body) {
        if (!page.month) page.month = today.slice(0, 7);
        page.reloadView = async () => {
            const [y, m] = page.month.split('-').map(Number);
            const first = `${page.month}-01`;
            const startDow = (new Date(first + 'T00:00:00Z').getUTCDay() + 6) % 7;
            const gridStart = L.addDays(first, -startDow);
            const days = Array.from({ length: 42 }, (_, i) => L.addDays(gridStart, i));
            body.innerHTML = '<div class="b24-area pad"><div class="ws-empty">Loading…</div></div>';
            try {
                const rows = await loadRows(b => b.gte('due_date', days[0]).lte('due_date', days[41]));
                const byDay = new Map(); rows.forEach(t => { if (!byDay.has(t.due_date)) byDay.set(t.due_date, []); byDay.get(t.due_date).push(t); });
                const label = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
                body.innerHTML = `<div class="b24-area b24-cal">
                    <div class="head"><button type="button" class="ws-btn sm" data-mon="-1" aria-label="Previous month">‹</button><b>${esc(label)}</b><button type="button" class="ws-btn sm" data-mon="1" aria-label="Next month">›</button><button type="button" class="ws-btn sm" data-mon="0">Today</button></div>
                    <div class="grid">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="dow">${d}</div>`).join('')}
                    ${days.map(d => { const list = byDay.get(d) || []; return `<div class="day${d.slice(0, 7) !== page.month ? ' other' : ''}${d === today ? ' today' : ''}"><span class="n">${Number(d.slice(8))}</span>
                        ${list.slice(0, 4).map(t => `<a class="chip ${isDone(t) ? 'done' : L.taskDueState(t, today)}" href="/tasks/?id=${esc(t.id)}" data-open title="${esc(t.title)}">${esc(t.title)}</a>`).join('')}${list.length > 4 ? `<span class="more">+${list.length - 4} more</span>` : ''}</div>`; }).join('')}</div></div>`;
                body.querySelectorAll('[data-mon]').forEach(b => b.addEventListener('click', () => {
                    const k = Number(b.dataset.mon);
                    if (!k) page.month = today.slice(0, 7);
                    else { const d = new Date(Date.UTC(y, m - 1 + k, 1)); page.month = d.toISOString().slice(0, 7); }
                    page.reloadView();
                }));
            } catch (e) { C.errorState(body, e, page.reloadView); }
        };
        page.reloadView();
    }

    /* ----- Gantt: bars from start to deadline; drag to shift ----- */
    function mountGantt(body) {
        const DAY = 30, SPAN = 42;
        if (!page.ganttStart) { const dow = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7; page.ganttStart = L.addDays(today, -dow - 7); }
        page.reloadView = async () => {
            const start = page.ganttStart, end = L.addDays(start, SPAN - 1);
            body.innerHTML = '<div class="b24-area pad"><div class="ws-empty">Loading…</div></div>';
            try {
                const rows = (await loadRows(b => b.or(`due_date.gte.${start},start_date.gte.${start}`))).filter(t => (t.start_date || t.due_date) && (t.start_date || t.due_date) <= end);
                const days = Array.from({ length: SPAN }, (_, i) => L.addDays(start, i));
                const off = d => L.daysBetween(start, d);
                body.innerHTML = `<div class="b24-area b24-gantt">
                    <div class="head"><button type="button" class="ws-btn sm" data-shift="-28">‹ 4 weeks</button><b>${esc(L.fmtDate(start))} – ${esc(L.fmtDate(end))}</b><button type="button" class="ws-btn sm" data-shift="28">4 weeks ›</button><button type="button" class="ws-btn sm" data-shift="0">Today</button><span class="hint">Drag a bar to move its dates.</span></div>
                    <div class="wrap"><div class="chart" style="--day:${DAY}px;--days:${SPAN}">
                        <div class="row axis"><div class="name"></div><div class="lane">${days.map(d => `<span class="d${d === today ? ' today' : ''}${[5, 6].includes((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7) ? ' we' : ''}">${Number(d.slice(8))}${d.slice(8) === '01' || d === start ? `<small>${esc(new Intl.DateTimeFormat('en-IN', { month: 'short', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z')))}</small>` : ''}</span>`).join('')}</div></div>
                        ${rows.map(t => {
                            const s = t.start_date || t.due_date, e = t.due_date || t.start_date;
                            const a = Math.max(0, off(s)), b = Math.min(SPAN - 1, off(e));
                            return `<div class="row"><div class="name"><a href="/tasks/?id=${esc(t.id)}" data-open>${esc(t.title)}</a></div><div class="lane">${b >= 0 && a <= SPAN - 1 ? `<span class="bar ${isDone(t) ? 'done' : L.taskDueState(t, today)}" data-bar="${esc(t.id)}" style="left:${a * DAY}px;width:${(b - a + 1) * DAY - 4}px" title="${esc(t.title)} · ${esc(L.fmtDate(s))} – ${esc(L.fmtDate(e))}"></span>` : ''}</div></div>`;
                        }).join('') || '<div class="ws-empty">No tasks with dates in these weeks.</div>'}
                        <span class="now" style="left:calc(var(--name-w) + ${off(today) * DAY + DAY / 2}px)"></span>
                    </div></div></div>`;
                body.querySelectorAll('[data-shift]').forEach(b => b.addEventListener('click', () => {
                    const k = Number(b.dataset.shift);
                    if (!k) { const dow = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7; page.ganttStart = L.addDays(today, -dow - 7); } else page.ganttStart = L.addDays(page.ganttStart, k);
                    page.reloadView();
                }));
                body.querySelectorAll('[data-bar]').forEach(bar => bar.addEventListener('pointerdown', ev => {
                    const t = rows.find(x => x.id === bar.dataset.bar); if (!t) return;
                    ev.preventDefault(); bar.setPointerCapture(ev.pointerId);
                    const x0 = ev.clientX, left0 = parseFloat(bar.style.left);
                    let delta = 0;
                    const move = e2 => { delta = Math.round((e2.clientX - x0) / DAY); bar.style.left = (left0 + delta * DAY) + 'px'; };
                    const cancel = () => { bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); bar.removeEventListener('pointercancel', cancel); bar.style.left = left0 + 'px'; };
                    const up = async () => {
                        bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); bar.removeEventListener('pointercancel', cancel);
                        if (!delta) return openTask(t.id);
                        const patch = {}; if (t.start_date) patch.start_date = L.addDays(t.start_date, delta); if (t.due_date) patch.due_date = L.addDays(t.due_date, delta);
                        try { await mustUpdate(sb.from('tasks').update(patch).eq('id', t.id)); C.toast(`Moved ${delta > 0 ? '+' : ''}${delta} day${Math.abs(delta) === 1 ? '' : 's'}`, 'ok'); }
                        catch (err) { C.toast(err.message, 'bad'); }
                        page.reloadView();
                    };
                    bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', up); bar.addEventListener('pointercancel', cancel);
                }));
            } catch (e) { C.errorState(body, e, page.reloadView); }
        };
        page.reloadView();
    }

    /* ----- Kanban by status ----- */
    function mountStatusBoard(body) {
        body.innerHTML = '<div class="b24-board-area"><div id="kb"></div></div>';
        page.board = WSKanban.mount(body.querySelector('#kb'), {
            columns: [], cards: [], renderCard: c => taskCard(c.task), emptyText: 'No tasks',
            onCardClick: (c, e) => { if (e) e.preventDefault(); openTask(c.task.id); },
            onAddCard: colId => C.openTaskEditor({ defaults: { assignee_id: me.id, status: colId }, onSaved: async s => { if (s && s.status !== colId) await sb.from('tasks').update({ status: colId }).eq('id', s.id); page.reloadView(); } }),
            onMove: async ({ card, toColumnId, position }) => { await mustUpdate(sb.from('tasks').update({ status: toColumnId, position }).eq('id', card.task.id)); WSShell.refreshUnread(); page.reloadView(); },
        });
        page.reloadView = async () => {
            try {
                const rows = await loadRows();
                page.board.update({ columns: lk.taskStatuses.map((s, i) => ({ id: s.key, name: s.label, hex: B.hex(s.color, i) })), cards: rows.map(t => ({ id: t.id, columnId: t.status, position: Number(t.position) || 0, task: t })) });
            } catch (e) { C.errorState(body, e, page.reloadView); }
        };
        page.reloadView();
    }
    view.addEventListener('click', e => {
        const a = e.target.closest('a[data-open]');
        if (!a || e.metaKey || e.ctrlKey || e.shiftKey || page.mode !== 'list') return;
        e.preventDefault();
        const id = new URL(a.href, location.href).searchParams.get('id');
        if (id) openTask(id);
    });

    /* ----- Templates ----- */
    async function pickTemplate() {
        const r = await sb.from('task_templates').select('*').order('title');
        if (r.error) return C.toast(C.friendly(r.error), 'bad');
        const list = r.data || [];
        if (!list.length) return C.alert({ title: 'No templates yet', message: 'Save a task as a template from its card, or add one under Task templates.' });
        const v = await B.pick('Create from a template', { type: 'select', label: 'Template', required: true, options: list.map(x => ({ value: x.id, label: x.title })) }, list[0].id);
        if (!v) return;
        const tpl = list.find(x => x.id === v);
        await C.openTaskEditor({
            defaults: { title: tpl.title, description: tpl.description, priority: tpl.priority, assignee_id: tpl.assignee_id || me.id, estimate_hours: tpl.estimate_hours, tags: tpl.tags || [], due_date: tpl.deadline_days != null ? L.addDays(today, tpl.deadline_days) : null },
            onSaved: async t => {
                const items = Array.isArray(tpl.checklist) ? tpl.checklist.map(x => (typeof x === 'string' ? x : x.title)).filter(Boolean) : [];
                if (t && t.id && items.length) await sb.from('tasks').insert(items.map(title => ({ title, parent_task_id: t.id, assignee_id: t.assignee_id, project_id: t.project_id, status: OPEN_KEY, created_by: me.id })));
                refreshList(); if (t && t.id) openTask(t.id);
            },
        });
    }
    function templateFields() {
        return [
            { name: 'title', label: 'Task name', type: 'text', required: true, full: true },
            { name: 'description', label: 'Description', type: 'textarea', full: true },
            { name: 'assignee_id', label: 'Responsible', type: 'people', none: 'Whoever creates it' },
            { name: 'priority', label: 'Priority', type: 'select', options: Object.entries(L.PRIORITY).map(([value, p]) => ({ value, label: p.label })) },
            { name: 'deadline_days', label: 'Deadline, days after creation', type: 'number', min: 0 },
            { name: 'estimate_hours', label: 'Estimate, hours', type: 'number', step: '0.25', min: 0 },
            { name: 'checklist', label: 'Checklist (one item per line, becomes subtasks)', type: 'textarea', full: true, rows: 4 },
            { name: 'tags', label: 'Tags', type: 'tags', full: true },
        ];
    }
    async function saveTemplate(values, id) {
        const row = { title: values.title.trim(), description: values.description || null, assignee_id: values.assignee_id || null, priority: values.priority || 'normal',
            deadline_days: values.deadline_days == null || values.deadline_days === '' ? null : Number(values.deadline_days), estimate_hours: values.estimate_hours == null || values.estimate_hours === '' ? null : Number(values.estimate_hours),
            checklist: String(values.checklist || '').split('\n').map(s => s.trim()).filter(Boolean), tags: values.tags || [] };
        if (id) await C.q(sb.from('task_templates').update(row).eq('id', id)); else await C.q(sb.from('task_templates').insert({ ...row, created_by: me.id }));
    }
    async function manageTemplates() {
        const body = document.createElement('div');
        const m = C.modal({ title: 'Task templates', size: 'wide', body, actions: [{ label: 'New template', onClick: () => edit(null) }, { label: 'Done', primary: true, close: true }] });
        async function render() {
            const r = await sb.from('task_templates').select('*').order('title');
            const list = r.data || [];
            body.innerHTML = list.length ? `<ul class="crm-list">${list.map(x => `<li><div class="main"><b>${esc(x.title)}</b><span>${esc([x.deadline_days != null ? `deadline in ${x.deadline_days} day${x.deadline_days === 1 ? '' : 's'}` : 'no deadline', (x.checklist || []).length ? `${x.checklist.length} checklist item${x.checklist.length === 1 ? '' : 's'}` : '', x.assignee_id ? C.personName(x.assignee_id) : ''].filter(Boolean).join(' · '))}</span></div><div class="right"><button type="button" class="ws-btn sm" data-edit="${esc(x.id)}">Edit</button> <button type="button" class="ws-btn sm danger" data-del="${esc(x.id)}">Delete</button></div></li>`).join('')}</ul>`
                : '<div class="ws-empty"><b>No templates yet</b>Templates pre-fill recurring tasks, checklists included.</div>';
            body.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => edit(list.find(x => x.id === b.dataset.edit))));
            body.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => { if (!await C.confirm({ title: 'Delete this template?', okText: 'Delete', danger: true })) return; try { await C.q(sb.from('task_templates').delete().eq('id', b.dataset.del)); render(); } catch (e) { C.toast(e.message, 'bad'); } }));
        }
        async function edit(x) {
            await C.formModal({ title: x ? 'Edit template' : 'New template', size: 'wide', fields: templateFields(), values: x ? { ...x, checklist: (x.checklist || []).join('\n') } : { priority: 'normal' }, submitLabel: 'Save', onSubmit: async v => { await saveTemplate(v, x && x.id); render(); } });
        }
        render();
        return m;
    }
    async function saveAsTemplate(t, subtasks) {
        await C.formModal({ title: 'Save as a template', size: 'wide', fields: templateFields(), submitLabel: 'Save template',
            values: { title: t.title, description: t.description, assignee_id: t.assignee_id, priority: t.priority, estimate_hours: t.estimate_hours, tags: t.tags || [],
                deadline_days: t.due_date ? Math.max(0, L.daysBetween(L.istDate(t.created_at), t.due_date)) : null, checklist: (subtasks || []).map(s => s.title).join('\n') },
            onSubmit: async v => { await saveTemplate(v, null); C.toast('Template saved', 'ok'); } });
    }

    /* ---------------------------------------------- new task (Bitrix24-style create page) */
    async function showCreate() {
        recordSeq++;
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        page.mode = 'create';
        if (page.grid) { page.grid.destroy(); page.grid = null; }
        if (page.board) { page.board.destroy(); page.board = null; }
        page.reloadView = null;
        document.title = 'New task · WorkSuite';
        WSShell.setCrumb('New task');
        const p = k => C.param(k) || null;
        // Optional parts, revealed by the chips under the form (as in Bitrix24).
        const CHIPS = [['assignees', 'Participants', ['assignees']], ['watchers', 'Observers', ['watchers']], ['project', 'Project', ['project_id']], ['tags', 'Tags', ['tags']],
            ['reminder', 'Reminder', ['reminder']], ['crm', 'CRM items', ['contact_id', 'deal_id']], ['parent', 'Parent task', ['parent_task_id']],
            ['planning', 'Time planning', ['start_date', 'estimate_hours']], ['priority', 'Priority', ['priority']], ['status', 'Status', ['status']]];
        const fields = [
            { name: 'assignee_id', label: 'Assignee', type: 'people', none: 'Not assigned' },
            { name: 'due_date', label: 'Deadline', type: 'date' },
            { name: 'due_time', label: 'Time', type: 'time' },
            { name: 'assignees', label: 'Participants (also assigned)', type: 'peoples', full: true },
            { name: 'watchers', label: 'Observers', type: 'peoples', full: true },
            { name: 'project_id', label: 'Project', type: 'entity', entity: 'project', placeholder: 'Search projects', full: true },
            { name: 'tags', label: 'Tags', type: 'tags', full: true },
            { name: 'reminder', label: 'Remind me in the app a day before the deadline', type: 'check', full: true },
            { name: 'contact_id', label: 'Contact', type: 'entity', entity: 'contact', placeholder: 'Search contacts' },
            { name: 'deal_id', label: 'Deal', type: 'entity', entity: 'deal', placeholder: 'Search deals' },
            { name: 'parent_task_id', label: 'Parent task', type: 'entity', entity: 'task', placeholder: 'Search tasks', full: true },
            { name: 'start_date', label: 'Start date', type: 'date' },
            { name: 'estimate_hours', label: 'Estimate (hours)', type: 'number', min: 0, step: 0.5 },
            { name: 'priority', label: 'Priority', type: 'select', required: true, options: Object.entries(L.PRIORITY).map(([value, x]) => ({ value, label: x.label })) },
            { name: 'status', label: 'Status', type: 'select', required: true, options: lk.taskStatuses.map(s => ({ value: s.key, label: s.label })) },
        ];
        const defaults = { assignee_id: p('assignee_id') || me.id, due_date: p('due_date'), project_id: p('project_id'), contact_id: p('contact_id'), deal_id: p('deal_id'), parent_task_id: p('parent_task_id'), priority: 'normal', status: OPEN_KEY, assignees: [], watchers: [], reminder: false };
        view.innerHTML = `
            <div class="b24-tnew">
                <div class="b24-tnew-cols">
                    <div class="b24-tnew-form">
                        <div class="b24-tnew-card">
                            <div class="b24-tnew-title" data-title></div>
                            <div class="b24-tnew-desc" data-desc></div>
                            <div class="b24-tnew-tools"><button type="button" data-add-check>+ Checklist</button></div>
                            <div class="b24-tnew-check" data-check></div>
                        </div>
                        <div class="b24-tnew-card b24-tnew-people">
                            <div class="who"><span class="l">Task owner</span>${C.personHtml(me.id, { link: false })}</div>
                            <div data-fields></div>
                        </div>
                        <div class="b24-tnew-chips" data-chips role="group" aria-label="Add to the task">${CHIPS.map(([k, label]) => `<button type="button" data-chip="${k}" aria-pressed="false">+ ${esc(label)}</button>`).join('')}</div>
                    </div>
                    <aside class="b24-tnew-chat" aria-label="Task chat"><div class="info"><b>Task chat</b>Once the task is created, everyone on it works together here:<ul><li>discuss progress and results</li><li>attach documents and files</li><li>follow every change to the task</li></ul></div></aside>
                </div>
                <div class="b24-new-foot">
                    <button type="button" class="b24-btn-create" data-save>Create</button>
                    <button type="button" class="b24-new-cancel" data-cancel>Cancel</button>
                    ${hasTemplates ? '<button type="button" class="b24-new-cancel" data-templates>Templates ▾</button>' : ''}
                    <span class="b24-new-err" data-err role="alert" hidden></span>
                </div>
            </div>`;
        const titleForm = C.form([{ name: 'title', label: 'Task name', type: 'text', required: true, placeholder: 'Task name' }], { title: p('title') || '' });
        const descForm = C.form([{ name: 'description', label: 'Description', type: 'textarea', rows: 4, placeholder: 'Description' }], {});
        const mainForm = C.form(fields, defaults);
        view.querySelector('[data-title]').appendChild(titleForm.el);
        view.querySelector('[data-desc]').appendChild(descForm.el);
        view.querySelector('[data-fields]').appendChild(mainForm.el);
        const chipEl = k => view.querySelector(`[data-chip="${k}"]`);
        function showChip(k, on) {
            const chip = CHIPS.find(c => c[0] === k); if (!chip) return;
            chip[2].forEach(n => { const w = mainForm.field(n); if (w) w.wrap.hidden = !on; });
            chipEl(k).classList.toggle('on', on); chipEl(k).setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        CHIPS.forEach(([k, , names]) => showChip(k, names.some(n => { const d = defaults[n]; return d != null && d !== '' && !(Array.isArray(d) && !d.length) && !['priority', 'status', 'reminder'].includes(n); })));
        view.querySelector('[data-chips]').addEventListener('click', e => {
            const b = e.target.closest('[data-chip]'); if (!b) return;
            const on = !b.classList.contains('on'); showChip(b.dataset.chip, on);
            if (on) { const chip = CHIPS.find(c => c[0] === b.dataset.chip); const w = mainForm.field(chip[2][0]); const f = w && w.wrap.querySelector('input, select, textarea'); if (f) f.focus(); }
        });
        const checkEl = view.querySelector('[data-check]');
        function addItem(text) {
            const row = document.createElement('div'); row.className = 'item';
            row.innerHTML = '<input type="checkbox" disabled aria-hidden="true"><input type="text" placeholder="Checklist item" aria-label="Checklist item"><button type="button" aria-label="Remove item">×</button>';
            row.querySelector('input[type=text]').value = text || '';
            row.querySelector('button').addEventListener('click', () => row.remove());
            row.querySelector('input[type=text]').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addItem('').querySelector('input[type=text]').focus(); } });
            checkEl.appendChild(row);
            return row;
        }
        view.querySelector('[data-add-check]').addEventListener('click', () => addItem('').querySelector('input[type=text]').focus());
        const tb = view.querySelector('[data-templates]');
        if (tb) tb.addEventListener('click', async () => {
            const r = await sb.from('task_templates').select('*').order('title');
            const list = r.error ? [] : (r.data || []);
            if (!list.length) return C.toast('No templates yet. Save a task as a template from its card.', 'ok');
            C.menu(tb, list.map(tpl => ({ label: tpl.title, onClick: () => {
                titleForm.set({ title: tpl.title }); descForm.set({ description: tpl.description || '' });
                mainForm.set({ assignee_id: tpl.assignee_id || me.id, priority: tpl.priority || 'normal', estimate_hours: tpl.estimate_hours, tags: tpl.tags || [], due_date: tpl.deadline_days != null ? L.addDays(today, tpl.deadline_days) : null });
                if (tpl.priority && tpl.priority !== 'normal') showChip('priority', true);
                if ((tpl.tags || []).length) showChip('tags', true);
                if (tpl.estimate_hours) showChip('planning', true);
                checkEl.innerHTML = '';
                (Array.isArray(tpl.checklist) ? tpl.checklist : []).map(x => (typeof x === 'string' ? x : x.title)).filter(Boolean).forEach(addItem);
            } })));
        });
        const errEl = view.querySelector('[data-err]'), btn = view.querySelector('[data-save]');
        async function save() {
            errEl.hidden = true;
            if (![titleForm.validate(), mainForm.validate()].every(Boolean)) { errEl.textContent = 'Fill in the fields marked in red.'; errEl.hidden = false; return; }
            const v = { ...titleForm.get(), ...descForm.get(), ...mainForm.get() };
            if (v.due_date && v.start_date && L.dayNumber(v.due_date) < L.dayNumber(v.start_date)) { errEl.textContent = 'The deadline is before the start date.'; errEl.hidden = false; return; }
            const row = {
                title: v.title.trim(), description: v.description || null, status: v.status || OPEN_KEY, priority: v.priority || 'normal',
                assignee_id: v.assignee_id || null, start_date: v.start_date || null, due_date: v.due_date || null, due_time: v.due_time || null,
                estimate_hours: v.estimate_hours, tags: v.tags || [], reminder_at: v.reminder && v.due_date ? L.isoAtIST(L.addDays(v.due_date, -1), '09:00') : null,
                project_id: v.project_id || null, contact_id: v.contact_id || null, deal_id: v.deal_id || null, parent_task_id: v.parent_task_id || null, created_by: me.id,
            };
            if (p('lead_id')) row.lead_id = p('lead_id');
            btn.disabled = true; btn.textContent = 'Creating…';
            try {
                const saved = (await C.q(sb.from('tasks').insert(row).select('id, title, assignee_id, project_id').single())).data;
                // The task exists now: problems with the extras are reported without losing it.
                try {
                    const extra = [...new Set(v.assignees || [])].filter(id => id && id !== saved.assignee_id);
                    if (extra.length) await C.q(sb.from('task_assignees').insert(extra.map(id => ({ task_id: saved.id, user_id: id, added_by: me.id }))));
                    const obs = [...new Set(v.watchers || [])].filter(Boolean);
                    if (obs.length) await C.q(sb.from('task_watchers').insert(obs.map(id => ({ task_id: saved.id, user_id: id }))));
                    const items = [...checkEl.querySelectorAll('input[type=text]')].map(i => i.value.trim()).filter(Boolean);
                    if (items.length) await C.q(sb.from('tasks').insert(items.map(title => ({ title, parent_task_id: saved.id, assignee_id: saved.assignee_id, project_id: saved.project_id, status: OPEN_KEY, created_by: me.id }))));
                    [saved.assignee_id, ...extra].filter(id => id && id !== me.id).forEach(id => C.pushNotify({ to: id, title: 'Task assigned to you', body: saved.title, url: `/tasks/?id=${saved.id}`, tag: 'task' }));
                    obs.filter(id => id !== me.id).forEach(id => C.pushNotify({ to: id, title: 'You are now watching a task', body: saved.title, url: `/tasks/?id=${saved.id}`, tag: 'task' }));
                } catch (e) { C.toast(`Task created, but some details could not be saved: ${e.message}`, 'bad'); }
                C.toast('Task created', 'ok');
                B.afterCreate('/tasks/', saved.id);
            } catch (e) { errEl.textContent = e.message; errEl.hidden = false; btn.disabled = false; btn.textContent = 'Create'; }
        }
        btn.addEventListener('click', save);
        view.querySelector('[data-cancel]').addEventListener('click', () => B.leaveCreate('/tasks/'));
        view.querySelector('.b24-tnew').addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); } });
        titleForm.field('title').el.focus();
    }

    /* ------------------------------------------------------------- record */
    async function showRecord(id) {
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        page.mode = 'record';
        if (page.grid) { page.grid.destroy(); page.grid = null; }
        if (page.board) { page.board.destroy(); page.board = null; }
        page.reloadView = null;
        C.loading(view, 'Loading task…');
        const mySeq = recordSeq;
        let t;
        try { t = (await C.q(sb.from('tasks').select(SELECT).eq('id', id).maybeSingle())).data; }
        catch (e) { return C.errorState(view, e, () => showRecord(id)); }
        if (mySeq !== recordSeq) return;                     // navigated away while it loaded
        if (!t) { view.innerHTML = `<a class="crm-back" href="/tasks/">${C.icon('arrow')}All tasks</a>`; C.empty(view.appendChild(document.createElement('div')), 'Task not found', 'It may have been deleted, or you may not have access to it.'); return; }
        document.title = `${t.title} · Tasks · WorkSuite`;
        sb.from('task_views').upsert({ user_id: me.id, task_id: id, viewed_at: new Date().toISOString() }, { onConflict: 'user_id,task_id' }).then(() => {}, () => {});
        WSShell.setCrumb(t.title);
        const [assignees, watchers, subtasks, parent, board, column] = await Promise.all([
            loadAssignees(id),
            sb.from('task_watchers').select('user_id').eq('task_id', id).then(r => (r.data || []).map(x => x.user_id)),
            C.related('tasks', 'parent_task_id', id, SELECT, b => b.is('archived_at', null).order('created_at', { ascending: true })),
            t.parent_task_id ? sb.from('tasks').select('id, title').eq('id', t.parent_task_id).maybeSingle().then(r => r.data) : null,
            t.board_id ? sb.from('boards').select('id, name').eq('id', t.board_id).maybeSingle().then(r => r.data) : null,
            t.board_column_id ? sb.from('board_columns').select('id, name').eq('id', t.board_column_id).maybeSingle().then(r => r.data) : null,
        ]);
        await resolveNames([t]);
        const canEdit = L.canEdit({ created_by: t.created_by, assignee_id: t.assignee_id, assignee_ids: assignees }, me) || (t.project_id && await onProject(t.project_id));
        if (mySeq !== recordSeq) return;
        const canDelete = L.canDelete(t, me);
        const watching = watchers.includes(me.id);
        const done = isDone(t);
        const linked = [t.project_id && ['project', t.project_id, names.project[t.project_id]], t.contact_id && ['contact', t.contact_id, names.contact[t.contact_id]], t.deal_id && ['deal', t.deal_id, names.deal[t.deal_id]], t.lead_id && ['lead', t.lead_id, names.lead[t.lead_id]]].filter(Boolean);

        view.innerHTML = `
            <div class="b24-card-head">
                <h1 class="b24-card-title"><span class="t" style="${done ? 'text-decoration:line-through;opacity:.7' : ''}">${esc(t.title)}</span>${cols.full && t.number != null ? `<span class="num">#${esc(t.number)}</span>` : ''}</h1>
                <div class="sub">${parent ? `Subtask of <a href="/tasks/?id=${esc(parent.id)}" style="color:inherit">${esc(parent.title)}</a> · ` : ''}${C.statusBadge(STATUS, t.status)} ${C.priorityBadge(t.priority)} ${t.due_date ? C.dueHtml(t, today) : ''} ${linked.map(([k, i, n]) => C.entityChip(k, i, n)).join(' ')}</div>
                <div class="acts">
                    ${WSShell.inSlider ? '' : `<a class="b24-btn-card" href="/tasks/" data-nav>${C.icon('arrow')}<span>All tasks</span></a>`}
                    ${canEdit ? `<button type="button" class="${done ? 'b24-btn-card' : 'b24-btn-create'}" id="done-btn">${done ? `${C.icon('refresh')}<span>Resume</span>` : 'Complete'}</button>` : ''}
                    ${canEdit ? `<button type="button" class="b24-btn-card" id="edit-btn">${C.icon('edit')}<span>Edit</span></button>` : ''}
                    <button type="button" class="b24-btn-card" id="watch-btn" aria-pressed="${watching}">${C.icon(watching ? 'bell' : 'star')}<span>${watching ? 'Following' : 'Follow'}</span></button>
                    <button type="button" class="b24-btn-card round" id="more-btn" aria-label="More actions">${C.icon('more')}</button>
                </div>
            </div>
            <div class="crm-detail">
                <div class="ws-stack">
                    ${t.description ? `<div class="ws-card"><div class="crm-section-title"><h3>Description</h3></div><div class="crm-desc">${C.linkify(C.nl2br(t.description))}</div></div>` : ''}
                    <div class="ws-card">
                        <div class="crm-section-title"><h3>Subtasks</h3><span class="muted" style="font-size:13px">${subtasks.filter(isDone).length}/${subtasks.length} done</span></div>
                        ${subtasks.length ? `<div class="ws-bar" style="margin-bottom:12px"><i style="width:${L.projectProgress(subtasks).pct}%"></i></div>` : ''}
                        <ul class="crm-subtasks" id="subtasks">${subtasks.map(s => `<li class="${isDone(s) ? 'done' : ''}" data-sub="${esc(s.id)}"><input type="checkbox" ${isDone(s) ? 'checked' : ''} aria-label="Complete subtask" ${canEdit ? '' : 'disabled'}><span><a class="crm-link" href="/tasks/?id=${esc(s.id)}" style="color:inherit">${esc(s.title)}</a>${s.assignee_id ? ` <span class="muted" style="font-size:12px">· ${esc(C.personName(s.assignee_id))}</span>` : ''}${s.due_date ? ` ${C.dueHtml(s, today)}` : ''}</span>${canEdit ? `<button type="button" data-rm aria-label="Remove subtask">${C.icon('x', 'sm')}</button>` : ''}</li>`).join('')}</ul>
                        ${canEdit ? `<form id="sub-form" style="display:flex;gap:8px;margin-top:10px"><input type="text" id="sub-title" placeholder="Add a subtask and press Enter" aria-label="New subtask" style="flex:1;min-height:38px;padding:7px 11px;border:1px solid var(--ws-border-2);border-radius:6px;background:var(--ws-surface);color:var(--ws-text);font:inherit"><button type="submit" class="ws-btn sm">${C.icon('plus')}<span>Add</span></button></form>` : ''}
                    </div>
                    <div class="ws-card">
                        <div class="crm-section-title"><h3>Attachments</h3></div>
                        <div id="documents"></div>
                    </div>
                    <div class="ws-card">
                        <div class="crm-section-title"><h3>Comments &amp; history</h3></div>
                        <div id="composer"></div>
                        <div id="activity"></div>
                    </div>
                </div>
                <div class="ws-stack">
                    <div class="ws-card">
                        <div class="crm-section-title"><h3>Details</h3></div>
                        <dl class="crm-props one">
                            <div><dt>Status</dt><dd>${C.statusBadge(STATUS, t.status)}</dd></div>
                            <div><dt>Priority</dt><dd>${C.priorityBadge(t.priority)}</dd></div>
                            <div><dt>Assignee</dt><dd>${C.personHtml(t.assignee_id)}</dd></div>
                            ${assignees.length ? `<div><dt>Also assigned</dt><dd>${assignees.map(a => C.personHtml(a)).join('<br>')}</dd></div>` : ''}
                            <div><dt>Start</dt><dd>${esc(L.fmtDate(t.start_date) || '—')}</dd></div>
                            <div><dt>Due</dt><dd>${t.due_date ? esc(L.fmtDate(t.due_date)) + (t.due_time ? ' · ' + esc(String(t.due_time).slice(0, 5)) : '') : '—'}</dd></div>
                            <div><dt>Estimate</dt><dd>${t.estimate_hours != null ? esc(t.estimate_hours + ' h') : '—'}</dd></div>
                            <div><dt>Reminder</dt><dd>${t.reminder_at ? esc(L.fmtDateTime(t.reminder_at)) : '—'}</dd></div>
                            ${done ? `<div><dt>Completed</dt><dd>${esc(L.fmtDateTime(t.completed_at))}</dd></div>` : ''}
                            ${board ? `<div><dt>Board</dt><dd><a class="crm-link" href="/boards/?id=${esc(board.id)}">${esc(board.name)}</a>${column ? ` · ${esc(column.name)}` : ''}</dd></div>` : ''}
                            <div><dt>Tags</dt><dd>${C.tagsHtml(t.tags) || '—'}</dd></div>
                            <div><dt>Created</dt><dd>${esc(L.fmtDateTime(t.created_at))} by ${esc(C.personName(t.created_by))}</dd></div>
                            <div><dt>Updated</dt><dd>${esc(L.fmtDateTime(t.updated_at))}</dd></div>
                            ${t.archived_at ? `<div><dt>Archived</dt><dd>${esc(L.fmtDateTime(t.archived_at))}</dd></div>` : ''}
                        </dl>
                    </div>
                    <div class="ws-card">
                        <div class="crm-section-title"><h3>Watchers</h3></div>
                        <div id="watchers"></div>
                    </div>
                    ${linked.length ? `<div class="ws-card"><div class="crm-section-title"><h3>Linked to</h3></div><ul class="crm-list compact">${linked.map(([k, i, n]) => `<li>${C.icon(C.ENTITY_META[k].icon)}<div class="main"><b><a href="${esc(C.entityUrl(k, i))}">${esc(n || C.ENTITY_META[k].label)}</a></b><span>${esc(C.ENTITY_META[k].label)}</span></div></li>`).join('')}</ul></div>` : ''}
                </div>
            </div>`;
        const navBtn = view.querySelector('[data-nav]');
        if (navBtn) navBtn.addEventListener('click', e => { e.preventDefault(); history.pushState(null, '', '/tasks/'); showList(); });
        const reloadRecord = () => showRecord(id);
        on('#done-btn', () => setDone(t, !done, reloadRecord));
        on('#edit-btn', () => C.openTaskEditor({ task: t, assignees, onSaved: reloadRecord }));
        on('#watch-btn', async () => {
            try {
                if (watching) await C.q(sb.from('task_watchers').delete().eq('task_id', id).eq('user_id', me.id));
                else await C.q(sb.from('task_watchers').insert({ task_id: id, user_id: me.id }));
                C.toast(watching ? 'Stopped watching' : 'Watching this task', 'ok'); reloadRecord();
            } catch (e) { C.toast(e.message, 'bad'); }
        });
        on('#more-btn', e => {
            const items = [
                { label: 'Copy', icon: 'plus', onClick: () => duplicateTask(t) },
                ...(hasTemplates ? [{ label: 'Save as a template', icon: 'star', onClick: () => saveAsTemplate(t, subtasks) }] : []),
                ...(t.assignee_id !== me.id ? [{ label: 'Assign to me', icon: 'user', onClick: () => assignToMe(t, reloadRecord) }] : []),
                { label: 'Open on calendar', icon: 'calendar', href: t.due_date ? `/calendar/?date=${t.due_date}` : '/calendar/' },
                'sep',
            ];
            if (canEdit) items.push(t.archived_at ? { label: 'Restore', icon: 'refresh', onClick: () => setArchived(t, false, reloadRecord) } : { label: 'Archive', icon: 'trash', danger: true, onClick: () => setArchived(t, true, reloadRecord) });
            if (canDelete) items.push({ label: 'Delete permanently', icon: 'trash', danger: true, onClick: () => deleteTask(t) });
            C.menu(e.currentTarget, items);
        });
        // Subtasks
        const subEl = view.querySelector('#subtasks');
        subEl.addEventListener('change', async e => {
            const li = e.target.closest('[data-sub]'); if (!li || e.target.type !== 'checkbox') return;
            const s = subtasks.find(x => x.id === li.dataset.sub); if (!s) return;
            await setDone(s, e.target.checked, reloadRecord);
        });
        subEl.addEventListener('click', async e => {
            const rm = e.target.closest('[data-rm]'); if (!rm) return;
            const li = rm.closest('[data-sub]'); const s = subtasks.find(x => x.id === li.dataset.sub); if (!s) return;
            if (!await C.confirm({ title: `Remove "${s.title}"?`, message: 'The subtask is archived and can be restored from the Tasks list.', okText: 'Remove', danger: true })) return;
            try { await C.q(sb.from('tasks').update({ archived_at: new Date().toISOString() }).eq('id', s.id)); reloadRecord(); } catch (err) { C.toast(err.message, 'bad'); }
        });
        const subForm = view.querySelector('#sub-form');
        if (subForm) subForm.addEventListener('submit', async e => {
            e.preventDefault();
            const input = subForm.querySelector('#sub-title'); const title = input.value.trim(); if (!title) return;
            input.disabled = true;
            try {
                await C.q(sb.from('tasks').insert({ title, parent_task_id: id, project_id: t.project_id, contact_id: t.contact_id, deal_id: t.deal_id, lead_id: t.lead_id, assignee_id: t.assignee_id, priority: t.priority, status: OPEN_KEY, created_by: me.id }));
                reloadRecord();
            } catch (err) { C.toast(err.message, 'bad'); input.disabled = false; }
        });
        // Watchers
        function renderWatchers() {
            const el = view.querySelector('#watchers');
            el.innerHTML = `${watchers.length ? `<ul class="crm-list compact">${watchers.map(w => `<li>${C.personHtml(w)}<div class="right">${(w === me.id || canEdit) ? `<button type="button" class="ws-btn sm icon" data-unwatch="${esc(w)}" aria-label="Remove watcher">${C.icon('x', 'sm')}</button>` : ''}</div></li>`).join('')}</ul>` : '<div class="muted" style="font-size:13px">Nobody is watching yet.</div>'}
                ${canEdit ? `<select id="add-watcher" aria-label="Add watcher" style="margin-top:10px;width:100%"><option value="">+ Add a watcher…</option>${C.peopleOptions('', { none: null, people: C.activePeople().filter(p => !watchers.includes(p.id)) })}</select>` : ''}`;
            const add = el.querySelector('#add-watcher');
            if (add) add.addEventListener('change', async e => { if (!e.target.value) return; try { await C.q(sb.from('task_watchers').insert({ task_id: id, user_id: e.target.value })); C.pushNotify({ to: e.target.value, title: 'You are now watching a task', body: t.title, url: `/tasks/?id=${id}`, tag: 'task' }); reloadRecord(); } catch (err) { C.toast(err.message, 'bad'); } });
            el.querySelectorAll('[data-unwatch]').forEach(b => b.addEventListener('click', async () => { try { await C.q(sb.from('task_watchers').delete().eq('task_id', id).eq('user_id', b.dataset.unwatch)); reloadRecord(); } catch (err) { C.toast(err.message, 'bad'); } }));
        }
        renderWatchers();
        C.documents(view.querySelector('#documents'), { entity_type: 'task', entity_id: id, canEdit: true });
        const feed = C.activityFeed(view.querySelector('#activity'), { entity_type: 'task', entity_id: id, limit: 100 });
        C.comments(view.querySelector('#composer'), { entity_type: 'task', entity_id: id, onPosted: () => feed.reload() });
        // Someone else edits the task: refresh (a bit later so their save has landed).
        unsubscribe = C.subscribe('task', { event: 'UPDATE', table: 'tasks', filter: `id=eq.${id}` }, C.debounce(() => { if (!document.querySelector('.crm-modal')) showRecord(id); }, 600));
    }
    async function onProject(projectId) {
        const r = await sb.from('project_members').select('user_id').eq('project_id', projectId).eq('user_id', me.id).maybeSingle();
        if (r.data) return true;
        const p = await sb.from('projects').select('owner_id, manager_id').eq('id', projectId).maybeSingle();
        return !!(p.data && (p.data.owner_id === me.id || p.data.manager_id === me.id));
    }

    route();
})();
