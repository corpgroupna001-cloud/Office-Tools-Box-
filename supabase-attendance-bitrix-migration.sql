-- ============================================================
-- Attendance → Bitrix24: delivery that is tracked and retried, and the
-- logout nobody punched.
--
--   attendance_logs.bitrix_status   what happened to the punch's group message:
--                                   sent | failed | deferred | no_group | skipped
--                                   (null = sent before this migration, or not a
--                                   punch that posts). failed and deferred ones
--                                   are sent again by the attendance job.
--   attendance_auto_logouts         one row per person per attendance day when
--                                   the shift ended with nobody punched out (or
--                                   still on a break): the Logout posted for them,
--                                   exactly once.
--   bitrix_log.kind                 also allows shift_switch and auto_logout.
--
-- The job runs through the scheduler the dual-shift migration set up
-- (worksuite-shift-switch, every 5 minutes): that call now also retries
-- undelivered punches and closes shifts nobody logged out of. Check it is
-- there with:   select jobname, schedule from cron.job;
-- If it is missing, schedule it as supabase-dual-shift-migration.sql shows.
--
-- Safe to run more than once. Run in Supabase → SQL Editor.
-- ============================================================

alter table public.attendance_logs add column if not exists bitrix_status   text;
alter table public.attendance_logs add column if not exists bitrix_error    text;
alter table public.attendance_logs add column if not exists bitrix_at       timestamptz;
alter table public.attendance_logs add column if not exists bitrix_attempts int not null default 0;

alter table public.attendance_logs drop constraint if exists attendance_logs_bitrix_status_ck;
alter table public.attendance_logs add constraint attendance_logs_bitrix_status_ck
  check (bitrix_status is null or bitrix_status in ('sent', 'failed', 'deferred', 'no_group', 'skipped'));

-- What the retry reads every few minutes.
create index if not exists attendance_logs_bitrix_retry_idx
  on public.attendance_logs (log_datetime)
  where bitrix_status in ('failed', 'deferred');

create table if not exists public.attendance_auto_logouts (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  log_date   date not null,
  kind       text not null,
  logout_at  timestamptz not null,
  company    text,
  bitrix_ok  boolean,
  detail     text,
  created_at timestamptz not null default now(),
  primary key (user_id, log_date)
);
alter table public.attendance_auto_logouts drop constraint if exists attendance_auto_logouts_kind_ck;
alter table public.attendance_auto_logouts add constraint attendance_auto_logouts_kind_ck
  check (kind in ('no_punch_out', 'break_not_returned'));

-- Written by the server only; a person may see their own.
alter table public.attendance_auto_logouts enable row level security;
drop policy if exists attendance_auto_logouts_own on public.attendance_auto_logouts;
create policy attendance_auto_logouts_own on public.attendance_auto_logouts
  for select to authenticated using (user_id = auth.uid());

-- The shift-switch job has always logged as 'shift_switch', which this check
-- refused, so those attempts never reached the log. Allow it, and the new kind.
alter table public.bitrix_log drop constraint if exists bitrix_log_kind_ck;
alter table public.bitrix_log add constraint bitrix_log_kind_ck
  check (kind in ('punch', 'leave', 'test', 'shift_switch', 'auto_logout'));
