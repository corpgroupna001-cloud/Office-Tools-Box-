-- WFH QC review: admin approves or rejects each Friday submission.
-- rejected => employee sees "QC failed" and must re-record all three clips
-- (their re-upload resets status back to 'pending').

alter table public.wfh_recordings
  add column if not exists status text not null default 'pending',
  add column if not exists review_note text,
  add column if not exists reviewed_at timestamptz;

alter table public.wfh_recordings drop constraint if exists wfh_recordings_status_check;
alter table public.wfh_recordings
  add constraint wfh_recordings_status_check
  check (status in ('pending','approved','rejected'));
