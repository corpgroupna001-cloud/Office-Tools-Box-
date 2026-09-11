/* ============================================================================
   Deals — sales pipeline. Kanban (stages as columns, shared WSKanban) and a
   table view, a deal record page with a stage track, and pipeline / stage
   configuration for managers. Stage rules (status, probability, close date)
   are enforced by the crm_deals triggers; this page only moves cards.

   URLs:  /deals/            board / table     /deals/?id=<uuid>   record
          /deals/?new=1      board + new-deal dialog
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'deals', crumb: 'Deals' });
    const sb = ctx.sb, me = ctx.user;

    const SOURCES = ['Website', 'Referral', 'Cold call', 'Email campaign', 'Social media', 'Event', 'Partner', 'Walk-in', 'Other'];
    const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED'];
    const COLORS = ['pending', 'late', 'leave', 'holiday', 'present', 'absent', 'weekoff'];
    const SELECT = 'id, company, title, contact_id, organization, owner_id, pipeline_id, stage_id, value, currency, probability, expected_close_date, actual_close_date, status, source, description, lead_id, tags, position, archived_at, created_by, created_at, updated_at, contact:crm_contacts(id, full_name, organization)';
    const VIEW_KEY = 'ws-deals-view';

    let lk = await C.lookups();
    let unsub = null;
    let routeSeq = 0;

    /* ------------------------------------------------------------ routing */
    function route() {
        if (unsub) { unsub(); unsub = null; }
        const id = C.param('id');
        if (id) return showRecord(id);
        return showList();
    }
    window.addEventListener('popstate', route);
    function go(url) { history.pushState(null, '', url); route(); }

    function pipelineOf(id) { return lk.pipelines.find(p => p.id === id) || null; }
    function stagesFor(pipelineId) { return L.stagesOf(lk.stages, pipelineId); }
    function outcomeStage(pipelineId, kind) { return stagesFor(pipelineId).find(s => kind === 'won' ? s.is_won : s.is_lost) || null; }
    function contactName(d) { return d.contact ? (d.contact.full_name || d.contact.organization) : ''; }
    function weighted(d) { return L.round2((Number(d.value) || 0) * (Number(d.probability) || 0) / 100); }

    /* --------------------------------------------------------- deal form */
    async function openDealEditor(deal, defaults, onSaved) {
        lk = await C.lookups();
        if (!lk.pipelines.length) {
            return C.alert({ title: 'No pipeline yet', message: ctx.isManager ? 'Configure a pipeline first (Configure pipelines in the toolbar).' : 'Ask a manager to set up a sales pipeline first.' });
        }
        const isNew = !deal;
        const d = defaults || {};
        const pipelineId = (deal && deal.pipeline_id) || d.pipeline_id || (lk.defaultPipeline && lk.defaultPipeline.id) || lk.pipelines[0].id;
        const stageOpts = pid => stagesFor(pid).map(s => ({ value: s.id, label: s.name + (s.is_won ? ' (won)' : s.is_lost ? ' (lost)' : '') }));
        const firstStage = (deal && deal.stage_id) || d.stage_id || (L.firstOpenStage(lk.stages, pipelineId) || stagesFor(pipelineId)[0] || {}).id || '';
        let orgField = null;
        const fields = [
            { name: 'title', label: 'Deal title', type: 'text', required: true, full: true, placeholder: 'e.g. Annual supply contract' },
            { name: 'contact_id', label: 'Contact', type: 'entity', entity: 'contact', placeholder: 'Search contacts', valueLabel: deal && deal.contact ? contactName(deal) : (d.contact_label || undefined),
              onChange: id => { if (id && orgField && !orgField.get()) sb.from('crm_contacts').select('organization').eq('id', id).maybeSingle().then(r => { if (r.data && r.data.organization && !orgField.get()) orgField.set(r.data.organization); }); } },
            { name: 'organization', label: 'Organisation', type: 'text' },
            { name: 'owner_id', label: 'Owner', type: 'people', none: 'Unassigned' },
            { name: 'pipeline_id', label: 'Pipeline', type: 'select', options: lk.pipelines.map(p => ({ value: p.id, label: p.name })), required: true },
            { name: 'stage_id', label: 'Stage', type: 'select', options: stageOpts(pipelineId), required: true },
            { name: 'value', label: 'Value', type: 'money', required: true },
            { name: 'currency', label: 'Currency', type: 'select', options: CURRENCIES, required: true },
            { name: 'expected_close_date', label: 'Expected close', type: 'date' },
            { name: 'source', label: 'Source', type: 'select', options: SOURCES, placeholder: 'Source' },
            { name: 'tags', label: 'Tags', type: 'tags', full: true },
            { name: 'description', label: 'Description', type: 'textarea', full: true },
        ];
        const values = isNew
            ? { owner_id: d.owner_id || me.id, pipeline_id: pipelineId, stage_id: firstStage, value: d.value != null ? d.value : 0, currency: 'INR', contact_id: d.contact_id || null, organization: d.organization || '', title: d.title || '', source: d.source || '' }
            : { ...deal, value: Number(deal.value) };
        return C.formModal({
            title: isNew ? 'New deal' : 'Edit deal', size: 'wide', fields, values, submitLabel: isNew ? 'Create deal' : 'Save changes',
            onReady: f => {
                orgField = f.field('organization');
                f.field('pipeline_id').el.addEventListener('change', e => {
                    const st = stageOpts(e.target.value);
                    f.field('stage_id').el.innerHTML = st.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
                    const open = L.firstOpenStage(lk.stages, e.target.value); if (open) f.field('stage_id').set(open.id);
                });
            },
            onSubmit: async v => {
                const row = {
                    title: v.title.trim(), contact_id: v.contact_id || null, organization: v.organization ? v.organization.trim() || null : null,
                    owner_id: v.owner_id || null, pipeline_id: v.pipeline_id, stage_id: v.stage_id, value: Number(v.value) || 0, currency: v.currency,
                    expected_close_date: v.expected_close_date || null, source: v.source || null, tags: v.tags || [], description: v.description || null,
                };
                if (isNew) { row.created_by = me.id; if (d.lead_id) row.lead_id = d.lead_id; }
                const saved = isNew
                    ? (await C.q(sb.from('crm_deals').insert(row).select(SELECT).single())).data
                    : (await C.q(sb.from('crm_deals').update(row).eq('id', deal.id).select(SELECT).single())).data;
                if (saved.owner_id && saved.owner_id !== me.id && (isNew || saved.owner_id !== deal.owner_id)) C.pushNotify({ to: saved.owner_id, title: 'Deal assigned to you', body: saved.title, url: `/deals/?id=${saved.id}`, tag: 'crm' });
                C.toast(isNew ? 'Deal created' : 'Deal saved', 'ok');
                if (onSaved) onSaved(saved);
                return saved;
            },
        });
    }

    /* ------------------------------------------------------- stage moves */
    async function moveToStage(deal, stage, position, after) {
        if (!stage) return;
        if ((stage.is_won || stage.is_lost) && deal.stage_id !== stage.id) {
            const ok = await C.confirm({ title: stage.is_won ? 'Mark this deal as won?' : 'Mark this deal as lost?', message: `${deal.title} · ${L.money(deal.value, deal.currency)} will be closed as ${stage.is_won ? 'won' : 'lost'} today. You can move it back to an open stage later.`, okText: stage.is_won ? 'Mark won' : 'Mark lost', danger: stage.is_lost });
            if (!ok) return false;
        }
        const patch = { stage_id: stage.id };
        if (position != null) patch.position = position;
        try {
            const { data } = await C.q(sb.from('crm_deals').update(patch).eq('id', deal.id).select('id, status, stage_id, probability').single());
            if (data.status === 'won') C.toast(`🎉 ${deal.title} marked as won`, 'ok');
            else if (data.status === 'lost') C.toast(`${deal.title} marked as lost`, '');
            else C.toast(`Moved to ${stage.name}`, 'ok');
            if (after) after(data);
            return true;
        } catch (e) { C.toast(e.message, 'bad'); throw e; }
    }
    async function setArchived(deal, archived, after) {
        if (archived && !await C.confirm({ title: `Archive ${deal.title}?`, message: 'The deal disappears from the board and lists but keeps its history, tasks and documents. You can restore it later.', okText: 'Archive', danger: true })) return;
        try { await C.q(sb.from('crm_deals').update({ archived_at: archived ? new Date().toISOString() : null }).eq('id', deal.id)); C.toast(archived ? 'Deal archived' : 'Deal restored', 'ok'); if (after) after(); }
        catch (e) { C.toast(e.message, 'bad'); }
    }
    async function deleteDeal(deal) {
        if (!await C.confirm({ title: 'Delete this deal permanently?', message: 'Its activity history, tasks and invoices lose the link. Archiving is usually the better choice.', okText: 'Delete permanently', danger: true })) return;
        try { await C.q(sb.from('crm_deals').delete().eq('id', deal.id)); C.toast('Deal deleted', 'ok'); go('/deals/'); }
        catch (e) { C.toast(e.message, 'bad'); }
    }
    async function duplicateDeal(deal) {
        try {
            const { data } = await C.q(sb.from('crm_deals').insert({
                title: `${deal.title} (copy)`, contact_id: deal.contact_id, organization: deal.organization, owner_id: deal.owner_id,
                pipeline_id: deal.pipeline_id, stage_id: (L.firstOpenStage(lk.stages, deal.pipeline_id) || { id: deal.stage_id }).id,
                value: deal.value, currency: deal.currency, expected_close_date: deal.expected_close_date, source: deal.source, description: deal.description, tags: deal.tags || [], created_by: me.id,
            }).select('id').single());
            C.toast('Deal duplicated', 'ok'); go(`/deals/?id=${data.id}`);
        } catch (e) { C.toast(e.message, 'bad'); }
    }

    /* --------------------------------------------------------------- list */
    const ls = { view: (function () { try { return localStorage.getItem(VIEW_KEY) || 'board'; } catch (e) { return 'board'; } })(), pipeline: '', owner: '', status: 'open', q: '', range: '', from: '', to: '', rows: [], archived: false };
    async function fetchDeals() {
        let b = sb.from('crm_deals').select(SELECT).order('updated_at', { ascending: false }).limit(1000);
        b = ls.archived ? b.not('archived_at', 'is', null) : b.is('archived_at', null);
        if (ls.pipeline) b = b.eq('pipeline_id', ls.pipeline);
        if (ls.owner === 'me') b = b.eq('owner_id', me.id); else if (ls.owner === 'none') b = b.is('owner_id', null); else if (ls.owner) b = b.eq('owner_id', ls.owner);
        if (ls.view === 'table' && ls.status && ls.status !== 'all') b = b.eq('status', ls.status);
        const r = ls.range ? (ls.range === 'custom' ? L.dateRange('custom', null, { from: ls.from, to: ls.to }) : L.dateRange(ls.range)) : null;
        if (r) b = b.gte('expected_close_date', r.from).lte('expected_close_date', r.to);
        const { data } = await C.q(b);
        return data || [];
    }
    function filtered() {
        const q = ls.q.trim().toLowerCase();
        return ls.rows.filter(d => !q || [d.title, d.organization, contactName(d), (d.tags || []).join(' ')].some(v => v && String(v).toLowerCase().includes(q)));
    }
    async function showList() {
        const myRoute = ++routeSeq;
        // Deep links: ?status=won|lost|open|all opens the table filtered; ?view=board|table picks the view.
        { const st = C.param('status'), vw = C.param('view');
          if (vw === 'board' || vw === 'table') ls.view = vw;
          if (st && ['open', 'won', 'lost', 'all'].includes(st)) { ls.status = st; if (st !== 'open') ls.view = 'table'; }
          if (st || vw) { C.setParam('status', null, true); C.setParam('view', null, true); } }
        WSShell.setCrumb('Deals');
        document.title = 'Deals · WorkSuite';
        lk = await C.lookups();
        if (!ls.pipeline) ls.pipeline = (lk.defaultPipeline && lk.defaultPipeline.id) || (lk.pipelines[0] && lk.pipelines[0].id) || '';
        view.innerHTML = `
            <div class="ws-page-head">
                <div><p class="ws-eyebrow">CRM</p><h1>Deals</h1><p>Every opportunity, from first conversation to closed.</p></div>
                <div class="actions">
                    ${ctx.isManager ? `<button type="button" class="ws-btn" id="cfg-btn">${C.icon('filter')}<span>Configure pipelines</span></button>` : ''}
                    <button type="button" class="ws-btn primary" id="new-btn">${C.icon('plus')}<span>New deal</span></button>
                </div>
            </div>
            <div class="crm-kpis" id="kpis"></div>
            <div class="crm-toolbar">
                <div class="crm-seg" role="tablist" aria-label="View">
                    <button type="button" data-view="board" class="${ls.view === 'board' ? 'on' : ''}">${C.icon('board', 'sm')} Pipeline</button>
                    <button type="button" data-view="table" class="${ls.view === 'table' ? 'on' : ''}">${C.icon('tasks', 'sm')} Table</button>
                </div>
                ${lk.pipelines.length > 1 ? `<select id="f-pipeline" aria-label="Pipeline">${lk.pipelines.map(p => `<option value="${esc(p.id)}"${p.id === ls.pipeline ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
                <div class="crm-search grow">${C.icon('search', 'sm')}<input type="search" id="q" placeholder="Search deals, organisations, contacts…" aria-label="Search deals"></div>
                <select id="f-owner" aria-label="Owner"><option value="">Any owner</option><option value="me">Owned by me</option><option value="none">Unassigned</option>${C.peopleOptions('', { none: null })}</select>
                <select id="f-status" aria-label="Status" ${ls.view === 'board' ? 'hidden' : ''}><option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option><option value="all">All</option></select>
                <select id="f-range" aria-label="Expected close"><option value="">Any close date</option><option value="today">Closing today</option><option value="week">This week</option><option value="month">This month</option><option value="quarter">This quarter</option><option value="custom">Custom…</option></select>
                <span id="custom-range" hidden style="display:inline-flex;gap:6px"><input type="date" id="f-from" aria-label="From"><input type="date" id="f-to" aria-label="To"></span>
                <label class="crm-check" style="min-height:auto;font-size:13px"><input type="checkbox" id="f-archived"> Archived</label>
                <span class="crm-count" id="count"></span>
            </div>
            <div id="bulk" class="crm-bulkbar" hidden></div>
            <div id="board" ${ls.view === 'board' ? '' : 'hidden'}></div>
            <div class="ws-card flush" id="table-card" ${ls.view === 'table' ? '' : 'hidden'}><div id="table"></div></div>`;
        const boardEl = view.querySelector('#board'), tableEl = view.querySelector('#table');
        view.querySelector('#q').value = ls.q; view.querySelector('#f-owner').value = ls.owner; view.querySelector('#f-status').value = ls.status; view.querySelector('#f-range').value = ls.range;
        view.querySelector('#f-archived').checked = ls.archived;
        view.querySelector('#custom-range').hidden = ls.range !== 'custom';
        view.querySelector('#f-from').value = ls.from; view.querySelector('#f-to').value = ls.to;
        C.skeletonRows(ls.view === 'board' ? boardEl : tableEl, 6);

        view.querySelector('#new-btn').addEventListener('click', () => openDealEditor(null, { pipeline_id: ls.pipeline }, d => go(`/deals/?id=${d.id}`)));
        const cfg = view.querySelector('#cfg-btn'); if (cfg) cfg.addEventListener('click', () => openPipelineSettings(reload));
        view.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
            ls.view = b.dataset.view; try { localStorage.setItem(VIEW_KEY, ls.view); } catch (e) { /* ignore */ }
            view.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('on', x === b));
            view.querySelector('#f-status').hidden = ls.view === 'board';
            reload();
        }));
        const fp = view.querySelector('#f-pipeline'); if (fp) fp.addEventListener('change', e => { ls.pipeline = e.target.value; reload(); });
        view.querySelector('#q').addEventListener('input', C.debounce(() => { ls.q = view.querySelector('#q').value; paint(); }, 200));
        view.querySelector('#f-owner').addEventListener('change', e => { ls.owner = e.target.value; reload(); });
        view.querySelector('#f-status').addEventListener('change', e => { ls.status = e.target.value; reload(); });
        view.querySelector('#f-range').addEventListener('change', e => { ls.range = e.target.value; view.querySelector('#custom-range').hidden = ls.range !== 'custom'; if (ls.range !== 'custom' || (ls.from && ls.to)) reload(); });
        ['f-from', 'f-to'].forEach(id => view.querySelector('#' + id).addEventListener('change', () => { ls.from = view.querySelector('#f-from').value; ls.to = view.querySelector('#f-to').value; if (ls.from && ls.to) reload(); }));
        view.querySelector('#f-archived').addEventListener('change', e => { ls.archived = e.target.checked; reload(); });

        let board = null, tbl = null;
        const bulk = view.querySelector('#bulk');
        function renderKpis(rows) {
            const m = L.pipelineMetrics(rows);
            const month = L.dateRange('month');
            const wonMonth = rows.filter(d => d.status === 'won' && d.actual_close_date && d.actual_close_date >= month.from && d.actual_close_date <= month.to);
            const cur = (rows[0] && rows[0].currency) || 'INR';
            view.querySelector('#kpis').innerHTML = `
                <div class="crm-kpi accent"><div class="lbl">Pipeline value</div><div class="val">${esc(L.moneyShort(m.pipeline_value, cur))}</div><div class="sub">${m.open_count} open deal${m.open_count === 1 ? '' : 's'}</div></div>
                <div class="crm-kpi"><div class="lbl">Weighted value</div><div class="val">${esc(L.moneyShort(m.weighted_value, cur))}</div><div class="sub">value × probability</div></div>
                <div class="crm-kpi ok"><div class="lbl">Won this month</div><div class="val">${esc(L.moneyShort(wonMonth.reduce((a, d) => a + Number(d.value || 0), 0), cur))}</div><div class="sub">${wonMonth.length} deal${wonMonth.length === 1 ? '' : 's'}</div></div>
                <div class="crm-kpi ${m.win_rate == null ? '' : m.win_rate >= 50 ? 'ok' : 'warn'}"><div class="lbl">Win rate</div><div class="val">${m.win_rate == null ? '—' : m.win_rate + '<small>%</small>'}</div><div class="sub">${m.won_count} won · ${m.lost_count} lost</div></div>`;
        }
        function cardHtml(d) {
            const dueState = d.status === 'open' && d.expected_close_date ? L.taskDueState({ due_date: d.expected_close_date }) : null;
            const who = contactName(d) || d.organization;
            return `<div class="t">${esc(d.title)}</div>${who ? `<div class="s">${esc(who)}</div>` : ''}
                <div class="f"><span class="money">${esc(L.money(d.value, d.currency, { whole: true }))}</span>
                ${d.status === 'open' ? `<span class="muted" style="font-size:11.5px">${d.probability}%</span>` : ''}
                ${dueState ? `<span class="crm-due ${dueState}" title="Expected close">${esc(L.fmtDate(d.expected_close_date, { short: true }))}</span>` : ''}
                <span class="spacer"></span>${d.owner_id ? C.avatarHtml(d.owner_id) : ''}</div>`;
        }
        function renderBoard(rows) {
            const stages = stagesFor(ls.pipeline);
            const columns = stages.map(s => {
                const inCol = rows.filter(d => d.stage_id === s.id);
                return { id: s.id, name: s.name, color: s.color, sum: inCol.length ? L.moneyShort(inCol.reduce((a, d) => a + Number(d.value || 0), 0), (inCol[0] || {}).currency) : null };
            });
            const cards = rows.filter(d => d.pipeline_id === ls.pipeline).map(d => ({ ...d, columnId: d.stage_id, position: Number(d.position) || 0 }));
            if (!stages.length) { C.empty(boardEl, 'This pipeline has no stages', ctx.isManager ? 'Add stages in Configure pipelines.' : 'Ask a manager to add stages.'); board = null; return; }
            if (!board) {
                boardEl.innerHTML = '';
                board = WSKanban.mount(boardEl, {
                    columns, cards, renderCard: cardHtml, emptyText: 'No deals',
                    canDrag: d => L.canEdit({ owner_id: d.owner_id, created_by: d.created_by }, me),
                    onCardClick: d => go(`/deals/?id=${d.id}`),
                    onAddCard: stageId => openDealEditor(null, { pipeline_id: ls.pipeline, stage_id: stageId }, reload),
                    onMove: async ({ card, toColumnId, position }) => {
                        const stage = lk.stageById[toColumnId];
                        const ok = await moveToStage(card, stage, position, () => reload(true));
                        if (ok === false) reload(true);          // declined the won/lost confirmation: put the card back quietly
                    },
                    onColumnMenu: (col, anchor, api) => C.menu(anchor, [
                        { label: api.collapsed ? 'Expand column' : 'Collapse column', icon: 'collapse', onClick: api.toggleCollapse },
                        { label: 'Add deal here', icon: 'plus', onClick: () => openDealEditor(null, { pipeline_id: ls.pipeline, stage_id: col.id }, reload) },
                    ]),
                });
            } else board.update({ columns, cards });
        }
        function renderBulk(sel) {
            bulk.hidden = !sel.length;
            if (!sel.length) return;
            const stages = stagesFor(ls.pipeline);
            bulk.innerHTML = `<span>${sel.length} selected</span>
                <select id="bulk-owner" aria-label="Assign owner"><option value="">Assign owner…</option>${C.peopleOptions('', { none: null })}</select>
                <select id="bulk-stage" aria-label="Move to stage"><option value="">Move to stage…</option>${stages.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>
                <span class="spacer"></span><button type="button" class="ws-btn sm ghost" id="bulk-clear">Clear</button>`;
            bulk.querySelector('#bulk-owner').addEventListener('change', async e => {
                if (!e.target.value) return;
                try { await C.q(sb.from('crm_deals').update({ owner_id: e.target.value }).in('id', sel)); C.toast(`Assigned ${sel.length} deal${sel.length > 1 ? 's' : ''}`, 'ok'); reload(); } catch (err) { C.toast(err.message, 'bad'); }
            });
            bulk.querySelector('#bulk-stage').addEventListener('change', async e => {
                const stage = lk.stageById[e.target.value]; if (!stage) return;
                const same = ls.rows.filter(d => sel.includes(d.id) && d.pipeline_id === stage.pipeline_id).map(d => d.id);
                if (!same.length) return C.toast('Those deals belong to another pipeline', 'bad');
                if ((stage.is_won || stage.is_lost) && !await C.confirm({ title: `Mark ${same.length} deal${same.length > 1 ? 's' : ''} as ${stage.is_won ? 'won' : 'lost'}?`, message: 'They will be closed today.', okText: 'Confirm', danger: stage.is_lost })) return;
                try { await C.q(sb.from('crm_deals').update({ stage_id: stage.id }).in('id', same)); C.toast(`Moved to ${stage.name}`, 'ok'); reload(); } catch (err) { C.toast(err.message, 'bad'); }
            });
            bulk.querySelector('#bulk-clear').addEventListener('click', () => tbl && tbl.clearSelection());
        }
        function renderTable(rows) {
            const cols = [
                { key: 'title', label: 'Deal', lead: true, render: d => `<span class="primary-text">${esc(d.title)}</span><span class="sub">${esc(d.organization || '')}</span>` },
                { key: 'contact', label: 'Contact', value: d => contactName(d), render: d => d.contact_id ? `<a class="crm-link" href="/contacts/?id=${esc(d.contact_id)}">${esc(contactName(d) || 'Contact')}</a>` : '<span class="muted">—</span>' },
                { key: 'stage_id', label: 'Stage', value: d => (lk.stageById[d.stage_id] || {}).position || 0, render: d => { const s = lk.stageById[d.stage_id]; return s ? `<span class="crm-dot ${esc(s.color || '')}"></span> ${esc(s.name)}` : '—'; } },
                { key: 'value', label: 'Value', num: true, value: d => Number(d.value), render: d => esc(L.money(d.value, d.currency)) },
                { key: 'probability', label: 'Prob.', num: true, render: d => `${d.probability}%` },
                { key: 'owner_id', label: 'Owner', value: d => C.personName(d.owner_id), render: d => C.personHtml(d.owner_id, { link: false }) },
                { key: 'expected_close_date', label: 'Expected close', render: d => d.expected_close_date ? `<span class="crm-due ${d.status === 'open' ? L.taskDueState({ due_date: d.expected_close_date }) : ''}">${esc(L.fmtDate(d.expected_close_date))}</span>` : '<span class="muted">—</span>' },
                { key: 'status', label: 'Status', render: d => C.statusBadge(L.DEAL_STATUS, d.status) },
                { key: 'updated_at', label: 'Updated', num: true, hideMobile: true, render: d => `<span class="muted">${esc(L.fmtRelative(d.updated_at))}</span>` },
                { key: 'actions', label: '', sort: false, cls: 'actions', render: d => `<button type="button" class="ws-btn sm icon" data-menu="${esc(d.id)}" aria-label="Actions">${C.icon('more')}</button>` },
            ];
            if (!tbl) {
                tbl = C.table(tableEl, {
                    columns: cols, rows, sort: { key: 'updated_at', dir: 'desc' }, selectable: true, pageSize: 50,
                    onRow: d => go(`/deals/?id=${d.id}`), onSelectionChange: renderBulk,
                    empty: { title: ls.q || ls.owner || ls.range ? 'No deals match' : 'No deals yet', sub: ls.q ? 'Try a different search or clear the filters.' : 'Open your first opportunity, or convert a lead.', action: ls.q ? '' : `<button type="button" class="ws-btn primary" onclick="document.getElementById('new-btn').click()">${C.icon('plus')}<span>New deal</span></button>` },
                });
            } else tbl.update(rows);
        }
        tableEl.addEventListener('click', e => {
            const b = e.target.closest('[data-menu]'); if (!b) return;
            e.stopPropagation();
            const d = ls.rows.find(x => x.id === b.dataset.menu); if (!d) return;
            const can = L.canEdit({ owner_id: d.owner_id, created_by: d.created_by }, me);
            const items = [{ label: 'Open', icon: 'arrow', onClick: () => go(`/deals/?id=${d.id}`) }];
            if (can) {
                items.push({ label: 'Edit', icon: 'edit', onClick: () => openDealEditor(d, null, reload) });
                items.push({ label: 'Move to stage…', icon: 'board', onClick: () => setTimeout(() => C.menu(b, stagesFor(d.pipeline_id).filter(s => s.id !== d.stage_id).map(s => ({ label: s.name, icon: s.is_won ? 'check' : s.is_lost ? 'x' : 'chevron', onClick: () => moveToStage(d, s, null, reload) }))), 0) });
                if (d.status !== 'won' && outcomeStage(d.pipeline_id, 'won')) items.push({ label: 'Mark won', icon: 'check', onClick: () => moveToStage(d, outcomeStage(d.pipeline_id, 'won'), null, reload) });
                if (d.status !== 'lost' && outcomeStage(d.pipeline_id, 'lost')) items.push({ label: 'Mark lost', icon: 'x', onClick: () => moveToStage(d, outcomeStage(d.pipeline_id, 'lost'), null, reload) });
                items.push('sep', d.archived_at ? { label: 'Restore', icon: 'refresh', onClick: () => setArchived(d, false, reload) } : { label: 'Archive', icon: 'trash', danger: true, onClick: () => setArchived(d, true, reload) });
            }
            C.menu(b, items);
        });
        function paint() {
            const rows = filtered();
            view.querySelector('#count').textContent = `${rows.length} deal${rows.length === 1 ? '' : 's'}${ls.rows.length >= 1000 ? ' (first 1000 loaded)' : ''}`;
            renderKpis(rows);
            boardEl.hidden = ls.view !== 'board'; view.querySelector('#table-card').hidden = ls.view !== 'table';
            if (ls.view === 'board') renderBoard(rows); else renderTable(rows);
        }
        async function reload(silent) {
            try { ls.rows = await fetchDeals(); paint(); }
            catch (e) { if (!silent) C.errorState(ls.view === 'board' ? boardEl : tableEl, e, reload); }
        }
        await reload();
        const liveReload = C.debounce(() => reload(true), 800);
        if (myRoute !== routeSeq) return;
        unsub = C.subscribe('deals', [{ table: 'crm_deals' }], liveReload);
        if (C.param('new') === '1') { C.setParam('new', null, true); openDealEditor(null, { pipeline_id: ls.pipeline }, d => go(`/deals/?id=${d.id}`)); }
    }

    /* ------------------------------------------------------------- record */
    async function showRecord(id) {
        const myRoute = ++routeSeq;
        if (unsub) { unsub(); unsub = null; }
        C.loading(view, 'Loading deal…');
        let d;
        try { d = (await C.q(sb.from('crm_deals').select(SELECT).eq('id', id).maybeSingle())).data; }
        catch (e) { return C.errorState(view, e, () => showRecord(id)); }
        if (!d) { view.innerHTML = `<a class="crm-back" href="/deals/">${C.icon('arrow')}All deals</a>`; C.empty(view.appendChild(document.createElement('div')), 'Deal not found', 'It may have been deleted, or you may not have access to it.'); return; }
        lk = await C.lookups();
        const canEdit = L.canEdit({ owner_id: d.owner_id, created_by: d.created_by }, me);
        const stages = stagesFor(d.pipeline_id);
        const stage = lk.stageById[d.stage_id] || {};
        const pipeline = pipelineOf(d.pipeline_id) || {};
        document.title = `${d.title} · Deals · WorkSuite`;
        WSShell.setCrumb(d.title);

        const [tasks, events, invoices, projects] = await Promise.all([
            C.related('tasks', 'deal_id', id, 'id, title, status, priority, assignee_id, due_date, completed_at, archived_at, created_at', b => b.is('archived_at', null)),
            C.related('calendar_events', 'deal_id', id, 'id, title, starts_at, ends_at, event_type, status, owner_id', b => b.order('starts_at', { ascending: false })),
            ctx.isManager ? C.related('invoices', 'deal_id', id, 'id, invoice_number, invoice_date, due_date, status, total, amount_paid, balance, currency') : Promise.resolve([]),
            C.related('projects', 'deal_id', id, 'id, name, status, due_date'),
        ]);
        const curIdx = stages.findIndex(s => s.id === d.stage_id);
        const trackHtml = stages.map((s, i) => {
            const cls = s.id === d.stage_id ? (s.is_won ? 'on won' : s.is_lost ? 'on lost' : 'on') : (i < curIdx && !stage.is_lost && !s.is_won && !s.is_lost ? 'done' : '');
            return `<button type="button" class="${cls}" data-stage="${esc(s.id)}" title="${esc(s.name)} · ${s.probability}%" ${canEdit ? '' : 'disabled'}>${esc(s.name)}</button>`;
        }).join('');

        view.innerHTML = `
            <a class="crm-back" href="/deals/" data-nav>${C.icon('arrow')}All deals</a>
            <div class="crm-record-head">
                <span class="ws-avatar xl">${C.icon('deal', 'lg')}</span>
                <div class="titles">
                    <h1>${esc(d.title)}</h1>
                    <div class="meta">
                        <b style="font-size:16px">${esc(L.money(d.value, d.currency))}</b>
                        ${C.statusBadge(L.DEAL_STATUS, d.status)}
                        ${d.archived_at ? C.badge('mute', 'Archived') : ''}
                        <span>${esc(pipeline.name || 'Pipeline')} · ${esc(stage.name || '')} · ${d.probability}%</span>
                        ${d.contact_id ? C.entityChip('contact', d.contact_id, contactName(d) || 'Contact') : ''}
                        ${d.organization ? `<span>${C.icon('building', 'sm')} ${esc(d.organization)}</span>` : ''}
                        <span>Owner: ${C.personHtml(d.owner_id)}</span>
                        ${C.tagsHtml(d.tags)}
                    </div>
                </div>
                <div class="actions">
                    ${canEdit ? `<button type="button" class="ws-btn" id="edit-btn">${C.icon('edit')}<span>Edit</span></button>` : ''}
                    <button type="button" class="ws-btn" id="task-btn">${C.icon('tasks')}<span>Task</span></button>
                    <button type="button" class="ws-btn" id="meet-btn">${C.icon('calendar')}<span>Meeting</span></button>
                    ${canEdit && d.status !== 'won' && outcomeStage(d.pipeline_id, 'won') ? `<button type="button" class="ws-btn primary" id="won-btn">${C.icon('check')}<span>Mark won</span></button>` : ''}
                    ${canEdit && d.status === 'open' && outcomeStage(d.pipeline_id, 'lost') ? `<button type="button" class="ws-btn danger" id="lost-btn">${C.icon('x')}<span>Mark lost</span></button>` : ''}
                    <button type="button" class="ws-btn icon" id="more-btn" aria-label="More actions">${C.icon('more')}</button>
                </div>
            </div>
            <div class="crm-stage-track" id="track" aria-label="Pipeline stage">${trackHtml}</div>
            <div id="tabs"></div>
            <section class="crm-tabpanel" data-panel="overview">
                <div class="crm-detail">
                    <div class="ws-stack">
                        <div class="ws-card">
                            <div class="crm-section-title"><h3>Details</h3></div>
                            <dl class="crm-props">
                                <div><dt>Value</dt><dd>${esc(L.money(d.value, d.currency))}</dd></div>
                                <div><dt>Weighted value</dt><dd>${esc(L.money(weighted(d), d.currency))} <span class="muted">(${d.probability}%)</span></dd></div>
                                <div><dt>Pipeline</dt><dd>${esc(pipeline.name || '—')}</dd></div>
                                <div><dt>Stage</dt><dd>${stage.color ? `<span class="crm-dot ${esc(stage.color)}"></span> ` : ''}${esc(stage.name || '—')}</dd></div>
                                <div><dt>Status</dt><dd>${C.statusBadge(L.DEAL_STATUS, d.status)}</dd></div>
                                <div><dt>Expected close</dt><dd>${esc(L.fmtDate(d.expected_close_date) || '—')}</dd></div>
                                <div><dt>Actual close</dt><dd>${esc(L.fmtDate(d.actual_close_date) || '—')}</dd></div>
                                <div><dt>Source</dt><dd>${esc(d.source || '—')}</dd></div>
                                <div><dt>Contact</dt><dd>${d.contact_id ? `<a href="/contacts/?id=${esc(d.contact_id)}">${esc(contactName(d) || 'Contact')}</a>` : '—'}</dd></div>
                                <div><dt>Organisation</dt><dd>${esc(d.organization || '—')}</dd></div>
                                <div><dt>Owner</dt><dd>${C.personHtml(d.owner_id)}</dd></div>
                                ${d.lead_id ? `<div><dt>Converted from lead</dt><dd><a href="/leads/?id=${esc(d.lead_id)}">Open lead</a></dd></div>` : ''}
                                <div><dt>Created</dt><dd>${esc(L.fmtDateTime(d.created_at))} by ${esc(C.personName(d.created_by))}</dd></div>
                                <div><dt>Last updated</dt><dd>${esc(L.fmtDateTime(d.updated_at))}</dd></div>
                                <div><dt>Deal ID</dt><dd class="muted" style="font-size:12px">${esc(d.id)}</dd></div>
                            </dl>
                            ${d.description ? `<div class="crm-section-title" style="margin-top:18px"><h3>Description</h3></div><div class="crm-desc">${C.linkify(C.nl2br(d.description))}</div>` : ''}
                        </div>
                        <div class="ws-card">
                            <div class="crm-section-title"><h3>Add a note</h3></div>
                            <div id="composer"></div>
                            <div id="recent-activity"></div>
                        </div>
                    </div>
                    <div class="ws-stack">
                        <div class="ws-card">
                            <div class="crm-section-title"><h3>Summary</h3></div>
                            <dl class="crm-props one">
                                <div><dt>Open tasks</dt><dd>${tasks.filter(t => !t.completed_at).length}</dd></div>
                                <div><dt>Meetings</dt><dd>${events.filter(e => e.status !== 'cancelled').length}</dd></div>
                                ${ctx.isManager ? `<div><dt>Invoiced</dt><dd>${esc(L.money(invoices.filter(i => i.status !== 'cancelled' && i.status !== 'draft').reduce((a, i) => a + Number(i.total || 0), 0), d.currency))}</dd></div><div><dt>Outstanding</dt><dd>${esc(L.money(invoices.filter(i => !['paid', 'cancelled', 'draft'].includes(i.status)).reduce((a, i) => a + Number(i.balance || 0), 0), d.currency))}</dd></div>` : ''}
                                <div><dt>Days in pipeline</dt><dd>${Math.max(0, L.daysBetween(L.istDate(d.created_at), d.actual_close_date || L.todayIST()) || 0)}</dd></div>
                            </dl>
                        </div>
                        ${projects.length ? `<div class="ws-card"><div class="crm-section-title"><h3>Projects</h3></div><ul class="crm-list compact">${projects.map(p => `<li>${C.icon('folder')}<div class="main"><b><a href="/projects/?id=${esc(p.id)}">${esc(p.name)}</a></b><span>${esc(L.PROJECT_STATUS[p.status] ? L.PROJECT_STATUS[p.status].label : p.status)}${p.due_date ? ' · due ' + esc(L.fmtDate(p.due_date)) : ''}</span></div></li>`).join('')}</ul></div>` : ''}
                        <div class="ws-card">
                            <div class="crm-section-title"><h3>Upcoming</h3></div>
                            ${(() => { const up = events.filter(e => e.status !== 'cancelled' && new Date(e.ends_at) >= new Date()).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at)).slice(0, 4); return up.length ? `<ul class="crm-list compact">${up.map(e => `<li>${C.icon('calendar')}<div class="main"><b><a href="/calendar/?id=${esc(e.id)}">${esc(e.title)}</a></b><span>${esc(L.fmtDateTime(e.starts_at))}</span></div></li>`).join('')}</ul>` : '<div class="muted" style="font-size:13px">No upcoming meetings.</div>'; })()}
                        </div>
                    </div>
                </div>
            </section>
            <section class="crm-tabpanel" data-panel="activity" hidden><div class="ws-card"><div id="activity"></div></div></section>
            <section class="crm-tabpanel" data-panel="tasks" hidden><div class="ws-card flush"><div class="ws-card-head"><h3>Tasks</h3><div class="right"><button type="button" class="ws-btn sm primary" id="task-btn-2">${C.icon('plus')}<span>New task</span></button></div></div><div id="tasks"></div></div></section>
            <section class="crm-tabpanel" data-panel="meetings" hidden><div class="ws-card flush"><div class="ws-card-head"><h3>Meetings &amp; calls</h3><div class="right"><button type="button" class="ws-btn sm primary" id="meet-btn-2">${C.icon('plus')}<span>Schedule</span></button></div></div><div id="events"></div></div></section>
            <section class="crm-tabpanel" data-panel="documents" hidden><div class="ws-card"><div class="crm-section-title"><h3>Documents</h3></div><div id="documents"></div></div></section>
            ${ctx.isManager ? `<section class="crm-tabpanel" data-panel="invoices" hidden><div class="ws-card flush"><div class="ws-card-head"><h3>Invoices</h3><div class="right"><a class="ws-btn sm primary" href="/invoices/?new=1&deal_id=${esc(d.id)}${d.contact_id ? '&contact_id=' + esc(d.contact_id) : ''}">${C.icon('plus')}<span>New invoice</span></a></div></div><div id="invoices"></div></div></section>` : ''}
            <section class="crm-tabpanel" data-panel="projects" hidden><div class="ws-card flush"><div class="ws-card-head"><h3>Projects</h3><div class="right"><a class="ws-btn sm primary" href="/projects/?new=1&deal_id=${esc(d.id)}${d.contact_id ? '&contact_id=' + esc(d.contact_id) : ''}">${C.icon('plus')}<span>New project</span></a></div></div><div id="projects"></div></div></section>
            <section class="crm-tabpanel" data-panel="notes" hidden><div class="ws-card"><div class="crm-section-title"><h3>Notes</h3></div><div id="notes-composer"></div><div id="notes"></div></div></section>`;

        view.querySelector('[data-nav]').addEventListener('click', e => { e.preventDefault(); go('/deals/'); });
        const tabItems = [
            { key: 'overview', label: 'Overview' }, { key: 'activity', label: 'Activity' },
            { key: 'tasks', label: 'Tasks', count: tasks.filter(t => !t.completed_at).length },
            { key: 'meetings', label: 'Meetings', count: events.filter(e => e.status !== 'cancelled').length },
            { key: 'documents', label: 'Documents' },
        ];
        if (ctx.isManager) tabItems.push({ key: 'invoices', label: 'Invoices', count: invoices.length });
        tabItems.push({ key: 'projects', label: 'Projects', count: projects.length }, { key: 'notes', label: 'Notes' });
        const loaded = {};
        const tabs = C.tabs(view.querySelector('#tabs'), tabItems, { hash: true, onChange: k => loadTab(k) });
        const feed = C.activityFeed(view.querySelector('#recent-activity'), { entity_type: 'deal', entity_id: id, deal_id: id, limit: 8 });
        C.comments(view.querySelector('#composer'), { entity_type: 'deal', entity_id: id, onPosted: () => { feed.reload(); if (loaded.activity) loaded.activity.reload(); if (loaded.notes) loaded.notes.reload(); } });
        const taskStatusMap = Object.fromEntries(lk.taskStatuses.map(s => [s.key, s]));
        const linkDefaults = { deal_id: id, contact_id: d.contact_id || null };

        function loadTab(k) {
            if (loaded[k]) return;
            if (k === 'activity') loaded.activity = C.activityFeed(view.querySelector('#activity'), { entity_type: 'deal', entity_id: id, deal_id: id, limit: 100 });
            if (k === 'notes') { C.comments(view.querySelector('#notes-composer'), { entity_type: 'deal', entity_id: id, onPosted: () => { loaded.notes.reload(); feed.reload(); } }); loaded.notes = C.activityFeed(view.querySelector('#notes'), { entity_type: 'deal', entity_id: id, actions: ['note.added'], limit: 100 }); }
            if (k === 'documents') loaded.documents = C.documents(view.querySelector('#documents'), { entity_type: 'deal', entity_id: id, canEdit: true });
            if (k === 'tasks') { loaded.tasks = true; C.table(view.querySelector('#tasks'), { rows: tasks, onRow: t => { location.href = `/tasks/?id=${t.id}`; }, sort: { key: 'due_date', dir: 'asc' }, columns: [
                { key: 'title', label: 'Task', lead: true, render: t => `<span class="primary-text">${esc(t.title)}</span>` },
                { key: 'status', label: 'Status', render: t => C.statusBadge(taskStatusMap, t.status) },
                { key: 'priority', label: 'Priority', render: t => C.priorityBadge(t.priority) },
                { key: 'assignee_id', label: 'Assignee', value: t => C.personName(t.assignee_id), render: t => C.personHtml(t.assignee_id, { link: false }) },
                { key: 'due_date', label: 'Due', render: t => C.dueHtml(t) },
            ], empty: { title: 'No tasks', sub: 'Create a follow-up task for this deal.' } }); }
            if (k === 'meetings') { loaded.meetings = true; C.table(view.querySelector('#events'), { rows: events, onRow: e => { location.href = `/calendar/?id=${e.id}`; }, sort: { key: 'starts_at', dir: 'desc' }, columns: [
                { key: 'title', label: 'Event', lead: true, render: e => `<span class="primary-text">${esc(e.title)}</span>` },
                { key: 'event_type', label: 'Type', render: e => C.statusBadge(L.EVENT_TYPE, e.event_type) },
                { key: 'starts_at', label: 'When', render: e => `${esc(L.fmtDateTime(e.starts_at))}${e.status === 'cancelled' ? ' ' + C.badge('mute', 'Cancelled') : ''}` },
                { key: 'owner_id', label: 'Organiser', value: e => C.personName(e.owner_id), render: e => C.personHtml(e.owner_id, { link: false }) },
            ], empty: { title: 'No meetings', sub: 'Schedule a meeting or call for this deal.' } }); }
            if (k === 'invoices') { loaded.invoices = true; C.table(view.querySelector('#invoices'), { rows: invoices, onRow: i => { location.href = `/invoices/?id=${i.id}`; }, sort: { key: 'invoice_date', dir: 'desc' }, columns: [
                { key: 'invoice_number', label: 'Invoice', lead: true, render: i => `<span class="primary-text">${esc(i.invoice_number)}</span>` },
                { key: 'invoice_date', label: 'Date', render: i => esc(L.fmtDate(i.invoice_date)) },
                { key: 'due_date', label: 'Due', render: i => esc(L.fmtDate(i.due_date) || '—') },
                { key: 'status', label: 'Status', render: i => { const s = L.invoiceStatus(i); return C.badge(L.INVOICE_STATUS[s].color, L.INVOICE_STATUS[s].label); } },
                { key: 'total', label: 'Total', num: true, render: i => esc(L.money(i.total, i.currency)) },
                { key: 'balance', label: 'Balance', num: true, render: i => esc(L.money(i.balance, i.currency)) },
            ], empty: { title: 'No invoices', sub: 'Invoices raised for this deal will appear here.' } }); }
            if (k === 'projects') { loaded.projects = true; C.table(view.querySelector('#projects'), { rows: projects, onRow: p => { location.href = `/projects/?id=${p.id}`; }, columns: [
                { key: 'name', label: 'Project', lead: true, render: p => `<span class="primary-text">${esc(p.name)}</span>` },
                { key: 'status', label: 'Status', render: p => C.statusBadge(L.PROJECT_STATUS, p.status) },
                { key: 'due_date', label: 'Due', render: p => esc(L.fmtDate(p.due_date) || '—') },
            ], empty: { title: 'No projects', sub: 'Projects delivered for this deal will appear here.' } }); }
        }
        loadTab(tabs.active);

        // Stage track
        view.querySelector('#track').addEventListener('click', async e => {
            const b = e.target.closest('[data-stage]'); if (!b || b.disabled) return;
            const s = lk.stageById[b.dataset.stage]; if (!s || s.id === d.stage_id) return;
            await moveToStage(d, s, null, () => showRecord(id)).catch(() => {});
        });
        // Actions
        const on = (sel, fn) => { const el = view.querySelector(sel); if (el) el.addEventListener('click', fn); };
        on('#edit-btn', () => openDealEditor(d, null, () => showRecord(id)));
        const newTask = () => C.openTaskEditor({ defaults: { ...linkDefaults, title: '' }, onSaved: () => showRecord(id) });
        const newMeet = () => C.openEventEditor({ defaults: { ...linkDefaults, title: `Meeting: ${d.title}` }, onSaved: () => showRecord(id) });
        on('#task-btn', newTask); on('#task-btn-2', newTask); on('#meet-btn', newMeet); on('#meet-btn-2', newMeet);
        on('#won-btn', () => moveToStage(d, outcomeStage(d.pipeline_id, 'won'), null, () => showRecord(id)).catch(() => {}));
        on('#lost-btn', () => moveToStage(d, outcomeStage(d.pipeline_id, 'lost'), null, () => showRecord(id)).catch(() => {}));
        on('#more-btn', e => {
            const items = [{ label: 'Duplicate deal', icon: 'plus', onClick: () => duplicateDeal(d) }];
            if (d.status !== 'open' && canEdit) { const open = L.firstOpenStage(lk.stages, d.pipeline_id); if (open) items.push({ label: 'Reopen deal', icon: 'refresh', onClick: () => moveToStage(d, open, null, () => showRecord(id)).catch(() => {}) }); }
            if (canEdit) items.push('sep', d.archived_at ? { label: 'Restore deal', icon: 'refresh', onClick: () => setArchived(d, false, () => showRecord(id)) } : { label: 'Archive deal', icon: 'trash', danger: true, onClick: () => setArchived(d, true, () => showRecord(id)) });
            if (ctx.isManager) items.push({ label: 'Delete permanently', icon: 'trash', danger: true, onClick: () => deleteDeal(d) });
            C.menu(e.currentTarget, items);
        });
        if (myRoute !== routeSeq) return;
        unsub = C.subscribe('deal', [{ table: 'crm_deals', filter: `id=eq.${id}` }], C.debounce(() => { if (C.param('id') === id) showRecord(id); }, 600));
    }

    /* ------------------------------------------------- pipeline settings */
    async function openPipelineSettings(after) {
        lk = await C.lookups(true);
        let current = (lk.defaultPipeline && lk.defaultPipeline.id) || (lk.pipelines[0] && lk.pipelines[0].id) || null;
        const body = document.createElement('div');
        const m = C.modal({ title: 'Configure pipelines', size: 'wide', body, actions: [{ label: 'Done', primary: true, close: true }], onClose: () => { if (after) after(); } });

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
                ${p ? `<p class="muted" style="font-size:13px;margin:0 0 10px">${p.company ? `Company: ${esc(p.company)}` : 'Shared by every company'}. Stage names are free; only <b>Won</b> / <b>Lost</b> flags and the probability drive the numbers.</p>
                <div class="crm-table-wrap"><table class="ws-table"><thead><tr><th style="width:36px"></th><th>Stage</th><th class="num">Probability</th><th>Outcome</th><th>Colour</th><th class="actions"></th></tr></thead><tbody>
                ${stages.map((s, i) => `<tr data-stage="${esc(s.id)}">
                    <td><span class="crm-dot ${esc(s.color || '')}"></span></td>
                    <td><input type="text" data-f="name" value="${esc(s.name)}" aria-label="Stage name" style="min-height:34px;padding:5px 8px;width:100%"></td>
                    <td class="num"><input type="number" data-f="probability" min="0" max="100" value="${s.probability}" aria-label="Probability" style="min-height:34px;padding:5px 8px;width:80px"></td>
                    <td><select data-f="outcome" aria-label="Outcome" style="min-height:34px;padding:5px 8px"><option value="open"${!s.is_won && !s.is_lost ? ' selected' : ''}>Open</option><option value="won"${s.is_won ? ' selected' : ''}>Won</option><option value="lost"${s.is_lost ? ' selected' : ''}>Lost</option></select></td>
                    <td><select data-f="color" aria-label="Colour" style="min-height:34px;padding:5px 8px">${COLORS.map(c => `<option value="${c}"${s.color === c ? ' selected' : ''}>${c}</option>`).join('')}</select></td>
                    <td class="actions"><button type="button" class="ws-btn sm icon" data-up ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button> <button type="button" class="ws-btn sm icon" data-down ${i === stages.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button> <button type="button" class="ws-btn sm icon" data-del aria-label="Delete stage">${C.icon('trash')}</button></td>
                </tr>`).join('') || '<tr><td colspan="6" class="muted" style="text-align:center;padding:14px">No stages yet.</td></tr>'}
                </tbody></table></div>
                <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="ws-btn sm" id="ps-add">${C.icon('plus')}<span>Add stage</span></button><span class="muted" style="font-size:12.5px;align-self:center">Edits save when you leave a field.</span></div>` : `<div class="ws-empty"><b>No pipeline yet</b>Create one to start tracking deals.</div>`}`;
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
                const save = async patch => { try { await C.q(sb.from('crm_pipeline_stages').update(patch).eq('id', s.id)); lk = await C.lookups(true); render(); } catch (e) { C.toast(e.message, 'bad'); render(); } };
                tr.querySelector('[data-f=name]').addEventListener('change', e => { const v = e.target.value.trim(); if (v && v !== s.name) save({ name: v }); });
                tr.querySelector('[data-f=probability]').addEventListener('change', e => { const v = Math.max(0, Math.min(100, Number(e.target.value) || 0)); if (v !== s.probability) save({ probability: v }); });
                tr.querySelector('[data-f=outcome]').addEventListener('change', e => { const v = e.target.value; save({ is_won: v === 'won', is_lost: v === 'lost', probability: v === 'won' ? 100 : v === 'lost' ? 0 : s.probability }); });
                tr.querySelector('[data-f=color]').addEventListener('change', e => save({ color: e.target.value }));
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
