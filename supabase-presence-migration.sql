-- ============================================================
-- Add last_seen_at column to profiles for site-wide presence.
-- Run once in Supabase → SQL Editor → New query → Run.
-- Idempotent (safe to re-run).
-- ============================================================

alter table public.profiles add column if not exists last_seen_at timestamptz;
create index if not exists profiles_last_seen_idx on public.profiles (last_seen_at desc);
