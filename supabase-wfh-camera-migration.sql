-- ============================================================
-- WFH Weekly Camera Recordings — v2 (back camera, Friday-only)
-- Replaces the earlier laptop/mobile/tab flow.
-- Run once in Supabase → SQL Editor → New query → Run.
-- Idempotent (safe to re-run).
-- ============================================================

-- ---------- 1) is_wfh flag on profiles ----------
alter table public.profiles
  add column if not exists is_wfh boolean not null default false;

create index if not exists profiles_is_wfh_idx on public.profiles (is_wfh) where is_wfh = true;

-- ---------- 2) Simplify wfh_recordings for single back-camera video ----------
alter table public.wfh_recordings add column if not exists video_path  text;
alter table public.wfh_recordings add column if not exists video_bytes bigint;
alter table public.wfh_recordings add column if not exists video_secs  int;

-- We no longer use these; leave the columns nullable for backward compatibility.
-- (If you want a hard cleanup later, drop them explicitly in a future migration.)

-- Ensure the unique (user_id, week_of) constraint from v1 still holds
-- (create table if not exists already declares it — this is a no-op if present).

-- ---------- 3) Storage bucket + policies (same private bucket) ----------
insert into storage.buckets (id, name, public)
values ('wfh-recordings', 'wfh-recordings', false)
on conflict (id) do nothing;

drop policy if exists "wfh_upload_own"  on storage.objects;
drop policy if exists "wfh_read_own"    on storage.objects;
drop policy if exists "wfh_delete_own"  on storage.objects;

create policy "wfh_upload_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'wfh-recordings'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "wfh_read_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'wfh-recordings'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "wfh_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'wfh-recordings'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------- 4) RLS: users read/write their own; admin uses service_role ----------
alter table public.wfh_recordings enable row level security;

drop policy if exists "wfh_select_own" on public.wfh_recordings;
drop policy if exists "wfh_insert_own" on public.wfh_recordings;
drop policy if exists "wfh_update_own" on public.wfh_recordings;

create policy "wfh_select_own" on public.wfh_recordings
  for select to authenticated
  using (auth.uid() = user_id);

create policy "wfh_insert_own" on public.wfh_recordings
  for insert to authenticated
  with check (auth.uid() = user_id);

create policy "wfh_update_own" on public.wfh_recordings
  for update to authenticated
  using (auth.uid() = user_id);
