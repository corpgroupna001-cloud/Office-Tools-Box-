-- ============================================================================
-- Email codes and rate limits (migration 17). Run AFTER
-- supabase-access-control-migration.sql (16). Idempotent; adds columns and
-- functions, changes no existing row.
--
--   1. Durable rate limits (SEC-06, SEC-09): ws_rate_limits and
--      ws_rate_hit / ws_rate_peek / ws_rate_clear. A counter per key (an IP
--      address, an email, "admin password from this IP") in the database, so
--      every serverless instance shares it and parallel requests count.
--   2. Sign-up codes (pending_signups) and email-verification codes
--      (signup_verifications) are issued and checked by one database function
--      each, under a row lock: twenty wrong guesses sent at the same moment
--      are twenty attempts, a resend inside a minute is refused, at most five
--      codes an hour go to one address, and a right code works once.
--   3. Finishing is one transaction (BUG-03). Checking an email-verification
--      code marks the profile verified and uses the code up together, or does
--      neither. A sign-up's profile is stamped, its invitation claimed and its
--      code used up together; if that fails the code still works, so the
--      person can try again. The company is the one the code was issued for.
--
-- Every function here is for the server (service key) only.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Rate limits
-- ---------------------------------------------------------------------------
create table if not exists public.ws_rate_limits (
  key               text primary key,
  window_started_at timestamptz not null default now(),
  hits              int not null default 0
);
alter table public.ws_rate_limits enable row level security;
revoke all on public.ws_rate_limits from public, anon, authenticated;
grant all on public.ws_rate_limits to service_role;

/** Count one hit for key in a fixed window. { allowed, hits, retry_after } — allowed is false once hits pass p_max. */
create or replace function public.ws_rate_hit(p_key text, p_window_seconds int, p_max int)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  w interval := make_interval(secs => greatest(p_window_seconds, 1));
  r public.ws_rate_limits;
begin
  insert into public.ws_rate_limits as l (key, window_started_at, hits)
  values (left(p_key, 200), now(), 1)
  on conflict (key) do update set
    hits              = case when l.window_started_at <= now() - w then 1 else l.hits + 1 end,
    window_started_at = case when l.window_started_at <= now() - w then now() else l.window_started_at end
  returning * into r;
  -- Old windows are cleared now and then, so the table stays small.
  if random() < 0.01 then delete from public.ws_rate_limits where window_started_at < now() - interval '2 days'; end if;
  return jsonb_build_object('allowed', r.hits <= p_max, 'hits', r.hits,
    'retry_after', greatest(0, ceil(extract(epoch from (r.window_started_at + w - now()))))::int);
end;
$$;

/** The same answer without counting a hit. */
create or replace function public.ws_rate_peek(p_key text, p_window_seconds int, p_max int)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when l.key is null or l.window_started_at <= now() - make_interval(secs => greatest(p_window_seconds, 1))
              then jsonb_build_object('allowed', true, 'hits', 0, 'retry_after', 0)
              else jsonb_build_object('allowed', l.hits < p_max, 'hits', l.hits,
                     'retry_after', greatest(0, ceil(extract(epoch from (l.window_started_at + make_interval(secs => greatest(p_window_seconds, 1)) - now()))))::int)
         end
    from (select 1) one left join public.ws_rate_limits l on l.key = left(p_key, 200);
$$;

create or replace function public.ws_rate_clear(p_key text)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  delete from public.ws_rate_limits where key = left(p_key, 200);
$$;

-- ---------------------------------------------------------------------------
-- 2) Codes
-- ---------------------------------------------------------------------------
alter table public.pending_signups
  add column if not exists company           text,
  add column if not exists full_name         text,
  add column if not exists issued_in_window  int not null default 1,
  add column if not exists window_started_at timestamptz not null default now(),
  add column if not exists verified_at       timestamptz,
  add column if not exists claimed_until     timestamptz,
  add column if not exists signup_ref        uuid not null default gen_random_uuid(),
  add column if not exists created_user_id   uuid;

alter table public.signup_verifications
  add column if not exists issued_in_window  int not null default 1,
  add column if not exists window_started_at timestamptz not null default now();

/**
 * Issue a sign-up code for email + company (the code is bound to both).
 * { ok, expires_at } or { ok: false, reason: too_soon | too_many_codes, retry_after }.
 */
create or replace function public.ws_signup_code_issue(
  p_email text, p_company text, p_full_name text, p_code_hash text,
  p_ttl_seconds int default 900, p_gap_seconds int default 60, p_max_per_hour int default 5)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(p_email));
  r public.pending_signups;
  ttl interval := make_interval(secs => p_ttl_seconds);
begin
  insert into public.pending_signups (email, code_hash, attempts, sent_at, expires_at, company, full_name,
                                      issued_in_window, window_started_at, signup_ref)
  values (v_email, p_code_hash, 0, now(), now() + ttl, p_company, left(p_full_name, 150), 1, now(), gen_random_uuid())
  on conflict (email) do nothing
  returning * into r;
  if r.email is not null then return jsonb_build_object('ok', true, 'expires_at', r.expires_at); end if;

  select * into r from public.pending_signups where email = v_email for update;
  if r.sent_at > now() - make_interval(secs => p_gap_seconds) then
    return jsonb_build_object('ok', false, 'reason', 'too_soon',
      'retry_after', ceil(extract(epoch from (r.sent_at + make_interval(secs => p_gap_seconds) - now())))::int);
  end if;
  if r.window_started_at > now() - interval '1 hour' and r.issued_in_window >= p_max_per_hour then
    return jsonb_build_object('ok', false, 'reason', 'too_many_codes',
      'retry_after', ceil(extract(epoch from (r.window_started_at + interval '1 hour' - now())))::int);
  end if;
  update public.pending_signups set
    code_hash = p_code_hash, attempts = 0, sent_at = now(), expires_at = now() + ttl,
    company = p_company, full_name = left(p_full_name, 150),
    verified_at = null, claimed_until = null, signup_ref = gen_random_uuid(),
    issued_in_window  = case when window_started_at > now() - interval '1 hour' then issued_in_window + 1 else 1 end,
    window_started_at = case when window_started_at > now() - interval '1 hour' then window_started_at else now() end
  where email = v_email
  returning * into r;
  return jsonb_build_object('ok', true, 'expires_at', r.expires_at);
end;
$$;

/** Take back a code whose email never went out, so asking again is not "too soon". */
create or replace function public.ws_signup_code_withdraw(p_email text, p_code_hash text)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  delete from public.pending_signups
   where email = lower(btrim(p_email)) and code_hash = p_code_hash and created_user_id is null;
$$;

/**
 * Check a sign-up code. Every guess counts, right or wrong. A right code
 * holds the sign-up for p_claim_seconds so two parallel completions cannot
 * both go ahead. { ok, company, full_name, signup_ref, created_user_id } or
 * { ok: false, reason: no_code | expired | too_many_attempts | wrong_code | in_progress, attempts_left }.
 */
create or replace function public.ws_signup_code_check(p_email text, p_code_hash text,
  p_max_attempts int default 6, p_claim_seconds int default 60)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  r public.pending_signups;
begin
  select * into r from public.pending_signups where email = lower(btrim(p_email)) for update;
  if r.email is null then return jsonb_build_object('ok', false, 'reason', 'no_code'); end if;
  if r.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if r.attempts >= p_max_attempts then return jsonb_build_object('ok', false, 'reason', 'too_many_attempts'); end if;
  update public.pending_signups set attempts = attempts + 1 where email = r.email;
  if r.code_hash is distinct from p_code_hash then
    return jsonb_build_object('ok', false, 'reason', 'wrong_code', 'attempts_left', greatest(0, p_max_attempts - r.attempts - 1));
  end if;
  if r.claimed_until is not null and r.claimed_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'in_progress');
  end if;
  update public.pending_signups
     set verified_at = coalesce(verified_at, now()), claimed_until = now() + make_interval(secs => p_claim_seconds)
   where email = r.email;
  return jsonb_build_object('ok', true, 'company', r.company, 'full_name', r.full_name,
    'signup_ref', r.signup_ref, 'created_user_id', r.created_user_id);
end;
$$;

/** The login account now exists: remember it, so a retry finishes instead of creating another. */
create or replace function public.ws_signup_mark_created(p_email text, p_user uuid)
returns boolean
language sql
volatile
security definer
set search_path = public
as $$
  update public.pending_signups set created_user_id = p_user
   where email = lower(btrim(p_email)) and verified_at is not null and (created_user_id is null or created_user_id = p_user)
  returning true;
$$;

/** A completion stopped part way: let the next try go ahead now rather than after the hold. */
create or replace function public.ws_signup_release(p_email text)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  update public.pending_signups set claimed_until = null where email = lower(btrim(p_email));
$$;

/**
 * Finish a sign-up in one transaction: stamp the profile, claim the invitation
 * (active) or leave it for an administrator (pending), use the code up.
 * Returns { status }. Raises if the sign-up is not the one this account was
 * created for; then nothing changes and the code still works.
 */
create or replace function public.ws_signup_finish(p_email text, p_user uuid, p_avatar_url text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  r public.pending_signups;
  v_status text;
begin
  select * into r from public.pending_signups where email = lower(btrim(p_email)) for update;
  if r.email is null or r.verified_at is null or r.created_user_id is distinct from p_user then
    raise exception 'This sign-up was not verified for that account' using errcode = '42501';
  end if;
  v_status := case when public.ws_invite_claim(r.email, r.company, p_user) then 'active' else 'pending' end;
  update public.profiles set
    email = r.email,
    full_name = coalesce(nullif(btrim(r.full_name), ''), full_name),
    company = r.company,
    email_verified = true,
    status = v_status,
    avatar_url = coalesce(nullif(p_avatar_url, ''), avatar_url)
  where id = p_user;
  if not found then raise exception 'The profile for this account is missing' using errcode = 'P0002'; end if;
  delete from public.pending_signups where email = r.email;
  return jsonb_build_object('status', v_status);
end;
$$;

/** Issue an email-verification code for an existing account. Same answers as ws_signup_code_issue. */
create or replace function public.ws_verify_code_issue(p_user uuid, p_code_hash text,
  p_ttl_seconds int default 900, p_gap_seconds int default 60, p_max_per_hour int default 5)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  r public.signup_verifications;
  ttl interval := make_interval(secs => p_ttl_seconds);
begin
  insert into public.signup_verifications (user_id, code_hash, attempts, sent_at, expires_at, issued_in_window, window_started_at)
  values (p_user, p_code_hash, 0, now(), now() + ttl, 1, now())
  on conflict (user_id) do nothing
  returning * into r;
  if r.user_id is not null then return jsonb_build_object('ok', true, 'expires_at', r.expires_at); end if;

  select * into r from public.signup_verifications where user_id = p_user for update;
  if r.sent_at > now() - make_interval(secs => p_gap_seconds) then
    return jsonb_build_object('ok', false, 'reason', 'too_soon',
      'retry_after', ceil(extract(epoch from (r.sent_at + make_interval(secs => p_gap_seconds) - now())))::int);
  end if;
  if r.window_started_at > now() - interval '1 hour' and r.issued_in_window >= p_max_per_hour then
    return jsonb_build_object('ok', false, 'reason', 'too_many_codes',
      'retry_after', ceil(extract(epoch from (r.window_started_at + interval '1 hour' - now())))::int);
  end if;
  update public.signup_verifications set
    code_hash = p_code_hash, attempts = 0, sent_at = now(), expires_at = now() + ttl,
    issued_in_window  = case when window_started_at > now() - interval '1 hour' then issued_in_window + 1 else 1 end,
    window_started_at = case when window_started_at > now() - interval '1 hour' then window_started_at else now() end
  where user_id = p_user
  returning * into r;
  return jsonb_build_object('ok', true, 'expires_at', r.expires_at);
end;
$$;

/**
 * Check an email-verification code. A right code marks the profile verified
 * and uses the code up in the same transaction — or, if the profile cannot be
 * updated, raises and leaves both as they were.
 */
create or replace function public.ws_verify_code_check(p_user uuid, p_code_hash text, p_max_attempts int default 6)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  r public.signup_verifications;
begin
  select * into r from public.signup_verifications where user_id = p_user for update;
  if r.user_id is null then return jsonb_build_object('ok', false, 'reason', 'no_code'); end if;
  if r.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if r.attempts >= p_max_attempts then return jsonb_build_object('ok', false, 'reason', 'too_many_attempts'); end if;
  update public.signup_verifications set attempts = attempts + 1 where user_id = p_user;
  if r.code_hash is distinct from p_code_hash then
    return jsonb_build_object('ok', false, 'reason', 'wrong_code', 'attempts_left', greatest(0, p_max_attempts - r.attempts - 1));
  end if;
  update public.profiles set email_verified = true where id = p_user;
  if not found then raise exception 'The profile for this account is missing' using errcode = 'P0002'; end if;
  delete from public.signup_verifications where user_id = p_user;
  return jsonb_build_object('ok', true);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.ws_rate_hit(text, int, int)', 'public.ws_rate_peek(text, int, int)', 'public.ws_rate_clear(text)',
    'public.ws_signup_code_issue(text, text, text, text, int, int, int)', 'public.ws_signup_code_withdraw(text, text)',
    'public.ws_signup_code_check(text, text, int, int)', 'public.ws_signup_mark_created(text, uuid)',
    'public.ws_signup_release(text)', 'public.ws_signup_finish(text, uuid, text)',
    'public.ws_verify_code_issue(uuid, text, int, int, int)', 'public.ws_verify_code_check(uuid, text, int)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

-- New tables get the session gate (migration 16).
select public.ws_apply_session_gate();

-- Done.
