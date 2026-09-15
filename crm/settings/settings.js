/* ============================================================================
   CRM settings — access permissions (roles), custom fields, lead stages,
   automation rules and the product catalogue.

   Everything here is enforced by the database: roles by RLS on the CRM
   tables (only workspace admins may change them), custom fields and the
   catalogue by the "CRM settings" permission, automation rules by the
   "Automation rules" permission. The page only shows what a person may do.

   URLs: /crm/settings?section=permissions|fields|stages|automation|products
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc, B = window.WSB24;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'crm-settings', crumb: 'CRM settings', layout: 'b24' });
    const sb = ctx.sb, me = ctx.user;

    const SECTIONS = [
        { key: 'permissions', title: 'Access permissions', icon: 'lock' },
        { key: 'fields', title: 'Custom fields', icon: 'edit' },
        { key: 'stages', title: 'Lead stages', icon: 'target' },
        { key: 'automation', title: 'Automation rules', icon: 'refresh' },
        { key: 'products', title: 'Product catalogue', icon: 'tag' },
    ];
    const LEVELS = [
        { value: 'none', label: 'No access' }, { value: 'own', label: 'Personal' },
        { value: 'department', label: 'Personal and department' }, { value: 'subdepartments', label: 'Personal, department and sub-departments' },
        { value: 'all', label: 'All' },
    ];
    const ENTITIES = [
        { key: 'lead', title: 'Leads', actions: ['read', 'add', 'edit', 'delete', 'export', 'import', 'move_stage', 'automation'] },
        { key: 'deal', title: 'Deals', actions: ['read', 'add', 'edit', 'delete', 'export', 'import', 'move_stage', 'automation'], pipelines: true },
        { key: 'contact', title: 'Contacts', actions: ['read', 'add', 'edit', 'delete', 'export', 'import'] },
        { key: 'company', title: 'Companies', actions: ['read', 'add', 'edit', 'delete', 'export', 'import'] },
        { key: 'invoice', title: 'Invoices', actions: ['read', 'add', 'edit', 'delete', 'export'] },
        { key: 'settings', title: 'CRM settings', actions: ['edit'] },
    ];
    const ACTIONS = { read: 'Read', add: 'Add', edit: 'Update', delete: 'Delete', export: 'Export', import: 'Import', move_stage: 'Move to stage', automation: 'Automation rules' };
    const FIELD_TYPES = [
        ['string', 'Text line'], ['text', 'Text block'], ['number', 'Number'], ['money', 'Money'], ['date', 'Date'], ['datetime', 'Date and time'],
        ['boolean', 'Yes / No'], ['list', 'List'], ['multilist', 'List (several values)'], ['employee', 'Employee'], ['url', 'Link'], ['email', 'Email'], ['phone', 'Phone'],
    ];
    const FIELD_ENTITIES = [['lead', 'Leads'], ['deal', 'Deals'], ['contact', 'Contacts'], ['company', 'Companies'], ['invoice', 'Invoices']];
    const COLORS = ['pending', 'late', 'present', 'leave', 'holiday', 'absent', 'weekoff'];

    // The new tables arrive with supabase-b24-migration.sql.
    const probe = await sb.from('crm_roles').select('id').limit(1);
    const hasMatrix = !(probe.error && ['42P01', 'PGRST205'].includes(String(probe.error.code)));
    const settingsLv = hasMatrix ? (await B.levels('settings')).edit : (ctx.isManager ? 'all' : 'none');
    const canSettings = ctx.isAdmin || settingsLv !== 'none';
    let lk = await C.lookups();

    const current = () => { const s = C.param('section'); return SECTIONS.some(x => x.key === s) ? s : 'permissions'; };
    function frame() {
        view.innerHTML = B.titleBar({ title: 'CRM settings' }) + `
            <div class="b24-settings">
                <nav class="b24-area b24-settings-nav" aria-label="Settings">${SECTIONS.map(s => `<a href="?section=${s.key}" data-section="${s.key}">${C.icon(s.icon)}<span>${esc(s.title)}</span></a>`).join('')}</nav>
                <section class="b24-settings-body" id="body"></section>
            </div>`;
        view.querySelector('.b24-settings-nav').addEventListener('click', e => {
            const a = e.target.closest('[data-section]'); if (!a) return;
            e.preventDefault(); C.setParam('section', a.dataset.section); show();
        });
    }
    window.addEventListener('popstate', () => show());
    function migrationNotice(what) {
        return `<div class="b24-area pad"><div class="crm-notice">${C.icon('lock')}<div><b>${esc(what)} need the latest database update.</b><br>An administrator needs to run <code>supabase-b24-migration.sql</code> in Supabase → SQL Editor. Existing records are not affected.</div></div></div>`;
    }
    function show() {
        const key = current();
        view.querySelectorAll('[data-section]').forEach(a => a.classList.toggle('on', a.dataset.section === key));
        const body = view.querySelector('#body');
        WSShell.setCrumb(SECTIONS.find(s => s.key === key).title);
        body.innerHTML = '<div class="b24-area pad"><div class="ws-empty">Loading…</div></div>';
        const run = { permissions: showPermissions, fields: showFields, stages: showStages, automation: showAutomation, products: showProducts }[key];
        run(body).catch(e => C.errorState(body, e, show));
    }

    /* ======================================================= permissions */
    // The Bitrix24-style matrix (ui/crm-perms.js); a workspace admin saves it
    // straight to the role tables, which only admins may write.
    async function showPermissions(body) {
        if (!hasMatrix) { body.innerHTML = migrationNotice('Access permissions'); return; }
        body.innerHTML = '<div class="cp-root"></div>';
        const all = async q => (await C.q(q)).data || [];
        WSCrmPerms.mount(body.firstElementChild, {
            canEdit: ctx.isAdmin,
            title: false,                                    // the settings page names the section already
            load: async () => {
                lk = await C.lookups(true);
                const [roles, permissions, assignments, depts] = await Promise.all([
                    all(sb.from('crm_roles').select('*').order('is_system', { ascending: false }).order('name')),
                    all(sb.from('crm_role_permissions').select('*')),
                    all(sb.from('crm_role_assignments').select('*').order('created_at')),
                    sb.from('departments').select('id, name, company, parent_id').order('name').then(r => r.data || []),
                ]);
                return {
                    roles, permissions, assignments, departments: depts,
                    pipelines: lk.pipelines, stages: lk.stages, statuses: lk.leadStatuses.map(x => ({ key: x.key, label: x.label })),
                    people: C.activePeople().map(p => ({ id: p.id, name: p.name, employee_id: p.employee_id || '', avatar_url: p.avatar_url || '' })),
                };
            },
            save: async batch => {
                const ids = new Map();
                const roleOf = v => ids.get(v) || v;
                const deleted = new Set(batch.deletes);
                for (const r of batch.new_roles) {
                    if (!r.name || r.name === 'Role name') throw new Error('Give each new role a name.');
                    const { data } = await C.q(sb.from('crm_roles').insert({ name: r.name.trim() }).select('id').single());
                    ids.set(r.tmp, data.id);
                }
                for (const r of batch.renames) await C.q(sb.from('crm_roles').update({ name: r.name.trim() }).eq('id', r.id));
                for (const id of batch.deletes) await C.q(sb.from('crm_roles').delete().eq('id', id));
                const find = (rid, c, action) => {
                    let q = sb.from('crm_role_permissions').select('id, extra').eq('role_id', rid).eq('entity', c.entity).eq('action', action);
                    return (c.pipeline_id ? q.eq('pipeline_id', c.pipeline_id) : q.is('pipeline_id', null)).maybeSingle();
                };
                for (const c of batch.levels) {
                    if (deleted.has(c.role_id)) continue;
                    const rid = roleOf(c.role_id);
                    const { data: have } = await C.q(find(rid, c, c.action));
                    if (!c.level) { if (have) await C.q(sb.from('crm_role_permissions').delete().eq('id', have.id)); continue; }
                    if (have) await C.q(sb.from('crm_role_permissions').update({ level: c.level }).eq('id', have.id));
                    else await C.q(sb.from('crm_role_permissions').insert({ role_id: rid, entity: c.entity, pipeline_id: c.pipeline_id, action: c.action, level: c.level }));
                }
                for (const c of batch.stages) {
                    if (deleted.has(c.role_id)) continue;
                    const rid = roleOf(c.role_id);
                    let { data: p } = await C.q(find(rid, c, 'move_stage'));
                    if (!p && c.stages.length) { await C.q(sb.from('crm_role_permissions').insert({ role_id: rid, entity: c.entity, pipeline_id: c.pipeline_id, action: 'move_stage', level: 'all' })); ({ data: p } = await C.q(find(rid, c, 'move_stage'))); }
                    if (p) await C.q(sb.from('crm_role_permissions').update({ extra: { ...(p.extra || {}), stages: c.stages } }).eq('id', p.id));
                }
                for (const id of batch.assign_remove) await C.q(sb.from('crm_role_assignments').delete().eq('id', id));
                for (const a of batch.assign_add) {
                    if (deleted.has(a.role_id)) continue;
                    const r = await sb.from('crm_role_assignments').insert({ ...a, role_id: roleOf(a.role_id) });
                    if (r.error && String(r.error.code) !== '23505') throw r.error;
                }
                C.toast('Access permissions saved', 'ok');
            },
        });
    }

    /* ===================================================== custom fields */
    async function showFields(body) {
        if (!hasMatrix) { body.innerHTML = migrationNotice('Custom fields'); return; }
        let entity = C.param('entity') && FIELD_ENTITIES.some(x => x[0] === C.param('entity')) ? C.param('entity') : 'lead';
        async function render() {
            const { data } = await C.q(sb.from('crm_custom_fields').select('*').eq('entity', entity).is('archived_at', null).order('sort').order('created_at'));
            const rows = data || [];
            const pipeName = id => (lk.pipelines.find(p => p.id === id) || {}).name || '';
            body.innerHTML = `
                <div class="b24-area pad">
                    <div class="b24-views" role="tablist">${FIELD_ENTITIES.map(([k, t]) => `<button type="button" data-entity="${k}" class="${k === entity ? 'on' : ''}">${esc(t)}</button>`).join('')}</div>
                    <p class="b24-hint">Fields added here appear on every ${esc(FIELD_ENTITIES.find(x => x[0] === entity)[1].toLowerCase())} card${entity === 'deal' ? ' (or only in one pipeline)' : ''}, and optionally as list columns and filter fields. Removing a field hides it; values already entered are kept.</p>
                    ${canSettings ? `<div class="b24-tabbar"><button type="button" class="ws-btn sm primary" data-new-field>${C.icon('plus')}<span>Add field</span></button></div>` : ''}
                    <table class="b24-grid-table b24-plain"><thead><tr><th>Field</th><th>Type</th><th>Where</th><th>Required</th><th>List</th><th>Filter</th><th></th></tr></thead>
                    <tbody>${rows.map(f => `<tr>
                        <td><b>${esc(f.label)}</b><span class="sub">${esc(f.code)}</span></td>
                        <td>${esc((FIELD_TYPES.find(t => t[0] === f.field_type) || [0, f.field_type])[1])}${f.options && f.options.length ? `<span class="sub">${f.options.length} option${f.options.length === 1 ? '' : 's'}</span>` : ''}</td>
                        <td>${f.company ? esc(f.company) : 'All companies'}${f.pipeline_id ? `<span class="sub">${esc(pipeName(f.pipeline_id))} pipeline</span>` : ''}</td>
                        <td>${f.required ? 'Yes' : '—'}</td><td>${f.show_in_list ? 'Yes' : '—'}</td><td>${f.show_in_filter ? 'Yes' : '—'}</td>
                        <td>${canSettings ? `<button type="button" class="ws-btn sm" data-edit-field="${esc(f.id)}">Edit</button> <button type="button" class="ws-btn sm danger" data-drop-field="${esc(f.id)}">Remove</button>` : ''}</td>
                    </tr>`).join('') || `<tr><td colspan="7"><div class="b24-grid-empty"><b>No custom fields yet</b><span>Add one to capture what your team needs on every record.</span></div></td></tr>`}</tbody></table>
                </div>`;
            body.querySelectorAll('[data-entity]').forEach(b => b.addEventListener('click', () => { entity = b.dataset.entity; C.setParam('entity', entity, true); render(); }));
            const nb = body.querySelector('[data-new-field]'); if (nb) nb.addEventListener('click', () => editField(null));
            body.querySelectorAll('[data-edit-field]').forEach(b => b.addEventListener('click', () => editField(rows.find(r => r.id === b.dataset.editField))));
            body.querySelectorAll('[data-drop-field]').forEach(b => b.addEventListener('click', async () => {
                const f = rows.find(r => r.id === b.dataset.dropField);
                if (!await C.confirm({ title: `Remove “${f.label}”?`, message: 'The field disappears from cards, lists and filters. Values already entered are kept and come back if the field is added again with the same code.', okText: 'Remove', danger: true })) return;
                try { await C.q(sb.from('crm_custom_fields').update({ archived_at: new Date().toISOString() }).eq('id', f.id)); C.toast('Field removed', 'ok'); render(); } catch (e) { C.toast(e.message, 'bad'); }
            }));
        }
        function slug(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 48) || 'field'; }
        async function editField(f) {
            const isNew = !f;
            await C.formModal({
                title: isNew ? 'Add field' : `Edit “${f.label}”`, size: 'wide', submitLabel: isNew ? 'Add field' : 'Save',
                fields: [
                    { name: 'label', label: 'Name', type: 'text', required: true },
                    { name: 'code', label: 'Code (used in exports and automation)', type: 'text', required: true, disabled: !isNew, hint: 'Lower-case letters, digits and _' },
                    { name: 'field_type', label: 'Type', type: 'select', required: true, disabled: !isNew, options: FIELD_TYPES.map(([value, label]) => ({ value, label })) },
                    ...(entity === 'deal' ? [{ name: 'pipeline_id', label: 'Pipeline', type: 'select', options: [{ value: '', label: 'All pipelines' }].concat(lk.pipelines.map(p => ({ value: p.id, label: p.name }))) }] : []),
                    ...(ctx.isAdmin ? [{ name: 'scope', label: 'Companies', type: 'select', options: [{ value: 'mine', label: me.company || 'My company' }, { value: 'all', label: 'All companies' }] }] : []),
                    { name: 'options', label: 'List values (one per line)', type: 'textarea', full: true, rows: 4 },
                    { name: 'section', label: 'Card section', type: 'text' },
                    { name: 'sort', label: 'Order', type: 'number' },
                    { name: 'required', label: 'Required', type: 'check' },
                    { name: 'show_in_list', label: 'Can be a list column', type: 'check' },
                    { name: 'show_in_filter', label: 'Can be a filter field', type: 'check' },
                ],
                values: isNew ? { field_type: 'string', section: 'Additional', sort: 100, show_in_list: true, show_in_filter: true, scope: 'mine' }
                    : { ...f, options: (f.options || []).map(o => o.label || o.value).join('\n'), pipeline_id: f.pipeline_id || '', scope: f.company ? 'mine' : 'all' },
                onReady: form => {
                    const sync = () => { const t = form.field('field_type').get(); form.field('options').wrap.hidden = !['list', 'multilist'].includes(t); };
                    form.field('field_type').el.addEventListener('change', sync); sync();
                    if (isNew) form.field('label').el.addEventListener('input', e => { form.field('code').set(slug(e.target.value)); });
                },
                onSubmit: async v => {
                    const opts = String(v.options || '').split('\n').map(s => s.trim()).filter(Boolean);
                    if (['list', 'multilist'].includes(v.field_type || f && f.field_type) && !opts.length) throw new Error('Add at least one list value.');
                    const row = {
                        label: v.label.trim(), section: v.section || 'Additional', sort: Number(v.sort) || 100,
                        required: !!v.required, show_in_list: !!v.show_in_list, show_in_filter: !!v.show_in_filter,
                        options: opts.map(o => { const prev = f && (f.options || []).find(x => (x.label || x.value) === o); return prev || { value: slug(o), label: o }; }),
                    };
                    if (entity === 'deal') row.pipeline_id = v.pipeline_id || null;
                    if (isNew) {
                        Object.assign(row, { entity, code: slug(v.code), field_type: v.field_type, company: ctx.isAdmin && v.scope === 'all' ? null : (me.company || null), created_by: me.id });
                        await C.q(sb.from('crm_custom_fields').insert(row));
                    } else {
                        if (ctx.isAdmin) row.company = v.scope === 'all' ? null : (f.company || me.company || null);
                        await C.q(sb.from('crm_custom_fields').update(row).eq('id', f.id));
                    }
                    C.toast('Saved', 'ok'); render();
                },
            });
        }
        await render();
    }

    /* ======================================================= lead stages */
    async function showStages(body) {
        async function render() {
            lk = await C.lookups(true);
            const stages = lk.leadStatuses;
            const counts = {};
            await Promise.all(stages.map(async s => { const r = await sb.from('crm_leads').select('id', { count: 'exact', head: true }).eq('status', s.key); counts[s.key] = r.error ? null : (r.count || 0); }));
            const canEdit = ctx.isManager;
            body.innerHTML = `
                <div class="b24-area pad">
                    <p class="b24-hint">Stages of a lead, in order. <b>Converted</b> is where a lead goes when it becomes a contact and deal; a closed stage (like Unqualified) takes a lead out of the pipeline.${canEdit ? ' Edits save when you leave a field.' : ''}</p>
                    <div class="b24-stage-editor">${stages.map((s, i) => `<div class="row" data-key="${esc(s.key)}">
                        <span class="b24-stage-pill" style="--c:${B.hex(s.color, i)}">${esc(s.label)}</span>
                        <input type="text" value="${esc(s.label)}" data-f="label" aria-label="Stage name"${canEdit ? '' : ' disabled'}>
                        <select data-f="color" aria-label="Colour"${canEdit ? '' : ' disabled'}>${COLORS.map(c => `<option value="${c}"${c === s.color ? ' selected' : ''}>${c}</option>`).join('')}</select>
                        <label class="crm-check"><input type="checkbox" data-f="is_closed"${s.is_closed ? ' checked' : ''}${canEdit && !s.is_converted ? '' : ' disabled'}> Closed</label>
                        <span class="muted">${counts[s.key] == null ? '' : `${counts[s.key]} lead${counts[s.key] === 1 ? '' : 's'}`}</span>
                        ${canEdit ? `<span class="btns"><button type="button" class="ws-btn sm icon" data-up${i === 0 ? ' disabled' : ''} aria-label="Move up">↑</button><button type="button" class="ws-btn sm icon" data-down${i === stages.length - 1 ? ' disabled' : ''} aria-label="Move down">↓</button>${s.is_converted ? '' : `<button type="button" class="ws-btn sm icon" data-del aria-label="Delete">${C.icon('trash')}</button>`}</span>` : ''}
                    </div>`).join('')}</div>
                    ${canEdit ? `<div class="b24-tabbar" style="margin-top:12px"><button type="button" class="ws-btn sm" data-add>${C.icon('plus')}<span>Add stage</span></button></div>` : ''}
                </div>`;
            if (!canEdit) return;
            body.querySelectorAll('.row').forEach((row, i) => {
                const s = stages[i];
                const save = async patch => { try { await C.q(sb.from('crm_lead_statuses').update(patch).eq('key', s.key)); render(); } catch (e) { C.toast(e.message, 'bad'); render(); } };
                row.querySelector('[data-f=label]').addEventListener('change', e => { const v = e.target.value.trim(); if (v && v !== s.label) save({ label: v }); });
                row.querySelector('[data-f=color]').addEventListener('change', e => save({ color: e.target.value }));
                row.querySelector('[data-f=is_closed]').addEventListener('change', e => save({ is_closed: e.target.checked }));
                const swap = async other => { if (!other) return; try { await C.q(sb.from('crm_lead_statuses').update({ sort_order: other.sort_order }).eq('key', s.key)); await C.q(sb.from('crm_lead_statuses').update({ sort_order: s.sort_order }).eq('key', other.key)); render(); } catch (e) { C.toast(e.message, 'bad'); } };
                row.querySelector('[data-up]').addEventListener('click', () => swap(stages[i - 1]));
                row.querySelector('[data-down]').addEventListener('click', () => swap(stages[i + 1]));
                const del = row.querySelector('[data-del]');
                if (del) del.addEventListener('click', async () => {
                    if (counts[s.key]) return C.alert({ title: 'Stage is in use', message: `${counts[s.key]} lead${counts[s.key] === 1 ? '' : 's'} sit in “${s.label}”. Move them to another stage first.` });
                    if (!await C.confirm({ title: `Delete “${s.label}”?`, message: 'No leads use it.', okText: 'Delete', danger: true })) return;
                    try { await C.q(sb.from('crm_lead_statuses').delete().eq('key', s.key)); render(); } catch (e) { C.toast(e.message, 'bad'); }
                });
            });
            body.querySelector('[data-add]').addEventListener('click', () => C.formModal({ title: 'Add stage', fields: [{ name: 'label', label: 'Name', type: 'text', required: true, full: true }, { name: 'is_closed', label: 'Closed stage (takes the lead out of the pipeline)', type: 'check', full: true }], submitLabel: 'Add', onSubmit: async v => {
                const key = v.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'stage';
                if (stages.some(s => s.key === key)) throw new Error('A stage with this name exists.');
                const converted = stages.find(s => s.is_converted);
                const before = stages.filter(s => !s.is_closed).pop();
                const order = v.is_closed ? (stages[stages.length - 1] || { sort_order: 0 }).sort_order + 1 : (before ? before.sort_order + 0.5 : 1);
                await C.q(sb.from('crm_lead_statuses').insert({ key, label: v.label.trim(), sort_order: Math.round(order * 2), is_closed: !!v.is_closed, color: 'pending' }));
                // Keep whole-number order values.
                const all = (await C.lookups(true)).leadStatuses;
                await Promise.all(all.map((s, i) => s.sort_order === i + 1 ? null : sb.from('crm_lead_statuses').update({ sort_order: i + 1 }).eq('key', s.key)));
                if (converted) render(); else render();
            } }));
        }
        await render();
    }

    /* =================================================== automation rules */
    async function showAutomation(body) {
        if (!hasMatrix) { body.innerHTML = migrationNotice('Automation rules'); return; }
        let entity = 'lead', pipeline = (lk.defaultPipeline && lk.defaultPipeline.id) || (lk.pipelines[0] && lk.pipelines[0].id) || '';
        const autoLv = { lead: (await B.levels('lead')).automation || 'none', deal: (await B.levels('deal')).automation || 'none' };
        const ACTION_LABEL = { create_task: 'Create a to-do', notify: 'Send a notification', set_owner: 'Change the responsible person', add_comment: 'Add a comment', set_field: 'Fill in a custom field' };
        const who = u => u === 'owner' || !u ? 'the responsible person' : u === 'creator' ? 'the creator' : C.personText(u);
        function describe(r) {
            const p = r.params || {};
            if (r.action === 'create_task') return `To-do “${esc(p.title || 'Follow up: {title}')}” for ${esc(who(p.user))}${p.due_days != null && p.due_days !== '' ? `, due in ${esc(p.due_days)} day${Number(p.due_days) === 1 ? '' : 's'}` : ''}`;
            if (r.action === 'notify') return `Notify ${esc(who(p.user))}: “${esc(p.title || '{title} moved stage')}”`;
            if (r.action === 'set_owner') return `Make ${esc(who(p.user))} responsible`;
            if (r.action === 'add_comment') return `Comment: “${esc(p.text || '')}”`;
            if (r.action === 'set_field') return `Set ${esc(p.code)} to “${esc(p.value)}”`;
            return esc(r.action);
        }
        async function render() {
            const stages = entity === 'lead' ? lk.leadStatuses.map((s, i) => ({ key: s.key, title: s.label, hex: B.hex(s.color, i) }))
                : L.stagesOf(lk.stages, pipeline).map((s, i) => ({ key: s.id, title: s.name, hex: B.hex(s.color, i) }));
            let q = sb.from('crm_automation_rules').select('*').eq('entity', entity).order('sort').order('created_at');
            if (entity === 'deal') q = q.eq('pipeline_id', pipeline);
            const { data } = await C.q(q);
            const rules = data || [];
            const canEdit = autoLv[entity] !== 'none';
            body.innerHTML = `
                <div class="b24-area pad">
                    <div class="b24-auto-head">
                        <div class="b24-views" role="tablist"><button type="button" data-ent="lead" class="${entity === 'lead' ? 'on' : ''}">Leads</button><button type="button" data-ent="deal" class="${entity === 'deal' ? 'on' : ''}">Deals</button></div>
                        ${entity === 'deal' && lk.pipelines.length > 1 ? `<select data-pipe aria-label="Pipeline">${lk.pipelines.map(p => `<option value="${esc(p.id)}"${p.id === pipeline ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
                    </div>
                    <p class="b24-hint">Rules run in the database when a ${entity} enters a stage, whoever moves it and from wherever. Use {title} to insert the ${entity === 'lead' ? 'lead' : 'deal'} name.</p>
                </div>
                <div class="b24-auto">${stages.map(s => `<section class="col"><header style="--kb-color:${s.hex}">${esc(s.title)}</header>
                    ${rules.filter(r => r.stage_key === s.key).map(r => `<article class="rule${r.active ? '' : ' off'}"><b>${esc(ACTION_LABEL[r.action] || r.action)}</b><span>${describe(r)}</span>
                        ${canEdit ? `<div class="acts"><button type="button" class="b24-link" data-toggle="${esc(r.id)}">${r.active ? 'Pause' : 'Turn on'}</button><button type="button" class="b24-link" data-edit-rule="${esc(r.id)}">Edit</button><button type="button" class="b24-link danger" data-del-rule="${esc(r.id)}">Delete</button></div>` : ''}</article>`).join('')}
                    ${canEdit ? `<button type="button" class="kb-add ws-btn sm" data-add-rule="${esc(s.key)}">${C.icon('plus')}<span>Add rule</span></button>` : ''}
                </section>`).join('') || '<div class="b24-area pad"><div class="ws-empty">No stages.</div></div>'}</div>`;
            body.querySelectorAll('[data-ent]').forEach(b => b.addEventListener('click', () => { entity = b.dataset.ent; render(); }));
            const ps = body.querySelector('[data-pipe]'); if (ps) ps.addEventListener('change', e => { pipeline = e.target.value; render(); });
            body.querySelectorAll('[data-add-rule]').forEach(b => b.addEventListener('click', () => editRule(null, b.dataset.addRule)));
            body.querySelectorAll('[data-edit-rule]').forEach(b => b.addEventListener('click', () => { const r = rules.find(x => x.id === b.dataset.editRule); editRule(r, r.stage_key); }));
            body.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', async () => { const r = rules.find(x => x.id === b.dataset.toggle); try { await C.q(sb.from('crm_automation_rules').update({ active: !r.active }).eq('id', r.id)); render(); } catch (e) { C.toast(e.message, 'bad'); } }));
            body.querySelectorAll('[data-del-rule]').forEach(b => b.addEventListener('click', async () => {
                if (!await C.confirm({ title: 'Delete this rule?', okText: 'Delete', danger: true })) return;
                try { await C.q(sb.from('crm_automation_rules').delete().eq('id', b.dataset.delRule)); render(); } catch (e) { C.toast(e.message, 'bad'); }
            }));
        }
        async function editRule(r, stageKey) {
            const cf = await B.customFields(entity, entity === 'deal' ? pipeline : null);
            const p = (r && r.params) || {};
            const userOpts = [{ value: 'owner', label: 'The responsible person' }, { value: 'creator', label: 'The creator' }].concat(B.peopleOptions());
            await C.formModal({
                title: r ? 'Edit rule' : 'Add rule', size: 'wide', submitLabel: 'Save',
                fields: [
                    { name: 'action', label: 'What happens', type: 'select', required: true, full: true, options: Object.entries(ACTION_LABEL).map(([value, label]) => ({ value, label })) },
                    { name: 'user', label: 'For whom', type: 'select', options: userOpts },
                    { name: 'title', label: 'Title', type: 'text', placeholder: 'e.g. Call {title}' },
                    { name: 'due_days', label: 'Due in (days)', type: 'number', min: 0 },
                    { name: 'text', label: 'Text', type: 'textarea', full: true },
                    { name: 'code', label: 'Custom field', type: 'select', options: [{ value: '', label: 'Choose…' }].concat(cf.map(f => ({ value: f.code, label: f.label }))) },
                    { name: 'value', label: 'Value', type: 'text' },
                ],
                values: { action: r ? r.action : 'create_task', user: p.user || 'owner', title: p.title || '', due_days: p.due_days != null ? p.due_days : 1, text: p.text || p.body || '', code: p.code || '', value: p.value != null ? p.value : '' },
                onReady: f => {
                    const sync = () => {
                        const a = f.field('action').get();
                        f.field('user').wrap.hidden = !['create_task', 'notify', 'set_owner'].includes(a);
                        f.field('title').wrap.hidden = !['create_task', 'notify'].includes(a);
                        f.field('due_days').wrap.hidden = a !== 'create_task';
                        f.field('text').wrap.hidden = !['add_comment', 'notify', 'create_task'].includes(a);
                        f.field('code').wrap.hidden = a !== 'set_field'; f.field('value').wrap.hidden = a !== 'set_field';
                    };
                    f.field('action').el.addEventListener('change', sync); sync();
                },
                onSubmit: async v => {
                    const params = {};
                    if (['create_task', 'notify', 'set_owner'].includes(v.action)) params.user = v.user || 'owner';
                    if (['create_task', 'notify'].includes(v.action) && v.title) params.title = v.title;
                    if (v.action === 'create_task') { if (v.due_days != null) params.due_days = Number(v.due_days); if (v.text) params.description = v.text; }
                    if (v.action === 'notify' && v.text) params.body = v.text;
                    if (v.action === 'add_comment') { if (!v.text) throw new Error('Write the comment.'); params.text = v.text; }
                    if (v.action === 'set_field') { if (!v.code) throw new Error('Choose a custom field.'); params.code = v.code; params.value = v.value; }
                    const row = { entity, stage_key: stageKey, action: v.action, params, pipeline_id: entity === 'deal' ? pipeline : null };
                    if (r) await C.q(sb.from('crm_automation_rules').update(row).eq('id', r.id));
                    else await C.q(sb.from('crm_automation_rules').insert({ ...row, created_by: me.id }));
                    C.toast('Rule saved', 'ok'); render();
                },
            });
        }
        await render();
    }

    /* ==================================================== product catalogue */
    async function showProducts(body) {
        if (!hasMatrix) { body.innerHTML = migrationNotice('The product catalogue'); return; }
        body.innerHTML = `<div class="b24-area pad"><p class="b24-hint">Products and services you sell. Deals add them as lines; the price and tax are copied into the deal so later changes here do not alter past deals.</p>
            ${ctx.isManager ? `<div class="b24-tabbar"><button type="button" class="ws-btn sm primary" data-new>${C.icon('plus')}<span>Add product</span></button></div>` : ''}</div><div data-grid style="margin-top:12px"></div>`;
        const edit = async p => C.formModal({
            title: p ? `Edit ${p.name}` : 'Add product', submitLabel: 'Save',
            fields: [
                { name: 'name', label: 'Name', type: 'text', required: true, full: true }, { name: 'sku', label: 'SKU / code', type: 'text' },
                { name: 'unit', label: 'Unit', type: 'select', options: ['pcs', 'hour', 'day', 'month', 'year', 'kg', 'm', 'set', 'service'] },
                { name: 'price', label: 'Price', type: 'money', required: true }, { name: 'currency', label: 'Currency', type: 'select', options: ['INR', 'USD', 'EUR', 'GBP', 'AED'] },
                { name: 'tax_rate', label: 'Tax, %', type: 'number', step: '0.01', min: 0, max: 100 }, { name: 'active', label: 'Available for new deals', type: 'check' },
                { name: 'description', label: 'Description', type: 'textarea', full: true },
            ],
            values: p || { unit: 'pcs', currency: 'INR', tax_rate: 18, active: true, price: 0 },
            onSubmit: async v => {
                const row = { name: v.name.trim(), sku: v.sku || null, unit: v.unit || 'pcs', price: Number(v.price) || 0, currency: v.currency || 'INR', tax_rate: Number(v.tax_rate) || 0, active: !!v.active, description: v.description || null };
                if (p) await C.q(sb.from('crm_products').update(row).eq('id', p.id)); else await C.q(sb.from('crm_products').insert({ ...row, created_by: me.id }));
                C.toast('Saved', 'ok'); grid.reload();
            },
        });
        const nb = body.querySelector('[data-new]'); if (nb) nb.addEventListener('click', () => edit(null));
        const grid = WSGrid.mount(body.querySelector('[data-grid]'), {
            id: 'crm-products', sort: { key: 'name', dir: 'asc' },
            columns: [
                { key: 'name', title: 'Product', width: 260, render: p => `<b>${esc(p.name)}</b>${p.sku ? `<span class="sub">${esc(p.sku)}</span>` : ''}`, edit: ctx.isManager ? { type: 'text', save: async (p, v) => { await C.q(sb.from('crm_products').update({ name: v }).eq('id', p.id)); } } : undefined },
                { key: 'price', title: 'Price', width: 130, align: 'right', render: p => esc(L.money(p.price, p.currency)), edit: ctx.isManager ? { type: 'money', save: async (p, v) => { await C.q(sb.from('crm_products').update({ price: v || 0 }).eq('id', p.id)); } } : undefined },
                { key: 'tax_rate', title: 'Tax, %', width: 90, align: 'right', render: p => esc(p.tax_rate) },
                { key: 'unit', title: 'Unit', width: 90, render: p => esc(p.unit) },
                { key: 'active', title: 'Status', width: 120, render: p => p.active ? C.badge('ok', 'Available') : C.badge('mute', 'Hidden') },
                { key: 'updated_at', title: 'Modified', width: 120, default: false, render: p => esc(L.fmtRelative(p.updated_at)) },
            ],
            load: async ({ offset, limit, sort }) => {
                let b = sb.from('crm_products').select('*');
                b = sort ? b.order(sort.key, { ascending: sort.dir === 'asc' }) : b.order('name');
                return (await C.q(b.range(offset, offset + limit - 1))).data || [];
            },
            count: async () => (await C.q(sb.from('crm_products').select('id', { count: 'exact', head: true }))).count || 0,
            rowMenu: p => ctx.isManager ? [{ label: 'Edit', icon: 'edit', onClick: () => edit(p) }, { label: p.active ? 'Hide from new deals' : 'Make available', icon: 'refresh', onClick: async () => { await C.q(sb.from('crm_products').update({ active: !p.active }).eq('id', p.id)); grid.reload(); } }] : [],
            empty: { title: 'No products yet', sub: ctx.isManager ? 'Add what you sell to use it in deals.' : 'Managers add products here.' },
        });
    }

    frame();
    show();
})();
