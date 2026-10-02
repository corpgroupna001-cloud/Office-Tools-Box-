-- ============================================================================
-- Delivery retry queue (migration 24). Run AFTER
-- supabase-attendance-corrections-migration.sql (23). Idempotent; adds one
-- table and five functions, all for the server only.
--
-- A message that could not be delivered — an attendance email, a line in the
-- company's Bitrix group, a push — is kept here and sent again with backoff,
-- each channel on its own, so a mail server that is down never holds up the
-- Bitrix line and the other way round (F-06).
--
--   - idempotency_key is unique: one job per message and channel, e.g.
--     'attendance:4711:email'. Asking twice finds the first job; a job that
--     was sent is never sent again.
--   - A sender claims due jobs (FOR UPDATE SKIP LOCKED, with a lease), so two
--     overlapping runs never take the same job; a job whose sender died comes
--     back when its lease runs out.
--   - Transient failures wait 1 min, 5 min, 15 min, 1 h, then 3 h between
--     attempts, up to max_attempts. Permanent failures (no address, no group,
--     a rejected recipient) and exhausted ones stop as 'dead' and stay listed
--     for administrators, who can send them again from the admin console.
--   - A message too old to be useful (expires_at) is not sent late.
--
-- Nobody signed in can read or change the queue: the API functions use the
-- service key, and the admin console shows it.
-- ============================================================================

create table if not exists public.delivery_jobs (
  id              uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (length(idempotency_key) between 3 and 200),
  channel         text not null check (channel in ('email', 'bitrix', 'push')),
  kind            text not null,                    -- 'attendance.punch', 'attendance.leave', ...
  company         text,
  source_table    text,                             -- where the result is written back
  source_id       text,
  payload         jsonb not null default '{}'::jsonb,   -- what to send, exactly as the first attempt sent it
  status          text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'dead')),
  attempts        int not null default 0 check (attempts >= 0),
  max_attempts    int not null default 5 check (max_attempts between 1 and 30),
  next_attempt_at timestamptz not null default now(),
  locked_until    timestamptz,
  expires_at      timestamptz,
  last_error      text,
  last_attempt_at timestamptz,
  sent_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists delivery_jobs_due_idx on public.delivery_jobs (next_attempt_at) where status in ('pending', 'failed', 'sending');
create index if not exists delivery_jobs_status_idx on public.delivery_jobs (status, updated_at desc);
create index if not exists delivery_jobs_source_idx on public.delivery_jobs (source_table, source_id);
alter table public.delivery_jobs enable row level security;
revoke all on public.delivery_jobs from anon, authenticated;

/** The wait before the next attempt, after `p_attempts` attempts. */
create or replace function public.ws_delivery_backoff(p_attempts int)
returns interval
language sql
immutable
as $$
  select case
    when p_attempts <= 1 then interval '1 minute'
    when p_attempts = 2 then interval '5 minutes'
    when p_attempts = 3 then interval '15 minutes'
    when p_attempts = 4 then interval '1 hour'
    else interval '3 hours' end;
$$;

/**
 * Add a job, once per key. p_attempts / p_error record a first attempt that
 * already happened (the punch handler tries straight away); p_dead marks it
 * as a permanent failure, kept for review. Returns the job and whether this
 * call created it ("created": false means the message was already queued).
 */
create or replace function public.ws_delivery_enqueue(
  p_key text, p_channel text, p_kind text, p_payload jsonb,
  p_company text default null, p_source_table text default null, p_source_id text default null,
  p_attempts int default 0, p_error text default null, p_dead boolean default false,
  p_expires_at timestamptz default null, p_max_attempts int default 5)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  j public.delivery_jobs;
  v_attempts int := greatest(coalesce(p_attempts, 0), 0);
  v_max int := least(greatest(coalesce(p_max_attempts, 5), 1), 30);
begin
  insert into public.delivery_jobs (idempotency_key, channel, kind, payload, company, source_table, source_id,
                                    status, attempts, max_attempts, next_attempt_at, expires_at, last_error, last_attempt_at)
  values (p_key, p_channel, p_kind, coalesce(p_payload, '{}'::jsonb), p_company, p_source_table, p_source_id,
          case when p_dead or v_attempts >= v_max then 'dead' when v_attempts > 0 then 'failed' else 'pending' end,
          v_attempts, v_max,
          now() + case when v_attempts > 0 then public.ws_delivery_backoff(v_attempts) else interval '0' end,
          p_expires_at, left(p_error, 1000), case when v_attempts > 0 then now() end)
  on conflict (idempotency_key) do nothing
  returning * into j;
  if j.id is not null then return to_jsonb(j) || jsonb_build_object('created', true); end if;
  select * into j from public.delivery_jobs where idempotency_key = p_key;
  return to_jsonb(j) || jsonb_build_object('created', false);
end;
$$;

/**
 * Claim up to p_limit due jobs (or one, by id) for p_lease_seconds. Jobs too
 * old to send, and jobs whose last attempt never answered, are closed as dead
 * first. Each claimed job's attempts is the attempt number to report back.
 */
create or replace function public.ws_delivery_claim(p_limit int default 10, p_lease_seconds int default 120, p_id uuid default null)
returns setof public.delivery_jobs
language plpgsql
volatile
set search_path = public
as $$
begin
  update public.delivery_jobs set status = 'dead', locked_until = null, updated_at = now(),
         last_error = case when expires_at is not null and expires_at <= now()
                           then left(coalesce(last_error || ' · ', '') || 'expired: too late to be useful', 1000)
                           else left(coalesce(last_error || ' · ', '') || 'the last attempt never answered', 1000) end
   where (p_id is null or id = p_id)
     and ((status in ('pending', 'failed') and expires_at is not null and expires_at <= now())
       or (status = 'sending' and locked_until < now() and (attempts >= max_attempts or (expires_at is not null and expires_at <= now()))));

  return query
  update public.delivery_jobs j
     set status = 'sending', attempts = j.attempts + 1, last_attempt_at = now(), updated_at = now(),
         locked_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 10), 900))
   where j.id in (
     select d.id from public.delivery_jobs d
      where (p_id is null or d.id = p_id)
        and ((d.status in ('pending', 'failed') and d.next_attempt_at <= now())
          or (d.status = 'sending' and d.locked_until < now()))
        and d.attempts < d.max_attempts
        and (d.expires_at is null or d.expires_at > now())
      order by d.next_attempt_at
      limit least(greatest(coalesce(p_limit, 10), 1), 100)
      for update skip locked)
  returning j.*;
end;
$$;

/**
 * The outcome of attempt p_attempt. A result for an attempt that is no longer
 * the current one is ignored — except a success, which always wins, so a
 * message that did go out is never sent again.
 */
create or replace function public.ws_delivery_result(p_id uuid, p_attempt int, p_ok boolean, p_error text default null, p_permanent boolean default false)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  j public.delivery_jobs;
begin
  select * into j from public.delivery_jobs where id = p_id for update;
  if j.id is null then return null; end if;
  if j.status = 'sent' then return to_jsonb(j) || jsonb_build_object('stale', true); end if;
  if p_ok then
    -- p_error on a success is a note, e.g. that there was nothing to deliver to.
    update public.delivery_jobs set status = 'sent', sent_at = now(), locked_until = null, last_error = left(p_error, 1000), updated_at = now()
     where id = p_id returning * into j;
    return to_jsonb(j);
  end if;
  if j.status <> 'sending' or j.attempts <> p_attempt then
    return to_jsonb(j) || jsonb_build_object('stale', true);
  end if;
  update public.delivery_jobs set
    status = case when p_permanent or j.attempts >= j.max_attempts then 'dead' else 'failed' end,
    next_attempt_at = now() + public.ws_delivery_backoff(j.attempts),
    locked_until = null, last_error = left(coalesce(p_error, 'failed'), 1000), updated_at = now()
   where id = p_id returning * into j;
  return to_jsonb(j);
end;
$$;

/**
 * An administrator sends a failed or dead job again: it is due now, with
 * three more attempts and no age limit. A sent job is never sent again, and a
 * job already waiting is left alone.
 */
create or replace function public.ws_delivery_retry(p_id uuid)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  j public.delivery_jobs;
begin
  select * into j from public.delivery_jobs where id = p_id for update;
  if j.id is null then raise exception 'No such delivery' using errcode = 'P0002'; end if;
  if j.status = 'sent' then raise exception 'Already delivered: it is not sent again' using errcode = '22023'; end if;
  if j.status in ('pending', 'sending') then raise exception 'Already waiting to be sent' using errcode = '22023'; end if;
  update public.delivery_jobs set status = 'pending', next_attempt_at = now(), expires_at = null,
         max_attempts = least(greatest(max_attempts, attempts + 3), 30), updated_at = now()
   where id = p_id returning * into j;
  return to_jsonb(j);
end;
$$;

/** Counts per channel and status, for the admin console. */
create or replace function public.ws_delivery_counts(p_since timestamptz default now() - interval '7 days')
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_object_agg(channel, by_status), '{}'::jsonb)
    from (select channel, jsonb_object_agg(status, n) as by_status
            from (select channel, status, count(*) as n from public.delivery_jobs
                   where updated_at >= p_since or status in ('pending', 'sending', 'failed', 'dead')
                   group by channel, status) c
           group by channel) x;
$$;

revoke execute on function public.ws_delivery_backoff(int) from public, anon, authenticated;
revoke execute on function public.ws_delivery_enqueue(text, text, text, jsonb, text, text, text, int, text, boolean, timestamptz, int) from public, anon, authenticated;
revoke execute on function public.ws_delivery_claim(int, int, uuid) from public, anon, authenticated;
revoke execute on function public.ws_delivery_result(uuid, int, boolean, text, boolean) from public, anon, authenticated;
revoke execute on function public.ws_delivery_retry(uuid) from public, anon, authenticated;
revoke execute on function public.ws_delivery_counts(timestamptz) from public, anon, authenticated;
grant execute on function public.ws_delivery_backoff(int), public.ws_delivery_enqueue(text, text, text, jsonb, text, text, text, int, text, boolean, timestamptz, int),
  public.ws_delivery_claim(int, int, uuid), public.ws_delivery_result(uuid, int, boolean, text, boolean),
  public.ws_delivery_retry(uuid), public.ws_delivery_counts(timestamptz) to service_role;
grant all on public.delivery_jobs to service_role;

select public.ws_apply_session_gate();

-- Done.
