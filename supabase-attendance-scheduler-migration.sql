-- ============================================================================
-- The attendance scheduler: the call every 5 minutes that posts the automatic
-- shift-end Logout, the dual-shift Logout/Login switch, and the retries of
-- punches Bitrix did not take.
--
-- Why this file exists: supabase-dual-shift-migration.sql scheduled that call
-- with the literal header "Bearer PASTE-YOUR-BIOMETRIC_API_KEY". Unless
-- someone edited the SQL before running it, every call was refused (401) -
-- and cron.job_run_details still said 'succeeded', because all pg_cron sees
-- is that the request was queued. Nothing about the webhook's answer reaches
-- that table. So no shift-end Logout was ever posted and no dual shift ever
-- switched.
--
-- This is the ONE file to run for those jobs. Run it as-is: there is no key
-- to paste. It
--   * re-states, only where missing, what the jobs need from earlier
--     migrations (profiles.shift2_id / company2 and shift_switch_posts from
--     the dual-shift migration; the attendance_logs bitrix_* columns,
--     attendance_auto_logouts and the bitrix_log kinds from the
--     attendance-bitrix migration), so it works whether or not those ran;
--   * adds attempts to attendance_auto_logouts and shift_switch_posts, so a
--     post Bitrix refused is tried again a few times instead of never;
--   * creates worksuite_scheduler: one row holding a random secret that the
--     scheduled call sends and the webhook checks (reading it with the
--     service key), where the webhook records how each run went, and
--     when the job was last scheduled;
--   * creates worksuite_scheduler_status(), the health check the admin
--     console shows under Admin -> Attendance;
--   * replaces the placeholder job with one that reads the secret from that
--     row at every run.
--
-- Needs the attendance (Step 6) and shift (Step 7) migrations, and a deployed
-- webhook that accepts the secret (until then its calls get 401, and the
-- status below says so). Safe to re-run: the secret is made once and kept,
-- and the job is replaced, never doubled.
--
-- How to check it (a minute or two after running, then any time):
--   select public.worksuite_scheduler_status();
--       "problems": [] means the job exists, reads its key from the table and
--       the webhook has recorded a scheduled run in the last 15 minutes. It
--       only looks at pg_net answers from after this file last scheduled the
--       job (worksuite_scheduler.scheduled_at), so the 401s the old
--       placeholder job collected are not reported against the new one.
--   select status_code, timed_out, error_msg, created
--     from net._http_response order by created desc limit 10;
--       200 is the webhook answering; 401 means the key it got was wrong.
--       Rows from before you ran this file are the old job's.
--   cron.job_run_details on its own is not proof: 'succeeded' there only
--   means the request was queued.
--
-- The site address is in the row, not the job. If WorkSuite moves:
--   update public.worksuite_scheduler set site_url = 'https://your-site.example', updated_at = now() where id = 1;
-- To change the secret (takes effect at the next run, nothing else to edit):
--   update public.worksuite_scheduler
--      set secret = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), updated_at = now()
--    where id = 1;
-- To stop the job:   select cron.unschedule('worksuite-shift-switch');
--
-- Run in Supabase -> SQL Editor.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- From supabase-dual-shift-migration.sql: the second shift, and one row per
-- person per day for the switch so it happens once.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists shift2_id bigint references public.shifts(id) on delete set null,
  add column if not exists company2  text;

create table if not exists public.shift_switch_posts (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  post_date  date not null,
  posted_at  timestamptz,
  first_ok   boolean,
  second_ok  boolean,
  detail     text,
  created_at timestamptz not null default now(),
  primary key (user_id, post_date)
);
alter table public.shift_switch_posts enable row level security;   -- service key only, like salaries

-- ---------------------------------------------------------------------------
-- From supabase-attendance-bitrix-migration.sql: what happened to each punch's
-- group message, and the Logout nobody punched.
-- ---------------------------------------------------------------------------
alter table public.attendance_logs add column if not exists bitrix_status   text;
alter table public.attendance_logs add column if not exists bitrix_error    text;
alter table public.attendance_logs add column if not exists bitrix_at       timestamptz;
alter table public.attendance_logs add column if not exists bitrix_attempts int not null default 0;

alter table public.attendance_logs drop constraint if exists attendance_logs_bitrix_status_ck;
alter table public.attendance_logs add constraint attendance_logs_bitrix_status_ck
  check (bitrix_status is null or bitrix_status in ('sent', 'failed', 'deferred', 'no_group', 'skipped'));

-- What the retry reads every few minutes.
create index if not exists attendance_logs_bitrix_retry_idx
  on public.attendance_logs (log_datetime)
  where bitrix_status in ('failed', 'deferred');

create table if not exists public.attendance_auto_logouts (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  log_date   date not null,
  kind       text not null,
  logout_at  timestamptz not null,
  company    text,
  bitrix_ok  boolean,
  detail     text,
  created_at timestamptz not null default now(),
  primary key (user_id, log_date)
);
alter table public.attendance_auto_logouts drop constraint if exists attendance_auto_logouts_kind_ck;
alter table public.attendance_auto_logouts add constraint attendance_auto_logouts_kind_ck
  check (kind in ('no_punch_out', 'break_not_returned'));

-- Written by the server only; a person may see their own.
alter table public.attendance_auto_logouts enable row level security;
drop policy if exists attendance_auto_logouts_own on public.attendance_auto_logouts;
create policy attendance_auto_logouts_own on public.attendance_auto_logouts
  for select to authenticated using (user_id = auth.uid());

-- The jobs log as 'shift_switch' and 'auto_logout', which the original check
-- refused. bitrix_log comes from supabase-bitrix-log-migration.sql; where that
-- has not been run there is nothing to widen (run this file again after it).
do $$
begin
  if to_regclass('public.bitrix_log') is not null then
    alter table public.bitrix_log drop constraint if exists bitrix_log_kind_ck;
    alter table public.bitrix_log add constraint bitrix_log_kind_ck
      check (kind in ('punch', 'leave', 'test', 'shift_switch', 'auto_logout'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- A post Bitrix refused is tried again on later runs; attempts caps that so a
-- chat that is gone for good is not retried every 5 minutes forever.
-- ---------------------------------------------------------------------------
alter table public.attendance_auto_logouts add column if not exists attempts int not null default 0;
alter table public.shift_switch_posts      add column if not exists attempts int not null default 0;

-- ---------------------------------------------------------------------------
-- The scheduler's own row. The secret is generated here, inside the database,
-- so nobody has to copy a key into SQL; the job sends it and the webhook reads
-- it back with the service key to check the call. Two random UUIDs without
-- their dashes make 64 hex characters without needing pgcrypto.
--
-- The webhook writes last_* after every scheduled call, so "did the last run
-- actually reach WorkSuite, and how did it go?" is answered here rather than
-- by cron.job_run_details, which only knows the request was queued.
-- ---------------------------------------------------------------------------
create table if not exists public.worksuite_scheduler (
  id          smallint primary key default 1 check (id = 1),   -- exactly one row
  secret      text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  site_url    text not null default 'https://work-suite-mauve.vercel.app',
  last_run_at timestamptz,
  last_job    text,
  last_ok     boolean,
  last_result jsonb,
  updated_at  timestamptz not null default now()
);
-- When the job was last (re)scheduled: set by the cron part at the end of
-- this file. The status counts only the pg_net answers that came after it,
-- so a job that was just replaced is not blamed for the old one's refusals.
-- Its own column: updated_at moves with every run the webhook records.
alter table public.worksuite_scheduler add column if not exists scheduled_at timestamptz;
insert into public.worksuite_scheduler (id) values (1) on conflict (id) do nothing;

-- The secret is a credential: no policies, and no grants for browser keys.
-- Only the service key (the webhook, the admin console) and the job itself
-- (it runs as the table's owner) can read it.
alter table public.worksuite_scheduler enable row level security;
revoke all on table public.worksuite_scheduler from public, anon, authenticated;
grant select, insert, update on table public.worksuite_scheduler to service_role;

-- ---------------------------------------------------------------------------
-- worksuite_scheduler_status(): everything needed to tell whether the job is
-- really working, in one call - the job, its last runs, the last HTTP answers
-- and a plain-language list of what is wrong.
--
-- plpgsql, not sql, so it can be created where pg_cron or pg_net are missing
-- (plpgsql resolves cron.* and net.* only when it runs); each read is in its
-- own block that catches any error, so a missing extension, table or grant
-- becomes a line in "problems" and the admin console always gets an answer.
-- ---------------------------------------------------------------------------
create or replace function public.worksuite_scheduler_status()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job      jsonb;
  v_jobid    bigint;
  v_command  text;
  v_active   boolean;
  v_runs     jsonb := '[]'::jsonb;
  v_http     jsonb := '[]'::jsonb;
  v_problems jsonb := '[]'::jsonb;
  v_cron     boolean := exists (select 1 from pg_extension where extname = 'pg_cron');
  v_net      boolean := exists (select 1 from pg_extension where extname = 'pg_net');
  v_row      record;
begin
  if not v_cron then
    v_problems := v_problems || to_jsonb('pg_cron is not installed: run supabase-attendance-scheduler-migration.sql in the Supabase SQL editor'::text);
  end if;
  if not v_net then
    v_problems := v_problems || to_jsonb('pg_net is not installed: run supabase-attendance-scheduler-migration.sql in the Supabase SQL editor'::text);
  end if;

  -- The job. Read even when pg_extension does not list pg_cron, so a cron
  -- schema that is there anyway is still reported on; a missing one is only
  -- worth a line of its own when pg_cron claims to be installed.
  begin
    select j.jobid, j.command, j.active,
           jsonb_build_object('jobname', j.jobname, 'schedule', j.schedule, 'active', j.active,
                              'uses_db_secret', position('worksuite_scheduler' in j.command) > 0)
      into v_jobid, v_command, v_active, v_job
      from cron.job j
     where j.jobname = 'worksuite-shift-switch'
     order by j.jobid desc
     limit 1;
    if v_job is null then
      v_problems := v_problems || to_jsonb('no worksuite-shift-switch job: run supabase-attendance-scheduler-migration.sql'::text);
    else
      if position('PASTE-YOUR' in v_command) > 0 then
        v_problems := v_problems || to_jsonb('the job still sends the pasted placeholder key, so the webhook refuses every call: run supabase-attendance-scheduler-migration.sql'::text);
      end if;
      if v_active is false then
        v_problems := v_problems || to_jsonb('the worksuite-shift-switch job is paused (active = false)'::text);
      end if;
    end if;
  exception when others then
    v_job := null;
    if v_cron then
      v_problems := v_problems || to_jsonb(('cannot read cron.job: ' || sqlerrm)::text);
    end if;
  end;

  -- Its last runs. 'succeeded' here only means the request was queued.
  if v_jobid is not null then
    begin
      select coalesce(jsonb_agg(jsonb_build_object('status', r.status, 'start_time', r.start_time,
                                                   'return_message', r.return_message)
                                order by r.start_time desc), '[]'::jsonb)
        into v_runs
        from (select d.status, d.start_time, d.return_message
                from cron.job_run_details d
               where d.jobid = v_jobid
               order by d.start_time desc
               limit 5) r;
      if v_runs -> 0 ->> 'status' = 'failed' then
        v_problems := v_problems || to_jsonb(('the last run of the job failed in the database: ' || coalesce(v_runs -> 0 ->> 'return_message', ''))::text);
      end if;
    exception when others then
      v_runs := '[]'::jsonb;
      v_problems := v_problems || to_jsonb(('cannot read cron.job_run_details: ' || sqlerrm)::text);
    end;
  end if;

  -- What came back. pg_net keeps its responses for a few hours and does not
  -- record the URL, so these are the most recent calls of any pg_net job -
  -- but none from before the job was last scheduled (scheduled_at): those
  -- answered the job it replaced, such as the placeholder that got 401s.
  begin
    select coalesce(jsonb_agg(jsonb_build_object('status_code', h.status_code, 'timed_out', h.timed_out,
                                                 'error_msg', h.error_msg, 'created', h.created,
                                                 'content', left(h.content, 200))
                              order by h.created desc), '[]'::jsonb)
      into v_http
      from (select x.status_code, x.timed_out, x.error_msg, x.created, x.content::text as content
              from net._http_response x
             where x.created >= coalesce((select w.scheduled_at from public.worksuite_scheduler w where w.id = 1),
                                         '-infinity'::timestamptz)
             order by x.created desc
             limit 10) h;
    if v_http -> 0 ->> 'status_code' = '401' then
      v_problems := v_problems || to_jsonb('the most recent pg_net call was refused (401): the key it sent is not one the webhook accepts'::text);
    elsif (v_http -> 0 ->> 'timed_out')::boolean then
      v_problems := v_problems || to_jsonb('the most recent pg_net call timed out before the webhook answered'::text);
    elsif v_http -> 0 ->> 'error_msg' is not null then
      v_problems := v_problems || to_jsonb(('the most recent pg_net call failed: ' || (v_http -> 0 ->> 'error_msg'))::text);
    end if;
  exception when others then
    v_http := '[]'::jsonb;
    if v_net then
      v_problems := v_problems || to_jsonb(('cannot read net._http_response: ' || sqlerrm)::text);
    end if;
  end;

  -- The proof that counts: the webhook itself recorded a scheduled run.
  begin
    select * into v_row from public.worksuite_scheduler where id = 1;
    if not found then
      v_problems := v_problems || to_jsonb('worksuite_scheduler has no row: run supabase-attendance-scheduler-migration.sql again'::text);
    elsif v_job is not null then
      if v_row.last_run_at is null then
        v_problems := v_problems || to_jsonb('no scheduled run has reached the webhook yet (the job runs every 5 minutes)'::text);
      elsif v_row.last_run_at < now() - interval '15 minutes' then
        v_problems := v_problems || to_jsonb(('no scheduled run has reached the webhook since '
          || to_char(v_row.last_run_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') || ' IST')::text);
      elsif v_row.last_ok is false then
        v_problems := v_problems || to_jsonb('the last scheduled run reached the webhook but did not finish cleanly: see worksuite_scheduler.last_result'::text);
      end if;
    end if;
  exception when others then
    v_problems := v_problems || to_jsonb(('cannot read worksuite_scheduler: ' || sqlerrm)::text);
  end;

  return jsonb_build_object('job', v_job, 'runs', v_runs, 'http', v_http, 'problems', v_problems);
end;
$$;

-- It shows the job's command and recent responses: the service key only.
revoke all on function public.worksuite_scheduler_status() from public, anon, authenticated;
grant execute on function public.worksuite_scheduler_status() to service_role;

-- ---------------------------------------------------------------------------
-- The job. pg_cron + pg_net exist on the hosted database only; everything
-- above works without them. Every 5 minutes is safe: each switch and each
-- automatic Logout happens once per person per day.
--
-- The job does not contain the secret. It reads the row at every run, so a
-- new secret or site_url applies from the next run on.
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Replaces the placeholder job the dual-shift migration made (and this job,
-- on a re-run), so there is only ever one.
select cron.unschedule(jobid) from cron.job where jobname = 'worksuite-shift-switch';
select cron.schedule(
  'worksuite-shift-switch',
  '*/5 * * * *',
  $job$
  select net.http_post(
    url                  := s.site_url || '/api/attendance-webhook?job=shift_switch',
    headers              := jsonb_build_object('Content-Type', 'application/json',
                                               'Authorization', 'Bearer ' || s.secret),
    body                 := '{}'::jsonb,
    timeout_milliseconds := 30000)
  from public.worksuite_scheduler s where s.id = 1;
  $job$
);
-- From now on the answers are this job's: the status leaves out older ones.
update public.worksuite_scheduler set scheduled_at = now() where id = 1;

-- Shown in the SQL editor as the result: the job, with no answers yet (the
-- old job's are older than scheduled_at and left out) and, unless a
-- scheduled run has reached the webhook before, "no scheduled run has
-- reached the webhook yet" until the first one does, within 5 minutes.
select public.worksuite_scheduler_status();
