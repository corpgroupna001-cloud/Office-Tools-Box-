/* ============================================================================
   Calendar — Month / Week / Day / Agenda over one merged item list:
   calendar_events, task due dates, project deadlines, company holidays,
   approved leave (own + managed people) and lead follow-ups. Every wall-clock
   value is rendered in IST through WSCrmLogic; nothing here uses the
   browser's local timezone.

   URLs: /calendar/?view=month|week|day|agenda&date=YYYY-MM-DD
         /calendar/?id=<event uuid>   opens the event on top of the calendar
         /calendar/?new=1             opens the create dialog
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'calendar', crumb: 'Calendar' });
    const sb = ctx.sb, me = ctx.user;

    const VIEWS = ['month', 'week', 'day', 'agenda'];
    const HOUR_PX = 48;
    const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const RESPONSE = { invited: { label: 'Invited', color: 'weekoff' }, accepted: { label: 'Accepted', color: 'present' }, declined: { label: 'Declined', color: 'absent' }, tentative: { label: 'Tentative', color: 'late' } };

    const params = new URLSearchParams(location.search);
    const state = {
        view: VIEWS.includes(params.get('view')) ? params.get('view') : (window.innerWidth < 640 ? 'agenda' : 'month'),
        date: L.dayNumber(params.get('date')) != null ? params.get('date') : L.todayIST(),
        onlyMine: false, person: '',
        sources: { events: true, tasks: true, completed: false, projects: true, holidays: true, leave: true, followups: true },
        types: new Set(Object.keys(L.EVENT_TYPE)),
        items: [], loading: false, eventsMissing: false,
    };
    const remindedIds = new Set();
    let reloadTimer = null;

    /* ------------------------------------------------------------ helpers */
    function syncUrl() {
        const u = new URL(location.href);
        u.searchParams.set('view', state.view); u.searchParams.set('date', state.date);
        history.replaceState(null, '', u.pathname + u.search);
    }
    function monthStart(d) { return d.slice(0, 7) + '-01'; }
    function monthEnd(d) { const [y, m] = d.split('-').map(Number); const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); return `${d.slice(0, 7)}-${String(last).padStart(2, '0')}`; }
    function weekStart(d) { return L.addDays(d, -(L.isoWeekday(d) - 1)); }
    function shiftMonth(d, n) { const [y, m] = d.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1 + n, 1)); return dt.toISOString().slice(0, 10); }
    /** Visible range, inclusive dates. Month view includes the leading/trailing days shown in the grid. */
    function visibleRange() {
        const d = state.date;
        if (state.view === 'month') { const s = weekStart(monthStart(d)); return { from: s, to: L.addDays(s, 41) }; }
        if (state.view === 'week') { const s = weekStart(d); return { from: s, to: L.addDays(s, 6) }; }
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
    function isMine(it) {
        if (it.kind === 'event') return it.ev.owner_id === me.id || it.ev.created_by === me.id || (it.ev.participants || []).some(p => p.user_id === me.id);
        if (it.kind === 'task') return it.task.assignee_id === me.id;
        if (it.kind === 'leave') return it.user_id === me.id;
        if (it.kind === 'followup') return it.lead.owner_id === me.id;
        return true;
    }
    function isPerson(it, id) {
        if (it.kind === 'event') return it.ev.owner_id === id || (it.ev.participants || []).some(p => p.user_id === id);
        if (it.kind === 'task') return it.task.assignee_id === id;
        if (it.kind === 'leave') return it.user_id === id;
        if (it.kind === 'followup') return it.lead.owner_id === id;
        return false;
    }
    function visibleItems() {
        return state.items.filter(it => {
            if (state.onlyMine && !isMine(it)) return false;
            if (state.person && !isPerson(it, state.person)) return false;
            if (it.kind === 'event' && !state.types.has(it.ev.event_type)) return false;
            if (it.kind === 'task' && it.task.completed_at && !state.sources.completed) return false;
            return true;
        });
    }
    /** Items touching a given IST day, all-day ones first, then by start. */
    function itemsOn(day, items) {
        return (items || visibleItems()).filter(it => it.from <= day && it.to >= day)
            .sort((a, b) => (a.allDay === b.allDay ? 0 : a.allDay ? -1 : 1) || String(a.startIso || '').localeCompare(String(b.startIso || '')) || a.title.localeCompare(b.title));
    }

    /* ------------------------------------------------------------- loading */
    async function load() {
        const range = visibleRange();
        const iso = L.rangeToIso(range);
        state.loading = true; renderBody();
        const items = [];
        const mine = [me.company, me.company2].filter(Boolean);
        state.eventsMissing = false;

        const jobs = [
            // 1) calendar events
            async () => {
                if (!state.sources.events) return;
                const r = await sb.from('calendar_events').select('*, participants:event_participants(user_id, response)')
                    .lt('starts_at', iso.to).gte('ends_at', iso.from).order('starts_at').limit(1000);
                if (r.error) { if (C.isMissingSchema(r.error)) state.eventsMissing = true; else console.warn('[calendar] events', r.error); return; }
                (r.data || []).forEach(ev => {
                    const from = L.istDate(ev.starts_at), to = L.istDate(ev.ends_at);
                    items.push({ kind: 'event', id: ev.id, key: 'e:' + ev.id, ev, title: ev.title, from, to: to < from ? from : to, allDay: !!ev.all_day, startIso: ev.starts_at, endIso: ev.ends_at,
                        cls: (ev.event_type === 'call' ? 'k-call' : ev.event_type === 'follow_up' ? 'k-followup' : ev.event_type === 'deadline' ? 'k-deadline' : '') + (ev.status === 'cancelled' ? ' cancelled' : '') });
                });
            },
            // 2) task due dates
            async () => {
                if (!state.sources.tasks) return;
                const r = await sb.from('tasks').select('id,title,due_date,due_time,status,completed_at,assignee_id').is('archived_at', null)
                    .gte('due_date', range.from).lte('due_date', range.to).limit(1000);
                if (r.error) return;
                const today = L.todayIST();
                (r.data || []).forEach(t => {
                    const timed = !!t.due_time;
                    const startIso = timed ? L.isoAtIST(t.due_date, t.due_time) : L.isoAtIST(t.due_date, '00:00');
                    items.push({ kind: 'task', id: t.id, key: 't:' + t.id, task: t, title: t.title, from: t.due_date, to: t.due_date, allDay: !timed, startIso,
                        endIso: timed ? new Date(new Date(startIso).getTime() + 30 * 60000).toISOString() : L.isoEndOfIST(t.due_date),
                        cls: 'k-task' + (!t.completed_at && t.due_date < today ? ' overdue' : '') + (t.completed_at ? ' cancelled' : ''), href: `/tasks/?id=${t.id}` });
                });
            },
            // 3) project deadlines
            async () => {
                if (!state.sources.projects) return;
                const r = await sb.from('projects').select('id,name,due_date,status').in('status', ['planning', 'active']).is('archived_at', null)
                    .gte('due_date', range.from).lte('due_date', range.to).limit(500);
                if (r.error) return;
                (r.data || []).forEach(p => items.push({ kind: 'project', id: p.id, key: 'p:' + p.id, title: `Project due: ${p.name}`, from: p.due_date, to: p.due_date, allDay: true, startIso: L.isoAtIST(p.due_date, '00:00'), cls: 'k-project', href: `/projects/?id=${p.id}` }));
            },
            // 4) holidays
            async () => {
                if (!state.sources.holidays) return;
                const r = await sb.from('holidays').select('id,holiday_date,name,company,is_optional').gte('holiday_date', range.from).lte('holiday_date', range.to).limit(500);
                if (r.error) return;
                (r.data || []).filter(hd => !hd.company || !mine.length || mine.includes(hd.company)).forEach(hd =>
                    items.push({ kind: 'holiday', id: hd.id, key: 'h:' + hd.id, title: `${hd.name}${hd.is_optional ? ' (optional)' : ''}`, from: hd.holiday_date, to: hd.holiday_date, allDay: true, startIso: L.isoAtIST(hd.holiday_date, '00:00'), cls: 'k-holiday', off: !hd.is_optional, tip: hd.company ? hd.company : 'All companies' }));
            },
            // 5) approved leave
            async () => {
                if (!state.sources.leave) return;
                const r = await sb.from('leave_requests').select('id,user_id,start_date,end_date,day_part,status').eq('status', 'approved')
                    .lte('start_date', range.to).gte('end_date', range.from).limit(500);
                if (r.error) return;
                (r.data || []).forEach(lv => items.push({ kind: 'leave', id: lv.id, key: 'l:' + lv.id, user_id: lv.user_id, title: `On leave: ${C.personName(lv.user_id)}${lv.day_part !== 'full' ? ' (half day)' : ''}`,
                    from: lv.start_date, to: lv.end_date, allDay: true, startIso: L.isoAtIST(lv.start_date, '00:00'), cls: 'k-leave', tip: `${L.fmtDate(lv.start_date)} – ${L.fmtDate(lv.end_date)}` }));
            },
            // 6) lead follow-ups
            async () => {
                if (!state.sources.followups) return;
                const r = await sb.from('crm_leads').select('id,name,next_follow_up_at,owner_id,status').is('archived_at', null)
                    .gte('next_follow_up_at', iso.from).lt('next_follow_up_at', iso.to).limit(500);
                if (r.error) return;
                (r.data || []).forEach(ld => {
                    const day = L.istDate(ld.next_follow_up_at);
                    items.push({ kind: 'followup', id: ld.id, key: 'f:' + ld.id, lead: ld, title: `Follow up: ${ld.name}`, from: day, to: day, allDay: false, startIso: ld.next_follow_up_at,
                        endIso: new Date(new Date(ld.next_follow_up_at).getTime() + 30 * 60000).toISOString(), cls: 'k-followup', href: `/leads/?id=${ld.id}` });
                });
            },
        ];
        await Promise.all(jobs.map(j => j().catch(e => console.warn('[calendar]', e))));
        state.items = items;
        state.loading = false;
        renderBody();
        checkReminders();
    }
    const reloadSoon = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(load, 400); };

    /* ------------------------------------------------------------ chrome */
    function titleText() {
        const d = state.date;
        const [y, m] = d.split('-').map(Number);
        if (state.view === 'month') return `${MONTHS[m - 1]} ${y}`;
        if (state.view === 'week') {
            const s = weekStart(d), e = L.addDays(s, 6);
            return s.slice(0, 7) === e.slice(0, 7) ? `${Number(s.slice(8))} – ${L.fmtDate(e)}` : `${L.fmtDate(s, { short: true })} – ${L.fmtDate(e)}`;
        }
        if (state.view === 'day') return `${DAY_NAMES[L.isoWeekday(d) - 1]}, ${L.fmtDate(d)}`;
        return `${L.fmtDate(d)} – ${L.fmtDate(L.addDays(d, 29))}`;
    }
    function renderChrome() {
        document.title = 'Calendar · WorkSuite';
        view.innerHTML = `
            <div class="ws-page-head">
                <div><p class="ws-eyebrow">Collaboration</p><h1>Calendar</h1><p>Meetings, follow-ups, task due dates, project deadlines, holidays and leave in one place.</p></div>
                <div class="actions"><button type="button" class="ws-btn primary" id="new-btn">${C.icon('plus')}<span>Schedule</span></button></div>
            </div>
            <div class="cal-head">
                <button type="button" class="ws-btn sm" id="prev" aria-label="Previous">${C.icon('chevron')}</button>
                <button type="button" class="ws-btn sm" id="today">Today</button>
                <button type="button" class="ws-btn sm" id="next" aria-label="Next">${C.icon('chevron')}</button>
                <h2 id="title"></h2>
                <input type="date" id="jump" aria-label="Jump to date" style="min-height:34px;padding:4px 8px;border:1px solid var(--ws-border-2);border-radius:6px;background:var(--ws-surface);color:var(--ws-text);font:inherit;font-size:13px">
                <span class="crm-count">Times shown in IST</span>
                <span style="flex:1"></span>
                <div class="crm-seg" role="tablist" id="views">${VIEWS.map(v => `<button type="button" data-view="${v}" class="${v === state.view ? 'on' : ''}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>
            </div>
            <div class="crm-toolbar" style="margin-bottom:10px">
                <label class="crm-check" style="min-height:34px"><input type="checkbox" id="only-mine"> Only mine</label>
                ${ctx.isManager ? `<select id="person" aria-label="Person"><option value="">Everyone</option>${C.peopleOptions('', { none: null })}</select>` : ''}
                <span class="crm-count" id="count"></span>
            </div>
            <div id="body"></div>
            <div class="cal-legend" id="legend">
                <label><span class="cal-ev" style="padding:0 6px">Meetings</span><input type="checkbox" data-src="events" ${state.sources.events ? 'checked' : ''}></label>
                <label><span class="cal-ev k-call" style="padding:0 6px">Calls</span><input type="checkbox" data-type="call" checked></label>
                <label><span class="cal-ev k-followup" style="padding:0 6px">Follow-ups</span><input type="checkbox" data-type="follow_up" checked></label>
                <label><span class="cal-ev k-deadline" style="padding:0 6px">Deadlines</span><input type="checkbox" data-type="deadline" checked></label>
                <label><span class="cal-ev k-task" style="padding:0 6px">Tasks due</span><input type="checkbox" data-src="tasks" ${state.sources.tasks ? 'checked' : ''}></label>
                <label><span class="muted">Completed tasks</span><input type="checkbox" data-src="completed" ${state.sources.completed ? 'checked' : ''}></label>
                <label><span class="cal-ev k-project" style="padding:0 6px">Project deadlines</span><input type="checkbox" data-src="projects" ${state.sources.projects ? 'checked' : ''}></label>
                <label><span class="cal-ev k-holiday" style="padding:0 6px">Holidays</span><input type="checkbox" data-src="holidays" ${state.sources.holidays ? 'checked' : ''}></label>
                <label><span class="cal-ev k-leave" style="padding:0 6px">Leave</span><input type="checkbox" data-src="leave" ${state.sources.leave ? 'checked' : ''}></label>
                <label><span class="cal-ev k-followup" style="padding:0 6px">Lead follow-ups</span><input type="checkbox" data-src="followups" ${state.sources.followups ? 'checked' : ''}></label>
            </div>`;
        view.querySelector('#prev .ic').style.transform = 'rotate(180deg)';
        view.querySelector('#new-btn').addEventListener('click', () => openCreate());
        view.querySelector('#prev').addEventListener('click', () => step(-1));
        view.querySelector('#next').addEventListener('click', () => step(1));
        view.querySelector('#today').addEventListener('click', () => setDate(L.todayIST()));
        view.querySelector('#jump').addEventListener('change', e => { if (L.dayNumber(e.target.value) != null) setDate(e.target.value); });
        view.querySelector('#views').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); });
        view.querySelector('#only-mine').addEventListener('change', e => { state.onlyMine = e.target.checked; renderBody(); });
        const person = view.querySelector('#person'); if (person) person.addEventListener('change', e => { state.person = e.target.value; renderBody(); });
        view.querySelector('#legend').addEventListener('change', e => {
            const t = e.target;
            if (t.dataset.src) { state.sources[t.dataset.src] = t.checked; if (t.dataset.src === 'completed') renderBody(); else load(); }
            if (t.dataset.type) { if (t.checked) state.types.add(t.dataset.type); else state.types.delete(t.dataset.type); renderBody(); }
        });
        const body = view.querySelector('#body');
        body.addEventListener('click', onBodyClick);
        body.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { const t = e.target.closest('[data-item],[data-day],[data-slot]'); if (t) { e.preventDefault(); onBodyClick({ target: t, preventDefault() {} }); } } });
    }
    function step(n) {
        if (state.view === 'month') setDate(shiftMonth(state.date, n));
        else if (state.view === 'week') setDate(L.addDays(state.date, 7 * n));
        else if (state.view === 'day') setDate(L.addDays(state.date, n));
        else setDate(L.addDays(state.date, 30 * n));
    }
    function setDate(d) { state.date = d; syncUrl(); load(); }
    function setView(v) {
        state.view = v; syncUrl();
        view.querySelectorAll('#views button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
        load();
    }

    /* ------------------------------------------------------------ render */
    function chip(it, opts) {
        const time = !it.allDay && it.startIso ? `<span class="tm">${esc(L.fmtTime(it.startIso).replace(/:00/, ''))}</span>` : '';
        return `<div class="cal-ev ${esc(it.cls || '')}" data-item="${esc(it.key)}" role="button" tabindex="0" title="${esc(it.tip || it.title)}">${opts && opts.noTime ? '' : time}<span>${esc(it.title)}</span></div>`;
    }
    function renderBody() {
        const body = view.querySelector('#body'); if (!body) return;
        view.querySelector('#title').textContent = titleText();
        view.querySelector('#jump').value = state.date;
        if (state.loading && !state.items.length) { body.innerHTML = `<div class="ws-card"><div class="crm-skel-rows" style="padding:8px 4px">${[90, 70, 80, 60].map(w => `<span class="ws-skel" style="display:block;width:${w}%"></span>`).join('')}</div></div>`; return; }
        const items = visibleItems();
        const count = view.querySelector('#count');
        if (count) count.textContent = `${items.length} item${items.length === 1 ? '' : 's'} in view${state.loading ? ' · refreshing…' : ''}`;
        let html = state.eventsMissing ? C.migrationNoticeHtml() : '';
        if (state.view === 'month') html += renderMonth(items);
        else if (state.view === 'agenda') html += renderAgenda(items);
        else html += renderWeek(items, state.view === 'day' ? [state.date] : Array.from({ length: 7 }, (_, i) => L.addDays(weekStart(state.date), i)));
        body.innerHTML = html;
        if (state.view === 'week' || state.view === 'day') {
            const sc = body.querySelector('.cal-scroll');
            if (sc) sc.scrollTop = 8 * HOUR_PX - 8;
        }
    }
    function renderMonth(items) {
        const today = L.todayIST();
        const first = monthStart(state.date), mon = first.slice(0, 7);
        const start = weekStart(first);
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
        const head = `<div class="h"></div>` + days.map(d => `<div class="h${d === today ? ' today' : ''}">${DAY_NAMES[L.isoWeekday(d) - 1]}<b>${Number(d.slice(8))}</b></div>`).join('');
        const allday = `<div class="allday gutter" style="border-right:1px solid var(--ws-border)"></div>` + days.map(d => `<div class="allday" data-day="${d}">${itemsOn(d, items).filter(it => it.allDay).map(it => chip(it, { noTime: true })).join('')}</div>`).join('');
        const gutter = `<div class="gutter">${Array.from({ length: 24 }, (_, hh) => `<div class="hour">${hh === 0 ? '' : (hh % 12 || 12) + (hh < 12 ? 'am' : 'pm')}</div>`).join('')}</div>`;
        const nowMin = (() => { const [hh, mm] = L.istTime(new Date()).split(':').map(Number); return hh * 60 + mm; })();
        const cols = days.map(d => {
            const timed = itemsOn(d, items).filter(it => !it.allDay && it.startIso);
            // Simple overlap layout: assign columns greedily.
            const placed = [];
            timed.forEach(it => {
                const s = minutesOn(it.startIso, d), e = Math.max(s + 20, minutesOn(it.endIso || it.startIso, d) || s + 30);
                let lane = 0; while (placed.some(p => p.lane === lane && p.s < e && p.e > s)) lane++;
                placed.push({ it, s, e, lane });
            });
            const lanes = Math.max(1, ...placed.map(p => p.lane + 1));
            const evs = placed.map(p => {
                const w = 100 / lanes;
                return `<div class="cal-ev ${esc(p.it.cls || '')}" data-item="${esc(p.it.key)}" role="button" tabindex="0" title="${esc(p.it.tip || p.it.title)}" style="top:${p.s / 60 * HOUR_PX}px;height:${Math.max(22, (p.e - p.s) / 60 * HOUR_PX - 2)}px;left:calc(${p.lane * w}% + 2px);right:auto;width:calc(${w}% - 4px)"><span class="tm">${esc(L.fmtTime(p.it.startIso))}</span><span>${esc(p.it.title)}</span></div>`;
            }).join('');
            const slots = Array.from({ length: 24 }, (_, hh) => `<div class="hour" data-slot="${d}T${String(hh).padStart(2, '0')}:00"></div>`).join('');
            return `<div class="col">${slots}${evs}${d === today ? `<div class="nowline" style="top:${nowMin / 60 * HOUR_PX}px"></div>` : ''}</div>`;
        }).join('');
        return `<div class="cal-week${days.length === 1 ? ' day' : ''}">${head}${allday}</div>
            <div class="cal-scroll"><div class="cal-week${days.length === 1 ? ' day' : ''}" style="border-top:0;border-radius:0 0 10px 10px">${gutter}${cols}</div></div>`;
    }
    function renderAgenda(items) {
        const today = L.todayIST();
        let html = '<div class="ws-card cal-agenda">';
        let any = false;
        for (let i = 0; i < 30; i++) {
            const day = L.addDays(state.date, i);
            const list = itemsOn(day, items);
            if (!list.length) continue;
            any = true;
            html += `<div class="day-h${day === today ? ' today' : ''}">${day === today ? 'Today · ' : ''}${DAY_NAMES[L.isoWeekday(day) - 1]}, ${esc(L.fmtDate(day))}</div><ul class="crm-list compact">`;
            list.forEach(it => {
                const when = it.allDay ? 'All day' : `${L.fmtTime(it.startIso)}${it.endIso && it.kind === 'event' ? ' – ' + L.fmtTime(it.endIso) : ''}`;
                const who = it.kind === 'event' ? C.personName(it.ev.owner_id) : it.kind === 'task' ? C.personName(it.task.assignee_id) : it.kind === 'followup' ? C.personName(it.lead.owner_id) : (it.tip || '');
                html += `<li data-item="${esc(it.key)}" role="button" tabindex="0" style="cursor:pointer"><span class="cal-ev ${esc(it.cls || '')}" style="min-width:74px;justify-content:center">${esc(when)}</span><div class="main"><b>${esc(it.title)}</b><span>${esc(who)}${it.kind === 'event' && it.ev.location ? ' · ' + esc(it.ev.location) : ''}</span></div></li>`;
            });
            html += '</ul>';
        }
        if (!any) html += `<div class="ws-empty"><b>Nothing scheduled</b><div>No meetings, due dates or holidays in the next 30 days from ${esc(L.fmtDate(state.date))}.</div><div style="margin-top:12px"><button type="button" class="ws-btn primary" onclick="document.getElementById('new-btn').click()">${C.icon('plus')}<span>Schedule</span></button></div></div>`;
        return html + '</div>';
    }

    /* ------------------------------------------------------------ clicks */
    function onBodyClick(e) {
        const more = e.target.closest('[data-more]');
        if (more) { e.preventDefault(); state.date = more.dataset.more; setView('day'); return; }
        const chipEl = e.target.closest('[data-item]');
        if (chipEl) { e.preventDefault(); openItem(chipEl.dataset.item); return; }
        const slot = e.target.closest('[data-slot]');
        if (slot) { const [d, t] = slot.dataset.slot.split('T'); openCreate({ starts_at: L.isoAtIST(d, t), ends_at: L.isoAtIST(d, `${String(Math.min(23, Number(t.slice(0, 2)) + 1)).padStart(2, '0')}:00`) }); return; }
        const dayEl = e.target.closest('[data-day]');
        if (dayEl) {
            if (state.view === 'month' && window.innerWidth < 760) { state.date = dayEl.dataset.day; setView('day'); return; }
            openCreate({ starts_at: L.isoAtIST(dayEl.dataset.day, '10:00'), ends_at: L.isoAtIST(dayEl.dataset.day, '11:00'), all_day: dayEl.classList.contains('allday') });
        }
    }
    function openCreate(defaults) {
        C.openEventEditor({ defaults: defaults || { starts_at: L.isoAtIST(state.date, '10:00'), ends_at: L.isoAtIST(state.date, '11:00') }, onSaved: load });
    }
    function openItem(key) {
        const it = state.items.find(x => x.key === key); if (!it) return;
        if (it.kind === 'event') return openEvent(it.ev.id);
        if (it.href) { location.href = it.href; return; }
        C.toast(it.tip ? `${it.title} · ${it.tip}` : it.title, '');
    }

    /* ------------------------------------------------------ event detail */
    async function openEvent(id) {
        let ev;
        try {
            const r = await C.q(sb.from('calendar_events').select('*, participants:event_participants(user_id, response)').eq('id', id).maybeSingle());
            ev = r.data;
        } catch (e) { return C.toast(e.message, 'bad'); }
        if (!ev) return C.toast('That event was not found, or you do not have access to it.', 'bad');
        const mine = ev.owner_id === me.id || ev.created_by === me.id;
        const canEdit = mine || ctx.isManager;
        const myPart = (ev.participants || []).find(p => p.user_id === me.id);
        const links = ['contact', 'lead', 'deal', 'project'].filter(k => ev[k + '_id']);
        const labels = {};
        await Promise.all(links.map(async k => { labels[k] = await C.entityLabel(k, ev[k + '_id']).catch(() => ''); }));
        const when = ev.all_day
            ? (L.istDate(ev.starts_at) === L.istDate(ev.ends_at) ? `${L.fmtDate(ev.starts_at)} · All day` : `${L.fmtDate(ev.starts_at)} – ${L.fmtDate(ev.ends_at)} · All day`)
            : (L.istDate(ev.starts_at) === L.istDate(ev.ends_at) ? `${L.fmtDate(ev.starts_at)}, ${L.fmtTime(ev.starts_at)} – ${L.fmtTime(ev.ends_at)}` : `${L.fmtDateTime(ev.starts_at)} – ${L.fmtDateTime(ev.ends_at)}`);
        const body = document.createElement('div');
        body.innerHTML = `
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">${C.statusBadge(L.EVENT_TYPE, ev.event_type)}${ev.status === 'cancelled' ? C.badge('mute', 'Cancelled') : ''}${ev.visibility === 'private' ? C.badge('info', 'Private') : ''}</div>
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
        const actions = [];
        actions.push({ label: 'Add to my tasks', onClick: api => { api.close(); C.openTaskEditor({ defaults: { title: ev.title, due_date: L.istDate(ev.starts_at), contact_id: ev.contact_id || undefined, deal_id: ev.deal_id || undefined, project_id: ev.project_id || undefined } }); } });
        if (canEdit && ev.status !== 'cancelled') actions.push({ label: 'Cancel event', danger: true, onClick: async api => {
            if (!await C.confirm({ title: 'Cancel this event?', message: 'Participants are notified and the event stays on the calendar, struck through.', okText: 'Cancel event', danger: true })) return;
            await C.q(sb.from('calendar_events').update({ status: 'cancelled' }).eq('id', ev.id));
            (ev.participants || []).forEach(p => C.pushNotify({ to: p.user_id, title: 'Meeting cancelled', body: ev.title, url: `/calendar/?id=${ev.id}`, tag: 'event' }));
            C.toast('Event cancelled', 'ok'); api.close(); load();
        } });
        if (canEdit) actions.push({ label: 'Delete', danger: true, onClick: async api => {
            if (!await C.confirm({ title: 'Delete this event permanently?', message: 'Cancelling keeps a record; deleting removes it for everyone.', okText: 'Delete', danger: true })) return;
            await C.q(sb.from('calendar_events').delete().eq('id', ev.id));
            C.toast('Event deleted', 'ok'); api.close(); load();
        } });
        if (canEdit) actions.push({ label: 'Edit', primary: true, onClick: api => { api.close(); C.openEventEditor({ event: ev, participants: (ev.participants || []).map(p => p.user_id), onSaved: () => { load(); openEvent(ev.id); } }); } });
        else actions.push({ label: 'Close', close: true });
        const m = C.modal({ title: ev.title, size: 'wide', body, actions, onClose: () => { if (C.param('id') === ev.id) C.setParam('id', null, true); } });
        const feed = C.activityFeed(body.querySelector('#ev-activity'), { entity_type: 'event', entity_id: ev.id, limit: 30 });
        C.comments(body.querySelector('#ev-composer'), { entity_type: 'event', entity_id: ev.id, onPosted: () => feed.reload() });
        const rsvp = body.querySelector('#rsvp');
        if (rsvp) rsvp.addEventListener('click', async e => {
            const b = e.target.closest('[data-rsvp]'); if (!b) return;
            try {
                await C.q(sb.from('event_participants').update({ response: b.dataset.rsvp }).eq('event_id', ev.id).eq('user_id', me.id));
                rsvp.querySelectorAll('button').forEach(x => x.classList.toggle('primary', x === b));
                if (ev.owner_id !== me.id) C.pushNotify({ to: ev.owner_id, title: `${me.name} ${b.dataset.rsvp} your meeting`, body: ev.title, url: `/calendar/?id=${ev.id}`, tag: 'event' });
                C.toast('Response saved', 'ok');
            } catch (err) { C.toast(err.message, 'bad'); }
        });
        return m;
    }

    /* ---------------------------------------------------------- reminders */
    function checkReminders() {
        const now = Date.now();
        state.items.filter(it => it.kind === 'event' && it.ev.reminder_minutes && it.ev.status !== 'cancelled' && isMine(it)).forEach(it => {
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
    await load();
    C.subscribe('calendar', [{ table: 'calendar_events' }], reloadSoon);
    if (C.param('id')) openEvent(C.param('id'));
    if (C.param('new') === '1') { C.setParam('new', null, true); openCreate(); }
    window.addEventListener('popstate', () => {
        const p = new URLSearchParams(location.search);
        if (VIEWS.includes(p.get('view'))) state.view = p.get('view');
        if (L.dayNumber(p.get('date')) != null) state.date = p.get('date');
        view.querySelectorAll('#views button').forEach(b => b.classList.toggle('on', b.dataset.view === state.view));
        load();
    });
})();
