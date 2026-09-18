-- ============================================================
-- Re-seed the reference rows that supabase-full-reset.sql empties
--
-- The reset truncates EVERY public table - including the ones that hold
-- configuration rather than history: leave types, each company's weekly
-- offs, the per-company Bitrix mapping rows, and the attendance scheduler's
-- row. Their migration files create the tables (already there) and then
-- seed them; this file is just those seeds in one place, so a reset is
-- followed by one run of this instead of hunting through five files.
--
-- Every insert is ON CONFLICT DO NOTHING: re-running never overwrites a
-- change made later in Admin. Shifts are not re-seeded here because they
-- are usually re-created by hand with the real timings (as they were:
-- Day 9-6, Day 9:30-6:30, SportsMart 10-5, Jobways 5-7, Night 6PM-3AM).
--
-- Run in Supabase -> SQL Editor. Idempotent.
-- ============================================================

-- ---------- Leave types (supabase-leave-migration.sql) ----------
insert into public.leave_types (code, name, is_paid, sort_order) values
  ('CL',  'Casual Leave',        true,  1),
  ('SL',  'Sick Leave',          true,  2),
  ('EL',  'Earned Leave',        true,  3),
  ('CO',  'Comp Off',            true,  4),
  ('LWP', 'Leave Without Pay',   false, 5)
on conflict (code) do nothing;

-- ---------- Weekly offs per company (supabase-payroll-migration.sql) ----------
-- 1 = Mon ... 7 = Sun. Jobways and Genie Lamp are Sat+Sun off; the rest Sunday.
insert into public.company_policies (company, week_offs) values
  ('Jobways Point LLP',               '{6,7}'),
  ('Genie Lamp Private Limited',      '{6,7}'),
  ('Nova Sportsmart Private Limited', '{7}'),
  ('Protathlitis Sportsmart LLP',     '{7}'),
  ('Navyug Raise A Player Foundation','{7}'),
  ('Raise a Player',                  '{7}')
on conflict (company) do nothing;

-- ---------- Bitrix24: one row per company, no group yet (supabase-bitrix-migration.sql) ----------
-- dialog_id stays NULL so nothing posts until a group is picked in Admin.
insert into public.bitrix_targets (company, label) values
  ('Nova Sportsmart Private Limited',  'SportsMart Working Hours'),
  ('Protathlitis Sportsmart LLP',      'SportsMart Working Hours'),
  ('Jobways Point LLP',                'Jobways Working Hours'),
  ('Genie Lamp Private Limited',       'Genie Lamp Working Hours'),
  ('Navyug Raise A Player Foundation', null),
  ('Raise a Player',                   null)
on conflict (company) do nothing;

-- ---------- The attendance scheduler's row (supabase-attendance-scheduler-migration.sql) ----------
-- The 5-minute job reads its secret and site address from this row; with
-- the row gone it calls nobody - no shift-end Logouts, no dual-shift
-- switches, no Bitrix retries - while cron.job_run_details still says
-- 'succeeded'. The new row gets a new secret, which the job sends from its
-- next run and the webhook re-reads when it sees it: nothing to paste.
-- Skipped where the scheduler migration was never run (no table to fill);
-- run that file instead. Five minutes later,
-- select public.worksuite_scheduler_status(); should list no problems.
do $$
begin
  if to_regclass('public.worksuite_scheduler') is not null then
    insert into public.worksuite_scheduler (id) values (1) on conflict (id) do nothing;
  end if;
end $$;

-- ---------- What is there now ----------
select 'leave_types' as tbl, count(*) as rows from public.leave_types
union all select 'company_policies', count(*) from public.company_policies
union all select 'bitrix_targets', count(*) from public.bitrix_targets
union all select 'shifts', count(*) from public.shifts
union all select 'holidays', count(*) from public.holidays;
