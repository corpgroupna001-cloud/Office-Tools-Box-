-- ============================================================================
-- Work modules: projects, boards, tasks, comments, documents, calendar.
--
-- Run SECOND of the CRM set, after supabase-crm-foundation-migration.sql
-- (it relies on ws_same_company / ws_is_manager / crm_log / ws_notify).
-- Idempotent; adds only. Nothing existing is dropped or truncated.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Task statuses (a table so a new status needs no migration)
-- ---------------------------------------------------------------------------
create table if not exists public.task_statuses (
  key        text primary key,
  label      text not null,
  sort_order int not null default 0,
  is_done    boolean not null default false,
  color      text
);

insert into public.task_statuses (key, label, sort_order, is_done, color) values
  ('todo',        'To Do',       1, false, 'weekoff'),
  ('in_progress', 'In Progress', 2, false, 'pending'),
  ('blocked',     'Blocked',     3, false, 'absent'),
  ('review',      'Review',      4, false, 'late'),
  ('completed',   'Completed',   5, true,  'present')
on conflict (key) do nothing;

alter table public.task_statuses enable row level security;
drop policy if exists task_statuses_read on public.task_statuses;
create policy task_statuses_read on public.task_statuses for select to authenticated using (true);
drop policy if exists task_statuses_manage on public.task_statuses;
create policy task_statuses_manage on public.task_statuses for all to authenticated
  using ((select public.ws_is_admin())) with check ((select public.ws_is_admin()));

-- ---------------------------------------------------------------------------
-- 2) Boards (a reusable Kanban surface: columns + cards, where a card is a task)
-- ---------------------------------------------------------------------------
create table if not exists public.boards (
  id          uuid primary key default gen_random_uuid(),
  company     text,
  name        text not null,
  description text,
  kind        text not null default 'custom',        -- custom | project | tasks
  project_id  uuid,                                  -- FK added once projects exists
  archived_at timestamptz,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.boards drop constraint if exists boards_kind_ck;
alter table public.boards add constraint boards_kind_ck check (kind in ('custom', 'project', 'tasks'));

create table if not exists public.board_columns (
  id              uuid primary key default gen_random_uuid(),
  board_id        uuid not null references public.boards(id) on delete cascade,
  name            text not null,
  position        int not null default 0,
  -- Dropping a card into this column also sets the task's status (optional).
  maps_to_status  text references public.task_statuses(key) on delete set null,
  color           text,
  wip_limit       int,
  created_at      timestamptz not null default now()
);

create index if not exists boards_company_idx on public.boards (company) where archived_at is null;
create index if not exists board_columns_board_idx on public.board_columns (board_id, position);

-- ---------------------------------------------------------------------------
-- 3) Projects
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
  id            uuid primary key default gen_random_uuid(),
  company       text,
  name          text not null,
  description   text,
  owner_id      uuid references public.profiles(id) on delete set null,
  manager_id    uuid references public.profiles(id) on delete set null,   -- project manager
  status        text not null default 'planning',
  priority      text not null default 'normal',
  start_date    date,
  due_date      date,
  completed_at  date,
  contact_id    uuid references public.crm_contacts(id) on delete set null,
  deal_id       uuid references public.crm_deals(id) on delete set null,
  board_id      uuid references public.boards(id) on delete set null,      -- the project's own board
  tags          text[] not null default '{}',
  archived_at   timestamptz,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.projects drop constraint if exists projects_status_ck;
alter table public.projects add constraint projects_status_ck
  check (status in ('planning', 'active', 'on_hold', 'completed', 'cancelled'));
alter table public.projects drop constraint if exists projects_priority_ck;
alter table public.projects add constraint projects_priority_ck
  check (priority in ('low', 'normal', 'high', 'urgent'));
alter table public.projects drop constraint if exists projects_dates_ck;
alter table public.projects add constraint projects_dates_ck
  check (start_date is null or due_date is null or due_date >= start_date);

create index if not exists projects_company_idx on public.projects (company, status);
create index if not exists projects_owner_idx   on public.projects (owner_id);
create index if not exists projects_manager_idx on public.projects (manager_id);
create index if not exists projects_deal_idx    on public.projects (deal_id) where deal_id is not null;
create index if not exists projects_contact_idx on public.projects (contact_id) where contact_id is not null;
create index if not exists projects_due_idx     on public.projects (due_date) where status in ('planning', 'active');
create index if not exists projects_name_idx    on public.projects (lower(name));

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'boards_project_fk') then
    alter table public.boards add constraint boards_project_fk
      foreign key (project_id) references public.projects(id) on delete cascade;
  end if;
end$$;
create index if not exists boards_project_idx on public.boards (project_id) where project_id is not null;

create table if not exists public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       text not null default 'member',
  added_by   uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
alter table public.project_members drop constraint if exists project_members_role_ck;
alter table public.project_members add constraint project_members_role_ck check (role in ('member', 'manager'));
create index if not exists project_members_user_idx on public.project_members (user_id);

/** True when the caller is on the project (owner, project manager or member). */
create or replace function public.ws_on_project(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_project is not null and exists (
    select 1 from public.projects p
     where p.id = p_project
       and (p.owner_id = auth.uid() or p.manager_id = auth.uid()
            or exists (select 1 from public.project_members m where m.project_id = p.id and m.user_id = auth.uid())));
$$;
grant execute on function public.ws_on_project(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Tasks (also the cards on every board)
-- ---------------------------------------------------------------------------
create table if not exists public.tasks (
  id               uuid primary key default gen_random_uuid(),
  company          text,
  title            text not null,
  description      text,
  status           text not null default 'todo' references public.task_statuses(key),
  priority         text not null default 'normal',
  assignee_id      uuid references public.profiles(id) on delete set null,
  project_id       uuid references public.projects(id) on delete set null,
  board_id         uuid references public.boards(id) on delete set null,
  board_column_id  uuid references public.board_columns(id) on delete set null,
  position         numeric not null default 0,
  parent_task_id   uuid references public.tasks(id) on delete cascade,      -- subtasks
  contact_id       uuid references public.crm_contacts(id) on delete set null,
  lead_id          uuid references public.crm_leads(id) on delete set null,
  deal_id          uuid references public.crm_deals(id) on delete set null,
  start_date       date,
  due_date         date,
  due_time         time,
  reminder_at      timestamptz,
  completed_at     timestamptz,
  estimate_hours   numeric(8,2),
  tags             text[] not null default '{}',
  archived_at      timestamptz,
  created_by       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.tasks drop constraint if exists tasks_priority_ck;
alter table public.tasks add constraint tasks_priority_ck check (priority in ('low', 'normal', 'high', 'urgent'));
alter table public.tasks drop constraint if exists tasks_estimate_ck;
alter table public.tasks add constraint tasks_estimate_ck check (estimate_hours is null or estimate_hours >= 0);

create index if not exists tasks_company_idx   on public.tasks (company, status) where archived_at is null;
create index if not exists tasks_assignee_idx  on public.tasks (assignee_id, status) where archived_at is null;
create index if not exists tasks_creator_idx   on public.tasks (created_by);
create index if not exists tasks_project_idx   on public.tasks (project_id) where project_id is not null;
create index if not exists tasks_board_idx     on public.tasks (board_id, board_column_id, position) where board_id is not null;
create index if not exists tasks_parent_idx    on public.tasks (parent_task_id) where parent_task_id is not null;
create index if not exists tasks_due_idx       on public.tasks (due_date) where due_date is not null and archived_at is null;
create index if not exists tasks_contact_idx   on public.tasks (contact_id) where contact_id is not null;
create index if not exists tasks_lead_idx      on public.tasks (lead_id) where lead_id is not null;
create index if not exists tasks_deal_idx      on public.tasks (deal_id) where deal_id is not null;
create index if not exists tasks_title_idx     on public.tasks (lower(title));

create table if not exists public.task_assignees (
  task_id    uuid not null references public.tasks(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  added_by   uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (task_id, user_id)
);
create index if not exists task_assignees_user_idx on public.task_assignees (user_id);

create table if not exists public.task_watchers (
  task_id    uuid not null references public.tasks(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, user_id)
);
create index if not exists task_watchers_user_idx on public.task_watchers (user_id);

/** True when the caller may edit a task: creator, assignee, extra assignee, on its project, or a manager. */
create or replace function public.ws_can_edit_task(p_task uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.tasks t
     where t.id = p_task
       and public.ws_same_company(t.company)
       and (t.created_by = auth.uid() or t.assignee_id = auth.uid()
            or public.ws_is_manager()
            or public.ws_on_project(t.project_id)
            or exists (select 1 from public.task_assignees a where a.task_id = t.id and a.user_id = auth.uid())));
$$;
grant execute on function public.ws_can_edit_task(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Comments / notes, shared by every record type
-- ---------------------------------------------------------------------------
create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  company     text,
  entity_type text not null,      -- task | project | contact | lead | deal | board | invoice | document
  entity_id   uuid not null,
  author_id   uuid references public.profiles(id) on delete set null,
  body        text not null,
  mentions    uuid[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists comments_entity_idx on public.comments (entity_type, entity_id, created_at);
create index if not exists comments_author_idx on public.comments (author_id);

-- ---------------------------------------------------------------------------
-- 6) Documents: one file, many links
-- ---------------------------------------------------------------------------
create table if not exists public.document_folders (
  id         uuid primary key default gen_random_uuid(),
  company    text,
  name       text not null,
  parent_id  uuid references public.document_folders(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists document_folders_company_idx on public.document_folders (company, parent_id);

create table if not exists public.documents (
  id            uuid primary key default gen_random_uuid(),
  company       text,
  name          text not null,                          -- display name (rename edits this, not the file)
  original_name text,
  bucket        text not null default 'documents',
  storage_path  text not null unique,                   -- {uploader uid}/{uuid}-{safe name}
  mime_type     text,
  size_bytes    bigint,
  sha256        text,                                   -- browser-computed, used to detect the same file uploaded twice
  folder_id     uuid references public.document_folders(id) on delete set null,
  description   text,
  archived_at   timestamptz,
  created_by    uuid references public.profiles(id) on delete set null,   -- uploader
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.documents drop constraint if exists documents_size_ck;
alter table public.documents add constraint documents_size_ck check (size_bytes is null or (size_bytes >= 0 and size_bytes <= 52428800));

create index if not exists documents_company_idx on public.documents (company, created_at desc) where archived_at is null;
create index if not exists documents_folder_idx  on public.documents (folder_id);
create index if not exists documents_owner_idx   on public.documents (created_by);
create index if not exists documents_name_idx    on public.documents (lower(name));
create index if not exists documents_sha_idx     on public.documents (company, sha256) where sha256 is not null;

create table if not exists public.document_links (
  document_id uuid not null references public.documents(id) on delete cascade,
  entity_type text not null,      -- project | task | contact | lead | deal | invoice | event
  entity_id   uuid not null,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (document_id, entity_type, entity_id)
);
create index if not exists document_links_entity_idx on public.document_links (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- 7) Calendar
-- ---------------------------------------------------------------------------
create table if not exists public.calendar_events (
  id               uuid primary key default gen_random_uuid(),
  company          text,
  title            text not null,
  description      text,
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  all_day          boolean not null default false,
  owner_id         uuid references public.profiles(id) on delete set null,
  location         text,
  meeting_link     text,
  contact_id       uuid references public.crm_contacts(id) on delete set null,
  lead_id          uuid references public.crm_leads(id) on delete set null,
  deal_id          uuid references public.crm_deals(id) on delete set null,
  project_id       uuid references public.projects(id) on delete set null,
  event_type       text not null default 'meeting',
  reminder_minutes int,
  visibility       text not null default 'company',   -- company | private (owner + participants only)
  status           text not null default 'scheduled',
  created_by       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
alter table public.calendar_events drop constraint if exists calendar_events_range_ck;
alter table public.calendar_events add constraint calendar_events_range_ck check (ends_at >= starts_at);
alter table public.calendar_events drop constraint if exists calendar_events_type_ck;
alter table public.calendar_events add constraint calendar_events_type_ck
  check (event_type in ('meeting', 'call', 'follow_up', 'deadline', 'reminder', 'other'));
alter table public.calendar_events drop constraint if exists calendar_events_visibility_ck;
alter table public.calendar_events add constraint calendar_events_visibility_ck check (visibility in ('company', 'private'));
alter table public.calendar_events drop constraint if exists calendar_events_status_ck;
alter table public.calendar_events add constraint calendar_events_status_ck check (status in ('scheduled', 'cancelled'));

create index if not exists calendar_events_company_idx on public.calendar_events (company, starts_at);
create index if not exists calendar_events_owner_idx   on public.calendar_events (owner_id, starts_at);
create index if not exists calendar_events_contact_idx on public.calendar_events (contact_id) where contact_id is not null;
create index if not exists calendar_events_lead_idx    on public.calendar_events (lead_id) where lead_id is not null;
create index if not exists calendar_events_deal_idx    on public.calendar_events (deal_id) where deal_id is not null;
create index if not exists calendar_events_project_idx on public.calendar_events (project_id) where project_id is not null;

create table if not exists public.event_participants (
  event_id   uuid not null references public.calendar_events(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  response   text not null default 'invited',
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
alter table public.event_participants drop constraint if exists event_participants_response_ck;
alter table public.event_participants add constraint event_participants_response_ck
  check (response in ('invited', 'accepted', 'declined', 'tentative'));
create index if not exists event_participants_user_idx on public.event_participants (user_id);

/** True when the caller may see an event. */
create or replace function public.ws_can_see_event(p_event uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.calendar_events e
     where e.id = p_event
       and (e.owner_id = auth.uid() or e.created_by = auth.uid()
            or exists (select 1 from public.event_participants x where x.event_id = e.id and x.user_id = auth.uid())
            or (e.visibility = 'company' and public.ws_same_company(e.company))
            or public.ws_is_admin()));
$$;
grant execute on function public.ws_can_see_event(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8) Bookkeeping triggers (created_by / company / updated_at)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['boards', 'projects', 'tasks', 'comments', 'document_folders', 'documents', 'calendar_events']
  loop
    execute format('drop trigger if exists %I_fill on public.%I', t, t);
    execute format('create trigger %I_fill before insert on public.%I for each row execute procedure public.ws_fill_owner_cols()', t, t);
  end loop;
  foreach t in array array['boards', 'projects', 'tasks', 'comments', 'documents', 'calendar_events']
  loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I for each row execute procedure public.ws_touch_updated_at()', t, t);
  end loop;
end$$;

-- comments.created_by does not exist; author_id is the equivalent.
create or replace function public.ws_fill_comment_cols()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.author_id is null then new.author_id := auth.uid(); end if;
  if new.company is null then new.company := public.ws_company(); end if;
  return new;
end;
$$;
drop trigger if exists comments_fill on public.comments;
create trigger comments_fill before insert on public.comments
  for each row execute procedure public.ws_fill_comment_cols();

-- ---------------------------------------------------------------------------
-- 9) Business rules + history + notifications
-- ---------------------------------------------------------------------------

-- Tasks: completed_at follows the status; board columns can set the status;
-- history and assignee notifications are written here.
create or replace function public.tasks_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_done boolean;
  v_col_status text;
begin
  -- A card dropped into a column that maps to a status takes that status.
  if new.board_column_id is not null and (tg_op = 'INSERT' or new.board_column_id is distinct from old.board_column_id) then
    select maps_to_status into v_col_status from public.board_columns where id = new.board_column_id;
    if v_col_status is not null then new.status := v_col_status; end if;
  end if;
  select is_done into v_done from public.task_statuses where key = new.status;
  if coalesce(v_done, false) then
    if new.completed_at is null then new.completed_at := now(); end if;
  else
    new.completed_at := null;
  end if;
  -- Inherit the project's company when the task was created from inside a project.
  if new.company is null and new.project_id is not null then
    select company into new.company from public.projects where id = new.project_id;
  end if;
  return new;
end;
$$;
drop trigger if exists tasks_rules on public.tasks;
create trigger tasks_rules before insert or update on public.tasks
  for each row execute procedure public.tasks_before_write();

create or replace function public.tasks_after_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text := '/tasks/?id=' || new.id;
begin
  if tg_op = 'INSERT' then
    perform public.crm_log('task.created', 'task', new.id, new.title,
      jsonb_build_object('status', new.status, 'priority', new.priority, 'due_date', new.due_date),
      new.company, new.contact_id, new.lead_id, new.deal_id, new.project_id);
    if new.assignee_id is not null then
      perform public.ws_notify(new.assignee_id, 'task.assigned', 'Task assigned to you', new.title, v_url, 'task', new.id);
    end if;
    return new;
  end if;

  if new.assignee_id is distinct from old.assignee_id then
    perform public.crm_log('task.assigned', 'task', new.id, new.title,
      jsonb_build_object('from', old.assignee_id, 'to', new.assignee_id),
      new.company, new.contact_id, new.lead_id, new.deal_id, new.project_id);
    if new.assignee_id is not null then
      perform public.ws_notify(new.assignee_id, 'task.assigned', 'Task assigned to you', new.title, v_url, 'task', new.id);
    end if;
  end if;
  if new.status is distinct from old.status then
    perform public.crm_log(case when new.completed_at is not null and old.completed_at is null then 'task.completed'
                                when old.completed_at is not null and new.completed_at is null then 'task.reopened'
                                else 'task.status_changed' end,
      'task', new.id, new.title, jsonb_build_object('from', old.status, 'to', new.status),
      new.company, new.contact_id, new.lead_id, new.deal_id, new.project_id);
    -- The creator hears about completion; the assignee about a reopen.
    if new.completed_at is not null and old.completed_at is null and new.created_by is not null then
      perform public.ws_notify(new.created_by, 'task.completed', 'Task completed', new.title, v_url, 'task', new.id);
    elsif old.completed_at is not null and new.completed_at is null and new.assignee_id is not null then
      perform public.ws_notify(new.assignee_id, 'task.reopened', 'Task reopened', new.title, v_url, 'task', new.id);
    end if;
  end if;
  if new.due_date is distinct from old.due_date then
    perform public.crm_log('task.due_changed', 'task', new.id, new.title,
      jsonb_build_object('from', old.due_date, 'to', new.due_date),
      new.company, new.contact_id, new.lead_id, new.deal_id, new.project_id);
  end if;
  if new.archived_at is not null and old.archived_at is null then
    perform public.crm_log('task.archived', 'task', new.id, new.title, '{}'::jsonb,
      new.company, new.contact_id, new.lead_id, new.deal_id, new.project_id);
  end if;
  return new;
end;
$$;
drop trigger if exists tasks_log on public.tasks;
create trigger tasks_log after insert or update on public.tasks
  for each row execute procedure public.tasks_after_change();

-- Extra assignees and watchers get told.
create or replace function public.task_people_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare t record;
begin
  select id, title into t from public.tasks where id = new.task_id;
  if tg_table_name = 'task_assignees' then
    perform public.ws_notify(new.user_id, 'task.assigned', 'Task assigned to you', t.title, '/tasks/?id=' || t.id, 'task', t.id);
  end if;
  return new;
end;
$$;
drop trigger if exists task_assignees_notify on public.task_assignees;
create trigger task_assignees_notify after insert on public.task_assignees
  for each row execute procedure public.task_people_after_insert();

-- Projects: status history, member notifications, and a board of its own.
create or replace function public.projects_after_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_board uuid;
begin
  if tg_op = 'INSERT' then
    perform public.crm_log('project.created', 'project', new.id, new.name,
      jsonb_build_object('status', new.status, 'due_date', new.due_date),
      new.company, new.contact_id, null, new.deal_id, new.id);
    if new.manager_id is not null then
      perform public.ws_notify(new.manager_id, 'project.added', 'You manage a new project', new.name,
        '/projects/?id=' || new.id, 'project', new.id);
    end if;
    -- Every project gets a board with the default columns mapped onto task statuses.
    if new.board_id is null then
      insert into public.boards (company, name, kind, project_id, created_by)
      values (new.company, new.name, 'project', new.id, new.created_by) returning id into v_board;
      insert into public.board_columns (board_id, name, position, maps_to_status, color)
      select v_board, s.label, s.sort_order, s.key, s.color from public.task_statuses s order by s.sort_order;
      update public.projects set board_id = v_board where id = new.id;
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    perform public.crm_log('project.status_changed', 'project', new.id, new.name,
      jsonb_build_object('from', old.status, 'to', new.status),
      new.company, new.contact_id, null, new.deal_id, new.id);
    -- Everyone on the project hears about a status change (owner, manager, members).
    perform public.ws_notify(u, 'project.status', 'Project ' || replace(new.status, '_', ' '), new.name,
      '/projects/?id=' || new.id, 'project', new.id)
      from (select new.owner_id as u union select new.manager_id
            union select user_id from public.project_members where project_id = new.id) x
     where u is not null;
  end if;
  if new.manager_id is distinct from old.manager_id and new.manager_id is not null then
    perform public.ws_notify(new.manager_id, 'project.added', 'You manage a project', new.name,
      '/projects/?id=' || new.id, 'project', new.id);
  end if;
  if new.archived_at is not null and old.archived_at is null then
    perform public.crm_log('project.archived', 'project', new.id, new.name, '{}'::jsonb,
      new.company, new.contact_id, null, new.deal_id, new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists projects_log on public.projects;
create trigger projects_log after insert or update on public.projects
  for each row execute procedure public.projects_after_change();

create or replace function public.project_members_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare p record;
begin
  select id, name, company, contact_id, deal_id into p from public.projects where id = new.project_id;
  perform public.crm_log('project.member_added', 'project', p.id, p.name,
    jsonb_build_object('user_id', new.user_id, 'role', new.role), p.company, p.contact_id, null, p.deal_id, p.id);
  perform public.ws_notify(new.user_id, 'project.added', 'Added to a project', p.name,
    '/projects/?id=' || p.id, 'project', p.id);
  return new;
end;
$$;
drop trigger if exists project_members_notify on public.project_members;
create trigger project_members_notify after insert on public.project_members
  for each row execute procedure public.project_members_after_insert();

-- Documents: history on upload and on each link.
create or replace function public.documents_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.crm_log('document.uploaded', 'document', new.id, new.name,
    jsonb_build_object('mime_type', new.mime_type, 'size_bytes', new.size_bytes), new.company);
  return new;
end;
$$;
drop trigger if exists documents_log on public.documents;
create trigger documents_log after insert on public.documents
  for each row execute procedure public.documents_after_insert();

create or replace function public.document_links_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare d record;
begin
  select id, name, company into d from public.documents where id = new.document_id;
  perform public.crm_log('document.attached', new.entity_type, new.entity_id, d.name,
    jsonb_build_object('document_id', d.id), d.company,
    case when new.entity_type = 'contact' then new.entity_id end,
    case when new.entity_type = 'lead'    then new.entity_id end,
    case when new.entity_type = 'deal'    then new.entity_id end,
    case when new.entity_type = 'project' then new.entity_id end);
  return new;
end;
$$;
drop trigger if exists document_links_log on public.document_links;
create trigger document_links_log after insert on public.document_links
  for each row execute procedure public.document_links_after_insert();

-- Calendar: history + invitations.
create or replace function public.calendar_events_after_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.crm_log('event.scheduled', 'event', new.id, new.title,
      jsonb_build_object('starts_at', new.starts_at, 'event_type', new.event_type),
      new.company, new.contact_id, new.lead_id, new.deal_id, new.project_id);
    return new;
  end if;
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    perform public.crm_log('event.cancelled', 'event', new.id, new.title, '{}'::jsonb,
      new.company, new.contact_id, new.lead_id, new.deal_id, new.project_id);
    perform public.ws_notify(x.user_id, 'event.cancelled', 'Meeting cancelled', new.title,
      '/calendar/?id=' || new.id, 'event', new.id)
      from public.event_participants x where x.event_id = new.id;
  elsif new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at then
    perform public.crm_log('event.rescheduled', 'event', new.id, new.title,
      jsonb_build_object('from', old.starts_at, 'to', new.starts_at),
      new.company, new.contact_id, new.lead_id, new.deal_id, new.project_id);
    perform public.ws_notify(x.user_id, 'event.rescheduled', 'Meeting rescheduled', new.title,
      '/calendar/?id=' || new.id, 'event', new.id)
      from public.event_participants x where x.event_id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists calendar_events_log on public.calendar_events;
create trigger calendar_events_log after insert or update on public.calendar_events
  for each row execute procedure public.calendar_events_after_change();

create or replace function public.event_participants_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare e record;
begin
  select id, title, starts_at into e from public.calendar_events where id = new.event_id;
  perform public.ws_notify(new.user_id, 'event.invited', 'Meeting invitation', e.title,
    '/calendar/?id=' || e.id, 'event', e.id);
  return new;
end;
$$;
drop trigger if exists event_participants_notify on public.event_participants;
create trigger event_participants_notify after insert on public.event_participants
  for each row execute procedure public.event_participants_after_insert();

-- Comments: mentions notify the people named.
create or replace function public.comments_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_label text;
  u uuid;
begin
  v_url := case new.entity_type
             when 'task'    then '/tasks/?id='    || new.entity_id
             when 'project' then '/projects/?id=' || new.entity_id
             when 'contact' then '/contacts/?id=' || new.entity_id
             when 'lead'    then '/leads/?id='    || new.entity_id
             when 'deal'    then '/deals/?id='    || new.entity_id
             when 'invoice' then '/invoices/?id=' || new.entity_id
             else null end;
  v_label := left(regexp_replace(new.body, '\s+', ' ', 'g'), 120);
  perform public.crm_log('note.added', new.entity_type, new.entity_id, v_label,
    jsonb_build_object('comment_id', new.id), new.company,
    case when new.entity_type = 'contact' then new.entity_id end,
    case when new.entity_type = 'lead'    then new.entity_id end,
    case when new.entity_type = 'deal'    then new.entity_id end,
    case when new.entity_type = 'project' then new.entity_id end);
  foreach u in array new.mentions loop
    perform public.ws_notify(u, 'mention', 'You were mentioned', v_label, v_url, new.entity_type, new.entity_id);
  end loop;
  return new;
end;
$$;
drop trigger if exists comments_log on public.comments;
create trigger comments_log after insert on public.comments
  for each row execute procedure public.comments_after_insert();

-- ---------------------------------------------------------------------------
-- 10) Row Level Security
-- ---------------------------------------------------------------------------
alter table public.boards             enable row level security;
alter table public.board_columns      enable row level security;
alter table public.projects           enable row level security;
alter table public.project_members    enable row level security;
alter table public.tasks              enable row level security;
alter table public.task_assignees     enable row level security;
alter table public.task_watchers      enable row level security;
alter table public.comments           enable row level security;
alter table public.document_folders   enable row level security;
alter table public.documents          enable row level security;
alter table public.document_links     enable row level security;
alter table public.calendar_events    enable row level security;
alter table public.event_participants enable row level security;

-- Boards
drop policy if exists boards_select on public.boards;
create policy boards_select on public.boards for select to authenticated
  using ((select public.ws_same_company(company)));
drop policy if exists boards_insert on public.boards;
create policy boards_insert on public.boards for insert to authenticated
  with check ((select public.ws_same_company(company)) and created_by = auth.uid());
drop policy if exists boards_update on public.boards;
create policy boards_update on public.boards for update to authenticated
  using ((select public.ws_same_company(company))
         and (created_by = auth.uid() or (select public.ws_is_manager()) or public.ws_on_project(project_id)))
  with check ((select public.ws_same_company(company)));
drop policy if exists boards_delete on public.boards;
create policy boards_delete on public.boards for delete to authenticated
  using ((select public.ws_same_company(company)) and (created_by = auth.uid() or (select public.ws_is_manager())));

drop policy if exists board_columns_select on public.board_columns;
create policy board_columns_select on public.board_columns for select to authenticated
  using (exists (select 1 from public.boards b where b.id = board_id and public.ws_same_company(b.company)));
drop policy if exists board_columns_manage on public.board_columns;
create policy board_columns_manage on public.board_columns for all to authenticated
  using (exists (select 1 from public.boards b where b.id = board_id and public.ws_same_company(b.company)
                   and (b.created_by = auth.uid() or public.ws_is_manager() or public.ws_on_project(b.project_id))))
  with check (exists (select 1 from public.boards b where b.id = board_id and public.ws_same_company(b.company)
                   and (b.created_by = auth.uid() or public.ws_is_manager() or public.ws_on_project(b.project_id))));

-- Projects
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects for select to authenticated
  using ((select public.ws_same_company(company)));
drop policy if exists projects_insert on public.projects;
create policy projects_insert on public.projects for insert to authenticated
  with check ((select public.ws_same_company(company)) and created_by = auth.uid());
drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects for update to authenticated
  using ((select public.ws_same_company(company))
         and (owner_id = auth.uid() or manager_id = auth.uid() or created_by = auth.uid()
              or public.ws_on_project(id) or (select public.ws_is_manager())))
  with check ((select public.ws_same_company(company)));
drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects for delete to authenticated
  using ((select public.ws_same_company(company)) and (select public.ws_is_manager()));

drop policy if exists project_members_select on public.project_members;
create policy project_members_select on public.project_members for select to authenticated
  using (exists (select 1 from public.projects p where p.id = project_id and public.ws_same_company(p.company)));
drop policy if exists project_members_manage on public.project_members;
create policy project_members_manage on public.project_members for all to authenticated
  using (exists (select 1 from public.projects p where p.id = project_id and public.ws_same_company(p.company)
                   and (p.owner_id = auth.uid() or p.manager_id = auth.uid() or p.created_by = auth.uid() or public.ws_is_manager())))
  with check (exists (select 1 from public.projects p where p.id = project_id and public.ws_same_company(p.company)
                   and (p.owner_id = auth.uid() or p.manager_id = auth.uid() or p.created_by = auth.uid() or public.ws_is_manager())));

-- Tasks
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select to authenticated
  using ((select public.ws_same_company(company)));
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to authenticated
  with check ((select public.ws_same_company(company)) and created_by = auth.uid());
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using (public.ws_can_edit_task(id))
  with check ((select public.ws_same_company(company)));
drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks for delete to authenticated
  using ((select public.ws_same_company(company)) and (created_by = auth.uid() or (select public.ws_is_manager())));

drop policy if exists task_assignees_select on public.task_assignees;
create policy task_assignees_select on public.task_assignees for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_id and public.ws_same_company(t.company)));
drop policy if exists task_assignees_manage on public.task_assignees;
create policy task_assignees_manage on public.task_assignees for all to authenticated
  using (public.ws_can_edit_task(task_id)) with check (public.ws_can_edit_task(task_id));

drop policy if exists task_watchers_select on public.task_watchers;
create policy task_watchers_select on public.task_watchers for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_id and public.ws_same_company(t.company)));
drop policy if exists task_watchers_manage on public.task_watchers;
create policy task_watchers_manage on public.task_watchers for all to authenticated
  using (user_id = auth.uid() or public.ws_can_edit_task(task_id))
  with check (user_id = auth.uid() or public.ws_can_edit_task(task_id));

-- Comments: readable with the record; edit/delete your own (managers may delete)
drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments for select to authenticated
  using ((select public.ws_same_company(company)));
drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments for insert to authenticated
  with check ((select public.ws_same_company(company)) and author_id = auth.uid());
drop policy if exists comments_update on public.comments;
create policy comments_update on public.comments for update to authenticated
  using (author_id = auth.uid()) with check (author_id = auth.uid());
drop policy if exists comments_delete on public.comments;
create policy comments_delete on public.comments for delete to authenticated
  using (author_id = auth.uid() or ((select public.ws_same_company(company)) and (select public.ws_is_manager())));

-- Documents
drop policy if exists document_folders_select on public.document_folders;
create policy document_folders_select on public.document_folders for select to authenticated
  using ((select public.ws_same_company(company)));
drop policy if exists document_folders_insert on public.document_folders;
create policy document_folders_insert on public.document_folders for insert to authenticated
  with check ((select public.ws_same_company(company)) and created_by = auth.uid());
drop policy if exists document_folders_update on public.document_folders;
create policy document_folders_update on public.document_folders for update to authenticated
  using ((select public.ws_same_company(company)) and (created_by = auth.uid() or (select public.ws_is_manager())))
  with check ((select public.ws_same_company(company)));
drop policy if exists document_folders_delete on public.document_folders;
create policy document_folders_delete on public.document_folders for delete to authenticated
  using ((select public.ws_same_company(company)) and (created_by = auth.uid() or (select public.ws_is_manager())));

drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents for select to authenticated
  using ((select public.ws_same_company(company)));
drop policy if exists documents_insert on public.documents;
create policy documents_insert on public.documents for insert to authenticated
  with check ((select public.ws_same_company(company)) and created_by = auth.uid()
              and split_part(storage_path, '/', 1) = auth.uid()::text);
drop policy if exists documents_update on public.documents;
create policy documents_update on public.documents for update to authenticated
  using ((select public.ws_same_company(company)) and (created_by = auth.uid() or (select public.ws_is_manager())))
  with check ((select public.ws_same_company(company)));
drop policy if exists documents_delete on public.documents;
create policy documents_delete on public.documents for delete to authenticated
  using ((select public.ws_same_company(company)) and (created_by = auth.uid() or (select public.ws_is_manager())));

drop policy if exists document_links_select on public.document_links;
create policy document_links_select on public.document_links for select to authenticated
  using (exists (select 1 from public.documents d where d.id = document_id and public.ws_same_company(d.company)));
drop policy if exists document_links_insert on public.document_links;
create policy document_links_insert on public.document_links for insert to authenticated
  with check (created_by = auth.uid()
              and exists (select 1 from public.documents d where d.id = document_id and public.ws_same_company(d.company)));
drop policy if exists document_links_delete on public.document_links;
create policy document_links_delete on public.document_links for delete to authenticated
  using (created_by = auth.uid()
         or exists (select 1 from public.documents d where d.id = document_id and public.ws_same_company(d.company)
                      and (d.created_by = auth.uid() or public.ws_is_manager())));

-- Calendar
drop policy if exists calendar_events_select on public.calendar_events;
create policy calendar_events_select on public.calendar_events for select to authenticated
  using (owner_id = auth.uid() or created_by = auth.uid()
         or (visibility = 'company' and (select public.ws_same_company(company)))
         or exists (select 1 from public.event_participants x where x.event_id = id and x.user_id = auth.uid())
         or (select public.ws_is_admin()));
drop policy if exists calendar_events_insert on public.calendar_events;
create policy calendar_events_insert on public.calendar_events for insert to authenticated
  with check ((select public.ws_same_company(company)) and created_by = auth.uid());
drop policy if exists calendar_events_update on public.calendar_events;
create policy calendar_events_update on public.calendar_events for update to authenticated
  using (owner_id = auth.uid() or created_by = auth.uid()
         or ((select public.ws_same_company(company)) and (select public.ws_is_manager())))
  with check ((select public.ws_same_company(company)));
drop policy if exists calendar_events_delete on public.calendar_events;
create policy calendar_events_delete on public.calendar_events for delete to authenticated
  using (owner_id = auth.uid() or created_by = auth.uid()
         or ((select public.ws_same_company(company)) and (select public.ws_is_manager())));

drop policy if exists event_participants_select on public.event_participants;
create policy event_participants_select on public.event_participants for select to authenticated
  using (public.ws_can_see_event(event_id));
drop policy if exists event_participants_insert on public.event_participants;
create policy event_participants_insert on public.event_participants for insert to authenticated
  with check (exists (select 1 from public.calendar_events e where e.id = event_id
                        and (e.owner_id = auth.uid() or e.created_by = auth.uid()
                             or (public.ws_same_company(e.company) and public.ws_is_manager()))));
drop policy if exists event_participants_update on public.event_participants;
create policy event_participants_update on public.event_participants for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());       -- accept / decline your own invite
drop policy if exists event_participants_delete on public.event_participants;
create policy event_participants_delete on public.event_participants for delete to authenticated
  using (user_id = auth.uid()
         or exists (select 1 from public.calendar_events e where e.id = event_id
                      and (e.owner_id = auth.uid() or e.created_by = auth.uid()
                           or (public.ws_same_company(e.company) and public.ws_is_manager()))));

-- ---------------------------------------------------------------------------
-- 11) Realtime: tasks and comments update live on open boards/detail pages.
--     RLS still applies, so a client only receives rows it may read.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['tasks', 'comments', 'crm_deals', 'calendar_events', 'event_participants'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end$$;

-- ---------------------------------------------------------------------------
-- 12) Storage: private `documents` bucket
--
-- Path shape is {uploader uid}/{uuid}-{safe file name}. Uploads go into the
-- caller's own folder only. Reads are gated on the documents row: the file is
-- visible to whoever may see its metadata row (same company). Nothing is
-- public; the app serves 1-hour signed URLs.
-- ---------------------------------------------------------------------------
-- Size and type are also enforced by Storage itself, not only by the page:
-- the list matches ALLOWED_DOC_TYPES in ui/crm-logic.js (a test keeps them equal).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 52428800,   -- 50 MB per file
  array[
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'text/plain',
    'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip',
    'application/x-zip-compressed',
    'application/json',
    'video/mp4',
    'audio/mpeg',
    'audio/wav',
    'video/webm'
  ])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.ws_document_visible(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select split_part(p_path, '/', 1) = auth.uid()::text
      or exists (select 1 from public.documents d
                  where d.storage_path = p_path and public.ws_same_company(d.company));
$$;
grant execute on function public.ws_document_visible(text) to authenticated;

drop policy if exists "documents upload own" on storage.objects;
create policy "documents upload own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "documents read visible" on storage.objects;
create policy "documents read visible" on storage.objects
  for select to authenticated
  using (bucket_id = 'documents' and public.ws_document_visible(name));

drop policy if exists "documents delete own or manager" on storage.objects;
create policy "documents delete own or manager" on storage.objects
  for delete to authenticated
  using (bucket_id = 'documents'
         and ((storage.foldername(name))[1] = auth.uid()::text
              or exists (select 1 from public.documents d
                          where d.storage_path = name and public.ws_same_company(d.company) and public.ws_is_manager())));

-- Done. Next: supabase-invoices-migration.sql
