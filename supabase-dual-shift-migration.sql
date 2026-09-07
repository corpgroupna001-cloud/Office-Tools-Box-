-- ============================================================================
-- Dual shifts: one employee, two shifts (typically for two companies).
--
--   10:00-17:00 SportsMart 10-5, Mon-Sat   +   17:00-19:00 Jobways Evening, Mon-Fri
--
-- Assign both in Admin -> Shifts (Shift / Second shift / For company). On the
-- days both cover, attendance treats the day as ONE window, first start to
-- last end; on the second shift's own days it uses that shift. Every day
-- either shift covers is a working day for the monthly salary.
--
-- When the second shift is for another company, a scheduler calls the
-- attendance webhook every few minutes; at the second shift's start, for
-- anyone who is on site, it posts "Logout · shift over" to the first
-- company's Bitrix chat and "Login" to the second's, as the person.
-- shift_switch_posts records one row per person per day so it happens once.
--
-- Run once in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

alter table public.profiles
  add column if not exists shift2_id bigint references public.shifts(id) on delete set null,
  add column if not exists company2  text;

create table if not exists public.shift_switch_posts (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  post_date  date not null,
  posted_at  timestamptz,
  first_ok   boolean,
  second_ok  boolean,
  detail     text,
  created_at timestamptz not null default now(),
  primary key (user_id, post_date)
);
alter table public.shift_switch_posts enable row level security;   -- service key only, like salaries

-- ---------------------------------------------------------------------------
-- The scheduler: pg_cron + pg_net, every 5 minutes, calling the webhook with
-- the same key the biometric device uses (BIOMETRIC_API_KEY in Vercel).
-- Paste your key in place of PASTE-YOUR-BIOMETRIC_API_KEY before running.
-- The job is idempotent, so "every 5 minutes" is safe; the switch itself
-- happens once per person per day, within 5 minutes of the shift start.
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'worksuite-shift-switch';
select cron.schedule(
  'worksuite-shift-switch',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://work-suite-mauve.vercel.app/api/attendance-webhook?job=shift_switch',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer PASTE-YOUR-BIOMETRIC_API_KEY"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);

-- To check it is running:   select * from cron.job_run_details order by start_time desc limit 10;
-- To stop it:               select cron.unschedule('worksuite-shift-switch');
