/* ============================================================================
   WorkSuite — application shell

   Include at the END of the page markup, before the page's own scripts:

       <body class="ws-app ws-corporate ws-b24">
           ...page content...
           <script src="/ui/shell.js"></script>
           <script>WSShell.mount({ active: 'leads', layout: 'b24' });</script>
           ...page scripts...

   mount() runs synchronously: it builds the chrome and moves everything
   already in <body> into the page column, so every id the page's scripts
   look up is still there — just inside .ws-page. Fixed overlays keep working.

   The layout follows Bitrix24's: a wallpaper, a customisable left menu
   (reorder, hide, "More", collapse), a header with search, the work-day clock,
   the company, Invite, Help and the user menu, module tabs above the page, a
   messenger bar on the right, a footer with Themes, and slide-over panels
   for records (WSShell.openSlider). Inside a slide-over (?slider=1) the same
   page renders without chrome.

   API
     WSShell.mount({ active, crumb, crumbPrefix, title, subtitle, brandSub,
                     layout,         // 'b24': the page draws its own title row and white areas
                     nav,            // optional grouped nav (the admin console): [{label, items:[{key,title,icon, href | tab, badge, role}]}]
                     tools,          // optional HTML for the header (buttons the page wires itself)
                     pageClass,      // 'center' | 'fill' (chat: no padding, full height)
                     tabs,           // optional [{key,title,href}] to replace the module tabs
                     onProfile, onSignOut })
     WSShell.setUser({ name, email, avatar, company } | null)
     WSShell.setCrumb(text)              the page title in the header
     WSShell.toast(message, 'ok' | 'bad' | '')
     WSShell.refreshUnread()             messages + notifications + tasks counters
     WSShell.setUnread(n), WSShell.setBadge('tasks', n), WSShell.setTabCount(key, n)
     WSShell.openSlider(url, { width, onClose, onMessage }) / closeSlider()
     WSShell.sliderMessage(type, data)   from inside a slide-over to the page that opened it
     WSShell.inSlider                    true inside a slide-over
     WSShell.openThemes(), WSShell.configureMenu()
     WSShell.role, WSShell.counts, WSShell.NAV
   Events on document: ws-role, ws-unread, ws-sidebar, ws-slider-message, ws-slider-closed.
   ============================================================================ */
(function () {
    'use strict';
    if (window.WSShell) return;

    // Every destination, for the menu and the command palette. Items with
    // `menu: false` are reached through a module's tabs; `section` names the
    // menu item that stays lit for them.
    var NAV = [
        { label: 'Workspace', items: [
            { key: 'home',       title: 'Home',               href: '/',            icon: 'home' },
            { key: 'chat',       title: 'Messenger',          href: '/chat/',       icon: 'chat', badge: 'unread' },
            { key: 'calendar',   title: 'Calendar',           href: '/calendar/',   icon: 'calendar' },
            { key: 'documents',  title: 'Documents',          href: '/documents/',  icon: 'doc' },
            { key: 'boards',     title: 'Boards',             href: '/boards/',     icon: 'board' },
        ]},
        { label: 'Tasks and Projects', items: [
            { key: 'tasks',      title: 'Tasks and Projects', href: '/tasks/',      icon: 'tasks', badge: 'tasks' },
            { key: 'projects',   title: 'Projects',           href: '/projects/',   icon: 'folder', menu: false, section: 'tasks' },
        ]},
        { label: 'CRM', items: [
            { key: 'crm',        title: 'CRM',                href: '/deals/',      icon: 'deal' },
            { key: 'deals',      title: 'Deals',              href: '/deals/',      icon: 'deal',    menu: false, section: 'crm' },
            { key: 'leads',      title: 'Leads',              href: '/leads/',      icon: 'target',  menu: false, section: 'crm' },
            { key: 'contacts',   title: 'Contacts',           href: '/contacts/',   icon: 'user',    menu: false, section: 'crm' },
            { key: 'companies',  title: 'Companies',          href: '/companies/',  icon: 'building', menu: false, section: 'crm' },
            { key: 'invoices',   title: 'Invoices',           href: '/invoices/',   icon: 'invoice', menu: false, section: 'crm' },
        ]},
        { label: 'Company', items: [
            { key: 'employees',  title: 'Employees',          href: '/employees/',  icon: 'users' },
            { key: 'attendance', title: 'Time and attendance', href: '/attendance/', icon: 'attend' },
            { key: 'leave',      title: 'Leave and holidays', href: '/attendance/#leave', icon: 'leave', menu: false, section: 'attendance' },
        ]},
        { label: 'Tools', items: [
            { key: 'recordings', title: 'Friday Check-in',    href: '/recordings/', icon: 'video' },
            { key: 'signature',  title: 'Email Signature',    href: '/signature/',  icon: 'pen' },
            { key: 'typing',     title: 'Typing assessment',  href: '/typingtest/', icon: 'keyboard' },
            { key: 'quiz',       title: 'Knowledge assessments', href: '/mcqquiz/', icon: 'quiz' },
        ]},
        // The admin console keeps its own password gate; it is only listed for
        // people whose workspace role is admin.
        { label: 'Admin', items: [
            { key: 'admin',      title: 'Admin console',      href: '/wsm-admin',   icon: 'shield', role: 'admin' },
        ]},
    ];

    // The horizontal menu above a page, per section.
    var TABS = {
        crm: [
            { key: 'deals',    title: 'Deals',     href: '/deals/' },
            { key: 'leads',    title: 'Leads',     href: '/leads/' },
            { key: 'contacts', title: 'Contacts',  href: '/contacts/' },
            { key: 'companies', title: 'Companies', href: '/companies/' },
            { key: 'invoices', title: 'Invoices',  href: '/invoices/' },
            { key: 'crm',      title: 'Analytics', href: '/crm/' },
        ],
        tasks: [
            { key: 'tasks',    title: 'Tasks',     href: '/tasks/' },
            { key: 'projects', title: 'Projects',  href: '/projects/' },
        ],
        attendance: [
            { key: 'attendance', title: 'My attendance',      href: '/attendance/' },
            { key: 'leave',      title: 'Leave and holidays', href: '/attendance/#leave' },
        ],
    };

    // WorkSuite's own wallpapers (ui/b24.css draws them).
    var WALLPAPERS = [
        { key: 'azure',    title: 'Azure' },
        { key: 'lagoon',   title: 'Lagoon' },
        { key: 'dusk',     title: 'Dusk' },
        { key: 'forest',   title: 'Forest' },
        { key: 'aurora',   title: 'Aurora' },
        { key: 'graphite', title: 'Graphite' },
        { key: 'sand',     title: 'Sand' },
        { key: 'light',    title: 'Light (no wallpaper)' },
    ];

    var COLLAPSE_KEY = 'ws-side-collapsed', MENU_KEY = 'ws-menu', WALL_KEY = 'ws-wallpaper';
    var state = {
        mounted: false, opts: {}, user: null, explicitUser: false, sb: null, uid: null, role: null, company: '',
        unreadTimer: null, clockTimer: null, railTimer: null, counts: { unread: 0, notifications: 0, tasks: 0 },
        notifOpen: false, notifChannel: null, notifItems: [], menu: { order: [], hidden: [] }, sliders: [], inSlider: false,
        attendance: null,
    };
    var refs = {};

    // ----- helpers -----
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function $(sel, root) { return (root || document).querySelector(sel); }
    function store(key, value) {
        try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); } catch (e) { /* private mode */ }
    }
    function load(key, json) {
        try { var v = localStorage.getItem(key); return json ? (v ? JSON.parse(v) : null) : v; } catch (e) { return null; }
    }
    function allItems(nav) { return (nav || NAV).reduce(function (a, g) { return a.concat(g.items); }, []); }
    function findIn(nav, key) { return allItems(nav).filter(function (it) { return it.key === key; })[0] || null; }
    function menuItems() { return allItems(NAV).filter(function (it) { return it.menu !== false; }); }
    function guessActive() {
        var p = location.pathname.replace(/\/+$/, '') || '/';
        if (p === '/' || p === '/index.html') return 'home';
        if (p.indexOf('/attendance') === 0) return location.hash === '#leave' || location.hash === '#holidays' ? 'leave' : 'attendance';
        var first = p.split('/')[1];
        var map = { chat: 'chat', messenger: 'chat', recordings: 'recordings', signature: 'signature', typingtest: 'typing', mcqquiz: 'quiz',
                    crm: 'crm', contacts: 'contacts', companies: 'companies', leads: 'leads', deals: 'deals', boards: 'boards', projects: 'projects', tasks: 'tasks',
                    documents: 'documents', calendar: 'calendar', employees: 'employees', invoices: 'invoices', admin: 'admin', 'wsm-admin': 'admin' };
        return map[first] || '';
    }
    function sectionOf(key) { var it = findIn(NAV, key); return it ? (it.section || it.key) : key; }
    function initialOf(name) { var s = String(name || '').trim(); return s ? s.charAt(0).toUpperCase() : '?'; }
    function avatarHtml(name, url, cls) {
        return '<span class="ws-avatar' + (cls ? ' ' + cls : '') + '">' + (url ? '<img src="' + esc(url) + '" alt="">' : esc(initialOf(name))) + '</span>';
    }
    function istToday() {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    }
    function istTime(d, withAmPm) {
        var s = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
        return withAmPm ? s : s.replace(/\s?[ap]\.?m\.?$/i, '');
    }
    function amPm(d) { return /pm/i.test(istTime(d, true)) ? 'PM' : 'AM'; }
    function readCollapsed() { return load(COLLAPSE_KEY) === '1'; }
    function writeCollapsed(v) { store(COLLAPSE_KEY, v ? '1' : null); }
    function sliderParam() {
        try { return new URLSearchParams(location.search).get('slider') === '1' && window.parent !== window; } catch (e) { return false; }
    }

    // ----- menu model: order + hidden, per person (browser first, then the account) -----
    function normaliseMenu(m) {
        var keys = menuItems().map(function (it) { return it.key; });
        var order = (m && Array.isArray(m.order) ? m.order : []).filter(function (k) { return keys.indexOf(k) >= 0; });
        keys.forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });
        var hidden = (m && Array.isArray(m.hidden) ? m.hidden : []).filter(function (k) { return keys.indexOf(k) >= 0 && k !== 'home'; });
        return { order: order, hidden: hidden };
    }
    function saveMenu() {
        store(MENU_KEY, state.menu);
        saveSetting('menu', state.menu);
    }
    async function saveSetting(key, value) {
        if (!state.sb || !state.uid) return;
        try { await state.sb.from('user_ui_settings').upsert({ user_id: state.uid, key: key, value: value, updated_at: new Date().toISOString() }); }
        catch (e) { /* the table arrives with supabase-b24-migration.sql; the browser copy still works */ }
    }
    async function loadSettings() {
        if (!state.sb || !state.uid) return;
        try {
            var r = await state.sb.from('user_ui_settings').select('key,value').eq('user_id', state.uid).in('key', ['menu', 'theme']);
            if (r.error || !r.data) return;
            r.data.forEach(function (row) {
                if (row.key === 'menu' && row.value && JSON.stringify(normaliseMenu(row.value)) !== JSON.stringify(state.menu)) {
                    state.menu = normaliseMenu(row.value); store(MENU_KEY, state.menu); renderMenu();
                }
                if (row.key === 'theme' && row.value && row.value.wallpaper && row.value.wallpaper !== currentWallpaper()) applyWallpaper(row.value.wallpaper, false);
            });
        } catch (e) { /* optional */ }
    }

    // ----- wallpaper -----
    function currentWallpaper() {
        var w = load(WALL_KEY);
        return WALLPAPERS.some(function (x) { return x.key === w; }) ? w : 'azure';
    }
    function applyWallpaper(key, persist) {
        document.documentElement.setAttribute('data-wallpaper', key);
        store(WALL_KEY, key);
        if (persist !== false) saveSetting('theme', { wallpaper: key, mode: window.WSTheme ? WSTheme.current() : 'light' });
    }

    // ----- markup -----
    function itemHtml(it, active, editable) {
        var cls = 'ws-side-item' + (it.key === active ? ' active' : '');
        var extra = it.badge ? '<span class="badge" data-ws-badge="' + esc(it.badge) + '" hidden></span>' : '';
        var attrs = ' data-key="' + esc(it.key) + '" data-tip="' + esc(it.title) + '"' + (it.role ? ' data-ws-role="' + esc(it.role) + '" hidden' : '') +
                    (it.key === active ? ' aria-current="page"' : '');
        var inner = (editable ? '<span class="grip" aria-hidden="true">⋮⋮</span>' : '') +
                    '<span class="ic ic-' + esc(it.icon) + '"></span><span class="t">' + esc(it.title) + '</span>' + extra +
                    (editable && it.key !== 'home' ? '<button type="button" class="hide-btn" data-hide="' + esc(it.key) + '">' + (state.menu.hidden.indexOf(it.key) >= 0 ? 'Show' : 'Hide') + '</button>' : '');
        if (it.tab) return '<button type="button" class="' + cls + '" data-tab="' + esc(it.tab) + '"' + attrs + '>' + inner + '</button>';
        return '<a class="' + cls + '" href="' + esc(it.href) + '"' + attrs + (editable ? ' draggable="true"' : '') + '>' + inner + '</a>';
    }
    // The admin console passes its own grouped nav of in-page tabs.
    function groupedNavHtml(nav, active) {
        return nav.map(function (g) {
            var gated = g.items.every(function (it) { return it.role; });
            return '<div class="ws-side-group"' + (gated ? ' data-ws-role-group hidden' : '') + '>' + (g.label ? '<div class="label">' + esc(g.label) + '</div>' : '') +
                g.items.map(function (it) { return itemHtml(it, active, false); }).join('') + '</div>';
        }).join('');
    }
    function renderMenu() {
        if (!refs.menuMain || state.opts.nav) return;
        var active = sectionOf(state.active);
        var byKey = {}; menuItems().forEach(function (it) { byKey[it.key] = it; });
        var editing = refs.side.classList.contains('editing');
        var shown = state.menu.order.filter(function (k) { return state.menu.hidden.indexOf(k) < 0; });
        var hidden = state.menu.order.filter(function (k) { return state.menu.hidden.indexOf(k) >= 0; });
        refs.menuMain.innerHTML = shown.map(function (k) { return itemHtml(byKey[k], active, editing); }).join('');
        refs.menuHidden.innerHTML = hidden.map(function (k) { return itemHtml(byKey[k], active, editing); }).join('');
        // A hidden page that is open right now keeps its section visible.
        if (hidden.indexOf(active) >= 0 || (editing && hidden.length)) refs.menuHidden.hidden = false;
        refs.menuMore.hidden = !hidden.length;
        refs.menuMore.querySelector('span:last-child').textContent = refs.menuHidden.hidden ? 'More (' + hidden.length + ')' : 'Hide';
        if (state.role) setRole(state.role);
        setCounts(state.counts);
    }
    function tabsHtml(tabs, active) {
        return tabs.map(function (t) {
            return '<a href="' + esc(t.href) + '" data-tab-key="' + esc(t.key) + '"' + (t.key === active ? ' class="active" aria-current="page"' : '') +
                (t.role ? ' data-ws-role="' + esc(t.role) + '" hidden' : '') + '>' + esc(t.title) + '<span class="n" hidden></span></a>';
        }).join('');
    }

    // ----- mount -----
    function mount(opts) {
        opts = opts || {};
        if (state.mounted) return;
        var body = document.body;
        if (!body) throw new Error('WSShell.mount: call it after the page markup, not in <head>');
        state.mounted = true;
        state.opts = opts;
        state.active = opts.active || guessActive();
        state.inSlider = sliderParam();
        body.classList.add('ws-app', 'ws-b24');
        // Every page links ui/b24.css in <head>; one that does not still gets the layout.
        if (!document.querySelector('link[href$="/ui/b24.css"]')) {
            var css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = '/ui/b24.css';
            document.head.appendChild(css);
        }
        applyWallpaper(currentWallpaper(), false);
        state.menu = normaliseMenu(load(MENU_KEY, true));

        var nav = opts.nav || NAV;
        var item = findIn(nav, state.active);
        var crumb = opts.crumb || (item ? item.title : document.title.split('·')[0].trim());

        // ----- page column: everything that was in <body> moves here -----
        var page = document.createElement('div');
        page.className = 'ws-page' + (opts.pageClass ? ' ' + opts.pageClass : '') + (opts.layout === 'b24' ? '' : ' legacy');
        page.id = 'ws-page';
        page.setAttribute('tabindex', '-1');
        if (opts.title) {
            var head = document.createElement('div');
            head.className = 'ws-page-head';
            head.innerHTML = '<div><h1>' + esc(opts.title) + '</h1>' + (opts.subtitle ? '<p>' + esc(opts.subtitle) + '</p>' : '') + '</div>';
            page.appendChild(head);
        }
        Array.prototype.slice.call(body.childNodes).forEach(function (n) {
            if (n.nodeType === 1 && (n.tagName === 'SCRIPT' || n.hasAttribute('data-ws-outside'))) return;
            page.appendChild(n);
        });

        var host = document.createElement('div');
        host.className = 'ws-toast-host';
        host.id = 'ws-toast-host';

        if (state.inSlider) {
            // Inside a slide-over: the page alone. The opener owns the chrome.
            body.classList.add('ws-in-slider');
            var bare = document.createElement('div');
            bare.className = 'ws-shell';
            var bareMain = document.createElement('div');
            bareMain.className = 'ws-main';
            bareMain.appendChild(page);
            bare.appendChild(bareMain);
            body.insertBefore(bare, body.firstChild);
            body.appendChild(host);
            refs = { page: page, host: host, shell: bare };
            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && !document.querySelector('.ws-modal-backdrop, .ws-crm-modal, [role="dialog"]:not([hidden])')) closeSlider();
            });
            whenSupabase(bootUser);
            return;
        }

        var showRail = !opts.nav && opts.pageClass !== 'fill';

        // ----- left menu -----
        var side = document.createElement('aside');
        side.className = 'ws-side';
        side.id = 'ws-side';
        side.setAttribute('aria-label', 'Main navigation');
        side.innerHTML =
            '<div class="ws-side-brand">' +
                '<button type="button" class="burger" id="ws-burger" title="Collapse menu" aria-label="Collapse menu" aria-pressed="false"><span class="ic ic-menu"></span></button>' +
                '<a class="logo" href="/"><b>WorkSuite</b>' + (opts.brandSub ? '<span class="mark">' + esc(opts.brandSub) + '</span>' : '') + '</a>' +
            '</div>' +
            '<nav class="ws-side-nav" id="ws-side-nav">' +
                (opts.nav ? groupedNavHtml(opts.nav, state.active) :
                    '<div id="ws-menu-main"></div>' +
                    '<button type="button" class="ws-side-more" id="ws-menu-more" hidden><span class="ic ic-chevron"></span><span>More</span></button>' +
                    '<div class="ws-side-hidden" id="ws-menu-hidden" hidden></div>' +
                    '<div class="ws-side-sep"></div>' +
                    '<div class="ws-side-edit-bar"><button type="button" id="ws-menu-reset">Reset</button><button type="button" class="primary" id="ws-menu-done">Done</button></div>' +
                    '<button type="button" class="ws-side-link" id="ws-menu-config"><span class="ic ic-edit"></span><span>Configure menu</span></button>' +
                    '<a class="ws-side-link" href="/wsm-admin" data-ws-role="admin" hidden><span class="ic ic-plus"></span><span>Invite users</span></a>') +
            '</nav>' +
            '<div class="ws-side-foot">' +
                '<button type="button" class="ws-side-link" id="ws-foot-out"><span class="ic ic-logout"></span><span>Sign out</span></button>' +
            '</div>';

        // ----- header -----
        var top = document.createElement('header');
        top.className = 'ws-top';
        top.innerHTML =
            '<button type="button" class="ws-top-btn round ws-hamb" id="ws-hamb" aria-label="Open navigation" aria-controls="ws-side" aria-expanded="false"><span class="ic ic-menu"></span></button>' +
            '<button type="button" class="ws-top-search" id="ws-search" title="Search (Ctrl/Cmd + K)"><span class="ic ic-search sm"></span><span class="ph">Find people, documents and more</span><span class="kbd">⌘K</span></button>' +
            '<div class="crumb">' + esc(opts.crumbPrefix || 'WorkSuite') + ' <span aria-hidden="true">›</span> <b id="ws-crumb">' + esc(crumb) + '</b></div>' +
            '<div class="spacer"></div>' +
            (opts.tools ? '<div class="ws-top-tools">' + opts.tools + '</div>' : '') +
            '<button type="button" class="ws-top-btn ws-clock" id="ws-clock" aria-haspopup="dialog" aria-expanded="false" title="Work day">' +
                '<span class="time" id="ws-clock-time"></span><span class="state" id="ws-clock-state"><i></i><span>Work day</span></span></button>' +
            '<span class="company" id="ws-company"></span>' +
            '<a class="ws-top-btn outline hide-sm" id="ws-invite" href="/wsm-admin" data-ws-role="admin" hidden><span class="ic ic-plus"></span><span>Invite</span></a>' +
            '<button type="button" class="ws-top-btn round" id="ws-help" title="Help" aria-label="Help" aria-haspopup="menu" aria-expanded="false"><span class="ic ic-help"></span></button>' +
            '<button type="button" class="ws-theme-toggle" data-ws-theme data-ws-theme-ready="1" aria-label="Switch between light and dark" title="Switch between light and dark">' +
                '<span class="moon ic ic-moon" aria-hidden="true"></span><span class="sun ic ic-sun" aria-hidden="true"></span></button>' +
            '<button type="button" class="ws-top-btn round' + (showRail ? ' only-narrow' : '') + '" id="ws-bell" title="Notifications" aria-label="Notifications" aria-haspopup="dialog" aria-expanded="false">' +
                '<span class="ic ic-bell"></span><span class="count" id="ws-bell-count" hidden></span></button>' +
            '<button type="button" class="ws-userbtn" id="ws-userbtn" aria-haspopup="menu" aria-expanded="false">' +
                '<span class="ws-avatar sm" id="ws-top-avatar">?</span><span class="nm" id="ws-top-name">…</span></button>';

        var userMenu = document.createElement('div');
        userMenu.className = 'ws-menu';
        userMenu.id = 'ws-menu';
        userMenu.setAttribute('role', 'menu');
        userMenu.hidden = true;
        userMenu.innerHTML =
            '<div class="head"><b id="ws-menu-name">Not signed in</b><span id="ws-menu-email"></span></div>' +
            '<button type="button" role="menuitem" id="ws-menu-profile"><span class="ic ic-user"></span>Profile &amp; settings</button>' +
            '<a role="menuitem" href="/attendance/"><span class="ic ic-attend"></span>My attendance</a>' +
            '<a role="menuitem" href="/attendance/#leave"><span class="ic ic-leave"></span>Apply for leave</a>' +
            '<a role="menuitem" href="/tasks/?view=mine"><span class="ic ic-tasks"></span>My tasks</a>' +
            '<button type="button" role="menuitem" data-act="themes"><span class="ic ic-sun"></span>Themes</button>' +
            '<button type="button" role="menuitem" data-act="menu"><span class="ic ic-edit"></span>Configure menu</button>' +
            '<button type="button" role="menuitem" class="danger" id="ws-menu-out"><span class="ic ic-logout"></span>Sign out</button>';

        var notif = document.createElement('div');
        notif.className = 'ws-notif' + (showRail ? '' : ' no-rail');
        notif.id = 'ws-notif';
        notif.setAttribute('role', 'dialog');
        notif.setAttribute('aria-label', 'Notifications');
        notif.hidden = true;
        notif.innerHTML =
            '<div class="head"><b>Notifications</b><button type="button" id="ws-notif-readall">Mark all read</button>' +
                '<button type="button" class="x" id="ws-notif-close" aria-label="Close"><span class="ic ic-x"></span></button></div>' +
            '<a class="msgs" href="/chat/"><span class="ic ic-chat"></span>Messages<span class="n" id="ws-notif-msgs" hidden></span></a>' +
            '<div class="list" id="ws-notif-list"><div class="empty">Loading…</div></div>';

        // ----- module tabs -----
        var tabs = opts.tabs || (opts.nav ? null : TABS[sectionOf(state.active)]);
        var tabBar = null;
        if (tabs && tabs.length) {
            tabBar = document.createElement('nav');
            tabBar.className = 'ws-tabs';
            tabBar.id = 'ws-tabs';
            tabBar.setAttribute('aria-label', 'Section');
            tabBar.innerHTML = tabsHtml(tabs, state.active);
        }

        // ----- right messenger bar -----
        var rail = null;
        if (showRail) {
            rail = document.createElement('aside');
            rail.className = 'ws-rail';
            rail.id = 'ws-rail';
            rail.setAttribute('aria-label', 'Messenger');
            rail.innerHTML =
                '<button type="button" class="rb" id="ws-rail-bell" data-tip="Notifications" aria-label="Notifications"><span class="ic ic-bell"></span><span class="count" id="ws-rail-bell-count" hidden></span></button>' +
                '<a class="rb" href="/chat/" data-tip="Messenger" aria-label="Messenger"><span class="ic ic-chat"></span><span class="count" data-ws-badge="unread" hidden></span></a>' +
                '<button type="button" class="rb" id="ws-rail-search" data-tip="Find a colleague" aria-label="Find a colleague"><span class="ic ic-search"></span></button>' +
                '<div class="sep"></div>' +
                '<div class="people" id="ws-rail-people"></div>' +
                '<div class="sep"></div>' +
                '<a class="rb" href="/employees/" data-tip="Employees" aria-label="Employees"><span class="ic ic-users"></span></a>';
        }

        var footer = null;
        if (opts.pageClass !== 'fill') {
            footer = document.createElement('footer');
            footer.className = 'ws-footer';
            footer.innerHTML = '<span>WorkSuite © ' + new Date().getFullYear() + '</span>' +
                '<button type="button" data-act="themes">Themes</button><button type="button" data-act="menu">Configure menu</button>' +
                '<button type="button" data-act="print">Print</button><a href="/">Home</a>';
        }

        var main = document.createElement('div');
        main.className = 'ws-main';
        main.appendChild(top);
        if (tabBar) main.appendChild(tabBar);
        main.appendChild(page);
        if (footer) main.appendChild(footer);

        var shell = document.createElement('div');
        shell.className = 'ws-shell' + (readCollapsed() ? ' collapsed' : '') + (rail ? '' : ' no-rail');
        shell.appendChild(side);
        shell.appendChild(main);
        if (rail) shell.appendChild(rail);

        var scrim = document.createElement('div');
        scrim.className = 'ws-scrim';
        scrim.id = 'ws-scrim';

        var skip = document.createElement('a');
        skip.className = 'ws-skip-link';
        skip.href = '#ws-page';
        skip.textContent = 'Skip to content';
        body.insertBefore(shell, body.firstChild);
        body.insertBefore(skip, shell);
        body.appendChild(userMenu);
        body.appendChild(notif);
        body.appendChild(scrim);
        body.appendChild(host);

        refs = {
            side: side, shell: shell, scrim: scrim, top: top, menu: userMenu, userbtn: top.querySelector('#ws-userbtn'), tabs: tabBar, rail: rail,
            crumb: top.querySelector('#ws-crumb'), bell: top.querySelector('#ws-bell'), bellCount: top.querySelector('#ws-bell-count'),
            railBell: rail && rail.querySelector('#ws-rail-bell'), railBellCount: rail && rail.querySelector('#ws-rail-bell-count'),
            railPeople: rail && rail.querySelector('#ws-rail-people'),
            notif: notif, notifList: notif.querySelector('#ws-notif-list'), notifMsgs: notif.querySelector('#ws-notif-msgs'),
            topAvatar: top.querySelector('#ws-top-avatar'), topName: top.querySelector('#ws-top-name'), company: top.querySelector('#ws-company'),
            menuName: userMenu.querySelector('#ws-menu-name'), menuEmail: userMenu.querySelector('#ws-menu-email'),
            clock: top.querySelector('#ws-clock'), clockTime: top.querySelector('#ws-clock-time'), clockState: top.querySelector('#ws-clock-state'),
            burger: side.querySelector('#ws-burger'), menuMain: side.querySelector('#ws-menu-main'), menuHidden: side.querySelector('#ws-menu-hidden'),
            menuMore: side.querySelector('#ws-menu-more'), host: host, page: page,
        };
        renderMenu();
        wire();
        tickClock();
        state.clockTimer = setInterval(tickClock, 15000);
        renderUser();
        whenSupabase(bootUser);
    }

    // ----- behaviour -----
    function wire() {
        var side = refs.side;
        document.getElementById('ws-hamb').addEventListener('click', function () { toggleDrawer(); });
        refs.burger.addEventListener('click', function () {
            if (window.matchMedia('(max-width: 1200px)').matches) return toggleDrawer();
            var on = !refs.shell.classList.contains('collapsed');
            refs.shell.classList.toggle('collapsed', on);
            writeCollapsed(on);
            refs.burger.setAttribute('aria-pressed', String(on));
            refs.burger.title = on ? 'Expand menu' : 'Collapse menu';
            document.dispatchEvent(new CustomEvent('ws-sidebar', { detail: { collapsed: on } }));
        });
        refs.scrim.addEventListener('click', function () { closeDrawer(); });
        $('#ws-search', refs.top).addEventListener('click', openSearch);
        refs.top.querySelector('.ws-theme-toggle').addEventListener('click', function () { if (window.WSTheme) WSTheme.toggle(); });
        refs.userbtn.addEventListener('click', function (e) { e.stopPropagation(); closePop(); toggleNotif(false); toggleMenu(); });
        refs.bell.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(false); toggleNotif(); });
        if (refs.railBell) refs.railBell.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(false); toggleNotif(); });
        if (refs.rail) $('#ws-rail-search', refs.rail).addEventListener('click', openSearch);
        refs.clock.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(false); openClock(); });
        $('#ws-help', refs.top).addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(false); openHelp(); });
        refs.notif.querySelector('#ws-notif-readall').addEventListener('click', function () { markAllRead(); });
        refs.notif.querySelector('#ws-notif-close').addEventListener('click', function () { toggleNotif(false); });
        refs.notifList.addEventListener('click', function (e) {
            var a = e.target.closest('[data-notif]');
            if (!a) return;
            e.preventDefault();
            openNotification(a.dataset.notif, a.getAttribute('href'));
        });
        document.addEventListener('click', function (e) {
            if (!refs.menu.hidden && !refs.menu.contains(e.target) && !refs.userbtn.contains(e.target)) toggleMenu(false);
            if (!refs.notif.hidden && !refs.notif.contains(e.target) && !refs.bell.contains(e.target) && !(refs.railBell && refs.railBell.contains(e.target))) toggleNotif(false);
            if (openPop && !openPop.el.contains(e.target) && !openPop.anchor.contains(e.target)) closePop();
            var act = e.target.closest('[data-act]');
            if (act && !act.closest('.ws-pop')) runAct(act.dataset.act);
            // Links marked data-slider open as a slide-over (plain clicks only).
            var sl = e.target.closest('a[data-slider]');
            if (sl && !e.defaultPrevented && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
                e.preventDefault();
                openSlider(sl.getAttribute('href'), { width: Number(sl.dataset.sliderWidth) || undefined });
            }
        });
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            if (state.sliders.length) return;               // the slide-over closes first
            toggleMenu(false); toggleNotif(false); closePop(); closeDrawer();
        });
        window.addEventListener('scroll', function () { refs.top.classList.toggle('scrolled', window.scrollY > 4); }, { passive: true });
        refs.menu.querySelector('#ws-menu-profile').addEventListener('click', function () {
            toggleMenu(false);
            if (typeof state.opts.onProfile === 'function') return state.opts.onProfile();
            location.href = '/#profile';
        });
        refs.menu.querySelector('#ws-menu-out').addEventListener('click', function () { toggleMenu(false); doSignOut(); });
        side.querySelector('#ws-foot-out').addEventListener('click', function () { doSignOut(); });
        side.addEventListener('click', function (e) {
            var hide = e.target.closest('[data-hide]');
            if (hide) { e.preventDefault(); e.stopPropagation(); return toggleHidden(hide.dataset.hide); }
            var it = e.target.closest('.ws-side-item');
            if (it && side.classList.contains('editing')) { e.preventDefault(); return; }
            if (it) {
                closeDrawer();
                // Tab items (admin console): the page's switcher marks the active one; keep the header in step.
                if (it.dataset.tab) { var x = findIn(state.opts.nav, it.dataset.key); if (x) setCrumb(x.title); }
            }
        });
        if (!state.opts.nav) wireMenuEditing(side);
        window.addEventListener('popstate', function (e) {
            var depth = (e.state && e.state.wsSlider) || 0;
            while (state.sliders.length > depth) removeTopSlider();
        });
        // Keep the closed phone drawer out of the keyboard order.
        var phone = window.matchMedia('(max-width: 640px)');
        function syncInert() { side.inert = phone.matches && !refs.shell.classList.contains('menu-open'); }
        phone.addEventListener('change', syncInert);
        syncInert();
        state.syncInert = syncInert;
    }
    function runAct(act) {
        if (act === 'themes') openThemes();
        else if (act === 'menu') configureMenu();
        else if (act === 'print') window.print();
    }
    function openSearch() { closePop(); if (window.wsCmdK && window.wsCmdK.open) window.wsCmdK.open(); }

    // ----- menu editing: hide, show, drag to reorder, Alt+arrows -----
    function configureMenu() {
        if (!refs.side || state.opts.nav) return;
        toggleMenu(false); closePop();
        if (window.matchMedia('(max-width: 1200px)').matches) toggleDrawer(true);
        refs.shell.classList.remove('collapsed');
        refs.side.classList.add('editing');
        renderMenu();
        var first = refs.menuMain.querySelector('.ws-side-item');
        if (first) first.focus();
    }
    function toggleHidden(key) {
        var i = state.menu.hidden.indexOf(key);
        if (i >= 0) state.menu.hidden.splice(i, 1); else state.menu.hidden.push(key);
        saveMenu();
        renderMenu();
    }
    function moveKey(key, beforeKey, hide) {
        var order = state.menu.order.filter(function (k) { return k !== key; });
        var at = beforeKey ? order.indexOf(beforeKey) : -1;
        if (at < 0) order.push(key); else order.splice(at, 0, key);
        state.menu.order = order;
        var h = state.menu.hidden.indexOf(key);
        if (hide === true && h < 0 && key !== 'home') state.menu.hidden.push(key);
        if (hide === false && h >= 0) state.menu.hidden.splice(h, 1);
        saveMenu();
        renderMenu();
    }
    function wireMenuEditing(side) {
        var dragKey = null;
        side.querySelector('#ws-menu-config').addEventListener('click', configureMenu);
        side.querySelector('#ws-menu-done').addEventListener('click', function () {
            side.classList.remove('editing');
            if (readCollapsed() && !window.matchMedia('(max-width: 1200px)').matches) refs.shell.classList.add('collapsed');
            renderMenu();
        });
        side.querySelector('#ws-menu-reset').addEventListener('click', function () { state.menu = normaliseMenu(null); saveMenu(); renderMenu(); });
        refs.menuMore.addEventListener('click', function () { refs.menuHidden.hidden = !refs.menuHidden.hidden; renderMenu(); });
        side.addEventListener('dragstart', function (e) {
            var it = e.target.closest('.ws-side-item');
            if (!it || !side.classList.contains('editing')) return;
            dragKey = it.dataset.key;
            it.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', dragKey); } catch (x) { /* old browsers */ }
        });
        side.addEventListener('dragover', function (e) {
            if (!dragKey) return;
            var it = e.target.closest('.ws-side-item'), zone = e.target.closest('#ws-menu-main, #ws-menu-hidden');
            if (!zone) return;
            e.preventDefault();
            side.querySelectorAll('.drop-before').forEach(function (x) { x.classList.remove('drop-before'); });
            if (it && it.dataset.key !== dragKey) it.classList.add('drop-before');
        });
        side.addEventListener('drop', function (e) {
            if (!dragKey) return;
            var zone = e.target.closest('#ws-menu-main, #ws-menu-hidden');
            if (!zone) return;
            e.preventDefault();
            var it = e.target.closest('.ws-side-item');
            moveKey(dragKey, it && it.dataset.key !== dragKey ? it.dataset.key : null, zone.id === 'ws-menu-hidden');
            dragKey = null;
        });
        side.addEventListener('dragend', function () {
            dragKey = null;
            side.querySelectorAll('.dragging, .drop-before').forEach(function (x) { x.classList.remove('dragging', 'drop-before'); });
        });
        side.addEventListener('keydown', function (e) {
            if (!side.classList.contains('editing') || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
            var it = e.target.closest('.ws-side-item');
            if (!it) return;
            e.preventDefault();
            var o = state.menu.order, i = o.indexOf(it.dataset.key), j = e.key === 'ArrowUp' ? i - 1 : i + 1;
            if (j < 0 || j >= o.length) return;
            o.splice(i, 1); o.splice(j, 0, it.dataset.key);
            saveMenu(); renderMenu();
            var again = refs.side.querySelector('.ws-side-item[data-key="' + it.dataset.key + '"]');
            if (again) again.focus();
        });
    }

    // ----- drawer / menus / popups -----
    function toggleDrawer(force) {
        if (!refs.shell || !refs.side) return;
        var open = typeof force === 'boolean' ? force : !refs.shell.classList.contains('menu-open');
        refs.shell.classList.toggle('menu-open', open);
        refs.scrim.classList.toggle('open', open);
        var hamb = document.getElementById('ws-hamb');
        if (hamb) hamb.setAttribute('aria-expanded', String(open));
        if (state.syncInert) state.syncInert();
        if (!open && refs.side.contains(document.activeElement) && hamb) hamb.focus();
    }
    function closeDrawer() {
        if (!refs.shell || !refs.shell.classList.contains('menu-open')) return;
        if (refs.side.classList.contains('editing')) return;
        toggleDrawer(false);
    }
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
        [refs.bell, refs.railBell].forEach(function (b) { if (b) b.setAttribute('aria-expanded', show ? 'true' : 'false'); });
        state.notifOpen = show;
        if (show) { loadNotifications(); setTimeout(function () { var f = refs.notif.querySelector('button, a'); if (f) f.focus(); }, 20); }
    }
    var openPop = null;
    function popup(anchor, html, cls) {
        closePop();
        var p = document.createElement('div');
        p.className = 'ws-pop' + (cls ? ' ' + cls : '');
        p.setAttribute('role', 'dialog');
        p.innerHTML = html;
        document.body.appendChild(p);
        var r = anchor.getBoundingClientRect();
        p.style.left = Math.max(8, Math.min(r.right - p.offsetWidth, window.innerWidth - p.offsetWidth - 8)) + 'px';
        p.style.top = (r.bottom + 6) + 'px';
        anchor.setAttribute('aria-expanded', 'true');
        openPop = { el: p, anchor: anchor };
        p.addEventListener('click', function (e) {
            var act = e.target.closest('[data-act]');
            if (act) { closePop(); runAct(act.dataset.act); }
            if (e.target.closest('[data-search]')) { closePop(); openSearch(); }
        });
        return p;
    }
    function closePop() {
        if (!openPop) return;
        openPop.el.remove();
        openPop.anchor.setAttribute('aria-expanded', 'false');
        openPop = null;
    }
    function openHelp() {
        if (openPop && openPop.anchor.id === 'ws-help') return closePop();
        popup($('#ws-help', refs.top),
            '<div class="head"><b>Help</b><span>Esc closes any panel. Ctrl/Cmd + K searches everything.</span></div>' +
            '<button type="button" class="item" data-search><span class="ic ic-search"></span>Search and quick actions</button>' +
            '<button type="button" class="item" data-act="menu"><span class="ic ic-edit"></span>Configure the menu</button>' +
            '<button type="button" class="item" data-act="themes"><span class="ic ic-sun"></span>Themes</button>' +
            '<hr><a class="item" href="/attendance/#leave"><span class="ic ic-leave"></span>Leave and holidays</a>');
    }

    // ----- work-day clock -----
    function tickClock() {
        if (!refs.clockTime) return;
        var d = new Date();
        refs.clockTime.innerHTML = esc(istTime(d)) + '<small>' + amPm(d) + '</small>';
    }
    async function loadAttendance() {
        if (!state.sb || !state.uid) return;
        try {
            var r = await state.sb.from('attendance_logs').select('direction,log_datetime').eq('user_id', state.uid)
                .eq('log_date', istToday()).order('log_datetime', { ascending: true }).limit(50);
            if (r.error) throw r.error;
            var rows = r.data || [], last = rows[rows.length - 1];
            state.attendance = { count: rows.length, first: rows[0] ? new Date(rows[0].log_datetime) : null,
                                 last: last ? new Date(last.log_datetime) : null, lastDir: last ? last.direction : null };
        } catch (e) { state.attendance = { error: true }; }
        renderClockState();
    }
    function renderClockState() {
        var a = state.attendance, el = refs.clockState;
        if (!el || !a) return;
        var text = 'Not clocked in', cls = 'state';
        if (a.error) text = 'Work day';
        else if (a.count && a.lastDir === 'OUT') { text = 'Day finished'; cls = 'state paused'; }
        else if (a.count) { text = 'Working since ' + istTime(a.first, true); cls = 'state on'; }
        el.className = cls;
        el.querySelector('span').textContent = text;
    }
    function openClock() {
        if (openPop && openPop.anchor === refs.clock) return closePop();
        var a = state.attendance || {}, d = new Date();
        var date = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long' }).format(d);
        var row = function (k, v) { return '<div class="row"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>'; };
        popup(refs.clock,
            '<div class="big">' + esc(istTime(d)) + ' <small>' + amPm(d) + '</small></div><div style="color:var(--b24-muted);margin-bottom:10px">' + esc(date) + '</div>' +
            (a.error ? '<p style="margin:0;color:var(--b24-muted)">Your punches could not be read right now.</p>' :
                row('Status', a.count ? (a.lastDir === 'OUT' ? 'Day finished' : 'Working') : 'Not clocked in') +
                row('First punch', a.first ? istTime(a.first, true) : '—') +
                row('Last punch', a.last ? istTime(a.last, true) + (a.lastDir && a.lastDir !== 'UNKNOWN' ? ' (' + a.lastDir.toLowerCase() + ')' : '') : '—') +
                row('Punches today', String(a.count || 0))) +
            '<div class="actions"><a class="ws-btn primary sm" href="/attendance/">Open time and attendance</a><a class="ws-btn sm" href="/attendance/#leave">Leave</a></div>',
            'ws-clockpop');
        loadAttendance();
    }

    // ----- themes -----
    function openThemes() {
        toggleMenu(false); closePop();
        var old = document.getElementById('ws-themes');
        if (old) old.remove();
        var cur = currentWallpaper(), mode = window.WSTheme ? WSTheme.current() : 'light';
        var bd = document.createElement('div');
        bd.className = 'ws-lite-backdrop';
        bd.id = 'ws-themes';
        bd.innerHTML = '<div class="ws-lite" role="dialog" aria-modal="true" aria-labelledby="ws-themes-t">' +
            '<div class="ws-lite-head"><b id="ws-themes-t">Themes</b><button type="button" class="x" aria-label="Close"><span class="ic ic-x"></span></button></div>' +
            '<div class="ws-lite-body"><div class="ws-theme-mode" role="group" aria-label="Brightness">' +
                ['light', 'dark'].map(function (m) { return '<button type="button" class="ws-btn sm' + (m === mode ? ' primary' : '') + '" data-mode="' + m + '">' + (m === 'light' ? 'Light' : 'Dark') + '</button>'; }).join('') +
            '</div><div class="ws-themes-grid">' +
                WALLPAPERS.map(function (w) {
                    return '<button type="button" class="ws-theme-card' + (w.key === cur ? ' on' : '') + '" data-w="' + w.key + '" aria-pressed="' + (w.key === cur) + '">' +
                        '<span class="sw" data-w="' + w.key + '"></span><b>' + esc(w.title) + '</b></button>';
                }).join('') +
            '</div></div></div>';
        document.body.appendChild(bd);
        var close = function () { bd.remove(); document.removeEventListener('keydown', onKey, true); };
        var onKey = function (e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
        document.addEventListener('keydown', onKey, true);
        bd.addEventListener('click', function (e) {
            if (e.target === bd || e.target.closest('.x')) return close();
            var card = e.target.closest('[data-w]');
            if (card && card.classList.contains('ws-theme-card')) {
                applyWallpaper(card.dataset.w);
                bd.querySelectorAll('.ws-theme-card').forEach(function (c) { c.classList.toggle('on', c === card); c.setAttribute('aria-pressed', String(c === card)); });
            }
            var m = e.target.closest('[data-mode]');
            if (m && window.WSTheme) {
                WSTheme.set(m.dataset.mode);
                bd.querySelectorAll('[data-mode]').forEach(function (b) { b.classList.toggle('primary', b === m); });
                saveSetting('theme', { wallpaper: currentWallpaper(), mode: m.dataset.mode });
            }
        });
        bd.querySelector('.ws-theme-card.on, .ws-theme-card').focus();
    }

    // ----- slide-over panels -----
    function sliderSrc(url) {
        var u = new URL(url, location.href);
        u.searchParams.set('slider', '1');
        return u.pathname + u.search + u.hash;
    }
    function openSlider(url, o) {
        o = o || {};
        if (state.inSlider) {
            try { if (window.parent.WSShell) return window.parent.WSShell.openSlider(url, o); } catch (e) { /* opener gone */ }
            location.href = url;
            return;
        }
        var hostEl = document.getElementById('ws-slider-host');
        if (!hostEl) {
            hostEl = document.createElement('div');
            hostEl.className = 'ws-slider-host';
            hostEl.id = 'ws-slider-host';
            hostEl.innerHTML = '<div class="scrim"></div>';
            hostEl.querySelector('.scrim').addEventListener('click', function () { closeSlider(); });
            document.body.appendChild(hostEl);
            document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.sliders.length) closeSlider(); });
        }
        var depth = state.sliders.length;
        var panel = document.createElement('div');
        panel.className = 'ws-slider';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.style.setProperty('--w', Math.max(480, (o.width || 1100) - depth * 40) + 'px');
        panel.innerHTML = '<button type="button" class="ws-slider-close" aria-label="Close"><span class="ic ic-x"></span></button>' +
                          '<div class="loading">Loading…</div><iframe title="' + esc(o.title || 'Details') + '"></iframe>';
        var frame = panel.querySelector('iframe');
        frame.addEventListener('load', function () { var l = panel.querySelector('.loading'); if (l) l.remove(); });
        frame.src = sliderSrc(url);
        panel.querySelector('.ws-slider-close').addEventListener('click', function () { closeSlider(); });
        hostEl.appendChild(panel);
        var entry = { panel: panel, frame: frame, url: url, onClose: o.onClose, onMessage: o.onMessage, pushed: false };
        state.sliders.push(entry);
        document.documentElement.style.overflow = 'hidden';
        // The address bar shows the record, so a reload opens it as a full page and Back closes the panel.
        try { history.pushState({ wsSlider: state.sliders.length }, '', new URL(url, location.href).href); entry.pushed = true; } catch (e) { /* sandboxed */ }
        setTimeout(function () { panel.querySelector('.ws-slider-close').focus(); }, 30);
        return entry;
    }
    function closeSlider() {
        if (state.inSlider) {
            try { if (window.parent.WSShell) return window.parent.WSShell._closeFrom(window); } catch (e) { /* opener gone */ }
            return;
        }
        var top = state.sliders[state.sliders.length - 1];
        if (!top) return;
        if (top.pushed && history.state && history.state.wsSlider === state.sliders.length) history.back();   // popstate removes it
        else removeTopSlider();
    }
    function removeTopSlider() {
        var top = state.sliders.pop();
        if (!top) return;
        top.panel.remove();
        if (!state.sliders.length) {
            document.documentElement.style.overflow = '';
            var hostEl = document.getElementById('ws-slider-host');
            if (hostEl) hostEl.remove();
        }
        if (typeof top.onClose === 'function') { try { top.onClose(); } catch (e) { /* page callback */ } }
        document.dispatchEvent(new CustomEvent('ws-slider-closed', { detail: { url: top.url } }));
    }
    function entryFor(win) { return state.sliders.filter(function (s) { return s.frame.contentWindow === win; })[0]; }
    function closeFrom(win) {
        var e = entryFor(win);
        if (!e) return;
        while (state.sliders.length && state.sliders[state.sliders.length - 1] !== e) removeTopSlider();
        closeSlider();
    }
    function fromSlider(win, type, data) {
        var e = entryFor(win);
        if (e && typeof e.onMessage === 'function') { try { e.onMessage(type, data); } catch (x) { /* page callback */ } }
        document.dispatchEvent(new CustomEvent('ws-slider-message', { detail: { type: type, data: data, url: e && e.url } }));
    }
    function sliderMessage(type, data) {
        if (!state.inSlider) return;
        try { if (window.parent.WSShell) window.parent.WSShell._fromSlider(window, type, data); } catch (e) { /* opener gone */ }
    }

    // ----- messenger bar: recent conversations -----
    async function loadRail() {
        if (!refs.railPeople || !state.sb || !state.uid) return;
        try {
            var uid = state.uid;
            var r = await state.sb.from('messages').select('sender_id,recipient_id,read_at,created_at')
                .or('sender_id.eq.' + uid + ',recipient_id.eq.' + uid).order('created_at', { ascending: false }).limit(200);
            if (r.error) throw r.error;
            var order = [], unread = {};
            (r.data || []).forEach(function (m) {
                var other = m.sender_id === uid ? m.recipient_id : m.sender_id;
                if (!other || other === uid) return;           // group messages have no recipient
                if (order.indexOf(other) < 0) order.push(other);
                if (m.recipient_id === uid && !m.read_at) unread[other] = (unread[other] || 0) + 1;
            });
            var ids = order.slice(0, 12);
            if (!ids.length) { refs.railPeople.innerHTML = ''; return; }
            var p = await state.sb.from('profiles').select('id,full_name,avatar_url,last_seen_at').in('id', ids);
            if (p.error) p = await state.sb.from('profiles').select('id,full_name,avatar_url').in('id', ids);
            var byId = {}; (p.data || []).forEach(function (x) { byId[x.id] = x; });
            var now = Date.now();
            refs.railPeople.innerHTML = ids.filter(function (id) { return byId[id]; }).map(function (id) {
                // presence.js stamps last_seen_at every 30s and counts 60s as online; allow one missed beat.
                var x = byId[id], online = x.last_seen_at && now - new Date(x.last_seen_at).getTime() < 90000;
                return '<a class="pp" href="/chat/#thread=' + encodeURIComponent(id) + '" data-tip="' + esc(x.full_name || 'Colleague') + '">' +
                    avatarHtml(x.full_name, x.avatar_url) + (online ? '<span class="on" aria-label="online"></span>' : '') +
                    (unread[id] ? '<span class="count">' + (unread[id] > 99 ? '99+' : unread[id]) + '</span>' : '') + '</a>';
            }).join('');
        } catch (e) { /* the rail is a convenience; messages stay on the Messenger page */ }
    }

    // ----- user -----
    function setUser(user) {
        state.user = user ? { name: user.name || (user.email ? user.email.split('@')[0] : ''), email: user.email || '', avatar: user.avatar || '', company: user.company || '' } : null;
        state.explicitUser = true;
        renderUser();
    }
    function renderUser() {
        if (!refs.topAvatar) return;
        var u = state.user;
        refs.topAvatar.innerHTML = u && u.avatar ? '<img src="' + esc(u.avatar) + '" alt="">' : esc(initialOf(u && (u.name || u.email)));
        refs.topName.textContent = u ? String(u.name).split(' ')[0] : 'Sign in';
        refs.menuName.textContent = u ? u.name : 'Not signed in';
        refs.menuEmail.textContent = u ? u.email : '';
        refs.company.textContent = u ? (u.company || '') : '';
    }
    function setCrumb(text) { if (refs.crumb) refs.crumb.textContent = text; }
    function setRole(role) {
        state.role = role || 'employee';
        var rank = { employee: 0, manager: 1, admin: 2 }, mine = rank[state.role] || 0;
        [refs.side, refs.top, refs.tabs, refs.menu].forEach(function (root) {
            if (!root) return;
            root.querySelectorAll('[data-ws-role]').forEach(function (el) { el.hidden = (rank[el.dataset.wsRole] || 0) > mine; });
        });
        if (refs.side) refs.side.querySelectorAll('[data-ws-role-group]').forEach(function (g) { g.hidden = !g.querySelector('.ws-side-item:not([hidden])'); });
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
        if (state.inSlider) return;
        loadSettings();
        refreshUnread();
        clearInterval(state.unreadTimer);
        state.unreadTimer = setInterval(refreshUnread, 30000);
        loadAttendance();
        loadRail();
        clearInterval(state.railTimer);
        state.railTimer = setInterval(loadRail, 60000);
        watchNotifications();
        loadCalls();
    }

    // Incoming calls ring on every signed-in page (calls.js guards against loading twice).
    function loadCalls() {
        if (window.WSCalls || document.querySelector('script[src$="/calls.js"]')) return;
        var s = document.createElement('script');
        s.src = '/calls.js';
        s.async = true;
        document.head.appendChild(s);
    }

    // ----- counters: messages, notifications, tasks -----
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
            var t = await state.sb.from('tasks').select('id', { count: 'exact', head: true })
                .eq('assignee_id', state.uid).is('archived_at', null).is('completed_at', null).lte('due_date', istToday());
            counts.tasks = !t.error && t.count ? t.count : 0;
        } catch (e) { counts.tasks = 0; }
        setCounts(counts);
    }
    function paintCount(el, n) { if (el) { el.hidden = !(n > 0); el.textContent = n > 99 ? '99+' : String(n || 0); } }
    function setCounts(c) {
        state.counts = c;
        setBadge('unread', c.unread);
        setBadge('tasks', c.tasks);
        var total = (c.unread || 0) + (c.notifications || 0);
        paintCount(refs.bellCount, refs.rail ? c.notifications : total);
        paintCount(refs.railBellCount, c.notifications);
        if (refs.bell) refs.bell.title = total ? total + ' unread' : 'Notifications';
        paintCount(refs.notifMsgs, c.unread);
        document.dispatchEvent(new CustomEvent('ws-unread', { detail: { count: c.unread, notifications: c.notifications, tasks: c.tasks } }));
    }
    function setBadge(name, n) {
        document.querySelectorAll('.ws-side [data-ws-badge="' + name + '"], .ws-rail [data-ws-badge="' + name + '"]').forEach(function (b) { paintCount(b, n); });
        if (state.counts && name in state.counts) state.counts[name] = n;
    }
    function setUnread(n) { setCounts(Object.assign({}, state.counts, { unread: n })); }
    function setTabCount(key, n) {
        var el = refs.tabs && refs.tabs.querySelector('[data-tab-key="' + key + '"] .n');
        paintCount(el, n);
    }

    // ----- notification panel -----
    async function loadNotifications() {
        if (!state.sb || !state.uid || !refs.notifList) return;
        try {
            var r = await state.sb.from('notifications').select('id,kind,title,body,url,read_at,created_at').eq('user_id', state.uid).order('created_at', { ascending: false }).limit(40);
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
        setTabCount: setTabCount, closeDrawer: closeDrawer, openSlider: openSlider, closeSlider: closeSlider, sliderMessage: sliderMessage,
        openThemes: openThemes, configureMenu: configureMenu, NAV: NAV, TABS: TABS, WALLPAPERS: WALLPAPERS,
        _closeFrom: closeFrom, _fromSlider: fromSlider,
        get role() { return state.role; },
        get counts() { return state.counts; },
        get inSlider() { return state.inSlider; },
        get uid() { return state.uid; },
    };
})();
