-- ============================================================
-- WorkSuite / ZenType — Supabase schema
-- Run this ONCE in your Supabase project:
--   Supabase Dashboard → SQL Editor → New query → paste all → Run
-- ============================================================

-- --- Profiles table (one row per user, auto-created on signup) ---
create table if not exists public.profiles (
  id         uuid references auth.users on delete cascade primary key,
  email      text unique,
  full_name  text,
  created_at timestamptz default now()
);

-- --- Test results table ---
create table if not exists public.test_results (
  id           bigserial primary key,
  user_id      uuid references auth.users on delete cascade,
  full_name    text,
  email        text,
  wpm          int,
  accuracy     int,
  cpm          int,
  keystrokes   int,
  errors       int,
  duration     int,
  theme        text,
  theme_label  text,
  category     text,
  person       text,
  created_at   timestamptz default now()
);

create index if not exists test_results_user_id_idx  on public.test_results (user_id);
create index if not exists test_results_created_idx  on public.test_results (created_at desc);

-- --- Row Level Security ---
alter table public.profiles      enable row level security;
alter table public.test_results  enable row level security;

drop policy if exists "profiles_select_own"           on public.profiles;
drop policy if exists "profiles_select_authenticated" on public.profiles;
drop policy if exists "profiles_insert_own"           on public.profiles;
drop policy if exists "profiles_update_own"           on public.profiles;
-- All authenticated users can see everyone's profile (needed for chat contacts list, leaderboard names, etc.)
create policy "profiles_select_authenticated" on public.profiles for select to authenticated using (true);
create policy "profiles_insert_own" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id);

drop policy if exists "results_select_own"           on public.test_results;
drop policy if exists "results_select_authenticated" on public.test_results;
drop policy if exists "results_insert_own"           on public.test_results;
-- All authenticated users can read any result (needed for Leaderboard).
-- Only the owner can insert their own row.
create policy "results_select_authenticated" on public.test_results for select to authenticated using (true);
create policy "results_insert_own"           on public.test_results for insert to authenticated with check (auth.uid() = user_id);

-- --- Leaderboard view (best score per user) ---
create or replace view public.leaderboard as
select
  user_id,
  full_name,
  max(wpm)        as best_wpm,
  max(accuracy)   as best_accuracy,
  count(*)::int   as tests_taken,
  max(created_at) as last_test_at
from public.test_results
group by user_id, full_name
order by best_wpm desc nulls last, best_accuracy desc nulls last;

grant select on public.leaderboard to authenticated;

-- --- Auto-create profile row on signup ---
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- MCQ Quiz results table (dedicated so quiz stats don't pollute typing stats)
-- ============================================================
create table if not exists public.quiz_results (
  id             bigserial primary key,
  user_id        uuid references auth.users on delete cascade,
  full_name      text,
  email          text,
  category       text,       -- 'mac' | 'windows' | 'vscode' | 'chrome' | 'excel' | 'logic' | 'math' | 'gk' | 'aptitude' | 'riddles' | 'ai'
  category_label text,       -- 'MacBook' | 'AI: Ancient Rome' | etc.
  score          int,
  total          int,
  accuracy       int,        -- percentage 0-100
  time_sec       int,
  difficulty     text,       -- 'easy' | 'medium' | 'hard' | 'mixed'
  violations     int default 0,       -- how many times user switched tabs / lost focus
  auto_submitted boolean default false,
  ai_generated   boolean default false,
  ai_topic       text,
  created_at     timestamptz default now()
);

create index if not exists quiz_results_user_id_idx  on public.quiz_results (user_id);
create index if not exists quiz_results_created_idx  on public.quiz_results (created_at desc);
create index if not exists quiz_results_category_idx on public.quiz_results (category);

alter table public.quiz_results enable row level security;

drop policy if exists "quiz_select_authenticated" on public.quiz_results;
drop policy if exists "quiz_insert_own"           on public.quiz_results;
create policy "quiz_select_authenticated" on public.quiz_results for select to authenticated using (true);
create policy "quiz_insert_own"           on public.quiz_results for insert to authenticated with check (auth.uid() = user_id);

-- Done. The admin dashboard uses the service_role key (bypasses RLS) to see all results.
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
