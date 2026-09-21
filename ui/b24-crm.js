/* ============================================================================
   WorkSuite — helpers shared by the CRM pages in the workspace layout
   (Leads, Deals, Contacts, Companies, Invoices). Needs ui/crm.js.

     WSB24.columns(table, full, legacy)    the select list this database supports
                                           (full once supabase-b24-migration.sql ran)
     WSB24.customFields(entity, pipelineId) admin-defined fields ([] before the migration)
     WSB24.cfColumns / cfFilters / cfSection   custom fields for grid, filter, card
     WSB24.levels(entity)                  { read, add, edit, delete, export, ... } from the roles
     WSB24.hex(token)                      a stage colour for a badge colour token
     WSB24.peopleOptions()                 [{ value, label }] of active colleagues
     WSB24.openRecord(url, onClose)        slide-over (full page inside a slide-over or on phones)
     WSB24.pick(title, field)              a one-field dialog; resolves with the value
     WSB24.titleBar({ title, createLabel, createMenu, gear })   markup for the title row
     WSB24.listGear({ anchor, before, importItem, exportRows, permissions })   the ⚙ menu of a CRM list
     WSB24.personBox / clientBox / amountHtml / importSection / thingsToDo    record card pieces
   ============================================================================ */
(function () {
    'use strict';
    if (window.WSB24) return;
    const C = () => window.WSCrm;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const probed = {};
    /** Try the full column list once; fall back to the pre-migration list on "column does not exist". */
    async function columns(table, full, legacy) {
        const k = table + '|' + full;
        if (probed[k]) return probed[k];
        probed[k] = (async () => {
            const ctx = await C().boot();
            const r = await ctx.sb.from(table).select(full).limit(1);
            // Missing column / relationship / table: the migration has not run yet.
            if (r.error && ['42703', 'PGRST200', 'PGRST100', '42P01', 'PGRST205'].includes(String(r.error.code))) return { select: legacy, full: false };
            return { select: full, full: true };
        })();
        return probed[k];
    }

    const cfCache = {};
    async function customFields(entity, pipelineId) {
        const k = entity + '|' + (pipelineId || '*');
        if (cfCache[k]) return cfCache[k];
        cfCache[k] = (async () => {
            try {
                const ctx = await C().boot();
                let b = ctx.sb.from('crm_custom_fields').select('*').eq('entity', entity).is('archived_at', null).order('sort').order('created_at');
                const r = await b;
                if (r.error) return [];
                return (r.data || []).filter(f => !f.pipeline_id || f.pipeline_id === pipelineId);
            } catch (e) { return []; }
        })();
        return cfCache[k];
    }
    function cfType(f) {
        return { string: 'text', text: 'textarea', number: 'number', money: 'money', date: 'date', datetime: 'datetime', boolean: 'check',
                 list: 'select', multilist: 'tags', employee: 'people', url: 'url', email: 'email', phone: 'tel' }[f.field_type] || 'text';
    }
    function cfOptions(f) { return (Array.isArray(f.options) ? f.options : []).map(o => typeof o === 'string' ? { value: o, label: o } : { value: o.value, label: o.label || o.value }); }
    function cfDisplay(f, v) {
        if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '';
        if (f.field_type === 'list') { const o = cfOptions(f).find(x => String(x.value) === String(v)); return esc(o ? o.label : v); }
        if (f.field_type === 'multilist') return esc((Array.isArray(v) ? v : [v]).map(x => { const o = cfOptions(f).find(y => String(y.value) === String(x)); return o ? o.label : x; }).join(', '));
        if (f.field_type === 'employee') return C().personHtml(v, { link: false });
        if (f.field_type === 'boolean') return v ? 'Yes' : 'No';
        if (f.field_type === 'money') return esc(window.WSCrmLogic.money(v, 'INR'));
        if (f.field_type === 'date') return esc(window.WSCrmLogic.fmtDate(v));
        if (f.field_type === 'datetime') return esc(window.WSCrmLogic.fmtDateTime(v));
        if (f.field_type === 'url') return `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>`;
        return esc(v);
    }
    function cfColumns(fields) {
        return fields.filter(f => f.show_in_list).map(f => ({
            key: 'cf_' + f.code, title: f.label, default: false, sortable: false, width: 160,
            render: r => cfDisplay(f, r.custom && r.custom[f.code]),
        }));
    }
    function cfFilters(fields) {
        return fields.filter(f => f.show_in_filter && ['string', 'list', 'employee', 'boolean', 'number', 'money', 'date'].includes(f.field_type)).map(f => {
            const base = { key: 'cf_' + f.code, title: f.label, default: false };
            if (f.field_type === 'list') return { ...base, type: 'select', options: cfOptions(f), apply: (b, v) => b.eq(`custom->>${f.code}`, String(v)) };
            if (f.field_type === 'employee') return { ...base, type: 'user', options: peopleOptions(), none: false, apply: (b, v) => b.eq(`custom->>${f.code}`, v === 'me' ? C().ctx().user.id : v) };
            if (f.field_type === 'boolean') return { ...base, type: 'check', apply: b => b.eq(`custom->>${f.code}`, 'true') };
            if (f.field_type === 'date') return { ...base, type: 'date', apply: (b, v) => { const r = window.WSFilter.dateRange(v); if (!r) return b; if (r.from) b = b.gte(`custom->>${f.code}`, r.from); if (r.to) b = b.lte(`custom->>${f.code}`, r.to); return b; } };
            if (f.field_type === 'number' || f.field_type === 'money') return { ...base, type: 'number', apply: (b, v) => { if (v.from !== '' && v.from != null) b = b.gte(`custom->${f.code}`, Number(v.from)); if (v.to !== '' && v.to != null) b = b.lte(`custom->${f.code}`, Number(v.to)); return b; } };
            return { ...base, type: 'text', apply: (b, v) => b.ilike(`custom->>${f.code}`, `%${String(v).replace(/[%,()]/g, ' ')}%`) };
        });
    }
    /** A card section for the record's custom fields; save(code, value) persists one. */
    function cfSection(fields, row, save, canEdit, title) {
        if (!fields.length) return null;
        return {
            title: title || 'Additional',
            fields: fields.map(f => ({
                key: 'cf_' + f.code, title: f.label, type: cfType(f), options: cfOptions(f), required: f.required,
                value: row.custom ? row.custom[f.code] : null,
                display: v => cfDisplay(f, v),
                save: canEdit ? v => save(f.code, v) : null,
            })),
        };
    }

    const levelCache = {};
    /** The caller's levels for an entity from the access-permissions matrix; falls back to the old rules. */
    async function levels(entity, pipelineId) {
        const k = entity + '|' + (pipelineId || '*');
        if (levelCache[k]) return levelCache[k];
        levelCache[k] = (async () => {
            const ctx = await C().boot();
            const actions = ['read', 'add', 'edit', 'delete', 'export', 'import', 'move_stage', 'automation'];
            const legacy = { read: 'all', add: entity === 'invoice' && !ctx.isManager ? 'none' : 'all', edit: ctx.isManager ? 'all' : 'own',
                             delete: ctx.isManager ? 'all' : 'none', export: ctx.isManager ? 'all' : 'own', import: ctx.isManager ? 'all' : 'none',
                             move_stage: 'all', automation: ctx.isManager ? 'all' : 'none', legacy: true };
            // Before the matrix, invoices were manager-only; employees saw only invoices they had raised.
            if (entity === 'invoice' && !ctx.isManager) Object.assign(legacy, { read: 'own', add: 'none', edit: 'none', delete: 'none', export: 'own', import: 'none' });
            try {
                const res = await Promise.all(actions.map(a => ctx.sb.rpc('ws_crm_levels', { p_entity: entity, p_action: a })));
                // Anything but a levels object ({"*": "all", ...}) means the matrix is not there yet.
                if (res.some(r => r.error || !r.data || typeof r.data !== 'object' || Array.isArray(r.data) || !('*' in r.data))) return legacy;
                const out = {};
                actions.forEach((a, i) => {
                    const v = res[i].data || {};
                    out[a] = pipelineId && v[pipelineId] ? v[pipelineId] : (v['*'] || 'none');
                });
                return out;
            } catch (e) { return legacy; }
        })();
        return levelCache[k];
    }
    /** Can the caller do `level` things to this row? (own = responsible or creator). */
    function allowed(level, row, me, ownerKey) {
        if (!level || level === 'none') return false;
        if (level === 'companies' || level === 'all' || level === 'department' || level === 'subdepartments') return true;   // the database narrows these precisely
        return !row || row[ownerKey || 'owner_id'] === me.id || row.created_by === me.id;
    }

    const HEX = { pending: '#2fc6f6', late: '#ffa900', present: '#7bd500', weekoff: '#a8adb4', leave: '#9b7cf5', absent: '#ff5752', holiday: '#f76fa6', mute: '#a8adb4', info: '#39a8ef', ok: '#7bd500', warn: '#ffa900', bad: '#ff5752' };
    const PALETTE = ['#39a8ef', '#2fc6f6', '#55d0e0', '#47e4c2', '#ffa900', '#f7a700', '#9b7cf5', '#7bd500', '#f76fa6', '#ff5752'];
    // Only a real colour reaches a style attribute; anything else falls back to the palette.
    function hex(token, i) { return (token && /^#[0-9a-f]{3,8}$/i.test(token)) ? token : (HEX[token] || PALETTE[(i || 0) % PALETTE.length]); }

    /** Filter options for a person: employee ID first, those with one listed first. */
    function peopleOptions() {
        return C().activePeople().slice()
            .sort((a, b) => (!a.employee_id - !b.employee_id) || String(a.employee_id || a.name).localeCompare(String(b.employee_id || b.name), 'en', { numeric: true }))
            .map(p => ({ value: p.id, label: C().personLabel(p) }));
    }

    function openRecord(url, onClose) {
        const phone = window.matchMedia('(max-width: 640px)').matches;
        if (!window.WSShell || !WSShell.openSlider || phone) { location.href = url; return; }
        WSShell.openSlider(url, { width: 1180, onClose });
    }

    function pick(title, field, value) {
        return C().formModal({ title, fields: [{ ...field, name: 'v', full: true }], values: { v: value }, submitLabel: 'Apply', onSubmit: v => v.v }).then(r => (r === true ? null : r));
    }

    function titleBar(o) {
        return `<div class="b24-titlebar">
            <h1 class="b24-title">${esc(o.title)}</h1>
            ${o.afterTitle || ''}
            ${o.createLabel ? `<span class="b24-create"><button type="button" class="b24-btn-create" data-create>${esc(o.createLabel)}</button>${o.createMenu ? '<button type="button" class="b24-btn-create more" data-create-menu aria-label="More ways to create">▾</button>' : ''}</span>` : ''}
            <div class="grow" data-filter></div>
            ${o.extra || ''}
            ${o.gear ? '<button type="button" class="b24-btn-glass round" data-gear title="Settings" aria-label="Settings"><span class="ic ic-gear"></span></button>' : ''}
        </div>`;
    }

    /* ---------- CSV import / export ---------- */
    // Parsing and writing live in ui/crm-logic.js (pure, unit-tested).
    const csvParse = text => window.WSCrmLogic.csvParse(text);
    const csvStringify = rows => window.WSCrmLogic.csvStringify(rows);
    function download(filename, text, type) {
        const url = URL.createObjectURL(new Blob(['﻿' + text], { type: type || 'text/csv;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
    /** Export: columns [{ title, value(row) }], rows loaded by the page (it applies the filter). */
    function exportCsv(filename, columns, rows) {
        download(filename, csvStringify([columns.map(c => c.title)].concat(rows.map(r => columns.map(c => c.value(r))))));
    }
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    /**
     * importCsv({ title, fields: [{ key, label, required, aliases: [] }], run: async (records) => ({ inserted, skipped }) })
     * Reads a CSV the person picks, maps its columns to fields (by header name, adjustable), and hands the records to run().
     */
    function importCsv(o) {
        const body = document.createElement('div');
        body.innerHTML = `<p style="margin:0 0 12px">Choose a CSV file (UTF-8, first row = column names). Up to 5,000 rows.</p>
            <input type="file" accept=".csv,text/csv" data-file aria-label="CSV file">
            <div data-map style="margin-top:14px"></div>`;
        let parsed = null;
        const m = C().modal({
            title: o.title, body, size: 'wide',
            actions: [{ label: 'Cancel', close: true }, { label: 'Import', primary: true, onClick: async api => {
                if (!parsed) throw new Error('Choose a CSV file first.');
                const map = {};
                body.querySelectorAll('[data-col]').forEach(sel => { if (sel.value !== '') map[sel.dataset.col] = Number(sel.value); });
                const missing = o.fields.filter(f => f.required && !(f.key in map));
                if (missing.length) throw new Error(`Choose a column for: ${missing.map(f => f.label).join(', ')}`);
                const records = parsed.rows.map(r => { const x = {}; Object.entries(map).forEach(([k, i]) => { const v = (r[i] || '').trim(); if (v) x[k] = v; }); return x; })
                    .filter(x => o.fields.filter(f => f.required).every(f => x[f.key]));
                if (!records.length) throw new Error('No rows have the required values.');
                api.setMessage(`Importing ${records.length} row${records.length === 1 ? '' : 's'}…`, true);
                const res = await o.run(records);
                api.close();
                C().alert({ title: 'Import finished', message: `${res.inserted} added${res.skipped ? `, ${res.skipped} skipped as duplicates` : ''}${res.failed ? `, ${res.failed} could not be saved` : ''}.` });
            } }],
        });
        body.querySelector('[data-file]').addEventListener('change', async e => {
            const file = e.target.files[0]; if (!file) return;
            if (file.size > 10 * 1024 * 1024) { m.setMessage('That file is larger than 10 MB.'); return; }
            const rows = csvParse(await file.text());
            if (rows.length < 2) { m.setMessage('The file has no data rows.'); return; }
            const head = rows[0];
            parsed = { head, rows: rows.slice(1, 5001) };
            const guess = f => { const names = [f.key, f.label].concat(f.aliases || []).map(norm); return head.findIndex(h => names.includes(norm(h))); };
            body.querySelector('[data-map]').innerHTML = `<p style="margin:0 0 8px"><b>${parsed.rows.length}</b> row${parsed.rows.length === 1 ? '' : 's'} found. Match the columns:</p>
                <div class="crm-form">${o.fields.map(f => { const g = guess(f); return `<div class="crm-field"><label>${esc(f.label)}${f.required ? '<span class="req">*</span>' : ''}</label>
                    <select data-col="${esc(f.key)}"><option value="">— skip —</option>${head.map((h, i) => `<option value="${i}"${i === g ? ' selected' : ''}>${esc(h || `Column ${i + 1}`)}</option>`).join('')}</select></div>`; }).join('')}</div>`;
        });
        return m;
    }

    /* ---------- create pages (WSCreate) ---------- */
    /** Form fields for a record's custom fields (the custom section of a create page). */
    function cfFormFields(fields) {
        return fields.map(f => ({
            name: 'cf_' + f.code, label: f.label, type: cfType(f), options: cfOptions(f), required: !!f.required, full: f.field_type === 'text',
            placeholder: f.field_type === 'list' ? 'Not selected' : undefined, none: f.field_type === 'employee' ? 'Not selected' : undefined,
        }));
    }
    /** Create-page values -> the record's own columns and its custom fields (blank custom values are left out). */
    function splitCustom(v, fields) {
        const values = {}, custom = {};
        Object.entries(v || {}).forEach(([k, val]) => { if (!k.startsWith('cf_')) values[k] = val; });
        (fields || []).forEach(f => { const val = (v || {})['cf_' + f.code]; if (!(val == null || val === '' || (Array.isArray(val) && !val.length))) custom[f.code] = val; });
        return { values, custom };
    }
    /** After a create page saves: show the new record in the same slider (or page) and tell the list behind it. */
    function afterCreate(base, id) {
        const inSlider = !!(window.WSShell && WSShell.inSlider);
        if (inSlider && WSShell.sliderMessage) WSShell.sliderMessage('changed', { id });
        location.replace(`${base}?id=${encodeURIComponent(id)}${inSlider ? '&slider=1' : ''}`);
    }
    function leaveCreate(base) {
        if (window.WSShell && WSShell.inSlider && WSShell.closeSlider) return WSShell.closeSlider();
        if (history.length > 1) history.back(); else location.href = base;
    }
    const fieldsSettingsUrl = entity => `/crm/settings?section=fields&entity=${encodeURIComponent(entity)}`;

    /* ---------- imported records (supabase-crm-import-migration.sql) ---------- */
    // Deals and leads brought in from Bitrix24 keep their export row in source_row
    // ({ "column name": "cell" }); records made here have none, so every helper
    // below answers '' for them and the page falls back to the record's own fields.
    const layoutCache = {};
    /** The export's column names for 'deal' | 'lead', in file order; [] before the migration or any import. */
    function importLayout(entity) {
        if (layoutCache[entity]) return layoutCache[entity];
        layoutCache[entity] = (async () => {
            try {
                const ctx = await C().boot();
                const r = await ctx.sb.from('crm_import_layouts').select('headers').eq('entity', entity).limit(1);
                const row = !r.error && Array.isArray(r.data) ? r.data[0] : null;
                const seen = new Set();
                return (row && Array.isArray(row.headers) ? row.headers : [])
                    .filter(h => typeof h === 'string' && h.trim() && !seen.has(h) && seen.add(h));
            } catch (e) { return []; }
        })();
        return layoutCache[entity];
    }
    /** A Bitrix cell as one line of plain text: [p], [br], [b], [url=…] and the like taken out. */
    function plainText(v) {
        if (v == null) return '';
        if (typeof v === 'object') v = Array.isArray(v) ? v.join(', ') : JSON.stringify(v);
        return String(v).replace(/\[br\s*\/?\]|\[\/p\]/gi, ' ').replace(/\[\/?[a-z*]{1,10}(?:=[^\]]*)?\]/gi, '')
            .replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
    }
    /** One cell of the record's export row, as plain text ('' when there is no such cell). */
    function src(row, header) {
        const s = row && row.source_row;
        return s && typeof s === 'object' && s[header] != null ? plainText(s[header]) : '';
    }
    const isYes = v => /^(y|yes|true|1)$/i.test(String(v || '').trim());
    /** The number the record had in the other system ("17651"), or ''. */
    function sourceId(row) {
        const m = String((row && row.external_ref) || '').match(/:(?:deal|lead):(.+)$/);
        return m ? m[1] : src(row, 'ID');
    }
    /** Optional grid columns, one per export column; `taken` = titles the page already uses. */
    function importColumns(headers, taken) {
        const used = new Set((taken || []).map(t => String(t).toLowerCase()));
        return (headers || []).map(h => ({
            key: 'src:' + h, title: used.has(h.toLowerCase()) ? `${h} (import)` : h, default: false, sortable: false, width: 170,
            render: r => { const v = src(r, h); return v ? `<span title="${esc(v)}">${esc(v)}</span>` : ''; },
        }));
    }
    /** 'DD.MM.YYYY' in IST, the way Bitrix24 lists dates. */
    function dotDate(v) {
        const iso = v ? window.WSCrmLogic.istDate(v) : null;
        return iso ? iso.split('-').reverse().join('.') : '';
    }
    function personByCode(code) {
        const c = String(code || '').trim().toLowerCase();
        if (!c) return null;
        return (C().ctx().people || []).find(p => String(p.employee_id || '').trim().toLowerCase() === c) || null;
    }
    /**
     * A person in a list cell: the record's person when it has one; else who the
     * import file named (an employee with that Employee ID, or the text itself
     * beside a generic avatar); else "Unassigned".
     */
    function personCell(id, named, opts) {
        if (id) return C().personHtml(id, { link: false });
        const text = plainText(named);
        if (!text) return C().personHtml(null, { link: false, ...(opts || {}) });
        const p = personByCode(text);
        if (p) return C().personHtml(p.id, { link: false });
        return `<span class="crm-person b24-person-imp" title="${esc(text)} (from the import)"><span class="ws-avatar b24-avatar-gen"><span class="ic ic-user"></span></span><span class="nm">${esc(text)}</span></span>`;
    }
    /** Several people named in one cell ("GL-A-001, GL-B-002"): the first two, then "+N". */
    function peopleCell(named) {
        const list = plainText(named).split(/\s*[,;]\s*/).filter(Boolean);
        if (!list.length) return '';
        const extra = list.length - 2;
        return `<span class="b24-people-cell" title="${esc(list.join(', '))}">${list.slice(0, 2).map(n => personCell(null, n)).join('')}${extra > 0 ? `<span class="more">+${extra} more</span>` : ''}</span>`;
    }
    /**
     * The Bitrix-style stage bar of a list row: a segment per stage, filled in the
     * current stage's colour up to it, the stage name under it.
     *   { stages: [{ key, name }], current, hex, lost, label, attr(stage) -> '' | 'data-…' (makes it clickable) }
     */
    function stageBar(o) {
        const at = o.lost ? o.stages.length - 1 : o.stages.findIndex(s => s.key === o.current);
        return `<div class="b24-stagebar${o.lost ? ' lost' : ''}" style="--c:${esc(o.hex)}">${o.stages.map((s, i) => {
            const a = o.attr ? o.attr(s) : '';
            const t = a ? 'Move to ' + s.name : s.name;
            return `<button type="button" class="seg${i <= at ? ' on' : ''}${a ? ' can' : ''}"${a ? ' ' + a : ' tabindex="-1"'} data-tip="${esc(s.name)}" aria-label="${esc(t)}"></button>`;
        }).join('')}</div><span class="b24-stagebar-l">${esc(o.label || '')}</span>`;
    }

    /* ---------- stage bar in a list: the name bubble, click vs double-click ---------- */
    let tipEl = null;
    function hideStageTip() { if (tipEl) tipEl.hidden = true; }
    function showStageTip(seg) {
        if (!tipEl) {
            tipEl = document.createElement('div');
            tipEl.className = 'b24-stage-tip';
            tipEl.setAttribute('role', 'tooltip');
            document.body.appendChild(tipEl);
        }
        const bar = seg.closest('.b24-stagebar');
        tipEl.innerHTML = `<b>${esc(seg.dataset.tip)}</b><span class="hint">Double-click - View</span>`;
        tipEl.style.setProperty('--c', bar ? getComputedStyle(bar).getPropertyValue('--c') : '#2fc6f6');
        tipEl.hidden = false;
        const r = seg.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight;
        const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
        tipEl.style.left = left + 'px';
        tipEl.style.top = Math.max(8, r.top - h - 8) + 'px';
        tipEl.style.setProperty('--arrow', Math.round(r.left + r.width / 2 - left) + 'px');
    }
    /**
     * Wire a list's stage bars: hovering a segment shows the stage name (Bitrix24's bubble),
     * a click on a movable segment calls move(button) after a short pause, and a
     * double-click cancels that move so the row can open instead.
     */
    function wireStageBars(root, selector, move) {
        let timer = null;
        root.addEventListener('mouseover', e => { const seg = e.target.closest('.b24-stagebar .seg[data-tip]'); if (seg) showStageTip(seg); });
        root.addEventListener('mouseout', e => { const seg = e.target.closest('.b24-stagebar .seg'); if (seg && !seg.contains(e.relatedTarget)) hideStageTip(); });
        root.addEventListener('click', e => {
            const b = e.target.closest(selector); if (!b) return;
            e.preventDefault();
            clearTimeout(timer);
            if (e.detail > 1) return;
            timer = setTimeout(() => { hideStageTip(); move(b); }, 260);
        });
        root.addEventListener('dblclick', e => { if (e.target.closest('.b24-stagebar')) { clearTimeout(timer); hideStageTip(); } });
        window.addEventListener('scroll', hideStageTip, true);
    }

    /* ---------- record card pieces (the Bitrix24 look) ---------- */
    /** A Bitrix cell kept as lines: [p]…[/p] and [br] become line breaks, other tags go. */
    function plainLines(v) {
        if (v == null) return '';
        if (typeof v === 'object') return plainText(v);
        return String(v).replace(/\[br\s*\/?\]|\[\/p\]/gi, '\n').replace(/\[\/?[a-z*]{1,10}(?:=[^\]]*)?\]/gi, '').replace(/&nbsp;/gi, ' ')
            .split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
    }
    /** "$500" / "₹2,50,000": no decimals when the amount is whole. */
    function moneyShort(v, currency) {
        const n = Number(v) || 0;
        return window.WSCrmLogic.money(n, currency || 'INR', { whole: n % 1 === 0 });
    }
    /** The big "Amount and currency" figure. */
    function amountHtml(v, currency, extra) {
        return `<div class="b24-amount"><span class="sum">${esc(moneyShort(v, currency))}</span>${extra || ''}</div>`;
    }
    /**
     * Responsible in a bordered box: the employee (avatar, Employee ID as a link, name); for an
     * imported record nobody matched, the code the file named; else "Not assigned".
     */
    function personBox(id, named) {
        let p = id ? C().person(id) : null;
        const text = plainText(named);
        if (!p && !id && text) p = personByCode(text);
        if (p) {
            const code = String(p.employee_id || '').trim();
            return `<span class="b24-box b24-personbox">${C().avatarHtml(p)}<span class="main"><a href="/employees/?id=${esc(p.id)}" target="_top" class="code">${esc(code || p.name)}</a>${code ? `<span class="sub">${esc(p.name)}</span>` : ''}</span></span>`;
        }
        if (!id && text) return `<span class="b24-box b24-personbox imp" title="${esc(text)} (from the import)"><span class="ws-avatar b24-avatar-gen"><span class="ic ic-user"></span></span><span class="main"><b class="code">${esc(text)}</b><span class="sub">from the import</span></span></span>`;
        return `<span class="b24-box b24-personbox none"><span class="ws-avatar b24-avatar-gen"><span class="ic ic-user"></span></span><span class="main"><span class="sub">${id ? 'Former employee' : 'Not assigned'}</span></span></span>`;
    }
    /** A client (contact) box: the name large, lines under it, and call / e-mail / chat icons. */
    function clientBox(o) {
        const digits = String(o.phone || '').replace(/[^\d+]/g, '');
        const wa = digits.replace(/\D/g, '');
        const name = o.href ? `<a class="nm" href="${esc(o.href)}"${o.attr ? ' ' + o.attr : ''}>${esc(o.name)}</a>` : `<span class="nm">${esc(o.name)}</span>`;
        const lines = (o.lines || []).filter(Boolean).map(l => `<span class="sub">${esc(l)}</span>`).join('');
        const phone = o.phone ? `<a class="sub" href="tel:${esc(digits)}">${esc(o.phone)}</a>` : '';
        const mail = o.email ? `<a class="sub" href="mailto:${esc(o.email)}">${esc(o.email)}</a>` : '';
        const ico = (href, ic, label, on) => on ? `<a class="b24-box-ic" href="${esc(href)}" title="${label}" aria-label="${label}"${/^https?:/.test(href) ? ' target="_blank" rel="noopener"' : ''}><span class="ic ic-${ic}"></span></a>` : `<span class="b24-box-ic off" title="${label}: no details" aria-hidden="true"><span class="ic ic-${ic}"></span></span>`;
        return `<div class="b24-box b24-clientbox">${o.label ? `<span class="kind">${esc(o.label)}</span>` : ''}<div class="row"><span class="main">${name}${lines}${phone}${mail}</span>
            <span class="icons">${ico('tel:' + digits, 'phone', 'Call', !!digits)}${ico('mailto:' + (o.email || ''), 'mail', 'E-mail', !!o.email)}${ico('https://wa.me/' + wa, 'chat', 'Chat', wa.length >= 8)}</span></div></div>`;
    }
    /**
     * CUSTOM SECTION of an imported record: every other non-empty cell of its export row, in file order.
     * `skip` = column names the card already shows. null for records made here (no export row).
     */
    function importSection(row, headers, skip, title) {
        const s = row && row.source_row;
        if (!s || typeof s !== 'object') return null;
        const skipSet = new Set((skip || []).map(h => String(h).toLowerCase()));
        const order = (headers && headers.length ? headers.filter(h => h in s) : []).concat(Object.keys(s).filter(k => !(headers || []).includes(k)));
        const fields = order.filter(h => !skipSet.has(h.toLowerCase())).map(h => ({ h, v: plainLines(s[h]) })).filter(x => x.v)
            .map(x => ({ key: 'src:' + x.h, title: x.h, edit: false, value: x.v, display: v => esc(v).replace(/\n/g, '<br>') }));
        return fields.length ? { title: title || 'Custom section', editLink: false, fields } : null;
    }
    /** "Things to do": the open to-dos of a record, soonest first, for the timeline. */
    function thingsToDo(tasks, opts) {
        const L = window.WSCrmLogic;
        const open = (tasks || []).filter(t => !t.completed_at).sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));
        const body = open.length ? open.slice(0, 5).map(t => {
            const st = t.due_date ? L.taskDueState(t) : '';
            return `<li><a href="/tasks/?id=${esc(t.id)}" data-open-task="${esc(t.id)}">${esc(t.title || 'To-do')}</a>${t.due_date ? `<span class="crm-due ${esc(st)}">${esc(L.fmtDate(t.due_date, { short: true }))}</span>` : ''}</li>`;
        }).join('') + (open.length > 5 ? `<li class="more">+${open.length - 5} more in To-dos</li>` : '')
            : `<li class="empty">${esc((opts && opts.empty) || 'No activities planned. Add a to-do so you do not forget the next step.')}</li>`;
        return `<div class="b24-todo"><span class="b24-todo-h">Things to do</span><ul>${body}</ul></div>`;
    }

    /* ---------- list gear menu and exports ---------- */
    /** Rows to an Excel-readable file (an HTML table saved as .xls). */
    function exportXls(filename, columns, rows) {
        const cell = v => esc(Array.isArray(v) ? v.join(', ') : v == null ? '' : v);
        const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body><table border="1">
            <tr>${columns.map(c => `<th>${cell(c.title)}</th>`).join('')}</tr>
            ${rows.map(r => `<tr>${columns.map(c => `<td style="mso-number-format:'\\@'">${cell(c.value(r))}</td>`).join('')}</tr>`).join('')}</table></body></html>`;
        download(filename, html, 'application/vnd.ms-excel;charset=utf-8');
    }
    /**
     * The ⚙ menu of a CRM list: pipeline settings (Deals), Import custom CSV data, Export to CSV / Excel,
     * Access permissions. Items the person cannot use are left out.
     *   { anchor, before: [items], importItem: item | null, exportRows: async () => ({ filename, columns, rows }) | null, permissions: bool }
     */
    function listGear(o) {
        const items = (o.before || []).slice();
        const run = fmt => async () => {
            try {
                const x = await o.exportRows();
                const name = `${x.filename}-${window.WSCrmLogic.todayIST()}`;
                if (fmt === 'xls') exportXls(name + '.xls', x.columns, x.rows); else exportCsv(name + '.csv', x.columns, x.rows);
                C().toast(`Exported ${x.rows.length} record${x.rows.length === 1 ? '' : 's'}${x.rows.length >= 5000 ? ' (first 5,000)' : ''}`, 'ok');
            } catch (e) { C().toast(e.message || 'Could not export', 'bad'); }
        };
        if (items.length && (o.importItem || o.exportRows)) items.push('sep');
        if (o.importItem) items.push(o.importItem);
        if (o.exportRows) items.push({ label: 'Export to CSV', icon: 'download', onClick: run('csv') }, { label: 'Export to Excel', icon: 'download', onClick: run('xls') });
        if (o.permissions) items.push('sep', { label: 'Access permissions', icon: 'shield', href: '/crm/settings/?section=permissions' });
        while (items.length && items[items.length - 1] === 'sep') items.pop();
        if (!items.length) return;
        C().menu(o.anchor, items);
    }

    window.WSB24 = { columns, customFields, cfColumns, cfFilters, cfSection, cfDisplay, levels, allowed, hex, peopleOptions, openRecord, pick, titleBar,
                     csvParse, csvStringify, exportCsv, importCsv, download, cfFormFields, splitCustom, afterCreate, leaveCreate, fieldsSettingsUrl,
                     importLayout, plainText, src, isYes, sourceId, importColumns, dotDate, personCell, peopleCell, stageBar,
                     wireStageBars, plainLines, moneyShort, amountHtml, personBox, clientBox, importSection, thingsToDo, exportXls, listGear };
})();
