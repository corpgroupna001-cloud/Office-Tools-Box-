-- ============================================================================
-- secondary_roles — a second job for one person, paid separately
--
-- Some CORPGROUP staff work two shifts in a day (SportsMart 10-5 AND Jobways
-- 5-7) and are paid by each company, so payroll has to produce TWO lines for
-- them. The salaries table is one row per person (user_id is its primary key),
-- so it cannot hold a second rate. This table is that second rate.
--
-- One secondary role per person (user_id is the key here too) - enough for the
-- two-company case. Their PRIMARY shift and pay stay where they are today
-- (profiles.shift_id + salaries); this only adds the extra one.
--
-- The secondary role affects PAY, not the attendance STATUS shown on the
-- calendar: a day is still "present" or "absent" once, judged against the
-- primary shift. Payroll counts the primary line the way it always did, and
-- the secondary line as "worked days that fall on the secondary shift's
-- working days x the secondary rate". So a Mon-Fri day a SportsMart(Mon-Sat)
-- + Jobways(Mon-Fri) person came in earns both rates; a Saturday earns only
-- SportsMart. That is the real arrangement, and it needs no per-punch
-- time-window attribution.
--
-- Run ONCE in Supabase -> SQL Editor. Idempotent.
-- ============================================================================

create table if not exists public.secondary_roles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  label        text not null,                       -- e.g. 'Jobways'
  shift_id     bigint references public.shifts(id) on delete set null,
  per_day_rate numeric(12,2) not null,
  currency     text not null default 'INR',
  note         text,
  updated_at   timestamptz not null default now(),
  updated_by   text
);

alter table public.secondary_roles drop constraint if exists secondary_roles_rate_ck;
alter table public.secondary_roles add constraint secondary_roles_rate_ck
  check (per_day_rate >= 0 and per_day_rate < 1000000);

-- Admin-only, same lock as salaries: RLS on, no policies. Only the
-- service_role key behind the admin password reads or writes it. Pay is not
-- something an employee token should see.
alter table public.secondary_roles enable row level security;
