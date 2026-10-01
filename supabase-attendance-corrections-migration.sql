-- ============================================================================
-- Attendance correction requests (migration 23). Run AFTER
-- supabase-notification-prefs-migration.sql (22). Idempotent; adds one table,
-- two columns on attendance_logs, and the review function.
--
-- An employee asks to fix their own attendance — a punch they forgot, or one
-- the device recorded at the wrong time — with a reason. Their manager (or an
-- administrator, or the admin console) approves or rejects it, once.
--
-- Nothing the device recorded is changed or deleted (F-04):
--   - approving a "missing" request ADDS a punch (source 'correction');
--   - approving a "wrong time" request adds the right punch and marks the
--     wrong one superseded_by it. Every day, report and the pay sheet skip
--     superseded punches (lib/attendance-live.js on the server, a read policy
--     for signed-in people), so attendance and payroll agree; the raw punch,
--     its raw device payload and its emails stay.
-- The request keeps who decided, when, why, and the punch before and after.
-- Nobody approves their own request.
-- ============================================================================

alter table public.attendance_logs add column if not exists superseded_by bigint references public.attendance_logs(id) on delete set null;
alter table public.attendance_logs add column if not exists correction_id uuid;
-- An approved correction is a punch of its own kind.
alter table public.attendance_logs drop constraint if exists attendance_logs_source_ck;
alter table public.attendance_logs add constraint attendance_logs_source_ck
  check (source in ('biometric', 'selfie', 'correction'));
create index if not exists attendance_logs_superseded_idx on public.attendance_logs (superseded_by) where superseded_by is not null;

-- Signed-in people (the attendance page, the clock in the sidebar, an
-- employee's attendance tab) read only the punches that count. The replaced
-- punch is still in the table: the admin console's raw log reads it with the
-- service key, and the request keeps it as "before".
drop policy if exists attendance_logs_live_only on public.attendance_logs;
create policy attendance_logs_live_only on public.attendance_logs as restrictive for select to authenticated
  using (superseded_by is null);

create table if not exists public.attendance_corrections (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  company        text,
  kind           text not null check (kind in ('missing', 'wrong_time')),
  direction      text not null check (direction in ('IN', 'OUT')),
  requested_at   timestamptz not null,               -- when the punch should have been
  work_date      date,                               -- its IST date (filled in)
  log_id         bigint references public.attendance_logs(id) on delete set null,   -- the wrong punch, for wrong_time
  reason         text not null check (length(btrim(reason)) between 5 and 500),
  status         text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by    uuid references public.profiles(id) on delete set null,
  reviewer_label text,
  reviewed_at    timestamptz,
  review_note    text check (review_note is null or length(review_note) <= 500),
  before         jsonb,                              -- the wrong punch as it was
  after          jsonb,                              -- the punch the approval added
  applied_log_id bigint references public.attendance_logs(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists attendance_corrections_user_idx on public.attendance_corrections (user_id, created_at desc);
create index if not exists attendance_corrections_pending_idx on public.attendance_corrections (status, created_at) where status = 'pending';
alter table public.attendance_corrections enable row level security;

-- A request is about the person's own attendance, recent, not in the future,
-- and starts pending; the review columns belong to the review function.
create or replace function public.attendance_corrections_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_log record;
begin
  if tg_op = 'INSERT' and v_role = 'authenticated' then
    new.user_id := auth.uid();
    new.status := 'pending';
    new.reviewed_by := null; new.reviewer_label := null; new.reviewed_at := null; new.review_note := null;
    new.before := null; new.after := null; new.applied_log_id := null;
  end if;
  if new.requested_at > now() + interval '5 minutes' then
    raise exception 'A correction cannot be for a time that has not happened yet' using errcode = '22023';
  end if;
  if tg_op = 'INSERT' and new.requested_at < now() - interval '45 days' then
    raise exception 'Corrections can be asked for up to 45 days back' using errcode = '22023';
  end if;
  new.work_date := (new.requested_at at time zone 'Asia/Kolkata')::date;
  select company into new.company from public.profiles where id = new.user_id;
  if new.kind = 'wrong_time' then
    if new.log_id is null then raise exception 'Choose the punch that is wrong' using errcode = '22023'; end if;
    select id, user_id, superseded_by into v_log from public.attendance_logs where id = new.log_id;
    if v_log.id is null or v_log.user_id is distinct from new.user_id then
      raise exception 'That punch is not yours' using errcode = '42501';
    end if;
    if tg_op = 'INSERT' and v_log.superseded_by is not null then
      raise exception 'That punch was already corrected' using errcode = '22023';
    end if;
  elsif new.log_id is not null then
    raise exception 'Only a wrong-time correction names a punch' using errcode = '22023';
  end if;
  return new;
end;
$$;
drop trigger if exists attendance_corrections_check on public.attendance_corrections;
create trigger attendance_corrections_check before insert or update on public.attendance_corrections
  for each row execute procedure public.attendance_corrections_check();

drop policy if exists attendance_corrections_read on public.attendance_corrections;
create policy attendance_corrections_read on public.attendance_corrections for select to authenticated
  using (user_id = auth.uid() or public.ws_manages(user_id));
drop policy if exists attendance_corrections_ask on public.attendance_corrections;
create policy attendance_corrections_ask on public.attendance_corrections for insert to authenticated
  with check (user_id = auth.uid());
-- A pending request can be withdrawn by its author; decisions only go through the function below.
drop policy if exists attendance_corrections_withdraw on public.attendance_corrections;
create policy attendance_corrections_withdraw on public.attendance_corrections for delete to authenticated
  using (user_id = auth.uid() and status = 'pending');
grant select, insert, delete on public.attendance_corrections to authenticated;

/**
 * Approve or reject a correction, once. A signed-in reviewer must manage the
 * person (their manager, a manager of their company, or an administrator) and
 * may not decide their own request; the admin console calls it with the
 * service key and a reviewer label. Approval adds the punch (and supersedes
 * the wrong one) in the same transaction. Returns the decided request.
 */
create or replace function public.ws_review_attendance_correction(
  p_id uuid, p_approve boolean, p_note text default null, p_reviewer_label text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  c public.attendance_corrections;
  v_log public.attendance_logs;
  v_code text;
  v_new bigint;
  v_t timestamptz;
begin
  select * into c from public.attendance_corrections where id = p_id for update;
  if c.id is null then raise exception 'No such correction request' using errcode = 'P0002'; end if;
  if v_role = 'authenticated' then
    if auth.uid() = c.user_id then raise exception 'Nobody approves their own correction' using errcode = '42501'; end if;
    if not public.ws_manages(c.user_id) then raise exception 'Only their manager or an administrator can decide this' using errcode = '42501'; end if;
  elsif v_role <> 'service_role' and v_role <> '' then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if c.status <> 'pending' then raise exception 'This request was already %', c.status using errcode = '22023'; end if;

  if p_approve then
    if c.kind = 'wrong_time' then
      select * into v_log from public.attendance_logs where id = c.log_id for update;
      if v_log.id is null then raise exception 'The punch to correct no longer exists' using errcode = 'P0002'; end if;
      if v_log.superseded_by is not null then raise exception 'That punch was already corrected' using errcode = '22023'; end if;
    end if;
    select coalesce(nullif(employee_code, ''), 'correction') into v_code from public.profiles where id = c.user_id;
    v_t := c.requested_at;
    insert into public.attendance_logs (user_id, employee_code, direction, direction_derived, log_datetime, log_date, log_time,
                                        device_sn, device_name, source, email_status, correction_id, raw)
    values (c.user_id, coalesce(v_code, 'correction'), c.direction, false, v_t,
            (v_t at time zone 'Asia/Kolkata')::date, (v_t at time zone 'Asia/Kolkata')::time,
            'correction:' || c.id, 'Approved correction', 'correction', 'skipped', c.id,
            jsonb_build_object('correction_id', c.id, 'reason', c.reason))
    returning id into v_new;
    if c.kind = 'wrong_time' then
      update public.attendance_logs set superseded_by = v_new where id = c.log_id;
    end if;
    update public.attendance_corrections set
      status = 'approved', applied_log_id = v_new,
      before = case when c.kind = 'wrong_time' then jsonb_build_object('log_id', v_log.id, 'log_datetime', v_log.log_datetime, 'direction', v_log.direction, 'source', v_log.source) end,
      after = jsonb_build_object('log_id', v_new, 'log_datetime', v_t, 'direction', c.direction)
    where id = c.id;
  else
    update public.attendance_corrections set status = 'rejected' where id = c.id;
  end if;
  update public.attendance_corrections set
    reviewed_by = case when v_role = 'authenticated' then auth.uid() end,
    reviewer_label = coalesce(nullif(btrim(p_reviewer_label), ''), case when v_role = 'authenticated' then null else 'Admin console' end),
    reviewed_at = now(), review_note = nullif(left(btrim(coalesce(p_note, '')), 500), '')
  where id = c.id
  returning * into c;
  if v_role = 'authenticated' then
    perform public.ws_notify(c.user_id, 'attendance.correction', 'Attendance correction ' || c.status,
                             to_char(c.requested_at at time zone 'Asia/Kolkata', 'DD Mon HH24:MI'), '/attendance/', 'attendance_correction', c.id);
  end if;
  return to_jsonb(c);
end;
$$;
revoke execute on function public.ws_review_attendance_correction(uuid, boolean, text, text) from public, anon;
grant execute on function public.ws_review_attendance_correction(uuid, boolean, text, text) to authenticated, service_role;

select public.ws_apply_session_gate();

-- Done.
