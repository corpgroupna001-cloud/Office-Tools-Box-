-- ============================================================
-- Pre-signup OTP flow (universal standard):
--   sign up → OTP email → verify OTP → ONLY THEN create the account.
-- If the code is never entered, no auth user is ever created.
--
-- 1) pending_signups — holds the emailed code until it's verified.
--    Service-role only (RLS enabled, no policies) — the browser
--    never touches this table directly.
-- 2) Grandfather all existing accounts as verified so current
--    employees log straight in (login → success, no OTP detour).
-- Idempotent (safe to re-run).
-- ============================================================

create table if not exists public.pending_signups (
  email      text primary key,
  code_hash  text not null,
  attempts   int  not null default 0,
  sent_at    timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes'
);

alter table public.pending_signups enable row level security;
-- No policies on purpose: only the service-role key (server) can read/write.

-- Existing users predate email verification — mark them verified.
update public.profiles set email_verified = true where email_verified = false;
