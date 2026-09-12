-- ============================================================
-- Messenger — a person's own marks on a message: Favourites and
-- "read later". One row per (message, person, kind); nobody else can
-- see what someone has marked.
--
-- Safe to run more than once. Existing messages are untouched: without
-- this table Messenger simply leaves those two menu items out.
-- Run in Supabase → SQL Editor.
-- ============================================================

create table if not exists public.message_flags (
  id         bigserial primary key,
  message_id bigint references public.messages(id) on delete cascade not null,
  user_id    uuid references auth.users on delete cascade not null,
  kind       text not null,
  created_at timestamptz not null default now(),
  unique (message_id, user_id, kind)
);

alter table public.message_flags drop constraint if exists message_flags_kind_ck;
alter table public.message_flags add constraint message_flags_kind_ck
  check (kind in ('favorite', 'later'));

create index if not exists message_flags_mine_idx on public.message_flags (user_id, kind, created_at desc);

alter table public.message_flags enable row level security;

drop policy if exists "flags_select_own" on public.message_flags;
drop policy if exists "flags_insert_own" on public.message_flags;
drop policy if exists "flags_delete_own" on public.message_flags;

-- A mark is private: only its owner reads, adds or removes it.
create policy "flags_select_own" on public.message_flags
  for select using (auth.uid() = user_id);

create policy "flags_insert_own" on public.message_flags
  for insert with check (auth.uid() = user_id);

create policy "flags_delete_own" on public.message_flags
  for delete using (auth.uid() = user_id);
