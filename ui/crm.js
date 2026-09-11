/* ============================================================================
   WorkSuite — shared CRM / work runtime (browser)

   Include on every CRM page AFTER supabase-js, /ui/crm-logic.js, /dialogs.js
   and /ui/shell.js:

       <script src="/ui/crm.js"></script>
       <script>
         (async () => {
           const ctx = await WSCrm.boot({ active: 'contacts', crumb: 'Contacts' });
           ...
         })();
       </script>

   What it gives a page
     boot()          the shared Supabase client, the signed-in user's profile
                     and workspace role, the people directory, the lookups
     q()/friendly()  query wrapper with user-safe error messages
     modal/form      one dialog implementation, keyboard accessible
     table()         sortable, paged table that collapses to cards on phones
     activityFeed()  the shared timeline (crm_activities + comments)
     comments()      notes with @mentions
     documents()     attach / upload / preview files with one storage path
     openTaskEditor() / openEventEditor()   quick-create from any record
     pickers         people and CRM-entity selectors
     subscribe()     Realtime with automatic cleanup on page unload
   Everything renders with the existing design system (ui/app.css) plus
   ui/crm.css. Nothing here talks to /api except push notifications.
   ============================================================================ */
(function () {
    'use strict';
    if (window.WSCrm) return;

    const L = window.WSCrmLogic;
    const state = {
        sb: null, session: null, user: null, people: [], peopleById: new Map(),
        lookups: null, lookupsPromise: null, channels: [], booted: null, migrationMissing: false,
    };

    /* ------------------------------------------------------------ utils */
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const $ = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
    const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x' + Math.random().toString(36).slice(2) + Date.now().toString(36));
    function debounce(fn, ms) { let t; return function () { clearTimeout(t); const a = arguments, c = this; t = setTimeout(() => fn.apply(c, a), ms || 250); }; }
    function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
    function param(name) { return new URLSearchParams(location.search).get(name); }
    function setParam(name, value, replace) {
        const u = new URL(location.href);
        if (value == null || value === '') u.searchParams.delete(name); else u.searchParams.set(name, value);
        history[replace ? 'replaceState' : 'pushState'](null, '', u.pathname + (u.search || '') + u.hash);
    }
    function toast(msg, kind) { if (window.WSShell && WSShell.toast) WSShell.toast(msg, kind); else console.log('[toast]', msg); }
    function icon(name, cls) { return `<span class="ic ic-${esc(name)}${cls ? ' ' + esc(cls) : ''}" aria-hidden="true"></span>`; }
    function nl2br(s) { return esc(s).replace(/\n/g, '<br>'); }
    function linkify(escaped) {
        return escaped.replace(/(https?:\/\/[^\s<]+)/g, m => `<a href="${m}" target="_blank" rel="noopener" class="crm-link">${m}</a>`);
    }

    /* ------------------------------------------------------- errors */
    const FRIENDLY = {
        '42P01': 'This module is not set up yet: the CRM database migration has not been run.',
        'PGRST205': 'This module is not set up yet: the CRM database migration has not been run.',
        '42703': 'The database is missing a column this page needs. Run the latest CRM migration.',
        '42501': 'You do not have permission to do that.',
        '23505': 'That record already exists.',
        '23503': 'This record is still linked to other records and cannot be removed.',
        '23514': 'One of the values is not allowed.',
        '22P02': 'One of the values has the wrong format.',
        'PGRST116': 'That record was not found.',
        'PGRST301': 'Your session has expired. Sign in again.',
        '401': 'Your session has expired. Sign in again.',
    };
    function friendly(error) {
        if (!error) return 'Something went wrong.';
        const code = String(error.code || error.status || '');
        if (code === 'P0001' || code === 'P0002') return error.message || 'That change was not allowed.';   // raise exception in our own triggers
        if (FRIENDLY[code]) return FRIENDLY[code];
        if (/Failed to fetch|NetworkError|Load failed/i.test(error.message || '')) return 'Could not reach the server. Check your connection and try again.';
        if (/JWT|token/i.test(error.message || '')) return FRIENDLY['401'];
        return 'Something went wrong. Please try again.';
    }
    function isMissingSchema(error) { const c = String(error && (error.code || '')); return c === '42P01' || c === 'PGRST205' || c === '42703'; }
    /** Await a supabase-js builder; throw an Error with a user-safe message. */
    async function q(builder) {
        const res = await builder;
        if (res.error) {
            console.warn('[crm]', res.error);
            const e = new Error(friendly(res.error));
            e.code = res.error.code; e.raw = res.error;
            if (isMissingSchema(res.error)) state.migrationMissing = true;
            throw e;
        }
        return res;
    }

    /* --------------------------------------------------------- boot */
    async function waitFor(test, tries, every) {
        for (let i = 0; i < (tries || 100); i++) { if (test()) return true; await new Promise(r => setTimeout(r, every || 100)); }
        return test();
    }
    async function client() {
        if (state.sb) return state.sb;
        await waitFor(() => window.supabase && window.supabase.createClient, 100);
        let sb = window.__WS_SB__ || window.__WS_PRESENCE_SB__ || null;
        if (!sb) {
            const cfg = await (await fetch('/api/config')).json();
            if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) throw new Error('Supabase is not configured');
            sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
            window.__WS_SB__ = sb;
        }
        state.sb = sb;
        return sb;
    }
    async function loadMe(sb, session) {
        const base = { id: session.user.id, email: session.user.email, name: session.user.user_metadata?.full_name || session.user.email.split('@')[0], avatar: session.user.user_metadata?.avatar_url || '', company: session.user.user_metadata?.company || '', company2: '', role: 'employee', manager_id: null };
        try {
            const { data, error } = await sb.from('profiles')
                .select('id, full_name, email, avatar_url, company, company2, app_role, manager_id, department, job_title, employee_code, status, is_wfh')
                .eq('id', session.user.id).maybeSingle();
            if (error) throw error;
            if (data) return { ...base, name: data.full_name || base.name, email: data.email || base.email, avatar: data.avatar_url || '', company: data.company || '', company2: data.company2 || '', role: data.app_role || 'employee', manager_id: data.manager_id, department: data.department, job_title: data.job_title, employee_code: data.employee_code, status: data.status, is_wfh: data.is_wfh };
        } catch (e) {
            // app_role does not exist before the foundation migration: fall back to the columns that do.
            if (String(e.code) === '42703') {
                state.migrationMissing = true;
                try {
                    const { data } = await sb.from('profiles').select('id, full_name, email, avatar_url, company, company2, manager_id').eq('id', session.user.id).maybeSingle();
                    if (data) return { ...base, name: data.full_name || base.name, avatar: data.avatar_url || '', company: data.company || '', company2: data.company2 || '', manager_id: data.manager_id };
                } catch (e2) { /* keep base */ }
            } else console.warn('[crm] profile', e);
        }
        return base;
    }
    async function loadPeople(sb) {
        try {
            const { data, error } = await sb.from('profiles')
                .select('id, full_name, email, avatar_url, company, company2, department, job_title, status, last_seen_at, manager_id, employee_code, joining_date, is_wfh, phone, shift_id')
                .order('full_name').limit(1000);
            if (error) throw error;
            state.people = (data || []).map(p => ({ ...p, name: p.full_name || (p.email || '').split('@')[0] || 'Unknown' }));
        } catch (e) {
            console.warn('[crm] people', e);
            try {
                const { data } = await sb.from('profiles').select('id, full_name, email, avatar_url, company, last_seen_at').order('full_name').limit(1000);
                state.people = (data || []).map(p => ({ ...p, name: p.full_name || (p.email || '').split('@')[0] || 'Unknown', status: 'active' }));
            } catch (e2) { state.people = []; }
        }
        state.peopleById = new Map(state.people.map(p => [p.id, p]));
    }
    /**
     * boot({ active, crumb, title, subtitle, tools, pageClass, requireRole? })
     * Mounts the shell if the page has not, resolves the session and profile,
     * and returns the context. Redirects to / when signed out.
     */
    function boot(opts) {
        if (state.booted) return state.booted;
        state.booted = (async () => {
            opts = opts || {};
            if (window.WSShell && !document.querySelector('.ws-shell')) WSShell.mount(opts);
            const sb = await client();
            const { data: { session } } = await sb.auth.getSession();
            if (!session) { location.replace('/'); return new Promise(() => {}); }
            state.session = session;
            state.user = await loadMe(sb, session);
            await loadPeople(sb);
            sb.auth.onAuthStateChange((ev, s) => {
                if (ev === 'SIGNED_OUT') location.replace('/');
                else if (s) state.session = s;
            });
            try { if (window.WSPush && WSPush.init) WSPush.init(sb); } catch (e) { /* optional */ }
            window.addEventListener('pagehide', unsubscribeAll);
            return ctx();
        })();
        return state.booted;
    }
    function ctx() {
        return {
            sb: state.sb, session: state.session, user: state.user, people: state.people, peopleById: state.peopleById,
            isManager: L.isManager(state.user), isAdmin: L.isAdmin(state.user), migrationMissing: state.migrationMissing,
        };
    }

    /* --------------------------------------------------------- lookups */
    /** task statuses, lead statuses, pipelines and stages — loaded once. */
    function lookups(force) {
        if (state.lookups && !force) return Promise.resolve(state.lookups);
        if (state.lookupsPromise && !force) return state.lookupsPromise;
        state.lookupsPromise = (async () => {
            const sb = await client();
            const get = async (table, order) => { try { const r = await sb.from(table).select('*').order(order || 'sort_order'); return r.error ? [] : (r.data || []); } catch (e) { return []; } };
            const [taskStatuses, leadStatuses, pipelines, stages] = await Promise.all([
                get('task_statuses'), get('crm_lead_statuses'), get('crm_pipelines', 'created_at'), get('crm_pipeline_stages', 'position'),
            ]);
            state.lookups = {
                taskStatuses, leadStatuses, pipelines, stages,
                taskStatus: Object.fromEntries(taskStatuses.map(s => [s.key, s])),
                leadStatus: Object.fromEntries(leadStatuses.map(s => [s.key, s])),
                stageById: Object.fromEntries(stages.map(s => [s.id, s])),
                defaultPipeline: pipelines.find(p => p.is_default && p.company === (state.user && state.user.company)) || pipelines.find(p => p.is_default) || pipelines[0] || null,
            };
            return state.lookups;
        })();
        return state.lookupsPromise;
    }

    /* ---------------------------------------------------------- people */
    function person(id) { return id ? state.peopleById.get(id) || null : null; }
    function personName(id, fallback) { const p = person(id); return p ? p.name : (fallback || (id ? 'Former employee' : 'Unassigned')); }
    function activePeople() { return state.people.filter(p => (p.status || 'active') !== 'inactive'); }
    function avatarHtml(p, cls) {
        const who = typeof p === 'string' ? person(p) : p;
        const name = who ? (who.name || who.full_name || who.email || '?') : '?';
        const c = 'ws-avatar' + (cls ? ' ' + cls : '');
        if (who && who.avatar_url) return `<span class="${c}"><img src="${esc(who.avatar_url)}" alt=""></span>`;
        return `<span class="${c}" title="${esc(name)}">${esc(L.initials(name))}</span>`;
    }
    function personHtml(id, opts) {
        const p = person(id);
        if (!p) return `<span class="crm-person muted"><span class="ws-avatar">?</span><span class="nm">${esc(id ? 'Former employee' : (opts && opts.none) || 'Unassigned')}</span></span>`;
        const inner = `${avatarHtml(p)}<span class="nm">${esc(p.name)}</span>`;
        return opts && opts.link === false ? `<span class="crm-person">${inner}</span>` : `<a class="crm-person link" href="/employees/?id=${esc(p.id)}">${inner}</a>`;
    }
    function avatarsHtml(ids, max) {
        const list = (ids || []).filter(Boolean);
        const shown = list.slice(0, max || 4);
        const extra = list.length - shown.length;
        return `<span class="crm-avatars">${shown.map(id => avatarHtml(id)).join('')}${extra > 0 ? `<span class="ws-avatar" title="${extra} more">+${extra}</span>` : ''}</span>`;
    }
    /** <option>s for a single-person select. */
    function peopleOptions(selected, opts) {
        const none = opts && opts.none !== undefined ? opts.none : 'Unassigned';
        const list = (opts && opts.people) || activePeople();
        const groups = new Map();
        list.forEach(p => { const g = p.company || 'Other'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(p); });
        let html = none === null ? '' : `<option value="">${esc(none)}</option>`;
        const one = groups.size <= 1;
        for (const [g, ps] of groups) {
            if (!one) html += `<optgroup label="${esc(g)}">`;
            html += ps.map(p => `<option value="${esc(p.id)}"${p.id === selected ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
            if (!one) html += '</optgroup>';
        }
        return html;
    }
    /** Multi-person picker: returns { el, get(), set(ids) }. */
    function peoplePicker(selectedIds, opts) {
        let ids = (selectedIds || []).filter(Boolean);
        const el = h('<div class="crm-people-pick"></div>');
        function render() {
            const exclude = new Set(ids);
            el.innerHTML = ids.map(id => `<span class="crm-tag">${esc(personName(id))}<button type="button" data-rm="${esc(id)}" aria-label="Remove">×</button></span>`).join('') +
                `<select aria-label="${esc((opts && opts.label) || 'Add person')}"><option value="">${esc((opts && opts.placeholder) || '+ Add person…')}</option>${activePeople().filter(p => !exclude.has(p.id)).map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>`;
        }
        el.addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) { ids = ids.filter(x => x !== b.dataset.rm); render(); el.dispatchEvent(new Event('change')); } });
        el.addEventListener('change', e => { if (e.target.tagName === 'SELECT' && e.target.value) { ids.push(e.target.value); render(); el.dispatchEvent(new Event('change')); } });
        render();
        return { el, get: () => ids.slice(), set: v => { ids = (v || []).slice(); render(); } };
    }

    /* ------------------------------------------------------ badges etc */
    function badge(color, label, extraCls) {
        return `<span class="ws-badge ${esc(color || 'mute')}${extraCls ? ' ' + esc(extraCls) : ''}">${esc(label)}</span>`;
    }
    function statusBadge(map, key) { const m = map && map[key]; return badge(m ? m.color : 'mute', m ? m.label : String(key || '').replace(/_/g, ' ')); }
    function priorityBadge(key) { return statusBadge(L.PRIORITY, key || 'normal'); }
    function dueHtml(task, today) {
        const st = L.taskDueState(task, today);
        if (!task.due_date) return '<span class="muted">—</span>';
        const label = st === 'overdue' ? `Overdue · ${L.fmtDate(task.due_date, { short: true })}` : st === 'today' ? 'Due today' : L.fmtDate(task.due_date, { short: true });
        return `<span class="crm-due ${st}">${esc(label)}</span>`;
    }
    function tagsHtml(tags) { return tags && tags.length ? `<span class="crm-tags">${tags.map(t => `<span class="crm-tag">${esc(t)}</span>`).join('')}</span>` : ''; }
    const ENTITY_META = {
        contact: { icon: 'user', path: '/contacts/', label: 'Contact' },
        lead: { icon: 'target', path: '/leads/', label: 'Lead' },
        deal: { icon: 'deal', path: '/deals/', label: 'Deal' },
        project: { icon: 'folder', path: '/projects/', label: 'Project' },
        task: { icon: 'check', path: '/tasks/', label: 'Task' },
        board: { icon: 'board', path: '/boards/', label: 'Board' },
        document: { icon: 'doc', path: '/documents/', label: 'Document' },
        event: { icon: 'calendar', path: '/calendar/', label: 'Meeting' },
        invoice: { icon: 'invoice', path: '/invoices/', label: 'Invoice' },
        employee: { icon: 'users', path: '/employees/', label: 'Employee' },
        conversation: { icon: 'chat', path: '/chat/#group=', label: 'Group' },
    };
    function entityUrl(type, id) { const m = ENTITY_META[type]; if (!m) return '#'; return m.path.endsWith('=') ? m.path + encodeURIComponent(id) : `${m.path}?id=${encodeURIComponent(id)}`; }
    function entityChip(type, id, label) {
        if (!id) return '';
        const m = ENTITY_META[type] || { icon: 'link', label: type };
        return `<a class="crm-entity" href="${esc(entityUrl(type, id))}" title="${esc(m.label)}">${icon(m.icon)}<span>${esc(label || m.label)}</span></a>`;
    }

    /* ------------------------------------------------------- states */
    function loading(el, text) { if (el) el.innerHTML = `<div class="ws-empty"><span class="ws-skel" style="display:block;height:14px;width:60%;margin:0 auto 10px"></span>${esc(text || 'Loading…')}</div>`; }
    function skeletonRows(el, n) { if (el) el.innerHTML = `<div class="crm-skel-rows" style="padding:14px 20px">${Array.from({ length: n || 5 }, (_, i) => `<span class="ws-skel" style="display:block;width:${90 - i * 9}%"></span>`).join('')}</div>`; }
    function empty(el, title, sub, actionHtml) { if (el) el.innerHTML = `<div class="ws-empty"><b>${esc(title || 'Nothing here yet')}</b>${sub ? `<div>${esc(sub)}</div>` : ''}${actionHtml ? `<div style="margin-top:12px">${actionHtml}</div>` : ''}</div>`; }
    function errorState(el, err, retry) {
        if (!el) return;
        const msg = typeof err === 'string' ? err : (err && err.message) || 'Something went wrong.';
        const missing = err && (isMissingSchema(err.raw || err) || /not set up yet/.test(msg));
        el.innerHTML = missing ? migrationNoticeHtml() :
            `<div class="ws-empty"><b>Could not load</b><div>${esc(msg)}</div>${retry ? '<div style="margin-top:12px"><button type="button" class="ws-btn sm" data-retry>Try again</button></div>' : ''}</div>`;
        const b = el.querySelector('[data-retry]'); if (b && retry) b.addEventListener('click', retry);
    }
    function migrationNoticeHtml() {
        return `<div class="crm-notice">${icon('lock')}<div><b>This module is not set up yet.</b><br>An administrator needs to run the CRM migrations in Supabase → SQL Editor, in this order: <code>supabase-crm-foundation-migration.sql</code>, <code>supabase-work-migration.sql</code>, <code>supabase-invoices-migration.sql</code>, <code>supabase-messenger-migration.sql</code>. Existing data is not affected.</div></div>`;
    }

    /* ---------------------------------------------------------- dialogs */
    async function confirm(opts) {
        if (window.wsDialog && wsDialog.confirm) return wsDialog.confirm({ icon: opts.danger ? '⚠️' : 'ℹ️', title: opts.title, message: esc(opts.message || ''), okText: opts.okText || 'Confirm', cancelText: opts.cancelText || 'Cancel', danger: !!opts.danger });
        return window.confirm(`${opts.title}\n\n${opts.message || ''}`);
    }
    async function alert(opts) {
        if (window.wsDialog && wsDialog.alert) return wsDialog.alert({ icon: opts.danger ? '⚠️' : 'ℹ️', title: opts.title, message: esc(opts.message || ''), danger: !!opts.danger });
        window.alert(`${opts.title}\n\n${opts.message || ''}`);
    }
    let modalStack = [];
    /**
     * modal({ title, body (html | node), actions: [{ label, primary, danger, onClick(api), close: true }], size: 'wide'|'xwide', onClose })
     * Returns api { el, body, close(), setMessage(text, ok), busy(bool) }.
     */
    function modal(opts) {
        const wrap = h(`<div class="crm-modal" role="dialog" aria-modal="true" aria-label="${esc(opts.title || 'Dialog')}" data-ws-outside>
            <div class="scrim"></div>
            <div class="panel${opts.size ? ' ' + esc(opts.size) : ''}">
                <div class="head"><h2></h2><button type="button" class="x" aria-label="Close">✕</button></div>
                <div class="body"></div>
                <div class="foot" hidden><span class="msg" hidden></span><span class="spacer"></span></div>
            </div></div>`);
        wrap.querySelector('h2').textContent = opts.title || '';
        const body = wrap.querySelector('.body');
        if (typeof opts.body === 'string') body.innerHTML = opts.body; else if (opts.body) body.appendChild(opts.body);
        const foot = wrap.querySelector('.foot');
        const msg = foot.querySelector('.msg');
        const api = {
            el: wrap, body,
            close(result) { if (!wrap.parentNode) return; wrap.remove(); modalStack = modalStack.filter(m => m !== api); document.body.style.overflow = modalStack.length ? 'hidden' : ''; if (opts.onClose) opts.onClose(result); if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch (e) {} },
            setMessage(text, ok) { msg.hidden = !text; msg.textContent = text || ''; msg.classList.toggle('ok', !!ok); foot.hidden = false; },
            busy(on) { $$('button', foot).forEach(b => { b.disabled = !!on; if (b.dataset.primary) b.classList.toggle('busy', !!on); }); },
        };
        (opts.actions || []).forEach(a => {
            const b = h(`<button type="button" class="ws-btn${a.primary ? ' primary' : ''}${a.danger ? ' danger' : ''}${a.ghost ? ' ghost' : ''}">${esc(a.label)}</button>`);
            if (a.primary) b.dataset.primary = '1';
            b.addEventListener('click', async () => {
                if (a.close) return api.close(a.value);
                if (!a.onClick) return;
                try { api.busy(true); await a.onClick(api); } catch (e) { api.setMessage(e.message || String(e)); } finally { if (wrap.parentNode) api.busy(false); }
            });
            foot.appendChild(b);
            foot.hidden = false;
        });
        const prevFocus = document.activeElement;
        wrap.querySelector('.x').addEventListener('click', () => api.close());
        wrap.querySelector('.scrim').addEventListener('click', () => { if (!opts.sticky) api.close(); });
        wrap.addEventListener('keydown', e => {
            if (e.key === 'Escape') { e.stopPropagation(); api.close(); }
            if (e.key === 'Tab') {       // keep focus inside
                const f = $$('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', wrap).filter(x => x.offsetParent !== null);
                if (!f.length) return;
                const first = f[0], last = f[f.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { const p = foot.querySelector('[data-primary]'); if (p) p.click(); }
        });
        document.body.appendChild(wrap);
        document.body.style.overflow = 'hidden';
        modalStack.push(api);
        setTimeout(() => { const f = $('input:not([type=hidden]), select, textarea, button.primary', body) || wrap.querySelector('.x'); if (f) f.focus(); }, 30);
        return api;
    }

    /* ------------------------------------------------------------ forms */
    /**
     * Field spec: { name, label, type: text|email|tel|url|number|date|time|datetime|textarea|select|people|peoples|check|tags|entity|hidden|money|html,
     *               options: [{value,label}] | string[], value, required, placeholder, hint, full, entity: 'contact'|'lead'|'deal'|'project'|'document', min, max, step, disabled }
     * Renders into a .crm-form; returns { el, get(), set(values), validate(), field(name) }.
     */
    function form(fields, values) {
        const el = h('<form class="crm-form" novalidate></form>');
        const widgets = {};
        values = values || {};
        fields.forEach(f => {
            const v = values[f.name] !== undefined ? values[f.name] : (f.value !== undefined ? f.value : '');
            const id = 'f-' + f.name + '-' + uid().slice(0, 6);
            const wrap = h(`<div class="crm-field${f.full ? ' full' : ''}${f.type === 'hidden' ? '" hidden="' : ''}"></div>`);
            if (f.type !== 'check' && f.type !== 'hidden' && f.type !== 'html') wrap.innerHTML = `<label for="${id}">${esc(f.label || f.name)}${f.required ? '<span class="req">*</span>' : ''}</label>`;
            let input;
            const common = `id="${id}" name="${esc(f.name)}"${f.required ? ' required' : ''}${f.disabled ? ' disabled' : ''}${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}`;
            switch (f.type) {
                case 'textarea': input = h(`<textarea ${common} rows="${f.rows || 3}"></textarea>`); input.value = v || ''; break;
                case 'select': {
                    input = h(`<select ${common}></select>`);
                    const opts = (f.options || []).map(o => typeof o === 'string' ? { value: o, label: o } : o);
                    input.innerHTML = (f.placeholder && !f.required ? `<option value="">${esc(f.placeholder)}</option>` : '') + (f.required && f.placeholder ? `<option value="" disabled${v ? '' : ' selected'}>${esc(f.placeholder)}</option>` : '') +
                        opts.map(o => `<option value="${esc(o.value)}"${String(o.value) === String(v) ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
                    break;
                }
                case 'people': input = h(`<select ${common}></select>`); input.innerHTML = peopleOptions(v || '', { none: f.none !== undefined ? f.none : 'Unassigned' }); break;
                case 'peoples': { const pk = peoplePicker(v || [], { label: f.label }); input = pk.el; widgets[f.name] = { get: pk.get, set: pk.set, el: pk.el }; break; }
                case 'check': input = h(`<label class="crm-check"><input type="checkbox" ${common}> <span>${esc(f.label)}</span></label>`); input.querySelector('input').checked = !!v; break;
                case 'tags': input = h(`<input type="text" ${common}>`); input.value = Array.isArray(v) ? v.join(', ') : (v || ''); if (!f.hint) f.hint = 'Separate tags with commas'; break;
                case 'entity': { const ep = entityPicker(f.entity, v, f); input = ep.el; widgets[f.name] = ep; break; }
                case 'hidden': input = h(`<input type="hidden" ${common}>`); input.value = v == null ? '' : v; break;
                case 'html': input = h(`<div>${f.html || ''}</div>`); break;
                case 'money': input = h(`<input type="number" inputmode="decimal" step="0.01" min="0" ${common}>`); input.value = v == null ? '' : v; break;
                case 'datetime': {
                    input = h('<div class="inline"></div>');
                    const d = h(`<input type="date" id="${id}" name="${esc(f.name)}__date"${f.required ? ' required' : ''}>`), t = h(`<input type="time" name="${esc(f.name)}__time" aria-label="Time" step="300">`);
                    if (v) { d.value = L.istDate(v) || ''; t.value = L.istTime(v) || ''; }
                    input.append(d, t);
                    widgets[f.name] = { get: () => d.value ? L.isoAtIST(d.value, t.value || '00:00') : null, set: val => { d.value = val ? L.istDate(val) : ''; t.value = val ? L.istTime(val) : ''; }, el: input, date: d, time: t };
                    break;
                }
                default: input = h(`<input type="${esc(f.type || 'text')}" ${common}${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''}${f.step != null ? ` step="${f.step}"` : ''}>`); input.value = v == null ? '' : v;
            }
            wrap.appendChild(input);
            if (f.hint) wrap.appendChild(h(`<span class="hint">${esc(f.hint)}</span>`));
            wrap.appendChild(h('<span class="err" hidden></span>'));
            el.appendChild(wrap);
            if (!widgets[f.name]) widgets[f.name] = { el: input, get: () => {
                if (f.type === 'check') return input.querySelector('input').checked;
                if (f.type === 'tags') return L.parseTags(input.value);
                if (f.type === 'number' || f.type === 'money') return input.value === '' ? null : Number(input.value);
                return input.value === '' ? null : input.value;
            }, set: val => {
                if (f.type === 'check') input.querySelector('input').checked = !!val;
                else if (f.type === 'tags') input.value = Array.isArray(val) ? val.join(', ') : (val || '');
                else input.value = val == null ? '' : val;
            } };
            widgets[f.name].wrap = wrap; widgets[f.name].spec = f;
        });
        el.addEventListener('submit', e => e.preventDefault());
        const api = {
            el,
            field: name => widgets[name],
            get() { const o = {}; Object.entries(widgets).forEach(([k, w]) => { if (w.spec.type !== 'html') o[k] = w.get(); }); return o; },
            set(vals) { Object.entries(vals || {}).forEach(([k, v]) => { if (widgets[k]) widgets[k].set(v); }); },
            validate() {
                let ok = true, first = null;
                Object.values(widgets).forEach(w => {
                    const f = w.spec; const err = w.wrap.querySelector('.err'); let m = '';
                    const val = w.get();
                    if (f.required && (val == null || val === '' || (Array.isArray(val) && !val.length))) m = 'Required';
                    else if (val && f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) m = 'Enter a valid email address';
                    else if (val && f.type === 'url' && !/^https?:\/\//i.test(val)) m = 'Start with http:// or https://';
                    else if (f.validate) m = f.validate(val, api.get()) || '';
                    if (err) { err.hidden = !m; err.textContent = m; }
                    w.wrap.classList.toggle('invalid', !!m);
                    if (m) { ok = false; first = first || w; }
                });
                if (first) { const fo = $('input, select, textarea', first.wrap); if (fo) fo.focus(); }
                return ok;
            },
        };
        return api;
    }
    /** formModal({ title, fields, values, submitLabel, size, onSubmit(values, api) -> result, extra: node }) resolves with the result or undefined. */
    function formModal(opts) {
        return new Promise(resolve => {
            const f = form(opts.fields, opts.values);
            const body = document.createElement('div');
            if (opts.intro) body.appendChild(h(`<div style="margin-bottom:12px">${opts.intro}</div>`));
            body.appendChild(f.el);
            if (opts.extra) body.appendChild(opts.extra);
            let result;
            const m = modal({
                title: opts.title, body, size: opts.size, onClose: () => resolve(result),
                actions: [
                    ...(opts.secondary || []).map(a => ({ label: a.label, danger: a.danger, onClick: async api => { const r = await a.onClick(f.get(), api, f); if (r !== undefined) { result = r; api.close(); } } })),
                    { label: 'Cancel', close: true },
                    { label: opts.submitLabel || 'Save', primary: true, onClick: async api => {
                        if (!f.validate()) return;
                        const r = await opts.onSubmit(f.get(), api, f);
                        result = r === undefined ? true : r;
                        api.close();
                    } },
                ],
            });
            if (opts.onReady) opts.onReady(f, m);
        });
    }

    /* --------------------------------------------------- entity picker */
    const ENTITY_QUERY = {
        contact: { table: 'crm_contacts', select: 'id, full_name, organization, email', label: r => r.full_name || r.organization, sub: r => r.organization || r.email, search: 'full_name,organization,email' },
        lead: { table: 'crm_leads', select: 'id, name, organization, status', label: r => r.name, sub: r => r.organization, search: 'name,organization,email' },
        deal: { table: 'crm_deals', select: 'id, title, value, currency, status', label: r => r.title, sub: r => L.money(r.value, r.currency), search: 'title,organization' },
        project: { table: 'projects', select: 'id, name, status', label: r => r.name, sub: r => L.PROJECT_STATUS[r.status] ? L.PROJECT_STATUS[r.status].label : r.status, search: 'name' },
        document: { table: 'documents', select: 'id, name, mime_type, size_bytes', label: r => r.name, sub: r => L.fmtBytes(r.size_bytes), search: 'name' },
        task: { table: 'tasks', select: 'id, title, status', label: r => r.title, sub: r => r.status, search: 'title' },
        board: { table: 'boards', select: 'id, name, kind', label: r => r.name, sub: r => r.kind, search: 'name' },
        invoice: { table: 'invoices', select: 'id, invoice_number, total, currency, status', label: r => r.invoice_number, sub: r => L.money(r.total, r.currency), search: 'invoice_number,bill_to_name' },
    };
    async function searchEntities(type, term, limit) {
        const spec = ENTITY_QUERY[type]; if (!spec) return [];
        const sb = await client();
        let b = sb.from(spec.table).select(spec.select).is('archived_at', null).limit(limit || 8);
        const t = String(term || '').trim();
        if (t) b = b.or(spec.search.split(',').map(c => `${c}.ilike.%${t.replace(/[%,]/g, ' ')}%`).join(','));
        else b = b.order('created_at', { ascending: false });
        const r = await b;
        if (r.error) { if (!isMissingSchema(r.error)) console.warn('[crm] search', r.error); return []; }
        return (r.data || []).map(row => ({ id: row.id, label: spec.label(row) || '(untitled)', sub: spec.sub ? spec.sub(row) : '', row }));
    }
    async function entityLabel(type, id) {
        if (!id) return '';
        const spec = ENTITY_QUERY[type]; if (!spec) return id;
        const sb = await client();
        const r = await sb.from(spec.table).select(spec.select).eq('id', id).maybeSingle();
        return r.data ? spec.label(r.data) : '';
    }
    /** A search box that resolves to one record id. { el, get, set, onChange } */
    function entityPicker(type, value, spec) {
        const el = h(`<div class="crm-menu-host" style="display:block"><input type="text" autocomplete="off" placeholder="${esc((spec && spec.placeholder) || 'Search…')}"${spec && spec.disabled ? ' disabled' : ''}><input type="hidden"><div class="crm-menu" hidden style="left:0;right:auto;min-width:260px;max-height:260px;overflow:auto"></div></div>`);
        const input = el.querySelector('input[type=text]'), hidden = el.querySelector('input[type=hidden]'), menu = el.querySelector('.crm-menu');
        let items = [], active = -1, labelCache = '';
        function set(id, label) { hidden.value = id || ''; labelCache = label || ''; input.value = label || ''; if (spec && spec.onChange) spec.onChange(id || null, label || ''); }
        if (value) { hidden.value = value; input.value = (spec && spec.valueLabel) || '…'; if (!(spec && spec.valueLabel)) entityLabel(type, value).then(l => { if (hidden.value === value) { input.value = l; labelCache = l; } }); else labelCache = spec.valueLabel; }
        const load = debounce(async () => {
            items = await searchEntities(type, input.value);
            active = -1;
            menu.innerHTML = items.length ? items.map((it, i) => `<button type="button" data-i="${i}"><span style="flex:1;min-width:0"><span style="display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(it.label)}</span>${it.sub ? `<span style="display:block;font-size:12px;color:var(--ws-text-muted)">${esc(it.sub)}</span>` : ''}</span></button>`).join('')
                : `<div style="padding:8px 10px;font-size:13px;color:var(--ws-text-muted)">No matches</div>`;
            menu.hidden = false;
        }, 200);
        input.addEventListener('focus', () => { load(); });
        input.addEventListener('input', () => { if (hidden.value) { hidden.value = ''; if (spec && spec.onChange) spec.onChange(null, ''); } load(); });
        input.addEventListener('blur', () => setTimeout(() => { menu.hidden = true; if (!hidden.value) input.value = ''; else input.value = labelCache; }, 150));
        input.addEventListener('keydown', e => {
            if (menu.hidden) return;
            const btns = $$('button', menu);
            if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(btns.length - 1, active + 1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); }
            else if (e.key === 'Enter') { e.preventDefault(); if (btns[active]) btns[active].click(); return; }
            else if (e.key === 'Escape') { menu.hidden = true; return; }
            btns.forEach((b, i) => b.classList.toggle('active', i === active));
        });
        menu.addEventListener('mousedown', e => { const b = e.target.closest('button[data-i]'); if (!b) return; e.preventDefault(); const it = items[Number(b.dataset.i)]; set(it.id, it.label); menu.hidden = true; });
        return { el, get: () => hidden.value || null, set: (id, label) => { if (!id) return set('', ''); if (label) return set(id, label); entityLabel(type, id).then(l => set(id, l)); }, input };
    }

    /* ------------------------------------------------------------ table */
    /**
     * table(container, { columns, rows, key, sort: {key, dir}, onRow(row), empty: {title, sub, action}, pageSize, selectable, onSelectionChange, rowClass(row) })
     * column: { key, label, render(row) -> html, sort: true | (a,b) => n, num, cls, lead, hideMobile, width }
     */
    function table(container, opts) {
        const st = { rows: opts.rows || [], sort: opts.sort || null, page: 0, pageSize: opts.pageSize || 50, selected: new Set() };
        const key = opts.key || 'id';
        function sorted() {
            const rows = st.rows.slice();
            if (!st.sort) return rows;
            const col = opts.columns.find(c => c.key === st.sort.key);
            if (!col) return rows;
            const dir = st.sort.dir === 'desc' ? -1 : 1;
            const cmp = typeof col.sort === 'function' ? col.sort : (a, b) => {
                const x = col.value ? col.value(a) : a[col.key], y = col.value ? col.value(b) : b[col.key];
                if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
                return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
            };
            return rows.sort((a, b) => cmp(a, b) * dir);
        }
        function render() {
            const all = sorted();
            const pages = Math.max(1, Math.ceil(all.length / st.pageSize));
            if (st.page >= pages) st.page = pages - 1;
            const slice = all.slice(st.page * st.pageSize, (st.page + 1) * st.pageSize);
            if (!all.length) {
                container.innerHTML = '';
                const e = opts.empty || {};
                empty(container, e.title || 'Nothing here yet', e.sub, e.action);
                return;
            }
            const head = opts.columns.map(c => {
                const sortable = c.sort !== false && c.key;
                const cls = [sortable ? 'sortable' : '', st.sort && st.sort.key === c.key ? st.sort.dir : '', c.num ? 'num' : '', c.hideMobile ? 'col-co' : '', c.cls || ''].filter(Boolean).join(' ');
                return `<th${cls ? ` class="${cls}"` : ''}${sortable ? ` data-sort="${esc(c.key)}" tabindex="0" role="button" aria-sort="${st.sort && st.sort.key === c.key ? (st.sort.dir === 'desc' ? 'descending' : 'ascending') : 'none'}"` : ''}${c.width ? ` style="width:${c.width}"` : ''}>${esc(c.label || '')}</th>`;
            }).join('');
            const body = slice.map(r => {
                const id = r[key];
                const tds = opts.columns.map(c => {
                    const cls = [c.num ? 'num' : '', c.lead ? 'lead' : '', c.hideMobile ? 'col-co' : '', c.cls || ''].filter(Boolean).join(' ');
                    const html = c.render ? c.render(r) : esc(c.value ? c.value(r) : r[c.key]);
                    return `<td${cls ? ` class="${cls}"` : ''} data-label="${esc(c.label || '')}">${html == null ? '' : html}</td>`;
                }).join('');
                const check = opts.selectable ? `<td class="checkcol"><input type="checkbox" data-sel="${esc(id)}" aria-label="Select"${st.selected.has(id) ? ' checked' : ''}></td>` : '';
                const cls = [(opts.onRow ? 'rowlink' : ''), st.selected.has(id) ? 'selected' : '', opts.rowClass ? opts.rowClass(r) : ''].filter(Boolean).join(' ');
                return `<tr data-id="${esc(id)}"${cls ? ` class="${cls}"` : ''}${opts.onRow ? ' tabindex="0"' : ''}>${check}${tds}</tr>`;
            }).join('');
            container.innerHTML = `<div class="crm-table-wrap"><table class="ws-table cards"><thead><tr>${opts.selectable ? '<th class="checkcol"><input type="checkbox" data-selall aria-label="Select all"></th>' : ''}${head}</tr></thead><tbody>${body}</tbody></table></div>` +
                (all.length > st.pageSize ? `<div class="crm-pager"><span>${st.page * st.pageSize + 1}–${Math.min(all.length, (st.page + 1) * st.pageSize)} of ${all.length}</span><span class="btns"><button type="button" class="ws-btn sm" data-pg="-1"${st.page === 0 ? ' disabled' : ''}>Previous</button><button type="button" class="ws-btn sm" data-pg="1"${st.page >= pages - 1 ? ' disabled' : ''}>Next</button></span></div>` : '');
        }
        container.addEventListener('click', e => {
            const th = e.target.closest('th[data-sort]');
            if (th) { const k = th.dataset.sort; st.sort = st.sort && st.sort.key === k ? { key: k, dir: st.sort.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'asc' }; render(); return; }
            const pg = e.target.closest('[data-pg]');
            if (pg) { st.page += Number(pg.dataset.pg); render(); container.scrollIntoView({ block: 'nearest' }); return; }
            const sel = e.target.closest('[data-sel]');
            if (sel) { if (sel.checked) st.selected.add(sel.dataset.sel); else st.selected.delete(sel.dataset.sel); sel.closest('tr').classList.toggle('selected', sel.checked); if (opts.onSelectionChange) opts.onSelectionChange(api.selected()); return; }
            const all = e.target.closest('[data-selall]');
            if (all) { const rows = sorted(); if (all.checked) rows.forEach(r => st.selected.add(r[key])); else st.selected.clear(); render(); if (opts.onSelectionChange) opts.onSelectionChange(api.selected()); return; }
            if (e.target.closest('a, button, input, select, label')) return;
            const tr = e.target.closest('tr[data-id]');
            if (tr && opts.onRow) { const row = st.rows.find(r => String(r[key]) === tr.dataset.id); if (row) opts.onRow(row, e); }
        });
        container.addEventListener('keydown', e => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const th = e.target.closest('th[data-sort]'); if (th) { e.preventDefault(); th.click(); return; }
            const tr = e.target.closest('tr[data-id]'); if (tr && e.target === tr && opts.onRow) { e.preventDefault(); const row = st.rows.find(r => String(r[key]) === tr.dataset.id); if (row) opts.onRow(row, e); }
        });
        const api = {
            update(rows) { st.rows = rows || []; st.selected = new Set([...st.selected].filter(id => st.rows.some(r => r[key] === id))); render(); },
            selected: () => [...st.selected],
            clearSelection() { st.selected.clear(); render(); if (opts.onSelectionChange) opts.onSelectionChange([]); },
            setSort(s) { st.sort = s; render(); },
            rows: () => st.rows,
        };
        render();
        return api;
    }

    /* ------------------------------------------------------------- tabs */
    /** tabs(container, [{ key, label, count }], { active, onChange, hash: true }) -> { set(key), setCount(key, n), active } */
    function tabs(container, items, opts) {
        opts = opts || {};
        const el = h('<div class="crm-tabs" role="tablist"></div>');
        let active = opts.active || (opts.hash && location.hash.replace('#', '')) || items[0].key;
        if (!items.some(i => i.key === active)) active = items[0].key;
        function render() {
            el.innerHTML = items.map(i => `<button type="button" role="tab" class="crm-tab${i.key === active ? ' active' : ''}" data-tab="${esc(i.key)}" aria-selected="${i.key === active}">${esc(i.label)}${i.count != null ? `<span class="n">${esc(i.count)}</span>` : ''}</button>`).join('');
            $$('.crm-tabpanel', container.parentNode || document).forEach(p => { p.hidden = p.dataset.panel !== active; });
        }
        el.addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) api.set(b.dataset.tab); });
        el.addEventListener('keydown', e => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            const i = items.findIndex(x => x.key === active); const n = (i + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
            api.set(items[n].key); $$('[data-tab]', el)[n].focus();
        });
        const api = {
            el,
            get active() { return active; },
            set(key, silent) { if (!items.some(i => i.key === key)) return; active = key; render(); if (opts.hash) history.replaceState(null, '', location.pathname + location.search + '#' + key); if (!silent && opts.onChange) opts.onChange(key); },
            setCount(key, n) { const i = items.find(x => x.key === key); if (i) { i.count = n; render(); } },
        };
        container.innerHTML = ''; container.appendChild(el); render();
        return api;
    }

    /* -------------------------------------------------------- row menu */
    /** menu(anchorButton, [{ label, icon, danger, onClick, href }, 'sep']) — a small anchored dropdown. */
    function menu(anchor, items) {
        $$('.crm-menu.open').forEach(m => { m.hidden = true; m.classList.remove('open'); });
        let host = anchor.closest('.crm-menu-host');
        if (!host) { host = document.createElement('span'); host.className = 'crm-menu-host'; anchor.parentNode.insertBefore(host, anchor); host.appendChild(anchor); }
        let m = host.querySelector('.crm-menu');
        if (!m) { m = document.createElement('div'); m.className = 'crm-menu'; m.setAttribute('role', 'menu'); host.appendChild(m); }
        m.innerHTML = items.map(it => it === 'sep' ? '<hr>' : it.href ? `<a role="menuitem" href="${esc(it.href)}" class="${it.danger ? 'danger' : ''}">${it.icon ? icon(it.icon) : ''}${esc(it.label)}</a>` : `<button type="button" role="menuitem" class="${it.danger ? 'danger' : ''}">${it.icon ? icon(it.icon) : ''}${esc(it.label)}</button>`).join('');
        const btns = $$('[role=menuitem]', m); let bi = 0;
        btns.forEach(b => { const it = items.filter(x => x !== 'sep')[bi++]; if (!it.href) b.addEventListener('click', () => { close(); it.onClick && it.onClick(); }); });
        m.hidden = false; m.classList.add('open');
        // Flip up if there is no room below.
        const r = m.getBoundingClientRect(); if (r.bottom > window.innerHeight - 8) { m.style.top = 'auto'; m.style.bottom = 'calc(100% + 4px)'; } else { m.style.top = ''; m.style.bottom = ''; }
        function close() { m.hidden = true; m.classList.remove('open'); document.removeEventListener('click', onDoc, true); document.removeEventListener('keydown', onKey); }
        function onDoc(e) { if (!host.contains(e.target)) close(); }
        function onKey(e) { if (e.key === 'Escape') { close(); anchor.focus(); } }
        setTimeout(() => { document.addEventListener('click', onDoc, true); document.addEventListener('keydown', onKey); if (btns[0]) btns[0].focus(); }, 0);
        return { close };
    }

    /* --------------------------------------------------------- activity */
    /** Log an activity from the client (server triggers cover the structural ones). */
    async function logActivity(action, entityType, entityId, label, meta, links) {
        const sb = await client();
        const l = links || {};
        const r = await sb.rpc('crm_log', { p_action: action, p_entity_type: entityType, p_entity_id: entityId, p_label: label || null, p_meta: meta || {}, p_company: null, p_contact_id: l.contact_id || null, p_lead_id: l.lead_id || null, p_deal_id: l.deal_id || null, p_project_id: l.project_id || null });
        if (r.error) console.warn('[crm] activity', r.error);
        return r.data;
    }
    function activityLine(a) {
        const d = L.describeActivity(a);
        const who = a.actor_id ? personName(a.actor_id) : 'System';
        const target = a.entity_type && a.entity_id && ENTITY_META[a.entity_type] && a.entity_type !== 'event' ? entityChip(a.entity_type, a.entity_id, a.entity_label) : (a.entity_label ? `<span class="detail">${esc(a.entity_label)}</span>` : '');
        return { who, verb: d.verb, detail: d.detail, target };
    }
    /**
     * activityFeed(container, { entity_type, entity_id | contact_id | lead_id | deal_id | project_id | actor_id | company: true, limit, withComments, includeLinked })
     * Renders the timeline; returns { reload() }.
     */
    function activityFeed(container, filter) {
        filter = filter || {};
        async function load() {
            skeletonRows(container, 4);
            try {
                const sb = await client();
                let b = sb.from('crm_activities').select('*').order('created_at', { ascending: false }).limit(filter.limit || 60);
                const ors = [];
                if (filter.entity_type && filter.entity_id) ors.push(`and(entity_type.eq.${filter.entity_type},entity_id.eq.${filter.entity_id})`);
                ['contact_id', 'lead_id', 'deal_id', 'project_id'].forEach(k => { if (filter[k]) ors.push(`${k}.eq.${filter[k]}`); });
                if (ors.length) b = b.or(ors.join(','));
                if (filter.actor_id) b = b.eq('actor_id', filter.actor_id);
                if (filter.actions) b = b.in('action', filter.actions);
                const { data: acts } = await q(b);
                let comments = [];
                if (filter.withComments !== false && filter.entity_type && filter.entity_id) {
                    const c = await sb.from('comments').select('*').eq('entity_type', filter.entity_type).eq('entity_id', filter.entity_id).order('created_at', { ascending: false }).limit(100);
                    comments = c.error ? [] : (c.data || []);
                }
                const commentIds = new Set(comments.map(c => c.id));
                const items = [
                    ...acts.filter(a => !(a.action === 'note.added' && a.meta && commentIds.has(a.meta.comment_id))).map(a => ({ kind: 'activity', at: a.created_at, a })),
                    ...comments.map(c => ({ kind: 'comment', at: c.created_at, c })),
                ].sort((x, y) => new Date(y.at) - new Date(x.at));
                if (!items.length) return empty(container, 'No activity yet', 'Changes, notes and updates will appear here.');
                container.innerHTML = `<ul class="crm-timeline">${items.map(it => {
                    if (it.kind === 'comment') {
                        const c = it.c; const mine = state.user && c.author_id === state.user.id;
                        return `<li data-comment="${esc(c.id)}"><div class="who">${avatarHtml(c.author_id)}</div><div class="what"><b>${esc(personName(c.author_id))}</b> added a note${mine || L.isManager(state.user) ? `<span class="tools">${mine ? '<button type="button" data-edit>Edit</button>' : ''}<button type="button" data-del>Delete</button></span>` : ''}<span class="when">${esc(L.fmtRelative(c.created_at))}${c.updated_at && c.updated_at !== c.created_at ? ' · edited' : ''}</span><div class="body">${renderMentions(c.body)}</div></div></li>`;
                    }
                    const l = activityLine(it.a);
                    return `<li><div class="who">${it.a.actor_id ? avatarHtml(it.a.actor_id) : '<span class="ws-avatar">⚙</span>'}</div><div class="what"><b>${esc(l.who)}</b> ${esc(l.verb)} ${l.target}${l.detail ? `<span class="detail">${esc(l.detail)}</span>` : ''}<span class="when">${esc(L.fmtDateTime(it.a.created_at))}</span></div></li>`;
                }).join('')}</ul>`;
            } catch (e) { errorState(container, e, load); }
        }
        container.addEventListener('click', async e => {
            const li = e.target.closest('[data-comment]'); if (!li) return;
            const id = li.dataset.comment;
            if (e.target.closest('[data-del]')) {
                if (!await confirm({ title: 'Delete this note?', message: 'This cannot be undone.', danger: true, okText: 'Delete' })) return;
                try { const sb = await client(); await q(sb.from('comments').delete().eq('id', id)); toast('Note deleted', 'ok'); load(); } catch (err) { toast(err.message, 'bad'); }
            } else if (e.target.closest('[data-edit]')) {
                const sb = await client();
                const { data } = await sb.from('comments').select('body').eq('id', id).maybeSingle();
                await formModal({ title: 'Edit note', fields: [{ name: 'body', label: 'Note', type: 'textarea', required: true, full: true, rows: 5 }], values: { body: data ? data.body : '' }, onSubmit: async v => { await q(sb.from('comments').update({ body: v.body }).eq('id', id)); toast('Note updated', 'ok'); load(); } });
            }
        });
        load();
        return { reload: load };
    }
    function renderMentions(body) {
        let html = linkify(nl2br(body));
        // @Full Name mentions were inserted by the composer; highlight people we know.
        state.people.forEach(p => { if (p.name && body.includes('@' + p.name)) html = html.split('@' + esc(p.name)).join(`<span class="mention">@${esc(p.name)}</span>`); });
        return html;
    }

    /* --------------------------------------------------------- comments */
    /** comments(container, { entity_type, entity_id, onPosted, placeholder }) — a composer with @mentions; pair with activityFeed for the list. */
    function comments(container, opts) {
        const el = h(`<div class="crm-composer"><textarea placeholder="${esc(opts.placeholder || 'Add a note… use @ to mention a colleague')}" aria-label="Note"></textarea><div class="send"><button type="button" class="ws-btn primary sm">Post</button></div><div class="crm-mention-menu" hidden></div></div>`);
        const ta = el.querySelector('textarea'), btn = el.querySelector('button'), mm = el.querySelector('.crm-mention-menu');
        let mentionStart = -1, mItems = [], mActive = 0;
        function closeMentions() { mm.hidden = true; mentionStart = -1; }
        function renderMentions() {
            mm.innerHTML = mItems.map((p, i) => `<button type="button" data-i="${i}" class="${i === mActive ? 'active' : ''}">${avatarHtml(p)}<span>${esc(p.name)}</span></button>`).join('');
            mm.hidden = !mItems.length;
            mm.style.top = `${Math.min(ta.offsetHeight, 90)}px`; mm.style.left = '0';
        }
        function pick(i) {
            const p = mItems[i]; if (!p) return;
            const before = ta.value.slice(0, mentionStart), after = ta.value.slice(ta.selectionStart);
            ta.value = `${before}@${p.name} ${after}`;
            const pos = before.length + p.name.length + 2; ta.setSelectionRange(pos, pos); ta.focus(); closeMentions();
        }
        ta.addEventListener('input', () => {
            const pos = ta.selectionStart, text = ta.value.slice(0, pos);
            const at = text.lastIndexOf('@');
            if (at >= 0 && (at === 0 || /\s/.test(text[at - 1])) && !/\s{2,}/.test(text.slice(at))) {
                const term = text.slice(at + 1).toLowerCase();
                if (term.length <= 30) {
                    mentionStart = at;
                    mItems = activePeople().filter(p => p.id !== (state.user && state.user.id) && p.name.toLowerCase().includes(term)).slice(0, 8);
                    mActive = 0; renderMentions(); return;
                }
            }
            closeMentions();
        });
        ta.addEventListener('keydown', e => {
            if (mm.hidden) { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') btn.click(); return; }
            if (e.key === 'ArrowDown') { e.preventDefault(); mActive = Math.min(mItems.length - 1, mActive + 1); renderMentions(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); mActive = Math.max(0, mActive - 1); renderMentions(); }
            else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(mActive); }
            else if (e.key === 'Escape') closeMentions();
        });
        mm.addEventListener('mousedown', e => { const b = e.target.closest('[data-i]'); if (b) { e.preventDefault(); pick(Number(b.dataset.i)); } });
        ta.addEventListener('blur', () => setTimeout(closeMentions, 150));
        btn.addEventListener('click', async () => {
            const body = ta.value.trim(); if (!body) return;
            const mentions = activePeople().filter(p => body.includes('@' + p.name)).map(p => p.id);
            btn.disabled = true;
            try {
                const sb = await client();
                await q(sb.from('comments').insert({ entity_type: opts.entity_type, entity_id: opts.entity_id, body, mentions, author_id: state.user.id }));
                ta.value = '';
                mentions.forEach(id => pushNotify({ to: id, title: `${state.user.name} mentioned you`, body: body.slice(0, 120), url: entityUrl(opts.entity_type, opts.entity_id), tag: 'mention' }));
                toast('Note added', 'ok');
                if (opts.onPosted) opts.onPosted();
            } catch (e) { toast(e.message, 'bad'); } finally { btn.disabled = false; }
        });
        container.appendChild(el);
        return { el, focus: () => ta.focus() };
    }

    /* ------------------------------------------------------- documents */
    function fileIcon(doc) {
        const m = String(doc.mime_type || ''); const ext = String(doc.name || '').split('.').pop().toLowerCase();
        const cls = m === 'application/pdf' ? 'pdf' : m.startsWith('image/') ? 'img' : /word|doc/.test(m) || ext === 'docx' || ext === 'doc' ? 'doc' : /sheet|excel|csv/.test(m) || ['xlsx', 'xls', 'csv'].includes(ext) ? 'xls' : /zip/.test(m) ? 'zip' : '';
        return `<span class="crm-file-ico ${cls}">${esc((ext || 'file').slice(0, 4))}</span>`;
    }
    async function signedUrl(doc, seconds) {
        const sb = await client();
        const r = await sb.storage.from(doc.bucket || 'documents').createSignedUrl(doc.storage_path, seconds || 3600);
        if (r.error) throw new Error('Could not open the file.');
        return r.data.signedUrl;
    }
    async function sha256(file) {
        try { const buf = await file.arrayBuffer(); const hash = await crypto.subtle.digest('SHA-256', buf); return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join(''); }
        catch (e) { return null; }
    }
    /**
     * uploadDocument(file, { links: [{entity_type, entity_id}], folder_id, onProgress }) -> documents row
     * Validates size/type (sniffing the first bytes), reuses an identical file already in the company
     * (same SHA-256) by linking to it instead of storing it twice.
     */
    async function uploadDocument(file, opts) {
        opts = opts || {};
        const sb = await client();
        const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
        const check = L.validateUpload(file, L.sniffMime(head));
        if (!check.ok) throw new Error(check.reason);
        const hash = await sha256(file);
        let doc = null;
        if (hash) {
            const dup = await sb.from('documents').select('*').eq('sha256', hash).is('archived_at', null).limit(1);
            if (!dup.error && dup.data && dup.data[0]) doc = dup.data[0];
        }
        if (!doc) {
            const path = `${state.user.id}/${uid()}-${L.safeFileName(file.name)}`;
            const up = await sb.storage.from('documents').upload(path, file, { contentType: check.mime, upsert: false });
            if (up.error) { console.warn('[crm] upload', up.error); throw new Error(/bucket/i.test(up.error.message || '') ? 'The documents storage bucket is not set up yet. Run supabase-work-migration.sql.' : 'Upload failed. Try again.'); }
            try {
                const ins = await q(sb.from('documents').insert({ name: file.name, original_name: file.name, bucket: 'documents', storage_path: path, mime_type: check.mime, size_bytes: file.size, sha256: hash, folder_id: opts.folder_id || null, created_by: state.user.id }).select('*').single());
                doc = ins.data;
            } catch (e) { try { await sb.storage.from('documents').remove([path]); } catch (e2) { /* best effort */ } throw e; }
        }
        for (const l of (opts.links || [])) await linkDocument(doc.id, l.entity_type, l.entity_id);
        return doc;
    }
    async function linkDocument(documentId, entityType, entityId) {
        const sb = await client();
        const r = await sb.from('document_links').upsert({ document_id: documentId, entity_type: entityType, entity_id: entityId, created_by: state.user.id }, { onConflict: 'document_id,entity_type,entity_id', ignoreDuplicates: true });
        if (r.error && r.error.code !== '23505') throw new Error(friendly(r.error));
    }
    async function openDocument(doc) {
        try {
            const url = await signedUrl(doc);
            const m = String(doc.mime_type || '');
            if (m.startsWith('image/')) modal({ title: doc.name, size: 'wide', body: `<div style="text-align:center"><img class="crm-preview" src="${esc(url)}" alt="${esc(doc.name)}"></div>`, actions: [{ label: 'Download', onClick: () => { window.open(url, '_blank', 'noopener'); } }, { label: 'Close', close: true }] });
            else if (m === 'application/pdf' || m.startsWith('text/') || m.startsWith('video/') || m.startsWith('audio/')) modal({ title: doc.name, size: 'xwide', body: m.startsWith('video/') ? `<video class="crm-preview" src="${esc(url)}" controls style="width:100%"></video>` : m.startsWith('audio/') ? `<audio src="${esc(url)}" controls style="width:100%"></audio>` : `<iframe class="crm-preview-frame" src="${esc(url)}" title="${esc(doc.name)}"></iframe>`, actions: [{ label: 'Open in new tab', onClick: () => { window.open(url, '_blank', 'noopener'); } }, { label: 'Close', close: true }] });
            else window.open(url, '_blank', 'noopener');
        } catch (e) { toast(e.message, 'bad'); }
    }
    /**
     * documents(container, { entity_type, entity_id, canEdit }) — the "Files" panel on a record:
     * attached files, drag-drop upload, attach an existing document, preview, unlink.
     */
    function documents(container, opts) {
        const listEl = document.createElement('div');
        const drop = h(`<label class="crm-drop" tabindex="0">${icon('upload')} Drop files here or <b>browse</b> · up to 50 MB<input type="file" multiple></label>`);
        const attachBtn = h(`<button type="button" class="ws-btn sm" style="margin-top:10px">${icon('link')}<span>Attach an existing document</span></button>`);
        const progress = document.createElement('div');
        container.innerHTML = '';
        container.append(listEl);
        if (opts.canEdit !== false) container.append(progress, drop, attachBtn);
        async function load() {
            skeletonRows(listEl, 3);
            try {
                const sb = await client();
                const { data } = await q(sb.from('document_links').select('created_at, created_by, document:documents(*)').eq('entity_type', opts.entity_type).eq('entity_id', opts.entity_id).order('created_at', { ascending: false }));
                const docs = (data || []).map(r => r.document).filter(d => d && !d.archived_at);
                if (!docs.length) return empty(listEl, 'No files attached', opts.canEdit === false ? '' : 'Upload a file below or attach one from Documents.');
                listEl.innerHTML = `<ul class="crm-list compact">${docs.map(d => `<li data-doc="${esc(d.id)}">${fileIcon(d)}<div class="main"><b><a href="#" data-open>${esc(d.name)}</a></b><span>${esc(L.fmtBytes(d.size_bytes))} · ${esc(personName(d.created_by))} · ${esc(L.fmtDate(d.created_at))}</span></div><div class="right"><a class="ws-btn sm" href="/documents/?id=${esc(d.id)}" title="Open in Documents">${icon('doc')}</a>${opts.canEdit === false ? '' : `<button type="button" class="ws-btn sm" data-unlink title="Remove from this record">${icon('x')}</button>`}</div></li>`).join('')}</ul>`;
                listEl._docs = docs;
            } catch (e) { errorState(listEl, e, load); }
        }
        listEl.addEventListener('click', async e => {
            const li = e.target.closest('[data-doc]'); if (!li) return;
            const doc = (listEl._docs || []).find(d => d.id === li.dataset.doc); if (!doc) return;
            if (e.target.closest('[data-open]')) { e.preventDefault(); openDocument(doc); }
            else if (e.target.closest('[data-unlink]')) {
                if (!await confirm({ title: 'Remove this file from the record?', message: 'The document itself stays in the Documents module.', okText: 'Remove' })) return;
                try { const sb = await client(); await q(sb.from('document_links').delete().eq('document_id', doc.id).eq('entity_type', opts.entity_type).eq('entity_id', opts.entity_id)); load(); } catch (err) { toast(err.message, 'bad'); }
            }
        });
        async function handleFiles(files) {
            for (const file of Array.from(files || [])) {
                const row = h(`<div class="crm-upload-row"><span>${esc(file.name)}</span><span class="ws-bar" style="flex:1"><i style="width:30%"></i></span><span class="st">Uploading…</span></div>`);
                progress.appendChild(row);
                try {
                    const doc = await uploadDocument(file, { links: [{ entity_type: opts.entity_type, entity_id: opts.entity_id }] });
                    row.querySelector('i').style.width = '100%'; row.querySelector('.st').textContent = doc.sha256 && doc.created_at && (Date.now() - new Date(doc.created_at)) > 60000 ? 'Linked existing copy' : 'Done';
                    setTimeout(() => row.remove(), 2500);
                } catch (e) { row.querySelector('.st').textContent = e.message; row.querySelector('.st').style.color = 'var(--ws-danger-text)'; setTimeout(() => row.remove(), 6000); }
            }
            load();
            if (opts.onChange) opts.onChange();
        }
        drop.querySelector('input').addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });
        drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
        drop.addEventListener('dragleave', () => drop.classList.remove('over'));
        drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); handleFiles(e.dataTransfer.files); });
        drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drop.querySelector('input').click(); } });
        attachBtn.addEventListener('click', () => formModal({
            title: 'Attach an existing document', fields: [{ name: 'document_id', label: 'Document', type: 'entity', entity: 'document', required: true, full: true, placeholder: 'Search documents by name' }],
            submitLabel: 'Attach', onSubmit: async v => { await linkDocument(v.document_id, opts.entity_type, opts.entity_id); toast('Document attached', 'ok'); load(); if (opts.onChange) opts.onChange(); },
        }));
        load();
        return { reload: load, upload: handleFiles };
    }

    /* ------------------------------------------------ push notifications */
    function pushNotify(payload) {
        try { if (window.WSPush && WSPush.notify && state.sb && payload.to && payload.to !== state.user.id) WSPush.notify(state.sb, payload); } catch (e) { /* never block */ }
    }

    /* --------------------------------------------------------- realtime */
    /** subscribe('name', [{ event, table, filter }], handler) → unsubscribe fn. Cleaned up on pagehide. */
    function subscribe(name, specs, handler) {
        const sb = state.sb; if (!sb) return () => {};
        let ch = sb.channel(`${name}:${uid().slice(0, 8)}`);
        (Array.isArray(specs) ? specs : [specs]).forEach(s => { ch = ch.on('postgres_changes', { event: s.event || '*', schema: 'public', table: s.table, filter: s.filter }, handler); });
        ch.subscribe();
        state.channels.push(ch);
        return () => { try { sb.removeChannel(ch); } catch (e) { /* gone */ } state.channels = state.channels.filter(c => c !== ch); };
    }
    function unsubscribeAll() { state.channels.forEach(ch => { try { state.sb.removeChannel(ch); } catch (e) { /* gone */ } }); state.channels = []; }

    /* ------------------------------------------------- task quick editor */
    /**
     * openTaskEditor({ task, defaults: { project_id, contact_id, lead_id, deal_id, board_id, board_column_id, parent_task_id, assignee_id }, onSaved(task) })
     */
    async function openTaskEditor(opts) {
        opts = opts || {};
        const lk = await lookups();
        const t = opts.task || {};
        const d = opts.defaults || {};
        const isNew = !t.id;
        const extra = [];
        if (!(d.project_id && isNew)) extra.push({ name: 'project_id', label: 'Project', type: 'entity', entity: 'project', placeholder: 'Search projects' });
        if (d.contact_id === undefined && !t.contact_id && !d.deal_id && !d.lead_id) extra.push({ name: 'contact_id', label: 'Contact', type: 'entity', entity: 'contact', placeholder: 'Search contacts' });
        if (d.deal_id === undefined && !t.deal_id && !d.contact_id && !d.lead_id) extra.push({ name: 'deal_id', label: 'Deal', type: 'entity', entity: 'deal', placeholder: 'Search deals' });
        const fields = [
            { name: 'title', label: 'Title', type: 'text', required: true, full: true, placeholder: 'What needs to be done?' },
            { name: 'description', label: 'Description', type: 'textarea', full: true, rows: 3 },
            { name: 'status', label: 'Status', type: 'select', options: lk.taskStatuses.map(s => ({ value: s.key, label: s.label })), required: true },
            { name: 'priority', label: 'Priority', type: 'select', options: Object.entries(L.PRIORITY).map(([k, v]) => ({ value: k, label: v.label })), required: true },
            { name: 'assignee_id', label: 'Assignee', type: 'people' },
            { name: 'assignees', label: 'Also assigned to', type: 'peoples' },
            { name: 'start_date', label: 'Start date', type: 'date' },
            { name: 'due_date', label: 'Due date', type: 'date', validate: (v, all) => v && all.start_date && L.dayNumber(v) < L.dayNumber(all.start_date) ? 'Due date is before the start date' : '' },
            { name: 'due_time', label: 'Due time', type: 'time' },
            { name: 'estimate_hours', label: 'Estimate (hours)', type: 'number', min: 0, step: 0.5 },
            ...extra,
            { name: 'tags', label: 'Tags', type: 'tags', full: true },
            { name: 'reminder', label: 'Remind me (in-app) a day before it is due', type: 'check', full: true },
        ];
        const values = isNew
            ? { status: 'todo', priority: 'normal', assignee_id: d.assignee_id || state.user.id, project_id: d.project_id || null, contact_id: d.contact_id || null, deal_id: d.deal_id || null, due_date: d.due_date || null, title: d.title || '', reminder: false, assignees: d.assignees || [] }
            : { ...t, reminder: !!t.reminder_at, assignees: opts.assignees || [] };
        return formModal({
            title: isNew ? 'New task' : 'Edit task', size: 'wide', fields, values, submitLabel: isNew ? 'Create task' : 'Save',
            onSubmit: async v => {
                const sb = await client();
                const row = {
                    title: v.title.trim(), description: v.description || null, status: v.status, priority: v.priority,
                    assignee_id: v.assignee_id || null, start_date: v.start_date || null, due_date: v.due_date || null, due_time: v.due_time || null,
                    estimate_hours: v.estimate_hours, tags: v.tags || [],
                    reminder_at: v.reminder && v.due_date ? L.isoAtIST(L.addDays(v.due_date, -1), '09:00') : null,
                };
                if ('project_id' in v) row.project_id = v.project_id || null; else if (isNew && d.project_id) row.project_id = d.project_id;
                if ('contact_id' in v) row.contact_id = v.contact_id || null; else if (isNew && d.contact_id) row.contact_id = d.contact_id;
                if ('deal_id' in v) row.deal_id = v.deal_id || null; else if (isNew && d.deal_id) row.deal_id = d.deal_id;
                if (isNew) {
                    if (d.lead_id) row.lead_id = d.lead_id;
                    if (d.board_id) row.board_id = d.board_id;
                    if (d.board_column_id) row.board_column_id = d.board_column_id;
                    if (d.parent_task_id) row.parent_task_id = d.parent_task_id;
                    if (d.position != null) row.position = d.position;
                    row.created_by = state.user.id;
                }
                const saved = isNew
                    ? (await q(sb.from('tasks').insert(row).select('*').single())).data
                    : (await q(sb.from('tasks').update(row).eq('id', t.id).select('*').single())).data;
                // Extra assignees: sync the join table (best effort; the task itself is already saved).
                try {
                    const want = new Set((v.assignees || []).filter(id => id !== saved.assignee_id));
                    const cur = new Set(opts.assignees || []);
                    const add = [...want].filter(id => !cur.has(id)), rm = [...cur].filter(id => !want.has(id));
                    if (add.length) await sb.from('task_assignees').insert(add.map(id => ({ task_id: saved.id, user_id: id, added_by: state.user.id })));
                    if (rm.length) await sb.from('task_assignees').delete().eq('task_id', saved.id).in('user_id', rm);
                    add.forEach(id => pushNotify({ to: id, title: 'Task assigned to you', body: saved.title, url: `/tasks/?id=${saved.id}`, tag: 'task' }));
                } catch (e) { console.warn('[crm] assignees', e); }
                if (saved.assignee_id && (isNew || saved.assignee_id !== t.assignee_id)) pushNotify({ to: saved.assignee_id, title: 'Task assigned to you', body: saved.title, url: `/tasks/?id=${saved.id}`, tag: 'task' });
                toast(isNew ? 'Task created' : 'Task saved', 'ok');
                if (opts.onSaved) opts.onSaved(saved);
                return saved;
            },
        });
    }

    /* ------------------------------------------------ event quick editor */
    /** openEventEditor({ event, participants: [ids], defaults: { contact_id, lead_id, deal_id, project_id, starts_at, title, event_type }, onSaved }) */
    async function openEventEditor(opts) {
        opts = opts || {};
        const ev = opts.event || {}; const d = opts.defaults || {}; const isNew = !ev.id;
        const startDefault = d.starts_at || (() => { const n = new Date(); n.setMinutes(0, 0, 0); n.setHours(n.getHours() + 1); return n.toISOString(); })();
        const endDefault = d.ends_at || new Date(new Date(startDefault).getTime() + 3600000).toISOString();
        const linkFields = [];
        ['contact', 'lead', 'deal', 'project'].forEach(k => { if (d[k + '_id'] === undefined && !ev[k + '_id']) linkFields.push({ name: k + '_id', label: ENTITY_META[k].label, type: 'entity', entity: k, placeholder: `Search ${k}s` }); });
        const fields = [
            { name: 'title', label: 'Title', type: 'text', required: true, full: true },
            { name: 'event_type', label: 'Type', type: 'select', options: Object.entries(L.EVENT_TYPE).map(([k, v]) => ({ value: k, label: v.label })), required: true },
            { name: 'all_day', label: 'All day', type: 'check' },
            { name: 'starts_at', label: 'Starts', type: 'datetime', required: true },
            { name: 'ends_at', label: 'Ends', type: 'datetime', required: true },
            { name: 'location', label: 'Location', type: 'text' },
            { name: 'meeting_link', label: 'Meeting link', type: 'url', placeholder: 'https://…' },
            { name: 'participants', label: 'Invite colleagues', type: 'peoples', full: true },
            ...linkFields,
            { name: 'reminder_minutes', label: 'Reminder', type: 'select', options: [{ value: '', label: 'None' }, { value: '10', label: '10 minutes before' }, { value: '30', label: '30 minutes before' }, { value: '60', label: '1 hour before' }, { value: '1440', label: '1 day before' }] },
            { name: 'visibility', label: 'Visibility', type: 'select', options: [{ value: 'company', label: 'Everyone in the company' }, { value: 'private', label: 'Only me and participants' }], required: true },
            { name: 'description', label: 'Notes', type: 'textarea', full: true },
        ];
        const values = isNew
            ? { title: d.title || '', event_type: d.event_type || 'meeting', all_day: !!d.all_day, starts_at: startDefault, ends_at: endDefault, participants: d.participants || [], visibility: 'company', reminder_minutes: '30' }
            : { ...ev, participants: opts.participants || [], reminder_minutes: ev.reminder_minutes == null ? '' : String(ev.reminder_minutes) };
        return formModal({
            title: isNew ? 'Schedule' : 'Edit event', size: 'wide', fields, values, submitLabel: isNew ? 'Schedule' : 'Save',
            onReady: f => {
                // Keep the end after the start when the start moves.
                const s = f.field('starts_at'), e = f.field('ends_at');
                s.date.addEventListener('change', () => { if (!e.date.value || L.dayNumber(e.date.value) < L.dayNumber(s.date.value)) e.date.value = s.date.value; });
                s.time.addEventListener('change', () => { if (e.date.value === s.date.value && (!e.time.value || e.time.value <= s.time.value)) { const [hh, mm] = s.time.value.split(':').map(Number); e.time.value = `${String(Math.min(23, hh + 1)).padStart(2, '0')}:${String(mm).padStart(2, '0')}`; } });
            },
            onSubmit: async v => {
                if (new Date(v.ends_at) < new Date(v.starts_at)) throw new Error('The event ends before it starts.');
                const sb = await client();
                const row = {
                    title: v.title.trim(), description: v.description || null, event_type: v.event_type, all_day: !!v.all_day,
                    starts_at: v.all_day ? L.isoAtIST(L.istDate(v.starts_at), '00:00') : v.starts_at,
                    ends_at: v.all_day ? L.isoEndOfIST(L.istDate(v.ends_at)) : v.ends_at,
                    location: v.location || null, meeting_link: v.meeting_link || null, visibility: v.visibility,
                    reminder_minutes: v.reminder_minutes ? Number(v.reminder_minutes) : null,
                };
                ['contact_id', 'lead_id', 'deal_id', 'project_id'].forEach(k => { if (k in v) row[k] = v[k] || null; else if (isNew && d[k]) row[k] = d[k]; });
                if (isNew) { row.owner_id = state.user.id; row.created_by = state.user.id; }
                const saved = isNew
                    ? (await q(sb.from('calendar_events').insert(row).select('*').single())).data
                    : (await q(sb.from('calendar_events').update(row).eq('id', ev.id).select('*').single())).data;
                try {
                    const want = new Set((v.participants || []).filter(id => id !== saved.owner_id));
                    const cur = new Set(opts.participants || []);
                    const add = [...want].filter(id => !cur.has(id)), rm = [...cur].filter(id => !want.has(id));
                    if (add.length) await sb.from('event_participants').insert(add.map(id => ({ event_id: saved.id, user_id: id })));
                    if (rm.length) await sb.from('event_participants').delete().eq('event_id', saved.id).in('user_id', rm);
                    add.forEach(id => pushNotify({ to: id, title: 'Meeting invitation', body: `${saved.title} · ${L.fmtDateTime(saved.starts_at)}`, url: `/calendar/?id=${saved.id}`, tag: 'event' }));
                } catch (e) { console.warn('[crm] participants', e); }
                toast(isNew ? 'Scheduled' : 'Event saved', 'ok');
                if (opts.onSaved) opts.onSaved(saved);
                return saved;
            },
        });
    }

    /* ---------------------------------------------- generic list loaders */
    /** Related records for a contact/lead/deal/project page. Each returns rows or [] (never throws for a missing table). */
    async function related(table, column, id, select, extra) {
        try {
            const sb = await client();
            let b = sb.from(table).select(select || '*').eq(column, id).order('created_at', { ascending: false }).limit(200);
            if (extra) b = extra(b);
            const r = await b; if (r.error) { if (!isMissingSchema(r.error)) console.warn('[crm] related', table, r.error); return []; }
            return r.data || [];
        } catch (e) { return []; }
    }

    /* --------------------------------------------------------- public API */
    window.WSCrm = {
        boot, ctx, client, lookups, q, friendly, isMissingSchema, migrationNoticeHtml,
        esc, h, $, $$, uid, debounce, param, setParam, toast, icon, nl2br, linkify,
        person, personName, activePeople, avatarHtml, personHtml, avatarsHtml, peopleOptions, peoplePicker,
        badge, statusBadge, priorityBadge, dueHtml, tagsHtml, entityUrl, entityChip, ENTITY_META,
        loading, skeletonRows, empty, errorState,
        confirm, alert, modal, form, formModal, entityPicker, searchEntities, entityLabel,
        table, tabs, menu,
        logActivity, activityFeed, comments, renderMentions,
        documents, uploadDocument, linkDocument, openDocument, signedUrl, fileIcon,
        pushNotify, subscribe, unsubscribeAll,
        openTaskEditor, openEventEditor, related,
        L,
    };
})();
