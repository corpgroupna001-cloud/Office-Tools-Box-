-- ============================================================================
-- Security hardening (migration 11). Run AFTER supabase-crm-sales-migration.sql.
-- Idempotent; adds guards only, changes no data.
--
--   1. Notification links must be in-app paths ("/..."), so a bell item or a
--      toast can never carry a javascript: or off-site URL.
--   2. People cannot change the columns an administrator owns on their own
--      profile: the second company (which widens what CRM data they see),
--      manager, shifts, biometric ID, WFH flag, status, HR fields, email and
--      its verified flag. The company itself may only be chosen once, when it
--      is still empty (first sign-in). The admin console and the API use the
--      service role and are not affected.
--   3. WFH clips: a person cannot approve their own QC; every upload goes back
--      to "pending".
--   4. Internal SECURITY DEFINER helpers are no longer callable by anonymous
--      visitors; crm_log only writes into the caller's own company.
--   5. Signup codes are only read and written by the server.
--   6. A chat message may only carry a file its sender can see right now, so
--      someone removed from a group cannot re-grant themselves its files.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Notification links
-- ---------------------------------------------------------------------------
create or replace function public.ws_notifications_safe_url()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- In-app paths only: "/x", never "//host" or "/\host" (both leave the site).
  if new.url is not null and new.url !~ '^/([^/\\]|$)' then
    new.url := null;
  end if;
  return new;
end;
$$;
drop trigger if exists notifications_safe_url on public.notifications;
create trigger notifications_safe_url before insert or update of url on public.notifications
  for each row execute procedure public.ws_notifications_safe_url();

-- ---------------------------------------------------------------------------
-- 2) Admin-owned profile columns
-- ---------------------------------------------------------------------------
create or replace function public.ws_guard_profile_admin_cols()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
  k text;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') <> 'authenticated'
     or public.ws_is_admin() then
    return new;
  end if;
  foreach k in array array['company2', 'manager_id', 'shift_id', 'shift2_id', 'employee_code', 'is_wfh',
                           'req_mobile', 'req_laptop', 'req_tab', 'status', 'exit_date', 'exit_reason',
                           'email_verified', 'department', 'job_title', 'joining_date'] loop
    if (n -> k) is distinct from (o -> k) then
      raise exception '% can only be changed by an administrator', replace(k, '_', ' ') using errcode = '42501';
    end if;
  end loop;
  -- The email follows the sign-in address (sync_profile_email); it is not typed in.
  if new.email is distinct from old.email
     and new.email is distinct from (select u.email from auth.users u where u.id = new.id) then
    raise exception 'email can only be changed from the email settings' using errcode = '42501';
  end if;
  -- The company is picked once, at first sign-in; after that an administrator moves people.
  if new.company is distinct from old.company then
    if nullif(btrim(coalesce(old.company, '')), '') is not null then
      raise exception 'company can only be changed by an administrator' using errcode = '42501';
    end if;
    if nullif(btrim(coalesce(new.company, '')), '') is null
       or not (new.company in ('Jobways Point LLP', 'Genie Lamp Private Limited', 'Nova Sportsmart Private Limited',
                               'Protathlitis Sportsmart LLP', 'Navyug Raise A Player Foundation')
               or exists (select 1 from public.profiles p where p.id <> new.id and p.company = new.company)) then
      raise exception 'Unknown company' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_guard_admin_cols on public.profiles;
create trigger profiles_guard_admin_cols before update on public.profiles
  for each row execute procedure public.ws_guard_profile_admin_cols();

-- ---------------------------------------------------------------------------
-- 3) WFH clips: QC fields belong to the reviewer
-- ---------------------------------------------------------------------------
create or replace function public.ws_guard_wfh_review()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.status := 'pending'; new.review_note := null; new.reviewed_at := null;
    return new;
  end if;
  if (to_jsonb(new) - array['status', 'review_note', 'reviewed_at', 'updated_at'])
     is distinct from (to_jsonb(old) - array['status', 'review_note', 'reviewed_at', 'updated_at']) then
    -- A new or replaced clip goes back to the reviewer.
    new.status := 'pending'; new.review_note := null; new.reviewed_at := null;
  else
    new.status := old.status; new.review_note := old.review_note; new.reviewed_at := old.reviewed_at;
  end if;
  return new;
end;
$$;
drop trigger if exists wfh_recordings_guard_review on public.wfh_recordings;
create trigger wfh_recordings_guard_review before insert or update on public.wfh_recordings
  for each row execute procedure public.ws_guard_wfh_review();

-- ---------------------------------------------------------------------------
-- 4) Internal helpers: not for anonymous callers
-- ---------------------------------------------------------------------------
revoke execute on function public.crm_log(text, text, uuid, text, jsonb, text, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.crm_log(text, text, uuid, text, jsonb, text, uuid, uuid, uuid, uuid) to authenticated;
revoke execute on function public.ws_notify(uuid, text, text, text, text, text, uuid) from public, anon;
grant execute on function public.ws_notify(uuid, text, text, text, text, text, uuid) to authenticated;
-- Only the invoice triggers number and total invoices.
revoke execute on function public.next_invoice_number(text, date) from public, anon, authenticated;
revoke execute on function public.invoice_recalc(uuid) from public, anon, authenticated;

-- crm_log is also the browser's "log a call / email" call: keep it inside the
-- caller's company. Triggers pass the record's own company, which is theirs.
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
  v_company text := coalesce(p_company, public.ws_company());
begin
  -- A signed-in browser call may only write into its own company. Trigger calls
  -- carry the record's company, and web-form leads (no caller) come from our own function.
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'authenticated'
     and pg_trigger_depth() = 0 and not public.ws_same_company(v_company) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  insert into public.crm_activities
    (company, actor_id, action, entity_type, entity_id, entity_label, meta,
     contact_id, lead_id, deal_id, project_id)
  values
    (v_company, auth.uid(), p_action, p_entity_type, p_entity_id,
     left(p_label, 200), coalesce(p_meta, '{}'::jsonb),
     p_contact_id, p_lead_id, p_deal_id, p_project_id)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Signup codes: server only
-- ---------------------------------------------------------------------------
drop policy if exists sv_select_own on public.signup_verifications;
drop policy if exists sv_update_own on public.signup_verifications;

-- ---------------------------------------------------------------------------
-- 6) Chat files: a message may only carry a file its sender can see
-- ---------------------------------------------------------------------------
create or replace function public.ws_messages_file_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') <> 'authenticated' then
    return new;
  end if;
  if new.body like '\_\_FILE\_\_::%'
     and (tg_op = 'INSERT' or new.body is distinct from old.body)
     and not public.ws_chat_file_visible(split_part(new.body, '::', 2)) then
    raise exception 'You can only share files you have access to' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists messages_file_guard on public.messages;
create trigger messages_file_guard before insert or update of body on public.messages
  for each row execute procedure public.ws_messages_file_guard();

-- Done.
