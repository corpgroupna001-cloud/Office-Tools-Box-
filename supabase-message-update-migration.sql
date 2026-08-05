-- ============================================================
-- Allow sender to update their own message (needed for soft-delete)
-- Run once in Supabase → SQL Editor → New query → Run.
-- Idempotent (safe to re-run).
-- ============================================================

drop policy if exists "msg_update_own" on public.messages;
create policy "msg_update_own" on public.messages
  for update to authenticated
  using (auth.uid() = sender_id);
