-- ============================================================================
-- Ready-made CRM roles (migration 14). Run AFTER
-- supabase-task-summary-migration.sql. Idempotent; adds roles only.
--
-- Bitrix24 ships a handful of CRM roles an administrator assigns people to.
-- These are seeded here, assigned to nobody, and editable like any other
-- role in Admin → CRM permissions. A role that already exists by name is
-- left exactly as it is (an administrator may have changed it).
--
--   Super admin      everything, every company ("All companies"), CRM settings
--   Admin            everything in their own company, CRM settings
--   Team lead        their department and sub-departments: read, edit, move,
--                    export; delete their own
--   Sales executive  read their department, add, edit and export their own
--   Accounts         invoices in full; read deals, contacts and companies
--   Read only        read every record of their company, change nothing
-- ============================================================================

do $$
declare
  r record;
  v_role uuid;
  roles constant jsonb := jsonb_build_array(
    jsonb_build_object('name', 'Super admin', 'description', 'Everything in the CRM of every company, including CRM settings.'),
    jsonb_build_object('name', 'Admin', 'description', 'Everything in the CRM of their own company, including CRM settings.'),
    jsonb_build_object('name', 'Team lead', 'description', 'Their department and sub-departments: read, edit, move and export; delete their own.'),
    jsonb_build_object('name', 'Sales executive', 'description', 'Read their department; add, edit and export their own records.'),
    jsonb_build_object('name', 'Accounts', 'description', 'Invoices in full; read deals, contacts and companies.'),
    jsonb_build_object('name', 'Read only', 'description', 'Read every record of their company; change nothing.'));
begin
  for r in select x ->> 'name' as name, x ->> 'description' as description from jsonb_array_elements(roles) x loop
    if exists (select 1 from public.crm_roles where lower(name) = lower(r.name)) then continue; end if;
    insert into public.crm_roles (name, description, is_system) values (r.name, r.description, false) returning id into v_role;
    insert into public.crm_role_permissions (role_id, entity, action, level)
    select v_role, e, a,
      case r.name
        when 'Super admin' then case when a = 'move_stage' then 'all' else 'companies' end
        when 'Admin' then 'all'
        when 'Team lead' then case
            when e = 'settings' then 'none'
            when a in ('read', 'edit', 'export', 'view_amounts') then 'subdepartments'
            when a in ('add', 'move_stage') then 'all'
            when a = 'delete' then 'own'
            else 'none' end
        when 'Sales executive' then case
            when e in ('settings', 'invoice') then case when e = 'invoice' and a in ('read', 'view_amounts') then 'own' else 'none' end
            when a in ('read', 'view_amounts') then 'department'
            when a in ('add', 'move_stage') then 'all'
            when a in ('edit', 'export') then 'own'
            else 'none' end
        when 'Accounts' then case
            when e = 'invoice' then 'all'
            when e in ('deal', 'contact', 'company') and a in ('read', 'view_amounts', 'export') then 'all'
            else 'none' end
        when 'Read only' then case when e <> 'settings' and a in ('read', 'view_amounts') then 'all' else 'none' end
      end
      from unnest(array['contact', 'company', 'lead', 'deal', 'invoice', 'settings']) e,
           unnest(array['read', 'add', 'edit', 'delete', 'export', 'import', 'move_stage', 'view_amounts', 'custom_form', 'automation']) a;
  end loop;
end$$;

-- Done.
