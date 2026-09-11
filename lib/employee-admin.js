const { companies } = require('../company-config');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = ['employee', 'manager', 'admin'];
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
  // Workspace role (CRM/work modules). Only the admin console can set it; the
  // database also refuses a change made with an employee's own session.
  if ('app_role' in body) {
    const role = body.app_role == null ? 'employee' : String(body.app_role).trim();
    if (!ROLES.includes(role)) fail('Workspace role must be employee, manager or admin');
    patch.app_role = role;
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
    if ((detail.code === 'PGRST204' || detail.code === '42703') && 'app_role' in patch) fail('Apply supabase-crm-foundation-migration.sql before setting workspace roles', 409);
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

/* ---------------------------------------------------------------------------
 * Onboarding: create the login account and the profile in one step, so HR does
 * not have to wait for someone to find the sign-up page. The account is created
 * already email-confirmed — an admin adding a colleague is the verification —
 * and the new employee sets their own password from the invite link.
 * ------------------------------------------------------------------------- */
async function createEmployee(body, { url, key, request = fetch }) {
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const call = (path, options = {}) => request(url + path, { ...options, headers: { ...headers, ...options.headers } });

  // Validate against an empty employee so every rule in the editor applies here too.
  const patch = employeePatch({ ...body, id: undefined }, {});
  if (!patch.email) fail('Email is required');
  if (!patch.full_name) fail('Full name is required');
  if (!patch.company) fail('Company is required');

  const existing = await call('/rest/v1/profiles?select=id&email=eq.' + encodeURIComponent(patch.email));
  if (existing.ok && (await existing.json()).length) fail('An account with this email already exists', 409);

  for (const field of ['shift_id', 'shift2_id', 'manager_id']) {
    if (!patch[field]) continue;
    const table = field === 'manager_id' ? 'profiles' : 'shifts';
    const r = await call('/rest/v1/' + table + '?select=id&id=eq.' + encodeURIComponent(patch[field]));
    if (!r.ok) fail('Unable to validate ' + field, 502);
    if (!(await r.json()).length) fail('Selected ' + field + ' no longer exists');
  }

  // A random password nobody ever sees or transmits: the invite link is the
  // only way in, so an unsent invite leaves no guessable account behind.
  const password = require('node:crypto').randomBytes(24).toString('base64url');
  const created = await call('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email: patch.email, password, email_confirm: true,
      user_metadata: { full_name: patch.full_name, company: patch.company } }),
  });
  if (!created.ok) {
    const detail = await created.json().catch(() => ({}));
    fail(/registered|exists/i.test(detail.msg || detail.message || '')
      ? 'An account with this email already exists'
      : 'Could not create the login account', created.status === 422 ? 409 : 502);
  }
  const account = await created.json();

  // The sign-up trigger has already made the profile row; fill in the rest.
  const profilePath = '/rest/v1/profiles?id=eq.' + encodeURIComponent(account.id);
  const pr = await call(profilePath, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ ...patch, email_verified: true }),
  });
  if (!pr.ok) {
    const detail = await pr.json().catch(() => ({}));
    // Nothing usable was created, so take the half-made account back out.
    await call('/auth/v1/admin/users/' + account.id, { method: 'DELETE' }).catch(() => {});
    if (detail.code === '23505') fail('That biometric code already belongs to another employee', 409);
    if (detail.code === 'PGRST204' || detail.code === '42703') fail('Apply supabase-admin-management-migration.sql before adding employees', 409);
    fail('Could not save the employee profile; the login account was removed', 502);
  }
  const employee = (await pr.json())[0];

  let warning;
  if (body.send_invite !== false) {
    const invited = await call('/auth/v1/recover', { method: 'POST', body: JSON.stringify({ email: patch.email }) })
      .catch(() => null);
    if (!invited || !invited.ok) warning = 'Employee added, but the invite email could not be sent. Use Reset password to try again.';
  } else {
    warning = 'Employee added without an invite. They cannot sign in until you send a password reset.';
  }
  return { success: true, employee, warning };
}

/* ---------------------------------------------------------------------------
 * Offboarding: stop the login, take the person out of the live schedule, and
 * keep every attendance, payroll and assessment record they earned. This is
 * deliberately not deletion — deleting an employee cascades their history away.
 * ------------------------------------------------------------------------- */
async function setEmployeeStatus(body, { url, key, request = fetch }) {
  if (!UUID.test(String(body.id || ''))) fail('Invalid employee ID');
  const status = body.status === 'inactive' ? 'inactive' : body.status === 'active' ? 'active' : null;
  if (!status) fail('Status must be active or inactive');
  const exitDate = status === 'inactive' ? String(body.exit_date || '').trim() : '';
  if (exitDate && (!/^\d{4}-\d{2}-\d{2}$/.test(exitDate) || new Date(exitDate).toISOString().slice(0, 10) !== exitDate)) {
    fail('Enter a valid last working day');
  }
  const reason = String(body.exit_reason || '').trim().slice(0, 300);

  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const call = (path, options = {}) => request(url + path, { ...options, headers: { ...headers, ...options.headers } });

  const patch = status === 'inactive'
    ? { status, exit_date: exitDate || null, exit_reason: reason || null }
    : { status, exit_date: null, exit_reason: null };
  const pr = await call('/rest/v1/profiles?id=eq.' + encodeURIComponent(body.id), {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
  });
  if (!pr.ok) {
    const detail = await pr.json().catch(() => ({}));
    if (detail.code === 'PGRST204' || detail.code === '42703') fail('Apply supabase-admin-console-migration.sql before offboarding employees', 409);
    fail('Could not update employment status', 502);
  }
  const employee = (await pr.json())[0];
  if (!employee) fail('Employee not found', 404);

  // GoTrue has no "disabled" flag; a ban far in the future is how a login is
  // held closed, and 'none' lifts it. Sessions are revoked on the next refresh.
  let warning;
  const banned = await call('/auth/v1/admin/users/' + encodeURIComponent(body.id), {
    method: 'PUT', body: JSON.stringify({ ban_duration: status === 'inactive' ? '876000h' : 'none' }),
  }).catch(() => null);
  if (!banned || !banned.ok) {
    warning = status === 'inactive'
      ? 'Marked as leaving, but the login could not be blocked. Reset their password or delete the account to be sure.'
      : 'Marked as active, but the login block could not be lifted. They may still be unable to sign in.';
  }
  return { success: true, employee, warning };
}

/* ---------------------------------------------------------------------------
 * Bulk import. Runs as a preview first: every row is matched, validated and
 * reported before anything is written, so a bad spreadsheet is caught before
 * it touches 200 accounts. Rows are applied one at a time and each reports its
 * own outcome — one bad row does not roll back the good ones above it.
 * ------------------------------------------------------------------------- */
const BULK_LIMIT = 500;

async function bulkEmployees(body, { url, key, request = fetch }) {
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows || !rows.length) fail('No rows to import');
  if (rows.length > BULK_LIMIT) fail(`Import at most ${BULK_LIMIT} rows at a time (received ${rows.length})`);
  const apply = body.apply === true;

  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const call = (path, options = {}) => request(url + path, { ...options, headers: { ...headers, ...options.headers } });

  const existing = await call('/rest/v1/profiles?select=id,email&limit=5000');
  if (!existing.ok) fail('Unable to load existing employees', 502);
  const byEmail = new Map((await existing.json()).map(p => [String(p.email || '').toLowerCase(), p.id]));

  const seen = new Set();
  const results = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const line = Number(row.line) || i + 2; // header is line 1 in the file
    const email = String(row.email || '').trim().toLowerCase();
    const record = { line, email: email || null, name: row.full_name || null };
    if (!email) { results.push({ ...record, outcome: 'error', message: 'Missing email' }); continue; }
    if (seen.has(email)) { results.push({ ...record, outcome: 'error', message: 'Duplicate email in this file' }); continue; }
    seen.add(email);

    const id = byEmail.get(email);
    const fields = { ...row };
    delete fields.line;
    try {
      if (id) {
        // An update must not silently retitle the account: email stays as matched.
        delete fields.email;
        if (!Object.keys(fields).length) { results.push({ ...record, outcome: 'skip', message: 'Nothing to change' }); continue; }
        if (!apply) {
          const current = await call('/rest/v1/profiles?select=*&id=eq.' + encodeURIComponent(id));
          if (!current.ok) fail('Unable to read employee', 502);
          employeePatch(fields, (await current.json())[0] || {});
          results.push({ ...record, outcome: 'update', message: 'Will update ' + Object.keys(fields).join(', ') });
          continue;
        }
        const out = await updateEmployee({ ...fields, id }, { url, key, request });
        results.push({ ...record, outcome: 'update', message: out.warning || 'Updated' });
      } else {
        if (!apply) {
          const patch = employeePatch(fields, {});
          if (!patch.full_name) fail('Full name is required');
          if (!patch.company) fail('Company is required');
          results.push({ ...record, outcome: 'create', message: 'Will create a new account' });
          continue;
        }
        const out = await createEmployee({ ...fields, email, send_invite: body.send_invite !== false }, { url, key, request });
        results.push({ ...record, outcome: 'create', message: out.warning || 'Created and invited' });
      }
    } catch (e) {
      results.push({ ...record, outcome: 'error', message: e.message || 'Row failed' });
    }
  }
  const tally = results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] || 0) + 1 }), {});
  return { success: true, applied: apply, rows: results, tally };
}

module.exports = { employeePatch, updateEmployee, createEmployee, setEmployeeStatus, bulkEmployees, BULK_LIMIT, ROLES };
