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
-- This file only adds the columns and that table. The scheduler itself is set
-- up by supabase-attendance-scheduler-migration.sql, which also re-states
-- everything here, so running that one file is enough.
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
-- The scheduler that makes the switch happen is not set up here any more.
-- This file used to schedule it with a key to paste by hand; left unedited,
-- every call was refused, and re-running this file would replace a working
-- job with that one again. Run supabase-attendance-scheduler-migration.sql:
-- it creates the job with a secret the database generates, nothing to paste.
-- ---------------------------------------------------------------------------
