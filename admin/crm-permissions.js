/* Admin console: CRM permissions.
   The roles matrix from CRM settings (crm/settings/settings.js), for the
   console: roles, what each may do with leads, deals (per pipeline),
   contacts, companies, invoices and CRM settings, and who has each role.
   The database enforces all of it (ws_crm_levels / ws_crm_row_ok); the
   console writes through api/admin.js (crm_perm_load / crm_perm_save),
   because it uses the service role rather than a signed-in user. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const main = document.querySelector('.admin-main');
  if (!main) return;

  async function api(action, data = {}) {
    const r = await adminFetch({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...data }) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((out.error || 'Request failed') + (out.detail ? ` — ${out.detail}` : ''));
    return out;
  }
  const save = (op, data) => api('crm_perm_save', { op, ...data });

  // The same lists as CRM settings and the database constraint.
  const LEVELS = [
    { value: 'none', label: 'No access' }, { value: 'own', label: 'Personal' },
    { value: 'department', label: 'Personal and department' }, { value: 'subdepartments', label: 'Personal, department and sub-departments' },
    { value: 'all', label: 'All' },
  ];
  const ENTITIES = [
    { key: 'lead', title: 'Leads', actions: ['read', 'add', 'edit', 'delete', 'export', 'import', 'move_stage', 'automation'] },
    { key: 'deal', title: 'Deals', actions: ['read', 'add', 'edit', 'delete', 'export', 'import', 'move_stage', 'automation'], pipelines: true },
    { key: 'contact', title: 'Contacts', actions: ['read', 'add', 'edit', 'delete', 'export', 'import'] },
    { key: 'company', title: 'Companies', actions: ['read', 'add', 'edit', 'delete', 'export', 'import'] },
    { key: 'invoice', title: 'Invoices', actions: ['read', 'add', 'edit', 'delete', 'export'] },
    { key: 'settings', title: 'CRM settings', actions: ['edit'] },
  ];
  const ACTIONS = { read: 'Read', add: 'Add', edit: 'Update', delete: 'Delete', export: 'Export', import: 'Import', move_stage: 'Move to stage', automation: 'Automation rules' };

  const el = document.createElement('section');
  el.id = 'crmperms-panel';
  el.className = 'hidden ws-management crm-perms';
  el.setAttribute('data-no-export', '');
  el.innerHTML = `<h1>CRM permissions</h1>
    <p>Roles decide what employees see and change in the CRM. A person's rights are the strongest of all their roles; workspace admins always have full access.
    Everyone sees CRM records of their own company only (and a second company, if they have one). Changes apply at once, in the CRM and to direct API calls.</p>
    <p id="cp-msg" aria-live="polite"></p>
    <div class="cp-layout">
      <div class="cp-roles" id="cp-roles"></div>
      <div class="cp-role" id="cp-role"></div>
    </div>`;
  main.append(el);

  let data = null, roleId = null, loaded = false;
  const msg = (text, bad) => { const m = $('cp-msg'); m.textContent = text || ''; m.className = bad ? 'mg-error' : ''; };
  const deptName = id => ((data.departments || []).find(d => d.id === id) || {}).name || 'Department';
  const person = id => (data.people || []).find(p => p.id === id);
  const personText = id => { const p = person(id); if (!p) return 'Former employee'; const n = p.full_name || p.email || 'Employee'; return p.employee_id ? `${p.employee_id} · ${n}` : n; };
  const permOf = (entity, pipeline, action) => data.permissions.find(p => p.role_id === roleId && p.entity === entity && (p.pipeline_id || null) === (pipeline || null) && p.action === action);

  function assignLabel(a) {
    if (a.principal_type === 'all') return 'All employees';
    if (a.principal_type === 'app_role') return a.principal_key === 'manager' ? 'Workspace managers' : 'Workspace employees';
    if (a.principal_type === 'department') return `Department: ${deptName(a.principal_id)} (and sub-departments)`;
    return personText(a.principal_id);
  }

  function cell(entity, pipeline, action) {
    const p = permOf(entity, pipeline, action);
    const val = p ? p.level : (pipeline ? '' : 'none');
    const opts = (pipeline ? [{ value: '', label: 'As for all pipelines' }] : []).concat(LEVELS);
    const limit = action === 'move_stage' && p && p.level !== 'none'
      ? `<button type="button" class="cp-link" data-stages="${esc(entity)}|${esc(pipeline || '')}">${(p.extra && p.extra.stages && p.extra.stages.length) ? `${p.extra.stages.length} stage${p.extra.stages.length === 1 ? '' : 's'} only` : 'All stages'}</button>` : '';
    return `<td><select data-perm="${esc(entity)}|${esc(pipeline || '')}|${esc(action)}" aria-label="${esc(ACTIONS[action])}">${opts.map(o => `<option value="${o.value}"${o.value === val ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>${limit}</td>`;
  }

  function render() {
    if (!data) return;
    if (!data.roles.find(r => r.id === roleId)) roleId = (data.roles[0] || {}).id || null;
    $('cp-roles').innerHTML = data.roles.map(r => {
      const n = data.assignments.filter(a => a.role_id === r.id).length;
      return `<button type="button" data-role="${esc(r.id)}" class="${r.id === roleId ? 'on' : ''}"><b>${esc(r.name)}</b>${r.is_system ? ' <small>built in</small>' : ''}<small>${n ? `${n} assignment${n === 1 ? '' : 's'}` : 'not assigned'}</small></button>`;
    }).join('') + `<form class="cp-add" id="cp-add-role"><input name="name" placeholder="New role name" maxlength="100" required><button type="submit">Add role</button></form>`;

    const role = data.roles.find(r => r.id === roleId);
    if (!role) { $('cp-role').innerHTML = '<p>No roles yet. Add one on the left.</p>'; return; }
    const actions = Object.keys(ACTIONS);
    const rowAll = (ent, pipeline) => `<td><select data-perm-row="${esc(ent.key)}|${esc(pipeline || '')}" aria-label="Every action for ${esc(ent.title)}"><option value="__">Set all…</option>${(pipeline ? [{ value: '', label: 'As for all pipelines' }] : []).concat(LEVELS).map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join('')}</select></td>`;
    const row = (ent, pipeline, label) => `<tr${pipeline ? ' class="sub"' : ''}><th scope="row">${esc(label)}</th>${rowAll(ent, pipeline)}${actions.map(a => ent.actions.includes(a) ? cell(ent.key, pipeline, a) : '<td class="na">—</td>').join('')}</tr>`;
    const assigns = data.assignments.filter(a => a.role_id === role.id);
    $('cp-role').innerHTML = `
      <form class="cp-head" id="cp-rename">
        <label>Role name<input name="name" value="${esc(role.name)}" maxlength="100" required></label>
        <label class="grow">Description<input name="description" value="${esc(role.description || '')}" maxlength="500"></label>
        <button type="submit">Save name</button>
        <button type="button" id="cp-copy">Copy role</button>
        ${role.is_system ? '' : '<button type="button" id="cp-delete" class="danger">Delete role</button>'}
      </form>
      <div class="mg-scroll cp-matrix-wrap"><table class="mg-table cp-matrix">
        <thead><tr><th scope="col">Entity</th><th scope="col">Every action</th>${actions.map(a => `<th scope="col">${esc(ACTIONS[a])}</th>`).join('')}</tr></thead>
        <tbody>${ENTITIES.map(ent => row(ent, null, ent.title) + (ent.pipelines ? (data.pipelines || []).map(p => row(ent, p.id, `↳ ${p.name}`)).join('') : '')).join('')}</tbody>
      </table></div>
      <h2 class="cp-sub">Who has this role</h2>
      <ul class="cp-assign">${assigns.map(a => `<li><span>${esc(assignLabel(a))}</span><button type="button" data-unassign="${esc(a.id)}" aria-label="Remove ${esc(assignLabel(a))}">Remove</button></li>`).join('') || '<li class="muted">Nobody yet.</li>'}</ul>
      <form class="cp-give" id="cp-give">
        <label>Give this role to
          <select name="type">
            <option value="user">A person</option><option value="department">A department (and its sub-departments)</option>
            <option value="all">All employees</option><option value="manager">Workspace managers</option><option value="employee">Workspace employees</option>
          </select></label>
        <label data-for="user">Person<select name="user"><option value="">Choose…</option>${(data.people || []).filter(p => (p.status || 'active') !== 'inactive').slice().sort((a, b) => (!a.employee_id - !b.employee_id) || String(a.employee_id || a.full_name || '').localeCompare(String(b.employee_id || b.full_name || ''), 'en', { numeric: true })).map(p => `<option value="${esc(p.id)}">${esc(personText(p.id))}</option>`).join('')}</select></label>
        <label data-for="department" hidden>Department<select name="department"><option value="">Choose…</option>${(data.departments || []).map(d => `<option value="${esc(d.id)}">${esc(d.name + (d.company ? ` · ${d.company}` : ''))}</option>`).join('')}</select></label>
        <button type="submit" class="btn-primary text-white font-black">Add</button>
      </form>
      <div id="cp-stages" hidden></div>`;
  }

  async function load(keepMessage) {
    if (!keepMessage) msg('Loading…');
    try {
      data = await api('crm_perm_load');
      loaded = true;
      if (!keepMessage) msg('');
      render();
    } catch (e) { msg(e.message, true); }
  }

  async function setLevel(entity, pipeline, actions, level) {
    const out = await save('perm_set', { role_id: roleId, entity, pipeline_id: pipeline || null, actions, level });
    data.permissions = data.permissions.filter(p => p.role_id !== roleId).concat(out.permissions || []);
  }

  el.addEventListener('change', async e => {
    const give = e.target.closest('#cp-give select[name="type"]');
    if (give) {
      const form = $('cp-give');
      form.querySelector('[data-for="user"]').hidden = give.value !== 'user';
      form.querySelector('[data-for="department"]').hidden = give.value !== 'department';
      return;
    }
    const rs = e.target.closest('[data-perm-row]');
    const s = e.target.closest('[data-perm]');
    if (!rs && !s) return;
    const target = rs || s;
    if (rs && rs.value === '__') return;
    const [entity, pipeline, action] = (rs ? rs.dataset.permRow : s.dataset.perm).split('|');
    const actions = rs ? ENTITIES.find(x => x.key === entity).actions : [action];
    target.disabled = true;
    try {
      await setLevel(entity, pipeline, actions, target.value);
      msg(rs ? `${ENTITIES.find(x => x.key === entity).title}: every action saved.` : 'Saved.');
      render();
    } catch (err) { msg(err.message, true); await load(true); }
  });

  el.addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    try {
      if (form.id === 'cp-add-role') {
        const out = await save('role_create', { name: form.name.value });
        roleId = out.role.id; msg('Role added. Set what it may do, then give it to people.');
      } else if (form.id === 'cp-rename') {
        await save('role_update', { id: roleId, name: form.name.value, description: form.description.value }); msg('Role saved.');
      } else if (form.id === 'cp-give') {
        const type = form.type.value;
        const payload = { role_id: roleId };
        if (type === 'user') Object.assign(payload, { principal_type: 'user', principal_id: form.user.value });
        else if (type === 'department') Object.assign(payload, { principal_type: 'department', principal_id: form.department.value });
        else if (type === 'all') payload.principal_type = 'all';
        else Object.assign(payload, { principal_type: 'app_role', principal_key: type });
        await save('assign_add', payload); msg('Role given.');
      } else if (form.id === 'cp-stages-form') {
        const stages = [...form.querySelectorAll('input:checked')].map(i => i.value);
        await save('perm_stages', { id: form.dataset.id, stages }); msg('Stages saved.');
      } else return;
      await load(true);
    } catch (err) { msg(err.message, true); }
  });

  el.addEventListener('click', async e => {
    const r = e.target.closest('[data-role]');
    if (r) { roleId = r.dataset.role; msg(''); return render(); }
    try {
      if (e.target.closest('#cp-copy')) {
        const src = data.roles.find(x => x.id === roleId);
        const name = window.prompt('Name of the new role', `Copy of ${src.name}`);
        if (!name) return;
        const out = await save('role_create', { name, description: src.description || '', copy_from: src.id });
        roleId = out.role.id; msg('Role copied. Give it to people below.'); await load(true); return;
      }
      if (e.target.closest('#cp-delete')) {
        const role = data.roles.find(x => x.id === roleId);
        if (!window.confirm(`Delete the role "${role.name}"? People who only had this role lose the rights it gave them.`)) return;
        await save('role_delete', { id: roleId }); roleId = null; msg('Role deleted.'); await load(true); return;
      }
      const un = e.target.closest('[data-unassign]');
      if (un) { await save('assign_remove', { id: un.dataset.unassign }); msg('Removed.'); await load(true); return; }
      const st = e.target.closest('[data-stages]');
      if (st) {
        const [entity, pipeline] = st.dataset.stages.split('|');
        const p = permOf(entity, pipeline || null, 'move_stage'); if (!p) return;
        const options = entity === 'lead'
          ? (data.statuses || []).map(s => ({ value: s.key, label: s.label }))
          : (data.stages || []).filter(s => !pipeline || s.pipeline_id === pipeline).map(s => ({ value: s.id, label: pipeline ? s.name : `${s.name} · ${((data.pipelines || []).find(x => x.id === s.pipeline_id) || {}).name || ''}` }));
        const chosen = new Set((p.extra && p.extra.stages) || []);
        const box = $('cp-stages');
        box.hidden = false;
        box.innerHTML = `<form id="cp-stages-form" class="cp-stages" data-id="${esc(p.id)}">
          <h2 class="cp-sub">Stages this role may move ${entity === 'lead' ? 'leads' : 'deals'} into</h2>
          <p>Leave everything unticked to allow every stage.</p>
          <div class="cp-stage-grid">${options.map(o => `<label class="mg-check"><input type="checkbox" value="${esc(o.value)}"${chosen.has(o.value) ? ' checked' : ''}> ${esc(o.label)}</label>`).join('')}</div>
          <div class="mg-toolbar"><button type="submit" class="btn-primary text-white font-black">Save stages</button><button type="button" id="cp-stages-close">Close</button></div>
        </form>`;
        box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }
      if (e.target.closest('#cp-stages-close')) { $('cp-stages').hidden = true; }
    } catch (err) { msg(err.message, true); }
  });

  document.querySelectorAll('.admin-tab').forEach(tab => tab.addEventListener('click', () => {
    const on = tab.dataset.tab === 'crmperms';
    el.classList.toggle('hidden', !on);
    if (on && !loaded) load();
  }));
  const refresh = () => { if (!el.classList.contains('hidden')) load(); };
  window.addEventListener('admin-refresh', refresh);
  document.addEventListener('admin-refresh', refresh);
}());
