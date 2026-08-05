-- ============================================================
-- MCQ Quiz — new table for quiz results.
-- Run this ONCE in Supabase → SQL Editor → New query → Run.
-- Safe to re-run (idempotent).
-- ============================================================

create table if not exists public.quiz_results (
  id             bigserial primary key,
  user_id        uuid references auth.users on delete cascade,
  full_name      text,
  email          text,
  category       text,
  category_label text,
  score          int,
  total          int,
  accuracy       int,
  time_sec       int,
  difficulty     text,
  violations     int default 0,
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

create policy "quiz_select_authenticated" on public.quiz_results
  for select to authenticated using (true);

create policy "quiz_insert_own" on public.quiz_results
  for insert to authenticated with check (auth.uid() = user_id);
