// ============================================================
// WorkSuite — Global command palette (⌘K / Ctrl+K)
// Included on every page (loaded by notifications.js if this
// file is referenced with a <script> tag right after it).
// Provides fuzzy search across:
//   - Tools (Home, Chat, MCQ Quiz, Typing Test, Signature, Admin)
//   - Teammates (jump to /chat/#thread=<peerId>)
//   - Quick actions (voice/video call last contact, sign out, etc.)
// ============================================================
(function () {
    if (window.__WS_CMDK__) return;
    window.__WS_CMDK__ = true;

    let sb = null;
    let currentUserId = null;
    let contacts = [];       // [{id,full_name,email,avatar_url,last_seen_at}]
    let overlay, input, results;
    let activeIndex = 0;
    let items = [];          // current filtered items
    let opened = false;

    const TOOLS = [
        { title: 'Home',           sub: 'Landing hub with all tools',           icon: '🏠', href: '/',           tags: 'home dashboard hub' },
        { title: 'Chat & Calls',   sub: 'Messaging, voice + video with team',   icon: '💬', href: '/chat/',      tags: 'chat message call voice video' },
        { title: 'Typing Test',    sub: 'Measure your WPM and accuracy',        icon: '⌨️', href: '/typingtest/',tags: 'typing wpm speed test zen' },
        { title: 'MCQ Quiz',       sub: '10 categories of quick-fire quizzes',  icon: '🧠', href: '/mcqquiz/',   tags: 'quiz mcq brain trivia' },
        { title: 'Signature',      sub: 'Generate a branded email signature',   icon: '✉️', href: '/signature/', tags: 'signature email brand' },
        { title: 'Friday Check-in', sub: 'WFH back-camera video (Fridays only)', icon: '📷', href: '/recordings/',tags: 'wfh friday check-in check in video camera workspace weekly record submit' },
        // Admin is intentionally excluded — it lives behind a password gate,
        // and surfacing it in the palette exposes the endpoint to non-admins.
    ];

    function injectMarkup() {
        if (document.getElementById('ws-cmdk-overlay')) return;
        overlay = document.createElement('div');
        overlay.id = 'ws-cmdk-overlay';
        overlay.innerHTML = `
            <div class="ws-cmdk-panel" role="dialog" aria-label="Quick actions">
                <div class="ws-cmdk-input-row">
                    <svg class="search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                    <input id="ws-cmdk-input" type="text" placeholder="Search tools, teammates, or actions…" autocomplete="off" spellcheck="false">
                    <span class="kbd">esc</span>
                </div>
                <div id="ws-cmdk-results" class="ws-cmdk-results"></div>
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
        input.addEventListener('input', () => { activeIndex = 0; render(); });
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

    function buildItems(query) {
        const q = (query || '').trim();
        const list = [];

        // 1) Tools — always show
        TOOLS.forEach(t => {
            const s = Math.max(score(q, t.title), score(q, t.tags));
            if (!q || s > 0) list.push({
                group: 'Tools',
                score: s || 1,
                key: 'tool:' + t.href,
                render: () => `
                    <div class="item-icon">${t.icon}</div>
                    <div class="item-body">
                        <div class="item-title">${esc(t.title)}</div>
                        <div class="item-sub">${esc(t.sub)}</div>
                    </div>
                    <div class="item-shortcut">Open</div>`,
                action: () => { location.href = t.href; }
            });
        });

        // 2) Teammates
        contacts.forEach(c => {
            const name = c.full_name || c.email || 'Unknown';
            const s = Math.max(score(q, name), score(q, c.email || ''));
            if (!q || s > 0) list.push({
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
                            <div class="item-sub">${esc(c.email || '')}</div>
                        </div>
                        <div class="item-shortcut">Chat</div>`;
                },
                action: () => { location.href = `/chat/#thread=${encodeURIComponent(c.id)}`; }
            });
        });

        // 3) Quick actions
        const actions = [
            { title: 'Sign out', sub: 'End your session', icon: '↩︎',
              action: async () => {
                  try {
                      if (sb) await sb.auth.signOut();
                      location.href = '/';
                  } catch { location.href = '/'; }
              },
              tags: 'sign out logout logoff exit' },
            { title: 'Go home', sub: 'Return to the tools hub', icon: '🏠',
              action: () => { location.href = '/'; }, tags: 'home back go' },
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
                action: a.action
            });
        });

        // Sort by score desc, but keep Tools group first when no query
        return list.sort((a, b) => b.score - a.score);
    }

    function render() {
        const q = input.value;
        items = buildItems(q);
        if (!items.length) {
            results.innerHTML = `<div class="ws-cmdk-empty">No matches for "<b>${esc(q)}</b>"</div>`;
            return;
        }
        // Group items in original score order
        const groups = new Map();
        items.forEach((it, idx) => {
            if (!groups.has(it.group)) groups.set(it.group, []);
            groups.get(it.group).push({ it, idx });
        });
        let html = '';
        for (const [group, arr] of groups) {
            html += `<div class="ws-cmdk-group-head">${esc(group)}</div>`;
            arr.forEach(({ it, idx }) => {
                html += `<div class="ws-cmdk-item ${idx === activeIndex ? 'active' : ''}" data-idx="${idx}">${it.render()}</div>`;
            });
        }
        results.innerHTML = html;
        results.querySelectorAll('.ws-cmdk-item').forEach(el => {
            el.addEventListener('click', () => {
                const idx = parseInt(el.dataset.idx, 10);
                if (items[idx]) { items[idx].action(); close(); }
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
            if (items[activeIndex]) { items[activeIndex].action(); close(); }
        }
    }

    function open() {
        injectMarkup();
        if (opened) return;
        opened = true;
        overlay.classList.add('show');
        input.value = '';
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

    // Load contacts if a Supabase session is present
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
                } catch { return; }
            }
            const { data: { session } } = await sb.auth.getSession();
            if (!session) return;
            currentUserId = session.user.id;
            const { data } = await sb.from('profiles')
                .select('id, full_name, email, avatar_url, last_seen_at')
                .not('id', 'eq', currentUserId).limit(200);
            contacts = (data || []).sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
        } catch (e) { /* silent */ }
    })();
})();
