-- ============================================================================
-- Favourite records (migration 21). Run AFTER supabase-task-completion-migration.sql
-- (20). Idempotent; adds one table and two functions.
--
-- A person can star tasks, deals, projects and documents; the command palette
-- (Ctrl+K) lists them first. Each person sees only their own favourites.
--
-- Favourites never leak what a person cannot see:
--   - starring a record is refused unless the person can see it now;
--   - ws_my_favorites() runs with the caller's own Row Level Security, so a
--     record that was deleted, archived, or is no longer theirs to see simply
--     drops out — its title is never returned.
-- ============================================================================

create table if not exists public.user_favorites (
  user_id     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  entity_type text not null check (entity_type in ('task', 'deal', 'project', 'document')),
  entity_id   uuid not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, entity_type, entity_id)
);
create index if not exists user_favorites_recent_idx on public.user_favorites (user_id, created_at desc);
alter table public.user_favorites enable row level security;

/** Can the caller see this record right now? Runs with their own RLS. */
create or replace function public.ws_can_see_record(p_type text, p_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select case p_type
    when 'task'     then exists (select 1 from public.tasks t where t.id = p_id and t.archived_at is null)
    when 'deal'     then exists (select 1 from public.crm_deals d where d.id = p_id and d.archived_at is null)
    when 'project'  then exists (select 1 from public.projects p where p.id = p_id and p.archived_at is null)
    when 'document' then exists (select 1 from public.documents d where d.id = p_id and d.archived_at is null)
    else false end;
$$;

drop policy if exists user_favorites_own_read on public.user_favorites;
create policy user_favorites_own_read on public.user_favorites for select to authenticated
  using (user_id = auth.uid());
drop policy if exists user_favorites_own_add on public.user_favorites;
create policy user_favorites_own_add on public.user_favorites for insert to authenticated
  with check (user_id = auth.uid() and public.ws_can_see_record(entity_type, entity_id));
drop policy if exists user_favorites_own_remove on public.user_favorites;
create policy user_favorites_own_remove on public.user_favorites for delete to authenticated
  using (user_id = auth.uid());

/**
 * The caller's favourites that they can still open, newest first, with a
 * title and a link. Runs with the caller's RLS: no title of a record they
 * cannot see is ever returned.
 */
create or replace function public.ws_my_favorites()
returns table (entity_type text, entity_id uuid, title text, url text, created_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select f.entity_type, f.entity_id,
         coalesce(t.title, d.title, p.name, doc.name) as title,
         case f.entity_type when 'task' then '/tasks/?id=' when 'deal' then '/deals/?id='
                            when 'project' then '/projects/?id=' else '/documents/?id=' end || f.entity_id as url,
         f.created_at
    from public.user_favorites f
    left join public.tasks t       on f.entity_type = 'task'     and t.id = f.entity_id   and t.archived_at is null
    left join public.crm_deals d   on f.entity_type = 'deal'     and d.id = f.entity_id   and d.archived_at is null
    left join public.projects p    on f.entity_type = 'project'  and p.id = f.entity_id   and p.archived_at is null
    left join public.documents doc on f.entity_type = 'document' and doc.id = f.entity_id and doc.archived_at is null
   where f.user_id = auth.uid()
     and coalesce(t.id, d.id, p.id, doc.id) is not null
   order by f.created_at desc
   limit 50;
$$;

revoke execute on function public.ws_can_see_record(text, uuid), public.ws_my_favorites() from public, anon;
grant execute on function public.ws_can_see_record(text, uuid), public.ws_my_favorites() to authenticated;
grant select, insert, delete on public.user_favorites to authenticated;

select public.ws_apply_session_gate();

-- Done.
