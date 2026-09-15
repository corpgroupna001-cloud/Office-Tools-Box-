/* Admin console: Deals and Leads.
   Every record in the columns of the file it was imported from — a Bitrix24
   export reads here exactly as it did there — with filters, a page at a time,
   the whole record on a click, and Export CSV in that same format (quoted
   cells, semicolons, a byte-order mark), so the download can go straight back
   into Bitrix24 or into CRM import. The cells are built by api/admin.js
   (crm_records) from lib/crm-import.js; this file only shows them. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const main = document.querySelector('.admin-main');
  if (!main) return;

  async function api(action, data = {}) {
    const r = await adminFetch({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...data }) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || 'Request failed');
    return out;
  }
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } },
  };
  /** A cell as text on screen: Bitrix [p] tags off, line breaks kept for the record view. */
  const plain = v => String(v ?? '').replace(/\[br\s*\/?\]/gi, '\n').replace(/\[\/?[a-z][^\]]*\]/gi, '').trim();
  const fmt = n => Number(n || 0).toLocaleString('en-IN');

  /** The export's own shape: every cell quoted, ; between cells and after the last, \n lines, BOM first. */
  function bitrixCsv(headers, rows) {
    const cell = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    return '﻿' + [headers, ...rows].map(r => r.map(cell).join(';') + ';').join('\n') + '\n';
  }
  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  const KINDS = {
    deals: {
      title: 'Deals', one: 'deal', file: 'DEAL', open: '/deals/?id=',
      find: 'Deal name, company or ID',
      intro: 'Every deal, in the columns of the Bitrix24 file it was imported from. Click a row to see all of it. Export CSV downloads every deal that matches the filters, in that same format.',
      columns: ['ID', 'Deal Name', 'Responsible', 'Pipeline', 'Stage', 'Income', 'Currency', 'Contact', 'Type', 'Created', 'Assumed close date'],
    },
    leads: {
      title: 'Leads', one: 'lead', file: 'LEAD', open: '/leads/?id=',
      find: 'Lead name, email, phone or ID',
      intro: 'Every lead, in the columns of the Bitrix24 file it was imported from. Click a row to see all of it. Export CSV downloads every lead that matches the filters, in that same format.',
      columns: ['ID', 'Lead Name', 'Responsible', 'Stage', 'Total', 'Currency', 'Source', 'Position', 'Referrer', 'Created'],
    },
  };

  const views = {};
  Object.entries(KINDS).forEach(([kind, K]) => {
    const p = `crm-${kind}`;
    const el = document.createElement('section');
    el.id = `${kind}-panel`;
    el.className = 'hidden ws-management crm-records';
    el.innerHTML = `<h1>${K.title}</h1>
      <p>${K.intro}</p>
      <div class="mg-toolbar">
        <label class="crm-find">Find<input id="${p}-q" type="search" placeholder="${esc(K.find)}"></label>
        ${kind === 'deals' ? `<label>Pipeline<select id="${p}-pipeline"><option value="">All pipelines</option></select></label>` : ''}
        <label>Stage<select id="${p}-stage"><option value="">All stages</option></select></label>
        ${kind === 'deals' ? `<label>Status<select id="${p}-status"><option value="">Any status</option><option value="open">In progress</option><option value="won">Won</option><option value="lost">Lost</option></select></label>` : ''}
        <label>Employee<select id="${p}-owner"><option value="">Every employee</option><option value="none">No employee</option></select></label>
        <button type="button" id="${p}-cols-btn" aria-expanded="false">Columns</button>
        <button type="button" id="${p}-export" data-csv-export="1" class="btn-primary text-white font-black">Export CSV</button>
      </div>
      <div id="${p}-cols" class="crm-cols" hidden></div>
      <p id="${p}-msg" aria-live="polite"></p>
      <div id="${p}-table"></div>
      <div class="mg-toolbar crm-pager">
        <button type="button" id="${p}-prev">Previous</button>
        <span id="${p}-range"></span>
        <button type="button" id="${p}-next">Next</button>
        <label class="crm-per">Rows<select id="${p}-per"><option>50</option><option>100</option><option>200</option></select></label>
      </div>`;
    main.append(el);
    views[kind] = { kind, K, p, el, page: 0, per: 50, total: 0, headers: [], rows: [], lookups: null, loaded: false, seq: 0 };
  });

  // The record view: every filled-in column, in the file's order.
  const modal = document.createElement('div');
  modal.id = 'crm-record-modal';
  modal.className = 'hidden fixed inset-0 z-50 items-center justify-center p-4';
  modal.style.background = 'rgba(2,6,23,.72)';
  modal.innerHTML = `<div class="glass rounded-2xl p-6 w-full ws-management" role="dialog" aria-modal="true" aria-labelledby="crm-record-title" style="max-width:820px;max-height:90vh;overflow:auto">
    <div class="crm-record-head"><h1 id="crm-record-title"></h1><button type="button" id="crm-record-close" aria-label="Close">Close</button></div>
    <p id="crm-record-sub"></p><dl id="crm-record-fields" class="crm-record-fields"></dl></div>`;
  document.body.append(modal);
  const closeModal = () => { modal.classList.add('hidden'); modal.classList.remove('flex'); };
  $('crm-record-close').addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal(); });

  function filtersOf(v) {
    const val = id => { const n = $(`${v.p}-${id}`); return n ? n.value : ''; };
    const f = { kind: v.kind, q: val('q').trim(), owner_id: val('owner') };
    if (v.kind === 'deals') Object.assign(f, { pipeline_id: val('pipeline'), stage_id: val('stage'), status: val('status') });
    else f.status = val('stage');
    return f;
  }

  function shownColumns(v) {
    const saved = store.get(`ws-admin-${v.kind}-columns`);
    const known = new Set(v.headers.map(h => h.toLowerCase()));
    let cols = Array.isArray(saved) ? saved.filter(h => known.has(h.toLowerCase())) : [];
    if (!cols.length) cols = v.K.columns.filter(h => known.has(h.toLowerCase()));
    if (!cols.length) cols = v.headers.slice(0, 10);
    const index = new Map(v.headers.map((h, i) => [h.toLowerCase(), i]));
    return cols.map(h => ({ name: v.headers[index.get(h.toLowerCase())], i: index.get(h.toLowerCase()) }));
  }

  function fillLookups(v) {
    const L = v.lookups; if (!L) return;
    const put = (id, options, first) => {
      const sel = $(`${v.p}-${id}`); if (!sel) return;
      const was = sel.value;
      sel.innerHTML = first + options.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
      if ([...sel.options].some(o => o.value === was)) sel.value = was;
    };
    if (v.kind === 'deals') {
      put('pipeline', L.pipelines.map(x => ({ value: x.id, label: x.name })), '<option value="">All pipelines</option>');
      const pipe = $(`${v.p}-pipeline`).value;
      const names = new Map(L.pipelines.map(x => [x.id, x.name]));
      put('stage', L.stages.filter(s => !pipe || s.pipeline_id === pipe)
        .map(s => ({ value: s.id, label: pipe ? s.name : `${s.name} — ${names.get(s.pipeline_id) || ''}` })), '<option value="">All stages</option>');
    } else {
      put('stage', L.statuses.map(s => ({ value: s.key, label: s.label })), '<option value="">All stages</option>');
    }
    // Employee ID first, the way the export names people; those without one after, by name.
    const byId = L.people.slice().sort((a, b) => (!a.code - !b.code) || String(a.code || a.name).localeCompare(String(b.code || b.name), 'en', { numeric: true }));
    put('owner', byId.map(x => ({ value: x.id, label: x.code ? `${x.code} · ${x.name}` : x.name })),
      '<option value="">Every employee</option><option value="none">No employee</option>');
    v.codes = new Map(L.people.filter(x => x.code).map(x => [x.code.trim().toLowerCase(), x.name]));
  }

  function renderColumnsPicker(v) {
    const chosen = new Set(shownColumns(v).map(c => c.name.toLowerCase()));
    $(`${v.p}-cols`).innerHTML = `<div class="crm-cols-actions">
        <button type="button" data-cols="default">Default columns</button>
        <button type="button" data-cols="all">Every column</button>
        <span>${fmt(v.headers.length)} columns in the file's order</span></div>
      <div class="crm-cols-grid">${v.headers.map(h => `<label class="mg-check"><input type="checkbox" value="${esc(h)}" ${chosen.has(h.toLowerCase()) ? 'checked' : ''}> ${esc(h)}</label>`).join('')}</div>`;
  }

  function renderTable(v) {
    const cols = shownColumns(v);
    if (!v.rows.length) {
      $(`${v.p}-table`).innerHTML = `<div class="mg-scroll"><table class="mg-table"><tbody><tr><td>${
        v.total ? 'No more rows.' : `No ${v.K.one}s match. Import a file in CRM import, or change the filters.`}</td></tr></tbody></table></div>`;
      return;
    }
    $(`${v.p}-table`).innerHTML = `<div class="mg-scroll crm-scroll"><table class="mg-table crm-table"><thead><tr>${
      cols.map(c => `<th scope="col">${esc(c.name)}</th>`).join('')}</tr></thead><tbody>${
      v.rows.map((r, n) => `<tr data-row="${n}" tabindex="0">${cols.map(c => {
        const text = plain(r.cells[c.i]).replace(/\s+/g, ' ');
        const name = employeeName(v, text);
        if (name) return `<td class="crm-emp"><b>${esc(text)}</b><small>${esc(name)}</small></td>`;
        return `<td title="${esc(text.length > 60 ? text : '')}">${esc(text.length > 60 ? text.slice(0, 57) + '…' : text)}</td>`;
      }).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  /** The name behind a cell that holds an employee ID (Responsible, Created by, Service Leads Executive…). */
  function employeeName(v, text) {
    return v.codes && text ? v.codes.get(text.trim().toLowerCase()) || '' : '';
  }

  function renderPager(v) {
    const from = v.total ? v.page * v.per + 1 : 0;
    const to = Math.min(v.total, v.page * v.per + v.rows.length);
    $(`${v.p}-range`).textContent = v.total ? `${fmt(from)}–${fmt(to)} of ${fmt(v.total)}` : '0 records';
    $(`${v.p}-prev`).disabled = v.page === 0;
    $(`${v.p}-next`).disabled = to >= v.total;
  }

  async function load(v) {
    const seq = ++v.seq;
    $(`${v.p}-msg`).textContent = 'Loading…';
    try {
      const d = await api('crm_records', { ...filtersOf(v), page: v.page, per: v.per, lookups: !v.lookups });
      if (seq !== v.seq) return;                         // a newer filter change has already asked again
      v.loaded = true;
      if (d.lookups) { v.lookups = d.lookups; fillLookups(v); }
      v.headers = d.headers; v.rows = d.rows; v.total = d.total;
      $(`${v.p}-msg`).textContent = d.migrated ? '' : 'Showing WorkSuite\'s own columns only — run supabase-crm-import-migration.sql, then import the files again, to see every column of the export.';
      renderTable(v); renderPager(v);
      if (!$(`${v.p}-cols`).hidden) renderColumnsPicker(v);
    } catch (e) {
      if (seq !== v.seq) return;
      $(`${v.p}-msg`).textContent = e.message;
      $(`${v.p}-table`).innerHTML = '';
    }
  }

  function openRecord(v, n) {
    const r = v.rows[n]; if (!r) return;
    const at = name => { const i = v.headers.findIndex(h => h.toLowerCase() === name.toLowerCase()); return i < 0 ? '' : plain(r.cells[i]); };
    $('crm-record-title').textContent = at(v.kind === 'deals' ? 'Deal Name' : 'Lead Name') || `Untitled ${v.K.one}`;
    $('crm-record-sub').innerHTML = `${esc([at('ID') && `ID ${at('ID')}`, at('Pipeline'), at('Stage')].filter(Boolean).join(' · '))}
      · <a href="${v.K.open}${encodeURIComponent(r.id)}" target="_blank" rel="noopener">Open in CRM</a>`;
    $('crm-record-fields').innerHTML = v.headers.map((h, i) => {
      const text = plain(r.cells[i]);
      const name = employeeName(v, text);
      return text ? `<dt>${esc(h)}</dt><dd>${name ? `<b>${esc(text)}</b> · ${esc(name)}` : esc(text)}</dd>` : '';
    }).join('');
    modal.classList.remove('hidden'); modal.classList.add('flex');
    $('crm-record-close').focus();
  }

  async function exportAll(v) {
    const btn = $(`${v.p}-export`);
    const f = filtersOf(v);
    btn.disabled = true;
    const rows = [];
    let headers = v.headers, total = null;
    try {
      for (let page = 0; total === null || page * 1000 < total; page++) {
        $(`${v.p}-msg`).textContent = total === null ? 'Preparing the export…' : `Exporting ${fmt(Math.min(page * 1000, total))} of ${fmt(total)}…`;
        const d = await api('crm_records', { ...f, page, per: 1000 });
        headers = d.headers; total = d.total;
        d.rows.forEach(r => rows.push(r.cells));
        if (!d.rows.length) break;
      }
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()).replace(/-/g, '');
      download(`${v.K.file}_${day}.csv`, bitrixCsv(headers, rows));
      $(`${v.p}-msg`).textContent = `Exported ${fmt(rows.length)} ${v.K.one}${rows.length === 1 ? '' : 's'} in the export's format.`;
    } catch (e) {
      $(`${v.p}-msg`).textContent = `The export stopped: ${e.message}`;
    } finally { btn.disabled = false; }
  }

  Object.values(views).forEach(v => {
    const again = () => { v.page = 0; load(v); };
    let timer;
    $(`${v.p}-q`).addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(again, 350); });
    ['stage', 'status', 'owner'].forEach(id => { const n = $(`${v.p}-${id}`); if (n) n.addEventListener('change', again); });
    if (v.kind === 'deals') $(`${v.p}-pipeline`).addEventListener('change', () => { $(`${v.p}-stage`).value = ''; fillLookups(v); again(); });
    $(`${v.p}-per`).addEventListener('change', e => { v.per = Number(e.target.value) || 50; again(); });
    $(`${v.p}-prev`).addEventListener('click', () => { if (v.page > 0) { v.page--; load(v); } });
    $(`${v.p}-next`).addEventListener('click', () => { if ((v.page + 1) * v.per < v.total) { v.page++; load(v); } });
    $(`${v.p}-export`).addEventListener('click', () => exportAll(v));
    $(`${v.p}-cols-btn`).addEventListener('click', e => {
      const box = $(`${v.p}-cols`);
      box.hidden = !box.hidden;
      e.currentTarget.setAttribute('aria-expanded', String(!box.hidden));
      if (!box.hidden) renderColumnsPicker(v);
    });
    $(`${v.p}-cols`).addEventListener('change', () => {
      const picked = [...$(`${v.p}-cols`).querySelectorAll('input:checked')].map(i => i.value);
      store.set(`ws-admin-${v.kind}-columns`, picked);
      renderTable(v);
    });
    $(`${v.p}-cols`).addEventListener('click', e => {
      const b = e.target.closest('[data-cols]'); if (!b) return;
      store.set(`ws-admin-${v.kind}-columns`, b.dataset.cols === 'all' ? v.headers : null);
      renderColumnsPicker(v); renderTable(v);
    });
    $(`${v.p}-table`).addEventListener('click', e => { const tr = e.target.closest('tr[data-row]'); if (tr) openRecord(v, Number(tr.dataset.row)); });
    $(`${v.p}-table`).addEventListener('keydown', e => {
      const tr = e.target.closest('tr[data-row]');
      if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openRecord(v, Number(tr.dataset.row)); }
    });
  });

  let active = '';
  document.querySelectorAll('.admin-tab').forEach(tab => tab.addEventListener('click', () => {
    active = tab.dataset.tab;
    Object.values(views).forEach(v => {
      v.el.classList.toggle('hidden', active !== v.kind);
      if (active === v.kind && !v.loaded) load(v);
    });
  }));
  window.addEventListener('admin-refresh', () => { if (views[active]) load(views[active]); });
  document.addEventListener('admin-refresh', () => { if (views[active]) load(views[active]); });
  // An import changes what these tabs show.
  window.addEventListener('crm-imported', () => Object.values(views).forEach(v => { v.loaded = false; v.lookups = null; }));
}());
