-- ============================================================================
-- Notification preferences and quiet hours (migration 22). Run AFTER
-- supabase-favorites-migration.sql (21). Idempotent; adds one table.
--
-- Each person chooses which kinds of push notifications they get and when
-- their phone stays quiet. Only PUSH delivery follows these settings: every
-- notification still lands in the bell, unread, as before. With no row
-- (everyone today) nothing changes — every push is sent, as before.
--
-- Policy (lib/notify-prefs.js applies it at delivery time):
--   - push_enabled = false: no pushes at all. Calls still ring in any open
--     WorkSuite tab, which does not use push.
--   - muted_categories: no pushes of those kinds.
--   - quiet hours (quiet_start..quiet_end in the person's time zone, across
--     midnight when start > end): no pushes, except incoming calls while
--     calls_in_quiet is on (the default: a call is someone trying to reach
--     you now). A reminder held back by quiet hours is pushed by a later run
--     the same day; muted or switched-off ones are not.
-- ============================================================================

create table if not exists public.notification_prefs (
  user_id          uuid primary key default auth.uid() references public.profiles(id) on delete cascade,
  push_enabled     boolean not null default true,
  muted_categories text[] not null default '{}',
  quiet_enabled    boolean not null default false,
  quiet_start      time not null default '22:00',
  quiet_end        time not null default '07:00',
  timezone         text not null default 'Asia/Kolkata',
  calls_in_quiet   boolean not null default true,
  updated_at       timestamptz not null default now()
);
alter table public.notification_prefs drop constraint if exists notification_prefs_categories_ck;
alter table public.notification_prefs add constraint notification_prefs_categories_ck
  check (muted_categories <@ array['messages', 'tasks', 'crm', 'calendar', 'projects', 'documents', 'reminders', 'other']::text[]);
alter table public.notification_prefs drop constraint if exists notification_prefs_timezone_ck;
alter table public.notification_prefs add constraint notification_prefs_timezone_ck
  check (timezone ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+){0,2}$' and length(timezone) <= 64);

-- A real time zone name, checked against the database's own list.
create or replace function public.notification_prefs_check()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'Unknown time zone %', new.timezone using errcode = '22023';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists notification_prefs_check on public.notification_prefs;
create trigger notification_prefs_check before insert or update on public.notification_prefs
  for each row execute procedure public.notification_prefs_check();

alter table public.notification_prefs enable row level security;
drop policy if exists notification_prefs_own on public.notification_prefs;
create policy notification_prefs_own on public.notification_prefs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update on public.notification_prefs to authenticated;

select public.ws_apply_session_gate();

-- Done.
