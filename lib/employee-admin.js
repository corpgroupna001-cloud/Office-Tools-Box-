const { companies } = require('../company-config');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
function employeePatch(body, current) {
  const patch = {};
  for (const [key, max] of Object.entries({ full_name: 150, email: 254, company: 120, company2: 120,
    employee_code: 50, department: 120, job_title: 120, phone: 40, joining_date: 10, manager_id: 36 })) {
    if (!(key in body)) continue;
    if (body[key] != null && typeof body[key] !== 'string') fail('Invalid ' + key);
    const value = (body[key] || '').trim();
    if (value.length > max) fail(key + ' is too long');
    patch[key] = value || null;
  }
  if ('full_name' in patch && (!patch.full_name || patch.full_name.length < 2)) fail('Name must be at least 2 characters');
  if ('email' in patch) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.email || '')) fail('Enter a valid email address');
    patch.email = patch.email.toLowerCase();
  }
  for (const key of ['company', 'company2']) {
    if (key in patch && patch[key] !== current[key] && !(key === 'company2' && patch[key] === null) && !companies.includes(patch[key])) fail('Choose a valid ' + key);
  }
  for (const key of ['is_wfh','req_mobile','req_laptop','req_tab']) {
    if (!(key in body)) continue;
    if (typeof body[key] !== 'boolean') fail('Invalid ' + key);
    patch[key] = body[key];
  }
  for (const key of ['shift_id','shift2_id']) {
    if (!(key in body)) continue;
    const value = body[key];
    if (value === null || value === '') patch[key] = null;
    else if (/^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value))) patch[key] = Number(value);
    else fail('Invalid shift');
  }
  if (patch.manager_id && (!UUID.test(patch.manager_id) || patch.manager_id === body.id)) fail('Choose another employee as manager');
  if (patch.joining_date && (!/^\d{4}-\d{2}-\d{2}$/.test(patch.joining_date) || !Number.isFinite(Date.parse(patch.joining_date)) || new Date(patch.joining_date).toISOString().slice(0,10) !== patch.joining_date)) fail('Enter a valid joining date');
  const next = { ...current, ...patch };
  if (!!next.shift2_id !== !!next.company2) fail('A secondary role needs both a company and a shift');
  return patch;
}
async function updateEmployee(body, { url, key, request = fetch }) {
  if (!UUID.test(String(body.id || ''))) fail('Invalid employee ID');
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const call = (path, options = {}) => request(url + path, { ...options, headers: { ...headers, ...options.headers } });
  const profilePath = '/rest/v1/profiles?id=eq.' + encodeURIComponent(body.id);
  const oldResponse = await call(profilePath + '&select=*');
  if (!oldResponse.ok) fail('Unable to load employee', 502);
  const current = (await oldResponse.json())[0];
  if (!current) fail('Employee not found', 404);
  const patch = employeePatch(body, current);
  if (!Object.keys(patch).length) fail('No employee fields supplied');
  // Validate references before changing either account or profile.
  for (const field of ['shift_id','shift2_id','manager_id']) {
    if (!patch[field]) continue;
    const table = field === 'manager_id' ? 'profiles' : 'shifts';
    const r = await call('/rest/v1/' + table + '?select=id&id=eq.' + encodeURIComponent(patch[field]));
    if (!r.ok) fail('Unable to validate ' + field, 502);
    if (!(await r.json()).length) fail('Selected ' + field + ' no longer exists');
  }
  const authPath = '/auth/v1/admin/users/' + encodeURIComponent(body.id);
  const ar = await call(authPath);
  if (!ar.ok) fail('Unable to load login account; no changes saved', 502);
  const auth = await ar.json();
  const metadata = { ...auth.user_metadata };
  for (const field of ['full_name','company']) if (field in patch) metadata[field] = patch[field];
  const authPatch = { user_metadata: metadata };
  if ('email' in patch && patch.email !== auth.email) authPatch.email = patch.email;
  // Profile first: missing migrations and duplicate codes cannot change Auth.
  const pr = await call(profilePath, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
  if (!pr.ok) {
    const detail = await pr.json().catch(() => ({}));
    if (detail.code === '23505') fail('Email or biometric code already belongs to another employee', 409);
    if (detail.code === 'PGRST204' || detail.code === '42703') fail('Apply supabase-admin-management-migration.sql before editing these fields', 409);
    fail('Profile update failed; no login changes saved', 502);
  }
  const saved = (await pr.json())[0];
  if (!saved) fail('Employee was removed while saving', 409);
  let updated;
  try { updated = await call(authPath, { method: 'PUT', body: JSON.stringify(authPatch) }); } catch {}
  if (!updated || !updated.ok) {
    const restore = Object.fromEntries(Object.keys(patch).map(k => [k, current[k] ?? null]));
    let rolledBack;
    try { rolledBack = await call(profilePath, { method: 'PATCH', body: JSON.stringify(restore) }); } catch {}
    fail(rolledBack && rolledBack.ok ? 'Login update failed. Profile changes were rolled back; reload before retrying.' : 'Login update failed and profile rollback failed. Review this account before retrying.', 502);
  }
  let warning;
  if (patch.full_name && patch.full_name !== current.full_name) {
    try {
      const tr = await call('/rest/v1/test_results?user_id=eq.' + encodeURIComponent(body.id), { method: 'PATCH', body: JSON.stringify({ full_name: patch.full_name }) });
      if (!tr.ok) warning = 'Account saved; old typing result names could not be refreshed.';
    } catch { warning = 'Account saved; old typing result names could not be refreshed.'; }
  }
  return { success: true, employee: saved, warning };
}
module.exports = { employeePatch, updateEmployee };
