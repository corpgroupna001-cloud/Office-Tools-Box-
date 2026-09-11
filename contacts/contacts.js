/* ============================================================================
   Contacts — the list with the "Filter + search" bar, CSV import / export,
   an activities view, and the contact card (a slide-over): editable fields,
   custom fields, company, deals, to-dos, meetings, documents, invoices,
   projects and history.

   URLs:  /contacts/                list          /contacts/?view=activity
          /contacts/?id=<uuid>      the contact card (also inside a slide-over)
          /contacts/?new=1          opens "Create contact"
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc, B = window.WSB24;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'contacts', crumb: 'Contacts', layout: 'b24' });
    const sb = ctx.sb, me = ctx.user;

    const STATUS = { active: { label: 'Active', color: 'present' }, inactive: { label: 'Inactive', color: 'weekoff' }, archived: { label: 'Archived', color: 'mute' } };
    const SOURCES = ['Website', 'Referral', 'Cold call', 'Email campaign', 'Social media', 'Event', 'Partner', 'Walk-in', 'Other'];
    const BASE = 'id, company, first_name, last_name, full_name, organization, job_title, email, email2, phone, phone2, address, city, state, country, postal_code, website, source, owner_id, status, notes, tags, lead_id, archived_at, created_by, created_at, updated_at';
    const [cols, cf, lv, invLv] = await Promise.all([
        B.columns('crm_contacts', BASE + ', number, custom, company_id, company_rec:crm_companies(id, title)', BASE),
        B.customFields('contact'), B.levels('contact'), B.levels('invoice'),
    ]);
    const SELECT = cols.select;
    const canAdd = lv.add !== 'none';
    const canEditC = c => B.allowed(lv.edit, c, me);
    const canDeleteC = c => B.allowed(lv.delete, c, me);
    const nameOf = c => c.full_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.organization || '(no name)';
    const companyOf = c => (c.company_rec && c.company_rec.title) || c.organization || '';

    const page = { mode: null, grid: null, filter: null, view: 'list' };
    function route() {
        const id = C.param('id');
        if (id) return showRecord(id);
        if (page.mode === 'list') return refreshList();
        return showList();
    }
    window.addEventListener('popstate', route);
    const openContact = id => B.openRecord(`/contacts/?id=${id}`, refreshList);

    /* ------------------------------------------------------ create / save */
    function contactFields() {
        return [
            { name: 'first_name', label: 'First name', type: 'text', required: true },
            { name: 'last_name', label: 'Last name', type: 'text' },
            { name: 'job_title', label: 'Position', type: 'text' },
            ...(cols.full ? [{ name: 'company_id', label: 'Company', type: 'entity', entity: 'company', placeholder: 'Search companies' }] : []),
            { name: 'organization', label: 'Company name (text)', type: 'text' },
            { name: 'phone', label: 'Phone', type: 'tel' },
            { name: 'email', label: 'Email', type: 'email' },
            { name: 'owner_id', label: 'Responsible', type: 'people', none: 'Not assigned' },
            { name: 'source', label: 'Source', type: 'select', options: SOURCES, placeholder: 'How did we meet them?' },
            { name: 'city', label: 'City', type: 'text' },
            { name: 'tags', label: 'Tags', type: 'tags', full: true },
            { name: 'notes', label: 'Comment', type: 'textarea', full: true },
        ];
    }
    function clean(v) {
        const out = { ...v };
        ['email', 'email2'].forEach(k => { if (k in out) out[k] = L.normalizeEmail(out[k]); });
        ['first_name', 'last_name', 'organization', 'job_title', 'phone', 'phone2', 'address', 'city', 'state', 'country', 'postal_code', 'website', 'source', 'notes'].forEach(k => { if (k in out) out[k] = out[k] ? String(out[k]).trim() || null : null; });
        if ('owner_id' in out) out.owner_id = out.owner_id || null;
        if ('company_id' in out) out.company_id = out.company_id || null;
        if ('tags' in out) out.tags = out.tags || [];
        return out;
    }
    async function duplicateCheck(values, excludeId) {
        const emails = [values.email, values.email2].map(L.normalizeEmail).filter(Boolean);
        const phones = [values.phone, values.phone2].filter(Boolean);
        const ors = [];
        emails.forEach(e => { ors.push(`email.ilike.${e}`); ors.push(`email2.ilike.${e}`); });
        phones.forEach(p => { const d = String(p).replace(/\D/g, '').slice(-10); if (d.length >= 6) { ors.push(`phone.ilike.%${d}%`); ors.push(`phone2.ilike.%${d}%`); } });
        if (!ors.length) return true;
        const r = await sb.from('crm_contacts').select('id, full_name, organization, email, phone, email2, phone2, status').or(ors.join(',')).neq('status', 'archived').limit(10);
        if (r.error) return true;
        const dupes = L.findDuplicateContacts(values, r.data || [], excludeId);
        if (!dupes.length) return true;
        return new Promise(resolve => {
            C.modal({
                title: 'Possible duplicate',
                body: `<div class="crm-warn" style="margin-bottom:12px">A contact with the same email or phone already exists.</div>
                       <ul class="crm-list compact">${dupes.map(d => `<li>${C.avatarHtml({ name: d.full_name })}<div class="main"><b>${esc(d.full_name || d.organization)}</b><span>${esc([d.organization, d.email || d.email2, d.phone || d.phone2].filter(Boolean).join(' · '))}</span></div></li>`).join('')}</ul>`,
                actions: [
                    { label: 'Open existing', onClick: api => { api.close(); resolve(false); openContact(dupes[0].id); } },
                    { label: 'Cancel', close: true },
                    { label: 'Save anyway', primary: true, onClick: api => { api.close(); resolve(true); } },
                ],
                onClose: () => resolve(false),
            });
        });
    }
    async function openContactEditor(defaults, onSaved) {
        return C.formModal({
            title: 'New contact', size: 'wide', fields: contactFields(), values: { status: 'active', owner_id: me.id, ...(defaults || {}) }, submitLabel: 'Create contact',
            onSubmit: async (v, api) => {
                const values = clean(v);
                if (!cols.full) delete values.company_id;
                api.close();
                if (!await duplicateCheck(values, null)) return null;
                try {
                    const saved = (await C.q(sb.from('crm_contacts').insert({ ...values, status: 'active', created_by: me.id }).select(SELECT).single())).data;
                    if (saved.owner_id && saved.owner_id !== me.id) C.pushNotify({ to: saved.owner_id, title: 'Contact assigned to you', body: nameOf(saved), url: `/contacts/?id=${saved.id}`, tag: 'crm' });
                    C.toast('Contact created', 'ok');
                    if (onSaved) onSaved(saved);
                    return saved;
                } catch (e) { C.toast(e.message, 'bad'); return null; }
            },
        });
    }
    async function updateContact(c, patch) {
        const values = clean(patch);
        if ('first_name' in values && !values.first_name) throw new Error('The contact needs a first name.');
        if ((values.email && values.email !== c.email) || (values.phone && values.phone !== c.phone)) {
            if (!await duplicateCheck({ ...c, ...values }, c.id)) throw Object.assign(new Error('Not saved'), { silent: true });
        }
        const saved = (await C.q(sb.from('crm_contacts').update(values).eq('id', c.id).select(SELECT).single())).data;
        if ('owner_id' in values && saved.owner_id && saved.owner_id !== me.id && saved.owner_id !== c.owner_id) C.pushNotify({ to: saved.owner_id, title: 'Contact assigned to you', body: nameOf(saved), url: `/contacts/?id=${saved.id}`, tag: 'crm' });
        Object.assign(c, saved);
        if (window.WSShell && WSShell.inSlider) WSShell.sliderMessage('changed', { id: c.id });
        return saved;
    }
    async function setStatus(c, status, after) {
        if (status === 'archived' && !await C.confirm({ title: `Archive ${nameOf(c)}?`, message: 'The contact is hidden from lists but keeps every deal, task, document and note. You can restore it later.', okText: 'Archive', danger: true })) return;
        try { await updateContact(c, { status, archived_at: status === 'archived' ? new Date().toISOString() : null }); C.toast(status === 'archived' ? 'Contact archived' : 'Contact restored', 'ok'); if (after) after(); }
        catch (e) { if (!e.silent) C.toast(e.message, 'bad'); }
    }
    async function deleteContact(c, after) {
        if (!await C.confirm({ title: 'Delete this contact permanently?', message: 'Deals, tasks and invoices linked to it lose the link; their own history stays. Archiving is usually the better choice.', okText: 'Delete permanently', danger: true })) return;
        try {
            await C.q(sb.from('crm_contacts').delete().eq('id', c.id));
            C.toast('Contact deleted', 'ok');
            if (window.WSShell && WSShell.inSlider) { WSShell.sliderMessage('deleted', { id: c.id }); WSShell.closeSlider(); }
            else if (after) after(); else location.href = '/contacts/';
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function logInteraction(c, action, title, after) {
        await C.formModal({
            title, fields: [
                { name: 'summary', label: 'What happened?', type: 'textarea', required: true, full: true, rows: 4 },
                { name: 'when', label: 'When', type: 'datetime', required: true, value: new Date().toISOString() },
            ],
            submitLabel: 'Save', onSubmit: async v => {
                await C.logActivity(action, 'contact', c.id, v.summary.slice(0, 200), { at: v.when, summary: v.summary }, { contact_id: c.id });
                C.toast('Saved', 'ok'); if (after) after();
            },
        });
    }
    async function newDealFor(c, after) {
        const lk = await C.lookups();
        if (!lk.pipelines.length) return C.alert({ title: 'No pipeline yet', message: 'Ask a manager to set up a sales pipeline in Deals first.' });
        const pipeline = lk.defaultPipeline || lk.pipelines[0];
        const open = pid => L.stagesOf(lk.stages, pid).filter(s => !s.is_won && !s.is_lost);
        return C.formModal({
            title: `New deal for ${nameOf(c)}`, size: 'wide',
            fields: [
                { name: 'title', label: 'Deal name', type: 'text', required: true, full: true },
                { name: 'value', label: 'Amount', type: 'money', required: true },
                { name: 'currency', label: 'Currency', type: 'select', options: ['INR', 'USD', 'EUR', 'GBP', 'AED'], required: true },
                { name: 'pipeline_id', label: 'Pipeline', type: 'select', options: lk.pipelines.map(p => ({ value: p.id, label: p.name })), required: true },
                { name: 'stage_id', label: 'Stage', type: 'select', options: open(pipeline.id).map(s => ({ value: s.id, label: s.name })), required: true },
                { name: 'owner_id', label: 'Responsible', type: 'people', none: null },
                { name: 'expected_close_date', label: 'Expected close', type: 'date' },
            ],
            values: { title: `${companyOf(c) || nameOf(c)} deal`, value: 0, currency: 'INR', pipeline_id: pipeline.id, stage_id: (open(pipeline.id)[0] || {}).id || '', owner_id: c.owner_id || me.id },
            onReady: f => f.field('pipeline_id').el.addEventListener('change', e => { f.field('stage_id').el.innerHTML = open(e.target.value).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join(''); }),
            submitLabel: 'Create deal',
            onSubmit: async v => {
                const row = { ...v, contact_id: c.id, organization: c.organization || null, expected_close_date: v.expected_close_date || null, created_by: me.id };
                if (cols.full && c.company_id) row.company_id = c.company_id;
                const { data } = await C.q(sb.from('crm_deals').insert(row).select('id').single());
                C.toast('Deal created', 'ok'); if (after) after(data);
                return data;
            },
        });
    }

    /* ------------------------------------------------------------ list */
    function filterFields() {
        return [
            { key: 'status', title: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'archived', label: 'Archived' }] },
            { key: 'owner', title: 'Responsible', type: 'user', column: 'owner_id', options: B.peopleOptions() },
            { key: 'source', title: 'Source', type: 'select', options: SOURCES },
            { key: 'created', title: 'Created', type: 'date', column: 'created_at', datetime: true },
            { key: 'organization', title: 'Company name', type: 'text', default: false },
            { key: 'email', title: 'Email', type: 'text', default: false },
            { key: 'phone', title: 'Phone', type: 'text', default: false },
            { key: 'city', title: 'City', type: 'text', default: false },
            { key: 'tag', title: 'Tag', type: 'text', default: false, apply: (b, v) => b.contains('tags', [String(v).trim()]) },
            ...B.cfFilters(cf),
        ];
    }
    const PRESETS = [
        { key: 'active', title: 'Active contacts', values: { status: 'active' } },
        { key: 'mine', title: 'My contacts', values: { owner: 'me', status: 'active' } },
        { key: 'all', title: 'All contacts', values: {} },
        { key: 'archived', title: 'Archived contacts', values: { status: 'archived' } },
    ];
    function scoped(builder) {
        const v = page.filter.get().values;
        if (!v.status) builder = builder.neq('status', 'archived');
        return page.filter.apply(builder, { searchColumns: ['full_name', 'organization', 'email', 'phone', 'city'] });
    }
    async function showList() {
        page.mode = 'list';
        WSShell.setCrumb('Contacts');
        document.title = 'Contacts · WorkSuite';
        const menu = [];
        if (lv.import !== 'none' && canAdd) menu.push({ label: 'Import from CSV', icon: 'upload', onClick: importContacts });
        if (lv.export !== 'none') menu.push({ label: 'Export to CSV', icon: 'download', onClick: exportContacts });
        view.innerHTML = B.titleBar({ title: 'Contacts', createLabel: canAdd ? 'Create' : '', createMenu: menu.length > 0 }) + `
            <div class="b24-toolbar">
                <div class="b24-views" role="tablist" aria-label="View">
                    <button type="button" role="tab" data-view="list">List</button>
                    <button type="button" role="tab" data-view="activity">Activities</button>
                </div>
                <span class="grow"></span>
                ${!canAdd && menu.length ? `<button type="button" class="ws-btn sm" data-export>${C.icon('download')}<span>Export to CSV</span></button>` : ''}
            </div>
            <div id="body"></div>`;
        page.filter = WSFilter.mount(view.querySelector('[data-filter]'), { id: 'contacts', fields: filterFields(), presets: PRESETS, defaultPreset: 'active', me: me.id, onChange: () => refreshList() });
        const create = view.querySelector('[data-create]');
        if (create) create.addEventListener('click', () => openContactEditor(null, c => { refreshList(); openContact(c.id); }));
        const more = view.querySelector('[data-create-menu]');
        if (more) more.addEventListener('click', () => C.menu(more, menu));
        const ex = view.querySelector('[data-export]'); if (ex) ex.addEventListener('click', exportContacts);
        view.querySelector('.b24-views').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) mountView(b.dataset.view); });
        mountView(C.param('view') === 'activity' ? 'activity' : 'list');
        if (C.param('new') === '1' && canAdd) { C.setParam('new', null, true); openContactEditor(null, c => { refreshList(); openContact(c.id); }); }
    }
    function mountView(kind) {
        page.view = kind;
        C.setParam('view', kind === 'list' ? null : kind, true);
        view.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('on', b.dataset.view === kind); b.setAttribute('aria-selected', String(b.dataset.view === kind)); });
        if (page.grid) { page.grid.destroy(); page.grid = null; }
        const body = view.querySelector('#body'); body.innerHTML = '';
        const host = document.createElement('div'); body.appendChild(host);
        if (kind === 'activity') return mountActivities(host);
        mountGrid(host);
    }
    function refreshList() { if (page.mode === 'list' && page.grid) page.grid.reload(); }
    function gridColumns() {
        const can = lv.edit !== 'none';
        const save = key => async (r, v) => { if (!canEditC(r)) throw new Error('You do not have permission to change this contact.'); await updateContact(r, { [key]: v }); };
        const people = [{ value: '', label: 'Not assigned' }].concat(B.peopleOptions());
        return [
            ...(cols.full ? [{ key: 'number', title: 'ID', width: 70, render: r => esc(r.number == null ? '' : r.number) }] : []),
            { key: 'full_name', title: 'Contact', width: 240, render: r => `<span class="b24-who">${C.avatarHtml({ name: nameOf(r) }, 'sm')}<span><a href="/contacts/?id=${esc(r.id)}" data-open>${esc(nameOf(r))}</a>${r.job_title ? `<span class="sub">${esc(r.job_title)}</span>` : ''}</span></span>` },
            { key: 'organization', title: 'Company', width: 200, render: r => r.company_id ? `<a href="/companies/?id=${esc(r.company_id)}" data-company="${esc(r.company_id)}">${esc(companyOf(r))}</a>` : esc(r.organization || ''), edit: can ? { type: 'text', save: save('organization') } : undefined },
            { key: 'phone', title: 'Phone', width: 150, render: r => r.phone ? `<a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>` : '', edit: can ? { type: 'text', save: save('phone') } : undefined },
            { key: 'email', title: 'Email', width: 210, render: r => r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : '', edit: can ? { type: 'text', save: save('email') } : undefined },
            { key: 'owner_id', title: 'Responsible', width: 180, render: r => C.personHtml(r.owner_id, { link: false }), edit: can ? { type: 'people', options: people, save: save('owner_id') } : undefined },
            { key: 'status', title: 'Status', width: 110, render: r => C.statusBadge(STATUS, r.status) },
            { key: 'created_at', title: 'Created', width: 120, render: r => `<span class="muted">${esc(L.fmtDate(r.created_at, { short: true }))}</span>` },
            { key: 'source', title: 'Source', width: 130, default: false, render: r => esc(r.source || '') },
            { key: 'city', title: 'City', width: 130, default: false, render: r => esc(r.city || '') },
            { key: 'job_title', title: 'Position', width: 150, default: false, render: r => esc(r.job_title || '') },
            { key: 'updated_at', title: 'Modified', width: 120, default: false, render: r => `<span class="muted">${esc(L.fmtRelative(r.updated_at))}</span>` },
            { key: 'tags', title: 'Tags', width: 160, default: false, sortable: false, render: r => C.tagsHtml(r.tags) },
            ...B.cfColumns(cf),
        ];
    }
    function mountGrid(host) {
        const bulk = [];
        if (lv.edit !== 'none') {
            bulk.push({ label: 'Assign responsible', icon: 'user', run: async (ids, o) => {
                const v = await B.pick('Assign responsible', { type: 'people', label: 'Responsible', none: 'Not assigned' }, '');
                if (v === undefined) return false;
                await bulkUpdate(ids, o, { owner_id: v || null });
            } });
            bulk.push({ label: 'Archive', icon: 'trash', run: async (ids, o) => {
                if (!await C.confirm({ title: o.all ? 'Archive every contact in this filter?' : `Archive ${ids.length} contact${ids.length > 1 ? 's' : ''}?`, message: 'Archived contacts keep their deals, tasks and history.', okText: 'Archive', danger: true })) return false;
                await bulkUpdate(ids, o, { status: 'archived', archived_at: new Date().toISOString() });
            } });
        }
        if (lv.delete !== 'none') bulk.push({ label: 'Delete', icon: 'trash', danger: true, run: async (ids, o) => {
            if (!await C.confirm({ title: o.all ? 'Delete every contact in this filter?' : `Delete ${ids.length} contact${ids.length > 1 ? 's' : ''} permanently?`, message: 'Linked deals and tasks lose the link.', okText: 'Delete permanently', danger: true })) return false;
            const b = sb.from('crm_contacts').delete();
            await C.q(o.all ? scoped(b) : b.in('id', ids));
            C.toast('Deleted', 'ok');
        } });
        page.grid = WSGrid.mount(host, {
            id: 'contacts', columns: gridColumns(), sort: { key: 'updated_at', dir: 'desc' },
            load: async ({ offset, limit, sort }) => {
                let b = scoped(sb.from('crm_contacts').select(SELECT));
                b = sort ? b.order(sort.key, { ascending: sort.dir === 'asc', nullsFirst: false }) : b.order('updated_at', { ascending: false });
                return (await C.q(b.range(offset, offset + limit - 1))).data || [];
            },
            count: async () => (await C.q(scoped(sb.from('crm_contacts').select('id', { count: 'exact', head: true })))).count || 0,
            onOpen: r => openContact(r.id),
            rowMenu: r => {
                const items = [{ label: 'Open', icon: 'arrow', onClick: () => openContact(r.id) }];
                items.push({ label: 'New deal', icon: 'deal', onClick: () => newDealFor(r, d => B.openRecord(`/deals/?id=${d.id}`)) });
                items.push({ label: 'Add to-do', icon: 'tasks', onClick: () => C.openTaskEditor({ defaults: { contact_id: r.id, title: '' } }) });
                items.push({ label: 'Schedule meeting', icon: 'calendar', onClick: () => C.openEventEditor({ defaults: { contact_id: r.id, title: `Meeting with ${nameOf(r)}` } }) });
                if (canEditC(r)) items.push('sep', r.status === 'archived' ? { label: 'Restore', icon: 'refresh', onClick: () => setStatus(r, 'active', refreshList) } : { label: 'Archive', icon: 'trash', onClick: () => setStatus(r, 'archived', refreshList) });
                if (canDeleteC(r)) items.push({ label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteContact(r, refreshList) });
                return items;
            },
            bulk,
            empty: { title: 'No contacts match this filter', sub: 'Change the filter, add a contact or import a CSV file.' },
        });
        host.addEventListener('click', e => { const a = e.target.closest('[data-company]'); if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); B.openRecord(`/companies/?id=${a.dataset.company}`, refreshList); } });
    }
    async function bulkUpdate(ids, o, patch) {
        const b = sb.from('crm_contacts').update(patch);
        await C.q(o.all ? scoped(b) : b.in('id', ids));
        C.toast('Updated', 'ok');
    }
    function mountActivities(host) {
        const names = new Map();
        page.grid = WSGrid.mount(host, {
            id: 'contacts-activity', sort: { key: 'due_date', dir: 'asc' },
            columns: [
                { key: 'title', title: 'To-do', width: 280, render: t => `<a href="/tasks/?id=${esc(t.id)}" data-task="${esc(t.id)}">${esc(t.title)}</a>` },
                { key: 'contact_id', title: 'Contact', width: 220, sortable: false, render: t => `<a href="/contacts/?id=${esc(t.contact_id)}" data-open>${esc(names.get(t.contact_id) || 'Contact')}</a>` },
                { key: 'due_date', title: 'Deadline', width: 150, render: t => C.dueHtml(t) },
                { key: 'assignee_id', title: 'Responsible', width: 180, render: t => C.personHtml(t.assignee_id, { link: false }) },
            ],
            load: async ({ offset, limit, sort }) => {
                let b = sb.from('tasks').select('id, title, status, assignee_id, due_date, completed_at, contact_id').not('contact_id', 'is', null).is('completed_at', null).is('archived_at', null);
                b = sort ? b.order(sort.key, { ascending: sort.dir === 'asc', nullsFirst: false }) : b.order('due_date', { ascending: true, nullsFirst: false });
                const rows = (await C.q(b.range(offset, offset + limit - 1))).data || [];
                const missing = [...new Set(rows.map(t => t.contact_id))].filter(id => !names.has(id));
                if (missing.length) { const r = await sb.from('crm_contacts').select('id, full_name, organization').in('id', missing); (r.data || []).forEach(x => names.set(x.id, x.full_name || x.organization)); }
                return rows;
            },
            empty: { title: 'No open to-dos on contacts', sub: 'To-dos created from a contact card show up here.' },
        });
        host.addEventListener('click', e => { const t = e.target.closest('[data-task]'); if (t) { e.preventDefault(); B.openRecord(`/tasks/?id=${t.dataset.task}`, () => page.grid && page.grid.refresh()); } });
    }
    view.addEventListener('click', e => {
        const a = e.target.closest('a[data-open]');
        if (!a || e.metaKey || e.ctrlKey || e.shiftKey || page.mode !== 'list') return;
        e.preventDefault();
        const id = new URL(a.href, location.href).searchParams.get('id');
        if (id) openContact(id);
    });

    /* ------------------------------------------------- import / export */
    async function exportContacts() {
        try {
            const { data } = await C.q(scoped(sb.from('crm_contacts').select(SELECT)).order('full_name').limit(5000));
            const rows = data || [];
            B.exportCsv(`contacts-${L.todayIST()}.csv`, [
                { title: 'First name', value: r => r.first_name }, { title: 'Last name', value: r => r.last_name },
                { title: 'Position', value: r => r.job_title }, { title: 'Company', value: r => companyOf(r) },
                { title: 'Email', value: r => r.email }, { title: 'Phone', value: r => r.phone },
                { title: 'City', value: r => r.city }, { title: 'Country', value: r => r.country }, { title: 'Source', value: r => r.source },
                { title: 'Responsible', value: r => r.owner_id ? C.personName(r.owner_id) : '' }, { title: 'Status', value: r => STATUS[r.status] ? STATUS[r.status].label : r.status },
                { title: 'Tags', value: r => r.tags }, { title: 'Created', value: r => L.fmtDate(r.created_at) },
            ], rows);
            C.toast(`Exported ${rows.length} contact${rows.length === 1 ? '' : 's'}${rows.length >= 5000 ? ' (first 5,000)' : ''}`, 'ok');
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    function importContacts() {
        B.importCsv({
            title: 'Import contacts',
            fields: [
                { key: 'first_name', label: 'First name', required: true, aliases: ['name', 'firstname', 'full name', 'contact'] },
                { key: 'last_name', label: 'Last name', aliases: ['surname', 'lastname'] },
                { key: 'email', label: 'Email', aliases: ['e-mail', 'mail', 'email address'] },
                { key: 'phone', label: 'Phone', aliases: ['mobile', 'telephone', 'phone number'] },
                { key: 'organization', label: 'Company', aliases: ['company name', 'organisation', 'organization'] },
                { key: 'job_title', label: 'Position', aliases: ['title', 'job title', 'designation'] },
                { key: 'city', label: 'City' }, { key: 'country', label: 'Country' }, { key: 'source', label: 'Source' },
                { key: 'notes', label: 'Comment', aliases: ['notes', 'comments'] },
            ],
            run: async records => {
                let inserted = 0, skipped = 0, failed = 0;
                for (let i = 0; i < records.length; i += 200) {
                    const chunk = records.slice(i, i + 200).map(x => {
                        const r = clean({ ...x });
                        // A single "name" column becomes first + last.
                        if (!x.last_name && r.first_name && r.first_name.includes(' ')) { const [f, ...rest] = r.first_name.split(/\s+/); r.first_name = f; r.last_name = rest.join(' '); }
                        return { ...r, status: 'active', owner_id: me.id, created_by: me.id };
                    });
                    const emails = chunk.map(r => r.email).filter(Boolean);
                    let existing = new Set();
                    if (emails.length) { const ex = await sb.from('crm_contacts').select('email').in('email', emails); existing = new Set((ex.data || []).map(x => String(x.email).toLowerCase())); }
                    const fresh = chunk.filter(r => !(r.email && existing.has(r.email)));
                    skipped += chunk.length - fresh.length;
                    if (!fresh.length) continue;
                    const res = await sb.from('crm_contacts').insert(fresh);
                    if (res.error) failed += fresh.length; else inserted += fresh.length;
                }
                refreshList();
                return { inserted, skipped, failed };
            },
        });
    }

    /* ------------------------------------------------------------ card */
    async function showRecord(id) {
        page.mode = 'record';
        if (page.grid) { page.grid.destroy(); page.grid = null; }
        C.loading(view, 'Loading contact…');
        let c;
        try { c = (await C.q(sb.from('crm_contacts').select(SELECT).eq('id', id).maybeSingle())).data; }
        catch (e) { return C.errorState(view, e, () => showRecord(id)); }
        if (!c) { view.innerHTML = '<div class="b24-area pad"></div>'; C.empty(view.firstElementChild, 'Contact not found', 'It may have been deleted, or you may not have access to it.', '<a class="ws-btn" href="/contacts/">All contacts</a>'); return; }
        const lk = await C.lookups();
        document.title = `${nameOf(c)} · Contacts · WorkSuite`;
        WSShell.setCrumb(nameOf(c));
        const [deals, tasks, events, invoices, projects] = await Promise.all([
            C.related('crm_deals', 'contact_id', id, 'id, title, value, currency, status, stage_id, owner_id, expected_close_date, created_at'),
            C.related('tasks', 'contact_id', id, 'id, title, status, priority, assignee_id, due_date, completed_at, archived_at, created_at', b => b.is('archived_at', null)),
            C.related('calendar_events', 'contact_id', id, 'id, title, starts_at, ends_at, event_type, status, owner_id', b => b.order('starts_at', { ascending: false })),
            invLv.read !== 'none' ? C.related('invoices', 'contact_id', id, 'id, invoice_number, invoice_date, due_date, status, total, amount_paid, balance, currency') : Promise.resolve([]),
            C.related('projects', 'contact_id', id, 'id, name, status, due_date'),
        ]);
        const edit = canEditC(c);
        const refresh = () => showRecord(id);
        const save = key => async v => { await updateContact(c, { [key]: v }); };
        const newTask = () => C.openTaskEditor({ defaults: { contact_id: id, title: '', assignee_id: c.owner_id || me.id }, onSaved: refresh });
        const newMeet = () => C.openEventEditor({ defaults: { contact_id: id, title: `Meeting with ${nameOf(c)}` }, onSaved: refresh });
        const pm = L.pipelineMetrics(deals);

        const menu = [
            { label: 'Log a call', icon: 'phone', onClick: () => logInteraction(c, 'call.logged', 'Log a call', refresh) },
            { label: 'Log an email', icon: 'mail', onClick: () => logInteraction(c, 'email.logged', 'Log an email', refresh) },
        ];
        if (invLv.add !== 'none') menu.push({ label: 'Create invoice', icon: 'invoice', onClick: () => { window.top.location.href = `/invoices/?new=1&contact_id=${c.id}`; } });
        if (edit) menu.push('sep', c.status === 'archived' ? { label: 'Restore contact', icon: 'refresh', onClick: () => setStatus(c, 'active', refresh) } : { label: 'Archive contact', icon: 'trash', onClick: () => setStatus(c, 'archived', refresh) });
        if (canDeleteC(c)) menu.push({ label: 'Delete permanently', icon: 'trash', danger: true, onClick: () => deleteContact(c) });
        if (window.WSShell && WSShell.inSlider) menu.push('sep', { label: 'Open as a page', icon: 'link', onClick: () => { window.top.location.href = `/contacts/?id=${c.id}`; } });

        const sections = [
            { title: 'About contact', fields: [
                { key: 'first_name', title: 'First name', type: 'text', value: c.first_name, required: true, save: save('first_name') },
                { key: 'last_name', title: 'Last name', type: 'text', value: c.last_name, save: save('last_name') },
                { key: 'job_title', title: 'Position', type: 'text', value: c.job_title, save: save('job_title') },
                { key: 'status', title: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }], value: c.status, display: v => C.statusBadge(STATUS, v), save: c.status === 'archived' ? null : save('status') },
                { key: 'source', title: 'Source', type: 'select', options: SOURCES, value: c.source, save: save('source') },
                { key: 'tags', title: 'Tags', type: 'tags', value: c.tags, save: save('tags') },
            ] },
            { title: 'Contact information', fields: [
                { key: 'phone', title: 'Phone', type: 'tel', value: c.phone, save: save('phone') },
                { key: 'phone2', title: 'Other phone', type: 'tel', value: c.phone2, save: save('phone2') },
                { key: 'email', title: 'Email', type: 'email', value: c.email, save: save('email') },
                { key: 'email2', title: 'Other email', type: 'email', value: c.email2, save: save('email2') },
                { key: 'website', title: 'Website', type: 'url', value: c.website, save: save('website') },
            ] },
            { title: 'Company', fields: [
                ...(cols.full ? [{ key: 'company_id', title: 'Company', type: 'entity', entity: 'company', value: c.company_id, display: v => v ? C.entityChip('company', v, (c.company_rec && c.company_rec.title) || 'Company') : '', save: save('company_id') }] : []),
                { key: 'organization', title: 'Company name (text)', type: 'text', value: c.organization, save: save('organization') },
            ] },
            { title: 'Address', fields: [
                { key: 'address', title: 'Street', type: 'text', value: c.address, save: save('address') },
                { key: 'city', title: 'City', type: 'text', value: c.city, save: save('city') },
                { key: 'state', title: 'State', type: 'text', value: c.state, save: save('state') },
                { key: 'postal_code', title: 'Postal code', type: 'text', value: c.postal_code, save: save('postal_code') },
                { key: 'country', title: 'Country', type: 'text', value: c.country, save: save('country') },
            ] },
            { title: 'Responsible', fields: [
                { key: 'owner_id', title: 'Responsible person', type: 'people', none: 'Not assigned', value: c.owner_id, display: v => C.personHtml(v), save: save('owner_id') },
            ] },
            B.cfSection(cf, c, async (code, v) => { await updateContact(c, { custom: { ...(c.custom || {}), [code]: v } }); }, edit),
            { title: 'More', fields: [
                { key: 'notes', title: 'Comment', type: 'textarea', value: c.notes, save: save('notes') },
                { key: 'deals', title: 'Deals', edit: false, value: 1, display: () => `${pm.open_count} in progress · ${esc(L.money(pm.pipeline_value))} · ${pm.won_count} won` },
                ...(c.lead_id ? [{ key: 'lead', title: 'Converted from', edit: false, value: c.lead_id, display: () => C.entityChip('lead', c.lead_id, 'Open lead') }] : []),
                { key: 'created', title: 'Created', edit: false, value: c.created_at, display: () => `${esc(L.fmtDateTime(c.created_at))} · ${C.personHtml(c.created_by)}` },
                { key: 'updated', title: 'Modified', edit: false, value: c.updated_at, display: () => esc(L.fmtDateTime(c.updated_at)) },
            ] },
        ].filter(Boolean);
        sections.forEach(s => s.fields.forEach(f => { if (!edit) f.save = null; }));

        const tabs = [
            { key: 'deals', title: 'Deals', count: deals.length, render: el => {
                el.innerHTML = `<div class="b24-tabbar"><button type="button" class="ws-btn sm primary" data-new>${C.icon('plus')}<span>New deal</span></button></div><div data-list></div>`;
                el.querySelector('[data-new]').addEventListener('click', () => newDealFor(c, refresh));
                C.table(el.querySelector('[data-list]'), { rows: deals, onRow: d => B.openRecord(`/deals/?id=${d.id}`, refresh), sort: { key: 'created_at', dir: 'desc' }, columns: [
                    { key: 'title', label: 'Deal', lead: true, render: d => `<span class="primary-text">${esc(d.title)}</span><span class="sub">${esc(lk.stageById[d.stage_id] ? lk.stageById[d.stage_id].name : '')}</span>` },
                    { key: 'value', label: 'Amount', num: true, render: d => esc(L.money(d.value, d.currency)) },
                    { key: 'status', label: 'Status', render: d => C.statusBadge(L.DEAL_STATUS, d.status) },
                    { key: 'owner_id', label: 'Responsible', value: d => C.personName(d.owner_id), render: d => C.personHtml(d.owner_id, { link: false }) },
                ], empty: { title: 'No deals yet', sub: 'Open an opportunity for this contact.' } });
            } },
            { key: 'tasks', title: 'To-dos', count: tasks.filter(t => !t.completed_at).length, render: el => {
                el.innerHTML = `<div class="b24-tabbar"><button type="button" class="ws-btn sm primary" data-new>${C.icon('plus')}<span>Add to-do</span></button></div><div data-list></div>`;
                el.querySelector('[data-new]').addEventListener('click', newTask);
                C.table(el.querySelector('[data-list]'), { rows: tasks, onRow: t => B.openRecord(`/tasks/?id=${t.id}`, refresh), sort: { key: 'due_date', dir: 'asc' }, columns: [
                    { key: 'title', label: 'To-do', lead: true, render: t => `<span class="primary-text">${esc(t.title)}</span>` },
                    { key: 'status', label: 'Status', render: t => C.statusBadge(lk.taskStatus || {}, t.status) },
                    { key: 'assignee_id', label: 'Responsible', value: t => C.personName(t.assignee_id), render: t => C.personHtml(t.assignee_id, { link: false }) },
                    { key: 'due_date', label: 'Deadline', render: t => C.dueHtml(t) },
                ], empty: { title: 'No to-dos', sub: 'Plan the next step with this contact.' } });
            } },
            { key: 'meetings', title: 'Meetings', count: events.filter(e => e.status !== 'cancelled').length, render: el => {
                el.innerHTML = `<div class="b24-tabbar"><button type="button" class="ws-btn sm primary" data-new>${C.icon('plus')}<span>Schedule</span></button></div><div data-list></div>`;
                el.querySelector('[data-new]').addEventListener('click', newMeet);
                C.table(el.querySelector('[data-list]'), { rows: events, onRow: e => B.openRecord(`/calendar/?id=${e.id}`, refresh), sort: { key: 'starts_at', dir: 'desc' }, columns: [
                    { key: 'title', label: 'Event', lead: true, render: e => `<span class="primary-text">${esc(e.title)}</span>` },
                    { key: 'event_type', label: 'Type', render: e => C.statusBadge(L.EVENT_TYPE, e.event_type) },
                    { key: 'starts_at', label: 'When', render: e => `${esc(L.fmtDateTime(e.starts_at))}${e.status === 'cancelled' ? ' ' + C.badge('mute', 'Cancelled') : ''}` },
                ], empty: { title: 'No meetings', sub: 'Schedule a meeting or call with this contact.' } });
            } },
            { key: 'documents', title: 'Documents', render: el => C.documents(el, { entity_type: 'contact', entity_id: id, canEdit: true }) },
        ];
        if (invLv.read !== 'none') tabs.push({ key: 'invoices', title: 'Invoices', count: invoices.length, render: el => {
            C.table(el, { rows: invoices, onRow: i => B.openRecord(`/invoices/?id=${i.id}`, refresh), sort: { key: 'invoice_date', dir: 'desc' }, columns: [
                { key: 'invoice_number', label: 'Invoice', lead: true, render: i => `<span class="primary-text">${esc(i.invoice_number)}</span>` },
                { key: 'invoice_date', label: 'Date', render: i => esc(L.fmtDate(i.invoice_date)) },
                { key: 'status', label: 'Status', render: i => { const s = L.invoiceStatus(i); return C.badge(L.INVOICE_STATUS[s].color, L.INVOICE_STATUS[s].label); } },
                { key: 'total', label: 'Total', num: true, render: i => esc(L.money(i.total, i.currency)) },
                { key: 'balance', label: 'Balance', num: true, render: i => esc(L.money(i.balance, i.currency)) },
            ], empty: { title: 'No invoices', sub: 'Invoices raised for this contact appear here.' } });
        } });
        tabs.push({ key: 'projects', title: 'Projects', count: projects.length, render: el => C.table(el, { rows: projects, onRow: p => B.openRecord(`/projects/?id=${p.id}`, refresh), columns: [
            { key: 'name', label: 'Project', lead: true, render: p => `<span class="primary-text">${esc(p.name)}</span>` },
            { key: 'status', label: 'Status', render: p => C.statusBadge(L.PROJECT_STATUS, p.status) },
            { key: 'due_date', label: 'Deadline', render: p => esc(L.fmtDate(p.due_date) || '—') },
        ], empty: { title: 'No projects', sub: 'Projects for this contact appear here.' } }) });
        tabs.push({ key: 'history', title: 'History', render: el => C.activityFeed(el, { entity_type: 'contact', entity_id: id, contact_id: id, limit: 200 }) });

        view.innerHTML = '<div id="card"></div>';
        WSCard.mount(view.querySelector('#card'), {
            title: nameOf(c), number: c.number, canEdit: edit,
            subtitle: [c.job_title, companyOf(c)].filter(Boolean).map(esc).join(' · ') + (c.status === 'archived' ? ' ' + C.badge('mute', 'Archived') : ''),
            actions: [{ label: 'New deal', icon: 'deal', onClick: () => newDealFor(c, refresh) }],
            menu, sections, tabs,
            timeline: {
                entity_type: 'contact', entity_id: id, links: { contact_id: id },
                composer: [
                    { title: 'To-do', onOpen: newTask },
                    { title: 'Meeting', onOpen: newMeet },
                    { title: 'Call', onOpen: () => logInteraction(c, 'call.logged', 'Log a call', refresh) },
                    { title: 'Email', onOpen: () => logInteraction(c, 'email.logged', 'Log an email', refresh) },
                ],
            },
        });
    }

    route();
})();
