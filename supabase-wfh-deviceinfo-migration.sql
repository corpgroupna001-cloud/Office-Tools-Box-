-- Per-clip recording-device fingerprint: model, OS, camera label,
-- actual capture resolution, device type. Shown in admin so you can
-- verify the clip really came from their personal mobile.

alter table public.wfh_recordings
  add column if not exists mobile_device jsonb,
  add column if not exists laptop_device jsonb,
  add column if not exists tab_device    jsonb;
