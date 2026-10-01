/* ============================================================================
   CRM dashboard — real numbers from the CRM tables, filtered by date range,
   owner and (for admins) company. Every tile and widget loads on its own so a
   module that is not migrated yet only blanks its own card.

   URL params: range=today|week|month|quarter|custom  from= to=  owner=<uuid|me>  company=<name>  currency=<ISO code>

   Totals come from the database (crm_deal_summary / crm_lead_summary,
   supabase-crm-summary-migration.sql), over every row the person may see and
   per currency: a rupee is never added to a dollar. When deals use more than
   one currency a "Values in" picker chooses which one the value tiles, the
   stage bars and the top deals show; the others are listed next to them.
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
        currency: /^[A-Z]{3}$/.test(C.param('currency') || '') ? C.param('currency') : '',
    };
    function range() { const r = L.dateRange(f.range, new Date(), { from: f.from, to: f.to }); return r || L.dateRange('month'); }
    function ownerId() { return f.owner === 'me' ? me.id : f.owner || null; }
    function persist() { ['range', 'from', 'to', 'owner', 'company', 'currency'].forEach(k => C.setParam(k, f[k] || null, true)); }

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
    const noFunction = e => !!e && (e.code === 'PGRST202' || e.code === '42883');

    /** Every row (a page of 1,000 at a time), up to `max`; `partial` says the cap was reached. Only for the fallback below. */
    async function allRows(table, select, build, opts, max = 10000) {
        const out = [];
        for (let from = 0; from < max; from += 1000) {
            let b = scoped(sb.from(table).select(select), opts);
            if (build) b = build(b);
            const r = await b.order('id').range(from, from + 999);
            if (r.error) throw r.error;
            out.push(...(r.data || []));
            if ((r.data || []).length < 1000) return { rows: out, partial: false };
        }
        return { rows: out, partial: true };
    }
    /** Deal totals per currency: the database adds them up; before migration 19, the browser does (paged). */
    async function dealSummary(r) {
        const res = await sb.rpc('crm_deal_summary', { p_owner: ownerId(), p_company: f.company || null, p_from: r.from, p_to: r.to });
        if (!res.error && res.data && Array.isArray(res.data.currencies)) return { ...res.data, partial: false };
        if (res.error && !noFunction(res.error)) throw res.error;
        const cols = 'id, value, currency, probability, stage_id, status, archived_at';
        const [open, closed] = await Promise.all([
            allRows('crm_deals', cols, b => b.eq('status', 'open').is('archived_at', null), { ownerCol: 'owner_id' }),
            allRows('crm_deals', cols, b => b.in('status', ['won', 'lost']).is('archived_at', null).gte('actual_close_date', r.from).lte('actual_close_date', r.to), { ownerCol: 'owner_id' }),
        ]);
        return { ...L.dealsByCurrency(open.rows.concat(closed.rows)), partial: open.partial || closed.partial };
    }
    /** Lead counts by status, and conversion among leads created in the period. */
    async function leadSummary(iso) {
        const res = await sb.rpc('crm_lead_summary', { p_owner: ownerId(), p_company: f.company || null, p_from: iso.from, p_to: iso.to });
        if (!res.error && res.data && res.data.by_status) return res.data;
        if (res.error && !noFunction(res.error)) throw res.error;
        const by_status = {};
        await Promise.all(lk.leadStatuses.map(async st => { by_status[st.key] = await count('crm_leads', b => b.eq('status', st.key).is('archived_at', null), { ownerCol: 'owner_id' }); }));
        const [created, converted] = await Promise.all([
            count('crm_leads', b => b.is('archived_at', null).gte('created_at', iso.from).lt('created_at', iso.to), { ownerCol: 'owner_id' }),
            count('crm_leads', b => b.is('archived_at', null).gte('created_at', iso.from).lt('created_at', iso.to).or('status.eq.converted,converted_at.not.is.null'), { ownerCol: 'owner_id' }),
        ]);
        return { by_status, created, created_converted: converted };
    }
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
            <div class="crm-section-title" style="margin:4px 0 10px;align-items:center"><h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--ws-text-muted);margin:0">Pipeline</h2><div class="right" id="cur-pick"></div></div>
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
                const [open, qualified, ls] = await Promise.all([
                    openLeadKeys.length ? count('crm_leads', b => b.in('status', openLeadKeys).is('archived_at', null), { ownerCol: 'owner_id' }) : Promise.resolve(0),
                    count('crm_leads', b => b.eq('status', 'qualified').is('archived_at', null), { ownerCol: 'owner_id' }),
                    leadSummary(iso),
                ]);
                const m = { total: ls.created, converted: ls.created_converted, conversion_rate: ls.created ? Math.round(ls.created_converted / ls.created * 100) : null };
                out.push(kpi({ label: 'Open leads', value: open, href: `/leads/${owner ? '?owner=' + encodeURIComponent(f.owner) : ''}`, cls: 'accent' }));
                out.push(kpi({ label: 'Qualified leads', value: qualified, href: '/leads/?status=qualified' }));
                out.push(kpi({ label: 'Lead conversion', value: m.conversion_rate == null ? '—' : m.conversion_rate + '%', sub: `${m.converted} of ${m.total} created in period`, href: '/leads/?status=converted' }));
            } catch (e) { out.push(kpiFail('Open leads', e), kpiFail('Qualified leads', e), kpiFail('Lead conversion', e)); }
            el.innerHTML = out.join('');
        })();

        // --- Pipeline tiles + widgets: per-currency totals from the database
        (async () => {
            const el = view.querySelector('#k2');
            try {
                const sum = await dealSummary(r);
                const curs = sum.currencies.map(c => c.currency);
                const cur = curs.includes(f.currency) ? f.currency : (curs[0] || 'INR');
                const pick = view.querySelector('#cur-pick');
                pick.innerHTML = curs.length > 1 ? `<label class="muted" style="font-size:12.5px;display:inline-flex;gap:6px;align-items:center">Values in <select id="currency" aria-label="Currency for values">${curs.map(c => `<option ${c === cur ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>` : '';
                const sel = pick.querySelector('#currency');
                if (sel) sel.addEventListener('change', e => { f.currency = e.target.value; persist(); render(); load(); });
                const one = sum.currencies.find(c => c.currency === cur) || { open_value: 0, weighted_value: 0 };
                const list = k => sum.currencies.map(c => ({ value: c[k], currency: c.currency }));
                const also = k => { const t = L.moneyList(list(k).filter(x => x.currency !== cur)); return t ? ` · also ${t}` : ''; };
                const closed = sum.won_count + sum.lost_count;
                const partial = sum.partial ? ' (first 10,000 deals only)' : '';
                el.innerHTML = [
                    kpi({ label: 'Open deals', value: sum.open_count, sub: partial ? 'first 10,000 deals only' : '', href: `/deals/${owner ? '?owner=' + encodeURIComponent(f.owner) : ''}`, cls: 'accent' }),
                    kpi({ label: 'Won deals', value: sum.won_count, sub: `${L.moneyList(list('won_value')) || L.moneyShort(0, cur)} in period`, subCls: 'ok', href: '/deals/?status=won', cls: 'ok' }),
                    kpi({ label: 'Lost deals', value: sum.lost_count, sub: closed ? `Win rate ${Math.round(sum.won_count / closed * 100)}%` : 'No closed deals in period', href: '/deals/?status=lost', cls: sum.lost_count ? 'bad' : '' }),
                    kpi({ label: 'Pipeline value', value: esc(L.moneyShort(one.open_value, cur)), sub: L.money(one.open_value, cur) + also('open_value') + partial, href: '/deals/?view=board' }),
                    kpi({ label: 'Expected value', value: esc(L.moneyShort(one.weighted_value, cur)), sub: 'value × probability' + also('weighted_value'), href: '/deals/' }),
                ].join('');
                // Pipeline by stage: bars by this currency's value; counts of every currency.
                const stEl = view.querySelector('#w-stages');
                const pipelineIds = Array.from(new Set(sum.stages.map(x => lk.stageById[x.stage_id] && lk.stageById[x.stage_id].pipeline_id).filter(Boolean)));
                const stages = L.stagesOf(lk.stages, pipelineIds.length === 1 ? pipelineIds[0] : ((lk.defaultPipeline && lk.defaultPipeline.id) || pipelineIds[0])).filter(st => !st.is_won && !st.is_lost);
                if (!sum.open_count) C.empty(stEl, 'No open deals', 'Deals in the pipeline will be summarised here.', `<a class="ws-btn sm" href="/deals/?new=1">${C.icon('plus')}<span>New deal</span></a>`);
                else stEl.innerHTML = bars(stages.map(st => {
                    const here = sum.stages.filter(x => x.stage_id === st.id), mine = here.find(x => x.currency === cur) || { count: 0, value: 0 };
                    const count = here.reduce((a, x) => a + x.count, 0);
                    return { label: st.name, color: st.color, value: mine.value, count, other: count - mine.count };
                }), i => `${i.count} · ${L.moneyShort(i.value, cur)}${i.other ? ` +${i.other} other currency` : ''}`) +
                    (pipelineIds.length > 1 ? '<p class="muted" style="font-size:12px;margin:10px 0 0">Several pipelines are in use; the default pipeline\'s stages are shown.</p>' : '');
                // Closing soon and the top deals: small queries of their own, never a slice of a capped download.
                const [soon, top] = await Promise.all([
                    rows('crm_deals', 'id, title, value, currency, stage_id, owner_id, expected_close_date', b => b.eq('status', 'open').is('archived_at', null).not('expected_close_date', 'is', null).lte('expected_close_date', L.addDays(today, 30)).order('expected_close_date'), { ownerCol: 'owner_id' }, 8),
                    rows('crm_deals', 'id, title, value, currency, probability, stage_id, owner_id', b => b.eq('status', 'open').is('archived_at', null).eq('currency', cur).order('value', { ascending: false }), { ownerCol: 'owner_id' }, 6),
                ]);
                const clEl = view.querySelector('#w-closing');
                if (!soon.length) C.empty(clEl, 'Nothing closing soon', 'Open deals with an expected close date in the next 30 days appear here.');
                else clEl.innerHTML = `<ul class="crm-list compact">${soon.map(d => { const days = L.daysBetween(today, d.expected_close_date); return listItem('deal', `/deals/?id=${d.id}`, d.title, `${esc(lk.stageById[d.stage_id] ? lk.stageById[d.stage_id].name : '')} · ${esc(C.personText(d.owner_id))}`, `<span class="crm-due ${days < 0 ? 'overdue' : days === 0 ? 'today' : 'soon'}">${days < 0 ? Math.abs(days) + 'd late' : days === 0 ? 'Today' : days + 'd'}</span><b style="font-size:13px">${esc(L.moneyShort(d.value, d.currency))}</b>`); }).join('')}</ul>`;
                const tpEl = view.querySelector('#w-top');
                if (!top.length) C.empty(tpEl, 'No open deals', '');
                else tpEl.innerHTML = `<ul class="crm-list compact">${top.map(d => listItem('deal', `/deals/?id=${d.id}`, d.title, `${esc(lk.stageById[d.stage_id] ? lk.stageById[d.stage_id].name : '')} · ${d.probability}% · ${esc(C.personText(d.owner_id))}`, `<b style="font-size:13px">${esc(L.money(d.value, d.currency))}</b>`)).join('')}</ul>` +
                    (curs.length > 1 ? `<p class="muted" style="font-size:12px;margin:10px 0 0">In ${esc(cur)}; choose another currency above.</p>` : '');
            } catch (e) {
                el.innerHTML = ['Open deals', 'Won deals', 'Lost deals', 'Pipeline value', 'Expected value'].map(l => kpiFail(l, e)).join('');
                ['#w-stages', '#w-closing', '#w-top'].forEach(sel => widgetError(view.querySelector(sel), e));
            }
        })();

        // --- Leads by status widget
        (async () => {
            const el = view.querySelector('#w-leads');
            try {
                const ls = await leadSummary(L.rangeToIso(range()));
                const byStatus = ls.by_status || {};
                if (!Object.values(byStatus).some(Boolean)) return C.empty(el, 'No leads yet', 'Capture your first enquiry.', `<a class="ws-btn sm" href="/leads/?new=1">${C.icon('plus')}<span>New lead</span></a>`);
                el.innerHTML = bars(lk.leadStatuses.slice().sort((a, b) => a.sort_order - b.sort_order).map(st => ({ label: st.label, color: st.color, value: byStatus[st.key] || 0 })), i => String(i.value));
            } catch (e) { widgetError(el, e); }
        })();

        // --- Work tiles + tasks widget
        (async () => {
            const el = view.querySelector('#k3'); const out = [];
            let tasks = [];
            try {
                // Counted by the database; the list is the first few, with "n more".
                const open = b => b.is('archived_at', null).is('completed_at', null);
                const [overdue, dueToday, list] = await Promise.all([
                    count('tasks', b => open(b).lt('due_date', today), { ownerCol: 'assignee_id' }),
                    count('tasks', b => open(b).eq('due_date', today), { ownerCol: 'assignee_id' }),
                    rows('tasks', 'id, title, status, priority, due_date, assignee_id, completed_at, archived_at, project_id', b => open(b).not('due_date', 'is', null).lte('due_date', today).order('due_date'), { ownerCol: 'assignee_id' }, 10),
                ]);
                tasks = list; tasks.total = overdue + dueToday;
                const c = { overdue, due_today: dueToday };
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
                const upcoming = b => b.eq('status', 'scheduled').gte('ends_at', now.toISOString()).lte('starts_at', week.toISOString());
                const [n, list] = await Promise.all([
                    count('calendar_events', upcoming, { ownerCol: 'owner_id' }),
                    rows('calendar_events', 'id, title, starts_at, ends_at, event_type, owner_id, contact_id, deal_id, status', b => upcoming(b).order('starts_at'), { ownerCol: 'owner_id' }, 8),
                ]);
                events = list;
                out.push(kpi({ label: 'Upcoming meetings', value: n, sub: 'next 7 days', href: '/calendar/' }));
            } catch (e) { out.push(kpiFail('Upcoming meetings', e)); widgetError(view.querySelector('#w-meetings'), e); }
            el.innerHTML = out.join('');
            if (tasks) {
                const tEl = view.querySelector('#w-tasks');
                if (!tasks.length) C.empty(tEl, 'Nothing overdue', 'No open tasks are due today or earlier.');
                else tEl.innerHTML = `<ul class="crm-list compact">${tasks.map(t => listItem('tasks', `/tasks/?id=${t.id}`, t.title, `${esc(C.personText(t.assignee_id))} · ${C.priorityBadge(t.priority)}`, C.dueHtml(t, today))).join('')}</ul>${tasks.total > tasks.length ? `<p class="muted" style="font-size:12.5px;margin:10px 0 0"><a class="crm-link" href="/tasks/?view=overdue">${tasks.total - tasks.length} more…</a></p>` : ''}`;
            }
            if (events) {
                const mEl = view.querySelector('#w-meetings');
                if (!events.length) C.empty(mEl, 'No meetings this week', 'Scheduled events for the next 7 days appear here.', `<a class="ws-btn sm" href="/calendar/?new=1">${C.icon('plus')}<span>Schedule</span></a>`);
                else mEl.innerHTML = `<ul class="crm-list compact">${events.map(e => listItem('calendar', `/calendar/?id=${e.id}`, e.title, `${esc(L.fmtDateTime(e.starts_at))} · ${esc(C.personText(e.owner_id))}`, C.statusBadge(L.EVENT_TYPE, e.event_type))).join('')}</ul>`;
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
