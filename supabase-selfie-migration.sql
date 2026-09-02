-- ============================================================
-- Selfie attendance for WFH employees
--
-- WFH staff clock in/out and start/end breaks with a selfie plus a
-- MANDATORY GPS fix. These land in the SAME attendance_logs table as the
-- biometric punches, so one daily report, one set of emails and one set of
-- shift late/early rules cover office and home alike.
--
-- Run ONCE in Supabase → SQL Editor. Idempotent.
-- ============================================================

-- ---------- 1) attendance_logs gains the selfie columns ----------
alter table public.attendance_logs
  add column if not exists source        text not null default 'biometric',
  add column if not exists event_type    text,
  add column if not exists selfie_path   text,
  add column if not exists latitude      double precision,
  add column if not exists longitude     double precision,
  add column if not exists accuracy_m    real,
  add column if not exists review_status text,
  add column if not exists review_note   text,
  add column if not exists reviewed_at   timestamptz;

alter table public.attendance_logs drop constraint if exists attendance_logs_source_ck;
alter table public.attendance_logs add constraint attendance_logs_source_ck
  check (source in ('biometric', 'selfie'));

alter table public.attendance_logs drop constraint if exists attendance_logs_event_ck;
alter table public.attendance_logs add constraint attendance_logs_event_ck
  check (event_type is null or event_type in ('LOGIN', 'LOGOUT', 'BREAK_IN', 'BREAK_OUT'));

alter table public.attendance_logs drop constraint if exists attendance_logs_review_ck;
alter table public.attendance_logs add constraint attendance_logs_review_ck
  check (review_status is null or review_status in ('pending', 'approved', 'flagged'));

-- GPS is mandatory for a selfie punch — enforced at the database, not just in
-- the UI, so a crafted request cannot slip through without a location.
alter table public.attendance_logs drop constraint if exists attendance_logs_selfie_gps_ck;
alter table public.attendance_logs add constraint attendance_logs_selfie_gps_ck
  check (
    source <> 'selfie'
    or (latitude is not null and longitude is not null
        and latitude between -90 and 90 and longitude between -180 and 180)
  );

-- A selfie punch must actually carry a photo and an event.
alter table public.attendance_logs drop constraint if exists attendance_logs_selfie_shape_ck;
alter table public.attendance_logs add constraint attendance_logs_selfie_shape_ck
  check (source <> 'selfie' or (selfie_path is not null and event_type is not null));

-- ---------- 2) employee_code is biometric-only ----------
-- A WFH employee may have no reader code at all, so selfie rows are keyed by
-- user_id instead. The existing dedupe index tolerates this: NULLs compare as
-- distinct in a unique index, so selfie rows never collide with each other.
alter table public.attendance_logs alter column employee_code drop not null;

-- Stops a double-tap creating two punches: the webhook also rejects a repeat
-- of the same event within 60s, this is the backstop.
create unique index if not exists attendance_logs_selfie_dedupe_uidx
  on public.attendance_logs (user_id, event_type, log_datetime)
  where source = 'selfie';

create index if not exists attendance_logs_review_idx
  on public.attendance_logs (review_status, log_datetime desc)
  where source = 'selfie';

create index if not exists attendance_logs_source_idx on public.attendance_logs (source);

-- ---------- 3) Storage bucket ----------
insert into storage.buckets (id, name, public)
values ('selfies', 'selfies', false)
on conflict (id) do nothing;

drop policy if exists "selfie_upload_own" on storage.objects;
drop policy if exists "selfie_read_own"   on storage.objects;

-- Path shape is {user_id}/{yyyy-mm-dd}/{event}-{epoch}.jpg, so the first
-- folder segment gates access to the owner. Admin review goes through the
-- service_role key, which bypasses RLS.
create policy "selfie_upload_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'selfies'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "selfie_read_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'selfies'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Deliberately NO update/delete policy for employees: once a selfie punch is
-- recorded, the person who made it cannot alter or remove the evidence.

-- Done.
