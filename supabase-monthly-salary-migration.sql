-- ============================================================================
-- salaries.monthly_salary — switch primary pay to a monthly salary
--
-- Payroll used to store a flat per-day rate and pay it for every day worked.
-- The new model stores a MONTHLY salary and prorates it by attendance:
--
--   per-day = monthly_salary / total working days that month
--   gross   = per-day * days present
--
-- "Total working days" is the person's scheduled working days for the month —
-- their shift's weekdays, minus company week-offs, minus company holidays. So
-- a month with a public holiday has fewer working days, each present day is
-- worth a little more, and a full salary is reached only by being present
-- every working day. Leave is unpaid (a leave day is not a present day);
-- holidays are removed from the divisor rather than paid.
--
-- This only ADDS a column. The old per_day_rate column is left in place (it is
-- no longer read for the primary salary, but nothing is dropped, so no data is
-- lost). secondary_roles keeps its own per_day_rate — the second role is still
-- a per-day top-up and is unaffected.
--
-- Existing rows have monthly_salary NULL until an admin enters one, and a NULL
-- salary shows as "—" in the Salary screen, never a bogus ₹0.
--
-- Run ONCE in Supabase -> SQL Editor. Idempotent.
-- ============================================================================

alter table public.salaries
  add column if not exists monthly_salary numeric(12,2);

alter table public.salaries drop constraint if exists salaries_monthly_salary_ck;
alter table public.salaries add constraint salaries_monthly_salary_ck
  check (monthly_salary is null or (monthly_salary >= 0 and monthly_salary < 100000000));
