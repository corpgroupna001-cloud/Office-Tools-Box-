/* ============================================================================
   WorkSuite — record card (the Bitrix24-style entity card)

   Used for leads, deals, contacts, companies and invoices. It usually opens
   in a slide-over (WSShell.openSlider) and also works as a full page.

       const card = WSCard.mount(container, {
           title, number, subtitle, onRename(title) -> Promise, canEdit,
           stages: [{ key, title, hex, kind: 'open'|'won'|'lost' }], stage, canMove, onStage(key) -> Promise,
           actions: [{ label, icon, primary, onClick }], menu: [{ label, icon, danger, onClick } | 'sep'],
           tabs: [{ key, title, count, render(el) }],          // shown after the "General" tab
           sections: [{ title, fields: [{ key, title, type, value, display(value) -> html, options, entity, none, edit: false, save(value) -> Promise }] }],
           timeline: { entity_type, entity_id, links: { lead_id, deal_id, contact_id, project_id },
                       composer: [{ key, title, icon, onOpen }] },   // "Comment" is built in
       });
       card.refresh(opts)   // re-render with new options, keeping the open tab

   Field types are those of WSCrm.form (text, email, tel, url, number, money,
   date, datetime, textarea, select, people, tags, entity, check).
   ============================================================================ */
(function () {
    'use strict';
    if (window.WSCard) return;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const icon = (n, cls) => `<span class="ic ic-${esc(n)}${cls ? ' ' + cls : ''}" aria-hidden="true"></span>`;

    function isBlank(v) { return v == null || v === '' || (Array.isArray(v) && !v.length); }
    function defaultDisplay(f, v) {
        const C = window.WSCrm, L = window.WSCrmLogic;
        if (isBlank(v)) return '<span class="none">not filled in</span>';
        switch (f.type) {
            case 'email': return `<a href="mailto:${esc(v)}">${esc(v)}</a>`;
            case 'tel': return `<a href="tel:${esc(v)}">${esc(v)}</a>`;
            case 'url': return `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>`;
            case 'money': return esc(L ? L.money(v, f.currency || 'INR') : v);
            case 'date': return esc(L ? L.fmtDate(v) : v);
            case 'datetime': return esc(L ? L.fmtDateTime(v) : v);
            case 'people': return C ? C.personHtml(v) : esc(v);
            case 'tags': return C ? C.tagsHtml(v) : esc(v.join(', '));
            case 'check': return v ? 'Yes' : 'No';
            case 'textarea': return C ? C.linkify(C.nl2br(v)) : esc(v);
            case 'select': {
                const o = (f.options || []).map(x => typeof x === 'string' ? { value: x, label: x } : x).find(x => String(x.value) === String(v));
                return esc(o ? o.label : v);
            }
            default: return esc(v);
        }
    }

    function mount(container, initial) {
        let opts = initial;
        let tab = 'general';
        const loaded = {};
        container.classList.add('b24-card');

        function stagesHtml() {
            if (!opts.stages || !opts.stages.length) return '';
            const open = opts.stages.filter(s => s.kind !== 'won' && s.kind !== 'lost');
            const finals = opts.stages.filter(s => s.kind === 'won' || s.kind === 'lost');
            const cur = opts.stages.find(s => s.key === opts.stage) || null;
            const curIdx = cur ? open.indexOf(cur) : -1;
            const done = cur && cur.kind === 'won' ? open.length : curIdx;
            const btn = (s, i) => {
                const reached = cur && (s === cur || (i >= 0 && i < done));
                return `<button type="button" class="st${reached ? ' on' : ''}${s === cur ? ' cur' : ''}" data-stage="${esc(s.key)}" style="--c:${esc(s.hex || '#2fc6f6')}"${opts.canMove ? '' : ' disabled'} title="${esc(s.title)}"><span>${esc(s.title)}</span></button>`;
            };
            let fin = '';
            if (finals.length) {
                const f = cur && finals.includes(cur) ? cur : null;
                fin = `<button type="button" class="st final${f ? ' on cur ' + f.kind : ''}" data-final style="--c:${esc(f ? f.hex || (f.kind === 'won' ? '#7bd500' : '#ff5752') : '#c8ced4')}"${opts.canMove ? '' : ' disabled'}><span>${esc(f ? f.title : 'Final stage')}</span></button>`;
            }
            return `<div class="b24-stages" role="group" aria-label="Stage">${open.map((s, i) => btn(s, i)).join('')}${fin}</div>`;
        }
        function fieldHtml(f, si, fi) {
            const shown = f.display ? f.display(f.value) : defaultDisplay(f, f.value);
            const editable = opts.canEdit !== false && f.edit !== false && typeof f.save === 'function';
            return `<div class="b24-field${editable ? ' editable' : ''}" data-f="${si}:${fi}">
                <div class="lbl">${esc(f.title)}</div>
                <div class="val">${shown == null || shown === '' ? '<span class="none">not filled in</span>' : shown}</div>
                ${editable ? `<button type="button" class="pen" data-edit="${si}:${fi}" aria-label="Edit ${esc(f.title)}">${icon('edit', 'sm')}</button>` : ''}
            </div>`;
        }
        function render() {
            const tabs = [{ key: 'general', title: 'General' }].concat(opts.tabs || []);
            if (!tabs.some(t => t.key === tab)) tab = 'general';
            container.innerHTML = `
                <div class="b24-card-head">
                    <h1 class="b24-card-title"><span class="t" data-title>${esc(opts.title || '')}</span>${opts.number ? `<span class="num">#${esc(opts.number)}</span>` : ''}
                        ${opts.onRename && opts.canEdit !== false ? `<button type="button" class="pen" data-rename aria-label="Rename">${icon('edit', 'sm')}</button>` : ''}</h1>
                    ${opts.subtitle ? `<div class="sub">${opts.subtitle}</div>` : ''}
                    <div class="acts">
                        ${(opts.actions || []).map((a, i) => `<button type="button" class="${a.primary ? 'b24-btn-create' : 'b24-btn-card'}" data-act="${i}">${a.icon && !a.primary ? icon(a.icon) : ''}<span>${esc(a.label)}</span></button>`).join('')}
                        ${opts.menu && opts.menu.length ? `<button type="button" class="b24-btn-card round" data-menu aria-label="More actions">${icon('more')}</button>` : ''}
                    </div>
                </div>
                ${stagesHtml()}
                <div class="b24-card-tabs" role="tablist">${tabs.map(t => `<button type="button" role="tab" data-tab="${esc(t.key)}" class="${t.key === tab ? 'on' : ''}" aria-selected="${t.key === tab}">${esc(t.title)}${t.count ? `<span class="n">${esc(t.count)}</span>` : ''}</button>`).join('')}</div>
                <div class="b24-card-panel" data-panel="general"${tab === 'general' ? '' : ' hidden'}>
                    <div class="b24-card-cols">
                        <div class="b24-card-fields">
                            ${(opts.sections || []).map((s, si) => `<section class="b24-sect"><header><h3>${esc(s.title)}</h3></header>${s.fields.map((f, fi) => fieldHtml(f, si, fi)).join('')}</section>`).join('')}
                        </div>
                        <div class="b24-card-timeline">
                            ${opts.timeline ? `<div class="b24-composer">
                                <div class="tabs">${[{ key: 'comment', title: 'Comment', icon: 'chat' }].concat(opts.timeline.composer || []).map((c, i) => `<button type="button" data-compose="${i}" class="${i === 0 ? 'on' : ''}">${esc(c.title)}</button>`).join('')}</div>
                                <div class="box" data-composer></div>
                            </div>
                            <div class="b24-timeline" data-feed></div>` : ''}
                        </div>
                    </div>
                </div>
                ${(opts.tabs || []).map(t => `<div class="b24-card-panel b24-area pad" data-panel="${esc(t.key)}"${tab === t.key ? '' : ' hidden'}></div>`).join('')}`;
            loaded.general = false;
            Object.keys(loaded).forEach(k => { loaded[k] = false; });
            wireTimeline();
            if (tab !== 'general') loadTab(tab);
        }
        function wireTimeline() {
            const C = window.WSCrm, t = opts.timeline;
            if (!t || !C) return;
            const feedEl = container.querySelector('[data-feed]');
            const links = Object.assign({}, t.links || {});
            const feed = C.activityFeed(feedEl, Object.assign({ entity_type: t.entity_type, entity_id: t.entity_id, limit: 60 }, links));
            C.comments(container.querySelector('[data-composer]'), { entity_type: t.entity_type, entity_id: t.entity_id, onPosted: () => feed.reload() });
            api.feed = feed;
        }
        function loadTab(key) {
            if (loaded[key]) return;
            const t = (opts.tabs || []).find(x => x.key === key);
            if (!t) return;
            loaded[key] = true;
            t.render(container.querySelector(`[data-panel="${CSS.escape(key)}"]`));
        }
        function editField(si, fi) {
            const C = window.WSCrm;
            const f = opts.sections[si].fields[fi];
            const box = container.querySelector(`[data-f="${si}:${fi}"]`);
            if (!box || box.classList.contains('editing')) return;
            box.classList.add('editing');
            const spec = { name: 'v', label: f.title, type: f.type || 'text', options: f.options, entity: f.entity, none: f.none, full: true, placeholder: f.placeholder, required: !!f.required, rows: f.rows };
            const frm = C.form([spec], { v: f.value });
            box.querySelector('.val').replaceWith(Object.assign(document.createElement('div'), { className: 'val' }));
            const val = box.querySelector('.val');
            val.appendChild(frm.el);
            const btns = document.createElement('div');
            btns.className = 'b24-field-btns';
            btns.innerHTML = '<button type="button" class="ws-btn sm primary" data-ok>Save</button><button type="button" class="ws-btn sm" data-no>Cancel</button>';
            val.appendChild(btns);
            const pen = box.querySelector('.pen'); if (pen) pen.hidden = true;
            const first = val.querySelector('input:not([type=hidden]), select, textarea'); if (first) first.focus();
            const cancel = () => render();
            const ok = async () => {
                if (!frm.validate()) return;
                const v = frm.get().v;
                btns.querySelectorAll('button').forEach(b => { b.disabled = true; });
                try { await f.save(v); f.value = v; render(); if (api.feed) api.feed.reload(); }
                catch (e) { btns.querySelectorAll('button').forEach(b => { b.disabled = false; }); C.toast(e.message || 'Could not save', 'bad'); }
            };
            btns.querySelector('[data-ok]').addEventListener('click', ok);
            btns.querySelector('[data-no]').addEventListener('click', cancel);
            val.addEventListener('keydown', e => {
                if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
                if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); ok(); }
            });
        }
        async function rename() {
            const h = container.querySelector('[data-title]');
            const input = document.createElement('input');
            input.type = 'text'; input.value = opts.title || ''; input.className = 'b24-rename'; input.setAttribute('aria-label', 'Title');
            h.replaceWith(input);
            input.focus(); input.select();
            let done = false;
            const finish = async save => {
                if (done) return; done = true;
                const v = input.value.trim();
                if (save && v && v !== opts.title) {
                    try { await opts.onRename(v); opts.title = v; } catch (e) { window.WSCrm && WSCrm.toast(e.message || 'Could not rename', 'bad'); }
                }
                render();
            };
            input.addEventListener('keydown', e => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') { e.stopPropagation(); finish(false); } });
            input.addEventListener('blur', () => finish(true));
        }
        async function moveTo(key) {
            if (!opts.onStage || key === opts.stage) return;
            const prev = opts.stage;
            opts.stage = key; render();
            try { await opts.onStage(key); if (api.feed) api.feed.reload(); }
            catch (e) { opts.stage = prev; render(); if (!(e && e.silent) && window.WSCrm) WSCrm.toast(e.message || 'Could not change the stage', 'bad'); }
        }
        function finalMenu(anchor) {
            const finals = opts.stages.filter(s => s.kind === 'won' || s.kind === 'lost');
            popMenu(anchor, finals.map(s => ({ label: s.title, icon: s.kind === 'won' ? 'check' : 'x', danger: s.kind === 'lost', onClick: () => moveTo(s.key) })));
        }
        function popMenu(anchor, items) {
            document.querySelectorAll('.b24-pop').forEach(p => p.remove());
            const pop = document.createElement('div');
            pop.className = 'b24-pop b24-menu';
            pop.setAttribute('role', 'menu');
            pop.innerHTML = items.map((it, i) => it === 'sep' ? '<hr>' : `<button type="button" role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}">${it.icon ? icon(it.icon) : ''}${esc(it.label)}</button>`).join('');
            document.body.appendChild(pop);
            const r = anchor.getBoundingClientRect();
            pop.style.left = Math.max(8, Math.min(r.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 8)) + 'px';
            pop.style.top = Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8) + 'px';
            const close = () => { pop.remove(); document.removeEventListener('mousedown', out, true); document.removeEventListener('keydown', key, true); };
            const out = e => { if (!pop.contains(e.target)) close(); };
            const key = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus(); } };
            setTimeout(() => { document.addEventListener('mousedown', out, true); document.addEventListener('keydown', key, true); }, 0);
            pop.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (!b) return; close(); const it = items[Number(b.dataset.i)]; if (it.onClick) it.onClick(); });
            const f = pop.querySelector('button'); if (f) f.focus();
        }

        container.addEventListener('click', e => {
            const t = e.target;
            const st = t.closest('[data-stage]'); if (st && !st.disabled) return moveTo(st.dataset.stage);
            const fin = t.closest('[data-final]'); if (fin && !fin.disabled) return finalMenu(fin);
            const tb = t.closest('[data-tab]');
            if (tb) {
                tab = tb.dataset.tab;
                container.querySelectorAll('[data-tab]').forEach(b => { b.classList.toggle('on', b === tb); b.setAttribute('aria-selected', String(b === tb)); });
                container.querySelectorAll('.b24-card-panel').forEach(p => { p.hidden = p.dataset.panel !== tab; });
                return loadTab(tab);
            }
            const ed = t.closest('[data-edit]'); if (ed) { const [si, fi] = ed.dataset.edit.split(':').map(Number); return editField(si, fi); }
            const fv = t.closest('.b24-field.editable:not(.editing) .val');
            if (fv && !t.closest('a, button')) { const [si, fi] = fv.parentNode.dataset.f.split(':').map(Number); return editField(si, fi); }
            if (t.closest('[data-rename]')) return rename();
            const act = t.closest('[data-act]'); if (act) { const a = opts.actions[Number(act.dataset.act)]; if (a && a.onClick) a.onClick(act); return; }
            const mb = t.closest('[data-menu]'); if (mb) return popMenu(mb, opts.menu);
            const cp = t.closest('[data-compose]');
            if (cp) {
                const i = Number(cp.dataset.compose);
                if (i === 0) return;
                const c = opts.timeline.composer[i - 1];
                if (c && c.onOpen) c.onOpen();
            }
        });

        const api = {
            feed: null,
            refresh(next) { opts = Object.assign({}, opts, next || {}); render(); },
            get tab() { return tab; },
            showTab(key) { tab = key; render(); },
            setCount(key, n) { const t = (opts.tabs || []).find(x => x.key === key); if (t) t.count = n; const b = container.querySelector(`[data-tab="${CSS.escape(key)}"]`); if (b) { let s = b.querySelector('.n'); if (!s && n) { s = document.createElement('span'); s.className = 'n'; b.appendChild(s); } if (s) { s.textContent = n || ''; s.hidden = !n; } } },
        };
        render();
        return api;
    }

    window.WSCard = { mount, display: defaultDisplay };
})();
