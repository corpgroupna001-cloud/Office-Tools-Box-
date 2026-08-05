-- ============================================================
-- Add company column to profiles + update signup trigger
-- Run once in Supabase → SQL Editor → New query → Run.
-- Idempotent (safe to re-run).
-- ============================================================

-- Add the column if it doesn't exist
alter table public.profiles add column if not exists company text;

create index if not exists profiles_company_idx on public.profiles (company);

-- Update the signup trigger to also copy company from user_metadata
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, company)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    nullif(new.raw_user_meta_data->>'company', '')
  )
  on conflict (id) do update set
    email    = excluded.email,
    -- Preserve existing full_name if the new value is null/empty
    full_name = coalesce(nullif(excluded.full_name, ''), public.profiles.full_name),
    company  = coalesce(excluded.company, public.profiles.company);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
