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
    const C = window.WSCrm, L = C.L, esc = C.esc, h = C.h, B = window.WSB24;
    const view = document.getElementById('view');
    const ctx = await C.boot({ active: 'invoices', crumb: 'Invoices', layout: 'b24' });
    const sb = ctx.sb, me = ctx.user;

    const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED'];
    const METHODS = ['Bank transfer', 'UPI', 'Cash', 'Cheque', 'Card', 'Other'];
    const BASE = 'id, company, invoice_number, contact_id, deal_id, project_id, bill_to_name, bill_to_address, bill_to_email, invoice_date, due_date, status, currency, subtotal, discount_total, tax_total, total, amount_paid, balance, notes, terms, sent_at, paid_at, cancelled_at, created_by, created_at, updated_at';
    const [cols, invLv] = await Promise.all([B.columns('invoices', BASE + ', responsible_id, subject, company_id', BASE), B.levels('invoice')]);
    const SELECT = cols.select;
    // What the access-permissions matrix lets this person do with invoices (managers only before it existed).
    const MANAGE = invLv.edit !== 'none', CREATE = invLv.add !== 'none';
    const STATUS_ORDER = ['draft', 'sent', 'partially_paid', 'paid', 'overdue', 'cancelled'];

    function statusBadge(inv) { const s = L.invoiceStatus(inv); const m = L.INVOICE_STATUS[s]; return C.badge(m.color, m.label); }
    function isOpen(inv) { return !['draft', 'cancelled', 'paid'].includes(L.invoiceStatus(inv)); }

    /* ------------------------------------------------------------ routing */
    function route() {
        const id = C.param('id');
        if (id) return showRecord(id, C.param('edit') === '1');
        if (page.mode === 'list') return refreshList();
        return showList();
    }
    window.addEventListener('popstate', route);
    function go(url) { history.pushState(null, '', url); route(); }

    /* ----------------------------------------------- list (workspace layout) */
    const page = { mode: null, grid: null, board: null, filter: null, view: 'list' };
    const openInvoice = id => B.openRecord(`/invoices/?id=${id}`, () => refreshList());
    function refreshList() {
        if (page.mode !== 'list') return;
        loadCounters();
        if (page.grid) return page.grid.reload();
        if (page.board) return loadBoard();
    }
    function statusApply(b, v) {
        const today = L.todayIST();
        switch (v) {
            case 'outstanding': return b.in('status', ['sent', 'partially_paid']);
            case 'overdue': return b.in('status', ['sent', 'partially_paid']).lt('due_date', today);
            case 'sent': return b.eq('status', 'sent').or(`due_date.is.null,due_date.gte.${today}`);
            case 'partially_paid': return b.eq('status', 'partially_paid').or(`due_date.is.null,due_date.gte.${today}`);
            default: return b.eq('status', v);
        }
    }
    function filterFields() {
        return [
            { key: 'status', title: 'Status', type: 'select', apply: statusApply, options: [
                { value: 'outstanding', label: 'Awaiting payment' }, { value: 'overdue', label: 'Overdue' }, { value: 'draft', label: 'Draft' },
                { value: 'sent', label: 'Sent' }, { value: 'partially_paid', label: 'Partially paid' }, { value: 'paid', label: 'Paid' }, { value: 'cancelled', label: 'Cancelled' },
            ] },
            { key: 'invoice_date', title: 'Invoice date', type: 'date', column: 'invoice_date' },
            { key: 'due_date', title: 'Due date', type: 'date', column: 'due_date' },
            { key: 'customer', title: 'Customer', type: 'text', column: 'bill_to_name' },
            { key: 'total', title: 'Amount', type: 'number', column: 'total', default: false },
            { key: 'currency', title: 'Currency', type: 'select', options: CURRENCIES, default: false },
            ...(cols.full ? [{ key: 'responsible', title: 'Responsible', type: 'user', column: 'responsible_id', options: B.peopleOptions(), none: false }] : []),
            { key: 'creator', title: 'Created by', type: 'user', column: 'created_by', options: B.peopleOptions(), none: false, default: false },
        ];
    }
    const PRESETS = [
        { key: 'open', title: 'Awaiting payment', values: { status: 'outstanding' } },
        { key: 'overdue', title: 'Overdue invoices', values: { status: 'overdue' } },
        { key: 'drafts', title: 'Drafts', values: { status: 'draft' } },
        { key: 'paid', title: 'Paid invoices', values: { status: 'paid' } },
        ...(cols.full ? [{ key: 'mine', title: 'My invoices', values: { responsible: 'me' } }] : []),
        { key: 'all', title: 'All invoices', values: {} },
    ];
    const scoped = b => page.filter.apply(b, { searchColumns: ['invoice_number', 'bill_to_name', 'bill_to_email'].concat(cols.full ? ['subject'] : []) });

    async function showList() {
        page.mode = 'list';
        WSShell.setCrumb('Invoices');
        document.title = 'Invoices · WorkSuite';
        view.innerHTML = B.titleBar({ title: 'Invoices', createLabel: CREATE ? 'Create' : '' }) + `
            ${invLv.legacy && !ctx.isManager ? `<div class="b24-area pad" style="margin-bottom:10px"><div class="crm-info">${C.icon('lock', 'sm')} Creating and editing invoices needs the manager or admin workspace role. Invoices you raised are listed here.</div></div>` : ''}
            <div class="b24-toolbar">
                <div class="b24-views" role="tablist" aria-label="View">
                    <button type="button" role="tab" data-view="list">List</button>
                    <button type="button" role="tab" data-view="kanban">Kanban</button>
                </div>
                <div class="b24-counters" id="counters"></div>
            </div>
            <div id="body"></div>`;
        page.filter = WSFilter.mount(view.querySelector('[data-filter]'), { id: 'invoices', fields: filterFields(), presets: PRESETS, defaultPreset: 'all', me: me.id, onChange: () => refreshList() });
        const create = view.querySelector('[data-create]');
        if (create) create.addEventListener('click', () => openEditor(null, {}));
        view.querySelector('.b24-views').addEventListener('click', e => {
            const b = e.target.closest('[data-view]'); if (!b) return;
            try { localStorage.setItem('ws-invoices-view', b.dataset.view); } catch (err) { /* private mode */ }
            mountView(b.dataset.view);
        });
        view.querySelector('#counters').addEventListener('click', e => { const b = e.target.closest('[data-counter]'); if (b) page.filter.set({ status: b.dataset.counter }); });
        let v0 = 'list'; try { v0 = localStorage.getItem('ws-invoices-view') || 'list'; } catch (e) { /* private mode */ }
        mountView(C.param('view') === 'kanban' ? 'kanban' : v0);
        loadCounters();
        if (C.param('new') === '1') {
            const pre = { contact_id: C.param('contact_id') || null, deal_id: C.param('deal_id') || null, project_id: C.param('project_id') || null, company_id: C.param('company_id') || null };
            ['new', 'contact_id', 'deal_id', 'project_id', 'company_id'].forEach(k => C.setParam(k, null, true));
            if (CREATE) openEditor(null, pre); else C.toast('You do not have permission to create invoices', 'bad');
        }
    }
    function mountView(kind) {
        page.view = kind;
        view.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('on', b.dataset.view === kind); b.setAttribute('aria-selected', String(b.dataset.view === kind)); });
        if (page.grid) { page.grid.destroy(); page.grid = null; }
        if (page.board) { page.board.destroy(); page.board = null; }
        const body = view.querySelector('#body'); body.innerHTML = '';
        if (kind === 'kanban') return mountBoard(body);
        mountGrid(body);
    }
    async function loadCounters() {
        const el = view.querySelector('#counters'); if (!el) return;
        try {
            const today = L.todayIST(), month = L.dateRange('month');
            const [open, draft, paid] = await Promise.all([
                sb.from('invoices').select('status, due_date, balance, currency').in('status', ['sent', 'partially_paid']).limit(2000),
                sb.from('invoices').select('id', { count: 'exact', head: true }).eq('status', 'draft'),
                sb.from('invoices').select('total, currency').eq('status', 'paid').gte('paid_at', `${month.from}T00:00:00+05:30`).limit(2000),
            ]);
            const rows = open.data || [];
            const cur = (rows[0] || (paid.data || [])[0] || {}).currency || 'INR';
            const sum = (list, k) => list.filter(r => (r.currency || 'INR') === cur).reduce((a, r) => a + Number(r[k] || 0), 0);
            const overdue = rows.filter(r => r.due_date && r.due_date < today);
            el.innerHTML = `
                <button type="button" class="b24-counter" data-counter="outstanding"><span class="n">${rows.length}</span>Awaiting payment · <b>${esc(L.money(sum(rows, 'balance'), cur))}</b></button>
                <button type="button" class="b24-counter${overdue.length ? ' red' : ''}" data-counter="overdue"><span class="n">${overdue.length}</span>Overdue · <b>${esc(L.money(sum(overdue, 'balance'), cur))}</b></button>
                <button type="button" class="b24-counter green" data-counter="paid"><span class="n">${(paid.data || []).length}</span>Paid this month · <b>${esc(L.money(sum(paid.data || [], 'total'), cur))}</b></button>
                <button type="button" class="b24-counter" data-counter="draft"><span class="n">${(!draft.error && draft.count) || 0}</span>Drafts</button>`;
        } catch (e) { el.innerHTML = ''; }
    }
    function rowMenu(r) {
        const acts = L.invoiceActions(L.invoiceStatus(r));
        const items = [{ label: 'Open', icon: 'arrow', onClick: () => openInvoice(r.id) }];
        if (MANAGE) {
            if (acts.edit) items.push({ label: 'Edit draft', icon: 'edit', onClick: () => B.openRecord(`/invoices/?id=${r.id}&edit=1`, refreshList) });
            if (acts.send) items.push({ label: 'Mark sent', icon: 'mail', onClick: () => setStatus(r, 'sent', refreshList) });
            if (acts.pay) items.push({ label: 'Record payment', icon: 'salary', onClick: () => recordPayment(r, refreshList) });
            if (canEmail(r)) items.push({ label: 'Email invoice', icon: 'mail', onClick: () => openEmailDialog(r) });
        }
        if (CREATE) items.push({ label: 'Duplicate', icon: 'plus', onClick: () => duplicate(r) });
        items.push({ label: 'Print', icon: 'doc', onClick: () => { window.top.location.href = `/invoices/?id=${r.id}&print=1`; } });
        if (MANAGE && acts.cancel) items.push('sep', { label: 'Cancel invoice', icon: 'x', danger: true, onClick: () => cancelInvoice(r, refreshList) });
        return items;
    }
    function mountGrid(body) {
        const host = document.createElement('div'); body.appendChild(host);
        page.grid = WSGrid.mount(host, {
            id: 'invoices', sort: { key: 'invoice_date', dir: 'desc' },
            columns: [
                { key: 'invoice_number', title: 'Invoice', width: 150, render: r => `<a href="/invoices/?id=${esc(r.id)}" data-open>${esc(r.invoice_number)}</a>` },
                ...(cols.full ? [{ key: 'subject', title: 'Subject', width: 200, render: r => esc(r.subject || '') }] : []),
                { key: 'bill_to_name', title: 'Customer', width: 220, render: r => r.contact_id ? `<a href="/contacts/?id=${esc(r.contact_id)}" data-contact="${esc(r.contact_id)}">${esc(r.bill_to_name || 'Contact')}</a>` : esc(r.bill_to_name || '') },
                { key: 'status', title: 'Status', width: 140, render: r => statusBadge(r) },
                { key: 'invoice_date', title: 'Invoice date', width: 130, render: r => esc(L.fmtDate(r.invoice_date)) },
                { key: 'due_date', title: 'Due date', width: 130, render: r => { const s = L.invoiceStatus(r); return r.due_date ? `<span class="crm-due ${s === 'overdue' ? 'overdue' : ''}">${esc(L.fmtDate(r.due_date))}</span>` : ''; } },
                { key: 'total', title: 'Amount', width: 140, align: 'right', render: r => esc(L.money(r.total, r.currency)) },
                { key: 'balance', title: 'Balance', width: 140, align: 'right', render: r => `<b>${esc(L.money(r.balance, r.currency))}</b>` },
                ...(cols.full ? [{ key: 'responsible_id', title: 'Responsible', width: 170, render: r => C.personHtml(r.responsible_id, { link: false }) }] : []),
                { key: 'amount_paid', title: 'Paid', width: 130, align: 'right', default: false, render: r => esc(L.money(r.amount_paid, r.currency)) },
                { key: 'currency', title: 'Currency', width: 90, default: false, render: r => esc(r.currency) },
                { key: 'created_by', title: 'Created by', width: 170, default: false, sortable: false, render: r => C.personHtml(r.created_by, { link: false }) },
            ],
            load: async ({ offset, limit, sort }) => {
                let b = scoped(sb.from('invoices').select(SELECT));
                b = sort ? b.order(sort.key, { ascending: sort.dir === 'asc', nullsFirst: false }) : b.order('invoice_date', { ascending: false });
                return (await C.q(b.order('created_at', { ascending: false }).range(offset, offset + limit - 1))).data || [];
            },
            count: async () => (await C.q(scoped(sb.from('invoices').select('id', { count: 'exact', head: true })))).count || 0,
            onOpen: r => openInvoice(r.id),
            rowMenu,
            empty: { title: 'No invoices match this filter', sub: CREATE ? 'Raise an invoice for a customer or a won deal.' : 'Change the filter.' },
        });
        host.addEventListener('click', e => { const a = e.target.closest('[data-contact]'); if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); B.openRecord(`/contacts/?id=${a.dataset.contact}`); } });
    }
    const BOARD = [
        { id: 'draft', name: 'Draft', hex: '#a8adb4' }, { id: 'sent', name: 'Sent', hex: '#2fc6f6' }, { id: 'partially_paid', name: 'Partially paid', hex: '#ffa900' },
        { id: 'overdue', name: 'Overdue', hex: '#ff5752' }, { id: 'paid', name: 'Paid', hex: '#7bd500' }, { id: 'cancelled', name: 'Cancelled', hex: '#6b7480' },
    ];
    function mountBoard(body) {
        body.innerHTML = '<div class="b24-board-area"><div id="kb"></div></div>';
        page.board = WSKanban.mount(body.querySelector('#kb'), {
            columns: [], cards: [], emptyText: 'No invoices',
            renderCard: c => { const r = c.inv; return `<div class="b24-kcard"><a class="t" href="/invoices/?id=${esc(r.id)}" data-open>${esc(r.invoice_number)}</a><div class="org">${esc(r.bill_to_name || '')}</div><div class="amt">${esc(L.money(r.total, r.currency))}</div><div class="meta">${r.due_date ? `<span class="crm-due ${L.invoiceStatus(r) === 'overdue' ? 'overdue' : ''}">Due ${esc(L.fmtDate(r.due_date, { short: true }))}</span>` : ''}${Number(r.balance) && L.invoiceStatus(r) !== 'draft' ? `<span>Balance ${esc(L.money(r.balance, r.currency))}</span>` : ''}</div></div>`; },
            canDrag: c => MANAGE && L.invoiceStatus(c.inv) === 'draft',
            onCardClick: (c, e) => { if (e) e.preventDefault(); openInvoice(c.inv.id); },
            onMove: async ({ card, toColumnId }) => {
                if (toColumnId !== 'sent') throw new Error('Drafts move to Sent here. Record payments and cancellations from the invoice.');
                await setStatus(card.inv, 'sent', () => loadBoard());
            },
        });
        loadBoard();
    }
    async function loadBoard() {
        if (!page.board) return;
        try {
            const { data } = await C.q(scoped(sb.from('invoices').select(SELECT)).order('invoice_date', { ascending: false }).limit(1000));
            const rows = data || [];
            page.board.update({
                columns: BOARD.map(col => { const inCol = rows.filter(r => L.invoiceStatus(r) === col.id); const cur = (inCol[0] || {}).currency || 'INR'; return { ...col, sum: L.money(inCol.filter(r => (r.currency || 'INR') === cur).reduce((a, r) => a + Number(r.total || 0), 0), cur, { whole: true }) }; }),
                cards: rows.map((r, i) => ({ id: r.id, columnId: L.invoiceStatus(r), position: i, inv: r })),
            });
        } catch (e) { C.errorState(view.querySelector('#kb'), e, loadBoard); }
    }
    view.addEventListener('click', e => {
        const a = e.target.closest('a[data-open]');
        if (!a || e.metaKey || e.ctrlKey || e.shiftKey || page.mode !== 'list') return;
        e.preventDefault();
        const id = new URL(a.href, location.href).searchParams.get('id');
        if (id) openInvoice(id);
    });

    /* ------------------------------------------------------- status ops */
    async function setStatus(inv, status, after) {
        const labels = { sent: 'Mark this invoice as sent?', draft: 'Revert this invoice to a draft?' };
        const msgs = { sent: 'Once sent, its lines are locked and payments can be recorded against it.', draft: 'Only possible while nothing has been paid. You can then edit the lines again.' };
        if (labels[status] && !await C.confirm({ title: labels[status], message: msgs[status], okText: status === 'sent' ? 'Mark sent' : 'Revert to draft' })) return;
        try {
            const { data } = await C.q(sb.from('invoices').update({ status }).eq('id', inv.id).select('id'));
            if (!data || !data.length) throw new Error('The invoice could not be updated. Reload and try again.');
            C.toast(status === 'sent' ? 'Invoice marked as sent' : 'Invoice reverted to draft', 'ok');
        } catch (e) { C.toast(e.message, 'bad'); return; }
        // Marking it sent is the natural moment to actually send it.
        if (status === 'sent') {
            const to = await recipientFor(inv);
            if (to && await C.confirm({ title: 'Email the invoice now?', message: `Email ${inv.invoice_number} to ${to} now?`, okText: 'Send email', cancelText: 'Not now' })) {
                await sendInvoiceEmail(inv, false);
            }
        }
        if (after) after();
    }

    /* -------------------------------------------------------------- email */
    const EMAILABLE = ['sent', 'partially_paid', 'overdue', 'paid'];
    function canEmail(inv) { return MANAGE && EMAILABLE.includes(L.invoiceStatus(inv)); }
    /** Where the server will send it: the bill-to snapshot, else the linked contact's email. */
    async function recipientFor(inv) {
        if (inv.bill_to_email) return inv.bill_to_email;
        if (!inv.contact_id) return '';
        try {
            const r = await sb.from('crm_contacts').select('email').eq('id', inv.contact_id).maybeSingle();
            return (r.data && r.data.email) || '';
        } catch (e) { return ''; }
    }
    /** POST to /api/mail with the signed-in user's token. Returns true when it went out. */
    async function sendInvoiceEmail(inv, ccMe) {
        try {
            const { data: { session } } = await sb.auth.getSession();
            if (!session) throw new Error('Your session has expired. Sign in again.');
            const r = await fetch('/api/mail', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
                body: JSON.stringify({ action: 'invoice', invoice_id: inv.id, cc_me: !!ccMe }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || 'The invoice could not be emailed.');
            C.toast(`Invoice emailed to ${(data.to || []).join(', ')}`, 'ok');
            return true;
        } catch (e) {
            C.toast(/Failed to fetch|NetworkError|Load failed/i.test(e.message) ? 'Could not reach the server. Check your connection and try again.' : e.message, 'bad');
            return false;
        }
    }
    async function openEmailDialog(inv, after) {
        const to = await recipientFor(inv);
        if (!to) {
            return C.alert({ title: 'No billing email', message: `${inv.invoice_number} has no billing email and its contact has none either. A sent invoice cannot be edited, so add an email address to the contact record and try again. (The bill-to details are a snapshot taken when the invoice was created; the contact's email is used when that snapshot has none.)` });
        }
        const paid = L.invoiceStatus(inv) === 'paid';
        C.modal({
            title: `Email ${inv.invoice_number}`,
            body: `<p style="margin:0 0 12px">${paid ? 'A receipt' : 'The invoice'} will be emailed to <b>${esc(to)}</b> from ${esc(inv.company || 'your company')}'s mailbox, with the line items and totals in the message.</p>
                   <label class="crm-check"><input type="checkbox" id="inv-cc-me"> <span>Send me a copy (${esc(me.email || '')})</span></label>`,
            actions: [
                { label: 'Cancel', close: true },
                { label: 'Send email', primary: true, onClick: async api => {
                    const cc = !!api.body.querySelector('#inv-cc-me').checked;
                    const ok = await sendInvoiceEmail(inv, cc);
                    if (ok) { api.close(); if (after) after(); }
                } },
            ],
        });
    }
    async function cancelInvoice(inv, after) {
        if (!await C.confirm({ title: `Cancel ${inv.invoice_number}?`, message: 'A cancelled invoice cannot be reopened; duplicate it if you need a corrected copy. Recorded payments stay on file.', okText: 'Cancel invoice', danger: true })) return;
        try { const { data } = await C.q(sb.from('invoices').update({ status: 'cancelled' }).eq('id', inv.id).select('id')); if (!data || !data.length) throw new Error('The invoice could not be cancelled. Reload and try again.'); C.toast('Invoice cancelled', 'ok'); if (after) after(); }
        catch (e) { C.toast(e.message, 'bad'); }
    }
    async function deleteDraft(inv) {
        if (!await C.confirm({ title: `Delete draft ${inv.invoice_number}?`, message: 'Only drafts can be deleted. The number is not reused.', okText: 'Delete draft', danger: true })) return;
        try { const { data } = await C.q(sb.from('invoices').delete().eq('id', inv.id).select('id')); if (!data || !data.length) throw new Error('Only a draft you may manage can be deleted.'); C.toast('Draft deleted', 'ok'); if (WSShell.inSlider) { WSShell.sliderMessage('deleted', { id: inv.id }); WSShell.closeSlider(); } else go('/invoices/'); }
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
            ...(cols.full ? [{ name: 'subject', label: 'Subject', type: 'text', full: true, placeholder: 'What the invoice is for' }] : []),
            { name: 'contact_id', label: 'Customer (contact)', type: 'entity', entity: 'contact', placeholder: 'Search contacts', onChange: id => fillFromContact(id) },
            ...(cols.full ? [{ name: 'company_id', label: 'Customer (company)', type: 'entity', entity: 'company', placeholder: 'Search companies', onChange: id => fillFromCompany(id) }, { name: 'responsible_id', label: 'Responsible', type: 'people', none: null }] : []),
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
            ? { invoice_date: today, due_date: L.addDays(today, 15), currency: 'INR', contact_id: prefill.contact_id || null, deal_id: prefill.deal_id || null, project_id: prefill.project_id || null, company_id: prefill.company_id || null, responsible_id: me.id }
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
        async function fillFromCompany(id) {
            if (!id) return;
            const r = await sb.from('crm_companies').select('title, email, address, city, state, country, postal_code').eq('id', id).maybeSingle();
            if (!r.data) return;
            const c = r.data, cur = form.get();
            if (!cur.bill_to_name) form.set({ bill_to_name: c.title });
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
        if (isNew && prefill.company_id) fillFromCompany(prefill.company_id);
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
                        if (cols.full) Object.assign(header, { company_id: v.company_id || null, subject: v.subject || null, responsible_id: v.responsible_id || me.id });
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
                        if (page.mode === 'list') { refreshList(); openInvoice(id); } else go(`/invoices/?id=${id}`);
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
        const canManage = MANAGE;
        page.mode = 'record';
        if (page.grid) { page.grid.destroy(); page.grid = null; }
        if (page.board) { page.board.destroy(); page.board = null; }
        document.title = `${inv.invoice_number} · Invoices · WorkSuite`;
        WSShell.setCrumb(inv.invoice_number);
        if (edit && canManage && acts.edit) { C.setParam('edit', null, true); openEditor(inv, {}); }
        else if (edit) C.setParam('edit', null, true);

        const stampCls = status === 'paid' ? 'paid' : status === 'overdue' ? 'overdue' : status === 'cancelled' ? 'cancelled' : status === 'draft' ? 'draft' : '';
        const links = [inv.contact_id ? C.entityChip('contact', inv.contact_id, inv.bill_to_name || 'Contact') : '', inv.deal_id ? C.entityChip('deal', inv.deal_id, 'Deal') : '', inv.project_id ? C.entityChip('project', inv.project_id, 'Project') : ''].filter(Boolean).join(' ');

        view.innerHTML = `
            <div class="b24-card-head no-print">
                <h1 class="b24-card-title"><span class="t">${esc(inv.invoice_number)}</span></h1>
                <div class="sub">${statusBadge(inv)} ${esc([inv.subject, inv.bill_to_name].filter(Boolean).join(' · '))} · Issued ${esc(L.fmtDate(inv.invoice_date))}${inv.due_date ? ` · Due ${esc(L.fmtDate(inv.due_date))}` : ''}</div>
                <div class="acts">
                    ${WSShell.inSlider ? '' : `<a class="b24-btn-card" href="/invoices/" data-nav>${C.icon('arrow')}<span>All invoices</span></a>`}
                    ${canManage && acts.send ? `<button type="button" class="b24-btn-create" id="send-btn">Mark sent</button>` : ''}
                    ${canManage && acts.pay ? `<button type="button" class="b24-btn-create" id="pay-btn">Record payment</button>` : ''}
                    ${canManage && acts.edit ? `<button type="button" class="b24-btn-card" id="edit-btn">${C.icon('edit')}<span>Edit</span></button>` : ''}
                    ${canEmail(inv) ? `<button type="button" class="b24-btn-card" id="email-btn">${C.icon('mail')}<span>Email</span></button>` : ''}
                    <button type="button" class="b24-btn-card" id="print-btn">${C.icon('doc')}<span>Print / PDF</span></button>
                    <button type="button" class="b24-btn-card round" id="more-btn" aria-label="More actions">${C.icon('more')}</button>
                </div>
            </div>
            <div class="b24-stages no-print" aria-label="Status">${(() => {
                const steps = [['draft', 'Draft', '#a8adb4'], ['sent', 'Sent', '#2fc6f6'], ['partially_paid', 'Partially paid', '#ffa900'], ['paid', 'Paid', '#7bd500']];
                const reached = { draft: 0, sent: 1, overdue: 1, partially_paid: 2, paid: 3, cancelled: -1 }[status];
                const fin = status === 'overdue' ? ['Overdue', '#ff5752'] : status === 'cancelled' ? ['Cancelled', '#6b7480'] : null;
                return steps.map(([k, label, hex], i) => `<button type="button" class="st${i <= reached ? ' on' : ''}${k === status ? ' cur' : ''}" style="--c:${hex}" disabled><span>${esc(label)}</span></button>`).join('') +
                    (fin ? `<button type="button" class="st final on cur" style="--c:${fin[1]}" disabled><span>${esc(fin[0])}</span></button>` : '');
            })()}</div>
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

        const navBtn = view.querySelector('[data-nav]');
        if (navBtn) navBtn.addEventListener('click', e => { e.preventDefault(); showList(); history.pushState(null, '', '/invoices/'); });
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
        on('#email-btn', () => openEmailDialog(inv, () => feed.reload()));
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
