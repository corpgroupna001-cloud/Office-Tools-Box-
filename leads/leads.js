/* ============================================================================
   Leads — Kanban, list and activities views with the "Filter + search" bar,
   and the lead card (a slide-over): stages, editable fields, custom fields,
   timeline, tasks, meetings, documents, and conversion into a contact +
   company + deal through crm_convert_lead().

   URLs:  /leads/                 Kanban (or the view last used)
          /leads/?view=list       list      /leads/?view=activity   open to-dos on leads
          /leads/?id=<uuid>       the lead card (also inside a slide-over)
          /leads/?new=1           opens "Create lead"
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc, B = window.WSB24;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'leads', crumb: 'Leads', layout: 'b24' });
    const sb = ctx.sb, me = ctx.user;

    const SOURCES = ['Website', 'Referral', 'Cold call', 'Email campaign', 'Social media', 'Event', 'Partner', 'Walk-in', 'Other'];
    const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED'];
    const BASE = 'id, company, name, organization, email, phone, source, source_detail, owner_id, status, estimated_value, currency, priority, notes, next_follow_up_at, tags, converted_at, converted_by, converted_contact_id, converted_deal_id, archived_at, created_by, created_at, updated_at';
    const [cols, lk, cf, lv] = await Promise.all([
        B.columns('crm_leads', BASE + ', number, company_id, custom', BASE), C.lookups(), B.customFields('lead'), B.levels('lead'),
    ]);
    const SELECT = cols.select;

    const statuses = lk.leadStatuses.length ? lk.leadStatuses : [
        { key: 'new', label: 'New', color: 'pending' }, { key: 'contacted', label: 'Contacted', color: 'late' },
        { key: 'qualified', label: 'Qualified', color: 'present' }, { key: 'unqualified', label: 'Unqualified', color: 'weekoff', is_closed: true },
        { key: 'converted', label: 'Converted', color: 'leave', is_closed: true, is_converted: true },
    ];
    const STATUS = Object.fromEntries(statuses.map(s => [s.key, { label: s.label, color: s.color || 'mute' }]));
    const openKeys = statuses.filter(s => !s.is_closed).map(s => s.key);
    const hexOf = key => { const i = statuses.findIndex(s => s.key === key); return B.hex(i >= 0 && statuses[i].color, i); };
    const stagePill = key => `<span class="b24-stage-pill" style="--c:${hexOf(key)}">${esc(STATUS[key] ? STATUS[key].label : key)}</span>`;
    const canAdd = lv.add !== 'none';
    const canEditLead = l => B.allowed(lv.edit, l, me);
    const canDeleteLead = l => B.allowed(lv.delete, l, me);
    const PRIORITIES = Object.entries(L.PRIORITY).map(([k, v]) => ({ value: k, label: v.label }));

    /* ------------------------------------------------------------ routing */
    const page = { mode: null, grid: null, board: null, filter: null };
    function route() {
        const id = C.param('id');
        if (id === 'new') return showCreate();
        if (id) return showRecord(id);
        if (page.mode === 'list') return refreshList();      // back from a slide-over: keep the list, refresh it
        return showList();
    }
    window.addEventListener('popstate', route);
    const openLead = id => B.openRecord(`/leads/?id=${id}`, refreshList);

    /* -------------------------------------------------------- follow-ups */
    function followState(l) {
        if (!l.next_follow_up_at || l.status === 'converted' || l.status === 'unqualified') return 'none';
        return L.taskDueState({ due_date: L.istDate(l.next_follow_up_at) });
    }
    function followHtml(l) {
        const st = followState(l);
        if (st === 'none') return '';
        const label = st === 'overdue' ? `Overdue · ${L.fmtDateTime(l.next_follow_up_at)}` : st === 'today' ? `Today · ${L.fmtTime(l.next_follow_up_at)}` : L.fmtDateTime(l.next_follow_up_at);
        return `<span class="crm-due ${st}">${esc(label)}</span>`;
    }

    /* --------------------------------------------------------- lead form */
    function leadFields() {
        return [
            { name: 'name', label: 'Lead name', type: 'text', required: true, full: true, placeholder: 'Person or company name' },
            { name: 'organization', label: 'Company name', type: 'text' },
            { name: 'owner_id', label: 'Responsible', type: 'people', none: 'Unassigned' },
            { name: 'email', label: 'Email', type: 'email' },
            { name: 'phone', label: 'Phone', type: 'tel' },
            { name: 'status', label: 'Stage', type: 'select', options: statuses.filter(s => !s.is_converted).map(s => ({ value: s.key, label: s.label })), required: true },
            { name: 'priority', label: 'Priority', type: 'select', options: PRIORITIES, required: true },
            { name: 'source', label: 'Source', type: 'select', options: SOURCES, placeholder: 'How did they find us?' },
            { name: 'source_detail', label: 'Source information', type: 'text', placeholder: 'e.g. Diwali campaign, LinkedIn ad' },
            { name: 'estimated_value', label: 'Amount', type: 'money' },
            { name: 'currency', label: 'Currency', type: 'select', options: CURRENCIES, required: true },
            { name: 'next_follow_up_at', label: 'Next follow-up', type: 'datetime', full: true },
            { name: 'tags', label: 'Tags', type: 'tags', full: true },
            { name: 'notes', label: 'Comment', type: 'textarea', full: true },
        ];
    }
    function cleanValues(v) {
        const out = { ...v };
        out.email = L.normalizeEmail(out.email);
        ['name', 'organization', 'phone', 'source', 'source_detail', 'notes'].forEach(k => { if (k in out) out[k] = out[k] ? String(out[k]).trim() || null : null; });
        if ('owner_id' in out) out.owner_id = out.owner_id || null;
        if ('tags' in out) out.tags = out.tags || [];
        if ('estimated_value' in out) out.estimated_value = out.estimated_value == null ? null : Number(out.estimated_value);
        if ('next_follow_up_at' in out) out.next_follow_up_at = out.next_follow_up_at || null;
        return out;
    }
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
                    { label: 'Open existing', onClick: api => { api.close(); resolve(false); if (contacts[0]) B.openRecord(`/contacts/?id=${contacts[0].id}`); else openLead(leads[0].id); } },
                    { label: 'Cancel', close: true },
                    { label: 'Save anyway', primary: true, onClick: api => { api.close(); resolve(true); } },
                ],
                onClose: () => resolve(false),
            });
        });
    }
    async function openLeadEditor(defaults, onSaved) {
        return C.formModal({
            title: 'New lead', size: 'wide', fields: leadFields(),
            values: { status: openKeys[0] || 'new', priority: 'normal', owner_id: me.id, currency: 'INR', ...(defaults || {}) },
            submitLabel: 'Create lead',
            onSubmit: async (v, api) => {
                const values = cleanValues(v);
                api.close();
                if (!await duplicateCheck(values, null)) return null;
                try {
                    const saved = (await C.q(sb.from('crm_leads').insert({ ...values, created_by: me.id }).select(SELECT).single())).data;
                    if (saved.owner_id && saved.owner_id !== me.id) C.pushNotify({ to: saved.owner_id, title: 'Lead assigned to you', body: saved.name, url: `/leads/?id=${saved.id}`, tag: 'crm' });
                    C.toast('Lead created', 'ok');
                    if (onSaved) onSaved(saved);
                    return saved;
                } catch (e) { C.toast(e.message, 'bad'); return null; }
            },
        });
    }
    async function updateLead(l, patch) {
        const values = cleanValues(patch);
        if ('name' in values && !values.name) throw new Error('The lead needs a name.');
        const saved = (await C.q(sb.from('crm_leads').update(values).eq('id', l.id).select(SELECT).single())).data;
        if ('owner_id' in values && saved.owner_id && saved.owner_id !== me.id && saved.owner_id !== l.owner_id) C.pushNotify({ to: saved.owner_id, title: 'Lead assigned to you', body: saved.name, url: `/leads/?id=${saved.id}`, tag: 'crm' });
        Object.assign(l, saved);
        if (window.WSShell && WSShell.inSlider) WSShell.sliderMessage('changed', { id: l.id });
        return saved;
    }

    /* --------------------------------------------------- small actions */
    async function setLeadStatus(l, status) {
        if (status === l.status) return;
        await updateLead(l, { status });
        C.toast(`Moved to ${STATUS[status] ? STATUS[status].label : status}`, 'ok');
    }
    async function setFollowUp(l, after) {
        await C.formModal({
            title: 'Set follow-up', fields: [{ name: 'when', label: 'Follow up on', type: 'datetime', required: true, full: true }, { name: 'task', label: 'Also create a to-do for the responsible person', type: 'check', full: true }],
            values: { when: l.next_follow_up_at || (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); return d.toISOString(); })(), task: false },
            submitLabel: 'Save', onSubmit: async v => {
                await updateLead(l, { next_follow_up_at: v.when });
                await C.logActivity('lead.follow_up_set', 'lead', l.id, l.name, { at: v.when }, { lead_id: l.id });
                if (v.task) await C.openTaskEditor({ defaults: { lead_id: l.id, title: `Follow up with ${l.name}`, assignee_id: l.owner_id || me.id, due_date: L.istDate(v.when) } });
                C.toast('Follow-up set', 'ok'); if (after) after();
            },
        });
    }
    async function archiveLead(l, archive, after) {
        if (archive && !await C.confirm({ title: `Archive ${l.name}?`, message: 'The lead is hidden from lists but keeps its history, tasks and notes. You can restore it later.', okText: 'Archive', danger: true })) return;
        try { await updateLead(l, { archived_at: archive ? new Date().toISOString() : null }); C.toast(archive ? 'Lead archived' : 'Lead restored', 'ok'); if (after) after(); }
        catch (e) { C.toast(e.message, 'bad'); }
    }
    async function deleteLead(l, after) {
        if (!await C.confirm({ title: 'Delete this lead permanently?', message: 'Its history and notes go with it. Archiving is usually the better choice.', okText: 'Delete permanently', danger: true })) return;
        try {
            await C.q(sb.from('crm_leads').delete().eq('id', l.id));
            C.toast('Lead deleted', 'ok');
            if (window.WSShell && WSShell.inSlider) { WSShell.sliderMessage('deleted', { id: l.id }); WSShell.closeSlider(); }
            else if (after) after(); else location.href = '/leads/';
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function logInteraction(l, action, title, after) {
        await C.formModal({
            title, fields: [
                { name: 'summary', label: 'What happened?', type: 'textarea', required: true, full: true, rows: 4 },
                { name: 'when', label: 'When', type: 'datetime', required: true, value: new Date().toISOString() },
                { name: 'follow_up', label: 'Create a follow-up to-do', type: 'check' },
            ],
            submitLabel: 'Save', onSubmit: async v => {
                await C.logActivity(action, 'lead', l.id, v.summary.slice(0, 200), { at: v.when, summary: v.summary }, { lead_id: l.id });
                if (l.status === 'new' && canEditLead(l)) await sb.from('crm_leads').update({ status: 'contacted' }).eq('id', l.id).eq('status', 'new');
                if (v.follow_up) await C.openTaskEditor({ defaults: { lead_id: l.id, title: `Follow up with ${l.name}` } });
                C.toast('Saved', 'ok');
                if (after) after();
            },
        });
    }

    /* ----------------------------------------------------------- convert */
    async function openConvert(l, onDone) {
        if (l.status === 'converted') return;
        const { contacts: candidates } = await findCandidates({ email: l.email, phone: l.phone }, l.id);
        const pipelines = lk.pipelines;
        if (!pipelines.length) { await C.alert({ title: 'No pipeline yet', message: 'Ask a manager to set up a sales pipeline in Deals before converting leads with a deal.' }); return; }
        const pipeline = lk.defaultPipeline || pipelines[0];
        const openStages = pid => L.stagesOf(lk.stages, pid).filter(s => !s.is_won && !s.is_lost);
        const plan = L.planLeadConversion(l, candidates);
        const fields = [
            { name: 'contact_mode', label: 'Contact', type: 'select', full: true, required: true, options: [
                ...(candidates.length ? [{ value: 'link', label: `Link to existing: ${candidates[0].full_name || candidates[0].organization}${candidates.length > 1 ? ` (+${candidates.length - 1} more match)` : ''}` }] : []),
                { value: 'create', label: `Create a new contact "${l.name}"` },
                { value: 'pick', label: 'Choose another existing contact…' },
            ] },
            { name: 'contact_id', label: 'Existing contact', type: 'entity', entity: 'contact', full: true, placeholder: 'Search contacts' },
            ...(cols.full && l.organization ? [{ name: 'create_company', label: `Link or create the company "${l.organization}"`, type: 'check', full: true }] : []),
            { name: 'create_deal', label: 'Also create a deal', type: 'check', full: true },
            { name: 'deal_title', label: 'Deal name', type: 'text', full: true },
            { name: 'deal_value', label: 'Amount', type: 'money' },
            { name: 'pipeline_id', label: 'Pipeline', type: 'select', options: pipelines.map(p => ({ value: p.id, label: p.name })) },
            { name: 'stage_id', label: 'Stage', type: 'select', options: openStages(pipeline.id).map(s => ({ value: s.id, label: s.name })) },
            { name: 'expected_close', label: 'Expected close', type: 'date' },
        ];
        const values = {
            contact_mode: candidates.length ? 'link' : 'create', contact_id: '', create_deal: true, create_company: true,
            deal_title: plan.deal ? plan.deal.title : `${l.name} deal`, deal_value: plan.deal ? plan.deal.value : (Number(l.estimated_value) || 0),
            pipeline_id: pipeline.id, stage_id: (openStages(pipeline.id)[0] || {}).id || '',
        };
        return C.formModal({
            title: `Convert ${l.name}`, size: 'wide', fields, values, submitLabel: 'Convert lead',
            intro: '<div class="crm-info" id="cv-preview"></div>',
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
                    previewEl.innerHTML = `Converting will ${contactText}${dealText}. The lead stays on record as <b>Converted</b> with links to what it became.`;
                }
                [mode.el, deal.el].forEach(el => el.addEventListener('change', sync));
                ['deal_title', 'deal_value'].forEach(n => f.field(n).el.addEventListener('input', sync));
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
                const args = {
                    p_lead_id: l.id, p_contact_id: contactId, p_create_deal: !!v.create_deal,
                    p_deal_title: v.create_deal ? (v.deal_title || null) : null, p_deal_value: v.create_deal ? (v.deal_value == null ? null : Number(v.deal_value)) : null,
                    p_pipeline_id: v.create_deal ? v.pipeline_id : null, p_stage_id: v.create_deal ? v.stage_id : null, p_expected_close: v.create_deal ? (v.expected_close || null) : null,
                };
                if (cols.full) args.p_create_company = v.create_company !== false;
                const r = await sb.rpc('crm_convert_lead', args);
                if (r.error) throw new Error(C.friendly(r.error));
                const out = r.data || {};
                if (l.owner_id && l.owner_id !== me.id) C.pushNotify({ to: l.owner_id, title: 'Lead converted', body: l.name, url: `/leads/?id=${l.id}`, tag: 'crm' });
                C.toast('Lead converted', 'ok');
                if (window.WSShell && WSShell.inSlider) WSShell.sliderMessage('changed', { id: l.id });
                C.modal({
                    title: 'Converted', body: `<p style="margin:0 0 12px">${esc(l.name)} is now ${out.existing_contact ? 'linked to an existing contact' : 'a contact'}${out.company_id ? ' with a company' : ''}${out.deal_id ? ' and a new deal' : ''}.</p>
                        <div style="display:flex;gap:8px;flex-wrap:wrap">${out.contact_id ? C.entityChip('contact', out.contact_id, 'Open contact') : ''}${out.deal_id ? C.entityChip('deal', out.deal_id, 'Open deal') : ''}</div>`,
                    actions: [{ label: 'Done', primary: true, close: true }],
                    onClose: () => { if (onDone) onDone(out); },
                });
                return out;
            },
        });
    }

    /* ------------------------------------------------------ list page */
    function filterFields() {
        return [
            { key: 'status', title: 'Stage', type: 'multiselect', options: statuses.map(s => ({ value: s.key, label: s.label })) },
            { key: 'owner', title: 'Responsible', type: 'user', column: 'owner_id', options: B.peopleOptions() },
            { key: 'source', title: 'Source', type: 'select', options: SOURCES },
            { key: 'created', title: 'Created', type: 'date', column: 'created_at', datetime: true },
            { key: 'follow', title: 'Follow-up', type: 'date', column: 'next_follow_up_at', datetime: true },
            { key: 'priority', title: 'Priority', type: 'select', options: PRIORITIES, default: false },
            { key: 'value', title: 'Amount', type: 'number', column: 'estimated_value', default: false },
            { key: 'organization', title: 'Company name', type: 'text', default: false },
            { key: 'email', title: 'Email', type: 'text', default: false },
            { key: 'phone', title: 'Phone', type: 'text', default: false },
            { key: 'tag', title: 'Tag', type: 'text', default: false, apply: (b, v) => b.contains('tags', [String(v).trim()]) },
            { key: 'archived', title: 'Archived', type: 'check', checkLabel: 'Only archived leads', default: false, apply: b => b },
            ...B.cfFilters(cf),
        ];
    }
    const PRESETS = [
        { key: 'open', title: 'Leads in progress', values: { status: openKeys } },
        { key: 'mine', title: 'My leads', values: { owner: 'me', status: openKeys } },
        { key: 'converted', title: 'Converted leads', values: { status: ['converted'] } },
        { key: 'junk', title: 'Unqualified leads', values: { status: statuses.filter(s => s.is_closed && !s.is_converted).map(s => s.key) } },
        { key: 'all', title: 'All leads', values: {} },
        { key: 'archived', title: 'Archived leads', values: { archived: true } },
    ];
    /** The list query with the filter, search and archive rule applied. */
    function scoped(builder) {
        const v = page.filter.get().values;
        builder = v.archived ? builder.not('archived_at', 'is', null) : builder.is('archived_at', null);
        return page.filter.apply(builder, { searchColumns: ['name', 'organization', 'email', 'phone'] });
    }
    function readView() { const v = C.param('view'); if (['kanban', 'list', 'activity'].includes(v)) return v; try { return localStorage.getItem('ws-leads-view') || 'kanban'; } catch (e) { return 'kanban'; } }

    async function showList() {
        page.mode = 'list';
        WSShell.setCrumb('Leads');
        document.title = 'Leads · WorkSuite';
        const current = readView();
        view.innerHTML = B.titleBar({ title: 'Leads', createLabel: canAdd ? 'Create' : '' }) + `
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
            id: 'leads', fields: filterFields(), presets: PRESETS, defaultPreset: 'open', me: me.id,
            placeholder: 'Filter + search', onChange: () => refreshList(),
        });
        const create = view.querySelector('[data-create]');
        if (create) create.addEventListener('click', () => B.openRecord('/leads/?id=new', refreshList));
        view.querySelector('.b24-views').addEventListener('click', e => {
            const b = e.target.closest('[data-view]'); if (!b) return;
            try { localStorage.setItem('ws-leads-view', b.dataset.view); } catch (err) { /* private mode */ }
            C.setParam('view', b.dataset.view === 'kanban' ? null : b.dataset.view, true);
            mountView(b.dataset.view);
        });
        view.querySelector('#counters').addEventListener('click', e => {
            const b = e.target.closest('[data-counter]'); if (!b) return;
            const f = { overdue: { owner: 'me', status: openKeys, follow: { kind: 'before_today' } }, today: { owner: 'me', status: openKeys, follow: { kind: 'today' } }, unassigned: { owner: 'none', status: openKeys } }[b.dataset.counter];
            page.filter.set(f);
        });
        mountView(current);
        loadCounters();
        if (C.param('new') === '1' && canAdd) { C.setParam('new', null, true); B.openRecord('/leads/?id=new', refreshList); }
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
    function refreshList() {
        if (page.mode !== 'list') return;
        loadCounters();
        if (page.grid) return page.grid.reload();
        if (page.view === 'kanban') return loadKanban();
    }
    async function loadCounters() {
        const el = view.querySelector('#counters'); if (!el) return;
        const today = L.todayIST(), tomorrow = WSFilter.dateRange({ kind: 'tomorrow' }).from;
        const head = () => sb.from('crm_leads').select('id', { count: 'exact', head: true }).is('archived_at', null).in('status', openKeys);
        try {
            const [o, t, u] = await Promise.all([
                head().eq('owner_id', me.id).lt('next_follow_up_at', `${today}T00:00:00+05:30`),
                head().eq('owner_id', me.id).gte('next_follow_up_at', `${today}T00:00:00+05:30`).lt('next_follow_up_at', `${tomorrow}T00:00:00+05:30`),
                head().is('owner_id', null),
            ]);
            const n = r => (r && !r.error && r.count) || 0;
            el.innerHTML = `<span>My items:</span>
                <button type="button" class="b24-counter${n(o) ? ' red' : ''}" data-counter="overdue"><span class="n">${n(o)}</span>Overdue</button>
                <button type="button" class="b24-counter${n(t) ? ' green' : ''}" data-counter="today"><span class="n">${n(t)}</span>Due today</button>
                <button type="button" class="b24-counter" data-counter="unassigned"><span class="n">${n(u)}</span>Not assigned</button>`;
        } catch (e) { el.innerHTML = ''; }
    }

    /* ----- Kanban ----- */
    function kanbanColumns(rows) {
        const chosen = page.filter.get().values.status;
        const keys = chosen && chosen.length ? statuses.filter(s => chosen.includes(s.key)).map(s => s.key) : openKeys;
        return statuses.filter(s => keys.includes(s.key)).map(s => {
            const inCol = rows.filter(r => r.status === s.key);
            const sum = inCol.reduce((a, r) => a + (Number(r.estimated_value) || 0), 0);
            return { id: s.key, name: s.label, hex: hexOf(s.key), sum: L.money(sum, 'INR') };
        });
    }
    function kanbanCard(c) {
        const l = c.lead;
        return `<div class="b24-kcard">
            <a class="t" href="/leads/?id=${esc(l.id)}" data-open>${esc(l.name)}</a>
            ${l.organization ? `<div class="org">${esc(l.organization)}</div>` : ''}
            ${l.estimated_value != null ? `<div class="amt">${esc(L.money(l.estimated_value, l.currency))}</div>` : ''}
            <div class="meta">${C.avatarHtml(l.owner_id || { name: '?' }, 'sm')}<span class="when">${followHtml(l) || `<span class="muted">${esc(L.fmtRelative(l.created_at))}</span>`}</span></div>
        </div>`;
    }
    async function mountKanban(body) {
        body.innerHTML = '<div class="b24-board-area"><div id="kb"></div></div>';
        page.board = WSKanban.mount(body.querySelector('#kb'), {
            columns: [], cards: [], emptyText: 'Drop leads here',
            renderCard: kanbanCard,
            canDrag: c => canEditLead(c.lead) && c.lead.status !== 'converted',
            onCardClick: (c, e) => { if (e) e.preventDefault(); openLead(c.lead.id); },
            onAddCard: canAdd ? status => openLeadEditor({ status }, l => { loadKanban(); openLead(l.id); }) : null,
            onMove: async ({ card, toColumnId }) => {
                if (toColumnId === card.lead.status) return;
                if (toColumnId === 'converted') {
                    const out = await openConvert(card.lead, () => loadKanban());
                    if (!out || out === true) throw new Error('Conversion cancelled');
                    return;
                }
                await setLeadStatus(card.lead, toColumnId);
                loadCounters();
            },
        });
        await loadKanban();
    }
    async function loadKanban() {
        if (!page.board) return;
        try {
            const { data } = await C.q(scoped(sb.from('crm_leads').select(SELECT)).order('updated_at', { ascending: false }).limit(500));
            const rows = data || [];
            page.board.update({
                columns: kanbanColumns(rows),
                cards: rows.map((l, i) => ({ id: l.id, columnId: l.status, position: i, lead: l })),
            });
            const total = rows.reduce((a, r) => a + (Number(r.estimated_value) || 0), 0);
            view.querySelector('#sum').innerHTML = `${rows.length}${rows.length >= 500 ? '+' : ''} leads · <b>${esc(L.money(total, 'INR'))}</b>`;
        } catch (e) { C.errorState(view.querySelector('#kb'), e, loadKanban); }
    }

    /* ----- List ----- */
    function gridColumns() {
        const people = [{ value: '', label: 'Not assigned' }].concat(B.peopleOptions());
        const editable = (spec) => (lv.edit !== 'none' ? spec : undefined);
        const save = key => async (r, v) => { if (!canEditLead(r)) throw new Error('You do not have permission to change this lead.'); await updateLead(r, { [key]: v }); };
        return [
            ...(cols.full ? [{ key: 'number', title: 'ID', width: 70, render: r => esc(r.number == null ? '' : r.number) }] : []),
            { key: 'name', title: 'Lead', width: 250, render: r => `<a href="/leads/?id=${esc(r.id)}" data-open>${esc(r.name)}</a>${r.organization ? `<span class="sub">${esc(r.organization)}</span>` : ''}`, edit: editable({ type: 'text', save: save('name') }) },
            { key: 'status', title: 'Stage', width: 160, render: r => stagePill(r.status), edit: editable({ type: 'select', options: statuses.filter(s => !s.is_converted).map(s => ({ value: s.key, label: s.label })), save: save('status') }) },
            { key: 'owner_id', title: 'Responsible', width: 180, render: r => C.personHtml(r.owner_id, { link: false }), edit: editable({ type: 'people', options: people, save: save('owner_id') }) },
            { key: 'estimated_value', title: 'Amount', width: 130, align: 'right', render: r => r.estimated_value != null ? esc(L.money(r.estimated_value, r.currency)) : '', edit: editable({ type: 'money', save: save('estimated_value') }) },
            { key: 'next_follow_up_at', title: 'Follow-up', width: 170, render: r => followHtml(r) },
            { key: 'source', title: 'Source', width: 130, render: r => esc(r.source || ''), edit: editable({ type: 'select', options: [{ value: '', label: '—' }].concat(SOURCES), save: save('source') }) },
            { key: 'phone', title: 'Phone', width: 150, render: r => r.phone ? `<a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>` : '', edit: editable({ type: 'text', save: save('phone') }) },
            { key: 'email', title: 'Email', width: 200, render: r => r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : '', edit: editable({ type: 'text', save: save('email') }) },
            { key: 'created_at', title: 'Created', width: 120, render: r => `<span class="muted">${esc(L.fmtDate(r.created_at, { short: true }))}</span>` },
            { key: 'priority', title: 'Priority', width: 110, default: false, render: r => C.priorityBadge(r.priority) },
            { key: 'organization', title: 'Company name', width: 180, default: false, render: r => esc(r.organization || '') },
            { key: 'updated_at', title: 'Modified', width: 120, default: false, render: r => `<span class="muted">${esc(L.fmtRelative(r.updated_at))}</span>` },
            { key: 'created_by', title: 'Created by', width: 170, default: false, sortable: false, render: r => C.personHtml(r.created_by, { link: false }) },
            { key: 'tags', title: 'Tags', width: 160, default: false, sortable: false, render: r => C.tagsHtml(r.tags) },
            ...B.cfColumns(cf),
        ];
    }
    function mountGrid(body) {
        const host = document.createElement('div');
        body.appendChild(host);
        const bulk = [];
        if (lv.edit !== 'none') {
            bulk.push({ label: 'Assign responsible', icon: 'user', run: async (ids, o) => {
                const v = await B.pick('Assign responsible', { type: 'people', label: 'Responsible', none: 'Not assigned' }, '');
                if (v === undefined) return false;
                await bulkUpdate(ids, o, { owner_id: v || null });
                if (v && v !== me.id) C.pushNotify({ to: v, title: o.all ? 'Leads assigned to you' : `${ids.length} lead${ids.length > 1 ? 's' : ''} assigned to you`, body: '', url: '/leads/', tag: 'crm' });
            } });
            bulk.push({ label: 'Change stage', icon: 'check', run: async (ids, o) => {
                const v = await B.pick('Change stage', { type: 'select', label: 'Stage', required: true, options: statuses.filter(s => !s.is_converted).map(s => ({ value: s.key, label: s.label })) }, openKeys[0]);
                if (!v) return false;
                await bulkUpdate(ids, o, { status: v }, b => b.neq('status', 'converted'));
            } });
            bulk.push({ label: 'Archive', icon: 'trash', run: async (ids, o) => {
                if (!await C.confirm({ title: o.all ? 'Archive every lead in this filter?' : `Archive ${ids.length} lead${ids.length > 1 ? 's' : ''}?`, message: 'Archived leads are hidden from lists but keep their history. You can restore them later.', okText: 'Archive', danger: true })) return false;
                await bulkUpdate(ids, o, { archived_at: new Date().toISOString() });
            } });
        }
        if (lv.delete !== 'none') {
            bulk.push({ label: 'Delete', icon: 'trash', danger: true, run: async (ids, o) => {
                if (!await C.confirm({ title: o.all ? 'Delete every lead in this filter?' : `Delete ${ids.length} lead${ids.length > 1 ? 's' : ''} permanently?`, message: 'Their history and notes go with them.', okText: 'Delete permanently', danger: true })) return false;
                let b = sb.from('crm_leads').delete();
                b = o.all ? scoped(b) : b.in('id', ids);
                await C.q(b);
                C.toast('Deleted', 'ok');
            } });
        }
        page.grid = WSGrid.mount(host, {
            id: 'leads', columns: gridColumns(), sort: { key: 'updated_at', dir: 'desc' }, perPage: 20,
            load: async ({ offset, limit, sort }) => {
                let b = scoped(sb.from('crm_leads').select(SELECT));
                b = sort ? b.order(sort.key, { ascending: sort.dir === 'asc', nullsFirst: false }) : b.order('updated_at', { ascending: false });
                return (await C.q(b.range(offset, offset + limit - 1))).data || [];
            },
            count: async () => (await C.q(scoped(sb.from('crm_leads').select('id', { count: 'exact', head: true })))).count || 0,
            onOpen: r => openLead(r.id),
            rowMenu: r => {
                const edit = canEditLead(r), items = [{ label: 'Open', icon: 'arrow', onClick: () => openLead(r.id) }];
                if (edit && r.status !== 'converted' && !r.archived_at) items.push({ label: 'Convert', icon: 'deal', onClick: () => openConvert(r, refreshList) });
                if (edit && r.status !== 'converted') items.push({ label: 'Set follow-up', icon: 'clock', onClick: () => setFollowUp(r, refreshList) });
                items.push({ label: 'Add to-do', icon: 'tasks', onClick: () => C.openTaskEditor({ defaults: { lead_id: r.id, title: `Follow up with ${r.name}`, assignee_id: r.owner_id || me.id }, onSaved: refreshList }) });
                if (edit) { items.push('sep'); items.push(r.archived_at ? { label: 'Restore', icon: 'refresh', onClick: () => archiveLead(r, false, refreshList) } : { label: 'Archive', icon: 'trash', onClick: () => archiveLead(r, true, refreshList) }); }
                if (canDeleteLead(r)) items.push({ label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteLead(r, refreshList) });
                return items;
            },
            bulk,
            empty: { title: 'No leads match this filter', sub: 'Change the filter or create a lead.', action: canAdd ? '<button type="button" class="b24-btn-create" onclick="document.querySelector(\'[data-create]\').click()">Create</button>' : '' },
        });
    }
    async function bulkUpdate(ids, o, patch, extra) {
        let b = sb.from('crm_leads').update(patch);
        b = o.all ? scoped(b) : b.in('id', ids);
        if (extra) b = extra(b);
        await C.q(b);
        C.toast('Updated', 'ok');
        loadCounters();
    }

    /* ----- Activities: open to-dos on leads ----- */
    function mountActivities(body) {
        const host = document.createElement('div');
        body.appendChild(host);
        const names = new Map();
        const taskStatus = lk.taskStatus || {};
        page.grid = WSGrid.mount(host, {
            id: 'leads-activity', sort: { key: 'due_date', dir: 'asc' },
            columns: [
                { key: 'title', title: 'To-do', width: 280, render: t => `<a href="/tasks/?id=${esc(t.id)}" data-task="${esc(t.id)}">${esc(t.title)}</a>` },
                { key: 'lead_id', title: 'Lead', width: 220, sortable: false, render: t => `<a href="/leads/?id=${esc(t.lead_id)}" data-lead="${esc(t.lead_id)}">${esc(names.get(t.lead_id) || 'Lead')}</a>` },
                { key: 'due_date', title: 'Deadline', width: 150, render: t => C.dueHtml(t) },
                { key: 'assignee_id', title: 'Responsible', width: 180, render: t => C.personHtml(t.assignee_id, { link: false }) },
                { key: 'status', title: 'Status', width: 140, render: t => C.statusBadge(taskStatus, t.status) },
                { key: 'created_at', title: 'Created', width: 120, default: false, render: t => esc(L.fmtDate(t.created_at, { short: true })) },
            ],
            load: async ({ offset, limit, sort }) => {
                let b = sb.from('tasks').select('id, title, status, priority, assignee_id, due_date, completed_at, lead_id, created_at')
                    .not('lead_id', 'is', null).is('completed_at', null).is('archived_at', null);
                const v = page.filter.get().values;
                if (v.owner === 'me') b = b.eq('assignee_id', me.id); else if (v.owner && v.owner !== 'none') b = b.eq('assignee_id', v.owner);
                b = sort ? b.order(sort.key, { ascending: sort.dir === 'asc', nullsFirst: false }) : b.order('due_date', { ascending: true, nullsFirst: false });
                const rows = (await C.q(b.range(offset, offset + limit - 1))).data || [];
                const missing = [...new Set(rows.map(t => t.lead_id))].filter(id => !names.has(id));
                if (missing.length) { const r = await sb.from('crm_leads').select('id, name').in('id', missing); (r.data || []).forEach(x => names.set(x.id, x.name)); }
                return rows;
            },
            empty: { title: 'No open to-dos on leads', sub: 'To-dos created from a lead card show up here.' },
        });
        host.addEventListener('click', e => {
            const t = e.target.closest('[data-task]'); if (t) { e.preventDefault(); B.openRecord(`/tasks/?id=${t.dataset.task}`, refreshList); return; }
            const l = e.target.closest('[data-lead]'); if (l) { e.preventDefault(); openLead(l.dataset.lead); }
        });
    }
    // Title links inside the list and board open the card as a slide-over.
    view.addEventListener('click', e => {
        const a = e.target.closest('a[data-open]');
        if (!a || e.metaKey || e.ctrlKey || e.shiftKey || page.mode !== 'list') return;
        e.preventDefault();
        const id = new URL(a.href, location.href).searchParams.get('id');
        if (id) openLead(id);
    });

    /* ------------------------------------------------------------- card */
    /* ---------------------------------------------- new lead (Bitrix24-style create page) */
    async function showCreate() {
        page.mode = 'create';
        if (page.grid) { page.grid.destroy(); page.grid = null; }
        if (page.board) { page.board.destroy(); page.board = null; }
        document.title = 'New lead · WorkSuite';
        WSShell.setCrumb('New lead');
        C.loading(view, 'Opening…');
        const cf = cols.full ? await B.customFields('lead') : [];
        const stageList = statuses.filter(s => !s.is_closed && !s.is_converted).map(s => ({ key: s.key, title: s.label, hex: hexOf(s.key) }));
        const info = [
            { name: 'name', label: 'Lead name', type: 'text', required: true, full: true, placeholder: 'Lead #' },
            { name: 'source', label: 'Source', type: 'select', options: SOURCES, placeholder: 'Not selected' },
            { name: 'owner_id', label: 'Responsible', type: 'people', none: 'Unassigned' },
            { name: 'organization', label: 'Company name', type: 'text' },
            ...(cols.full ? [{ name: 'company_id', label: 'Company', type: 'entity', entity: 'company', placeholder: 'Company name, phone or email' }] : []),
            { name: 'phone', label: 'Phone', type: 'tel' },
            { name: 'email', label: 'E-mail', type: 'email' },
            { name: 'estimated_value', label: 'Amount', type: 'money' },
            { name: 'currency', label: 'Currency', type: 'select', options: CURRENCIES, required: true },
            { name: 'priority', label: 'Priority', type: 'select', options: PRIORITIES, required: true },
            { name: 'source_detail', label: 'Source information', type: 'text', optional: true, placeholder: 'e.g. Diwali campaign, LinkedIn ad' },
            { name: 'next_follow_up_at', label: 'Next follow-up', type: 'datetime', optional: true, full: true },
            { name: 'tags', label: 'Tags', type: 'tags', optional: true, full: true },
            { name: 'notes', label: 'Comment', type: 'textarea', full: true },
        ];
        const sections = [{ title: 'Lead information', fields: info }];
        if (cf.length) sections.push({ title: 'More about the lead', fields: B.cfFormFields(cf) });
        view.innerHTML = '<div class="b24-new-host"></div>';
        WSCreate.mount(view.firstElementChild, {
            title: 'New lead', entity: 'lead', sections,
            stages: stageList, stage: (stageList.find(s => s.key === C.param('status')) || stageList[0] || {}).key, stageField: 'status',
            values: { priority: 'normal', owner_id: me.id, currency: 'INR' },
            note: 'You are now adding a lead…',
            createFieldHref: ctx.isManager && cols.full ? B.fieldsSettingsUrl('lead') : null,
            onSave: async v => {
                const { values, custom } = B.splitCustom(v, cf);
                const row = cleanValues(values);
                if (!cols.full) delete row.company_id;
                if (!await duplicateCheck(row, null)) throw Object.assign(new Error('Not saved'), { silent: true });
                const saved = (await C.q(sb.from('crm_leads').insert({ ...row, ...(cf.length ? { custom } : {}), created_by: me.id }).select(SELECT).single())).data;
                if (saved.owner_id && saved.owner_id !== me.id) C.pushNotify({ to: saved.owner_id, title: 'Lead assigned to you', body: saved.name, url: `/leads/?id=${saved.id}`, tag: 'crm' });
                C.toast('Lead created', 'ok');
                B.afterCreate('/leads/', saved.id);
            },
            onCancel: () => B.leaveCreate('/leads/'),
        }).focus();
    }

    async function showRecord(id) {
        page.mode = 'record';
        if (page.grid) { page.grid.destroy(); page.grid = null; }
        if (page.board) { page.board.destroy(); page.board = null; }
        C.loading(view, 'Loading lead…');
        let l;
        try { l = (await C.q(sb.from('crm_leads').select(SELECT).eq('id', id).maybeSingle())).data; }
        catch (e) { return C.errorState(view, e, () => showRecord(id)); }
        if (!l) { view.innerHTML = '<div class="b24-area pad"></div>'; C.empty(view.firstElementChild, 'Lead not found', 'It may have been deleted, or you may not have access to it.', '<a class="ws-btn" href="/leads/">All leads</a>'); return; }
        document.title = `${l.name} · Leads · WorkSuite`;
        WSShell.setCrumb(l.name);
        const [tasks, events, contact, deal] = await Promise.all([
            C.related('tasks', 'lead_id', id, 'id, title, status, priority, assignee_id, due_date, completed_at, archived_at, created_at', b => b.is('archived_at', null)),
            C.related('calendar_events', 'lead_id', id, 'id, title, starts_at, ends_at, event_type, status, owner_id', b => b.order('starts_at', { ascending: false })),
            l.converted_contact_id ? C.related('crm_contacts', 'id', l.converted_contact_id, 'id, full_name, organization') : Promise.resolve([]),
            l.converted_deal_id ? C.related('crm_deals', 'id', l.converted_deal_id, 'id, title, value, currency, status') : Promise.resolve([]),
        ]);
        const refresh = () => showRecord(id);
        const edit = canEditLead(l), converted = l.status === 'converted';
        const save = key => async v => { await updateLead(l, { [key]: v }); };
        const newTask = () => C.openTaskEditor({ defaults: { lead_id: l.id, title: '', assignee_id: l.owner_id || me.id }, onSaved: refresh });
        const newMeet = () => C.openEventEditor({ defaults: { lead_id: l.id, title: `Meeting with ${l.name}` }, onSaved: refresh });
        const taskStatusMap = lk.taskStatus || {};
        const subtitle = [
            l.archived_at ? C.badge('mute', 'Archived') : '',
            converted ? `Converted ${esc(L.fmtDateTime(l.converted_at))} by ${esc(C.personName(l.converted_by))} → ${contact[0] ? C.entityChip('contact', contact[0].id, contact[0].full_name || contact[0].organization) : ''} ${deal[0] ? C.entityChip('deal', deal[0].id, `${deal[0].title} · ${L.money(deal[0].value, deal[0].currency)}`) : ''}` : '',
        ].filter(Boolean).join(' ');

        const menu = [
            { label: 'Log a call', icon: 'phone', onClick: () => logInteraction(l, 'call.logged', 'Log a call', refresh) },
            { label: 'Log an email', icon: 'mail', onClick: () => logInteraction(l, 'email.logged', 'Log an email', refresh) },
        ];
        if (edit) {
            menu.push('sep');
            if (!converted) menu.push({ label: 'Set follow-up', icon: 'clock', onClick: () => setFollowUp(l, refresh) });
            menu.push(l.archived_at ? { label: 'Restore lead', icon: 'refresh', onClick: () => archiveLead(l, false, refresh) } : { label: 'Archive lead', icon: 'trash', onClick: () => archiveLead(l, true, refresh) });
        }
        if (canDeleteLead(l)) menu.push({ label: 'Delete permanently', icon: 'trash', danger: true, onClick: () => deleteLead(l) });
        if (window.WSShell && WSShell.inSlider) menu.push('sep', { label: 'Open as a page', icon: 'link', onClick: () => { window.top.location.href = `/leads/?id=${l.id}`; } });

        const sections = [
            { title: 'About lead', fields: [
                { key: 'name', title: 'Lead name', type: 'text', value: l.name, required: true, save: save('name') },
                { key: 'organization', title: 'Company name', type: 'text', value: l.organization, save: save('organization') },
                { key: 'estimated_value', title: 'Amount', type: 'money', value: l.estimated_value, display: v => v == null ? '' : esc(L.money(v, l.currency)), save: save('estimated_value') },
                { key: 'currency', title: 'Currency', type: 'select', options: CURRENCIES, value: l.currency, save: save('currency') },
                { key: 'source', title: 'Source', type: 'select', options: SOURCES, value: l.source, save: save('source') },
                { key: 'source_detail', title: 'Source information', type: 'text', value: l.source_detail, save: save('source_detail') },
                { key: 'priority', title: 'Priority', type: 'select', options: PRIORITIES, value: l.priority, display: v => C.priorityBadge(v), save: save('priority') },
                { key: 'next_follow_up_at', title: 'Next follow-up', type: 'datetime', value: l.next_follow_up_at, display: () => followHtml(l) || (l.next_follow_up_at ? esc(L.fmtDateTime(l.next_follow_up_at)) : ''), save: save('next_follow_up_at') },
                { key: 'tags', title: 'Tags', type: 'tags', value: l.tags, save: save('tags') },
            ] },
            { title: 'Contact information', fields: [
                { key: 'phone', title: 'Phone', type: 'tel', value: l.phone, save: save('phone') },
                { key: 'email', title: 'Email', type: 'email', value: l.email, save: save('email') },
            ] },
            { title: 'Responsible', fields: [
                { key: 'owner_id', title: 'Responsible person', type: 'people', none: 'Not assigned', value: l.owner_id, display: v => C.personHtml(v), save: save('owner_id') },
            ] },
            B.cfSection(cf, l, async (code, v) => { await updateLead(l, { custom: { ...(l.custom || {}), [code]: v } }); }, edit),
            { title: 'More', fields: [
                { key: 'notes', title: 'Comment', type: 'textarea', value: l.notes, save: save('notes') },
                { key: 'created', title: 'Created', edit: false, value: l.created_at, display: () => `${esc(L.fmtDateTime(l.created_at))} · ${C.personHtml(l.created_by)}` },
                { key: 'updated', title: 'Modified', edit: false, value: l.updated_at, display: () => esc(L.fmtDateTime(l.updated_at)) },
            ] },
        ].filter(Boolean);

        view.innerHTML = '<div id="card"></div>';
        WSCard.mount(view.querySelector('#card'), {
            title: l.name, number: l.number, subtitle, canEdit: edit, onRename: edit ? save('name') : null,
            stages: statuses.map(s => ({ key: s.key, title: s.label, hex: hexOf(s.key), kind: s.is_converted ? 'won' : s.is_closed ? 'lost' : 'open' })),
            stage: l.status, canMove: edit && !converted && !l.archived_at,
            onStage: async key => {
                if (key === 'converted') {
                    const out = await openConvert(l, refresh);
                    if (!out || out === true) { const e = new Error('Conversion cancelled'); e.silent = true; throw e; }
                    return;
                }
                await setLeadStatus(l, key);
            },
            actions: edit && !converted && !l.archived_at ? [{ label: 'Convert', primary: true, onClick: () => openConvert(l, refresh) }] : [],
            menu, sections,
            tabs: [
                { key: 'tasks', title: 'To-dos', count: tasks.filter(t => !t.completed_at).length, render: el => {
                    el.innerHTML = `<div class="b24-tabbar"><button type="button" class="ws-btn sm primary" data-new-task>${C.icon('plus')}<span>Add to-do</span></button></div><div data-list></div>`;
                    el.querySelector('[data-new-task]').addEventListener('click', newTask);
                    C.table(el.querySelector('[data-list]'), {
                        rows: tasks, onRow: t => B.openRecord(`/tasks/?id=${t.id}`, refresh), sort: { key: 'due_date', dir: 'asc' },
                        columns: [
                            { key: 'title', label: 'To-do', lead: true, render: t => `<span class="primary-text">${esc(t.title)}</span>` },
                            { key: 'status', label: 'Status', render: t => C.statusBadge(taskStatusMap, t.status) },
                            { key: 'assignee_id', label: 'Responsible', value: t => C.personName(t.assignee_id), render: t => C.personHtml(t.assignee_id, { link: false }) },
                            { key: 'due_date', label: 'Deadline', render: t => C.dueHtml(t) },
                        ],
                        empty: { title: 'No to-dos', sub: 'Plan the next step with this lead.' },
                    });
                } },
                { key: 'meetings', title: 'Meetings', count: events.filter(e => e.status !== 'cancelled').length, render: el => {
                    el.innerHTML = `<div class="b24-tabbar"><button type="button" class="ws-btn sm primary" data-new-meet>${C.icon('plus')}<span>Schedule</span></button></div><div data-list></div>`;
                    el.querySelector('[data-new-meet]').addEventListener('click', newMeet);
                    C.table(el.querySelector('[data-list]'), {
                        rows: events, onRow: e => B.openRecord(`/calendar/?id=${e.id}`, refresh), sort: { key: 'starts_at', dir: 'desc' },
                        columns: [
                            { key: 'title', label: 'Event', lead: true, render: e => `<span class="primary-text">${esc(e.title)}</span>` },
                            { key: 'event_type', label: 'Type', render: e => C.statusBadge(L.EVENT_TYPE, e.event_type) },
                            { key: 'starts_at', label: 'When', render: e => `${esc(L.fmtDateTime(e.starts_at))}${e.status === 'cancelled' ? ' ' + C.badge('mute', 'Cancelled') : ''}` },
                            { key: 'owner_id', label: 'Organiser', value: e => C.personName(e.owner_id), render: e => C.personHtml(e.owner_id, { link: false }) },
                        ],
                        empty: { title: 'No meetings', sub: 'Schedule a meeting or call with this lead.' },
                    });
                } },
                { key: 'documents', title: 'Documents', render: el => C.documents(el, { entity_type: 'lead', entity_id: id, canEdit: true }) },
                { key: 'history', title: 'History', render: el => C.activityFeed(el, { entity_type: 'lead', entity_id: id, lead_id: id, limit: 200 }) },
            ],
            timeline: {
                entity_type: 'lead', entity_id: id, links: { lead_id: id },
                composer: [
                    { title: 'To-do', onOpen: newTask },
                    { title: 'Meeting', onOpen: newMeet },
                    { title: 'Call', onOpen: () => logInteraction(l, 'call.logged', 'Log a call', refresh) },
                    { title: 'Email', onOpen: () => logInteraction(l, 'email.logged', 'Log an email', refresh) },
                ],
            },
        });
    }

    route();
})();
