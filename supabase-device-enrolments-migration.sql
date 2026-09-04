-- ============================================================================
-- device_enrolments — the biometric roster, kept as its own table
--
-- The admin "who is on the device" list used to be derived from
-- attendance_logs: group the punches, read the names off them. That works
-- until the punches are cleared — then the roster is empty and every person
-- has to punch again before you can bind them. It also can't hold anything
-- the punch rows don't, like the device's own Employee Code.
--
-- So the roster is its own table now. Every punch upserts the person's row
-- (see api/attendance-webhook.js), so the list survives an attendance wipe:
-- clearing the log clears the history, not the fact that the person exists.
--
-- Keyed on ENROLL_NO, the number the reader assigns at enrolment. That is the
-- one identifier the device sends reliably on every punch. staff_code (the
-- CG-… Employee Code) is captured when the device sends it, but binding never
-- depends on it — it arrives late, and on this reader it arrives truncated.
--
-- Run ONCE in Supabase -> SQL Editor. Idempotent.
-- ============================================================================

create table if not exists public.device_enrolments (
  enroll_no    text primary key,          -- the reader's enrolment number
  device_name  text,                       -- the name as the DEVICE spells it
  staff_code   text,                       -- the CG-… code, when the device sends one
  device_sn    text,                       -- which reader last saw them
  user_id      uuid references auth.users(id) on delete set null,  -- bound WorkSuite account
  first_seen   timestamptz,
  last_seen    timestamptz,
  punches      integer not null default 0,
  bound_at     timestamptz,
  bound_by     text
);

-- Binding writes user_id; the roster screen reads "who is not yet bound".
create index if not exists device_enrolments_user_idx on public.device_enrolments (user_id);

-- ============================================================================
-- record_enrolments — one atomic upsert for a whole batch of punches.
--
-- Called from the webhook after the punches are stored, with one entry per
-- distinct enroll_no in the batch. Doing it as a function keeps it to a single
-- round trip and lets first_seen/last_seen/punches accumulate correctly:
-- PostgREST's upsert can only replace columns, not take LEAST/GREATEST or add.
--
-- staff_code and device_name use COALESCE(new, existing) so a punch that omits
-- them never blanks a value an earlier punch supplied.
-- ============================================================================
create or replace function public.record_enrolments(items jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.device_enrolments
        (enroll_no, device_name, staff_code, device_sn, first_seen, last_seen, punches)
  select e->>'enroll_no',
         e->>'device_name',
         e->>'staff_code',
         e->>'device_sn',
         (e->>'first_seen')::timestamptz,
         (e->>'last_seen')::timestamptz,
         coalesce((e->>'punches')::int, 0)
    from jsonb_array_elements(items) as e
   where coalesce(e->>'enroll_no', '') <> ''
  on conflict (enroll_no) do update set
    device_name = coalesce(excluded.device_name, device_enrolments.device_name),
    staff_code  = coalesce(excluded.staff_code,  device_enrolments.staff_code),
    device_sn   = coalesce(excluded.device_sn,   device_enrolments.device_sn),
    first_seen  = least(coalesce(device_enrolments.first_seen, excluded.first_seen), excluded.first_seen),
    last_seen   = greatest(coalesce(device_enrolments.last_seen, excluded.last_seen), excluded.last_seen),
    punches     = device_enrolments.punches + excluded.punches;
end $$;

-- The webhook authenticates with the service_role key, which bypasses RLS, so
-- it can call this. No other grant is given.
revoke all on function public.record_enrolments(jsonb) from public, anon, authenticated;

-- ============================================================================
-- Admin-only, same lock as salaries and bitrix_targets: RLS on, no policies.
-- The roster carries names and the codes that map to attendance, so it is not
-- something an employee token should be able to read.
-- ============================================================================
alter table public.device_enrolments enable row level security;

-- ----------------------------------------------------------------------------
-- Backfill from whatever punch history still exists, so the roster is not
-- empty on day one. A no-op once punches start maintaining it, and harmless
-- to run after a wipe (there is simply nothing to copy).
-- ----------------------------------------------------------------------------
insert into public.device_enrolments
      (enroll_no, device_name, device_sn, first_seen, last_seen, punches, user_id)
select l.employee_code,
       (array_agg(l.employee_name order by l.log_datetime desc))[1],
       (array_agg(l.device_sn      order by l.log_datetime desc))[1],
       min(l.log_datetime),
       max(l.log_datetime),
       count(*),
       (select p.id from public.profiles p where p.employee_code = l.employee_code limit 1)
  from public.attendance_logs l
 where coalesce(l.employee_code, '') <> ''
 group by l.employee_code
on conflict (enroll_no) do nothing;

update public.device_enrolments d
   set bound_at = coalesce(d.bound_at, now()), bound_by = coalesce(d.bound_by, 'backfill')
 where d.user_id is not null and d.bound_at is null;
