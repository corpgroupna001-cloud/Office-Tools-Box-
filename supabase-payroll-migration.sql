-- ============================================================
-- Company week-offs, per-day salary, and a readable punch location
--
-- Three small additions that the calendar, pay sheet and chat status
-- badges all read from:
--
--   1) company_policies — which weekdays are a weekly off, per company.
--      Jobways and Genie Lamp are Sat + Sun; everyone else is Sun only.
--   2) salaries         — one per-day rate per employee. ADMIN ONLY.
--   3) attendance_logs.location_address — the street address a selfie
--      punch's GPS fix resolved to, so people read a place, not numbers.
--
-- Run ONCE in Supabase -> SQL Editor -> New query -> Run. Idempotent.
-- ============================================================

-- ---------- 1) Weekly offs per company ----------
-- ISO weekday numbers: 1 = Monday ... 7 = Sunday, matching shifts.working_days
-- so the two can be reasoned about together without a mental conversion.
create table if not exists public.company_policies (
  company    text primary key,
  week_offs  smallint[] not null default '{7}',
  updated_at timestamptz not null default now()
);

alter table public.company_policies drop constraint if exists company_policies_week_offs_ck;
alter table public.company_policies add constraint company_policies_week_offs_ck
  check (
    -- An empty array is legitimate (a site that works every day); a bogus
    -- weekday number is not.
    week_offs <@ array[1,2,3,4,5,6,7]::smallint[]
    and array_length(week_offs, 1) is distinct from 0
  );

-- Seed every company we send mail for. on conflict do nothing so re-running
-- this file never overwrites a change made later in Admin.
insert into public.company_policies (company, week_offs) values
  ('Jobways Point LLP',               '{6,7}'),
  ('Genie Lamp Private Limited',      '{6,7}'),
  ('Nova Sportsmart Private Limited', '{7}'),
  ('Protathlitis Sportsmart LLP',     '{7}'),
  ('CORPGROUP',                       '{7}'),
  ('Navyug Raise A Player Foundation','{7}'),
  ('Raise a Player',                  '{7}')
on conflict (company) do nothing;

-- ---------- 2) Salary: one per-day rate per employee ----------
create table if not exists public.salaries (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  per_day_rate  numeric(12,2) not null,
  currency      text not null default 'INR',
  note          text,
  updated_at    timestamptz not null default now(),
  updated_by    text
);

alter table public.salaries drop constraint if exists salaries_rate_ck;
alter table public.salaries add constraint salaries_rate_ck
  check (per_day_rate >= 0 and per_day_rate < 1000000);

-- ---------- 3) Where a selfie punch actually happened ----------
alter table public.attendance_logs
  add column if not exists location_address text;

-- The calendar and the pay sheet both scan one person's month at a time.
create index if not exists attendance_logs_user_date_idx
  on public.attendance_logs (user_id, log_date);

-- ---------- 4) Row Level Security ----------
alter table public.company_policies enable row level security;
alter table public.salaries         enable row level security;

-- Week-offs are not secret: the attendance page, the calendar and the chat
-- status badges all need them, and they are the same for everyone at a company.
drop policy if exists company_policies_read on public.company_policies;
create policy company_policies_read on public.company_policies
  for select to authenticated using (true);

-- ============================================================
-- salaries has NO POLICIES, and that is deliberate.
--
-- With RLS enabled and no policy granting select, PostgREST returns zero
-- rows to every anon and authenticated caller — including the employee the
-- row belongs to. Only the service_role key bypasses RLS, and that key
-- lives solely in the Vercel environment behind the password-gated admin
-- API. So salary is reachable from the admin screen and nowhere else.
--
-- Adding a "let people read their own salary" policy would change that.
-- Do not add one unless you actually mean to publish payslips.
-- ============================================================
