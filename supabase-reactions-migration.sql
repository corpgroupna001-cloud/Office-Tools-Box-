-- ============================================================
-- Chat reactions — one row per (message, user, emoji)
-- Run once in Supabase → SQL Editor.
-- ============================================================

create table if not exists public.message_reactions (
  id         bigserial primary key,
  message_id bigint references public.messages(id) on delete cascade not null,
  user_id    uuid references auth.users on delete cascade not null,
  emoji      text not null,
  created_at timestamptz default now(),
  unique (message_id, user_id, emoji)
);

create index if not exists reactions_msg_idx on public.message_reactions (message_id);

alter table public.message_reactions enable row level security;

drop policy if exists "reactions_select_all" on public.message_reactions;
drop policy if exists "reactions_insert_own" on public.message_reactions;
drop policy if exists "reactions_delete_own" on public.message_reactions;

-- Anyone in the conversation can see reactions
create policy "reactions_select_all" on public.message_reactions
  for select using (
    exists (
      select 1 from public.messages m
      where m.id = message_id
      and (m.sender_id = auth.uid() or m.recipient_id = auth.uid())
    )
  );

-- Users can only add their own reactions
create policy "reactions_insert_own" on public.message_reactions
  for insert with check (auth.uid() = user_id);

-- Users can only remove their own reactions
create policy "reactions_delete_own" on public.message_reactions
  for delete using (auth.uid() = user_id);

-- Enable realtime
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'message_reactions') then
    alter publication supabase_realtime add table public.message_reactions;
  end if;
end$$;
