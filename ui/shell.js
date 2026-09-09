/* ============================================================================
   WorkSuite — application shell (sidebar, top bar, user menu, drawer)

   Include at the END of the page markup, before the page's own scripts:

       <body class="ws-app">
           ...page content...
           <script src="/ui/shell.js"></script>
           <script>WSShell.mount({ active: 'attendance' });</script>
           ...page scripts...

   mount() runs synchronously: it builds the sidebar and the top bar and
   moves everything already in <body> into the page column, so every id the
   page's scripts look up is still there — just inside .ws-page. Fixed
   overlays (modals, sheets, toasts) keep working where they are.

   It runs before DOMContentLoaded on purpose, so theme.js finds the toggle
   in the top bar and does not add its floating fallback button.

   API
     WSShell.mount({ active, crumb, crumbPrefix, title, subtitle, brandSub,
                     nav,            // optional: [{label, items:[{key,title,icon, href | tab, tag, badge}]}]
                     tools,          // optional HTML for the top bar (buttons the page wires itself)
                     pageClass,      // 'center' (old centred tool pages) | 'fill' (chat: no padding, full height)
                     onProfile, onSignOut })
     WSShell.setUser({ name, email, avatar, company } | null)
     WSShell.setCrumb(text)
     WSShell.toast(message, 'ok' | 'bad' | '')
     WSShell.refreshUnread()
   ============================================================================ */
(function () {
    'use strict';
    if (window.WSShell) return;

    var NAV = [
        { label: 'Workspace', items: [
            { key: 'home',       title: 'Dashboard',             href: '/',                 icon: 'home' },
            { key: 'attendance', title: 'My Attendance',    href: '/attendance/',      icon: 'attend' },
            { key: 'leave',      title: 'Leave & Holidays', href: '/attendance/#leave', icon: 'leave' },
        ]},
        { label: 'Collaboration', items: [
            { key: 'chat',       title: 'Chat & Calls',     href: '/chat/',       icon: 'chat', badge: 'unread' },
            { key: 'recordings', title: 'Friday Check-in',  href: '/recordings/', icon: 'video' },
            { key: 'signature',  title: 'Email Signature',  href: '/signature/',  icon: 'pen' },
        ]},
        { label: 'Development', items: [
            { key: 'typing',     title: 'Typing assessment',          href: '/typingtest/', icon: 'keyboard' },
            { key: 'quiz',       title: 'Knowledge assessments',         href: '/mcqquiz/',    icon: 'quiz' },
        ]},
        // The admin console is deliberately not listed: it is reached by its
        // URL and its own password, and employees have no reason to see it.
    ];

    var state = { mounted: false, opts: {}, user: null, explicitUser: false, sb: null, uid: null, unreadTimer: null };
    var refs = {};

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function guessActive() {
        var p = location.pathname.replace(/\/+$/, '') || '/';
        if (p === '/' || p === '/index.html') return 'home';
        if (p.indexOf('/attendance') === 0) return location.hash === '#leave' || location.hash === '#holidays' ? 'leave' : 'attendance';
        if (p.indexOf('/chat') === 0) return 'chat';
        if (p.indexOf('/recordings') === 0) return 'recordings';
        if (p.indexOf('/signature') === 0) return 'signature';
        if (p.indexOf('/typingtest') === 0) return 'typing';
        if (p.indexOf('/mcqquiz') === 0) return 'quiz';
        if (p.indexOf('/admin') === 0 || p.indexOf('/wsm-admin') === 0) return 'admin';
        return '';
    }
    function initialOf(name) {
        var s = String(name || '').trim();
        return s ? s.charAt(0).toUpperCase() : '?';
    }
    function navHtml(nav, active) {
        return nav.map(function (g) {
            return '<div class="ws-side-group">' + (g.label ? '<div class="label">' + esc(g.label) + '</div>' : '') +
                g.items.map(function (it) {
                    var extra = it.badge ? '<span class="badge" data-ws-badge="' + it.badge + '" hidden></span>'
                              : it.tag ? '<span class="tag">' + esc(it.tag) + '</span>' : '';
                    var inner = '<span class="ic ic-' + esc(it.icon) + '"></span><span>' + esc(it.title) + '</span>' + extra;
                    var cls = 'ws-side-item' + (it.key === active ? ' active' : '') + (it.cls ? ' ' + esc(it.cls) : '');
                    // A "tab" item is a button the page's own switcher handles (data-tab);
                    // everything else is a plain link.
                    if (it.tab) return '<button type="button" class="' + cls + '" data-tab="' + esc(it.tab) + '" data-key="' + esc(it.key) + '">' + inner + '</button>';
                    return '<a class="' + cls + '" href="' + esc(it.href) + '" data-key="' + esc(it.key) + '">' + inner + '</a>';
                }).join('') + '</div>';
        }).join('');
    }
    function findIn(nav, key) {
        for (var g = 0; g < nav.length; g++) for (var i = 0; i < nav[g].items.length; i++) if (nav[g].items[i].key === key) return nav[g].items[i];
        return null;
    }

    function mount(opts) {
        opts = opts || {};
        if (state.mounted) return;
        var body = document.body;
        if (!body) throw new Error('WSShell.mount: call it after the page markup, not in <head>');
        state.mounted = true;
        state.opts = opts;
        body.classList.add('ws-app');

        var nav = opts.nav || NAV;
        var active = opts.active || guessActive();
        var item = findIn(nav, active);
        var crumb = opts.crumb || (item ? item.title : document.title.split('·')[0].trim());
        var prefix = opts.crumbPrefix || 'WorkSuite';

        // ----- sidebar -----
        var side = document.createElement('aside');
        side.className = 'ws-side';
        side.id = 'ws-side';
        side.setAttribute('aria-label', 'Main navigation');
        side.innerHTML =
            '<a class="ws-side-brand" href="/"><span class="mark"><span class="ic ic-shield"></span></span>' +
                '<span class="name">WorkSuite<small>' + esc(opts.brandSub || 'Employee workspace') + '</small></span></a>' +
            '<nav class="ws-side-nav">' + navHtml(nav, active) + '</nav>' +
            '<div class="ws-side-foot" id="ws-side-foot">' +
                '<span class="ws-avatar" id="ws-foot-avatar">?</span>' +
                '<div class="who"><b id="ws-foot-name">Not signed in</b><span id="ws-foot-sub">WorkSuite</span></div>' +
                '<button type="button" class="out" id="ws-foot-out" title="Sign out" aria-label="Sign out"><span class="ic ic-logout"></span></button>' +
            '</div>';

        // ----- top bar -----
        var top = document.createElement('header');
        top.className = 'ws-top';
        top.innerHTML =
            '<button type="button" class="ws-iconbtn ws-hamb" id="ws-hamb" aria-label="Open navigation" aria-controls="ws-side" aria-expanded="false"><span class="ic ic-menu"></span></button>' +
            '<div class="crumb">' + esc(prefix) + ' <span aria-hidden="true">›</span> <b id="ws-crumb">' + esc(crumb) + '</b></div>' +
            '<div class="spacer"></div>' +
            (opts.tools ? '<div class="ws-top-tools">' + opts.tools + '</div>' : '') +
            '<button type="button" class="ws-cmdk-trigger" id="ws-search" title="Search & quick actions (Ctrl/Cmd + K)">' +
                '<span class="ic ic-search sm"></span><span>Search workspace</span><span class="kbd">⌘K</span></button>' +
            '<button type="button" class="ws-theme-toggle" data-ws-theme data-ws-theme-ready="1" aria-label="Switch between light and dark" title="Switch between light and dark">' +
                '<span class="moon ic ic-moon" aria-hidden="true"></span><span class="sun ic ic-sun" aria-hidden="true"></span></button>' +
            '<a class="ws-iconbtn" id="ws-bell" href="/chat/" title="Messages" aria-label="Messages"><span class="ic ic-bell"></span><span class="dot"></span></a>' +
            '<button type="button" class="ws-userbtn" id="ws-userbtn" aria-haspopup="menu" aria-expanded="false">' +
                '<span class="ws-avatar sm" id="ws-top-avatar">?</span><span class="nm" id="ws-top-name">…</span></button>' +
            '<div class="ws-menu" id="ws-menu" role="menu" hidden>' +
                '<div class="head"><b id="ws-menu-name">Not signed in</b><span id="ws-menu-email"></span></div>' +
                '<button type="button" role="menuitem" id="ws-menu-profile"><span class="ic ic-user"></span>Profile &amp; settings</button>' +
                '<a role="menuitem" href="/attendance/"><span class="ic ic-attend"></span>My attendance</a>' +
                '<a role="menuitem" href="/attendance/#leave"><span class="ic ic-leave"></span>Apply for leave</a>' +
                '<button type="button" role="menuitem" class="danger" id="ws-menu-out"><span class="ic ic-logout"></span>Sign out</button>' +
            '</div>';

        // ----- page column: everything that was in <body> moves here -----
        var page = document.createElement('div');
        page.className = 'ws-page' + (opts.pageClass ? ' ' + opts.pageClass : '');
        page.id = 'ws-page';
        page.setAttribute('tabindex', '-1');
        if (opts.title) {
            var head = document.createElement('div');
            head.className = 'ws-page-head';
            head.innerHTML = '<div><h1>' + esc(opts.title) + '</h1>' + (opts.subtitle ? '<p>' + esc(opts.subtitle) + '</p>' : '') + '</div>';
            page.appendChild(head);
        }
        var nodes = Array.prototype.slice.call(body.childNodes);
        nodes.forEach(function (n) {
            if (n.nodeType === 1 && (n.tagName === 'SCRIPT' || n.hasAttribute('data-ws-outside'))) return;
            page.appendChild(n);
        });

        var main = document.createElement('div');
        main.className = 'ws-main';
        main.appendChild(top);
        main.appendChild(page);

        var shell = document.createElement('div');
        shell.className = 'ws-shell';
        shell.appendChild(side);
        shell.appendChild(main);

        var scrim = document.createElement('div');
        scrim.className = 'ws-scrim';
        scrim.id = 'ws-scrim';

        var host = document.createElement('div');
        host.className = 'ws-toast-host';
        host.id = 'ws-toast-host';

        var skip = document.createElement('a');
        skip.className = 'ws-skip-link';
        skip.href = '#ws-page';
        skip.textContent = 'Skip to content';
        body.insertBefore(shell, body.firstChild);
        body.insertBefore(skip, shell);
        body.appendChild(scrim);
        body.appendChild(host);

        refs = {
            side: side, scrim: scrim, menu: top.querySelector('#ws-menu'), userbtn: top.querySelector('#ws-userbtn'),
            crumb: top.querySelector('#ws-crumb'), bell: top.querySelector('#ws-bell'),
            topAvatar: top.querySelector('#ws-top-avatar'), topName: top.querySelector('#ws-top-name'),
            menuName: top.querySelector('#ws-menu-name'), menuEmail: top.querySelector('#ws-menu-email'),
            footAvatar: side.querySelector('#ws-foot-avatar'), footName: side.querySelector('#ws-foot-name'), footSub: side.querySelector('#ws-foot-sub'),
            host: host, page: page,
        };

        // ----- behaviour -----
        top.querySelector('#ws-hamb').addEventListener('click', function () { toggleDrawer(); });
        scrim.addEventListener('click', function () { closeDrawer(); });
        top.querySelector('#ws-search').addEventListener('click', function () {
            if (window.wsCmdK && window.wsCmdK.open) window.wsCmdK.open();
        });
        top.querySelector('.ws-theme-toggle').addEventListener('click', function () {
            if (window.WSTheme) window.WSTheme.toggle();
        });
        refs.userbtn.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(); });
        document.addEventListener('click', function (e) {
            if (!refs.menu.hidden && !refs.menu.contains(e.target)) toggleMenu(false);
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { toggleMenu(false); closeDrawer(); }
        });
        top.querySelector('#ws-menu-profile').addEventListener('click', function () {
            toggleMenu(false);
            if (typeof opts.onProfile === 'function') return opts.onProfile();
            location.href = '/#profile';
        });
        var signOut = function () { toggleMenu(false); doSignOut(); };
        top.querySelector('#ws-menu-out').addEventListener('click', signOut);
        side.querySelector('#ws-foot-out').addEventListener('click', signOut);
        side.querySelectorAll('.ws-side-item').forEach(function (a) {
            a.addEventListener('click', function () {
                closeDrawer();
                // Tab items: the page's switcher marks the active one; keep the breadcrumb in step.
                if (a.dataset.tab) { var it = findIn(nav, a.dataset.key); if (it) setCrumb(it.title); }
            });
        });

        // Keep the closed mobile drawer out of the keyboard focus order.
        var mobileNav = window.matchMedia('(max-width: 960px)');
        function syncDrawerVisibility() {
            side.inert = mobileNav.matches && !side.classList.contains('open');
        }
        mobileNav.addEventListener('change', syncDrawerVisibility);
        syncDrawerVisibility();
        renderUser();
        whenSupabase(bootUser);
    }

    // ----- drawer / menu -----
    function toggleDrawer(force) {
        var open = typeof force === 'boolean' ? force : !refs.side.classList.contains('open');
        refs.side.classList.toggle('open', open);
        refs.scrim.classList.toggle('open', open);
        document.getElementById('ws-hamb').setAttribute('aria-expanded', String(open));
        refs.side.inert = window.matchMedia('(max-width: 960px)').matches && !open;
        if (!open && refs.side.contains(document.activeElement)) document.getElementById('ws-hamb').focus();
        if (open) {
            var first = refs.side.querySelector('.ws-side-item');
            if (first) first.focus();
        }
    }
    function closeDrawer() { if (refs.side) toggleDrawer(false); }
    function toggleMenu(force) {
        if (!refs.menu) return;
        var show = typeof force === 'boolean' ? force : refs.menu.hidden;
        refs.menu.hidden = !show;
        refs.userbtn.setAttribute('aria-expanded', show ? 'true' : 'false');
    }

    // ----- user -----
    function setUser(user) {
        state.user = user ? {
            name: user.name || (user.email ? user.email.split('@')[0] : ''),
            email: user.email || '',
            avatar: user.avatar || '',
            company: user.company || '',
        } : null;
        state.explicitUser = true;
        renderUser();
    }
    function fillAvatar(el, u) {
        if (!el) return;
        if (u && u.avatar) el.innerHTML = '<img src="' + esc(u.avatar) + '" alt="">';
        else el.textContent = initialOf(u && (u.name || u.email));
    }
    function renderUser() {
        if (!refs.topAvatar) return;
        var u = state.user;
        fillAvatar(refs.topAvatar, u);
        fillAvatar(refs.footAvatar, u);
        refs.topName.textContent = u ? u.name : 'Sign in';
        refs.menuName.textContent = u ? u.name : 'Not signed in';
        refs.menuEmail.textContent = u ? u.email : '';
        refs.footName.textContent = u ? u.name : 'Not signed in';
        refs.footSub.textContent = u ? (u.company || u.email || 'WorkSuite') : 'WorkSuite';
    }
    function setCrumb(text) { if (refs.crumb) refs.crumb.textContent = text; }

    function whenSupabase(cb) {
        var tries = 0;
        (function poll() {
            var sb = window.__WS_SB__ || window.__WS_PRESENCE_SB__ || null;
            if (sb && sb.auth && sb.auth.getSession) return cb(sb);
            if (++tries > 150) return;           // 15s: the page never made a client
            setTimeout(poll, 100);
        })();
    }
    async function bootUser(sb) {
        state.sb = sb;
        try {
            var res = await sb.auth.getSession();
            var session = res && res.data && res.data.session;
            if (session) await hydrate(session);
            sb.auth.onAuthStateChange(function (ev, s) {
                if (ev === 'SIGNED_OUT') { state.uid = null; if (!state.explicitUser) { state.user = null; renderUser(); } setUnread(0); }
                else if (s && s.user && s.user.id !== state.uid) hydrate(s).catch(function () {});
            });
        } catch (e) { /* the shell is decoration; never break the page */ }
    }
    async function hydrate(session) {
        state.uid = session.user.id;
        var meta = session.user.user_metadata || {};
        if (!state.explicitUser) {
            state.user = { name: meta.full_name || session.user.email.split('@')[0], email: session.user.email, avatar: meta.avatar_url || '', company: meta.company || '' };
            renderUser();
        }
        try {
            var q = await state.sb.from('profiles').select('full_name,avatar_url,company,email').eq('id', state.uid).maybeSingle();
            var p = q && q.data;
            if (p && !state.explicitUser) {
                state.user = { name: p.full_name || state.user.name, email: p.email || state.user.email, avatar: p.avatar_url || state.user.avatar, company: p.company || state.user.company };
                renderUser();
            }
        } catch (e) { /* profile row is optional */ }
        refreshUnread();
        clearInterval(state.unreadTimer);
        state.unreadTimer = setInterval(refreshUnread, 30000);
    }
    async function refreshUnread() {
        if (!state.sb || !state.uid) return;
        try {
            var r = await state.sb.from('messages').select('id', { count: 'exact', head: true }).eq('recipient_id', state.uid).is('read_at', null);
            setUnread(r && r.count ? r.count : 0);
        } catch (e) { /* messages table is optional */ }
    }
    function setUnread(n) {
        if (refs.bell) refs.bell.classList.toggle('has', n > 0);
        var b = refs.side && refs.side.querySelector('[data-ws-badge="unread"]');
        if (b) { b.hidden = !(n > 0); b.textContent = n > 99 ? '99+' : String(n); }
        document.dispatchEvent(new CustomEvent('ws-unread', { detail: { count: n } }));
    }
    async function doSignOut() {
        if (typeof state.opts.onSignOut === 'function') return state.opts.onSignOut();
        try { if (state.sb) await state.sb.auth.signOut(); } catch (e) { /* fall through */ }
        location.replace('/');
    }

    // ----- toast -----
    function toast(message, kind) {
        if (!refs.host) return;
        var t = document.createElement('div');
        t.className = 'ws-toast' + (kind ? ' ' + kind : '');
        t.textContent = message;
        refs.host.appendChild(t);
        setTimeout(function () { t.style.opacity = '0'; t.style.transition = 'opacity 200ms'; }, 2600);
        setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2900);
    }

    window.WSShell = { mount: mount, setUser: setUser, setCrumb: setCrumb, toast: toast, refreshUnread: refreshUnread, closeDrawer: closeDrawer, NAV: NAV };
})();
