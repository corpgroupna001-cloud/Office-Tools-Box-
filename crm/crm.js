/* ============================================================================
   CRM dashboard — real numbers from the CRM tables, filtered by date range,
   owner and (for admins) company. Every tile and widget loads on its own so a
   module that is not migrated yet only blanks its own card.

   URL params: range=today|week|month|quarter|custom  from= to=  owner=<uuid|me>  company=<name>
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'crm', crumb: 'CRM' });
    const sb = ctx.sb, me = ctx.user;
    const lk = await C.lookups();

    const PRESETS = [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['quarter', 'This quarter'], ['custom', 'Custom']];
    const f = {
        range: C.param('range') || 'month', from: C.param('from') || '', to: C.param('to') || '',
        owner: C.param('owner') || '', company: ctx.isAdmin ? (C.param('company') || '') : '',
    };
    function range() { const r = L.dateRange(f.range, new Date(), { from: f.from, to: f.to }); return r || L.dateRange('month'); }
    function ownerId() { return f.owner === 'me' ? me.id : f.owner || null; }
    function persist() { ['range', 'from', 'to', 'owner', 'company'].forEach(k => C.setParam(k, f[k] || null, true)); }

    /* Query helpers: apply the shared filters; count or rows. */
    function scoped(b, opts) {
        opts = opts || {};
        if (f.company) b = b.eq('company', f.company);
        const o = ownerId();
        if (o && opts.ownerCol) b = b.eq(opts.ownerCol, o);
        return b;
    }
    async function count(table, build, opts) {
        let b = sb.from(table).select('id', { count: 'exact', head: true });
        b = scoped(b, opts);
        if (build) b = build(b);
        const r = await b;
        if (r.error) throw r.error;
        return r.count || 0;
    }
    async function rows(table, select, build, opts, limit) {
        let b = sb.from(table).select(select).limit(limit || 1000);
        b = scoped(b, opts);
        if (build) b = build(b);
        const r = await b;
        if (r.error) throw r.error;
        return r.data || [];
    }
    function missing(e) { return C.isMissingSchema(e); }
    function widgetError(el, e) {
        el.innerHTML = missing(e)
            ? `<div class="muted" style="font-size:13px">${C.icon('lock', 'sm')} Not set up yet — run the CRM migrations.</div>`
            : `<div class="muted" style="font-size:13px">Could not load: ${esc(C.friendly(e))}</div>`;
    }
    const ownerQS = () => (ownerId() ? `&owner=${encodeURIComponent(f.owner)}` : '');

    /* ------------------------------------------------------------ layout */
    function render() {
        const r = range();
        document.title = 'CRM · WorkSuite';
        view.innerHTML = `
            <div class="ws-page-head">
                <div><p class="ws-eyebrow">CRM</p><h1>Sales &amp; work overview</h1><p>Live figures from contacts, leads, deals, tasks, projects and the calendar.</p></div>
                <div class="actions">
                    <a class="ws-btn" href="/contacts/?new=1">${C.icon('plus')}<span>Contact</span></a>
                    <a class="ws-btn" href="/leads/?new=1">${C.icon('plus')}<span>Lead</span></a>
                    <a class="ws-btn" href="/deals/?new=1">${C.icon('plus')}<span>Deal</span></a>
                    <a class="ws-btn" href="/tasks/?new=1">${C.icon('plus')}<span>Task</span></a>
                    <a class="ws-btn" href="/calendar/?new=1">${C.icon('calendar')}<span>Meeting</span></a>
                </div>
            </div>
            <div class="crm-toolbar">
                <div class="crm-seg" id="seg">${PRESETS.map(([k, l]) => `<button type="button" data-range="${k}" class="${f.range === k ? 'on' : ''}">${l}</button>`).join('')}</div>
                <span id="custom" ${f.range === 'custom' ? '' : 'hidden'} style="display:${f.range === 'custom' ? 'inline-flex' : 'none'};gap:6px;align-items:center"><input type="date" id="from" value="${esc(f.from)}" aria-label="From"><span class="muted">to</span><input type="date" id="to" value="${esc(f.to)}" aria-label="To"></span>
                <span class="crm-count">${esc(L.fmtDate(r.from))} – ${esc(L.fmtDate(r.to))}</span>
                <span class="spacer"></span>
                <select id="owner" aria-label="Owner"><option value="">Everyone</option><option value="me" ${f.owner === 'me' ? 'selected' : ''}>Me</option>${C.peopleOptions(f.owner !== 'me' ? f.owner : '', { none: null })}</select>
                ${ctx.isAdmin ? `<select id="company" aria-label="Company"><option value="">All companies</option>${(window.WSCompanies ? WSCompanies.companies : []).map(c => `<option value="${esc(c)}" ${f.company === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>` : ''}
            </div>
            <h2 class="crm-section-title" style="font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--ws-text-muted);margin:4px 0 10px">Contacts &amp; leads</h2>
            <div class="crm-kpis" id="k1">${skel(5)}</div>
            <h2 class="crm-section-title" style="font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--ws-text-muted);margin:4px 0 10px">Pipeline</h2>
            <div class="crm-kpis" id="k2">${skel(5)}</div>
            <h2 class="crm-section-title" style="font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--ws-text-muted);margin:4px 0 10px">Work</h2>
            <div class="crm-kpis" id="k3">${skel(4)}</div>
            <div class="ws-grid c2" style="margin-top:8px">
                <div class="ws-card"><div class="crm-section-title"><h3>Pipeline by stage</h3><div class="right"><a class="ws-btn sm ghost" href="/deals/?view=board">Open board</a></div></div><div id="w-stages"></div></div>
                <div class="ws-card"><div class="crm-section-title"><h3>Leads by status</h3><div class="right"><a class="ws-btn sm ghost" href="/leads/">All leads</a></div></div><div id="w-leads"></div></div>
                <div class="ws-card"><div class="crm-section-title"><h3>Deals closing in 30 days</h3><div class="right"><a class="ws-btn sm ghost" href="/deals/">All deals</a></div></div><div id="w-closing"></div></div>
                <div class="ws-card"><div class="crm-section-title"><h3>Top open deals</h3></div><div id="w-top"></div></div>
                <div class="ws-card"><div class="crm-section-title"><h3>Tasks needing attention</h3><div class="right"><a class="ws-btn sm ghost" href="/tasks/?view=overdue">Overdue</a></div></div><div id="w-tasks"></div></div>
                <div class="ws-card"><div class="crm-section-title"><h3>Upcoming meetings</h3><div class="right"><a class="ws-btn sm ghost" href="/calendar/">Calendar</a></div></div><div id="w-meetings"></div></div>
                <div class="ws-card"><div class="crm-section-title"><h3>My follow-ups</h3><div class="right"><a class="ws-btn sm ghost" href="/leads/?owner=me">My leads</a></div></div><div id="w-followups"></div></div>
                <div class="ws-card"><div class="crm-section-title"><h3>Recent CRM activity</h3></div><div id="w-activity"></div></div>
            </div>`;
        view.querySelector('#seg').addEventListener('click', e => {
            const b = e.target.closest('[data-range]'); if (!b) return;
            f.range = b.dataset.range;
            if (f.range === 'custom' && !(f.from && f.to)) { const m = L.dateRange('month'); f.from = f.from || m.from; f.to = f.to || m.to; }
            persist(); render(); load();
        });
        ['#from', '#to'].forEach(sel => view.querySelector(sel).addEventListener('change', () => { f.from = view.querySelector('#from').value; f.to = view.querySelector('#to').value; if (f.from && f.to) { persist(); render(); load(); } }));
        view.querySelector('#owner').addEventListener('change', e => { f.owner = e.target.value; persist(); render(); load(); });
        const co = view.querySelector('#company'); if (co) co.addEventListener('change', e => { f.company = e.target.value; persist(); render(); load(); });
    }
    function skel(n) { return Array.from({ length: n }, () => '<div class="crm-kpi"><span class="ws-skel" style="display:block;height:12px;width:50%"></span><span class="ws-skel" style="display:block;height:26px;width:70%;margin-top:10px"></span></div>').join(''); }
    function kpi(o) {
        const inner = `<div class="lbl">${esc(o.label)}</div><div class="val">${o.value}${o.small ? `<small>${esc(o.small)}</small>` : ''}</div>${o.sub ? `<div class="sub ${o.subCls || ''}">${esc(o.sub)}</div>` : ''}`;
        return o.href ? `<a class="crm-kpi ${o.cls || ''}" href="${esc(o.href)}">${inner}</a>` : `<div class="crm-kpi ${o.cls || ''}">${inner}</div>`;
    }
    function kpiFail(label, e) { return kpi({ label, value: '—', sub: missing(e) ? 'Not set up yet' : 'Could not load', subCls: 'bad' }); }
    function bars(items, fmt) {
        const max = Math.max(1, ...items.map(i => i.value));
        return `<div class="crm-bars">${items.map(i => `<div class="row"><span class="lbl" title="${esc(i.label)}"><span class="crm-dot ${esc(i.color || 'pending')}" style="margin-right:6px"></span>${esc(i.label)}</span><span class="ws-bar"><i style="width:${Math.round(i.value / max * 100)}%"></i></span><span class="num">${esc(fmt(i))}</span></div>`).join('')}</div>`;
    }
    const listItem = (icon, href, title, sub, right) => `<li>${C.icon(icon)}<div class="main"><b><a href="${esc(href)}">${esc(title)}</a></b><span>${sub}</span></div>${right ? `<div class="right">${right}</div>` : ''}</li>`;

    /* --------------------------------------------------------------- data */
    async function load() {
        const r = range(), iso = L.rangeToIso(r), today = L.todayIST();
        const owner = ownerId();
        const openLeadKeys = lk.leadStatuses.filter(s => !s.is_closed).map(s => s.key);

        // --- Contacts & leads tiles
        (async () => {
            const el = view.querySelector('#k1'); const out = [];
            try {
                const [total, fresh] = await Promise.all([
                    count('crm_contacts', b => b.neq('status', 'archived'), { ownerCol: 'owner_id' }),
                    count('crm_contacts', b => b.neq('status', 'archived').gte('created_at', iso.from).lt('created_at', iso.to), { ownerCol: 'owner_id' }),
                ]);
                out.push(kpi({ label: 'Total contacts', value: total, href: `/contacts/${owner ? '?owner=' + encodeURIComponent(f.owner) : ''}` }));
                out.push(kpi({ label: 'New contacts', value: fresh, sub: 'in this period', href: '/contacts/', cls: fresh ? 'ok' : '' }));
            } catch (e) { out.push(kpiFail('Total contacts', e), kpiFail('New contacts', e)); }
            try {
                const [open, qualified, created] = await Promise.all([
                    openLeadKeys.length ? count('crm_leads', b => b.in('status', openLeadKeys).is('archived_at', null), { ownerCol: 'owner_id' }) : Promise.resolve(0),
                    count('crm_leads', b => b.eq('status', 'qualified').is('archived_at', null), { ownerCol: 'owner_id' }),
                    rows('crm_leads', 'id, status, converted_at, archived_at', b => b.gte('created_at', iso.from).lt('created_at', iso.to), { ownerCol: 'owner_id' }),
                ]);
                const m = L.leadMetrics(created, lk.leadStatuses);
                out.push(kpi({ label: 'Open leads', value: open, href: `/leads/${owner ? '?owner=' + encodeURIComponent(f.owner) : ''}`, cls: 'accent' }));
                out.push(kpi({ label: 'Qualified leads', value: qualified, href: '/leads/?status=qualified' }));
                out.push(kpi({ label: 'Lead conversion', value: m.conversion_rate == null ? '—' : m.conversion_rate + '%', sub: `${m.converted} of ${m.total} created in period`, href: '/leads/?status=converted' }));
            } catch (e) { out.push(kpiFail('Open leads', e), kpiFail('Qualified leads', e), kpiFail('Lead conversion', e)); }
            el.innerHTML = out.join('');
        })();

        // --- Pipeline tiles + widgets
        (async () => {
            const el = view.querySelector('#k2');
            try {
                const [open, won, lost] = await Promise.all([
                    rows('crm_deals', 'id, title, value, currency, probability, stage_id, status, owner_id, contact_id, expected_close_date, archived_at', b => b.eq('status', 'open').is('archived_at', null), { ownerCol: 'owner_id' }, 2000),
                    rows('crm_deals', 'id, value, status, archived_at', b => b.eq('status', 'won').gte('actual_close_date', r.from).lte('actual_close_date', r.to), { ownerCol: 'owner_id' }, 2000),
                    rows('crm_deals', 'id, value, status, archived_at', b => b.eq('status', 'lost').gte('actual_close_date', r.from).lte('actual_close_date', r.to), { ownerCol: 'owner_id' }, 2000),
                ]);
                const m = L.pipelineMetrics(open), mw = L.pipelineMetrics(won), ml = L.pipelineMetrics(lost);
                const closed = mw.won_count + ml.lost_count;
                const cur = (open[0] && open[0].currency) || 'INR';
                el.innerHTML = [
                    kpi({ label: 'Open deals', value: m.open_count, href: `/deals/${owner ? '?owner=' + encodeURIComponent(f.owner) : ''}`, cls: 'accent' }),
                    kpi({ label: 'Won deals', value: mw.won_count, sub: `${L.money(mw.won_value, cur)} in period`, subCls: 'ok', href: '/deals/?status=won', cls: 'ok' }),
                    kpi({ label: 'Lost deals', value: ml.lost_count, sub: closed ? `Win rate ${Math.round(mw.won_count / closed * 100)}%` : 'No closed deals in period', href: '/deals/?status=lost', cls: ml.lost_count ? 'bad' : '' }),
                    kpi({ label: 'Pipeline value', value: esc(L.moneyShort(m.pipeline_value, cur)), sub: L.money(m.pipeline_value, cur), href: '/deals/?view=board' }),
                    kpi({ label: 'Expected value', value: esc(L.moneyShort(m.weighted_value, cur)), sub: 'value × probability', href: '/deals/' }),
                ].join('');
                // Pipeline by stage
                const stEl = view.querySelector('#w-stages');
                const pipelineIds = Array.from(new Set(open.map(d => lk.stageById[d.stage_id] && lk.stageById[d.stage_id].pipeline_id).filter(Boolean)));
                const stages = L.stagesOf(lk.stages, pipelineIds.length === 1 ? pipelineIds[0] : ((lk.defaultPipeline && lk.defaultPipeline.id) || pipelineIds[0])).filter(s => !s.is_won && !s.is_lost);
                if (!open.length) C.empty(stEl, 'No open deals', 'Deals in the pipeline will be summarised here.', `<a class="ws-btn sm" href="/deals/?new=1">${C.icon('plus')}<span>New deal</span></a>`);
                else stEl.innerHTML = bars(stages.map(s => ({ label: s.name, color: s.color, value: (m.by_stage[s.id] || { value: 0 }).value, count: (m.by_stage[s.id] || { count: 0 }).count })), i => `${i.count} · ${L.moneyShort(i.value, cur)}`) +
                    (pipelineIds.length > 1 ? '<p class="muted" style="font-size:12px;margin:10px 0 0">Several pipelines are in use; the default pipeline\'s stages are shown.</p>' : '');
                // Closing soon
                const soon = open.filter(d => d.expected_close_date && L.daysBetween(today, d.expected_close_date) <= 30).sort((a, b) => a.expected_close_date.localeCompare(b.expected_close_date)).slice(0, 8);
                const clEl = view.querySelector('#w-closing');
                if (!soon.length) C.empty(clEl, 'Nothing closing soon', 'Open deals with an expected close date in the next 30 days appear here.');
                else clEl.innerHTML = `<ul class="crm-list compact">${soon.map(d => { const days = L.daysBetween(today, d.expected_close_date); return listItem('deal', `/deals/?id=${d.id}`, d.title, `${esc(lk.stageById[d.stage_id] ? lk.stageById[d.stage_id].name : '')} · ${esc(C.personName(d.owner_id))}`, `<span class="crm-due ${days < 0 ? 'overdue' : days === 0 ? 'today' : 'soon'}">${days < 0 ? Math.abs(days) + 'd late' : days === 0 ? 'Today' : days + 'd'}</span><b style="font-size:13px">${esc(L.moneyShort(d.value, d.currency))}</b>`); }).join('')}</ul>`;
                // Top open deals
                const top = open.slice().sort((a, b) => Number(b.value) - Number(a.value)).slice(0, 6);
                const tpEl = view.querySelector('#w-top');
                if (!top.length) C.empty(tpEl, 'No open deals', '');
                else tpEl.innerHTML = `<ul class="crm-list compact">${top.map(d => listItem('deal', `/deals/?id=${d.id}`, d.title, `${esc(lk.stageById[d.stage_id] ? lk.stageById[d.stage_id].name : '')} · ${d.probability}% · ${esc(C.personName(d.owner_id))}`, `<b style="font-size:13px">${esc(L.money(d.value, d.currency))}</b>`)).join('')}</ul>`;
            } catch (e) {
                el.innerHTML = ['Open deals', 'Won deals', 'Lost deals', 'Pipeline value', 'Expected value'].map(l => kpiFail(l, e)).join('');
                ['#w-stages', '#w-closing', '#w-top'].forEach(s => widgetError(view.querySelector(s), e));
            }
        })();

        // --- Leads by status widget
        (async () => {
            const el = view.querySelector('#w-leads');
            try {
                const leads = await rows('crm_leads', 'id, status, archived_at, converted_at', b => b.is('archived_at', null), { ownerCol: 'owner_id' }, 5000);
                if (!leads.length) return C.empty(el, 'No leads yet', 'Capture your first enquiry.', `<a class="ws-btn sm" href="/leads/?new=1">${C.icon('plus')}<span>New lead</span></a>`);
                const m = L.leadMetrics(leads, lk.leadStatuses);
                el.innerHTML = bars(lk.leadStatuses.slice().sort((a, b) => a.sort_order - b.sort_order).map(s => ({ label: s.label, color: s.color, value: m.by_status[s.key] || 0 })), i => String(i.value));
            } catch (e) { widgetError(el, e); }
        })();

        // --- Work tiles + tasks widget
        (async () => {
            const el = view.querySelector('#k3'); const out = [];
            let tasks = [];
            try {
                tasks = await rows('tasks', 'id, title, status, priority, due_date, assignee_id, completed_at, archived_at, project_id', b => b.is('archived_at', null).is('completed_at', null).not('due_date', 'is', null).lte('due_date', today).order('due_date'), { ownerCol: 'assignee_id' }, 2000);
                const c = L.taskCounts(tasks, today);
                out.push(kpi({ label: 'Overdue tasks', value: c.overdue, href: `/tasks/?view=overdue${owner ? '&owner=' + encodeURIComponent(f.owner) : ''}`, cls: c.overdue ? 'bad' : '' }));
                out.push(kpi({ label: 'Due today', value: c.due_today, href: '/tasks/?view=today', cls: c.due_today ? 'warn' : '' }));
            } catch (e) { out.push(kpiFail('Overdue tasks', e), kpiFail('Due today', e)); widgetError(view.querySelector('#w-tasks'), e); tasks = null; }
            try {
                const active = await count('projects', b => b.eq('status', 'active').is('archived_at', null), { ownerCol: 'manager_id' });
                out.push(kpi({ label: 'Active projects', value: active, href: '/projects/?status=active' }));
            } catch (e) { out.push(kpiFail('Active projects', e)); }
            let events = null;
            try {
                const now = new Date(), week = new Date(now.getTime() + 7 * 86400000);
                events = await rows('calendar_events', 'id, title, starts_at, ends_at, event_type, owner_id, contact_id, deal_id, status', b => b.eq('status', 'scheduled').gte('ends_at', now.toISOString()).lte('starts_at', week.toISOString()).order('starts_at'), { ownerCol: 'owner_id' }, 200);
                out.push(kpi({ label: 'Upcoming meetings', value: events.length, sub: 'next 7 days', href: '/calendar/' }));
            } catch (e) { out.push(kpiFail('Upcoming meetings', e)); widgetError(view.querySelector('#w-meetings'), e); }
            el.innerHTML = out.join('');
            if (tasks) {
                const tEl = view.querySelector('#w-tasks');
                if (!tasks.length) C.empty(tEl, 'Nothing overdue', 'No open tasks are due today or earlier.');
                else tEl.innerHTML = `<ul class="crm-list compact">${tasks.slice(0, 10).map(t => listItem('tasks', `/tasks/?id=${t.id}`, t.title, `${esc(C.personName(t.assignee_id))} · ${C.priorityBadge(t.priority)}`, C.dueHtml(t, today))).join('')}</ul>${tasks.length > 10 ? `<p class="muted" style="font-size:12.5px;margin:10px 0 0"><a class="crm-link" href="/tasks/?view=overdue">${tasks.length - 10} more…</a></p>` : ''}`;
            }
            if (events) {
                const mEl = view.querySelector('#w-meetings');
                if (!events.length) C.empty(mEl, 'No meetings this week', 'Scheduled events for the next 7 days appear here.', `<a class="ws-btn sm" href="/calendar/?new=1">${C.icon('plus')}<span>Schedule</span></a>`);
                else mEl.innerHTML = `<ul class="crm-list compact">${events.slice(0, 8).map(e => listItem('calendar', `/calendar/?id=${e.id}`, e.title, `${esc(L.fmtDateTime(e.starts_at))} · ${esc(C.personName(e.owner_id))}`, C.statusBadge(L.EVENT_TYPE, e.event_type))).join('')}</ul>`;
            }
        })();

        // --- My follow-ups
        (async () => {
            const el = view.querySelector('#w-followups');
            try {
                const due = await rows('crm_leads', 'id, name, organization, status, next_follow_up_at, estimated_value, currency', b => b.eq('owner_id', me.id).is('archived_at', null).in('status', openLeadKeys.length ? openLeadKeys : ['new']).not('next_follow_up_at', 'is', null).lte('next_follow_up_at', L.isoEndOfIST(today)).order('next_follow_up_at'), {}, 20);
                if (!due.length) return C.empty(el, 'No follow-ups due', 'Leads you own with a follow-up date up to today appear here.');
                el.innerHTML = `<ul class="crm-list compact">${due.map(l => { const d = L.daysBetween(today, L.istDate(l.next_follow_up_at)); return listItem('target', `/leads/?id=${l.id}`, l.name, `${esc(l.organization || '')}${l.organization ? ' · ' : ''}${esc(lk.leadStatus[l.status] ? lk.leadStatus[l.status].label : l.status)}`, `<span class="crm-due ${d < 0 ? 'overdue' : 'today'}">${d < 0 ? Math.abs(d) + 'd overdue' : 'Today'}</span>`); }).join('')}</ul>`;
            } catch (e) { widgetError(el, e); }
        })();

        // --- Recent activity (RLS scopes to the company; owner filter narrows to that actor)
        try {
            C.activityFeed(view.querySelector('#w-activity'), { limit: 25, withComments: false, actor_id: owner || undefined, company: f.company || undefined, from: iso.from, to: iso.to });
        } catch (e) { widgetError(view.querySelector('#w-activity'), e); }
    }

    render();
    load();
})();
