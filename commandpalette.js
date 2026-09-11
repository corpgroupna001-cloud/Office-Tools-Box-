// ============================================================
// WorkSuite — Global command palette (⌘K / Ctrl+K)
// Included on every page.
// Provides fuzzy search across:
//   - Navigation (every module in the sidebar: CRM, Contacts, Leads, Deals,
//     Messenger, Boards, Projects, Tasks, Documents, Calendar, Employees,
//     Invoices, the existing tools)
//   - Teammates (open a chat or their employee profile)
//   - Records — contacts, leads, deals, projects, tasks, documents — looked
//     up on the server as you type (debounced). Row Level Security decides
//     what comes back, so nobody sees a record they could not open.
//   - Quick actions (new contact / lead / deal / task, sign out)
// ============================================================
(function () {
    if (window.__WS_CMDK__) return;
    window.__WS_CMDK__ = true;

    let sb = null;
    let currentUserId = null;
    let contacts = [];       // teammates [{id,full_name,email,avatar_url,last_seen_at}]
    let overlay, input, results;
    let activeIndex = 0;
    let items = [];          // current filtered items
    let opened = false;
    let records = [];        // server results for the current query
    let recordsFor = '';     // the query the records belong to
    let searchSeq = 0;
    let schemaMissing = false;

    // Fallback navigation when the shell is not on the page.
    const FALLBACK_NAV = [
        { key: 'home', title: 'Dashboard', href: '/', icon: 'home' },
        { key: 'crm', title: 'CRM', href: '/crm/', icon: 'dashboard' },
        { key: 'contacts', title: 'Contacts', href: '/contacts/', icon: 'user' },
        { key: 'leads', title: 'Leads', href: '/leads/', icon: 'target' },
        { key: 'deals', title: 'Deals', href: '/deals/', icon: 'deal' },
        { key: 'chat', title: 'Messenger', href: '/chat/', icon: 'chat' },
        { key: 'boards', title: 'Boards', href: '/boards/', icon: 'board' },
        { key: 'projects', title: 'Projects', href: '/projects/', icon: 'folder' },
        { key: 'tasks', title: 'Tasks', href: '/tasks/', icon: 'tasks' },
        { key: 'documents', title: 'Documents', href: '/documents/', icon: 'doc' },
        { key: 'calendar', title: 'Calendar', href: '/calendar/', icon: 'calendar' },
        { key: 'employees', title: 'Employees', href: '/employees/', icon: 'users' },
        { key: 'invoices', title: 'Invoices', href: '/invoices/', icon: 'invoice', role: 'manager' },
        { key: 'attendance', title: 'My Attendance', href: '/attendance/', icon: 'attend' },
        { key: 'leave', title: 'Leave & Holidays', href: '/attendance/#leave', icon: 'leave' },
        { key: 'recordings', title: 'Friday Check-in', href: '/recordings/', icon: 'video' },
        { key: 'signature', title: 'Email Signature', href: '/signature/', icon: 'pen' },
        { key: 'typing', title: 'Typing assessment', href: '/typingtest/', icon: 'keyboard' },
        { key: 'quiz', title: 'Knowledge assessments', href: '/mcqquiz/', icon: 'quiz' },
    ];
    const NAV_TAGS = {
        home: 'home dashboard hub', crm: 'crm dashboard sales pipeline overview', contacts: 'contacts people customers clients',
        leads: 'leads prospects enquiries', deals: 'deals pipeline opportunities sales', chat: 'chat messenger messages call voice video',
        boards: 'boards kanban cards', projects: 'projects work', tasks: 'tasks todo to-do my tasks', documents: 'documents files uploads',
        calendar: 'calendar meetings events schedule', employees: 'employees team directory staff people', invoices: 'invoices billing payments finance',
        attendance: 'attendance punch clock', leave: 'leave holidays', recordings: 'wfh friday check-in video', signature: 'signature email brand',
        typing: 'typing wpm speed test zen', quiz: 'quiz mcq brain trivia',
    };
    // Admin is intentionally excluded — it lives behind a password gate, and
    // surfacing it in the palette exposes the endpoint to non-admins.
    function navItems() {
        const roleRank = { employee: 0, manager: 1, admin: 2 };
        const mine = roleRank[(window.WSShell && WSShell.role) || 'employee'] || 0;
        const src = window.WSShell && WSShell.NAV ? WSShell.NAV.flatMap(g => g.items) : FALLBACK_NAV;
        return src.filter(it => it.href && it.key !== 'admin' && (!it.role || (roleRank[it.role] || 0) <= mine));
    }

    const RECORD_TYPES = [
        { type: 'contact', group: 'Contacts', icon: '👤', table: 'crm_contacts', select: 'id, full_name, organization, email', cols: 'full_name,organization,email', label: r => r.full_name || r.organization, sub: r => [r.organization, r.email].filter(Boolean).join(' · '), url: r => `/contacts/?id=${r.id}` },
        { type: 'lead', group: 'Leads', icon: '🎯', table: 'crm_leads', select: 'id, name, organization, status', cols: 'name,organization,email', label: r => r.name, sub: r => [r.organization, r.status].filter(Boolean).join(' · '), url: r => `/leads/?id=${r.id}` },
        { type: 'deal', group: 'Deals', icon: '💼', table: 'crm_deals', select: 'id, title, value, currency, status', cols: 'title,organization', label: r => r.title, sub: r => `${r.status} · ${fmtMoney(r.value, r.currency)}`, url: r => `/deals/?id=${r.id}` },
        { type: 'project', group: 'Projects', icon: '📁', table: 'projects', select: 'id, name, status', cols: 'name', label: r => r.name, sub: r => String(r.status || '').replace(/_/g, ' '), url: r => `/projects/?id=${r.id}` },
        { type: 'task', group: 'Tasks', icon: '✅', table: 'tasks', select: 'id, title, status, due_date', cols: 'title', label: r => r.title, sub: r => [String(r.status || '').replace(/_/g, ' '), r.due_date ? 'due ' + r.due_date : ''].filter(Boolean).join(' · '), url: r => `/tasks/?id=${r.id}` },
        { type: 'document', group: 'Documents', icon: '📄', table: 'documents', select: 'id, name, mime_type', cols: 'name', label: r => r.name, sub: r => r.mime_type || '', url: r => `/documents/?id=${r.id}` },
    ];
    function fmtMoney(v, cur) {
        try { return new Intl.NumberFormat(cur === 'INR' || !cur ? 'en-IN' : 'en-US', { style: 'currency', currency: cur || 'INR', maximumFractionDigits: 0 }).format(Number(v) || 0); }
        catch { return String(v || 0); }
    }

    function injectMarkup() {
        if (document.getElementById('ws-cmdk-overlay')) return;
        overlay = document.createElement('div');
        overlay.id = 'ws-cmdk-overlay';
        overlay.innerHTML = `
            <div class="ws-cmdk-panel" role="dialog" aria-label="Quick actions">
                <div class="ws-cmdk-input-row">
                    <svg class="search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                    <input id="ws-cmdk-input" type="text" placeholder="Search records, pages, teammates, or actions…" autocomplete="off" spellcheck="false" aria-label="Search workspace">
                    <span class="kbd">esc</span>
                </div>
                <div id="ws-cmdk-results" class="ws-cmdk-results" role="listbox"></div>
                <div class="ws-cmdk-footer">
                    <div class="hints">
                        <span class="hint"><span class="kbd">↑↓</span> navigate</span>
                        <span class="hint"><span class="kbd">↵</span> select</span>
                        <span class="hint"><span class="kbd">esc</span> close</span>
                    </div>
                    <span>WorkSuite ⌘K</span>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        input   = overlay.querySelector('#ws-cmdk-input');
        results = overlay.querySelector('#ws-cmdk-results');

        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        input.addEventListener('input', () => { activeIndex = 0; render(); scheduleSearch(); });
        input.addEventListener('keydown', onKey);
    }

    function pickColor(name) {
        const colors = ['#3b82f6','#6366f1','#8b5cf6','#ec4899','#f43f5e','#f97316','#eab308','#22c55e','#14b8a6','#0ea5e9'];
        let h = 0; for (let i = 0; i < (name||'').length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
        return colors[Math.abs(h) % colors.length];
    }
    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function isOnline(lastSeenISO) {
        if (!lastSeenISO) return false;
        return (Date.now() - new Date(lastSeenISO).getTime()) < 60_000;
    }

    // Simple fuzzy score — higher is better
    function score(query, text) {
        if (!query) return 1;
        const q = query.toLowerCase();
        const t = (text || '').toLowerCase();
        if (t === q) return 100;
        if (t.startsWith(q)) return 80;
        if (t.includes(q)) return 50;
        // Char-by-char subsequence
        let qi = 0, streak = 0, best = 0;
        for (let i = 0; i < t.length && qi < q.length; i++) {
            if (t[i] === q[qi]) { qi++; streak++; best = Math.max(best, streak); }
            else streak = 0;
        }
        return qi === q.length ? 10 + best : 0;
    }

    // ---------- server-side record search (debounced) ----------
    let searchTimer = null;
    function scheduleSearch() {
        clearTimeout(searchTimer);
        const q = input.value.trim();
        if (q.length < 2 || !sb || schemaMissing) { records = []; recordsFor = q; return; }
        searchTimer = setTimeout(() => runSearch(q), 260);
    }
    async function runSearch(q) {
        const seq = ++searchSeq;
        const safe = q.replace(/[%,()]/g, ' ').trim();
        if (!safe) return;
        const out = [];
        let missing = 0;
        await Promise.all(RECORD_TYPES.map(async t => {
            try {
                const r = await sb.from(t.table).select(t.select).is('archived_at', null)
                    .or(t.cols.split(',').map(c => `${c}.ilike.%${safe}%`).join(',')).limit(5);
                if (r.error) { if (r.error.code === '42P01' || r.error.code === 'PGRST205') missing++; return; }
                (r.data || []).forEach(row => out.push({ t, row }));
            } catch { /* one table failing must not hide the others */ }
        }));
        if (missing === RECORD_TYPES.length) schemaMissing = true;
        if (seq !== searchSeq) return;          // a newer query is in flight
        records = out; recordsFor = q;
        if (opened) render();
    }

    function buildItems(query) {
        const q = (query || '').trim();
        const list = [];

        // 1) Records from the server (only for the current query)
        if (q && recordsFor === q) {
            records.forEach(({ t, row }) => {
                const label = t.label(row) || '(untitled)';
                list.push({
                    group: t.group,
                    score: Math.max(score(q, label), 45) + 5,
                    key: `rec:${t.type}:${row.id}`,
                    render: () => `
                        <div class="item-icon">${t.icon}</div>
                        <div class="item-body">
                            <div class="item-title">${esc(label)}</div>
                            <div class="item-sub">${esc(t.sub(row) || t.group)}</div>
                        </div>
                        <div class="item-shortcut">Open</div>`,
                    action: () => { location.href = t.url(row); }
                });
            });
        }

        // 2) Navigation — always show
        navItems().forEach(it => {
            const s = Math.max(score(q, it.title), score(q, NAV_TAGS[it.key] || ''), score(q, 'go to ' + it.title));
            if (!q || s > 0) list.push({
                group: 'Go to',
                score: s || 1,
                key: 'nav:' + it.href,
                render: () => `
                    <div class="item-icon"><span class="ic ic-${esc(it.icon || 'arrow')}"></span></div>
                    <div class="item-body">
                        <div class="item-title">${esc(it.title)}</div>
                        <div class="item-sub">Go to ${esc(it.title)}</div>
                    </div>
                    <div class="item-shortcut">Open</div>`,
                action: () => { location.href = it.href; }
            });
        });

        // 3) Teammates
        contacts.forEach(c => {
            const name = c.full_name || c.email || 'Unknown';
            const s = Math.max(score(q, name), score(q, c.email || ''));
            if ((q && s > 0) || (!q && contacts.length <= 12)) list.push({
                group: 'Teammates',
                score: s,
                key: 'peer:' + c.id,
                render: () => {
                    const initial = name.charAt(0).toUpperCase();
                    const bg = pickColor(name);
                    const avatar = c.avatar_url
                        ? `<img src="${esc(c.avatar_url)}" alt="">`
                        : `<span style="background:${bg};width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;">${esc(initial)}</span>`;
                    const online = isOnline(c.last_seen_at);
                    return `
                        <div class="item-icon" style="border:none;background:transparent;padding:0;">${avatar}</div>
                        <div class="item-body">
                            <div class="item-title">${esc(name)} ${online ? '<span style="color:#6ee7b7;font-size:11px;margin-left:6px;">● online</span>' : ''}</div>
                            <div class="item-sub">${esc(c.email || '')} · Enter to chat, ⇧Enter for profile</div>
                        </div>
                        <div class="item-shortcut">Chat</div>`;
                },
                action: (e) => { location.href = e && e.shiftKey ? `/employees/?id=${encodeURIComponent(c.id)}` : `/chat/#thread=${encodeURIComponent(c.id)}`; }
            });
        });

        // 4) Quick actions
        const actions = [
            { title: 'New contact', sub: 'Add a person or organisation to the CRM', icon: '➕', href: '/contacts/?new=1', tags: 'new create add contact person customer' },
            { title: 'New lead', sub: 'Capture an enquiry', icon: '➕', href: '/leads/?new=1', tags: 'new create add lead enquiry prospect' },
            { title: 'New deal', sub: 'Open an opportunity in the pipeline', icon: '➕', href: '/deals/?new=1', tags: 'new create add deal opportunity' },
            { title: 'New task', sub: 'Create a task for yourself or a colleague', icon: '➕', href: '/tasks/?new=1', tags: 'new create add task todo' },
            { title: 'Schedule a meeting', sub: 'Add an event to the calendar', icon: '📅', href: '/calendar/?new=1', tags: 'new meeting event schedule calendar' },
            { title: 'Sign out', sub: 'End your session', icon: '↩︎',
              action: async () => {
                  try {
                      if (sb) await sb.auth.signOut();
                      location.href = '/';
                  } catch { location.href = '/'; }
              },
              tags: 'sign out logout logoff exit' },
        ];
        actions.forEach(a => {
            const s = Math.max(score(q, a.title), score(q, a.tags));
            if (!q || s > 0) list.push({
                group: 'Quick Actions',
                score: s,
                key: 'act:' + a.title,
                render: () => `
                    <div class="item-icon">${a.icon}</div>
                    <div class="item-body">
                        <div class="item-title">${esc(a.title)}</div>
                        <div class="item-sub">${esc(a.sub)}</div>
                    </div>
                    <div class="item-shortcut">Run</div>`,
                action: a.action || (() => { location.href = a.href; })
            });
        });

        return list.sort((a, b) => b.score - a.score);
    }

    function render() {
        const q = input.value;
        items = buildItems(q);
        const searching = q.trim().length >= 2 && recordsFor !== q.trim() && sb && !schemaMissing;
        if (!items.length && !searching) {
            results.innerHTML = `<div class="ws-cmdk-empty">No matches for "<b>${esc(q)}</b>"</div>`;
            return;
        }
        // Group items in original score order
        const groups = new Map();
        items.forEach((it, idx) => {
            if (!groups.has(it.group)) groups.set(it.group, []);
            groups.get(it.group).push({ it, idx });
        });
        let html = searching ? `<div class="ws-cmdk-group-head">Searching records…</div>` : '';
        for (const [group, arr] of groups) {
            html += `<div class="ws-cmdk-group-head">${esc(group)}</div>`;
            arr.forEach(({ it, idx }) => {
                html += `<div class="ws-cmdk-item ${idx === activeIndex ? 'active' : ''}" role="option" aria-selected="${idx === activeIndex}" data-idx="${idx}">${it.render()}</div>`;
            });
        }
        results.innerHTML = html;
        results.querySelectorAll('.ws-cmdk-item').forEach(el => {
            el.addEventListener('click', (e) => {
                const idx = parseInt(el.dataset.idx, 10);
                if (items[idx]) { items[idx].action(e); close(); }
            });
            el.addEventListener('mouseenter', () => {
                activeIndex = parseInt(el.dataset.idx, 10);
                syncActive();
            });
        });
        // Scroll active into view
        const active = results.querySelector('.ws-cmdk-item.active');
        if (active) active.scrollIntoView({ block: 'nearest' });
    }

    function syncActive() {
        results.querySelectorAll('.ws-cmdk-item').forEach(el => {
            const idx = parseInt(el.dataset.idx, 10);
            el.classList.toggle('active', idx === activeIndex);
            el.setAttribute('aria-selected', idx === activeIndex ? 'true' : 'false');
        });
        const active = results.querySelector('.ws-cmdk-item.active');
        if (active) active.scrollIntoView({ block: 'nearest' });
    }

    function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(); return; }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            activeIndex = Math.min(items.length - 1, activeIndex + 1);
            syncActive();
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            activeIndex = Math.max(0, activeIndex - 1);
            syncActive();
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            if (items[activeIndex]) { items[activeIndex].action(e); close(); }
        }
    }

    function open() {
        injectMarkup();
        if (opened) return;
        opened = true;
        overlay.classList.add('show');
        input.value = '';
        records = []; recordsFor = '';
        activeIndex = 0;
        render();
        setTimeout(() => input.focus(), 30);
    }
    function close() {
        if (!opened) return;
        opened = false;
        overlay.classList.remove('show');
    }

    // Public API
    window.wsCmdK = { open, close };

    // Global keybinding (⌘K / Ctrl+K)
    document.addEventListener('keydown', (e) => {
        const isCmdK = (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K');
        if (isCmdK) { e.preventDefault(); opened ? close() : open(); }
    });

    // Load teammates if a Supabase session is present
    (async () => {
        try {
            for (let i = 0; i < 60; i++) {
                if (window.supabase && window.supabase.createClient) break;
                await new Promise(r => setTimeout(r, 100));
            }
            if (!window.supabase) return;
            sb = window.__WS_SB__ || window.__WS_PRESENCE_SB__;
            if (!sb) {
                try {
                    const r = await fetch('/api/config');
                    const cfg = await r.json();
                    if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) return;
                    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
                        auth: { persistSession: true, autoRefreshToken: true }
                    });
                    window.__WS_SB__ = window.__WS_SB__ || sb;
                } catch { return; }
            }
            const { data: { session } } = await sb.auth.getSession();
            if (!session) { sb = null; return; }
            currentUserId = session.user.id;
            const { data } = await sb.from('profiles')
                .select('id, full_name, email, avatar_url, last_seen_at, status')
                .not('id', 'eq', currentUserId).limit(300);
            contacts = (data || []).filter(p => (p.status || 'active') !== 'inactive')
                .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
        } catch (e) { /* silent */ }
    })();
})();
