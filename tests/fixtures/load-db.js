// Builds an in-process Postgres (PGlite) with the Supabase stand-in and every
// WorkSuite migration applied in deployment order, for the database tests.
//
// PGlite is a dev-only dependency. When it is not installed the loader
// returns null and the database tests skip themselves, so `npm test` still
// runs everywhere.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

// The pre-CRM schema, in the order the SETUP guide introduces it. Files that
// do not exist in a checkout are skipped.
const BASE = [
  'supabase-schema.sql', 'supabase-profiles-fix.sql', 'supabase-company-migration.sql',
  'supabase-company-email-migration.sql', 'supabase-avatar-migration.sql', 'supabase-presence-migration.sql',
  'supabase-email-change-migration.sql', 'supabase-pending-signups-migration.sql',
  'supabase-chat-migration.sql', 'supabase-chat-files-migration.sql', 'supabase-message-update-migration.sql',
  'supabase-reactions-migration.sql', 'supabase-push-migration.sql', 'supabase-quiz-migration.sql',
  'supabase-recordings-migration.sql', 'supabase-wfh-camera-migration.sql', 'supabase-wfh-3clip-migration.sql',
  'supabase-wfh-deviceinfo-migration.sql', 'supabase-wfh-devices-migration.sql', 'supabase-wfh-qc-migration.sql',
  'supabase-attendance-migration.sql', 'supabase-attendance-direction-migration.sql',
  'supabase-selfie-migration.sql', 'supabase-punch-events-migration.sql', 'supabase-shifts-migration.sql',
  'supabase-leave-migration.sql', 'supabase-payroll-migration.sql', 'supabase-monthly-salary-migration.sql',
  'supabase-dual-shift-migration.sql', 'supabase-secondary-roles-migration.sql',
  'supabase-bitrix-migration.sql', 'supabase-bitrix-log-migration.sql', 'supabase-device-enrolments-migration.sql',
  'supabase-admin-management-migration.sql', 'supabase-admin-console-migration.sql',
  'supabase-corpgroup-retire-migration.sql',
  'supabase-attendance-bitrix-migration.sql', 'supabase-attendance-scheduler-migration.sql',
];

// The CRM set, in the order SETUP.md tells an administrator to run it.
const CRM = [
  'supabase-crm-foundation-migration.sql',
  'supabase-work-migration.sql',
  'supabase-invoices-migration.sql',
  'supabase-messenger-migration.sql',
  'supabase-crm-reminders-migration.sql',
  'supabase-b24-migration.sql',
  'supabase-messenger-calls-migration.sql',
  'supabase-crm-import-migration.sql',
  'supabase-employee-id-migration.sql',
];

// Files that end by scheduling a job with pg_cron + pg_net, which only exist on
// the hosted database. Everything before that point is tables, columns and
// functions, and is what runs here. Only a statement at the start of a line
// cuts, so a comment that names the extension does not; a file without the
// statement (the dual-shift one no longer has it) runs whole.
const CRON_TAIL = new Set(['supabase-dual-shift-migration.sql', 'supabase-attendance-scheduler-migration.sql']);
const CRON_START = /^create extension if not exists pg_cron\b/im;

function sqlOf(file) {
  let sql = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (CRON_TAIL.has(file)) {
    const at = sql.search(CRON_START);
    if (at >= 0) sql = sql.slice(0, at);
  }
  return sql;
}

function pglite() {
  try { return require('@electric-sql/pglite').PGlite; } catch { return null; }
}

/**
 * freshDb({ crm = true, twice = false, without = [] }) -> PGlite | null
 * `without` leaves those files out, for a database where an administrator
 * never ran them. Throws with the file name when a migration fails, so a
 * failing test says which file to look at.
 */
async function freshDb(opts = {}) {
  const PGlite = pglite();
  if (!PGlite) return null;
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'supabase-stub.sql'), 'utf8'));
  const run = async file => {
    if (!fs.existsSync(path.join(ROOT, file))) return;
    try { await db.exec(sqlOf(file)); }
    catch (e) { const err = new Error(`${file}: ${e.message}`); err.file = file; err.cause = e; throw err; }
  };
  const without = new Set(opts.without || []);
  for (const f of BASE) if (!without.has(f)) await run(f);
  if (opts.crm !== false) {
    for (const f of CRM) await run(f);
    if (opts.twice) for (const f of CRM) await run(f);     // every CRM migration must be safe to re-run
  }
  return db;
}

/** Run fn as a signed-in user: role authenticated + JWT claims, exactly as PostgREST does. */
async function as(db, userId, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
  await db.exec('set role authenticated');
  try { return await fn(); }
  finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}

/** Create an auth user (the signup trigger makes the profile), then set profile fields as the service. */
async function makeUser(db, { email, name, company, role = 'employee', manager_id = null, company2 = null }) {
  const r = await db.query(
    `insert into auth.users (email, raw_user_meta_data) values ($1, jsonb_build_object('full_name', $2::text, 'company', $3::text)) returning id`,
    [email, name, company]);
  const id = r.rows[0].id;
  await db.query(`update public.profiles set app_role = $2, manager_id = $3, company2 = $4, status = 'active' where id = $1`,
    [id, role, manager_id, company2]);
  return id;
}

module.exports = { freshDb, as, makeUser, sqlOf, BASE, CRM, pglite };
