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
    function cfSection(fields, row, save, canEdit) {
        if (!fields.length) return null;
        return {
            title: 'Additional',
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
        if (level === 'all' || level === 'department' || level === 'subdepartments') return true;   // the database narrows these precisely
        return !row || row[ownerKey || 'owner_id'] === me.id || row.created_by === me.id;
    }

    const HEX = { pending: '#2fc6f6', late: '#ffa900', present: '#7bd500', weekoff: '#a8adb4', leave: '#9b7cf5', absent: '#ff5752', holiday: '#f76fa6', mute: '#a8adb4', info: '#39a8ef', ok: '#7bd500', warn: '#ffa900', bad: '#ff5752' };
    const PALETTE = ['#39a8ef', '#2fc6f6', '#55d0e0', '#47e4c2', '#ffa900', '#f7a700', '#9b7cf5', '#7bd500', '#f76fa6', '#ff5752'];
    function hex(token, i) { return (token && token[0] === '#') ? token : (HEX[token] || PALETTE[(i || 0) % PALETTE.length]); }

    function peopleOptions() { return C().activePeople().map(p => ({ value: p.id, label: p.name })); }

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

    window.WSB24 = { columns, customFields, cfColumns, cfFilters, cfSection, cfDisplay, levels, allowed, hex, peopleOptions, openRecord, pick, titleBar,
                     csvParse, csvStringify, exportCsv, importCsv, download };
})();
