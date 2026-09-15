/* Admin console: CRM permissions.
   The Bitrix24-style access permissions matrix (ui/crm-perms.js), fed by the
   admin API: the console is not a signed-in user, so it reads and saves
   through api/admin.js (crm_perm_load / crm_perm_save op "batch") with the
   service role. The database enforces every rule the matrix shows. */
(function () {
  'use strict';
  const main = document.querySelector('.admin-main');
  if (!main || !window.WSCrmPerms) return;

  async function api(action, data = {}) {
    const r = await adminFetch({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...data }) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((out.error || 'Request failed') + (out.detail ? ` — ${out.detail}` : ''));
    return out;
  }

  const el = document.createElement('section');
  el.id = 'crmperms-panel';
  el.className = 'hidden crm-perms-panel';
  el.setAttribute('data-no-export', '');
  el.innerHTML = '<div class="cp-root" id="cp-root"></div>';
  main.append(el);

  let view = null;
  function start() {
    view = WSCrmPerms.mount(document.getElementById('cp-root'), {
      canEdit: true,
      load: async () => {
        const d = await api('crm_perm_load');
        return { ...d, people: (d.people || []).filter(p => (p.status || 'active') !== 'inactive').map(p => ({ id: p.id, name: p.full_name || p.email, employee_id: p.employee_id || '' })) };
      },
      save: batch => api('crm_perm_save', { op: 'batch', ...batch }),
    });
  }

  document.querySelectorAll('.admin-tab').forEach(tab => tab.addEventListener('click', () => {
    const on = tab.dataset.tab === 'crmperms';
    el.classList.toggle('hidden', !on);
    if (on && !view) start();
  }));
  const refresh = () => { if (view && !el.classList.contains('hidden') && !view.isDirty()) view.reload(); };
  window.addEventListener('admin-refresh', refresh);
  document.addEventListener('admin-refresh', refresh);
  // Leaving with unsaved changes asks first, as Bitrix24 does.
  window.addEventListener('beforeunload', e => { if (view && view.isDirty()) { e.preventDefault(); e.returnValue = ''; } });
}());
