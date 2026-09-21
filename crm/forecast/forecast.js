/* ============================================================================
   Sales forecast — Salesforce-style categories per month from real deals,
   targets (quota) per person, and win/loss with the reasons deals were lost.

     Closed     won deals closed in the month
     Commit     open deals expected that month at >= 70% probability
     Best case  every open deal expected that month
     Pipeline   probability-weighted open value expected that month

   The arithmetic is WSCrmLogic.forecast / winLoss (unit-tested). Targets are
   crm_sales_targets (supabase-crm-sales-migration.sql); managers edit them here.

   URL params: months=3|6|12  owner=<uuid|me>  pipeline=<uuid>  currency=INR
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'forecast', crumb: 'Sales forecast' });
    const sb = ctx.sb, me = ctx.user;
    const lk = await C.lookups();
    const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED'];
    const f = {
        months: [3, 6, 12].includes(Number(C.param('months'))) ? Number(C.param('months')) : 3,
        owner: C.param('owner') || '', pipeline: C.param('pipeline') || '',
        currency: CURRENCIES.includes(C.param('currency')) ? C.param('currency') : 'INR',
    };
    const ownerId = () => (f.owner === 'me' ? me.id : f.owner || null);
    function persist() { ['months', 'owner', 'pipeline', 'currency'].forEach(k => C.setParam(k, f[k] && !(k === 'months' && f[k] === 3) && !(k === 'currency' && f[k] === 'INR') ? f[k] : null, true)); }

    const today = L.todayIST();
    const monthName = k => { const [y, m] = k.split('-').map(Number); return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`; };
    const money = v => L.moneyShort(v, f.currency);

    function render() {
        document.title = 'Sales forecast · WorkSuite';
        view.innerHTML = `
            <div class="ws-page-head">
                <div><p class="ws-eyebrow">CRM</p><h1>Sales forecast</h1><p>What will close, against target, from the deals in the pipeline. Commit is open deals at ${L.COMMIT_PROBABILITY}% or more.</p></div>
                <div class="actions"><a class="ws-btn" href="/deals/">${C.icon('deal')}<span>Deals</span></a><a class="ws-btn" href="/quotes/">${C.icon('doc')}<span>Quotes</span></a></div>
            </div>
            <div class="crm-toolbar">
                <div class="crm-seg" id="seg">${[3, 6, 12].map(n => `<button type="button" data-months="${n}" class="${f.months === n ? 'on' : ''}">${n} months</button>`).join('')}</div>
                <span class="spacer"></span>
                <select id="owner" aria-label="Responsible"><option value="">Everyone</option><option value="me" ${f.owner === 'me' ? 'selected' : ''}>Me</option>${C.peopleOptions(f.owner !== 'me' ? f.owner : '', { none: null })}</select>
                <select id="pipeline" aria-label="Pipeline"><option value="">All pipelines</option>${lk.pipelines.map(p => `<option value="${esc(p.id)}" ${f.pipeline === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
                <select id="currency" aria-label="Currency">${CURRENCIES.map(c => `<option ${f.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
            </div>
            <div class="crm-kpis" id="kpis">${Array.from({ length: 5 }, () => '<div class="crm-kpi"><span class="ws-skel" style="display:block;height:12px;width:50%"></span><span class="ws-skel" style="display:block;height:26px;width:70%;margin-top:10px"></span></div>').join('')}</div>
            <div class="ws-card flush" style="margin-top:8px"><div class="ws-card-head"><h3>By month</h3><span class="sub" id="overdue"></span></div><div id="months"></div></div>
            <div class="ws-grid c2" style="margin-top:14px">
                <div class="ws-card"><div class="crm-section-title"><h3>This month by person</h3>${ctx.isManager ? '<div class="right"><span class="muted" style="font-size:12px">Click a target to set it</span></div>' : ''}</div><div id="people"></div></div>
                <div class="ws-card"><div class="crm-section-title"><h3>Win / loss · last 90 days</h3></div><div id="winloss"></div></div>
            </div>`;
        view.querySelector('#seg').addEventListener('click', e => { const b = e.target.closest('[data-months]'); if (!b) return; f.months = Number(b.dataset.months); persist(); render(); load(); });
        ['owner', 'pipeline', 'currency'].forEach(k => view.querySelector('#' + k).addEventListener('change', e => { f[k] = e.target.value; persist(); render(); load(); }));
    }

    /** Every row the query returns, a page at a time (PostgREST caps a response at 1,000). */
    async function all(build) {
        const out = [];
        for (let from = 0; from < 10000; from += 1000) {
            const { data } = await C.q(build().range(from, from + 999));
            out.push(...(data || []));
            if (!data || data.length < 1000) break;
        }
        return out;
    }

    async function load() {
        const months = L.monthKeys(today, f.months);
        const first = months[0] + '-01';
        const last = L.addDays(L.monthKeys(months[months.length - 1], 2)[1] + '-01', -1);
        const since = L.addDays(today, -90);
        const owner = ownerId();
        const cols = 'id, title, owner_id, pipeline_id, value, currency, probability, status, expected_close_date, actual_close_date, created_at, archived_at';
        const scope = b => { b = b.is('archived_at', null).eq('currency', f.currency); if (owner) b = b.eq('owner_id', owner); if (f.pipeline) b = b.eq('pipeline_id', f.pipeline); return b; };
        let open, closed, lostRows, targets;
        try {
            const reasonCol = (await sb.from('crm_deals').select('lost_reason').limit(1)).error ? '' : ', lost_reason';
            [open, closed, targets] = await Promise.all([
                all(() => scope(sb.from('crm_deals').select(cols)).eq('status', 'open').order('id')),
                all(() => scope(sb.from('crm_deals').select(cols + reasonCol)).in('status', ['won', 'lost']).gte('actual_close_date', since < first ? since : first).lte('actual_close_date', last).order('id')),
                sb.from('crm_sales_targets').select('id, owner_id, period_start, amount, currency').gte('period_start', first).lte('period_start', last).then(r => (r.error ? null : r.data || [])),
            ]);
            lostRows = closed;
        } catch (e) { return C.errorState(view.querySelector('#months'), e, load); }

        const fc = L.forecast(open.concat(closed), months, { currency: f.currency });
        const wl = L.winLoss(lostRows.filter(d => d.actual_close_date >= since), { currency: f.currency });
        const tgt = (month, who) => (targets || []).filter(t => t.period_start.slice(0, 7) === month && (t.currency || 'INR') === f.currency
            && (who === undefined ? (owner ? t.owner_id === owner : !t.owner_id) : t.owner_id === who)).reduce((a, t) => a + Number(t.amount || 0), 0);
        const targetFor = m => { const own = tgt(m); if (own || owner) return own; return (targets || []).filter(t => t.period_start.slice(0, 7) === m && t.owner_id && (t.currency || 'INR') === f.currency).reduce((a, t) => a + Number(t.amount || 0), 0); };
        const totalTarget = months.reduce((a, m) => a + targetFor(m), 0);
        const att = L.attainment(fc.totals.closed, totalTarget);

        const kpi = o => `<div class="crm-kpi ${o.cls || ''}"><div class="lbl">${esc(o.label)}</div><div class="val">${esc(o.value)}</div>${o.sub ? `<div class="sub">${esc(o.sub)}</div>` : ''}</div>`;
        view.querySelector('#kpis').innerHTML = [
            kpi({ label: 'Closed won', value: money(fc.totals.closed), sub: totalTarget ? `${att}% of ${money(totalTarget)} target` : 'no target set', cls: att != null && att >= 100 ? 'ok' : '' }),
            kpi({ label: 'Commit', value: money(fc.totals.commit), sub: `closed + commit ${money(fc.totals.closed + fc.totals.commit)}` }),
            kpi({ label: 'Best case', value: money(fc.totals.bestCase), sub: 'every open deal in the period' }),
            kpi({ label: 'Weighted pipeline', value: money(fc.totals.pipeline), sub: 'value × probability' }),
            kpi({ label: 'Win rate', value: wl.win_rate == null ? '—' : wl.win_rate + '%', sub: wl.avg_cycle_days == null ? `${wl.won} won · ${wl.lost} lost` : `${wl.won} won · ${wl.lost} lost · ${wl.avg_cycle_days} days to win` }),
        ].join('');
        view.querySelector('#overdue').innerHTML = fc.overdue.count
            ? `<a href="/deals/" class="crm-due overdue">${fc.overdue.count} open deal${fc.overdue.count === 1 ? '' : 's'} (${esc(money(fc.overdue.value))}) past or without an expected close date</a>` : '';

        const maxV = Math.max(1, ...fc.months.map(m => Math.max(m.closed + m.bestCase, targetFor(m.month))));
        const bar = (v, cls) => `<span class="ws-bar ${cls || ''}" style="min-width:80px"><i style="width:${Math.round(v / maxV * 100)}%"></i></span>`;
        C.table(view.querySelector('#months'), {
            rows: fc.months.map(m => ({ ...m, target: targetFor(m.month) })),
            columns: [
                { key: 'month', label: 'Month', lead: true, render: m => `<span class="primary-text">${esc(monthName(m.month))}</span>` },
                { key: 'target', label: 'Target', num: true, render: m => m.target ? esc(money(m.target)) : '<span class="muted">—</span>' },
                { key: 'closed', label: 'Closed won', num: true, render: m => `<b>${esc(money(m.closed))}</b>` },
                { key: 'commit', label: 'Commit', num: true, render: m => esc(money(m.commit)) },
                { key: 'bestCase', label: 'Best case', num: true, render: m => esc(money(m.bestCase)) },
                { key: 'pipeline', label: 'Weighted', num: true, render: m => esc(money(m.pipeline)) },
                { key: 'att', label: 'Attainment', value: m => L.attainment(m.closed, m.target) || 0, render: m => { const a = L.attainment(m.closed, m.target); return a == null ? '<span class="muted">—</span>' : `${bar(Math.min(m.closed, maxV))} <b>${a}%</b>`; } },
            ],
            empty: { title: 'Nothing in this period', sub: 'Set expected close dates on open deals to see them here.' },
        });

        // This month by person: targets, closed, commit, weighted.
        const month = months[0];
        const byPerson = new Map();
        const row = id => { if (!byPerson.has(id)) byPerson.set(id, { owner_id: id, target: 0, closed: 0, commit: 0, pipeline: 0 }); return byPerson.get(id); };
        open.concat(closed).forEach(d => {
            if (!d.owner_id) return;
            if (d.status === 'won' && L.monthKey(d.actual_close_date) === month) row(d.owner_id).closed += Number(d.value) || 0;
            if (d.status === 'open' && L.monthKey(d.expected_close_date) === month) {
                const p = Number(d.probability) || 0, r = row(d.owner_id);
                r.pipeline += (Number(d.value) || 0) * p / 100;
                if (p >= L.COMMIT_PROBABILITY) r.commit += Number(d.value) || 0;
            }
        });
        (targets || []).filter(t => t.owner_id && t.period_start.slice(0, 7) === month && (t.currency || 'INR') === f.currency && (!owner || t.owner_id === owner)).forEach(t => { row(t.owner_id).target += Number(t.amount) || 0; });
        if (ctx.isManager && !owner) C.activePeople().filter(p => !p.company || !me.company || p.company === me.company).slice(0, 200).forEach(p => row(p.id));
        const people = [...byPerson.values()].sort((a, b) => b.closed - a.closed || b.commit - a.commit || b.target - a.target || C.personName(a.owner_id).localeCompare(C.personName(b.owner_id)));
        C.table(view.querySelector('#people'), {
            rows: people.filter(p => p.target || p.closed || p.commit || p.pipeline || ctx.isManager),
            columns: [
                { key: 'owner_id', label: 'Person', lead: true, value: p => C.personName(p.owner_id), render: p => C.personHtml(p.owner_id, { link: false }) },
                { key: 'target', label: 'Target', num: true, render: p => ctx.isManager && targets ? `<button type="button" class="ws-btn sm ghost" data-target="${esc(p.owner_id)}">${p.target ? esc(money(p.target)) : 'Set'}</button>` : (p.target ? esc(money(p.target)) : '—') },
                { key: 'closed', label: 'Closed', num: true, render: p => `<b>${esc(money(p.closed))}</b>` },
                { key: 'commit', label: 'Commit', num: true, render: p => esc(money(p.commit)) },
                { key: 'att', label: '%', num: true, value: p => L.attainment(p.closed, p.target) || 0, render: p => { const a = L.attainment(p.closed, p.target); return a == null ? '—' : `<span class="${a >= 100 ? 'ok' : ''}">${a}%</span>`; } },
            ],
            empty: { title: 'No deals this month', sub: targets ? '' : 'Targets need supabase-crm-sales-migration.sql.' },
        });
        view.querySelector('#people').onclick = e => {
            const b = e.target.closest('[data-target]'); if (!b) return;
            const who = b.dataset.target, cur = (targets || []).find(t => t.owner_id === who && t.period_start.slice(0, 7) === month && (t.currency || 'INR') === f.currency);
            editTarget(who, month, cur);
        };

        const wlEl = view.querySelector('#winloss');
        if (!wl.won && !wl.lost) { C.empty(wlEl, 'No deals closed in the last 90 days'); return; }
        const maxR = Math.max(1, ...wl.reasons.map(r => r.count));
        wlEl.innerHTML = `
            <div class="crm-kpis" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:12px">
                <div class="crm-kpi ok"><div class="lbl">Won</div><div class="val">${wl.won}</div><div class="sub">${esc(money(wl.won_value))}</div></div>
                <div class="crm-kpi"><div class="lbl">Lost</div><div class="val">${wl.lost}</div><div class="sub">${esc(money(wl.lost_value))}</div></div>
                <div class="crm-kpi"><div class="lbl">Win rate</div><div class="val">${wl.win_rate == null ? '—' : wl.win_rate + '%'}</div></div>
            </div>
            ${wl.reasons.length ? `<h4 style="margin:4px 0 8px;font-size:13px">Why deals were lost</h4><div class="crm-bars">${wl.reasons.map(r => `<div class="row"><span class="lbl" title="${esc(r.reason)}">${esc(r.reason)}</span><span class="ws-bar"><i style="width:${Math.round(r.count / maxR * 100)}%"></i></span><span class="num">${r.count} · ${r.share}%</span></div>`).join('')}</div>` : ''}`;
    }

    async function editTarget(ownerIdValue, month, cur) {
        const done = await C.formModal({
            title: `Target · ${C.personName(ownerIdValue)} · ${monthName(month)}`,
            fields: [{ name: 'amount', label: `Amount (${f.currency})`, type: 'money', required: true, hint: 'Closed-won value expected this month. 0 removes the target.' }],
            values: { amount: cur ? Number(cur.amount) : '' },
            submitLabel: 'Save target',
            onSubmit: async v => {
                const amount = Number(v.amount) || 0;
                const company = (C.person(ownerIdValue) || {}).company || me.company;
                if (cur && !amount) await C.q(sb.from('crm_sales_targets').delete().eq('id', cur.id));
                else if (cur) await C.q(sb.from('crm_sales_targets').update({ amount, currency: f.currency }).eq('id', cur.id));
                else if (amount) await C.q(sb.from('crm_sales_targets').insert({ owner_id: ownerIdValue, company, period_start: month + '-01', amount, currency: f.currency }));
                return true;
            },
        });
        if (done) { C.toast('Target saved', 'ok'); load(); }
    }

    render();
    load();
})();
