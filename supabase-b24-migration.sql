-- ============================================================================
-- Workspace upgrade: the structure behind the Bitrix24-style interface.
--
-- Run SIXTH, after supabase-crm-reminders-migration.sql. Idempotent; adds
-- only. No existing row is deleted. What it adds:
--
--   1. user_ui_settings / workspace_settings  per-user layout (menu order,
--      grid columns, saved filters, theme) and per-company settings
--   2. departments + department_members       the company structure (seeded
--      once from profiles.company / profiles.department)
--   3. numeric IDs on contacts, leads, deals, tasks, projects, companies
--   4. crm_companies                           customers as organisations
--   5. crm_custom_fields + custom jsonb        admin-defined fields per entity
--                                              and per deal pipeline
--   6. crm_products + crm_deal_products        catalogue and deal lines
--   7. crm_roles / crm_role_permissions /      the Access permissions matrix,
--      crm_role_assignments                    enforced by RLS on contacts,
--                                              companies, leads, deals and
--                                              invoices. Seeded with an
--                                              "Employee" and a "Manager"
--                                              role that reproduce the rules
--                                              in force before this file.
--   8. crm_automation_rules                    act when a lead or deal enters
--                                              a stage
--   9. project privacy (public/private/secret), join requests, member roles
--  10. task planner, task views (unread comments), task templates
--  11. feed posts, comments, reactions, views
--  12. whiteboards
--  13. drive: private / company / shared documents, native documents,
--      published links (public bucket "published")
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Interface settings
-- ---------------------------------------------------------------------------
create table if not exists public.user_ui_settings (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  key        text not null,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.user_ui_settings enable row level security;
drop policy if exists user_ui_settings_own on public.user_ui_settings;
create policy user_ui_settings_own on public.user_ui_settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- '*' = the whole group; otherwise one company (its logo, working hours...).
create table if not exists public.workspace_settings (
  company    text not null default '*',
  key        text not null,
  value      jsonb not null default '{}'::jsonb,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (company, key)
);
alter table public.workspace_settings enable row level security;
drop policy if exists workspace_settings_read on public.workspace_settings;
create policy workspace_settings_read on public.workspace_settings for select to authenticated
  using (company = '*' or (select public.ws_same_company(company)));
drop policy if exists workspace_settings_manage on public.workspace_settings;
create policy workspace_settings_manage on public.workspace_settings for all to authenticated
  using ((select public.ws_is_admin()) or (company <> '*' and (select public.ws_is_manager()) and (select public.ws_same_company(company))))
  with check ((select public.ws_is_admin()) or (company <> '*' and (select public.ws_is_manager()) and (select public.ws_same_company(company))));

-- An invite sent from the admin console: the person shows as "Invited" until
-- their first sign-in (presence stamps last_seen_at).
alter table public.profiles add column if not exists invited_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2) Company structure
-- ---------------------------------------------------------------------------
create table if not exists public.departments (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  parent_id  uuid references public.departments(id) on delete restrict,   -- move or delete children first
  company    text,                                                         -- null: the group root
  sort       int not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists departments_parent_idx on public.departments (parent_id, sort);
create index if not exists departments_company_idx on public.departments (company);

create table if not exists public.department_members (
  department_id uuid not null references public.departments(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  role          text not null default 'member',
  position      text,
  created_at    timestamptz not null default now(),
  primary key (department_id, user_id)
);
alter table public.department_members drop constraint if exists department_members_role_ck;
alter table public.department_members add constraint department_members_role_ck check (role in ('member', 'head', 'deputy'));
create index if not exists department_members_user_idx on public.department_members (user_id);
create unique index if not exists department_members_one_head_uidx on public.department_members (department_id) where role = 'head';

drop trigger if exists departments_touch on public.departments;
create trigger departments_touch before update on public.departments
  for each row execute procedure public.ws_touch_updated_at();

-- A department may not sit inside itself or inside one of its own descendants.
create or replace function public.departments_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception 'A department cannot be its own parent';
    end if;
    if exists (
      with recursive up(id, parent_id) as (
        select d.id, d.parent_id from public.departments d where d.id = new.parent_id
        union
        select d.id, d.parent_id from public.departments d join up on d.id = up.parent_id)
      select 1 from up where up.id = new.id) then
      raise exception 'A department cannot sit inside its own sub-department';
    end if;
  end if;
  if new.created_by is null then new.created_by := auth.uid(); end if;
  return new;
end;
$$;
drop trigger if exists departments_rules on public.departments;
create trigger departments_rules before insert or update on public.departments
  for each row execute procedure public.departments_before_write();

/** The departments the caller belongs to. */
create or replace function public.ws_my_departments()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(department_id), '{}') from public.department_members where user_id = auth.uid();
$$;

/** Those departments plus every department below them. */
create or replace function public.ws_department_subtree(p_roots uuid[])
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  with recursive t(id) as (
    select unnest(coalesce(p_roots, '{}'::uuid[]))
    union
    select d.id from public.departments d join t on d.parent_id = t.id)
  select coalesce(array_agg(id), '{}') from t;
$$;

/** The caller's departments and every department above them (a role given to a
    department also applies to the people in its sub-departments). */
create or replace function public.ws_my_dept_lineage()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  with recursive up(id, parent_id) as (
    select d.id, d.parent_id from public.departments d where d.id = any(public.ws_my_departments())
    union
    select d.id, d.parent_id from public.departments d join up on d.id = up.parent_id)
  select coalesce(array_agg(id), '{}') from up;
$$;

/** Everyone who shares a department with the caller. */
create or replace function public.ws_dept_peers()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct user_id), '{}') from public.department_members
   where department_id = any(public.ws_my_departments());
$$;

/** Everyone in the caller's departments and their sub-departments. */
create or replace function public.ws_subdept_peers()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct user_id), '{}') from public.department_members
   where department_id = any(public.ws_department_subtree(public.ws_my_departments()));
$$;

/** The caller's companies (primary and secondary role). */
create or replace function public.ws_my_companies()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select array_remove(array[p.company, p.company2], null) from public.profiles p where p.id = auth.uid()), '{}');
$$;

grant execute on function public.ws_my_departments(), public.ws_department_subtree(uuid[]), public.ws_my_dept_lineage(),
  public.ws_dept_peers(), public.ws_subdept_peers(), public.ws_my_companies() to authenticated;

alter table public.departments enable row level security;
alter table public.department_members enable row level security;

-- People see the group root and their own companies' structure; admins see all.
drop policy if exists departments_read on public.departments;
create policy departments_read on public.departments for select to authenticated
  using (company is null or (select public.ws_same_company(company)));
drop policy if exists departments_manage on public.departments;
create policy departments_manage on public.departments for all to authenticated
  using ((select public.ws_is_admin()) or (company is not null and (select public.ws_is_manager()) and (select public.ws_same_company(company))))
  with check ((select public.ws_is_admin()) or (company is not null and (select public.ws_is_manager()) and (select public.ws_same_company(company))));

drop policy if exists department_members_read on public.department_members;
create policy department_members_read on public.department_members for select to authenticated
  using (exists (select 1 from public.departments d where d.id = department_id));
drop policy if exists department_members_manage on public.department_members;
create policy department_members_manage on public.department_members for all to authenticated
  using (exists (select 1 from public.departments d where d.id = department_id
                   and (public.ws_is_admin() or (d.company is not null and public.ws_is_manager() and public.ws_same_company(d.company)))))
  with check (exists (select 1 from public.departments d where d.id = department_id
                   and (public.ws_is_admin() or (d.company is not null and public.ws_is_manager() and public.ws_same_company(d.company)))));

-- Seed once from what WorkSuite already knows: group > company > department.
do $$
declare
  v_root uuid;
  v_co   uuid;
  r      record;
  d      record;
begin
  if exists (select 1 from public.departments) then return; end if;
  if not exists (select 1 from public.profiles where company is not null) then return; end if;
  insert into public.departments (name, company, sort) values ('Corporate Group', null, 0) returning id into v_root;
  for r in select distinct company from public.profiles where company is not null order by company loop
    insert into public.departments (name, parent_id, company) values (r.company, v_root, r.company) returning id into v_co;
    for d in select distinct btrim(department) as name from public.profiles
              where company = r.company and nullif(btrim(department), '') is not null order by 1 loop
      insert into public.departments (name, parent_id, company) values (d.name, v_co, r.company);
    end loop;
    insert into public.department_members (department_id, user_id)
    select coalesce((select x.id from public.departments x where x.parent_id = v_co and x.name = btrim(p.department) limit 1), v_co), p.id
      from public.profiles p where p.company = r.company
    on conflict do nothing;
  end loop;
end$$;

-- ---------------------------------------------------------------------------
-- 3) Customers as organisations
-- ---------------------------------------------------------------------------
create table if not exists public.crm_companies (
  id           uuid primary key default gen_random_uuid(),
  company      text,                                  -- the owning WorkSuite company
  title        text not null,
  company_type text not null default 'customer',
  industry     text,
  employees    text,
  revenue      numeric(16,2),
  currency     text not null default 'INR',
  phone        text,
  email        text,
  website      text,
  address      text,
  city         text,
  state        text,
  country      text,
  postal_code  text,
  owner_id     uuid references public.profiles(id) on delete set null,
  status       text not null default 'active',
  tags         text[] not null default '{}',
  notes        text,
  custom       jsonb not null default '{}'::jsonb,
  archived_at  timestamptz,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.crm_companies drop constraint if exists crm_companies_type_ck;
alter table public.crm_companies add constraint crm_companies_type_ck
  check (company_type in ('customer', 'partner', 'supplier', 'competitor', 'reseller', 'other'));
alter table public.crm_companies drop constraint if exists crm_companies_status_ck;
alter table public.crm_companies add constraint crm_companies_status_ck check (status in ('active', 'inactive', 'archived'));
create index if not exists crm_companies_company_idx on public.crm_companies (company, status);
create index if not exists crm_companies_owner_idx on public.crm_companies (owner_id);
create index if not exists crm_companies_title_idx on public.crm_companies (lower(title));

drop trigger if exists crm_companies_fill on public.crm_companies;
create trigger crm_companies_fill before insert on public.crm_companies
  for each row execute procedure public.ws_fill_owner_cols();
drop trigger if exists crm_companies_touch on public.crm_companies;
create trigger crm_companies_touch before update on public.crm_companies
  for each row execute procedure public.ws_touch_updated_at();

create or replace function public.crm_companies_after_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.crm_log('company.created', 'company', new.id, new.title, jsonb_build_object('type', new.company_type), new.company);
    if new.owner_id is not null then
      perform public.ws_notify(new.owner_id, 'company.assigned', 'Company assigned to you', new.title, '/companies/?id=' || new.id, 'company', new.id);
    end if;
    return new;
  end if;
  if new.owner_id is distinct from old.owner_id then
    perform public.crm_log('company.assigned', 'company', new.id, new.title, jsonb_build_object('from', old.owner_id, 'to', new.owner_id), new.company);
    if new.owner_id is not null then
      perform public.ws_notify(new.owner_id, 'company.assigned', 'Company assigned to you', new.title, '/companies/?id=' || new.id, 'company', new.id);
    end if;
  elsif row(new.title, new.company_type, new.industry, new.phone, new.email, new.website, new.address, new.custom)
        is distinct from row(old.title, old.company_type, old.industry, old.phone, old.email, old.website, old.address, old.custom) then
    perform public.crm_log('company.updated', 'company', new.id, new.title, '{}'::jsonb, new.company);
  end if;
  return new;
end;
$$;
drop trigger if exists crm_companies_log on public.crm_companies;
create trigger crm_companies_log after insert or update on public.crm_companies
  for each row execute procedure public.crm_companies_after_change();

alter table public.crm_contacts add column if not exists company_id uuid references public.crm_companies(id) on delete set null;
alter table public.crm_deals    add column if not exists company_id uuid references public.crm_companies(id) on delete set null;
alter table public.crm_leads    add column if not exists company_id uuid references public.crm_companies(id) on delete set null;
alter table public.invoices     add column if not exists company_id uuid references public.crm_companies(id) on delete set null;
create index if not exists crm_contacts_company_ref_idx on public.crm_contacts (company_id) where company_id is not null;
create index if not exists crm_deals_company_ref_idx on public.crm_deals (company_id) where company_id is not null;
create index if not exists invoices_company_ref_idx on public.invoices (company_id) where company_id is not null;

-- Invoices get a responsible person and a subject, as in the CRM grid.
alter table public.invoices add column if not exists responsible_id uuid references public.profiles(id) on delete set null;
alter table public.invoices add column if not exists subject text;
update public.invoices set responsible_id = created_by where responsible_id is null and created_by is not null;
create or replace function public.invoices_fill_responsible()
returns trigger
language plpgsql
as $$
begin
  if new.responsible_id is null then new.responsible_id := coalesce(new.created_by, auth.uid()); end if;
  return new;
end;
$$;
drop trigger if exists invoices_fill_responsible on public.invoices;
create trigger invoices_fill_responsible before insert on public.invoices
  for each row execute procedure public.invoices_fill_responsible();

-- ---------------------------------------------------------------------------
-- 4) Numeric IDs (the "ID" column in grids). Existing rows are numbered in the
--    order they were created.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['crm_contacts', 'crm_leads', 'crm_deals', 'crm_companies', 'tasks', 'projects'] loop
    execute format('create sequence if not exists public.%I', t || '_number_seq');
    execute format('grant usage, select on sequence public.%I to authenticated', t || '_number_seq');
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = 'number') then
      execute format('alter table public.%I add column number bigint', t);
      execute format('update public.%I x set number = s.n from (select id, row_number() over (order by created_at, id) n from public.%I) s where x.id = s.id', t, t);
      execute format('select setval(%L, coalesce((select max(number) from public.%I), 0) + 1, false)', 'public.' || t || '_number_seq', t);
    end if;
    execute format('alter table public.%I alter column number set default nextval(%L)', t, 'public.' || t || '_number_seq');
    execute format('create unique index if not exists %I on public.%I (number)', t || '_number_uidx', t);
  end loop;
end$$;

-- ---------------------------------------------------------------------------
-- 5) Custom fields
-- ---------------------------------------------------------------------------
create table if not exists public.crm_custom_fields (
  id             uuid primary key default gen_random_uuid(),
  company        text,                                    -- null: every company
  entity         text not null,
  pipeline_id    uuid references public.crm_pipelines(id) on delete cascade,   -- deals: one pipeline, or null for all
  code           text not null,
  label          text not null,
  field_type     text not null default 'string',
  options        jsonb not null default '[]'::jsonb,      -- list items: [{"value": "...", "label": "...", "color": "..."}]
  required       boolean not null default false,
  show_in_list   boolean not null default true,
  show_in_filter boolean not null default true,
  section        text not null default 'Additional',
  sort           int not null default 100,
  archived_at    timestamptz,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
alter table public.crm_custom_fields drop constraint if exists crm_custom_fields_entity_ck;
alter table public.crm_custom_fields add constraint crm_custom_fields_entity_ck
  check (entity in ('lead', 'deal', 'contact', 'company', 'invoice'));
alter table public.crm_custom_fields drop constraint if exists crm_custom_fields_type_ck;
alter table public.crm_custom_fields add constraint crm_custom_fields_type_ck
  check (field_type in ('string', 'text', 'number', 'money', 'date', 'datetime', 'boolean', 'list', 'multilist', 'employee', 'url', 'email', 'phone'));
alter table public.crm_custom_fields drop constraint if exists crm_custom_fields_code_ck;
alter table public.crm_custom_fields add constraint crm_custom_fields_code_ck check (code ~ '^[a-z][a-z0-9_]{0,48}$');
create unique index if not exists crm_custom_fields_code_uidx
  on public.crm_custom_fields (entity, coalesce(pipeline_id::text, '*'), coalesce(company, '*'), code);
create index if not exists crm_custom_fields_entity_idx on public.crm_custom_fields (entity, sort);

-- Only the creator is filled in: here a null company means "every company".
create or replace function public.ws_fill_creator()
returns trigger
language plpgsql
as $$
begin
  if new.created_by is null then new.created_by := auth.uid(); end if;
  return new;
end;
$$;
drop trigger if exists crm_custom_fields_fill on public.crm_custom_fields;
create trigger crm_custom_fields_fill before insert on public.crm_custom_fields
  for each row execute procedure public.ws_fill_creator();
drop trigger if exists crm_custom_fields_touch on public.crm_custom_fields;
create trigger crm_custom_fields_touch before update on public.crm_custom_fields
  for each row execute procedure public.ws_touch_updated_at();

alter table public.crm_custom_fields enable row level security;
drop policy if exists crm_custom_fields_read on public.crm_custom_fields;
create policy crm_custom_fields_read on public.crm_custom_fields for select to authenticated
  using (company is null or (select public.ws_same_company(company)));
-- Managed under the roles' "CRM settings" permission (created further down;
-- the policy is attached there).

alter table public.crm_contacts  add column if not exists custom jsonb not null default '{}'::jsonb;
alter table public.crm_leads     add column if not exists custom jsonb not null default '{}'::jsonb;
alter table public.crm_deals     add column if not exists custom jsonb not null default '{}'::jsonb;
alter table public.invoices      add column if not exists custom jsonb not null default '{}'::jsonb;
do $$
declare t text;
begin
  foreach t in array array['crm_contacts', 'crm_leads', 'crm_deals', 'crm_companies', 'invoices'] loop
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_custom_ck');
    execute format('alter table public.%I add constraint %I check (jsonb_typeof(custom) = ''object'')', t, t || '_custom_ck');
    execute format('create index if not exists %I on public.%I using gin (custom)', t || '_custom_gin', t);
  end loop;
end$$;

-- ---------------------------------------------------------------------------
-- 6) Products
-- ---------------------------------------------------------------------------
create table if not exists public.crm_products (
  id          uuid primary key default gen_random_uuid(),
  company     text,
  name        text not null,
  sku         text,
  description text,
  price       numeric(14,2) not null default 0,
  currency    text not null default 'INR',
  tax_rate    numeric(5,2) not null default 0,
  unit        text not null default 'pcs',
  active      boolean not null default true,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.crm_products drop constraint if exists crm_products_price_ck;
alter table public.crm_products add constraint crm_products_price_ck check (price >= 0 and tax_rate between 0 and 100);
create index if not exists crm_products_company_idx on public.crm_products (company, active);
drop trigger if exists crm_products_fill on public.crm_products;
create trigger crm_products_fill before insert on public.crm_products
  for each row execute procedure public.ws_fill_owner_cols();
drop trigger if exists crm_products_touch on public.crm_products;
create trigger crm_products_touch before update on public.crm_products
  for each row execute procedure public.ws_touch_updated_at();

create table if not exists public.crm_deal_products (
  id           uuid primary key default gen_random_uuid(),
  deal_id      uuid not null references public.crm_deals(id) on delete cascade,
  product_id   uuid references public.crm_products(id) on delete set null,
  name         text not null,
  price        numeric(14,2) not null default 0,
  quantity     numeric(12,3) not null default 1,
  discount_pct numeric(5,2) not null default 0,
  tax_rate     numeric(5,2) not null default 0,
  line_total   numeric(14,2) not null default 0,
  position     int not null default 0,
  created_at   timestamptz not null default now()
);
alter table public.crm_deal_products drop constraint if exists crm_deal_products_values_ck;
alter table public.crm_deal_products add constraint crm_deal_products_values_ck
  check (price >= 0 and quantity >= 0 and discount_pct between 0 and 100 and tax_rate between 0 and 100);
create index if not exists crm_deal_products_deal_idx on public.crm_deal_products (deal_id, position);

-- The deal amount follows its products unless someone typed an amount by hand.
alter table public.crm_deals add column if not exists amount_from_products boolean not null default false;

create or replace function public.crm_deal_products_before_write()
returns trigger
language plpgsql
as $$
declare
  v_sub numeric(14,2); v_disc numeric(14,2); v_tax numeric(14,2);
begin
  -- Same arithmetic as invoice lines (ui/crm-logic.js invoiceLine).
  v_sub  := round(new.quantity * new.price, 2);
  v_disc := round(v_sub * new.discount_pct / 100, 2);
  v_tax  := round((v_sub - v_disc) * new.tax_rate / 100, 2);
  new.line_total := v_sub - v_disc + v_tax;
  return new;
end;
$$;
drop trigger if exists crm_deal_products_compute on public.crm_deal_products;
create trigger crm_deal_products_compute before insert or update on public.crm_deal_products
  for each row execute procedure public.crm_deal_products_before_write();

create or replace function public.crm_deal_products_after_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_deal uuid := coalesce(new.deal_id, old.deal_id);
begin
  update public.crm_deals d
     set value = coalesce((select sum(line_total) from public.crm_deal_products where deal_id = v_deal), 0)
   where d.id = v_deal and d.amount_from_products;
  return null;
end;
$$;
drop trigger if exists crm_deal_products_total on public.crm_deal_products;
create trigger crm_deal_products_total after insert or update or delete on public.crm_deal_products
  for each row execute procedure public.crm_deal_products_after_change();

-- ---------------------------------------------------------------------------
-- 7) Access permissions (roles)
--
-- Levels, weakest to strongest:
--   none            no access
--   own             records the person owns (responsible) or created
--   department      ... or that anyone in their departments owns or created
--   subdepartments  ... or that anyone in their departments' sub-departments does
--   all             every record of their company (companies stay isolated)
-- A person's level for an entity + action is the strongest level any of their
-- roles gives them. Roles are given to a person, a department (and so to its
-- sub-departments), everyone, or a workspace role (employee / manager).
-- Workspace admins always have "all", across companies.
-- ---------------------------------------------------------------------------
create table if not exists public.crm_roles (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  is_system   boolean not null default false,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
drop trigger if exists crm_roles_touch on public.crm_roles;
create trigger crm_roles_touch before update on public.crm_roles
  for each row execute procedure public.ws_touch_updated_at();

create table if not exists public.crm_role_permissions (
  id          uuid primary key default gen_random_uuid(),
  role_id     uuid not null references public.crm_roles(id) on delete cascade,
  entity      text not null,
  pipeline_id uuid references public.crm_pipelines(id) on delete cascade,     -- deals only; null = every pipeline
  action      text not null,
  level       text not null default 'none',
  extra       jsonb not null default '{}'::jsonb                                -- move_stage: {"stages": ["<stage id or lead status key>", ...]}
);
alter table public.crm_role_permissions drop constraint if exists crm_role_permissions_ck;
alter table public.crm_role_permissions add constraint crm_role_permissions_ck check (
  entity in ('contact', 'company', 'lead', 'deal', 'invoice', 'settings')
  and action in ('read', 'add', 'edit', 'delete', 'export', 'import', 'move_stage', 'view_amounts', 'custom_form', 'automation')
  and level in ('none', 'own', 'department', 'subdepartments', 'all'));
create unique index if not exists crm_role_permissions_uidx
  on public.crm_role_permissions (role_id, entity, coalesce(pipeline_id::text, '*'), action);
create index if not exists crm_role_permissions_lookup_idx on public.crm_role_permissions (entity, action);

create table if not exists public.crm_role_assignments (
  id             uuid primary key default gen_random_uuid(),
  role_id        uuid not null references public.crm_roles(id) on delete cascade,
  principal_type text not null,
  principal_id   uuid,              -- a profile id or a department id
  principal_key  text,              -- a workspace role: 'employee' | 'manager'
  created_at     timestamptz not null default now()
);
alter table public.crm_role_assignments drop constraint if exists crm_role_assignments_ck;
alter table public.crm_role_assignments add constraint crm_role_assignments_ck check (
  (principal_type = 'all' and principal_id is null and principal_key is null)
  or (principal_type in ('user', 'department') and principal_id is not null and principal_key is null)
  or (principal_type = 'app_role' and principal_key in ('employee', 'manager') and principal_id is null));
create unique index if not exists crm_role_assignments_uidx
  on public.crm_role_assignments (role_id, principal_type, coalesce(principal_id::text, principal_key, '*'));

alter table public.crm_roles enable row level security;
alter table public.crm_role_permissions enable row level security;
alter table public.crm_role_assignments enable row level security;
-- Everyone may read the roles (the interface hides what a person may not do);
-- only workspace admins change them.
drop policy if exists crm_roles_read on public.crm_roles;
create policy crm_roles_read on public.crm_roles for select to authenticated using (auth.uid() is not null);
drop policy if exists crm_roles_manage on public.crm_roles;
create policy crm_roles_manage on public.crm_roles for all to authenticated
  using ((select public.ws_is_admin())) with check ((select public.ws_is_admin()));
drop policy if exists crm_role_permissions_read on public.crm_role_permissions;
create policy crm_role_permissions_read on public.crm_role_permissions for select to authenticated using (auth.uid() is not null);
drop policy if exists crm_role_permissions_manage on public.crm_role_permissions;
create policy crm_role_permissions_manage on public.crm_role_permissions for all to authenticated
  using ((select public.ws_is_admin())) with check ((select public.ws_is_admin()));
drop policy if exists crm_role_assignments_read on public.crm_role_assignments;
create policy crm_role_assignments_read on public.crm_role_assignments for select to authenticated using (auth.uid() is not null);
drop policy if exists crm_role_assignments_manage on public.crm_role_assignments;
create policy crm_role_assignments_manage on public.crm_role_assignments for all to authenticated
  using ((select public.ws_is_admin())) with check ((select public.ws_is_admin()));

create or replace function public.ws_crm_rank(p_level text)
returns int
language sql
immutable
as $$
  select case p_level when 'all' then 4 when 'subdepartments' then 3 when 'department' then 2 when 'own' then 1 else 0 end;
$$;
create or replace function public.ws_crm_level_name(p_rank int)
returns text
language sql
immutable
as $$
  select case p_rank when 4 then 'all' when 3 then 'subdepartments' when 2 then 'department' when 1 then 'own' else 'none' end;
$$;

/** {"*": level, "<pipeline id>": level} for the caller, computed once per statement.
    Within one role a pipeline's own row replaces that role's all-pipelines row
    (so a role can be shut out of one pipeline); across roles the strongest wins. */
create or replace function public.ws_crm_levels(p_entity text, p_action text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select p.role_id, p.pipeline_id, public.ws_crm_rank(p.level) r
      from public.crm_role_permissions p
      join public.crm_role_assignments a on a.role_id = p.role_id
     where p.entity = p_entity and p.action = p_action
       and (a.principal_type = 'all'
            or (a.principal_type = 'user' and a.principal_id = auth.uid())
            or (a.principal_type = 'app_role' and a.principal_key = public.ws_role())
            or (a.principal_type = 'department' and a.principal_id = any(public.ws_my_dept_lineage())))),
  roles as (select role_id, max(r) filter (where pipeline_id is null) star from mine group by role_id),
  pipes as (select distinct pipeline_id from mine where pipeline_id is not null),
  per as (
    select pp.pipeline_id,
           max(coalesce((select max(m.r) from mine m where m.role_id = ro.role_id and m.pipeline_id = pp.pipeline_id), ro.star, 0)) r
      from pipes pp cross join roles ro
     group by pp.pipeline_id)
  select case when public.ws_is_admin() then jsonb_build_object('*', 'all')
    else jsonb_build_object('*', public.ws_crm_level_name(coalesce((select max(star) from roles), 0)))
         || coalesce((select jsonb_object_agg(pipeline_id::text, public.ws_crm_level_name(r)) from per), '{}'::jsonb) end;
$$;

/** The rank that applies to one pipeline: its own entry when a role mentions it, else the all-pipelines level. */
create or replace function public.ws_crm_rank_for(p_levels jsonb, p_pipeline uuid)
returns int
language sql
immutable
as $$
  select public.ws_crm_rank(case when p_pipeline is not null and p_levels ? p_pipeline::text
                                 then p_levels ->> p_pipeline::text else p_levels ->> '*' end);
$$;

/** Does a level allow this row? Every argument that does not change per row is
    computed once by the policy ((select ...) initplans). */
create or replace function public.ws_crm_row_ok(p_levels jsonb, p_pipeline uuid, p_company text, p_owner uuid, p_creator uuid,
                                                p_peers uuid[], p_subpeers uuid[], p_companies text[], p_admin boolean)
returns boolean
language sql
stable
as $$
  select coalesce(p_admin, false) or coalesce(
    p_company = any(coalesce(p_companies, '{}'))
    and case public.ws_crm_rank_for(p_levels, p_pipeline)
      when 4 then true
      when 3 then p_owner = auth.uid() or p_creator = auth.uid() or p_owner = any(p_subpeers) or p_creator = any(p_subpeers)
      when 2 then p_owner = auth.uid() or p_creator = auth.uid() or p_owner = any(p_peers) or p_creator = any(p_peers)
      when 1 then p_owner = auth.uid() or p_creator = auth.uid()
      else false end, false);
$$;

/** One-off check for functions and triggers (not for policies: it recomputes everything). */
create or replace function public.ws_crm_can(p_entity text, p_action text, p_pipeline uuid, p_company text, p_owner uuid, p_creator uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.ws_crm_row_ok(public.ws_crm_levels(p_entity, p_action), p_pipeline, p_company, p_owner, p_creator,
                              public.ws_dept_peers(), public.ws_subdept_peers(), public.ws_my_companies(), public.ws_is_admin());
$$;

/** May the caller create a record of this entity (in this pipeline)? */
create or replace function public.ws_crm_can_add(p_entity text, p_pipeline uuid default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.ws_crm_rank_for(public.ws_crm_levels(p_entity, 'add'), p_pipeline) > 0;
$$;

/** May the caller move a record of this entity into this stage? */
create or replace function public.ws_crm_stage_allowed(p_entity text, p_pipeline uuid, p_stage text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.ws_is_admin() or (
    public.ws_crm_rank_for(public.ws_crm_levels(p_entity, 'move_stage'), p_pipeline) > 0
    and (
      -- No role limits the stages, or one of them lists this stage.
      not exists (select 1 from public.crm_role_permissions p join public.crm_role_assignments a on a.role_id = p.role_id
                   where p.entity = p_entity and p.action = 'move_stage' and p.level <> 'none'
                     and (p.pipeline_id is null or p.pipeline_id = p_pipeline)
                     and jsonb_array_length(coalesce(p.extra -> 'stages', '[]'::jsonb)) > 0
                     and (a.principal_type = 'all' or (a.principal_type = 'user' and a.principal_id = auth.uid())
                          or (a.principal_type = 'app_role' and a.principal_key = public.ws_role())
                          or (a.principal_type = 'department' and a.principal_id = any(public.ws_my_dept_lineage()))))
      or exists (select 1 from public.crm_role_permissions p join public.crm_role_assignments a on a.role_id = p.role_id
                  where p.entity = p_entity and p.action = 'move_stage' and p.level <> 'none'
                    and (p.pipeline_id is null or p.pipeline_id = p_pipeline)
                    and (jsonb_array_length(coalesce(p.extra -> 'stages', '[]'::jsonb)) = 0 or p.extra -> 'stages' ? p_stage)
                    and (a.principal_type = 'all' or (a.principal_type = 'user' and a.principal_id = auth.uid())
                         or (a.principal_type = 'app_role' and a.principal_key = public.ws_role())
                         or (a.principal_type = 'department' and a.principal_id = any(public.ws_my_dept_lineage()))))));
$$;

grant execute on function public.ws_crm_rank(text), public.ws_crm_level_name(int), public.ws_crm_levels(text, text),
  public.ws_crm_rank_for(jsonb, uuid), public.ws_crm_row_ok(jsonb, uuid, text, uuid, uuid, uuid[], uuid[], text[], boolean),
  public.ws_crm_can(text, text, uuid, text, uuid, uuid), public.ws_crm_can_add(text, uuid),
  public.ws_crm_stage_allowed(text, uuid, text) to authenticated;

-- Seed two roles that reproduce the rules before this migration, so nothing
-- changes for anyone until an administrator edits the matrix.
do $$
declare
  v_emp uuid;
  v_mgr uuid;
begin
  if exists (select 1 from public.crm_roles) then return; end if;
  insert into public.crm_roles (name, description, is_system)
  values ('Employee', 'Everyone: see the company''s CRM records, edit what they own or created.', true) returning id into v_emp;
  insert into public.crm_roles (name, description, is_system)
  values ('Manager', 'Workspace managers: everything in their company.', true) returning id into v_mgr;
  insert into public.crm_role_permissions (role_id, entity, action, level)
  select v_emp, e, a,
         case when e = 'invoice' and a in ('read', 'view_amounts') then 'own'   -- invoices they are responsible for
              when e in ('invoice', 'settings') then 'none'
              when a in ('read', 'add', 'move_stage', 'view_amounts') then 'all'
              when a in ('edit', 'export') then 'own'
              else 'none' end
    from unnest(array['contact', 'company', 'lead', 'deal', 'invoice', 'settings']) e,
         unnest(array['read', 'add', 'edit', 'delete', 'export', 'import', 'move_stage', 'view_amounts', 'custom_form', 'automation']) a;
  insert into public.crm_role_permissions (role_id, entity, action, level)
  select v_mgr, e, a, 'all'
    from unnest(array['contact', 'company', 'lead', 'deal', 'invoice', 'settings']) e,
         unnest(array['read', 'add', 'edit', 'delete', 'export', 'import', 'move_stage', 'view_amounts', 'custom_form', 'automation']) a;
  insert into public.crm_role_assignments (role_id, principal_type) values (v_emp, 'all');
  insert into public.crm_role_assignments (role_id, principal_type, principal_key) values (v_mgr, 'app_role', 'manager');
end$$;

-- Custom fields: the "CRM settings / edit" permission, inside the caller's
-- company; fields shared by every company are for workspace admins.
drop policy if exists crm_custom_fields_manage on public.crm_custom_fields;
create policy crm_custom_fields_manage on public.crm_custom_fields for all to authenticated
  using ((select public.ws_is_admin())
         or (company = any((select public.ws_my_companies())::text[]) and public.ws_crm_rank((select public.ws_crm_levels('settings', 'edit')) ->> '*') > 0))
  with check ((select public.ws_is_admin())
         or (company = any((select public.ws_my_companies())::text[]) and public.ws_crm_rank((select public.ws_crm_levels('settings', 'edit')) ->> '*') > 0));

-- The CRM policies, now driven by the roles.
do $$
declare
  t record;
begin
  for t in select * from (values
      ('crm_contacts', 'contact', 'null::uuid', 'owner_id'),
      ('crm_companies', 'company', 'null::uuid', 'owner_id'),
      ('crm_leads', 'lead', 'null::uuid', 'owner_id'),
      ('crm_deals', 'deal', 'pipeline_id', 'owner_id'),
      ('invoices', 'invoice', 'null::uuid', 'responsible_id')) as v(tbl, entity, pipe, owner)
  loop
    execute format('drop policy if exists %I on public.%I', t.tbl || '_select', t.tbl);
    execute format($p$create policy %I on public.%I for select to authenticated using (
        public.ws_crm_row_ok((select public.ws_crm_levels(%L, 'read')), %s, company, %I, created_by,
          (select public.ws_dept_peers()), (select public.ws_subdept_peers()), (select public.ws_my_companies()), (select public.ws_is_admin())))$p$,
      t.tbl || '_select', t.tbl, t.entity, t.pipe, t.owner);
    execute format('drop policy if exists %I on public.%I', t.tbl || '_insert', t.tbl);
    execute format($p$create policy %I on public.%I for insert to authenticated with check (
        created_by = auth.uid()
        and ((select public.ws_is_admin()) or company = any((select public.ws_my_companies())::text[]))
        and public.ws_crm_rank_for((select public.ws_crm_levels(%L, 'add')), %s) > 0)$p$,
      t.tbl || '_insert', t.tbl, t.entity, t.pipe);
    execute format('drop policy if exists %I on public.%I', t.tbl || '_update', t.tbl);
    execute format($p$create policy %I on public.%I for update to authenticated using (
        public.ws_crm_row_ok((select public.ws_crm_levels(%L, 'edit')), %s, company, %I, created_by,
          (select public.ws_dept_peers()), (select public.ws_subdept_peers()), (select public.ws_my_companies()), (select public.ws_is_admin())))
        with check ((select public.ws_is_admin()) or company = any((select public.ws_my_companies())::text[]))$p$,
      t.tbl || '_update', t.tbl, t.entity, t.pipe, t.owner);
    execute format('drop policy if exists %I on public.%I', t.tbl || '_delete', t.tbl);
    execute format($p$create policy %I on public.%I for delete to authenticated using (
        public.ws_crm_row_ok((select public.ws_crm_levels(%L, 'delete')), %s, company, %I, created_by,
          (select public.ws_dept_peers()), (select public.ws_subdept_peers()), (select public.ws_my_companies()), (select public.ws_is_admin()))%s)$p$,
      t.tbl || '_delete', t.tbl, t.entity, t.pipe, t.owner, case when t.tbl = 'invoices' then ' and status = ''draft''' else '' end);
  end loop;
end$$;
alter table public.crm_companies enable row level security;

-- Invoice lines and payments follow the invoice.
create or replace function public.ws_invoice_editable(p_invoice uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.invoices i where i.id = p_invoice
                   and public.ws_crm_can('invoice', 'edit', null, i.company, i.responsible_id, i.created_by));
$$;
grant execute on function public.ws_invoice_editable(uuid) to authenticated;

drop policy if exists invoice_items_select on public.invoice_items;
create policy invoice_items_select on public.invoice_items for select to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_id));
drop policy if exists invoice_items_manage on public.invoice_items;
create policy invoice_items_manage on public.invoice_items for all to authenticated
  using (public.ws_invoice_editable(invoice_id)) with check (public.ws_invoice_editable(invoice_id));
drop policy if exists invoice_payments_select on public.invoice_payments;
create policy invoice_payments_select on public.invoice_payments for select to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_id));
drop policy if exists invoice_payments_insert on public.invoice_payments;
create policy invoice_payments_insert on public.invoice_payments for insert to authenticated
  with check (public.ws_invoice_editable(invoice_id));
drop policy if exists invoice_payments_delete on public.invoice_payments;
create policy invoice_payments_delete on public.invoice_payments for delete to authenticated
  using (public.ws_invoice_editable(invoice_id));

-- invoice_duplicate: now "may add an invoice and read the source".
create or replace function public.invoice_duplicate(p_invoice uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  src public.invoices%rowtype;
  v_new uuid;
begin
  select * into src from public.invoices where id = p_invoice;
  if src is null then raise exception 'Invoice not found'; end if;
  if not (public.ws_crm_can('invoice', 'read', null, src.company, src.responsible_id, src.created_by)
          and public.ws_crm_can_add('invoice') and (public.ws_is_admin() or src.company = any(public.ws_my_companies()))) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  insert into public.invoices (company, contact_id, company_id, deal_id, project_id, subject, bill_to_name, bill_to_address, bill_to_email,
                               invoice_date, due_date, status, currency, notes, terms, created_by, responsible_id)
  values (src.company, src.contact_id, src.company_id, src.deal_id, src.project_id, src.subject, src.bill_to_name, src.bill_to_address, src.bill_to_email,
          (now() at time zone 'Asia/Kolkata')::date,
          case when src.due_date is null then null else (now() at time zone 'Asia/Kolkata')::date + (src.due_date - src.invoice_date) end,
          'draft', src.currency, src.notes, src.terms, auth.uid(), auth.uid())
  returning id into v_new;
  insert into public.invoice_items (invoice_id, position, description, quantity, unit_price, discount_pct, tax_rate)
  select v_new, position, description, quantity, unit_price, discount_pct, tax_rate
    from public.invoice_items where invoice_id = p_invoice order by position;
  return v_new;
end;
$$;
grant execute on function public.invoice_duplicate(uuid) to authenticated;

-- Deal products follow the deal.
create or replace function public.ws_deal_editable(p_deal uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.crm_deals d where d.id = p_deal
                   and public.ws_crm_can('deal', 'edit', d.pipeline_id, d.company, d.owner_id, d.created_by));
$$;
grant execute on function public.ws_deal_editable(uuid) to authenticated;

alter table public.crm_products enable row level security;
alter table public.crm_deal_products enable row level security;
drop policy if exists crm_products_select on public.crm_products;
create policy crm_products_select on public.crm_products for select to authenticated
  using ((select public.ws_same_company(company)));
drop policy if exists crm_products_manage on public.crm_products;
create policy crm_products_manage on public.crm_products for all to authenticated
  using ((select public.ws_same_company(company)) and (select public.ws_is_manager()))
  with check ((select public.ws_same_company(company)) and (select public.ws_is_manager()));
drop policy if exists crm_deal_products_select on public.crm_deal_products;
create policy crm_deal_products_select on public.crm_deal_products for select to authenticated
  using (exists (select 1 from public.crm_deals d where d.id = deal_id));
drop policy if exists crm_deal_products_manage on public.crm_deal_products;
create policy crm_deal_products_manage on public.crm_deal_products for all to authenticated
  using (public.ws_deal_editable(deal_id)) with check (public.ws_deal_editable(deal_id));

-- Lead stages may be edited by managers too (they already edit pipelines).
drop policy if exists crm_lead_statuses_manage on public.crm_lead_statuses;
create policy crm_lead_statuses_manage on public.crm_lead_statuses for all to authenticated
  using ((select public.ws_is_manager())) with check ((select public.ws_is_manager()));
alter table public.crm_lead_statuses add column if not exists sort_order_locked boolean not null default false;

-- Stage restrictions from the matrix ("Move to stage").
create or replace function public.crm_stage_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') <> 'authenticated' then
    return new;
  end if;
  if tg_table_name = 'crm_deals' then
    if (tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id)
       and not public.ws_crm_stage_allowed('deal', new.pipeline_id, new.stage_id::text) then
      raise exception 'You may not move deals into this stage' using errcode = '42501';
    end if;
  else
    if tg_op = 'UPDATE' and new.status is distinct from old.status and new.status <> 'converted'
       and not public.ws_crm_stage_allowed('lead', null, new.status) then
      raise exception 'You may not move leads into this stage' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists crm_deals_stage_guard on public.crm_deals;
create trigger crm_deals_stage_guard before insert or update of stage_id on public.crm_deals
  for each row execute procedure public.crm_stage_guard();
drop trigger if exists crm_leads_stage_guard on public.crm_leads;
create trigger crm_leads_stage_guard before update of status on public.crm_leads
  for each row execute procedure public.crm_stage_guard();

-- Lead conversion: contact + company + deal, under the same permissions.
drop function if exists public.crm_convert_lead(uuid, uuid, boolean, text, numeric, uuid, uuid, date);
create or replace function public.crm_convert_lead(
  p_lead_id uuid,
  p_contact_id uuid default null,
  p_create_deal boolean default true,
  p_deal_title text default null,
  p_deal_value numeric default null,
  p_pipeline_id uuid default null,
  p_stage_id uuid default null,
  p_expected_close date default null,
  p_company_id uuid default null,
  p_create_company boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  l          public.crm_leads%rowtype;
  v_contact  uuid;
  v_company  uuid;
  v_deal     uuid;
  v_pipeline uuid;
  v_stage    uuid;
  v_first    text;
  v_last     text;
  v_existing boolean := false;
begin
  select * into l from public.crm_leads where id = p_lead_id for update;
  if l is null then raise exception 'Lead not found'; end if;
  if not public.ws_crm_can('lead', 'edit', null, l.company, l.owner_id, l.created_by) then
    raise exception 'Only the lead owner or a manager (or a role allowed to edit this lead) can convert it' using errcode = '42501';
  end if;
  if l.status = 'converted' then raise exception 'Lead is already converted'; end if;

  -- Company: explicit link, else a match on the name, else a new one (when the lead names an organisation).
  if p_company_id is not null then
    select id into v_company from public.crm_companies where id = p_company_id and public.ws_same_company(company);
    if v_company is null then raise exception 'Company not found'; end if;
  elsif nullif(btrim(l.organization), '') is not null then
    select id into v_company from public.crm_companies c
     where c.company is not distinct from l.company and c.status <> 'archived' and lower(c.title) = lower(btrim(l.organization))
     order by c.created_at limit 1;
    if v_company is null and p_create_company then
      if not public.ws_crm_can_add('company') then raise exception 'You may not create companies' using errcode = '42501'; end if;
      insert into public.crm_companies (company, title, owner_id, created_by, phone, email)
      values (l.company, btrim(l.organization), coalesce(l.owner_id, auth.uid()), auth.uid(), null, null)
      returning id into v_company;
    end if;
  end if;

  -- Contact: explicit link, else a match on email/phone, else a new record.
  if p_contact_id is not null then
    select id into v_contact from public.crm_contacts where id = p_contact_id and public.ws_same_company(company);
    if v_contact is null then raise exception 'Contact not found'; end if;
    v_existing := true;
  else
    select id into v_contact from public.crm_contacts c
     where c.company is not distinct from l.company and c.status <> 'archived'
       and ((l.email is not null and lower(c.email) = lower(l.email)) or (l.phone is not null and c.phone = l.phone))
     order by c.created_at limit 1;
    if v_contact is not null then
      v_existing := true;
    else
      if not public.ws_crm_can_add('contact') then raise exception 'You may not create contacts' using errcode = '42501'; end if;
      v_first := split_part(btrim(l.name), ' ', 1);
      v_last  := nullif(btrim(substr(btrim(l.name), length(v_first) + 1)), '');
      insert into public.crm_contacts
        (company, first_name, last_name, organization, company_id, email, phone, source, owner_id, notes, tags, lead_id, custom, created_by)
      values
        (l.company, v_first, v_last, l.organization, v_company, l.email, l.phone, l.source,
         coalesce(l.owner_id, auth.uid()), l.notes, l.tags, l.id, coalesce(l.custom, '{}'::jsonb), auth.uid())
      returning id into v_contact;
    end if;
  end if;
  if v_company is not null then
    update public.crm_contacts set company_id = v_company where id = v_contact and company_id is null;
  end if;

  if p_create_deal then
    -- The company's default pipeline, then the shared default, then anything else.
    v_pipeline := p_pipeline_id;
    if v_pipeline is null then
      select id into v_pipeline from public.crm_pipelines
       where (company = l.company or company is null)
       order by is_default desc, (company is not distinct from l.company) desc, created_at limit 1;
    end if;
    if v_pipeline is null then raise exception 'No pipeline configured'; end if;
    if not public.ws_crm_can_add('deal', v_pipeline) then raise exception 'You may not create deals in this pipeline' using errcode = '42501'; end if;
    v_stage := p_stage_id;
    if v_stage is null then
      select id into v_stage from public.crm_pipeline_stages
       where pipeline_id = v_pipeline and not is_won and not is_lost order by position limit 1;
    end if;
    if v_stage is null then raise exception 'Pipeline has no open stage'; end if;
    insert into public.crm_deals
      (company, title, contact_id, company_id, organization, owner_id, pipeline_id, stage_id, value, currency,
       expected_close_date, source, description, lead_id, created_by)
    values
      (l.company, coalesce(nullif(btrim(p_deal_title), ''), l.name || ' deal'), v_contact, v_company, l.organization,
       coalesce(l.owner_id, auth.uid()), v_pipeline, v_stage, coalesce(p_deal_value, l.estimated_value, 0), l.currency,
       p_expected_close, l.source, l.notes, l.id, auth.uid())
    returning id into v_deal;
  end if;

  update public.crm_leads
     set status = 'converted', converted_at = now(), converted_by = auth.uid(),
         converted_contact_id = v_contact, converted_deal_id = v_deal, company_id = coalesce(company_id, v_company)
   where id = l.id;

  return jsonb_build_object('contact_id', v_contact, 'deal_id', v_deal, 'company_id', v_company, 'existing_contact', v_existing);
end;
$$;
grant execute on function public.crm_convert_lead(uuid, uuid, boolean, text, numeric, uuid, uuid, date, uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 8) Automation rules: when a lead or deal enters a stage
-- ---------------------------------------------------------------------------
create table if not exists public.crm_automation_rules (
  id          uuid primary key default gen_random_uuid(),
  company     text,
  entity      text not null,
  pipeline_id uuid references public.crm_pipelines(id) on delete cascade,
  stage_key   text not null,              -- lead status key, or deal stage id
  action      text not null,
  params      jsonb not null default '{}'::jsonb,
  active      boolean not null default true,
  sort        int not null default 0,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.crm_automation_rules drop constraint if exists crm_automation_rules_ck;
alter table public.crm_automation_rules add constraint crm_automation_rules_ck check (
  entity in ('lead', 'deal') and action in ('create_task', 'notify', 'set_owner', 'add_comment', 'set_field'));
create index if not exists crm_automation_rules_lookup_idx on public.crm_automation_rules (entity, stage_key) where active;
drop trigger if exists crm_automation_rules_fill on public.crm_automation_rules;
create trigger crm_automation_rules_fill before insert on public.crm_automation_rules
  for each row execute procedure public.ws_fill_owner_cols();
drop trigger if exists crm_automation_rules_touch on public.crm_automation_rules;
create trigger crm_automation_rules_touch before update on public.crm_automation_rules
  for each row execute procedure public.ws_touch_updated_at();

alter table public.crm_automation_rules enable row level security;
drop policy if exists crm_automation_rules_read on public.crm_automation_rules;
create policy crm_automation_rules_read on public.crm_automation_rules for select to authenticated
  using ((select public.ws_same_company(company)));
drop policy if exists crm_automation_rules_manage on public.crm_automation_rules;
create policy crm_automation_rules_manage on public.crm_automation_rules for all to authenticated
  using ((select public.ws_same_company(company)) and public.ws_crm_rank_for((select public.ws_crm_levels(entity, 'automation')), pipeline_id) > 0)
  with check ((select public.ws_same_company(company)) and public.ws_crm_rank_for((select public.ws_crm_levels(entity, 'automation')), pipeline_id) > 0);

create or replace function public.crm_run_automation(p_entity text, p_row jsonb, p_stage text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r        record;
  v_n      int := 0;
  v_id     uuid := (p_row ->> 'id')::uuid;
  v_title  text := coalesce(p_row ->> 'title', p_row ->> 'name', '');
  v_owner  uuid := nullif(p_row ->> 'owner_id', '')::uuid;
  v_creator uuid := nullif(p_row ->> 'created_by', '')::uuid;
  v_target uuid;
  v_url    text := case p_entity when 'deal' then '/deals/?id=' else '/leads/?id=' end || (p_row ->> 'id');
begin
  -- A rule's own changes must not set off more rules.
  if current_setting('ws.automation', true) = '1' then return 0; end if;
  perform set_config('ws.automation', '1', true);
  for r in
    select * from public.crm_automation_rules a
     where a.active and a.entity = p_entity and a.stage_key = p_stage
       and a.company is not distinct from (p_row ->> 'company')
       and (a.pipeline_id is null or a.pipeline_id::text = p_row ->> 'pipeline_id')
     order by a.sort, a.created_at
  loop
    v_target := case coalesce(r.params ->> 'user', 'owner')
                  when 'owner' then v_owner when 'creator' then v_creator
                  else nullif(r.params ->> 'user', '')::uuid end;
    if r.action = 'create_task' then
      insert into public.tasks (company, title, description, priority, assignee_id, due_date, created_by,
                                lead_id, deal_id, contact_id)
      values (p_row ->> 'company', left(replace(coalesce(r.params ->> 'title', 'Follow up: {title}'), '{title}', v_title), 300),
              r.params ->> 'description', coalesce(r.params ->> 'priority', 'normal'), v_target,
              case when r.params ? 'due_days' then (now() at time zone 'Asia/Kolkata')::date + (r.params ->> 'due_days')::int end,
              coalesce(auth.uid(), v_creator),
              case when p_entity = 'lead' then v_id end, case when p_entity = 'deal' then v_id end,
              nullif(p_row ->> 'contact_id', '')::uuid);
    elsif r.action = 'notify' and v_target is not null then
      perform public.ws_notify(v_target, p_entity || '.automation',
        left(replace(coalesce(r.params ->> 'title', '{title} moved stage'), '{title}', v_title), 140),
        r.params ->> 'body', v_url, p_entity, v_id);
    elsif r.action = 'set_owner' and v_target is not null then
      if p_entity = 'deal' then update public.crm_deals set owner_id = v_target where id = v_id;
      else update public.crm_leads set owner_id = v_target where id = v_id; end if;
    elsif r.action = 'add_comment' then
      insert into public.comments (company, entity_type, entity_id, author_id, body)
      values (p_row ->> 'company', p_entity, v_id, coalesce(auth.uid(), v_creator),
              replace(coalesce(r.params ->> 'text', ''), '{title}', v_title));
    elsif r.action = 'set_field' and nullif(r.params ->> 'code', '') is not null then
      if p_entity = 'deal' then
        update public.crm_deals set custom = custom || jsonb_build_object(r.params ->> 'code', r.params -> 'value') where id = v_id;
      else
        update public.crm_leads set custom = custom || jsonb_build_object(r.params ->> 'code', r.params -> 'value') where id = v_id;
      end if;
    end if;
    perform public.crm_log('automation.ran', p_entity, v_id, v_title, jsonb_build_object('rule', r.id, 'action', r.action), p_row ->> 'company',
      null, case when p_entity = 'lead' then v_id end, case when p_entity = 'deal' then v_id end);
    v_n := v_n + 1;
  end loop;
  perform set_config('ws.automation', '', true);
  return v_n;
end;
$$;
revoke all on function public.crm_run_automation(text, jsonb, text) from public, anon, authenticated;

create or replace function public.crm_automation_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name = 'crm_deals' then
    if tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id then
      perform public.crm_run_automation('deal', to_jsonb(new), new.stage_id::text);
    end if;
  elsif tg_op = 'INSERT' or new.status is distinct from old.status then
    perform public.crm_run_automation('lead', to_jsonb(new), new.status);
  end if;
  return null;
end;
$$;
drop trigger if exists crm_deals_automation on public.crm_deals;
create trigger crm_deals_automation after insert or update of stage_id on public.crm_deals
  for each row execute procedure public.crm_automation_trigger();
drop trigger if exists crm_leads_automation on public.crm_leads;
create trigger crm_leads_automation after insert or update of status on public.crm_leads
  for each row execute procedure public.crm_automation_trigger();

-- ---------------------------------------------------------------------------
-- 9) Projects: privacy, member roles, join requests
-- ---------------------------------------------------------------------------
alter table public.projects add column if not exists privacy text not null default 'public';
alter table public.projects add column if not exists avatar_color text;
alter table public.projects add column if not exists goal text;              -- "Project goal" on the create page
-- Only a hex colour: the value is drawn into a style attribute. NOT VALID keeps any older rows as they are.
alter table public.projects drop constraint if exists projects_avatar_color_ck;
alter table public.projects add constraint projects_avatar_color_ck check (avatar_color is null or avatar_color ~ '^#[0-9A-Fa-f]{6}$') not valid;
alter table public.projects drop constraint if exists projects_privacy_ck;
alter table public.projects add constraint projects_privacy_ck check (privacy in ('public', 'private', 'secret'));
alter table public.project_members drop constraint if exists project_members_role_ck;
alter table public.project_members add constraint project_members_role_ck check (role in ('member', 'manager', 'moderator', 'owner'));

/** A secret project is invisible to everyone outside it (admins excepted). */
create or replace function public.ws_project_visible(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.projects p where p.id = p_project and public.ws_same_company(p.company)
                   and (p.privacy <> 'secret' or public.ws_on_project(p.id) or p.created_by = auth.uid() or public.ws_is_admin()));
$$;
/** Owner, project manager, moderators, the creator, or a workspace manager of the company. */
create or replace function public.ws_project_admin(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.projects p where p.id = p_project and public.ws_same_company(p.company)
                   and (p.owner_id = auth.uid() or p.manager_id = auth.uid() or p.created_by = auth.uid() or public.ws_is_manager()
                        or exists (select 1 from public.project_members m where m.project_id = p.id and m.user_id = auth.uid()
                                     and m.role in ('owner', 'manager', 'moderator'))));
$$;
grant execute on function public.ws_project_visible(uuid), public.ws_project_admin(uuid) to authenticated;

drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects for select to authenticated
  using ((select public.ws_same_company(company))
         and (privacy <> 'secret' or public.ws_on_project(id) or created_by = auth.uid() or (select public.ws_is_admin())));

drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select to authenticated
  using ((select public.ws_same_company(company)) and (project_id is null or public.ws_project_visible(project_id)));

-- Anyone in the company may join a public project, and anyone may leave.
drop policy if exists project_members_join on public.project_members;
create policy project_members_join on public.project_members for insert to authenticated
  with check (user_id = auth.uid() and role = 'member'
              and exists (select 1 from public.projects p where p.id = project_id and p.privacy = 'public' and public.ws_same_company(p.company)));
drop policy if exists project_members_leave on public.project_members;
create policy project_members_leave on public.project_members for delete to authenticated
  using (user_id = auth.uid());

create table if not exists public.project_join_requests (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  message     text,
  status      text not null default 'pending',
  decided_by  uuid references public.profiles(id) on delete set null,
  decided_at  timestamptz,
  created_at  timestamptz not null default now()
);
alter table public.project_join_requests drop constraint if exists project_join_requests_status_ck;
alter table public.project_join_requests add constraint project_join_requests_status_ck
  check (status in ('pending', 'approved', 'rejected', 'cancelled'));
create unique index if not exists project_join_requests_pending_uidx on public.project_join_requests (project_id, user_id) where status = 'pending';

alter table public.project_join_requests enable row level security;
drop policy if exists project_join_requests_select on public.project_join_requests;
create policy project_join_requests_select on public.project_join_requests for select to authenticated
  using (user_id = auth.uid() or public.ws_project_admin(project_id));
drop policy if exists project_join_requests_insert on public.project_join_requests;
create policy project_join_requests_insert on public.project_join_requests for insert to authenticated
  with check (user_id = auth.uid() and status = 'pending'
              and exists (select 1 from public.projects p where p.id = project_id and p.privacy = 'private' and public.ws_same_company(p.company)));
drop policy if exists project_join_requests_update on public.project_join_requests;
create policy project_join_requests_update on public.project_join_requests for update to authenticated
  using ((user_id = auth.uid() and status = 'pending') or public.ws_project_admin(project_id))
  with check (public.ws_project_admin(project_id) or (user_id = auth.uid() and status in ('pending', 'cancelled')));

create or replace function public.project_join_requests_after_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare p record; u uuid;
begin
  select id, name, owner_id, manager_id, created_by into p from public.projects where id = new.project_id;
  if tg_op = 'INSERT' then
    for u in select x from (select p.owner_id x union select p.manager_id union select p.created_by
                            union select user_id from public.project_members where project_id = p.id and role in ('owner', 'manager', 'moderator')) s
              where x is not null loop
      perform public.ws_notify(u, 'project.join_request', 'Request to join ' || p.name,
        (select full_name from public.profiles where id = new.user_id), '/projects/?id=' || p.id, 'project', p.id);
    end loop;
    return new;
  end if;
  if new.status = 'approved' and old.status = 'pending' then
    insert into public.project_members (project_id, user_id, role, added_by) values (new.project_id, new.user_id, 'member', auth.uid())
    on conflict do nothing;
    perform public.ws_notify(new.user_id, 'project.join_approved', 'You joined ' || p.name, null, '/projects/?id=' || p.id, 'project', p.id);
  elsif new.status = 'rejected' and old.status = 'pending' then
    perform public.ws_notify(new.user_id, 'project.join_rejected', 'Request to join ' || p.name || ' was declined', null, '/projects/', 'project', p.id);
  end if;
  return new;
end;
$$;
drop trigger if exists project_join_requests_notify on public.project_join_requests;
create trigger project_join_requests_notify after insert or update on public.project_join_requests
  for each row execute procedure public.project_join_requests_after_change();

create or replace function public.project_join_requests_before_update()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status and new.status in ('approved', 'rejected') then
    new.decided_by := auth.uid(); new.decided_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists project_join_requests_stamp on public.project_join_requests;
create trigger project_join_requests_stamp before update on public.project_join_requests
  for each row execute procedure public.project_join_requests_before_update();

-- ---------------------------------------------------------------------------
-- 10) Tasks: planner, read markers, templates
-- ---------------------------------------------------------------------------
create table if not exists public.task_planner (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  task_id    uuid not null references public.tasks(id) on delete cascade,
  stage      text not null default 'new',
  position   numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, task_id)
);
alter table public.task_planner drop constraint if exists task_planner_stage_ck;
alter table public.task_planner add constraint task_planner_stage_ck check (stage in ('new', 'today', 'week', 'later'));
alter table public.task_planner enable row level security;
drop policy if exists task_planner_own on public.task_planner;
create policy task_planner_own on public.task_planner for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists public.task_views (
  user_id   uuid not null references public.profiles(id) on delete cascade,
  task_id   uuid not null references public.tasks(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (user_id, task_id)
);
alter table public.task_views enable row level security;
drop policy if exists task_views_own on public.task_views;
create policy task_views_own on public.task_views for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists public.task_templates (
  id             uuid primary key default gen_random_uuid(),
  company        text,
  title          text not null,
  description    text,
  priority       text not null default 'normal',
  assignee_id    uuid references public.profiles(id) on delete set null,
  deadline_days  int,
  estimate_hours numeric(8,2),
  checklist      jsonb not null default '[]'::jsonb,
  tags           text[] not null default '{}',
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
alter table public.task_templates drop constraint if exists task_templates_priority_ck;
alter table public.task_templates add constraint task_templates_priority_ck check (priority in ('low', 'normal', 'high', 'urgent'));
drop trigger if exists task_templates_fill on public.task_templates;
create trigger task_templates_fill before insert on public.task_templates
  for each row execute procedure public.ws_fill_owner_cols();
drop trigger if exists task_templates_touch on public.task_templates;
create trigger task_templates_touch before update on public.task_templates
  for each row execute procedure public.ws_touch_updated_at();
alter table public.task_templates enable row level security;
drop policy if exists task_templates_select on public.task_templates;
create policy task_templates_select on public.task_templates for select to authenticated
  using ((select public.ws_same_company(company)));
drop policy if exists task_templates_insert on public.task_templates;
create policy task_templates_insert on public.task_templates for insert to authenticated
  with check ((select public.ws_same_company(company)) and created_by = auth.uid());
drop policy if exists task_templates_change on public.task_templates;
create policy task_templates_change on public.task_templates for update to authenticated
  using (created_by = auth.uid() or ((select public.ws_same_company(company)) and (select public.ws_is_manager())))
  with check ((select public.ws_same_company(company)));
drop policy if exists task_templates_delete on public.task_templates;
create policy task_templates_delete on public.task_templates for delete to authenticated
  using (created_by = auth.uid() or ((select public.ws_same_company(company)) and (select public.ws_is_manager())));

-- ---------------------------------------------------------------------------
-- 11) Feed
-- ---------------------------------------------------------------------------
create table if not exists public.feed_posts (
  id           uuid primary key default gen_random_uuid(),
  company      text,
  author_id    uuid references public.profiles(id) on delete set null,
  title        text,
  body         text not null,
  kind         text not null default 'post',
  audience     text not null default 'company',
  audience_ids uuid[] not null default '{}',
  mentions     uuid[] not null default '{}',
  pinned_at    timestamptz,
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.feed_posts drop constraint if exists feed_posts_ck;
alter table public.feed_posts add constraint feed_posts_ck check (
  kind in ('post', 'announcement', 'appreciation') and audience in ('all', 'company', 'department', 'project', 'users'));
create index if not exists feed_posts_created_idx on public.feed_posts (created_at desc);
create index if not exists feed_posts_company_idx on public.feed_posts (company, created_at desc);

create or replace function public.feed_posts_fill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.author_id is null then new.author_id := auth.uid(); end if;
  if new.company is null then new.company := public.ws_company(); end if;
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end;
$$;
drop trigger if exists feed_posts_fill on public.feed_posts;
create trigger feed_posts_fill before insert or update on public.feed_posts
  for each row execute procedure public.feed_posts_fill();

/** Who a post is for. */
create or replace function public.ws_feed_visible(p_post uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.feed_posts f where f.id = p_post and (
      f.author_id = auth.uid() or public.ws_is_admin()
      or f.audience = 'all'
      or (f.audience = 'company' and public.ws_same_company(f.company))
      or (f.audience = 'department' and f.audience_ids && public.ws_my_dept_lineage())
      or (f.audience = 'project' and exists (select 1 from unnest(f.audience_ids) pid where public.ws_on_project(pid)))
      or (f.audience = 'users' and auth.uid() = any(f.audience_ids))));
$$;
grant execute on function public.ws_feed_visible(uuid) to authenticated;

alter table public.feed_posts enable row level security;
drop policy if exists feed_posts_select on public.feed_posts;
create policy feed_posts_select on public.feed_posts for select to authenticated
  using (author_id = auth.uid() or (select public.ws_is_admin()) or audience = 'all'
         or (audience = 'company' and (select public.ws_same_company(company)))
         or (audience = 'department' and audience_ids && (select public.ws_my_dept_lineage()))
         or (audience = 'project' and exists (select 1 from unnest(audience_ids) pid where public.ws_on_project(pid)))
         or (audience = 'users' and auth.uid() = any(audience_ids)));
drop policy if exists feed_posts_insert on public.feed_posts;
create policy feed_posts_insert on public.feed_posts for insert to authenticated
  with check (author_id = auth.uid() and (audience <> 'all' or (select public.ws_is_manager()))
              and (kind <> 'announcement' or (select public.ws_is_manager())));
drop policy if exists feed_posts_update on public.feed_posts;
create policy feed_posts_update on public.feed_posts for update to authenticated
  using (author_id = auth.uid() or ((select public.ws_is_manager()) and (select public.ws_same_company(company))))
  with check (author_id = auth.uid() or ((select public.ws_is_manager()) and (select public.ws_same_company(company))));
drop policy if exists feed_posts_delete on public.feed_posts;
create policy feed_posts_delete on public.feed_posts for delete to authenticated
  using (author_id = auth.uid() or ((select public.ws_is_manager()) and (select public.ws_same_company(company))));

create table if not exists public.feed_comments (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.feed_posts(id) on delete cascade,
  author_id  uuid references public.profiles(id) on delete set null,
  body       text not null,
  mentions   uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists feed_comments_post_idx on public.feed_comments (post_id, created_at);
create or replace function public.feed_child_fill()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' and new.author_id is null then new.author_id := auth.uid(); end if;
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end;
$$;
drop trigger if exists feed_comments_fill on public.feed_comments;
create trigger feed_comments_fill before insert or update on public.feed_comments
  for each row execute procedure public.feed_child_fill();
alter table public.feed_comments enable row level security;
drop policy if exists feed_comments_select on public.feed_comments;
create policy feed_comments_select on public.feed_comments for select to authenticated using (public.ws_feed_visible(post_id));
drop policy if exists feed_comments_insert on public.feed_comments;
create policy feed_comments_insert on public.feed_comments for insert to authenticated
  with check (author_id = auth.uid() and public.ws_feed_visible(post_id));
drop policy if exists feed_comments_update on public.feed_comments;
create policy feed_comments_update on public.feed_comments for update to authenticated
  using (author_id = auth.uid()) with check (author_id = auth.uid());
drop policy if exists feed_comments_delete on public.feed_comments;
create policy feed_comments_delete on public.feed_comments for delete to authenticated
  using (author_id = auth.uid() or (select public.ws_is_manager()));

create table if not exists public.feed_reactions (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.feed_posts(id) on delete cascade,
  comment_id uuid references public.feed_comments(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  emoji      text not null default '👍',
  created_at timestamptz not null default now()
);
create unique index if not exists feed_reactions_uidx on public.feed_reactions (post_id, coalesce(comment_id::text, '*'), user_id, emoji);
alter table public.feed_reactions enable row level security;
drop policy if exists feed_reactions_select on public.feed_reactions;
create policy feed_reactions_select on public.feed_reactions for select to authenticated using (public.ws_feed_visible(post_id));
drop policy if exists feed_reactions_insert on public.feed_reactions;
create policy feed_reactions_insert on public.feed_reactions for insert to authenticated
  with check (user_id = auth.uid() and public.ws_feed_visible(post_id));
drop policy if exists feed_reactions_delete on public.feed_reactions;
create policy feed_reactions_delete on public.feed_reactions for delete to authenticated using (user_id = auth.uid());

create table if not exists public.feed_post_views (
  post_id   uuid not null references public.feed_posts(id) on delete cascade,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
alter table public.feed_post_views enable row level security;
drop policy if exists feed_post_views_select on public.feed_post_views;
create policy feed_post_views_select on public.feed_post_views for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.feed_posts f where f.id = post_id and f.author_id = auth.uid()));
drop policy if exists feed_post_views_insert on public.feed_post_views;
create policy feed_post_views_insert on public.feed_post_views for insert to authenticated
  with check (user_id = auth.uid() and public.ws_feed_visible(post_id));

-- Announcements and mentions reach people as notifications.
create or replace function public.feed_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_post record;
  u uuid;
  v_n int := 0;
begin
  select coalesce(full_name, email, 'Someone') into v_name from public.profiles where id = new.author_id;
  if tg_table_name = 'feed_posts' then
    if new.kind = 'announcement' then
      for u in
        select p.id from public.profiles p
         where coalesce(p.status, 'active') <> 'inactive' and p.id <> new.author_id
           and (new.audience = 'all'
                or (new.audience = 'company' and (p.company = new.company or p.company2 = new.company))
                or (new.audience = 'department' and exists (select 1 from public.department_members m
                      where m.user_id = p.id and m.department_id = any(public.ws_department_subtree(new.audience_ids))))
                or (new.audience = 'project' and exists (select 1 from public.project_members m where m.user_id = p.id and m.project_id = any(new.audience_ids)))
                or (new.audience = 'users' and p.id = any(new.audience_ids)))
         limit 1000
      loop
        perform public.ws_notify(u, 'feed.announcement', 'Announcement: ' || left(coalesce(new.title, new.body), 100),
          v_name, '/feed/?post=' || new.id, 'post', new.id);
      end loop;
    end if;
    foreach u in array new.mentions loop
      perform public.ws_notify(u, 'mention', v_name || ' mentioned you', left(new.body, 120), '/feed/?post=' || new.id, 'post', new.id);
    end loop;
  else
    select id, author_id into v_post from public.feed_posts where id = new.post_id;
    if v_post.author_id is not null and v_post.author_id <> new.author_id then
      perform public.ws_notify(v_post.author_id, 'feed.comment', v_name || ' commented on your post', left(new.body, 120),
        '/feed/?post=' || v_post.id, 'post', v_post.id);
    end if;
    foreach u in array new.mentions loop
      perform public.ws_notify(u, 'mention', v_name || ' mentioned you', left(new.body, 120), '/feed/?post=' || v_post.id, 'post', v_post.id);
    end loop;
  end if;
  return new;
end;
$$;
drop trigger if exists feed_posts_notify on public.feed_posts;
create trigger feed_posts_notify after insert on public.feed_posts
  for each row execute procedure public.feed_after_insert();
drop trigger if exists feed_comments_notify on public.feed_comments;
create trigger feed_comments_notify after insert on public.feed_comments
  for each row execute procedure public.feed_after_insert();

-- ---------------------------------------------------------------------------
-- 12) Whiteboards
-- ---------------------------------------------------------------------------
create table if not exists public.whiteboards (
  id          uuid primary key default gen_random_uuid(),
  company     text,
  name        text not null,
  data        jsonb not null default '{"elements": []}'::jsonb,
  thumbnail   text,
  visibility  text not null default 'company',
  archived_at timestamptz,
  created_by  uuid references public.profiles(id) on delete set null,
  updated_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.whiteboards drop constraint if exists whiteboards_ck;
alter table public.whiteboards add constraint whiteboards_ck check (
  visibility in ('company', 'private', 'shared') and pg_column_size(data) < 5000000 and coalesce(length(thumbnail), 0) < 400000);
create index if not exists whiteboards_company_idx on public.whiteboards (company, updated_at desc);
drop trigger if exists whiteboards_fill on public.whiteboards;
create trigger whiteboards_fill before insert on public.whiteboards
  for each row execute procedure public.ws_fill_owner_cols();
drop trigger if exists whiteboards_touch on public.whiteboards;
create trigger whiteboards_touch before update on public.whiteboards
  for each row execute procedure public.ws_touch_updated_at();

create table if not exists public.whiteboard_shares (
  whiteboard_id uuid not null references public.whiteboards(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  can_edit      boolean not null default true,
  created_at    timestamptz not null default now(),
  primary key (whiteboard_id, user_id)
);

create or replace function public.ws_whiteboard_access(p_board uuid, p_edit boolean)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.whiteboards w where w.id = p_board and public.ws_same_company(w.company) and (
      w.created_by = auth.uid()
      or (w.visibility = 'company')
      or exists (select 1 from public.whiteboard_shares s where s.whiteboard_id = w.id and s.user_id = auth.uid() and (s.can_edit or not p_edit))));
$$;
grant execute on function public.ws_whiteboard_access(uuid, boolean) to authenticated;

alter table public.whiteboards enable row level security;
alter table public.whiteboard_shares enable row level security;
drop policy if exists whiteboards_select on public.whiteboards;
create policy whiteboards_select on public.whiteboards for select to authenticated
  using ((select public.ws_same_company(company))
         and (created_by = auth.uid() or visibility = 'company'
              or exists (select 1 from public.whiteboard_shares s where s.whiteboard_id = id and s.user_id = auth.uid())));
drop policy if exists whiteboards_insert on public.whiteboards;
create policy whiteboards_insert on public.whiteboards for insert to authenticated
  with check ((select public.ws_same_company(company)) and created_by = auth.uid());
drop policy if exists whiteboards_update on public.whiteboards;
create policy whiteboards_update on public.whiteboards for update to authenticated
  using (public.ws_whiteboard_access(id, true)) with check ((select public.ws_same_company(company)));
drop policy if exists whiteboards_delete on public.whiteboards;
create policy whiteboards_delete on public.whiteboards for delete to authenticated
  using (created_by = auth.uid() or ((select public.ws_is_manager()) and (select public.ws_same_company(company))));
drop policy if exists whiteboard_shares_select on public.whiteboard_shares;
create policy whiteboard_shares_select on public.whiteboard_shares for select to authenticated
  using (public.ws_whiteboard_access(whiteboard_id, false));
-- Through a definer check: a policy here that read whiteboards would loop
-- back through whiteboards_select.
create or replace function public.ws_whiteboard_owned(p_board uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.whiteboards where id = p_board and created_by = auth.uid());
$$;
grant execute on function public.ws_whiteboard_owned(uuid) to authenticated;
drop policy if exists whiteboard_shares_manage on public.whiteboard_shares;
create policy whiteboard_shares_manage on public.whiteboard_shares for all to authenticated
  using (public.ws_whiteboard_owned(whiteboard_id)) with check (public.ws_whiteboard_owned(whiteboard_id));

-- ---------------------------------------------------------------------------
-- 13) Drive: private / company / shared, native documents, published links
-- ---------------------------------------------------------------------------
alter table public.documents add column if not exists visibility text not null default 'company';
alter table public.documents add column if not exists doc_kind text not null default 'file';
alter table public.documents add column if not exists content jsonb;
alter table public.documents add column if not exists published_token text;
alter table public.documents add column if not exists published_at timestamptz;
alter table public.documents add column if not exists updated_by uuid references public.profiles(id) on delete set null;
alter table public.documents alter column storage_path drop not null;
alter table public.documents drop constraint if exists documents_drive_ck;
alter table public.documents add constraint documents_drive_ck check (
  visibility in ('private', 'company', 'shared')
  and doc_kind in ('file', 'document', 'spreadsheet', 'presentation')
  and (doc_kind <> 'file' or storage_path is not null)
  and (content is null or pg_column_size(content) < 5000000));
create unique index if not exists documents_published_token_uidx on public.documents (published_token) where published_token is not null;
-- updated_at moves on every change, so an editor can tell that someone else saved first.
drop trigger if exists documents_touch on public.documents;
create trigger documents_touch before update on public.documents
  for each row execute procedure public.ws_touch_updated_at();

-- What an editor may not change: who owns a document, its company, the stored
-- file behind it (a row pointing at someone else's file would open that file
-- through ws_document_visible), or, unless they own it, who can see it.
create or replace function public.documents_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then return new; end if;            -- the service role and migrations
  if new.created_by is distinct from old.created_by then
    raise exception 'The owner of a document cannot be changed' using errcode = '42501';
  end if;
  if new.company is distinct from old.company then
    raise exception 'A document cannot move to another company' using errcode = '42501';
  end if;
  if new.storage_path is distinct from old.storage_path or new.bucket is distinct from old.bucket or new.sha256 is distinct from old.sha256 then
    raise exception 'The stored file of a document cannot be swapped' using errcode = '42501';
  end if;
  if new.visibility is distinct from old.visibility and old.created_by is distinct from auth.uid() then
    raise exception 'Only the owner can change who can see a document' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists documents_guard on public.documents;
create trigger documents_guard before update on public.documents
  for each row execute procedure public.documents_guard();

create table if not exists public.document_shares (
  document_id uuid not null references public.documents(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  can_edit    boolean not null default false,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (document_id, user_id)
);
alter table public.document_shares enable row level security;

create or replace function public.ws_document_access(p_doc uuid, p_edit boolean)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.documents d where d.id = p_doc and public.ws_same_company(d.company) and (
      d.created_by = auth.uid()
      or (d.visibility = 'company' and (not p_edit or public.ws_is_manager()))
      or exists (select 1 from public.document_shares s where s.document_id = d.id and s.user_id = auth.uid() and (s.can_edit or not p_edit))));
$$;
grant execute on function public.ws_document_access(uuid, boolean) to authenticated;

-- Written out on the row (not via ws_document_access) so INSERT ... RETURNING
-- sees the row it has just written.
drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents for select to authenticated
  using ((select public.ws_same_company(company))
         and (created_by = auth.uid() or visibility = 'company'
              or exists (select 1 from public.document_shares s where s.document_id = id and s.user_id = auth.uid())));
drop policy if exists documents_insert on public.documents;
create policy documents_insert on public.documents for insert to authenticated
  with check ((select public.ws_same_company(company)) and created_by = auth.uid()
              and (storage_path is null or split_part(storage_path, '/', 1) = auth.uid()::text));
drop policy if exists documents_update on public.documents;
create policy documents_update on public.documents for update to authenticated
  using (public.ws_document_access(id, true)) with check ((select public.ws_same_company(company)));
drop policy if exists documents_delete on public.documents;
create policy documents_delete on public.documents for delete to authenticated
  using ((select public.ws_same_company(company))
         and (created_by = auth.uid() or (visibility = 'company' and (select public.ws_is_manager()))));

drop policy if exists document_shares_select on public.document_shares;
create policy document_shares_select on public.document_shares for select to authenticated
  using (public.ws_document_access(document_id, false));
create or replace function public.ws_document_owned(p_doc uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.documents where id = p_doc and created_by = auth.uid());
$$;
grant execute on function public.ws_document_owned(uuid) to authenticated;
drop policy if exists document_shares_manage on public.document_shares;
create policy document_shares_manage on public.document_shares for all to authenticated
  using (public.ws_document_owned(document_id)) with check (public.ws_document_owned(document_id));

-- Storage reads follow the same rule as the documents row.
create or replace function public.ws_document_visible(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select split_part(p_path, '/', 1) = auth.uid()::text
      or exists (select 1 from public.documents d where d.storage_path = p_path and public.ws_document_access(d.id, false));
$$;

-- Published copies live in a public bucket under the document's token, so a
-- link works without signing in and stops working when it is unpublished.
insert into storage.buckets (id, name, public, file_size_limit)
values ('published', 'published', true, 52428800)
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit;

drop policy if exists "published write by owner" on storage.objects;
create policy "published write by owner" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'published' and exists (
    select 1 from public.documents d where d.published_token = (storage.foldername(name))[1]
      and (d.created_by = auth.uid() or public.ws_document_access(d.id, true))));
drop policy if exists "published delete by owner" on storage.objects;
create policy "published delete by owner" on storage.objects
  for delete to authenticated
  using (bucket_id = 'published' and exists (
    select 1 from public.documents d where d.published_token = (storage.foldername(name))[1]
      and (d.created_by = auth.uid() or public.ws_document_access(d.id, true))));

/** The public share page: what a published link shows. Anyone may call it. */
create or replace function public.ws_published_document(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('name', d.name, 'doc_kind', d.doc_kind, 'mime_type', d.mime_type, 'size_bytes', d.size_bytes,
                            -- speaker notes are for the presenter, never for the public link
                            'content', case when d.doc_kind = 'presentation' and jsonb_typeof(d.content -> 'slides') = 'array'
                                              then jsonb_set(d.content, '{slides}', coalesce((select jsonb_agg(case when jsonb_typeof(s) = 'object' then s - 'notes' else s end)
                                                                                                   from jsonb_array_elements(d.content -> 'slides') s), '[]'::jsonb))
                                            when d.doc_kind <> 'file' then d.content end,
                            'path', case when d.doc_kind = 'file' then d.published_token || '/file' end,
                            'published_at', d.published_at)
    from public.documents d
   where p_token is not null and length(p_token) >= 24 and d.published_token = p_token and d.archived_at is null;
$$;
grant execute on function public.ws_published_document(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 14) Calendar colours, Realtime
-- ---------------------------------------------------------------------------
alter table public.calendar_events add column if not exists color text;

do $$
declare t text;
begin
  foreach t in array array['crm_leads', 'crm_companies', 'feed_posts', 'feed_comments', 'whiteboards', 'project_join_requests', 'documents'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end$$;

-- Done.
