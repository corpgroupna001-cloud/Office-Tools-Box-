-- ============================================================================
-- WorkSuite — FULL DATA RESET
--
-- Deletes every row in every public table AND every sign-in account. It
-- cannot be undone: no soft delete, no recycle bin, and no point-in-time
-- restore on the Supabase free plan.
--
-- After this runs, nobody can log in until they register again — you
-- included. The admin panel keeps working throughout; it is protected by the
-- admin password, not by a user account.
--
-- BEFORE YOU RUN IT
--   * device-enrolments-2026-09-04.csv is the ONLY copy of the biometric
--     roster — 17 names and enroll numbers. Once attendance_logs is empty
--     that list is gone until each person punches again.
--   * 193 punches, payroll and leave history go with it. Attendance and wage
--     records are normally records a business must retain, so keep that CSV
--     somewhere real rather than only in a chat window.
--
-- Run the sections IN ORDER. Section 1 changes nothing — read its output and
-- only carry on if the numbers are what you expect.
--
-- AND READ SECTION 6 BEFORE SECTION 2. A full wipe also deletes the app's
-- CONFIGURATION, not just its data, and WorkSuite will not work correctly
-- until you put that back. Section 6 lists exactly what to re-run.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — LOOK FIRST.  Safe. Deletes nothing.
-- ============================================================================
select 'public table' as kind, relname as name, n_live_tup as rows
  from pg_stat_user_tables
 where schemaname = 'public' and n_live_tup > 0
union all
select 'auth.users', 'accounts that can sign in', count(*)::bigint from auth.users
union all
select 'storage',    'files in buckets',          count(*)::bigint from storage.objects
order by kind, rows desc;


-- ============================================================================
-- SECTION 2 — EMPTY EVERY PUBLIC TABLE.  ⚠️ POINT OF NO RETURN.
--
-- A loop over the live schema rather than a list typed by hand, so it cannot
-- miss a table or fail on one that no longer exists.
--
-- TRUNCATE ... CASCADE resolves foreign keys in whatever order they point, so
-- there is no dependency ordering to get wrong. RESTART IDENTITY returns the
-- auto-increment counters to 1, so the next punch is id 1 rather than id 194.
--
-- Tables owned by an EXTENSION are skipped. If PostGIS or similar is ever
-- installed it puts its own reference tables in public, and truncating those
-- breaks the extension rather than clearing your data.
-- ============================================================================
do $$
declare
  victims text;
begin
  select string_agg(format('%I.%I', t.schemaname, t.tablename), ', ')
    into victims
    from pg_tables t
   where t.schemaname = 'public'
     and not exists (
           select 1
             from pg_depend d
             join pg_class c on c.oid = d.objid
            where c.relname = t.tablename
              and c.relnamespace = 'public'::regnamespace
              and d.deptype = 'e');

  if victims is null then
    raise notice 'Nothing to empty.';
    return;
  end if;

  raise notice 'Emptying: %', victims;
  execute 'truncate table ' || victims || ' restart identity cascade';
  raise notice 'Done — every public table is empty.';
end $$;


-- ----------------------------------------------------------------------------
-- SECTION 2b — ALTERNATIVE: wipe the data, KEEP the configuration.
--
-- Use this INSTEAD of Section 2 if you would rather not rebuild shifts, leave
-- types, week-off rules and the Bitrix mapping by hand. Everything about
-- people and their activity still goes.
-- ----------------------------------------------------------------------------
-- do $$
-- declare victims text;
-- begin
--   select string_agg(format('%I.%I', t.schemaname, t.tablename), ', ')
--     into victims
--     from pg_tables t
--    where t.schemaname = 'public'
--      and t.tablename not in ('shifts', 'leave_types', 'company_policies',
--                              'bitrix_targets', 'holidays')
--      and not exists (select 1 from pg_depend d join pg_class c on c.oid = d.objid
--                       where c.relname = t.tablename
--                         and c.relnamespace = 'public'::regnamespace
--                         and d.deptype = 'e');
--   execute 'truncate table ' || victims || ' restart identity cascade';
-- end $$;


-- ============================================================================
-- SECTION 3 — DELETE THE SIGN-IN ACCOUNTS.  ⚠️ ALSO IRREVERSIBLE.
--
-- Section 2 removes the profiles but leaves the auth accounts, so those people
-- could still sign in to a WorkSuite that knows nothing about them. This
-- removes the accounts themselves, so everybody registers again and binding
-- happens at registration.
--
--   * This deletes YOUR OWN employee login too. You register again like
--     everyone else.
--   * It does NOT affect your Supabase dashboard access, and it does NOT
--     affect the admin panel — that is protected by the admin password, not by
--     a user account. You cannot lock yourself out of administration.
--   * If signups need approval, approve yourself from the admin panel
--     afterwards.
--
-- Run this AFTER Section 2. Deleting the accounts while profiles still holds
-- rows can trip a foreign key; emptying public first avoids that entirely.
-- ============================================================================
do $$
declare
  n bigint;
begin
  -- storage.objects.owner points at auth.users, and on some Supabase versions
  -- that constraint does not cascade — which makes the delete below fail with
  -- a foreign key error that looks unrelated to what you asked for. Releasing
  -- the reference first costs nothing: the files are being deleted anyway
  -- (Section 4), and ownership means nothing once the owner is gone.
  if exists (select 1 from information_schema.columns
              where table_schema = 'storage' and table_name = 'objects'
                and column_name = 'owner') then
    update storage.objects set owner = null where owner is not null;
  end if;

  select count(*) into n from auth.users;
  delete from auth.users;
  raise notice 'Deleted % sign-in account(s). Everyone registers again.', n;
end $$;


-- ============================================================================
-- SECTION 4 — THE FILES.  Not SQL; do this in the dashboard.
--
-- Avatars, attendance selfies, WFH clips, chat attachments and recordings are
-- real files in Storage. Section 2 emptied the tables that POINT at them; the
-- files themselves are still there using quota. Deleting rows from
-- storage.objects by hand would orphan them — the row vanishes, the file does
-- not.
--
-- Empty them properly: Dashboard → Storage → each bucket → select all → Delete.
-- The buckets themselves survive Section 2 (they live in the storage schema),
-- so nothing needs recreating.
-- ============================================================================


-- ============================================================================
-- SECTION 5 — CHECK IT WORKED.  Safe. Every count should be 0.
-- ============================================================================
-- select relname as table_name, n_live_tup as rows
--   from pg_stat_user_tables
--  where schemaname = 'public' and n_live_tup > 0
--  union all
--  select 'auth.users', count(*) from auth.users;


-- ============================================================================
-- SECTION 6 — PUT THE CONFIGURATION BACK.  Do not skip this.
--
-- Section 2 empties DATA and CONFIGURATION alike, and four tables are seeded
-- by migrations rather than entered by hand. Until you re-run these, WorkSuite
-- is missing things it depends on:
--
--   supabase-shifts-migration.sql     → shifts
--        Without a default shift there is no start or end time to compare a
--        punch against, so late arrivals, early departures and Login/Logout
--        detection all stop working.
--
--   supabase-payroll-migration.sql    → company_policies
--        Holds the week-off rules, including Saturday AND Sunday off for
--        Jobways and Genie Lamp. Lose it and everyone is back to Sunday only,
--        and the calendar marks Saturdays absent.
--
--   supabase-leave-migration.sql      → leave_types
--        The leave dropdown is empty until this runs — nobody can file leave.
--
--   supabase-bitrix-migration.sql     → bitrix_targets
--        The seven companies and their group labels. The Bitrix panel shows
--        no rows to map until this runs.
--
-- Re-run them in that order in the SQL Editor. They are all idempotent, so
-- running one twice is harmless.
--
-- Then, still to do by hand:
--   * your 2026 holiday list   → Admin → 🌴 Leave
--   * per-employee salaries    → Admin → 💰 Salary
--   * the three Bitrix groups  → Admin → 💬 Bitrix24
-- ============================================================================
