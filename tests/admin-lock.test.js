// admin/inactivity.js — the Lock button and the idle timeout (BUG-01, BUG-02).
// Runs the browser script in a small fake window: timers, localStorage,
// BroadcastChannel, fetch and the Supabase client are stand-ins we control.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '../admin/inactivity.js'), 'utf8');

function jwt(payload) {
  const b64 = s => Buffer.from(JSON.stringify(s)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

/** One admin tab. Tabs made from the same `shared` see the same localStorage and channel. */
function tab(shared, opts = {}) {
  const listeners = {}, docListeners = {}, timers = [];
  const calls = { fetch: [], signOut: 0, replace: [] };
  const dashboard = { classList: { hidden: false, add(c) { if (c === 'hidden') this.hidden = true; } } };
  const storage = {
    getItem: k => (k in shared.store ? shared.store[k] : null),
    setItem: (k, v) => {
      shared.store[k] = String(v);
      for (const t of shared.tabs) if (t !== self && t.storageListener) t.storageListener({ key: k, newValue: String(v) });
    },
    removeItem: k => { delete shared.store[k]; },
  };
  class BroadcastChannel {
    constructor(name) { this.name = name; shared.channels.push(this); this.owner = self; }
    postMessage(data) { for (const c of shared.channels) if (c !== this && c.name === this.name && c.onmessage) c.onmessage({ data }); }
  }
  const self = {};
  const window = {
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); if (type === 'storage') self.storageListener = fn; },
    setTimeout(fn, ms) { timers.push({ fn, at: shared.now + ms }); return timers.length; },
    __WS_ADMIN_SB__: opts.account === false ? undefined : {
      auth: {
        getSession: async () => ({ data: { session: { access_token: jwt({ session_id: opts.session || 'sess-1' }) } } }),
        signOut: async () => { calls.signOut++; return { error: opts.signOutFails ? new Error('offline') : null }; },
      },
    },
  };
  const context = {
    window, localStorage: storage, BroadcastChannel, atob: s => Buffer.from(s, 'base64').toString('binary'),
    clearTimeout: () => {}, Date: { now: () => shared.now }, URL, URLSearchParams, Number, Math, JSON, String, Promise, Option: function () {},
    location: { origin: 'https://work.example.test', replace(u) { calls.replace.push(u); }, reload() {} },
    CustomEvent: function (type) { this.type = type; },
    document: {
      readyState: 'complete', hidden: false,
      addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
      dispatchEvent(e) { (docListeners[e.type] || []).forEach(fn => fn(e)); },
      getElementById: id => (id === 'dashboard' ? dashboard : null),
      querySelectorAll: () => [],
    },
    fetch: async (url, init) => {
      calls.fetch.push(JSON.parse(init.body).action);
      if (opts.logoutFails) throw new TypeError('Failed to fetch');
      return { ok: true };
    },
  };
  window.document = context.document;
  vm.runInNewContext(SRC, context);
  Object.assign(self, { window, listeners, docListeners, timers, calls, dashboard, document: context.document });
  shared.tabs.push(self);
  return self;
}
const world = () => ({ store: {}, channels: [], tabs: [], now: 1_000_000 });
const settle = () => new Promise(r => setImmediate(r));
/** Move the clock and run every timer that came due. */
async function advance(shared, t, ms) {
  shared.now += ms;
  for (let guard = 0; guard < 50; guard++) {
    const due = t.timers.filter(x => !x.done && x.at <= shared.now);
    if (!due.length) break;
    for (const x of due) { x.done = true; x.fn(); }
    await settle();
  }
  await settle();
}

test('the script loads: every activity listener and the reset hook are installed (BUG-01)', () => {
  const t = tab(world());
  for (const evt of ['mousemove', 'keydown', 'click', 'touchstart', 'scroll']) assert.ok(t.listeners[evt] && t.listeners[evt].length, evt);
  assert.equal(typeof t.window.WSAdminResetInactivityTimer, 'function');
  assert.equal(typeof t.window.WSAdminLock.lock, 'function');
});

test('the timeout setting is clamped to 1-240 whole minutes; junk means 30', () => {
  const L = tab(world()).window.WSAdminLock;
  assert.equal(L.clampMinutes(0), 1);
  assert.equal(L.clampMinutes(-5), 1);
  assert.equal(L.clampMinutes(100000), 240);
  assert.equal(L.clampMinutes('abc'), 30);
  assert.equal(L.clampMinutes(null), 30);
  assert.equal(L.clampMinutes('45'), 45);
  assert.equal(L.configure(9999), 240);
  assert.equal(L.minutes(), 240);
});

test('idle for the timeout: the cookie and the account session end and the page goes to the gate', async () => {
  const shared = world();
  const t = tab(shared);
  t.window.WSAdminLock.configure(10);
  t.document.dispatchEvent({ type: 'admin-unlocked' });
  await advance(shared, t, 9 * 60 * 1000);
  assert.deepEqual(t.calls.replace, [], 'not yet');
  await advance(shared, t, 2 * 60 * 1000);
  assert.deepEqual(t.calls.fetch, ['logout']);
  assert.equal(t.calls.signOut, 1);
  assert.deepEqual(t.calls.replace, ['/wsm-admin?locked=idle']);
  assert.equal(t.dashboard.classList.hidden, true);
  const mark = JSON.parse(shared.store.wsAdminLocked);
  assert.equal(mark.reason, 'idle');
  assert.equal(mark.session, 'sess-1');
  assert.equal(mark.incomplete, undefined);
});

test('activity keeps it open, including activity in another admin tab', async () => {
  const shared = world();
  const a = tab(shared), b = tab(shared);
  a.window.WSAdminLock.configure(10);
  a.document.dispatchEvent({ type: 'admin-unlocked' });
  b.document.dispatchEvent({ type: 'admin-unlocked' });
  for (let i = 0; i < 5; i++) {
    await advance(shared, a, 4 * 60 * 1000);
    await advance(shared, b, 0);
    b.listeners.keydown[0]();           // someone is working in tab B
  }
  assert.deepEqual(a.calls.replace, [], 'tab A saw tab B working');
  assert.deepEqual(b.calls.replace, []);
});

test('Lock in one tab locks every admin tab, and only one of them talks to the server', async () => {
  const shared = world();
  const a = tab(shared), b = tab(shared);
  b.document.dispatchEvent({ type: 'admin-unlocked' });
  await a.window.WSAdminLock.lock('manual');
  assert.deepEqual(a.calls.replace, ['/wsm-admin?locked=manual']);
  assert.deepEqual(b.calls.replace, ['/wsm-admin?locked=manual']);
  assert.equal(b.dashboard.classList.hidden, true);
  assert.deepEqual(b.calls.fetch, []);
});

test('a failed logout still hides the page and keeps the console shut on the next load', async () => {
  const shared = world();
  const t = tab(shared, { logoutFails: true, signOutFails: true });
  await t.window.WSAdminLock.lock('manual');
  assert.deepEqual(t.calls.replace, ['/wsm-admin?locked=manual']);
  assert.equal(JSON.parse(shared.store.wsAdminLocked).incomplete, true);
  // The reloaded page: a leftover cookie or the same account session may not reopen it.
  const reloaded = tab(shared, { session: 'sess-1' });
  assert.equal(reloaded.window.WSAdminLock.mayUnlock(jwt({ session_id: 'sess-1' })), false);
  assert.equal(reloaded.window.WSAdminLock.mayUnlock(null), false);
  // A new sign-in has a new session id; a password login clears the mark.
  assert.equal(reloaded.window.WSAdminLock.mayUnlock(jwt({ session_id: 'sess-2' })), true);
  reloaded.window.WSAdminLock.clearLock();
  assert.equal(shared.store.wsAdminLocked, undefined);
  assert.equal(reloaded.window.WSAdminLock.mayUnlock(null), true);
});

test('password-only console (no account client): Lock still ends the cookie', async () => {
  const shared = world();
  const t = tab(shared, { account: false });
  await t.window.WSAdminLock.lock('manual');
  assert.deepEqual(t.calls.fetch, ['logout']);
  assert.equal(JSON.parse(shared.store.wsAdminLocked).session, null);
});

test('the admin page wires Lock to this flow and checks the mark before opening', () => {
  const html = fs.readFileSync(path.join(__dirname, '../wsm-admin/index.html'), 'utf8');
  assert.match(html, /<script src="\/admin\/inactivity\.js"><\/script>/);
  assert.match(html, /getElementById\('logout-btn'\)\.addEventListener\('click', \(\) => window\.WSAdminLock\.lock\('manual'\)\)/);
  assert.match(html, /WSAdminLock\.mayUnlock\(adminToken\)/);
  assert.match(html, /WSAdminLock\.clearLock\(\);\s*\n\s*await unlockAdmin\(\);/);
  // The old code redirected to a page that does not exist.
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../admin/inactivity.js'), 'utf8'), /login\.html/);
});
