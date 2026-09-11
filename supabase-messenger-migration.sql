-- ============================================================================
-- Messenger: group conversations, replies, edits, pins and read state on top
-- of the existing chat.
--
-- Run FOURTH of the CRM set. Idempotent; adds only.
--
-- Existing direct messages are untouched: they keep sender_id + recipient_id
-- and a null conversation_id, and every old policy still applies to them.
-- Group messages carry conversation_id and a null recipient_id.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Conversations (groups). A direct thread stays what it was: two user ids.
-- ---------------------------------------------------------------------------
create table if not exists public.conversations (
  id          uuid primary key default gen_random_uuid(),
  company     text,
  name        text not null,
  description text,
  kind        text not null default 'group',           -- group | project (auto-created for a project)
  project_id  uuid references public.projects(id) on delete set null,
  avatar_url  text,
  created_by  uuid references public.profiles(id) on delete set null,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.conversations drop constraint if exists conversations_kind_ck;
alter table public.conversations add constraint conversations_kind_ck check (kind in ('group', 'project'));
create index if not exists conversations_company_idx on public.conversations (company) where archived_at is null;

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  role            text not null default 'member',       -- member | admin
  added_by        uuid references public.profiles(id) on delete set null,
  last_read_at    timestamptz,                          -- read state for unread counts
  muted           boolean not null default false,
  created_at      timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
alter table public.conversation_members drop constraint if exists conversation_members_role_ck;
alter table public.conversation_members add constraint conversation_members_role_ck check (role in ('member', 'admin'));
create index if not exists conversation_members_user_idx on public.conversation_members (user_id);

/** True when the caller is in the conversation. */
create or replace function public.ws_in_conversation(p_conversation uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_conversation is not null and exists (
    select 1 from public.conversation_members m
     where m.conversation_id = p_conversation and m.user_id = auth.uid());
$$;
grant execute on function public.ws_in_conversation(uuid) to authenticated;

/** True when the caller may manage a conversation (creator, conversation admin, or workspace manager). */
create or replace function public.ws_conversation_admin(p_conversation uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.conversations c
     where c.id = p_conversation
       and (c.created_by = auth.uid()
            or exists (select 1 from public.conversation_members m
                        where m.conversation_id = c.id and m.user_id = auth.uid() and m.role = 'admin')
            or (public.ws_is_manager() and public.ws_same_company(c.company))));
$$;
grant execute on function public.ws_conversation_admin(uuid) to authenticated;

drop trigger if exists conversations_fill on public.conversations;
create trigger conversations_fill before insert on public.conversations
  for each row execute procedure public.ws_fill_owner_cols();
drop trigger if exists conversations_touch on public.conversations;
create trigger conversations_touch before update on public.conversations
  for each row execute procedure public.ws_touch_updated_at();

-- The creator is always a member and an admin of what they create.
create or replace function public.conversations_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.conversation_members (conversation_id, user_id, role, added_by, last_read_at)
  values (new.id, coalesce(new.created_by, auth.uid()), 'admin', new.created_by, now())
  on conflict do nothing;
  return new;
end;
$$;
drop trigger if exists conversations_creator_member on public.conversations;
create trigger conversations_creator_member after insert on public.conversations
  for each row execute procedure public.conversations_after_insert();

create or replace function public.conversation_members_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare c record;
begin
  select id, name into c from public.conversations where id = new.conversation_id;
  perform public.ws_notify(new.user_id, 'conversation.added', 'Added to a group', c.name,
    '/chat/#group=' || c.id, 'conversation', c.id);
  return new;
end;
$$;
drop trigger if exists conversation_members_notify on public.conversation_members;
create trigger conversation_members_notify after insert on public.conversation_members
  for each row execute procedure public.conversation_members_after_insert();

-- ---------------------------------------------------------------------------
-- 2) Messages: group + reply + edit + pin + soft delete
-- ---------------------------------------------------------------------------
alter table public.messages alter column recipient_id drop not null;
alter table public.messages
  add column if not exists conversation_id uuid references public.conversations(id) on delete cascade,
  add column if not exists reply_to_id     bigint references public.messages(id) on delete set null,
  add column if not exists edited_at       timestamptz,
  add column if not exists deleted_at      timestamptz,
  add column if not exists pinned_at       timestamptz,
  add column if not exists pinned_by       uuid references public.profiles(id) on delete set null,
  add column if not exists mentions        uuid[] not null default '{}';

-- A message is either a direct message (recipient) or a group message
-- (conversation), never both and never neither.
alter table public.messages drop constraint if exists messages_target_ck;
alter table public.messages add constraint messages_target_ck
  check ((recipient_id is not null and conversation_id is null)
      or (recipient_id is null and conversation_id is not null));

create index if not exists messages_conversation_idx on public.messages (conversation_id, created_at desc)
  where conversation_id is not null;
create index if not exists messages_pinned_idx on public.messages (conversation_id, pinned_at desc)
  where pinned_at is not null;
create index if not exists messages_reply_idx on public.messages (reply_to_id) where reply_to_id is not null;

-- The original chat policy lets a sender insert any row carrying their own
-- sender_id. Now that a message can target a conversation, that policy is
-- limited to direct messages — otherwise anyone could post into a group they
-- are not in by knowing its id. Direct messages behave exactly as before.
drop policy if exists "msg_insert_own" on public.messages;
create policy "msg_insert_own" on public.messages
  for insert
  with check (auth.uid() = sender_id and conversation_id is null);

-- A reaction needs a message the reactor can actually see.
drop policy if exists "reactions_insert_own" on public.message_reactions;
create policy "reactions_insert_own" on public.message_reactions
  for insert
  with check (auth.uid() = user_id and exists (select 1 from public.messages m where m.id = message_id));

-- Group members may read; a member may post as themselves.
drop policy if exists msg_select_group on public.messages;
create policy msg_select_group on public.messages
  for select to authenticated
  using (conversation_id is not null and public.ws_in_conversation(conversation_id));

drop policy if exists msg_insert_group on public.messages;
create policy msg_insert_group on public.messages
  for insert to authenticated
  with check (conversation_id is not null and sender_id = auth.uid() and public.ws_in_conversation(conversation_id));

-- Pin / unpin: any member of a group; either side of a direct thread.
-- (Editing the body is already covered by msg_update_own; pinning needs a
-- policy that lets someone other than the author touch the row.)
drop policy if exists msg_update_pin on public.messages;
create policy msg_update_pin on public.messages
  for update to authenticated
  using ((conversation_id is not null and public.ws_in_conversation(conversation_id))
         or auth.uid() = sender_id or auth.uid() = recipient_id);

drop policy if exists msg_delete_group_own on public.messages;
create policy msg_delete_group_own on public.messages
  for delete to authenticated
  using (conversation_id is not null and (sender_id = auth.uid() or public.ws_conversation_admin(conversation_id)));

-- Only the author edits the text; anyone allowed by the update policies may
-- change pin state; edited_at is stamped by the database.
create or replace function public.messages_before_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
begin
  if v_role = 'authenticated' then
    if new.body is distinct from old.body then
      if old.sender_id <> auth.uid() then
        raise exception 'Only the author can edit a message' using errcode = '42501';
      end if;
      if new.body <> '__DELETED__' then new.edited_at := now(); else new.deleted_at := now(); end if;
    end if;
    if new.pinned_at is distinct from old.pinned_at then
      new.pinned_by := case when new.pinned_at is null then null else auth.uid() end;
    end if;
    -- Someone else may pin a message or (in a DM) mark it read, nothing more.
    if old.sender_id is distinct from auth.uid() then
      new.edited_at := old.edited_at; new.deleted_at := old.deleted_at; new.mentions := old.mentions;
    end if;
    -- Nothing else on a message is mutable from the browser.
    new.sender_id := old.sender_id; new.recipient_id := old.recipient_id;
    new.conversation_id := old.conversation_id; new.created_at := old.created_at;
    new.reply_to_id := old.reply_to_id;
  end if;
  return new;
end;
$$;
drop trigger if exists messages_guard_update on public.messages;
create trigger messages_guard_update before update on public.messages
  for each row execute procedure public.messages_before_update();

-- Mentions and group activity: tell the people named, and mark the sender as
-- having read their own message.
create or replace function public.messages_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  u uuid;
  v_name text;
  v_preview text;
  v_url text;
begin
  select coalesce(full_name, email, 'Someone') into v_name from public.profiles where id = new.sender_id;
  v_preview := left(regexp_replace(new.body, '\s+', ' ', 'g'), 120);
  if new.body like '\_\_FILE\_\_::%' then v_preview := 'Sent a file'; end if;
  if new.conversation_id is not null then
    v_url := '/chat/#group=' || new.conversation_id;
    update public.conversation_members set last_read_at = now()
     where conversation_id = new.conversation_id and user_id = new.sender_id;
  else
    v_url := '/chat/#thread=' || new.sender_id;
  end if;
  foreach u in array new.mentions loop
    perform public.ws_notify(u, 'mention', v_name || ' mentioned you', v_preview, v_url, 'message', null);
  end loop;
  return new;
end;
$$;
drop trigger if exists messages_notify on public.messages;
create trigger messages_notify after insert on public.messages
  for each row execute procedure public.messages_after_insert();

-- Reactions on group messages: the existing policy only knows sender/recipient.
drop policy if exists reactions_select_group on public.message_reactions;
create policy reactions_select_group on public.message_reactions
  for select to authenticated
  using (exists (select 1 from public.messages m
                  where m.id = message_id and m.conversation_id is not null
                    and public.ws_in_conversation(m.conversation_id)));

-- ---------------------------------------------------------------------------
-- 3) Conversations RLS
-- ---------------------------------------------------------------------------
alter table public.conversations        enable row level security;
alter table public.conversation_members enable row level security;

drop policy if exists conversations_select on public.conversations;
create policy conversations_select on public.conversations for select to authenticated
  using (public.ws_in_conversation(id) or created_by = auth.uid());
drop policy if exists conversations_insert on public.conversations;
create policy conversations_insert on public.conversations for insert to authenticated
  with check (created_by = auth.uid() and (select public.ws_same_company(company)));
drop policy if exists conversations_update on public.conversations;
create policy conversations_update on public.conversations for update to authenticated
  using (public.ws_conversation_admin(id)) with check (public.ws_conversation_admin(id));
drop policy if exists conversations_delete on public.conversations;
create policy conversations_delete on public.conversations for delete to authenticated
  using (public.ws_conversation_admin(id));

drop policy if exists conversation_members_select on public.conversation_members;
create policy conversation_members_select on public.conversation_members for select to authenticated
  using (public.ws_in_conversation(conversation_id));
drop policy if exists conversation_members_insert on public.conversation_members;
create policy conversation_members_insert on public.conversation_members for insert to authenticated
  with check (public.ws_conversation_admin(conversation_id));
drop policy if exists conversation_members_update on public.conversation_members;
create policy conversation_members_update on public.conversation_members for update to authenticated
  using (user_id = auth.uid() or public.ws_conversation_admin(conversation_id))
  with check (user_id = auth.uid() or public.ws_conversation_admin(conversation_id));
drop policy if exists conversation_members_delete on public.conversation_members;
create policy conversation_members_delete on public.conversation_members for delete to authenticated
  using (user_id = auth.uid() or public.ws_conversation_admin(conversation_id));   -- leave, or be removed

-- A member's read marker is theirs alone; role changes need an admin.
create or replace function public.conversation_members_before_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'authenticated'
     and new.role is distinct from old.role
     and not public.ws_conversation_admin(new.conversation_id) then
    raise exception 'Only a group admin can change roles' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists conversation_members_guard on public.conversation_members;
create trigger conversation_members_guard before update on public.conversation_members
  for each row execute procedure public.conversation_members_before_update();

-- ---------------------------------------------------------------------------
-- 4) Unread counts in one call (direct + group), for the shell badge.
-- ---------------------------------------------------------------------------
create or replace function public.ws_unread_counts()
returns table (direct_unread bigint, group_unread bigint, total bigint)
language sql
stable
security definer
set search_path = public
as $$
  with d as (
    select count(*) as n from public.messages
     where recipient_id = auth.uid() and read_at is null and deleted_at is null
  ), g as (
    select count(*) as n
      from public.messages m
      join public.conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = auth.uid()
     where m.sender_id <> auth.uid() and m.deleted_at is null and not cm.muted
       and (cm.last_read_at is null or m.created_at > cm.last_read_at)
  )
  select d.n, g.n, d.n + g.n from d, g;
$$;
grant execute on function public.ws_unread_counts() to authenticated;

-- Realtime already publishes messages and message_reactions. Add membership
-- (a new group shows up without a reload) and conversations (a rename or an
-- archive reaches every member live). RLS still decides who receives what.
do $$
declare t text;
begin
  foreach t in array array['conversation_members', 'conversations'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end$$;

-- Done. All four CRM migrations are now applied.
