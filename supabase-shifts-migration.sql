-- ============================================================
-- Employee shift timings
--
-- Named shift templates assigned to employees, used to flag late arrivals
-- and early departures against the biometric attendance data.
--
-- Run ONCE in Supabase → SQL Editor. Idempotent.
-- ============================================================

create table if not exists public.shifts (
  id            bigserial primary key,
  name          text not null unique,

  -- Wall-clock IST. end_time <= start_time means the shift crosses midnight
  -- (e.g. 22:00 → 07:00); the code handles that, no extra flag needed.
  start_time    time not null,
  end_time      time not null,

  -- Minutes of slack before a punch counts as late / early-out.
  grace_minutes           int not null default 0,
  early_out_grace_minutes int not null default 0,

  -- ISO weekday numbers: 1 = Monday … 7 = Sunday.
  -- Days not listed show as "Week-off" in the report rather than "Absent".
  working_days  smallint[] not null default '{1,2,3,4,5,6}',

  is_default    boolean not null default false,
  created_at    timestamptz not null default now()
);

alter table public.shifts drop constraint if exists shifts_grace_ck;
alter table public.shifts add constraint shifts_grace_ck
  check (grace_minutes between 0 and 240 and early_out_grace_minutes between 0 and 240);

-- working_days must be a non-empty set of valid ISO weekdays.
-- Uses array containment (<@) rather than a subquery: Postgres rejects
-- subqueries inside CHECK constraints (ERROR 0A000).
alter table public.shifts drop constraint if exists shifts_working_days_ck;
alter table public.shifts add constraint shifts_working_days_ck
  check (
    array_length(working_days, 1) between 1 and 7
    and working_days <@ array[1,2,3,4,5,6,7]::smallint[]
  );

-- Only one default shift at a time (used for employees with nothing assigned).
create unique index if not exists shifts_single_default_uidx
  on public.shifts ((is_default)) where is_default;

-- ---------- Assignment ----------
alter table public.profiles
  add column if not exists shift_id bigint references public.shifts(id) on delete set null;

create index if not exists profiles_shift_idx on public.profiles (shift_id);

-- ---------- Seed a General shift ----------
insert into public.shifts (name, start_time, end_time, grace_minutes, early_out_grace_minutes, working_days, is_default)
values ('General', '09:30', '18:30', 10, 10, '{1,2,3,4,5,6}', true)
on conflict (name) do nothing;

-- ---------- Row Level Security ----------
-- Everyone signed in may READ shifts (the employee page shows their own
-- window). Nobody writes from the browser — admin tooling uses service_role.
alter table public.shifts enable row level security;

drop policy if exists shifts_select_authenticated on public.shifts;
create policy shifts_select_authenticated on public.shifts
  for select to authenticated using (true);

-- Done.
