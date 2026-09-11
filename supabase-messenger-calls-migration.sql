-- ============================================================================
-- Messenger & calls v2.
--
-- Run SEVENTH of the CRM set, after supabase-b24-migration.sql.
-- Idempotent; adds only. Existing messages, groups and reactions are untouched.
--
-- 1) messages.client_id: the id a browser gives a message while it is still
--    sending, so the copy already on screen and the realtime echo are
--    recognised as one message (no duplicates, no flicker, safe retries).
-- 2) ws_chat_inbox(): every conversation with its last message and unread
--    count in one call, instead of each browser downloading hundreds of rows.
-- 3) Calls: `calls` and `call_participants`. The database is the source of
--    truth for who is ringing, who answered and when a call ended, so every
--    device of a person rings, stops ringing when one of them answers, and a
--    missed call is recorded even when the caller's browser closes. Browsers
--    never write these tables: every change goes through the ws_call_*
--    functions below, which also settle time-outs.
--
-- Media (audio/video) never touches the database or the server: it flows
-- browser to browser over WebRTC, relayed by a TURN server only when a
-- firewall blocks the direct path (see SETUP.md, "Calls").
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Messages: the sender's own id for a message, and paging indexes
-- ---------------------------------------------------------------------------
alter table public.messages add column if not exists client_id uuid;
create unique index if not exists messages_sender_client_idx
  on public.messages (sender_id, client_id) where client_id is not null;

-- A thread is read newest-first and paged backwards by id.
create index if not exists messages_dm_page_idx
  on public.messages (sender_id, recipient_id, id desc) where conversation_id is null;
create index if not exists messages_group_page_idx
  on public.messages (conversation_id, id desc) where conversation_id is not null;

-- ---------------------------------------------------------------------------
-- 2) The inbox: one row per conversation with its last message and unread count
-- ---------------------------------------------------------------------------
create or replace function public.ws_chat_inbox()
returns table (
  kind            text,          -- dm | group
  peer_id         uuid,          -- the other person, for a direct thread
  conversation_id uuid,          -- the group, for a group thread
  last_id         bigint,
  last_sender     uuid,
  last_body       text,
  last_at         timestamptz,
  unread          bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with dm as (
    select distinct on (x.partner) x.partner, x.id, x.sender_id, x.body, x.created_at
      from (select case when m.sender_id = auth.uid() then m.recipient_id else m.sender_id end as partner,
                   m.id, m.sender_id, m.body, m.created_at
              from public.messages m
             where m.conversation_id is null
               and (m.sender_id = auth.uid() or m.recipient_id = auth.uid())) x
     where x.partner is not null
     order by x.partner, x.id desc
  ), dm_unread as (
    select m.sender_id as partner, count(*) as n
      from public.messages m
     where m.recipient_id = auth.uid() and m.read_at is null and m.deleted_at is null
     group by m.sender_id
  ), mine as (
    select cm.conversation_id, cm.last_read_at
      from public.conversation_members cm
      join public.conversations c on c.id = cm.conversation_id and c.archived_at is null
     where cm.user_id = auth.uid()
  ), g_last as (
    select distinct on (m.conversation_id) m.conversation_id, m.id, m.sender_id, m.body, m.created_at
      from public.messages m
      join mine on mine.conversation_id = m.conversation_id
     order by m.conversation_id, m.id desc
  ), g_unread as (
    select m.conversation_id, count(*) as n
      from public.messages m
      join mine on mine.conversation_id = m.conversation_id
     where m.sender_id <> auth.uid() and m.deleted_at is null
       and (mine.last_read_at is null or m.created_at > mine.last_read_at)
     group by m.conversation_id
  )
  select 'dm'::text, dm.partner, null::uuid, dm.id, dm.sender_id, dm.body, dm.created_at, coalesce(u.n, 0)
    from dm left join dm_unread u on u.partner = dm.partner
  union all
  select 'group'::text, null::uuid, mine.conversation_id, gl.id, gl.sender_id, gl.body, gl.created_at, coalesce(gu.n, 0)
    from mine
    left join g_last gl on gl.conversation_id = mine.conversation_id
    left join g_unread gu on gu.conversation_id = mine.conversation_id;
$$;

-- ---------------------------------------------------------------------------
-- 3) Calls
-- ---------------------------------------------------------------------------
create table if not exists public.calls (
  id              uuid primary key default gen_random_uuid(),
  company         text,
  created_by      uuid not null references public.profiles(id) on delete cascade,   -- the caller
  conversation_id uuid references public.conversations(id) on delete set null,      -- a group call
  media           text not null default 'audio',       -- audio | video (what the call started as)
  status          text not null default 'ringing',     -- ringing | active | ended | missed | declined | busy
  created_at      timestamptz not null default now(),
  answered_at     timestamptz,
  ended_at        timestamptz,
  end_reason      text                                  -- hangup | cancelled | no_answer | declined | busy
);
alter table public.calls drop constraint if exists calls_media_ck;
alter table public.calls add constraint calls_media_ck check (media in ('audio', 'video'));
alter table public.calls drop constraint if exists calls_status_ck;
alter table public.calls add constraint calls_status_ck
  check (status in ('ringing', 'active', 'ended', 'missed', 'declined', 'busy'));
create index if not exists calls_created_by_idx on public.calls (created_by, created_at desc);
create index if not exists calls_conversation_idx on public.calls (conversation_id, created_at desc)
  where conversation_id is not null;
create index if not exists calls_live_idx on public.calls (status) where status in ('ringing', 'active');

create table if not exists public.call_participants (
  call_id      uuid not null references public.calls(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  role         text not null default 'callee',         -- caller | callee
  state        text not null default 'invited',        -- invited | ringing | joined | left | declined | missed | busy
  device_id    text,                                   -- the browser session in the call: one per person
  invited_at   timestamptz not null default now(),
  joined_at    timestamptz,
  left_at      timestamptz,
  last_seen_at timestamptz,                            -- heartbeat while joined
  primary key (call_id, user_id)
);
alter table public.call_participants drop constraint if exists call_participants_role_ck;
alter table public.call_participants add constraint call_participants_role_ck check (role in ('caller', 'callee'));
alter table public.call_participants drop constraint if exists call_participants_state_ck;
alter table public.call_participants add constraint call_participants_state_ck
  check (state in ('invited', 'ringing', 'joined', 'left', 'declined', 'missed', 'busy'));
create index if not exists call_participants_user_idx on public.call_participants (user_id, invited_at desc);
create index if not exists call_participants_live_idx on public.call_participants (user_id)
  where state in ('invited', 'ringing', 'joined');

/** True when the caller may see a call: they were in it, or it is a call in one of their groups. */
create or replace function public.ws_in_call(p_call uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_call is not null and (
    exists (select 1 from public.call_participants p where p.call_id = p_call and p.user_id = auth.uid())
    or exists (select 1 from public.calls c
                where c.id = p_call and c.conversation_id is not null
                  and public.ws_in_conversation(c.conversation_id)));
$$;
grant execute on function public.ws_in_call(uuid) to authenticated;

alter table public.calls             enable row level security;
alter table public.call_participants enable row level security;

-- Read-only from the browser. There are deliberately no insert, update or
-- delete policies: ws_call_start and ws_call_action make every change.
drop policy if exists calls_select on public.calls;
create policy calls_select on public.calls
  for select to authenticated
  using (public.ws_in_call(id));

drop policy if exists call_participants_select on public.call_participants;
create policy call_participants_select on public.call_participants
  for select to authenticated
  using (public.ws_in_call(call_id));

-- ---------------------------------------------------------------------------
-- Settling a call. Internal: run by the functions below, never by a browser.
--
--   an invitation rings for 45 seconds, then it is missed;
--   a joined browser heartbeats every 10 seconds and is gone after 40 silent ones;
--   ringing -> active   when a callee picks up;
--   ringing -> missed / declined / busy  when nobody is left ringing or the caller hung up;
--   active  -> ended    when one person (or nobody) is left and nobody is still ringing.
-- ---------------------------------------------------------------------------
create or replace function public.ws_call_settle(p_call uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status    text;
  v_pending   int;
  v_joined    int;
  v_answered  int;
  v_declined  int;
  v_busy      int;
  v_callees   int;
  v_caller_in boolean;
begin
  select status into v_status from public.calls where id = p_call for update;
  if not found or v_status not in ('ringing', 'active') then return; end if;

  update public.call_participants set state = 'missed'
   where call_id = p_call and state in ('invited', 'ringing') and invited_at < now() - interval '45 seconds';
  update public.call_participants set state = 'left', left_at = coalesce(left_at, now())
   where call_id = p_call and state = 'joined'
     and coalesce(last_seen_at, joined_at, invited_at) < now() - interval '40 seconds';

  select count(*) filter (where state in ('invited', 'ringing')),
         count(*) filter (where state = 'joined'),
         count(*) filter (where role = 'callee' and joined_at is not null),
         count(*) filter (where role = 'callee' and state = 'declined'),
         count(*) filter (where role = 'callee' and state = 'busy'),
         count(*) filter (where role = 'callee'),
         coalesce(bool_or(role = 'caller' and state = 'joined'), false)
    into v_pending, v_joined, v_answered, v_declined, v_busy, v_callees, v_caller_in
    from public.call_participants
   where call_id = p_call;

  if v_status = 'ringing' and v_answered > 0 then
    update public.calls set status = 'active', answered_at = coalesce(answered_at, now()) where id = p_call;
    v_status := 'active';
  end if;

  if v_status = 'ringing' then
    if v_caller_in and v_pending > 0 then return; end if;          -- still ringing
    update public.call_participants set state = 'missed'
     where call_id = p_call and state in ('invited', 'ringing');
    update public.call_participants set state = 'left', left_at = coalesce(left_at, now())
     where call_id = p_call and state = 'joined';
    update public.calls
       set status = case when v_callees > 0 and v_declined + v_busy = v_callees
                         then (case when v_declined > 0 then 'declined' else 'busy' end)
                         else 'missed' end,
           ended_at = now(),
           end_reason = case when not v_caller_in and v_pending > 0 then 'cancelled'
                             when v_callees > 0 and v_declined + v_busy = v_callees
                             then (case when v_declined > 0 then 'declined' else 'busy' end)
                             else 'no_answer' end
     where id = p_call;
    return;
  end if;

  if v_joined = 0 or (v_joined = 1 and v_pending = 0) then
    update public.call_participants set state = 'missed'
     where call_id = p_call and state in ('invited', 'ringing');
    update public.call_participants set state = 'left', left_at = coalesce(left_at, now())
     where call_id = p_call and state = 'joined';
    update public.calls set status = 'ended', ended_at = now(), end_reason = coalesce(end_reason, 'hangup')
     where id = p_call;
  end if;
end;
$$;

/** A call and its people as one JSON document (what every call function returns). Internal. */
create or replace function public.ws_call_state(p_call uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'id', c.id, 'status', c.status, 'media', c.media, 'conversation_id', c.conversation_id,
           'created_by', c.created_by, 'created_at', c.created_at, 'answered_at', c.answered_at,
           'ended_at', c.ended_at, 'end_reason', c.end_reason, 'now', now(),
           'participants', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'user_id', p.user_id, 'role', p.role, 'state', p.state, 'device_id', p.device_id,
                      'invited_at', p.invited_at, 'joined_at', p.joined_at, 'left_at', p.left_at)
                    order by p.role, p.invited_at)
               from public.call_participants p where p.call_id = c.id), '[]'::jsonb))
    from public.calls c
   where c.id = p_call;
$$;

revoke execute on function public.ws_call_settle(uuid) from public, anon, authenticated;
revoke execute on function public.ws_call_state(uuid) from public, anon, authenticated;

-- When a call is over the database writes its one line in the conversation
-- (so it is logged exactly once, even if every browser closed) and tells the
-- people who never picked up.
create or replace function public.calls_after_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secs   int := 0;
  v_status text;
  v_body   text;
  v_peer   uuid;
  v_name   text;
  v_label  text := case when new.media = 'video' then 'video' else 'voice' end;
  v_url    text;
  p        record;
begin
  if old.status not in ('ringing', 'active') or new.status in ('ringing', 'active') then return null; end if;
  if new.answered_at is not null then
    v_secs := greatest(0, round(extract(epoch from (coalesce(new.ended_at, now()) - new.answered_at)))::int);
  end if;
  v_status := case new.status when 'ended' then 'completed' else new.status end;
  v_body := format('__CALL__::%s::%s::%s', new.media, v_status, v_secs);

  if new.conversation_id is not null then
    insert into public.messages (sender_id, conversation_id, body)
    values (new.created_by, new.conversation_id, v_body);
    v_url := '/chat/#group=' || new.conversation_id;
  else
    select user_id into v_peer from public.call_participants
     where call_id = new.id and role = 'callee' order by invited_at limit 1;
    if v_peer is not null then
      -- A call the callee took or turned down is not news to them; a missed one stays unread.
      insert into public.messages (sender_id, recipient_id, body, read_at)
      values (new.created_by, v_peer, v_body, case when v_status in ('completed', 'declined') then now() end);
    end if;
    v_url := '/chat/#thread=' || new.created_by;
  end if;

  select coalesce(full_name, email, 'Someone') into v_name from public.profiles where id = new.created_by;
  for p in select user_id from public.call_participants
            where call_id = new.id and role = 'callee' and state in ('missed', 'busy') and joined_at is null loop
    perform public.ws_notify(p.user_id, 'call.missed', 'Missed ' || v_label || ' call', 'from ' || v_name,
                             v_url, 'call', new.id);
  end loop;
  return null;
end;
$$;
drop trigger if exists calls_log_end on public.calls;
create trigger calls_log_end after update of status on public.calls
  for each row execute procedure public.calls_after_update();

-- ---------------------------------------------------------------------------
-- Call functions (the only way a browser changes a call)
-- ---------------------------------------------------------------------------

/**
 * Start a call. 1:1: p_callees = {peer}. Group: p_conversation = the group;
 * every other member is invited, and if the group already has a live call its
 * id is returned instead so the caller simply joins it. People already in
 * another call are marked busy and do not ring. Returns the call id.
 */
create or replace function public.ws_call_start(p_callees uuid[] default null, p_media text default 'audio',
                                                p_conversation uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me   uuid := auth.uid();
  v_call uuid;
  v_live uuid;
  v_ids  uuid[];
  r      record;
begin
  if v_me is null then raise exception 'Sign in to make calls' using errcode = '42501'; end if;
  if coalesce(p_media, '') not in ('audio', 'video') then
    raise exception 'Unknown call type' using errcode = '22023';
  end if;

  -- Let go of anything left behind (a closed tab, a laptop that went to sleep)
  -- before deciding whether this person is already in a call.
  for r in select call_id from public.call_participants
            where user_id = v_me and state in ('invited', 'ringing', 'joined') loop
    perform public.ws_call_settle(r.call_id);
  end loop;
  if exists (select 1 from public.call_participants cp
               join public.calls c on c.id = cp.call_id
              where cp.user_id = v_me and cp.state = 'joined' and c.status in ('ringing', 'active')) then
    raise exception 'You are already in a call' using errcode = 'P0001';
  end if;

  if p_conversation is not null then
    if not public.ws_in_conversation(p_conversation) then
      raise exception 'You are not in this group' using errcode = '42501';
    end if;
    for r in select id from public.calls
              where conversation_id = p_conversation and status in ('ringing', 'active') loop
      perform public.ws_call_settle(r.id);
    end loop;
    select id into v_live from public.calls
     where conversation_id = p_conversation and status in ('ringing', 'active')
     order by created_at desc limit 1;
    if v_live is not null then return v_live; end if;
    select array_agg(user_id) into v_ids from public.conversation_members
     where conversation_id = p_conversation and user_id <> v_me;
  else
    select array_agg(distinct t.x) into v_ids
      from unnest(coalesce(p_callees, '{}'::uuid[])) as t(x)
     where t.x is not null and t.x <> v_me
       and exists (select 1 from public.profiles p where p.id = t.x);
  end if;

  if coalesce(cardinality(v_ids), 0) = 0 then raise exception 'Nobody to call' using errcode = 'P0001'; end if;
  if cardinality(v_ids) > 7 then raise exception 'A call can have at most 8 people' using errcode = 'P0001'; end if;

  insert into public.calls (company, created_by, conversation_id, media)
  values (public.ws_company(), v_me, p_conversation, p_media)
  returning id into v_call;

  insert into public.call_participants (call_id, user_id, role, state, joined_at, last_seen_at)
  values (v_call, v_me, 'caller', 'joined', now(), now());

  insert into public.call_participants (call_id, user_id, role, state)
  select v_call, t.x, 'callee',
         case when exists (select 1 from public.call_participants cp
                             join public.calls c on c.id = cp.call_id
                            where cp.user_id = t.x and cp.state = 'joined' and c.status in ('ringing', 'active')
                              and coalesce(cp.last_seen_at, cp.joined_at) > now() - interval '40 seconds')
              then 'busy' else 'invited' end
    from unnest(v_ids) as t(x);

  perform public.ws_call_settle(v_call);          -- everyone busy: it settles as 'busy' straight away
  return v_call;
end;
$$;

/**
 * Change my part in a call and get the call back.
 *   ringing   a device of mine received the invitation (the caller sees "Ringing…")
 *   join      pick up / join (a group member who was not rung may join a live group call)
 *   decline   turn the invitation down
 *   leave     hang up (for someone never answered: decline)
 *   heartbeat I am still here (every 10 seconds while joined)
 * leave and heartbeat only count from the device that joined, so an old tab
 * cannot hang up a call its owner has since picked up on another device.
 */
create or replace function public.ws_call_action(p_call uuid, p_action text, p_device text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me     uuid := auth.uid();
  v_status text;
  v_mine   public.call_participants%rowtype;
begin
  if v_me is null or p_call is null or not public.ws_in_call(p_call) then
    raise exception 'Call not found' using errcode = '42501';
  end if;
  perform public.ws_call_settle(p_call);
  select status into v_status from public.calls where id = p_call;
  select * into v_mine from public.call_participants where call_id = p_call and user_id = v_me;

  if p_action = 'ringing' then
    update public.call_participants set state = 'ringing'
     where call_id = p_call and user_id = v_me and state = 'invited';
  elsif p_action = 'join' then
    if v_status not in ('ringing', 'active') then
      raise exception 'This call has ended' using errcode = 'P0001';
    end if;
    if v_mine.user_id is null then
      if (select count(*) from public.call_participants where call_id = p_call and state = 'joined') >= 8 then
        raise exception 'This call is full' using errcode = 'P0001';
      end if;
      insert into public.call_participants (call_id, user_id, role, state, joined_at, last_seen_at, device_id)
      values (p_call, v_me, 'callee', 'joined', now(), now(), p_device);
    else
      update public.call_participants
         set state = 'joined', joined_at = coalesce(joined_at, now()), left_at = null,
             last_seen_at = now(), device_id = p_device
       where call_id = p_call and user_id = v_me;
    end if;
  elsif p_action = 'decline' then
    update public.call_participants set state = 'declined'
     where call_id = p_call and user_id = v_me and state in ('invited', 'ringing');
  elsif p_action = 'leave' then
    update public.call_participants set state = 'left', left_at = now()
     where call_id = p_call and user_id = v_me and state = 'joined'
       and (p_device is null or device_id is null or device_id = p_device);
    update public.call_participants set state = 'declined'
     where call_id = p_call and user_id = v_me and state in ('invited', 'ringing');
  elsif p_action = 'heartbeat' then
    update public.call_participants set last_seen_at = now()
     where call_id = p_call and user_id = v_me and state = 'joined'
       and (p_device is null or device_id is null or device_id = p_device);
  else
    raise exception 'Unknown call action' using errcode = '22023';
  end if;

  perform public.ws_call_settle(p_call);
  return public.ws_call_state(p_call);
end;
$$;

/** One call (settled first). */
create or replace function public.ws_call_get(p_call uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or p_call is null or not public.ws_in_call(p_call) then
    raise exception 'Call not found' using errcode = '42501';
  end if;
  perform public.ws_call_settle(p_call);
  return public.ws_call_state(p_call);
end;
$$;

/** My live calls: ringing for me, or joined. A page loaded mid-ring shows the incoming call. */
create or replace function public.ws_call_live()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r     record;
  v_out jsonb;
begin
  if auth.uid() is null then return '[]'::jsonb; end if;
  for r in select distinct cp.call_id from public.call_participants cp
             join public.calls c on c.id = cp.call_id
            where cp.user_id = auth.uid() and cp.state in ('invited', 'ringing', 'joined')
              and c.status in ('ringing', 'active') loop
    perform public.ws_call_settle(r.call_id);
  end loop;
  select coalesce(jsonb_agg(public.ws_call_state(c.id) order by c.created_at desc), '[]'::jsonb) into v_out
    from public.calls c
    join public.call_participants cp on cp.call_id = c.id and cp.user_id = auth.uid()
   where cp.state in ('invited', 'ringing', 'joined') and c.status in ('ringing', 'active');
  return v_out;
end;
$$;

grant execute on function public.ws_chat_inbox(), public.ws_call_start(uuid[], text, uuid),
  public.ws_call_action(uuid, text, text), public.ws_call_get(uuid), public.ws_call_live() to authenticated;

-- Live updates: an invitation, an answer on another device or a hang-up
-- reaches every browser involved at once. RLS still decides who receives what.
do $$
declare t text;
begin
  foreach t in array array['calls', 'call_participants'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end$$;

-- ---------------------------------------------------------------------------
-- 4) Chat attachments are private to their conversation
--
-- The original chat-files policy let any signed-in user read (and list) every
-- file in the bucket, across companies. A file is now readable by the person
-- who uploaded it and by whoever can see a message that carries it, so
-- clearing a chat or deleting a message for everyone also withdraws the file.
-- Uploads are unchanged: still only into your own folder.
-- ---------------------------------------------------------------------------
create index if not exists messages_file_path_idx
  on public.messages ((split_part(body, '::', 2))) where body like '\_\_FILE\_\_::%';

create or replace function public.ws_chat_file_visible(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_name is not null and auth.uid() is not null and (
    (storage.foldername(p_name))[1] = auth.uid()::text
    or exists (select 1 from public.messages m
                where m.body like '\_\_FILE\_\_::%' and split_part(m.body, '::', 2) = p_name
                  and (m.sender_id = auth.uid() or m.recipient_id = auth.uid()
                       or (m.conversation_id is not null and public.ws_in_conversation(m.conversation_id)))));
$$;
grant execute on function public.ws_chat_file_visible(text) to authenticated;

drop policy if exists "chat files read all" on storage.objects;
drop policy if exists chat_files_read on storage.objects;
create policy chat_files_read on storage.objects
  for select to authenticated
  using (bucket_id = 'chat-files' and public.ws_chat_file_visible(name));

-- Done. Messenger & calls v2 is applied.
