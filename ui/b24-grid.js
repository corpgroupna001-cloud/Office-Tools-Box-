/* ============================================================================
   WorkSuite — list grid (the Bitrix24-style records list)

       const grid = WSGrid.mount(container, {
           id: 'leads',                         // settings key (columns, widths, sort, page size)
           columns: [{ key, title, width, default, sortable, sortKey, align, render(row) -> html,
                       edit: { type: 'text'|'number'|'money'|'date'|'select'|'people', options, save(row, value) -> Promise } }],
           load: async ({ offset, limit, sort }) => rows,   // one page; the grid asks for limit + 1 to see a next page
           count: async () => n,                            // "show quantity", on demand
           rowKey: 'id', onOpen(row), rowMenu(row) -> [{ label, icon, danger, onClick } | 'sep'],
           bulk: [{ label, icon, danger, run: async (ids, { all }) }],   // "for all" = every record the filter matches
           perPage: 20, empty: { title, sub, action },
       });
       grid.reload()   // back to page 1      grid.refresh()   // same page
       grid.selected() / grid.clearSelection() / grid.destroy()

   Settings live in the browser and, once supabase-b24-migration.sql is in,
   in user_ui_settings ('grid:<id>'), so they follow the person.
   ============================================================================ */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WSGrid = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const PER_PAGE = [5, 10, 20, 50, 100, 200];
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const icon = (n, cls) => `<span class="ic ic-${esc(n)}${cls ? ' ' + cls : ''}" aria-hidden="true"></span>`;

    /** Merge saved settings with the column list: unknown keys drop out, new default columns appear. Pure. */
    function normaliseSettings(columns, saved) {
        const keys = columns.map(c => c.key);
        const s = saved && typeof saved === 'object' ? saved : {};
        let visible = Array.isArray(s.visible) ? s.visible.filter(k => keys.includes(k)) : null;
        if (!visible || !visible.length) visible = columns.filter(c => c.default !== false).map(c => c.key);
        const known = Array.isArray(s.known) ? s.known : keys;
        // Columns added to the page after the settings were saved show up if they are on by default.
        columns.forEach(c => { if (!known.includes(c.key) && c.default !== false && !visible.includes(c.key)) visible.push(c.key); });
        const widths = {};
        Object.entries(s.widths || {}).forEach(([k, w]) => { if (keys.includes(k) && Number(w) >= 40 && Number(w) <= 1200) widths[k] = Math.round(Number(w)); });
        const sortable = columns.filter(c => c.sortable !== false).map(c => c.key);
        const sort = s.sort && sortable.includes(s.sort.key) ? { key: s.sort.key, dir: s.sort.dir === 'asc' ? 'asc' : 'desc' } : null;
        const perPage = PER_PAGE.includes(Number(s.perPage)) ? Number(s.perPage) : null;
        return { visible, widths, sort, perPage, known: keys };
    }

    function readLocal(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
    function writeLocal(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* private mode */ } }
    async function readRemote(key) {
        const sb = typeof window !== 'undefined' && window.__WS_SB__, uid = window.WSShell && WSShell.uid;
        if (!sb || !uid) return null;
        try { const r = await sb.from('user_ui_settings').select('value').eq('user_id', uid).eq('key', key).maybeSingle(); return r.error || !r.data ? null : r.data.value; }
        catch (e) { return null; }
    }
    async function writeRemote(key, value) {
        const sb = typeof window !== 'undefined' && window.__WS_SB__, uid = window.WSShell && WSShell.uid;
        if (!sb || !uid) return;
        try { await sb.from('user_ui_settings').upsert({ user_id: uid, key, value, updated_at: new Date().toISOString() }); } catch (e) { /* browser copy stays */ }
    }

    function mount(container, opts) {
        const rowKey = opts.rowKey || 'id';
        const settingsKey = 'grid:' + (opts.id || 'default');
        const cols = opts.columns;
        const byKey = Object.fromEntries(cols.map(c => [c.key, c]));
        const st = {
            settings: normaliseSettings(cols, readLocal('ws-' + settingsKey)),
            rows: [], page: 0, hasNext: false, loading: false, error: null, total: null,
            selected: new Set(), forAll: false, seq: 0,
        };
        if (!st.settings.sort && opts.sort) st.settings.sort = opts.sort;
        const perPage = () => st.settings.perPage || opts.perPage || 20;
        const saveSettings = () => { writeLocal('ws-' + settingsKey, st.settings); writeRemote(settingsKey, st.settings); };

        container.classList.add('b24-grid');
        container.innerHTML = `
            <div class="b24-grid-scroll"><table class="b24-grid-table"><colgroup></colgroup><thead></thead><tbody></tbody></table></div>
            <div class="b24-grid-foot">
                <span class="sel">Selected: <b data-selcount>0</b> / Total: <button type="button" class="b24-link" data-count>show quantity</button></span>
                <span class="pager" data-pager></span>
                <label class="pp">Records per page: <select data-perpage>${PER_PAGE.map(n => `<option value="${n}">${n}</option>`).join('')}</select></label>
            </div>
            <div class="b24-grid-bulk" data-bulk hidden></div>`;
        const table = container.querySelector('table');
        const colgroup = table.querySelector('colgroup'), thead = table.querySelector('thead'), tbody = table.querySelector('tbody');
        const bulkEl = container.querySelector('[data-bulk]');
        container.querySelector('[data-perpage]').value = String(perPage());

        function visibleCols() { return st.settings.visible.map(k => byKey[k]).filter(Boolean); }
        function renderHead() {
            const vc = visibleCols();
            colgroup.innerHTML = '<col style="width:44px"><col style="width:40px">' + vc.map(c => `<col data-colw="${esc(c.key)}" style="width:${st.settings.widths[c.key] || c.width || 160}px">`).join('');
            const s = st.settings.sort;
            thead.innerHTML = `<tr><th class="g-check"><input type="checkbox" data-all aria-label="Select all on this page"></th>` +
                `<th class="g-menu"><button type="button" class="g-gear" data-colsettings title="Columns" aria-label="Choose columns">${icon('gear', 'sm')}</button></th>` +
                vc.map(c => {
                    const sortable = c.sortable !== false;
                    const on = s && s.key === c.key;
                    return `<th data-col="${esc(c.key)}" class="${sortable ? 'sortable' : ''}${on ? ' ' + s.dir : ''}${c.align === 'right' ? ' num' : ''}"` +
                        (sortable ? ` tabindex="0" aria-sort="${on ? (s.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"` : '') + `>` +
                        `<span class="t">${esc(c.title)}</span>${sortable ? '<span class="si" aria-hidden="true"></span>' : ''}<span class="rs" data-resize aria-hidden="true"></span></th>`;
                }).join('') + '</tr>';
        }
        function renderBody() {
            const vc = visibleCols();
            const span = vc.length + 2;
            if (st.error) { tbody.innerHTML = `<tr class="g-state"><td colspan="${span}"><div class="ws-empty"><b>Could not load</b><div>${esc(st.error)}</div><div style="margin-top:10px"><button type="button" class="ws-btn sm" data-retry>Try again</button></div></div></td></tr>`; return; }
            if (st.loading && !st.rows.length) { tbody.innerHTML = Array.from({ length: 6 }, () => `<tr class="g-skel"><td colspan="${span}"><span class="ws-skel"></span></td></tr>`).join(''); return; }
            if (!st.rows.length) {
                const e = opts.empty || {};
                tbody.innerHTML = `<tr class="g-state"><td colspan="${span}"><div class="b24-grid-empty"><b>${esc(e.title || 'No records')}</b>${e.sub ? `<span>${esc(e.sub)}</span>` : ''}${e.action ? `<div>${e.action}</div>` : ''}</div></td></tr>`;
                return;
            }
            tbody.innerHTML = st.rows.map(r => {
                const id = String(r[rowKey]);
                const sel = st.selected.has(id);
                return `<tr data-id="${esc(id)}"${sel ? ' class="selected"' : ''}>` +
                    `<td class="g-check"><input type="checkbox" data-sel="${esc(id)}" aria-label="Select"${sel ? ' checked' : ''}></td>` +
                    `<td class="g-menu">${opts.rowMenu ? `<button type="button" class="g-rowmenu" data-rowmenu="${esc(id)}" aria-label="Actions">☰</button>` : ''}</td>` +
                    vc.map(c => `<td data-col="${esc(c.key)}" class="${c.align === 'right' ? 'num' : ''}${c.edit ? ' editable' : ''}">${c.render ? (c.render(r) ?? '') : esc(r[c.key] ?? '')}</td>`).join('') +
                    '</tr>';
            }).join('');
            if (st.loading) tbody.classList.add('busy'); else tbody.classList.remove('busy');
        }
        function renderFoot() {
            container.querySelector('[data-selcount]').textContent = st.forAll ? 'all' : String(st.selected.size);
            const countBtn = container.querySelector('[data-count]');
            countBtn.textContent = st.total == null ? 'show quantity' : String(st.total);
            countBtn.disabled = st.total != null || !opts.count;
            const pages = st.total != null ? Math.max(1, Math.ceil(st.total / perPage())) : null;
            container.querySelector('[data-pager]').innerHTML = (st.page > 0 || st.hasNext) ?
                `<button type="button" class="b24-link" data-page="${st.page - 1}"${st.page === 0 ? ' disabled' : ''}>‹ Previous</button>` +
                `<span>Page ${st.page + 1}${pages ? ' of ' + pages : ''}</span>` +
                `<button type="button" class="b24-link" data-page="${st.page + 1}"${st.hasNext ? '' : ' disabled'}>Next ›</button>` : '';
            const allBox = thead.querySelector('[data-all]');
            if (allBox) { const ids = st.rows.map(r => String(r[rowKey])); allBox.checked = ids.length > 0 && ids.every(id => st.selected.has(id)); allBox.indeterminate = !allBox.checked && ids.some(id => st.selected.has(id)); }
            renderBulk();
        }
        function renderBulk() {
            const n = st.selected.size;
            bulkEl.hidden = !(n || st.forAll) || !(opts.bulk && opts.bulk.length);
            if (bulkEl.hidden) return;
            bulkEl.innerHTML = `<span class="n">${st.forAll ? 'All matching records' : `${n} selected`}</span>` +
                opts.bulk.map((b, i) => `<button type="button" class="ws-btn sm${b.danger ? ' danger' : ''}" data-bulk-i="${i}">${b.icon ? icon(b.icon) : ''}<span>${esc(b.label)}</span></button>`).join('') +
                `<label class="forall"><input type="checkbox" data-forall${st.forAll ? ' checked' : ''}> For all</label>` +
                `<button type="button" class="b24-link" data-clearsel>Cancel</button>`;
        }
        function render() { renderHead(); renderBody(); renderFoot(); }

        async function loadPage() {
            const seq = ++st.seq;
            st.loading = true; st.error = null;
            renderBody();
            try {
                const rows = await opts.load({ offset: st.page * perPage(), limit: perPage() + 1, sort: st.settings.sort });
                if (seq !== st.seq) return;
                st.hasNext = rows.length > perPage();
                st.rows = rows.slice(0, perPage());
                if (!st.rows.length && st.page > 0) { st.page -= 1; return loadPage(); }
            } catch (e) {
                if (seq !== st.seq) return;
                st.rows = []; st.error = (e && e.message) || 'Something went wrong.';
            }
            st.loading = false;
            renderBody(); renderFoot();
        }

        /* ----- column chooser ----- */
        function openColumns(anchor) {
            closePops();
            const pop = document.createElement('div');
            pop.className = 'b24-pop b24-colpop';
            pop.setAttribute('role', 'dialog');
            pop.setAttribute('aria-label', 'Columns');
            const order = st.settings.visible.concat(cols.map(c => c.key).filter(k => !st.settings.visible.includes(k)));
            pop.innerHTML = `<div class="b24-pop-head"><b>Columns</b><span>Tick to show; drag to reorder.</span></div>
                <div class="b24-colpop-list">${order.map(k => `<label draggable="true" data-k="${esc(k)}"><span class="grip">⋮⋮</span><input type="checkbox"${st.settings.visible.includes(k) ? ' checked' : ''}> ${esc(byKey[k].title)}</label>`).join('')}</div>
                <div class="b24-pop-foot"><button type="button" class="ws-btn sm primary" data-save>Save</button><button type="button" class="ws-btn sm" data-cancel>Cancel</button><span class="grow"></span><button type="button" class="b24-link" data-reset>Reset</button></div>`;
            document.body.appendChild(pop);
            placePop(pop, anchor);
            const list = pop.querySelector('.b24-colpop-list');
            let drag = null;
            list.addEventListener('dragstart', e => { drag = e.target.closest('label'); if (drag) drag.classList.add('dragging'); });
            list.addEventListener('dragover', e => { if (!drag) return; e.preventDefault(); const over = e.target.closest('label'); if (over && over !== drag) { const r = over.getBoundingClientRect(); list.insertBefore(drag, e.clientY < r.top + r.height / 2 ? over : over.nextSibling); } });
            list.addEventListener('dragend', () => { if (drag) drag.classList.remove('dragging'); drag = null; });
            pop.addEventListener('click', e => {
                if (e.target.closest('[data-cancel]')) return closePops();
                if (e.target.closest('[data-reset]')) { st.settings = normaliseSettings(cols, null); saveSettings(); closePops(); render(); return loadPage(); }
                if (e.target.closest('[data-save]')) {
                    const vis = Array.from(list.querySelectorAll('label')).filter(l => l.querySelector('input').checked).map(l => l.dataset.k);
                    if (!vis.length) return;
                    st.settings.visible = vis;
                    saveSettings(); closePops(); render();
                }
            });
        }
        function placePop(pop, anchor) {
            const r = anchor.getBoundingClientRect();
            pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
            pop.style.top = Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8) + 'px';
            setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
            function outside(e) { if (!pop.contains(e.target)) { closePops(); document.removeEventListener('mousedown', outside, true); } }
            pop._outside = outside;
        }
        function closePops() {
            document.querySelectorAll('.b24-pop').forEach(p => { if (p._outside) document.removeEventListener('mousedown', p._outside, true); p.remove(); });
        }
        function openRowMenu(anchor, row) {
            closePops();
            const items = (opts.rowMenu(row) || []).filter(Boolean);
            if (!items.length) return;
            const pop = document.createElement('div');
            pop.className = 'b24-pop b24-menu';
            pop.setAttribute('role', 'menu');
            pop.innerHTML = items.map((it, i) => it === 'sep' ? '<hr>' : `<button type="button" role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}">${it.icon ? icon(it.icon) : ''}${esc(it.label)}</button>`).join('');
            document.body.appendChild(pop);
            placePop(pop, anchor);
            pop.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (!b) return; closePops(); const it = items[Number(b.dataset.i)]; if (it.onClick) it.onClick(); });
            const first = pop.querySelector('button'); if (first) first.focus();
        }

        /* ----- inline edit ----- */
        function startEdit(td, row) {
            const c = byKey[td.dataset.col];
            if (!c || !c.edit || td.querySelector('.g-edit')) return;
            const e = c.edit;
            const cur = e.value ? e.value(row) : row[c.key];
            let field;
            if (e.type === 'select' || e.type === 'people') {
                const options = typeof e.options === 'function' ? e.options(row) : (e.options || []);
                field = `<select class="g-edit">${options.map(o => { const v = typeof o === 'string' ? o : o.value, l = typeof o === 'string' ? o : o.label; return `<option value="${esc(v)}"${String(v) === String(cur ?? '') ? ' selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
            } else {
                const type = e.type === 'money' || e.type === 'number' ? 'number' : e.type === 'date' ? 'date' : 'text';
                field = `<input class="g-edit" type="${type}"${type === 'number' ? ' step="0.01"' : ''} value="${esc(cur ?? '')}">`;
            }
            const before = td.innerHTML;
            td.innerHTML = field + '<span class="g-edit-btns"><button type="button" class="ws-btn sm primary" data-edit-ok>Save</button><button type="button" class="ws-btn sm" data-edit-no>Cancel</button></span>';
            const input = td.querySelector('.g-edit');
            input.focus();
            const cancel = () => { td.innerHTML = before; };
            const ok = async () => {
                let v = input.value;
                if (e.type === 'money' || e.type === 'number') v = v === '' ? null : Number(v);
                if (v === '') v = null;
                td.querySelectorAll('button').forEach(b => { b.disabled = true; });
                try { await e.save(row, v); await api.refresh(); }
                catch (err) { td.innerHTML = before; if (window.WSShell) WSShell.toast(err.message || 'Could not save', 'bad'); }
            };
            td.querySelector('[data-edit-ok]').addEventListener('click', ev => { ev.stopPropagation(); ok(); });
            td.querySelector('[data-edit-no]').addEventListener('click', ev => { ev.stopPropagation(); cancel(); });
            input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); ok(); } if (ev.key === 'Escape') { ev.stopPropagation(); cancel(); } });
        }

        /* ----- events ----- */
        container.addEventListener('click', async e => {
            const t = e.target;
            if (t.closest('[data-retry]')) return loadPage();
            if (t.closest('[data-colsettings]')) return openColumns(t.closest('[data-colsettings]'));
            const th = t.closest('th.sortable');
            if (th && !t.closest('[data-resize]')) {
                const k = th.dataset.col, s = st.settings.sort;
                st.settings.sort = s && s.key === k ? { key: k, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'asc' };
                saveSettings(); st.page = 0; renderHead(); return loadPage();
            }
            const pg = t.closest('[data-page]');
            if (pg && !pg.disabled) { st.page = Math.max(0, Number(pg.dataset.page)); await loadPage(); container.scrollIntoView({ block: 'nearest' }); return; }
            if (t.closest('[data-count]') && opts.count && st.total == null) {
                const b = t.closest('[data-count]'); b.textContent = '…';
                try { st.total = await opts.count(); } catch (err) { st.total = null; b.textContent = 'show quantity'; if (window.WSShell) WSShell.toast(err.message || 'Could not count', 'bad'); return; }
                return renderFoot();
            }
            const sel = t.closest('[data-sel]');
            if (sel) { const id = sel.dataset.sel; if (sel.checked) st.selected.add(id); else st.selected.delete(id); st.forAll = false; sel.closest('tr').classList.toggle('selected', sel.checked); return renderFoot(); }
            const all = t.closest('[data-all]');
            if (all) { st.rows.forEach(r => { const id = String(r[rowKey]); if (all.checked) st.selected.add(id); else st.selected.delete(id); }); st.forAll = false; renderBody(); return renderFoot(); }
            if (t.closest('[data-forall]')) { st.forAll = t.closest('[data-forall]').checked; return renderFoot(); }
            if (t.closest('[data-clearsel]')) return api.clearSelection();
            const bb = t.closest('[data-bulk-i]');
            if (bb) {
                const action = opts.bulk[Number(bb.dataset.bulkI)];
                bb.disabled = true;
                try { const done = await action.run([...st.selected], { all: st.forAll }); if (done !== false) { st.selected.clear(); st.forAll = false; await api.refresh(); } }
                catch (err) { if (window.WSShell) WSShell.toast(err.message || 'Could not apply', 'bad'); }
                finally { bb.disabled = false; }
                return;
            }
            const rm = t.closest('[data-rowmenu]');
            if (rm) { const row = st.rows.find(r => String(r[rowKey]) === rm.dataset.rowmenu); if (row) openRowMenu(rm, row); return; }
            if (t.closest('a, button, input, select, textarea, label, .g-edit-btns')) return;
            const openEl = t.closest('[data-open]');
            const tr = t.closest('tr[data-id]');
            if (openEl && tr && opts.onOpen) { const row = st.rows.find(r => String(r[rowKey]) === tr.dataset.id); if (row) opts.onOpen(row, e); }
        });
        container.addEventListener('dblclick', e => {
            const td = e.target.closest('td.editable'), tr = e.target.closest('tr[data-id]');
            if (!td || !tr) return;
            const row = st.rows.find(r => String(r[rowKey]) === tr.dataset.id);
            if (row) startEdit(td, row);
        });
        container.addEventListener('keydown', e => {
            const th = e.target.closest('th.sortable');
            if (th && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); th.click(); }
        });
        container.querySelector('[data-perpage]').addEventListener('change', e => {
            st.settings.perPage = Number(e.target.value); saveSettings(); st.page = 0; loadPage();
        });
        // Column resize: drag the right edge of a header.
        container.addEventListener('mousedown', e => {
            const h = e.target.closest('[data-resize]'); if (!h) return;
            e.preventDefault();
            const th = h.closest('th'), key = th.dataset.col, col = colgroup.querySelector(`[data-colw="${CSS.escape(key)}"]`);
            const startX = e.clientX, startW = th.getBoundingClientRect().width;
            document.body.classList.add('b24-resizing');
            const move = ev => { const w = Math.max(60, Math.min(900, startW + ev.clientX - startX)); col.style.width = w + 'px'; st.settings.widths[key] = Math.round(w); };
            const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.classList.remove('b24-resizing'); saveSettings(); };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
        });

        const api = {
            reload() { st.page = 0; st.total = null; st.selected.clear(); st.forAll = false; render(); return loadPage(); },
            refresh() { return loadPage(); },
            selected: () => [...st.selected],
            get forAll() { return st.forAll; },
            clearSelection() { st.selected.clear(); st.forAll = false; renderBody(); renderFoot(); },
            rows: () => st.rows.slice(),
            destroy() { closePops(); container.innerHTML = ''; container.classList.remove('b24-grid'); },
        };
        render();
        // The account copy of the settings may differ from this browser's.
        readRemote(settingsKey).then(v => {
            if (!v || JSON.stringify(normaliseSettings(cols, v)) === JSON.stringify(st.settings)) return;
            st.settings = normaliseSettings(cols, v); writeLocal('ws-' + settingsKey, st.settings);
            container.querySelector('[data-perpage]').value = String(perPage());
            render(); loadPage();
        });
        loadPage();
        return api;
    }

    return { mount, normaliseSettings, PER_PAGE };
});
