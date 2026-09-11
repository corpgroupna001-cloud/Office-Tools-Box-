-- ============================================================================
-- Server-side reminders for the CRM & work modules.
--
-- Run FIFTH of the CRM set, after supabase-messenger-migration.sql.
-- Idempotent; adds only.
--
-- One function, crm_run_reminders(), turns due work into in-app notifications
-- whether or not anybody has WorkSuite open:
--   task.reminder    a task's reminder time has passed (assignee)
--   event.reminder   a meeting starts within its reminder window (organiser +
--                    everyone who has not declined)
--   lead.follow_up   a lead's follow-up time has passed (owner)
--   task.digest      once a day from 09:00 IST: "N due today, M overdue"
--   invoice.overdue  a sent invoice passed its due date: the status flips to
--                    overdue and whoever raised it is told once
-- crm_reminder_log remembers what has fired, so every reminder fires once
-- no matter how often the function runs.
--
-- How it runs:
--   * every 5 minutes inside the database via pg_cron, when the extension
--     is available (Supabase has it; nothing else to configure), and
--   * twice a day from the existing /api/wfh-remind cron, which also pushes
--     these notifications to phones and laptops (Web Push) — so no new
--     serverless function and no new cron slot.
-- ============================================================================

-- Push bookkeeping: /api/wfh-remind pushes reminder notifications once.
alter table public.notifications add column if not exists pushed_at timestamptz;
create index if not exists notifications_push_queue_idx
  on public.notifications (created_at) where pushed_at is null;

create table if not exists public.crm_reminder_log (
  kind       text not null,
  entity_id  uuid not null,
  user_id    uuid not null,
  fire_key   text not null,        -- what the reminder was for (a timestamp or a date), so a reschedule fires again
  created_at timestamptz not null default now(),
  primary key (kind, entity_id, user_id, fire_key)
);
create index if not exists crm_reminder_log_created_idx on public.crm_reminder_log (created_at);
-- Written only by the definer functions below; nobody reads it from the browser.
alter table public.crm_reminder_log enable row level security;

/** True the first time a (kind, record, person, key) is seen; false on every later call. */
create or replace function public.crm_remind_once(p_kind text, p_entity uuid, p_user uuid, p_key text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  insert into public.crm_reminder_log (kind, entity_id, user_id, fire_key)
  values (p_kind, p_entity, p_user, p_key)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

create or replace function public.crm_run_reminders(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_local   timestamp := p_now at time zone 'Asia/Kolkata';
  v_today   date      := (p_now at time zone 'Asia/Kolkata')::date;
  r         record;
  v_user    uuid;
  n_task    int := 0;
  n_event   int := 0;
  n_lead    int := 0;
  n_digest  int := 0;
  n_invoice int := 0;
begin
  -- 1) Task reminders (the editor stores reminder_at; only the last day is considered
  --    so a newly installed job does not replay months of old reminders).
  for r in
    select t.id, t.title, t.assignee_id, t.reminder_at, t.due_date
      from public.tasks t
      join public.profiles p on p.id = t.assignee_id and coalesce(p.status, 'active') <> 'inactive'
     where t.reminder_at is not null
       and t.reminder_at <= p_now and t.reminder_at > p_now - interval '1 day'
       and t.completed_at is null and t.archived_at is null
  loop
    if public.crm_remind_once('task.reminder', r.id, r.assignee_id, r.reminder_at::text) then
      perform public.ws_notify(r.assignee_id, 'task.reminder', left('Reminder: ' || r.title, 140),
        case when r.due_date is null then null else 'Due ' || to_char(r.due_date, 'FMDD Mon YYYY') end,
        '/tasks/?id=' || r.id, 'task', r.id);
      n_task := n_task + 1;
    end if;
  end loop;

  -- 2) Meeting reminders: inside the reminder window, before the start.
  for r in
    select e.id, e.title, e.starts_at, e.owner_id
      from public.calendar_events e
     where e.status = 'scheduled' and e.reminder_minutes is not null
       and e.starts_at > p_now
       and e.starts_at - make_interval(mins => e.reminder_minutes) <= p_now
  loop
    for v_user in
      select r.owner_id where r.owner_id is not null
      union
      select x.user_id from public.event_participants x where x.event_id = r.id and x.response <> 'declined'
    loop
      if public.crm_remind_once('event.reminder', r.id, v_user, r.starts_at::text) then
        perform public.ws_notify(v_user, 'event.reminder',
          left('At ' || to_char(r.starts_at at time zone 'Asia/Kolkata', 'FMHH12:MI am') || ': ' || r.title, 140),
          to_char(r.starts_at at time zone 'Asia/Kolkata', 'FMDay, FMDD Mon') || ' (IST)',
          '/calendar/?id=' || r.id, 'event', r.id);
        n_event := n_event + 1;
      end if;
    end loop;
  end loop;

  -- 3) Lead follow-ups that have come due (open leads only).
  for r in
    select l.id, l.name, l.owner_id, l.next_follow_up_at, l.organization
      from public.crm_leads l
      left join public.crm_lead_statuses s on s.key = l.status
     where l.next_follow_up_at is not null
       and l.next_follow_up_at <= p_now and l.next_follow_up_at > p_now - interval '1 day'
       and l.owner_id is not null and l.archived_at is null
       and not coalesce(s.is_closed, false)
  loop
    if public.crm_remind_once('lead.follow_up', r.id, r.owner_id, r.next_follow_up_at::text) then
      perform public.ws_notify(r.owner_id, 'lead.follow_up', left('Follow up: ' || r.name, 140),
        r.organization, '/leads/?id=' || r.id, 'lead', r.id);
      n_lead := n_lead + 1;
    end if;
  end loop;

  -- 4) One daily digest per person from 09:00 IST, only when something is due.
  if extract(hour from v_local) >= 9 then
    for r in
      select t.assignee_id as uid,
             count(*) filter (where t.due_date = v_today)::int as due_today,
             count(*) filter (where t.due_date < v_today)::int as overdue
        from public.tasks t
        join public.profiles p on p.id = t.assignee_id and coalesce(p.status, 'active') <> 'inactive'
       where t.completed_at is null and t.archived_at is null and t.due_date <= v_today
       group by t.assignee_id
    loop
      if public.crm_remind_once('task.digest', r.uid, r.uid, v_today::text) then
        perform public.ws_notify(r.uid, 'task.digest',
          concat_ws(', ',
            case when r.due_today > 0 then r.due_today || ' task' || case when r.due_today = 1 then '' else 's' end || ' due today' end,
            case when r.overdue > 0 then r.overdue || ' overdue' end),
          'Open My Tasks to plan the day.', '/tasks/?view=mine', 'task', null);
        n_digest := n_digest + 1;
      end if;
    end loop;
  end if;

  -- 5) Sent invoices past their due date read as overdue, and the person who raised
  --    each one hears about it once. (Partly paid invoices keep that status.)
  for r in
    select i.id, i.invoice_number, i.created_by, i.due_date, i.balance, i.currency
      from public.invoices i
     where i.status = 'sent' and i.due_date is not null and i.due_date < v_today
  loop
    perform public.invoice_recalc(r.id);
    if r.created_by is not null and public.crm_remind_once('invoice.overdue', r.id, r.created_by, r.due_date::text) then
      perform public.ws_notify(r.created_by, 'invoice.overdue', left('Invoice ' || r.invoice_number || ' is overdue', 140),
        'Due ' || to_char(r.due_date, 'FMDD Mon YYYY') || ' · balance ' || r.currency || ' ' || to_char(r.balance, 'FM999,999,999,990.00'),
        '/invoices/?id=' || r.id, 'invoice', r.id);
      n_invoice := n_invoice + 1;
    end if;
  end loop;

  -- Keep the log small: anything older than 60 days can never fire again.
  delete from public.crm_reminder_log where created_at < p_now - interval '60 days';

  return jsonb_build_object('tasks', n_task, 'events', n_event, 'leads', n_lead,
                            'digests', n_digest, 'invoices', n_invoice, 'at', p_now);
end;
$$;

-- Only the service (cron, /api/wfh-remind) may run these; an employee calling
-- them through the REST API would just fire reminders early for everyone.
revoke all on function public.crm_run_reminders(timestamptz) from public, anon, authenticated;
revoke all on function public.crm_remind_once(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.crm_run_reminders(timestamptz) to service_role;
grant execute on function public.crm_remind_once(text, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Schedule: every 5 minutes inside the database when pg_cron is available.
-- Without it, /api/wfh-remind still runs crm_run_reminders() twice a day.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.unschedule(jobid) from cron.job where jobname = 'worksuite-crm-reminders';
    perform cron.schedule('worksuite-crm-reminders', '*/5 * * * *', 'select public.crm_run_reminders()');
  else
    raise notice 'pg_cron is not available here: reminders will be generated by /api/wfh-remind twice a day.';
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- OPTIONAL — push reminders to devices within minutes instead of twice a day.
-- Needs pg_net and the MAIL_API_KEY already set in Vercel. Paste the key in
-- place of PASTE-YOUR-MAIL_API_KEY and run this block on its own:
--
--   create extension if not exists pg_net;
--   select cron.unschedule(jobid) from cron.job where jobname = 'worksuite-crm-push';
--   select cron.schedule('worksuite-crm-push', '*/5 * * * *', $job$
--     select net.http_post(
--       url     := 'https://work-suite-mauve.vercel.app/api/wfh-remind?job=crm',
--       headers := '{"Content-Type":"application/json","x-worksuite-mail-key":"PASTE-YOUR-MAIL_API_KEY"}'::jsonb,
--       body    := '{}'::jsonb);
--   $job$);
--
-- To check:  select * from cron.job_run_details order by start_time desc limit 10;
-- To stop:   select cron.unschedule('worksuite-crm-push');
-- ---------------------------------------------------------------------------

-- Done.
