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
 * Light is OPT-IN for now: with nothing stored the site stays dark, even on a
 * machine set to light. Following the OS would have moved everyone whose
 * machine prefers light onto a theme nobody has reviewed on real data. The CSS
 * omits its prefers-color-scheme block for the same reason, and the two must be
 * flipped together - if one follows the OS and the other does not, the button
 * shows the wrong icon for the theme actually on screen.
 *
 * set(null) already clears the stored choice, so the day the CSS block is
 * uncommented, unset simply means "follow the OS" and this file needs one edit:
 * current() returning the OS preference instead of "dark".
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

    // Dark is the floor until every page has been reviewed in light. The CSS
    // has no prefers-color-scheme rule yet for the same reason, so these two
    // must stay in step: if one starts following the OS and the other does
    // not, the button ends up showing the wrong icon for the actual theme.
    var Theme = {
        /** "light" or "dark" - what is actually on screen right now. */
        current: function () {
            return read() || 'dark';
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

    var BUTTON_INNER =
        '<span class="moon" aria-hidden="true">☽</span>' +
        '<span class="sun" aria-hidden="true">☀</span>';

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
