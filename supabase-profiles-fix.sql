-- ============================================================
-- Fix: allow all logged-in users to see everyone's profile.
-- Without this, chat's contact list stays empty ("No employees yet")
-- because RLS hides other users' rows.
--
-- Run once in Supabase → SQL Editor → New query → Run.
-- Idempotent (safe to re-run).
-- ============================================================

-- Drop the old own-only policy if it exists
drop policy if exists "profiles_select_own"           on public.profiles;
drop policy if exists "profiles_select_authenticated" on public.profiles;

-- New policy: any logged-in user can read any profile
create policy "profiles_select_authenticated"
  on public.profiles
  for select
  to authenticated
  using (true);

-- Keep insert and update strictly own-row
drop policy if exists "profiles_insert_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id);

-- Sanity: backfill profiles for any auth users that don't have one yet
-- (happens if the on_auth_user_created trigger was added AFTER users signed up)
insert into public.profiles (id, email, full_name)
select
  u.id,
  u.email,
  coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1))
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null
on conflict (id) do nothing;
