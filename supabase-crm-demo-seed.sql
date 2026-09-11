-- ============================================================================
-- OPTIONAL — demo data for trying the CRM on a development / preview project.
--
-- DO NOT run this on production. It creates a handful of clearly-labelled
-- sample contacts, leads, deals, a project with tasks and a meeting, owned by
-- the FIRST active profile in the company named below. Everything it creates
-- is tagged 'demo' so it can be removed with the block at the bottom.
--
-- Requires the four CRM migrations to have run. Re-running does nothing once
-- demo rows exist.
-- ============================================================================
do $$
declare
  v_company text := 'Nova Sportsmart Private Limited';   -- change to the company you are testing with
  v_owner   uuid;
  v_pipe    uuid;
  v_stage   uuid;
  v_contact uuid;
  v_deal    uuid;
  v_project uuid;
begin
  if exists (select 1 from public.crm_contacts where 'demo' = any(tags)) then
    raise notice 'Demo data already present; nothing done.';
    return;
  end if;

  select id into v_owner from public.profiles
   where company = v_company and coalesce(status, 'active') = 'active' order by created_at limit 1;
  if v_owner is null then raise exception 'No active profile in company %', v_company; end if;

  select id into v_pipe from public.crm_pipelines where company is null or company = v_company order by is_default desc limit 1;
  select id into v_stage from public.crm_pipeline_stages where pipeline_id = v_pipe and not is_won and not is_lost order by position limit 1;

  insert into public.crm_contacts (company, first_name, last_name, organization, job_title, email, phone, city, country, source, owner_id, tags, created_by)
  values (v_company, 'Demo', 'Customer', 'Demo Sports Academy', 'Procurement Head', 'demo.customer@example.com', '+91 90000 00001', 'Hyderabad', 'India', 'Referral', v_owner, '{demo}', v_owner)
  returning id into v_contact;

  insert into public.crm_leads (company, name, organization, email, phone, source, owner_id, status, estimated_value, priority, next_follow_up_at, tags, created_by)
  values
    (v_company, 'Demo Lead One', 'Demo School Trust', 'lead.one@example.com', '+91 90000 00002', 'Website', v_owner, 'new', 150000, 'high', now() + interval '2 days', '{demo}', v_owner),
    (v_company, 'Demo Lead Two', 'Demo Fitness Club', 'lead.two@example.com', '+91 90000 00003', 'Cold call', v_owner, 'contacted', 60000, 'normal', now() + interval '5 days', '{demo}', v_owner);

  insert into public.crm_deals (company, title, contact_id, organization, owner_id, pipeline_id, stage_id, value, currency, expected_close_date, source, tags, created_by)
  values (v_company, 'Demo: Academy kit supply', v_contact, 'Demo Sports Academy', v_owner, v_pipe, v_stage, 250000, 'INR', current_date + 30, 'Referral', '{demo}', v_owner)
  returning id into v_deal;

  insert into public.projects (company, name, description, owner_id, manager_id, status, priority, start_date, due_date, contact_id, deal_id, tags, created_by)
  values (v_company, 'Demo: Kit delivery project', 'Sample project created by supabase-crm-demo-seed.sql', v_owner, v_owner, 'active', 'normal', current_date, current_date + 45, v_contact, v_deal, '{demo}', v_owner)
  returning id into v_project;

  insert into public.tasks (company, title, status, priority, assignee_id, project_id, contact_id, deal_id, due_date, tags, created_by)
  values
    (v_company, 'Demo: confirm sizes with the academy', 'todo', 'high', v_owner, v_project, v_contact, v_deal, current_date + 2, '{demo}', v_owner),
    (v_company, 'Demo: send proforma invoice', 'in_progress', 'normal', v_owner, v_project, v_contact, v_deal, current_date + 7, '{demo}', v_owner),
    (v_company, 'Demo: overdue sample task', 'todo', 'urgent', v_owner, v_project, null, null, current_date - 1, '{demo}', v_owner);

  insert into public.calendar_events (company, title, starts_at, ends_at, owner_id, event_type, contact_id, deal_id, project_id, created_by)
  values (v_company, 'Demo: kick-off call', date_trunc('hour', now()) + interval '1 day', date_trunc('hour', now()) + interval '1 day 1 hour', v_owner, 'call', v_contact, v_deal, v_project, v_owner);

  raise notice 'Demo data created for owner %', v_owner;
end $$;

-- To remove the demo data:
--   delete from public.tasks where 'demo' = any(tags);
--   delete from public.calendar_events where title like 'Demo:%';
--   delete from public.projects where 'demo' = any(tags);
--   delete from public.crm_deals where 'demo' = any(tags);
--   delete from public.crm_leads where 'demo' = any(tags);
--   delete from public.crm_contacts where 'demo' = any(tags);
