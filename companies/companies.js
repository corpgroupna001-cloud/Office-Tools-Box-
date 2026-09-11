/* ============================================================================
   Companies — customers as organisations: the list with the "Filter + search"
   bar, CSV import / export, and the company card (a slide-over) with its
   contacts, deals, invoices, documents and history.

   Needs supabase-b24-migration.sql (the crm_companies table); until then the
   page says so instead of failing.

   URLs:  /companies/               list
          /companies/?id=<uuid>     the company card (also inside a slide-over)
          /companies/?new=1         opens "Create company"
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc, B = window.WSB24;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'companies', crumb: 'Companies', layout: 'b24' });
    const sb = ctx.sb, me = ctx.user;

    const TYPES = { customer: 'Customer', partner: 'Partner', supplier: 'Supplier', competitor: 'Competitor', reseller: 'Reseller', other: 'Other' };
    const TYPE_OPTS = Object.entries(TYPES).map(([value, label]) => ({ value, label }));
    const STATUS = { active: { label: 'Active', color: 'present' }, inactive: { label: 'Inactive', color: 'weekoff' }, archived: { label: 'Archived', color: 'mute' } };
    const EMPLOYEES = ['1–10', '11–50', '51–250', '251–500', '501–1000', '1000+'];
    const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED'];
    const SELECT = 'id, company, title, company_type, industry, employees, revenue, currency, phone, email, website, address, city, state, country, postal_code, owner_id, status, tags, notes, custom, number, archived_at, created_by, created_at, updated_at';

    const probe = await sb.from('crm_companies').select('id').limit(1);
    if (probe.error && ['42P01', 'PGRST205', '42703'].includes(String(probe.error.code))) {
        view.innerHTML = B.titleBar({ title: 'Companies' }) + `<div class="b24-area pad"><div class="crm-notice">${C.icon('lock')}<div><b>Companies are not set up yet.</b><br>
            An administrator needs to run <code>supabase-b24-migration.sql</code> in Supabase → SQL Editor (after the other CRM migrations). Existing contacts, leads and deals are not affected.</div></div></div>`;
        return;
    }
    const [cf, lv, invLv] = await Promise.all([B.customFields('company'), B.levels('company'), B.levels('invoice')]);
    const canAdd = lv.add !== 'none';
    const canEditCo = c => B.allowed(lv.edit, c, me);
    const canDeleteCo = c => B.allowed(lv.delete, c, me);

    const page = { mode: null, grid: null, filter: null };
    function route() {
        const id = C.param('id');
        if (id) return showRecord(id);
        if (page.mode === 'list') return refreshList();
        return showList();
    }
    window.addEventListener('popstate', route);
    const openCompany = id => B.openRecord(`/companies/?id=${id}`, refreshList);

    function clean(v) {
        const out = { ...v };
        if ('email' in out) out.email = L.normalizeEmail(out.email);
        ['title', 'industry', 'phone', 'website', 'address', 'city', 'state', 'country', 'postal_code', 'notes', 'employees'].forEach(k => { if (k in out) out[k] = out[k] ? String(out[k]).trim() || null : null; });
        if ('owner_id' in out) out.owner_id = out.owner_id || null;
        if ('revenue' in out) out.revenue = out.revenue == null || out.revenue === '' ? null : Number(out.revenue);
        if ('tags' in out) out.tags = out.tags || [];
        return out;
    }
    async function findSameName(title, excludeId) {
        const r = await sb.from('crm_companies').select('id, title, city').ilike('title', String(title).trim()).neq('status', 'archived').limit(5);
        return r.error ? [] : (r.data || []).filter(x => x.id !== excludeId);
    }
    async function openCompanyEditor(defaults, onSaved) {
        return C.formModal({
            title: 'New company', size: 'wide', submitLabel: 'Create company',
            fields: [
                { name: 'title', label: 'Company name', type: 'text', required: true, full: true },
                { name: 'company_type', label: 'Company type', type: 'select', options: TYPE_OPTS, required: true },
                { name: 'industry', label: 'Industry', type: 'text' },
                { name: 'phone', label: 'Phone', type: 'tel' },
                { name: 'email', label: 'Email', type: 'email' },
                { name: 'website', label: 'Website', type: 'url', placeholder: 'https://…' },
                { name: 'owner_id', label: 'Responsible', type: 'people', none: 'Not assigned' },
                { name: 'city', label: 'City', type: 'text' },
                { name: 'tags', label: 'Tags', type: 'tags', full: true },
                { name: 'notes', label: 'Comment', type: 'textarea', full: true },
            ],
            values: { company_type: 'customer', owner_id: me.id, ...(defaults || {}) },
            onSubmit: async (v, api) => {
                const values = clean(v);
                const same = await findSameName(values.title);
                if (same.length && !await C.confirm({ title: 'A company with this name exists', message: `${same.map(s => s.title + (s.city ? ` (${s.city})` : '')).join(', ')}. Create another one anyway?`, okText: 'Create anyway' })) return null;
                const saved = (await C.q(sb.from('crm_companies').insert({ ...values, created_by: me.id }).select(SELECT).single())).data;
                C.toast('Company created', 'ok');
                if (onSaved) onSaved(saved);
                return saved;
            },
        });
    }
    async function updateCompany(c, patch) {
        const values = clean(patch);
        if ('title' in values && !values.title) throw new Error('The company needs a name.');
        const saved = (await C.q(sb.from('crm_companies').update(values).eq('id', c.id).select(SELECT).single())).data;
        Object.assign(c, saved);
        if (window.WSShell && WSShell.inSlider) WSShell.sliderMessage('changed', { id: c.id });
        return saved;
    }
    async function setStatus(c, status, after) {
        if (status === 'archived' && !await C.confirm({ title: `Archive ${c.title}?`, message: 'The company is hidden from lists; its contacts, deals and invoices keep the link. You can restore it later.', okText: 'Archive', danger: true })) return;
        try { await updateCompany(c, { status, archived_at: status === 'archived' ? new Date().toISOString() : null }); C.toast(status === 'archived' ? 'Company archived' : 'Company restored', 'ok'); if (after) after(); }
        catch (e) { C.toast(e.message, 'bad'); }
    }
    async function deleteCompany(c, after) {
        if (!await C.confirm({ title: 'Delete this company permanently?', message: 'Contacts, deals and invoices linked to it keep their own history but lose the link.', okText: 'Delete permanently', danger: true })) return;
        try {
            await C.q(sb.from('crm_companies').delete().eq('id', c.id));
            C.toast('Company deleted', 'ok');
            if (window.WSShell && WSShell.inSlider) { WSShell.sliderMessage('deleted', { id: c.id }); WSShell.closeSlider(); }
            else if (after) after(); else location.href = '/companies/';
        } catch (e) { C.toast(e.message, 'bad'); }
    }

    /* ------------------------------------------------------------ list */
    const PRESETS = [
        { key: 'active', title: 'Active companies', values: { status: 'active' } },
        { key: 'mine', title: 'My companies', values: { owner: 'me', status: 'active' } },
        { key: 'customers', title: 'Customers', values: { company_type: 'customer', status: 'active' } },
        { key: 'partners', title: 'Partners and suppliers', values: { company_type_multi: ['partner', 'supplier', 'reseller'], status: 'active' } },
        { key: 'all', title: 'All companies', values: {} },
        { key: 'archived', title: 'Archived companies', values: { status: 'archived' } },
    ];
    function filterFields() {
        return [
            { key: 'status', title: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'archived', label: 'Archived' }] },
            { key: 'company_type', title: 'Company type', type: 'select', options: TYPE_OPTS },
            { key: 'company_type_multi', title: 'Company types', type: 'multiselect', column: 'company_type', options: TYPE_OPTS, default: false },
            { key: 'owner', title: 'Responsible', type: 'user', column: 'owner_id', options: B.peopleOptions() },
            { key: 'created', title: 'Created', type: 'date', column: 'created_at', datetime: true },
            { key: 'industry', title: 'Industry', type: 'text', default: false },
            { key: 'city', title: 'City', type: 'text', default: false },
            { key: 'revenue', title: 'Annual revenue', type: 'number', default: false },
            { key: 'tag', title: 'Tag', type: 'text', default: false, apply: (b, v) => b.contains('tags', [String(v).trim()]) },
            ...B.cfFilters(cf),
        ];
    }
    function scoped(builder) {
        if (!page.filter.get().values.status) builder = builder.neq('status', 'archived');
        return page.filter.apply(builder, { searchColumns: ['title', 'email', 'phone', 'city', 'industry'] });
    }
    async function showList() {
        page.mode = 'list';
        WSShell.setCrumb('Companies');
        document.title = 'Companies · WorkSuite';
        const menu = [];
        if (lv.import !== 'none' && canAdd) menu.push({ label: 'Import from CSV', icon: 'upload', onClick: importCompanies });
        if (lv.export !== 'none') menu.push({ label: 'Export to CSV', icon: 'download', onClick: exportCompanies });
        view.innerHTML = B.titleBar({ title: 'Companies', createLabel: canAdd ? 'Create' : '', createMenu: menu.length > 0 }) + '<div id="body"></div>';
        page.filter = WSFilter.mount(view.querySelector('[data-filter]'), { id: 'companies', fields: filterFields(), presets: PRESETS, defaultPreset: 'active', me: me.id, onChange: () => refreshList() });
        const create = view.querySelector('[data-create]');
        if (create) create.addEventListener('click', () => openCompanyEditor(null, c => { refreshList(); openCompany(c.id); }));
        const more = view.querySelector('[data-create-menu]'); if (more) more.addEventListener('click', () => C.menu(more, menu));
        const host = document.createElement('div');
        view.querySelector('#body').appendChild(host);
        const can = lv.edit !== 'none';
        const save = key => async (r, v) => { if (!canEditCo(r)) throw new Error('You do not have permission to change this company.'); await updateCompany(r, { [key]: v }); };
        const people = [{ value: '', label: 'Not assigned' }].concat(B.peopleOptions());
        const bulk = [];
        if (can) {
            bulk.push({ label: 'Assign responsible', icon: 'user', run: async (ids, o) => {
                const v = await B.pick('Assign responsible', { type: 'people', label: 'Responsible', none: 'Not assigned' }, '');
                if (v === undefined) return false;
                await bulkUpdate(ids, o, { owner_id: v || null });
            } });
            bulk.push({ label: 'Archive', icon: 'trash', run: async (ids, o) => {
                if (!await C.confirm({ title: o.all ? 'Archive every company in this filter?' : `Archive ${ids.length} compan${ids.length > 1 ? 'ies' : 'y'}?`, message: 'Linked records keep the link.', okText: 'Archive', danger: true })) return false;
                await bulkUpdate(ids, o, { status: 'archived', archived_at: new Date().toISOString() });
            } });
        }
        if (lv.delete !== 'none') bulk.push({ label: 'Delete', icon: 'trash', danger: true, run: async (ids, o) => {
            if (!await C.confirm({ title: o.all ? 'Delete every company in this filter?' : `Delete ${ids.length} compan${ids.length > 1 ? 'ies' : 'y'} permanently?`, message: 'Linked records lose the link.', okText: 'Delete permanently', danger: true })) return false;
            const b = sb.from('crm_companies').delete();
            await C.q(o.all ? scoped(b) : b.in('id', ids));
            C.toast('Deleted', 'ok');
        } });
        page.grid = WSGrid.mount(host, {
            id: 'companies', sort: { key: 'updated_at', dir: 'desc' },
            columns: [
                { key: 'number', title: 'ID', width: 70, render: r => esc(r.number == null ? '' : r.number) },
                { key: 'title', title: 'Company', width: 250, render: r => `<span class="b24-who"><span class="ws-avatar sm">${C.icon('building', 'sm')}</span><span><a href="/companies/?id=${esc(r.id)}" data-open>${esc(r.title)}</a>${r.industry ? `<span class="sub">${esc(r.industry)}</span>` : ''}</span></span>`, edit: can ? { type: 'text', save: save('title') } : undefined },
                { key: 'company_type', title: 'Type', width: 130, render: r => esc(TYPES[r.company_type] || r.company_type), edit: can ? { type: 'select', options: TYPE_OPTS, save: save('company_type') } : undefined },
                { key: 'phone', title: 'Phone', width: 150, render: r => r.phone ? `<a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>` : '', edit: can ? { type: 'text', save: save('phone') } : undefined },
                { key: 'email', title: 'Email', width: 200, render: r => r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : '', edit: can ? { type: 'text', save: save('email') } : undefined },
                { key: 'owner_id', title: 'Responsible', width: 180, render: r => C.personHtml(r.owner_id, { link: false }), edit: can ? { type: 'people', options: people, save: save('owner_id') } : undefined },
                { key: 'city', title: 'City', width: 130, render: r => esc(r.city || '') },
                { key: 'created_at', title: 'Created', width: 120, render: r => `<span class="muted">${esc(L.fmtDate(r.created_at, { short: true }))}</span>` },
                { key: 'revenue', title: 'Annual revenue', width: 140, align: 'right', default: false, render: r => r.revenue != null ? esc(L.money(r.revenue, r.currency)) : '' },
                { key: 'employees', title: 'Employees', width: 110, default: false, render: r => esc(r.employees || '') },
                { key: 'website', title: 'Website', width: 180, default: false, render: r => r.website ? `<a href="${esc(r.website)}" target="_blank" rel="noopener">${esc(r.website.replace(/^https?:\/\//, ''))}</a>` : '' },
                { key: 'status', title: 'Status', width: 110, default: false, render: r => C.statusBadge(STATUS, r.status) },
                { key: 'tags', title: 'Tags', width: 160, default: false, sortable: false, render: r => C.tagsHtml(r.tags) },
                ...B.cfColumns(cf),
            ],
            load: async ({ offset, limit, sort }) => {
                let b = scoped(sb.from('crm_companies').select(SELECT));
                b = sort ? b.order(sort.key, { ascending: sort.dir === 'asc', nullsFirst: false }) : b.order('updated_at', { ascending: false });
                return (await C.q(b.range(offset, offset + limit - 1))).data || [];
            },
            count: async () => (await C.q(scoped(sb.from('crm_companies').select('id', { count: 'exact', head: true })))).count || 0,
            onOpen: r => openCompany(r.id),
            rowMenu: r => {
                const items = [{ label: 'Open', icon: 'arrow', onClick: () => openCompany(r.id) }];
                if (canEditCo(r)) items.push('sep', r.status === 'archived' ? { label: 'Restore', icon: 'refresh', onClick: () => setStatus(r, 'active', refreshList) } : { label: 'Archive', icon: 'trash', onClick: () => setStatus(r, 'archived', refreshList) });
                if (canDeleteCo(r)) items.push({ label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteCompany(r, refreshList) });
                return items;
            },
            bulk,
            empty: { title: 'No companies match this filter', sub: 'Companies are created here, when a lead is converted, or by importing a CSV file.' },
        });
        if (C.param('new') === '1' && canAdd) { C.setParam('new', null, true); openCompanyEditor(null, c => { refreshList(); openCompany(c.id); }); }
    }
    function refreshList() { if (page.mode === 'list' && page.grid) page.grid.reload(); }
    async function bulkUpdate(ids, o, patch) {
        const b = sb.from('crm_companies').update(patch);
        await C.q(o.all ? scoped(b) : b.in('id', ids));
        C.toast('Updated', 'ok');
    }
    view.addEventListener('click', e => {
        const a = e.target.closest('a[data-open]');
        if (!a || e.metaKey || e.ctrlKey || e.shiftKey || page.mode !== 'list') return;
        e.preventDefault();
        const id = new URL(a.href, location.href).searchParams.get('id');
        if (id) openCompany(id);
    });

    async function exportCompanies() {
        try {
            const { data } = await C.q(scoped(sb.from('crm_companies').select(SELECT)).order('title').limit(5000));
            const rows = data || [];
            B.exportCsv(`companies-${L.todayIST()}.csv`, [
                { title: 'Company', value: r => r.title }, { title: 'Type', value: r => TYPES[r.company_type] || r.company_type },
                { title: 'Industry', value: r => r.industry }, { title: 'Phone', value: r => r.phone }, { title: 'Email', value: r => r.email },
                { title: 'Website', value: r => r.website }, { title: 'City', value: r => r.city }, { title: 'Country', value: r => r.country },
                { title: 'Employees', value: r => r.employees }, { title: 'Annual revenue', value: r => r.revenue },
                { title: 'Responsible', value: r => r.owner_id ? C.personName(r.owner_id) : '' }, { title: 'Tags', value: r => r.tags },
                { title: 'Created', value: r => L.fmtDate(r.created_at) },
            ], rows);
            C.toast(`Exported ${rows.length} compan${rows.length === 1 ? 'y' : 'ies'}`, 'ok');
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    function importCompanies() {
        B.importCsv({
            title: 'Import companies',
            fields: [
                { key: 'title', label: 'Company name', required: true, aliases: ['company', 'name', 'organisation', 'organization'] },
                { key: 'industry', label: 'Industry' }, { key: 'phone', label: 'Phone', aliases: ['telephone'] }, { key: 'email', label: 'Email', aliases: ['e-mail'] },
                { key: 'website', label: 'Website', aliases: ['url', 'site'] }, { key: 'city', label: 'City' }, { key: 'country', label: 'Country' },
                { key: 'address', label: 'Address', aliases: ['street'] }, { key: 'notes', label: 'Comment', aliases: ['notes'] },
            ],
            run: async records => {
                let inserted = 0, skipped = 0, failed = 0;
                const existing = new Set();
                const ex = await sb.from('crm_companies').select('title').neq('status', 'archived').limit(10000);
                (ex.data || []).forEach(x => existing.add(String(x.title).trim().toLowerCase()));
                const fresh = [];
                records.forEach(r => {
                    const k = r.title.trim().toLowerCase();
                    if (existing.has(k)) { skipped++; return; }
                    existing.add(k);
                    const row = clean(r);
                    if (row.website && !/^https?:\/\//i.test(row.website)) row.website = 'https://' + row.website;
                    fresh.push({ ...row, company_type: 'customer', owner_id: me.id, created_by: me.id });
                });
                for (let i = 0; i < fresh.length; i += 200) {
                    const res = await sb.from('crm_companies').insert(fresh.slice(i, i + 200));
                    if (res.error) failed += Math.min(200, fresh.length - i); else inserted += Math.min(200, fresh.length - i);
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
        C.loading(view, 'Loading company…');
        let co;
        try { co = (await C.q(sb.from('crm_companies').select(SELECT).eq('id', id).maybeSingle())).data; }
        catch (e) { return C.errorState(view, e, () => showRecord(id)); }
        if (!co) { view.innerHTML = '<div class="b24-area pad"></div>'; C.empty(view.firstElementChild, 'Company not found', 'It may have been deleted, or you may not have access to it.', '<a class="ws-btn" href="/companies/">All companies</a>'); return; }
        document.title = `${co.title} · Companies · WorkSuite`;
        WSShell.setCrumb(co.title);
        const lk = await C.lookups();
        const [contacts, deals, invoices] = await Promise.all([
            C.related('crm_contacts', 'company_id', id, 'id, full_name, job_title, email, phone, owner_id, status', b => b.neq('status', 'archived')),
            C.related('crm_deals', 'company_id', id, 'id, title, value, currency, status, stage_id, owner_id, created_at'),
            invLv.read !== 'none' ? C.related('invoices', 'company_id', id, 'id, invoice_number, invoice_date, status, total, balance, currency') : Promise.resolve([]),
        ]);
        const edit = canEditCo(co);
        const refresh = () => showRecord(id);
        const save = key => async v => { await updateCompany(co, { [key]: v }); };
        const pm = L.pipelineMetrics(deals);
        const newContact = () => C.formModal({
            title: `New contact at ${co.title}`, submitLabel: 'Create contact', fields: [
                { name: 'first_name', label: 'First name', type: 'text', required: true }, { name: 'last_name', label: 'Last name', type: 'text' },
                { name: 'job_title', label: 'Position', type: 'text' }, { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'email', label: 'Email', type: 'email' },
            ],
            onSubmit: async v => {
                await C.q(sb.from('crm_contacts').insert({ ...v, email: L.normalizeEmail(v.email), company_id: co.id, organization: co.title, owner_id: co.owner_id || me.id, status: 'active', created_by: me.id }));
                C.toast('Contact created', 'ok'); refresh();
            },
        });
        const linkContact = () => C.formModal({
            title: `Link a contact to ${co.title}`, submitLabel: 'Link', fields: [{ name: 'contact_id', label: 'Contact', type: 'entity', entity: 'contact', required: true, full: true, placeholder: 'Search contacts' }],
            onSubmit: async v => { await C.q(sb.from('crm_contacts').update({ company_id: co.id }).eq('id', v.contact_id)); C.toast('Contact linked', 'ok'); refresh(); },
        });
        const newDeal = async () => {
            if (!lk.pipelines.length) return C.alert({ title: 'No pipeline yet', message: 'Ask a manager to set up a sales pipeline in Deals first.' });
            const p = lk.defaultPipeline || lk.pipelines[0], stage = L.firstOpenStage(lk.stages, p.id);
            await C.formModal({
                title: `New deal with ${co.title}`, submitLabel: 'Create deal', fields: [
                    { name: 'title', label: 'Deal name', type: 'text', required: true, full: true }, { name: 'value', label: 'Amount', type: 'money', required: true },
                    { name: 'contact_id', label: 'Contact', type: 'select', options: [{ value: '', label: '—' }].concat(contacts.map(x => ({ value: x.id, label: x.full_name }))) },
                    { name: 'owner_id', label: 'Responsible', type: 'people', none: null },
                ],
                values: { title: `${co.title} deal`, value: 0, owner_id: co.owner_id || me.id },
                onSubmit: async v => {
                    const { data } = await C.q(sb.from('crm_deals').insert({ title: v.title, value: Number(v.value) || 0, contact_id: v.contact_id || null, owner_id: v.owner_id, company_id: co.id, organization: co.title, pipeline_id: p.id, stage_id: stage && stage.id, currency: co.currency || 'INR', created_by: me.id }).select('id').single());
                    C.toast('Deal created', 'ok'); B.openRecord(`/deals/?id=${data.id}`, refresh);
                },
            });
        };
        const menu = [];
        if (invLv.add !== 'none') menu.push({ label: 'Create invoice', icon: 'invoice', onClick: () => { window.top.location.href = `/invoices/?new=1&company_id=${co.id}`; } });
        if (edit) menu.push('sep', co.status === 'archived' ? { label: 'Restore company', icon: 'refresh', onClick: () => setStatus(co, 'active', refresh) } : { label: 'Archive company', icon: 'trash', onClick: () => setStatus(co, 'archived', refresh) });
        if (canDeleteCo(co)) menu.push({ label: 'Delete permanently', icon: 'trash', danger: true, onClick: () => deleteCompany(co) });
        if (window.WSShell && WSShell.inSlider) menu.push('sep', { label: 'Open as a page', icon: 'link', onClick: () => { window.top.location.href = `/companies/?id=${co.id}`; } });

        const sections = [
            { title: 'About company', fields: [
                { key: 'title', title: 'Company name', type: 'text', value: co.title, required: true, save: save('title') },
                { key: 'company_type', title: 'Company type', type: 'select', options: TYPE_OPTS, value: co.company_type, save: save('company_type') },
                { key: 'industry', title: 'Industry', type: 'text', value: co.industry, save: save('industry') },
                { key: 'employees', title: 'Employees', type: 'select', options: EMPLOYEES, value: co.employees, save: save('employees') },
                { key: 'revenue', title: 'Annual revenue', type: 'money', value: co.revenue, display: v => v == null ? '' : esc(L.money(v, co.currency)), save: save('revenue') },
                { key: 'currency', title: 'Currency', type: 'select', options: CURRENCIES, value: co.currency, save: save('currency') },
                { key: 'status', title: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }], value: co.status, display: v => C.statusBadge(STATUS, v), save: co.status === 'archived' ? null : save('status') },
                { key: 'tags', title: 'Tags', type: 'tags', value: co.tags, save: save('tags') },
            ] },
            { title: 'Contact information', fields: [
                { key: 'phone', title: 'Phone', type: 'tel', value: co.phone, save: save('phone') },
                { key: 'email', title: 'Email', type: 'email', value: co.email, save: save('email') },
                { key: 'website', title: 'Website', type: 'url', value: co.website, save: save('website') },
            ] },
            { title: 'Address', fields: [
                { key: 'address', title: 'Street', type: 'text', value: co.address, save: save('address') },
                { key: 'city', title: 'City', type: 'text', value: co.city, save: save('city') },
                { key: 'state', title: 'State', type: 'text', value: co.state, save: save('state') },
                { key: 'postal_code', title: 'Postal code', type: 'text', value: co.postal_code, save: save('postal_code') },
                { key: 'country', title: 'Country', type: 'text', value: co.country, save: save('country') },
            ] },
            { title: 'Responsible', fields: [
                { key: 'owner_id', title: 'Responsible person', type: 'people', none: 'Not assigned', value: co.owner_id, display: v => C.personHtml(v), save: save('owner_id') },
            ] },
            B.cfSection(cf, co, async (code, v) => { await updateCompany(co, { custom: { ...(co.custom || {}), [code]: v } }); }, edit),
            { title: 'More', fields: [
                { key: 'notes', title: 'Comment', type: 'textarea', value: co.notes, save: save('notes') },
                { key: 'deals', title: 'Deals', edit: false, value: 1, display: () => `${pm.open_count} in progress · ${esc(L.money(pm.pipeline_value))} · ${pm.won_count} won · ${esc(L.money(pm.won_value))}` },
                { key: 'created', title: 'Created', edit: false, value: co.created_at, display: () => `${esc(L.fmtDateTime(co.created_at))} · ${C.personHtml(co.created_by)}` },
                { key: 'updated', title: 'Modified', edit: false, value: co.updated_at, display: () => esc(L.fmtDateTime(co.updated_at)) },
            ] },
        ].filter(Boolean);
        sections.forEach(s => s.fields.forEach(f => { if (!edit) f.save = null; }));

        const tabs = [
            { key: 'contacts', title: 'Contacts', count: contacts.length, render: el => {
                el.innerHTML = `<div class="b24-tabbar"><button type="button" class="ws-btn sm primary" data-new>${C.icon('plus')}<span>New contact</span></button><button type="button" class="ws-btn sm" data-link>${C.icon('link')}<span>Link a contact</span></button></div><div data-list></div>`;
                el.querySelector('[data-new]').addEventListener('click', newContact);
                el.querySelector('[data-link]').addEventListener('click', linkContact);
                C.table(el.querySelector('[data-list]'), { rows: contacts, onRow: x => B.openRecord(`/contacts/?id=${x.id}`, refresh), columns: [
                    { key: 'full_name', label: 'Contact', lead: true, render: x => `<span class="primary-text">${esc(x.full_name)}</span><span class="sub">${esc(x.job_title || '')}</span>` },
                    { key: 'phone', label: 'Phone', render: x => esc(x.phone || '—') },
                    { key: 'email', label: 'Email', render: x => esc(x.email || '—') },
                    { key: 'owner_id', label: 'Responsible', value: x => C.personName(x.owner_id), render: x => C.personHtml(x.owner_id, { link: false }) },
                ], empty: { title: 'No contacts yet', sub: 'Add the people you work with at this company.' } });
            } },
            { key: 'deals', title: 'Deals', count: deals.length, render: el => {
                el.innerHTML = `<div class="b24-tabbar"><button type="button" class="ws-btn sm primary" data-new>${C.icon('plus')}<span>New deal</span></button></div><div data-list></div>`;
                el.querySelector('[data-new]').addEventListener('click', newDeal);
                C.table(el.querySelector('[data-list]'), { rows: deals, onRow: d => B.openRecord(`/deals/?id=${d.id}`, refresh), sort: { key: 'created_at', dir: 'desc' }, columns: [
                    { key: 'title', label: 'Deal', lead: true, render: d => `<span class="primary-text">${esc(d.title)}</span><span class="sub">${esc(lk.stageById[d.stage_id] ? lk.stageById[d.stage_id].name : '')}</span>` },
                    { key: 'value', label: 'Amount', num: true, render: d => esc(L.money(d.value, d.currency)) },
                    { key: 'status', label: 'Status', render: d => C.statusBadge(L.DEAL_STATUS, d.status) },
                    { key: 'owner_id', label: 'Responsible', value: d => C.personName(d.owner_id), render: d => C.personHtml(d.owner_id, { link: false }) },
                ], empty: { title: 'No deals yet', sub: 'Open an opportunity with this company.' } });
            } },
        ];
        if (invLv.read !== 'none') tabs.push({ key: 'invoices', title: 'Invoices', count: invoices.length, render: el => C.table(el, { rows: invoices, onRow: i => B.openRecord(`/invoices/?id=${i.id}`, refresh), sort: { key: 'invoice_date', dir: 'desc' }, columns: [
            { key: 'invoice_number', label: 'Invoice', lead: true, render: i => `<span class="primary-text">${esc(i.invoice_number)}</span>` },
            { key: 'invoice_date', label: 'Date', render: i => esc(L.fmtDate(i.invoice_date)) },
            { key: 'status', label: 'Status', render: i => { const s = L.invoiceStatus(i); return C.badge(L.INVOICE_STATUS[s].color, L.INVOICE_STATUS[s].label); } },
            { key: 'total', label: 'Total', num: true, render: i => esc(L.money(i.total, i.currency)) },
            { key: 'balance', label: 'Balance', num: true, render: i => esc(L.money(i.balance, i.currency)) },
        ], empty: { title: 'No invoices', sub: 'Invoices for this company appear here.' } }) });
        tabs.push({ key: 'documents', title: 'Documents', render: el => C.documents(el, { entity_type: 'company', entity_id: id, canEdit: true }) });
        tabs.push({ key: 'history', title: 'History', render: el => C.activityFeed(el, { entity_type: 'company', entity_id: id, limit: 200 }) });

        view.innerHTML = '<div id="card"></div>';
        WSCard.mount(view.querySelector('#card'), {
            title: co.title, number: co.number, canEdit: edit, onRename: edit ? save('title') : null,
            subtitle: [esc(TYPES[co.company_type] || ''), esc(co.industry || ''), co.status === 'archived' ? C.badge('mute', 'Archived') : ''].filter(Boolean).join(' · '),
            actions: [{ label: 'New deal', icon: 'deal', onClick: newDeal }],
            menu, sections, tabs,
            timeline: { entity_type: 'company', entity_id: id, links: {}, composer: [{ title: 'Contact', onOpen: newContact }, { title: 'Deal', onOpen: newDeal }] },
        });
    }

    route();
})();
