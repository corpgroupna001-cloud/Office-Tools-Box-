-- ============================================================
-- Company + email-verification migration
-- Adds:
--   1) profiles.company  (which corporate entity the employee belongs to)
--   2) profiles.email_verified  (flipped true after the user enters
--                                 the 6-digit code we email them)
--   3) signup_verifications  (short-lived OTP codes, one per user)
-- Idempotent (safe to re-run).
-- ============================================================

-- ---------- 1) company column on profiles ----------
alter table public.profiles
  add column if not exists company text;

-- Constrained to the six allowed values so typos can't creep in.
alter table public.profiles
  drop constraint if exists profiles_company_allowed_ck;
alter table public.profiles
  add constraint profiles_company_allowed_ck
  check (company is null or company in (
    'Nova Sportsmart Private Limited',
    'CORPGROUP',
    'Protathlitis Sportsmart LLP',
    'Jobways Point LLP',
    'Genie Lamp Private Limited',
    'Navyug Raise A Player Foundation'
  ));

create index if not exists profiles_company_idx on public.profiles (company);

-- ---------- 2) email_verified flag ----------
alter table public.profiles
  add column if not exists email_verified boolean not null default false;

-- ---------- 3) signup_verifications table ----------
create table if not exists public.signup_verifications (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code_hash text not null,      -- sha256 of the 6-digit code (never store plaintext)
  attempts int not null default 0,
  sent_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes'
);

create index if not exists signup_verifications_expires_idx
  on public.signup_verifications (expires_at);

-- RLS: users may read/update ONLY their own row (server also uses service_role for writes).
alter table public.signup_verifications enable row level security;

drop policy if exists sv_select_own on public.signup_verifications;
drop policy if exists sv_update_own on public.signup_verifications;

create policy sv_select_own on public.signup_verifications
  for select to authenticated using (auth.uid() = user_id);

create policy sv_update_own on public.signup_verifications
  for update to authenticated using (auth.uid() = user_id);
