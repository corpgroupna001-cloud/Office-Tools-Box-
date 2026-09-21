-- ============================================================================
-- Company structure as in Bitrix24 (migration 15). Run AFTER
-- supabase-crm-roles-migration.sql. Idempotent; adds departments and heads,
-- deletes nothing.
--
--   Corporate Group
--   ├── Jobways Point LLP        9 departments, down to Interview Supports
--   ├── Genie Lamp Private Limited  10 departments
--   ├── SPORTSMART
--   │   └── Nova Sportsmart Private Limited  12 departments
--   └── Navyug Raise A Player Foundation
--
-- A department is matched by name under its parent (case-insensitive), so
-- running the file again, or after someone added a department by hand, adds
-- only what is missing. Heads are found by Employee ID (profiles.employee_id);
-- someone not in WorkSuite yet is skipped and can be set later on the chart.
-- Everyone signed in may now read the whole chart, as in Bitrix24; changing
-- it stays with admins and a company's managers.
-- ============================================================================

-- The chart is the whole group's, not one company's.
drop policy if exists departments_read on public.departments;
create policy departments_read on public.departments for select to authenticated using (auth.uid() is not null);
drop policy if exists department_members_read on public.department_members;
create policy department_members_read on public.department_members for select to authenticated using (auth.uid() is not null);

/** Find or add a department by name under a parent; returns its id. */
create or replace function public.ws_seed_department(p_parent uuid, p_name text, p_company text, p_sort int)
returns uuid
language plpgsql
set search_path = public
as $$
declare v_id uuid;
begin
  select id into v_id from public.departments
   where parent_id is not distinct from p_parent and lower(btrim(name)) = lower(btrim(p_name)) limit 1;
  if v_id is null then
    insert into public.departments (name, parent_id, company, sort) values (btrim(p_name), p_parent, p_company, p_sort) returning id into v_id;
  end if;
  return v_id;
end;
$$;
revoke all on function public.ws_seed_department(uuid, text, text, int) from public, anon, authenticated;

/** Add a tree ({"n": name, "h": head Employee ID, "d": deputy Employee ID, "c": [children]}) under a parent. */
create or replace function public.ws_seed_department_tree(p_parent uuid, p_company text, p_nodes jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  n jsonb; i int := 0; v_id uuid; v_user uuid;
begin
  for n in select * from jsonb_array_elements(coalesce(p_nodes, '[]'::jsonb)) loop
    i := i + 1;
    v_id := public.ws_seed_department(p_parent, n ->> 'n', p_company, i * 10);
    foreach v_user in array array[
        (select id from public.profiles where lower(employee_id) = lower(n ->> 'h') limit 1),
        (select id from public.profiles where lower(employee_id) = lower(n ->> 'd') limit 1)] loop
      if v_user is null then continue; end if;
      insert into public.department_members (department_id, user_id, role)
      values (v_id, v_user, case when v_user = (select id from public.profiles where lower(employee_id) = lower(n ->> 'h') limit 1) then 'head' else 'deputy' end)
      on conflict (department_id, user_id) do nothing;
    end loop;
    perform public.ws_seed_department_tree(v_id, p_company, n -> 'c');
  end loop;
end;
$$;
revoke all on function public.ws_seed_department_tree(uuid, text, jsonb) from public, anon, authenticated;

do $$
declare
  v_root uuid; v_jw uuid; v_gl uuid; v_sm uuid; v_nova uuid; v_rap uuid;
  JW constant text := 'Jobways Point LLP';
  GL constant text := 'Genie Lamp Private Limited';
  NOVA constant text := 'Nova Sportsmart Private Limited';
  RAP constant text := 'Navyug Raise A Player Foundation';
  common jsonb;
begin
  -- A database with nobody in it yet (a fresh project) gets its chart from the
  -- b24 seed first; run this file again once people exist.
  if not exists (select 1 from public.profiles where company is not null) then return; end if;
  -- The group root (the b24 migration's seed makes it on a live database).
  select id into v_root from public.departments where parent_id is null order by created_at limit 1;
  if v_root is null then
    insert into public.departments (name, company, sort) values ('Corporate Group', null, 0) returning id into v_root;
  end if;

  -- A company's node: the one the b24 seed made (any depth), else a new one under the root.
  select id into v_jw from public.departments where company = JW and lower(name) = lower(JW) order by created_at limit 1;
  if v_jw is null then v_jw := public.ws_seed_department(v_root, JW, JW, 10); end if;
  select id into v_gl from public.departments where company = GL and lower(name) = lower(GL) order by created_at limit 1;
  if v_gl is null then v_gl := public.ws_seed_department(v_root, GL, GL, 20); end if;
  v_sm := public.ws_seed_department(v_root, 'SPORTSMART', null, 30);
  select id into v_nova from public.departments where company = NOVA and lower(name) = lower(NOVA) order by created_at limit 1;
  if v_nova is null then v_nova := public.ws_seed_department(v_sm, NOVA, NOVA, 10); end if;
  select id into v_rap from public.departments where company = RAP and lower(name) = lower(RAP) order by created_at limit 1;
  if v_rap is null then v_rap := public.ws_seed_department(v_root, RAP, RAP, 40); end if;
  -- Nova sits under SPORTSMART, as in Bitrix24; its people stay where they are.
  update public.departments set parent_id = v_sm where id = v_nova and parent_id = v_root;
  update public.departments set sort = 10 where id = v_jw and parent_id = v_root;
  update public.departments set sort = 20 where id = v_gl and parent_id = v_root;
  update public.departments set sort = 40 where id = v_rap and parent_id = v_root;

  -- The departments every company shares.
  common := '[
    {"n": "Executive Management", "h": "CG-SBM-EM-CEO-001", "d": "JW-SBM-EM-MD-001", "c": [
      {"n": "Chief Executive Officer", "h": "CG-SBM-EM-CEO-001"},
      {"n": "Managing Partner", "h": "JW-SBM-EM-MD-001"}]},
    {"n": "Finance and Accounts", "h": "CG-AC-FA-AM-001", "c": [
      {"n": "Accounts", "c": [{"n": "Accounts Manager", "h": "CG-AC-FA-AM-001"}]}]},
    {"n": "Human Resource", "h": "JW-HR-HRA-HRA-001", "c": [
      {"n": "Human Resource", "c": [{"n": "Human Resource Analyst", "h": "JW-HR-HRA-HRA-001"}]}]},
    {"n": "Corporate Project Governance", "c": [
      {"n": "General Supervision", "c": [{"n": "General Supervisor"}]}]},
    {"n": "Information Technology Security and Administration", "h": "CG-ITSA-SNA-NA-001", "c": [
      {"n": "System and Network Administration", "c": [{"n": "Network Administrator", "h": "CG-ITSA-SNA-NA-001"}]}]},
    {"n": "Research and Development", "c": [
      {"n": "Product Research", "c": [{"n": "Research and Development Analyst"}]}]},
    {"n": "Business Intelligence and Analytics", "c": [{"n": "Business Intelligence Analyst"}]},
    {"n": "Digital Marketing", "h": "CG-DM-DMM-DMM-001", "c": [
      {"n": "Performance Marketing Management", "c": [{"n": "Performance Marketing Manager", "h": "CG-DM-PMM-PMM-001"}]},
      {"n": "Content Management", "c": [{"n": "Content Manager"}, {"n": "Creative Designer"}]}]}
  ]'::jsonb;

  perform public.ws_seed_department_tree(v_jw, JW, common || '[
    {"n": "Resume Marketing Services", "c": [
      {"n": "Operations Management", "c": [
        {"n": "Resume Marketing Management", "c": [
          {"n": "Service Leads Executive", "h": "JW-RMS-RMM-SLE-001"},
          {"n": "Resume Marketing Executive"},
          {"n": "Interview Supports", "c": [
            {"n": "Interview Coordinator"},
            {"n": "Mock Interviewer", "h": "JW-RMS-IS-MI-001"},
            {"n": "Interview Supporter", "h": "JW-RMS-IS-IS-002"}]},
          {"n": "Accounts and Reconciliation", "c": [{"n": "Accountant"}]}]}]}]}
  ]'::jsonb);

  perform public.ws_seed_department_tree(v_gl, GL, common || '[
    {"n": "Interview Supports", "h": "GL-PIS-CSM-IC-001"},
    {"n": "Employment BGC Saviors", "h": "GL-EBS-ESM-SLE-001"}
  ]'::jsonb);

  perform public.ws_seed_department_tree(v_nova, NOVA, common || '[
    {"n": "Software Development"},
    {"n": "Marketplace"},
    {"n": "Franchise Partnership System"},
    {"n": "Own Brand Commerce"}
  ]'::jsonb);
end$$;

-- Done.
