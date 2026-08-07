-- ============================================================
-- WFH Weekly Camera Recordings — v3 (three back-camera clips)
-- One clip each of: mobile, laptop, tab (tablet).
-- Run once in Supabase → SQL Editor → New query → Run.
-- Idempotent (safe to re-run).
-- ============================================================

-- ---------- 1) Three per-device path/bytes/secs columns ----------
alter table public.wfh_recordings add column if not exists mobile_path   text;
alter table public.wfh_recordings add column if not exists mobile_bytes  bigint;
alter table public.wfh_recordings add column if not exists mobile_secs   int;

alter table public.wfh_recordings add column if not exists laptop_path   text;
alter table public.wfh_recordings add column if not exists laptop_bytes  bigint;
alter table public.wfh_recordings add column if not exists laptop_secs   int;

alter table public.wfh_recordings add column if not exists tab_path      text;
alter table public.wfh_recordings add column if not exists tab_bytes     bigint;
alter table public.wfh_recordings add column if not exists tab_secs      int;

-- The v2 single video_path column stays for back-compat but is no longer written to.

-- ---------- 2) Storage / RLS policies unchanged from v2 ----------
-- (bucket "wfh-recordings", per-user folder gate, is_wfh flag on profiles
--  all installed in the v2 migration — nothing to re-run here.)
