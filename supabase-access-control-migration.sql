-- ============================================================================
-- Access control (migration 16). Run AFTER supabase-company-structure-migration.sql
-- (15), in Supabase -> SQL Editor. Idempotent: safe to run again, and run it
-- again after re-running any earlier CRM migration (1-15), because it
-- redefines a few of their helper functions.
--
-- Adds only: no row is deleted and existing accounts keep their status, so
-- everyone who can sign in today still can.
--
--   1. Membership (SEC-01). A new login account starts as 'pending' and sees
--      nothing until it is approved. /api/signup-complete makes it 'active' at
--      once when an invitation is waiting for that email and company
--      (ws_invitations); otherwise an administrator approves it in the admin
--      console. Signing up straight through Supabase Auth also ends at
--      'pending', and nobody can insert a profile row for themselves with an
--      administrator's columns filled in.
--   2. The session gate (SEC-02, SEC-03). Every database request made with a
--      person's token passes ws_session_status(): the account is active, its
--      session has not been ended (signed out, or ended when they left), and a
--      person with an authenticator app has done the second step (aal2). It
--      is enforced three ways:
--        - a PostgREST pre-request function (pgrst.db_pre_request), which
--          covers tables, views and every RPC;
--        - a RESTRICTIVE policy on every public table and on storage.objects,
--          which Realtime and Storage obey as well;
--        - the ws_* permission helpers say "no" for a session that fails it.
--      ws_my_access() is the one call such a session may make: the sign-in page
--      uses it to say "waiting for approval" or "enter your code".
--   3. Private HR columns (SEC-04). profiles.exit_date and exit_reason are no
--      longer readable with a person's token; every other column still is
--      (the directory, chat and org chart need them). Workspace admins read
--      them with ws_profile_private(); the admin console uses the service key.
--   4. Notifications come only from the database (SEC-10). Nobody may insert
--      one directly or call ws_notify(); the triggers that notify people about
--      tasks, deals, messages and calls are unaffected.
--   5. Ending sessions (SEC-03). ws_end_sessions(user) removes a person's
--      sessions and refresh tokens; the admin console calls it when someone
--      leaves, so a token they still hold stops working at once.
--
-- Recovery. A person who lost their authenticator: Admin -> Employees ->
-- "Remove two-step verification" (or Supabase -> Authentication -> Users ->
-- the user -> remove the factor); they then sign in with their password
-- alone. The admin password and the service key are never subject to the
-- gate, so the console always works. To switch the pre-request gate off:
--   alter role authenticator reset pgrst.db_pre_request; notify pgrst, 'reload config';
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Membership
-- ---------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_status_ck;
alter table public.profiles add constraint profiles_status_ck
  check (status in ('active', 'inactive', 'pending'));

-- New login accounts start pending. The server makes them active (an
-- invitation, or an administrator adding the person); metadata a browser
-- sent with a direct sign-up never does.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, company, avatar_url, status)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    nullif(new.raw_user_meta_data->>'company', ''),
    nullif(new.raw_user_meta_data->>'avatar_url', ''),
    'pending'
  )
  on conflict (id) do update set
    email      = excluded.email,
    full_name  = coalesce(nullif(excluded.full_name, ''), public.profiles.full_name),
    company    = coalesce(excluded.company,    public.profiles.company),
    avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- A profile row a person inserts for themselves (profiles_insert_own) carries
-- none of the columns an administrator owns.
create or replace function public.ws_guard_profile_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'authenticated' then
    new := jsonb_populate_record(new, jsonb_build_object(
      'status', 'pending', 'app_role', 'employee', 'email_verified', false,
      'company2', null, 'manager_id', null, 'shift_id', null, 'shift2_id', null,
      'employee_code', null, 'employee_id', null, 'is_wfh', false, 'department', null,
      'job_title', null, 'joining_date', null, 'exit_date', null, 'exit_reason', null));
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_guard_insert on public.profiles;
create trigger profiles_guard_insert before insert on public.profiles
  for each row execute procedure public.ws_guard_profile_insert();

-- Invitations: who may join which company without waiting for approval.
-- Written and read only by the server (service key).
create table if not exists public.ws_invitations (
  id          uuid primary key default gen_random_uuid(),
  email       text not null check (email = lower(btrim(email)) and email like '%@%'),
  company     text not null,
  invited_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  revoked_at  timestamptz
);
-- One open invitation per address and company; sending again extends it.
create unique index if not exists ws_invitations_open_idx on public.ws_invitations (email, company)
  where accepted_at is null and revoked_at is null;
create index if not exists ws_invitations_email_idx on public.ws_invitations (email, created_at desc);
alter table public.ws_invitations enable row level security;
revoke all on public.ws_invitations from public, anon, authenticated;
grant all on public.ws_invitations to service_role;

/** Record (or extend) an invitation. Server only. */
create or replace function public.ws_invite_record(p_email text, p_company text, p_invited_by uuid default null, p_days int default 14)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_until timestamptz := now() + make_interval(days => least(greatest(coalesce(p_days, 14), 1), 60));
begin
  insert into public.ws_invitations as i (email, company, invited_by, expires_at)
  values (lower(btrim(p_email)), p_company, p_invited_by, v_until)
  on conflict (email, company) where accepted_at is null and revoked_at is null
  do update set expires_at = greatest(i.expires_at, excluded.expires_at),
                invited_by = coalesce(excluded.invited_by, i.invited_by)
  returning id into v_id;
  return v_id;
end;
$$;

/** Is an unexpired invitation waiting for this address and company? Server only. */
create or replace function public.ws_invite_open(p_email text, p_company text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.ws_invitations
                  where email = lower(btrim(p_email)) and company = p_company
                    and accepted_at is null and revoked_at is null and expires_at > now());
$$;

/** Use up the invitation for this account. True only for the one call that claims it. Server only. */
create or replace function public.ws_invite_claim(p_email text, p_company text, p_user uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id from public.ws_invitations
   where email = lower(btrim(p_email)) and company = p_company
     and accepted_at is null and revoked_at is null and expires_at > now()
   order by created_at desc
   limit 1
   for update skip locked;
  if v_id is null then return false; end if;
  update public.ws_invitations set accepted_at = now(), accepted_by = p_user where id = v_id;
  return true;
end;
$$;

revoke execute on function public.ws_invite_record(text, text, uuid, int), public.ws_invite_open(text, text),
  public.ws_invite_claim(text, text, uuid) from public, anon, authenticated;
grant execute on function public.ws_invite_record(text, text, uuid, int), public.ws_invite_open(text, text),
  public.ws_invite_claim(text, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2) The session gate
-- ---------------------------------------------------------------------------
-- 'ok' for anything that is not a signed-in person (anonymous visitors, the
-- service key); for a person: 'ok', 'pending', 'inactive', 'no_profile',
-- 'session_ended' or 'mfa_required'. The claims were checked by PostgREST
-- (signature, expiry) before any SQL runs.
create or replace function public.ws_session_status()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c   jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
  uid uuid;
  st  text;
  sid text := c ->> 'session_id';
  t   regclass;
begin
  if coalesce(c ->> 'role', '') <> 'authenticated' then return 'ok'; end if;
  if coalesce(c ->> 'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return 'no_profile'; end if;
  uid := (c ->> 'sub')::uuid;
  select p.status into st from public.profiles p where p.id = uid;
  if st is null then return 'no_profile'; end if;
  if st <> 'active' then return st; end if;
  -- Signed out, or ended by an administrator: the token outlives its session by up to an hour.
  t := to_regclass('auth.sessions');
  if sid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and t is not null and has_table_privilege(t, 'SELECT') then
    if not exists (select 1 from auth.sessions s where s.id = sid::uuid) then return 'session_ended'; end if;
  end if;
  -- An authenticator set up means the second step is owed on every session.
  t := to_regclass('auth.mfa_factors');
  if coalesce(c ->> 'aal', 'aal1') <> 'aal2' and t is not null and has_table_privilege(t, 'SELECT') then
    if exists (select 1 from auth.mfa_factors f where f.user_id = uid and f.status::text = 'verified') then
      return 'mfa_required';
    end if;
  end if;
  return 'ok';
end;
$$;

-- ws_session_ok() runs once per row in the RESTRICTIVE policies below, so it
-- is a plain SQL expression Postgres inlines into the query: it compares a
-- transaction-local note against the request's claims, and only the first
-- row of a request pays for the lookups (ws_session_check). The note holds
-- the claims themselves, so a change of caller inside one transaction is
-- never answered from another caller's note. Nobody can set it through the
-- API. (It is not wrapped as `(select ...)` in the policies: that would make
-- Postgres see a sub-query on every table and report "infinite recursion" for
-- tables whose policies already look at each other.)
create or replace function public.ws_session_check()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ok boolean := public.ws_session_status() = 'ok';
begin
  perform set_config('ws.session_gate',
    case when ok then 'ok|' else 'no|' end || coalesce(current_setting('request.jwt.claims', true), ''), true);
  return ok;
end;
$$;

create or replace function public.ws_session_ok()
returns boolean
language sql
stable
as $$
  select case current_setting('ws.session_gate', true)
           when 'ok|' || coalesce(current_setting('request.jwt.claims', true), '') then true
           when 'no|' || coalesce(current_setting('request.jwt.claims', true), '') then false
           else public.ws_session_check() end;
$$;

/** The caller's own standing: what the sign-in page shows a session the gate turns away. */
create or replace function public.ws_my_access()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  p record;
  enrolled boolean := false;
  t regclass := to_regclass('auth.mfa_factors');
begin
  if uid is null then return jsonb_build_object('signed_in', false, 'access', 'signed_out'); end if;
  select status, email_verified, company, full_name into p from public.profiles where id = uid;
  if t is not null and has_table_privilege(t, 'SELECT') then
    select exists (select 1 from auth.mfa_factors f where f.user_id = uid and f.status::text = 'verified') into enrolled;
  end if;
  return jsonb_build_object(
    'signed_in', true, 'access', public.ws_session_status(), 'status', p.status,
    'email_verified', p.email_verified, 'company', p.company, 'full_name', p.full_name,
    'mfa_enrolled', enrolled);
end;
$$;

revoke execute on function public.ws_session_status(), public.ws_session_check(), public.ws_session_ok(), public.ws_my_access() from public;
grant execute on function public.ws_session_status(), public.ws_session_check(), public.ws_session_ok(), public.ws_my_access() to anon, authenticated, service_role;

-- PostgREST runs this before every request (tables, views, RPCs).
create or replace function public.ws_pre_request()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v text;
begin
  if current_setting('request.path', true) = '/rpc/ws_my_access' then return; end if;
  v := public.ws_session_status();
  perform set_config('ws.session_gate',
    case when v = 'ok' then 'ok|' else 'no|' end || coalesce(current_setting('request.jwt.claims', true), ''), true);
  if v <> 'ok' then
    raise exception 'This session cannot use WorkSuite data (%)', v
      using errcode = '42501', detail = v, hint = 'ws_access:' || v;
  end if;
end;
$$;
revoke execute on function public.ws_pre_request() from public;
grant execute on function public.ws_pre_request() to anon, authenticated, service_role;

do $$
declare
  cur text;
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    raise notice 'No authenticator role (not a Supabase database): pre-request gate not installed.';
    return;
  end if;
  select substr(cfg, length('pgrst.db_pre_request=') + 1) into cur
    from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) cfg
   where r.rolname = 'authenticator' and s.setdatabase = 0 and cfg like 'pgrst.db_pre_request=%';
  if cur is not null and cur not in ('public.ws_pre_request', 'ws_pre_request') then
    raise notice 'authenticator already runs % before each request; WorkSuite''s gate was not added. Call public.ws_pre_request() from it.', cur;
    return;
  end if;
  execute 'alter role authenticator set pgrst.db_pre_request = ''public.ws_pre_request''';
  notify pgrst, 'reload config';
exception when insufficient_privilege then
  raise notice 'Could not set pgrst.db_pre_request (%); the table and storage policies below still apply.', sqlerrm;
end
$$;

/**
 * The RESTRICTIVE policy on every public table with RLS: whatever else a
 * policy allows, a session the gate turns away gets nothing. Returns how many
 * tables it covers. Migrations that add tables call it at their end.
 */
create or replace function public.ws_apply_session_gate()
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  t record;
  n int := 0;
begin
  for t in
    select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
  loop
    execute format('drop policy if exists ws_session_gate on public.%I', t.relname);
    execute format('create policy ws_session_gate on public.%I as restrictive for all to authenticated '
                   'using (public.ws_session_ok()) with check (public.ws_session_ok())', t.relname);
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function public.ws_apply_session_gate() from public, anon, authenticated;

select public.ws_apply_session_gate();

do $$
begin
  if to_regclass('storage.objects') is not null then
    drop policy if exists ws_session_gate on storage.objects;
    create policy ws_session_gate on storage.objects as restrictive for all to authenticated
      using (public.ws_session_ok()) with check (public.ws_session_ok());
  end if;
exception when insufficient_privilege then
  raise notice 'Could not add the session gate to storage.objects (%).', sqlerrm;
end
$$;

-- The permission helpers: a session the gate turns away is nobody.
create or replace function public.ws_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when public.ws_session_ok()
              then coalesce((select app_role from public.profiles where id = auth.uid()), 'employee')
              else 'none' end;
$$;

create or replace function public.ws_company()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select company from public.profiles where id = auth.uid() and public.ws_session_ok();
$$;

create or replace function public.ws_same_company(target text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.ws_session_ok() and (
         public.ws_is_admin()
      or (target is not null and exists (
            select 1 from public.profiles p
             where p.id = auth.uid()
               and (p.company = target or p.company2 = target))));
$$;

create or replace function public.ws_manages(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.ws_session_ok() and (
         target_user = auth.uid()
      or public.ws_is_admin()
      or exists (
           select 1 from public.profiles t
            where t.id = target_user
              and (t.manager_id = auth.uid()
                   or (public.ws_is_manager() and public.ws_same_company(t.company)))));
$$;

do $$
begin
  if to_regprocedure('public.ws_my_companies()') is not null then
    create or replace function public.ws_my_companies()
    returns text[]
    language sql
    stable
    security definer
    set search_path = public
    as $f$
      select case when public.ws_session_ok()
                  then coalesce((select array_remove(array[p.company, p.company2], null) from public.profiles p where p.id = auth.uid()), '{}')
                  else '{}' end;
    $f$;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3) Private HR columns
-- ---------------------------------------------------------------------------
-- Column privileges: SELECT on every profiles column except the private
-- ones. A column added later is not readable until it is granted here, so a
-- new HR field stays private by default.
create or replace function public.ws_grant_profile_columns()
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'profiles'
     and column_name not in ('exit_date', 'exit_reason');
  revoke select on public.profiles from anon, authenticated;
  execute format('grant select (%s) on public.profiles to anon, authenticated', cols);
  return cols;
end;
$$;
revoke execute on function public.ws_grant_profile_columns() from public, anon, authenticated;
select public.ws_grant_profile_columns();

/** exit_date / exit_reason for a workspace admin; null for anyone else. */
create or replace function public.ws_profile_private(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when public.ws_is_admin()
              then (select jsonb_build_object('id', id, 'status', status, 'exit_date', exit_date, 'exit_reason', exit_reason)
                      from public.profiles where id = p_user)
         end;
$$;
revoke execute on function public.ws_profile_private(uuid) from public, anon;
grant execute on function public.ws_profile_private(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) Notifications come only from the database
-- ---------------------------------------------------------------------------
drop policy if exists notifications_insert_as_actor on public.notifications;
revoke insert on public.notifications from anon, authenticated;
revoke execute on function public.ws_notify(uuid, text, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.ws_notify(uuid, text, text, text, text, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5) Ending a person's sessions
-- ---------------------------------------------------------------------------
create or replace function public.ws_end_sessions(p_user uuid)
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  n int := 0;
begin
  if p_user is null then return 0; end if;
  if to_regclass('auth.refresh_tokens') is not null then
    delete from auth.refresh_tokens where user_id = p_user::text;
  end if;
  if to_regclass('auth.sessions') is not null then
    delete from auth.sessions where user_id = p_user;
    get diagnostics n = row_count;
  end if;
  return n;
end;
$$;
revoke execute on function public.ws_end_sessions(uuid) from public, anon, authenticated;
grant execute on function public.ws_end_sessions(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- What an administrator can check (Admin -> Overview -> Setup health)
-- ---------------------------------------------------------------------------
create or replace function public.ws_access_control_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  gated int;
  tables int;
  pre text;
begin
  select count(*) filter (where exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname and p.policyname = 'ws_session_gate')),
         count(*)
    into gated, tables
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity;
  select substr(cfg, length('pgrst.db_pre_request=') + 1) into pre
    from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) cfg
   where r.rolname = 'authenticator' and cfg like 'pgrst.db_pre_request=%';
  return jsonb_build_object(
    'tables_with_rls', tables, 'tables_gated', gated,
    'storage_gated', exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'ws_session_gate'),
    'pre_request', pre,
    'mfa_check', coalesce(has_table_privilege(to_regclass('auth.mfa_factors'), 'SELECT'), false),
    'session_check', coalesce(has_table_privilege(to_regclass('auth.sessions'), 'SELECT'), false),
    'pending_accounts', (select count(*) from public.profiles where status = 'pending'),
    'private_columns_hidden', not has_column_privilege('authenticated', 'public.profiles', 'exit_reason', 'SELECT'));
end;
$$;
revoke execute on function public.ws_access_control_status() from public, anon, authenticated;
grant execute on function public.ws_access_control_status() to service_role;

-- Done.
