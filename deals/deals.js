/* ============================================================================
   Deals — pipelines in the workspace layout: Kanban (stages as columns),
   list and activities views with the "Filter + search" bar, and the deal card
   (a slide-over) with stages, editable fields, custom fields, products,
   to-dos, meetings, documents, invoices, projects and history. Stage rules
   (status, probability, close date) are enforced by the crm_deals triggers.

   URLs:  /deals/                  Kanban of the chosen pipeline
          /deals/?view=list|activity   /deals/?pipeline=<uuid>
          /deals/?id=<uuid>        the deal card (also inside a slide-over)
          /deals/?new=1            opens "Create deal"
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc, B = window.WSB24;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'deals', crumb: 'Deals', layout: 'b24' });
    const sb = ctx.sb, me = ctx.user;

    const SOURCES = ['Website', 'Referral', 'Cold call', 'Email campaign', 'Social media', 'Event', 'Partner', 'Walk-in', 'Other'];
    const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED'];
    const COLORS = ['pending', 'late', 'leave', 'holiday', 'present', 'absent', 'weekoff'];
    const BASE = 'id, company, title, contact_id, organization, owner_id, pipeline_id, stage_id, value, currency, probability, expected_close_date, actual_close_date, status, source, description, lead_id, tags, position, archived_at, created_by, created_at, updated_at, contact:crm_contacts(id, full_name, organization)';
    const [cols, invLv] = await Promise.all([
        B.columns('crm_deals', BASE + ', number, custom, company_id, amount_from_products, company_rec:crm_companies(id, title)', BASE),
        B.levels('invoice'),
    ]);
    const SELECT = cols.select;
    let lk = await C.lookups();

    const page = { mode: null, pipeline: '', grid: null, board: null, filter: null, lv: null, cf: [], unsub: null };
    function pipelineOf(id) { return lk.pipelines.find(p => p.id === id) || null; }
    function stagesFor(pid) { return L.stagesOf(lk.stages, pid); }
    function outcomeStage(pid, kind) { return stagesFor(pid).find(s => kind === 'won' ? s.is_won : s.is_lost) || null; }
    function stageHex(s) { const list = stagesFor(s.pipeline_id); return B.hex(s.color, list.indexOf(s)); }
    function stagePill(stageId) { const s = lk.stageById[stageId]; return s ? `<span class="b24-stage-pill" style="--c:${stageHex(s)}">${esc(s.name)}</span>` : ''; }
    function contactName(d) { return d.contact ? (d.contact.full_name || d.contact.organization) : ''; }
    function companyName(d) { return (d.company_rec && d.company_rec.title) || d.organization || ''; }
    const canEditDeal = (d, lv) => B.allowed((lv || page.lv).edit, d, me);
    const canDeleteDeal = (d, lv) => B.allowed((lv || page.lv).delete, d, me);
    function initialPipeline() {
        const p = C.param('pipeline');
        if (p && pipelineOf(p)) return p;
        let s = null; try { s = localStorage.getItem('ws-deals-pipeline'); } catch (e) { /* private mode */ }
        if (s && pipelineOf(s)) return s;
        return (lk.defaultPipeline && lk.defaultPipeline.id) || (lk.pipelines[0] && lk.pipelines[0].id) || '';
    }

    /* ------------------------------------------------------------ routing */
    function route() {
        const id = C.param('id');
        if (id) return showRecord(id);
        if (page.mode === 'list') return refreshList();
        return showList();
    }
    window.addEventListener('popstate', route);
    const openDeal = id => B.openRecord(`/deals/?id=${id}`, refreshList);

    /* --------------------------------------------------------- deal form */
    async function openDealEditor(defaults, onSaved) {
        lk = await C.lookups();
        if (!lk.pipelines.length) {
            return C.alert({ title: 'No pipeline yet', message: ctx.isManager ? 'Configure a pipeline first (the gear next to the filter).' : 'Ask a manager to set up a sales pipeline first.' });
        }
        const d = defaults || {};
        const pipelineId = d.pipeline_id || page.pipeline || (lk.defaultPipeline && lk.defaultPipeline.id) || lk.pipelines[0].id;
        const stageOpts = pid => stagesFor(pid).map(s => ({ value: s.id, label: s.name + (s.is_won ? ' (won)' : s.is_lost ? ' (lost)' : '') }));
        const firstStage = d.stage_id || (L.firstOpenStage(lk.stages, pipelineId) || stagesFor(pipelineId)[0] || {}).id || '';
        let orgField = null;
        const fields = [
            { name: 'title', label: 'Deal name', type: 'text', required: true, full: true, placeholder: 'e.g. Annual supply contract' },
            { name: 'contact_id', label: 'Contact', type: 'entity', entity: 'contact', placeholder: 'Search contacts', valueLabel: d.contact_label || undefined,
              onChange: id => { if (id && orgField && !orgField.get()) sb.from('crm_contacts').select('organization').eq('id', id).maybeSingle().then(r => { if (r.data && r.data.organization && !orgField.get()) orgField.set(r.data.organization); }); } },
            ...(cols.full ? [{ name: 'company_id', label: 'Company', type: 'entity', entity: 'company', placeholder: 'Search companies' }] : []),
            { name: 'organization', label: 'Company name (text)', type: 'text' },
            { name: 'owner_id', label: 'Responsible', type: 'people', none: 'Not assigned' },
            { name: 'pipeline_id', label: 'Pipeline', type: 'select', options: lk.pipelines.map(p => ({ value: p.id, label: p.name })), required: true },
            { name: 'stage_id', label: 'Stage', type: 'select', options: stageOpts(pipelineId), required: true },
            { name: 'value', label: 'Amount', type: 'money', required: true },
            { name: 'currency', label: 'Currency', type: 'select', options: CURRENCIES, required: true },
            { name: 'expected_close_date', label: 'Expected close', type: 'date' },
            { name: 'source', label: 'Source', type: 'select', options: SOURCES, placeholder: 'Source' },
            { name: 'tags', label: 'Tags', type: 'tags', full: true },
            { name: 'description', label: 'Comment', type: 'textarea', full: true },
        ];
        return C.formModal({
            title: 'New deal', size: 'wide', fields, submitLabel: 'Create deal',
            values: { owner_id: d.owner_id || me.id, pipeline_id: pipelineId, stage_id: firstStage, value: d.value != null ? d.value : 0, currency: 'INR', contact_id: d.contact_id || null, company_id: d.company_id || null, organization: d.organization || '', title: d.title || '', source: d.source || '' },
            onReady: f => {
                orgField = f.field('organization');
                f.field('pipeline_id').el.addEventListener('change', e => {
                    f.field('stage_id').el.innerHTML = stageOpts(e.target.value).map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
                    const open = L.firstOpenStage(lk.stages, e.target.value); if (open) f.field('stage_id').set(open.id);
                });
            },
            onSubmit: async v => {
                const row = {
                    title: v.title.trim(), contact_id: v.contact_id || null, organization: v.organization ? v.organization.trim() || null : null,
                    owner_id: v.owner_id || null, pipeline_id: v.pipeline_id, stage_id: v.stage_id, value: Number(v.value) || 0, currency: v.currency,
                    expected_close_date: v.expected_close_date || null, source: v.source || null, tags: v.tags || [], description: v.description || null, created_by: me.id,
                };
                if (cols.full) row.company_id = v.company_id || null;
                if (d.lead_id) row.lead_id = d.lead_id;
                const saved = (await C.q(sb.from('crm_deals').insert(row).select(SELECT).single())).data;
                if (saved.owner_id && saved.owner_id !== me.id) C.pushNotify({ to: saved.owner_id, title: 'Deal assigned to you', body: saved.title, url: `/deals/?id=${saved.id}`, tag: 'crm' });
                C.toast('Deal created', 'ok');
                if (onSaved) onSaved(saved);
                return saved;
            },
        });
    }
    async function updateDeal(d, patch) {
        if ('title' in patch && !String(patch.title || '').trim()) throw new Error('The deal needs a name.');
        const saved = (await C.q(sb.from('crm_deals').update(patch).eq('id', d.id).select(SELECT).single())).data;
        if ('owner_id' in patch && saved.owner_id && saved.owner_id !== me.id && saved.owner_id !== d.owner_id) C.pushNotify({ to: saved.owner_id, title: 'Deal assigned to you', body: saved.title, url: `/deals/?id=${saved.id}`, tag: 'crm' });
        Object.assign(d, saved);
        if (window.WSShell && WSShell.inSlider) WSShell.sliderMessage('changed', { id: d.id });
        return saved;
    }

    /* ------------------------------------------------------- stage moves */
    async function moveToStage(deal, stage, position) {
        if (!stage) return false;
        if ((stage.is_won || stage.is_lost) && deal.stage_id !== stage.id) {
            const ok = await C.confirm({ title: stage.is_won ? 'Mark this deal as won?' : 'Mark this deal as lost?', message: `${deal.title} · ${L.money(deal.value, deal.currency)} will be closed as ${stage.is_won ? 'won' : 'lost'} today. You can move it back to an open stage later.`, okText: stage.is_won ? 'Deal won' : 'Deal lost', danger: stage.is_lost });
            if (!ok) return false;
        }
        const patch = { stage_id: stage.id };
        if (position != null) patch.position = position;
        const { data } = await C.q(sb.from('crm_deals').update(patch).eq('id', deal.id).select('id, status, stage_id, probability, actual_close_date').single());
        Object.assign(deal, data);
        if (data.status === 'won') C.toast(`${deal.title} won`, 'ok');
        else if (data.status === 'lost') C.toast(`${deal.title} marked as lost`, '');
        else C.toast(`Moved to ${stage.name}`, 'ok');
        if (window.WSShell && WSShell.inSlider) WSShell.sliderMessage('changed', { id: deal.id });
        return true;
    }
    async function setArchived(deal, archived, after) {
        if (archived && !await C.confirm({ title: `Archive ${deal.title}?`, message: 'The deal disappears from the board and lists but keeps its history, tasks and documents. You can restore it later.', okText: 'Archive', danger: true })) return;
        try { await updateDeal(deal, { archived_at: archived ? new Date().toISOString() : null }); C.toast(archived ? 'Deal archived' : 'Deal restored', 'ok'); if (after) after(); }
        catch (e) { C.toast(e.message, 'bad'); }
    }
    async function deleteDeal(deal, after) {
        if (!await C.confirm({ title: 'Delete this deal permanently?', message: 'Its activity history, tasks and invoices lose the link. Archiving is usually the better choice.', okText: 'Delete permanently', danger: true })) return;
        try {
            await C.q(sb.from('crm_deals').delete().eq('id', deal.id));
            C.toast('Deal deleted', 'ok');
            if (window.WSShell && WSShell.inSlider) { WSShell.sliderMessage('deleted', { id: deal.id }); WSShell.closeSlider(); }
            else if (after) after(); else location.href = '/deals/';
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function duplicateDeal(deal) {
        try {
            const row = {
                title: `${deal.title} (copy)`, contact_id: deal.contact_id, organization: deal.organization, owner_id: deal.owner_id,
                pipeline_id: deal.pipeline_id, stage_id: (L.firstOpenStage(lk.stages, deal.pipeline_id) || { id: deal.stage_id }).id,
                value: deal.value, currency: deal.currency, expected_close_date: deal.expected_close_date, source: deal.source, description: deal.description, tags: deal.tags || [], created_by: me.id,
            };
            if (cols.full) { row.company_id = deal.company_id; row.custom = deal.custom || {}; }
            const { data } = await C.q(sb.from('crm_deals').insert(row).select('id').single());
            C.toast('Deal copied', 'ok'); openDeal(data.id);
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function logInteraction(d, action, title, after) {
        await C.formModal({
            title, fields: [
                { name: 'summary', label: 'What happened?', type: 'textarea', required: true, full: true, rows: 4 },
                { name: 'when', label: 'When', type: 'datetime', required: true, value: new Date().toISOString() },
            ],
            submitLabel: 'Save', onSubmit: async v => {
                await C.logActivity(action, 'deal', d.id, v.summary.slice(0, 200), { at: v.when, summary: v.summary }, { deal_id: d.id, contact_id: d.contact_id || null });
                C.toast('Saved', 'ok'); if (after) after();
            },
        });
    }

    /* ------------------------------------------------------ list page */
    function stageOptions() { return stagesFor(page.pipeline).map(s => ({ value: s.id, label: s.name })); }
    function filterFields() {
        return [
            { key: 'status', title: 'Deal status', type: 'select', options: [{ value: 'open', label: 'In progress' }, { value: 'won', label: 'Won' }, { value: 'lost', label: 'Lost' }] },
            { key: 'stage', title: 'Stage', type: 'multiselect', column: 'stage_id', options: stageOptions() },
            { key: 'owner', title: 'Responsible', type: 'user', column: 'owner_id', options: B.peopleOptions() },
            { key: 'value', title: 'Amount', type: 'number', column: 'value' },
            { key: 'close', title: 'Expected close', type: 'date', column: 'expected_close_date' },
            { key: 'created', title: 'Created', type: 'date', column: 'created_at', datetime: true, default: false },
            { key: 'source', title: 'Source', type: 'select', options: SOURCES, default: false },
            { key: 'organization', title: 'Company name', type: 'text', default: false },
            { key: 'tag', title: 'Tag', type: 'text', default: false, apply: (b, v) => b.contains('tags', [String(v).trim()]) },
            { key: 'archived', title: 'Archived', type: 'check', checkLabel: 'Only archived deals', default: false, apply: b => b },
            ...B.cfFilters(page.cf),
        ];
    }
    const PRESETS = [
        { key: 'open', title: 'Deals in progress', values: { status: 'open' } },
        { key: 'mine', title: 'My deals', values: { owner: 'me', status: 'open' } },
        { key: 'won', title: 'Won deals', values: { status: 'won' } },
        { key: 'lost', title: 'Lost deals', values: { status: 'lost' } },
        { key: 'all', title: 'All deals', values: {} },
        { key: 'archived', title: 'Archived deals', values: { archived: true } },
    ];
    function scoped(builder, opts) {
        const v = page.filter.get().values;
        builder = v.archived ? builder.not('archived_at', 'is', null) : builder.is('archived_at', null);
        if (!(opts && opts.allPipelines)) builder = builder.eq('pipeline_id', page.pipeline);
        return page.filter.apply(builder, { searchColumns: ['title', 'organization'] });
    }
    function readView() { const v = C.param('view'); if (['kanban', 'list', 'activity'].includes(v)) return v; try { return localStorage.getItem('ws-deals-view') || 'kanban'; } catch (e) { return 'kanban'; } }

    async function showList() {
        page.mode = 'list';
        WSShell.setCrumb('Deals');
        document.title = 'Deals · WorkSuite';
        lk = await C.lookups();
        page.pipeline = initialPipeline();
        [page.lv, page.cf] = await Promise.all([B.levels('deal', page.pipeline), B.customFields('deal', page.pipeline)]);
        const canAdd = page.lv.add !== 'none';
        const pipe = pipelineOf(page.pipeline);
        view.innerHTML = B.titleBar({
            title: 'Deals', createLabel: canAdd ? 'Create' : '', gear: ctx.isManager,
            afterTitle: lk.pipelines.length ? `<button type="button" class="b24-btn-glass" data-pipes aria-haspopup="menu">${esc(pipe ? pipe.name : 'Pipeline')} <span aria-hidden="true">▾</span></button>` : '',
        }) + `
            <div class="b24-toolbar">
                <div class="b24-views" role="tablist" aria-label="View">
                    <button type="button" role="tab" data-view="kanban">Kanban</button>
                    <button type="button" role="tab" data-view="list">List</button>
                    <button type="button" role="tab" data-view="activity">Activities</button>
                </div>
                <div class="b24-counters" id="counters"></div>
                <span class="grow"></span>
                <span class="b24-sum" id="sum"></span>
            </div>
            <div id="body"></div>`;
        page.filter = WSFilter.mount(view.querySelector('[data-filter]'), {
            id: 'deals', fields: filterFields(), presets: PRESETS, defaultPreset: 'open', me: me.id, onChange: () => refreshList(),
        });
        const create = view.querySelector('[data-create]');
        if (create) create.addEventListener('click', () => openDealEditor({ pipeline_id: page.pipeline }, d => { refreshList(); openDeal(d.id); }));
        const gear = view.querySelector('[data-gear]');
        if (gear) gear.addEventListener('click', () => C.menu(gear, [
            { label: 'Configure pipelines and stages', icon: 'board', onClick: () => openPipelineSettings(() => { lk = null; showList(); }) },
        ]));
        const pipes = view.querySelector('[data-pipes]');
        if (pipes) pipes.addEventListener('click', () => C.menu(pipes, lk.pipelines.map(p => ({ label: p.name + (p.id === page.pipeline ? '  ✓' : ''), icon: 'board', onClick: () => {
            try { localStorage.setItem('ws-deals-pipeline', p.id); } catch (e) { /* private mode */ }
            C.setParam('pipeline', p.id, true);
            const v = page.filter.get().values; delete v.stage;
            showList();
        } })).concat(ctx.isManager ? ['sep', { label: 'Configure pipelines', icon: 'edit', onClick: () => openPipelineSettings(() => showList()) }] : [])));
        view.querySelector('.b24-views').addEventListener('click', e => {
            const b = e.target.closest('[data-view]'); if (!b) return;
            try { localStorage.setItem('ws-deals-view', b.dataset.view); } catch (err) { /* private mode */ }
            C.setParam('view', b.dataset.view === 'kanban' ? null : b.dataset.view, true);
            mountView(b.dataset.view);
        });
        view.querySelector('#counters').addEventListener('click', e => {
            const b = e.target.closest('[data-counter]'); if (!b) return;
            page.filter.set({ overdue: { owner: 'me', status: 'open', close: { kind: 'before_today' } }, today: { owner: 'me', status: 'open', close: { kind: 'today' } }, unassigned: { owner: 'none', status: 'open' } }[b.dataset.counter]);
        });
        // A stage filter from another pipeline would hide everything.
        const v0 = page.filter.get().values;
        if (v0.stage && v0.stage.some(id => !stagesFor(page.pipeline).some(s => s.id === id))) { delete v0.stage; page.filter.set(v0); }
        mountView(readView());
        loadCounters();
        if (page.unsub) page.unsub();
        page.unsub = C.subscribe('deals', [{ table: 'crm_deals' }], C.debounce(() => refreshList(true), 900));
        if (C.param('new') === '1' && canAdd) { C.setParam('new', null, true); openDealEditor({ pipeline_id: page.pipeline }, d => { refreshList(); openDeal(d.id); }); }
    }
    function mountView(kind) {
        page.view = kind;
        view.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('on', b.dataset.view === kind); b.setAttribute('aria-selected', String(b.dataset.view === kind)); });
        if (page.grid) { page.grid.destroy(); page.grid = null; }
        if (page.board) { page.board.destroy(); page.board = null; }
        const body = view.querySelector('#body');
        body.innerHTML = '';
        view.querySelector('#sum').textContent = '';
        if (kind === 'kanban') return mountKanban(body);
        if (kind === 'activity') return mountActivities(body);
        return mountGrid(body);
    }
    function refreshList(quiet) {
        if (page.mode !== 'list') return;
        loadCounters();
        if (page.grid) return quiet ? page.grid.refresh() : page.grid.reload();
        if (page.view === 'kanban') return loadKanban();
    }
    async function loadCounters() {
        const el = view.querySelector('#counters'); if (!el) return;
        const today = L.todayIST();
        const head = () => sb.from('crm_deals').select('id', { count: 'exact', head: true }).is('archived_at', null).eq('status', 'open').eq('pipeline_id', page.pipeline);
        try {
            const [o, t, u] = await Promise.all([
                head().eq('owner_id', me.id).lt('expected_close_date', today),
                head().eq('owner_id', me.id).eq('expected_close_date', today),
                head().is('owner_id', null),
            ]);
            const n = r => (r && !r.error && r.count) || 0;
            el.innerHTML = `<span>My items:</span>
                <button type="button" class="b24-counter${n(o) ? ' red' : ''}" data-counter="overdue"><span class="n">${n(o)}</span>Overdue</button>
                <button type="button" class="b24-counter${n(t) ? ' green' : ''}" data-counter="today"><span class="n">${n(t)}</span>Closing today</button>
                <button type="button" class="b24-counter" data-counter="unassigned"><span class="n">${n(u)}</span>Not assigned</button>`;
        } catch (e) { el.innerHTML = ''; }
    }

    /* ----- Kanban ----- */
    function dealCard(c) {
        const d = c.deal;
        const due = d.status === 'open' && d.expected_close_date ? L.taskDueState({ due_date: d.expected_close_date }) : null;
        const who = contactName(d), co = companyName(d);
        return `<div class="b24-kcard">
            <a class="t" href="/deals/?id=${esc(d.id)}" data-open>${esc(d.title)}</a>
            <div class="amt">${esc(L.money(d.value, d.currency))}</div>
            ${who || co ? `<div class="org">${esc([who, co].filter(Boolean).join(' · '))}</div>` : ''}
            <div class="meta">${d.owner_id ? C.avatarHtml(d.owner_id, 'sm') : ''}<span class="when">${due ? `<span class="crm-due ${due}">${esc(L.fmtDate(d.expected_close_date, { short: true }))}</span>` : `<span class="muted">${esc(L.fmtRelative(d.created_at))}</span>`}</span></div>
        </div>`;
    }
    async function mountKanban(body) {
        const stages = stagesFor(page.pipeline);
        if (!stages.length) { body.innerHTML = '<div class="b24-area pad"></div>'; C.empty(body.firstElementChild, 'This pipeline has no stages', ctx.isManager ? 'Add stages with the gear next to the filter.' : 'Ask a manager to add stages.'); return; }
        body.innerHTML = '<div class="b24-board-area"><div id="kb"></div></div>';
        page.board = WSKanban.mount(body.querySelector('#kb'), {
            columns: [], cards: [], emptyText: 'Drop deals here', renderCard: dealCard,
            canDrag: c => canEditDeal(c.deal),
            onCardClick: (c, e) => { if (e) e.preventDefault(); openDeal(c.deal.id); },
            onAddCard: page.lv.add !== 'none' ? stageId => openDealEditor({ pipeline_id: page.pipeline, stage_id: stageId }, d => { loadKanban(); openDeal(d.id); }) : null,
            onMove: async ({ card, toColumnId, position }) => {
                const ok = await moveToStage(card.deal, lk.stageById[toColumnId], position);
                if (ok === false) { loadKanban(); return; }
                loadCounters();
                if (card.deal.status !== 'open') loadKanban();
            },
            onColumnMenu: (col, anchor, api) => C.menu(anchor, [
                { label: api.collapsed ? 'Expand column' : 'Collapse column', icon: 'collapse', onClick: api.toggleCollapse },
                ...(page.lv.add !== 'none' ? [{ label: 'Add deal here', icon: 'plus', onClick: () => openDealEditor({ pipeline_id: page.pipeline, stage_id: col.id }, () => loadKanban()) }] : []),
            ]),
        });
        await loadKanban();
    }
    async function loadKanban() {
        if (!page.board) return;
        try {
            const { data } = await C.q(scoped(sb.from('crm_deals').select(SELECT)).order('position', { ascending: true }).order('updated_at', { ascending: false }).limit(1000));
            const rows = data || [];
            const columns = stagesFor(page.pipeline).map(s => {
                const inCol = rows.filter(d => d.stage_id === s.id);
                return { id: s.id, name: s.name, hex: stageHex(s), sum: L.money(inCol.reduce((a, d) => a + Number(d.value || 0), 0), (inCol[0] || {}).currency || 'INR', { whole: true }) };
            });
            page.board.update({ columns, cards: rows.map(d => ({ id: d.id, columnId: d.stage_id, position: Number(d.position) || 0, deal: d })) });
            const open = rows.filter(d => d.status === 'open');
            view.querySelector('#sum').innerHTML = `${rows.length}${rows.length >= 1000 ? '+' : ''} deals · <b>${esc(L.money(open.reduce((a, d) => a + Number(d.value || 0), 0), 'INR', { whole: true }))}</b> in progress`;
        } catch (e) { C.errorState(view.querySelector('#kb'), e, loadKanban); }
    }

    /* ----- List ----- */
    function gridColumns() {
        const people = [{ value: '', label: 'Not assigned' }].concat(B.peopleOptions());
        const can = page.lv.edit !== 'none';
        const save = key => async (r, v) => { if (!canEditDeal(r)) throw new Error('You do not have permission to change this deal.'); await updateDeal(r, { [key]: v }); };
        return [
            ...(cols.full ? [{ key: 'number', title: 'ID', width: 70, render: r => esc(r.number == null ? '' : r.number) }] : []),
            { key: 'title', title: 'Deal', width: 250, render: r => `<a href="/deals/?id=${esc(r.id)}" data-open>${esc(r.title)}</a>${companyName(r) ? `<span class="sub">${esc(companyName(r))}</span>` : ''}`, edit: can ? { type: 'text', save: save('title') } : undefined },
            { key: 'stage_id', title: 'Stage', width: 170, sortable: false, render: r => stagePill(r.stage_id),
              edit: can ? { type: 'select', options: r => stagesFor(r.pipeline_id).map(s => ({ value: s.id, label: s.name })), save: async (r, v) => { if (!canEditDeal(r)) throw new Error('You do not have permission to change this deal.'); const ok = await moveToStage(r, lk.stageById[v]); if (ok === false) throw new Error('Stage not changed'); } } : undefined },
            { key: 'value', title: 'Amount', width: 140, align: 'right', render: r => esc(L.money(r.value, r.currency)), edit: can ? { type: 'money', save: save('value') } : undefined },
            { key: 'owner_id', title: 'Responsible', width: 180, render: r => C.personHtml(r.owner_id, { link: false }), edit: can ? { type: 'people', options: people, save: save('owner_id') } : undefined },
            { key: 'contact_id', title: 'Contact', width: 180, sortable: false, render: r => r.contact_id ? `<a href="/contacts/?id=${esc(r.contact_id)}" data-contact="${esc(r.contact_id)}">${esc(contactName(r) || 'Contact')}</a>` : '' },
            { key: 'expected_close_date', title: 'Expected close', width: 140, render: r => r.expected_close_date ? `<span class="crm-due ${r.status === 'open' ? L.taskDueState({ due_date: r.expected_close_date }) : ''}">${esc(L.fmtDate(r.expected_close_date))}</span>` : '', edit: can ? { type: 'date', save: save('expected_close_date') } : undefined },
            { key: 'probability', title: 'Probability', width: 110, align: 'right', render: r => `${esc(r.probability)}%` },
            { key: 'status', title: 'Status', width: 110, default: false, render: r => C.statusBadge(L.DEAL_STATUS, r.status) },
            { key: 'source', title: 'Source', width: 130, default: false, render: r => esc(r.source || '') },
            { key: 'created_at', title: 'Created', width: 120, render: r => `<span class="muted">${esc(L.fmtDate(r.created_at, { short: true }))}</span>` },
            { key: 'updated_at', title: 'Modified', width: 120, default: false, render: r => `<span class="muted">${esc(L.fmtRelative(r.updated_at))}</span>` },
            { key: 'tags', title: 'Tags', width: 160, default: false, sortable: false, render: r => C.tagsHtml(r.tags) },
            ...B.cfColumns(page.cf),
        ];
    }
    function mountGrid(body) {
        const host = document.createElement('div');
        body.appendChild(host);
        const bulk = [];
        if (page.lv.edit !== 'none') {
            bulk.push({ label: 'Assign responsible', icon: 'user', run: async (ids, o) => {
                const v = await B.pick('Assign responsible', { type: 'people', label: 'Responsible', none: 'Not assigned' }, '');
                if (v === undefined) return false;
                await bulkUpdate(ids, o, { owner_id: v || null });
                if (v && v !== me.id) C.pushNotify({ to: v, title: 'Deals assigned to you', body: '', url: '/deals/', tag: 'crm' });
            } });
            bulk.push({ label: 'Move to stage', icon: 'board', run: async (ids, o) => {
                const v = await B.pick('Move to stage', { type: 'select', label: 'Stage', required: true, options: stageOptions() }, (L.firstOpenStage(lk.stages, page.pipeline) || {}).id);
                if (!v) return false;
                const s = lk.stageById[v];
                if ((s.is_won || s.is_lost) && !await C.confirm({ title: `Close these deals as ${s.is_won ? 'won' : 'lost'}?`, message: 'They will be closed today.', okText: 'Confirm', danger: s.is_lost })) return false;
                await bulkUpdate(ids, o, { stage_id: v });
            } });
            bulk.push({ label: 'Archive', icon: 'trash', run: async (ids, o) => {
                if (!await C.confirm({ title: o.all ? 'Archive every deal in this filter?' : `Archive ${ids.length} deal${ids.length > 1 ? 's' : ''}?`, message: 'Archived deals leave the board and lists but keep their history.', okText: 'Archive', danger: true })) return false;
                await bulkUpdate(ids, o, { archived_at: new Date().toISOString() });
            } });
        }
        if (page.lv.delete !== 'none') bulk.push({ label: 'Delete', icon: 'trash', danger: true, run: async (ids, o) => {
            if (!await C.confirm({ title: o.all ? 'Delete every deal in this filter?' : `Delete ${ids.length} deal${ids.length > 1 ? 's' : ''} permanently?`, message: 'Their history goes with them.', okText: 'Delete permanently', danger: true })) return false;
            let b = sb.from('crm_deals').delete();
            await C.q(o.all ? scoped(b) : b.in('id', ids));
            C.toast('Deleted', 'ok');
        } });
        page.grid = WSGrid.mount(host, {
            id: 'deals', columns: gridColumns(), sort: { key: 'updated_at', dir: 'desc' },
            load: async ({ offset, limit, sort }) => {
                let b = scoped(sb.from('crm_deals').select(SELECT));
                b = sort ? b.order(sort.key, { ascending: sort.dir === 'asc', nullsFirst: false }) : b.order('updated_at', { ascending: false });
                return (await C.q(b.range(offset, offset + limit - 1))).data || [];
            },
            count: async () => (await C.q(scoped(sb.from('crm_deals').select('id', { count: 'exact', head: true })))).count || 0,
            onOpen: r => openDeal(r.id),
            rowMenu: r => {
                const edit = canEditDeal(r), items = [{ label: 'Open', icon: 'arrow', onClick: () => openDeal(r.id) }];
                if (edit) {
                    const won = outcomeStage(r.pipeline_id, 'won'), lost = outcomeStage(r.pipeline_id, 'lost');
                    if (r.status !== 'won' && won) items.push({ label: 'Deal won', icon: 'check', onClick: () => moveToStage(r, won).then(() => refreshList(true)).catch(e => C.toast(e.message, 'bad')) });
                    if (r.status === 'open' && lost) items.push({ label: 'Deal lost', icon: 'x', onClick: () => moveToStage(r, lost).then(() => refreshList(true)).catch(e => C.toast(e.message, 'bad')) });
                }
                items.push({ label: 'Add to-do', icon: 'tasks', onClick: () => C.openTaskEditor({ defaults: { deal_id: r.id, contact_id: r.contact_id || null, title: '', assignee_id: r.owner_id || me.id }, onSaved: () => refreshList(true) }) });
                if (page.lv.add !== 'none') items.push({ label: 'Copy', icon: 'plus', onClick: () => duplicateDeal(r) });
                if (edit) items.push('sep', r.archived_at ? { label: 'Restore', icon: 'refresh', onClick: () => setArchived(r, false, refreshList) } : { label: 'Archive', icon: 'trash', onClick: () => setArchived(r, true, refreshList) });
                if (canDeleteDeal(r)) items.push({ label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteDeal(r, refreshList) });
                return items;
            },
            bulk,
            empty: { title: 'No deals match this filter', sub: 'Change the filter or create a deal.' },
        });
        host.addEventListener('click', e => { const a = e.target.closest('[data-contact]'); if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); B.openRecord(`/contacts/?id=${a.dataset.contact}`, () => refreshList(true)); } });
    }
    async function bulkUpdate(ids, o, patch) {
        let b = sb.from('crm_deals').update(patch);
        await C.q(o.all ? scoped(b) : b.in('id', ids));
        C.toast('Updated', 'ok');
        loadCounters();
    }

    /* ----- Activities: open to-dos on deals ----- */
    function mountActivities(body) {
        const host = document.createElement('div');
        body.appendChild(host);
        const names = new Map();
        page.grid = WSGrid.mount(host, {
            id: 'deals-activity', sort: { key: 'due_date', dir: 'asc' },
            columns: [
                { key: 'title', title: 'To-do', width: 280, render: t => `<a href="/tasks/?id=${esc(t.id)}" data-task="${esc(t.id)}">${esc(t.title)}</a>` },
                { key: 'deal_id', title: 'Deal', width: 220, sortable: false, render: t => `<a href="/deals/?id=${esc(t.deal_id)}" data-deal="${esc(t.deal_id)}">${esc(names.get(t.deal_id) || 'Deal')}</a>` },
                { key: 'due_date', title: 'Deadline', width: 150, render: t => C.dueHtml(t) },
                { key: 'assignee_id', title: 'Responsible', width: 180, render: t => C.personHtml(t.assignee_id, { link: false }) },
                { key: 'status', title: 'Status', width: 140, render: t => C.statusBadge(lk.taskStatus || {}, t.status) },
            ],
            load: async ({ offset, limit, sort }) => {
                let b = sb.from('tasks').select('id, title, status, assignee_id, due_date, completed_at, deal_id, created_at').not('deal_id', 'is', null).is('completed_at', null).is('archived_at', null);
                const v = page.filter.get().values;
                if (v.owner === 'me') b = b.eq('assignee_id', me.id); else if (v.owner && v.owner !== 'none') b = b.eq('assignee_id', v.owner);
                b = sort ? b.order(sort.key, { ascending: sort.dir === 'asc', nullsFirst: false }) : b.order('due_date', { ascending: true, nullsFirst: false });
                const rows = (await C.q(b.range(offset, offset + limit - 1))).data || [];
                const missing = [...new Set(rows.map(t => t.deal_id))].filter(id => !names.has(id));
                if (missing.length) { const r = await sb.from('crm_deals').select('id, title').in('id', missing); (r.data || []).forEach(x => names.set(x.id, x.title)); }
                return rows;
            },
            empty: { title: 'No open to-dos on deals', sub: 'To-dos created from a deal card show up here.' },
        });
        host.addEventListener('click', e => {
            const t = e.target.closest('[data-task]'); if (t) { e.preventDefault(); B.openRecord(`/tasks/?id=${t.dataset.task}`, () => refreshList(true)); return; }
            const d = e.target.closest('[data-deal]'); if (d) { e.preventDefault(); openDeal(d.dataset.deal); }
        });
    }
    view.addEventListener('click', e => {
        const a = e.target.closest('a[data-open]');
        if (!a || e.metaKey || e.ctrlKey || e.shiftKey || page.mode !== 'list') return;
        e.preventDefault();
        const id = new URL(a.href, location.href).searchParams.get('id');
        if (id) openDeal(id);
    });

    /* ------------------------------------------------------------- card */
    async function showRecord(id) {
        page.mode = 'record';
        if (page.unsub) { page.unsub(); page.unsub = null; }
        if (page.grid) { page.grid.destroy(); page.grid = null; }
        if (page.board) { page.board.destroy(); page.board = null; }
        C.loading(view, 'Loading deal…');
        let d;
        try { d = (await C.q(sb.from('crm_deals').select(SELECT).eq('id', id).maybeSingle())).data; }
        catch (e) { return C.errorState(view, e, () => showRecord(id)); }
        if (!d) { view.innerHTML = '<div class="b24-area pad"></div>'; C.empty(view.firstElementChild, 'Deal not found', 'It may have been deleted, or you may not have access to it.', '<a class="ws-btn" href="/deals/">All deals</a>'); return; }
        lk = await C.lookups();
        const [lv, cf] = await Promise.all([B.levels('deal', d.pipeline_id), B.customFields('deal', d.pipeline_id)]);
        const edit = canEditDeal(d, lv);
        const stages = stagesFor(d.pipeline_id);
        const pipeline = pipelineOf(d.pipeline_id) || {};
        document.title = `${d.title} · Deals · WorkSuite`;
        WSShell.setCrumb(d.title);
        const [tasks, events, invoices, projects] = await Promise.all([
            C.related('tasks', 'deal_id', id, 'id, title, status, priority, assignee_id, due_date, completed_at, archived_at, created_at', b => b.is('archived_at', null)),
            C.related('calendar_events', 'deal_id', id, 'id, title, starts_at, ends_at, event_type, status, owner_id', b => b.order('starts_at', { ascending: false })),
            invLv.read !== 'none' ? C.related('invoices', 'deal_id', id, 'id, invoice_number, invoice_date, due_date, status, total, amount_paid, balance, currency') : Promise.resolve([]),
            C.related('projects', 'deal_id', id, 'id, name, status, due_date'),
        ]);
        const refresh = () => showRecord(id);
        const save = key => async v => { await updateDeal(d, { [key]: v }); };
        const links = { deal_id: id, contact_id: d.contact_id || null };
        const newTask = () => C.openTaskEditor({ defaults: { ...links, title: '', assignee_id: d.owner_id || me.id }, onSaved: refresh });
        const newMeet = () => C.openEventEditor({ defaults: { ...links, title: `Meeting: ${d.title}` }, onSaved: refresh });

        const menu = [];
        if (lv.add !== 'none') menu.push({ label: 'Copy deal', icon: 'plus', onClick: () => duplicateDeal(d) });
        if (invLv.add !== 'none') menu.push({ label: 'Create invoice', icon: 'invoice', onClick: () => { window.top.location.href = `/invoices/?new=1&deal_id=${d.id}${d.contact_id ? '&contact_id=' + d.contact_id : ''}`; } });
        menu.push({ label: 'Create project', icon: 'folder', onClick: () => { window.top.location.href = `/projects/?new=1&deal_id=${d.id}${d.contact_id ? '&contact_id=' + d.contact_id : ''}`; } });
        menu.push({ label: 'Log a call', icon: 'phone', onClick: () => logInteraction(d, 'call.logged', 'Log a call', refresh) });
        if (edit) {
            if (d.status !== 'open') { const open = L.firstOpenStage(lk.stages, d.pipeline_id); if (open) menu.push({ label: 'Reopen deal', icon: 'refresh', onClick: () => moveToStage(d, open).then(refresh).catch(e => C.toast(e.message, 'bad')) }); }
            menu.push('sep', d.archived_at ? { label: 'Restore deal', icon: 'refresh', onClick: () => setArchived(d, false, refresh) } : { label: 'Archive deal', icon: 'trash', onClick: () => setArchived(d, true, refresh) });
        }
        if (canDeleteDeal(d, lv)) menu.push({ label: 'Delete permanently', icon: 'trash', danger: true, onClick: () => deleteDeal(d) });
        if (window.WSShell && WSShell.inSlider) menu.push('sep', { label: 'Open as a page', icon: 'link', onClick: () => { window.top.location.href = `/deals/?id=${d.id}`; } });

        const sections = [
            { title: 'About deal', fields: [
                { key: 'title', title: 'Deal name', type: 'text', value: d.title, required: true, save: save('title') },
                { key: 'value', title: 'Amount', type: 'money', value: Number(d.value), display: v => esc(L.money(v, d.currency)) + (d.amount_from_products ? ' <span class="muted">(from products)</span>' : ''), save: d.amount_from_products ? null : save('value') },
                { key: 'currency', title: 'Currency', type: 'select', options: CURRENCIES, value: d.currency, save: save('currency') },
                { key: 'pipeline', title: 'Pipeline', edit: false, value: pipeline.name, display: () => `${esc(pipeline.name || '')} · ${esc(d.probability)}%` },
                { key: 'expected_close_date', title: 'Expected close', type: 'date', value: d.expected_close_date, save: save('expected_close_date') },
                { key: 'actual_close_date', title: 'Closed', edit: false, value: d.actual_close_date, display: v => v ? esc(L.fmtDate(v)) : '' },
                { key: 'source', title: 'Source', type: 'select', options: SOURCES, value: d.source, save: save('source') },
                { key: 'tags', title: 'Tags', type: 'tags', value: d.tags, save: save('tags') },
            ] },
            { title: 'Client', fields: [
                { key: 'contact_id', title: 'Contact', type: 'entity', entity: 'contact', value: d.contact_id, display: v => v ? C.entityChip('contact', v, contactName(d) || 'Contact') : '', save: save('contact_id') },
                ...(cols.full ? [{ key: 'company_id', title: 'Company', type: 'entity', entity: 'company', value: d.company_id, display: v => v ? C.entityChip('company', v, (d.company_rec && d.company_rec.title) || 'Company') : '', save: save('company_id') }] : []),
                { key: 'organization', title: 'Company name (text)', type: 'text', value: d.organization, save: save('organization') },
            ] },
            { title: 'Responsible', fields: [
                { key: 'owner_id', title: 'Responsible person', type: 'people', none: 'Not assigned', value: d.owner_id, display: v => C.personHtml(v), save: save('owner_id') },
            ] },
            B.cfSection(cf, d, async (code, v) => { await updateDeal(d, { custom: { ...(d.custom || {}), [code]: v } }); }, edit),
            { title: 'More', fields: [
                { key: 'description', title: 'Comment', type: 'textarea', value: d.description, save: save('description') },
                ...(d.lead_id ? [{ key: 'lead', title: 'Converted from', edit: false, value: d.lead_id, display: () => C.entityChip('lead', d.lead_id, 'Open lead') }] : []),
                { key: 'created', title: 'Created', edit: false, value: d.created_at, display: () => `${esc(L.fmtDateTime(d.created_at))} · ${C.personHtml(d.created_by)}` },
                { key: 'updated', title: 'Modified', edit: false, value: d.updated_at, display: () => esc(L.fmtDateTime(d.updated_at)) },
            ] },
        ].filter(Boolean);

        const tabs = [];
        if (cols.full) tabs.push({ key: 'products', title: 'Products', render: el => renderProducts(el, d, edit, refresh) });
        tabs.push({ key: 'tasks', title: 'To-dos', count: tasks.filter(t => !t.completed_at).length, render: el => {
            el.innerHTML = `<div class="b24-tabbar"><button type="button" class="ws-btn sm primary" data-new>${C.icon('plus')}<span>Add to-do</span></button></div><div data-list></div>`;
            el.querySelector('[data-new]').addEventListener('click', newTask);
            C.table(el.querySelector('[data-list]'), { rows: tasks, onRow: t => B.openRecord(`/tasks/?id=${t.id}`, refresh), sort: { key: 'due_date', dir: 'asc' }, columns: [
                { key: 'title', label: 'To-do', lead: true, render: t => `<span class="primary-text">${esc(t.title)}</span>` },
                { key: 'status', label: 'Status', render: t => C.statusBadge(lk.taskStatus || {}, t.status) },
                { key: 'assignee_id', label: 'Responsible', value: t => C.personName(t.assignee_id), render: t => C.personHtml(t.assignee_id, { link: false }) },
                { key: 'due_date', label: 'Deadline', render: t => C.dueHtml(t) },
            ], empty: { title: 'No to-dos', sub: 'Plan the next step on this deal.' } });
        } });
        tabs.push({ key: 'meetings', title: 'Meetings', count: events.filter(e => e.status !== 'cancelled').length, render: el => {
            el.innerHTML = `<div class="b24-tabbar"><button type="button" class="ws-btn sm primary" data-new>${C.icon('plus')}<span>Schedule</span></button></div><div data-list></div>`;
            el.querySelector('[data-new]').addEventListener('click', newMeet);
            C.table(el.querySelector('[data-list]'), { rows: events, onRow: e => B.openRecord(`/calendar/?id=${e.id}`, refresh), sort: { key: 'starts_at', dir: 'desc' }, columns: [
                { key: 'title', label: 'Event', lead: true, render: e => `<span class="primary-text">${esc(e.title)}</span>` },
                { key: 'event_type', label: 'Type', render: e => C.statusBadge(L.EVENT_TYPE, e.event_type) },
                { key: 'starts_at', label: 'When', render: e => `${esc(L.fmtDateTime(e.starts_at))}${e.status === 'cancelled' ? ' ' + C.badge('mute', 'Cancelled') : ''}` },
            ], empty: { title: 'No meetings', sub: 'Schedule a meeting or call for this deal.' } });
        } });
        tabs.push({ key: 'documents', title: 'Documents', render: el => C.documents(el, { entity_type: 'deal', entity_id: id, canEdit: true }) });
        if (invLv.read !== 'none') tabs.push({ key: 'invoices', title: 'Invoices', count: invoices.length, render: el => {
            el.innerHTML = `${invLv.add !== 'none' ? `<div class="b24-tabbar"><a class="ws-btn sm primary" target="_top" href="/invoices/?new=1&deal_id=${esc(d.id)}${d.contact_id ? '&contact_id=' + esc(d.contact_id) : ''}">${C.icon('plus')}<span>New invoice</span></a></div>` : ''}<div data-list></div>`;
            C.table(el.querySelector('[data-list]'), { rows: invoices, onRow: i => B.openRecord(`/invoices/?id=${i.id}`, refresh), sort: { key: 'invoice_date', dir: 'desc' }, columns: [
                { key: 'invoice_number', label: 'Invoice', lead: true, render: i => `<span class="primary-text">${esc(i.invoice_number)}</span>` },
                { key: 'invoice_date', label: 'Date', render: i => esc(L.fmtDate(i.invoice_date)) },
                { key: 'status', label: 'Status', render: i => { const s = L.invoiceStatus(i); return C.badge(L.INVOICE_STATUS[s].color, L.INVOICE_STATUS[s].label); } },
                { key: 'total', label: 'Total', num: true, render: i => esc(L.money(i.total, i.currency)) },
                { key: 'balance', label: 'Balance', num: true, render: i => esc(L.money(i.balance, i.currency)) },
            ], empty: { title: 'No invoices', sub: 'Invoices raised for this deal appear here.' } });
        } });
        tabs.push({ key: 'projects', title: 'Projects', count: projects.length, render: el => {
            C.table(el, { rows: projects, onRow: p => B.openRecord(`/projects/?id=${p.id}`, refresh), columns: [
                { key: 'name', label: 'Project', lead: true, render: p => `<span class="primary-text">${esc(p.name)}</span>` },
                { key: 'status', label: 'Status', render: p => C.statusBadge(L.PROJECT_STATUS, p.status) },
                { key: 'due_date', label: 'Deadline', render: p => esc(L.fmtDate(p.due_date) || '—') },
            ], empty: { title: 'No projects', sub: 'Projects delivered for this deal appear here.' } });
        } });
        tabs.push({ key: 'history', title: 'History', render: el => C.activityFeed(el, { entity_type: 'deal', entity_id: id, deal_id: id, limit: 200 }) });

        view.innerHTML = '<div id="card"></div>';
        WSCard.mount(view.querySelector('#card'), {
            title: d.title, number: d.number, canEdit: edit, onRename: edit ? save('title') : null,
            subtitle: [`<b>${esc(L.money(d.value, d.currency))}</b>`, C.statusBadge(L.DEAL_STATUS, d.status), d.archived_at ? C.badge('mute', 'Archived') : ''].filter(Boolean).join(' '),
            stages: stages.map(s => ({ key: s.id, title: s.name, hex: stageHex(s), kind: s.is_won ? 'won' : s.is_lost ? 'lost' : 'open' })),
            stage: d.stage_id, canMove: edit && !d.archived_at,
            onStage: async key => {
                const ok = await moveToStage(d, lk.stageById[key]);
                if (ok === false) { const e = new Error('Stage not changed'); e.silent = true; throw e; }
                refresh();
            },
            actions: [], menu, sections, tabs,
            timeline: {
                entity_type: 'deal', entity_id: id, links,
                composer: [
                    { title: 'To-do', onOpen: newTask },
                    { title: 'Meeting', onOpen: newMeet },
                    { title: 'Call', onOpen: () => logInteraction(d, 'call.logged', 'Log a call', refresh) },
                    { title: 'Email', onOpen: () => logInteraction(d, 'email.logged', 'Log an email', refresh) },
                ],
            },
        });
        page.unsub = C.subscribe('deal', [{ table: 'crm_deals', filter: `id=eq.${id}` }], C.debounce(() => { if (C.param('id') === id && !document.querySelector('.b24-field.editing')) refresh(); }, 800));
    }

    /* ---------------------------------------------------------- products */
    async function renderProducts(el, d, edit, refresh) {
        el.innerHTML = '<div class="ws-empty">Loading products…</div>';
        const [lines, catalogue] = await Promise.all([
            sb.from('crm_deal_products').select('*').eq('deal_id', d.id).order('position').order('created_at'),
            sb.from('crm_products').select('id, name, price, tax_rate, unit').eq('active', true).order('name').limit(500),
        ]);
        if (lines.error) return C.errorState(el, new Error(C.friendly(lines.error)), () => renderProducts(el, d, edit, refresh));
        const rows = lines.data || [], cat = catalogue.data || [];
        const total = rows.reduce((a, r) => a + Number(r.line_total || 0), 0);
        const num = (r, k, step) => edit ? `<input type="number" min="0" step="${step}" value="${esc(r[k])}" data-line="${esc(r.id)}" data-k="${k}" aria-label="${k}">` : esc(r[k]);
        el.innerHTML = `
            <div class="b24-products">
                <table class="b24-grid-table">
                    <thead><tr><th style="width:34%">Product</th><th class="num">Price</th><th class="num">Quantity</th><th class="num">Discount, %</th><th class="num">Tax, %</th><th class="num">Total</th>${edit ? '<th style="width:44px"></th>' : ''}</tr></thead>
                    <tbody>${rows.map(r => `<tr>
                        <td>${edit ? `<input type="text" value="${esc(r.name)}" data-line="${esc(r.id)}" data-k="name" aria-label="Product name">` : esc(r.name)}</td>
                        <td class="num">${num(r, 'price', '0.01')}</td><td class="num">${num(r, 'quantity', '0.001')}</td>
                        <td class="num">${num(r, 'discount_pct', '0.01')}</td><td class="num">${num(r, 'tax_rate', '0.01')}</td>
                        <td class="num"><b>${esc(L.money(r.line_total, d.currency))}</b></td>
                        ${edit ? `<td><button type="button" class="g-rowmenu" data-del="${esc(r.id)}" aria-label="Remove line">×</button></td>` : ''}
                    </tr>`).join('') || `<tr><td colspan="${edit ? 7 : 6}"><div class="b24-grid-empty"><b>No products yet</b><span>Add what this deal sells to total it automatically.</span></div></td></tr>`}</tbody>
                </table>
                ${edit ? `<div class="b24-products-add">
                    <select data-add aria-label="Add a product"><option value="">+ Add from the catalogue…</option>${cat.map(p => `<option value="${esc(p.id)}">${esc(p.name)} · ${esc(L.money(p.price, d.currency))}</option>`).join('')}</select>
                    <button type="button" class="ws-btn sm" data-add-free>${C.icon('plus')}<span>Add a custom line</span></button>
                </div>` : ''}
                <div class="b24-products-foot">
                    ${edit ? `<label class="crm-check"><input type="checkbox" data-sync${d.amount_from_products ? ' checked' : ''}> Deal amount follows the products</label>` : ''}
                    <span class="grow"></span><span>Total: <b>${esc(L.money(total, d.currency))}</b></span>
                </div>
            </div>`;
        if (!edit) return;
        const reload = async () => { await renderProducts(el, d, edit, refresh); };
        el.querySelectorAll('[data-line]').forEach(inp => inp.addEventListener('change', async () => {
            const k = inp.dataset.k, v = k === 'name' ? inp.value.trim() : Number(inp.value);
            if (k === 'name' && !v) return reload();
            try { await C.q(sb.from('crm_deal_products').update({ [k]: v }).eq('id', inp.dataset.line)); await reload(); if (d.amount_from_products) refreshAmount(d); }
            catch (e) { C.toast(e.message, 'bad'); reload(); }
        }));
        el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
            try { await C.q(sb.from('crm_deal_products').delete().eq('id', b.dataset.del)); await reload(); if (d.amount_from_products) refreshAmount(d); } catch (e) { C.toast(e.message, 'bad'); }
        }));
        const pos = rows.length ? Math.max(...rows.map(r => r.position || 0)) + 1 : 0;
        el.querySelector('[data-add]').addEventListener('change', async e => {
            const p = cat.find(x => x.id === e.target.value); if (!p) return;
            try { await C.q(sb.from('crm_deal_products').insert({ deal_id: d.id, product_id: p.id, name: p.name, price: p.price, tax_rate: p.tax_rate, quantity: 1, position: pos })); await reload(); if (d.amount_from_products) refreshAmount(d); }
            catch (err) { C.toast(err.message, 'bad'); }
        });
        el.querySelector('[data-add-free]').addEventListener('click', async () => {
            const v = await C.formModal({ title: 'Add a line', fields: [
                { name: 'name', label: 'Product or service', type: 'text', required: true, full: true },
                { name: 'price', label: 'Price', type: 'money', required: true }, { name: 'quantity', label: 'Quantity', type: 'number', required: true, step: '0.001' },
                { name: 'tax_rate', label: 'Tax, %', type: 'number', step: '0.01' }, { name: 'discount_pct', label: 'Discount, %', type: 'number', step: '0.01' },
            ], values: { quantity: 1, tax_rate: 0, discount_pct: 0 }, submitLabel: 'Add', onSubmit: v => v });
            if (!v || v === true) return;
            try { await C.q(sb.from('crm_deal_products').insert({ deal_id: d.id, name: v.name.trim(), price: Number(v.price) || 0, quantity: Number(v.quantity) || 1, tax_rate: Number(v.tax_rate) || 0, discount_pct: Number(v.discount_pct) || 0, position: pos })); await reload(); if (d.amount_from_products) refreshAmount(d); }
            catch (err) { C.toast(err.message, 'bad'); }
        });
        const sync = el.querySelector('[data-sync]');
        if (sync) sync.addEventListener('change', async () => {
            try {
                const patch = { amount_from_products: sync.checked };
                if (sync.checked) patch.value = total;
                await updateDeal(d, patch);
                C.toast(sync.checked ? 'The amount now follows the products' : 'The amount is entered by hand', 'ok');
            } catch (e) { C.toast(e.message, 'bad'); sync.checked = !sync.checked; }
        });
    }
    async function refreshAmount(d) {
        const r = await sb.from('crm_deals').select('value').eq('id', d.id).maybeSingle();
        if (r.data) d.value = r.data.value;
    }

    /* ------------------------------------------------- pipeline settings */
    async function openPipelineSettings(after) {
        lk = await C.lookups(true);
        let current = page.pipeline || (lk.defaultPipeline && lk.defaultPipeline.id) || (lk.pipelines[0] && lk.pipelines[0].id) || null;
        const body = document.createElement('div');
        const m = C.modal({ title: 'Pipelines and stages', size: 'wide', body, actions: [{ label: 'Done', primary: true, close: true }], onClose: () => { if (after) after(); } });
        async function usage(stageId) {
            const r = await sb.from('crm_deals').select('id', { count: 'exact', head: true }).eq('stage_id', stageId);
            return r.error ? null : (r.count || 0);
        }
        function render() {
            const p = lk.pipelines.find(x => x.id === current);
            const stages = p ? stagesFor(p.id) : [];
            body.innerHTML = `
                <div class="crm-toolbar" style="margin-bottom:12px">
                    <select id="ps-pipeline" aria-label="Pipeline">${lk.pipelines.map(x => `<option value="${esc(x.id)}"${x.id === current ? ' selected' : ''}>${esc(x.name)}${x.is_default ? ' (default)' : ''}${x.company ? '' : ' · shared'}</option>`).join('')}${lk.pipelines.length ? '' : '<option value="">No pipelines</option>'}</select>
                    <button type="button" class="ws-btn sm" id="ps-new">${C.icon('plus')}<span>New pipeline</span></button>
                    ${p ? `<button type="button" class="ws-btn sm" id="ps-rename">${C.icon('edit')}<span>Rename</span></button>${p.is_default ? '' : `<button type="button" class="ws-btn sm" id="ps-default">${C.icon('star')}<span>Make default</span></button>`}` : ''}
                </div>
                ${p ? `<p class="muted" style="font-size:13px;margin:0 0 10px">${p.company ? `Company: ${esc(p.company)}` : 'Shared by every company'}. Only the <b>Won</b> / <b>Lost</b> outcome and the probability drive the numbers.</p>
                <div class="crm-table-wrap"><table class="ws-table"><thead><tr><th style="width:36px"></th><th>Stage</th><th class="num">Probability</th><th>Outcome</th><th>Colour</th><th class="actions"></th></tr></thead><tbody>
                ${stages.map((s, i) => `<tr data-stage="${esc(s.id)}">
                    <td><span class="b24-stage-pill" style="--c:${stageHex(s)};width:18px;padding:0"></span></td>
                    <td><input type="text" data-f="name" value="${esc(s.name)}" aria-label="Stage name" style="min-height:34px;padding:5px 8px;width:100%"></td>
                    <td class="num"><input type="number" data-f="probability" min="0" max="100" value="${s.probability}" aria-label="Probability" style="min-height:34px;padding:5px 8px;width:80px"></td>
                    <td><select data-f="outcome" aria-label="Outcome" style="min-height:34px;padding:5px 8px"><option value="open"${!s.is_won && !s.is_lost ? ' selected' : ''}>In progress</option><option value="won"${s.is_won ? ' selected' : ''}>Won</option><option value="lost"${s.is_lost ? ' selected' : ''}>Lost</option></select></td>
                    <td><select data-f="color" aria-label="Colour" style="min-height:34px;padding:5px 8px">${COLORS.map(c => `<option value="${c}"${s.color === c ? ' selected' : ''}>${c}</option>`).join('')}</select></td>
                    <td class="actions"><button type="button" class="ws-btn sm icon" data-up ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button> <button type="button" class="ws-btn sm icon" data-down ${i === stages.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button> <button type="button" class="ws-btn sm icon" data-del aria-label="Delete stage">${C.icon('trash')}</button></td>
                </tr>`).join('') || '<tr><td colspan="6" class="muted" style="text-align:center;padding:14px">No stages yet.</td></tr>'}
                </tbody></table></div>
                <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="ws-btn sm" id="ps-add">${C.icon('plus')}<span>Add stage</span></button><span class="muted" style="font-size:12.5px;align-self:center">Edits save when you leave a field.</span></div>` : '<div class="ws-empty"><b>No pipeline yet</b>Create one to start tracking deals.</div>'}`;
            body.querySelector('#ps-pipeline').addEventListener('change', e => { current = e.target.value; render(); });
            body.querySelector('#ps-new').addEventListener('click', () => C.formModal({ title: 'New pipeline', fields: [
                { name: 'name', label: 'Name', type: 'text', required: true, full: true },
                ...(ctx.isAdmin ? [{ name: 'scope', label: 'Available to', type: 'select', options: [{ value: 'mine', label: me.company || 'My company' }, { value: 'shared', label: 'Every company' }], required: true, full: true }] : []),
                { name: 'is_default', label: 'Make this the default pipeline', type: 'check', full: true },
            ], values: { scope: 'mine' }, submitLabel: 'Create', onSubmit: async v => {
                const company = ctx.isAdmin && v.scope === 'shared' ? null : (me.company || null);
                if (v.is_default) await sb.from('crm_pipelines').update({ is_default: false }).eq('is_default', true)[company == null ? 'is' : 'eq']('company', company == null ? null : company);
                const { data } = await C.q(sb.from('crm_pipelines').insert({ name: v.name.trim(), company, is_default: !!v.is_default, created_by: me.id }).select('id').single());
                const seed = [['New Opportunity', 1, 10, false, false, 'pending'], ['Qualification', 2, 25, false, false, 'late'], ['Proposal', 3, 50, false, false, 'leave'], ['Negotiation', 4, 75, false, false, 'holiday'], ['Won', 5, 100, true, false, 'present'], ['Lost', 6, 0, false, true, 'absent']];
                await C.q(sb.from('crm_pipeline_stages').insert(seed.map(([name, position, probability, is_won, is_lost, color]) => ({ pipeline_id: data.id, name, position, probability, is_won, is_lost, color }))));
                lk = await C.lookups(true); current = data.id; render(); C.toast('Pipeline created with default stages', 'ok');
            } }));
            if (!p) return;
            body.querySelector('#ps-rename').addEventListener('click', () => C.formModal({ title: 'Rename pipeline', fields: [{ name: 'name', label: 'Name', type: 'text', required: true, full: true }], values: { name: p.name }, onSubmit: async v => { await C.q(sb.from('crm_pipelines').update({ name: v.name.trim() }).eq('id', p.id)); lk = await C.lookups(true); render(); } }));
            const def = body.querySelector('#ps-default'); if (def) def.addEventListener('click', async () => {
                try { await sb.from('crm_pipelines').update({ is_default: false }).eq('is_default', true).is('company', p.company); await C.q(sb.from('crm_pipelines').update({ is_default: true }).eq('id', p.id)); lk = await C.lookups(true); render(); C.toast('Default pipeline updated', 'ok'); } catch (e) { C.toast(e.message, 'bad'); }
            });
            body.querySelector('#ps-add').addEventListener('click', async () => {
                const pos = (stages[stages.length - 1] || { position: 0 }).position + 1;
                try { await C.q(sb.from('crm_pipeline_stages').insert({ pipeline_id: p.id, name: 'New stage', position: pos, probability: 50, color: 'pending' })); lk = await C.lookups(true); render(); } catch (e) { C.toast(e.message, 'bad'); }
            });
            body.querySelectorAll('tr[data-stage]').forEach(tr => {
                const s = lk.stageById[tr.dataset.stage];
                const saveStage = async patch => { try { await C.q(sb.from('crm_pipeline_stages').update(patch).eq('id', s.id)); lk = await C.lookups(true); render(); } catch (e) { C.toast(e.message, 'bad'); render(); } };
                tr.querySelector('[data-f=name]').addEventListener('change', e => { const v = e.target.value.trim(); if (v && v !== s.name) saveStage({ name: v }); });
                tr.querySelector('[data-f=probability]').addEventListener('change', e => { const v = Math.max(0, Math.min(100, Number(e.target.value) || 0)); if (v !== s.probability) saveStage({ probability: v }); });
                tr.querySelector('[data-f=outcome]').addEventListener('change', e => { const v = e.target.value; saveStage({ is_won: v === 'won', is_lost: v === 'lost', probability: v === 'won' ? 100 : v === 'lost' ? 0 : s.probability }); });
                tr.querySelector('[data-f=color]').addEventListener('change', e => saveStage({ color: e.target.value }));
                const swap = async other => { if (!other) return; try { await C.q(sb.from('crm_pipeline_stages').update({ position: other.position }).eq('id', s.id)); await C.q(sb.from('crm_pipeline_stages').update({ position: s.position }).eq('id', other.id)); lk = await C.lookups(true); render(); } catch (e) { C.toast(e.message, 'bad'); } };
                const idx = stages.findIndex(x => x.id === s.id);
                tr.querySelector('[data-up]').addEventListener('click', () => swap(stages[idx - 1]));
                tr.querySelector('[data-down]').addEventListener('click', () => swap(stages[idx + 1]));
                tr.querySelector('[data-del]').addEventListener('click', async () => {
                    const n = await usage(s.id);
                    if (n === null) return C.toast('Could not check whether deals use this stage', 'bad');
                    if (n > 0) return C.alert({ title: 'Stage is in use', message: `${n} deal${n === 1 ? '' : 's'} sit${n === 1 ? 's' : ''} in “${s.name}”. Move them to another stage first, then delete it.` });
                    if (!await C.confirm({ title: `Delete stage “${s.name}”?`, message: 'No deals use it. This cannot be undone.', okText: 'Delete', danger: true })) return;
                    try { await C.q(sb.from('crm_pipeline_stages').delete().eq('id', s.id)); lk = await C.lookups(true); render(); C.toast('Stage deleted', 'ok'); } catch (e) { C.toast(e.message, 'bad'); }
                });
            });
        }
        render();
        return m;
    }

    route();
})();
