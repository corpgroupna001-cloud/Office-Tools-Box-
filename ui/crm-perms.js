/* ============================================================================
   Access permissions — the CRM roles matrix, laid out the way Bitrix24 does it:
   roles are columns (with the people who hold them), entities are sections
   (Lead, Deal and each pipeline, Contact, Company, Invoice, CRM settings) and
   actions are rows. Every value is a dashed link that opens a menu; edits
   collect until Save, and Cancel drops them.

   Used by CRM settings (a signed-in admin, straight to Supabase) and by the
   admin console (the service role, through api/admin.js). Each passes an
   adapter, so this file only draws and collects:

     WSCrmPerms.mount(element, {
       load: async () => ({ roles, permissions, assignments, pipelines, stages,
                            statuses, departments, people: [{ id, name, employee_id, avatar_url }] }),
       save: async batch => {},      // see collect() for the batch shape
       canEdit: true | false,
     })

   The database enforces all of it (ws_crm_levels / ws_crm_row_ok).
   ============================================================================ */
(function () {
  'use strict';
  if (window.WSCrmPerms) return;

  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';

  const LEVELS = [
    { value: 'none', label: 'Deny access' },
    { value: 'own', label: 'Only their own items' },
    { value: 'department', label: "Their own and their department's items" },
    { value: 'subdepartments', label: "Their own, their department's and sub-departments' items" },
    { value: 'all', label: 'All' },
  ];
  const LEVEL_LABEL = Object.fromEntries(LEVELS.map(l => [l.value, l.label]));
  const ACTION_LABEL = { read: 'Read', add: 'Add', edit: 'Edit', delete: 'Delete', export: 'Export', import: 'Import', move_stage: 'Move to stage', automation: 'Automation rules' };
  const ENTITIES = [
    { key: 'lead', title: 'Lead', icon: 'L', actions: ['read', 'add', 'edit', 'delete', 'export', 'import', 'automation', 'move_stage'] },
    { key: 'deal', title: 'Deal', icon: 'D', actions: ['read', 'add', 'edit', 'delete', 'export', 'import', 'automation', 'move_stage'], pipelines: true },
    { key: 'contact', title: 'Contact', icon: 'C', actions: ['read', 'add', 'edit', 'delete', 'export', 'import'] },
    { key: 'company', title: 'Company', icon: 'Co', actions: ['read', 'add', 'edit', 'delete', 'export', 'import'] },
    { key: 'invoice', title: 'Invoice', icon: 'I', actions: ['read', 'add', 'edit', 'delete', 'export'] },
    { key: 'settings', title: 'CRM settings', icon: '⚙', actions: ['edit'] },
  ];
  const HINT = {
    automation: 'Who may set up automation rules for this entity.',
    move_stage: 'Which stages a role may move records into.',
  };
  const GROUPS = [
    { type: 'all', key: null, label: 'All employees' },
    { type: 'app_role', key: 'manager', label: 'Workspace managers' },
    { type: 'app_role', key: 'employee', label: 'Workspace employees' },
  ];

  function mount(root, adapter) {
    const canEdit = !!adapter.canEdit;
    let data = null;
    let pending = fresh();                 // what Save will send
    let hiddenRoles = new Set(), collapsed = new Set(), search = '';
    let tmpSeq = 0;
    let popover = null;

    function fresh() { return { levels: new Map(), stages: new Map(), renames: new Map(), newRoles: [], deletes: new Set(), assignAdd: [], assignRemove: new Set() }; }
    const dirty = () => pending.levels.size || pending.stages.size || pending.renames.size || pending.newRoles.length || pending.deletes.size || pending.assignAdd.length || pending.assignRemove.size;
    const cellKey = (rid, entity, pipeline, action) => `${rid}|${entity}|${pipeline || ''}|${action}`;

    /* ------------------------------------------------------------ reading */
    const roles = () => data.roles.filter(r => !pending.deletes.has(r.id))
      .map(r => ({ ...r, name: pending.renames.get(r.id) ?? r.name }))
      .concat(pending.newRoles.map(r => ({ id: r.tmp, name: r.name, is_system: false, fresh: true })));
    const visibleRoles = () => roles().filter(r => !hiddenRoles.has(r.id));
    const stored = (rid, entity, pipeline, action) => data.permissions.find(p => p.role_id === rid && p.entity === entity && (p.pipeline_id || null) === (pipeline || null) && p.action === action);
    function levelOf(rid, entity, pipeline, action) {
      const k = cellKey(rid, entity, pipeline, action);
      if (pending.levels.has(k)) return pending.levels.get(k);
      const p = stored(rid, entity, pipeline, action);
      return p ? p.level : (pipeline ? '' : 'none');
    }
    function stagesOf(rid, entity, pipeline) {
      const k = `${rid}|${entity}|${pipeline || ''}`;
      if (pending.stages.has(k)) return pending.stages.get(k);
      const p = stored(rid, entity, pipeline, 'move_stage');
      return (p && p.extra && p.extra.stages) || [];
    }
    const assignsOf = rid => data.assignments.filter(a => a.role_id === rid && !pending.assignRemove.has(a.id))
      .concat(pending.assignAdd.filter(a => a.role_id === rid));
    const personOf = id => (data.people || []).find(p => p.id === id);
    const personLabel = p => p ? (p.employee_id ? `${p.employee_id} · ${p.name}` : p.name) : 'Former employee';
    const deptOf = id => (data.departments || []).find(d => d.id === id);
    function assignLabel(a) {
      if (a.principal_type === 'all') return 'All employees';
      if (a.principal_type === 'app_role') return a.principal_key === 'manager' ? 'Workspace managers' : 'Workspace employees';
      if (a.principal_type === 'department') return `${(deptOf(a.principal_id) || {}).name || 'Department'} (department)`;
      return personLabel(personOf(a.principal_id));
    }
    function avatar(a, cls) {
      if (a.principal_type === 'user') {
        const p = personOf(a.principal_id);
        const title = esc(personLabel(p));
        return p && p.avatar_url ? `<span class="cp-av ${cls || ''}" title="${title}"><img src="${esc(p.avatar_url)}" alt=""></span>`
          : `<span class="cp-av ${cls || ''}" title="${title}">${esc(initials(p && p.name))}</span>`;
      }
      return `<span class="cp-av group ${cls || ''}" title="${esc(assignLabel(a))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 19c0-3 2.7-5 6-5s6 2 6 5v1H3v-1Zm13.5-4.9c2.6.3 4.5 2 4.5 4.4V20h-4v-1c0-1.8-.6-3.5-1.8-4.7l1.3-.2Z" fill="currentColor"/></svg></span>`;
    }
    function stageOptions(entity, pipeline) {
      if (entity === 'lead') return (data.statuses || []).map(s => ({ value: s.key, label: s.label }));
      return (data.stages || []).filter(s => !pipeline || s.pipeline_id === pipeline)
        .map(s => ({ value: s.id, label: pipeline ? s.name : `${s.name} · ${((data.pipelines || []).find(p => p.id === s.pipeline_id) || {}).name || ''}` }));
    }

    /* ------------------------------------------------------------ drawing */
    function sections() {
      const out = [];
      ENTITIES.forEach(ent => {
        out.push({ ent, pipeline: null, id: ent.key, title: ent.title });
        if (ent.pipelines) (data.pipelines || []).forEach(p => out.push({ ent, pipeline: p.id, id: `${ent.key}:${p.id}`, title: `${ent.title} (${p.name})`, sub: true }));
      });
      return out;
    }
    function cellText(rid, sec, action) {
      const level = levelOf(rid, sec.ent.key, sec.pipeline, action);
      if (level === '') return { text: `As for all ${sec.ent.key}s`, muted: true };
      if (action === 'move_stage') {
        if (level === 'none') return { text: 'Deny access' };
        const n = stagesOf(rid, sec.ent.key, sec.pipeline).length;
        return { text: n ? `${n} stage${n === 1 ? '' : 's'} only` : 'To any stage' };
      }
      return { text: LEVEL_LABEL[level] || level };
    }
    function render() {
      const list = visibleRoles();
      const all = roles();
      const q = search.trim().toLowerCase();
      const secs = sections().filter(s => !q || s.title.toLowerCase().includes(q) || s.ent.actions.some(a => ACTION_LABEL[a].toLowerCase().includes(q)) || list.some(r => r.name.toLowerCase().includes(q)));
      root.innerHTML = `
        <div class="cp-top">
          ${adapter.title === false ? '' : '<h1>Access permissions</h1>'}
          <label class="cp-search"><input type="search" placeholder="Search" value="${esc(search)}" aria-label="Search roles, entities and actions"></label>
          <span class="grow"></span>
          ${canEdit ? '' : '<span class="cp-note">Only workspace admins can change roles.</span>'}
        </div>
        <div class="cp-card">
          <div class="cp-scroll">
            <table class="cp-grid">
              <thead><tr>
                <th class="cp-corner">
                  <div class="cp-roles-title">Roles</div>
                  <div class="cp-corner-tools">
                    <button type="button" class="cp-count" data-act="pick-roles" aria-haspopup="true">👁 <b>${list.length}</b> out of ${all.length}</button>
                    <span class="grow"></span>
                    <button type="button" class="cp-icon" data-act="collapse-all" title="Collapse all" aria-label="Collapse all">⌃</button>
                    <button type="button" class="cp-icon" data-act="expand-all" title="Expand all" aria-label="Expand all">⌄</button>
                  </div>
                </th>
                ${list.map(r => {
                  const as = assignsOf(r.id);
                  return `<th class="cp-role${r.fresh ? ' fresh' : ''}" data-role="${esc(r.id)}">
                    ${canEdit ? `<button type="button" class="cp-dots" data-act="role-menu" data-role="${esc(r.id)}" aria-label="Role actions for ${esc(r.name)}">···</button>` : ''}
                    ${canEdit && r.fresh ? `<input class="cp-role-name" data-rename="${esc(r.id)}" value="${esc(r.name)}" aria-label="Role name">`
                      : `<div class="cp-role-name" title="${esc(r.name)}">${esc(r.name)}</div>`}
                    <div class="cp-members">
                      <span class="cp-stack">${as.slice(0, 5).map(a => avatar(a)).join('')}${as.length > 5 ? `<span class="cp-av more">+${as.length - 5}</span>` : ''}${as.length ? '' : '<span class="cp-empty">nobody</span>'}</span>
                      ${canEdit ? `<button type="button" class="cp-plus" data-act="members" data-role="${esc(r.id)}" aria-label="People with ${esc(r.name)}">+</button>` : ''}
                    </div>
                  </th>`;
                }).join('')}
                ${canEdit ? '<th class="cp-addcol"><button type="button" class="cp-add-role" data-act="add-role" aria-label="Add role">+</button></th>' : '<th class="cp-addcol"></th>'}
              </tr></thead>
              <tbody>
                ${secs.map(sec => {
                  const open = !collapsed.has(sec.id);
                  const head = `<tr class="cp-sec${sec.sub ? ' sub' : ''}"><th colspan="${list.length + 2}"><button type="button" data-act="toggle" data-sec="${esc(sec.id)}" aria-expanded="${open}"><span class="chev">${open ? '⌃' : '⌄'}</span><span class="ico">${esc(sec.ent.icon)}</span>${esc(sec.title)}</button></th></tr>`;
                  if (!open) return head;
                  return head + sec.ent.actions.map(action => `<tr>
                    <th class="cp-action" scope="row">${canEdit ? `<button type="button" class="cp-rowset" data-act="row-menu" data-sec="${esc(sec.id)}" data-action="${action}" title="Set this for every role" aria-label="Set ${esc(ACTION_LABEL[action])} for every role">⊕</button>` : ''}${esc(ACTION_LABEL[action])}${HINT[action] ? ` <span class="cp-hint" title="${esc(HINT[action])}">?</span>` : ''}</th>
                    ${list.map(r => {
                      const t = cellText(r.id, sec, action);
                      const changed = pending.levels.has(cellKey(r.id, sec.ent.key, sec.pipeline, action)) || (action === 'move_stage' && pending.stages.has(`${r.id}|${sec.ent.key}|${sec.pipeline || ''}`));
                      return `<td class="${changed ? 'changed' : ''}${r.fresh ? ' fresh' : ''}">${canEdit
                        ? `<button type="button" class="cp-val${t.muted ? ' muted' : ''}" data-act="cell" data-role="${esc(r.id)}" data-sec="${esc(sec.id)}" data-action="${action}">${esc(t.text)}</button>`
                        : `<span class="cp-val${t.muted ? ' muted' : ''}">${esc(t.text)}</span>`}</td>`;
                    }).join('')}
                    <td class="cp-addcol"></td>
                  </tr>`).join('');
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
        <div class="cp-footer"${dirty() ? '' : ' hidden'}>
          <button type="button" class="cp-save" data-act="save">Save</button>
          <button type="button" class="cp-cancel" data-act="cancel">Cancel</button>
          <span class="cp-status" aria-live="polite"></span>
        </div>`;
      const s = root.querySelector('.cp-search input');
      s.addEventListener('input', () => { search = s.value; const pos = s.selectionStart; render(); const again = root.querySelector('.cp-search input'); again.focus(); again.setSelectionRange(pos, pos); });
    }

    /* ------------------------------------------------------------ menus */
    /** Keep the popover beside its anchor and inside the window (called again once a picker has filled in). */
    function place(anchor) {
      if (!popover || !anchor) return;
      const r = anchor.getBoundingClientRect(), w = popover.offsetWidth, h = popover.offsetHeight;
      const left = Math.min(window.innerWidth - w - 12, Math.max(12, r.left + r.width / 2 - w / 2));
      let top = r.bottom + 6;
      if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 6);
      popover.style.left = `${left + window.scrollX}px`;
      popover.style.top = `${top + window.scrollY}px`;
    }
    function closePopover() { if (popover) { popover.remove(); popover = null; document.removeEventListener('mousedown', outside, true); } }
    function outside(e) { if (popover && !popover.contains(e.target) && !e.target.closest('[data-act]')) closePopover(); }
    function openPopover(anchor, html, wide) {
      closePopover();
      popover = document.createElement('div');
      popover.className = `cp-pop${wide ? ' wide' : ''}`;
      popover.setAttribute('role', 'dialog');
      popover.innerHTML = html;
      document.body.append(popover);
      place(anchor);
      setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
      const first = popover.querySelector('input, button');
      if (first) first.focus();
      return popover;
    }
    const secById = id => sections().find(s => s.id === id);

    function cellMenu(btn) {
      const rid = btn.dataset.role, sec = secById(btn.dataset.sec), action = btn.dataset.action;
      const cur = levelOf(rid, sec.ent.key, sec.pipeline, action);
      const opts = (sec.pipeline ? [{ value: '', label: `As for all ${sec.ent.key}s` }] : []);
      if (action === 'move_stage') {
        opts.push({ value: 'none', label: 'Deny access' }, { value: 'all', label: 'To any stage' }, { value: '__stages', label: 'Only some stages…' });
      } else opts.push(...LEVELS);
      const pop = openPopover(btn, `<div class="cp-menu" role="menu">${opts.map(o => `<button type="button" role="menuitemradio" aria-checked="${o.value === cur && !(action === 'move_stage' && o.value === 'all' && stagesOf(rid, sec.ent.key, sec.pipeline).length)}" data-v="${esc(o.value)}">${esc(o.label)}</button>`).join('')}</div>`);
      pop.addEventListener('click', e => {
        const b = e.target.closest('[data-v]'); if (!b) return;
        const v = b.dataset.v;
        if (v === '__stages') return stagesMenu(btn, rid, sec);
        pending.levels.set(cellKey(rid, sec.ent.key, sec.pipeline, action), v);
        if (action === 'move_stage' && v === 'all') pending.stages.set(`${rid}|${sec.ent.key}|${sec.pipeline || ''}`, []);
        closePopover(); render();
      });
    }
    function stagesMenu(anchor, rid, sec) {
      const chosen = new Set(stagesOf(rid, sec.ent.key, sec.pipeline));
      const opts = stageOptions(sec.ent.key, sec.pipeline);
      const pop = openPopover(anchor, `<form class="cp-stages"><b>Stages this role may move ${sec.ent.key}s into</b>
        <div class="cp-stage-list">${opts.map(o => `<label><input type="checkbox" value="${esc(o.value)}"${chosen.has(o.value) ? ' checked' : ''}> ${esc(o.label)}</label>`).join('') || '<p>No stages yet.</p>'}</div>
        <div class="cp-pop-do"><button type="submit" class="cp-save">Apply</button><button type="button" data-close>Cancel</button></div></form>`, true);
      pop.querySelector('[data-close]').addEventListener('click', closePopover);
      pop.querySelector('form').addEventListener('submit', e => {
        e.preventDefault();
        const stages = [...pop.querySelectorAll('input:checked')].map(i => i.value);
        pending.levels.set(cellKey(rid, sec.ent.key, sec.pipeline, 'move_stage'), 'all');
        pending.stages.set(`${rid}|${sec.ent.key}|${sec.pipeline || ''}`, stages);
        closePopover(); render();
      });
    }
    function rowMenu(btn) {
      const sec = secById(btn.dataset.sec), action = btn.dataset.action;
      const opts = (sec.pipeline ? [{ value: '', label: `As for all ${sec.ent.key}s` }] : []).concat(action === 'move_stage'
        ? [{ value: 'none', label: 'Deny access' }, { value: 'all', label: 'To any stage' }] : LEVELS);
      const pop = openPopover(btn, `<div class="cp-menu" role="menu"><div class="cp-menu-title">${esc(ACTION_LABEL[action])} for every role shown</div>${opts.map(o => `<button type="button" role="menuitem" data-v="${esc(o.value)}">${esc(o.label)}</button>`).join('')}</div>`);
      pop.addEventListener('click', e => {
        const b = e.target.closest('[data-v]'); if (!b) return;
        visibleRoles().forEach(r => {
          pending.levels.set(cellKey(r.id, sec.ent.key, sec.pipeline, action), b.dataset.v);
          if (action === 'move_stage' && b.dataset.v === 'all') pending.stages.set(`${r.id}|${sec.ent.key}|${sec.pipeline || ''}`, []);
        });
        closePopover(); render();
      });
    }
    function roleMenu(btn) {
      const rid = btn.dataset.role, role = roles().find(r => r.id === rid);
      const pop = openPopover(btn, `<div class="cp-menu" role="menu">
        <button type="button" role="menuitem" data-do="rename">Rename</button>
        ${role.fresh ? '' : '<button type="button" role="menuitem" data-do="copy">Copy</button>'}
        <button type="button" role="menuitem" data-do="hide">Hide column</button>
        ${role.is_system ? '' : '<button type="button" role="menuitem" data-do="delete" class="danger">Delete</button>'}
      </div>`);
      pop.addEventListener('click', e => {
        const b = e.target.closest('[data-do]'); if (!b) return;
        const act = b.dataset.do;
        closePopover();
        if (act === 'rename') {
          const name = window.prompt('Role name', role.name);
          if (!name || !name.trim()) return;
          if (role.fresh) pending.newRoles.find(r => r.tmp === rid).name = name.trim();
          else pending.renames.set(rid, name.trim());
        } else if (act === 'copy') {
          const tmp = `new-${++tmpSeq}`;
          pending.newRoles.push({ tmp, name: `Copy of ${role.name}`, copyFrom: rid });
          data.permissions.filter(p => p.role_id === rid).forEach(p => {
            pending.levels.set(cellKey(tmp, p.entity, p.pipeline_id, p.action), p.level);
            if (p.action === 'move_stage' && p.extra && p.extra.stages && p.extra.stages.length) pending.stages.set(`${tmp}|${p.entity}|${p.pipeline_id || ''}`, p.extra.stages.slice());
          });
        } else if (act === 'hide') {
          hiddenRoles.add(rid);
        } else if (act === 'delete') {
          if (!window.confirm(`Delete the role "${role.name}" when you save? People who only had this role lose the rights it gave them.`)) return;
          if (role.fresh) pending.newRoles = pending.newRoles.filter(r => r.tmp !== rid);
          else pending.deletes.add(rid);
        }
        render();
      });
    }
    function rolesPicker(btn) {
      const all = roles();
      const pop = openPopover(btn, `<div class="cp-menu cp-checks"><div class="cp-menu-title">Roles shown</div>
        ${all.map(r => `<label><input type="checkbox" value="${esc(r.id)}"${hiddenRoles.has(r.id) ? '' : ' checked'}> ${esc(r.name)}</label>`).join('')}
        <div class="cp-pop-do"><button type="button" data-all>Show all</button></div></div>`);
      pop.addEventListener('change', e => { const i = e.target; if (i.checked) hiddenRoles.delete(i.value); else hiddenRoles.add(i.value); render(); rolesPicker(root.querySelector('[data-act="pick-roles"]')); });
      pop.querySelector('[data-all]').addEventListener('click', () => { hiddenRoles.clear(); closePopover(); render(); });
    }
    function membersPicker(btn) {
      const rid = btn.dataset.role;
      let tab = 'people', q = '';
      const pop = openPopover(btn, '<div class="cp-picker"></div>', true);
      const box = pop.firstElementChild;
      function has(type, id, key) { return assignsOf(rid).some(a => a.principal_type === type && (a.principal_id || null) === (id || null) && (a.principal_key || null) === (key || null)); }
      function paint() {
        const current = assignsOf(rid);
        const people = (data.people || []).filter(p => !q || [p.name, p.employee_id, p.email].some(v => String(v || '').toLowerCase().includes(q)))
          .sort((a, b) => (!a.employee_id - !b.employee_id) || String(a.employee_id || a.name).localeCompare(String(b.employee_id || b.name), 'en', { numeric: true })).slice(0, 60);
        const depts = (data.departments || []).filter(d => !q || String(d.name).toLowerCase().includes(q));
        const groups = GROUPS.filter(g => !q || g.label.toLowerCase().includes(q));
        const row = (type, id, key, label, av) => {
          const on = has(type, id, key);
          return `<button type="button" class="cp-pick${on ? ' on' : ''}" data-type="${type}" data-id="${esc(id || '')}" data-key="${esc(key || '')}">${av}<span>${esc(label)}</span>${on ? '<i>✓</i>' : ''}</button>`;
        };
        box.innerHTML = `
          <nav class="cp-pick-tabs">${[['people', 'Employees'], ['departments', 'Departments'], ['groups', 'Groups']].map(([k, l]) => `<button type="button" data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</nav>
          <div class="cp-pick-main">
            <div class="cp-chips">${current.map(a => `<span class="cp-chip">${esc(assignLabel(a))}<button type="button" data-remove="${esc(a.id || a.tmpKey)}" aria-label="Remove ${esc(assignLabel(a))}">×</button></span>`).join('')}
              <input type="search" class="cp-pick-q" placeholder="search" value="${esc(q)}" aria-label="Search"></div>
            <div class="cp-pick-list">${tab === 'people' ? people.map(p => row('user', p.id, null, personLabel(p), avatar({ principal_type: 'user', principal_id: p.id }))).join('')
              : tab === 'departments' ? (depts.map(d => row('department', d.id, null, d.name + (d.company ? ` · ${d.company}` : ''), avatar({ principal_type: 'department' }))).join('') || '<p>No departments yet — build them in Company structure.</p>')
              : groups.map(g => row(g.type, null, g.key, g.label, avatar({ principal_type: g.type }))).join('')}</div>
          </div>`;
        const qi = box.querySelector('.cp-pick-q');
        qi.addEventListener('input', () => { q = qi.value.trim().toLowerCase(); const pos = qi.selectionStart; paint(); const again = box.querySelector('.cp-pick-q'); again.focus(); again.setSelectionRange(pos, pos); });
      }
      box.addEventListener('click', e => {
        const t = e.target.closest('[data-tab]'); if (t) { tab = t.dataset.tab; return paint(); }
        const rm = e.target.closest('[data-remove]');
        if (rm) {
          const id = rm.dataset.remove;
          if (pending.assignAdd.some(a => a.tmpKey === id)) pending.assignAdd = pending.assignAdd.filter(a => a.tmpKey !== id);
          else pending.assignRemove.add(id);
          paint(); render(); return;
        }
        const p = e.target.closest('.cp-pick'); if (!p) return;
        const type = p.dataset.type, id = p.dataset.id || null, key = p.dataset.key || null;
        const existing = assignsOf(rid).find(a => a.principal_type === type && (a.principal_id || null) === id && (a.principal_key || null) === key);
        if (existing) {
          if (existing.tmpKey) pending.assignAdd = pending.assignAdd.filter(a => a.tmpKey !== existing.tmpKey);
          else pending.assignRemove.add(existing.id);
        } else {
          pending.assignAdd.push({ tmpKey: `a${++tmpSeq}`, role_id: rid, principal_type: type, principal_id: id, principal_key: key });
        }
        paint(); render();
        place(root.querySelector(`[data-act="members"][data-role="${CSS.escape(rid)}"]`));
      });
      paint();
      place(btn);
    }

    /* ------------------------------------------------------------ saving */
    function collect() {
      const splitCell = k => { const [role_id, entity, pipeline, action] = k.split('|'); return { role_id, entity, pipeline_id: pipeline || null, action }; };
      return {
        new_roles: pending.newRoles.map(r => ({ tmp: r.tmp, name: r.name })),
        renames: [...pending.renames].map(([id, name]) => ({ id, name })),
        deletes: [...pending.deletes],
        levels: [...pending.levels].map(([k, level]) => ({ ...splitCell(k), level })),
        stages: [...pending.stages].map(([k, stages]) => { const [role_id, entity, pipeline] = k.split('|'); return { role_id, entity, pipeline_id: pipeline || null, stages }; }),
        assign_add: pending.assignAdd.map(a => ({ role_id: a.role_id, principal_type: a.principal_type, principal_id: a.principal_id, principal_key: a.principal_key })),
        assign_remove: [...pending.assignRemove],
      };
    }
    async function save() {
      const status = root.querySelector('.cp-status'), btn = root.querySelector('.cp-save');
      btn.disabled = true; status.textContent = 'Saving…';
      try {
        // A new role's name may have been typed straight into its column.
        root.querySelectorAll('input[data-rename]').forEach(i => { const r = pending.newRoles.find(x => x.tmp === i.dataset.rename); if (r && i.value.trim()) r.name = i.value.trim(); });
        await adapter.save(collect());
        pending = fresh();
        await load();
        const s = root.querySelector('.cp-status'); if (s) s.textContent = '';
        if (adapter.onSaved) adapter.onSaved();
      } catch (e) {
        btn.disabled = false;
        status.textContent = String(e.message || e);
        status.classList.add('bad');
      }
    }

    /* ------------------------------------------------------------ events */
    root.addEventListener('click', e => {
      const b = e.target.closest('[data-act]'); if (!b || !root.contains(b)) return;
      const act = b.dataset.act;
      if (act === 'toggle') { const id = b.dataset.sec; if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id); return render(); }
      if (act === 'collapse-all') { sections().forEach(s => collapsed.add(s.id)); return render(); }
      if (act === 'expand-all') { collapsed.clear(); return render(); }
      if (act === 'pick-roles') return rolesPicker(b);
      if (!canEdit) return;
      if (act === 'cell') return cellMenu(b);
      if (act === 'row-menu') return rowMenu(b);
      if (act === 'role-menu') return roleMenu(b);
      if (act === 'members') return membersPicker(b);
      if (act === 'add-role') {
        const tmp = `new-${++tmpSeq}`;
        pending.newRoles.push({ tmp, name: 'Role name' });
        render();
        const input = root.querySelector(`input[data-rename="${tmp}"]`);
        if (input) { input.focus(); input.select(); input.closest('.cp-scroll').scrollLeft = 1e6; }
        return;
      }
      if (act === 'save') return save();
      if (act === 'cancel') { pending = fresh(); closePopover(); return render(); }
    });
    root.addEventListener('input', e => {
      const i = e.target.closest('input[data-rename]'); if (!i) return;
      const r = pending.newRoles.find(x => x.tmp === i.dataset.rename); if (r) r.name = i.value;
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && popover) closePopover(); });

    async function load() {
      root.innerHTML = '<div class="cp-loading">Loading access permissions…</div>';
      try {
        data = await adapter.load();
        data.people = (data.people || []).map(p => ({ ...p, name: p.name || p.full_name || p.email || 'Employee' }));
        render();
      } catch (e) {
        root.innerHTML = `<div class="cp-loading bad">${esc(e.message || e)}</div>`;
      }
    }
    load();
    return { reload: load, isDirty: () => !!dirty() };
  }

  window.WSCrmPerms = { mount, LEVELS, ENTITIES, ACTION_LABEL };
}());
