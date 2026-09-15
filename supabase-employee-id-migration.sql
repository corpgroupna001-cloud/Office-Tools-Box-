-- ============================================================
-- Employee ID — the ID a person is known by at work.
--
-- WorkSuite has kept one code per person, profiles.employee_code, and it
-- is the biometric reader's enrolment number: punches arrive under it and
-- attendance matches on it. People are known by something else — the ID
-- on their deals, leads and paperwork (GL-PIS-CSM-IC-001). That is
-- profiles.employee_id, added here.
--
--   employee_id    shown first wherever a person is: the CRM, chat
--                  mentions, the employee directory, the admin console.
--   employee_code  unchanged — now labelled "Biometric ID".
--
-- Only an administrator sets it: the admin console (service role) or a
-- workspace admin. An employee editing their own profile cannot change
-- it, the same way they cannot change their own workspace role.
--
-- Safe to run more than once. No existing row changes: every
-- employee_id starts empty until an administrator fills it in.
-- Run in Supabase → SQL Editor, after supabase-crm-import-migration.sql.
-- ============================================================

alter table public.profiles add column if not exists employee_id text;

-- Written as typed, with no stray spaces, and not absurdly long.
alter table public.profiles drop constraint if exists profiles_employee_id_ck;
alter table public.profiles add constraint profiles_employee_id_ck
  check (employee_id is null or (employee_id = btrim(employee_id) and length(employee_id) between 1 and 50));

-- One person per Employee ID, whatever the letter case.
create unique index if not exists profiles_employee_id_key
  on public.profiles (lower(employee_id)) where employee_id is not null;

-- Reads PostgREST's claims the way ws_guard_profile_role does: the service
-- key and the SQL editor carry no 'authenticated' role, so they may set it;
-- a signed-in session may only if it belongs to a workspace admin.
create or replace function public.ws_guard_employee_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'authenticated'
     and not public.ws_is_admin()
     and (case when tg_op = 'INSERT' then new.employee_id is not null
               else new.employee_id is distinct from old.employee_id end) then
    raise exception 'Employee ID can only be set by an administrator'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_employee_id on public.profiles;
create trigger profiles_guard_employee_id
  before insert or update of employee_id on public.profiles
  for each row execute procedure public.ws_guard_employee_id();
