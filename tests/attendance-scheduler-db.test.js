// The attendance scheduler migration on a real Postgres engine (PGlite).
//
// The shift-end Logout and the dual-shift switch only happen when pg_cron's
// call reaches the webhook with a key it accepts. The old job carried a key
// to paste by hand and, left as it was, was refused every time while
// cron.job_run_details said 'succeeded'. These check the replacement: one
// file, run as-is, that makes its own secret, keeps it away from browser
// keys, schedules a job that sends it, and reports honestly on whether the
// calls are getting through.
//
// PGlite has no pg_cron or pg_net, so the job itself is checked against a
// stand-in cron.job / net.http_post built here; the loader applies the file
// up to its pg_cron part, exactly as for the other migrations.
//
// Skips itself when the dev dependency is missing: npm i -D @electric-sql/pglite
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { freshDb, as, makeUser, sqlOf, pglite } = require('./fixtures/load-db');

const skip = pglite() ? false : 'PGlite is not installed (npm i -D @electric-sql/pglite)';
const FILE = 'supabase-attendance-scheduler-migration.sql';
const NOVA = 'Nova Sportsmart Private Limited';
const SOURCE = fs.readFileSync(path.join(__dirname, '..', FILE), 'utf8');
// Everything from the pg_cron line on: the part only the hosted database runs.
const CRON_PART = SOURCE.slice(SOURCE.search(/^create extension if not exists pg_cron;$/m));
// The command the job runs every 5 minutes, as the migration schedules it.
const JOB_COMMAND = (/\$job\$([\s\S]*?)\$job\$/.exec(CRON_PART) || [])[1] || '';

let db, A;

const rows = async (sql, params) => (await db.query(sql, params)).rows;
const status = async () => (await rows('select public.worksuite_scheduler_status() as s'))[0].s;
async function asRole(role, fn) {
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
async function columns(table) {
  return rows(`select column_name, data_type, is_nullable, column_default from information_schema.columns
                where table_schema = 'public' and table_name = $1`, [table]);
}

test.before(async () => {
  if (skip) return;
  db = await freshDb();          // every migration, the scheduler one included
  A = await makeUser(db, { email: 'anil@nova.test', name: 'Anil Kumar', company: NOVA });
});

test('the file ends with the pg_cron part, and the job it schedules sends the stored secret, not a pasted key', () => {
  assert.ok(CRON_PART.startsWith('create extension if not exists pg_cron;'), 'the pg_cron part starts with the extension');
  assert.doesNotMatch(CRON_PART, /create table|alter table|create or replace function|create policy/i,
    'nothing but the job lives after the pg_cron line (the test loader stops there)');
  assert.match(CRON_PART, /cron\.unschedule\(jobid\) from cron\.job where jobname = 'worksuite-shift-switch'/);
  assert.match(CRON_PART, /cron\.schedule\(\s*'worksuite-shift-switch',\s*'\*\/5 \* \* \* \*'/);
  assert.match(JOB_COMMAND, /from public\.worksuite_scheduler s where s\.id = 1/);
  assert.doesNotMatch(JOB_COMMAND, /PASTE-YOUR|Bearer [A-Za-z0-9]/, 'no key is written into the job');
  const stamp = CRON_PART.search(/^update public\.worksuite_scheduler set scheduled_at = now\(\) where id = 1;$/m);
  assert.ok(stamp > CRON_PART.search(/^select cron\.schedule\(/m), 'the job is stamped right after it is scheduled');
});

test('the dual-shift migration no longer schedules the placeholder job over a working one', () => {
  const dual = fs.readFileSync(path.join(__dirname, '..', 'supabase-dual-shift-migration.sql'), 'utf8');
  const code = dual.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(code, /cron\.|net\.http_post|PASTE-YOUR/);
  assert.match(dual, /supabase-attendance-scheduler-migration\.sql/, 'it points to the file that does');
});

test('it applies after every other migration and again on top of itself, keeping the same secret', { skip }, async () => {
  const before = await rows('select id, secret, site_url from worksuite_scheduler');
  assert.equal(before.length, 1);
  assert.equal(before[0].id, 1);
  assert.match(before[0].secret, /^[0-9a-f]{64}$/);
  assert.equal(before[0].site_url, 'https://work-suite-mauve.vercel.app');

  await db.exec(sqlOf(FILE));
  const after = await rows('select id, secret from worksuite_scheduler');
  assert.deepEqual(after, [{ id: 1, secret: before[0].secret }], 're-running does not replace the key the job and webhook share');
});

test('worksuite_scheduler holds exactly one row', { skip }, async () => {
  await assert.rejects(db.query(`insert into worksuite_scheduler (id) values (2)`), /worksuite_scheduler_id_check/);
  await assert.rejects(db.query(`insert into worksuite_scheduler (id) values (1)`), /worksuite_scheduler_pkey/);
  assert.equal((await rows('select count(*)::int n from worksuite_scheduler'))[0].n, 1);
});

test('browser keys cannot read the secret or the status; the service key can', { skip }, async () => {
  const DENIED_TABLE = /permission denied for table worksuite_scheduler/;
  const DENIED_FN = /permission denied for function worksuite_scheduler_status/;
  await assert.rejects(asRole('anon', () => db.query('select secret from worksuite_scheduler')), DENIED_TABLE);
  await assert.rejects(as(db, A, () => db.query('select secret from worksuite_scheduler')), DENIED_TABLE);
  await assert.rejects(as(db, A, () => db.query(`update worksuite_scheduler set site_url = 'https://evil.example'`)), DENIED_TABLE);
  await assert.rejects(asRole('anon', () => db.query('select public.worksuite_scheduler_status()')), DENIED_FN);
  await assert.rejects(as(db, A, () => db.query('select public.worksuite_scheduler_status()')), DENIED_FN);

  const svc = await asRole('service_role', () => db.query('select secret from worksuite_scheduler where id = 1'));
  assert.match(svc.rows[0].secret, /^[0-9a-f]{64}$/, 'the webhook reads it with the service key');
  await asRole('service_role', () => db.query(`update worksuite_scheduler set last_run_at = null, last_ok = null where id = 1`));
  const st = await asRole('service_role', () => db.query('select public.worksuite_scheduler_status() as s'));
  assert.ok(Array.isArray(st.rows[0].s.problems));
});

test('shift_switch_posts and attendance_auto_logouts count their attempts', { skip }, async () => {
  for (const table of ['shift_switch_posts', 'attendance_auto_logouts']) {
    const col = (await columns(table)).find(c => c.column_name === 'attempts');
    assert.ok(col, `${table}.attempts exists`);
    assert.equal(col.data_type, 'integer');
    assert.equal(col.is_nullable, 'NO');
    assert.equal(col.column_default, '0');
  }
});

test('the status runs where pg_cron and pg_net are missing, and says so instead of failing', { skip }, async () => {
  const s = await status();
  assert.equal(s.job, null);
  assert.deepEqual(s.runs, []);
  assert.deepEqual(s.http, []);
  assert.ok(s.problems.some(p => /pg_cron/.test(p)), 'it names pg_cron');
  assert.ok(s.problems.some(p => /pg_net/.test(p)), 'it names pg_net');
});

// From here on the database has stand-ins for the parts of pg_cron and pg_net
// the job and the status read, shaped like the real ones.
test('the status sees through a placeholder job whose runs "succeeded" while every call was refused', { skip }, async () => {
  await db.exec(`
    create schema cron;
    create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean not null default true);
    create table cron.job_run_details (runid bigserial primary key, jobid bigint, status text, return_message text,
                                       start_time timestamptz, end_time timestamptz);
    create schema net;
    create table net._http_response (id bigserial primary key, status_code int, content_type text, headers jsonb,
                                     content text, timed_out boolean, error_msg text, created timestamptz not null default now());
  `);
  const old = `select net.http_post(url := 'https://work-suite-mauve.vercel.app/api/attendance-webhook?job=shift_switch',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer PASTE-YOUR-BIOMETRIC_API_KEY"}'::jsonb, body := '{}'::jsonb);`;
  const job = (await rows(`insert into cron.job (jobname, schedule, command) values ('worksuite-shift-switch', '*/5 * * * *', $1) returning jobid`, [old]))[0].jobid;
  for (let i = 7; i >= 1; i--) {
    await db.query(`insert into cron.job_run_details (jobid, status, return_message, start_time)
                    values ($1, 'succeeded', '1 row', now() - make_interval(mins => $2 * 5))`, [job, i]);
    await db.query(`insert into net._http_response (status_code, content, timed_out, created)
                    values (401, '{"error":"unauthorized"}', false, now() - make_interval(mins => $1 * 5))`, [i]);
  }

  const s = await status();
  assert.deepEqual(s.job, { jobname: 'worksuite-shift-switch', schedule: '*/5 * * * *', active: true, uses_db_secret: false });
  assert.equal(s.runs.length, 5, 'the last 5 runs');
  assert.ok(s.runs.every(r => r.status === 'succeeded'), 'pg_cron is content');
  assert.ok(new Date(s.runs[0].start_time) > new Date(s.runs[4].start_time), 'newest first');
  assert.equal(s.http.length, 7);
  assert.deepEqual(Object.keys(s.http[0]).sort(), ['content', 'created', 'error_msg', 'status_code', 'timed_out']);
  assert.equal(s.http[0].status_code, 401);
  assert.ok(s.problems.some(p => /placeholder key/.test(p)), 'the pasted placeholder is named');
  assert.ok(s.problems.some(p => /401/.test(p)), 'and so is the refusal');
});

test('the job the migration schedules sends the stored secret to the webhook, read afresh at every run', { skip }, async () => {
  await db.exec(`
    create table net.sent (url text, headers jsonb, body jsonb, timeout_milliseconds int);
    create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
                                  headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
                                  timeout_milliseconds int default 5000)
    returns bigint language sql as $$ insert into net.sent values (url, headers, body, timeout_milliseconds) returning 1::bigint $$;
  `);
  const { secret } = (await rows('select secret from worksuite_scheduler'))[0];

  await db.exec(JOB_COMMAND);
  const [call] = await rows('select * from net.sent');
  assert.equal(call.url, 'https://work-suite-mauve.vercel.app/api/attendance-webhook?job=shift_switch');
  assert.deepEqual(call.headers, { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` });
  assert.deepEqual(call.body, {});
  assert.equal(call.timeout_milliseconds, 30000, 'a busy run is not given up on after pg_net\'s default few seconds');

  await db.query(`update worksuite_scheduler set site_url = 'https://worksuite.example.test' where id = 1`);
  await db.exec(JOB_COMMAND);
  assert.equal((await rows('select url from net.sent order by url'))[1].url,
    'https://worksuite.example.test/api/attendance-webhook?job=shift_switch', 'no need to reschedule to move the site');
  await db.query(`update worksuite_scheduler set site_url = 'https://work-suite-mauve.vercel.app' where id = 1`);
});

test('running the pg_cron part over the placeholder job replaces it, and its old 401s are not blamed on the new one', { skip }, async () => {
  // pg_cron's schedule/unschedule, enough for the file's own calls.
  await db.exec(`
    create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as
      $f$ insert into cron.job (jobname, schedule, command) values (job_name, schedule, command) returning jobid $f$;
    create function cron.unschedule(job_id bigint) returns boolean language sql as
      $f$ delete from cron.job where jobid = job_id returning true $f$;
  `);
  const cronPart = CRON_PART.replace(/^create extension if not exists pg_(cron|net);$/gm, '-- (extension)');
  assert.equal((await rows(`select scheduled_at from worksuite_scheduler`))[0].scheduled_at, null, 'not scheduled yet');

  await db.exec(cronPart);
  const jobs = await rows(`select jobid, command from cron.job where jobname = 'worksuite-shift-switch'`);
  assert.equal(jobs.length, 1, 'the placeholder is gone and the new job is the only one');
  assert.equal(jobs[0].command, JOB_COMMAND);
  const { scheduled_at: stamped } = (await rows(`select scheduled_at from worksuite_scheduler`))[0];
  assert.ok(stamped instanceof Date, 'the file notes when it scheduled the job');

  // The 401s the placeholder collected are all older than that: right after
  // the migration the status says only that no run has arrived yet.
  let s = await status();
  assert.equal(s.job.uses_db_secret, true);
  assert.deepEqual(s.http, [], 'no answers yet from the new job');
  assert.deepEqual(s.problems.filter(p => !/is not installed/.test(p)),
    ['no scheduled run has reached the webhook yet (the job runs every 5 minutes)']);

  // A refusal of the NEW job (a webhook not deployed yet) is still reported.
  // Times are set, not taken from the clock: PGlite's ticks are coarse.
  await db.query(`insert into net._http_response (status_code, content, timed_out, created)
                  select 401, '{"error":"unauthorized"}', false, scheduled_at + interval '1 minute' from worksuite_scheduler`);
  s = await status();
  assert.equal(s.http.length, 1);
  assert.ok(s.problems.some(p => /refused \(401\)/.test(p)));

  // Ten minutes on, the file is run again: still one job, and the stamp
  // moves past that answer, which belonged to the job it replaced.
  await db.query(`update net._http_response set created = created - interval '10 minutes'
                   where created >= (select scheduled_at from worksuite_scheduler)`);
  await db.query(`update worksuite_scheduler set scheduled_at = scheduled_at - interval '10 minutes'`);
  const { scheduled_at: earlier } = (await rows(`select scheduled_at from worksuite_scheduler`))[0];
  await db.exec(cronPart);
  assert.equal((await rows(`select count(*)::int n from cron.job where jobname = 'worksuite-shift-switch'`))[0].n, 1);
  const { scheduled_at: again } = (await rows(`select scheduled_at from worksuite_scheduler`))[0];
  assert.ok(again > earlier, 'the re-run stamps the job it made');
  assert.deepEqual((await status()).http, [], 'the old job\'s answer is left out');
});

test('once the job is replaced, the status stops at the webhook\'s own record of the runs', { skip }, async () => {
  await db.query(`update cron.job set command = $1 where jobname = 'worksuite-shift-switch'`, [JOB_COMMAND]);
  await db.query(`insert into net._http_response (status_code, content, timed_out) values (200, '{"ok":true}', false)`);

  let s = await status();
  assert.equal(s.job.uses_db_secret, true);
  assert.ok(!s.problems.some(p => /placeholder|401/.test(p)), 'nothing left of the old job');
  assert.ok(s.problems.some(p => /no scheduled run has reached the webhook yet/.test(p)), 'the job alone is not proof');

  await db.query(`update worksuite_scheduler set last_run_at = now() - interval '2 hours', last_job = 'shift_switch', last_ok = true where id = 1`);
  s = await status();
  assert.ok(s.problems.some(p => /no scheduled run has reached the webhook since/.test(p)), 'a run that stopped arriving is flagged');

  await db.query(`update worksuite_scheduler set last_run_at = now() - interval '3 minutes', last_ok = false,
                    last_result = '{"attendance":{"error":"boom"}}' where id = 1`);
  s = await status();
  assert.ok(s.problems.some(p => /did not finish cleanly/.test(p)));

  await db.query(`update worksuite_scheduler set last_ok = true, last_result = null where id = 1`);
  s = await status();
  assert.deepEqual(s.problems.filter(p => !/is not installed/.test(p)), [], 'a working scheduler reports no problems');

  await db.query(`update cron.job set active = false where jobname = 'worksuite-shift-switch'`);
  assert.ok((await status()).problems.some(p => /paused/.test(p)));
  await db.query(`delete from cron.job`);
  assert.ok((await status()).problems.some(p => /no worksuite-shift-switch job/.test(p)));
});

test('run on its own, it creates what the jobs need from the dual-shift and attendance-bitrix migrations', { skip }, async () => {
  const bare = await freshDb({ crm: false, without: [
    'supabase-dual-shift-migration.sql',
    'supabase-corpgroup-retire-migration.sql',         // clears profiles.shift2_id, so it needs the dual-shift columns
    'supabase-attendance-bitrix-migration.sql',
  ] });
  const q = async (sql, params) => (await bare.query(sql, params)).rows;
  const cols = async table => (await q(`select column_name from information_schema.columns
                                         where table_schema = 'public' and table_name = $1`, [table])).map(c => c.column_name);

  assert.ok((await cols('profiles')).includes('shift2_id'));
  assert.ok((await cols('profiles')).includes('company2'));
  for (const c of ['user_id', 'post_date', 'posted_at', 'first_ok', 'second_ok', 'detail', 'attempts']) {
    assert.ok((await cols('shift_switch_posts')).includes(c), `shift_switch_posts.${c}`);
  }
  for (const c of ['user_id', 'log_date', 'kind', 'logout_at', 'company', 'bitrix_ok', 'detail', 'attempts']) {
    assert.ok((await cols('attendance_auto_logouts')).includes(c), `attendance_auto_logouts.${c}`);
  }
  for (const c of ['bitrix_status', 'bitrix_error', 'bitrix_at', 'bitrix_attempts']) {
    assert.ok((await cols('attendance_logs')).includes(c), `attendance_logs.${c}`);
  }
  const rls = await q(`select relname from pg_class where relnamespace = 'public'::regnamespace
                         and relname in ('shift_switch_posts', 'attendance_auto_logouts', 'worksuite_scheduler') and relrowsecurity`);
  assert.equal(rls.length, 3, 'row level security on all three');
  assert.equal((await q(`select 1 from pg_policies where policyname = 'attendance_auto_logouts_own'`)).length, 1);

  const who = (await q(`insert into auth.users (email) values ('x@nova.test') returning id`))[0].id;
  await assert.rejects(bare.query(`insert into attendance_auto_logouts (user_id, log_date, kind, logout_at) values ($1, current_date, 'nope', now())`, [who]),
    /attendance_auto_logouts_kind_ck/);
  await assert.rejects(bare.query(`insert into attendance_logs (employee_code, log_datetime, log_date, bitrix_status) values ('1', now(), current_date, 'lost')`),
    /attendance_logs_bitrix_status_ck/);
  await bare.query(`insert into bitrix_log (kind, ok) values ('shift_switch', true), ('auto_logout', false)`);
  await assert.rejects(bare.query(`insert into bitrix_log (kind, ok) values ('nope', true)`), /bitrix_log_kind_ck/);

  // Running the skipped migrations later still works: they only add what is missing.
  for (const f of ['supabase-dual-shift-migration.sql', 'supabase-attendance-bitrix-migration.sql', FILE]) {
    await bare.exec(sqlOf(f));
  }
  await bare.close();
});

test('where bitrix_log was never created it still applies, and widens the kinds once it exists', { skip }, async () => {
  const bare = await freshDb({ crm: false, without: [
    'supabase-dual-shift-migration.sql', 'supabase-bitrix-log-migration.sql',
    'supabase-corpgroup-retire-migration.sql', 'supabase-attendance-bitrix-migration.sql',
  ] });
  assert.equal((await bare.query(`select to_regclass('public.bitrix_log') as t`)).rows[0].t, null);
  assert.equal((await bare.query(`select count(*)::int n from worksuite_scheduler`)).rows[0].n, 1);

  await bare.exec(sqlOf('supabase-bitrix-log-migration.sql'));
  await assert.rejects(bare.query(`insert into bitrix_log (kind, ok) values ('auto_logout', true)`), /bitrix_log_kind_ck/);
  await bare.exec(sqlOf(FILE));
  await bare.query(`insert into bitrix_log (kind, ok) values ('auto_logout', true)`);
  await bare.close();
});

// ---- A full reset (supabase-full-reset.sql) and the reseed that follows it ----
// The job reads its secret and address from worksuite_scheduler at every run,
// so a reset that empties the table and never puts the row back leaves a job
// that calls nobody while pg_cron reports 'succeeded'.
const RESET = fs.readFileSync(path.join(__dirname, '..', 'supabase-full-reset.sql'), 'utf8');
const RESEED = fs.readFileSync(path.join(__dirname, '..', 'supabase-reseed-after-reset.sql'), 'utf8');
// Section 2 is the first block after its heading; Section 2b is the same kind
// of block, commented out, and runs here with the comment marks taken off.
const SECTION_2 = (/SECTION 2 —[\s\S]*?\n(do \$\$[\s\S]*?\nend \$\$;)/.exec(RESET) || [])[1] || '';
const SECTION_2B = ((/SECTION 2b —[\s\S]*?\n(-- do \$\$[\s\S]*?\n-- end \$\$;)/.exec(RESET) || [])[1] || '')
  .split('\n').map(l => l.replace(/^-- ?/, '')).join('\n');

/** The job's call, as pg_net would send it: what one run of the job's command queues. */
async function jobCalls(d) {
  await d.exec(`
    create schema if not exists net;
    create table if not exists net.sent (url text, headers jsonb, body jsonb, timeout_milliseconds int);
    create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
                                             headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
                                             timeout_milliseconds int default 5000)
    returns bigint language sql as $$ insert into net.sent values (url, headers, body, timeout_milliseconds) returning 1::bigint $$;
    delete from net.sent;
  `);
  await d.exec(JOB_COMMAND);
  return (await d.query('select url, headers from net.sent')).rows;
}

test('the reset keeps the scheduler working: Section 6 names its migration, the reseed restores its row', { skip }, async () => {
  assert.ok(SECTION_2.includes('truncate table'), 'Section 2 found');
  assert.ok(SECTION_2B.includes("'worksuite_scheduler'"), 'Section 2b keeps the scheduler row');
  const section6 = RESET.slice(RESET.indexOf('SECTION 6 —'));
  assert.match(section6, /supabase-attendance-scheduler-migration\.sql/, 'Section 6 lists the scheduler migration');

  const d = await freshDb({ crm: false });
  const secretOf = async () => (await d.query('select secret from worksuite_scheduler')).rows.map(r => r.secret);
  const [before] = await secretOf();
  assert.equal((await jobCalls(d)).length, 1, 'before the reset the job makes its call');

  // Section 2 empties everything, the scheduler row included: the job calls nobody.
  await d.exec(SECTION_2);
  assert.deepEqual(await secretOf(), []);
  assert.equal((await jobCalls(d)).length, 0);

  // The reseed puts the row back with a new secret, and the job sends it.
  await d.exec(RESEED);
  const [fresh] = await secretOf();
  assert.match(fresh, /^[0-9a-f]{64}$/);
  assert.notEqual(fresh, before);
  const calls = await jobCalls(d);
  assert.equal(calls.length, 1, 'after the reseed the job makes its call again');
  assert.equal(calls[0].url, 'https://work-suite-mauve.vercel.app/api/attendance-webhook?job=shift_switch');
  assert.equal(calls[0].headers.Authorization, `Bearer ${fresh}`);
  await d.exec(RESEED);
  assert.deepEqual(await secretOf(), [fresh], 're-running the reseed keeps the secret');

  // Section 2b ("keep the configuration") leaves the row and its secret alone.
  await d.query(`insert into auth.users (email) values ('ravi@nova.test')`);   // the signup trigger makes the profile
  assert.equal((await d.query('select count(*)::int n from profiles')).rows[0].n, 1);
  await d.exec(SECTION_2B);
  assert.equal((await d.query('select count(*)::int n from profiles')).rows[0].n, 0, 'Section 2b ran');
  assert.ok((await d.query('select count(*)::int n from leave_types')).rows[0].n > 0, 'and kept the configuration');
  assert.deepEqual(await secretOf(), [fresh]);
  assert.equal((await jobCalls(d)).length, 1);
  await d.close();
});

test('the reseed still runs where the scheduler migration never did', { skip }, async () => {
  const d = await freshDb({ crm: false, without: [FILE] });
  assert.equal((await d.query(`select to_regclass('public.worksuite_scheduler') as t`)).rows[0].t, null);
  await d.exec(RESEED);                                  // an unguarded insert would fail the whole file here
  assert.equal((await d.query(`select to_regclass('public.worksuite_scheduler') as t`)).rows[0].t, null);
  assert.ok((await d.query('select count(*)::int n from leave_types')).rows[0].n > 0, 'the other seeds still went in');
  await d.close();
});
