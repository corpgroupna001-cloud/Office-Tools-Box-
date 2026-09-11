/* ============================================================================
   Boards — reusable Kanban boards. A board is a set of columns; the cards are
   tasks (tasks.board_id / board_column_id / position), so a card on a board is
   the same record that shows in Tasks, on the project and on the calendar.
   Columns may map to a task status: dropping a card there sets the status
   (done by the database trigger).

   URLs:  /boards/               list       /boards/?id=<uuid>   board
          /boards/?new=1         list + new-board dialog
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'boards', crumb: 'Boards' });
    const sb = ctx.sb, me = ctx.user;
    const lk = await C.lookups();
    const STATUS = lk.taskStatus;
    const KIND = { custom: { label: 'Custom', color: 'pending' }, project: { label: 'Project', color: 'leave' }, tasks: { label: 'Tasks', color: 'present' } };
    const COLORS = ['pending', 'late', 'present', 'absent', 'leave', 'holiday', 'weekoff'];
    const TASK_SELECT = 'id, title, description, status, priority, assignee_id, project_id, board_id, board_column_id, position, parent_task_id, contact_id, deal_id, lead_id, due_date, due_time, completed_at, tags, archived_at, created_by, created_at, updated_at';
    const today = L.todayIST();
    let unsubscribe = null;

    /* ------------------------------------------------------------ routing */
    function route() {
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        const id = C.param('id');
        if (id) return showBoard(id);
        return showList();
    }
    window.addEventListener('popstate', route);
    function go(url) { history.pushState(null, '', url); route(); }
    function on(sel, fn) { const el = view.querySelector(sel); if (el) el.addEventListener('click', fn); }
    function canManage(b) { return L.canEdit({ created_by: b.created_by }, me); }

    /* -------------------------------------------------------- board form */
    const DEFAULT_COLUMNS = [
        { name: 'To Do', maps_to_status: 'todo', color: 'weekoff' },
        { name: 'In Progress', maps_to_status: 'in_progress', color: 'pending' },
        { name: 'Review', maps_to_status: 'review', color: 'late' },
        { name: 'Done', maps_to_status: 'completed', color: 'present' },
    ];
    async function openBoardEditor(board, onSaved) {
        const isNew = !board;
        return C.formModal({
            title: isNew ? 'New board' : 'Edit board',
            fields: [
                { name: 'name', label: 'Board name', type: 'text', required: true, full: true },
                { name: 'description', label: 'Description', type: 'textarea', full: true, rows: 2 },
                { name: 'kind', label: 'Kind', type: 'select', options: [{ value: 'custom', label: 'Custom work' }, { value: 'tasks', label: 'Team tasks' }], required: true },
                { name: 'project_id', label: 'Project (optional)', type: 'entity', entity: 'project', placeholder: 'Search projects' },
            ],
            values: isNew ? { kind: 'custom' } : { ...board, kind: board.kind === 'project' ? 'custom' : board.kind },
            submitLabel: isNew ? 'Create board' : 'Save',
            onSubmit: async v => {
                const row = { name: v.name.trim(), description: v.description || null, kind: v.project_id ? 'project' : v.kind, project_id: v.project_id || null };
                if (isNew) {
                    const { data } = await C.q(sb.from('boards').insert({ ...row, created_by: me.id }).select('*').single());
                    const statuses = new Set(lk.taskStatuses.map(s => s.key));
                    await C.q(sb.from('board_columns').insert(DEFAULT_COLUMNS.map((c, i) => ({ board_id: data.id, name: c.name, position: i + 1, maps_to_status: statuses.has(c.maps_to_status) ? c.maps_to_status : null, color: c.color }))));
                    C.toast('Board created', 'ok');
                    if (onSaved) onSaved(data);
                    return data;
                }
                const { data } = await C.q(sb.from('boards').update(row).eq('id', board.id).select('*').single());
                C.toast('Board saved', 'ok');
                if (onSaved) onSaved(data);
                return data;
            },
        });
    }
    async function setArchived(b, archived, after) {
        if (archived && !await C.confirm({ title: `Archive "${b.name}"?`, message: 'The board is hidden from the list. Its cards stay as tasks and the board can be restored.', okText: 'Archive', danger: true })) return;
        try { await C.q(sb.from('boards').update({ archived_at: archived ? new Date().toISOString() : null }).eq('id', b.id)); C.toast(archived ? 'Board archived' : 'Board restored', 'ok'); if (after) after(); }
        catch (e) { C.toast(e.message, 'bad'); }
    }
    async function deleteBoard(b) {
        if (!await C.confirm({ title: 'Delete this board permanently?', message: 'Columns are removed. Cards stay as tasks but leave the board. Archiving is usually the better choice.', okText: 'Delete permanently', danger: true })) return;
        try {
            await sb.from('tasks').update({ board_id: null, board_column_id: null }).eq('board_id', b.id);
            await C.q(sb.from('boards').delete().eq('id', b.id));
            C.toast('Board deleted', 'ok'); go('/boards/');
        } catch (e) { C.toast(e.message, 'bad'); }
    }

    /* --------------------------------------------------------------- list */
    const ls = { q: '', kind: '', archived: false, rows: [], counts: {}, projects: {} };
    async function showList() {
        WSShell.setCrumb('Boards');
        document.title = 'Boards · WorkSuite';
        view.innerHTML = `
            <div class="ws-page-head">
                <div><p class="ws-eyebrow">Collaboration</p><h1>Boards</h1><p>Kanban boards for tasks, projects and any other flow of work.</p></div>
                <div class="actions"><button type="button" class="ws-btn primary" id="new-btn">${C.icon('plus')}<span>New board</span></button></div>
            </div>
            <div class="crm-toolbar">
                <div class="crm-search grow">${C.icon('search', 'sm')}<input type="search" id="q" placeholder="Search boards…" aria-label="Search boards"></div>
                <select id="f-kind" aria-label="Kind"><option value="">All kinds</option>${Object.entries(KIND).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select>
                <label class="crm-check" style="min-height:auto"><input type="checkbox" id="f-archived"> Archived</label>
                <span class="crm-count" id="count"></span>
            </div>
            <div id="grid"></div>`;
        const grid = view.querySelector('#grid');
        C.skeletonRows(grid, 4);
        view.querySelector('#q').value = ls.q; view.querySelector('#f-kind').value = ls.kind; view.querySelector('#f-archived').checked = ls.archived;
        const newBoard = () => openBoardEditor(null, b => go(`/boards/?id=${b.id}`));
        on('#new-btn', newBoard);
        async function reload() {
            try {
                let b = sb.from('boards').select('*').order('updated_at', { ascending: false }).limit(300);
                b = ls.archived ? b.not('archived_at', 'is', null) : b.is('archived_at', null);
                const { data } = await C.q(b);
                ls.rows = data || [];
                const ids = ls.rows.map(x => x.id);
                ls.counts = {};
                if (ids.length) {
                    const t = await sb.from('tasks').select('board_id').in('board_id', ids).is('archived_at', null).is('completed_at', null);
                    (t.data || []).forEach(x => { ls.counts[x.board_id] = (ls.counts[x.board_id] || 0) + 1; });
                    const pids = Array.from(new Set(ls.rows.map(x => x.project_id).filter(Boolean)));
                    if (pids.length) { const p = await sb.from('projects').select('id, name').in('id', pids); (p.data || []).forEach(x => { ls.projects[x.id] = x.name; }); }
                }
                paint();
            } catch (e) { C.errorState(grid, e, reload); }
        }
        function paint() {
            const q = ls.q.trim().toLowerCase();
            const rows = ls.rows.filter(b => (!ls.kind || b.kind === ls.kind) && (!q || b.name.toLowerCase().includes(q) || (b.description || '').toLowerCase().includes(q)));
            view.querySelector('#count').textContent = `${rows.length} board${rows.length === 1 ? '' : 's'}`;
            if (!rows.length) return C.empty(grid, ls.q || ls.kind ? 'No boards match' : (ls.archived ? 'No archived boards' : 'No boards yet'), ls.q || ls.kind ? 'Try clearing a filter.' : 'Create a board to organise work as cards in columns. Every project also gets a board of its own.', ls.q || ls.kind || ls.archived ? '' : `<button type="button" class="ws-btn primary" onclick="document.getElementById('new-btn').click()">${C.icon('plus')}<span>New board</span></button>`);
            grid.innerHTML = `<div class="emp-grid">${rows.map(b => `
                <div class="ws-card hover" data-board="${esc(b.id)}" style="cursor:pointer;display:flex;flex-direction:column;gap:8px" tabindex="0" role="link" aria-label="Open ${esc(b.name)}">
                    <div style="display:flex;align-items:flex-start;gap:8px">
                        <div style="flex:1;min-width:0"><b style="font-size:15px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(b.name)}</b>${b.project_id ? `<a class="crm-link" style="font-size:12.5px" href="/projects/?id=${esc(b.project_id)}">${C.icon('folder', 'sm')} ${esc(ls.projects[b.project_id] || 'Project')}</a>` : ''}</div>
                        <button type="button" class="ws-btn sm icon" data-menu="${esc(b.id)}" aria-label="Board actions">${C.icon('more')}</button>
                    </div>
                    ${b.description ? `<div class="muted" style="font-size:13px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(b.description)}</div>` : ''}
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:auto">${C.statusBadge(KIND, b.kind)}<span class="muted" style="font-size:12.5px">${ls.counts[b.id] || 0} open card${(ls.counts[b.id] || 0) === 1 ? '' : 's'}</span><span class="spacer" style="flex:1"></span>${C.avatarHtml(b.created_by, 'sm')}</div>
                </div>`).join('')}</div>`;
        }
        grid.addEventListener('click', e => {
            const m = e.target.closest('[data-menu]');
            if (m) {
                e.stopPropagation();
                const b = ls.rows.find(x => x.id === m.dataset.menu); if (!b) return;
                const items = [{ label: 'Open', icon: 'arrow', onClick: () => go(`/boards/?id=${b.id}`) }];
                if (canManage(b)) items.push({ label: 'Edit', icon: 'edit', onClick: () => openBoardEditor(b, reload) }, 'sep', b.archived_at ? { label: 'Restore', icon: 'refresh', onClick: () => setArchived(b, false, reload) } : { label: 'Archive', icon: 'trash', danger: true, onClick: () => setArchived(b, true, reload) }, { label: 'Delete permanently', icon: 'trash', danger: true, onClick: () => deleteBoard(b) });
                return C.menu(m, items);
            }
            if (e.target.closest('a')) return;
            const card = e.target.closest('[data-board]'); if (card) go(`/boards/?id=${card.dataset.board}`);
        });
        grid.addEventListener('keydown', e => { const card = e.target.closest('[data-board]'); if (card && e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go(`/boards/?id=${card.dataset.board}`); } });
        view.querySelector('#q').addEventListener('input', C.debounce(() => { ls.q = view.querySelector('#q').value; paint(); }, 180));
        view.querySelector('#f-kind').addEventListener('change', e => { ls.kind = e.target.value; paint(); });
        view.querySelector('#f-archived').addEventListener('change', e => { ls.archived = e.target.checked; reload(); });
        await reload();
        if (C.param('new') === '1') { C.setParam('new', null, true); newBoard(); }
    }

    /* -------------------------------------------------------------- board */
    async function showBoard(id) {
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        C.loading(view, 'Loading board…');
        let board;
        try { board = (await C.q(sb.from('boards').select('*').eq('id', id).maybeSingle())).data; }
        catch (e) { return C.errorState(view, e, () => showBoard(id)); }
        if (!board) { view.innerHTML = `<a class="crm-back" href="/boards/">${C.icon('arrow')}All boards</a>`; C.empty(view.appendChild(document.createElement('div')), 'Board not found', 'It may have been deleted, or you may not have access to it.'); return; }
        document.title = `${board.name} · Boards · WorkSuite`;
        WSShell.setCrumb(board.name);
        const bs = { columns: [], cards: [], assignee: '', project: null, members: [] };
        const [cols, project, members] = await Promise.all([
            C.q(sb.from('board_columns').select('*').eq('board_id', id).order('position')).then(r => r.data || []),
            board.project_id ? sb.from('projects').select('id, name, owner_id, manager_id').eq('id', board.project_id).maybeSingle().then(r => r.data) : null,
            board.project_id ? sb.from('project_members').select('user_id').eq('project_id', board.project_id).then(r => (r.data || []).map(x => x.user_id)) : [],
        ]);
        bs.columns = cols; bs.project = project; bs.members = members;
        const onProject = !!(project && (project.owner_id === me.id || project.manager_id === me.id || members.includes(me.id)));
        const manage = canManage(board) || onProject;

        view.innerHTML = `
            <a class="crm-back" href="/boards/" data-nav>${C.icon('arrow')}All boards</a>
            <div class="crm-record-head">
                <div class="titles">
                    <h1>${esc(board.name)}</h1>
                    <div class="meta">
                        ${C.statusBadge(KIND, board.kind)}
                        ${project ? C.entityChip('project', project.id, project.name) : ''}
                        ${project ? `<span>Team: ${C.avatarsHtml(Array.from(new Set([project.owner_id, project.manager_id, ...members].filter(Boolean))), 6)}</span>` : ''}
                        ${board.description ? `<span>${esc(board.description)}</span>` : ''}
                        ${board.archived_at ? C.badge('mute', 'Archived') : ''}
                        <span class="muted" id="card-count"></span>
                    </div>
                </div>
                <div class="actions">
                    <select id="f-assignee" aria-label="Filter by assignee" style="min-height:38px;padding:7px 11px;border:1px solid var(--ws-border-2);border-radius:6px;background:var(--ws-surface);color:var(--ws-text)"><option value="">Everyone</option><option value="me">Mine</option><option value="none">Unassigned</option>${C.peopleOptions('', { none: null })}</select>
                    ${manage ? `<button type="button" class="ws-btn" id="add-col">${C.icon('plus')}<span>Column</span></button>` : ''}
                    <button type="button" class="ws-btn primary" id="add-card">${C.icon('plus')}<span>Card</span></button>
                    <button type="button" class="ws-btn icon" id="more-btn" aria-label="More actions">${C.icon('more')}</button>
                </div>
            </div>
            <div id="kanban"></div>`;
        view.querySelector('[data-nav]').addEventListener('click', e => { e.preventDefault(); go('/boards/'); });
        const kbEl = view.querySelector('#kanban');
        let kb = null;

        function visibleCards() {
            return bs.cards.filter(t => {
                if (bs.assignee === 'me') return t.assignee_id === me.id;
                if (bs.assignee === 'none') return !t.assignee_id;
                if (bs.assignee) return t.assignee_id === bs.assignee;
                return true;
            }).map(t => ({ ...t, columnId: t.board_column_id || (bs.columns[0] && bs.columns[0].id), position: t.position || 0 }));
        }
        function renderCard(t) {
            const subs = subCounts[t.id];
            return `<div class="t" style="${t.completed_at ? 'text-decoration:line-through;color:var(--ws-text-muted)' : ''}">${esc(t.title)}</div>
                ${(t.tags || []).length ? `<div class="crm-tags" style="margin-top:6px">${t.tags.slice(0, 4).map(x => `<span class="crm-tag">${esc(x)}</span>`).join('')}</div>` : ''}
                <div class="f">${C.priorityBadge(t.priority)}${t.due_date ? C.dueHtml(t, today) : ''}${subs ? `<span class="muted" style="font-size:11.5px">${subs} subtask${subs > 1 ? 's' : ''}</span>` : ''}<span class="spacer"></span>${t.assignee_id ? C.avatarHtml(t.assignee_id) : ''}</div>`;
        }
        const subCounts = {};
        function paint() {
            const cards = visibleCards();
            view.querySelector('#card-count').textContent = `${bs.cards.length} card${bs.cards.length === 1 ? '' : 's'}`;
            const columns = bs.columns.map(c => ({ id: c.id, name: c.name, color: c.color, wipLimit: c.wip_limit || null }));
            if (!columns.length) { kbEl.classList.remove('kb-board'); return C.empty(kbEl, 'This board has no columns', manage ? 'Add a column to start placing cards.' : 'Ask the board owner to add columns.', manage ? `<button type="button" class="ws-btn primary" onclick="document.getElementById('add-col').click()">${C.icon('plus')}<span>Add column</span></button>` : ''); }
            if (!kb) kb = WSKanban.mount(kbEl, {
                columns, cards, emptyText: 'No cards', renderCard,
                canDrag: t => !board.archived_at && (ctx.isManager || L.canEdit({ created_by: t.created_by, assignee_id: t.assignee_id }, me) || onProject),
                onMove: async ({ card, toColumnId, position }) => {
                    const { data } = await C.q(sb.from('tasks').update({ board_column_id: toColumnId, position }).eq('id', card.id).select('id'));
                    if (!data || !data.length) throw new Error('You do not have permission to move this card.');
                    WSShell.refreshUnread();
                    reload(true);
                },
                onCardClick: t => openCard(t),
                onAddCard: colId => addCard(colId),
                onColumnMenu: (col, anchor, extra) => columnMenu(col, anchor, extra),
            });
            else kb.update({ columns, cards });
        }
        async function reload(silent) {
            try {
                const [c, t] = await Promise.all([
                    C.q(sb.from('board_columns').select('*').eq('board_id', id).order('position')),
                    C.q(sb.from('tasks').select(TASK_SELECT).eq('board_id', id).is('archived_at', null).is('parent_task_id', null).order('position').limit(1000)),
                ]);
                bs.columns = c.data || []; bs.cards = t.data || [];
                const ids = bs.cards.map(x => x.id);
                Object.keys(subCounts).forEach(k => delete subCounts[k]);
                if (ids.length) { const s = await sb.from('tasks').select('parent_task_id').in('parent_task_id', ids.slice(0, 500)).is('archived_at', null); (s.data || []).forEach(x => { subCounts[x.parent_task_id] = (subCounts[x.parent_task_id] || 0) + 1; }); }
                paint();
            } catch (e) { if (!silent) C.errorState(kbEl, e, () => reload()); }
        }
        function addCard(colId) {
            const col = bs.columns.find(c => c.id === colId) || bs.columns[0];
            if (!col) return C.alert({ title: 'Add a column first', message: 'Cards live in columns.' });
            const pos = L.positionBetween(Math.max(0, ...bs.cards.filter(t => t.board_column_id === col.id).map(t => Number(t.position) || 0)), null);
            C.openTaskEditor({ defaults: { board_id: id, board_column_id: col.id, project_id: board.project_id || undefined, assignee_id: me.id, position: pos }, onSaved: () => reload() });
        }
        on('#add-card', () => addCard(bs.columns[0] && bs.columns[0].id));
        on('#add-col', () => openColumnEditor(null));
        view.querySelector('#f-assignee').addEventListener('change', e => { bs.assignee = e.target.value; paint(); });
        on('#more-btn', e => {
            const items = [{ label: 'Open in Tasks', icon: 'tasks', href: '/tasks/' }];
            if (project) items.push({ label: 'Open project', icon: 'folder', href: `/projects/?id=${project.id}` });
            if (canManage(board)) items.push('sep', { label: 'Edit board', icon: 'edit', onClick: () => openBoardEditor(board, () => showBoard(id)) }, board.archived_at ? { label: 'Restore', icon: 'refresh', onClick: () => setArchived(board, false, () => showBoard(id)) } : { label: 'Archive board', icon: 'trash', danger: true, onClick: () => setArchived(board, true, () => showBoard(id)) }, { label: 'Delete permanently', icon: 'trash', danger: true, onClick: () => deleteBoard(board) });
            C.menu(e.currentTarget, items);
        });

        /* ---- columns ---- */
        function statusOptions(sel) { return [{ value: '', label: 'No status change' }, ...lk.taskStatuses.map(s => ({ value: s.key, label: s.label }))]; }
        function openColumnEditor(col) {
            const isNew = !col;
            return C.formModal({
                title: isNew ? 'Add column' : `Edit "${col.name}"`,
                fields: [
                    { name: 'name', label: 'Column name', type: 'text', required: true, full: true },
                    { name: 'maps_to_status', label: 'Cards dropped here become', type: 'select', options: statusOptions(), hint: 'Optional: moving a card into this column sets the task status.' },
                    { name: 'color', label: 'Colour', type: 'select', options: COLORS.map(c => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1) })) },
                    { name: 'wip_limit', label: 'WIP limit', type: 'number', min: 1, step: 1, hint: 'Show a warning when the column holds more cards than this.' },
                ],
                values: isNew ? { color: 'pending' } : { name: col.name, maps_to_status: col.maps_to_status || '', color: col.color || 'pending', wip_limit: col.wip_limit },
                submitLabel: isNew ? 'Add column' : 'Save',
                onSubmit: async v => {
                    const row = { name: v.name.trim(), maps_to_status: v.maps_to_status || null, color: v.color || null, wip_limit: v.wip_limit || null };
                    if (isNew) await C.q(sb.from('board_columns').insert({ ...row, board_id: id, position: Math.max(0, ...bs.columns.map(c => c.position)) + 1 }));
                    else await C.q(sb.from('board_columns').update(row).eq('id', col.id));
                    C.toast(isNew ? 'Column added' : 'Column saved', 'ok'); reload();
                },
            });
        }
        async function moveColumn(col, dir) {
            const sorted = bs.columns.slice().sort((a, b) => a.position - b.position);
            const i = sorted.findIndex(c => c.id === col.id), j = i + dir;
            if (j < 0 || j >= sorted.length) return;
            const other = sorted[j];
            try {
                // Renumber all columns so the swap never produces duplicate positions.
                sorted[i] = other; sorted[j] = col;
                await Promise.all(sorted.map((c, idx) => C.q(sb.from('board_columns').update({ position: idx + 1 }).eq('id', c.id))));
                reload(true);
            } catch (e) { C.toast(e.message, 'bad'); }
        }
        async function deleteColumn(col) {
            const cards = bs.cards.filter(t => t.board_column_id === col.id);
            const others = bs.columns.filter(c => c.id !== col.id);
            if (cards.length) {
                if (!others.length) return C.alert({ title: 'Cannot delete', message: 'This column still has cards and there is no other column to move them to. Add another column first.' });
                const r = await C.formModal({
                    title: `"${col.name}" has ${cards.length} card${cards.length > 1 ? 's' : ''}`,
                    intro: '<div class="crm-warn">Choose where the cards should go before the column is removed.</div>',
                    fields: [{ name: 'to', label: 'Move cards to', type: 'select', options: others.map(c => ({ value: c.id, label: c.name })), required: true, full: true }],
                    submitLabel: 'Move cards and delete column',
                    onSubmit: async v => {
                        await C.q(sb.from('tasks').update({ board_column_id: v.to }).eq('board_column_id', col.id));
                        await C.q(sb.from('board_columns').delete().eq('id', col.id));
                        C.toast('Column deleted', 'ok'); reload();
                    },
                });
                return r;
            }
            if (!await C.confirm({ title: `Delete column "${col.name}"?`, message: 'The column is empty; nothing else changes.', okText: 'Delete', danger: true })) return;
            try { await C.q(sb.from('board_columns').delete().eq('id', col.id)); C.toast('Column deleted', 'ok'); reload(); } catch (e) { C.toast(e.message, 'bad'); }
        }
        function columnMenu(colView, anchor, extra) {
            const col = bs.columns.find(c => c.id === colView.id); if (!col) return;
            const items = [{ label: extra && extra.collapsed ? 'Expand' : 'Collapse', icon: 'collapse', onClick: () => extra.toggleCollapse() }, { label: 'Add card here', icon: 'plus', onClick: () => addCard(col.id) }];
            if (manage) items.push('sep',
                { label: 'Rename / settings', icon: 'edit', onClick: () => openColumnEditor(col) },
                { label: 'Move left', icon: 'arrow', onClick: () => moveColumn(col, -1) },
                { label: 'Move right', icon: 'arrow', onClick: () => moveColumn(col, 1) },
                'sep',
                { label: 'Delete column', icon: 'trash', danger: true, onClick: () => deleteColumn(col) });
            C.menu(anchor, items);
        }

        /* ---- card modal ---- */
        async function openCard(card) {
            const t = bs.cards.find(x => x.id === card.id) || card;
            const editable = L.canEdit({ created_by: t.created_by, assignee_id: t.assignee_id }, me) || ctx.isManager || onProject;
            const f = C.form([
                { name: 'title', label: 'Title', type: 'text', required: true, full: true, disabled: !editable },
                { name: 'status', label: 'Status', type: 'select', options: lk.taskStatuses.map(s => ({ value: s.key, label: s.label })), required: true, disabled: !editable },
                { name: 'priority', label: 'Priority', type: 'select', options: Object.entries(L.PRIORITY).map(([k, p]) => ({ value: k, label: p.label })), required: true, disabled: !editable },
                { name: 'assignee_id', label: 'Assignee', type: 'people', disabled: !editable },
                { name: 'due_date', label: 'Due date', type: 'date', disabled: !editable },
                { name: 'board_column_id', label: 'Column', type: 'select', options: bs.columns.map(c => ({ value: c.id, label: c.name })), required: true, disabled: !editable },
                { name: 'description', label: 'Description', type: 'textarea', full: true, rows: 4, disabled: !editable },
            ], { ...t, board_column_id: t.board_column_id || (bs.columns[0] && bs.columns[0].id) });
            const body = document.createElement('div');
            body.appendChild(f.el);
            body.insertAdjacentHTML('beforeend', `<div class="crm-section-title" style="margin-top:18px"><h3>Attachments</h3></div><div id="card-docs"></div><div class="crm-section-title" style="margin-top:18px"><h3>Comments &amp; history</h3></div><div id="card-composer"></div><div id="card-activity"></div>`);
            const m = C.modal({
                title: t.title, size: 'wide', body,
                actions: [
                    { label: 'Open full page', ghost: true, onClick: () => { location.href = `/tasks/?id=${t.id}`; } },
                    { label: 'Close', close: true },
                    ...(editable ? [{ label: 'Save', primary: true, onClick: async api => {
                        if (!f.validate()) return;
                        const v = f.get();
                        const { data: upd } = await C.q(sb.from('tasks').update({ title: v.title.trim(), status: v.status, priority: v.priority, assignee_id: v.assignee_id || null, due_date: v.due_date || null, board_column_id: v.board_column_id, description: v.description || null }).eq('id', t.id).select('id'));
                        if (!upd || !upd.length) throw new Error('You do not have permission to change this card.');
                        if (v.assignee_id && v.assignee_id !== t.assignee_id) C.pushNotify({ to: v.assignee_id, title: 'Task assigned to you', body: v.title, url: `/tasks/?id=${t.id}`, tag: 'task' });
                        C.toast('Card saved', 'ok'); WSShell.refreshUnread(); api.close(); reload();
                    } }] : []),
                ],
            });
            // Keep the column and status selects in step: a column that maps to a status implies that status.
            f.field('board_column_id').el.addEventListener('change', e => { const col = bs.columns.find(c => c.id === e.target.value); if (col && col.maps_to_status) f.field('status').set(col.maps_to_status); });
            C.documents(m.body.querySelector('#card-docs'), { entity_type: 'task', entity_id: t.id, canEdit: editable });
            const feed = C.activityFeed(m.body.querySelector('#card-activity'), { entity_type: 'task', entity_id: t.id, limit: 50 });
            C.comments(m.body.querySelector('#card-composer'), { entity_type: 'task', entity_id: t.id, onPosted: () => feed.reload() });
        }

        await reload();
        unsubscribe = C.subscribe('board', [{ event: '*', table: 'tasks', filter: `board_id=eq.${id}` }], C.debounce(() => reload(true), 800));
    }

    route();
})();
