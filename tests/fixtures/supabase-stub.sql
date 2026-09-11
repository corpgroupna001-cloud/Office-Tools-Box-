-- ============================================================================
-- The parts of a Supabase project the WorkSuite migrations rely on, recreated
-- for an in-process Postgres (PGlite) so tests can run every migration and
-- exercise Row Level Security without a network or a real project.
--
-- Mirrors Supabase closely enough for the policies to mean the same thing:
--   anon / authenticated / service_role roles (service_role bypasses RLS)
--   auth.users, auth.uid(), auth.role() reading request.jwt.claims
--   storage.buckets / storage.objects (RLS on) and storage.foldername()
--   the supabase_realtime publication
-- Test-only. Never run this against a real project.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

-- ---------------------------------------------------------------- auth
create schema if not exists auth;
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);
-- Same shape as Supabase's own helpers: an empty setting means "no caller".
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;

-- ------------------------------------------------------------- storage
create schema if not exists storage;
create table if not exists storage.buckets (
  id              text primary key,
  name            text,
  public          boolean not null default false,
  file_size_limit bigint,
  created_at      timestamptz not null default now()
);
create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets(id),
  name       text not null,
  owner      uuid,
  created_at timestamptz not null default now()
);
alter table storage.objects enable row level security;
-- 'a/b/c.pdf' -> {a,b}
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)]
$$;
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.objects, storage.buckets to authenticated, service_role;
grant execute on all functions in schema storage to anon, authenticated, service_role;

-- ------------------------------------------------------------- realtime
create publication supabase_realtime;
