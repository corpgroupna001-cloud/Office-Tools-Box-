/* ============================================================================
   Invoices — list with KPIs and filters, a draft editor with live totals, and
   a printable record page with payments, status actions and a timeline.

   The database owns every money column and the invoice number
   (supabase-invoices-migration.sql). The editor only previews totals with the
   same formulas (WSCrmLogic.invoiceLine / invoiceTotals); after a save the
   record shows what the database computed.

   URLs:  /invoices/                 list
          /invoices/?id=<uuid>       record        /invoices/?id=<uuid>&edit=1  edit draft
          /invoices/?new=1[&contact_id=&deal_id=]  list + new-invoice editor
   ============================================================================ */
(async function () {
    'use strict';
    const C = window.WSCrm, L = C.L, esc = C.esc, h = C.h;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'invoices', crumb: 'Invoices' });
    const sb = ctx.sb, me = ctx.user;

    const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED'];
    const METHODS = ['Bank transfer', 'UPI', 'Cash', 'Cheque', 'Card', 'Other'];
    const SELECT = 'id, company, invoice_number, contact_id, deal_id, project_id, bill_to_name, bill_to_address, bill_to_email, invoice_date, due_date, status, currency, subtotal, discount_total, tax_total, total, amount_paid, balance, notes, terms, sent_at, paid_at, cancelled_at, created_by, created_at, updated_at';
    const STATUS_ORDER = ['draft', 'sent', 'partially_paid', 'paid', 'overdue', 'cancelled'];

    function statusBadge(inv) { const s = L.invoiceStatus(inv); const m = L.INVOICE_STATUS[s]; return C.badge(m.color, m.label); }
    function isOpen(inv) { return !['draft', 'cancelled', 'paid'].includes(L.invoiceStatus(inv)); }

    /* ------------------------------------------------------------ routing */
    function route() {
        const id = C.param('id');
        if (id) return showRecord(id, C.param('edit') === '1');
        return showList();
    }
    window.addEventListener('popstate', route);
    function go(url) { history.pushState(null, '', url); route(); }

    /* --------------------------------------------------------------- list */
    const listState = { rows: [], q: '', status: '', range: 'all', from: '', to: '', contact: '' };
    async function fetchInvoices() {
        let b = sb.from('invoices').select(SELECT).order('invoice_date', { ascending: false }).order('created_at', { ascending: false }).limit(1000);
        if (listState.range !== 'all') {
            const r = L.dateRange(listState.range, new Date(), { from: listState.from, to: listState.to });
            if (r) b = b.gte('invoice_date', r.from).lte('invoice_date', r.to);
        }
        if (listState.contact) b = b.eq('contact_id', listState.contact);
        const { data } = await C.q(b);
        return data || [];
    }
    function filterRows(rows) {
        const q = listState.q.trim().toLowerCase();
        return rows.filter(r => {
            if (listState.status === 'outstanding') { if (!['sent', 'partially_paid', 'overdue'].includes(L.invoiceStatus(r))) return false; }
            else if (listState.status && L.invoiceStatus(r) !== listState.status) return false;
            if (!q) return true;
            return [r.invoice_number, r.bill_to_name, r.bill_to_email].some(v => v && String(v).toLowerCase().includes(q));
        });
    }
    function kpis(rows) {
        const today = L.todayIST();
        const month = L.dateRange('month');
        const out = { outstanding: 0, overdue: 0, overdueCount: 0, paidMonth: 0, drafts: 0, cur: 'INR' };
        rows.forEach(r => {
            const s = L.invoiceStatus(r, today);
            if (s === 'draft') out.drafts++;
            if (['sent', 'partially_paid', 'overdue'].includes(s)) out.outstanding += Number(r.balance) || 0;
            if (s === 'overdue') { out.overdue += Number(r.balance) || 0; out.overdueCount++; }
            if (s === 'paid' && r.paid_at && L.istDate(r.paid_at) >= month.from && L.istDate(r.paid_at) <= month.to) out.paidMonth += Number(r.total) || 0;
            if (r.currency && r.currency !== 'INR') out.cur = r.currency;      // best effort when a workspace bills in one currency
        });
        return out;
    }
    async function showList() {
        WSShell.setCrumb('Invoices');
        document.title = 'Invoices · WorkSuite';
        view.innerHTML = `
            <div class="ws-page-head">
                <div><p class="ws-eyebrow">Finance</p><h1>Invoices</h1><p>${ctx.isManager ? 'Bill customers, track payments and keep the books straight.' : 'Invoices are administered by managers. Any invoice you created is listed here.'}</p></div>
                <div class="actions">${ctx.isManager ? `<button type="button" class="ws-btn primary" id="new-btn">${C.icon('plus')}<span>New invoice</span></button>` : ''}</div>
            </div>
            ${ctx.isManager ? '' : `<div class="crm-info" style="margin-bottom:16px">${C.icon('lock', 'sm')} Creating and editing invoices needs the manager or admin workspace role. Ask an administrator if you need access.</div>`}
            <div class="crm-kpis" id="kpis"></div>
            <div class="crm-toolbar">
                <div class="crm-seg" id="seg" role="tablist"></div>
                <div class="crm-search grow">${C.icon('search', 'sm')}<input type="search" id="q" placeholder="Search number or customer…" aria-label="Search invoices"></div>
                <select id="f-range" aria-label="Invoice date"><option value="all">All dates</option><option value="month">This month</option><option value="quarter">This quarter</option><option value="year">This year</option><option value="last30">Last 30 days</option><option value="custom">Custom…</option></select>
                <span id="custom-range" hidden style="display:inline-flex;gap:6px;align-items:center"><input type="date" id="f-from" aria-label="From"><span class="muted">to</span><input type="date" id="f-to" aria-label="To"></span>
                <div id="f-contact" style="min-width:200px"></div>
                <span class="crm-count" id="count"></span>
            </div>
            <div class="ws-card flush"><div id="table"></div></div>`;
        const tableEl = view.querySelector('#table');
        C.skeletonRows(tableEl, 6);
        const newBtn = view.querySelector('#new-btn');
        if (newBtn) newBtn.addEventListener('click', () => openEditor(null, {}));
        view.querySelector('#f-range').value = listState.range;
        view.querySelector('#custom-range').hidden = listState.range !== 'custom';
        view.querySelector('#f-from').value = listState.from; view.querySelector('#f-to').value = listState.to;
        view.querySelector('#q').value = listState.q;
        const picker = C.entityPicker('contact', listState.contact || null, { placeholder: 'Any customer', onChange: id => { listState.contact = id || ''; reload(); } });
        view.querySelector('#f-contact').appendChild(picker.el);

        let tbl = null;
        function paintSeg(all) {
            const counts = {}; all.forEach(r => { const s = L.invoiceStatus(r); counts[s] = (counts[s] || 0) + 1; });
            const seg = view.querySelector('#seg');
            seg.innerHTML = [['', 'All', all.length], ...STATUS_ORDER.map(s => [s, L.INVOICE_STATUS[s].label, counts[s] || 0])]
                .map(([k, label, n]) => `<button type="button" role="tab" data-status="${k}" class="${listState.status === k ? 'on' : ''}" aria-selected="${listState.status === k}">${esc(label)}<span class="n">${n}</span></button>`).join('');
        }
        function paintKpis(all) {
            const k = kpis(all);
            view.querySelector('#kpis').innerHTML = `
                <a class="crm-kpi accent" href="#" data-status="outstanding"><div class="lbl">Outstanding</div><div class="val">${esc(L.money(k.outstanding, k.cur))}</div><div class="sub">Sent, not yet paid</div></a>
                <a class="crm-kpi ${k.overdueCount ? 'bad' : ''}" href="#" data-status="overdue"><div class="lbl">Overdue</div><div class="val">${esc(L.money(k.overdue, k.cur))}</div><div class="sub ${k.overdueCount ? 'bad' : ''}">${k.overdueCount} invoice${k.overdueCount === 1 ? '' : 's'} past due</div></a>
                <a class="crm-kpi ok" href="#" data-status="paid"><div class="lbl">Paid this month</div><div class="val">${esc(L.money(k.paidMonth, k.cur))}</div><div class="sub">By payment date</div></a>
                <a class="crm-kpi" href="#" data-status="draft"><div class="lbl">Drafts</div><div class="val">${k.drafts}</div><div class="sub">Not yet sent</div></a>`;
        }
        function columns() {
            return [
                { key: 'invoice_number', label: 'Invoice', lead: true, render: r => `<span class="primary-text">${esc(r.invoice_number)}</span><span class="sub">${esc(r.bill_to_name || '—')}</span>` },
                { key: 'bill_to_name', label: 'Customer', hideMobile: true, render: r => r.contact_id ? `<a class="crm-link" href="/contacts/?id=${esc(r.contact_id)}">${esc(r.bill_to_name || 'Contact')}</a>` : esc(r.bill_to_name || '—') },
                { key: 'invoice_date', label: 'Date', render: r => esc(L.fmtDate(r.invoice_date)) },
                { key: 'due_date', label: 'Due', render: r => { const s = L.invoiceStatus(r); return r.due_date ? `<span class="crm-due ${s === 'overdue' ? 'overdue' : ''}">${esc(L.fmtDate(r.due_date))}</span>` : '<span class="muted">—</span>'; } },
                { key: 'status', label: 'Status', value: r => L.invoiceStatus(r), render: r => statusBadge(r) },
                { key: 'total', label: 'Total', num: true, value: r => Number(r.total), render: r => esc(L.money(r.total, r.currency)) },
                { key: 'amount_paid', label: 'Paid', num: true, value: r => Number(r.amount_paid), render: r => esc(L.money(r.amount_paid, r.currency)) },
                { key: 'balance', label: 'Balance', num: true, value: r => Number(r.balance), render: r => `<b>${esc(L.money(r.balance, r.currency))}</b>` },
                { key: 'actions', label: '', sort: false, cls: 'actions', render: r => `<button type="button" class="ws-btn sm icon" data-menu="${esc(r.id)}" aria-label="Actions">${C.icon('more')}</button>` },
            ];
        }
        function paint() {
            paintKpis(listState.rows); paintSeg(listState.rows);
            const rows = filterRows(listState.rows);
            view.querySelector('#count').textContent = `${rows.length} invoice${rows.length === 1 ? '' : 's'}`;
            if (!tbl) tbl = C.table(tableEl, {
                columns: columns(), rows, sort: { key: 'invoice_date', dir: 'desc' }, pageSize: 50, onRow: r => go(`/invoices/?id=${r.id}`),
                empty: { title: listState.q || listState.status || listState.contact || listState.range !== 'all' ? 'No invoices match' : 'No invoices yet', sub: ctx.isManager && !listState.q ? 'Raise the first invoice for a customer or a won deal.' : 'Try a different filter.', action: ctx.isManager && !listState.q && !listState.status ? `<button type="button" class="ws-btn primary" onclick="document.getElementById('new-btn').click()">${C.icon('plus')}<span>New invoice</span></button>` : '' },
            }); else tbl.update(rows);
        }
        async function reload() { try { listState.rows = await fetchInvoices(); paint(); } catch (e) { C.errorState(tableEl, e, reload); } }
        view.querySelector('#seg').addEventListener('click', e => { const b = e.target.closest('[data-status]'); if (!b) return; listState.status = b.dataset.status; paint(); });
        view.querySelector('#kpis').addEventListener('click', e => { const a = e.target.closest('[data-status]'); if (!a) return; e.preventDefault(); listState.status = a.dataset.status; paint(); });
        view.querySelector('#q').addEventListener('input', C.debounce(() => { listState.q = view.querySelector('#q').value; paint(); }, 200));
        view.querySelector('#f-range').addEventListener('change', e => { listState.range = e.target.value; view.querySelector('#custom-range').hidden = listState.range !== 'custom'; if (listState.range !== 'custom' || (listState.from && listState.to)) reload(); });
        ['#f-from', '#f-to'].forEach(sel => view.querySelector(sel).addEventListener('change', () => { listState.from = view.querySelector('#f-from').value; listState.to = view.querySelector('#f-to').value; if (listState.from && listState.to) reload(); }));
        tableEl.addEventListener('click', e => {
            const b = e.target.closest('[data-menu]'); if (!b) return;
            e.stopPropagation();
            const r = listState.rows.find(x => x.id === b.dataset.menu); if (!r) return;
            const acts = L.invoiceActions(L.invoiceStatus(r));
            const items = [{ label: 'Open', icon: 'arrow', onClick: () => go(`/invoices/?id=${r.id}`) }];
            if (ctx.isManager) {
                if (acts.edit) items.push({ label: 'Edit draft', icon: 'edit', onClick: () => go(`/invoices/?id=${r.id}&edit=1`) });
                if (acts.send) items.push({ label: 'Mark sent', icon: 'mail', onClick: () => setStatus(r, 'sent', reload) });
                if (acts.pay) items.push({ label: 'Record payment', icon: 'salary', onClick: () => recordPayment(r, reload) });
                items.push({ label: 'Duplicate', icon: 'plus', onClick: () => duplicate(r) });
            }
            items.push({ label: 'Print', icon: 'doc', onClick: () => { location.href = `/invoices/?id=${r.id}&print=1`; } });
            if (ctx.isManager && acts.cancel) items.push('sep', { label: 'Cancel invoice', icon: 'x', danger: true, onClick: () => cancelInvoice(r, reload) });
            C.menu(b, items);
        });
        await reload();
        if (C.param('new') === '1') {
            const pre = { contact_id: C.param('contact_id') || null, deal_id: C.param('deal_id') || null, project_id: C.param('project_id') || null };
            C.setParam('new', null, true); C.setParam('contact_id', null, true); C.setParam('deal_id', null, true); C.setParam('project_id', null, true);
            if (ctx.isManager) openEditor(null, pre); else C.toast('Only managers can create invoices', 'bad');
        }
    }

    /* ------------------------------------------------------- status ops */
    async function setStatus(inv, status, after) {
        const labels = { sent: 'Mark this invoice as sent?', draft: 'Revert this invoice to a draft?' };
        const msgs = { sent: 'Once sent, its lines are locked and payments can be recorded against it.', draft: 'Only possible while nothing has been paid. You can then edit the lines again.' };
        if (labels[status] && !await C.confirm({ title: labels[status], message: msgs[status], okText: status === 'sent' ? 'Mark sent' : 'Revert to draft' })) return;
        try {
            const { data } = await C.q(sb.from('invoices').update({ status }).eq('id', inv.id).select('id'));
            if (!data || !data.length) throw new Error('The invoice could not be updated. Reload and try again.');
            C.toast(status === 'sent' ? 'Invoice marked as sent' : 'Invoice reverted to draft', 'ok');
            if (after) after();
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function cancelInvoice(inv, after) {
        if (!await C.confirm({ title: `Cancel ${inv.invoice_number}?`, message: 'A cancelled invoice cannot be reopened; duplicate it if you need a corrected copy. Recorded payments stay on file.', okText: 'Cancel invoice', danger: true })) return;
        try { const { data } = await C.q(sb.from('invoices').update({ status: 'cancelled' }).eq('id', inv.id).select('id')); if (!data || !data.length) throw new Error('The invoice could not be cancelled. Reload and try again.'); C.toast('Invoice cancelled', 'ok'); if (after) after(); }
        catch (e) { C.toast(e.message, 'bad'); }
    }
    async function deleteDraft(inv) {
        if (!await C.confirm({ title: `Delete draft ${inv.invoice_number}?`, message: 'Only drafts can be deleted. The number is not reused.', okText: 'Delete draft', danger: true })) return;
        try { const { data } = await C.q(sb.from('invoices').delete().eq('id', inv.id).select('id')); if (!data || !data.length) throw new Error('Only a draft you may manage can be deleted.'); C.toast('Draft deleted', 'ok'); go('/invoices/'); }
        catch (e) { C.toast(e.message, 'bad'); }
    }
    async function duplicate(inv) {
        try {
            const r = await sb.rpc('invoice_duplicate', { p_invoice: inv.id });
            if (r.error) throw new Error(C.friendly(r.error));
            C.toast('Draft copy created', 'ok');
            go(`/invoices/?id=${r.data}&edit=1`);
        } catch (e) { C.toast(e.message, 'bad'); }
    }
    async function recordPayment(inv, after) {
        return C.formModal({
            title: `Record a payment · ${inv.invoice_number}`,
            intro: `<div class="crm-info">Outstanding balance: <b>${esc(L.money(inv.balance, inv.currency))}</b></div>`,
            fields: [
                { name: 'amount', label: `Amount (${inv.currency})`, type: 'money', required: true, validate: v => Number(v) <= 0 ? 'Enter an amount above zero' : Number(v) > Number(inv.balance) + 0.001 ? 'More than the outstanding balance' : '' },
                { name: 'paid_on', label: 'Paid on', type: 'date', required: true },
                { name: 'method', label: 'Method', type: 'select', options: METHODS, required: true },
                { name: 'reference', label: 'Reference / transaction ID', type: 'text' },
                { name: 'note', label: 'Note', type: 'textarea', full: true },
            ],
            values: { amount: Number(inv.balance), paid_on: L.todayIST(), method: 'Bank transfer' },
            submitLabel: 'Record payment',
            onSubmit: async v => {
                await C.q(sb.from('invoice_payments').insert({ invoice_id: inv.id, amount: v.amount, paid_on: v.paid_on, method: v.method, reference: v.reference || null, note: v.note || null, created_by: me.id }));
                C.toast('Payment recorded', 'ok');
                if (after) after();
            },
        });
    }

    /* -------------------------------------------------------------- editor */
    function blankItem() { return { key: C.uid(), id: null, description: '', quantity: 1, unit_price: 0, discount_pct: 0, tax_rate: 0 }; }
    /**
     * openEditor(invoice | null, prefill { contact_id, deal_id, project_id })
     * A wide modal: header form + editable line items + live totals preview.
     */
    async function openEditor(inv, prefill) {
        const isNew = !inv;
        prefill = prefill || {};
        let items = [];
        if (!isNew) {
            try { const r = await C.q(sb.from('invoice_items').select('*').eq('invoice_id', inv.id).order('position')); items = (r.data || []).map(x => ({ ...x, key: x.id })); }
            catch (e) { return C.toast(e.message, 'bad'); }
        }
        if (!items.length) items.push(blankItem());
        const origIds = new Set(items.filter(x => x.id).map(x => x.id));
        const today = L.todayIST();

        const form = C.form([
            { name: 'contact_id', label: 'Customer (contact)', type: 'entity', entity: 'contact', placeholder: 'Search contacts', full: true, onChange: id => fillFromContact(id) },
            { name: 'bill_to_name', label: 'Bill to', type: 'text', required: true, placeholder: 'Customer or company name' },
            { name: 'bill_to_email', label: 'Billing email', type: 'email' },
            { name: 'bill_to_address', label: 'Billing address', type: 'textarea', full: true, rows: 2 },
            { name: 'deal_id', label: 'Deal', type: 'entity', entity: 'deal', placeholder: 'Link a deal (optional)', onChange: id => fillFromDeal(id) },
            { name: 'project_id', label: 'Project', type: 'entity', entity: 'project', placeholder: 'Link a project (optional)' },
            { name: 'invoice_date', label: 'Invoice date', type: 'date', required: true },
            { name: 'due_date', label: 'Due date', type: 'date', validate: (v, all) => v && all.invoice_date && L.dayNumber(v) < L.dayNumber(all.invoice_date) ? 'Due date is before the invoice date' : '' },
            { name: 'currency', label: 'Currency', type: 'select', options: CURRENCIES, required: true },
            { name: 'notes', label: 'Notes to customer', type: 'textarea', full: true, rows: 2 },
            { name: 'terms', label: 'Terms', type: 'textarea', full: true, rows: 2, placeholder: 'Payment terms, bank details…' },
        ], isNew
            ? { invoice_date: today, due_date: L.addDays(today, 15), currency: 'INR', contact_id: prefill.contact_id || null, deal_id: prefill.deal_id || null, project_id: prefill.project_id || null }
            : inv);

        // Pull customer details when a contact is picked.
        async function fillFromContact(id) {
            if (!id) return;
            const r = await sb.from('crm_contacts').select('full_name, organization, email, address, city, state, country, postal_code').eq('id', id).maybeSingle();
            if (!r.data) return;
            const c = r.data;
            const cur = form.get();
            if (!cur.bill_to_name) form.set({ bill_to_name: c.organization || c.full_name });
            if (!cur.bill_to_email && c.email) form.set({ bill_to_email: c.email });
            if (!cur.bill_to_address) form.set({ bill_to_address: [c.address, c.city, c.state, c.postal_code, c.country].filter(Boolean).join(', ') });
        }
        async function fillFromDeal(id) {
            if (!id) return;
            const r = await sb.from('crm_deals').select('title, value, currency, contact_id').eq('id', id).maybeSingle();
            if (!r.data) return;
            const d = r.data;
            if (d.currency) form.set({ currency: d.currency });
            if (d.contact_id && !form.get().contact_id) { form.field('contact_id').set(d.contact_id); fillFromContact(d.contact_id); }
            const first = items[0];
            if (items.length === 1 && !first.description) { first.description = d.title; first.unit_price = Number(d.value) || 0; first.quantity = 1; renderItems(); }
        }
        if (isNew && prefill.contact_id) fillFromContact(prefill.contact_id);
        if (isNew && prefill.deal_id) fillFromDeal(prefill.deal_id);

        // Line items
        const itemsWrap = h(`<div style="margin-top:18px">
            <div class="crm-section-title"><h3>Line items</h3><div class="right"><button type="button" class="ws-btn sm" data-add>${C.icon('plus')}<span>Add line</span></button></div></div>
            <div class="crm-table-wrap"><table class="ws-table" id="items"><thead><tr><th style="min-width:220px">Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Disc %</th><th class="num">Tax %</th><th class="num">Line total</th><th></th></tr></thead><tbody></tbody></table></div>
            <div class="inv-sheet" style="padding:0;border:0;margin-top:12px;background:transparent"><div class="totals" id="totals"></div></div>
            <p class="muted" style="font-size:12px;margin:8px 0 0">Totals are a preview. The database computes and stores the final figures when you save.</p>
        </div>`);
        const tbody = itemsWrap.querySelector('tbody'), totalsEl = itemsWrap.querySelector('#totals');
        const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
        function renderTotals() {
            const cur = form.get().currency || 'INR';
            const t = L.invoiceTotals(items, []);
            totalsEl.innerHTML = `<div><span>Subtotal</span><span>${esc(L.money(t.subtotal, cur))}</span></div>
                ${t.discount_total ? `<div><span>Discount</span><span>− ${esc(L.money(t.discount_total, cur))}</span></div>` : ''}
                <div><span>Tax</span><span>${esc(L.money(t.tax_total, cur))}</span></div>
                <div class="grand"><span>Total</span><span>${esc(L.money(t.total, cur))}</span></div>`;
        }
        function renderItems() {
            tbody.innerHTML = items.map((it, i) => {
                const line = L.invoiceLine(it);
                return `<tr data-key="${esc(it.key)}">
                    <td><input type="text" data-f="description" value="${esc(it.description)}" placeholder="What is being billed" aria-label="Description" style="width:100%;min-width:200px"></td>
                    <td class="num"><input type="number" data-f="quantity" value="${esc(it.quantity)}" min="0" step="0.001" style="width:80px" aria-label="Quantity"></td>
                    <td class="num"><input type="number" data-f="unit_price" value="${esc(it.unit_price)}" min="0" step="0.01" style="width:110px" aria-label="Unit price"></td>
                    <td class="num"><input type="number" data-f="discount_pct" value="${esc(it.discount_pct)}" min="0" max="100" step="0.01" style="width:72px" aria-label="Discount percent"></td>
                    <td class="num"><input type="number" data-f="tax_rate" value="${esc(it.tax_rate)}" min="0" max="100" step="0.01" style="width:72px" aria-label="Tax rate"></td>
                    <td class="num" data-total>${esc(L.money(line.line_total, form.get().currency))}</td>
                    <td class="actions" style="white-space:nowrap"><button type="button" class="ws-btn sm icon" data-up title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" class="ws-btn sm icon" data-down title="Move down" ${i === items.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="ws-btn sm icon" data-rm title="Remove line" aria-label="Remove line">${C.icon('x')}</button></td>
                </tr>`;
            }).join('');
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
            const tr = e.target.closest('tr'); if (!tr) return;
            const i = items.findIndex(x => x.key === tr.dataset.key); if (i < 0) return;
            if (e.target.closest('[data-rm]')) { items.splice(i, 1); if (!items.length) items.push(blankItem()); renderItems(); }
            else if (e.target.closest('[data-up]') && i > 0) { [items[i - 1], items[i]] = [items[i], items[i - 1]]; renderItems(); }
            else if (e.target.closest('[data-down]') && i < items.length - 1) { [items[i + 1], items[i]] = [items[i], items[i + 1]]; renderItems(); }
        });
        itemsWrap.querySelector('[data-add]').addEventListener('click', () => { items.push(blankItem()); renderItems(); const last = tbody.querySelector('tr:last-child input'); if (last) last.focus(); });
        form.field('currency').el.addEventListener('change', renderItems);
        renderItems();

        const body = document.createElement('div');
        body.append(form.el, itemsWrap);
        return new Promise(resolve => {
            C.modal({
                title: isNew ? 'New invoice' : `Edit draft ${inv.invoice_number}`, size: 'xwide', body, sticky: true, onClose: () => resolve(),
                actions: [
                    { label: 'Cancel', close: true },
                    { label: isNew ? 'Save draft' : 'Save changes', primary: true, onClick: async api => {
                        if (!form.validate()) return;
                        const live = items.filter(x => String(x.description || '').trim());
                        if (!live.length) { api.setMessage('Add at least one line item with a description.'); return; }
                        // The database checks these too; catching them here avoids a half-saved draft.
                        for (let i = 0; i < live.length; i++) {
                            const it = live[i];
                            if (num(it.quantity) < 0 || num(it.unit_price) < 0) { api.setMessage(`Line ${i + 1}: quantity and unit price cannot be negative.`); return; }
                            if (num(it.discount_pct) < 0 || num(it.discount_pct) > 100) { api.setMessage(`Line ${i + 1}: discount must be between 0 and 100%.`); return; }
                            if (num(it.tax_rate) < 0 || num(it.tax_rate) > 100) { api.setMessage(`Line ${i + 1}: tax rate must be between 0 and 100%.`); return; }
                        }
                        const v = form.get();
                        const header = {
                            contact_id: v.contact_id || null, deal_id: v.deal_id || null, project_id: v.project_id || null,
                            bill_to_name: v.bill_to_name.trim(), bill_to_email: v.bill_to_email || null, bill_to_address: v.bill_to_address || null,
                            invoice_date: v.invoice_date, due_date: v.due_date || null, currency: v.currency, notes: v.notes || null, terms: v.terms || null,
                        };
                        let id;
                        if (isNew) {
                            const r = await C.q(sb.from('invoices').insert({ ...header, status: 'draft', created_by: me.id }).select('id').single());
                            id = r.data.id;
                            try {
                                await C.q(sb.from('invoice_items').insert(live.map((it, i) => ({ invoice_id: id, position: i + 1, description: it.description.trim(), quantity: num(it.quantity), unit_price: num(it.unit_price), discount_pct: num(it.discount_pct), tax_rate: num(it.tax_rate) }))));
                            } catch (e) {
                                // Do not leave a numbered, empty draft behind.
                                try { await sb.from('invoices').delete().eq('id', id); } catch (e2) { /* best effort */ }
                                throw e;
                            }
                        } else {
                            id = inv.id;
                            await C.q(sb.from('invoices').update(header).eq('id', id));
                            const keep = new Set(live.filter(x => x.id).map(x => x.id));
                            const removed = [...origIds].filter(x => !keep.has(x));
                            if (removed.length) await C.q(sb.from('invoice_items').delete().in('id', removed));
                            for (let i = 0; i < live.length; i++) {
                                const it = live[i];
                                const row = { position: i + 1, description: it.description.trim(), quantity: num(it.quantity), unit_price: num(it.unit_price), discount_pct: num(it.discount_pct), tax_rate: num(it.tax_rate) };
                                if (it.id) await C.q(sb.from('invoice_items').update(row).eq('id', it.id));
                                else await C.q(sb.from('invoice_items').insert({ ...row, invoice_id: id }));
                            }
                        }
                        const preview = L.invoiceTotals(live, []);
                        api.close();
                        C.toast(isNew ? 'Draft saved' : 'Invoice updated', 'ok');
                        resolve(id);
                        go(`/invoices/?id=${id}`);
                        // Tell the user if the database disagreed with the preview (it is the authority).
                        setTimeout(async () => {
                            const r = await sb.from('invoices').select('total').eq('id', id).maybeSingle();
                            if (r.data && Math.abs(Number(r.data.total) - preview.total) >= 0.01) C.toast(`Stored total is ${L.money(r.data.total, v.currency)} (preview showed ${L.money(preview.total, v.currency)})`, '');
                        }, 400);
                    } },
                ],
            });
        });
    }

    /* -------------------------------------------------------------- record */
    async function showRecord(id, edit) {
        C.loading(view, 'Loading invoice…');
        let inv, items = [], payments = [];
        try {
            const r = await C.q(sb.from('invoices').select(SELECT).eq('id', id).maybeSingle());
            inv = r.data;
            if (inv) {
                const [it, pay] = await Promise.all([
                    C.q(sb.from('invoice_items').select('*').eq('invoice_id', id).order('position')),
                    C.q(sb.from('invoice_payments').select('*').eq('invoice_id', id).order('paid_on', { ascending: false })),
                ]);
                items = it.data || []; payments = pay.data || [];
            }
        } catch (e) { return C.errorState(view, e, () => showRecord(id, edit)); }
        if (!inv) { view.innerHTML = `<a class="crm-back" href="/invoices/">${C.icon('arrow')}All invoices</a>`; C.empty(view.appendChild(document.createElement('div')), 'Invoice not found', 'It may have been deleted, or you may not have access to it.'); return; }
        const status = L.invoiceStatus(inv);
        const acts = L.invoiceActions(status);
        const canManage = ctx.isManager;
        document.title = `${inv.invoice_number} · Invoices · WorkSuite`;
        WSShell.setCrumb(inv.invoice_number);
        if (edit && canManage && acts.edit) { C.setParam('edit', null, true); openEditor(inv, {}); }
        else if (edit) C.setParam('edit', null, true);

        const stampCls = status === 'paid' ? 'paid' : status === 'overdue' ? 'overdue' : status === 'cancelled' ? 'cancelled' : status === 'draft' ? 'draft' : '';
        const links = [inv.contact_id ? C.entityChip('contact', inv.contact_id, inv.bill_to_name || 'Contact') : '', inv.deal_id ? C.entityChip('deal', inv.deal_id, 'Deal') : '', inv.project_id ? C.entityChip('project', inv.project_id, 'Project') : ''].filter(Boolean).join(' ');

        view.innerHTML = `
            <a class="crm-back no-print" href="/invoices/" data-nav>${C.icon('arrow')}All invoices</a>
            <div class="crm-record-head no-print">
                <div class="titles">
                    <h1>${esc(inv.invoice_number)}</h1>
                    <div class="meta">${statusBadge(inv)}<span>${esc(inv.bill_to_name || '')}</span><span>Issued ${esc(L.fmtDate(inv.invoice_date))}</span>${inv.due_date ? `<span>Due ${esc(L.fmtDate(inv.due_date))}</span>` : ''}<span>Created by ${C.personHtml(inv.created_by)}</span></div>
                </div>
                <div class="actions">
                    ${canManage && acts.edit ? `<button type="button" class="ws-btn" id="edit-btn">${C.icon('edit')}<span>Edit</span></button>` : ''}
                    ${canManage && acts.send ? `<button type="button" class="ws-btn primary" id="send-btn">${C.icon('mail')}<span>Mark sent</span></button>` : ''}
                    ${canManage && acts.pay ? `<button type="button" class="ws-btn primary" id="pay-btn">${C.icon('salary')}<span>Record payment</span></button>` : ''}
                    <button type="button" class="ws-btn" id="print-btn">${C.icon('doc')}<span>Print / PDF</span></button>
                    <button type="button" class="ws-btn icon" id="more-btn" aria-label="More actions">${C.icon('more')}</button>
                </div>
            </div>
            <div class="crm-detail">
                <div class="ws-stack">
                    <div class="inv-sheet">
                        <div class="top">
                            <div class="co"><b>${esc(inv.company || 'WorkSuite')}</b><div class="muted" style="font-size:13px;margin-top:4px">Invoice</div></div>
                            <div style="text-align:right"><h1>${esc(inv.invoice_number)}</h1><div style="margin-top:8px"><span class="stamp ${stampCls}">${esc(L.INVOICE_STATUS[status].label)}</span></div></div>
                        </div>
                        <div class="parties">
                            <div><h4>Bill to</h4><b>${esc(inv.bill_to_name || '—')}</b>${inv.bill_to_address ? `<div style="white-space:pre-wrap">${esc(inv.bill_to_address)}</div>` : ''}${inv.bill_to_email ? `<div>${esc(inv.bill_to_email)}</div>` : ''}</div>
                            <div><h4>Details</h4><div class="meta"><span>Invoice date</span><span>${esc(L.fmtDate(inv.invoice_date))}</span><span>Due date</span><span>${esc(L.fmtDate(inv.due_date) || '—')}</span><span>Currency</span><span>${esc(inv.currency)}</span>${inv.sent_at ? `<span>Sent</span><span>${esc(L.fmtDate(inv.sent_at))}</span>` : ''}${inv.paid_at ? `<span>Paid</span><span>${esc(L.fmtDate(inv.paid_at))}</span>` : ''}</div></div>
                        </div>
                        <table>
                            <thead><tr><th>#</th><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Disc</th><th class="num">Tax</th><th class="num">Amount</th></tr></thead>
                            <tbody>${items.length ? items.map((it, i) => `<tr><td class="num muted">${i + 1}</td><td>${esc(it.description)}</td><td class="num">${esc(Number(it.quantity))}</td><td class="num">${esc(L.money(it.unit_price, inv.currency))}</td><td class="num">${Number(it.discount_pct) ? esc(Number(it.discount_pct) + '%') : '—'}</td><td class="num">${Number(it.tax_rate) ? esc(Number(it.tax_rate) + '%') : '—'}</td><td class="num">${esc(L.money(it.line_total, inv.currency))}</td></tr>`).join('') : '<tr><td colspan="7" class="muted" style="text-align:center;padding:18px">No line items yet.</td></tr>'}</tbody>
                        </table>
                        <div class="totals">
                            <div><span>Subtotal</span><span>${esc(L.money(inv.subtotal, inv.currency))}</span></div>
                            ${Number(inv.discount_total) ? `<div><span>Discount</span><span>− ${esc(L.money(inv.discount_total, inv.currency))}</span></div>` : ''}
                            <div><span>Tax</span><span>${esc(L.money(inv.tax_total, inv.currency))}</span></div>
                            <div class="grand"><span>Total</span><span>${esc(L.money(inv.total, inv.currency))}</span></div>
                            ${Number(inv.amount_paid) ? `<div><span>Paid</span><span>− ${esc(L.money(inv.amount_paid, inv.currency))}</span></div><div class="grand"><span>Balance due</span><span>${esc(L.money(inv.balance, inv.currency))}</span></div>` : ''}
                        </div>
                        ${inv.notes ? `<div class="notes"><b>Notes</b><br>${esc(inv.notes)}</div>` : ''}
                        ${inv.terms ? `<div class="notes"><b>Terms</b><br>${esc(inv.terms)}</div>` : ''}
                    </div>
                    <div class="ws-card flush no-print">
                        <div class="ws-card-head"><h3>Payments</h3><span class="sub">${esc(L.money(inv.amount_paid, inv.currency))} received</span>${canManage && acts.pay ? `<div class="right"><button type="button" class="ws-btn sm primary" id="pay-btn-2">${C.icon('plus')}<span>Record payment</span></button></div>` : ''}</div>
                        <div id="payments"></div>
                    </div>
                    <div class="ws-card no-print">
                        <div class="crm-section-title"><h3>Activity &amp; notes</h3></div>
                        <div id="composer"></div>
                        <div id="activity"></div>
                    </div>
                </div>
                <div class="ws-stack no-print">
                    <div class="ws-card">
                        <div class="crm-section-title"><h3>Linked to</h3></div>
                        ${links ? `<div class="crm-tags">${links}</div>` : '<div class="muted" style="font-size:13px">Not linked to a contact, deal or project.</div>'}
                        <dl class="crm-props one" style="margin-top:14px">
                            <div><dt>Status</dt><dd>${statusBadge(inv)}</dd></div>
                            <div><dt>Balance</dt><dd><b>${esc(L.money(inv.balance, inv.currency))}</b></dd></div>
                            <div><dt>Created</dt><dd>${esc(L.fmtDateTime(inv.created_at))}</dd></div>
                            <div><dt>Last updated</dt><dd>${esc(L.fmtDateTime(inv.updated_at))}</dd></div>
                            ${inv.cancelled_at ? `<div><dt>Cancelled</dt><dd>${esc(L.fmtDateTime(inv.cancelled_at))}</dd></div>` : ''}
                        </dl>
                    </div>
                    <div class="ws-card"><div class="crm-section-title"><h3>Attachments</h3></div><div id="documents"></div></div>
                </div>
            </div>`;

        view.querySelector('[data-nav]').addEventListener('click', e => { e.preventDefault(); go('/invoices/'); });
        C.table(view.querySelector('#payments'), {
            rows: payments, sort: { key: 'paid_on', dir: 'desc' },
            columns: [
                { key: 'paid_on', label: 'Date', lead: true, render: p => `<span class="primary-text">${esc(L.fmtDate(p.paid_on))}</span>` },
                { key: 'amount', label: 'Amount', num: true, value: p => Number(p.amount), render: p => `<b>${esc(L.money(p.amount, inv.currency))}</b>` },
                { key: 'method', label: 'Method', render: p => esc(p.method || '—') },
                { key: 'reference', label: 'Reference', render: p => esc(p.reference || '—') + (p.note ? `<span class="sub">${esc(p.note)}</span>` : '') },
                { key: 'created_by', label: 'Recorded by', value: p => C.personName(p.created_by), render: p => C.personHtml(p.created_by, { link: false }) },
                ...(canManage ? [{ key: 'actions', label: '', sort: false, cls: 'actions', render: p => `<button type="button" class="ws-btn sm icon" data-del-pay="${esc(p.id)}" aria-label="Remove payment">${C.icon('trash')}</button>` }] : []),
            ],
            empty: { title: 'No payments recorded', sub: acts.pay ? 'Record a payment when money arrives.' : status === 'draft' ? 'Mark the invoice as sent before recording payments.' : '' },
        });
        view.querySelector('#payments').addEventListener('click', async e => {
            const b = e.target.closest('[data-del-pay]'); if (!b) return;
            e.stopPropagation();
            const p = payments.find(x => x.id === b.dataset.delPay); if (!p) return;
            if (!await C.confirm({ title: 'Remove this payment?', message: `${L.money(p.amount, inv.currency)} on ${L.fmtDate(p.paid_on)} will be removed and the balance recomputed.`, okText: 'Remove', danger: true })) return;
            try { await C.q(sb.from('invoice_payments').delete().eq('id', p.id)); C.toast('Payment removed', 'ok'); showRecord(id); } catch (err) { C.toast(err.message, 'bad'); }
        });
        const feed = C.activityFeed(view.querySelector('#activity'), { entity_type: 'invoice', entity_id: id, limit: 60 });
        C.comments(view.querySelector('#composer'), { entity_type: 'invoice', entity_id: id, onPosted: () => feed.reload() });
        C.documents(view.querySelector('#documents'), { entity_type: 'invoice', entity_id: id, canEdit: canManage });

        const on = (sel, fn) => { const el = view.querySelector(sel); if (el) el.addEventListener('click', fn); };
        on('#edit-btn', () => openEditor(inv, {}));
        on('#send-btn', () => setStatus(inv, 'sent', () => showRecord(id)));
        const pay = () => recordPayment(inv, () => showRecord(id));
        on('#pay-btn', pay); on('#pay-btn-2', pay);
        on('#print-btn', () => window.print());
        on('#more-btn', e => {
            const items = [{ label: 'Print / save as PDF', icon: 'doc', onClick: () => window.print() }];
            if (canManage) {
                items.push({ label: 'Duplicate as new draft', icon: 'plus', onClick: () => duplicate(inv) });
                if (acts.revertToDraft && Number(inv.amount_paid) === 0) items.push({ label: 'Revert to draft', icon: 'refresh', onClick: () => setStatus(inv, 'draft', () => showRecord(id)) });
                if (acts.cancel) items.push('sep', { label: 'Cancel invoice', icon: 'x', danger: true, onClick: () => cancelInvoice(inv, () => showRecord(id)) });
                if (acts.cancelPaid) items.push('sep', { label: 'Cancel (paid) invoice', icon: 'x', danger: true, onClick: () => cancelInvoice(inv, () => showRecord(id)) });
                if (status === 'draft') items.push({ label: 'Delete draft', icon: 'trash', danger: true, onClick: () => deleteDraft(inv) });
            }
            C.menu(e.currentTarget, items);
        });
        if (C.param('print') === '1') { C.setParam('print', null, true); setTimeout(() => window.print(), 400); }
    }

    route();
})();
