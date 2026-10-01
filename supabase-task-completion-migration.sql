-- ============================================================================
-- Task status summary, enforced (migration 20). Run AFTER
-- supabase-crm-summary-migration.sql (19). Idempotent; adds two columns and
-- two triggers.
--
-- Migration 13 added tasks.result_required ("Task status summary is
-- required"), but only the single-task Complete button asked for one: bulk
-- Complete, dragging to a done column, the task editor and any direct API
-- update completed such a task with no summary (BUG-05).
--
-- Now the summary is part of the task row (result_summary) and the database
-- checks it on every way in: a task that requires one cannot become completed
-- (whatever sets the status — the status itself, or a board column mapped to
-- a done status) unless the same update carries a summary. The summary is
-- then posted as the task's comment in the same transaction. Reopening clears
-- it, so the next completion asks again. The service key (server jobs, data
-- repair) is not held to it.
-- ============================================================================

alter table public.tasks add column if not exists result_summary text;
alter table public.tasks add column if not exists result_by uuid references public.profiles(id) on delete set null;
alter table public.tasks drop constraint if exists tasks_result_summary_len_ck;
alter table public.tasks add constraint tasks_result_summary_len_ck check (result_summary is null or length(result_summary) <= 5000);

-- Runs after tasks_rules (triggers fire in name order), so completed_at already
-- follows the status and any board-column mapping.
create or replace function public.tasks_summary_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_completing boolean := new.completed_at is not null and (tg_op = 'INSERT' or old.completed_at is null);
begin
  new.result_summary := nullif(btrim(coalesce(new.result_summary, '')), '');
  if tg_op = 'UPDATE' and new.completed_at is null and old.completed_at is not null then
    new.result_summary := null;                                   -- reopened: the next completion needs a new summary
    new.result_by := null;
    return new;
  end if;
  if v_completing and new.result_required and v_role <> 'service_role' and v_role <> ''
     and (new.result_summary is null or (tg_op = 'UPDATE' and new.result_summary is not distinct from old.result_summary)) then
    raise exception 'This task needs a status summary before it is completed'
      using errcode = 'P0001', hint = 'task_summary_required';
  end if;
  if v_completing and new.result_summary is not null then
    new.result_by := coalesce(auth.uid(), new.result_by);
  end if;
  return new;
end;
$$;
drop trigger if exists tasks_summary_guard on public.tasks;
create trigger tasks_summary_guard before insert or update on public.tasks
  for each row execute procedure public.tasks_summary_guard();

-- The summary also goes on the task's timeline, written in the same transaction.
create or replace function public.tasks_summary_comment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.completed_at is not null and new.result_summary is not null
     and (tg_op = 'INSERT' or old.completed_at is null or new.result_summary is distinct from old.result_summary) then
    insert into public.comments (entity_type, entity_id, body, mentions, author_id)
    values ('task', new.id, 'Task status summary:' || chr(10) || new.result_summary, '{}', coalesce(auth.uid(), new.result_by, new.created_by));
  end if;
  return null;
end;
$$;
drop trigger if exists tasks_summary_comment on public.tasks;
create trigger tasks_summary_comment after insert or update of status, completed_at, result_summary, board_column_id on public.tasks
  for each row execute procedure public.tasks_summary_comment();

select public.ws_apply_session_gate();

-- Done.
