/* ============================================================================
   WorkSuite call window (/call/?id=<uuid>[&answer=1][&audio=1][&decline=1][&return=<url>])

   The database decides who is in the call and whether it is still going
   (calls + call_participants, changed only through ws_call_* functions);
   this page follows that state, carries the media with call/mesh.js and
   signals on a Realtime channel private to the call (`call:<id>`).

   Life of the page:
     boot      -> session, ws_call_get, names
     route     -> caller: join straight away · callee: Accept / Decline screen
                  (answer=1 skips it; decline=1 declines and closes) ·
                  group member: Join screen
     join      -> microphone (+ camera), ws_call_action('join', sid), ICE servers,
                  presence + signalling, heartbeat every 10 s
     in call   -> tiles, controls, devices; repairs are mesh.js's job
     finish    -> tracks stopped, channels closed, the ended screen

   Nothing here trusts the browser for call state: "who hung up" and "was it
   answered" come back from the database, so every device agrees.
   ============================================================================ */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const params = new URLSearchParams(location.search);
    const CALL_ID = (params.get('id') || '').trim();
    const WANT_ANSWER = params.get('answer') === '1';
    const WANT_DECLINE = params.get('decline') === '1';
    const AUDIO_ONLY = params.get('audio') === '1';
    const RETURN_URL = sameOriginPath(params.get('return'));
    const SID = randomId();
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const FALLBACK_ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
    const PREFS_KEY = 'ws-call-devices';
    const HEARTBEAT_MS = 10000;
    const RING_SECONDS = 45;
    const DEBUG = (() => { try { return localStorage.getItem('ws-call-debug') === '1'; } catch (e) { return false; } })();

    const S = {
        sb: null, cfg: null, session: null,
        me: { id: null, name: 'You', avatar: null },
        call: null, people: new Map(), groupName: '',
        phase: 'preparing', joined: false, joining: false, ended: false, leaving: false, cancelled: false,
        skew: 0,
        local: { stream: null, mic: null, cam: null, screen: null },
        micOn: false, noMic: false, camBusy: false,
        mesh: null, iceServers: FALLBACK_ICE, iceInfo: null,
        sigChannel: null, dbChannel: null,
        presence: new Map(), goneTimers: new Map(),
        streams: new Map(), peerState: new Map(), stats: new Map(),
        tiles: new Map(), audios: new Map(),
        timers: { heartbeat: null, clock: null, bcPost: null, settle: null, poll: null, presence: null, close: null },
        heartbeatFails: 0, rejoinAt: 0,
        bc: null, pipCorner: 'br', callEndPushed: false, missedPushed: false, byeSids: new Set(), callerGaveUp: false,
    };

    /* ------------------------------------------------------------ helpers */
    function randomId() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        return 'sid-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
    /** A path on this site only: "/.//evil.com" or "https://site//evil.com/x" must never become "//evil.com". */
    function sameOriginPath(u) {
        if (!u) return null;
        let x;
        try { x = new URL(u, location.origin); } catch (e) { return null; }
        if (x.origin !== location.origin) return null;
        const out = '/' + x.pathname.replace(/^[\/\\]+/, '') + x.search + x.hash;
        return /^\/(?![\/\\])/.test(out) ? out : null;
    }
    function log(...a) { if (DEBUG) console.log('[call]', ...a); }
    function pickColor(name) {
        const colors = ['#3b82f6', '#a855f7', '#ec4899', '#f97316', '#10b981', '#14b8a6', '#f59e0b', '#ef4444', '#6366f1', '#06b6d4'];
        const i = String(name || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0) % colors.length;
        return colors[i];
    }
    function person(id) { return S.people.get(id) || null; }
    function nameOf(id) {
        if (id === S.me.id) return S.me.name || 'You';
        const p = person(id);
        return (p && (p.full_name || (p.email ? p.email.split('@')[0] : ''))) || 'Someone';
    }
    function firstName(id) { return nameOf(id).split(' ')[0]; }
    /** Fill an avatar element with a photo or an initial. Never innerHTML with names. */
    function fillAvatar(el, id, label) {
        if (!el) return;
        el.textContent = '';
        const p = id ? person(id) : null;
        const name = label || nameOf(id);
        if (p && p.avatar_url) {
            const img = document.createElement('img');
            img.alt = '';
            img.src = p.avatar_url;
            img.onerror = () => { img.remove(); el.textContent = initials(name); };
            el.appendChild(img);
        } else {
            el.textContent = initials(name);
        }
        el.style.background = pickColor(name);
    }
    function initials(name) {
        const parts = String(name || '?').trim().split(/\s+/);
        return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
    }
    function fmtClock(sec) {
        sec = Math.max(0, Math.floor(sec));
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(s).padStart(2, '0');
        return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    }
    function serverNow() { return Date.now() + S.skew; }
    function toast(msg, ms) {
        const box = $('toasts');
        const t = document.createElement('div');
        t.className = 'toast';
        t.textContent = msg;
        box.appendChild(t);
        setTimeout(() => t.remove(), ms || 3200);
    }
    function withTimeout(p, ms) {
        return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
    }
    async function rpc(name, args) {
        const { data, error } = await S.sb.rpc(name, args);
        if (error) throw error;
        return data;
    }
    const isMissingSetup = (e) => !!e && (['PGRST202', '42883', '42P01', 'PGRST205'].includes(String(e.code)) || /could not find the function/i.test(e.message || ''));
    const isTerminal = (status) => ['ended', 'missed', 'declined', 'busy'].includes(status);
    function myPart() { return S.call && S.call.participants ? S.call.participants.find(p => p.user_id === S.me.id) || null : null; }
    function part(id) { return S.call && S.call.participants ? S.call.participants.find(p => p.user_id === id) || null : null; }
    function others() { return S.call && S.call.participants ? S.call.participants.filter(p => p.user_id !== S.me.id) : []; }
    const isCaller = () => !!S.call && S.call.created_by === S.me.id;
    const isGroup = () => !!(S.call && S.call.conversation_id);
    function callTitle() {
        if (isGroup()) return S.groupName || 'Group call';
        const o = others().find(p => p.user_id !== S.me.id);
        return o ? nameOf(o.user_id) : 'Call';
    }
    function titleAvatarId() {
        if (isGroup()) return null;
        const o = others()[0];
        return o ? o.user_id : null;
    }
    function chatUrl() {
        if (!S.call) return '/chat/';
        if (isGroup()) return '/chat/#group=' + encodeURIComponent(S.call.conversation_id);
        const o = others()[0];
        return o ? '/chat/#thread=' + encodeURIComponent(o.user_id) : '/chat/';
    }
    function token() { return S.session && S.session.access_token; }
    function sendPush(body) {
        if (!token()) return;
        try {
            fetch('/api/push', {
                method: 'POST', keepalive: true,
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
                body: JSON.stringify(body),
            }).catch(() => {});
        } catch (e) { /* best effort */ }
    }
    /** The service worker shows ringing pushes with tag call-<id>; once this call stops ringing they must go. */
    function closeCallNotifications() {
        try {
            if (!('serviceWorker' in navigator) || !navigator.serviceWorker.getRegistration) return;
            navigator.serviceWorker.getRegistration().then(reg => {
                if (!reg || !reg.getNotifications) return;
                return reg.getNotifications({ tag: 'call-' + CALL_ID }).then(list => list.forEach(n => n.close()));
            }).catch(() => {});
        } catch (e) { /* not supported */ }
    }
    function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch (e) { return {}; } }
    function savePref(k, v) { const p = loadPrefs(); p[k] = v; try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) { /* private mode */ } }

    /* -------------------------------------------------------------- tones */
    // Indian ring-back (400+450 Hz, "ring-ring") while calling; a bright
    // two-note ring for an incoming call; a busy tone for declined/busy.
    const Tones = (() => {
        let ctx = null, timer = null, pending = [];
        function ensure() {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return null;
            if (!ctx) { try { ctx = new AC(); } catch (e) { return null; } }
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
            return ctx;
        }
        function beep(freqs, dur, gain) {
            const c = ensure();
            if (!c) return;
            const t0 = c.currentTime, g = c.createGain();
            g.gain.setValueAtTime(0, t0);
            g.gain.linearRampToValueAtTime(gain, t0 + 0.02);
            g.gain.setValueAtTime(gain, t0 + dur - 0.03);
            g.gain.linearRampToValueAtTime(0, t0 + dur);
            g.connect(c.destination);
            freqs.forEach(f => { const o = c.createOscillator(); o.frequency.value = f; o.connect(g); o.start(t0); o.stop(t0 + dur + 0.02); });
        }
        function later(fn, ms) { pending.push(setTimeout(fn, ms)); }
        function stop() { if (timer) clearInterval(timer); timer = null; pending.forEach(clearTimeout); pending = []; }
        function loop(fn, every) { stop(); fn(); timer = setInterval(fn, every); }
        return {
            ringback() { loop(() => { beep([400, 450], 0.4, 0.05); later(() => beep([400, 450], 0.4, 0.05), 600); }, 3000); },
            incoming() {
                loop(() => {
                    beep([880], 0.16, 0.07); later(() => beep([1175], 0.16, 0.07), 200);
                    later(() => beep([880], 0.16, 0.07), 650); later(() => beep([1175], 0.16, 0.07), 850);
                }, 2600);
            },
            busy() { stop(); [0, 800, 1600].forEach(ms => later(() => beep([480, 620], 0.4, 0.05), ms)); },
            end() { stop(); beep([660], 0.14, 0.05); later(() => beep([440], 0.22, 0.05), 170); },
            stop,
            resume() { ensure(); },
            close() { stop(); if (ctx) { ctx.close().catch(() => {}); ctx = null; } },
        };
    })();

    /* ---------------------------------------------------------- UI chrome */
    function setPhase(p) {
        if (S.phase === p && document.body.classList.contains('phase-' + p)) return;
        S.phase = p;
        document.body.className = document.body.className.replace(/\bphase-\S+/g, '').trim() + ' phase-' + p;
        const controlsOn = p === 'calling' || p === 'incall';
        $('controls').hidden = !controlsOn;
        document.body.classList.toggle('no-controls', !controlsOn);
        postState();
        renderTiles();
        if (S.call) updateClock();
    }

    /** The centre panel for everything that is not the live call. */
    function panel(opts) {
        const av = $('panel-avatar');
        if (opts.avatar === false) { av.textContent = ''; av.style.background = ''; }
        else if (opts.avatarGroup) { av.textContent = initials(opts.avatarGroup); av.style.background = pickColor(opts.avatarGroup); }
        else fillAvatar(av, opts.avatarId || null, opts.avatarLabel);
        $('panel-title').textContent = opts.title || '';
        $('panel-sub').textContent = opts.sub || '';
        const help = $('panel-help');
        help.textContent = '';
        help.hidden = !opts.help;
        if (opts.help) {
            if (opts.help.lead) { const p = document.createElement('div'); p.textContent = opts.help.lead; help.appendChild(p); }
            if (opts.help.steps) {
                const ol = document.createElement('ol');
                opts.help.steps.forEach(s => { const li = document.createElement('li'); li.textContent = s; ol.appendChild(li); });
                help.appendChild(ol);
            }
        }
        const box = $('panel-actions');
        box.textContent = '';
        (opts.actions || []).forEach(a => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'pbtn ' + (a.cls || '');
            if (a.icon) b.insertAdjacentHTML('afterbegin', a.icon);   // static SVG strings from this file only
            b.appendChild(document.createTextNode(a.label));
            b.addEventListener('click', a.onClick);
            box.appendChild(b);
        });
        $('panel-foot').textContent = opts.foot || '';
        const first = box.querySelector('.accept, .primary') || box.querySelector('button');
        if (first && opts.focus !== false) setTimeout(() => { try { first.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 30);
    }

    const ICON = {
        phone: '<svg viewBox="0 0 24 24"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"/></svg>',
        video: '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3"/></svg>',
        end: '<svg viewBox="0 0 24 24"><path d="M21 15.5v2a2 2 0 0 1-2.2 2 16 16 0 0 1-3.8-1.1 2 2 0 0 1-1.1-2.2l.3-1.4a12 12 0 0 0-4.4 0l.3 1.4A2 2 0 0 1 9 18.4a16 16 0 0 1-3.8 1.1A2 2 0 0 1 3 17.5v-2c0-.6.3-1.2.8-1.5a14 14 0 0 1 16.4 0c.5.3.8.9.8 1.5Z"/></svg>',
    };

    function renderHeader() {
        const title = callTitle();
        $('tb-title').textContent = title;
        document.title = `${title} · Call · WorkSuite`;
        const av = $('tb-avatar');
        if (isGroup()) { av.textContent = initials(title); av.style.background = pickColor(title); }
        else fillAvatar(av, titleAvatarId());
        const count = $('tb-count');
        if (isGroup() && S.joined) {
            const n = (S.call.participants || []).filter(p => p.state === 'joined').length;
            count.hidden = false;
            count.textContent = `${n} in call`;
        } else count.hidden = true;
        updateClock();
    }

    function updateClock() {
        const sub = $('tb-sub');
        if (!S.call) return;
        if (S.phase === 'incall') {
            const solo = !isGroup() ? others()[0] : null;
            const st = solo ? S.peerState.get(solo.user_id) : null;
            if (st === 'reconnecting' || st === 'failed') { sub.textContent = 'Reconnecting…'; return; }
            if (S.call.answered_at) sub.textContent = fmtClock((serverNow() - Date.parse(S.call.answered_at)) / 1000);
            else sub.textContent = 'Connecting…';
        } else if (S.phase === 'calling') {
            sub.textContent = ringingText();
        } else if (S.phase === 'incoming') {
            sub.textContent = S.call.media === 'video' ? 'Incoming video call' : 'Incoming voice call';
        } else if (S.phase === 'ended') {
            sub.textContent = 'Call ended';
        }
    }
    function ringingText() {
        const pending = others().filter(p => p.state === 'invited' || p.state === 'ringing');
        return pending.some(p => p.state === 'ringing') ? 'Ringing…' : 'Calling…';
    }

    /* ------------------------------------------------------------- boot */
    async function initSupabase() {
        const r = await fetch('/api/config', { cache: 'no-store' });
        const cfg = await r.json();
        if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase) throw new Error('config');
        S.cfg = cfg;
        const existing = window.__WS_SB__ || window.__WS_PRESENCE_SB__;
        S.sb = existing && existing.auth && existing.rpc ? existing
            : window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
        if (!window.__WS_SB__) window.__WS_SB__ = S.sb;
    }

    async function loadPeople() {
        const ids = new Set([S.me.id]);
        (S.call.participants || []).forEach(p => ids.add(p.user_id));
        if (S.call.created_by) ids.add(S.call.created_by);
        const missing = [...ids].filter(id => id && !S.people.has(id));
        const jobs = [];
        if (missing.length) {
            jobs.push(S.sb.from('profiles').select('id, full_name, email, avatar_url').in('id', missing).then(({ data }) => {
                (data || []).forEach(p => S.people.set(p.id, p));
            }));
        }
        if (isGroup() && !S.groupName) {
            jobs.push(S.sb.from('conversations').select('id, name').eq('id', S.call.conversation_id).maybeSingle().then(({ data }) => {
                if (data && data.name) S.groupName = data.name;
            }));
        }
        try { await Promise.all(jobs); } catch (e) { log('people', e); }
        const me = S.people.get(S.me.id);
        if (me) { S.me.name = me.full_name || S.me.name; S.me.avatar = me.avatar_url || null; }
    }

    async function boot() {
        wireControls();
        setupBroadcast();
        if (!CALL_ID || !UUID_RE.test(CALL_ID)) return fail('notfound');
        try { await initSupabase(); } catch (e) { return fail('offline', e); }
        let session = null;
        try { session = (await S.sb.auth.getSession()).data.session; } catch (e) { /* treated as signed out */ }
        if (!session) return fail('signedout');
        S.session = session;
        S.me.id = session.user.id;
        S.me.name = (session.user.user_metadata && session.user.user_metadata.full_name) || (session.user.email || 'You').split('@')[0];
        S.sb.auth.onAuthStateChange((ev, s) => { if (s) S.session = s; if (ev === 'SIGNED_OUT' && !S.ended) finish('signedout'); });

        let state;
        try { state = await rpc('ws_call_get', { p_call: CALL_ID }); }
        catch (e) { return fail(isMissingSetup(e) ? 'setup' : /not found/i.test(e.message || '') ? 'notfound' : 'load', e); }
        if (!state || !state.id) return fail('notfound');
        S.call = state;
        if (state.now) S.skew = Date.parse(state.now) - Date.now();
        await loadPeople();
        renderHeader();
        subscribeDb();
        if (WANT_DECLINE) return declineFromLink();
        route();
    }

    function route() {
        const c = S.call, mine = myPart();
        if (isTerminal(c.status)) return showEnded('db');
        if (mine && mine.role === 'caller') return join();
        if (WANT_ANSWER) return join({ audioOnly: AUDIO_ONLY });
        if (mine && (mine.state === 'invited' || mine.state === 'ringing')) return showIncoming();
        if (mine && mine.state === 'joined' && mine.device_id && mine.device_id !== SID) return showElsewhere();
        return showJoinPrompt();
    }

    /* ---------------------------------------------------- pre-call screens */
    function showIncoming() {
        setPhase('incoming');
        const video = S.call.media === 'video';
        const caller = S.call.created_by;
        panel({
            avatarId: isGroup() ? null : caller,
            avatarGroup: isGroup() ? callTitle() : null,
            title: isGroup() ? callTitle() : nameOf(caller),
            sub: isGroup() ? `${nameOf(caller)} is calling the group` : (video ? 'Incoming video call' : 'Incoming voice call'),
            actions: [
                { label: 'Decline', cls: 'decline', icon: ICON.end, onClick: decline },
                { label: 'Accept', cls: 'accept', icon: video ? ICON.video : ICON.phone, onClick: () => join() },
                ...(video ? [{ label: 'Answer with audio only', cls: 'wide', onClick: () => join({ audioOnly: true }) }] : []),
            ],
        });
        Tones.incoming();
        const mine = myPart();
        if (mine && mine.state === 'invited') rpc('ws_call_action', { p_call: CALL_ID, p_action: 'ringing', p_device: null }).then(applyState).catch(() => {});
        // Realtime normally tells us when the caller gives up; poll as well in case it is down.
        clearInterval(S.timers.poll);
        S.timers.poll = setInterval(() => {
            if (S.phase !== 'incoming') return clearInterval(S.timers.poll);
            rpc('ws_call_get', { p_call: CALL_ID }).then(applyState).catch(() => {});
        }, 5000);
    }

    async function decline() {
        Tones.stop();
        clearInterval(S.timers.poll);
        closeCallNotifications();
        try { const st = await rpc('ws_call_action', { p_call: CALL_ID, p_action: 'decline', p_device: null }); if (st) S.call = st; }
        catch (e) { log('decline', e); }
        sendPush({ action: 'call-end', call_id: CALL_ID });      // stop it ringing on my other devices
        finish('declined-here');
    }

    /** The notification's "Decline" button opens this page with decline=1. */
    async function declineFromLink() {
        setPhase('ended');
        panel({ avatarId: isGroup() ? null : S.call.created_by, avatarGroup: isGroup() ? callTitle() : null, title: 'Declining…', sub: '', focus: false });
        closeCallNotifications();
        const mine = myPart();
        if (mine && (mine.state === 'invited' || mine.state === 'ringing') && !isTerminal(S.call.status)) {
            try { await rpc('ws_call_action', { p_call: CALL_ID, p_action: 'decline', p_device: null }); } catch (e) { log('decline', e); }
            sendPush({ action: 'call-end', call_id: CALL_ID });  // stop it ringing on my other devices
        }
        panel({ avatarId: isGroup() ? null : S.call.created_by, avatarGroup: isGroup() ? callTitle() : null, title: 'Call declined', sub: `${callTitle()} has been told you can’t talk right now.`, focus: false });
        postState();
        setTimeout(() => {
            try { window.close(); } catch (e) { /* not script-opened */ }
            setTimeout(() => { if (!window.closed) location.replace(RETURN_URL || '/chat/'); }, 250);
        }, 1500);
    }

    function showJoinPrompt() {
        setPhase('incoming');
        const joined = (S.call.participants || []).filter(p => p.state === 'joined').length;
        const video = S.call.media === 'video';
        panel({
            avatarId: isGroup() ? null : S.call.created_by,
            avatarGroup: isGroup() ? callTitle() : null,
            title: callTitle(),
            sub: `${isGroup() ? 'Group call' : 'Call'} in progress · ${joined} in the call`,
            actions: [
                { label: 'Not now', onClick: backToChat },
                { label: video ? 'Join with video' : 'Join', cls: 'accept', icon: video ? ICON.video : ICON.phone, onClick: () => join() },
                ...(video ? [{ label: 'Join with audio only', cls: 'wide', onClick: () => join({ audioOnly: true }) }] : []),
            ],
        });
    }

    function showElsewhere() {
        setPhase('incoming');
        panel({
            avatarId: titleAvatarId(), avatarGroup: isGroup() ? callTitle() : null,
            title: 'You’re in this call on another device',
            sub: 'Move the call here to continue on this device. The other one will hang up.',
            actions: [
                { label: 'Back to chat', onClick: backToChat },
                { label: 'Move the call here', cls: 'accept', icon: ICON.phone, onClick: () => join() },
            ],
        });
    }

    /* ------------------------------------------------------------- media */
    function gum(constraints) { return navigator.mediaDevices.getUserMedia(constraints); }
    function audioConstraints(deviceId) {
        const a = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
        if (deviceId) a.deviceId = { exact: deviceId };
        return a;
    }
    function videoConstraints(deviceId, facing) {
        const v = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } };
        if (deviceId) v.deviceId = { exact: deviceId };
        else v.facingMode = facing || 'user';
        return v;
    }
    /** Ask with the saved device first; if it is gone, fall back to the default one. */
    async function gumPreferring(kind, saved) {
        const make = (id) => kind === 'audio' ? { audio: audioConstraints(id) } : { video: videoConstraints(id) };
        if (saved) { try { return await gum(make(saved)); } catch (e) { if (e.name === 'NotAllowedError' || e.name === 'SecurityError') throw e; } }
        return gum(make(null));
    }

    async function startMedia(wantVideo) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            const e = new Error('Calls need a secure (https) connection'); e.name = 'NotSupportedError'; throw e;
        }
        const prefs = loadPrefs();
        const stream = new MediaStream();
        // Microphone first: without permission for it there is no call; without a device we can still listen.
        try {
            const a = await gumPreferring('audio', prefs.mic);
            a.getAudioTracks().forEach(t => stream.addTrack(t));
        } catch (e) {
            if (e.name === 'NotAllowedError' || e.name === 'SecurityError' || e.name === 'NotSupportedError') throw e;
            S.noMic = true;
            toast('No microphone found — you can listen, but others won’t hear you', 5000);
        }
        if (wantVideo) {
            try {
                const v = await gumPreferring('video', prefs.cam);
                v.getVideoTracks().forEach(t => stream.addTrack(t));
            } catch (e) {
                toast(e.name === 'NotAllowedError' ? 'Camera blocked — you joined with audio only' : 'Camera unavailable — you joined with audio only', 5000);
            }
        }
        S.local.stream = stream;
        S.local.mic = stream.getAudioTracks()[0] || null;
        S.local.cam = stream.getVideoTracks()[0] || null;
        S.micOn = !!S.local.mic;
        if (S.local.mic) watchMic(S.local.mic);
        if (S.local.cam) watchCam(S.local.cam);
        refreshDevices();
    }

    function watchMic(track) {
        track.addEventListener('ended', () => {
            if (S.local.mic !== track || S.ended) return;
            toast('Your microphone disconnected — switching to another one');
            switchMic(null).catch(() => { S.local.mic = null; S.noMic = true; S.micOn = false; updateButtons(); trackPresence(); });
        });
    }
    function watchCam(track) {
        track.addEventListener('ended', () => {
            if (S.local.cam !== track || S.ended) return;
            S.local.cam = null;
            if (!S.local.screen) setVideoTrack(null);
            toast('Your camera turned off');
            renderSelf(); updateButtons(); trackPresence();
        });
    }

    async function setVideoTrack(track) {
        if (S.mesh) await S.mesh.setLocalTrack('video', track);
        else {
            const s = S.local.stream;
            s.getVideoTracks().forEach(t => s.removeTrack(t));
            if (track) s.addTrack(track);
        }
        renderSelf();
    }
    async function setAudioTrack(track) {
        if (S.mesh) await S.mesh.setLocalTrack('audio', track);
        else {
            const s = S.local.stream;
            s.getAudioTracks().forEach(t => s.removeTrack(t));
            if (track) s.addTrack(track);
        }
    }
    const sendingVideo = () => !!(S.local.screen || S.local.cam);

    function stopLocalTracks() {
        ['mic', 'cam', 'screen'].forEach(k => { const t = S.local[k]; if (t) { try { t.stop(); } catch (e) { /* stopped */ } } S.local[k] = null; });
        if (S.local.stream) S.local.stream.getTracks().forEach(t => { try { t.stop(); } catch (e) { /* stopped */ } });
    }

    async function fetchIce() {
        try {
            const ctl = window.AbortController ? new AbortController() : null;
            const t = setTimeout(() => ctl && ctl.abort(), 4000);
            const r = await fetch('/api/ice', { headers: { Authorization: 'Bearer ' + token() }, cache: 'no-store', signal: ctl ? ctl.signal : undefined });
            clearTimeout(t);
            if (!r.ok) { S.iceInfo = { reachable: false }; return FALLBACK_ICE; }
            const j = await r.json();
            S.iceInfo = { reachable: true, relay: !!j.relay, provider: j.provider || '' };
            if (Array.isArray(j.iceServers) && j.iceServers.length) { log('ice', j.provider, j.relay); return j.iceServers; }
        } catch (e) { log('ice fallback', e && e.message); S.iceInfo = { reachable: false }; }
        return FALLBACK_ICE;
    }

    /* -------------------------------------------------------------- join */
    async function join(opts) {
        opts = opts || {};
        if (S.joining || S.joined || S.ended) return;
        S.joining = true;
        clearInterval(S.timers.poll);
        Tones.stop();
        closeCallNotifications();
        const wantVideo = S.call.media === 'video' && !opts.audioOnly;
        setPhase('preparing');
        panel({
            avatarId: titleAvatarId(), avatarGroup: isGroup() ? callTitle() : null,
            title: isCaller() ? `Calling ${callTitle()}…` : 'Joining…',
            sub: `Allow your microphone${wantVideo ? ' and camera' : ''} if the browser asks.`, focus: false,
        });
        try { await startMedia(wantVideo); }
        catch (e) {
            S.joining = false;
            stopLocalTracks();
            // A caller without a microphone must not leave the other person ringing for nothing.
            if (isCaller() && S.call.status === 'ringing') {
                S.callerGaveUp = true;
                rpc('ws_call_action', { p_call: CALL_ID, p_action: 'leave', p_device: SID })
                    .then(st => { if (st && st.id) S.call = st; if (st && ['missed', 'declined', 'busy'].includes(st.status)) sendPush({ action: 'call-end', call_id: CALL_ID }); })
                    .catch(() => {});
            }
            return fail('media', e);
        }
        const icePromise = fetchIce();
        let state;
        try { state = await rpc('ws_call_action', { p_call: CALL_ID, p_action: 'join', p_device: SID }); }
        catch (e) {
            S.joining = false;
            stopLocalTracks();
            if (/ended/i.test(e.message || '')) { try { S.call = await rpc('ws_call_get', { p_call: CALL_ID }); } catch (x) { /* keep */ } return showEnded('db'); }
            return fail(isMissingSetup(e) ? 'setup' : 'join', e);
        }
        S.iceServers = await icePromise;
        S.joined = true;
        S.joining = false;
        createMesh();
        subscribeSignal();
        startHeartbeat();
        startClock();
        await loadPeople();
        applyState(state);
        // Picked up here: take the "Incoming call" notification off my phone and other devices.
        if (!isCaller()) sendPush({ action: 'call-end', call_id: CALL_ID });
        if (S.phase === 'preparing') updateCallPhase();
        renderSelf();
        updateButtons();
    }

    async function rejoin() {
        if (Date.now() - S.rejoinAt < HEARTBEAT_MS || S.ended) return;
        S.rejoinAt = Date.now();
        try { applyState(await rpc('ws_call_action', { p_call: CALL_ID, p_action: 'join', p_device: SID })); }
        catch (e) { if (/ended/i.test(e.message || '')) finish('db'); }
    }

    function createMesh() {
        S.mesh = new window.WSCallMesh({
            selfId: S.me.id, sid: SID, iceServers: S.iceServers, localStream: S.local.stream,
            send: sendSignal, log: DEBUG ? (...a) => console.log('[mesh]', ...a) : null,
        });
        S.mesh.on('stream', (uid, stream) => {
            S.streams.set(uid, stream);
            stream.getTracks().forEach(t => {
                if (t.__wsWatched) return;
                t.__wsWatched = true;
                t.addEventListener('mute', () => updateTile(uid));
                t.addEventListener('unmute', () => updateTile(uid));
            });
            attachAudio(uid, stream);
            renderTiles();
        });
        S.mesh.on('state', (uid, st) => {
            if (st === 'closed') { S.peerState.delete(uid); S.streams.delete(uid); S.stats.delete(uid); detachAudio(uid); }
            else S.peerState.set(uid, st);
            updateCallPhase();
            renderTiles();
            updateClock();
        });
        S.mesh.on('stats', (uid, st) => { S.stats.set(uid, st); updateQuality(uid); if (!$('devices').hidden) renderConnection(); });
        S.mesh.on('levels', (m) => m.forEach((lvl, uid) => { const t = S.tiles.get(uid); if (t) t.el.classList.toggle('speaking', lvl > 0.04); }));
    }

    /* ------------------------------------------------------ signalling */
    function sendSignal(to, type, data) {
        const ch = S.sigChannel;
        if (!ch) return;
        try {
            const r = ch.send({ type: 'broadcast', event: 'sig', payload: { from: { userId: S.me.id, sid: SID }, to, type, data } });
            if (r && r.catch) r.catch(() => {});
        } catch (e) { log('send', e); }
    }

    function allowed(userId) {
        if (part(userId)) return true;
        return isGroup();   // a group member who joins late appears in call_participants a moment later
    }

    function onSignal(p) {
        if (!p || !p.from || !p.to || p.to.userId !== S.me.id || p.to.sid !== SID || !S.mesh || S.ended) return;
        if (!allowed(p.from.userId)) return;
        if (!part(p.from.userId)) refreshState();
        S.mesh.handleSignal(p.from, p.type, p.data);
        if (p.type === 'bye') { S.byeSids.add(p.from.sid); onBye(p.from.userId); }
    }

    function subscribeSignal() {
        const ch = S.sb.channel('call:' + CALL_ID, { config: { broadcast: { self: false }, presence: { key: S.me.id } } });
        ch.on('broadcast', { event: 'sig' }, ({ payload }) => onSignal(payload))
          .on('presence', { event: 'sync' }, () => onPresence(ch.presenceState()))
          .subscribe((status) => {
              log('signal channel', status);
              if (status === 'SUBSCRIBED') trackPresence(true);
          });
        S.sigChannel = ch;
    }

    function trackPresence(now) {
        if (!S.sigChannel || S.ended) return;
        clearTimeout(S.timers.presence);
        const doTrack = () => {
            if (!S.sigChannel || S.ended) return;
            const r = S.sigChannel.track({
                sid: SID, name: S.me.name,
                audio: !!(S.local.mic && S.micOn), video: sendingVideo(), screen: !!S.local.screen,
            });
            if (r && r.catch) r.catch(() => {});
        };
        if (now) doTrack(); else S.timers.presence = setTimeout(doTrack, 120);
    }

    function onPresence(state) {
        if (!S.mesh || S.ended) return;
        const seen = new Set();
        Object.keys(state || {}).forEach(key => {
            const metas = state[key];
            if (!metas || !metas.length || key === S.me.id || !allowed(key)) return;
            const dev = part(key) && part(key).device_id;
            const meta = metas.find(m => m.sid === dev) || metas[metas.length - 1];
            if (!meta || !meta.sid || S.byeSids.has(meta.sid)) return;
            const row = part(key);
            if (row && row.state === 'left' && row.device_id === meta.sid) return;   // presence lags behind leaving
            seen.add(key);
            const prev = S.presence.get(key);
            S.presence.set(key, meta);
            clearTimeout(S.goneTimers.get(key));
            S.goneTimers.delete(key);
            S.mesh.addPeer({ userId: key, sid: meta.sid, name: nameOf(key) });
            if (prev && prev.screen !== meta.screen && meta.screen) toast(`${firstName(key)} is sharing their screen`);
            if (!part(key)) refreshState();
        });
        [...S.presence.keys()].forEach(key => { if (!seen.has(key)) scheduleGone(key); });
        renderTiles();
    }

    /** Presence can blip while a socket reconnects: only drop a peer whose media is gone too. */
    function scheduleGone(key) {
        if (S.goneTimers.has(key)) return;
        S.goneTimers.set(key, setTimeout(() => {
            S.goneTimers.delete(key);
            const p = part(key);
            if (S.mesh && (S.mesh.peerState(key) !== 'connected' || !p || p.state !== 'joined')) {
                S.mesh.removePeer(key, 'gone', { notify: true });
                S.presence.delete(key);
                renderTiles();
            } else scheduleGone(key);
        }, 12000));
    }

    function onBye(userId) {
        S.presence.delete(userId);
        if (isGroup() || S.ended) { renderTiles(); return; }
        // 1:1: they hung up. Wait a moment in case they are only moving to another device.
        setTimeout(() => {
            if (S.ended || (S.mesh && S.mesh.peerState(userId))) return;
            hangup('remote');
        }, 1500);
    }

    /* ----------------------------------------------------- database state */
    function subscribeDb() {
        const ch = S.sb.channel('calldb:' + CALL_ID + ':' + SID)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'call_participants', filter: 'call_id=eq.' + CALL_ID }, (p) => {
                const row = p && p.new;
                if (!row || !row.user_id || !S.call) return;
                const list = (S.call.participants || []).filter(x => x.user_id !== row.user_id);
                list.push(row);
                applyState({ ...S.call, participants: list });
                if (!S.people.has(row.user_id)) loadPeople().then(() => { renderHeader(); renderTiles(); });
            })
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'calls', filter: 'id=eq.' + CALL_ID }, (p) => {
                if (!p || !p.new || !S.call) return;
                applyState({ ...S.call, ...p.new, participants: S.call.participants });
            })
            .subscribe();
        S.dbChannel = ch;
    }

    let refreshing = null;
    function refreshState() {
        if (refreshing || S.ended) return;
        refreshing = rpc('ws_call_get', { p_call: CALL_ID })
            .then(st => { applyState(st); return loadPeople(); })
            .then(() => { renderHeader(); renderTiles(); })
            .catch(() => {})
            .finally(() => { refreshing = null; });
    }

    function applyState(c) {
        if (!c || !c.id || S.ended) return;
        const prev = S.call;
        S.call = c;
        if (c.now) S.skew = Date.parse(c.now) - Date.now();
        const mine = myPart();

        if (!S.joined) {
            if (S.phase === 'incoming' && !S.joining) {
                if (isTerminal(c.status)) { Tones.stop(); clearInterval(S.timers.poll); closeCallNotifications(); return showEnded('db'); }
                if (mine && mine.state === 'joined' && mine.device_id && mine.device_id !== SID && !WANT_ANSWER) {
                    Tones.stop(); clearInterval(S.timers.poll); closeCallNotifications();
                    return showElsewhere();
                }
                if (mine && ['declined', 'missed'].includes(mine.state)) { Tones.stop(); clearInterval(S.timers.poll); closeCallNotifications(); return finish(mine.state === 'declined' ? 'declined-here' : 'db'); }
            }
            return;
        }
        if (mine && mine.state === 'joined' && mine.device_id && mine.device_id !== SID) return finish('takeover');
        if (isTerminal(c.status)) return finish('db');
        // Someone's invitation just ran out: take the ringing notification off their devices (once per call).
        if (prev && !S.missedPushed && (c.participants || []).some(p => p.state === 'missed'
                && (prev.participants || []).some(q => q.user_id === p.user_id && (q.state === 'invited' || q.state === 'ringing')))) {
            S.missedPushed = true;
            sendPush({ action: 'call-end', call_id: CALL_ID });
        }
        if (mine && mine.state !== 'joined' && !S.leaving) rejoin();
        if (S.mesh) {
            (c.participants || []).forEach(p => {
                // The database alone never cuts working media: a missed heartbeat can mark someone
                // 'left' for a moment. A real hang-up arrives as 'bye'; a dead link stops being 'connected'.
                const st = p.user_id !== S.me.id && p.state !== 'joined' ? S.mesh.peerState(p.user_id) : null;
                if (st && st !== 'connected') {
                    S.mesh.removePeer(p.user_id, 'left', { notify: true });
                    S.presence.delete(p.user_id);
                }
            });
        }
        if (prev && prev.status === 'ringing' && c.status === 'active') closeCallNotifications();
        updateCallPhase();
        renderHeader();
        renderTiles();
    }

    function updateCallPhase() {
        if (!S.joined || S.ended || !S.call) return;
        const anyoneJoined = others().some(p => p.state === 'joined');
        const anyoneConnected = [...S.peerState.values()].some(s => s === 'connected');
        if (!anyoneJoined && !anyoneConnected && S.call.status === 'ringing') {
            if (S.phase !== 'calling') {
                setPhase('calling');
                if (isCaller()) Tones.ringback();
            }
            panel({
                avatarId: titleAvatarId(), avatarGroup: isGroup() ? callTitle() : null,
                title: callTitle(), sub: ringingText(), focus: false,
                foot: isGroup() ? `${others().filter(p => p.state === 'invited' || p.state === 'ringing').length} people are being called` : '',
            });
            scheduleSettle();
        } else if (S.phase !== 'incall') {
            Tones.stop();
            setPhase('incall');
            closeCallNotifications();
        }
        updateClock();
    }

    /** The caller's device asks the server to settle the call right after the ring window closes. */
    function scheduleSettle() {
        if (S.timers.settle || !S.call) return;
        const age = serverNow() - Date.parse(S.call.created_at);
        S.timers.settle = setTimeout(() => { S.timers.settle = null; heartbeat(); }, Math.max(1000, RING_SECONDS * 1000 + 1500 - age));
    }

    function startHeartbeat() {
        clearInterval(S.timers.heartbeat);
        S.timers.heartbeat = setInterval(heartbeat, HEARTBEAT_MS);
    }
    async function heartbeat() {
        if (!S.joined || S.ended) return;
        try {
            const st = await rpc('ws_call_action', { p_call: CALL_ID, p_action: 'heartbeat', p_device: SID });
            if (S.heartbeatFails >= 3) toast('Back online');
            S.heartbeatFails = 0;
            applyState(st);
        } catch (e) {
            if (/ended|not found/i.test(e.message || '')) return finish('db');
            if (++S.heartbeatFails === 3) toast('Can’t reach WorkSuite — the call continues while your network allows', 5000);
        }
    }
    function startClock() {
        clearInterval(S.timers.clock);
        S.timers.clock = setInterval(updateClock, 1000);
    }

    /* ---------------------------------------------------------- hang up */
    async function hangup(why) {
        if (S.ended || S.leaving) return;
        S.leaving = true;
        const ringing = S.call && S.call.status === 'ringing' && !others().some(p => p.state === 'joined');
        if (ringing && isCaller()) S.cancelled = true;
        try { if (S.mesh) S.mesh.close(); } catch (e) { /* closing anyway */ }
        try {
            const st = await withTimeout(rpc('ws_call_action', { p_call: CALL_ID, p_action: 'leave', p_device: SID }), 4000);
            if (st && st.id) S.call = st;
        } catch (e) { log('leave', e && e.message); leaveBeacon(); }
        finish(why === 'remote' ? 'db' : 'hangup');
    }

    function leaveBeacon() {
        if (!S.cfg || !token()) return;
        try {
            fetch(S.cfg.supabaseUrl + '/rest/v1/rpc/ws_call_action', {
                method: 'POST', keepalive: true,
                headers: { apikey: S.cfg.supabaseAnonKey, Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ p_call: CALL_ID, p_action: 'leave', p_device: SID }),
            }).catch(() => {});
        } catch (e) { /* page is going away */ }
        // The push endpoint leaves for us as well and only then clears ringing notifications, so it
        // cannot race the request above.
        try {
            fetch('/api/push', {
                method: 'POST', keepalive: true,
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
                body: JSON.stringify({ action: 'call-end', call_id: CALL_ID, leave: true, device: SID }),
            }).catch(() => {});
        } catch (e) { /* page is going away */ }
    }

    function finish(reason) {
        if (S.ended) return;
        S.ended = true;
        Object.keys(S.timers).forEach(k => { clearInterval(S.timers[k]); clearTimeout(S.timers[k]); S.timers[k] = null; });
        S.goneTimers.forEach(t => clearTimeout(t));
        S.goneTimers.clear();
        Tones.stop();
        if (S.mesh) { try { S.mesh.close({ bye: reason !== 'takeover' }); } catch (e) { /* closed */ } }
        stopLocalTracks();
        S.audios.forEach(a => { try { a.srcObject = null; a.remove(); } catch (e) { /* gone */ } });
        S.audios.clear();
        S.tiles.forEach(t => { try { t.video.srcObject = null; } catch (e) { /* gone */ } });
        const sv = $('self-video'); if (sv) sv.srcObject = null;
        [S.sigChannel, S.dbChannel].forEach(ch => { if (ch) { try { S.sb.removeChannel(ch); } catch (e) { /* closed */ } } });
        S.sigChannel = S.dbChannel = null;
        closeCallNotifications();
        // Take any "Incoming call" notification off everyone's devices. The server works out who
        // still has one (people who never answered); everyone else gets a silent close.
        const c = S.call;
        if (c && isTerminal(c.status) && !S.callEndPushed) {
            S.callEndPushed = true;
            sendPush({ action: 'call-end', call_id: CALL_ID });
        }
        showEnded(reason);
    }

    /* ------------------------------------------------------------- ended */
    function endedCopy(reason) {
        const c = S.call || {};
        const caller = isCaller();
        const who = callTitle();
        const mine = myPart();
        const live = !!c.status && !isTerminal(c.status);
        if (reason === 'takeover') return { title: 'Call moved', sub: 'You joined this call on another device.', again: false };
        if (reason === 'signedout') return { title: 'Signed out', sub: 'Sign in again to make calls.', again: false };
        if (reason === 'declined-here') return { title: 'Call declined', sub: `${who} has been told you can’t talk right now.`, again: !isGroup(), rejoin: live && isGroup() };
        // Only my own time in the call counts: from when I was in it and someone had answered.
        const from = mine && mine.joined_at && c.answered_at ? Math.max(Date.parse(mine.joined_at), Date.parse(c.answered_at)) : null;
        if (from) {
            const to = mine.left_at ? Date.parse(mine.left_at) : c.ended_at ? Date.parse(c.ended_at) : serverNow();
            const dur = fmtClock(Math.max(0, to - from) / 1000);
            if (live) return { title: 'You left the call', sub: `The call is still going · you were in it for ${dur}`, rejoin: true };
            return { title: 'Call ended', sub: dur, again: true };
        }
        if (!caller) {
            if (mine && mine.state === 'declined') return { title: 'Call declined', sub: '', again: !isGroup(), rejoin: live && isGroup() };
            if (live && isGroup()) return { title: 'Group call in progress', sub: `${nameOf(c.created_by)} started it. You can still join.`, rejoin: true };
            return { title: 'Missed call', sub: `${nameOf(c.created_by)} called you.`, again: true };
        }
        if (c.status === 'declined') return { title: 'Declined', sub: `${who} can’t talk right now.`, again: true, busy: true };
        if (c.status === 'busy') return { title: 'Busy — on another call', sub: `${who} is on another call. Try again in a little while.`, again: true, busy: true };
        if (c.status === 'missed') return S.cancelled ? { title: 'Call cancelled', sub: '', again: true } : { title: 'No answer', sub: `${who} didn’t pick up.`, again: true };
        if (live) return { title: 'You left the call', sub: 'The call is still going.', rejoin: true };
        return { title: 'Call ended', sub: '', again: true };
    }

    function showEnded(reason) {
        if (!S.ended) { S.ended = true; stopLocalTracks(); Tones.stop(); }
        const copy = endedCopy(reason);
        setPhase('ended');
        if (copy.busy) Tones.busy(); else if (S.joined) Tones.end();
        const hasOpener = (() => { try { return !!(window.opener && !window.opener.closed); } catch (e) { return false; } })();
        const actions = [];
        if (copy.rejoin && S.call) actions.push({ label: 'Rejoin', cls: 'primary', icon: S.call.media === 'video' ? ICON.video : ICON.phone, onClick: rejoinCall });
        else if (copy.again && S.call) actions.push({ label: 'Call again', cls: 'primary', icon: S.call.media === 'video' ? ICON.video : ICON.phone, onClick: callAgain });
        actions.push({ label: 'Back to chat', onClick: backToChat });
        panel({ avatarId: titleAvatarId(), avatarGroup: isGroup() ? callTitle() : null, title: copy.title, sub: copy.sub, actions, focus: false });
        renderHeader();
        $('tb-sub').textContent = copy.title;
        if (hasOpener) {
            // A popup the app opened closes itself; any tap keeps it open.
            let n = 8;
            const foot = $('panel-foot');
            const tick = () => {
                if (n <= 0) { clearInterval(S.timers.close); try { window.close(); } catch (e) { /* ignore */ } return; }
                foot.textContent = `This window closes in ${n} s`;
                n--;
            };
            tick();
            S.timers.close = setInterval(tick, 1000);
            const keep = () => { clearInterval(S.timers.close); foot.textContent = ''; document.removeEventListener('pointerdown', keep, true); };
            document.addEventListener('pointerdown', keep, true);
        }
    }

    async function callAgain() {
        const c = S.call;
        if (!c) return;
        clearInterval(S.timers.close);
        const targets = others().map(p => p.user_id);
        try {
            const id = await rpc('ws_call_start', c.conversation_id
                ? { p_callees: null, p_media: c.media, p_conversation: c.conversation_id }
                : { p_callees: targets.slice(0, 1), p_media: c.media, p_conversation: null });
            sendPush({ action: 'call', call_id: id });
            try { window.name = 'ws-call-' + id; } catch (e) { /* ignore */ }
            location.replace('/call/?id=' + encodeURIComponent(id) + (c.conversation_id ? '&answer=1' : '') + (RETURN_URL ? '&return=' + encodeURIComponent(RETURN_URL) : ''));
        } catch (e) {
            toast(/already in a call/i.test(e.message || '') ? 'You are already in a call' : isMissingSetup(e) ? 'Calls are not set up yet' : 'Could not start the call — try again');
        }
    }

    function rejoinCall() {
        clearInterval(S.timers.close);
        location.replace('/call/?id=' + encodeURIComponent(CALL_ID) + '&answer=1' + (RETURN_URL ? '&return=' + encodeURIComponent(RETURN_URL) : ''));
    }

    function backToChat() {
        const target = RETURN_URL || chatUrl();
        let opener = null;
        try { opener = window.opener && !window.opener.closed ? window.opener : null; } catch (e) { opener = null; }
        if (opener) {
            try { opener.focus(); } catch (e) { /* ignore */ }
            try { window.close(); } catch (e) { /* ignore */ }
            setTimeout(() => { if (!window.closed) location.href = target; }, 200);
        } else {
            location.href = target;
        }
    }

    /* ------------------------------------------------------------- errors */
    function permissionSteps() {
        const ua = navigator.userAgent;
        const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        if (/Firefox\//.test(ua)) return ['Click the crossed-out camera or microphone icon at the left of the address bar.', 'Remove "Blocked temporarily" or allow access.', 'Press Try again.'];
        if (ios) return ['Open the Settings app → Safari → Camera and Microphone, and choose Ask or Allow.', 'Come back here and press Try again.'];
        if (/Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)) return ['In the menu bar choose Safari → Settings for This Website….', 'Set Camera and Microphone to Allow.', 'Press Try again.'];
        if (/Android/.test(ua)) return ['Tap the icon at the left of the address bar → Permissions.', 'Allow Microphone (and Camera).', 'Press Try again.'];
        return ['Click the camera or settings icon at the left of the address bar.', 'Allow Microphone (and Camera) for this site.', 'Press Try again.'];
    }

    function fail(kind, err) {
        log('fail', kind, err);
        Tones.stop();
        clearInterval(S.timers.poll);
        const pendingCallee = () => { const m = myPart(); return m && (m.state === 'invited' || m.state === 'ringing'); };
        const retry = { label: 'Try again', cls: 'primary', onClick: () => { if (S.callerGaveUp) return callAgain(); S.ended = false; route(); } };
        const back = { label: 'Back to chat', onClick: backToChat };
        let o;
        if (kind === 'notfound') o = { title: 'Call not found', sub: 'This call link has expired, or it is not a call you are part of.', actions: [back] };
        else if (kind === 'signedout') o = { title: 'Sign in to join the call', sub: 'Your WorkSuite session has ended.', actions: [{ label: 'Sign in', cls: 'primary', onClick: () => { location.href = '/'; } }] };
        else if (kind === 'setup') o = { title: 'Calls are not set up yet', sub: 'Ask your WorkSuite admin to run supabase-messenger-calls-migration.sql.', actions: [back] };
        else if (kind === 'offline') o = { title: 'Can’t reach WorkSuite', sub: 'Check your internet connection and try again.', actions: [{ label: 'Try again', cls: 'primary', onClick: () => location.reload() }, back] };
        else if (kind === 'media') {
            const name = err && err.name;
            const firstAct = pendingCallee() ? [{ label: 'Decline', cls: 'decline', onClick: decline }] : [back];
            if (name === 'NotAllowedError' || name === 'SecurityError') {
                o = { title: 'Microphone blocked', sub: 'WorkSuite needs your microphone for calls.', help: { lead: 'To allow it:', steps: permissionSteps() }, actions: [...firstAct, retry] };
            } else if (name === 'NotSupportedError') {
                o = { title: 'Calls need a secure connection', sub: 'Open WorkSuite over https to make calls.', actions: [back] };
            } else {
                o = { title: 'Couldn’t start your microphone', sub: (err && err.message) || 'Another app may be using it. Close it and try again.', actions: [...firstAct, retry] };
            }
        } else if (kind === 'join') o = { title: 'Couldn’t join the call', sub: (err && err.message) || 'Please try again.', actions: [retry, back] };
        else o = { title: 'Something went wrong', sub: (err && err.message) || 'Please try again.', actions: [{ label: 'Try again', cls: 'primary', onClick: () => location.reload() }, back] };
        setPhase('error');
        panel({ avatarId: S.call ? titleAvatarId() : null, avatarGroup: S.call && isGroup() ? callTitle() : null, avatar: S.call ? undefined : false, ...o });
        $('tb-sub').textContent = o.title;
        postState();
    }

    /* -------------------------------------------------------- full screen */
    const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
    const fsSupported = () => !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
    function exitFullscreen() {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (!fsElement() || !exit) return;
        try { const p = exit.call(document); if (p && p.catch) p.catch(() => {}); } catch (e) { /* already left */ }
    }
    /** Full screen for one tile (a shared screen) or, without one, the whole call window. */
    function toggleFullscreen(el) {
        if (fsElement()) return exitFullscreen();
        el = el || document.documentElement;
        const req = el.requestFullscreen || el.webkitRequestFullscreen;
        if (req) {
            try { const p = req.call(el); if (p && p.catch) p.catch(() => toast('Full screen is not available here')); } catch (e) { toast('Full screen is not available here'); }
            return;
        }
        // iPhone: only a video element can go full screen.
        const v = el.querySelector && el.querySelector('video');
        if (v && v.webkitEnterFullscreen) { try { v.webkitEnterFullscreen(); } catch (e) { toast('Full screen is not available here'); } }
        else toast('Full screen is not available here');
    }
    // A shared screen is shown whole by default; Fill trades the edges for no black bars.
    let screenFill = (() => { try { return localStorage.getItem('ws-call-screen-fill') === '1'; } catch (e) { return false; } })();
    function paintTileTools(t) {
        const shared = t.el.classList.contains('screen');
        t.el.classList.toggle('fill', shared && screenFill);
        const fit = t.tools.querySelector('[data-fit]');
        fit.querySelector('span').textContent = screenFill ? 'Fit' : 'Fill';
        fit.title = screenFill ? 'Show the whole screen' : 'Fill the space (the edges may be cut off)';
        fit.setAttribute('aria-pressed', String(screenFill));
        const isFull = fsElement() === t.el;
        const full = t.tools.querySelector('[data-full]');
        full.querySelector('span').textContent = isFull ? 'Exit full screen' : 'Full screen';
        full.title = isFull ? 'Exit full screen (Esc)' : 'Show the shared screen full screen';
    }

    /* -------------------------------------------------------------- tiles */
    function ensureTile(uid) {
        let t = S.tiles.get(uid);
        if (t) return t;
        const el = document.createElement('div');
        el.className = 'tile';
        const video = document.createElement('video');
        video.autoplay = true; video.playsInline = true; video.muted = true;
        video.setAttribute('playsinline', '');
        const avatar = document.createElement('div');
        avatar.className = 'tile-avatar';
        const label = document.createElement('div');
        label.className = 'tile-label';
        const mic = document.createElement('span');
        mic.className = 'mic-off';
        mic.hidden = true;
        mic.setAttribute('aria-label', 'Microphone off');
        mic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 11a7 7 0 0 1-1.2 3.9M15 9.3V5a3 3 0 0 0-5.8-1M9 9v2a3 3 0 0 0 5.1 2.1M12 18v4M8 22h8M5 11a7 7 0 0 0 11 5.7M3 3l18 18"/></svg>';
        const nm = document.createElement('span');
        label.append(mic, nm);
        const quality = document.createElement('span');
        quality.className = 'quality';
        quality.hidden = true;
        quality.innerHTML = '<i></i><i></i><i></i>';
        const status = document.createElement('div');
        status.className = 'tile-status';
        status.hidden = true;
        // Shown on a shared screen only (CSS): fit or fill, and its own full screen.
        const tools = document.createElement('div');
        tools.className = 'tile-tools';
        tools.innerHTML = '<button type="button" data-fit aria-pressed="false"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 9h8v6H8z"/></svg><span>Fill</span></button>'
            + '<button type="button" data-full><svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg><span>Full screen</span></button>';
        tools.addEventListener('click', (e) => {
            const b = e.target.closest('button');
            if (!b) return;
            e.stopPropagation();
            if (b.hasAttribute('data-full')) return toggleFullscreen(el);
            screenFill = !screenFill;
            try { localStorage.setItem('ws-call-screen-fill', screenFill ? '1' : '0'); } catch (x) { /* private mode */ }
            S.tiles.forEach(paintTileTools);
        });
        el.addEventListener('dblclick', () => { if (el.classList.contains('screen')) toggleFullscreen(el); });
        el.append(video, avatar, label, quality, status, tools);
        t = { el, video, avatar, mic, nm, quality, status, tools };
        S.tiles.set(uid, t);
        fillAvatar(avatar, uid);
        return t;
    }

    function remoteIds() {
        const ids = new Set();
        S.peerState.forEach((_, uid) => ids.add(uid));
        S.presence.forEach((_, uid) => ids.add(uid));
        others().forEach(p => { if (p.state === 'joined') ids.add(p.user_id); });
        ids.delete(S.me.id);
        return [...ids].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    }

    function updateTile(uid) {
        const t = S.tiles.get(uid);
        if (!t) return;
        const stream = S.streams.get(uid);
        const meta = S.presence.get(uid);
        if (stream && t.video.srcObject !== stream) { t.video.srcObject = stream; t.video.play().catch(() => {}); }
        const vt = stream && stream.getVideoTracks()[0];
        const videoFlowing = !!(vt && vt.readyState === 'live' && !vt.muted);
        const wantsVideo = meta ? !!(meta.video || meta.screen) : true;
        t.el.classList.toggle('has-video', videoFlowing && wantsVideo);
        t.el.classList.toggle('screen', !!(meta && meta.screen));
        paintTileTools(t);
        t.mic.hidden = !(meta && meta.audio === false);
        const nm = nameOf(uid);
        if (t.nm.textContent !== nm) { t.nm.textContent = nm; fillAvatar(t.avatar, uid); }
        const st = S.peerState.get(uid);
        const label = !st ? 'Connecting…' : st === 'connecting' ? 'Connecting…' : st === 'reconnecting' ? 'Reconnecting…' : st === 'failed' ? 'Connection lost — retrying…' : '';
        t.status.hidden = !label;
        t.status.textContent = label;
        updateQuality(uid);
    }

    function updateQuality(uid) {
        const t = S.tiles.get(uid);
        const st = S.stats.get(uid);
        const q = st && S.peerState.get(uid) === 'connected' ? st.quality : null;
        if (t) {
            t.quality.hidden = !q || q === 'good';           // only worth showing when it is not fine
            t.quality.className = 'quality ' + (q || '');
            t.quality.title = st ? `${q} connection${st.rtt != null ? ` · ${st.rtt} ms` : ''}${st.loss ? ` · ${st.loss}% loss` : ''}${st.relay ? ' · via relay' : ''}` : '';
        }
        // The top bar shows the worst link in a 1:1.
        if (!isGroup()) {
            const tb = $('tb-quality');
            tb.hidden = !q;
            tb.className = 'quality ' + (q || '');
            tb.querySelector('em').textContent = q === 'poor' ? 'Poor connection' : q === 'fair' ? 'Fair' : '';
            tb.title = t ? t.quality.title : '';
        }
    }

    function renderSelf() {
        const self = $('self-tile');
        const v = $('self-video');
        const track = S.local.screen || S.local.cam;
        const stream = track ? new MediaStream([track]) : null;
        if (!track) v.srcObject = null;
        else if (!v.srcObject || v.srcObject.getVideoTracks()[0] !== track) { v.srcObject = stream; v.play().catch(() => {}); }
        self.classList.toggle('has-video', !!track);
        self.classList.toggle('screen', !!S.local.screen);
        let mirror = false;
        if (S.local.cam && !S.local.screen) {
            let facing = null;
            try { facing = S.local.cam.getSettings().facingMode; } catch (e) { /* not supported */ }
            mirror = !facing || facing === 'user';
        }
        self.classList.toggle('mirror', mirror);
        self.querySelector('.mic-off').hidden = !!(S.local.mic && S.micOn);
        fillAvatar($('self-avatar'), S.me.id, S.me.name);
        document.body.classList.toggle('has-self-video', !!track);
    }

    function renderTiles() {
        const box = $('tiles');
        const self = $('self-tile');
        if (!box) return;
        const inCall = S.phase === 'incall';
        const calling = S.phase === 'calling';
        self.hidden = !(inCall || calling);
        if (!inCall && !calling) return;
        const ids = inCall ? remoteIds() : [];
        ids.forEach(uid => { ensureTile(uid); updateTile(uid); });
        // Tiles for people no longer here.
        [...S.tiles.keys()].forEach(uid => { if (!ids.includes(uid)) { const t = S.tiles.get(uid); t.video.srcObject = null; t.el.remove(); S.tiles.delete(uid); } });

        // While a shared screen is full screen, leave the layout alone: moving
        // that tile in the page would drop it out of full screen.
        const fs = fsElement();
        if (fs && fs.classList && fs.classList.contains('tile')) {
            if (fs.classList.contains('screen') && [...S.tiles.values()].some(t => t.el === fs)) { renderSelf(); return; }
            exitFullscreen();
        }

        const presenter = ids.find(uid => { const m = S.presence.get(uid); return m && m.screen; });
        box.className = 'tiles';
        box.textContent = '';
        self.classList.remove('pip');
        self.style.left = self.style.top = self.style.right = self.style.bottom = '';

        if (!ids.length) {
            box.style.setProperty('--cols', 1);
            box.appendChild(self);
        } else if (presenter) {
            box.classList.add('presenting');
            const main = S.tiles.get(presenter).el;
            main.classList.add('presenter');
            box.appendChild(main);
            const rest = ids.filter(u => u !== presenter);
            if (!rest.length) {
                // 1:1 — the shared screen takes the whole stage; you float in a corner.
                box.classList.add('solo');
                self.classList.add('pip');
                document.body.appendChild(self);
                placePip();
            } else {
                const strip = document.createElement('div');
                strip.className = 'strip';
                rest.forEach(u => { const el = S.tiles.get(u).el; el.classList.remove('presenter'); strip.appendChild(el); });
                strip.appendChild(self);
                box.appendChild(strip);
            }
        } else if (ids.length === 1) {
            box.classList.add('solo');
            box.style.setProperty('--cols', 1);
            const el = S.tiles.get(ids[0]).el;
            el.classList.remove('presenter');
            box.appendChild(el);
            self.classList.add('pip');
            document.body.appendChild(self);
            placePip();
        } else {
            const n = ids.length + 1;
            const narrow = window.innerWidth < 640;
            const cols = narrow ? (n <= 2 ? 1 : 2) : n <= 1 ? 1 : n <= 4 ? 2 : n <= 6 ? 3 : 4;
            box.style.setProperty('--cols', cols);
            ids.forEach(u => { const el = S.tiles.get(u).el; el.classList.remove('presenter'); box.appendChild(el); });
            box.appendChild(self);
        }
        renderSelf();
    }

    // The self view in a 1:1 can be dragged to any corner.
    function placePip() {
        const self = $('self-tile');
        if (!self.classList.contains('pip')) return;
        const m = 16, ctl = $('controls').hidden ? 0 : $('controls').offsetHeight;
        const top = S.pipCorner[0] === 't', left = S.pipCorner[1] === 'l';
        self.style.left = left ? m + 'px' : '';
        self.style.right = left ? '' : m + 'px';
        self.style.top = top ? '72px' : '';
        self.style.bottom = top ? '' : (ctl + 14) + 'px';
    }
    function wirePipDrag() {
        const self = $('self-tile');
        let start = null;
        self.addEventListener('pointerdown', (e) => {
            if (!self.classList.contains('pip')) return;
            const r = self.getBoundingClientRect();
            start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false };
            try { self.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
        });
        self.addEventListener('pointermove', (e) => {
            if (!start) return;
            const dx = e.clientX - start.x, dy = e.clientY - start.y;
            if (!start.moved && Math.hypot(dx, dy) < 6) return;
            start.moved = true;
            self.classList.add('dragging');
            self.style.right = self.style.bottom = '';
            self.style.left = (start.left + dx) + 'px';
            self.style.top = (start.top + dy) + 'px';
        });
        const end = () => {
            if (!start) return;
            const moved = start.moved;
            start = null;
            self.classList.remove('dragging');
            if (!moved) return;
            const r = self.getBoundingClientRect();
            S.pipCorner = (r.top + r.height / 2 < window.innerHeight / 2 ? 't' : 'b') + (r.left + r.width / 2 < window.innerWidth / 2 ? 'l' : 'r');
            placePip();
        };
        self.addEventListener('pointerup', end);
        self.addEventListener('pointercancel', end);
        window.addEventListener('resize', () => { placePip(); if (S.phase === 'incall') renderTiles(); });
    }

    /* -------------------------------------------------------------- audio */
    function attachAudio(uid, stream) {
        let a = S.audios.get(uid);
        if (!a) {
            a = document.createElement('audio');
            a.autoplay = true;
            $('audios').appendChild(a);
            S.audios.set(uid, a);
            const sink = loadPrefs().speaker;
            if (sink && a.setSinkId) a.setSinkId(sink).catch(() => {});
        }
        if (a.srcObject !== stream) a.srcObject = stream;
        const p = a.play();
        if (p && p.catch) p.catch(() => { $('unlock').hidden = false; });
    }
    function detachAudio(uid) {
        const a = S.audios.get(uid);
        if (!a) return;
        a.srcObject = null;
        a.remove();
        S.audios.delete(uid);
    }

    /* ----------------------------------------------------------- controls */
    function updateButtons() {
        const mic = $('btn-mic');
        const micOff = !(S.local.mic && S.micOn);
        mic.classList.toggle('is-off', micOff);
        mic.setAttribute('aria-pressed', String(micOff));
        mic.querySelector('span').textContent = S.noMic ? 'No mic' : micOff ? 'Unmute' : 'Mute';
        mic.title = S.noMic ? 'No microphone — click to try again' : micOff ? 'Unmute (M)' : 'Mute (M)';
        const cam = $('btn-cam');
        cam.classList.toggle('is-off', !S.local.cam);
        cam.setAttribute('aria-pressed', String(!!S.local.cam));
        cam.querySelector('span').textContent = S.local.cam ? 'Camera' : 'Camera off';
        cam.title = S.local.cam ? 'Turn camera off (V)' : 'Turn camera on (V)';
        cam.disabled = S.camBusy;
        const share = $('btn-share');
        share.hidden = !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) || window.innerWidth < 600 && /Android|iPhone|iPad/.test(navigator.userAgent);
        share.classList.toggle('active', !!S.local.screen);
        share.setAttribute('aria-pressed', String(!!S.local.screen));
        share.querySelector('span').textContent = S.local.screen ? 'Stop' : 'Share';
        const full = $('btn-full');
        const isFull = !!fsElement();
        full.hidden = !fsSupported();
        full.classList.toggle('is-full', isFull);
        full.setAttribute('aria-pressed', String(isFull));
        full.querySelector('span').textContent = isFull ? 'Exit' : 'Expand';
        full.title = isFull ? 'Exit full screen (F)' : 'Full screen (F)';
    }

    async function toggleMic() {
        if (!S.local.mic) {
            try { await switchMic(null); toast('Microphone on'); } catch (e) { toast(e.name === 'NotAllowedError' ? 'Microphone blocked by the browser' : 'Still no microphone'); }
            return;
        }
        S.micOn = !S.micOn;
        S.local.mic.enabled = S.micOn;
        updateButtons(); renderSelf(); trackPresence();
    }

    async function toggleCam() {
        if (S.camBusy) return;
        S.camBusy = true; updateButtons();
        try {
            if (S.local.cam) {
                const t = S.local.cam;
                S.local.cam = null;
                if (!S.local.screen) await setVideoTrack(null);
                t.stop();                                   // the camera light goes off
            } else {
                const t = (await gumPreferring('video', loadPrefs().cam)).getVideoTracks()[0];
                watchCam(t);
                S.local.cam = t;
                if (!S.local.screen) await setVideoTrack(t);
                refreshDevices();
            }
        } catch (e) {
            toast(e.name === 'NotAllowedError' ? 'Camera blocked — allow it in the address bar' : 'Could not start the camera');
        } finally {
            S.camBusy = false;
            renderSelf(); updateButtons(); trackPresence();
        }
    }

    async function switchCamera(deviceId) {
        const old = S.local.cam;
        if (old) old.stop();                               // phones cannot open two cameras at once
        const t = (await gum({ video: videoConstraints(deviceId) })).getVideoTracks()[0];
        watchCam(t);
        S.local.cam = t;
        if (!S.local.screen) await setVideoTrack(t);
        savePref('cam', deviceId);
        renderSelf(); updateButtons();
    }

    async function flipCamera() {
        const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
        if (cams.length < 2) return;
        let current = null;
        try { current = S.local.cam && S.local.cam.getSettings().deviceId; } catch (e) { /* ignore */ }
        const i = cams.findIndex(c => c.deviceId === current);
        const next = cams[(i + 1) % cams.length];
        if (!S.local.cam) { savePref('cam', next.deviceId); toast('Camera switched — turn it on to use it'); return; }
        try { await switchCamera(next.deviceId); } catch (e) { toast('Could not switch camera'); }
    }

    async function switchMic(deviceId) {
        const t = (await gum({ audio: audioConstraints(deviceId) })).getAudioTracks()[0];
        const old = S.local.mic;
        t.enabled = S.noMic ? true : S.micOn;
        if (S.noMic) S.micOn = true;
        S.noMic = false;
        S.local.mic = t;
        watchMic(t);
        await setAudioTrack(t);
        if (old && old !== t) old.stop();
        if (deviceId) savePref('mic', deviceId);
        refreshDevices(); updateButtons(); renderSelf(); trackPresence();
    }

    async function toggleShare() {
        if (S.local.screen) return stopShare();
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return;
        try {
            const ds = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
            const t = ds.getVideoTracks()[0];
            try { t.contentHint = 'detail'; } catch (e) { /* older browsers */ }
            S.local.screen = t;
            t.addEventListener('ended', () => { if (S.local.screen === t) stopShare(); });
            await setVideoTrack(t);
            toast('You are sharing your screen');
        } catch (e) {
            if (e && e.name !== 'NotAllowedError' && e.name !== 'AbortError') toast('Could not share your screen');
        }
        renderSelf(); updateButtons(); trackPresence();
    }
    async function stopShare() {
        const t = S.local.screen;
        S.local.screen = null;
        await setVideoTrack(S.local.cam || null);
        if (t) t.stop();
        renderSelf(); updateButtons(); trackPresence();
    }

    /* ------------------------------------------------------------ devices */
    async function refreshDevices() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
        let list = [];
        try { list = await navigator.mediaDevices.enumerateDevices(); } catch (e) { return; }
        const mics = list.filter(d => d.kind === 'audioinput');
        const cams = list.filter(d => d.kind === 'videoinput');
        const spks = list.filter(d => d.kind === 'audiooutput');
        $('btn-flip').hidden = cams.length < 2;
        const cur = (t) => { try { return t && t.getSettings().deviceId; } catch (e) { return null; } };
        fillSelect($('dev-mic'), mics, cur(S.local.mic) || loadPrefs().mic, 'Microphone');
        fillSelect($('dev-cam'), cams, cur(S.local.cam) || loadPrefs().cam, 'Camera');
        const canSink = 'setSinkId' in HTMLMediaElement.prototype;
        $('dev-speaker-row').hidden = !canSink || !spks.length;
        if (canSink) fillSelect($('dev-speaker'), spks, loadPrefs().speaker || 'default', 'Speaker');
        $('dev-note').textContent = canSink ? '' : 'This browser plays calls through its default speaker.';
    }
    /** "Devices & connection": is a relay configured, and how is each person reached. */
    function renderConnection() {
        const relay = $('conn-relay');
        const info = S.iceInfo;
        relay.classList.remove('relay');
        if (!info) relay.textContent = S.joined ? 'Relay server: checking…' : 'Relay server: checked when you join';
        else if (!info.reachable) relay.textContent = 'Relay server: unknown (WorkSuite could not be reached) — using direct connections only';
        else if (info.relay) relay.textContent = `Relay server: configured${info.provider ? ` (${info.provider})` : ''}`;
        else { relay.textContent = 'Relay server: not configured — calls through strict office firewalls may fail'; relay.classList.add('relay'); }
        const ul = $('conn-peers');
        ul.textContent = '';
        const ids = remoteIds();
        if (!ids.length) {
            const li = document.createElement('li');
            li.innerHTML = '<span></span><span></span>';
            li.firstChild.textContent = S.joined ? 'Nobody else is connected yet' : 'Not in the call';
            ul.appendChild(li);
            return;
        }
        ids.forEach(uid => {
            const st = S.stats.get(uid), state = S.peerState.get(uid);
            const li = document.createElement('li');
            const a = document.createElement('span'), b = document.createElement('span');
            a.textContent = nameOf(uid);
            if (state !== 'connected' || !st) b.textContent = state === 'reconnecting' ? 'reconnecting…' : state === 'failed' ? 'connection lost' : 'connecting…';
            else {
                b.textContent = `${st.relay ? 'via relay' : 'direct'}${st.rtt != null ? ` · ${st.rtt} ms` : ''} · ${st.loss || 0}% loss`;
                if (st.relay) b.classList.add('relay');
            }
            li.append(a, b);
            ul.appendChild(li);
        });
    }

    function fillSelect(sel, devices, current, label) {
        sel.textContent = '';
        if (!devices.length) { const o = document.createElement('option'); o.textContent = `No ${label.toLowerCase()} found`; o.value = ''; sel.appendChild(o); sel.disabled = true; return; }
        sel.disabled = false;
        devices.forEach((d, i) => {
            const o = document.createElement('option');
            o.value = d.deviceId;
            o.textContent = d.label || `${label} ${i + 1}`;
            if (d.deviceId === current) o.selected = true;
            sel.appendChild(o);
        });
    }

    function wireControls() {
        $('btn-mic').addEventListener('click', toggleMic);
        $('btn-cam').addEventListener('click', toggleCam);
        $('btn-flip').addEventListener('click', flipCamera);
        $('btn-share').addEventListener('click', toggleShare);
        $('btn-full').addEventListener('click', () => toggleFullscreen());
        const onFullscreen = () => { updateButtons(); S.tiles.forEach(paintTileTools); if (!fsElement() && S.phase === 'incall') renderTiles(); };
        document.addEventListener('fullscreenchange', onFullscreen);
        document.addEventListener('webkitfullscreenchange', onFullscreen);
        $('btn-hangup').addEventListener('click', () => { if (S.joined) hangup(); else if (S.phase === 'incoming') decline(); else backToChat(); });
        $('btn-devices').addEventListener('click', () => { refreshDevices(); renderConnection(); $('devices').hidden = false; setTimeout(() => $('dev-mic').focus(), 20); });
        $('devices-close').addEventListener('click', () => { $('devices').hidden = true; $('btn-devices').focus(); });
        $('devices').addEventListener('click', (e) => { if (e.target === $('devices')) $('devices').hidden = true; });
        $('dev-mic').addEventListener('change', (e) => { if (e.target.value) switchMic(e.target.value).catch(() => toast('Could not switch microphone')); });
        $('dev-cam').addEventListener('change', (e) => {
            if (!e.target.value) return;
            if (S.local.cam) switchCamera(e.target.value).catch(() => toast('Could not switch camera'));
            else { savePref('cam', e.target.value); toast('Camera chosen — turn it on to use it'); }
        });
        $('dev-speaker').addEventListener('change', (e) => {
            const id = e.target.value;
            savePref('speaker', id);
            S.audios.forEach(a => { if (a.setSinkId) a.setSinkId(id).catch(() => toast('Could not switch speaker')); });
        });
        $('unlock').addEventListener('click', () => {
            $('unlock').hidden = true;
            Tones.resume();
            S.audios.forEach(a => { const p = a.play(); if (p && p.catch) p.catch(() => { $('unlock').hidden = false; }); });
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !$('devices').hidden) { $('devices').hidden = true; return; }
            if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
            if (e.metaKey || e.ctrlKey || e.altKey || !S.joined || S.ended) return;
            if (e.key === 'm' || e.key === 'M') { e.preventDefault(); toggleMic(); }
            else if (e.key === 'v' || e.key === 'V') { e.preventDefault(); toggleCam(); }
            else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFullscreen(); }
        });
        // Any tap wakes audio the browser held back.
        document.addEventListener('pointerdown', () => Tones.resume(), { once: true, capture: true });
        if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
        wirePipDrag();
    }

    /* ----------------------------------------------- other WorkSuite tabs */
    function setupBroadcast() {
        if (!('BroadcastChannel' in window)) return;
        try { S.bc = new BroadcastChannel('ws-calls'); } catch (e) { return; }
        S.bc.onmessage = (e) => {
            const m = e.data || {};
            if (m.callId !== CALL_ID) return;
            if (m.type === 'call-focus') { try { window.focus(); } catch (x) { /* ignore */ } }
            else if (m.type === 'call-hangup') { if (S.joined) hangup(); else if (S.phase === 'incoming') decline(); }
        };
        S.timers.bcPost = setInterval(postState, 5000);
    }
    function postState() {
        if (!S.bc || !CALL_ID) return;
        if (S.phase === 'preparing' && !S.joining) return;           // still loading: nothing to say yet
        // 'incoming' (Accept/Decline, Join, "on another device") is not a call in progress: other
        // tabs keep ringing and do not show "Return to call".
        const map = { preparing: 'starting', incoming: 'incoming', calling: 'ringing', incall: 'active', ended: 'ended', error: 'ended' };
        try { S.bc.postMessage({ type: 'call-state', callId: CALL_ID, state: map[S.phase] || 'starting' }); } catch (e) { /* closed */ }
    }

    window.addEventListener('pagehide', () => {
        if (S.joined && !S.ended) {
            try { if (S.mesh) S.mesh.close(); } catch (e) { /* going */ }
            leaveBeacon();
        }
        if (S.bc) { try { S.bc.postMessage({ type: 'call-state', callId: CALL_ID, state: 'ended' }); } catch (e) { /* closed */ } }
        Tones.close();
    });
    // In the same tab (phones) the back button would drop the call without asking.
    window.addEventListener('beforeunload', (e) => {
        let hasOpener = false;
        try { hasOpener = !!window.opener; } catch (x) { /* ignore */ }
        if (S.joined && !S.ended && !hasOpener && S.phase === 'incall') { e.preventDefault(); e.returnValue = ''; }
    });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
