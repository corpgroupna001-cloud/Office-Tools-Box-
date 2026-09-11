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
    const C = window.WSCrm, L = C.L, esc = C.esc, h = C.h;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'tasks', crumb: 'Tasks' });
    const sb = ctx.sb, me = ctx.user;
    const lk = await C.lookups();
    const STATUS = lk.taskStatus;
    const DONE_KEY = (lk.taskStatuses.find(s => s.is_done) || { key: 'completed' }).key;
    const OPEN_KEY = (lk.taskStatuses.find(s => !s.is_done) || { key: 'todo' }).key;
    const SELECT = 'id, company, title, description, status, priority, assignee_id, project_id, board_id, board_column_id, position, parent_task_id, contact_id, lead_id, deal_id, start_date, due_date, due_time, reminder_at, completed_at, estimate_hours, tags, archived_at, created_by, created_at, updated_at';
    const VIEWS = [
        { key: 'mine', label: 'My Tasks' }, { key: 'all', label: 'All Tasks' }, { key: 'created', label: 'Created by Me' },
        { key: 'overdue', label: 'Overdue' }, { key: 'today', label: 'Due Today' }, { key: 'completed', label: 'Completed' },
    ];
    let unsubscribe = null;

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
    async function setDone(t, done, after) {
        try {
            await C.q(sb.from('tasks').update({ status: done ? DONE_KEY : OPEN_KEY }).eq('id', t.id));
            C.toast(done ? 'Task completed' : 'Task reopened', 'ok');
            WSShell.refreshUnread();
            if (after) after();
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function assignToMe(t, after) {
        try {
            await C.q(sb.from('tasks').update({ assignee_id: me.id }).eq('id', t.id));
            C.toast('Assigned to you', 'ok'); WSShell.refreshUnread(); if (after) after();
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function setArchived(t, archived, after) {
        if (archived && !await C.confirm({ title: `Archive "${t.title}"?`, message: 'Archived tasks disappear from lists and boards but keep their comments and history. You can restore them from the archived filter.', okText: 'Archive', danger: true })) return;
        try {
            await C.q(sb.from('tasks').update({ archived_at: archived ? new Date().toISOString() : null }).eq('id', t.id));
            C.toast(archived ? 'Task archived' : 'Task restored', 'ok'); WSShell.refreshUnread(); if (after) after();
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function deleteTask(t) {
        if (!await C.confirm({ title: 'Delete this task permanently?', message: 'Subtasks, comments and attachments links are removed with it. Archiving keeps the history.', okText: 'Delete permanently', danger: true })) return;
        try { await C.q(sb.from('tasks').delete().eq('id', t.id)); C.toast('Task deleted', 'ok'); WSShell.refreshUnread(); go('/tasks/'); }
        catch (e) { C.toast(e.message, 'bad'); }
    }
    async function duplicateTask(t) {
        try {
            const copy = { title: `Copy of ${t.title}`, description: t.description, status: OPEN_KEY, priority: t.priority, assignee_id: t.assignee_id, project_id: t.project_id, board_id: t.board_id, board_column_id: t.board_column_id, contact_id: t.contact_id, lead_id: t.lead_id, deal_id: t.deal_id, start_date: t.start_date, due_date: t.due_date, due_time: t.due_time, estimate_hours: t.estimate_hours, tags: t.tags || [], created_by: me.id };
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
    function rowMenu(anchor, t, after) {
        C.menu(anchor, [
            { label: 'Open', icon: 'arrow', onClick: () => go(`/tasks/?id=${t.id}`) },
            { label: 'Edit', icon: 'edit', onClick: () => editTask(t, after) },
            isDone(t) ? { label: 'Reopen', icon: 'refresh', onClick: () => setDone(t, false, after) } : { label: 'Complete', icon: 'check', onClick: () => setDone(t, true, after) },
            ...(t.assignee_id !== me.id ? [{ label: 'Assign to me', icon: 'user', onClick: () => assignToMe(t, after) }] : []),
            'sep',
            t.archived_at ? { label: 'Restore', icon: 'refresh', onClick: () => setArchived(t, false, after) } : { label: 'Archive', icon: 'trash', danger: true, onClick: () => setArchived(t, true, after) },
        ]);
    }

    /* --------------------------------------------------------------- list */
    const ls = { view: 'mine', display: 'list', q: '', assignee: '', priority: '', status: '', project: '', archived: false, open: [], completed: [], myExtra: new Set(), completedCount: 0 };
    async function fetchOpen() {
        let b = sb.from('tasks').select(SELECT).is('completed_at', null).order('due_date', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false }).limit(1000);
        b = ls.archived ? b.not('archived_at', 'is', null) : b.is('archived_at', null);
        const [{ data }, extra] = await Promise.all([C.q(b), sb.from('task_assignees').select('task_id').eq('user_id', me.id)]);
        ls.open = data || [];
        ls.myExtra = new Set((extra.data || []).map(x => x.task_id));
        await resolveNames(ls.open);
    }
    async function fetchCompleted() {
        let b = sb.from('tasks').select(SELECT).not('completed_at', 'is', null).order('completed_at', { ascending: false }).limit(300);
        b = ls.archived ? b.not('archived_at', 'is', null) : b.is('archived_at', null);
        const { data, count } = await C.q(b);
        ls.completed = data || [];
        await resolveNames(ls.completed);
        const c = await sb.from('tasks').select('id', { count: 'exact', head: true }).not('completed_at', 'is', null).is('archived_at', null);
        ls.completedCount = c.count != null ? c.count : (count || ls.completed.length);
    }
    const today = L.todayIST();
    function mine(t) { return t.assignee_id === me.id || ls.myExtra.has(t.id); }
    function viewRows(key) {
        const o = ls.open;
        switch (key) {
            case 'mine': return o.filter(mine);
            case 'created': return o.filter(t => t.created_by === me.id);
            case 'overdue': return o.filter(t => L.taskDueState(t, today) === 'overdue');
            case 'today': return o.filter(t => L.taskDueState(t, today) === 'today');
            case 'completed': return ls.completed;
            default: return o;
        }
    }
    function applyFilters(rows) {
        const q = ls.q.trim().toLowerCase();
        return rows.filter(t => {
            if (q && !(t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q) || (t.tags || []).some(x => x.toLowerCase().includes(q)))) return false;
            if (ls.assignee === 'me' && !mine(t)) return false;
            if (ls.assignee === 'none' && t.assignee_id) return false;
            if (ls.assignee && ls.assignee !== 'me' && ls.assignee !== 'none' && t.assignee_id !== ls.assignee) return false;
            if (ls.priority && t.priority !== ls.priority) return false;
            if (ls.status && t.status !== ls.status) return false;
            if (ls.project && t.project_id !== ls.project) return false;
            return true;
        });
    }
    function prioRank(t) { return (L.PRIORITY[t.priority] || L.PRIORITY.normal).rank; }
    function defaultSort(rows) {
        return rows.slice().sort((a, b) => {
            const da = a.due_date ? L.dayNumber(a.due_date) : Infinity, db = b.due_date ? L.dayNumber(b.due_date) : Infinity;
            if (da !== db) return da - db;
            return prioRank(b) - prioRank(a);
        });
    }

    async function showList() {
        WSShell.setCrumb('Tasks');
        document.title = 'Tasks · WorkSuite';
        const v = C.param('view'); if (v && VIEWS.some(x => x.key === v)) ls.view = v;
        const d = C.param('display'); if (d === 'kanban' || d === 'list') ls.display = d;
        view.innerHTML = `
            <div class="ws-page-head">
                <div><p class="ws-eyebrow">Collaboration</p><h1>Tasks</h1><p>Work assigned to you and your team, with due dates that show up on the calendar.</p></div>
                <div class="actions">
                    <div class="crm-seg" role="group" aria-label="Display"><button type="button" data-display="list">${C.icon('tasks', 'sm')} List</button><button type="button" data-display="kanban">${C.icon('board', 'sm')} Kanban</button></div>
                    <button type="button" class="ws-btn primary" id="new-btn">${C.icon('plus')}<span>New task</span></button>
                </div>
            </div>
            <div class="crm-toolbar">
                <div class="crm-seg" id="views" role="tablist" aria-label="Task views">${VIEWS.map(x => `<button type="button" role="tab" data-view="${x.key}">${esc(x.label)}<span class="n" data-count="${x.key}">…</span></button>`).join('')}</div>
            </div>
            <div class="crm-toolbar">
                <div class="crm-search grow">${C.icon('search', 'sm')}<input type="search" id="q" placeholder="Search tasks…" aria-label="Search tasks"></div>
                <select id="f-assignee" aria-label="Assignee"><option value="">Any assignee</option><option value="me">Assigned to me</option><option value="none">Unassigned</option>${C.peopleOptions('', { none: null })}</select>
                <select id="f-project" aria-label="Project"><option value="">Any project</option></select>
                <select id="f-priority" aria-label="Priority"><option value="">Any priority</option>${Object.entries(L.PRIORITY).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('')}</select>
                <select id="f-status" aria-label="Status"><option value="">Any status</option>${lk.taskStatuses.map(s => `<option value="${esc(s.key)}">${esc(s.label)}</option>`).join('')}</select>
                <label class="crm-check" style="min-height:auto"><input type="checkbox" id="f-archived"> Archived</label>
                <span class="crm-count" id="count"></span>
            </div>
            <div id="bulk" class="crm-bulkbar" hidden></div>
            <div id="list-wrap" class="ws-card flush"><div id="table"></div></div>
            <div id="kanban" hidden></div>`;
        const tableEl = view.querySelector('#table'), kbEl = view.querySelector('#kanban'), listWrap = view.querySelector('#list-wrap');
        C.skeletonRows(tableEl, 6);
        view.querySelector('#q').value = ls.q;
        view.querySelector('#f-assignee').value = ls.assignee;
        view.querySelector('#f-priority').value = ls.priority;
        view.querySelector('#f-status').value = ls.status;
        view.querySelector('#f-archived').checked = ls.archived;
        const newTask = () => C.openTaskEditor({ defaults: { assignee_id: me.id }, onSaved: t => go(`/tasks/?id=${t.id}`) });
        on('#new-btn', newTask);

        let tbl = null, kb = null;
        const bulk = view.querySelector('#bulk');
        function syncControls() {
            view.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('on', b.dataset.view === ls.view); b.setAttribute('aria-selected', b.dataset.view === ls.view); });
            view.querySelectorAll('[data-display]').forEach(b => b.classList.toggle('on', b.dataset.display === ls.display));
            view.querySelector('#f-status').disabled = ls.display === 'kanban';
            listWrap.hidden = ls.display !== 'list'; kbEl.hidden = ls.display !== 'kanban';
        }
        function counts() {
            const c = { mine: viewRows('mine').length, all: ls.open.length, created: viewRows('created').length, overdue: viewRows('overdue').length, today: viewRows('today').length, completed: ls.completedCount };
            Object.entries(c).forEach(([k, n]) => { const el = view.querySelector(`[data-count="${k}"]`); if (el) el.textContent = n; });
        }
        function projectOptions() {
            const sel = view.querySelector('#f-project');
            const ids = Array.from(new Set([...ls.open, ...ls.completed].map(t => t.project_id).filter(Boolean)));
            sel.innerHTML = '<option value="">Any project</option>' + ids.map(id => `<option value="${esc(id)}"${id === ls.project ? ' selected' : ''}>${esc(names.project[id] || 'Project')}</option>`).join('');
        }
        function renderBulk(sel) {
            bulk.hidden = !sel.length;
            if (!sel.length) return;
            bulk.innerHTML = `<span>${sel.length} selected</span>
                <select id="bulk-assign" aria-label="Assign"><option value="">Assign to…</option>${C.peopleOptions('', { none: null })}</select>
                <select id="bulk-status" aria-label="Set status"><option value="">Set status…</option>${lk.taskStatuses.map(s => `<option value="${esc(s.key)}">${esc(s.label)}</option>`).join('')}</select>
                <select id="bulk-priority" aria-label="Set priority"><option value="">Set priority…</option>${Object.entries(L.PRIORITY).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('')}</select>
                <button type="button" class="ws-btn sm" id="bulk-archive">${C.icon('trash')}<span>Archive</span></button>
                <span class="spacer"></span><button type="button" class="ws-btn sm ghost" id="bulk-clear">Clear</button>`;
            const apply = async (patch, msg) => { try { await C.q(sb.from('tasks').update(patch).in('id', sel)); C.toast(msg, 'ok'); WSShell.refreshUnread(); await reload(); } catch (e) { C.toast(e.message, 'bad'); } };
            bulk.querySelector('#bulk-assign').addEventListener('change', e => { if (e.target.value) apply({ assignee_id: e.target.value }, `Assigned ${sel.length} task${sel.length > 1 ? 's' : ''}`); });
            bulk.querySelector('#bulk-status').addEventListener('change', e => { if (e.target.value) apply({ status: e.target.value }, 'Status updated'); });
            bulk.querySelector('#bulk-priority').addEventListener('change', e => { if (e.target.value) apply({ priority: e.target.value }, 'Priority updated'); });
            bulk.querySelector('#bulk-archive').addEventListener('click', async () => {
                if (!await C.confirm({ title: `Archive ${sel.length} task${sel.length > 1 ? 's' : ''}?`, message: 'They are hidden from lists and boards but keep their history.', okText: 'Archive', danger: true })) return;
                apply({ archived_at: new Date().toISOString() }, 'Archived');
            });
            bulk.querySelector('#bulk-clear').addEventListener('click', () => tbl && tbl.clearSelection());
        }
        const subCounts = {};
        async function loadSubCounts(rows) {
            const ids = rows.filter(t => !t.parent_task_id).map(t => t.id);
            if (!ids.length) return;
            const r = await sb.from('tasks').select('parent_task_id').in('parent_task_id', ids.slice(0, 500)).is('archived_at', null);
            Object.keys(subCounts).forEach(k => delete subCounts[k]);
            (r.data || []).forEach(x => { subCounts[x.parent_task_id] = (subCounts[x.parent_task_id] || 0) + 1; });
        }
        function columns() {
            return [
                { key: 'title', label: 'Task', lead: true, render: t => `<div style="display:flex;gap:10px;align-items:flex-start"><input type="checkbox" data-done="${esc(t.id)}" aria-label="Complete" ${isDone(t) ? 'checked' : ''} style="margin-top:3px;width:17px;height:17px;accent-color:var(--ws-primary)"><div style="min-width:0"><span class="primary-text" style="${isDone(t) ? 'text-decoration:line-through;color:var(--ws-text-muted)' : ''}">${esc(t.title)}</span>${t.reminder_at ? ` <span class="ic ic-bell sm" title="Reminder ${esc(L.fmtDateTime(t.reminder_at))}" style="color:var(--ws-text-muted)"></span>` : ''}${t.parent_task_id ? ' <span class="crm-tag">subtask</span>' : ''}${subCounts[t.id] ? ` <span class="crm-tag">${subCounts[t.id]} subtask${subCounts[t.id] > 1 ? 's' : ''}</span>` : ''}<span class="sub">${subtitle(t) || '—'}</span></div></div>` },
                { key: 'status', label: 'Status', render: t => C.statusBadge(STATUS, t.status) },
                { key: 'priority', label: 'Priority', value: t => prioRank(t), render: t => C.priorityBadge(t.priority) },
                { key: 'assignee_id', label: 'Assignee', value: t => C.personName(t.assignee_id), render: t => C.personHtml(t.assignee_id, { link: false }) },
                { key: 'due_date', label: 'Due', render: t => C.dueHtml(t, today) },
                { key: 'updated_at', label: 'Updated', num: true, hideMobile: true, render: t => `<span class="muted">${esc(L.fmtRelative(t.updated_at))}</span>` },
                { key: 'actions', label: '', sort: false, cls: 'actions', render: t => `<button type="button" class="ws-btn sm icon" data-menu="${esc(t.id)}" aria-label="Actions">${C.icon('more')}</button>` },
            ];
        }
        function currentRows() { return defaultSort(applyFilters(viewRows(ls.view))); }
        function emptyFor() {
            const has = ls.q || ls.assignee || ls.priority || ls.status || ls.project;
            const t = { mine: 'You have no open tasks', all: 'No open tasks', created: 'You have not created any tasks', overdue: 'Nothing overdue', today: 'Nothing due today', completed: 'No completed tasks yet' }[ls.view];
            return { title: has ? 'No tasks match' : t, sub: has ? 'Try clearing a filter.' : (ls.view === 'overdue' || ls.view === 'today' ? 'Nice — keep it that way.' : 'Create a task to get going.'), action: has ? '' : `<button type="button" class="ws-btn primary" onclick="document.getElementById('new-btn').click()">${C.icon('plus')}<span>New task</span></button>` };
        }
        function paint() {
            syncControls(); counts(); projectOptions();
            const rows = currentRows();
            view.querySelector('#count').textContent = `${rows.length} task${rows.length === 1 ? '' : 's'}`;
            if (ls.display === 'list') {
                if (!tbl) tbl = C.table(tableEl, { columns: columns(), rows, sort: null, selectable: true, pageSize: 50, onRow: t => go(`/tasks/?id=${t.id}`), onSelectionChange: renderBulk, empty: emptyFor(), rowClass: t => isDone(t) ? 'done' : '' });
                else tbl.update(rows);
            } else {
                const cards = rows.map(t => ({ ...t, columnId: t.status, position: t.position || 0 }));
                const cols = lk.taskStatuses.map(s => ({ id: s.key, name: s.label, color: s.color }));
                if (!kb) kb = WSKanban.mount(kbEl, {
                    columns: cols, cards, emptyText: 'No tasks',
                    renderCard: t => `<div class="t">${esc(t.title)}</div>${chipText(t) ? `<div class="s">${chipText(t)}</div>` : ''}<div class="f">${C.priorityBadge(t.priority)}${C.dueHtml(t, today)}<span class="spacer"></span>${t.assignee_id ? C.avatarHtml(t.assignee_id) : ''}</div>`,
                    onMove: async ({ card, toColumnId, position }) => { await C.q(sb.from('tasks').update({ status: toColumnId, position }).eq('id', card.id)); WSShell.refreshUnread(); await reload(true); },
                    onCardClick: t => go(`/tasks/?id=${t.id}`),
                    onAddCard: colId => C.openTaskEditor({ defaults: { assignee_id: me.id, status: colId }, onSaved: async s => { if (s.status !== colId) await sb.from('tasks').update({ status: colId }).eq('id', s.id); reload(); } }),
                });
                else kb.update({ columns: cols, cards });
            }
        }
        async function reload(silent) {
            try {
                if (!silent && ls.display === 'list' && !tbl) C.skeletonRows(tableEl, 6);
                await fetchOpen();
                if (ls.view === 'completed' || !ls.completedCount) await fetchCompleted();
                await loadSubCounts([...ls.open, ...ls.completed]);
                paint();
            } catch (e) { C.errorState(ls.display === 'list' ? tableEl : kbEl, e, () => reload()); }
        }
        view.querySelector('#views').addEventListener('click', async e => {
            const b = e.target.closest('[data-view]'); if (!b) return;
            ls.view = b.dataset.view; C.setParam('view', ls.view, true);
            if (ls.view === 'completed') { await fetchCompleted(); await loadSubCounts(ls.completed); }
            if (tbl) tbl.clearSelection();
            paint();
        });
        view.querySelectorAll('[data-display]').forEach(b => b.addEventListener('click', () => { ls.display = b.dataset.display; C.setParam('display', ls.display, true); paint(); }));
        tableEl.addEventListener('click', async e => {
            const done = e.target.closest('[data-done]');
            if (done) { const t = [...ls.open, ...ls.completed].find(x => x.id === done.dataset.done); if (t) await setDone(t, done.checked, reload); return; }
            const b = e.target.closest('[data-menu]'); if (!b) return;
            e.stopPropagation();
            const t = [...ls.open, ...ls.completed].find(x => x.id === b.dataset.menu); if (t) rowMenu(b, t, reload);
        });
        view.querySelector('#q').addEventListener('input', C.debounce(() => { ls.q = view.querySelector('#q').value; paint(); }, 180));
        view.querySelector('#f-assignee').addEventListener('change', e => { ls.assignee = e.target.value; paint(); });
        view.querySelector('#f-project').addEventListener('change', e => { ls.project = e.target.value; paint(); });
        view.querySelector('#f-priority').addEventListener('change', e => { ls.priority = e.target.value; paint(); });
        view.querySelector('#f-status').addEventListener('change', e => { ls.status = e.target.value; paint(); });
        view.querySelector('#f-archived').addEventListener('change', e => { ls.archived = e.target.checked; ls.completedCount = 0; reload(); });
        await reload();
        if (C.param('new') === '1') { C.setParam('new', null, true); newTask(); }
    }

    /* ------------------------------------------------------------- record */
    async function showRecord(id) {
        C.loading(view, 'Loading task…');
        let t;
        try { t = (await C.q(sb.from('tasks').select(SELECT).eq('id', id).maybeSingle())).data; }
        catch (e) { return C.errorState(view, e, () => showRecord(id)); }
        if (!t) { view.innerHTML = `<a class="crm-back" href="/tasks/">${C.icon('arrow')}All tasks</a>`; C.empty(view.appendChild(document.createElement('div')), 'Task not found', 'It may have been deleted, or you may not have access to it.'); return; }
        document.title = `${t.title} · Tasks · WorkSuite`;
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
        const canDelete = L.canDelete(t, me);
        const watching = watchers.includes(me.id);
        const done = isDone(t);
        const linked = [t.project_id && ['project', t.project_id, names.project[t.project_id]], t.contact_id && ['contact', t.contact_id, names.contact[t.contact_id]], t.deal_id && ['deal', t.deal_id, names.deal[t.deal_id]], t.lead_id && ['lead', t.lead_id, names.lead[t.lead_id]]].filter(Boolean);

        view.innerHTML = `
            <a class="crm-back" href="/tasks/" data-nav>${C.icon('arrow')}All tasks</a>
            <div class="crm-record-head">
                <div class="titles">
                    ${parent ? `<div class="muted" style="font-size:13px;margin-bottom:4px">Subtask of <a class="crm-link" href="/tasks/?id=${esc(parent.id)}">${esc(parent.title)}</a></div>` : ''}
                    <h1 style="${done ? 'text-decoration:line-through;color:var(--ws-text-muted)' : ''}">${esc(t.title)}</h1>
                    <div class="meta">
                        ${C.statusBadge(STATUS, t.status)} ${C.priorityBadge(t.priority)}
                        ${t.due_date ? C.dueHtml(t, today) : ''}
                        <span>Assignee: ${C.personHtml(t.assignee_id)}</span>
                        ${assignees.length ? `<span>+ ${C.avatarsHtml(assignees)}</span>` : ''}
                        ${linked.map(([k, i, n]) => C.entityChip(k, i, n)).join(' ')}
                    </div>
                </div>
                <div class="actions">
                    ${canEdit ? `<button type="button" class="ws-btn ${done ? '' : 'primary'}" id="done-btn">${C.icon(done ? 'refresh' : 'check')}<span>${done ? 'Reopen' : 'Complete'}</span></button>` : ''}
                    ${canEdit ? `<button type="button" class="ws-btn" id="edit-btn">${C.icon('edit')}<span>Edit</span></button>` : ''}
                    <button type="button" class="ws-btn" id="watch-btn" aria-pressed="${watching}">${C.icon(watching ? 'bell' : 'star')}<span>${watching ? 'Watching' : 'Watch'}</span></button>
                    <button type="button" class="ws-btn icon" id="more-btn" aria-label="More actions">${C.icon('more')}</button>
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
        view.querySelector('[data-nav]').addEventListener('click', e => { e.preventDefault(); go('/tasks/'); });
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
                { label: 'Duplicate', icon: 'plus', onClick: () => duplicateTask(t) },
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
                await C.q(sb.from('tasks').insert({ title, parent_task_id: id, project_id: t.project_id, board_id: t.board_id, contact_id: t.contact_id, deal_id: t.deal_id, lead_id: t.lead_id, assignee_id: t.assignee_id, priority: t.priority, status: OPEN_KEY, created_by: me.id }));
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
