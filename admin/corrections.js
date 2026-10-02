/* ===========================================================================
 * Admin: attendance correction requests (supabase-attendance-corrections-migration.sql)
 *
 * The card under Leave requests. Employees ask from their attendance page for
 * a forgotten punch or one recorded at the wrong time; approving here adds the
 * right punch and marks the wrong one as replaced. The device's own record is
 * never edited or deleted, and each request is decided once.
 * =========================================================================== */
(function () {
    'use strict';

    const esc = s => (window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s));
    const $ = id => document.getElementById(id);
    const IST = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
    const when = iso => (iso ? IST.format(new Date(iso)).replace(',', '') : '—');
    const name = r => (typeof empNameHtml === 'function' ? empNameHtml(r.employee_id, r.full_name) : esc(r.full_name || r.email || 'Employee'));

    let data = null;

    async function api(action, extra = {}) {
        const r = await adminFetch({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.error || out.detail || `Request failed (${r.status})`);
        return out;
    }

    function badge(st) {
        if (st === 'approved') return '<span class="text-emerald-300 font-black">Approved</span>';
        if (st === 'rejected') return '<span class="text-rose-300 font-black">Rejected</span>';
        return '<span class="text-amber-300 font-black">Pending</span>';
    }

    async function load() {
        if (!adminAuthenticated) return;
        $('ac-tbody').innerHTML = '<tr><td colspan="6" class="p-8 text-center text-slate-400 font-bold">Loading…</td></tr>';
        try {
            data = await api('att_corrections', { status: $('ac-status').value || null });
            render();
        } catch (e) {
            data = null;
            $('ac-counts').textContent = '';
            $('ac-tbody').innerHTML = `<tr><td colspan="6" class="p-8 text-center text-rose-300 font-bold">${esc(e.message)}</td></tr>`;
        }
    }

    function render() {
        const rows = data.requests || [];
        $('ac-counts').textContent = `${data.counts.pending || 0} pending`;
        $('ac-tbody').innerHTML = rows.length ? rows.map(r => `
            <tr data-ac="${esc(r.id)}">
                <td class="font-bold text-white">${name(r)}</td>
                <td class="text-white font-bold whitespace-nowrap">${r.direction === 'IN' ? 'In' : 'Out'} at ${esc(when(r.requested_at))}
                    <br><span class="text-slate-400 text-xs font-bold">${r.kind === 'missing' ? 'Forgot to punch' : 'Wrong time recorded'}</span></td>
                <td class="text-slate-300 font-bold whitespace-nowrap">${r.wrong_punch ? `${r.wrong_punch.direction === 'IN' ? 'In' : 'Out'} at ${esc(when(r.wrong_punch.log_datetime))}` : '—'}</td>
                <td class="text-slate-300 text-xs font-medium" style="max-width:240px;">${esc(r.reason)}</td>
                <td>${badge(r.status)}${r.status !== 'pending'
                    ? `<br><span class="text-slate-500 text-xs font-bold">${esc(r.reviewer || '')}${r.reviewed_at ? ' · ' + esc(when(r.reviewed_at)) : ''}</span>${r.review_note ? `<br><span class="text-slate-400 text-xs">${esc(r.review_note)}</span>` : ''}`
                    : ''}</td>
                <td>${r.status === 'pending' ? `
                    <div class="flex flex-wrap gap-2 items-center">
                        <label class="sr-only" for="ac-note-${esc(r.id)}">Note for ${esc(r.full_name || 'the employee')}</label>
                        <input id="ac-note-${esc(r.id)}" maxlength="500" placeholder="Note (optional)" class="glass px-3 py-1.5 rounded-xl text-xs font-bold w-36 focus:outline-none">
                        <button type="button" data-ac-ok class="glass px-3 py-1.5 rounded-xl text-xs font-bold text-emerald-300 hover:bg-emerald-500/10">Approve</button>
                        <button type="button" data-ac-no class="glass px-3 py-1.5 rounded-xl text-xs font-bold text-rose-300 hover:bg-rose-500/10">Reject</button>
                    </div>` : ''}</td>
            </tr>`).join('')
            : '<tr><td colspan="6" class="p-8 text-center text-slate-400 font-bold">No correction requests for this filter.</td></tr>';
    }

    $('ac-tbody').addEventListener('click', async ev => {
        const ok = ev.target.closest('[data-ac-ok]'), no = ev.target.closest('[data-ac-no]');
        if (!ok && !no) return;
        const tr = ev.target.closest('[data-ac]');
        const req = (data.requests || []).find(r => r.id === tr.dataset.ac);
        if (!req) return;
        const confirmed = await wsDialog.confirm({
            icon: ok ? '✅' : '❌', danger: !ok,
            title: ok ? 'Approve this correction?' : 'Reject this correction?',
            message: ok
                ? `An ${req.direction === 'IN' ? 'In' : 'Out'} punch at <b>${esc(when(req.requested_at))}</b> is added for <b>${esc(req.full_name || '')}</b>` +
                  (req.kind === 'wrong_time' ? ' and replaces the wrong one in attendance and pay. The device’s record is kept.' : '.')
                : `<b>${esc(req.full_name || '')}</b>'s attendance stays as the device recorded it.`,
            okText: ok ? 'Approve' : 'Reject',
        });
        if (!confirmed) return;
        tr.querySelectorAll('button').forEach(b => { b.disabled = true; });
        try {
            await api('att_correction_decide', { id: req.id, status: ok ? 'approved' : 'rejected', note: (tr.querySelector('input') || {}).value || null, full_name: req.full_name });
        } catch (e) {
            await wsDialog.alert({ icon: '⚠️', danger: true, title: 'Could not save the decision', message: esc(e.message) });
        }
        load();
    });

    $('ac-refresh').addEventListener('click', load);
    $('ac-status').addEventListener('change', load);
    document.querySelectorAll('.admin-tab').forEach(btn => {
        btn.addEventListener('click', () => { if (btn.dataset.tab === 'leave' && !data) load(); });
    });
    document.addEventListener('admin-refresh', ev => { if (ev.detail && ev.detail.tab === 'leave') load(); });
})();
