/* ============================================================================
   Contacts — list, create/edit with duplicate warning, and a CRM record page
   with Overview / Activity / Deals / Tasks / Meetings / Documents / Invoices /
   Notes tabs. Everything is read and written through Supabase behind RLS via
   the shared WSCrm runtime.

   URLs:  /contacts/            list         /contacts/?id=<uuid>   record
          /contacts/?new=1      list + new-contact dialog
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc, h = C.h;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'contacts', crumb: 'Contacts' });
    const sb = ctx.sb, me = ctx.user;

    const STATUS = {
        active: { label: 'Active', color: 'present' },
        inactive: { label: 'Inactive', color: 'weekoff' },
        archived: { label: 'Archived', color: 'mute' },
    };
    const SOURCES = ['Website', 'Referral', 'Cold call', 'Email campaign', 'Social media', 'Event', 'Partner', 'Walk-in', 'Other'];
    const SELECT = 'id, company, first_name, last_name, full_name, organization, job_title, email, email2, phone, phone2, address, city, state, country, postal_code, website, source, owner_id, status, notes, tags, lead_id, archived_at, created_by, created_at, updated_at';

    /* ------------------------------------------------------------ routing */
    function route() {
        const id = C.param('id');
        if (id) return showRecord(id);
        return showList();
    }
    window.addEventListener('popstate', route);
    function go(url) { history.pushState(null, '', url); route(); }

    /* ------------------------------------------------------ contact form */
    function contactFields() {
        return [
            { name: 'first_name', label: 'First name', type: 'text', required: true },
            { name: 'last_name', label: 'Last name', type: 'text' },
            { name: 'organization', label: 'Company / organisation', type: 'text' },
            { name: 'job_title', label: 'Job title', type: 'text' },
            { name: 'email', label: 'Email', type: 'email' },
            { name: 'phone', label: 'Phone', type: 'tel' },
            { name: 'email2', label: 'Secondary email', type: 'email' },
            { name: 'phone2', label: 'Secondary phone', type: 'tel' },
            { name: 'owner_id', label: 'Owner', type: 'people', none: 'Unassigned' },
            { name: 'status', label: 'Status', type: 'select', options: Object.entries(STATUS).filter(([k]) => k !== 'archived').map(([k, v]) => ({ value: k, label: v.label })), required: true },
            { name: 'source', label: 'Source', type: 'select', options: SOURCES, placeholder: 'How did we meet them?' },
            { name: 'website', label: 'Website', type: 'url', placeholder: 'https://…' },
            { name: 'address', label: 'Address', type: 'text', full: true },
            { name: 'city', label: 'City', type: 'text' },
            { name: 'state', label: 'State', type: 'text' },
            { name: 'country', label: 'Country', type: 'text' },
            { name: 'postal_code', label: 'Postal code', type: 'text' },
            { name: 'tags', label: 'Tags', type: 'tags', full: true },
            { name: 'notes', label: 'Notes', type: 'textarea', full: true },
        ];
    }
    /** Warn before saving a contact that matches an existing email or phone. Returns true to proceed. */
    async function duplicateCheck(values, excludeId) {
        const emails = [values.email, values.email2].map(L.normalizeEmail).filter(Boolean);
        const phones = [values.phone, values.phone2].filter(Boolean);
        if (!emails.length && !phones.length) return true;
        const ors = [];
        emails.forEach(e => { ors.push(`email.ilike.${e}`); ors.push(`email2.ilike.${e}`); });
        phones.forEach(p => { const digits = String(p).replace(/\D/g, '').slice(-10); if (digits.length >= 6) { ors.push(`phone.ilike.%${digits}%`); ors.push(`phone2.ilike.%${digits}%`); } });
        if (!ors.length) return true;
        const r = await sb.from('crm_contacts').select('id, full_name, organization, email, phone, email2, phone2, status').or(ors.join(',')).neq('status', 'archived').limit(10);
        if (r.error) return true;                                  // never block a save on a failed lookup
        const dupes = L.findDuplicateContacts(values, r.data || [], excludeId);
        if (!dupes.length) return true;
        return new Promise(resolve => {
            C.modal({
                title: 'Possible duplicate',
                body: `<div class="crm-warn" style="margin-bottom:12px">A contact with the same email or phone already exists.</div>
                       <ul class="crm-list compact">${dupes.map(d => `<li>${C.avatarHtml({ name: d.full_name })}<div class="main"><b><a href="/contacts/?id=${esc(d.id)}">${esc(d.full_name || d.organization)}</a></b><span>${esc([d.organization, d.email || d.email2, d.phone || d.phone2].filter(Boolean).join(' · '))}</span></div></li>`).join('')}</ul>`,
                actions: [
                    { label: 'Open existing', onClick: api => { api.close(); resolve(false); go(`/contacts/?id=${dupes[0].id}`); } },
                    { label: 'Cancel', close: true },
                    { label: 'Save anyway', primary: true, onClick: api => { api.close(); resolve(true); } },
                ],
                onClose: () => resolve(false),
            });
        });
    }
    function cleanValues(v) {
        const out = { ...v };
        ['email', 'email2'].forEach(k => { out[k] = L.normalizeEmail(out[k]); });
        ['first_name', 'last_name', 'organization', 'job_title', 'phone', 'phone2', 'address', 'city', 'state', 'country', 'postal_code', 'website', 'source', 'notes'].forEach(k => { out[k] = out[k] ? String(out[k]).trim() || null : null; });
        out.owner_id = out.owner_id || null;
        out.tags = out.tags || [];
        return out;
    }
    async function openContactEditor(contact, onSaved) {
        const isNew = !contact;
        return C.formModal({
            title: isNew ? 'New contact' : 'Edit contact', size: 'wide', fields: contactFields(),
            values: isNew ? { status: 'active', owner_id: me.id } : contact, submitLabel: isNew ? 'Create contact' : 'Save changes',
            onSubmit: async (v, api) => {
                const values = cleanValues(v);
                api.close();                                           // the duplicate dialog needs the stage
                const proceed = await duplicateCheck(values, contact && contact.id);
                if (!proceed) return null;
                try {
                    const row = isNew ? { ...values, created_by: me.id } : values;
                    const saved = isNew
                        ? (await C.q(sb.from('crm_contacts').insert(row).select(SELECT).single())).data
                        : (await C.q(sb.from('crm_contacts').update(row).eq('id', contact.id).select(SELECT).single())).data;
                    if (saved.owner_id && saved.owner_id !== me.id && (isNew || saved.owner_id !== contact.owner_id)) C.pushNotify({ to: saved.owner_id, title: 'Contact assigned to you', body: saved.full_name, url: `/contacts/?id=${saved.id}`, tag: 'crm' });
                    C.toast(isNew ? 'Contact created' : 'Contact saved', 'ok');
                    if (onSaved) onSaved(saved);
                    return saved;
                } catch (e) { C.toast(e.message, 'bad'); return null; }
            },
        });
    }

    /* --------------------------------------------------------------- list */
    let listState = { rows: [], q: '', status: 'active', owner: '', tag: '', serverSearch: false };
    async function fetchContacts() {
        let b = sb.from('crm_contacts').select(SELECT).order('updated_at', { ascending: false }).limit(500);
        if (listState.status === 'archived') b = b.eq('status', 'archived'); else if (listState.status) b = b.eq('status', listState.status); else b = b.neq('status', 'archived');
        if (listState.owner === 'me') b = b.eq('owner_id', me.id); else if (listState.owner === 'none') b = b.is('owner_id', null); else if (listState.owner) b = b.eq('owner_id', listState.owner);
        if (listState.q && listState.serverSearch) { const t = listState.q.replace(/[%,()]/g, ' '); b = b.or(`full_name.ilike.%${t}%,organization.ilike.%${t}%,email.ilike.%${t}%,phone.ilike.%${t}%`); }
        const { data } = await C.q(b);
        return data || [];
    }
    function filterRows(rows) {
        const q = listState.q.trim().toLowerCase();
        return rows.filter(r => {
            if (listState.tag && !(r.tags || []).includes(listState.tag)) return false;
            if (!q || listState.serverSearch) return true;
            return [r.full_name, r.organization, r.email, r.email2, r.phone, r.phone2, r.city, (r.tags || []).join(' ')].some(v => v && String(v).toLowerCase().includes(q));
        });
    }
    async function showList() {
        WSShell.setCrumb('Contacts');
        document.title = 'Contacts · WorkSuite';
        view.innerHTML = `
            <div class="ws-page-head">
                <div><p class="ws-eyebrow">CRM</p><h1>Contacts</h1><p>People and organisations your company works with.</p></div>
                <div class="actions"><button type="button" class="ws-btn primary" id="new-btn">${C.icon('plus')}<span>New contact</span></button></div>
            </div>
            <div class="crm-toolbar">
                <div class="crm-search grow">${C.icon('search', 'sm')}<input type="search" id="q" placeholder="Search name, company, email, phone…" aria-label="Search contacts"></div>
                <select id="f-status" aria-label="Status"><option value="active">Active</option><option value="inactive">Inactive</option><option value="">All (not archived)</option><option value="archived">Archived</option></select>
                <select id="f-owner" aria-label="Owner"><option value="">Any owner</option><option value="me">Owned by me</option><option value="none">Unassigned</option>${C.peopleOptions('', { none: null })}</select>
                <select id="f-tag" aria-label="Tag"><option value="">Any tag</option></select>
                <span class="crm-count" id="count"></span>
            </div>
            <div id="bulk" class="crm-bulkbar" hidden></div>
            <div class="ws-card flush"><div id="table"></div></div>`;
        const tableEl = view.querySelector('#table');
        C.skeletonRows(tableEl, 6);
        view.querySelector('#new-btn').addEventListener('click', () => openContactEditor(null, c => go(`/contacts/?id=${c.id}`)));
        view.querySelector('#f-status').value = listState.status;
        view.querySelector('#f-owner').value = listState.owner;
        view.querySelector('#q').value = listState.q;

        let tbl = null;
        const bulk = view.querySelector('#bulk');
        function renderBulk(sel) {
            bulk.hidden = !sel.length;
            if (!sel.length) return;
            bulk.innerHTML = `<span>${sel.length} selected</span>
                <select id="bulk-owner" aria-label="Assign owner"><option value="">Assign owner…</option>${C.peopleOptions('', { none: null })}</select>
                <button type="button" class="ws-btn sm" id="bulk-tag">${C.icon('tag')}<span>Add tag</span></button>
                <button type="button" class="ws-btn sm" id="bulk-archive">${C.icon('trash')}<span>Archive</span></button>
                <span class="spacer"></span><button type="button" class="ws-btn sm ghost" id="bulk-clear">Clear</button>`;
            bulk.querySelector('#bulk-owner').addEventListener('change', async e => {
                if (!e.target.value) return;
                try { await C.q(sb.from('crm_contacts').update({ owner_id: e.target.value }).in('id', sel)); C.toast(`Assigned ${sel.length} contact${sel.length > 1 ? 's' : ''}`, 'ok'); await reload(); } catch (err) { C.toast(err.message, 'bad'); }
            });
            bulk.querySelector('#bulk-tag').addEventListener('click', async () => {
                const r = await C.formModal({ title: 'Add a tag', fields: [{ name: 'tag', label: 'Tag', type: 'text', required: true, full: true }], submitLabel: 'Add', onSubmit: v => v.tag.trim() });
                if (!r) return;
                try {
                    const rows = listState.rows.filter(x => sel.includes(x.id));
                    await Promise.all(rows.map(x => C.q(sb.from('crm_contacts').update({ tags: Array.from(new Set([...(x.tags || []), r])) }).eq('id', x.id))));
                    C.toast('Tag added', 'ok'); await reload();
                } catch (err) { C.toast(err.message, 'bad'); }
            });
            bulk.querySelector('#bulk-archive').addEventListener('click', async () => {
                if (!await C.confirm({ title: `Archive ${sel.length} contact${sel.length > 1 ? 's' : ''}?`, message: 'Archived contacts are hidden from lists but keep their deals, tasks and history. You can restore them later.', okText: 'Archive', danger: true })) return;
                try { await C.q(sb.from('crm_contacts').update({ status: 'archived', archived_at: new Date().toISOString() }).in('id', sel)); C.toast('Archived', 'ok'); await reload(); } catch (err) { C.toast(err.message, 'bad'); }
            });
            bulk.querySelector('#bulk-clear').addEventListener('click', () => tbl && tbl.clearSelection());
        }
        function columns() {
            return [
                { key: 'full_name', label: 'Name', lead: true, render: r => `<div class="who">${C.avatarHtml({ name: r.full_name || r.organization })}<div><span class="primary-text">${esc(r.full_name || r.organization || '(no name)')}</span><span class="sub">${esc([r.job_title, r.organization].filter(Boolean).join(' · ') || '—')}</span></div></div>` },
                { key: 'email', label: 'Email', render: r => r.email ? `<a class="crm-link" href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : '<span class="muted">—</span>' },
                { key: 'phone', label: 'Phone', render: r => r.phone ? `<a class="crm-link" href="tel:${esc(r.phone)}">${esc(r.phone)}</a>` : '<span class="muted">—</span>' },
                { key: 'owner_id', label: 'Owner', value: r => C.personName(r.owner_id), render: r => C.personHtml(r.owner_id, { link: false }) },
                { key: 'status', label: 'Status', render: r => C.statusBadge(STATUS, r.status) },
                { key: 'tags', label: 'Tags', sort: false, hideMobile: true, render: r => C.tagsHtml(r.tags) || '<span class="muted">—</span>' },
                { key: 'updated_at', label: 'Updated', num: true, render: r => `<span class="muted">${esc(L.fmtRelative(r.updated_at))}</span>` },
                { key: 'actions', label: '', sort: false, cls: 'actions', render: r => `<button type="button" class="ws-btn sm icon" data-menu="${esc(r.id)}" aria-label="Actions">${C.icon('more')}</button>` },
            ];
        }
        function paint() {
            const rows = filterRows(listState.rows);
            view.querySelector('#count').textContent = `${rows.length} contact${rows.length === 1 ? '' : 's'}${listState.rows.length >= 500 ? ' (first 500 loaded, search to narrow)' : ''}`;
            const tags = Array.from(new Set(listState.rows.flatMap(r => r.tags || []))).sort();
            const tagSel = view.querySelector('#f-tag');
            tagSel.innerHTML = '<option value="">Any tag</option>' + tags.map(t => `<option value="${esc(t)}"${t === listState.tag ? ' selected' : ''}>${esc(t)}</option>`).join('');
            if (!tbl) {
                tbl = C.table(tableEl, {
                    columns: columns(), rows, sort: { key: 'updated_at', dir: 'desc' }, selectable: true, pageSize: 50,
                    onRow: r => go(`/contacts/?id=${r.id}`), onSelectionChange: renderBulk,
                    empty: { title: listState.q || listState.tag || listState.owner ? 'No contacts match' : 'No contacts yet', sub: listState.q ? 'Try a different search or clear the filters.' : 'Add your first contact, or convert a lead.', action: listState.q ? '' : `<button type="button" class="ws-btn primary" onclick="document.getElementById('new-btn').click()">${C.icon('plus')}<span>New contact</span></button>` },
                });
            } else tbl.update(rows);
        }
        async function reload() {
            try { listState.rows = await fetchContacts(); paint(); }
            catch (e) { C.errorState(tableEl, e, reload); }
        }
        tableEl.addEventListener('click', e => {
            const b = e.target.closest('[data-menu]'); if (!b) return;
            e.stopPropagation();
            const r = listState.rows.find(x => x.id === b.dataset.menu); if (!r) return;
            C.menu(b, [
                { label: 'Open', icon: 'arrow', onClick: () => go(`/contacts/?id=${r.id}`) },
                { label: 'Edit', icon: 'edit', onClick: () => openContactEditor(r, reload) },
                { label: 'New task', icon: 'tasks', onClick: () => C.openTaskEditor({ defaults: { contact_id: r.id, title: '' } }) },
                { label: 'Schedule meeting', icon: 'calendar', onClick: () => C.openEventEditor({ defaults: { contact_id: r.id, title: `Meeting with ${r.full_name}` } }) },
                'sep',
                r.status === 'archived' ? { label: 'Restore', icon: 'refresh', onClick: () => setStatus(r, 'active', reload) } : { label: 'Archive', icon: 'trash', danger: true, onClick: () => setStatus(r, 'archived', reload) },
            ]);
        });
        const onSearch = C.debounce(async () => {
            listState.q = view.querySelector('#q').value;
            const needServer = listState.rows.length >= 500;
            if (needServer !== listState.serverSearch || needServer) { listState.serverSearch = needServer; await reload(); } else paint();
        }, 220);
        view.querySelector('#q').addEventListener('input', onSearch);
        view.querySelector('#f-status').addEventListener('change', e => { listState.status = e.target.value; reload(); });
        view.querySelector('#f-owner').addEventListener('change', e => { listState.owner = e.target.value; reload(); });
        view.querySelector('#f-tag').addEventListener('change', e => { listState.tag = e.target.value; paint(); });
        await reload();
        if (C.param('new') === '1') { C.setParam('new', null, true); openContactEditor(null, c => go(`/contacts/?id=${c.id}`)); }
    }
    async function setStatus(r, status, after) {
        if (status === 'archived' && !await C.confirm({ title: `Archive ${r.full_name || 'this contact'}?`, message: 'The contact is hidden from lists but keeps every deal, task, document and note. You can restore it later.', okText: 'Archive', danger: true })) return;
        try {
            await C.q(sb.from('crm_contacts').update({ status, archived_at: status === 'archived' ? new Date().toISOString() : null }).eq('id', r.id));
            C.toast(status === 'archived' ? 'Contact archived' : 'Contact restored', 'ok');
            if (after) after();
        } catch (e) { C.toast(e.message, 'bad'); }
    }

    /* ------------------------------------------------------------- record */
    async function showRecord(id) {
        C.loading(view, 'Loading contact…');
        let c;
        try {
            const r = await C.q(sb.from('crm_contacts').select(SELECT).eq('id', id).maybeSingle());
            c = r.data;
        } catch (e) { return C.errorState(view, e, () => showRecord(id)); }
        if (!c) { view.innerHTML = `<a class="crm-back" href="/contacts/">${C.icon('arrow')}All contacts</a>`; C.empty(view.appendChild(document.createElement('div')), 'Contact not found', 'It may have been deleted, or you may not have access to it.'); return; }
        const canEdit = L.canEdit({ owner_id: c.owner_id, created_by: c.created_by }, me);
        const lk = await C.lookups();
        document.title = `${c.full_name || c.organization} · Contacts · WorkSuite`;
        WSShell.setCrumb(c.full_name || c.organization);

        const [deals, tasks, events, invoices, projects, leads] = await Promise.all([
            C.related('crm_deals', 'contact_id', id, 'id, title, value, currency, status, stage_id, owner_id, expected_close_date, created_at'),
            C.related('tasks', 'contact_id', id, 'id, title, status, priority, assignee_id, due_date, completed_at, archived_at, created_at', b => b.is('archived_at', null)),
            C.related('calendar_events', 'contact_id', id, 'id, title, starts_at, ends_at, event_type, status, owner_id', b => b.order('starts_at', { ascending: false })),
            ctx.isManager ? C.related('invoices', 'contact_id', id, 'id, invoice_number, invoice_date, due_date, status, total, amount_paid, balance, currency') : Promise.resolve([]),
            C.related('projects', 'contact_id', id, 'id, name, status, due_date'),
            c.lead_id ? C.related('crm_leads', 'id', c.lead_id, 'id, name, status, converted_at') : Promise.resolve([]),
        ]);
        const openDeals = deals.filter(d => d.status === 'open');
        const pm = L.pipelineMetrics(deals);

        view.innerHTML = `
            <a class="crm-back" href="/contacts/" data-nav>${C.icon('arrow')}All contacts</a>
            <div class="crm-record-head">
                ${C.avatarHtml({ name: c.full_name || c.organization }, 'xl')}
                <div class="titles">
                    <h1>${esc(c.full_name || c.organization)}</h1>
                    <div class="meta">
                        ${c.job_title || c.organization ? `<span>${esc([c.job_title, c.organization].filter(Boolean).join(' at '))}</span>` : ''}
                        ${C.statusBadge(STATUS, c.status)}
                        ${c.email ? `<a href="mailto:${esc(c.email)}">${C.icon('mail', 'sm')} ${esc(c.email)}</a>` : ''}
                        ${c.phone ? `<a href="tel:${esc(c.phone)}">${C.icon('phone', 'sm')} ${esc(c.phone)}</a>` : ''}
                        <span>Owner: ${C.personHtml(c.owner_id)}</span>
                        ${C.tagsHtml(c.tags)}
                    </div>
                </div>
                <div class="actions">
                    ${canEdit ? `<button type="button" class="ws-btn" id="edit-btn">${C.icon('edit')}<span>Edit</span></button>` : ''}
                    <button type="button" class="ws-btn" id="task-btn">${C.icon('tasks')}<span>Task</span></button>
                    <button type="button" class="ws-btn" id="meet-btn">${C.icon('calendar')}<span>Meeting</span></button>
                    <button type="button" class="ws-btn primary" id="deal-btn">${C.icon('deal')}<span>New deal</span></button>
                    <button type="button" class="ws-btn icon" id="more-btn" aria-label="More actions">${C.icon('more')}</button>
                </div>
            </div>
            <div id="tabs"></div>
            <section class="crm-tabpanel" data-panel="overview">
                <div class="crm-detail">
                    <div class="ws-stack">
                        <div class="ws-card">
                            <div class="crm-section-title"><h3>Details</h3></div>
                            <dl class="crm-props">
                                <div><dt>Full name</dt><dd>${esc(c.full_name || '—')}</dd></div>
                                <div><dt>Organisation</dt><dd>${esc(c.organization || '—')}</dd></div>
                                <div><dt>Job title</dt><dd>${esc(c.job_title || '—')}</dd></div>
                                <div><dt>Source</dt><dd>${esc(c.source || '—')}</dd></div>
                                <div><dt>Email</dt><dd>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '—'}${c.email2 ? `<br><a href="mailto:${esc(c.email2)}">${esc(c.email2)}</a>` : ''}</dd></div>
                                <div><dt>Phone</dt><dd>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '—'}${c.phone2 ? `<br><a href="tel:${esc(c.phone2)}">${esc(c.phone2)}</a>` : ''}</dd></div>
                                <div><dt>Website</dt><dd>${c.website ? `<a href="${esc(c.website)}" target="_blank" rel="noopener">${esc(c.website)}</a>` : '—'}</dd></div>
                                <div><dt>Address</dt><dd>${esc([c.address, c.city, c.state, c.postal_code, c.country].filter(Boolean).join(', ') || '—')}</dd></div>
                                <div><dt>Owner</dt><dd>${C.personHtml(c.owner_id)}</dd></div>
                                <div><dt>Created</dt><dd>${esc(L.fmtDateTime(c.created_at))} by ${esc(C.personName(c.created_by))}</dd></div>
                                <div><dt>Last updated</dt><dd>${esc(L.fmtDateTime(c.updated_at))}</dd></div>
                                <div><dt>Contact ID</dt><dd class="muted" style="font-size:12px">${esc(c.id)}</dd></div>
                            </dl>
                            ${c.notes ? `<div class="crm-section-title" style="margin-top:18px"><h3>Notes</h3></div><div class="crm-desc">${C.linkify(C.nl2br(c.notes))}</div>` : ''}
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
                                <div><dt>Open deals</dt><dd>${openDeals.length} · ${esc(L.money(pm.pipeline_value))}</dd></div>
                                <div><dt>Won deals</dt><dd>${pm.won_count} · ${esc(L.money(pm.won_value))}</dd></div>
                                <div><dt>Open tasks</dt><dd>${tasks.filter(t => !t.completed_at).length}</dd></div>
                                <div><dt>Meetings</dt><dd>${events.filter(e => e.status !== 'cancelled').length}</dd></div>
                                ${ctx.isManager ? `<div><dt>Outstanding invoices</dt><dd>${esc(L.money(invoices.filter(i => !['paid', 'cancelled', 'draft'].includes(i.status)).reduce((a, i) => a + Number(i.balance || 0), 0)))}</dd></div>` : ''}
                            </dl>
                        </div>
                        ${leads.length ? `<div class="ws-card"><div class="crm-section-title"><h3>Converted from</h3></div><ul class="crm-list compact">${leads.map(l => `<li>${C.icon('target')}<div class="main"><b><a href="/leads/?id=${esc(l.id)}">${esc(l.name)}</a></b><span>Lead · converted ${esc(L.fmtDate(l.converted_at))}</span></div></li>`).join('')}</ul></div>` : ''}
                        ${projects.length ? `<div class="ws-card"><div class="crm-section-title"><h3>Projects</h3></div><ul class="crm-list compact">${projects.map(p => `<li>${C.icon('folder')}<div class="main"><b><a href="/projects/?id=${esc(p.id)}">${esc(p.name)}</a></b><span>${esc(L.PROJECT_STATUS[p.status] ? L.PROJECT_STATUS[p.status].label : p.status)}${p.due_date ? ' · due ' + esc(L.fmtDate(p.due_date)) : ''}</span></div></li>`).join('')}</ul></div>` : ''}
                        <div class="ws-card">
                            <div class="crm-section-title"><h3>Upcoming</h3></div>
                            ${(() => { const up = events.filter(e => e.status !== 'cancelled' && new Date(e.ends_at) >= new Date()).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at)).slice(0, 4); return up.length ? `<ul class="crm-list compact">${up.map(e => `<li>${C.icon('calendar')}<div class="main"><b><a href="/calendar/?id=${esc(e.id)}">${esc(e.title)}</a></b><span>${esc(L.fmtDateTime(e.starts_at))}</span></div></li>`).join('')}</ul>` : '<div class="muted" style="font-size:13px">No upcoming meetings.</div>'; })()}
                        </div>
                    </div>
                </div>
            </section>
            <section class="crm-tabpanel" data-panel="activity" hidden><div class="ws-card"><div id="activity"></div></div></section>
            <section class="crm-tabpanel" data-panel="deals" hidden><div class="ws-card flush"><div class="ws-card-head"><h3>Deals</h3><div class="right"><button type="button" class="ws-btn sm primary" id="deal-btn-2">${C.icon('plus')}<span>New deal</span></button></div></div><div id="deals"></div></div></section>
            <section class="crm-tabpanel" data-panel="tasks" hidden><div class="ws-card flush"><div class="ws-card-head"><h3>Tasks</h3><div class="right"><button type="button" class="ws-btn sm primary" id="task-btn-2">${C.icon('plus')}<span>New task</span></button></div></div><div id="tasks"></div></div></section>
            <section class="crm-tabpanel" data-panel="meetings" hidden><div class="ws-card flush"><div class="ws-card-head"><h3>Meetings &amp; calls</h3><div class="right"><button type="button" class="ws-btn sm primary" id="meet-btn-2">${C.icon('plus')}<span>Schedule</span></button></div></div><div id="events"></div></div></section>
            <section class="crm-tabpanel" data-panel="documents" hidden><div class="ws-card"><div class="crm-section-title"><h3>Documents</h3></div><div id="documents"></div></div></section>
            ${ctx.isManager ? `<section class="crm-tabpanel" data-panel="invoices" hidden><div class="ws-card flush"><div class="ws-card-head"><h3>Invoices</h3><div class="right"><a class="ws-btn sm primary" href="/invoices/?new=1&contact_id=${esc(c.id)}">${C.icon('plus')}<span>New invoice</span></a></div></div><div id="invoices"></div></div></section>` : ''}
            <section class="crm-tabpanel" data-panel="notes" hidden><div class="ws-card"><div class="crm-section-title"><h3>Notes</h3></div><div id="notes-composer"></div><div id="notes"></div></div></section>`;

        view.querySelector('[data-nav]').addEventListener('click', e => { e.preventDefault(); go('/contacts/'); });
        const tabItems = [
            { key: 'overview', label: 'Overview' }, { key: 'activity', label: 'Activity' },
            { key: 'deals', label: 'Deals', count: deals.length }, { key: 'tasks', label: 'Tasks', count: tasks.filter(t => !t.completed_at).length },
            { key: 'meetings', label: 'Meetings', count: events.filter(e => e.status !== 'cancelled').length }, { key: 'documents', label: 'Documents' },
        ];
        if (ctx.isManager) tabItems.push({ key: 'invoices', label: 'Invoices', count: invoices.length });
        tabItems.push({ key: 'notes', label: 'Notes' });
        const loaded = {};
        const tabs = C.tabs(view.querySelector('#tabs'), tabItems, { hash: true, onChange: k => loadTab(k) });

        // Overview widgets
        const recent = view.querySelector('#recent-activity');
        const feed = C.activityFeed(recent, { entity_type: 'contact', entity_id: id, contact_id: id, limit: 8 });
        C.comments(view.querySelector('#composer'), { entity_type: 'contact', entity_id: id, onPosted: () => { feed.reload(); if (loaded.activity) loaded.activity.reload(); if (loaded.notes) loaded.notes.reload(); } });

        function loadTab(k) {
            if (loaded[k]) return;
            if (k === 'activity') loaded.activity = C.activityFeed(view.querySelector('#activity'), { entity_type: 'contact', entity_id: id, contact_id: id, limit: 100 });
            if (k === 'notes') { C.comments(view.querySelector('#notes-composer'), { entity_type: 'contact', entity_id: id, onPosted: () => { loaded.notes.reload(); feed.reload(); } }); loaded.notes = C.activityFeed(view.querySelector('#notes'), { entity_type: 'contact', entity_id: id, actions: ['note.added'], limit: 100 }); }
            if (k === 'documents') loaded.documents = C.documents(view.querySelector('#documents'), { entity_type: 'contact', entity_id: id, canEdit: true });
            if (k === 'deals') { loaded.deals = true; renderDeals(); }
            if (k === 'tasks') { loaded.tasks = true; renderTasks(); }
            if (k === 'meetings') { loaded.meetings = true; renderEvents(); }
            if (k === 'invoices') { loaded.invoices = true; renderInvoices(); }
        }
        function renderDeals() {
            const el = view.querySelector('#deals');
            C.table(el, {
                rows: deals, onRow: d => { location.href = `/deals/?id=${d.id}`; }, sort: { key: 'created_at', dir: 'desc' },
                columns: [
                    { key: 'title', label: 'Deal', lead: true, render: d => `<span class="primary-text">${esc(d.title)}</span><span class="sub">${esc(lk.stageById[d.stage_id] ? lk.stageById[d.stage_id].name : '')}</span>` },
                    { key: 'value', label: 'Value', num: true, render: d => esc(L.money(d.value, d.currency)) },
                    { key: 'status', label: 'Status', render: d => C.statusBadge(L.DEAL_STATUS, d.status) },
                    { key: 'owner_id', label: 'Owner', value: d => C.personName(d.owner_id), render: d => C.personHtml(d.owner_id, { link: false }) },
                    { key: 'expected_close_date', label: 'Expected close', render: d => esc(L.fmtDate(d.expected_close_date) || '—') },
                ],
                empty: { title: 'No deals yet', sub: 'Open an opportunity for this contact.' },
            });
        }
        function renderTasks() {
            C.table(view.querySelector('#tasks'), {
                rows: tasks, onRow: t => { location.href = `/tasks/?id=${t.id}`; }, sort: { key: 'due_date', dir: 'asc' },
                columns: [
                    { key: 'title', label: 'Task', lead: true, render: t => `<span class="primary-text">${esc(t.title)}</span>` },
                    { key: 'status', label: 'Status', render: t => C.statusBadge(Object.fromEntries(lk.taskStatuses.map(s => [s.key, s])), t.status) },
                    { key: 'priority', label: 'Priority', render: t => C.priorityBadge(t.priority) },
                    { key: 'assignee_id', label: 'Assignee', value: t => C.personName(t.assignee_id), render: t => C.personHtml(t.assignee_id, { link: false }) },
                    { key: 'due_date', label: 'Due', render: t => C.dueHtml(t) },
                ],
                empty: { title: 'No tasks', sub: 'Create a follow-up task for this contact.' },
            });
        }
        function renderEvents() {
            C.table(view.querySelector('#events'), {
                rows: events, onRow: e => { location.href = `/calendar/?id=${e.id}`; }, sort: { key: 'starts_at', dir: 'desc' },
                columns: [
                    { key: 'title', label: 'Event', lead: true, render: e => `<span class="primary-text">${esc(e.title)}</span>` },
                    { key: 'event_type', label: 'Type', render: e => C.statusBadge(L.EVENT_TYPE, e.event_type) },
                    { key: 'starts_at', label: 'When', render: e => `${esc(L.fmtDateTime(e.starts_at))}${e.status === 'cancelled' ? ' ' + C.badge('mute', 'Cancelled') : ''}` },
                    { key: 'owner_id', label: 'Organiser', value: e => C.personName(e.owner_id), render: e => C.personHtml(e.owner_id, { link: false }) },
                ],
                empty: { title: 'No meetings', sub: 'Schedule a meeting or call with this contact.' },
            });
        }
        function renderInvoices() {
            C.table(view.querySelector('#invoices'), {
                rows: invoices, onRow: i => { location.href = `/invoices/?id=${i.id}`; }, sort: { key: 'invoice_date', dir: 'desc' },
                columns: [
                    { key: 'invoice_number', label: 'Invoice', lead: true, render: i => `<span class="primary-text">${esc(i.invoice_number)}</span>` },
                    { key: 'invoice_date', label: 'Date', render: i => esc(L.fmtDate(i.invoice_date)) },
                    { key: 'due_date', label: 'Due', render: i => esc(L.fmtDate(i.due_date) || '—') },
                    { key: 'status', label: 'Status', render: i => { const s = L.invoiceStatus(i); return C.badge(L.INVOICE_STATUS[s].color, L.INVOICE_STATUS[s].label); } },
                    { key: 'total', label: 'Total', num: true, render: i => esc(L.money(i.total, i.currency)) },
                    { key: 'balance', label: 'Balance', num: true, render: i => esc(L.money(i.balance, i.currency)) },
                ],
                empty: { title: 'No invoices', sub: 'Invoices raised for this contact will appear here.' },
            });
        }
        loadTab(tabs.active);

        // Actions
        const editBtn = view.querySelector('#edit-btn'); if (editBtn) editBtn.addEventListener('click', () => openContactEditor(c, () => showRecord(id)));
        const newTask = () => C.openTaskEditor({ defaults: { contact_id: id, title: '' }, onSaved: () => showRecord(id) });
        const newMeet = () => C.openEventEditor({ defaults: { contact_id: id, title: `Meeting with ${c.full_name || c.organization}` }, onSaved: () => showRecord(id) });
        const newDeal = () => openDealForContact(c, () => showRecord(id));
        view.querySelector('#task-btn').addEventListener('click', newTask); view.querySelector('#task-btn-2').addEventListener('click', newTask);
        on('#meet-btn', newMeet); on('#meet-btn-2', newMeet);
        view.querySelector('#deal-btn').addEventListener('click', newDeal); view.querySelector('#deal-btn-2').addEventListener('click', newDeal);
        view.querySelector('#more-btn').addEventListener('click', e => {
            const items = [
                { label: 'Log a call', icon: 'phone', onClick: () => logInteraction(c, 'call.logged', 'Log a call') },
                { label: 'Log an email', icon: 'mail', onClick: () => logInteraction(c, 'email.logged', 'Log an email') },
                { label: 'Log a meeting', icon: 'users', onClick: () => logInteraction(c, 'meeting.logged', 'Log a meeting') },
                'sep',
            ];
            if (canEdit) items.push(c.status === 'archived' ? { label: 'Restore contact', icon: 'refresh', onClick: () => setStatus(c, 'active', () => showRecord(id)) } : { label: 'Archive contact', icon: 'trash', danger: true, onClick: () => setStatus(c, 'archived', () => showRecord(id)) });
            if (ctx.isManager) items.push({ label: 'Delete permanently', icon: 'trash', danger: true, onClick: () => deleteContact(c) });
            C.menu(e.currentTarget, items);
        });
    }
    /** Bind a click inside the view, tolerating a node that is not rendered for this user. */
    function on(sel, fn) { const el = view.querySelector(sel); if (el) el.addEventListener('click', fn); }

    async function logInteraction(c, action, title) {
        await C.formModal({
            title, fields: [
                { name: 'summary', label: 'What happened?', type: 'textarea', required: true, full: true, rows: 4 },
                { name: 'when', label: 'When', type: 'datetime', required: true, value: new Date().toISOString() },
                { name: 'follow_up', label: 'Create a follow-up task', type: 'check' },
            ],
            submitLabel: 'Log', onSubmit: async v => {
                await C.logActivity(action, 'contact', c.id, v.summary.slice(0, 200), { at: v.when, summary: v.summary }, { contact_id: c.id });
                if (v.follow_up) await C.openTaskEditor({ defaults: { contact_id: c.id, title: `Follow up with ${c.full_name}` } });
                C.toast('Logged', 'ok');
                showRecord(c.id);
            },
        });
    }
    async function deleteContact(c) {
        const ok = await C.confirm({ title: 'Delete this contact permanently?', message: 'Deals, tasks and invoices linked to it will lose the link; their own history stays. Archiving is usually the better choice.', okText: 'Delete permanently', danger: true });
        if (!ok) return;
        try { await C.q(sb.from('crm_contacts').delete().eq('id', c.id)); C.toast('Contact deleted', 'ok'); go('/contacts/'); }
        catch (e) { C.toast(e.message, 'bad'); }
    }
    /** New deal pre-linked to a contact (mirrors the deals page dialog). */
    async function openDealForContact(c, onSaved) {
        const lk = await C.lookups();
        if (!lk.pipelines.length) return C.alert({ title: 'No pipeline yet', message: 'Ask a manager to set up a sales pipeline in Deals first.' });
        const pipeline = lk.defaultPipeline;
        const stages = L.stagesOf(lk.stages, pipeline.id).filter(s => !s.is_won && !s.is_lost);
        return C.formModal({
            title: `New deal for ${c.full_name || c.organization}`, size: 'wide',
            fields: [
                { name: 'title', label: 'Deal title', type: 'text', required: true, full: true },
                { name: 'value', label: 'Value', type: 'money', required: true },
                { name: 'currency', label: 'Currency', type: 'select', options: ['INR', 'USD', 'EUR', 'GBP', 'AED'], required: true },
                { name: 'pipeline_id', label: 'Pipeline', type: 'select', options: lk.pipelines.map(p => ({ value: p.id, label: p.name })), required: true },
                { name: 'stage_id', label: 'Stage', type: 'select', options: stages.map(s => ({ value: s.id, label: s.name })), required: true },
                { name: 'owner_id', label: 'Owner', type: 'people', none: null },
                { name: 'expected_close_date', label: 'Expected close', type: 'date' },
                { name: 'source', label: 'Source', type: 'select', options: SOURCES, placeholder: 'Source' },
                { name: 'description', label: 'Description', type: 'textarea', full: true },
            ],
            values: { title: `${c.organization || c.full_name} deal`, value: 0, currency: 'INR', pipeline_id: pipeline.id, stage_id: stages[0] ? stages[0].id : '', owner_id: c.owner_id || me.id, source: c.source || '' },
            onReady: f => {
                f.field('pipeline_id').el.addEventListener('change', e => {
                    const st = L.stagesOf(lk.stages, e.target.value).filter(s => !s.is_won && !s.is_lost);
                    f.field('stage_id').el.innerHTML = st.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
                });
            },
            submitLabel: 'Create deal',
            onSubmit: async v => {
                const { data } = await C.q(sb.from('crm_deals').insert({ ...v, contact_id: c.id, organization: c.organization || null, created_by: me.id, description: v.description || null, expected_close_date: v.expected_close_date || null, source: v.source || null }).select('id').single());
                C.toast('Deal created', 'ok');
                if (onSaved) onSaved(data);
                return data;
            },
        });
    }

    route();
})();
