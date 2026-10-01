// @ts-check
/* ===========================================================================
 * Admin console lock: the Lock button and the idle timeout, one flow.
 *
 * Locking ends every way the console is open in this browser:
 *   - the password session: the server clears its HttpOnly cookie
 *     (action 'logout'; JavaScript cannot clear an HttpOnly cookie itself);
 *   - the WorkSuite account session an administrator opens it with: that
 *     session is signed out in this browser, so it cannot reopen the console;
 * then it hides the page and reloads it on the gate, which drops every report
 * held in memory.
 *
 * A "locked" mark in localStorage outlives the reload. While it is there the
 * page does not reopen from a leftover cookie or the same account session
 * (say the logout request failed on a bad network): it takes a new password
 * sign-in or a new account sign-in. Every admin tab locks together, and
 * activity in any tab keeps all of them open.
 *
 * The idle timeout is a browser setting (1-240 minutes, default 30). It does
 * not change the server cookie, which always expires after 12 hours.
 * =========================================================================== */
(function () {
    'use strict';

    const KEY_TIMEOUT = 'wsAdminInactivityTimeout';   // minutes
    const KEY_ACTIVITY = 'wsAdminLastActivity';       // ms timestamp, shared by tabs
    const KEY_LOCKED = 'wsAdminLocked';               // JSON { at, reason, session }
    const DEFAULT_MINUTES = 30, MIN_MINUTES = 1, MAX_MINUTES = 240;
    const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'click', 'touchstart', 'scroll', 'wheel', 'pointerdown'];
    const WRITE_EVERY_MS = 5000;

    const store = {
        get(key) { try { return localStorage.getItem(key); } catch { return null; } },
        set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode: this tab only */ } },
        remove(key) { try { localStorage.removeItem(key); } catch { /* nothing to remove */ } },
    };

    /** Whole minutes between 1 and 240; anything else is the default. */
    function clampMinutes(value) {
        const n = typeof value === 'number' ? value : parseInt(String(value == null ? '' : value), 10);
        if (!Number.isFinite(n)) return DEFAULT_MINUTES;
        return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(n)));
    }
    const minutes = () => clampMinutes(store.get(KEY_TIMEOUT));
    const timeoutMs = () => minutes() * 60 * 1000;

    /** The session id inside a Supabase access token (to tell a new sign-in from the old one). */
    function sessionIdOf(token) {
        try {
            const part = String(token || '').split('.')[1];
            if (!part) return null;
            const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
            return json.session_id || null;
        } catch { return null; }
    }

    function lockedState() {
        try { const v = JSON.parse(store.get(KEY_LOCKED) || 'null'); return v && typeof v === 'object' ? v : null; }
        catch { return null; }
    }
    /** May this page open the console? Not while locked, unless this is a new account sign-in. */
    function mayUnlock(accountToken) {
        const locked = lockedState();
        if (!locked) return true;
        const sid = sessionIdOf(accountToken);
        return !!(sid && sid !== locked.session);
    }

    /* ------------------------------------------------------------ activity */
    let lastActivity = Date.now(), lastWrite = 0, timer = 0, running = false, locking = false;

    function sharedActivity() {
        const v = Number(store.get(KEY_ACTIVITY));
        return Number.isFinite(v) ? v : 0;
    }
    function noteActivity() {
        if (!running || locking) return;
        lastActivity = Date.now();
        if (lastActivity - lastWrite >= WRITE_EVERY_MS) { lastWrite = lastActivity; store.set(KEY_ACTIVITY, String(lastActivity)); }
    }
    function schedule() {
        clearTimeout(timer);
        if (!running) return;
        const idleFor = Date.now() - Math.max(lastActivity, sharedActivity());
        const left = timeoutMs() - idleFor;
        if (left <= 0) { lock('idle'); return; }
        // Check again when the time is up; activity meanwhile only moves the mark.
        timer = window.setTimeout(schedule, Math.min(left, 60 * 1000) + 50);
    }
    function start() {
        if (running) return;
        running = true;
        lastActivity = Date.now(); lastWrite = lastActivity;
        store.set(KEY_ACTIVITY, String(lastActivity));
        schedule();
    }
    /** Restart the countdown now (the old WSAdminResetInactivityTimer). */
    function reset() { noteActivity(); schedule(); }
    /** Save a new timeout; returns the value actually used. */
    function configure(value) {
        const m = clampMinutes(value);
        store.set(KEY_TIMEOUT, String(m));
        reset();
        return m;
    }

    ACTIVITY_EVENTS.forEach(evt => window.addEventListener(evt, noteActivity, { passive: true, capture: true }));
    // Background tabs get their timers slowed or paused: check on return.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
    window.addEventListener('focus', () => schedule());

    /* ---------------------------------------------------------------- lock */
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('ws-admin-lock') : null;

    function hidePage() {
        const dash = document.getElementById('dashboard');
        if (dash) dash.classList.add('hidden');
        document.querySelectorAll('[id$="-modal"]').forEach(m => m.classList.add('hidden'));
        document.dispatchEvent(new CustomEvent('admin-locked'));
    }
    function toGate(reason) {
        const url = new URL('/wsm-admin', location.origin);
        url.searchParams.set('locked', reason || 'manual');
        location.replace(url.pathname + url.search);
    }

    /** End the server cookie. Resolves true when the server confirmed it. */
    async function endServerSession() {
        try {
            const r = await fetch('/api/admin', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'logout' }),
            });
            return r.ok;
        } catch { return false; }
    }
    /** Sign the WorkSuite account out in this browser (when the console was opened with it). */
    async function endAccountSession() {
        const sb = window.__WS_ADMIN_SB__;
        if (!sb || !sb.auth) return true;
        try {
            const { error } = await sb.auth.signOut({ scope: 'local' });
            return !error;
        } catch { return false; }
    }

    /**
     * Lock the console in this tab and every other admin tab.
     * reason: 'manual' | 'idle'. The page reloads on the gate whatever happens;
     * if the server could not be reached the "locked" mark still keeps it shut.
     */
    async function lock(reason) {
        if (locking) return;
        locking = true; running = false; clearTimeout(timer);
        let session = null;
        try {
            const sb = window.__WS_ADMIN_SB__;
            if (sb && sb.auth) session = sessionIdOf(((await sb.auth.getSession()).data.session || {}).access_token);
        } catch { /* no account session */ }
        store.set(KEY_LOCKED, JSON.stringify({ at: Date.now(), reason: reason || 'manual', session }));
        hidePage();
        if (channel) channel.postMessage({ type: 'lock', reason });
        const [server, account] = await Promise.all([endServerSession(), endAccountSession()]);
        if (!server || !account) store.set(KEY_LOCKED, JSON.stringify({ at: Date.now(), reason: reason || 'manual', session, incomplete: true }));
        toGate(reason);
    }

    /** Another tab locked: follow it without asking the server again. */
    function followLock(reason) {
        if (locking) return;
        locking = true; running = false; clearTimeout(timer);
        hidePage();
        toGate(reason);
    }
    if (channel) channel.onmessage = e => { if (e.data && e.data.type === 'lock') followLock(e.data.reason); };
    window.addEventListener('storage', e => { if (e.key === KEY_LOCKED && e.newValue && running) followLock('manual'); });
    // Back/forward cache: a locked page must not come back with its data.
    window.addEventListener('pageshow', e => { if (e.persisted && lockedState()) location.reload(); });

    /** A fresh sign-in succeeded: the console may open again. */
    function clearLock() { store.remove(KEY_LOCKED); locking = false; }

    // Start counting once the console is open.
    document.addEventListener('admin-unlocked', start);

    // The "Lock after inactivity" picker on the overview.
    function bindPicker() {
        const select = /** @type {HTMLSelectElement | null} */ (document.getElementById('ov-idle-lock'));
        if (!select) return;
        const current = String(minutes());
        if (![...select.options].some(o => o.value === current)) select.add(new Option(`${current} minutes`, current));
        select.value = current;
        select.addEventListener('change', () => {
            const used = configure(select.value);
            select.value = String(used);
            const shell = /** @type {any} */ (window).WSShell;
            if (shell && shell.toast) shell.toast(`The console now locks after ${used} minutes without activity.`, 'ok');
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindPicker); else bindPicker();

    window.WSAdminLock = { lock, reset, configure, minutes, clampMinutes, mayUnlock, lockedState, clearLock, endServerSession, sessionIdOf, MIN_MINUTES, MAX_MINUTES };
    window.WSAdminResetInactivityTimer = reset;
})();
