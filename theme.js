/* ===========================================================================
 * WorkSuite theme
 *
 * Load SYNCHRONOUSLY in <head>, before the page renders:
 *     <script src="/theme.js"></script>
 *
 * Not deferred, and not at the end of body, on purpose. The stored choice
 * has to be on <html> before the first paint; a deferred script runs after
 * it, so every load would flash the dark theme for a frame before turning
 * light. That flash is the single most noticeable bug in a theme switcher.
 *
 * Light is the DEFAULT. With nothing stored the site is light, on every
 * machine, regardless of the OS setting. Dark is an explicit choice made with
 * the toggle and remembered per browser.
 *
 * The CSS agrees: :root carries the light tokens and only
 * :root[data-theme="dark"] switches them. There is deliberately no
 * prefers-color-scheme rule in either file. If one of them ever starts
 * following the OS, the other has to change in the same commit, or the
 * toggle's icon and the theme actually on screen will disagree.
 * =========================================================================== */
(function () {
    'use strict';

    var KEY = 'ws-theme';
    var root = document.documentElement;

    // Storage throws in some privacy modes; a theme is never worth an exception.
    function read() {
        try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : null; }
        catch (e) { return null; }
    }
    function write(v) {
        try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); }
        catch (e) { /* session-only theme is still better than an error */ }
    }

    function apply(v) {
        if (v) root.setAttribute('data-theme', v);
        else root.removeAttribute('data-theme');
    }

    // Runs at parse time, before the body exists. This is the anti-flash step.
    apply(read());

    // "No stored choice" means light. Keep this in step with the CSS - see
    // the header comment.
    var Theme = {
        /** "light" or "dark" - what is actually on screen right now. */
        current: function () {
            return read() || 'light';
        },
        /** null = go back to following the OS. */
        set: function (v) {
            write(v);
            apply(v);
            document.dispatchEvent(new CustomEvent('ws-theme-change', { detail: { theme: Theme.current() } }));
        },
        toggle: function () {
            Theme.set(Theme.current() === 'light' ? 'dark' : 'light');
        },
        followSystem: function () { Theme.set(null); },
    };
    window.WSTheme = Theme;

    // Same line icons the rest of the site uses (design-system.css .ic-*),
    // so a page that gets the fallback button does not get a different glyph.
    var BUTTON_INNER =
        '<span class="moon ic ic-moon" aria-hidden="true"></span>' +
        '<span class="sun ic ic-sun" aria-hidden="true"></span>';

    function dress(btn) {
        if (btn.dataset.wsThemeReady) return;
        btn.dataset.wsThemeReady = '1';
        btn.type = 'button';
        btn.classList.add('ws-theme-toggle');
        if (!btn.innerHTML.trim()) btn.innerHTML = BUTTON_INNER;
        btn.setAttribute('aria-label', 'Switch between light and dark');
        btn.title = 'Switch between light and dark';
        btn.addEventListener('click', function () { Theme.toggle(); });
    }

    function mount() {
        var found = document.querySelectorAll('[data-ws-theme]');
        for (var i = 0; i < found.length; i++) dress(found[i]);
        // Fallback so the control exists on pages that have not been given a
        // home for it yet. Pages that add their own [data-ws-theme] button
        // suppress this automatically.
        if (!found.length && !document.querySelector('.ws-theme-toggle')) {
            var b = document.createElement('button');
            b.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;box-shadow:var(--ws-shadow-md);';
            dress(b);
            document.body.appendChild(b);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }
})();
