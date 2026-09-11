/* ============================================================================
   Calendar — in the Bitrix24 layout: Day / Week / Month / Schedule over one
   merged list of calendar events (mine and the company's), task due dates,
   project deadlines, company holidays, approved leave and lead follow-ups.
   A side panel holds a month picker, the calendars to show and .ics export
   and import. Events can be dragged to another time or day, and resized, in
   Day and Week (to another day in Month); dragging across empty hours
   creates an event for that span. Invitations waiting for an answer are
   counted in the toolbar and can be answered from the Schedule view.
   Every wall-clock value is shown in IST through WSCrmLogic.

   URLs: /calendar/?view=day|week|month|schedule&date=YYYY-MM-DD   (view=agenda still works)
         /calendar/?id=<event uuid>   opens the event on top of the calendar
         /calendar/?new=1             opens the create dialog
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc, h = C.h, B = window.WSB24, ICS = window.WSIcs;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'calendar', crumb: 'Calendar' });
    const sb = ctx.sb, me = ctx.user;

    const VIEWS = ['day', 'week', 'month', 'schedule'];
    const VIEW_LABEL = { day: 'Day', week: 'Week', month: 'Month', schedule: 'Schedule' };
    const HOUR_PX = 48, WORK_FROM = 9, WORK_TO = 18;
    const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const RESPONSE = { invited: { label: 'Invited', color: 'weekoff' }, accepted: { label: 'Accepted', color: 'present' }, declined: { label: 'Declined', color: 'absent' }, tentative: { label: 'Tentative', color: 'late' } };
    const CALS = {
        mine: { label: 'My calendar', color: '#2fc6f6' },
        company: { label: 'Company calendar', color: '#9dcf00' },
        tasks: { label: 'Task deadlines', color: '#ffa900' },
        projects: { label: 'Project deadlines', color: '#9b7cf5' },
        holidays: { label: 'Holidays', color: '#ff5752' },
        leave: { label: 'Leave', color: '#55d0e0' },
        followups: { label: 'Lead follow-ups', color: '#f76fa6' },
    };
    const KIND_CAL = { task: 'tasks', project: 'projects', holiday: 'holidays', leave: 'leave', followup: 'followups' };
    const EVENT_COLORS = [['#2fc6f6', 'Light blue'], ['#2067b0', 'Blue'], ['#9dcf00', 'Green'], ['#ffa900', 'Orange'], ['#ff5752', 'Red'], ['#9b7cf5', 'Purple'], ['#f76fa6', 'Pink'], ['#828b95', 'Grey']];
    const hasColor = (await B.columns('calendar_events', 'id, color', 'id')).full;     // the colour column comes with supabase-b24-migration.sql

    const pref = (k, dflt) => { try { return localStorage.getItem(k) || dflt; } catch (e) { return dflt; } };
    const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } };
    const readJson = k => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } };
    const params = new URLSearchParams(location.search);
    const urlView = params.get('view') === 'agenda' ? 'schedule' : params.get('view');
    const savedView = pref('ws-cal-view', '');
    const state = {
        view: VIEWS.includes(urlView) ? urlView : window.innerWidth < 640 ? 'schedule' : (VIEWS.includes(savedView) ? savedView : 'month'),
        date: L.dayNumber(params.get('date')) != null ? params.get('date') : L.todayIST(),
        mini: null,
        cals: Object.assign(Object.fromEntries(Object.keys(CALS).map(k => [k, true])), readJson('ws-cal-cals')),
        items: [], loading: false, eventsMissing: false, invites: 0, invitesLoaded: false,
    };
    let filter = null, reloadTimer = null, suppressClick = false, loadSeq = 0;
    const remindedIds = new Set();

    /* ------------------------------------------------------------ helpers */
    function syncUrl() {
        const u = new URL(location.href);
        u.searchParams.set('view', state.view); u.searchParams.set('date', state.date);
        history.replaceState(null, '', u.pathname + u.search);
    }
    const monthStart = d => d.slice(0, 7) + '-01';
    const weekStart = d => L.addDays(d, -(L.isoWeekday(d) - 1));
    const narrow = () => window.matchMedia('(max-width: 640px)').matches;        // phones: Week shows three days
    const weekDays = () => (narrow() ? [0, 1, 2].map(i => L.addDays(state.date, i)) : Array.from({ length: 7 }, (_, i) => L.addDays(weekStart(state.date), i)));
    function shiftMonth(d, n) { const [y, m] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10); }
    /** Visible range, inclusive dates. Month includes the leading/trailing days in the grid. */
    function visibleRange() {
        const d = state.date;
        if (state.view === 'month') { const s = weekStart(monthStart(d)); return { from: s, to: L.addDays(s, 41) }; }
        if (state.view === 'week') { const w = weekDays(); return { from: w[0], to: w[w.length - 1] }; }
        if (state.view === 'day') return { from: d, to: d };
        return { from: d, to: L.addDays(d, 29) };
    }
    /** IST minutes since midnight of an instant on a given IST day (clamped to the day). */
    function minutesOn(iso, day) {
        const dayOf = L.istDate(iso);
        if (dayOf < day) return 0;
        if (dayOf > day) return 1440;
        const [hh, mm] = L.istTime(iso).split(':').map(Number);
        return hh * 60 + mm;
    }
    const fmtHM = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const fmtMin = m => { const hh = Math.floor(m / 60) % 24, mm = m % 60; return `${hh % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''}${hh < 12 ? 'am' : 'pm'}`; };
    const myResponse = ev => { const p = (ev.participants || []).find(x => x.user_id === me.id); return p ? p.response : null; };
    const isEventMine = ev => ev.owner_id === me.id || ev.created_by === me.id || (ev.participants || []).some(p => p.user_id === me.id);
    const canEditEvent = ev => ev.owner_id === me.id || ev.created_by === me.id || ctx.isManager;
    function colorOf(it) {
        if (it.kind === 'event') return /^#[0-9a-f]{6}$/i.test(it.ev.color || '') ? it.ev.color : (isEventMine(it.ev) ? CALS.mine.color : CALS.company.color);
        return CALS[KIND_CAL[it.kind]].color;
    }
    function isPerson(it, id) {
        if (it.kind === 'event') return it.ev.owner_id === id || (it.ev.participants || []).some(p => p.user_id === id);
        if (it.kind === 'task') return it.task.assignee_id === id;
        if (it.kind === 'leave') return it.user_id === id;
        if (it.kind === 'followup') return it.lead.owner_id === id;
        return false;
    }
    function calOn(it) {
        if (it.kind === 'event') return isEventMine(it.ev) ? state.cals.mine : state.cals.company;
        return state.cals[KIND_CAL[it.kind]] !== false;
    }
    const filterState = () => (filter ? filter.get() : { search: '', values: {} });
    function visibleItems() {
        const st = filterState(), v = st.values || {}, q = String(st.search || '').toLowerCase();
        return state.items.filter(it => {
            if (!calOn(it)) return false;
            if (q && !it.title.toLowerCase().includes(q) && !(it.ev && String(it.ev.location || '').toLowerCase().includes(q))) return false;
            if (v.type && !(it.kind === 'event' && it.ev.event_type === v.type)) return false;
            if (v.person && !isPerson(it, v.person === 'me' ? me.id : v.person)) return false;
            if (v.invites && !(it.kind === 'event' && myResponse(it.ev) === 'invited' && it.ev.status !== 'cancelled')) return false;
            if (v.organiser && !(it.kind === 'event' && it.ev.owner_id === me.id)) return false;
            if (v.declined && !(it.kind === 'event' && myResponse(it.ev) === 'declined')) return false;
            if (it.kind === 'task' && it.task.completed_at && !v.completed) return false;
            return true;
        });
    }
    /** Items touching a given IST day, all-day ones first, then by start. */
    function itemsOn(day, items) {
        return items.filter(it => it.from <= day && it.to >= day)
            .sort((a, b) => (a.allDay === b.allDay ? 0 : a.allDay ? -1 : 1) || String(a.startIso || '').localeCompare(String(b.startIso || '')) || a.title.localeCompare(b.title));
    }
    function eventItem(ev) {
        const from = L.istDate(ev.starts_at), to = L.istDate(ev.ends_at), r = myResponse(ev);
        return { kind: 'event', id: ev.id, key: 'e:' + ev.id, ev, title: ev.title, from, to: to < from ? from : to, allDay: !!ev.all_day, startIso: ev.starts_at, endIso: ev.ends_at,
                 cls: (ev.status === 'cancelled' ? ' cancelled' : '') + (r === 'declined' ? ' declined' : '') + (r === 'invited' ? ' invited' : '') };
    }
    function download(name, text) {
        const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' })), a = document.createElement('a');
        a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
    }

    /* ------------------------------------------------------------- loading */
    async function load() {
        const seq = ++loadSeq;
        const range = visibleRange(), iso = L.rangeToIso(range);
        const invitesOn = !!filterState().values.invites;
        state.loading = true; renderBody();
        const items = [];
        const mine = [me.company, me.company2].filter(Boolean);
        let eventsMissing = false;
        const jobs = [
            async () => {                                                  // calendar events
                if (!state.cals.mine && !state.cals.company) return;
                const r = await sb.from('calendar_events').select('*, participants:event_participants(user_id, response)')
                    .lt('starts_at', iso.to).gte('ends_at', iso.from).order('starts_at').limit(1000);
                if (r.error) { if (C.isMissingSchema(r.error)) eventsMissing = true; else console.warn('[calendar] events', r.error); return; }
                (r.data || []).forEach(ev => items.push(eventItem(ev)));
            },
            async () => {                                                  // invitations waiting for me, whatever the dates on screen
                if (!invitesOn) return;
                const r = await sb.from('event_participants').select('response, event:calendar_events(*, participants:event_participants(user_id, response))')
                    .eq('user_id', me.id).eq('response', 'invited').limit(300);
                if (r.error) return;
                const now = Date.now();
                (r.data || []).map(x => x.event).filter(ev => ev && Date.parse(ev.ends_at) >= now).forEach(ev => items.push(eventItem(ev)));
            },
            async () => {                                                  // task due dates
                if (!state.cals.tasks) return;
                const r = await sb.from('tasks').select('id,title,due_date,due_time,status,completed_at,assignee_id').is('archived_at', null)
                    .gte('due_date', range.from).lte('due_date', range.to).limit(1000);
                if (r.error) return;
                const today = L.todayIST();
                (r.data || []).forEach(t => {
                    const timed = !!t.due_time;
                    const startIso = timed ? L.isoAtIST(t.due_date, t.due_time) : L.isoAtIST(t.due_date, '00:00');
                    items.push({ kind: 'task', id: t.id, key: 't:' + t.id, task: t, title: t.title, from: t.due_date, to: t.due_date, allDay: !timed, startIso,
                        endIso: timed ? new Date(new Date(startIso).getTime() + 30 * 60000).toISOString() : L.isoEndOfIST(t.due_date),
                        cls: (!t.completed_at && t.due_date < today ? ' overdue' : '') + (t.completed_at ? ' cancelled' : ''), href: `/tasks/?id=${t.id}` });
                });
            },
            async () => {                                                  // project deadlines
                if (!state.cals.projects) return;
                const r = await sb.from('projects').select('id,name,due_date,status').in('status', ['planning', 'active']).is('archived_at', null)
                    .gte('due_date', range.from).lte('due_date', range.to).limit(500);
                if (r.error) return;
                (r.data || []).forEach(p => items.push({ kind: 'project', id: p.id, key: 'p:' + p.id, title: `Project due: ${p.name}`, from: p.due_date, to: p.due_date, allDay: true, startIso: L.isoAtIST(p.due_date, '00:00'), cls: '', href: `/projects/?id=${p.id}` }));
            },
            async () => {                                                  // holidays
                if (!state.cals.holidays) return;
                const r = await sb.from('holidays').select('id,holiday_date,name,company,is_optional').gte('holiday_date', range.from).lte('holiday_date', range.to).limit(500);
                if (r.error) return;
                (r.data || []).filter(hd => !hd.company || !mine.length || mine.includes(hd.company)).forEach(hd =>
                    items.push({ kind: 'holiday', id: hd.id, key: 'h:' + hd.id, title: `${hd.name}${hd.is_optional ? ' (optional)' : ''}`, from: hd.holiday_date, to: hd.holiday_date, allDay: true, startIso: L.isoAtIST(hd.holiday_date, '00:00'), cls: '', off: !hd.is_optional, tip: hd.company ? hd.company : 'All companies' }));
            },
            async () => {                                                  // approved leave
                if (!state.cals.leave) return;
                const r = await sb.from('leave_requests').select('id,user_id,start_date,end_date,day_part,status').eq('status', 'approved')
                    .lte('start_date', range.to).gte('end_date', range.from).limit(500);
                if (r.error) return;
                (r.data || []).forEach(lv => items.push({ kind: 'leave', id: lv.id, key: 'l:' + lv.id, user_id: lv.user_id, title: `On leave: ${C.personName(lv.user_id)}${lv.day_part !== 'full' ? ' (half day)' : ''}`,
                    from: lv.start_date, to: lv.end_date, allDay: true, startIso: L.isoAtIST(lv.start_date, '00:00'), cls: '', tip: `${L.fmtDate(lv.start_date)} – ${L.fmtDate(lv.end_date)}` }));
            },
            async () => {                                                  // lead follow-ups
                if (!state.cals.followups) return;
                const r = await sb.from('crm_leads').select('id,name,next_follow_up_at,owner_id,status').is('archived_at', null)
                    .gte('next_follow_up_at', iso.from).lt('next_follow_up_at', iso.to).limit(500);
                if (r.error) return;
                (r.data || []).forEach(ld => {
                    const day = L.istDate(ld.next_follow_up_at);
                    items.push({ kind: 'followup', id: ld.id, key: 'f:' + ld.id, lead: ld, title: `Follow up: ${ld.name}`, from: day, to: day, allDay: false, startIso: ld.next_follow_up_at,
                        endIso: new Date(new Date(ld.next_follow_up_at).getTime() + 30 * 60000).toISOString(), cls: '', href: `/leads/?id=${ld.id}` });
                });
            },
        ];
        await Promise.all(jobs.map(j => j().catch(e => console.warn('[calendar]', e))));
        if (seq !== loadSeq) return;                                       // a newer load started meanwhile
        const seen = new Set();
        state.items = items.filter(it => (seen.has(it.key) ? false : seen.add(it.key)));
        state.eventsMissing = eventsMissing;
        state.loading = false;
        renderBody();
        checkReminders();
    }
    const reloadSoon = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => { load(); loadInvites(); }, 400); };
    async function loadInvites() {
        try {
            const r = await sb.from('event_participants').select('event_id, event:calendar_events(ends_at, status)').eq('user_id', me.id).eq('response', 'invited').limit(500);
            if (!r.error) {
                const now = Date.now();
                state.invites = (r.data || []).filter(x => x.event && x.event.status !== 'cancelled' && Date.parse(x.event.ends_at) >= now).length;
            }
        } catch (e) { /* the counter is a nicety */ }
        const n = view.querySelector('[data-inv-n]');
        if (n) { n.textContent = state.invites; n.closest('[data-invites]').classList.toggle('has', state.invites > 0); }
    }

    /* ------------------------------------------------------------ chrome */
    function titleText() {
        const d = state.date, [y, m] = d.split('-').map(Number);
        if (filterState().values.invites && state.view === 'schedule') return 'Invitations';
        if (state.view === 'month') return `${MONTHS[m - 1]} ${y}`;
        if (state.view === 'week') {
            const w = weekDays(), s = w[0], e = w[w.length - 1];
            return s.slice(0, 7) === e.slice(0, 7) ? `${Number(s.slice(8))} – ${L.fmtDate(e)}` : `${L.fmtDate(s, { short: true })} – ${L.fmtDate(e)}`;
        }
        if (state.view === 'day') return `${DAY_NAMES[L.isoWeekday(d) - 1]}, ${L.fmtDate(d)}`;
        return `${L.fmtDate(d)} – ${L.fmtDate(L.addDays(d, 29))}`;
    }
    function renderChrome() {
        document.title = 'Calendar · WorkSuite';
        view.innerHTML = B.titleBar({ title: 'Calendar', createLabel: 'Create', createMenu: true })
            + `<div class="b24-toolbar cal-toolbar">
                <button type="button" class="ws-btn sm" data-today>Today</button>
                <span class="cal-nav"><button type="button" data-step="-1" aria-label="Previous">‹</button><button type="button" data-step="1" aria-label="Next">›</button></span>
                <h2 class="cal-title" data-title></h2>
                <span class="cal-tz" title="All times are India Standard Time">IST</span>
                <span class="grow"></span>
                <button type="button" class="cal-inv" data-invites title="Invitations waiting for your answer">Invitations <b data-inv-n>0</b></button>
                <button type="button" class="ws-btn sm cal-side-btn" data-side-btn aria-expanded="false">${C.icon('filter', 'sm')}<span>Calendars</span></button>
                <div class="b24-views" role="tablist" aria-label="View">${VIEWS.map(v => `<button type="button" role="tab" data-view="${v}">${VIEW_LABEL[v]}</button>`).join('')}</div>
            </div>
            <div class="cal-layout">
                <div class="cal-panel" id="body"></div>
                <aside class="cal-side" aria-label="Calendars">
                    <div data-mini></div>
                    <div class="cal-cals"><h4>Calendars</h4>${Object.entries(CALS).map(([k, c]) => `<label class="cal-cal"><input type="checkbox" data-cal="${k}"${state.cals[k] ? ' checked' : ''}><span class="sw" style="--c:${c.color}"></span><span>${esc(c.label)}</span></label>`).join('')}</div>
                    <div class="cal-io">
                        <button type="button" class="ws-btn sm" data-export title="The events on screen, for Google Calendar, Outlook or Apple Calendar">${C.icon('download', 'sm')}<span>Export (.ics)</span></button>
                        <button type="button" class="ws-btn sm" data-import title="Add events from an .ics file">${C.icon('upload', 'sm')}<span>Import (.ics)</span></button>
                    </div>
                </aside>
            </div>`;
        filter = WSFilter.mount(view.querySelector('[data-filter]'), {
            id: 'calendar', me: me.id, defaultPreset: 'all', placeholder: 'Filter + search',
            presets: [{ key: 'all', title: 'All events', values: {} }, { key: 'invites', title: 'Invitations', values: { invites: true } },
                      { key: 'organiser', title: 'I am organising', values: { organiser: true } }, { key: 'declined', title: 'Declined', values: { declined: true } }],
            fields: [
                { key: 'type', title: 'Event type', type: 'select', options: Object.entries(L.EVENT_TYPE).map(([value, x]) => ({ value, label: x.label })), apply: b => b },
                ...(ctx.isManager ? [{ key: 'person', title: 'Person', type: 'user', options: B.peopleOptions(), none: false, apply: b => b }] : []),
                { key: 'invites', title: 'Waiting for my answer', type: 'check', apply: b => b },
                { key: 'organiser', title: 'I am the organiser', type: 'check', apply: b => b },
                { key: 'declined', title: 'I declined', type: 'check', apply: b => b },
                { key: 'completed', title: 'Show completed tasks', type: 'check', apply: b => b },
            ],
            onChange: () => {
                const inv = !!filterState().values.invites;
                view.querySelector('[data-invites]').classList.toggle('on', inv);
                if (inv && state.view !== 'schedule') { state.view = 'schedule'; syncUrl(); }
                if (inv !== state.invitesLoaded) { state.invitesLoaded = inv; load(); } else renderBody();
            },
        });
        state.invitesLoaded = !!filterState().values.invites;
        view.querySelector('[data-invites]').classList.toggle('on', state.invitesLoaded);
        const createMenu = e => C.menu(e.currentTarget, [
            { label: 'Event', icon: 'plus', onClick: () => openCreate() },
            { label: 'Task', icon: 'tasks', onClick: () => C.openTaskEditor({ defaults: { due_date: state.date }, onSaved: load }) },
            'sep',
            { label: 'Import events (.ics)', icon: 'upload', onClick: importIcs },
        ]);
        view.querySelector('[data-create]').addEventListener('click', () => openCreate());
        view.querySelector('[data-create-menu]').addEventListener('click', createMenu);
        view.querySelector('[data-today]').addEventListener('click', () => setDate(L.todayIST()));
        view.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => step(Number(b.dataset.step))));
        view.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
        view.querySelector('[data-invites]').addEventListener('click', () => {
            if (filterState().values.invites) filter.set({}, 'all');
            else filter.set({ invites: true }, 'invites');
        });
        view.querySelector('[data-side-btn]').addEventListener('click', e => {
            const open = view.querySelector('.cal-layout').classList.toggle('side-open');
            e.currentTarget.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        const side = view.querySelector('.cal-side');
        side.addEventListener('change', e => {
            const k = e.target.dataset.cal; if (!k) return;
            state.cals[k] = e.target.checked;
            setPref('ws-cal-cals', JSON.stringify(state.cals));
            load();
        });
        side.addEventListener('click', e => {
            const ms = e.target.closest('[data-mini-step]');
            if (ms) { state.mini = shiftMonth(monthStart(state.mini || state.date), Number(ms.dataset.miniStep)); return renderMini(); }
            const md = e.target.closest('[data-mini-day]');
            if (md) { state.mini = null; if (state.view === 'month' && md.dataset.miniDay.slice(0, 7) === state.date.slice(0, 7)) { state.date = md.dataset.miniDay; setView('day'); } else setDate(md.dataset.miniDay); return; }
            if (e.target.closest('[data-export]')) return exportIcs();
            if (e.target.closest('[data-import]')) return importIcs();
        });
        const body = view.querySelector('#body');
        body.addEventListener('click', onBodyClick);
        body.addEventListener('pointerdown', onPointerDown);
        body.addEventListener('keydown', e => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const t = e.target.closest('[data-item],[data-day],[data-slot]');
            if (t && t === e.target) { e.preventDefault(); onBodyClick({ target: t, preventDefault() {} }); }
        });
    }
    function step(n) {
        if (filterState().values.invites) filter.set({}, 'all');
        if (state.view === 'month') setDate(shiftMonth(state.date, n));
        else if (state.view === 'week') setDate(L.addDays(state.date, (narrow() ? 3 : 7) * n));
        else if (state.view === 'day') setDate(L.addDays(state.date, n));
        else setDate(L.addDays(state.date, 30 * n));
    }
    function setDate(d) { state.date = d; state.mini = null; syncUrl(); load(); }
    function setView(v) {
        state.view = v; setPref('ws-cal-view', v); syncUrl();
        if (v !== 'schedule' && filterState().values.invites) { filter.set({}, 'all'); return; }
        load();
    }

    /* ------------------------------------------------------------ render */
    function chip(it, o) {
        o = o || {};
        const timed = !it.allDay && !!it.startIso;
        const time = timed && !o.noTime ? `<span class="tm">${esc(L.fmtTime(it.startIso).replace(/:00/, ''))}</span>` : '';
        const drag = it.kind === 'event' && canEditEvent(it.ev) && it.ev.status !== 'cancelled';
        return `<div class="cal-ev ${timed ? 'timed' : 'bar'}${it.cls || ''}${drag ? ' can-drag' : ''}" data-kind="${it.kind}" style="--ev:${colorOf(it)}" data-item="${esc(it.key)}" role="button" tabindex="0" title="${esc(it.tip || it.title)}">${time}<span class="tt">${esc(it.title)}</span></div>`;
    }
    let lastKey = '';
    function renderBody() {
        const body = view.querySelector('#body'); if (!body) return;
        view.querySelector('[data-title]').textContent = titleText();
        view.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('on', b.dataset.view === state.view); b.setAttribute('aria-selected', b.dataset.view === state.view ? 'true' : 'false'); });
        renderMini();
        if (state.loading && !state.items.length) {
            body.innerHTML = `<div class="crm-skel-rows" style="padding:8px 4px">${[90, 70, 80, 60].map(w => `<span class="ws-skel" style="display:block;width:${w}%"></span>`).join('')}</div>`;
            return;
        }
        const items = visibleItems();
        const key = `${state.view}|${state.date}`;
        const prevScroll = body.querySelector('.cal-scroll');
        const keep = prevScroll && key === lastKey ? prevScroll.scrollTop : null;
        let html = state.eventsMissing ? C.migrationNoticeHtml() : '';
        if (state.view === 'month') html += renderMonth(items);
        else if (state.view === 'schedule') html += renderSchedule(items);
        else html += renderWeek(items, state.view === 'day' ? [state.date] : weekDays());
        body.innerHTML = html;
        const sc = body.querySelector('.cal-scroll');
        if (sc) { fitScroll(); sc.scrollTop = keep != null ? keep : 8 * HOUR_PX - 8; }
        lastKey = key;
    }
    /** Week and Day take the room left on screen, so only the hours scroll (not the page as well). */
    function fitScroll() {
        const sc = view.querySelector('.cal-scroll'); if (!sc) return;
        const scrollers = [document.scrollingElement];
        for (let p = sc.parentElement; p && p !== document.body; p = p.parentElement) { const oy = getComputedStyle(p).overflowY; if (oy === 'auto' || oy === 'scroll') scrollers.push(p); }
        sc.style.height = window.innerHeight + 'px';
        for (let i = 0; i < 4; i++) {
            const extra = Math.max(...scrollers.map(s => s.scrollHeight - s.clientHeight));
            if (extra <= 1) break;
            const next = Math.max(280, sc.offsetHeight - extra);
            if (next === sc.offsetHeight) break;
            sc.style.height = next + 'px';
        }
    }
    window.addEventListener('resize', C.debounce(fitScroll, 150));
    function renderMini() {
        const el = view.querySelector('[data-mini]'); if (!el) return;
        const first = monthStart(state.mini || state.date), start = weekStart(first), mon = first.slice(0, 7), today = L.todayIST();
        const [y, m] = first.split('-').map(Number);
        const sel = state.view === 'week' ? { from: weekDays()[0], to: weekDays()[weekDays().length - 1] } : { from: state.date, to: state.date };
        const busy = new Set();
        state.items.forEach(it => { if (it.kind === 'event' && calOn(it)) for (let d = it.from, i = 0; d <= it.to && i < 42; d = L.addDays(d, 1), i++) busy.add(d); });
        let cells = '';
        for (let i = 0; i < 42; i++) {
            const d = L.addDays(start, i);
            const cls = [d.slice(0, 7) !== mon ? 'out' : '', d >= sel.from && d <= sel.to ? 'sel' : '', d === today ? 'today' : '', busy.has(d) ? 'dot' : ''].filter(Boolean).join(' ');
            cells += `<button type="button" class="${cls}" data-mini-day="${d}" aria-label="${esc(L.fmtDate(d))}">${Number(d.slice(8))}</button>`;
        }
        el.innerHTML = `<div class="cal-mini"><div class="mh"><button type="button" data-mini-step="-1" aria-label="Previous month">‹</button><b>${MONTHS[m - 1]} ${y}</b><button type="button" data-mini-step="1" aria-label="Next month">›</button></div>
            <div class="mg">${DAY_NAMES.map(n => `<span>${n.slice(0, 2)}</span>`).join('')}${cells}</div></div>`;
    }
    function renderMonth(items) {
        const today = L.todayIST();
        const first = monthStart(state.date), mon = first.slice(0, 7), start = weekStart(first);
        let cells = '';
        for (let i = 0; i < 42; i++) {
            const day = L.addDays(start, i);
            const dayItems = itemsOn(day, items);
            const off = dayItems.some(it => it.off) || L.isoWeekday(day) === 7;
            const shown = dayItems.slice(0, 3), more = dayItems.length - shown.length;
            cells += `<div class="d${day.slice(0, 7) !== mon ? ' out' : ''}${day === today ? ' today' : ''}${off ? ' off' : ''}" data-day="${day}" role="button" tabindex="0" aria-label="${esc(L.fmtDate(day))}">
                <span class="n">${Number(day.slice(8))}</span>
                <div class="evs">${shown.map(it => chip(it)).join('')}</div>
                ${more > 0 ? `<span class="more" data-more="${day}">+${more} more</span>` : ''}
            </div>`;
        }
        return `<div class="cal-month">${DAY_NAMES.map(n => `<div class="h">${n}</div>`).join('')}${cells}</div>`;
    }
    function renderWeek(items, days) {
        const today = L.todayIST();
        const head = '<div class="h"></div>' + days.map(d => `<div class="h${d === today ? ' today' : ''}" data-day-head="${d}">${DAY_NAMES[L.isoWeekday(d) - 1]}<b>${Number(d.slice(8))}</b></div>`).join('');
        const allday = '<div class="allday gutter"><span>All day</span></div>' + days.map(d => `<div class="allday" data-day="${d}">${itemsOn(d, items).filter(it => it.allDay).map(it => chip(it, { noTime: true })).join('')}</div>`).join('');
        const gutter = `<div class="gutter">${Array.from({ length: 24 }, (_, hh) => `<div class="hour">${hh === 0 ? '' : fmtMin(hh * 60)}</div>`).join('')}</div>`;
        const nowMin = (() => { const [hh, mm] = L.istTime(new Date()).split(':').map(Number); return hh * 60 + mm; })();
        const cols = days.map(d => {
            const timed = itemsOn(d, items).filter(it => !it.allDay && it.startIso);
            // Overlapping events share the column side by side (greedy lanes).
            const placed = [];
            timed.forEach(it => {
                const s = minutesOn(it.startIso, d), e = Math.max(s + 20, minutesOn(it.endIso || it.startIso, d) || s + 30);
                let lane = 0; while (placed.some(p => p.lane === lane && p.s < e && p.e > s)) lane++;
                placed.push({ it, s, e, lane });
            });
            const lanes = Math.max(1, ...placed.map(p => p.lane + 1));
            const evs = placed.map(p => {
                const w = 100 / lanes, it = p.it, short = p.e - p.s < 45;          // short events: time and title on one line
                const drag = it.kind === 'event' && canEditEvent(it.ev) && it.ev.status !== 'cancelled';
                return `<div class="cal-ev timed${short ? ' short' : ''}${it.cls || ''}${drag ? ' can-drag' : ''}" data-kind="${it.kind}" data-item="${esc(it.key)}" role="button" tabindex="0" title="${esc(it.tip || it.title)}" style="--ev:${colorOf(it)};top:${p.s / 60 * HOUR_PX}px;height:${Math.max(22, (p.e - p.s) / 60 * HOUR_PX - 2)}px;left:calc(${p.lane * w}% + 2px);right:auto;width:calc(${w}% - 4px)"><span class="tm">${esc(L.fmtTime(it.startIso))}${p.e - p.s >= 90 && it.endIso && it.kind === 'event' ? ' – ' + esc(L.fmtTime(it.endIso)) : ''}</span><span class="tt">${esc(it.title)}</span>${drag && !(it.ev.all_day) ? '<span class="rz" aria-hidden="true"></span>' : ''}</div>`;
            }).join('');
            const slots = Array.from({ length: 24 }, (_, hh) => `<div class="hour${hh < WORK_FROM || hh >= WORK_TO || L.isoWeekday(d) === 7 ? ' off' : ''}" data-slot="${d}T${String(hh).padStart(2, '0')}:00"></div>`).join('');
            return `<div class="col" data-date="${d}">${slots}${evs}${d === today ? `<div class="nowline" style="top:${nowMin / 60 * HOUR_PX}px"></div>` : ''}</div>`;
        }).join('');
        const cls = days.length === 1 ? ' day' : days.length === 3 ? ' three' : '';
        return `<div class="cal-week${cls}">${head}${allday}</div>
            <div class="cal-scroll"><div class="cal-week${cls}" style="border-top:0;border-radius:0 0 8px 8px">${gutter}${cols}</div></div>`;
    }
    function renderSchedule(items) {
        const today = L.todayIST(), inv = !!filterState().values.invites;
        const from = inv ? today : state.date;
        const last = inv ? items.reduce((m, it) => (it.to > m ? it.to : m), from) : L.addDays(from, 29);
        let html = '<div class="cal-agenda">', any = false;
        for (let day = from, i = 0; day <= last && i < 400; day = L.addDays(day, 1), i++) {
            const list = itemsOn(day, items);
            if (!list.length) continue;
            any = true;
            html += `<div class="day-h${day === today ? ' today' : ''}">${day === today ? 'Today · ' : ''}${DAY_NAMES[L.isoWeekday(day) - 1]}, ${esc(L.fmtDate(day))}</div><ul class="crm-list compact">`;
            list.forEach(it => {
                const when = it.allDay ? 'All day' : `${L.fmtTime(it.startIso)}${it.endIso && it.kind === 'event' ? ' – ' + L.fmtTime(it.endIso) : ''}`;
                const who = it.kind === 'event' ? C.personName(it.ev.owner_id) : it.kind === 'task' ? C.personName(it.task.assignee_id) : it.kind === 'followup' ? C.personName(it.lead.owner_id) : (it.tip || '');
                const waiting = it.kind === 'event' && myResponse(it.ev) === 'invited' && it.ev.status !== 'cancelled';
                html += `<li class="cal-row${it.cls || ''}" data-item="${esc(it.key)}" role="button" tabindex="0" style="--ev:${colorOf(it)}">
                    <span class="when">${esc(when)}</span><span class="dot" aria-hidden="true"></span>
                    <div class="main"><b>${esc(it.title)}</b><span>${esc(who)}${it.kind === 'event' && it.ev.location ? ' · ' + esc(it.ev.location) : ''}${it.kind === 'event' && it.ev.status === 'cancelled' ? ' · Cancelled' : ''}</span></div>
                    ${waiting ? `<div class="right"><button type="button" class="ws-btn sm primary" data-rsvp="accepted" data-ev="${esc(it.ev.id)}">Accept</button><button type="button" class="ws-btn sm" data-rsvp="tentative" data-ev="${esc(it.ev.id)}">Maybe</button><button type="button" class="ws-btn sm" data-rsvp="declined" data-ev="${esc(it.ev.id)}">Decline</button></div>` : ''}
                </li>`;
            });
            html += '</ul>';
        }
        if (!any) html += inv
            ? '<div class="ws-empty"><b>No invitations waiting</b><div>Meetings you are invited to show up here until you answer them.</div></div>'
            : `<div class="ws-empty"><b>Nothing scheduled</b><div>No meetings, due dates or holidays in the 30 days from ${esc(L.fmtDate(state.date))}.</div><div style="margin-top:12px"><button type="button" class="ws-btn primary" data-new>${C.icon('plus')}<span>Create an event</span></button></div></div>`;
        return html + '</div>';
    }

    /* ------------------------------------------------------------ clicks */
    async function answer(eventId, response, btn) {
        try {
            if (btn) btn.disabled = true;
            await C.q(sb.from('event_participants').update({ response }).eq('event_id', eventId).eq('user_id', me.id));
            const it = state.items.find(x => x.key === 'e:' + eventId);
            if (it) {
                const p = (it.ev.participants || []).find(x => x.user_id === me.id); if (p) p.response = response;
                Object.assign(it, eventItem(it.ev));
                if (it.ev.owner_id !== me.id) C.pushNotify({ to: it.ev.owner_id, title: `${me.name} ${RESPONSE[response].label.toLowerCase()} your meeting`, body: it.ev.title, url: `/calendar/?id=${eventId}`, tag: 'event' });
            }
            C.toast(response === 'accepted' ? 'Accepted' : response === 'declined' ? 'Declined' : 'Marked as maybe', 'ok');
            renderBody(); loadInvites();
        } catch (e) { if (btn) btn.disabled = false; C.toast(e.message, 'bad'); }
    }
    function onBodyClick(e) {
        if (suppressClick) { suppressClick = false; return; }
        const rs = e.target.closest('[data-rsvp]');
        if (rs) { e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); return answer(rs.dataset.ev, rs.dataset.rsvp, rs); }
        if (e.target.closest('[data-new]')) return openCreate();
        const more = e.target.closest('[data-more]');
        if (more) { e.preventDefault(); state.date = more.dataset.more; setView('day'); return; }
        const chipEl = e.target.closest('[data-item]');
        if (chipEl) { e.preventDefault(); openItem(chipEl.dataset.item); return; }
        const slot = e.target.closest('[data-slot]');
        if (slot) { const [d, t] = slot.dataset.slot.split('T'); const hh = Number(t.slice(0, 2)); openCreate({ starts_at: L.isoAtIST(d, t), ends_at: hh >= 23 ? L.isoEndOfIST(d) : L.isoAtIST(d, `${String(hh + 1).padStart(2, '0')}:00`) }); return; }
        const dayEl = e.target.closest('[data-day]');
        if (dayEl) {
            if (state.view === 'month' && window.innerWidth < 760) { state.date = dayEl.dataset.day; setView('day'); return; }
            const allDay = dayEl.classList.contains('allday');
            openCreate({ starts_at: L.isoAtIST(dayEl.dataset.day, allDay ? '00:00' : '10:00'), ends_at: allDay ? L.isoEndOfIST(dayEl.dataset.day) : L.isoAtIST(dayEl.dataset.day, '11:00'), all_day: allDay });
        }
    }
    function openCreate(defaults) {
        C.openEventEditor({ defaults: defaults || { starts_at: L.isoAtIST(state.date, '10:00'), ends_at: L.isoAtIST(state.date, '11:00') }, colors: hasColor ? EVENT_COLORS : null, onSaved: () => { load(); loadInvites(); } });
    }
    function openItem(key) {
        const it = state.items.find(x => x.key === key); if (!it) return;
        if (it.kind === 'event') return openEvent(it.ev.id);
        if (it.href) { location.href = it.href; return; }
        C.toast(it.tip ? `${it.title} · ${it.tip}` : it.title, '');
    }

    /* ------------------------------------------------------- drag and drop */
    function onPointerDown(e) {
        if (e.button !== 0 || e.pointerType === 'touch') return;          // on touch screens a tap opens; scrolling stays free
        const chipEl = e.target.closest('.cal-ev.can-drag[data-item]');
        if (chipEl) return dragEvent(e, chipEl);
        const col = e.target.closest('.cal-week .col[data-date]');
        if (col && !e.target.closest('.cal-ev')) selectSpan(e, col);
    }
    function dragEvent(e, el) {
        const it = state.items.find(x => x.key === el.dataset.item); if (!it) return;
        const resize = !!e.target.closest('.rz'), homeCol = el.closest('.col[data-date]'), homeDay = el.closest('[data-day]');
        const x0 = e.clientX, y0 = e.clientY, top0 = el.offsetTop, h0 = el.offsetHeight;
        const s0 = Date.parse(it.ev.starts_at), e0 = Date.parse(it.ev.ends_at);
        let moved = false, cancelled = false, dMin = 0, dDays = 0, ghost = null, overCell = null;
        function move(ev) {
            if (!moved) { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return; moved = true; el.classList.add('dragging'); document.body.classList.add('cal-dragging'); }
            ev.preventDefault();
            if (homeCol) {
                dMin = Math.round((ev.clientY - y0) / HOUR_PX * 60 / 15) * 15;
                if (resize) { el.style.height = Math.max(HOUR_PX / 4, h0 + dMin / 60 * HOUR_PX) + 'px'; return; }
                const target = document.elementsFromPoint(ev.clientX, ev.clientY).find(n => n.matches && n.matches('.cal-week .col[data-date]'));
                if (target && target !== el.parentElement) { target.appendChild(el); el.style.left = '2px'; el.style.width = 'calc(100% - 4px)'; }
                dDays = L.dayNumber(el.parentElement.dataset.date) - L.dayNumber(homeCol.dataset.date);
                el.style.top = Math.max(0, top0 + dMin / 60 * HOUR_PX) + 'px';
                const tm = el.querySelector('.tm'); if (tm) tm.textContent = `${L.fmtTime(new Date(s0 + dMin * 60000).toISOString())}`;
            } else {
                if (!ghost) { ghost = el.cloneNode(true); ghost.classList.add('cal-ghost'); ghost.style.width = el.offsetWidth + 'px'; document.body.appendChild(ghost); }
                ghost.style.left = (ev.clientX + 10) + 'px'; ghost.style.top = (ev.clientY + 10) + 'px';
                const cell = document.elementsFromPoint(ev.clientX, ev.clientY).find(n => n.dataset && n.dataset.day && view.contains(n));
                if (overCell !== cell) { if (overCell) overCell.classList.remove('drop'); overCell = cell || null; if (overCell) overCell.classList.add('drop'); }
                dDays = overCell && homeDay ? L.dayNumber(overCell.dataset.day) - L.dayNumber(homeDay.dataset.day) : 0;
            }
        }
        function onKey(ev) { if (ev.key === 'Escape') { cancelled = true; up(); } }
        async function up() {
            document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('keydown', onKey, true);
            document.body.classList.remove('cal-dragging');
            if (ghost) ghost.remove();
            if (overCell) overCell.classList.remove('drop');
            if (!moved) return;
            suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
            let ns = s0, ne = e0;
            if (resize) ne = Math.max(s0 + 15 * 60000, e0 + dMin * 60000);
            else { const shift = dDays * 864e5 + (homeCol ? dMin * 60000 : 0); ns = s0 + shift; ne = e0 + shift; }
            if (cancelled || (ns === s0 && ne === e0)) return renderBody();
            await reschedule(it, new Date(ns).toISOString(), new Date(ne).toISOString());
        }
        document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('keydown', onKey, true);
    }
    async function reschedule(it, startsAt, endsAt) {
        const prev = { s: it.ev.starts_at, e: it.ev.ends_at };
        it.ev.starts_at = startsAt; it.ev.ends_at = endsAt; Object.assign(it, eventItem(it.ev));
        renderBody();                                                     // show it where it was dropped straight away
        const r = await sb.from('calendar_events').update({ starts_at: startsAt, ends_at: endsAt }).eq('id', it.ev.id).select('id');
        if (r.error || !(r.data || []).length) {
            it.ev.starts_at = prev.s; it.ev.ends_at = prev.e; Object.assign(it, eventItem(it.ev)); renderBody();
            return C.toast(r.error ? C.friendly(r.error) : 'Only the organiser or a manager can move this event.', 'bad');
        }
        C.toast(`Moved to ${L.fmtDate(startsAt)}${it.ev.all_day ? '' : ', ' + L.fmtTime(startsAt)}${(it.ev.participants || []).length ? '. Participants are notified.' : ''}`, 'ok');
    }
    function selectSpan(e, col) {
        const at = y => (y - col.getBoundingClientRect().top) / HOUR_PX * 60;
        const m0 = Math.max(0, Math.min(1410, Math.floor(at(e.clientY) / 30) * 30));
        let m1 = m0 + 30, moved = false;
        const y0 = e.clientY, sel = document.createElement('div');
        sel.className = 'cal-sel';
        const span = () => ({ a: Math.min(m0, m1 - 30), b: Math.max(m0 + 30, m1) });
        function move(ev) {
            if (!moved) { if (Math.abs(ev.clientY - y0) < 6) return; moved = true; col.appendChild(sel); document.body.classList.add('cal-dragging'); }
            ev.preventDefault();
            m1 = Math.max(0, Math.min(1440, Math.ceil(at(ev.clientY) / 30) * 30));
            const { a, b } = span();
            sel.style.top = (a / 60 * HOUR_PX) + 'px'; sel.style.height = ((b - a) / 60 * HOUR_PX) + 'px';
            sel.textContent = `${fmtMin(a)} – ${fmtMin(b)}`;
        }
        function up() {
            document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
            document.body.classList.remove('cal-dragging');
            sel.remove();
            if (!moved) return;
            suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
            const { a, b } = span(), d = col.dataset.date;
            openCreate({ starts_at: L.isoAtIST(d, fmtHM(a)), ends_at: b >= 1440 ? L.isoEndOfIST(d) : L.isoAtIST(d, fmtHM(b)) });
        }
        document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    }

    /* ------------------------------------------------------- .ics files */
    function exportIcs() {
        const evs = visibleItems().filter(it => it.kind === 'event').map(it => it.ev);
        if (!evs.length) return C.toast('No events on screen to export. Change the dates or the calendars shown first.', 'warn');
        const r = visibleRange();
        download(`WorkSuite calendar ${r.from} to ${r.to}.ics`, ICS.toIcs(evs, { name: 'WorkSuite', url: ev => `${location.origin}/calendar/?id=${ev.id}` }));
        C.toast(`${evs.length} event${evs.length === 1 ? '' : 's'} exported`, 'ok');
    }
    function importIcs() {
        const input = h('<input type="file" accept=".ics,text/calendar" hidden>');
        document.body.appendChild(input);
        input.addEventListener('change', async () => {
            const f = input.files[0]; input.remove(); if (!f) return;
            if (f.size > 5 * 1048576) return C.toast('Choose a calendar file of 5 MB or less.', 'bad');
            let parsed = [];
            try { parsed = ICS.parseIcs(await f.text()).filter(x => !x.cancelled); } catch (e) { parsed = []; }
            if (!parsed.length) return C.alert({ title: 'No events found', message: `${f.name} has no events WorkSuite can read.` });
            const repeating = parsed.filter(x => x.recurring).length, capped = parsed.length > 1000;
            await C.formModal({
                title: `Import ${Math.min(parsed.length, 1000)} event${parsed.length === 1 ? '' : 's'}`, submitLabel: 'Import',
                intro: `<div class="crm-info">From ${esc(f.name)}. ${repeating ? `${repeating} repeating event${repeating === 1 ? '' : 's'} will be added once, on the first date. ` : ''}${capped ? 'Only the first 1,000 events are imported. ' : ''}Events already in your calendar with the same title and start time are skipped. Times without a time zone are read as IST.</div>`,
                fields: [{ name: 'visibility', label: 'Who can see them', type: 'select', required: true, full: true, options: [{ value: 'private', label: 'Only me' }, { value: 'company', label: 'Everyone in the company' }] }],
                values: { visibility: 'private' },
                onSubmit: async v => {
                    const rows = parsed.slice(0, 1000).map(x => ({
                        title: x.title.slice(0, 300), description: x.description ? x.description.slice(0, 5000) : null, location: x.location ? x.location.slice(0, 300) : null,
                        meeting_link: /^https?:\/\//i.test(x.url || '') ? x.url.slice(0, 1000) : null, event_type: 'meeting', all_day: x.all_day, visibility: v.visibility,
                        starts_at: x.all_day ? L.isoAtIST(x.start_date, '00:00') : x.starts_at, ends_at: x.all_day ? L.isoEndOfIST(x.end_date) : x.ends_at,
                        owner_id: me.id, created_by: me.id,
                    }));
                    const starts = rows.map(r => r.starts_at).sort();
                    const ex = await sb.from('calendar_events').select('title, starts_at').eq('owner_id', me.id).gte('starts_at', starts[0]).lte('starts_at', starts[starts.length - 1]).limit(5000);
                    const seen = new Set((ex.data || []).map(e => `${e.title}|${Date.parse(e.starts_at)}`));
                    const fresh = rows.filter(r => { const k = `${r.title}|${Date.parse(r.starts_at)}`; if (seen.has(k)) return false; seen.add(k); return true; });
                    for (let i = 0; i < fresh.length; i += 100) await C.q(sb.from('calendar_events').insert(fresh.slice(i, i + 100)));
                    C.toast(`${fresh.length} imported${rows.length - fresh.length ? `, ${rows.length - fresh.length} already there` : ''}`, 'ok');
                    if (fresh.length) setDate(L.istDate(fresh.map(r => r.starts_at).sort()[0])); else load();
                },
            });
        });
        input.click();
    }

    /* ------------------------------------------------------ event detail */
    async function openEvent(id) {
        let ev;
        try { ev = (await C.q(sb.from('calendar_events').select('*, participants:event_participants(user_id, response)').eq('id', id).maybeSingle())).data; }
        catch (e) { return C.toast(e.message, 'bad'); }
        if (!ev) return C.toast('That event was not found, or you do not have access to it.', 'bad');
        const canEdit = canEditEvent(ev);
        const myPart = (ev.participants || []).find(p => p.user_id === me.id);
        const links = ['contact', 'lead', 'deal', 'project'].filter(k => ev[k + '_id']);
        const labels = {};
        await Promise.all(links.map(async k => { labels[k] = await C.entityLabel(k, ev[k + '_id']).catch(() => ''); }));
        const when = ev.all_day
            ? (L.istDate(ev.starts_at) === L.istDate(ev.ends_at) ? `${L.fmtDate(ev.starts_at)} · All day` : `${L.fmtDate(ev.starts_at)} – ${L.fmtDate(ev.ends_at)} · All day`)
            : (L.istDate(ev.starts_at) === L.istDate(ev.ends_at) ? `${L.fmtDate(ev.starts_at)}, ${L.fmtTime(ev.starts_at)} – ${L.fmtTime(ev.ends_at)}` : `${L.fmtDateTime(ev.starts_at)} – ${L.fmtDateTime(ev.ends_at)}`);
        const color = colorOf(eventItem(ev));
        const body = document.createElement('div');
        body.innerHTML = `
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px"><span class="cal-swatch" style="--ev:${color}" aria-hidden="true"></span>${C.statusBadge(L.EVENT_TYPE, ev.event_type)}${ev.status === 'cancelled' ? C.badge('mute', 'Cancelled') : ''}${ev.visibility === 'private' ? C.badge('info', 'Private') : ''}</div>
            <dl class="crm-props">
                <div><dt>When</dt><dd>${esc(when)} <span class="muted">IST</span></dd></div>
                <div><dt>Organiser</dt><dd>${C.personHtml(ev.owner_id)}</dd></div>
                ${ev.location ? `<div><dt>Location</dt><dd>${esc(ev.location)}</dd></div>` : ''}
                ${ev.meeting_link ? `<div><dt>Meeting link</dt><dd><a class="ws-btn sm primary" href="${esc(ev.meeting_link)}" target="_blank" rel="noopener">${C.icon('link')}<span>Join</span></a></dd></div>` : ''}
                ${ev.reminder_minutes ? `<div><dt>Reminder</dt><dd>${ev.reminder_minutes >= 1440 ? '1 day' : ev.reminder_minutes >= 60 ? (ev.reminder_minutes / 60) + ' hour' + (ev.reminder_minutes >= 120 ? 's' : '') : ev.reminder_minutes + ' minutes'} before</dd></div>` : ''}
                ${links.length ? `<div class="full" style="grid-column:1/-1"><dt>Linked to</dt><dd style="display:flex;gap:6px;flex-wrap:wrap">${links.map(k => C.entityChip(k, ev[k + '_id'], labels[k] || C.ENTITY_META[k].label)).join('')}</dd></div>` : ''}
            </dl>
            <div class="crm-section-title" style="margin-top:16px"><h3>Participants</h3></div>
            ${(ev.participants || []).length ? `<ul class="crm-list compact">${ev.participants.map(p => `<li>${C.personHtml(p.user_id)}<div class="right">${C.statusBadge(RESPONSE, p.response)}</div></li>`).join('')}</ul>` : '<div class="muted" style="font-size:13px">No colleagues invited.</div>'}
            ${myPart ? `<div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap" id="rsvp">${['accepted', 'tentative', 'declined'].map(r => `<button type="button" class="ws-btn sm${myPart.response === r ? ' primary' : ''}" data-rsvp="${r}">${RESPONSE[r].label}</button>`).join('')}</div>` : ''}
            ${ev.description ? `<div class="crm-section-title" style="margin-top:16px"><h3>Notes</h3></div><div class="crm-desc">${C.linkify(C.nl2br(ev.description))}</div>` : ''}
            <div class="crm-section-title" style="margin-top:16px"><h3>Activity</h3></div>
            <div id="ev-composer"></div><div id="ev-activity"></div>`;
        const actions = [
            { label: 'Download (.ics)', onClick: () => download(`${ev.title.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80) || 'event'}.ics`, ICS.toIcs([ev], { name: 'WorkSuite', url: x => `${location.origin}/calendar/?id=${x.id}` })) },
            { label: 'Add to my tasks', onClick: api => { api.close(); C.openTaskEditor({ defaults: { title: ev.title, due_date: L.istDate(ev.starts_at), contact_id: ev.contact_id || undefined, deal_id: ev.deal_id || undefined, project_id: ev.project_id || undefined } }); } },
        ];
        if (canEdit && ev.status !== 'cancelled') actions.push({ label: 'Cancel event', danger: true, onClick: async api => {
            if (!await C.confirm({ title: 'Cancel this event?', message: 'Participants are notified and the event stays on the calendar, struck through.', okText: 'Cancel event', danger: true })) return;
            await C.q(sb.from('calendar_events').update({ status: 'cancelled' }).eq('id', ev.id));
            (ev.participants || []).forEach(p => C.pushNotify({ to: p.user_id, title: 'Meeting cancelled', body: ev.title, url: `/calendar/?id=${ev.id}`, tag: 'event' }));
            C.toast('Event cancelled', 'ok'); api.close(); load(); loadInvites();
        } });
        if (canEdit) actions.push({ label: 'Delete', danger: true, onClick: async api => {
            if (!await C.confirm({ title: 'Delete this event permanently?', message: 'Cancelling keeps a record; deleting removes it for everyone.', okText: 'Delete', danger: true })) return;
            await C.q(sb.from('calendar_events').delete().eq('id', ev.id));
            C.toast('Event deleted', 'ok'); api.close(); load(); loadInvites();
        } });
        if (canEdit) actions.push({ label: 'Edit', primary: true, onClick: api => { api.close(); C.openEventEditor({ event: ev, participants: (ev.participants || []).map(p => p.user_id), colors: hasColor ? EVENT_COLORS : null, onSaved: () => { load(); openEvent(ev.id); } }); } });
        else actions.push({ label: 'Close', close: true });
        const m = C.modal({ title: ev.title, size: 'wide', body, actions, onClose: () => { if (C.param('id') === ev.id) C.setParam('id', null, true); } });
        const feed = C.activityFeed(body.querySelector('#ev-activity'), { entity_type: 'event', entity_id: ev.id, limit: 30 });
        C.comments(body.querySelector('#ev-composer'), { entity_type: 'event', entity_id: ev.id, onPosted: () => feed.reload() });
        const rsvp = body.querySelector('#rsvp');
        if (rsvp) rsvp.addEventListener('click', async e => {
            const b = e.target.closest('[data-rsvp]'); if (!b) return;
            await answer(ev.id, b.dataset.rsvp);
            rsvp.querySelectorAll('button').forEach(x => x.classList.toggle('primary', x === b));
        });
        return m;
    }

    /* ---------------------------------------------------------- reminders */
    function checkReminders() {
        const now = Date.now();
        state.items.filter(it => it.kind === 'event' && it.ev.reminder_minutes && it.ev.status !== 'cancelled' && isEventMine(it.ev) && myResponse(it.ev) !== 'declined').forEach(it => {
            const at = new Date(it.ev.starts_at).getTime() - it.ev.reminder_minutes * 60000;
            if (at <= now && now < new Date(it.ev.starts_at).getTime() && !remindedIds.has(it.ev.id)) {
                remindedIds.add(it.ev.id);
                WSShell.toast(`Reminder: ${it.title} at ${L.fmtTime(it.ev.starts_at)}`, 'ok');
            }
        });
    }
    setInterval(checkReminders, 60000);

    /* ---------------------------------------------------------------- boot */
    renderChrome();
    syncUrl();
    loadInvites();
    await load();
    C.subscribe('calendar', [{ table: 'calendar_events' }, { table: 'event_participants' }], reloadSoon);
    if (C.param('id')) openEvent(C.param('id'));
    if (C.param('new') === '1') { C.setParam('new', null, true); openCreate(); }
    window.addEventListener('popstate', () => {
        const p = new URLSearchParams(location.search);
        const v = p.get('view') === 'agenda' ? 'schedule' : p.get('view');
        if (VIEWS.includes(v)) state.view = v;
        if (L.dayNumber(p.get('date')) != null) state.date = p.get('date');
        load();
    });
})();
