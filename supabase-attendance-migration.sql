-- ============================================================
-- Biometric Attendance migration
--
-- Adds:
--   1) profiles.employee_code   — the biometric device's employee code.
--                                 Auto-filled on first punch by matching the
--                                 employee NAME the device sends against
--                                 profiles.full_name, so there is normally no
--                                 manual data entry.
--   2) attendance_logs          — one row per punch pushed by the Realtime
--                                 biometric cloud (OnlineRealSoft) to
--                                 /api/attendance-webhook.
--
-- Run ONCE in Supabase → SQL Editor → New query → paste → Run.
-- Idempotent (safe to re-run).
-- ============================================================

-- ---------- 1) employee_code on profiles ----------
alter table public.profiles
  add column if not exists employee_code text;

-- One profile per device code. NULLs are allowed and are not compared,
-- so unmapped employees don't collide with each other.
create unique index if not exists profiles_employee_code_uidx
  on public.profiles (employee_code)
  where employee_code is not null;

-- ---------- 2) attendance_logs ----------
create table if not exists public.attendance_logs (
  id             bigserial primary key,

  -- Who. user_id is null until the code is mapped to a profile.
  user_id        uuid references auth.users(id) on delete set null,
  employee_code  text not null,
  employee_name  text,                       -- name as sent by the device

  -- What.
  direction      text not null default 'UNKNOWN',   -- 'IN' | 'OUT' | 'UNKNOWN'

  -- When. log_datetime is absolute (UTC inside Postgres); log_date and
  -- log_time are the IST calendar date / wall-clock time, precomputed by the
  -- webhook so reports and "one day" grouping never drift across midnight.
  log_datetime   timestamptz not null,
  log_date       date not null,
  log_time       time,
  downloaded_at  timestamptz,

  -- Where. device_sn is NOT NULL with an empty-string default so it can sit
  -- in the plain-column unique index below (PostgREST's on_conflict target
  -- cannot reference an expression like coalesce(device_sn,'')).
  device_sn      text not null default '',
  device_no      text,
  device_name    text,

  -- Mail bookkeeping.
  email_status   text not null default 'pending',   -- pending|sent|failed|unmapped|skipped
  email_to       text,
  email_error    text,
  emailed_at     timestamptz,

  raw            jsonb,                      -- exact payload received, for forensics
  created_at     timestamptz not null default now()
);

-- Backfill for re-runs against an older version of this table.
alter table public.attendance_logs alter column device_sn set default '';
update public.attendance_logs set device_sn = '' where device_sn is null;
alter table public.attendance_logs alter column device_sn set not null;

alter table public.attendance_logs
  drop constraint if exists attendance_logs_direction_ck;
alter table public.attendance_logs
  add constraint attendance_logs_direction_ck
  check (direction in ('IN', 'OUT', 'UNKNOWN'));

alter table public.attendance_logs
  drop constraint if exists attendance_logs_email_status_ck;
alter table public.attendance_logs
  add constraint attendance_logs_email_status_ck
  check (email_status in ('pending', 'sent', 'failed', 'unmapped', 'skipped'));

-- ---------- Idempotency ----------
-- The vendor's "Manual Data Export" can replay a date range at any time, and
-- a flaky network can make the device resend. This index is what stops a
-- replay from emailing everyone their Monday punches all over again:
-- the webhook inserts with Prefer: resolution=ignore-duplicates, so a repeat
-- of the same punch is silently dropped instead of re-sent, and the
-- webhook only emails the rows PostgREST reports as actually inserted.
create unique index if not exists attendance_logs_dedupe_uidx
  on public.attendance_logs (employee_code, log_datetime, direction, device_sn);

create index if not exists attendance_logs_user_date_idx  on public.attendance_logs (user_id, log_date desc);
create index if not exists attendance_logs_date_idx       on public.attendance_logs (log_date desc, log_datetime desc);
create index if not exists attendance_logs_code_idx       on public.attendance_logs (employee_code);
create index if not exists attendance_logs_status_idx     on public.attendance_logs (email_status)
  where email_status in ('failed', 'unmapped');

-- ---------- Row Level Security ----------
-- Employees may read only their OWN punches. Admin tooling uses the
-- service_role key, which bypasses RLS entirely. Nothing may be written
-- from the browser — only the webhook (service_role) inserts.
alter table public.attendance_logs enable row level security;

drop policy if exists attendance_select_own on public.attendance_logs;
create policy attendance_select_own on public.attendance_logs
  for select to authenticated
  using (auth.uid() = user_id);

-- ---------- Realtime ----------
-- Lets /attendance update live when a punch lands, without polling.
-- RLS still applies, so a user only ever receives their own rows.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'attendance_logs'
  ) then
    alter publication supabase_realtime add table public.attendance_logs;
  end if;
end$$;

-- Done.
