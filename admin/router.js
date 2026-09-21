// Admin console routing: one real URL per section.
//
//     /wsm-admin/overview, /wsm-admin/employees, /wsm-admin/company-structure …
//
// The shell draws the sidebar's tab items as <button data-tab>. install() swaps
// each one for an <a href="/wsm-admin/<slug>"> carrying the same classes and
// data-* attributes, so ctrl/cmd-click opens a new browser tab while a plain
// click still runs every .admin-tab switcher (they bind after this runs).
// Switching pushes the URL, Back/Forward switch back, and a deep link opens its
// section once the password gate is passed (openInitial, called on unlock).
// Old links keep working: /wsm-admin?tab=crmimport and /wsm-admin#employees are
// rewritten in place to /wsm-admin/crm-import and /wsm-admin/employees.
(function () {
    'use strict';
    const BASE = '/wsm-admin';
    // data-tab → URL slug. A tab missing here falls back to its own name.
    const SLUGS = {
        overview: 'overview', employees: 'employees', company: 'company-structure', shifts: 'shifts',
        leave: 'leave', holidays: 'holidays', salary: 'salary', import: 'bulk-import',
        deals: 'deals', leads: 'leads', crmimport: 'crm-import', crmperms: 'crm-permissions',
        attendance: 'attendance', calendar: 'calendar', selfies: 'selfies', wfh: 'wfh-check-ins',
        friday: 'friday-report', roster: 'biometric', results: 'typing', quizzes: 'quizzes',
        email: 'email-monitoring', bitrix: 'bitrix24', audit: 'audit-log',
    };
    const slugOf = tab => SLUGS[tab] || tab;
    const urlFor = tab => BASE + '/' + encodeURIComponent(slugOf(tab));
    const tabEl = tab => document.querySelector('.ws-side-item.admin-tab[data-tab="' + String(tab).replace(/["\\]/g, '') + '"]');
    // A slug, a raw tab name (legacy ?tab= / #hash) or nothing.
    function tabFrom(word) {
        const w = String(word || '').trim().toLowerCase().replace(/^#/, '');
        if (!w) return '';
        for (const tab in SLUGS) if (SLUGS[tab] === w) return tab;
        if (SLUGS[w] || document.querySelector('.admin-tab[data-tab="' + w.replace(/["\\]/g, '') + '"]')) return w;
        return '';
    }
    // Which section the address bar names, and whether it used an old form.
    function fromLocation() {
        const rest = location.pathname.replace(/\/+$/, '').slice(BASE.length).replace(/^\/+/, '');
        let tab = '', legacy = false;
        if (rest && rest !== 'index.html') tab = tabFrom(decodeURIComponent(rest.split('/')[0]));
        const q = new URLSearchParams(location.search).get('tab');
        if (!tab && q) { tab = tabFrom(q); legacy = !!tab; }
        if (!tab && location.hash.length > 1) { tab = tabFrom(location.hash.slice(1)); legacy = !!tab; }
        return { tab, legacy };
    }
    function activeTab() {
        const a = document.querySelector('.ws-side-item.admin-tab.active');
        return a ? a.dataset.tab : '';
    }

    let quiet = false;   // true while switching because of the URL itself (no new history entry)
    function show(tab) {
        const el = tabEl(tab);
        if (!el) return false;
        quiet = true;
        try { el.click(); } finally { quiet = false; }
        return true;
    }
    const modified = e => e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;

    function install() {
        document.querySelectorAll('.ws-side-item[data-tab]').forEach(btn => {
            const a = document.createElement('a');
            for (const at of btn.attributes) if (at.name !== 'type') a.setAttribute(at.name, at.value);
            a.classList.add('admin-tab');
            a.href = urlFor(btn.dataset.tab);
            a.innerHTML = btn.innerHTML;
            // Registered before any switcher, so a modified click can stop them all.
            a.addEventListener('click', e => {
                if (modified(e)) { e.stopImmediatePropagation(); return; }   // the browser opens a new tab
                e.preventDefault();
                document.querySelectorAll('.ws-side-item[data-tab]').forEach(x => {
                    if (x === a) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current');
                });
                if (quiet) return;
                const url = urlFor(a.dataset.tab);
                if (location.pathname !== url) {
                    try { history.pushState({ adminTab: a.dataset.tab }, '', url); } catch (err) { /* sandboxed */ }
                }
            });
            btn.replaceWith(a);
        });

        // The brand opens the admin overview, not the employee home.
        const logo = document.querySelector('.ws-side-brand a.logo');
        if (logo) {
            logo.href = urlFor('overview');
            logo.title = 'Admin overview';
            logo.addEventListener('click', e => {
                if (modified(e)) return;
                e.preventDefault();
                const o = tabEl('overview');
                if (o) o.click();
            });
        }

        window.addEventListener('popstate', () => {
            const tab = fromLocation().tab || 'overview';
            if (tab !== activeTab()) show(tab);
        });

        // Tidy an old-style address straight away; the section itself opens on unlock.
        const at = fromLocation();
        if (at.legacy) {
            try { history.replaceState({ adminTab: at.tab }, '', urlFor(at.tab)); } catch (err) { /* sandboxed */ }
        }
    }

    // After the password/session gate: open the section the URL names.
    function openInitial() {
        const tab = fromLocation().tab;
        if (tab && tab !== activeTab()) show(tab);
    }

    window.WSAdminRouter = { install, openInitial, urlFor, slugOf, tabFrom, SLUGS };
})();
