/* ============================================================================
   Leads — list, create/edit with duplicate warning, follow-ups, status
   changes, and conversion into a contact + deal through crm_convert_lead().
   The lead row survives conversion with links to what it became.

   URLs:  /leads/            list         /leads/?id=<uuid>   record
          /leads/?new=1      list + new-lead dialog
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'leads', crumb: 'Leads' });
    const sb = ctx.sb, me = ctx.user;

    const SOURCES = ['Website', 'Referral', 'Cold call', 'Email campaign', 'Social media', 'Event', 'Partner', 'Walk-in', 'Other'];
    const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED'];
    const SELECT = 'id, company, name, organization, email, phone, source, source_detail, owner_id, status, estimated_value, currency, priority, notes, next_follow_up_at, tags, converted_at, converted_by, converted_contact_id, converted_deal_id, archived_at, created_by, created_at, updated_at';

    const lk = await C.lookups();
    const statuses = lk.leadStatuses.length ? lk.leadStatuses : [
        { key: 'new', label: 'New', color: 'pending' }, { key: 'contacted', label: 'Contacted', color: 'late' },
        { key: 'qualified', label: 'Qualified', color: 'present' }, { key: 'unqualified', label: 'Unqualified', color: 'weekoff', is_closed: true },
        { key: 'converted', label: 'Converted', color: 'leave', is_closed: true, is_converted: true },
    ];
    const STATUS = Object.fromEntries(statuses.map(s => [s.key, { label: s.label, color: s.color || 'mute' }]));
    const openKeys = statuses.filter(s => !s.is_closed).map(s => s.key);

    /* ------------------------------------------------------------ routing */
    function route() {
        const id = C.param('id');
        if (id) return showRecord(id);
        return showList();
    }
    window.addEventListener('popstate', route);
    function go(url) { history.pushState(null, '', url); route(); }

    /* -------------------------------------------------------- follow-ups */
    /** overdue | today | soon | upcoming | none — for the next_follow_up_at instant. */
    function followState(l) {
        if (!l.next_follow_up_at) return 'none';
        if (l.status === 'converted' || l.status === 'unqualified') return 'none';
        return L.taskDueState({ due_date: L.istDate(l.next_follow_up_at) });
    }
    function followHtml(l) {
        const st = followState(l);
        if (st === 'none') return '<span class="muted">—</span>';
        const label = st === 'overdue' ? `Overdue · ${L.fmtDateTime(l.next_follow_up_at)}` : st === 'today' ? `Today · ${L.fmtTime(l.next_follow_up_at)}` : L.fmtDateTime(l.next_follow_up_at);
        return `<span class="crm-due ${st}">${esc(label)}</span>`;
    }
    function canEditLead(l) { return ctx.isManager || L.canEdit({ owner_id: l.owner_id, created_by: l.created_by }, me); }

    /* --------------------------------------------------------- lead form */
    function leadFields() {
        return [
            { name: 'name', label: 'Name', type: 'text', required: true, full: true, placeholder: 'Person or company name' },
            { name: 'organization', label: 'Company / organisation', type: 'text' },
            { name: 'owner_id', label: 'Owner', type: 'people', none: 'Unassigned' },
            { name: 'email', label: 'Email', type: 'email' },
            { name: 'phone', label: 'Phone', type: 'tel' },
            { name: 'status', label: 'Status', type: 'select', options: statuses.filter(s => !s.is_converted).map(s => ({ value: s.key, label: s.label })), required: true },
            { name: 'priority', label: 'Priority', type: 'select', options: Object.entries(L.PRIORITY).map(([k, v]) => ({ value: k, label: v.label })), required: true },
            { name: 'source', label: 'Source', type: 'select', options: SOURCES, placeholder: 'How did they find us?' },
            { name: 'source_detail', label: 'Campaign / source detail', type: 'text', placeholder: 'e.g. Diwali campaign, LinkedIn ad' },
            { name: 'estimated_value', label: 'Estimated value', type: 'money' },
            { name: 'currency', label: 'Currency', type: 'select', options: CURRENCIES, required: true },
            { name: 'next_follow_up_at', label: 'Next follow-up', type: 'datetime', full: true },
            { name: 'tags', label: 'Tags', type: 'tags', full: true },
            { name: 'notes', label: 'Notes', type: 'textarea', full: true },
        ];
    }
    function cleanValues(v) {
        const out = { ...v };
        out.email = L.normalizeEmail(out.email);
        ['name', 'organization', 'phone', 'source', 'source_detail', 'notes'].forEach(k => { out[k] = out[k] ? String(out[k]).trim() || null : null; });
        out.owner_id = out.owner_id || null;
        out.tags = out.tags || [];
        out.estimated_value = out.estimated_value == null ? null : Number(out.estimated_value);
        out.next_follow_up_at = out.next_follow_up_at || null;
        return out;
    }
    /** Contacts and leads that already carry this email / phone. */
    async function findCandidates(values, excludeLeadId) {
        const emails = [values.email].map(L.normalizeEmail).filter(Boolean);
        const digits = values.phone ? String(values.phone).replace(/\D/g, '').slice(-10) : '';
        const ors = [];
        emails.forEach(e => ors.push(`email.ilike.${e}`));
        if (digits.length >= 6) ors.push(`phone.ilike.%${digits}%`);
        if (!ors.length) return { contacts: [], leads: [] };
        const [c, l] = await Promise.all([
            sb.from('crm_contacts').select('id, full_name, organization, email, phone, email2, phone2, status').or(ors.join(',') + (emails.length ? `,email2.ilike.${emails[0]}` : '') + (digits.length >= 6 ? `,phone2.ilike.%${digits}%` : '')).neq('status', 'archived').limit(10),
            sb.from('crm_leads').select('id, name, organization, email, phone, status').or(ors.join(',')).is('archived_at', null).limit(10),
        ]);
        return {
            contacts: c.error ? [] : L.findDuplicateContacts(values, c.data || []),
            leads: l.error ? [] : L.findDuplicateContacts(values, (l.data || []).filter(x => x.id !== excludeLeadId)),
        };
    }
    /** Warn before saving a lead that matches an existing contact or lead. Resolves true to proceed. */
    async function duplicateCheck(values, excludeLeadId) {
        if (!values.email && !values.phone) return true;
        const { contacts, leads } = await findCandidates(values, excludeLeadId);
        if (!contacts.length && !leads.length) return true;
        return new Promise(resolve => {
            const row = (href, name, sub) => `<li>${C.avatarHtml({ name })}<div class="main"><b><a href="${esc(href)}">${esc(name)}</a></b><span>${esc(sub)}</span></div></li>`;
            C.modal({
                title: 'Possible duplicate',
                body: `<div class="crm-warn" style="margin-bottom:12px">Someone with the same email or phone already exists.</div>
                       <ul class="crm-list compact">
                       ${contacts.map(d => row(`/contacts/?id=${d.id}`, d.full_name || d.organization, ['Contact', d.organization, d.email || d.email2, d.phone || d.phone2].filter(Boolean).join(' · '))).join('')}
                       ${leads.map(d => row(`/leads/?id=${d.id}`, d.name, ['Lead', STATUS[d.status] ? STATUS[d.status].label : d.status, d.organization, d.email, d.phone].filter(Boolean).join(' · '))).join('')}
                       </ul>`,
                actions: [
                    { label: 'Open existing', onClick: api => { api.close(); resolve(false); const first = contacts[0] ? `/contacts/?id=${contacts[0].id}` : `/leads/?id=${leads[0].id}`; if (first.startsWith('/leads/')) go(first); else location.href = first; } },
                    { label: 'Cancel', close: true },
                    { label: 'Save anyway', primary: true, onClick: api => { api.close(); resolve(true); } },
                ],
                onClose: () => resolve(false),
            });
        });
    }
    async function openLeadEditor(lead, onSaved) {
        const isNew = !lead;
        return C.formModal({
            title: isNew ? 'New lead' : 'Edit lead', size: 'wide', fields: leadFields(),
            values: isNew ? { status: openKeys[0] || 'new', priority: 'normal', owner_id: me.id, currency: 'INR' } : lead,
            submitLabel: isNew ? 'Create lead' : 'Save changes',
            onSubmit: async (v, api) => {
                const values = cleanValues(v);
                api.close();
                if (isNew) {
                    const proceed = await duplicateCheck(values, null);
                    if (!proceed) return null;
                }
                try {
                    const row = isNew ? { ...values, created_by: me.id } : values;
                    const saved = isNew
                        ? (await C.q(sb.from('crm_leads').insert(row).select(SELECT).single())).data
                        : (await C.q(sb.from('crm_leads').update(row).eq('id', lead.id).select(SELECT).single())).data;
                    if (saved.owner_id && saved.owner_id !== me.id && (isNew || saved.owner_id !== lead.owner_id)) C.pushNotify({ to: saved.owner_id, title: 'Lead assigned to you', body: saved.name, url: `/leads/?id=${saved.id}`, tag: 'crm' });
                    C.toast(isNew ? 'Lead created' : 'Lead saved', 'ok');
                    if (onSaved) onSaved(saved);
                    return saved;
                } catch (e) { C.toast(e.message, 'bad'); return null; }
            },
        });
    }

    /* --------------------------------------------------- small actions */
    async function setLeadStatus(l, status, after) {
        if (status === l.status) return;
        try {
            await C.q(sb.from('crm_leads').update({ status }).eq('id', l.id));
            C.toast(`Marked ${STATUS[status] ? STATUS[status].label.toLowerCase() : status}`, 'ok');
            if (after) after();
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function assignLead(l, after) {
        await C.formModal({
            title: `Assign ${l.name}`, fields: [{ name: 'owner_id', label: 'Owner', type: 'people', none: 'Unassigned', full: true }], values: { owner_id: l.owner_id || '' },
            submitLabel: 'Assign', onSubmit: async v => {
                await C.q(sb.from('crm_leads').update({ owner_id: v.owner_id || null }).eq('id', l.id));
                if (v.owner_id && v.owner_id !== me.id) C.pushNotify({ to: v.owner_id, title: 'Lead assigned to you', body: l.name, url: `/leads/?id=${l.id}`, tag: 'crm' });
                C.toast('Owner updated', 'ok'); if (after) after();
            },
        });
    }
    async function setFollowUp(l, after) {
        await C.formModal({
            title: 'Set follow-up', fields: [{ name: 'when', label: 'Follow up on', type: 'datetime', required: true, full: true }, { name: 'task', label: 'Also create a task for the owner', type: 'check', full: true }],
            values: { when: l.next_follow_up_at || (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); return d.toISOString(); })(), task: false },
            submitLabel: 'Save', onSubmit: async v => {
                await C.q(sb.from('crm_leads').update({ next_follow_up_at: v.when }).eq('id', l.id));
                await C.logActivity('lead.follow_up_set', 'lead', l.id, l.name, { at: v.when }, { lead_id: l.id });
                if (v.task) await C.openTaskEditor({ defaults: { lead_id: l.id, title: `Follow up with ${l.name}`, assignee_id: l.owner_id || me.id, due_date: L.istDate(v.when) } });
                C.toast('Follow-up set', 'ok'); if (after) after();
            },
        });
    }
    async function archiveLead(l, archive, after) {
        if (archive && !await C.confirm({ title: `Archive ${l.name}?`, message: 'The lead is hidden from lists but keeps its history, tasks and notes. You can restore it later.', okText: 'Archive', danger: true })) return;
        try {
            await C.q(sb.from('crm_leads').update({ archived_at: archive ? new Date().toISOString() : null }).eq('id', l.id));
            C.toast(archive ? 'Lead archived' : 'Lead restored', 'ok'); if (after) after();
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function deleteLead(l) {
        if (!await C.confirm({ title: 'Delete this lead permanently?', message: 'Its history and notes go with it. Archiving is usually the better choice.', okText: 'Delete permanently', danger: true })) return;
        try { await C.q(sb.from('crm_leads').delete().eq('id', l.id)); C.toast('Lead deleted', 'ok'); go('/leads/'); }
        catch (e) { C.toast(e.message, 'bad'); }
    }
    function statusMenuItems(l, after) {
        return statuses.filter(s => !s.is_converted && s.key !== l.status).map(s => ({ label: s.label, icon: 'check', onClick: () => setLeadStatus(l, s.key, after) }));
    }

    /* ----------------------------------------------------------- convert */
    async function openConvert(l, onDone) {
        if (l.status === 'converted') return;
        const { contacts: candidates } = await findCandidates({ email: l.email, phone: l.phone }, l.id);
        const pipelines = lk.pipelines;
        if (!pipelines.length) return C.alert({ title: 'No pipeline yet', message: 'Ask a manager to set up a sales pipeline in Deals before converting leads with a deal.' });
        const pipeline = lk.defaultPipeline || pipelines[0];
        const openStages = pid => L.stagesOf(lk.stages, pid).filter(s => !s.is_won && !s.is_lost);
        const plan = L.planLeadConversion(l, candidates);
        const preview = document.createElement('div');
        preview.className = 'crm-info'; preview.style.marginBottom = '12px';

        const fields = [
            { name: 'contact_mode', label: 'Contact', type: 'select', full: true, required: true, options: [
                ...(candidates.length ? [{ value: 'link', label: `Link to existing: ${candidates[0].full_name || candidates[0].organization}${candidates.length > 1 ? ` (+${candidates.length - 1} more match)` : ''}` }] : []),
                { value: 'create', label: `Create a new contact "${l.name}"` },
                { value: 'pick', label: 'Choose another existing contact…' },
            ] },
            { name: 'contact_id', label: 'Existing contact', type: 'entity', entity: 'contact', full: true, placeholder: 'Search contacts' },
            { name: 'create_deal', label: 'Also create a deal', type: 'check', full: true },
            { name: 'deal_title', label: 'Deal title', type: 'text', full: true },
            { name: 'deal_value', label: 'Deal value', type: 'money' },
            { name: 'pipeline_id', label: 'Pipeline', type: 'select', options: pipelines.map(p => ({ value: p.id, label: p.name })) },
            { name: 'stage_id', label: 'Stage', type: 'select', options: openStages(pipeline.id).map(s => ({ value: s.id, label: s.name })) },
            { name: 'expected_close', label: 'Expected close', type: 'date' },
        ];
        const values = {
            contact_mode: candidates.length ? 'link' : 'create', contact_id: '', create_deal: true,
            deal_title: plan.deal ? plan.deal.title : `${l.name} deal`, deal_value: plan.deal ? plan.deal.value : (Number(l.estimated_value) || 0),
            pipeline_id: pipeline.id, stage_id: (openStages(pipeline.id)[0] || {}).id || '',
        };
        return C.formModal({
            title: `Convert ${l.name}`, size: 'wide', fields, values, submitLabel: 'Convert lead',
            intro: `<div class="crm-info" id="cv-preview"></div>`,
            onReady: f => {
                const mode = f.field('contact_mode'), pick = f.field('contact_id'), deal = f.field('create_deal');
                const dealFields = ['deal_title', 'deal_value', 'pipeline_id', 'stage_id', 'expected_close'].map(n => f.field(n));
                const previewEl = document.getElementById('cv-preview');
                function sync() {
                    const m = mode.get();
                    pick.wrap.hidden = m !== 'pick';
                    const on = deal.get();
                    dealFields.forEach(w => { w.wrap.hidden = !on; });
                    const contactText = m === 'link' ? `link this lead to the existing contact <b>${esc(candidates[0].full_name || candidates[0].organization)}</b> (no duplicate is created)`
                        : m === 'pick' ? 'link this lead to the contact you choose'
                        : `create a new contact <b>${esc(l.name)}</b>${l.organization ? ` at ${esc(l.organization)}` : ''}`;
                    const dealText = on ? `, open a deal <b>${esc(f.field('deal_title').get() || plan.deal.title)}</b> worth ${esc(L.money(f.field('deal_value').get() || 0, l.currency))}` : ', and not open a deal';
                    previewEl.innerHTML = `Converting will ${contactText}${dealText}. The lead stays on record as <b>Converted</b> with links to both.`;
                }
                mode.el.addEventListener('change', sync);
                deal.el.addEventListener('change', sync);
                f.field('deal_title').el.addEventListener('input', sync);
                f.field('deal_value').el.addEventListener('input', sync);
                f.field('pipeline_id').el.addEventListener('change', e => {
                    f.field('stage_id').el.innerHTML = openStages(e.target.value).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
                });
                sync();
            },
            onSubmit: async v => {
                let contactId = null;
                if (v.contact_mode === 'link') contactId = candidates[0].id;
                else if (v.contact_mode === 'pick') { if (!v.contact_id) throw new Error('Choose a contact to link to, or create a new one.'); contactId = v.contact_id; }
                if (v.create_deal && !v.stage_id) throw new Error('The chosen pipeline has no open stage.');
                const r = await sb.rpc('crm_convert_lead', {
                    p_lead_id: l.id, p_contact_id: contactId, p_create_deal: !!v.create_deal,
                    p_deal_title: v.create_deal ? (v.deal_title || null) : null, p_deal_value: v.create_deal ? (v.deal_value == null ? null : Number(v.deal_value)) : null,
                    p_pipeline_id: v.create_deal ? v.pipeline_id : null, p_stage_id: v.create_deal ? v.stage_id : null, p_expected_close: v.create_deal ? (v.expected_close || null) : null,
                });
                if (r.error) throw new Error(C.friendly(r.error));
                const out = r.data || {};
                if (l.owner_id && l.owner_id !== me.id) C.pushNotify({ to: l.owner_id, title: 'Lead converted', body: l.name, url: `/leads/?id=${l.id}`, tag: 'crm' });
                C.toast('Lead converted', 'ok');
                C.modal({
                    title: 'Converted', body: `<p style="margin:0 0 12px">${esc(l.name)} is now ${out.existing_contact ? 'linked to an existing contact' : 'a contact'}${out.deal_id ? ' with a new deal' : ''}.</p>
                        <div style="display:flex;gap:8px;flex-wrap:wrap">${out.contact_id ? C.entityChip('contact', out.contact_id, 'Open contact') : ''}${out.deal_id ? C.entityChip('deal', out.deal_id, 'Open deal') : ''}</div>`,
                    actions: [{ label: 'Done', primary: true, close: true }],
                    onClose: () => { if (onDone) onDone(out); },
                });
                return out;
            },
        });
    }

    /* --------------------------------------------------------------- list */
    const listState = { rows: [], q: '', seg: 'open', status: '', owner: '', priority: '', serverSearch: false };
    async function fetchLeads() {
        let b = sb.from('crm_leads').select(SELECT).order('updated_at', { ascending: false }).limit(500);
        if (listState.seg === 'archived') b = b.not('archived_at', 'is', null); else b = b.is('archived_at', null);
        if (listState.seg === 'open') b = b.in('status', openKeys.length ? openKeys : ['new']);
        else if (listState.seg === 'converted') b = b.eq('status', 'converted');
        else if (listState.seg === 'unqualified') b = b.eq('status', 'unqualified');
        if (listState.status) b = b.eq('status', listState.status);
        if (listState.priority) b = b.eq('priority', listState.priority);
        if (listState.owner === 'me') b = b.eq('owner_id', me.id); else if (listState.owner === 'none') b = b.is('owner_id', null); else if (listState.owner) b = b.eq('owner_id', listState.owner);
        if (listState.q && listState.serverSearch) { const t = listState.q.replace(/[%,()]/g, ' '); b = b.or(`name.ilike.%${t}%,organization.ilike.%${t}%,email.ilike.%${t}%,phone.ilike.%${t}%`); }
        const { data } = await C.q(b);
        return data || [];
    }
    function filterRows(rows) {
        const q = listState.q.trim().toLowerCase();
        if (!q || listState.serverSearch) return rows;
        return rows.filter(r => [r.name, r.organization, r.email, r.phone, r.source_detail, (r.tags || []).join(' ')].some(v => v && String(v).toLowerCase().includes(q)));
    }
    async function showList() {
        // Deep links from the dashboard / palette: ?status=<key> shows that status across all segments.
        { const st = C.param('status'); if (st) { listState.status = st; listState.seg = 'all'; C.setParam('status', null, true); } }
        WSShell.setCrumb('Leads');
        document.title = 'Leads · WorkSuite';
        view.innerHTML = `
            <div class="ws-page-head">
                <div><p class="ws-eyebrow">CRM</p><h1>Leads</h1><p>Enquiries and prospects, from first contact to conversion.</p></div>
                <div class="actions"><button type="button" class="ws-btn primary" id="new-btn">${C.icon('plus')}<span>New lead</span></button></div>
            </div>
            <div class="crm-toolbar">
                <div class="crm-seg" id="seg" role="tablist">
                    <button type="button" data-seg="open" class="on">Open</button>
                    <button type="button" data-seg="all">All</button>
                    <button type="button" data-seg="converted">Converted</button>
                    <button type="button" data-seg="unqualified">Unqualified</button>
                    <button type="button" data-seg="archived">Archived</button>
                </div>
                <div class="crm-search grow">${C.icon('search', 'sm')}<input type="search" id="q" placeholder="Search name, company, email, phone…" aria-label="Search leads"></div>
                <select id="f-status" aria-label="Status"><option value="">Any status</option>${statuses.map(s => `<option value="${esc(s.key)}">${esc(s.label)}</option>`).join('')}</select>
                <select id="f-owner" aria-label="Owner"><option value="">Any owner</option><option value="me">Owned by me</option><option value="none">Unassigned</option>${C.peopleOptions('', { none: null })}</select>
                <select id="f-priority" aria-label="Priority"><option value="">Any priority</option>${Object.entries(L.PRIORITY).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select>
                <span class="crm-count" id="count"></span>
                <span class="crm-count" id="due"></span>
            </div>
            <div id="bulk" class="crm-bulkbar" hidden></div>
            <div class="ws-card flush"><div id="table"></div></div>`;
        const tableEl = view.querySelector('#table');
        C.skeletonRows(tableEl, 6);
        view.querySelector('#new-btn').addEventListener('click', () => openLeadEditor(null, l => go(`/leads/?id=${l.id}`)));
        view.querySelector('#q').value = listState.q;
        view.querySelector('#f-status').value = listState.status;
        view.querySelector('#f-owner').value = listState.owner;
        view.querySelector('#f-priority').value = listState.priority;
        view.querySelectorAll('#seg button').forEach(b => b.classList.toggle('on', b.dataset.seg === listState.seg));

        let tbl = null;
        const bulk = view.querySelector('#bulk');
        function renderBulk(sel) {
            bulk.hidden = !sel.length;
            if (!sel.length) return;
            bulk.innerHTML = `<span>${sel.length} selected</span>
                <select id="bulk-owner" aria-label="Assign owner"><option value="">Assign owner…</option>${C.peopleOptions('', { none: null })}</select>
                <select id="bulk-status" aria-label="Change status"><option value="">Change status…</option>${statuses.filter(s => !s.is_converted).map(s => `<option value="${esc(s.key)}">${esc(s.label)}</option>`).join('')}</select>
                <button type="button" class="ws-btn sm" id="bulk-archive">${C.icon('trash')}<span>Archive</span></button>
                <span class="spacer"></span><button type="button" class="ws-btn sm ghost" id="bulk-clear">Clear</button>`;
            bulk.querySelector('#bulk-owner').addEventListener('change', async e => {
                if (!e.target.value) return;
                try {
                    await C.q(sb.from('crm_leads').update({ owner_id: e.target.value }).in('id', sel));
                    if (e.target.value !== me.id) C.pushNotify({ to: e.target.value, title: `${sel.length} lead${sel.length > 1 ? 's' : ''} assigned to you`, body: '', url: '/leads/?owner=me', tag: 'crm' });
                    C.toast(`Assigned ${sel.length} lead${sel.length > 1 ? 's' : ''}`, 'ok'); await reload();
                } catch (err) { C.toast(err.message, 'bad'); }
            });
            bulk.querySelector('#bulk-status').addEventListener('change', async e => {
                if (!e.target.value) return;
                try { await C.q(sb.from('crm_leads').update({ status: e.target.value }).in('id', sel).neq('status', 'converted')); C.toast('Status updated', 'ok'); await reload(); } catch (err) { C.toast(err.message, 'bad'); }
            });
            bulk.querySelector('#bulk-archive').addEventListener('click', async () => {
                if (!await C.confirm({ title: `Archive ${sel.length} lead${sel.length > 1 ? 's' : ''}?`, message: 'Archived leads are hidden from lists but keep their history. You can restore them later.', okText: 'Archive', danger: true })) return;
                try { await C.q(sb.from('crm_leads').update({ archived_at: new Date().toISOString() }).in('id', sel)); C.toast('Archived', 'ok'); await reload(); } catch (err) { C.toast(err.message, 'bad'); }
            });
            bulk.querySelector('#bulk-clear').addEventListener('click', () => tbl && tbl.clearSelection());
        }
        function columns() {
            return [
                { key: 'name', label: 'Lead', lead: true, render: r => `<div class="who">${C.avatarHtml({ name: r.name })}<div><span class="primary-text">${esc(r.name)}</span><span class="sub">${esc([r.email, r.phone].filter(Boolean).join(' · ') || '—')}</span></div></div>` },
                { key: 'organization', label: 'Company', render: r => esc(r.organization || '—') },
                { key: 'status', label: 'Status', render: r => C.statusBadge(STATUS, r.status) },
                { key: 'priority', label: 'Priority', value: r => (L.PRIORITY[r.priority] || {}).rank, render: r => C.priorityBadge(r.priority) },
                { key: 'owner_id', label: 'Owner', value: r => C.personName(r.owner_id), render: r => C.personHtml(r.owner_id, { link: false }) },
                { key: 'estimated_value', label: 'Est. value', num: true, value: r => Number(r.estimated_value) || 0, render: r => r.estimated_value != null ? esc(L.money(r.estimated_value, r.currency)) : '<span class="muted">—</span>' },
                { key: 'next_follow_up_at', label: 'Next follow-up', render: r => followHtml(r) },
                { key: 'created_at', label: 'Created', num: true, hideMobile: true, render: r => `<span class="muted">${esc(L.fmtRelative(r.created_at))}</span>` },
                { key: 'actions', label: '', sort: false, cls: 'actions', render: r => `<button type="button" class="ws-btn sm icon" data-menu="${esc(r.id)}" aria-label="Actions">${C.icon('more')}</button>` },
            ];
        }
        function paint() {
            const rows = filterRows(listState.rows);
            view.querySelector('#count').textContent = `${rows.length} lead${rows.length === 1 ? '' : 's'}${listState.rows.length >= 500 ? ' (first 500 loaded, search to narrow)' : ''}`;
            const due = rows.filter(r => ['overdue', 'today'].includes(followState(r))).length;
            view.querySelector('#due').innerHTML = due ? `<span class="crm-due overdue">${due} follow-up${due === 1 ? '' : 's'} due</span>` : '';
            if (!tbl) {
                tbl = C.table(tableEl, {
                    columns: columns(), rows, sort: { key: 'updated_at', dir: 'desc' }, selectable: true, pageSize: 50,
                    onRow: r => go(`/leads/?id=${r.id}`), onSelectionChange: renderBulk,
                    empty: { title: listState.q || listState.status || listState.owner || listState.priority ? 'No leads match' : listState.seg === 'open' ? 'No open leads' : 'No leads here', sub: listState.q ? 'Try a different search or clear the filters.' : 'Capture an enquiry to get started.', action: listState.q ? '' : `<button type="button" class="ws-btn primary" onclick="document.getElementById('new-btn').click()">${C.icon('plus')}<span>New lead</span></button>` },
                });
            } else tbl.update(rows);
        }
        async function reload() {
            try { listState.rows = await fetchLeads(); paint(); }
            catch (e) { C.errorState(tableEl, e, reload); }
        }
        tableEl.addEventListener('click', e => {
            const b = e.target.closest('[data-menu]'); if (!b) return;
            e.stopPropagation();
            const r = listState.rows.find(x => x.id === b.dataset.menu); if (!r) return;
            const edit = canEditLead(r);
            const items = [{ label: 'Open', icon: 'arrow', onClick: () => go(`/leads/?id=${r.id}`) }];
            if (edit) {
                items.push({ label: 'Edit', icon: 'edit', onClick: () => openLeadEditor(r, reload) });
                if (r.status !== 'converted' && !r.archived_at) items.push({ label: 'Convert', icon: 'deal', onClick: () => openConvert(r, reload) });
                if (r.status !== 'converted') items.push({ label: 'Set follow-up', icon: 'clock', onClick: () => setFollowUp(r, reload) });
                if (r.status !== 'converted') items.push(...statusMenuItems(r, reload).map(it => ({ ...it, label: `Mark ${it.label.toLowerCase()}` })));
                items.push({ label: 'Assign owner', icon: 'user', onClick: () => assignLead(r, reload) });
                items.push('sep');
                items.push(r.archived_at ? { label: 'Restore', icon: 'refresh', onClick: () => archiveLead(r, false, reload) } : { label: 'Archive', icon: 'trash', danger: true, onClick: () => archiveLead(r, true, reload) });
            }
            C.menu(b, items);
        });
        const onSearch = C.debounce(async () => {
            listState.q = view.querySelector('#q').value;
            const needServer = listState.rows.length >= 500;
            if (needServer !== listState.serverSearch || needServer) { listState.serverSearch = needServer; await reload(); } else paint();
        }, 220);
        view.querySelector('#q').addEventListener('input', onSearch);
        view.querySelector('#seg').addEventListener('click', e => {
            const b = e.target.closest('[data-seg]'); if (!b) return;
            listState.seg = b.dataset.seg;
            view.querySelectorAll('#seg button').forEach(x => x.classList.toggle('on', x === b));
            reload();
        });
        view.querySelector('#f-status').addEventListener('change', e => { listState.status = e.target.value; reload(); });
        view.querySelector('#f-owner').addEventListener('change', e => { listState.owner = e.target.value; reload(); });
        view.querySelector('#f-priority').addEventListener('change', e => { listState.priority = e.target.value; reload(); });
        if (C.param('owner') === 'me') { listState.owner = 'me'; view.querySelector('#f-owner').value = 'me'; C.setParam('owner', null, true); }
        await reload();
        if (C.param('new') === '1') { C.setParam('new', null, true); openLeadEditor(null, l => go(`/leads/?id=${l.id}`)); }
    }

    /* ------------------------------------------------------------- record */
    async function showRecord(id) {
        C.loading(view, 'Loading lead…');
        let l;
        try { l = (await C.q(sb.from('crm_leads').select(SELECT).eq('id', id).maybeSingle())).data; }
        catch (e) { return C.errorState(view, e, () => showRecord(id)); }
        if (!l) { view.innerHTML = `<a class="crm-back" href="/leads/">${C.icon('arrow')}All leads</a>`; C.empty(view.appendChild(document.createElement('div')), 'Lead not found', 'It may have been deleted, or you may not have access to it.'); return; }
        const canEdit = canEditLead(l);
        const converted = l.status === 'converted';
        document.title = `${l.name} · Leads · WorkSuite`;
        WSShell.setCrumb(l.name);

        const [tasks, events, contact, deal] = await Promise.all([
            C.related('tasks', 'lead_id', id, 'id, title, status, priority, assignee_id, due_date, completed_at, archived_at, created_at', b => b.is('archived_at', null)),
            C.related('calendar_events', 'lead_id', id, 'id, title, starts_at, ends_at, event_type, status, owner_id', b => b.order('starts_at', { ascending: false })),
            l.converted_contact_id ? C.related('crm_contacts', 'id', l.converted_contact_id, 'id, full_name, organization') : Promise.resolve([]),
            l.converted_deal_id ? C.related('crm_deals', 'id', l.converted_deal_id, 'id, title, value, currency, status') : Promise.resolve([]),
        ]);
        const fs = followState(l);

        view.innerHTML = `
            <a class="crm-back" href="/leads/" data-nav>${C.icon('arrow')}All leads</a>
            <div class="crm-record-head">
                ${C.avatarHtml({ name: l.name }, 'xl')}
                <div class="titles">
                    <h1>${esc(l.name)}</h1>
                    <div class="meta">
                        ${l.organization ? `<span>${C.icon('building', 'sm')} ${esc(l.organization)}</span>` : ''}
                        ${C.statusBadge(STATUS, l.status)}
                        ${C.priorityBadge(l.priority)}
                        ${l.archived_at ? C.badge('mute', 'Archived') : ''}
                        ${l.email ? `<a href="mailto:${esc(l.email)}">${C.icon('mail', 'sm')} ${esc(l.email)}</a>` : ''}
                        ${l.phone ? `<a href="tel:${esc(l.phone)}">${C.icon('phone', 'sm')} ${esc(l.phone)}</a>` : ''}
                        <span>Owner: ${C.personHtml(l.owner_id)}</span>
                        ${fs !== 'none' ? `<span>Follow-up: ${followHtml(l)}</span>` : ''}
                        ${C.tagsHtml(l.tags)}
                    </div>
                    ${converted ? `<div class="meta" style="margin-top:8px"><span>Converted ${esc(L.fmtDateTime(l.converted_at))} by ${esc(C.personName(l.converted_by))} →</span>${contact[0] ? C.entityChip('contact', contact[0].id, contact[0].full_name || contact[0].organization) : ''}${deal[0] ? C.entityChip('deal', deal[0].id, `${deal[0].title} · ${L.money(deal[0].value, deal[0].currency)}`) : ''}</div>` : ''}
                </div>
                <div class="actions">
                    ${canEdit && !converted ? `<button type="button" class="ws-btn" id="edit-btn">${C.icon('edit')}<span>Edit</span></button>` : ''}
                    ${canEdit && !converted ? `<button type="button" class="ws-btn" id="status-btn">${C.icon('check')}<span>Status</span></button>` : ''}
                    <button type="button" class="ws-btn" id="task-btn">${C.icon('tasks')}<span>Task</span></button>
                    <button type="button" class="ws-btn" id="meet-btn">${C.icon('calendar')}<span>Meeting</span></button>
                    ${canEdit && !converted && !l.archived_at ? `<button type="button" class="ws-btn primary" id="convert-btn">${C.icon('deal')}<span>Convert lead</span></button>` : ''}
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
                                <div><dt>Name</dt><dd>${esc(l.name)}</dd></div>
                                <div><dt>Company</dt><dd>${esc(l.organization || '—')}</dd></div>
                                <div><dt>Email</dt><dd>${l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : '—'}</dd></div>
                                <div><dt>Phone</dt><dd>${l.phone ? `<a href="tel:${esc(l.phone)}">${esc(l.phone)}</a>` : '—'}</dd></div>
                                <div><dt>Source</dt><dd>${esc(l.source || '—')}${l.source_detail ? `<br><span class="muted">${esc(l.source_detail)}</span>` : ''}</dd></div>
                                <div><dt>Estimated value</dt><dd>${l.estimated_value != null ? esc(L.money(l.estimated_value, l.currency)) : '—'}</dd></div>
                                <div><dt>Status</dt><dd>${C.statusBadge(STATUS, l.status)}</dd></div>
                                <div><dt>Priority</dt><dd>${C.priorityBadge(l.priority)}</dd></div>
                                <div><dt>Owner</dt><dd>${C.personHtml(l.owner_id)}</dd></div>
                                <div><dt>Next follow-up</dt><dd>${followHtml(l)}</dd></div>
                                <div><dt>Created</dt><dd>${esc(L.fmtDateTime(l.created_at))} by ${esc(C.personName(l.created_by))}</dd></div>
                                <div><dt>Last updated</dt><dd>${esc(L.fmtDateTime(l.updated_at))}</dd></div>
                                <div><dt>Lead ID</dt><dd class="muted" style="font-size:12px">${esc(l.id)}</dd></div>
                            </dl>
                            ${l.notes ? `<div class="crm-section-title" style="margin-top:18px"><h3>Notes</h3></div><div class="crm-desc">${C.linkify(C.nl2br(l.notes))}</div>` : ''}
                        </div>
                        <div class="ws-card">
                            <div class="crm-section-title"><h3>Add a note</h3></div>
                            <div id="composer"></div>
                            <div id="recent-activity"></div>
                        </div>
                    </div>
                    <div class="ws-stack">
                        <div class="ws-card">
                            <div class="crm-section-title"><h3>Pipeline</h3></div>
                            <div class="crm-stage-track" style="flex-direction:column;gap:6px">
                                ${statuses.filter(s => !s.is_closed || s.key === l.status).map(s => { const idx = statuses.findIndex(x => x.key === s.key), cur = statuses.findIndex(x => x.key === l.status); return `<button type="button" data-status="${esc(s.key)}" class="${s.key === l.status ? (s.is_converted ? 'won' : s.key === 'unqualified' ? 'lost' : 'on') : idx < cur && !s.is_closed ? 'done' : ''}" style="border-radius:6px"${!canEdit || converted ? ' disabled' : ''}>${esc(s.label)}</button>`; }).join('')}
                            </div>
                            ${!converted && !statuses.find(s => s.key === 'unqualified' && s.key === l.status) && canEdit ? `<button type="button" class="ws-btn sm danger" id="unq-btn" style="width:100%">Mark unqualified</button>` : ''}
                        </div>
                        <div class="ws-card">
                            <div class="crm-section-title"><h3>Summary</h3></div>
                            <dl class="crm-props one">
                                <div><dt>Open tasks</dt><dd>${tasks.filter(t => !t.completed_at).length}</dd></div>
                                <div><dt>Meetings</dt><dd>${events.filter(e => e.status !== 'cancelled').length}</dd></div>
                                <div><dt>Age</dt><dd>${esc(String(L.daysBetween(L.istDate(l.created_at), L.todayIST())))} day${L.daysBetween(L.istDate(l.created_at), L.todayIST()) === 1 ? '' : 's'}</dd></div>
                            </dl>
                        </div>
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
            <section class="crm-tabpanel" data-panel="notes" hidden><div class="ws-card"><div class="crm-section-title"><h3>Notes</h3></div><div id="notes-composer"></div><div id="notes"></div></div></section>`;

        view.querySelector('[data-nav]').addEventListener('click', e => { e.preventDefault(); go('/leads/'); });
        const tabItems = [
            { key: 'overview', label: 'Overview' }, { key: 'activity', label: 'Activity' },
            { key: 'tasks', label: 'Tasks', count: tasks.filter(t => !t.completed_at).length },
            { key: 'meetings', label: 'Meetings', count: events.filter(e => e.status !== 'cancelled').length },
            { key: 'documents', label: 'Documents' }, { key: 'notes', label: 'Notes' },
        ];
        const loaded = {};
        const tabs = C.tabs(view.querySelector('#tabs'), tabItems, { hash: true, onChange: k => loadTab(k) });
        const recent = view.querySelector('#recent-activity');
        const feed = C.activityFeed(recent, { entity_type: 'lead', entity_id: id, lead_id: id, limit: 8 });
        C.comments(view.querySelector('#composer'), { entity_type: 'lead', entity_id: id, onPosted: () => { feed.reload(); if (loaded.activity) loaded.activity.reload(); if (loaded.notes) loaded.notes.reload(); } });

        const taskStatusMap = Object.fromEntries(lk.taskStatuses.map(s => [s.key, s]));
        function loadTab(k) {
            if (loaded[k]) return;
            if (k === 'activity') loaded.activity = C.activityFeed(view.querySelector('#activity'), { entity_type: 'lead', entity_id: id, lead_id: id, limit: 100 });
            if (k === 'notes') { C.comments(view.querySelector('#notes-composer'), { entity_type: 'lead', entity_id: id, onPosted: () => { loaded.notes.reload(); feed.reload(); } }); loaded.notes = C.activityFeed(view.querySelector('#notes'), { entity_type: 'lead', entity_id: id, actions: ['note.added'], limit: 100 }); }
            if (k === 'documents') loaded.documents = C.documents(view.querySelector('#documents'), { entity_type: 'lead', entity_id: id, canEdit: true });
            if (k === 'tasks') {
                loaded.tasks = true;
                C.table(view.querySelector('#tasks'), {
                    rows: tasks, onRow: t => { location.href = `/tasks/?id=${t.id}`; }, sort: { key: 'due_date', dir: 'asc' },
                    columns: [
                        { key: 'title', label: 'Task', lead: true, render: t => `<span class="primary-text">${esc(t.title)}</span>` },
                        { key: 'status', label: 'Status', render: t => C.statusBadge(taskStatusMap, t.status) },
                        { key: 'priority', label: 'Priority', render: t => C.priorityBadge(t.priority) },
                        { key: 'assignee_id', label: 'Assignee', value: t => C.personName(t.assignee_id), render: t => C.personHtml(t.assignee_id, { link: false }) },
                        { key: 'due_date', label: 'Due', render: t => C.dueHtml(t) },
                    ],
                    empty: { title: 'No tasks', sub: 'Create a follow-up task for this lead.' },
                });
            }
            if (k === 'meetings') {
                loaded.meetings = true;
                C.table(view.querySelector('#events'), {
                    rows: events, onRow: e => { location.href = `/calendar/?id=${e.id}`; }, sort: { key: 'starts_at', dir: 'desc' },
                    columns: [
                        { key: 'title', label: 'Event', lead: true, render: e => `<span class="primary-text">${esc(e.title)}</span>` },
                        { key: 'event_type', label: 'Type', render: e => C.statusBadge(L.EVENT_TYPE, e.event_type) },
                        { key: 'starts_at', label: 'When', render: e => `${esc(L.fmtDateTime(e.starts_at))}${e.status === 'cancelled' ? ' ' + C.badge('mute', 'Cancelled') : ''}` },
                        { key: 'owner_id', label: 'Organiser', value: e => C.personName(e.owner_id), render: e => C.personHtml(e.owner_id, { link: false }) },
                    ],
                    empty: { title: 'No meetings', sub: 'Schedule a meeting or call with this lead.' },
                });
            }
        }
        loadTab(tabs.active);

        const on = (sel, fn) => { const el = view.querySelector(sel); if (el) el.addEventListener('click', fn); };
        const refresh = () => showRecord(id);
        on('#edit-btn', () => openLeadEditor(l, refresh));
        on('#status-btn', e => C.menu(e.currentTarget, [...statusMenuItems(l, refresh), 'sep', { label: 'Set follow-up', icon: 'clock', onClick: () => setFollowUp(l, refresh) }]));
        on('#convert-btn', () => openConvert(l, refresh));
        on('#unq-btn', async () => { if (await C.confirm({ title: 'Mark this lead unqualified?', message: 'It leaves the open pipeline but stays on record. You can change the status back later.', okText: 'Mark unqualified', danger: true })) setLeadStatus(l, 'unqualified', refresh); });
        view.querySelectorAll('[data-status]:not([disabled])').forEach(b => b.addEventListener('click', () => { if (b.dataset.status !== l.status) setLeadStatus(l, b.dataset.status, refresh); }));
        const newTask = () => C.openTaskEditor({ defaults: { lead_id: l.id, title: '', assignee_id: l.owner_id || me.id }, onSaved: refresh });
        const newMeet = () => C.openEventEditor({ defaults: { lead_id: l.id, title: `Meeting with ${l.name}` }, onSaved: refresh });
        on('#task-btn', newTask); on('#task-btn-2', newTask); on('#meet-btn', newMeet); on('#meet-btn-2', newMeet);
        on('#more-btn', e => {
            const items = [
                { label: 'Log a call', icon: 'phone', onClick: () => logInteraction(l, 'call.logged', 'Log a call') },
                { label: 'Log an email', icon: 'mail', onClick: () => logInteraction(l, 'email.logged', 'Log an email') },
                { label: 'Log a meeting', icon: 'users', onClick: () => logInteraction(l, 'meeting.logged', 'Log a meeting') },
            ];
            if (canEdit) {
                items.push('sep');
                if (!converted) items.push({ label: 'Set follow-up', icon: 'clock', onClick: () => setFollowUp(l, refresh) });
                items.push({ label: 'Assign owner', icon: 'user', onClick: () => assignLead(l, refresh) });
                items.push(l.archived_at ? { label: 'Restore lead', icon: 'refresh', onClick: () => archiveLead(l, false, refresh) } : { label: 'Archive lead', icon: 'trash', danger: true, onClick: () => archiveLead(l, true, refresh) });
            }
            if (ctx.isManager) items.push({ label: 'Delete permanently', icon: 'trash', danger: true, onClick: () => deleteLead(l) });
            C.menu(e.currentTarget, items);
        });
    }

    async function logInteraction(l, action, title) {
        await C.formModal({
            title, fields: [
                { name: 'summary', label: 'What happened?', type: 'textarea', required: true, full: true, rows: 4 },
                { name: 'when', label: 'When', type: 'datetime', required: true, value: new Date().toISOString() },
                { name: 'follow_up', label: 'Create a follow-up task', type: 'check' },
            ],
            submitLabel: 'Log', onSubmit: async v => {
                await C.logActivity(action, 'lead', l.id, v.summary.slice(0, 200), { at: v.when, summary: v.summary }, { lead_id: l.id });
                if (l.status === 'new' && canEditLead(l)) await sb.from('crm_leads').update({ status: 'contacted' }).eq('id', l.id).eq('status', 'new');
                if (v.follow_up) await C.openTaskEditor({ defaults: { lead_id: l.id, title: `Follow up with ${l.name}` } });
                C.toast('Logged', 'ok');
                showRecord(l.id);
            },
        });
    }

    route();
})();
