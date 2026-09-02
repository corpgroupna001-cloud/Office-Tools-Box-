-- ============================================================
-- Leave & holidays
--
-- Requests → approval, plus a company holiday calendar. No balance
-- accounting (deliberately — chosen scope).
--
-- The point of this is the attendance report: "Absent" currently means
-- "no punch", which lumps together someone who skipped work, someone on
-- approved leave, and everyone on Diwali. After this it means absent.
--
-- Run ONCE in Supabase → SQL Editor. Idempotent.
-- ============================================================

-- ---------- 1) Leave types ----------
-- A table rather than a CHECK enum so admin can add a type without a
-- migration.
create table if not exists public.leave_types (
  id         bigserial primary key,
  code       text not null unique,
  name       text not null,
  is_paid    boolean not null default true,
  active     boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

insert into public.leave_types (code, name, is_paid, sort_order) values
  ('CL',  'Casual Leave',        true,  1),
  ('SL',  'Sick Leave',          true,  2),
  ('EL',  'Earned Leave',        true,  3),
  ('CO',  'Comp Off',            true,  4),
  ('LWP', 'Leave Without Pay',   false, 5)
on conflict (code) do nothing;

-- ---------- 2) Holiday calendar ----------
create table if not exists public.holidays (
  id           bigserial primary key,
  holiday_date date not null,
  name         text not null,
  -- NULL = applies to every company; otherwise just that entity.
  company      text,
  is_optional  boolean not null default false,
  created_at   timestamptz not null default now()
);

-- One entry per date per company. NULLs are distinct in a unique index, so
-- this is expressed on coalesce() to make "all companies" a single slot.
create unique index if not exists holidays_date_company_uidx
  on public.holidays (holiday_date, coalesce(company, '*'));

create index if not exists holidays_date_idx on public.holidays (holiday_date);

-- ---------- 3) Leave requests ----------
create table if not exists public.leave_requests (
  id             bigserial primary key,
  user_id        uuid not null references auth.users(id) on delete cascade,
  leave_type_id  bigint references public.leave_types(id) on delete set null,
  start_date     date not null,
  end_date       date not null,
  -- Half days only make sense on a single-day request; enforced below.
  day_part       text not null default 'full',
  reason         text,
  status         text not null default 'pending',
  decided_by     text,
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz not null default now()
);

alter table public.leave_requests drop constraint if exists leave_requests_status_ck;
alter table public.leave_requests add constraint leave_requests_status_ck
  check (status in ('pending', 'approved', 'rejected', 'cancelled'));

alter table public.leave_requests drop constraint if exists leave_requests_daypart_ck;
alter table public.leave_requests add constraint leave_requests_daypart_ck
  check (day_part in ('full', 'first_half', 'second_half'));

alter table public.leave_requests drop constraint if exists leave_requests_range_ck;
alter table public.leave_requests add constraint leave_requests_range_ck
  check (end_date >= start_date);

-- A half-day spanning a week is meaningless; keep the data honest.
alter table public.leave_requests drop constraint if exists leave_requests_halfday_ck;
alter table public.leave_requests add constraint leave_requests_halfday_ck
  check (day_part = 'full' or start_date = end_date);

create index if not exists leave_requests_user_idx   on public.leave_requests (user_id, start_date desc);
create index if not exists leave_requests_status_idx on public.leave_requests (status, start_date desc);
create index if not exists leave_requests_range_idx  on public.leave_requests (start_date, end_date);

-- ---------- 4) Row Level Security ----------
alter table public.leave_types    enable row level security;
alter table public.holidays       enable row level security;
alter table public.leave_requests enable row level security;

drop policy if exists leave_types_read on public.leave_types;
create policy leave_types_read on public.leave_types
  for select to authenticated using (true);

drop policy if exists holidays_read on public.holidays;
create policy holidays_read on public.holidays
  for select to authenticated using (true);

drop policy if exists leave_select_own on public.leave_requests;
drop policy if exists leave_insert_own on public.leave_requests;
drop policy if exists leave_cancel_own on public.leave_requests;

create policy leave_select_own on public.leave_requests
  for select to authenticated using (auth.uid() = user_id);

-- An employee may only file a request FOR THEMSELVES and only as 'pending' —
-- so nobody can self-approve by posting status:'approved' straight from the
-- browser. Approval happens through the admin API on the service_role key.
create policy leave_insert_own on public.leave_requests
  for insert to authenticated
  with check (auth.uid() = user_id and status = 'pending');

-- They may withdraw their own request, but only while it is still pending,
-- and only into 'cancelled'.
create policy leave_cancel_own on public.leave_requests
  for update to authenticated
  using (auth.uid() = user_id and status = 'pending')
  with check (auth.uid() = user_id and status in ('pending', 'cancelled'));

-- Done.
