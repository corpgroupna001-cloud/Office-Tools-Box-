/* Admin console: onboarding, offboarding, CSV export/import and the audit log.
   Sits alongside management.js (company structure + email monitoring + editor
   fields) and, like it, builds its own panels rather than editing the page. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const main = document.querySelector('.admin-main');
  async function api(action, data = {}) {
    const r = await adminFetch({ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action,...data}) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || 'Request failed');
    return out;
  }
  const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const daysAgo = n => new Date(Date.parse(today()) - n*86400000).toISOString().slice(0,10);
  const stamp = v => v ? new Date(v).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}) : '—';
  const panel = (id, html) => {
    const el = document.createElement('section');
    el.id = id; el.className = 'hidden ws-management'; el.innerHTML = html;
    main.append(el); return el;
  };

  /* ===================== CSV =====================
     Excel decides a leading "ID"/"SEP" means SYLK, and turns a bare 09:00 into
     a time; quoting every field and prefixing the BOM keeps a punch log
     readable in the spreadsheet HR actually opens it in. */
  function csvCell(value) {
    const s = String(value ?? '').replace(/\s+/g, ' ').trim();
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function download(name, text, type = 'text/csv;charset=utf-8') {
    const url = URL.createObjectURL(new Blob(['﻿' + text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  /* A cell's value, not its widgets: a toggle exports as Yes/No and a dropdown
     as its chosen label, so the sheet says what the screen says. */
  function cellValue(cell) {
    const box = cell.querySelector('input[type="checkbox"]');
    if (box) return box.checked ? 'Yes' : 'No';
    const select = cell.querySelector('select');
    if (select) return select.selectedOptions[0] ? select.selectedOptions[0].text : select.value;
    const field = cell.querySelector('input, textarea');
    if (field) return field.value;
    return cell.innerText;
  }
  /* A column of nothing but buttons is the row's Actions — it has no value to
     export. Dropping it by index keeps the header and the rows lined up. */
  function actionColumns(bodyRows) {
    if (!bodyRows.length) return new Set();
    const width = Math.max(...bodyRows.map(tr => tr.children.length));
    const drop = new Set();
    for (let i = 0; i < width; i++) {
      const cells = bodyRows.map(tr => tr.children[i]).filter(Boolean);
      if (cells.length && cells.every(cell => cell.querySelector('button') && !cell.innerText.trim())) drop.add(i);
    }
    return drop;
  }
  /* Export what the admin is actually looking at — the rendered table, after
     their search and filters — rather than a second server query that might
     disagree with the screen. */
  function exportTable(table, name) {
    const head = [...table.querySelectorAll('thead tr')];
    const body = [...table.querySelectorAll('tbody tr')];
    const drop = actionColumns(body);
    const line = (tr, read) => [...tr.children].filter((_, i) => !drop.has(i)).map(cell => csvCell(read(cell))).join(',');
    const rows = [...head.map(tr => line(tr, c => c.innerText)), ...body.map(tr => line(tr, cellValue))];
    if (!body.length) { alert('There is nothing to export on this tab yet.'); return; }
    download(`${name}-${today()}.csv`, rows.join('\r\n'));
  }
  /* Split on commas outside quotes; "" is an escaped quote inside a field. */
  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    const src = String(text).replace(/^﻿/, '');
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quoted) {
        if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* handled by \n */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(cell => cell.trim()));
  }

  // An "Export CSV" button on every panel that renders a table, wired lazily so
  // it always exports the table as it stands right now.
  function addExportButtons() {
    document.querySelectorAll('.admin-main > div[id$="-panel"], .admin-main > section[id$="-panel"]').forEach(p => {
      if (p.querySelector('[data-csv-export]') || !p.querySelector('table')) return;
      const btn = document.createElement('button');
      btn.type = 'button'; btn.dataset.csvExport = '1';
      btn.className = 'glass px-4 py-2 rounded-xl text-sm font-bold ws-export';
      btn.textContent = 'Export CSV';
      btn.title = 'Download the rows shown below, with the filters you have applied';
      btn.addEventListener('click', () => {
        const table = p.querySelector('table');
        if (!table) return;
        exportTable(table, p.id.replace('-panel', ''));
      });
      const bar = p.querySelector('.glass.rounded-2xl.p-4, .mg-toolbar');
      if (bar) bar.append(btn); else p.prepend(btn);
    });
  }

  /* ===================== Add employee ===================== */
  const addModal = document.createElement('div');
  addModal.id = 'add-emp-modal';
  addModal.className = 'hidden fixed inset-0 z-50 items-center justify-center p-4';
  addModal.style.background = 'rgba(2,6,23,.72)';
  addModal.innerHTML = `<div class="glass rounded-2xl p-6 w-full ws-management" style="max-width:760px;max-height:90vh;overflow:auto">
    <h1>Add employee</h1>
    <p>Creates the login account and the employee record together. They are emailed a link to set their own password — no password is chosen here or sent in plain text.</p>
    <div id="add-emp-fields" class="mg-fields"></div>
    <label class="mg-check"><input id="add-emp-invite" type="checkbox" checked> Email them an invite to set a password</label>
    <p id="add-emp-err" class="mg-error hidden"></p>
    <div class="mg-toolbar"><button id="add-emp-cancel" type="button">Cancel</button><button id="add-emp-save" type="button" class="btn-primary text-white font-black px-5 py-2 rounded-xl">Create account</button></div>
  </div>`;
  document.body.append(addModal);

  const ADD_FIELDS = [['full_name','Full name','text'],['email','Login / notification email','email'],
    ['company','Company','company'],['employee_code','Biometric employee code','text'],
    ['department','Department','text'],['job_title','Job title','text'],['phone','Phone','tel'],
    ['joining_date','Joining date','date'],['shift_id','Primary shift','shift']];

  async function openAdd() {
    $('add-emp-err').classList.add('hidden');
    $('add-emp-fields').textContent = 'Loading shifts…';
    addModal.classList.remove('hidden'); addModal.classList.add('flex');
    let shifts = [];
    try { shifts = (await api('shift_list')).shifts || []; } catch { /* shifts are optional */ }
    const clock = t => { const h = Number(String(t).slice(0,2)); return `${h%12 || 12}:${String(t).slice(3,5)} ${h>=12?'PM':'AM'}`; };
    $('add-emp-fields').innerHTML = ADD_FIELDS.map(([key,label,type]) => {
      let input;
      if (type === 'company') input = `<select id="add-emp-${key}"><option value="">Select company</option>${WSCompanies.companies.map(c=>`<option>${esc(c)}</option>`).join('')}</select>`;
      else if (type === 'shift') input = `<select id="add-emp-${key}"><option value="">Company default</option>${shifts.map(s=>`<option value="${esc(s.id)}">${esc(s.name)} · ${clock(s.start_time)} – ${clock(s.end_time)}</option>`).join('')}</select>`;
      else input = `<input id="add-emp-${key}" type="${type}">`;
      return `<label>${label}${input}</label>`;
    }).join('') + `<label class="mg-check"><input id="add-emp-is_wfh" type="checkbox"> Works from home</label>`;
  }
  function closeAdd() { addModal.classList.add('hidden'); addModal.classList.remove('flex'); }

  async function submitAdd() {
    const data = { send_invite: $('add-emp-invite').checked, is_wfh: $('add-emp-is_wfh').checked };
    for (const [key] of ADD_FIELDS) { const v = $('add-emp-' + key).value.trim(); if (v) data[key] = v; }
    const err = $('add-emp-err');
    err.classList.add('hidden');
    $('add-emp-save').disabled = true;
    try {
      const out = await api('create_employee', data);
      closeAdd();
      if (out.warning) alert(out.warning);
      window.dispatchEvent(new CustomEvent('admin-refresh'));
      if (window.WSAdminEmployees) WSAdminEmployees.reload();
    } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
    finally { $('add-emp-save').disabled = false; }
  }
  $('add-emp-cancel').addEventListener('click', closeAdd);
  $('add-emp-save').addEventListener('click', submitAdd);
  addModal.addEventListener('click', e => { if (e.target === addModal) closeAdd(); });

  /* ===================== Offboard / reactivate ===================== */
  const exitModal = document.createElement('div');
  exitModal.id = 'exit-emp-modal';
  exitModal.className = 'hidden fixed inset-0 z-50 items-center justify-center p-4';
  exitModal.style.background = 'rgba(2,6,23,.72)';
  exitModal.innerHTML = `<div class="glass rounded-2xl p-6 w-full ws-management" style="max-width:520px">
    <h1 id="exit-emp-title">Offboard employee</h1>
    <p id="exit-emp-copy"></p>
    <div id="exit-emp-fields" class="mg-fields"></div>
    <p id="exit-emp-err" class="mg-error hidden"></p>
    <div class="mg-toolbar"><button id="exit-emp-cancel" type="button">Cancel</button><button id="exit-emp-save" type="button" class="btn-primary text-white font-black px-5 py-2 rounded-xl">Confirm</button></div>
  </div>`;
  document.body.append(exitModal);
  let exitTarget = null;

  function openExit(emp) {
    exitTarget = emp;
    const leaving = (emp.status || 'active') === 'active';
    $('exit-emp-err').classList.add('hidden');
    $('exit-emp-title').textContent = leaving ? 'Offboard employee' : 'Bring employee back';
    $('exit-emp-copy').textContent = leaving
      ? `${emp.full_name || emp.email} will no longer be able to sign in, and drops out of the live schedule and company structure. Their attendance, payroll, leave and assessment history is kept — this is not a deletion.`
      : `${emp.full_name || emp.email} will be able to sign in again and returns to the live schedule. Any last working day on record is cleared.`;
    $('exit-emp-fields').innerHTML = leaving
      ? `<label>Last working day<input id="exit-emp-date" type="date" value="${today()}"></label><label>Reason (optional)<input id="exit-emp-reason" type="text" placeholder="Resigned, contract ended…"></label>`
      : '';
    $('exit-emp-save').textContent = leaving ? 'Offboard' : 'Reactivate';
    exitModal.classList.remove('hidden'); exitModal.classList.add('flex');
  }
  function closeExit() { exitModal.classList.add('hidden'); exitModal.classList.remove('flex'); exitTarget = null; }

  async function submitExit() {
    if (!exitTarget) return;
    const leaving = (exitTarget.status || 'active') === 'active';
    const err = $('exit-emp-err');
    err.classList.add('hidden');
    $('exit-emp-save').disabled = true;
    try {
      const out = await api('set_employee_status', { id: exitTarget.id, status: leaving ? 'inactive' : 'active',
        exit_date: leaving ? ($('exit-emp-date').value || '') : '', exit_reason: leaving ? ($('exit-emp-reason').value || '') : '' });
      closeExit();
      if (out.warning) alert(out.warning);
      window.dispatchEvent(new CustomEvent('admin-refresh'));
      if (window.WSAdminEmployees) WSAdminEmployees.reload();
    } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
    finally { $('exit-emp-save').disabled = false; }
  }
  $('exit-emp-cancel').addEventListener('click', closeExit);
  $('exit-emp-save').addEventListener('click', submitExit);
  exitModal.addEventListener('click', e => { if (e.target === exitModal) closeExit(); });

  // Employees table: an Add button in the toolbar, and an offboard control per row.
  const empToolbar = document.querySelector('#employees-panel .glass.rounded-2xl.p-4');
  if (empToolbar) {
    const add = document.createElement('button');
    add.type = 'button'; add.id = 'emp-add';
    add.className = 'btn-primary text-white font-black px-5 py-2 rounded-xl text-sm';
    add.textContent = '+ Add employee';
    add.addEventListener('click', openAdd);
    empToolbar.append(add);
  }
  window.addEventListener('employees-rendered', () => {
    document.querySelectorAll('#emp-tbody [data-action="exit"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const emp = (window.WSAdminEmployees ? WSAdminEmployees.all() : []).find(x => x.id === btn.dataset.id);
        if (emp) openExit(emp);
      });
    });
  });

  /* ===================== Bulk import ===================== */
  const COLUMNS = ['email','full_name','company','employee_code','department','job_title','phone','joining_date','is_wfh'];
  let importRows = [], importPreviewed = false;
  const importPanel = panel('import-panel', `<h1>Bulk import employees</h1>
    <p>Upload or paste a CSV. Rows are matched on <b>email</b>: an address already in WorkSuite is updated, a new one creates an account and sends an invite. Nothing is written until you check the preview and confirm. Large files are sent in small batches, so a big import takes a little while — leave the tab open until it finishes.</p>
    <div class="mg-toolbar">
      <label>CSV file<input id="im-file" type="file" accept=".csv,text/csv"></label>
      <button id="im-template">Download template</button>
      <label class="mg-check"><input id="im-invite" type="checkbox" checked> Invite new employees by email</label>
    </div>
    <label>Or paste CSV<textarea id="im-text" rows="6" style="width:100%;font-family:ui-monospace,monospace;font-size:12px" placeholder="email,full_name,company,employee_code"></textarea></label>
    <div class="mg-toolbar"><button id="im-preview" class="btn-primary text-white font-black px-5 py-2 rounded-xl">Check the file</button><button id="im-apply" disabled>Apply changes</button></div>
    <p id="im-message" aria-live="polite"></p><div id="im-results"></div>`);

  $('im-template').addEventListener('click', () => {
    download('worksuite-employee-import-template.csv',
      COLUMNS.join(',') + '\r\n' + csvCell('new.person@example.com') + ',' + csvCell('New Person') + ',' +
      csvCell(WSCompanies.companies[0]) + ',' + csvCell('00000123') + ',' + csvCell('Operations') + ',' +
      csvCell('Executive') + ',' + csvCell('9000000000') + ',' + csvCell(today()) + ',' + csvCell('false'));
  });
  $('im-file').addEventListener('change', async () => {
    const file = $('im-file').files[0];
    if (file) { $('im-text').value = await file.text(); $('im-message').textContent = `Loaded ${file.name}. Check the file to see what would change.`; }
  });

  function readRows() {
    const table = parseCsv($('im-text').value);
    if (!table.length) throw new Error('No rows found. Paste a CSV or choose a file.');
    const header = table[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
    const unknown = header.filter(h => h && !COLUMNS.includes(h));
    if (!header.includes('email')) throw new Error('The first row must be a header containing an "email" column.');
    return { unknown, rows: table.slice(1).map((cells, i) => {
      const row = { line: i + 2 };
      header.forEach((key, c) => {
        if (!COLUMNS.includes(key)) return;
        const value = (cells[c] ?? '').trim();
        if (!value) return;
        if (key === 'is_wfh') row[key] = /^(true|yes|y|1|wfh)$/i.test(value);
        else row[key] = value;
      });
      return row;
    }) };
  }

  /* Each row costs the server several round trips to Supabase and GoTrue, and a
     Vercel function has ten seconds. So the file is sent in small batches: one
     batch per request, results accumulated here. A batch that fails leaves the
     batches before it applied — which is why every row reports its own outcome
     and why the preview has to be clean before Apply is offered. */
  const CHUNK = 20;
  function renderImport(rows) {
    $('im-results').innerHTML = `<div class="mg-scroll"><table class="mg-table"><thead><tr><th>Line</th><th>Email</th><th>Name</th><th>Outcome</th><th>Detail</th></tr></thead><tbody>${
      rows.map(r => `<tr><td>${r.line}</td><td>${esc(r.email || '—')}</td><td>${esc(r.name || '—')}</td><td><span class="mg-status ${r.outcome==='error'?'bad':r.outcome==='skip'?'':'ok'}">${esc(r.outcome)}</span></td><td>${esc(r.message)}</td></tr>`).join('')
    }</tbody></table></div>`;
  }

  async function runImport(apply) {
    const message = $('im-message');
    $('im-preview').disabled = true; $('im-apply').disabled = true;
    try {
      const { rows, unknown } = readRows();
      importRows = rows;
      const done = [];
      for (let i = 0; i < rows.length; i += CHUNK) {
        const batch = rows.slice(i, i + CHUNK);
        message.textContent = `${apply ? 'Applying' : 'Checking'} rows ${i + 1}–${Math.min(i + CHUNK, rows.length)} of ${rows.length}…`;
        try {
          const out = await api('bulk_employees', { rows: batch, apply, send_invite: $('im-invite').checked });
          done.push(...out.rows);
        } catch (e) {
          // Report the batch that failed against its own lines rather than
          // losing the outcome of everything already done.
          done.push(...batch.map(r => ({ line: r.line, email: r.email || null, name: r.full_name || null,
            outcome: 'error', message: e.message })));
        }
        renderImport(done);
      }
      const tally = done.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] || 0) + 1 }), {});
      const summary = Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(' · ');
      const errors = done.filter(r => r.outcome === 'error').length;
      // Duplicate emails inside the file only show up when both copies land in
      // the same batch, so the whole file is checked here too.
      const seen = new Set(), repeated = new Set();
      done.forEach(r => { if (r.email) (seen.has(r.email) ? repeated : seen).add(r.email); });
      importPreviewed = !apply && !errors && !repeated.size;
      $('im-apply').disabled = !importPreviewed;
      message.textContent = (unknown.length ? `Ignored unknown columns: ${unknown.join(', ')}. ` : '')
        + (repeated.size ? `The same address appears more than once: ${[...repeated].join(', ')}. ` : '')
        + (apply
          ? `Import finished — ${summary}.`
          : errors || repeated.size
            ? `${summary}. Fix the rows marked above, then check the file again. Nothing has been written.`
            : `${summary}. Nothing has been written yet — press Apply changes to go ahead.`);
    } catch (e) { message.textContent = e.message; $('im-results').innerHTML = ''; }
    finally { $('im-preview').disabled = false; }
  }
  $('im-preview').addEventListener('click', () => runImport(false));
  $('im-apply').addEventListener('click', () => {
    if (!importPreviewed) return;
    const creating = importRows.length;
    if (!confirm(`Apply ${creating} row${creating > 1 ? 's' : ''}? New employees will be emailed an invite.`)) return;
    runImport(true);
  });
  ['im-text'].forEach(id => $(id).addEventListener('input', () => { importPreviewed = false; $('im-apply').disabled = true; }));

  /* ===================== Audit log ===================== */
  let auditPage = 0, auditMore = false;
  panel('audit-panel', `<h1>Audit log</h1>
    <p>Every change made from this console — who changed what, and whether it worked. Reads are not logged, and no passwords, verification codes or webhook URLs are recorded. Entries start from the release that added this log.</p>
    <div class="mg-toolbar">
      <label>From (IST)<input id="au-from" type="date"></label>
      <label>To (IST)<input id="au-to" type="date"></label>
      <label>Result<select id="au-status"><option value="">All results</option><option value="ok">Succeeded</option><option value="failed">Failed</option></select></label>
      <label>Find<input id="au-search" type="search" placeholder="Employee or description"></label>
      <button id="au-refresh">Refresh</button>
    </div>
    <p id="au-message" aria-live="polite"></p><div id="au-rows"></div>
    <div class="mg-toolbar"><button id="au-prev">Previous</button><span id="au-page"></span><button id="au-next">Next</button></div>`);
  $('au-to').value = today(); $('au-from').value = daysAgo(6);

  async function loadAudit() {
    $('au-message').textContent = 'Loading…';
    $('au-prev').disabled = true; $('au-next').disabled = true;
    try {
      const d = await api('audit_log', { from: $('au-from').value, to: $('au-to').value,
        status: $('au-status').value, search: $('au-search').value.trim(), page: auditPage });
      auditMore = d.more;
      $('au-rows').innerHTML = `<div class="mg-scroll"><table class="mg-table"><thead><tr><th>Time (IST)</th><th>Change</th><th>Employee / record</th><th>Result</th><th>Source</th></tr></thead><tbody>${
        d.rows.map(r => `<tr><td>${esc(stamp(r.created_at))}</td><td>${esc(r.summary || r.action)}<small>${esc(r.action)}</small></td><td>${esc(r.target_label || '—')}<small>${esc(r.target_id || '')}</small></td><td><span class="mg-status ${r.status==='ok'?'ok':'bad'}">${r.status==='ok'?'Succeeded':'Failed'}</span>${r.detail?`<small>${esc(r.detail)}</small>`:''}</td><td>${esc(r.actor_ip || '—')}<small>HTTP ${esc(r.http_status ?? '—')}</small></td></tr>`).join('')
        || '<tr><td colspan="5">No admin changes in this date range.</td></tr>'
      }</tbody></table></div>`;
      $('au-message').textContent = '';
      $('au-page').textContent = `Page ${auditPage + 1}`;
      $('au-prev').disabled = auditPage === 0; $('au-next').disabled = !auditMore;
    } catch (e) { $('au-message').textContent = e.message; $('au-rows').innerHTML = ''; }
  }
  ['au-from','au-to','au-status'].forEach(id => $(id).addEventListener('change', () => { auditPage = 0; loadAudit(); }));
  let searchTimer;
  $('au-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { auditPage = 0; loadAudit(); }, 350); });
  $('au-refresh').addEventListener('click', () => { auditPage = 0; loadAudit(); });
  $('au-prev').addEventListener('click', () => { if (auditPage > 0) { auditPage--; loadAudit(); } });
  $('au-next').addEventListener('click', () => { if (auditMore) { auditPage++; loadAudit(); } });

  /* ===================== Tabs ===================== */
  let active = '';
  document.querySelectorAll('.admin-tab').forEach(tab => tab.addEventListener('click', () => {
    active = tab.dataset.tab;
    importPanel.classList.toggle('hidden', active !== 'import');
    $('audit-panel').classList.toggle('hidden', active !== 'audit');
    if (active === 'audit') loadAudit();
  }));
  window.addEventListener('admin-refresh', () => { if (active === 'audit') loadAudit(); });

  // Most panels build their table only once their data arrives, so watch for it
  // rather than guessing when each tab has finished loading.
  let pending;
  new MutationObserver(() => { clearTimeout(pending); pending = setTimeout(addExportButtons, 80); })
    .observe(main, { childList: true, subtree: true });
  addExportButtons();
}());
