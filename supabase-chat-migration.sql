-- ============================================================
-- Chat + Calls — messages table + presence support
-- Run this ONCE in Supabase → SQL Editor → New query → Run.
-- Safe to re-run (idempotent).
-- ============================================================

create table if not exists public.messages (
  id            bigserial primary key,
  sender_id     uuid references auth.users on delete cascade not null,
  recipient_id  uuid references auth.users on delete cascade not null,
  body          text not null,
  created_at    timestamptz default now(),
  read_at       timestamptz
);

create index if not exists messages_sender_recipient_idx  on public.messages (sender_id, recipient_id, created_at desc);
create index if not exists messages_recipient_created_idx on public.messages (recipient_id, created_at desc);

alter table public.messages enable row level security;

drop policy if exists "msg_select_own"       on public.messages;
drop policy if exists "msg_insert_own"       on public.messages;
drop policy if exists "msg_update_recipient" on public.messages;

-- You can read messages you sent or received
create policy "msg_select_own" on public.messages for select
  using (auth.uid() = sender_id or auth.uid() = recipient_id);

-- You can only insert messages as yourself
create policy "msg_insert_own" on public.messages for insert
  with check (auth.uid() = sender_id);

-- Recipient can update (to mark as read)
create policy "msg_update_recipient" on public.messages for update
  using (auth.uid() = recipient_id);

-- Enable realtime broadcasting on the messages table
-- (skips silently if already added)
do $$
begin
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'messages') then
        alter publication supabase_realtime add table public.messages;
    end if;
end$$;

-- Helper view for chat threads: last message per conversation partner
-- (Ignore any errors if underlying tables aren't ready.)
