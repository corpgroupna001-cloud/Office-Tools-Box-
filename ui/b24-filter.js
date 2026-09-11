/* ============================================================================
   WorkSuite — "Filter + search" bar (the Bitrix24-style list filter)

       const filter = WSFilter.mount(container, {
           id: 'leads',
           fields: [{ key, title, type: 'text'|'select'|'multiselect'|'user'|'date'|'number'|'check',
                      column, options: [{ value, label }], datetime, default, apply(builder, value) }],
           presets: [{ key, title, values }], defaultPreset: 'open',
           placeholder: 'Filter + search', me: '<my user id>',
           onChange({ search, values, preset }),
       });
       builder = filter.apply(builder, { searchColumns: ['name', 'email'] })   // a supabase-js query

   The last filter used, the fields shown and saved filters are kept per
   person ('filter:<id>' in user_ui_settings, with a browser copy).
   The pure parts (dateRange, toOps, chips) are exported for tests.
   ============================================================================ */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WSFilter = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const DATE_KINDS = [
        ['', 'Any date'], ['today', 'Today'], ['yesterday', 'Yesterday'], ['tomorrow', 'Tomorrow'],
        ['this_week', 'This week'], ['last_week', 'Last week'], ['next_week', 'Next week'],
        ['this_month', 'This month'], ['last_month', 'Last month'],
        ['last_7', 'Last 7 days'], ['last_30', 'Last 30 days'], ['next_7', 'Next 7 days'],
        ['before_today', 'Before today'], ['range', 'Custom range'],
    ];

    /* ---------- pure helpers ---------- */
    function istToday() {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    }
    function addDays(iso, n) {
        const d = new Date(iso + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
    }
    /** { from, to } (inclusive calendar days) for a date choice; weeks start on Monday. null = no limit. */
    function dateRange(value, today) {
        const v = value || {};
        const t = today || istToday();
        const dow = (new Date(t + 'T00:00:00Z').getUTCDay() + 6) % 7;          // Monday = 0
        const monthStart = t.slice(0, 8) + '01';
        const nextMonth = (() => { const d = new Date(monthStart + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); })();
        const prevMonth = (() => { const d = new Date(monthStart + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10); })();
        switch (v.kind) {
            case 'today': return { from: t, to: t };
            case 'yesterday': return { from: addDays(t, -1), to: addDays(t, -1) };
            case 'tomorrow': return { from: addDays(t, 1), to: addDays(t, 1) };
            case 'this_week': return { from: addDays(t, -dow), to: addDays(t, 6 - dow) };
            case 'last_week': return { from: addDays(t, -dow - 7), to: addDays(t, -dow - 1) };
            case 'next_week': return { from: addDays(t, 7 - dow), to: addDays(t, 13 - dow) };
            case 'this_month': return { from: monthStart, to: addDays(nextMonth, -1) };
            case 'last_month': return { from: prevMonth, to: addDays(monthStart, -1) };
            case 'last_7': return { from: addDays(t, -6), to: t };
            case 'last_30': return { from: addDays(t, -29), to: t };
            case 'next_7': return { from: t, to: addDays(t, 6) };
            case 'before_today': return { from: null, to: addDays(t, -1) };
            case 'range': return v.from || v.to ? { from: v.from || null, to: v.to || null } : null;
            default: return null;
        }
    }
    function isEmpty(f, v) {
        if (v == null || v === '' || v === false) return true;
        if (Array.isArray(v)) return !v.length;
        if (f.type === 'date') return !dateRange(v, '2000-01-01');
        if (f.type === 'number') return (v.from == null || v.from === '') && (v.to == null || v.to === '');
        return false;
    }
    /** The query operations for a set of values: [{ column, op, value }]. Pure. */
    function toOps(fields, values, ctx) {
        const out = [];
        const today = (ctx && ctx.today) || istToday();
        fields.forEach(f => {
            const v = values && values[f.key];
            if (f.apply || isEmpty(f, v)) return;
            const col = f.column || f.key;
            switch (f.type) {
                case 'text': out.push({ column: col, op: 'ilike', value: `%${String(v).replace(/[%,()]/g, ' ').trim()}%` }); break;
                case 'multiselect': out.push({ column: col, op: 'in', value: v.slice() }); break;
                case 'user':
                    if (v === 'none') out.push({ column: col, op: 'is', value: null });
                    else out.push({ column: col, op: 'eq', value: v === 'me' ? ctx && ctx.me : v });
                    break;
                case 'check': out.push({ column: col, op: 'eq', value: f.onValue !== undefined ? f.onValue : true }); break;
                case 'number':
                    if (v.from !== '' && v.from != null) out.push({ column: col, op: 'gte', value: Number(v.from) });
                    if (v.to !== '' && v.to != null) out.push({ column: col, op: 'lte', value: Number(v.to) });
                    break;
                case 'date': {
                    const r = dateRange(v, today);
                    if (!r) break;
                    // Timestamps compare against the IST day boundaries; plain dates compare as dates.
                    if (r.from) out.push({ column: col, op: 'gte', value: f.datetime ? `${r.from}T00:00:00+05:30` : r.from });
                    if (r.to) out.push({ column: col, op: f.datetime ? 'lt' : 'lte', value: f.datetime ? `${addDays(r.to, 1)}T00:00:00+05:30` : r.to });
                    break;
                }
                default: out.push({ column: col, op: 'eq', value: v });
            }
        });
        return out;
    }
    function optionLabel(f, v) {
        if (f.type === 'user' && v === 'me') return 'Me';
        if (f.type === 'user' && v === 'none') return 'Not assigned';
        const o = (f.options || []).find(x => String(typeof x === 'string' ? x : x.value) === String(v));
        return o ? (typeof o === 'string' ? o : o.label) : String(v);
    }
    /** Short labels for the chips in the bar. Pure. */
    function chips(fields, values) {
        return fields.filter(f => !isEmpty(f, values && values[f.key])).map(f => {
            const v = values[f.key];
            let text;
            if (f.type === 'multiselect') text = v.map(x => optionLabel(f, x)).join(', ');
            else if (f.type === 'date') { const k = DATE_KINDS.find(x => x[0] === v.kind); text = v.kind === 'range' ? [v.from, v.to].filter(Boolean).join(' – ') : (k ? k[1] : ''); }
            else if (f.type === 'number') text = [v.from !== '' && v.from != null ? `from ${v.from}` : '', v.to !== '' && v.to != null ? `to ${v.to}` : ''].filter(Boolean).join(' ');
            else if (f.type === 'check') text = 'Yes';
            else if (f.type === 'select' || f.type === 'user') text = optionLabel(f, v);
            else text = String(v);
            return { key: f.key, label: `${f.title}: ${text}` };
        });
    }
    function applyOps(builder, ops) {
        ops.forEach(o => {
            if (o.op === 'is') builder = builder.is(o.column, o.value);
            else if (o.op === 'in') builder = builder.in(o.column, o.value);
            else builder = builder[o.op](o.column, o.value);
        });
        return builder;
    }

    /* ---------- settings ---------- */
    function readLocal(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
    function writeLocal(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* private mode */ } }
    async function writeRemote(key, value) {
        const sb = window.__WS_SB__, uid = window.WSShell && WSShell.uid;
        if (!sb || !uid) return;
        try { await sb.from('user_ui_settings').upsert({ user_id: uid, key, value, updated_at: new Date().toISOString() }); } catch (e) { /* browser copy stays */ }
    }

    /* ---------- the bar ---------- */
    function mount(container, opts) {
        const fields = opts.fields;
        const byKey = Object.fromEntries(fields.map(f => [f.key, f]));
        const presets = opts.presets || [];
        const key = 'filter:' + opts.id;
        const saved = readLocal('ws-' + key) || {};
        const st = {
            search: '',
            preset: saved.last ? saved.last.preset || null : (opts.defaultPreset || null),
            values: saved.last ? saved.last.values || {} : {},
            shown: Array.isArray(saved.shown) && saved.shown.length ? saved.shown.filter(k => byKey[k]) : fields.filter(f => f.default !== false).map(f => f.key),
            saved: Array.isArray(saved.saved) ? saved.saved : [],
        };
        if (!saved.last && st.preset) { const p = allPresets().find(x => x.key === st.preset); st.values = p ? { ...p.values } : {}; }
        function allPresets() { return presets.concat(st.saved.map(s => ({ ...s, custom: true }))); }
        function persist() {
            const v = { shown: st.shown, saved: st.saved, last: { preset: st.preset, values: st.values } };
            writeLocal('ws-' + key, v); writeRemote(key, v);
        }
        function emit() { persist(); renderBar(); if (opts.onChange) opts.onChange(api.get()); }

        container.classList.add('b24-filter');
        container.innerHTML = `<span class="ic ic-search sm" aria-hidden="true"></span><span class="chips" data-chips></span>` +
            `<input type="search" data-q placeholder="${esc(opts.placeholder || 'Filter + search')}" aria-label="Search">` +
            `<button type="button" class="clear" data-clear aria-label="Reset filter" hidden>×</button>`;
        const input = container.querySelector('[data-q]');
        function renderBar() {
            const p = st.preset && allPresets().find(x => x.key === st.preset);
            const list = p ? [{ key: '__preset', label: p.title }] : chips(fields, st.values);
            container.querySelector('[data-chips]').innerHTML = list.map(c => `<span class="chip">${esc(c.label)}<button type="button" data-rm="${esc(c.key)}" aria-label="Remove ${esc(c.label)}">×</button></span>`).join('');
            container.querySelector('[data-clear]').hidden = !list.length && !st.search;
            container.classList.toggle('active', !!list.length);
        }

        let pop = null;
        function control(f) {
            const v = st.values[f.key];
            const opt = (value, label, on) => `<option value="${esc(value)}"${on ? ' selected' : ''}>${esc(label)}</option>`;
            const options = (f.options || []).map(o => typeof o === 'string' ? { value: o, label: o } : o);
            switch (f.type) {
                case 'select': return `<select data-f="${esc(f.key)}">${opt('', 'Any', !v)}${options.map(o => opt(o.value, o.label, String(o.value) === String(v))).join('')}</select>`;
                case 'user': return `<select data-f="${esc(f.key)}">${opt('', 'Anyone', !v)}${opt('me', 'Me', v === 'me')}${f.none !== false ? opt('none', 'Not assigned', v === 'none') : ''}${options.map(o => opt(o.value, o.label, String(o.value) === String(v))).join('')}</select>`;
                case 'multiselect': return `<div class="multi" data-f="${esc(f.key)}">${options.map(o => `<label><input type="checkbox" value="${esc(o.value)}"${(v || []).map(String).includes(String(o.value)) ? ' checked' : ''}> ${esc(o.label)}</label>`).join('')}</div>`;
                case 'check': return `<label class="chk"><input type="checkbox" data-f="${esc(f.key)}"${v ? ' checked' : ''}> ${esc(f.checkLabel || 'Yes')}</label>`;
                case 'number': return `<div class="range" data-f="${esc(f.key)}"><input type="number" step="any" placeholder="From" value="${esc(v && v.from != null ? v.from : '')}"><input type="number" step="any" placeholder="To" value="${esc(v && v.to != null ? v.to : '')}"></div>`;
                case 'date': {
                    const d = v || {};
                    return `<div class="daterange" data-f="${esc(f.key)}"><select>${DATE_KINDS.map(([k, l]) => opt(k, l, (d.kind || '') === k)).join('')}</select>` +
                        `<span class="dates"${d.kind === 'range' ? '' : ' hidden'}><input type="date" value="${esc(d.from || '')}" aria-label="From"><input type="date" value="${esc(d.to || '')}" aria-label="To"></span></div>`;
                }
                default: return `<input type="text" data-f="${esc(f.key)}" value="${esc(v || '')}">`;
            }
        }
        function readControls() {
            const out = {};
            st.shown.forEach(k => {
                const f = byKey[k], el = pop.querySelector(`[data-f="${CSS.escape(k)}"]`);
                if (!el) return;
                if (f.type === 'multiselect') out[k] = Array.from(el.querySelectorAll('input:checked')).map(i => i.value);
                else if (f.type === 'check') out[k] = el.checked;
                else if (f.type === 'number') { const [a, b] = el.querySelectorAll('input'); out[k] = { from: a.value, to: b.value }; }
                else if (f.type === 'date') { const s = el.querySelector('select'); const [a, b] = el.querySelectorAll('input'); out[k] = { kind: s.value, from: a.value, to: b.value }; }
                else out[k] = el.value;
                if (isEmpty(f, out[k])) delete out[k];
            });
            return out;
        }
        function openPop() {
            closePop();
            pop = document.createElement('div');
            pop.className = 'b24-pop b24-filterpop';
            pop.setAttribute('role', 'dialog');
            pop.setAttribute('aria-label', 'Filter');
            const hiddenFields = fields.filter(f => !st.shown.includes(f.key));
            pop.innerHTML = `
                <div class="presets">
                    ${allPresets().map(p => `<button type="button" class="preset${p.key === st.preset ? ' on' : ''}" data-preset="${esc(p.key)}"><span>${esc(p.title)}</span>${p.custom ? `<span class="del" data-del="${esc(p.key)}" title="Delete this filter" role="button" aria-label="Delete ${esc(p.title)}">×</span>` : ''}</button>`).join('')}
                    <div class="save"><button type="button" class="b24-link" data-savefilter>Save filter</button></div>
                </div>
                <div class="fields">
                    <div class="grid">${st.shown.map(k => `<div class="fld"><label>${esc(byKey[k].title)}<button type="button" class="rmf" data-hidefield="${esc(k)}" aria-label="Remove field">×</button></label>${control(byKey[k])}</div>`).join('')}</div>
                    ${hiddenFields.length ? `<select class="addf" data-addfield aria-label="Add field"><option value="">+ Add field</option>${hiddenFields.map(f => `<option value="${esc(f.key)}">${esc(f.title)}</option>`).join('')}</select>` : ''}
                    <div class="btns"><button type="button" class="ws-btn primary" data-find>${'Search'}</button><button type="button" class="ws-btn" data-reset>Reset</button></div>
                </div>`;
            document.body.appendChild(pop);
            const r = container.getBoundingClientRect();
            pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
            pop.style.top = (r.bottom + 6) + 'px';
            pop.addEventListener('change', e => {
                const s = e.target.closest('.daterange select');
                if (s) s.parentNode.querySelector('.dates').hidden = s.value !== 'range';
                if (e.target.matches('[data-addfield]') && e.target.value) { st.values = { ...st.values, ...readControls() }; st.shown.push(e.target.value); persist(); openPop(); }
            });
            pop.addEventListener('click', e => {
                const del = e.target.closest('[data-del]');
                if (del) { e.stopPropagation(); st.saved = st.saved.filter(s => s.key !== del.dataset.del); if (st.preset === del.dataset.del) st.preset = null; persist(); return openPop(); }
                const pb = e.target.closest('[data-preset]');
                if (pb) { const p = allPresets().find(x => x.key === pb.dataset.preset); st.preset = p.key; st.values = { ...(p.values || {}) }; closePop(); return emit(); }
                const hf = e.target.closest('[data-hidefield]');
                if (hf) { st.values = { ...readControls() }; delete st.values[hf.dataset.hidefield]; st.shown = st.shown.filter(k => k !== hf.dataset.hidefield); persist(); return openPop(); }
                if (e.target.closest('[data-find]')) { st.values = readControls(); st.preset = null; closePop(); return emit(); }
                if (e.target.closest('[data-reset]')) { api.reset(); return closePop(); }
                if (e.target.closest('[data-savefilter]')) {
                    const box = e.target.closest('.save');
                    box.innerHTML = '<input type="text" maxlength="60" placeholder="Filter name" aria-label="Filter name"><button type="button" class="ws-btn sm primary" data-savename>Save</button>';
                    box.querySelector('input').focus();
                    return;
                }
                if (e.target.closest('[data-savename]')) {
                    const name = pop.querySelector('.save input').value.trim();
                    if (!name) return;
                    const k = 'saved-' + Date.now().toString(36);
                    st.saved.push({ key: k, title: name, values: readControls() });
                    st.values = readControls(); st.preset = k;
                    closePop(); return emit();
                }
            });
            pop.addEventListener('keydown', e => {
                if (e.key === 'Escape') { e.stopPropagation(); closePop(); container.focus && input.focus(); }
                if (e.key === 'Enter' && e.target.matches('input:not(.save input)')) { e.preventDefault(); pop.querySelector('[data-find]').click(); }
            });
            setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
            const first = pop.querySelector('.fields input, .fields select'); if (first) first.focus();
        }
        function outside(e) { if (pop && !pop.contains(e.target) && !container.contains(e.target)) closePop(); }
        function closePop() { if (pop) { pop.remove(); pop = null; } document.removeEventListener('mousedown', outside, true); }

        container.addEventListener('click', e => {
            const rm = e.target.closest('[data-rm]');
            if (rm) {
                e.stopPropagation();
                if (rm.dataset.rm === '__preset') { st.preset = null; st.values = {}; }
                else { st.values = { ...st.values }; delete st.values[rm.dataset.rm]; st.preset = null; }
                return emit();
            }
            if (e.target.closest('[data-clear]')) { input.value = ''; st.search = ''; return api.reset(); }
            if (e.target === input && pop) return;
            if (!pop) openPop();
        });
        let t = null;
        input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { st.search = input.value.trim(); renderBar(); if (opts.onChange) opts.onChange(api.get()); }, 280); });
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(t); closePop(); st.search = input.value.trim(); if (opts.onChange) opts.onChange(api.get()); } });

        const api = {
            get: () => ({ search: st.search, values: { ...st.values }, preset: st.preset }),
            ops: () => toOps(fields, st.values, { me: opts.me }),
            /** Apply the filter and the search box to a supabase-js builder. */
            apply(builder, o) {
                builder = applyOps(builder, toOps(fields, st.values, { me: opts.me }));
                fields.forEach(f => { if (f.apply && !isEmpty(f, st.values[f.key])) builder = f.apply(builder, st.values[f.key]); });
                const cols = (o && o.searchColumns) || opts.searchColumns || [];
                const s = st.search.replace(/[%,()*]/g, ' ').trim();
                if (s && cols.length) builder = builder.or(cols.map(c => `${c}.ilike.%${s}%`).join(','));
                return builder;
            },
            set(values, preset) { st.values = { ...(values || {}) }; st.preset = preset || null; emit(); },
            reset() { const p = opts.defaultPreset && allPresets().find(x => x.key === opts.defaultPreset); st.preset = p ? p.key : null; st.values = p ? { ...p.values } : {}; emit(); },
            setOptions(fieldKey, options) { if (byKey[fieldKey]) byKey[fieldKey].options = options; renderBar(); },
            destroy() { closePop(); container.innerHTML = ''; },
        };
        renderBar();
        return api;
    }

    return { mount, dateRange, toOps, chips, applyOps, DATE_KINDS };
});
