-- ============================================================
-- WFH Weekly Recordings
-- Employees record laptop / mobile / tab screens every Friday
-- and submit them through /recordings/.
-- Run once in Supabase → SQL Editor → New query → Run.
-- Idempotent (safe to re-run).
-- ============================================================

-- ---------- 1) Storage bucket ----------
insert into storage.buckets (id, name, public)
values ('wfh-recordings', 'wfh-recordings', false)
on conflict (id) do nothing;

-- ---------- 2) Storage policies ----------
-- Files are stored under `<user_id>/<week_of>/<device>.<ext>` so we key
-- policies on the first folder segment being the caller's uid.

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

-- ---------- 3) Metadata table ----------
create table if not exists public.wfh_recordings (
  id            bigserial primary key,
  user_id       uuid references auth.users on delete cascade not null,
  full_name     text,
  email         text,
  week_of       date not null,                -- the Friday the recording is for
  laptop_path   text,                          -- storage path (bucket-relative)
  mobile_path   text,
  tab_path      text,
  laptop_bytes  bigint,
  mobile_bytes  bigint,
  tab_bytes     bigint,
  laptop_secs   int,
  notes         text,
  created_at    timestamptz default now(),
  unique (user_id, week_of)
);

create index if not exists wfh_recordings_week_idx on public.wfh_recordings (week_of desc);
create index if not exists wfh_recordings_user_idx on public.wfh_recordings (user_id);

alter table public.wfh_recordings enable row level security;

drop policy if exists "wfh_select_own"        on public.wfh_recordings;
drop policy if exists "wfh_insert_own"        on public.wfh_recordings;
drop policy if exists "wfh_update_own"        on public.wfh_recordings;

-- Users see and edit only their own submissions.
-- The admin dashboard uses the service_role key (bypasses RLS) to see all rows.
create policy "wfh_select_own" on public.wfh_recordings
  for select to authenticated
  using (auth.uid() = user_id);

create policy "wfh_insert_own" on public.wfh_recordings
  for insert to authenticated
  with check (auth.uid() = user_id);

create policy "wfh_update_own" on public.wfh_recordings
  for update to authenticated
  using (auth.uid() = user_id);
