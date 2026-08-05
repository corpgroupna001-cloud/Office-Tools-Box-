-- ============================================================
-- Add avatar_url column to profiles + update signup trigger.
-- Run once in Supabase → SQL Editor → New query → Run.
-- Idempotent (safe to re-run).
-- ============================================================

-- Add the column if it doesn't exist
alter table public.profiles add column if not exists avatar_url text;

-- Update the signup trigger to also copy avatar_url + company from user_metadata
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, company, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    nullif(new.raw_user_meta_data->>'company', ''),
    nullif(new.raw_user_meta_data->>'avatar_url', '')
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
