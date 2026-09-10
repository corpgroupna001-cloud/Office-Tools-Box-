-- ============================================================================
-- CRM foundation: workspace roles, permission helpers, shared activity log,
-- in-app notifications, contacts, leads, pipelines and deals.
--
-- Run FIRST of the CRM set, in Supabase -> SQL Editor. Idempotent: safe to
-- re-run. Adds only; nothing existing is dropped or truncated. Existing auth
-- users, profiles, attendance, leave, payroll, messages and results are
-- untouched.
--
-- Order of the CRM set:
--   1. supabase-crm-foundation-migration.sql   (this file)
--   2. supabase-work-migration.sql             (projects, boards, tasks,
--                                               comments, documents, calendar)
--   3. supabase-invoices-migration.sql
--   4. supabase-messenger-migration.sql
--
-- Permission model (see SETUP.md "CRM & work modules"):
--   profiles.app_role  employee | manager | admin
--     employee  sees the CRM/work records of their own company; edits what
--               they own, created, or are assigned to.
--     manager   everything an employee can, plus edit/delete/finance across
--               their company, and read their company's attendance and leave.
--     admin     the same across every company.
--   The role is set only from the admin console (service key). A trigger
--   rejects any attempt by a signed-in employee to change it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Workspace role on profiles
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists app_role text not null default 'employee';

alter table public.profiles drop constraint if exists profiles_app_role_ck;
alter table public.profiles add constraint profiles_app_role_ck
  check (app_role in ('employee', 'manager', 'admin'));

create index if not exists profiles_app_role_idx on public.profiles (app_role)
  where app_role <> 'employee';

-- profiles_update_own lets a person edit their own row (name, avatar,
-- last_seen_at). It must not let them promote themselves. PostgREST requests
-- carry the caller's role in the JWT claims; the service key and the SQL
-- editor do not carry 'authenticated'.
create or replace function public.ws_guard_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.app_role is distinct from old.app_role
     and coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'authenticated' then
    raise exception 'app_role can only be changed by an administrator'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_role on public.profiles;
create trigger profiles_guard_role
  before update of app_role on public.profiles
  for each row execute procedure public.ws_guard_profile_role();

-- ---------------------------------------------------------------------------
-- 2) Permission helpers used by every CRM/work policy
--
-- SECURITY DEFINER so they can read profiles regardless of the caller's own
-- policies; STABLE so the planner evaluates them once per statement when
-- they are wrapped as (select ...) inside a policy.
-- ---------------------------------------------------------------------------
create or replace function public.ws_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select app_role from public.profiles where id = auth.uid()), 'employee');
$$;

create or replace function public.ws_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.ws_role() = 'admin';
$$;

create or replace function public.ws_is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.ws_role() in ('manager', 'admin');
$$;

/** The caller's primary company (used to stamp new records). */
create or replace function public.ws_company()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select company from public.profiles where id = auth.uid();
$$;

/** True when the caller belongs to that company (either of their two), or is an admin. */
create or replace function public.ws_same_company(target text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.ws_is_admin()
      or (target is not null and exists (
            select 1 from public.profiles p
             where p.id = auth.uid()
               and (p.company = target or p.company2 = target)));
$$;

/** True when the caller may see another person's private records (attendance, leave). */
create or replace function public.ws_manages(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_user = auth.uid()
      or public.ws_is_admin()
      or exists (
           select 1 from public.profiles t
            where t.id = target_user
              and (t.manager_id = auth.uid()
                   or (public.ws_is_manager() and public.ws_same_company(t.company))));
$$;

grant execute on function public.ws_role(), public.ws_is_admin(), public.ws_is_manager(),
  public.ws_company(), public.ws_same_company(text), public.ws_manages(uuid) to authenticated;

-- Generic row bookkeeping shared by every new table.
create or replace function public.ws_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Stamp created_by and company from the signed-in caller when the client did
-- not send them. Admins may pass an explicit company.
create or replace function public.ws_fill_owner_cols()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.created_by is null then new.created_by := auth.uid(); end if;
  if new.company is null then new.company := public.ws_company(); end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Managers may read their people's attendance and leave (additive policies;
--    employees keep exactly the access they had).
-- ---------------------------------------------------------------------------
drop policy if exists attendance_select_manager on public.attendance_logs;
create policy attendance_select_manager on public.attendance_logs
  for select to authenticated
  using (user_id is not null and public.ws_manages(user_id));

drop policy if exists leave_select_manager on public.leave_requests;
create policy leave_select_manager on public.leave_requests
  for select to authenticated
  using (public.ws_manages(user_id));

-- ---------------------------------------------------------------------------
-- 4) Shared activity timeline
--
-- One table for every module. Written by triggers (stage changes, status
-- changes, conversions) and by the client for notes/actions. Append-only for
-- employees; never carries passwords, tokens or secrets (meta is what the
-- helper below is handed, and callers pass only labels and ids).
-- ---------------------------------------------------------------------------
create table if not exists public.crm_activities (
  id           uuid primary key default gen_random_uuid(),
  company      text,
  actor_id     uuid references public.profiles(id) on delete set null,
  action       text not null,                 -- e.g. 'lead.created', 'deal.stage_changed'
  entity_type  text not null,                 -- contact | lead | deal | task | project | document | event | invoice | board
  entity_id    uuid not null,
  entity_label text,                          -- denormalised so the line still reads after deletion
  meta         jsonb not null default '{}'::jsonb,
  -- Secondary links so a contact's timeline also shows its deals' history.
  contact_id   uuid,
  lead_id      uuid,
  deal_id      uuid,
  project_id   uuid,
  created_at   timestamptz not null default now()
);

create index if not exists crm_activities_entity_idx  on public.crm_activities (entity_type, entity_id, created_at desc);
create index if not exists crm_activities_company_idx on public.crm_activities (company, created_at desc);
create index if not exists crm_activities_contact_idx on public.crm_activities (contact_id, created_at desc) where contact_id is not null;
create index if not exists crm_activities_lead_idx    on public.crm_activities (lead_id, created_at desc) where lead_id is not null;
create index if not exists crm_activities_deal_idx    on public.crm_activities (deal_id, created_at desc) where deal_id is not null;
create index if not exists crm_activities_project_idx on public.crm_activities (project_id, created_at desc) where project_id is not null;
create index if not exists crm_activities_actor_idx   on public.crm_activities (actor_id, created_at desc);

alter table public.crm_activities enable row level security;

drop policy if exists crm_activities_select on public.crm_activities;
create policy crm_activities_select on public.crm_activities
  for select to authenticated
  using ((select public.ws_same_company(company)));

drop policy if exists crm_activities_insert on public.crm_activities;
create policy crm_activities_insert on public.crm_activities
  for insert to authenticated
  with check (actor_id = auth.uid() and (select public.ws_same_company(company)));
-- No update/delete for authenticated: the timeline is append-only.

-- Helper used by triggers and by the client (via RPC) to log an activity.
create or replace function public.crm_log(
  p_action text, p_entity_type text, p_entity_id uuid, p_label text default null,
  p_meta jsonb default '{}'::jsonb, p_company text default null,
  p_contact_id uuid default null, p_lead_id uuid default null,
  p_deal_id uuid default null, p_project_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.crm_activities
    (company, actor_id, action, entity_type, entity_id, entity_label, meta,
     contact_id, lead_id, deal_id, project_id)
  values
    (coalesce(p_company, public.ws_company()), auth.uid(), p_action, p_entity_type, p_entity_id,
     left(p_label, 200), coalesce(p_meta, '{}'::jsonb),
     p_contact_id, p_lead_id, p_deal_id, p_project_id)
  returning id into v_id;
  return v_id;
end;
$$;

grant execute on function public.crm_log(text, text, uuid, text, jsonb, text, uuid, uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) In-app notifications (the bell). Delivered live over Realtime; Web Push
--    still goes through /api/push from the acting client, so a push failure
--    can never roll back the change that caused it.
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  actor_id    uuid references public.profiles(id) on delete set null,
  kind        text not null,                 -- task.assigned | lead.assigned | deal.assigned | project.added | event.invited | mention | ...
  title       text not null,
  body        text,
  url         text,
  entity_type text,
  entity_id   uuid,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx on public.notifications (user_id) where read_at is null;

alter table public.notifications enable row level security;

drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
  for select to authenticated using (user_id = auth.uid());

drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists notifications_delete_own on public.notifications;
create policy notifications_delete_own on public.notifications
  for delete to authenticated using (user_id = auth.uid());

-- A client may notify a colleague only as itself (mentions, manual shares).
drop policy if exists notifications_insert_as_actor on public.notifications;
create policy notifications_insert_as_actor on public.notifications
  for insert to authenticated
  with check (actor_id = auth.uid() and user_id <> auth.uid());

-- Trigger-side helper: never notifies the actor about their own action, and
-- collapses repeats of the same kind for the same record within an hour so a
-- burst of edits does not become a burst of bells.
create or replace function public.ws_notify(
  p_user uuid, p_kind text, p_title text, p_body text default null, p_url text default null,
  p_entity_type text default null, p_entity_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user is null or p_user = auth.uid() then return; end if;
  if p_entity_id is not null and exists (
       select 1 from public.notifications n
        where n.user_id = p_user and n.kind = p_kind and n.entity_id = p_entity_id
          and n.read_at is null and n.created_at > now() - interval '1 hour') then
    return;
  end if;
  insert into public.notifications (user_id, actor_id, kind, title, body, url, entity_type, entity_id)
  values (p_user, auth.uid(), p_kind, left(p_title, 140), left(p_body, 300), left(p_url, 300), p_entity_type, p_entity_id);
end;
$$;

grant execute on function public.ws_notify(uuid, text, text, text, text, text, uuid) to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- 6) Contacts
-- ---------------------------------------------------------------------------
create table if not exists public.crm_contacts (
  id            uuid primary key default gen_random_uuid(),
  company       text,                                   -- owning WorkSuite company (profiles.company)
  first_name    text,
  last_name     text,
  full_name     text generated always as (btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))) stored,
  organization  text,                                   -- the contact's own company / employer
  job_title     text,
  email         text,
  email2        text,
  phone         text,
  phone2        text,
  address       text,
  city          text,
  state         text,
  country       text,
  postal_code   text,
  website       text,
  source        text,
  owner_id      uuid references public.profiles(id) on delete set null,
  status        text not null default 'active',
  notes         text,
  tags          text[] not null default '{}',
  lead_id       uuid,                                   -- the lead this contact was converted from (FK added below)
  archived_at   timestamptz,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.crm_contacts drop constraint if exists crm_contacts_status_ck;
alter table public.crm_contacts add constraint crm_contacts_status_ck
  check (status in ('active', 'inactive', 'archived'));
alter table public.crm_contacts drop constraint if exists crm_contacts_name_ck;
alter table public.crm_contacts add constraint crm_contacts_name_ck
  check (coalesce(first_name, '') <> '' or coalesce(last_name, '') <> '' or coalesce(organization, '') <> '');

create index if not exists crm_contacts_company_idx  on public.crm_contacts (company, status);
create index if not exists crm_contacts_owner_idx    on public.crm_contacts (owner_id);
create index if not exists crm_contacts_email_idx    on public.crm_contacts (lower(email));
create index if not exists crm_contacts_phone_idx    on public.crm_contacts (phone);
create index if not exists crm_contacts_name_idx     on public.crm_contacts (lower(full_name));
create index if not exists crm_contacts_org_idx      on public.crm_contacts (lower(organization));
create index if not exists crm_contacts_created_idx  on public.crm_contacts (created_at desc);
create index if not exists crm_contacts_tags_idx     on public.crm_contacts using gin (tags);

drop trigger if exists crm_contacts_fill on public.crm_contacts;
create trigger crm_contacts_fill before insert on public.crm_contacts
  for each row execute procedure public.ws_fill_owner_cols();
drop trigger if exists crm_contacts_touch on public.crm_contacts;
create trigger crm_contacts_touch before update on public.crm_contacts
  for each row execute procedure public.ws_touch_updated_at();

alter table public.crm_contacts enable row level security;

drop policy if exists crm_contacts_select on public.crm_contacts;
create policy crm_contacts_select on public.crm_contacts
  for select to authenticated
  using ((select public.ws_same_company(company)));

drop policy if exists crm_contacts_insert on public.crm_contacts;
create policy crm_contacts_insert on public.crm_contacts
  for insert to authenticated
  with check ((select public.ws_same_company(company)) and created_by = auth.uid());

drop policy if exists crm_contacts_update on public.crm_contacts;
create policy crm_contacts_update on public.crm_contacts
  for update to authenticated
  using ((select public.ws_same_company(company))
         and (owner_id = auth.uid() or created_by = auth.uid() or (select public.ws_is_manager())))
  with check ((select public.ws_same_company(company)));

drop policy if exists crm_contacts_delete on public.crm_contacts;
create policy crm_contacts_delete on public.crm_contacts
  for delete to authenticated
  using ((select public.ws_same_company(company)) and (select public.ws_is_manager()));

-- ---------------------------------------------------------------------------
-- 7) Lead statuses (a table, so a new status needs no migration) and leads
-- ---------------------------------------------------------------------------
create table if not exists public.crm_lead_statuses (
  key          text primary key,
  label        text not null,
  sort_order   int not null default 0,
  is_closed    boolean not null default false,   -- unqualified / converted: no longer "open"
  is_converted boolean not null default false,
  color        text
);

insert into public.crm_lead_statuses (key, label, sort_order, is_closed, is_converted, color) values
  ('new',         'New',         1, false, false, 'pending'),
  ('contacted',   'Contacted',   2, false, false, 'late'),
  ('qualified',   'Qualified',   3, false, false, 'present'),
  ('unqualified', 'Unqualified', 4, true,  false, 'weekoff'),
  ('converted',   'Converted',   5, true,  true,  'leave')
on conflict (key) do nothing;

alter table public.crm_lead_statuses enable row level security;
drop policy if exists crm_lead_statuses_read on public.crm_lead_statuses;
create policy crm_lead_statuses_read on public.crm_lead_statuses
  for select to authenticated using (true);           -- reference data, not sensitive
drop policy if exists crm_lead_statuses_manage on public.crm_lead_statuses;
create policy crm_lead_statuses_manage on public.crm_lead_statuses
  for all to authenticated
  using ((select public.ws_is_admin())) with check ((select public.ws_is_admin()));

create table if not exists public.crm_leads (
  id                   uuid primary key default gen_random_uuid(),
  company              text,
  name                 text not null,
  organization         text,
  email                text,
  phone                text,
  source               text,
  source_detail        text,                          -- campaign / referrer / event
  owner_id             uuid references public.profiles(id) on delete set null,
  status               text not null default 'new' references public.crm_lead_statuses(key),
  estimated_value      numeric(14,2),
  currency             text not null default 'INR',
  priority             text not null default 'normal',
  notes                text,
  next_follow_up_at    timestamptz,
  tags                 text[] not null default '{}',
  converted_at         timestamptz,
  converted_by         uuid references public.profiles(id) on delete set null,
  converted_contact_id uuid references public.crm_contacts(id) on delete set null,
  converted_deal_id    uuid,                          -- FK added after crm_deals exists
  archived_at          timestamptz,
  created_by           uuid references public.profiles(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table public.crm_leads drop constraint if exists crm_leads_priority_ck;
alter table public.crm_leads add constraint crm_leads_priority_ck
  check (priority in ('low', 'normal', 'high', 'urgent'));
alter table public.crm_leads drop constraint if exists crm_leads_value_ck;
alter table public.crm_leads add constraint crm_leads_value_ck
  check (estimated_value is null or estimated_value >= 0);

create index if not exists crm_leads_company_idx   on public.crm_leads (company, status);
create index if not exists crm_leads_owner_idx     on public.crm_leads (owner_id, status);
create index if not exists crm_leads_email_idx     on public.crm_leads (lower(email));
create index if not exists crm_leads_followup_idx  on public.crm_leads (next_follow_up_at) where next_follow_up_at is not null;
create index if not exists crm_leads_created_idx   on public.crm_leads (created_at desc);
create index if not exists crm_leads_name_idx      on public.crm_leads (lower(name));

-- contact -> lead back-reference, now that both tables exist
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crm_contacts_lead_fk') then
    alter table public.crm_contacts
      add constraint crm_contacts_lead_fk foreign key (lead_id)
      references public.crm_leads(id) on delete set null;
  end if;
end$$;

drop trigger if exists crm_leads_fill on public.crm_leads;
create trigger crm_leads_fill before insert on public.crm_leads
  for each row execute procedure public.ws_fill_owner_cols();
drop trigger if exists crm_leads_touch on public.crm_leads;
create trigger crm_leads_touch before update on public.crm_leads
  for each row execute procedure public.ws_touch_updated_at();

alter table public.crm_leads enable row level security;

drop policy if exists crm_leads_select on public.crm_leads;
create policy crm_leads_select on public.crm_leads
  for select to authenticated
  using ((select public.ws_same_company(company)));

drop policy if exists crm_leads_insert on public.crm_leads;
create policy crm_leads_insert on public.crm_leads
  for insert to authenticated
  with check ((select public.ws_same_company(company)) and created_by = auth.uid());

drop policy if exists crm_leads_update on public.crm_leads;
create policy crm_leads_update on public.crm_leads
  for update to authenticated
  using ((select public.ws_same_company(company))
         and (owner_id = auth.uid() or created_by = auth.uid() or (select public.ws_is_manager())))
  with check ((select public.ws_same_company(company)));

drop policy if exists crm_leads_delete on public.crm_leads;
create policy crm_leads_delete on public.crm_leads
  for delete to authenticated
  using ((select public.ws_same_company(company)) and (select public.ws_is_manager()));

-- Lead history + owner notification, written by the database so it holds
-- whichever client made the change.
create or replace function public.crm_leads_after_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.crm_log('lead.created', 'lead', new.id, new.name,
      jsonb_build_object('status', new.status, 'source', new.source), new.company, null, new.id);
    if new.owner_id is not null then
      perform public.ws_notify(new.owner_id, 'lead.assigned', 'Lead assigned to you', new.name,
        '/leads/?id=' || new.id, 'lead', new.id);
    end if;
    return new;
  end if;

  if new.owner_id is distinct from old.owner_id then
    perform public.crm_log('lead.assigned', 'lead', new.id, new.name,
      jsonb_build_object('from', old.owner_id, 'to', new.owner_id), new.company, null, new.id);
    if new.owner_id is not null then
      perform public.ws_notify(new.owner_id, 'lead.assigned', 'Lead assigned to you', new.name,
        '/leads/?id=' || new.id, 'lead', new.id);
    end if;
  end if;
  if new.status is distinct from old.status then
    perform public.crm_log(case when new.status = 'converted' then 'lead.converted' else 'lead.status_changed' end,
      'lead', new.id, new.name,
      jsonb_build_object('from', old.status, 'to', new.status,
                         'contact_id', new.converted_contact_id, 'deal_id', new.converted_deal_id),
      new.company, new.converted_contact_id, new.id, new.converted_deal_id);
  end if;
  return new;
end;
$$;

drop trigger if exists crm_leads_log on public.crm_leads;
create trigger crm_leads_log after insert or update on public.crm_leads
  for each row execute procedure public.crm_leads_after_change();

-- ---------------------------------------------------------------------------
-- 8) Pipelines and stages (configurable; nothing in the code is tied to the
--    stage names, only to is_won / is_lost / probability)
-- ---------------------------------------------------------------------------
create table if not exists public.crm_pipelines (
  id          uuid primary key default gen_random_uuid(),
  company     text,                                     -- null = shared by every company
  name        text not null,
  is_default  boolean not null default false,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.crm_pipeline_stages (
  id           uuid primary key default gen_random_uuid(),
  pipeline_id  uuid not null references public.crm_pipelines(id) on delete cascade,
  name         text not null,
  position     int not null default 0,
  probability  int not null default 0,
  is_won       boolean not null default false,
  is_lost      boolean not null default false,
  color        text,                                    -- one of the --st-* palette keys
  created_at   timestamptz not null default now()
);

alter table public.crm_pipeline_stages drop constraint if exists crm_stage_probability_ck;
alter table public.crm_pipeline_stages add constraint crm_stage_probability_ck
  check (probability between 0 and 100);
alter table public.crm_pipeline_stages drop constraint if exists crm_stage_outcome_ck;
alter table public.crm_pipeline_stages add constraint crm_stage_outcome_ck
  check (not (is_won and is_lost));

create index if not exists crm_pipeline_stages_pipeline_idx on public.crm_pipeline_stages (pipeline_id, position);
create unique index if not exists crm_pipelines_single_default_uidx
  on public.crm_pipelines ((coalesce(company, '*'))) where is_default;

drop trigger if exists crm_pipelines_touch on public.crm_pipelines;
create trigger crm_pipelines_touch before update on public.crm_pipelines
  for each row execute procedure public.ws_touch_updated_at();

-- Seed one shared default pipeline (only when none exists).
do $$
declare
  v_pipeline uuid;
begin
  if not exists (select 1 from public.crm_pipelines) then
    insert into public.crm_pipelines (company, name, is_default) values (null, 'Sales', true)
    returning id into v_pipeline;
    insert into public.crm_pipeline_stages (pipeline_id, name, position, probability, is_won, is_lost, color) values
      (v_pipeline, 'New Opportunity', 1,  10, false, false, 'pending'),
      (v_pipeline, 'Qualification',   2,  25, false, false, 'late'),
      (v_pipeline, 'Proposal',        3,  50, false, false, 'leave'),
      (v_pipeline, 'Negotiation',     4,  75, false, false, 'holiday'),
      (v_pipeline, 'Won',             5, 100, true,  false, 'present'),
      (v_pipeline, 'Lost',            6,   0, false, true,  'absent');
  end if;
end$$;

alter table public.crm_pipelines enable row level security;
alter table public.crm_pipeline_stages enable row level security;

drop policy if exists crm_pipelines_select on public.crm_pipelines;
create policy crm_pipelines_select on public.crm_pipelines
  for select to authenticated
  using (company is null or (select public.ws_same_company(company)));

drop policy if exists crm_pipelines_manage on public.crm_pipelines;
create policy crm_pipelines_manage on public.crm_pipelines
  for all to authenticated
  using ((select public.ws_is_manager()) and (company is null or (select public.ws_same_company(company))))
  with check ((select public.ws_is_manager()) and (company is null or (select public.ws_same_company(company))));

drop policy if exists crm_pipeline_stages_select on public.crm_pipeline_stages;
create policy crm_pipeline_stages_select on public.crm_pipeline_stages
  for select to authenticated
  using (exists (select 1 from public.crm_pipelines p where p.id = pipeline_id
                   and (p.company is null or public.ws_same_company(p.company))));

drop policy if exists crm_pipeline_stages_manage on public.crm_pipeline_stages;
create policy crm_pipeline_stages_manage on public.crm_pipeline_stages
  for all to authenticated
  using ((select public.ws_is_manager()) and exists (select 1 from public.crm_pipelines p where p.id = pipeline_id
                   and (p.company is null or public.ws_same_company(p.company))))
  with check ((select public.ws_is_manager()) and exists (select 1 from public.crm_pipelines p where p.id = pipeline_id
                   and (p.company is null or public.ws_same_company(p.company))));

-- ---------------------------------------------------------------------------
-- 9) Deals
-- ---------------------------------------------------------------------------
create table if not exists public.crm_deals (
  id                   uuid primary key default gen_random_uuid(),
  company              text,
  title                text not null,
  contact_id           uuid references public.crm_contacts(id) on delete set null,
  organization         text,
  owner_id             uuid references public.profiles(id) on delete set null,
  pipeline_id          uuid not null references public.crm_pipelines(id) on delete restrict,
  stage_id             uuid not null references public.crm_pipeline_stages(id) on delete restrict,
  value                numeric(14,2) not null default 0,
  currency             text not null default 'INR',
  probability          int not null default 0,
  expected_close_date  date,
  actual_close_date    date,
  status               text not null default 'open',
  source               text,
  description          text,
  lead_id              uuid references public.crm_leads(id) on delete set null,
  tags                 text[] not null default '{}',
  position             numeric not null default 0,       -- order inside a kanban column
  archived_at          timestamptz,
  created_by           uuid references public.profiles(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table public.crm_deals drop constraint if exists crm_deals_status_ck;
alter table public.crm_deals add constraint crm_deals_status_ck check (status in ('open', 'won', 'lost'));
alter table public.crm_deals drop constraint if exists crm_deals_value_ck;
alter table public.crm_deals add constraint crm_deals_value_ck check (value >= 0);
alter table public.crm_deals drop constraint if exists crm_deals_probability_ck;
alter table public.crm_deals add constraint crm_deals_probability_ck check (probability between 0 and 100);

create index if not exists crm_deals_company_idx   on public.crm_deals (company, status);
create index if not exists crm_deals_stage_idx     on public.crm_deals (pipeline_id, stage_id, position);
create index if not exists crm_deals_owner_idx     on public.crm_deals (owner_id, status);
create index if not exists crm_deals_contact_idx   on public.crm_deals (contact_id);
create index if not exists crm_deals_close_idx     on public.crm_deals (expected_close_date) where status = 'open';
create index if not exists crm_deals_created_idx   on public.crm_deals (created_at desc);
create index if not exists crm_deals_title_idx     on public.crm_deals (lower(title));

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crm_leads_deal_fk') then
    alter table public.crm_leads
      add constraint crm_leads_deal_fk foreign key (converted_deal_id)
      references public.crm_deals(id) on delete set null;
  end if;
end$$;

drop trigger if exists crm_deals_fill on public.crm_deals;
create trigger crm_deals_fill before insert on public.crm_deals
  for each row execute procedure public.ws_fill_owner_cols();
drop trigger if exists crm_deals_touch on public.crm_deals;
create trigger crm_deals_touch before update on public.crm_deals
  for each row execute procedure public.ws_touch_updated_at();

-- Stage drives status/probability. A deal dropped on a Won stage is won; on a
-- Lost stage, lost; anywhere else it is open again and the close date clears.
create or replace function public.crm_deals_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
begin
  select * into s from public.crm_pipeline_stages where id = new.stage_id;
  if s is null then raise exception 'Unknown pipeline stage'; end if;
  if s.pipeline_id <> new.pipeline_id then
    raise exception 'Stage does not belong to the deal''s pipeline';
  end if;
  if tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id then
    new.probability := s.probability;
    if s.is_won then
      new.status := 'won';
      new.actual_close_date := coalesce(new.actual_close_date, current_date);
    elsif s.is_lost then
      new.status := 'lost';
      new.actual_close_date := coalesce(new.actual_close_date, current_date);
    else
      new.status := 'open';
      new.actual_close_date := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists crm_deals_stage_rules on public.crm_deals;
create trigger crm_deals_stage_rules before insert or update on public.crm_deals
  for each row execute procedure public.crm_deals_before_write();

create or replace function public.crm_deals_after_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from text; v_to text;
begin
  if tg_op = 'INSERT' then
    perform public.crm_log('deal.created', 'deal', new.id, new.title,
      jsonb_build_object('value', new.value, 'currency', new.currency, 'stage_id', new.stage_id),
      new.company, new.contact_id, new.lead_id, new.id);
    if new.owner_id is not null then
      perform public.ws_notify(new.owner_id, 'deal.assigned', 'Deal assigned to you', new.title,
        '/deals/?id=' || new.id, 'deal', new.id);
    end if;
    return new;
  end if;

  if new.owner_id is distinct from old.owner_id then
    perform public.crm_log('deal.assigned', 'deal', new.id, new.title,
      jsonb_build_object('from', old.owner_id, 'to', new.owner_id), new.company, new.contact_id, new.lead_id, new.id);
    if new.owner_id is not null then
      perform public.ws_notify(new.owner_id, 'deal.assigned', 'Deal assigned to you', new.title,
        '/deals/?id=' || new.id, 'deal', new.id);
    end if;
  end if;
  if new.stage_id is distinct from old.stage_id then
    select name into v_from from public.crm_pipeline_stages where id = old.stage_id;
    select name into v_to   from public.crm_pipeline_stages where id = new.stage_id;
    perform public.crm_log('deal.stage_changed', 'deal', new.id, new.title,
      jsonb_build_object('from', v_from, 'to', v_to, 'from_id', old.stage_id, 'to_id', new.stage_id),
      new.company, new.contact_id, new.lead_id, new.id);
  end if;
  if new.status is distinct from old.status and new.status in ('won', 'lost') then
    perform public.crm_log('deal.' || new.status, 'deal', new.id, new.title,
      jsonb_build_object('value', new.value, 'currency', new.currency), new.company, new.contact_id, new.lead_id, new.id);
    if new.owner_id is not null and new.owner_id <> auth.uid() then
      perform public.ws_notify(new.owner_id, 'deal.' || new.status,
        'Deal marked ' || new.status, new.title, '/deals/?id=' || new.id, 'deal', new.id);
    end if;
  end if;
  if new.value is distinct from old.value then
    perform public.crm_log('deal.value_changed', 'deal', new.id, new.title,
      jsonb_build_object('from', old.value, 'to', new.value, 'currency', new.currency),
      new.company, new.contact_id, new.lead_id, new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists crm_deals_log on public.crm_deals;
create trigger crm_deals_log after insert or update on public.crm_deals
  for each row execute procedure public.crm_deals_after_change();

alter table public.crm_deals enable row level security;

drop policy if exists crm_deals_select on public.crm_deals;
create policy crm_deals_select on public.crm_deals
  for select to authenticated
  using ((select public.ws_same_company(company)));

drop policy if exists crm_deals_insert on public.crm_deals;
create policy crm_deals_insert on public.crm_deals
  for insert to authenticated
  with check ((select public.ws_same_company(company)) and created_by = auth.uid());

drop policy if exists crm_deals_update on public.crm_deals;
create policy crm_deals_update on public.crm_deals
  for update to authenticated
  using ((select public.ws_same_company(company))
         and (owner_id = auth.uid() or created_by = auth.uid() or (select public.ws_is_manager())))
  with check ((select public.ws_same_company(company)));

drop policy if exists crm_deals_delete on public.crm_deals;
create policy crm_deals_delete on public.crm_deals
  for delete to authenticated
  using ((select public.ws_same_company(company)) and (select public.ws_is_manager()));

-- Contact history: edits to the record itself.
create or replace function public.crm_contacts_after_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.crm_log('contact.created', 'contact', new.id, new.full_name,
      jsonb_build_object('organization', new.organization, 'source', new.source), new.company, new.id, new.lead_id);
    return new;
  end if;
  if new.owner_id is distinct from old.owner_id then
    perform public.crm_log('contact.assigned', 'contact', new.id, new.full_name,
      jsonb_build_object('from', old.owner_id, 'to', new.owner_id), new.company, new.id, new.lead_id);
    if new.owner_id is not null then
      perform public.ws_notify(new.owner_id, 'contact.assigned', 'Contact assigned to you', new.full_name,
        '/contacts/?id=' || new.id, 'contact', new.id);
    end if;
  end if;
  if new.status is distinct from old.status then
    perform public.crm_log('contact.status_changed', 'contact', new.id, new.full_name,
      jsonb_build_object('from', old.status, 'to', new.status), new.company, new.id, new.lead_id);
  elsif row(new.first_name, new.last_name, new.organization, new.job_title, new.email, new.email2, new.phone, new.phone2,
            new.address, new.city, new.state, new.country, new.postal_code, new.website, new.source, new.tags)
        is distinct from
        row(old.first_name, old.last_name, old.organization, old.job_title, old.email, old.email2, old.phone, old.phone2,
            old.address, old.city, old.state, old.country, old.postal_code, old.website, old.source, old.tags) then
    perform public.crm_log('contact.updated', 'contact', new.id, new.full_name, '{}'::jsonb, new.company, new.id, new.lead_id);
  end if;
  return new;
end;
$$;

drop trigger if exists crm_contacts_log on public.crm_contacts;
create trigger crm_contacts_log after insert or update on public.crm_contacts
  for each row execute procedure public.crm_contacts_after_change();

-- ---------------------------------------------------------------------------
-- 10) Lead conversion, in one transaction.
--
-- Creates or links a contact (matching an existing contact by email or phone
-- inside the same company rather than duplicating it), optionally creates a
-- deal, and stamps the lead as converted with both links. The lead row is
-- kept, so the conversion history survives.
-- ---------------------------------------------------------------------------
create or replace function public.crm_convert_lead(
  p_lead_id uuid,
  p_contact_id uuid default null,             -- link to this existing contact instead of creating one
  p_create_deal boolean default true,
  p_deal_title text default null,
  p_deal_value numeric default null,
  p_pipeline_id uuid default null,
  p_stage_id uuid default null,
  p_expected_close date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  l          public.crm_leads%rowtype;
  v_contact  uuid;
  v_deal     uuid;
  v_pipeline uuid;
  v_stage    uuid;
  v_first    text;
  v_last     text;
  v_existing boolean := false;
begin
  select * into l from public.crm_leads where id = p_lead_id for update;
  if l is null then raise exception 'Lead not found'; end if;
  if not public.ws_same_company(l.company) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if not (l.owner_id = auth.uid() or l.created_by = auth.uid() or public.ws_is_manager()) then
    raise exception 'Only the lead owner or a manager can convert it' using errcode = '42501';
  end if;
  if l.status = 'converted' then raise exception 'Lead is already converted'; end if;

  -- 1) Contact: explicit link, else a match on email/phone, else a new record.
  if p_contact_id is not null then
    select id into v_contact from public.crm_contacts
     where id = p_contact_id and public.ws_same_company(company);
    if v_contact is null then raise exception 'Contact not found'; end if;
    v_existing := true;
  else
    select id into v_contact from public.crm_contacts c
     where c.company is not distinct from l.company and c.status <> 'archived'
       and ((l.email is not null and lower(c.email) = lower(l.email))
            or (l.phone is not null and c.phone = l.phone))
     order by c.created_at limit 1;
    if v_contact is not null then
      v_existing := true;
    else
      v_first := split_part(btrim(l.name), ' ', 1);
      v_last  := nullif(btrim(substr(btrim(l.name), length(v_first) + 1)), '');
      insert into public.crm_contacts
        (company, first_name, last_name, organization, email, phone, source, owner_id, notes, tags, lead_id, created_by)
      values
        (l.company, v_first, v_last, l.organization, l.email, l.phone, l.source,
         coalesce(l.owner_id, auth.uid()), l.notes, l.tags, l.id, auth.uid())
      returning id into v_contact;
    end if;
  end if;

  -- 2) Deal (optional).
  if p_create_deal then
    v_pipeline := p_pipeline_id;
    if v_pipeline is null then
      select id into v_pipeline from public.crm_pipelines
       where (company = l.company or company is null)
       order by (company = l.company) desc nulls last, is_default desc, created_at limit 1;
    end if;
    if v_pipeline is null then raise exception 'No pipeline configured'; end if;
    v_stage := p_stage_id;
    if v_stage is null then
      select id into v_stage from public.crm_pipeline_stages
       where pipeline_id = v_pipeline and not is_won and not is_lost
       order by position limit 1;
    end if;
    if v_stage is null then raise exception 'Pipeline has no open stage'; end if;
    insert into public.crm_deals
      (company, title, contact_id, organization, owner_id, pipeline_id, stage_id, value, currency,
       expected_close_date, source, description, lead_id, created_by)
    values
      (l.company, coalesce(nullif(btrim(p_deal_title), ''), l.name || ' deal'), v_contact, l.organization,
       coalesce(l.owner_id, auth.uid()), v_pipeline, v_stage, coalesce(p_deal_value, l.estimated_value, 0), l.currency,
       p_expected_close, l.source, l.notes, l.id, auth.uid())
    returning id into v_deal;
  end if;

  -- 3) Stamp the lead. The status change fires crm_leads_log -> 'lead.converted'.
  update public.crm_leads
     set status = 'converted', converted_at = now(), converted_by = auth.uid(),
         converted_contact_id = v_contact, converted_deal_id = v_deal
   where id = l.id;

  return jsonb_build_object('contact_id', v_contact, 'deal_id', v_deal, 'existing_contact', v_existing);
end;
$$;

grant execute on function public.crm_convert_lead(uuid, uuid, boolean, text, numeric, uuid, uuid, date) to authenticated;

-- Done. Next: supabase-work-migration.sql
