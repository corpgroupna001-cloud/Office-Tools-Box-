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
                     nav,            // optional: [{label, items:[{key,title,icon, href | tab, tag, badge, role}]}]
                     tools,          // optional HTML for the top bar (buttons the page wires itself)
                     pageClass,      // 'center' (old centred tool pages) | 'fill' (chat: no padding, full height)
                     onProfile, onSignOut })
     WSShell.setUser({ name, email, avatar, company } | null)
     WSShell.setCrumb(text)
     WSShell.toast(message, 'ok' | 'bad' | '')
     WSShell.refreshUnread()          // messages + notifications + tasks badges
     WSShell.setBadge('tasks', n)     // a page may push a count it already knows
     WSShell.role                     // 'employee' | 'manager' | 'admin' once known

   Sidebar groups follow the business modules: Workspace, CRM, Collaboration,
   People, Finance, Tools, Admin. Items carrying `role: 'manager' | 'admin'`
   stay hidden until the signed-in profile confirms the workspace role.
   The sidebar collapses to an icon rail on desktop (remembered per browser)
   and becomes a drawer under 960px.
   ============================================================================ */
(function () {
    'use strict';
    if (window.WSShell) return;

    var NAV = [
        { label: 'Workspace', items: [
            { key: 'home',       title: 'Dashboard',        href: '/',                 icon: 'home' },
            { key: 'attendance', title: 'My Attendance',    href: '/attendance/',      icon: 'attend' },
            { key: 'leave',      title: 'Leave & Holidays', href: '/attendance/#leave', icon: 'leave' },
        ]},
        { label: 'CRM', items: [
            { key: 'crm',        title: 'CRM',              href: '/crm/',        icon: 'dashboard' },
            { key: 'contacts',   title: 'Contacts',         href: '/contacts/',   icon: 'user' },
            { key: 'leads',      title: 'Leads',            href: '/leads/',      icon: 'target' },
            { key: 'deals',      title: 'Deals',            href: '/deals/',      icon: 'deal' },
        ]},
        { label: 'Collaboration', items: [
            { key: 'chat',       title: 'Messenger',        href: '/chat/',       icon: 'chat', badge: 'unread' },
            { key: 'boards',     title: 'Boards',           href: '/boards/',     icon: 'board' },
            { key: 'projects',   title: 'Projects',         href: '/projects/',   icon: 'folder' },
            { key: 'tasks',      title: 'Tasks',            href: '/tasks/',      icon: 'tasks', badge: 'tasks' },
            { key: 'documents',  title: 'Documents',        href: '/documents/',  icon: 'doc' },
            { key: 'calendar',   title: 'Calendar',         href: '/calendar/',   icon: 'calendar' },
        ]},
        { label: 'People', items: [
            { key: 'employees',  title: 'Employees',        href: '/employees/',  icon: 'users' },
        ]},
        { label: 'Finance', items: [
            { key: 'invoices',   title: 'Invoices',         href: '/invoices/',   icon: 'invoice', role: 'manager' },
        ]},
        { label: 'Tools', items: [
            { key: 'recordings', title: 'Friday Check-in',  href: '/recordings/', icon: 'video' },
            { key: 'signature',  title: 'Email Signature',  href: '/signature/',  icon: 'pen' },
            { key: 'typing',     title: 'Typing assessment',      href: '/typingtest/', icon: 'keyboard' },
            { key: 'quiz',       title: 'Knowledge assessments',  href: '/mcqquiz/',    icon: 'quiz' },
        ]},
        // The admin console keeps its own password gate; it is only listed for
        // people whose workspace role is admin, and never in the command palette.
        { label: 'Admin', items: [
            { key: 'admin',      title: 'Admin console',    href: '/wsm-admin',   icon: 'shield', role: 'admin' },
        ]},
    ];

    var COLLAPSE_KEY = 'ws-side-collapsed';
    var state = { mounted: false, opts: {}, user: null, explicitUser: false, sb: null, uid: null, unreadTimer: null, role: null,
                  counts: { unread: 0, notifications: 0, tasks: 0 }, notifOpen: false, notifChannel: null, notifItems: [] };
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
        var first = p.split('/')[1];
        var map = { chat: 'chat', messenger: 'chat', recordings: 'recordings', signature: 'signature', typingtest: 'typing', mcqquiz: 'quiz',
                    crm: 'crm', contacts: 'contacts', leads: 'leads', deals: 'deals', boards: 'boards', projects: 'projects', tasks: 'tasks',
                    documents: 'documents', calendar: 'calendar', employees: 'employees', invoices: 'invoices', admin: 'admin', 'wsm-admin': 'admin' };
        return map[first] || '';
    }
    function initialOf(name) {
        var s = String(name || '').trim();
        return s ? s.charAt(0).toUpperCase() : '?';
    }
    function navHtml(nav, active) {
        return nav.map(function (g) {
            var gated = g.items.every(function (it) { return it.role; });
            return '<div class="ws-side-group"' + (gated ? ' data-ws-role-group hidden' : '') + '>' + (g.label ? '<div class="label">' + esc(g.label) + '</div>' : '') +
                g.items.map(function (it) {
                    var extra = it.badge ? '<span class="badge" data-ws-badge="' + it.badge + '" hidden></span>'
                              : it.tag ? '<span class="tag">' + esc(it.tag) + '</span>' : '';
                    var inner = '<span class="ic ic-' + esc(it.icon) + '"></span><span>' + esc(it.title) + '</span>' + extra;
                    var cls = 'ws-side-item' + (it.key === active ? ' active' : '') + (it.cls ? ' ' + esc(it.cls) : '');
                    var attrs = ' data-key="' + esc(it.key) + '" data-tip="' + esc(it.title) + '"' + (it.role ? ' data-ws-role="' + esc(it.role) + '" hidden' : '') + (it.key === active ? ' aria-current="page"' : '');
                    // A "tab" item is a button the page's own switcher handles (data-tab);
                    // everything else is a plain link.
                    if (it.tab) return '<button type="button" class="' + cls + '" data-tab="' + esc(it.tab) + '"' + attrs + '>' + inner + '</button>';
                    return '<a class="' + cls + '" href="' + esc(it.href) + '"' + attrs + '>' + inner + '</a>';
                }).join('') + '</div>';
        }).join('');
    }
    function findIn(nav, key) {
        for (var g = 0; g < nav.length; g++) for (var i = 0; i < nav[g].items.length; i++) if (nav[g].items[i].key === key) return nav[g].items[i];
        return null;
    }
    function readCollapsed() { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch (e) { return false; } }
    function writeCollapsed(v) { try { v ? localStorage.setItem(COLLAPSE_KEY, '1') : localStorage.removeItem(COLLAPSE_KEY); } catch (e) { /* private mode */ } }

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
                '<button type="button" class="ws-side-collapse" id="ws-side-collapse" title="Collapse sidebar" aria-label="Collapse sidebar" aria-pressed="false"><span class="ic ic-collapse"></span></button>' +
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
            '<button type="button" class="ws-iconbtn" id="ws-bell" title="Notifications" aria-label="Notifications" aria-haspopup="dialog" aria-expanded="false"><span class="ic ic-bell"></span><span class="dot count" id="ws-bell-count"></span></button>' +
            '<div class="ws-notif" id="ws-notif" role="dialog" aria-label="Notifications" hidden>' +
                '<div class="head"><b>Notifications</b><button type="button" id="ws-notif-readall">Mark all read</button></div>' +
                '<a class="msgs" href="/chat/"><span class="ic ic-chat"></span>Messages<span class="n" id="ws-notif-msgs" hidden></span></a>' +
                '<div class="list" id="ws-notif-list"><div class="empty">Loading…</div></div>' +
            '</div>' +
            '<button type="button" class="ws-userbtn" id="ws-userbtn" aria-haspopup="menu" aria-expanded="false">' +
                '<span class="ws-avatar sm" id="ws-top-avatar">?</span><span class="nm" id="ws-top-name">…</span></button>' +
            '<div class="ws-menu" id="ws-menu" role="menu" hidden>' +
                '<div class="head"><b id="ws-menu-name">Not signed in</b><span id="ws-menu-email"></span></div>' +
                '<button type="button" role="menuitem" id="ws-menu-profile"><span class="ic ic-user"></span>Profile &amp; settings</button>' +
                '<a role="menuitem" href="/attendance/"><span class="ic ic-attend"></span>My attendance</a>' +
                '<a role="menuitem" href="/attendance/#leave"><span class="ic ic-leave"></span>Apply for leave</a>' +
                '<a role="menuitem" href="/tasks/?view=mine"><span class="ic ic-tasks"></span>My tasks</a>' +
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
        shell.className = 'ws-shell' + (readCollapsed() ? ' collapsed' : '');
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
            side: side, shell: shell, scrim: scrim, menu: top.querySelector('#ws-menu'), userbtn: top.querySelector('#ws-userbtn'),
            crumb: top.querySelector('#ws-crumb'), bell: top.querySelector('#ws-bell'), bellCount: top.querySelector('#ws-bell-count'),
            notif: top.querySelector('#ws-notif'), notifList: top.querySelector('#ws-notif-list'), notifMsgs: top.querySelector('#ws-notif-msgs'),
            topAvatar: top.querySelector('#ws-top-avatar'), topName: top.querySelector('#ws-top-name'),
            menuName: top.querySelector('#ws-menu-name'), menuEmail: top.querySelector('#ws-menu-email'),
            footAvatar: side.querySelector('#ws-foot-avatar'), footName: side.querySelector('#ws-foot-name'), footSub: side.querySelector('#ws-foot-sub'),
            collapse: side.querySelector('#ws-side-collapse'),
            host: host, page: page,
        };
        refs.collapse.setAttribute('aria-pressed', String(shell.classList.contains('collapsed')));

        // ----- behaviour -----
        top.querySelector('#ws-hamb').addEventListener('click', function () { toggleDrawer(); });
        scrim.addEventListener('click', function () { closeDrawer(); });
        top.querySelector('#ws-search').addEventListener('click', function () {
            if (window.wsCmdK && window.wsCmdK.open) window.wsCmdK.open();
        });
        top.querySelector('.ws-theme-toggle').addEventListener('click', function () {
            if (window.WSTheme) window.WSTheme.toggle();
        });
        refs.userbtn.addEventListener('click', function (e) { e.stopPropagation(); toggleNotif(false); toggleMenu(); });
        refs.bell.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(false); toggleNotif(); });
        top.querySelector('#ws-notif-readall').addEventListener('click', function () { markAllRead(); });
        refs.notifList.addEventListener('click', function (e) {
            var a = e.target.closest('[data-notif]');
            if (!a) return;
            e.preventDefault();
            openNotification(a.dataset.notif, a.getAttribute('href'));
        });
        document.addEventListener('click', function (e) {
            if (!refs.menu.hidden && !refs.menu.contains(e.target)) toggleMenu(false);
            if (!refs.notif.hidden && !refs.notif.contains(e.target) && !refs.bell.contains(e.target)) toggleNotif(false);
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { toggleMenu(false); toggleNotif(false); closeDrawer(); }
        });
        top.querySelector('#ws-menu-profile').addEventListener('click', function () {
            toggleMenu(false);
            if (typeof opts.onProfile === 'function') return opts.onProfile();
            location.href = '/#profile';
        });
        var signOut = function () { toggleMenu(false); doSignOut(); };
        top.querySelector('#ws-menu-out').addEventListener('click', signOut);
        side.querySelector('#ws-foot-out').addEventListener('click', signOut);
        refs.collapse.addEventListener('click', function () {
            var on = !shell.classList.contains('collapsed');
            shell.classList.toggle('collapsed', on);
            writeCollapsed(on);
            refs.collapse.setAttribute('aria-pressed', String(on));
            refs.collapse.title = on ? 'Expand sidebar' : 'Collapse sidebar';
            document.dispatchEvent(new CustomEvent('ws-sidebar', { detail: { collapsed: on } }));
        });
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

    // ----- drawer / menu / notifications -----
    function toggleDrawer(force) {
        var open = typeof force === 'boolean' ? force : !refs.side.classList.contains('open');
        refs.side.classList.toggle('open', open);
        refs.scrim.classList.toggle('open', open);
        document.getElementById('ws-hamb').setAttribute('aria-expanded', String(open));
        refs.side.inert = window.matchMedia('(max-width: 960px)').matches && !open;
        if (!open && refs.side.contains(document.activeElement)) document.getElementById('ws-hamb').focus();
        if (open) {
            var first = refs.side.querySelector('.ws-side-item:not([hidden])');
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
    function toggleNotif(force) {
        if (!refs.notif) return;
        var show = typeof force === 'boolean' ? force : refs.notif.hidden;
        refs.notif.hidden = !show;
        refs.bell.setAttribute('aria-expanded', show ? 'true' : 'false');
        state.notifOpen = show;
        if (show) { loadNotifications(); setTimeout(function () { var f = refs.notif.querySelector('a, button'); if (f) f.focus(); }, 20); }
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
    function setRole(role) {
        state.role = role || 'employee';
        var rank = { employee: 0, manager: 1, admin: 2 };
        var mine = rank[state.role] || 0;
        if (!refs.side) return;
        refs.side.querySelectorAll('[data-ws-role]').forEach(function (el) {
            el.hidden = (rank[el.dataset.wsRole] || 0) > mine;
        });
        refs.side.querySelectorAll('[data-ws-role-group]').forEach(function (g) {
            g.hidden = !g.querySelector('.ws-side-item:not([hidden])');
        });
        document.dispatchEvent(new CustomEvent('ws-role', { detail: { role: state.role } }));
    }

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
                if (ev === 'SIGNED_OUT') { state.uid = null; if (!state.explicitUser) { state.user = null; renderUser(); } setCounts({ unread: 0, notifications: 0, tasks: 0 }); }
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
            var q = await state.sb.from('profiles').select('full_name,avatar_url,company,email,app_role').eq('id', state.uid).maybeSingle();
            var p = q && q.data;
            if (q && q.error && String(q.error.code) === '42703') {
                // app_role does not exist before the CRM migration: read the rest and stay an employee.
                var q2 = await state.sb.from('profiles').select('full_name,avatar_url,company,email').eq('id', state.uid).maybeSingle();
                p = q2 && q2.data;
            }
            if (p && !state.explicitUser) {
                state.user = { name: p.full_name || state.user.name, email: p.email || state.user.email, avatar: p.avatar_url || state.user.avatar, company: p.company || state.user.company };
                renderUser();
            }
            setRole(p && p.app_role ? p.app_role : 'employee');
        } catch (e) { setRole('employee'); }
        refreshUnread();
        clearInterval(state.unreadTimer);
        state.unreadTimer = setInterval(refreshUnread, 30000);
        watchNotifications();
    }

    // ----- badges: messages, notifications, tasks -----
    async function refreshUnread() {
        if (!state.sb || !state.uid) return;
        var counts = { unread: state.counts.unread, notifications: state.counts.notifications, tasks: state.counts.tasks };
        try {
            // Direct + group unread in one call once the messenger migration exists; the old count otherwise.
            var rpc = await state.sb.rpc('ws_unread_counts');
            if (!rpc.error && rpc.data && rpc.data[0]) counts.unread = Number(rpc.data[0].total) || 0;
            else {
                var r = await state.sb.from('messages').select('id', { count: 'exact', head: true }).eq('recipient_id', state.uid).is('read_at', null);
                counts.unread = r && r.count ? r.count : 0;
            }
        } catch (e) { /* messages table is optional */ }
        try {
            var n = await state.sb.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', state.uid).is('read_at', null);
            counts.notifications = !n.error && n.count ? n.count : 0;
        } catch (e) { counts.notifications = 0; }
        try {
            // Meaningful outstanding work: my open tasks that are overdue or due today.
            var today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
            var t = await state.sb.from('tasks').select('id', { count: 'exact', head: true })
                .eq('assignee_id', state.uid).is('archived_at', null).is('completed_at', null).lte('due_date', today);
            counts.tasks = !t.error && t.count ? t.count : 0;
        } catch (e) { counts.tasks = 0; }
        setCounts(counts);
    }
    function setCounts(c) {
        state.counts = c;
        setBadge('unread', c.unread);
        setBadge('tasks', c.tasks);
        var total = (c.unread || 0) + (c.notifications || 0);
        if (refs.bell) {
            refs.bell.classList.toggle('has', total > 0);
            refs.bellCount.textContent = total > 99 ? '99+' : String(total);
            refs.bell.title = total ? total + ' unread' : 'Notifications';
        }
        if (refs.notifMsgs) { refs.notifMsgs.hidden = !(c.unread > 0); refs.notifMsgs.textContent = c.unread > 99 ? '99+' : String(c.unread); }
        document.dispatchEvent(new CustomEvent('ws-unread', { detail: { count: c.unread, notifications: c.notifications, tasks: c.tasks } }));
    }
    function setBadge(name, n) {
        var b = refs.side && refs.side.querySelector('[data-ws-badge="' + name + '"]');
        if (b) { b.hidden = !(n > 0); b.textContent = n > 99 ? '99+' : String(n); }
        if (state.counts && name in state.counts) state.counts[name] = n;
    }
    function setUnread(n) { setCounts(Object.assign({}, state.counts, { unread: n })); }

    // ----- notification panel -----
    async function loadNotifications() {
        if (!state.sb || !state.uid || !refs.notifList) return;
        try {
            var r = await state.sb.from('notifications').select('id,kind,title,body,url,read_at,created_at').eq('user_id', state.uid).order('created_at', { ascending: false }).limit(30);
            if (r.error) throw r.error;
            state.notifItems = r.data || [];
            renderNotifications();
        } catch (e) {
            refs.notifList.innerHTML = '<div class="empty">' + (String(e.code) === '42P01' || String(e.code) === 'PGRST205' ? 'Notifications are not set up yet.' : 'Could not load notifications.') + '</div>';
        }
    }
    function relTime(iso) {
        var d = new Date(iso); if (isNaN(d)) return '';
        var s = (Date.now() - d) / 1000;
        if (s < 60) return 'just now';
        if (s < 3600) return Math.round(s / 60) + 'm ago';
        if (s < 86400) return Math.round(s / 3600) + 'h ago';
        if (s < 7 * 86400) return Math.round(s / 86400) + 'd ago';
        return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
    }
    function renderNotifications() {
        if (!state.notifItems.length) { refs.notifList.innerHTML = '<div class="empty">You are all caught up.</div>'; return; }
        refs.notifList.innerHTML = state.notifItems.map(function (n) {
            return '<a class="item' + (n.read_at ? ' read' : '') + '" href="' + esc(n.url || '#') + '" data-notif="' + esc(n.id) + '">' +
                '<span class="dot"></span><span class="t"><b>' + esc(n.title) + '</b>' + (n.body ? '<span>' + esc(n.body) + '</span>' : '') + '<small>' + esc(relTime(n.created_at)) + '</small></span></a>';
        }).join('');
    }
    async function openNotification(id, url) {
        var n = state.notifItems.filter(function (x) { return x.id === id; })[0];
        if (n && !n.read_at) {
            n.read_at = new Date().toISOString();
            try { await state.sb.from('notifications').update({ read_at: n.read_at }).eq('id', id); } catch (e) { /* best effort */ }
            setCounts(Object.assign({}, state.counts, { notifications: Math.max(0, state.counts.notifications - 1) }));
        }
        toggleNotif(false);
        if (url && url !== '#') location.href = url;
    }
    async function markAllRead() {
        try { await state.sb.from('notifications').update({ read_at: new Date().toISOString() }).eq('user_id', state.uid).is('read_at', null); } catch (e) { /* best effort */ }
        state.notifItems.forEach(function (n) { n.read_at = n.read_at || new Date().toISOString(); });
        renderNotifications();
        setCounts(Object.assign({}, state.counts, { notifications: 0 }));
    }
    function watchNotifications() {
        if (state.notifChannel || !state.sb || !state.uid || !state.sb.channel) return;
        try {
            state.notifChannel = state.sb.channel('shell:notif:' + state.uid)
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: 'user_id=eq.' + state.uid }, function (payload) {
                    var n = payload && payload.new;
                    if (!n) return;
                    state.notifItems.unshift(n);
                    if (state.notifOpen) renderNotifications();
                    setCounts(Object.assign({}, state.counts, { notifications: (state.counts.notifications || 0) + 1 }));
                    if (n.kind === 'task.assigned' || n.kind === 'task.reopened') refreshUnread();
                })
                .subscribe();
        } catch (e) { /* realtime is optional */ }
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
        t.setAttribute('role', 'status');
        refs.host.appendChild(t);
        setTimeout(function () { t.style.opacity = '0'; t.style.transition = 'opacity 200ms'; }, 2600);
        setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2900);
    }

    window.WSShell = {
        mount: mount, setUser: setUser, setCrumb: setCrumb, toast: toast, refreshUnread: refreshUnread, setUnread: setUnread, setBadge: setBadge,
        closeDrawer: closeDrawer, NAV: NAV,
        get role() { return state.role; },
        get counts() { return state.counts; },
    };
})();
