/* ============================================================================
   WorkSuite — "New contact / lead / deal" page (the Bitrix24-style create slider)

       const page = WSCreate.mount(container, {
           title: 'New lead', entity: 'lead',
           stages: [{ key, title, hex }], stage: 'new', stageField: 'status',   // optional clickable stage bar
           sections: [{ title, fields: [WSCrm.form field specs, plus optional: true to start hidden] }],
           values: { … },                                                   // defaults
           note: 'You are now adding a lead…',
           createFieldHref: '/crm/settings?s=fields&entity=lead',          // managers: "Create field"
           onChange(name, value, page),                                     // e.g. a pipeline changed
           onSave: async values => saved,                                   // throw to show a message
           onCancel(),
       });
       page.get() / page.validate() / page.setStages(stages, stage) / page.field(name)

   Fields marked optional start hidden and are offered under "Select field"
   in their section, as in Bitrix24. Ctrl/Cmd+Enter saves.
   ============================================================================ */
(function () {
    'use strict';
    if (window.WSCreate) return;
    const C = () => window.WSCrm;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function mount(container, o) {
        let stages = o.stages || null, stage = o.stage || null, busy = false;
        const shown = new Set();                       // optional fields the person revealed
        (o.sections || []).forEach(s => s.fields.forEach(f => { if (f.optional && hasValue((o.values || {})[f.name])) shown.add(f.name); }));
        container.innerHTML = `
            <div class="b24-new">
                <div class="b24-new-head"><h1 class="b24-new-title">${esc(o.title)}</h1></div>
                <div class="b24-new-stages" data-stages role="radiogroup" aria-label="Stage"${stages ? '' : ' hidden'}></div>
                <div class="b24-card-tabs" role="tablist"><button type="button" role="tab" class="on" aria-selected="true">General</button></div>
                <div class="b24-new-cols">
                    <div class="b24-new-fields" data-sections></div>
                    <aside class="b24-new-side" aria-label="Activity">
                        <div class="b24-new-hint"><span class="dot" aria-hidden="true">i</span><div><b>Add a new activity</b><span>After saving, plan the next step here: calls, meetings, tasks, emails and comments.</span></div></div>
                        <div class="b24-new-today"><span>Today</span></div>
                        <div class="b24-new-note">${esc(o.note || 'You are now adding a record…')}</div>
                    </aside>
                </div>
                <div class="b24-new-foot">
                    <button type="button" class="b24-btn-create" data-save>Save</button>
                    <button type="button" class="b24-new-cancel" data-cancel>Cancel</button>
                    <span class="b24-new-err" data-err role="alert" hidden></span>
                </div>
            </div>`;
        const sectionsEl = container.querySelector('[data-sections]'), errEl = container.querySelector('[data-err]');
        const forms = [];
        function renderStages() {
            const el = container.querySelector('[data-stages]');
            el.hidden = !stages || !stages.length;
            if (el.hidden) return;
            const at = stages.findIndex(s => s.key === stage);
            el.innerHTML = stages.map((s, i) => `<button type="button" role="radio" aria-checked="${s.key === stage}" data-stage="${esc(s.key)}" class="${i <= at ? 'on' : ''}" style="--c:${/^#[0-9a-f]{3,8}$/i.test(s.hex || '') ? s.hex : '#2fc6f6'}" title="${esc(s.title)}"><span>${esc(s.title)}</span></button>`).join('');
        }
        function renderSections() {
            const values = forms.length ? api.get() : (o.values || {});
            forms.length = 0;
            sectionsEl.innerHTML = '';
            (o.sections || []).forEach((s, si) => {
                const visible = s.fields.filter(f => !f.optional || shown.has(f.name));
                const hidden = s.fields.filter(f => f.optional && !shown.has(f.name));
                const sec = document.createElement('section');
                sec.className = 'b24-sect b24-new-sect';
                sec.innerHTML = `<header><h3>${esc(s.title)}</h3></header><div data-form></div>
                    <footer class="b24-new-sect-foot">${hidden.length ? `<button type="button" class="b24-link" data-select-field="${si}">Select field ▾</button>` : ''}${o.createFieldHref && si === (o.sections.length - 1) ? `<a class="b24-link" href="${esc(o.createFieldHref)}" target="_blank" rel="noopener">Create field</a>` : ''}</footer>`;
                const f = C().form(visible, values);
                sec.querySelector('[data-form]').appendChild(f.el);
                sectionsEl.appendChild(sec);
                forms.push({ form: f, fields: visible });
                visible.forEach(spec => {
                    const w = f.field(spec.name); if (!w || !o.onChange) return;
                    const node = w.el && (w.el.matches && w.el.matches('input, select, textarea') ? w.el : w.el.querySelector && w.el.querySelector('input, select, textarea'));
                    if (node) node.addEventListener('change', () => o.onChange(spec.name, w.get(), api));
                });
                if (!sec.querySelector('.b24-new-sect-foot').children.length) sec.querySelector('.b24-new-sect-foot').remove();
            });
        }
        container.querySelector('[data-stages]').addEventListener('click', e => {
            const b = e.target.closest('[data-stage]'); if (!b) return;
            stage = b.dataset.stage; renderStages();
            if (o.onChange) o.onChange(o.stageField || 'stage', stage, api);
        });
        sectionsEl.addEventListener('click', e => {
            const b = e.target.closest('[data-select-field]'); if (!b) return;
            const s = o.sections[Number(b.dataset.selectField)];
            C().menu(b, s.fields.filter(f => f.optional && !shown.has(f.name)).map(f => ({ label: f.label, onClick: () => {
                shown.add(f.name); renderSections();
                const w = api.field(f.name); const node = w && w.wrap && w.wrap.querySelector('input, select, textarea'); if (node) node.focus();
            } })));
        });
        async function save() {
            if (busy) return;
            errEl.hidden = true;
            if (!api.validate()) { errEl.textContent = 'Fill in the fields marked in red.'; errEl.hidden = false; return; }
            busy = true;
            const btn = container.querySelector('[data-save]'); btn.disabled = true; btn.textContent = 'Saving…';
            try { await o.onSave(api.get()); }
            catch (e) { if (!e.silent) { errEl.textContent = e.message || String(e); errEl.hidden = false; } }
            finally { busy = false; if (btn.isConnected) { btn.disabled = false; btn.textContent = 'Save'; } }
        }
        container.querySelector('[data-save]').addEventListener('click', save);
        container.querySelector('[data-cancel]').addEventListener('click', () => { if (o.onCancel) o.onCancel(); });
        container.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); } });
        const api = {
            get() {
                const out = {};
                forms.forEach(x => Object.assign(out, x.form.get()));
                if (stages && stages.length) out[o.stageField || 'stage'] = stage;
                return out;
            },
            validate() { let ok = true; forms.forEach(x => { if (!x.form.validate()) ok = false; }); return ok; },
            field(name) { for (const x of forms) { const w = x.form.field(name); if (w) return w; } return null; },
            setStages(next, current) { stages = next; stage = current; renderStages(); },
            setSections(sections) { o.sections = sections; renderSections(); },
            focus() { const first = sectionsEl.querySelector('input:not([type=hidden]), select, textarea'); if (first) first.focus(); },
        };
        renderStages();
        renderSections();
        return api;
    }
    function hasValue(v) { return !(v == null || v === '' || (Array.isArray(v) && !v.length)); }

    window.WSCreate = { mount };
})();
