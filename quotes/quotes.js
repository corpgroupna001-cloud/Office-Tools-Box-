/* ============================================================================
   Quotes — every quote belongs to a deal (supabase-crm-sales-migration.sql).
   A list with counters and filters, a draft editor with live totals, and a
   printable record page: send, accepted / declined, revise, turn into an
   invoice.

   The database owns the number, the money columns and the status rules;
   the editor only previews totals with the invoice formulas
   (WSCrmLogic.invoiceLine / invoiceTotals, the same rounding).

   URLs:  /quotes/                 list
          /quotes/?id=<uuid>       record        /quotes/?id=<uuid>&edit=1  edit draft
          /quotes/?new=1&deal_id=  create a draft from that deal
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc, h = C.h, B = window.WSB24;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'quotes', crumb: 'Quotes', layout: 'b24' });
    const sb = ctx.sb, me = ctx.user;

    const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED'];
    const SELECT = 'id, company, quote_number, deal_id, contact_id, company_id, subject, bill_to_name, bill_to_email, bill_to_address, quote_date, valid_until, status, currency, subtotal, discount_total, tax_total, total, notes, terms, sent_at, accepted_at, declined_at, invoice_id, responsible_id, created_by, created_at, updated_at, deal:crm_deals(id, title, owner_id, created_by, pipeline_id, amount_from_products)';
    const probe = await sb.from('crm_quotes').select('id').limit(1);
    if (probe.error && C.isMissingSchema(probe.error)) {
        view.innerHTML = `<div class="b24-area pad">${C.migrationNoticeHtml()}<p class="muted" style="margin-top:10px">Quotes need <code>supabase-crm-sales-migration.sql</code>.</p></div>`;
        return;
    }
    const invLv = await B.levels('invoice');

    function badge(q) { const s = L.quoteStatus(q); const m = L.QUOTE_STATUS[s]; return C.badge(m.color, m.label) + (q.invoice_id ? ' ' + C.badge('present', 'Invoiced') : ''); }
    /** Can the signed-in person write this quote? The database decides (deal edit rights); ask once per deal. */
    const editable = new Map();
    async function canEdit(q) {
        if (!editable.has(q.deal_id)) editable.set(q.deal_id, sb.rpc('ws_deal_editable', { p_deal: q.deal_id }).then(r => !r.error && r.data === true, () => false));
        return editable.get(q.deal_id);
    }

    /* ------------------------------------------------------------ routing */
    const page = { mode: null, grid: null, filter: null };
    function route() {
        const id = C.param('id');
        if (id) return showRecord(id, C.param('edit') === '1');
        if (page.mode === 'list') return refreshList();
        return showList();
    }
    window.addEventListener('popstate', route);
    function go(url) { history.pushState(null, '', url); route(); }
    const openQuote = id => B.openRecord(`/quotes/?id=${id}`, () => refreshList());
    function refreshList() { if (page.mode !== 'list') return; loadCounters(); if (page.grid) page.grid.reload(); }

    /* --------------------------------------------------------------- list */
    function statusApply(b, v) {
        const today = L.todayIST();
        if (v === 'expired') return b.eq('status', 'sent').lt('valid_until', today);
        if (v === 'sent') return b.eq('status', 'sent').or(`valid_until.is.null,valid_until.gte.${today}`);
        if (v === 'open') return b.in('status', ['draft', 'sent']);
        return b.eq('status', v);
    }
    const FIELDS = [
        { key: 'status', title: 'Status', type: 'select', apply: statusApply, options: [
            { value: 'open', label: 'Open (draft or sent)' }, { value: 'draft', label: 'Draft' }, { value: 'sent', label: 'Sent' },
            { value: 'expired', label: 'Expired' }, { value: 'accepted', label: 'Accepted' }, { value: 'declined', label: 'Declined' },
        ] },
        { key: 'quote_date', title: 'Quote date', type: 'date', column: 'quote_date' },
        { key: 'valid_until', title: 'Valid until', type: 'date', column: 'valid_until', default: false },
        { key: 'customer', title: 'Customer', type: 'text', column: 'bill_to_name' },
        { key: 'total', title: 'Amount', type: 'number', column: 'total', default: false },
        { key: 'responsible', title: 'Responsible', type: 'user', column: 'responsible_id', options: B.peopleOptions(), none: false },
    ];
    const PRESETS = [
        { key: 'mine', title: 'My open quotes', values: { responsible: 'me', status: 'open' } },
        { key: 'open', title: 'Open quotes', values: { status: 'open' } },
        { key: 'expired', title: 'Expired', values: { status: 'expired' } },
        { key: 'accepted', title: 'Accepted', values: { status: 'accepted' } },
        { key: 'all', title: 'All quotes', values: {} },
    ];
    const scoped = b => page.filter.apply(b, { searchColumns: ['quote_number', 'bill_to_name', 'subject'] });

    async function showList() {
        page.mode = 'list';
        WSShell.setCrumb('Quotes');
        document.title = 'Quotes · WorkSuite';
        view.innerHTML = B.titleBar({ title: 'Quotes', createLabel: 'Create' }) + `
            <div class="b24-toolbar"><div class="b24-counters" id="counters"></div></div>
            <div id="body"></div>`;
        page.filter = WSFilter.mount(view.querySelector('[data-filter]'), { id: 'quotes', fields: FIELDS, presets: PRESETS, defaultPreset: 'mine', me: me.id, onChange: () => refreshList() });
        view.querySelector('[data-create]').addEventListener('click', () => pickDealAndCreate());
        view.querySelector('#counters').addEventListener('click', e => { const b = e.target.closest('[data-counter]'); if (b) page.filter.set({ status: b.dataset.counter }); });
        mountGrid(view.querySelector('#body'));
        loadCounters();
        if (C.param('new') === '1') {
            const deal = C.param('deal_id');
            ['new', 'deal_id'].forEach(k => C.setParam(k, null, true));
            if (deal) createFromDeal(deal); else pickDealAndCreate();
        }
    }
    async function loadCounters() {
        const el = view.querySelector('#counters'); if (!el) return;
        try {
            const today = L.todayIST(), month = L.dateRange('month');
            const [open, accepted] = await Promise.all([
                sb.from('crm_quotes').select('status, valid_until, total, currency').in('status', ['draft', 'sent']).limit(2000),
                sb.from('crm_quotes').select('total, currency').eq('status', 'accepted').gte('accepted_at', `${month.from}T00:00:00+05:30`).limit(2000),
            ]);
            const rows = open.data || [], acc = accepted.data || [];
            const cur = (rows[0] || acc[0] || {}).currency || 'INR';
            const sum = list => list.filter(r => (r.currency || 'INR') === cur).reduce((a, r) => a + Number(r.total || 0), 0);
            const sent = rows.filter(r => r.status === 'sent' && !(r.valid_until && r.valid_until < today));
            const expired = rows.filter(r => r.status === 'sent' && r.valid_until && r.valid_until < today);
            el.innerHTML = `
                <button type="button" class="b24-counter" data-counter="sent"><span class="n">${sent.length}</span>Awaiting answer · <b>${esc(L.money(sum(sent), cur))}</b></button>
                <button type="button" class="b24-counter${expired.length ? ' red' : ''}" data-counter="expired"><span class="n">${expired.length}</span>Expired</button>
                <button type="button" class="b24-counter green" data-counter="accepted"><span class="n">${acc.length}</span>Accepted this month · <b>${esc(L.money(sum(acc), cur))}</b></button>
                <button type="button" class="b24-counter" data-counter="draft"><span class="n">${rows.filter(r => r.status === 'draft').length}</span>Drafts</button>`;
        } catch (e) { el.innerHTML = ''; }
    }
    function mountGrid(body) {
        const host = document.createElement('div'); body.appendChild(host);
        page.grid = WSGrid.mount(host, {
            id: 'quotes', sort: { key: 'quote_date', dir: 'desc' },
            columns: [
                { key: 'quote_number', title: 'Quote #', width: 130, render: r => `<a href="/quotes/?id=${esc(r.id)}" data-open>${esc(r.quote_number)}</a>` },
                { key: 'subject', title: 'Subject', width: 220, render: r => esc(r.subject || '') },
                { key: 'status', title: 'Status', width: 160, render: badge },
                { key: 'total', title: 'Total', width: 130, align: 'right', render: r => esc(L.money(r.total, r.currency)) },
                { key: 'deal_id', title: 'Deal', width: 220, sortable: false, render: r => r.deal ? `${C.icon('deal', 'sm')} <a href="/deals/?id=${esc(r.deal_id)}" data-deal="${esc(r.deal_id)}">${esc(r.deal.title)}</a>` : '' },
                { key: 'bill_to_name', title: 'Customer', width: 200, render: r => esc(r.bill_to_name || '') },
                { key: 'valid_until', title: 'Valid until', width: 130, render: r => r.valid_until ? `<span class="crm-due ${L.quoteStatus(r) === 'expired' ? 'overdue' : ''}">${esc(L.fmtDate(r.valid_until))}</span>` : '' },
                { key: 'responsible_id', title: 'Responsible', width: 180, render: r => C.personHtml(r.responsible_id, { link: false }) },
                { key: 'quote_date', title: 'Quote date', width: 130, default: false, render: r => esc(L.fmtDate(r.quote_date)) },
                { key: 'created_at', title: 'Created on', width: 130, default: false, render: r => `<span class="muted">${esc(L.fmtDate(r.created_at))}</span>` },
            ],
            load: async ({ offset, limit, sort }) => {
                let b = scoped(sb.from('crm_quotes').select(SELECT));
                b = sort ? b.order(sort.key, { ascending: sort.dir === 'asc', nullsFirst: false }) : b.order('quote_date', { ascending: false });
                return (await C.q(b.order('created_at', { ascending: false }).range(offset, offset + limit - 1))).data || [];
            },
            count: async () => (await C.q(scoped(sb.from('crm_quotes').select('id', { count: 'exact', head: true })))).count || 0,
            onOpen: r => openQuote(r.id),
            rowMenu: r => {
                const items = [{ label: 'Open', icon: 'arrow', onClick: () => openQuote(r.id) }];
                if (r.status === 'draft') items.push({ label: 'Edit draft', icon: 'edit', onClick: () => B.openRecord(`/quotes/?id=${r.id}&edit=1`, refreshList) });
                items.push({ label: 'Print', icon: 'doc', onClick: () => { window.top.location.href = `/quotes/?id=${r.id}&print=1`; } });
                return items;
            },
            empty: { title: 'No quotes match this filter', sub: 'Create a quote from a deal: its customer and products fill it in.' },
        });
        host.addEventListener('click', e => {
            const a = e.target.closest('[data-deal]'); if (!a || e.metaKey || e.ctrlKey) return;
            e.preventDefault(); B.openRecord(`/deals/?id=${a.dataset.deal}`);
        });
    }
    view.addEventListener('click', e => {
        const a = e.target.closest('a[data-open]');
        if (!a || e.metaKey || e.ctrlKey || e.shiftKey || page.mode !== 'list') return;
        e.preventDefault();
        const id = new URL(a.href, location.href).searchParams.get('id');
        if (id) openQuote(id);
    });

    /* ------------------------------------------------------------ create */
    async function pickDealAndCreate() {
        const deal = await C.formModal({
            title: 'New quote',
            intro: '<div class="crm-info">A quote belongs to a deal. Its customer, currency and products are copied in; you can change them before sending.</div>',
            fields: [{ name: 'deal_id', label: 'Deal', type: 'entity', entity: 'deal', required: true, placeholder: 'Search deals' }],
            submitLabel: 'Create draft',
            onSubmit: v => v.deal_id,
        });
        if (deal && deal !== true) createFromDeal(deal);
    }
    async function createFromDeal(dealId) {
        try {
            const r = await sb.rpc('crm_quote_from_deal', { p_deal: dealId });
            if (r.error) throw new Error(C.friendly(r.error));
            C.toast('Draft quote created', 'ok');
            go(`/quotes/?id=${r.data}&edit=1`);
        } catch (e) { C.toast(e.message, 'bad'); }
    }

    /* ------------------------------------------------------------ status */
    async function setStatus(q, status, after) {
        const T = {
            sent: ['Mark this quote as sent?', 'Its lines are locked while the customer decides. Revise it as a draft to change them.', 'Mark sent'],
            accepted: ['Mark this quote as accepted?', 'You can then turn it into an invoice.', 'Accepted'],
            declined: ['Mark this quote as declined?', 'You can revise it as a new draft later.', 'Declined'],
            draft: ['Revise this quote as a draft?', 'The lines unlock; send it again when it is ready.', 'Revise'],
        }[status];
        let syncDeal = false;
        if (status === 'accepted' && q.deal && !q.deal.amount_from_products) {
            const r = await C.formModal({ title: T[0], intro: `<div class="crm-info">${esc(T[1])}</div>`,
                fields: [{ name: 'sync', type: 'check', label: `Set the deal amount to this quote's total (${L.money(q.total, q.currency)})`, value: true }],
                submitLabel: T[2], onSubmit: v => ({ sync: !!v.sync }) });
            if (!r || r === true) return;
            syncDeal = r.sync;
        } else if (!await C.confirm({ title: T[0], message: T[1], okText: T[2], danger: status === 'declined' })) return;
        try {
            const { data } = await C.q(sb.from('crm_quotes').update({ status }).eq('id', q.id).select('id'));
            if (!data || !data.length) throw new Error('The quote could not be updated. Reload and try again.');
            if (syncDeal) {
                const d = await sb.from('crm_deals').update({ value: Number(q.total) || 0, currency: q.currency }).eq('id', q.deal_id).select('id');
                if (d.error || !(d.data || []).length) C.toast('The quote is accepted, but the deal amount could not be changed.', '');
            }
            C.toast({ sent: 'Quote marked as sent', accepted: 'Quote accepted', declined: 'Quote declined', draft: 'Quote reopened as a draft' }[status], 'ok');
        } catch (e) { C.toast(e.message, 'bad'); return; }
        if (after) after();
    }
    async function toInvoice(q) {
        try {
            const r = await sb.rpc('crm_quote_to_invoice', { p_quote: q.id });
            if (r.error) throw new Error(C.friendly(r.error));
            C.toast('Draft invoice created', 'ok');
            window.top.location.href = `/invoices/?id=${r.data}`;
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function deleteDraft(q) {
        if (!await C.confirm({ title: `Delete draft ${q.quote_number}?`, message: 'Only drafts can be deleted. The number is not reused.', okText: 'Delete draft', danger: true })) return;
        try {
            const { data } = await C.q(sb.from('crm_quotes').delete().eq('id', q.id).select('id'));
            if (!data || !data.length) throw new Error('Only a draft on a deal you may edit can be deleted.');
            C.toast('Draft deleted', 'ok');
            if (WSShell.inSlider) { WSShell.sliderMessage('deleted', { id: q.id }); WSShell.closeSlider(); } else go('/quotes/');
        } catch (e) { C.toast(e.message, 'bad'); }
    }

    /* ------------------------------------------------------------ editor */
    function blankItem() { return { key: C.uid(), id: null, description: '', quantity: 1, unit_price: 0, discount_pct: 0, tax_rate: 0 }; }
    async function openEditor(q) {
        let items = [];
        try { items = ((await C.q(sb.from('crm_quote_items').select('*').eq('quote_id', q.id).order('position'))).data || []).map(x => ({ ...x, key: x.id })); }
        catch (e) { return C.toast(e.message, 'bad'); }
        if (!items.length) items.push(blankItem());
        const origIds = new Set(items.filter(x => x.id).map(x => x.id));
        const form = C.form([
            { name: 'subject', label: 'Subject', type: 'text', full: true, placeholder: 'What the quote is for' },
            { name: 'bill_to_name', label: 'Customer', type: 'text', required: true },
            { name: 'bill_to_email', label: 'Customer email', type: 'email' },
            { name: 'bill_to_address', label: 'Address', type: 'textarea', full: true, rows: 2 },
            { name: 'contact_id', label: 'Contact', type: 'entity', entity: 'contact', placeholder: 'Search contacts' },
            { name: 'responsible_id', label: 'Responsible', type: 'people', none: null },
            { name: 'quote_date', label: 'Quote date', type: 'date', required: true },
            { name: 'valid_until', label: 'Valid until', type: 'date', validate: (v, all) => v && all.quote_date && L.dayNumber(v) < L.dayNumber(all.quote_date) ? 'Before the quote date' : '' },
            { name: 'currency', label: 'Currency', type: 'select', options: CURRENCIES, required: true },
            { name: 'notes', label: 'Notes to customer', type: 'textarea', full: true, rows: 2 },
            { name: 'terms', label: 'Terms', type: 'textarea', full: true, rows: 2, placeholder: 'Delivery, payment terms, validity…' },
        ], q);

        const itemsWrap = h(`<div style="margin-top:18px">
            <div class="crm-section-title"><h3>Lines</h3><div class="right"><button type="button" class="ws-btn sm" data-product>${C.icon('plus')}<span>From catalogue</span></button> <button type="button" class="ws-btn sm" data-add>${C.icon('plus')}<span>Add line</span></button></div></div>
            <div class="crm-table-wrap"><table class="ws-table"><thead><tr><th style="min-width:220px">Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Disc %</th><th class="num">Tax %</th><th class="num">Line total</th><th></th></tr></thead><tbody></tbody></table></div>
            <div class="inv-sheet" style="padding:0;border:0;margin-top:12px;background:transparent"><div class="totals" id="totals"></div></div>
            <p class="muted" style="font-size:12px;margin:8px 0 0">Totals are a preview. The database computes and stores the final figures when you save.</p>
        </div>`);
        const tbody = itemsWrap.querySelector('tbody'), totalsEl = itemsWrap.querySelector('#totals');
        const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
        function renderTotals() {
            const cur = form.get().currency || 'INR', t = L.invoiceTotals(items, []);
            totalsEl.innerHTML = `<div><span>Subtotal</span><span>${esc(L.money(t.subtotal, cur))}</span></div>
                ${t.discount_total ? `<div><span>Discount</span><span>− ${esc(L.money(t.discount_total, cur))}</span></div>` : ''}
                <div><span>Tax</span><span>${esc(L.money(t.tax_total, cur))}</span></div>
                <div class="grand"><span>Total</span><span>${esc(L.money(t.total, cur))}</span></div>`;
        }
        function renderItems() {
            tbody.innerHTML = items.map(it => `<tr data-key="${esc(it.key)}">
                <td><input type="text" data-f="description" value="${esc(it.description)}" placeholder="Product or service" aria-label="Description" style="width:100%;min-width:200px"></td>
                <td class="num"><input type="number" data-f="quantity" value="${esc(it.quantity)}" min="0" step="0.001" style="width:80px" aria-label="Quantity"></td>
                <td class="num"><input type="number" data-f="unit_price" value="${esc(it.unit_price)}" min="0" step="0.01" style="width:110px" aria-label="Unit price"></td>
                <td class="num"><input type="number" data-f="discount_pct" value="${esc(it.discount_pct)}" min="0" max="100" step="0.01" style="width:72px" aria-label="Discount percent"></td>
                <td class="num"><input type="number" data-f="tax_rate" value="${esc(it.tax_rate)}" min="0" max="100" step="0.01" style="width:72px" aria-label="Tax rate"></td>
                <td class="num" data-total>${esc(L.money(L.invoiceLine(it).line_total, form.get().currency))}</td>
                <td class="actions"><button type="button" class="ws-btn sm icon" data-rm title="Remove line" aria-label="Remove line">${C.icon('x')}</button></td>
            </tr>`).join('');
            renderTotals();
        }
        tbody.addEventListener('input', e => {
            const tr = e.target.closest('tr'); const it = items.find(x => x.key === tr.dataset.key); if (!it) return;
            const f = e.target.dataset.f;
            it[f] = f === 'description' ? e.target.value : num(e.target.value);
            tr.querySelector('[data-total]').textContent = L.money(L.invoiceLine(it).line_total, form.get().currency);
            renderTotals();
        });
        tbody.addEventListener('click', e => {
            if (!e.target.closest('[data-rm]')) return;
            const i = items.findIndex(x => x.key === e.target.closest('tr').dataset.key);
            if (i >= 0) { items.splice(i, 1); if (!items.length) items.push(blankItem()); renderItems(); }
        });
        itemsWrap.querySelector('[data-add]').addEventListener('click', () => { items.push(blankItem()); renderItems(); const last = tbody.querySelector('tr:last-child input'); if (last) last.focus(); });
        itemsWrap.querySelector('[data-product]').addEventListener('click', async e => {
            const r = await sb.from('crm_products').select('id, name, price, tax_rate').eq('active', true).order('name').limit(200);
            const list = r.data || [];
            if (!list.length) return C.toast('The product catalogue is empty (CRM settings → Products).', '');
            C.menu(e.currentTarget, list.map(p => ({ label: `${p.name} · ${L.money(p.price, form.get().currency)}`, icon: 'plus', onClick: () => {
                const blank = items.length === 1 && !items[0].description ? items.pop() : null;
                items.push({ ...(blank || blankItem()), key: C.uid(), id: null, product_id: p.id, description: p.name, unit_price: Number(p.price) || 0, tax_rate: Number(p.tax_rate) || 0 });
                renderItems();
            } })));
        });
        form.field('currency').el.addEventListener('change', renderItems);
        renderItems();

        const body = document.createElement('div');
        body.append(form.el, itemsWrap);
        C.modal({
            title: `Edit draft ${q.quote_number}`, size: 'xwide', body, sticky: true,
            actions: [
                { label: 'Cancel', close: true },
                { label: 'Save changes', primary: true, onClick: async api => {
                    if (!form.validate()) return;
                    const live = items.filter(x => String(x.description || '').trim());
                    if (!live.length) { api.setMessage('Add at least one line with a description.'); return; }
                    for (let i = 0; i < live.length; i++) {
                        const it = live[i];
                        if (num(it.quantity) < 0 || num(it.unit_price) < 0) { api.setMessage(`Line ${i + 1}: quantity and unit price cannot be negative.`); return; }
                        if (num(it.discount_pct) < 0 || num(it.discount_pct) > 100 || num(it.tax_rate) < 0 || num(it.tax_rate) > 100) { api.setMessage(`Line ${i + 1}: discount and tax must be between 0 and 100%.`); return; }
                    }
                    const v = form.get();
                    await C.q(sb.from('crm_quotes').update({
                        subject: v.subject || null, bill_to_name: v.bill_to_name.trim(), bill_to_email: v.bill_to_email || null, bill_to_address: v.bill_to_address || null,
                        contact_id: v.contact_id || null, responsible_id: v.responsible_id || me.id, quote_date: v.quote_date, valid_until: v.valid_until || null,
                        currency: v.currency, notes: v.notes || null, terms: v.terms || null,
                    }).eq('id', q.id));
                    const keep = new Set(live.filter(x => x.id).map(x => x.id));
                    const removed = [...origIds].filter(x => !keep.has(x));
                    if (removed.length) { await C.q(sb.from('crm_quote_items').delete().in('id', removed)); removed.forEach(x => origIds.delete(x)); }
                    for (let i = 0; i < live.length; i++) {
                        const it = live[i];
                        const row = { position: i + 1, description: it.description.trim(), quantity: num(it.quantity), unit_price: num(it.unit_price), discount_pct: num(it.discount_pct), tax_rate: num(it.tax_rate), product_id: it.product_id || null };
                        if (it.id) await C.q(sb.from('crm_quote_items').update(row).eq('id', it.id));
                        else {
                            // Keep the new id, so a retry after a failure updates instead of adding the line twice.
                            const r = await C.q(sb.from('crm_quote_items').insert({ ...row, quote_id: q.id }).select('id').single());
                            it.id = r.data.id; origIds.add(it.id);
                        }
                    }
                    api.close();
                    C.toast('Quote saved', 'ok');
                    showRecord(q.id);
                } },
            ],
        });
    }

    /* ------------------------------------------------------------ record */
    async function showRecord(id, edit) {
        C.loading(view, 'Loading quote…');
        let q, items = [];
        try {
            q = (await C.q(sb.from('crm_quotes').select(SELECT).eq('id', id).maybeSingle())).data;
            if (q) items = (await C.q(sb.from('crm_quote_items').select('*').eq('quote_id', id).order('position'))).data || [];
        } catch (e) { return C.errorState(view, e, () => showRecord(id, edit)); }
        if (!q) { view.innerHTML = '<div class="b24-area pad"></div>'; C.empty(view.firstElementChild, 'Quote not found', 'It may have been deleted, or you may not have access to it.', '<a class="ws-btn" href="/quotes/">All quotes</a>'); return; }
        page.mode = 'record';
        if (page.grid) { page.grid.destroy(); page.grid = null; }
        const can = await canEdit(q);
        const acts = L.quoteActions(q);
        const status = L.quoteStatus(q);
        document.title = `${q.quote_number} · Quotes · WorkSuite`;
        WSShell.setCrumb(q.quote_number);
        if (edit) { C.setParam('edit', null, true); if (can && acts.edit) openEditor(q); }
        const canInvoice = can && acts.invoice && invLv.add !== 'none';
        const refresh = () => showRecord(id);

        view.innerHTML = `
            <div class="b24-card-head no-print">
                <h1 class="b24-card-title"><span class="t">${esc(q.quote_number)}</span></h1>
                <div class="sub">${badge(q)} ${esc([q.subject, q.bill_to_name].filter(Boolean).join(' · '))} · ${esc(L.fmtDate(q.quote_date))}${q.valid_until ? ` · Valid until ${esc(L.fmtDate(q.valid_until))}` : ''}</div>
                <div class="acts">
                    ${WSShell.inSlider ? '' : `<a class="b24-btn-card" href="/quotes/" data-nav>${C.icon('arrow')}<span>All quotes</span></a>`}
                    ${can && acts.send ? '<button type="button" class="b24-btn-create" data-do="sent">Mark sent</button>' : ''}
                    ${can && acts.accept ? '<button type="button" class="b24-btn-create" data-do="accepted">Accepted</button>' : ''}
                    ${canInvoice ? '<button type="button" class="b24-btn-create" data-do="invoice">Create invoice</button>' : ''}
                    ${q.invoice_id ? `<a class="b24-btn-card" target="_top" href="/invoices/?id=${esc(q.invoice_id)}">${C.icon('invoice')}<span>Open invoice</span></a>` : ''}
                    ${can && acts.edit ? `<button type="button" class="b24-btn-card" data-do="edit">${C.icon('edit')}<span>Edit</span></button>` : ''}
                    <button type="button" class="b24-btn-card" data-do="print">${C.icon('doc')}<span>Print / PDF</span></button>
                    <button type="button" class="b24-btn-card round" data-do="more" aria-label="More actions">${C.icon('more')}</button>
                </div>
            </div>
            <div class="crm-detail">
                <div class="ws-stack">
                    <div class="inv-sheet">
                        <div class="top">
                            <div class="co"><b>${esc(q.company || 'WorkSuite')}</b><div class="muted" style="font-size:13px;margin-top:4px">Quotation</div></div>
                            <div style="text-align:right"><h1>${esc(q.quote_number)}</h1><div style="margin-top:8px"><span class="stamp ${status === 'accepted' ? 'paid' : status === 'declined' ? 'cancelled' : status === 'expired' ? 'overdue' : status === 'draft' ? 'draft' : ''}">${esc(L.QUOTE_STATUS[status].label)}</span></div></div>
                        </div>
                        <div class="parties">
                            <div><h4>Prepared for</h4><b>${esc(q.bill_to_name || '—')}</b>${q.bill_to_address ? `<div style="white-space:pre-wrap">${esc(q.bill_to_address)}</div>` : ''}${q.bill_to_email ? `<div>${esc(q.bill_to_email)}</div>` : ''}</div>
                            <div><h4>Details</h4><div class="meta"><span>Quote date</span><span>${esc(L.fmtDate(q.quote_date))}</span><span>Valid until</span><span>${esc(L.fmtDate(q.valid_until) || '—')}</span><span>Currency</span><span>${esc(q.currency)}</span>${q.responsible_id ? `<span>Prepared by</span><span>${esc(C.personName(q.responsible_id))}</span>` : ''}</div></div>
                        </div>
                        <table>
                            <thead><tr><th>#</th><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Disc</th><th class="num">Tax</th><th class="num">Amount</th></tr></thead>
                            <tbody>${items.length ? items.map((it, i) => `<tr><td class="num muted">${i + 1}</td><td>${esc(it.description)}</td><td class="num">${esc(Number(it.quantity))}</td><td class="num">${esc(L.money(it.unit_price, q.currency))}</td><td class="num">${Number(it.discount_pct) ? esc(Number(it.discount_pct) + '%') : '—'}</td><td class="num">${Number(it.tax_rate) ? esc(Number(it.tax_rate) + '%') : '—'}</td><td class="num">${esc(L.money(it.line_total, q.currency))}</td></tr>`).join('') : '<tr><td colspan="7" class="muted" style="text-align:center;padding:18px">No lines yet.</td></tr>'}</tbody>
                        </table>
                        <div class="totals">
                            <div><span>Subtotal</span><span>${esc(L.money(q.subtotal, q.currency))}</span></div>
                            ${Number(q.discount_total) ? `<div><span>Discount</span><span>− ${esc(L.money(q.discount_total, q.currency))}</span></div>` : ''}
                            <div><span>Tax</span><span>${esc(L.money(q.tax_total, q.currency))}</span></div>
                            <div class="grand"><span>Total</span><span>${esc(L.money(q.total, q.currency))}</span></div>
                        </div>
                        ${q.notes ? `<div class="notes"><b>Notes</b><br>${esc(q.notes)}</div>` : ''}
                        ${q.terms ? `<div class="notes"><b>Terms</b><br>${esc(q.terms)}</div>` : ''}
                    </div>
                    <div class="ws-card no-print"><div class="crm-section-title"><h3>History</h3></div><div id="activity"></div></div>
                </div>
                <div class="ws-stack no-print">
                    <div class="ws-card">
                        <div class="crm-section-title"><h3>Deal</h3></div>
                        ${q.deal ? C.entityChip('deal', q.deal_id, q.deal.title) : '<span class="muted">—</span>'}
                        <dl class="crm-props one" style="margin-top:14px">
                            <div><dt>Status</dt><dd>${badge(q)}</dd></div>
                            ${q.contact_id ? `<div><dt>Contact</dt><dd>${C.entityChip('contact', q.contact_id, q.bill_to_name || 'Contact')}</dd></div>` : ''}
                            ${q.sent_at ? `<div><dt>Sent</dt><dd>${esc(L.fmtDateTime(q.sent_at))}</dd></div>` : ''}
                            ${q.accepted_at ? `<div><dt>Accepted</dt><dd>${esc(L.fmtDateTime(q.accepted_at))}</dd></div>` : ''}
                            ${q.declined_at ? `<div><dt>Declined</dt><dd>${esc(L.fmtDateTime(q.declined_at))}</dd></div>` : ''}
                            <div><dt>Created</dt><dd>${esc(L.fmtDateTime(q.created_at))}</dd></div>
                        </dl>
                        ${can ? '' : '<p class="muted" style="font-size:12px;margin-top:10px">Only people who can edit the deal can change its quotes.</p>'}
                    </div>
                </div>
            </div>`;

        const nav = view.querySelector('[data-nav]');
        if (nav) nav.addEventListener('click', e => { e.preventDefault(); history.pushState(null, '', '/quotes/'); showList(); });
        C.activityFeed(view.querySelector('#activity'), { entity_type: 'quote', entity_id: id, limit: 60 });
        view.querySelector('.acts').addEventListener('click', e => {
            const b = e.target.closest('[data-do]'); if (!b) return;
            const k = b.dataset.do;
            if (k === 'print') return window.print();
            if (k === 'edit') return openEditor(q);
            if (k === 'invoice') return toInvoice(q);
            if (k === 'more') {
                const items = [{ label: 'Print / save as PDF', icon: 'doc', onClick: () => window.print() }];
                if (can) {
                    if (acts.decline) items.push({ label: 'Declined', icon: 'x', onClick: () => setStatus(q, 'declined', refresh) });
                    if (acts.revise) items.push({ label: 'Revise as draft', icon: 'refresh', onClick: () => setStatus(q, 'draft', refresh) });
                    if (acts.remove) items.push('sep', { label: 'Delete draft', icon: 'trash', danger: true, onClick: () => deleteDraft(q) });
                }
                return C.menu(b, items);
            }
            setStatus(q, k, refresh);
        });
        if (C.param('print') === '1') { C.setParam('print', null, true); setTimeout(() => window.print(), 400); }
    }

    route();
})();
