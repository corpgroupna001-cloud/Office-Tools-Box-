-- ============================================================================
-- CRM access across companies (migration 12). Run AFTER
-- supabase-security-hardening-migration.sql. Idempotent; changes no records.
--
-- The access-permissions matrix had five levels, the strongest being "All",
-- which means every record *of the person's own company* (company or
-- company2). Records imported from Bitrix24 belong to the company of their
-- responsible person, so someone in Nova given "All" still saw nothing of
-- Genie Lamp's or Jobways' deals and leads — and nobody but a workspace admin
-- saw records whose company is empty.
--
-- This adds a sixth level, "companies" (All companies): every record of every
-- company, and records with no company, like Bitrix24's portal-wide "All".
-- It is opt-in per role and per action; nothing anyone sees changes until an
-- administrator picks it. A role "Full CRM access (every company)" is seeded
-- with it everywhere and assigned to nobody: add people to it in
-- Admin → CRM permissions.
-- ============================================================================

alter table public.crm_role_permissions drop constraint if exists crm_role_permissions_ck;
alter table public.crm_role_permissions add constraint crm_role_permissions_ck check (
  entity in ('contact', 'company', 'lead', 'deal', 'invoice', 'settings')
  and action in ('read', 'add', 'edit', 'delete', 'export', 'import', 'move_stage', 'view_amounts', 'custom_form', 'automation')
  and level in ('none', 'own', 'department', 'subdepartments', 'all', 'companies'));

create or replace function public.ws_crm_rank(p_level text)
returns int
language sql
immutable
as $$
  select case p_level when 'companies' then 5 when 'all' then 4 when 'subdepartments' then 3 when 'department' then 2 when 'own' then 1 else 0 end;
$$;
create or replace function public.ws_crm_level_name(p_rank int)
returns text
language sql
immutable
as $$
  select case p_rank when 5 then 'companies' when 4 then 'all' when 3 then 'subdepartments' when 2 then 'department' when 1 then 'own' else 'none' end;
$$;

/** Does a level allow this row? "companies" reaches every company, and records with none. */
create or replace function public.ws_crm_row_ok(p_levels jsonb, p_pipeline uuid, p_company text, p_owner uuid, p_creator uuid,
                                                p_peers uuid[], p_subpeers uuid[], p_companies text[], p_admin boolean)
returns boolean
language sql
stable
as $$
  select coalesce(p_admin, false)
    or public.ws_crm_rank_for(p_levels, p_pipeline) >= 5
    or coalesce(
      p_company = any(coalesce(p_companies, '{}'))
      and case public.ws_crm_rank_for(p_levels, p_pipeline)
        when 4 then true
        when 3 then p_owner = auth.uid() or p_creator = auth.uid() or p_owner = any(p_subpeers) or p_creator = any(p_subpeers)
        when 2 then p_owner = auth.uid() or p_creator = auth.uid() or p_owner = any(p_peers) or p_creator = any(p_peers)
        when 1 then p_owner = auth.uid() or p_creator = auth.uid()
        else false end, false);
$$;

/** Someone who may read deals of every company also sees every pipeline and its stages. */
create or replace function public.ws_crm_every_company(p_entity text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from jsonb_each_text(public.ws_crm_levels(p_entity, 'read')) l where l.value = 'companies');
$$;
revoke all on function public.ws_crm_every_company(text) from public, anon;
grant execute on function public.ws_crm_every_company(text) to authenticated;

drop policy if exists crm_pipelines_select on public.crm_pipelines;
create policy crm_pipelines_select on public.crm_pipelines
  for select to authenticated
  using (company is null or (select public.ws_same_company(company)) or (select public.ws_crm_every_company('deal')));
drop policy if exists crm_pipeline_stages_select on public.crm_pipeline_stages;
create policy crm_pipeline_stages_select on public.crm_pipeline_stages
  for select to authenticated
  using (exists (select 1 from public.crm_pipelines p where p.id = pipeline_id
                   and (p.company is null or public.ws_same_company(p.company) or public.ws_crm_every_company('deal'))));

-- Editing: "All companies" may also keep a record in a company that is not the editor's.
do $$
declare t record;
begin
  for t in select * from (values
      ('crm_contacts', 'contact', 'null::uuid', 'owner_id'),
      ('crm_companies', 'company', 'null::uuid', 'owner_id'),
      ('crm_leads', 'lead', 'null::uuid', 'owner_id'),
      ('crm_deals', 'deal', 'pipeline_id', 'owner_id'),
      ('invoices', 'invoice', 'null::uuid', 'responsible_id')) as v(tbl, entity, pipe, owner)
  loop
    execute format('drop policy if exists %I on public.%I', t.tbl || '_update', t.tbl);
    execute format($p$create policy %I on public.%I for update to authenticated using (
        public.ws_crm_row_ok((select public.ws_crm_levels(%L, 'edit')), %s, company, %I, created_by,
          (select public.ws_dept_peers()), (select public.ws_subdept_peers()), (select public.ws_my_companies()), (select public.ws_is_admin())))
        with check ((select public.ws_is_admin()) or company = any((select public.ws_my_companies())::text[])
                    or public.ws_crm_rank_for((select public.ws_crm_levels(%L, 'edit')), %s) >= 5)$p$,
      t.tbl || '_update', t.tbl, t.entity, t.pipe, t.owner, t.entity, t.pipe);
  end loop;
end$$;

-- A ready-made role for people who look after the CRM of every company.
do $$
declare v_role uuid;
begin
  if exists (select 1 from public.crm_roles where name = 'Full CRM access (every company)') then return; end if;
  insert into public.crm_roles (name, description, is_system)
  values ('Full CRM access (every company)', 'Every lead, deal, contact, company and invoice of every company, including imported records with no company.', false)
  returning id into v_role;
  insert into public.crm_role_permissions (role_id, entity, action, level)
  select v_role, e, a, case when a = 'move_stage' then 'all' else 'companies' end
    from unnest(array['contact', 'company', 'lead', 'deal', 'invoice']) e,
         unnest(array['read', 'add', 'edit', 'delete', 'export', 'import', 'move_stage', 'view_amounts', 'custom_form', 'automation']) a;
end$$;

-- Done.
