-- ============================================================
-- Keep public.profiles.email in step with a confirmed email change
--
-- Supabase only swaps auth.users.email when the person opens the
-- confirmation link, which usually happens in a different browser
-- session - often on a different device - from the one that asked
-- for the change. So the sync cannot live in the page that made the
-- request; it has to hang off the update itself.
--
-- Everything else in the app reads profiles.email (chat, the daily
-- attendance mail, the admin lists), so without this the person would
-- change their address and keep receiving mail at the old one.
--
-- Run ONCE in Supabase -> SQL Editor. Idempotent.
-- ============================================================

create or replace function public.sync_profile_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- `after update of email` still fires when other columns change in the
  -- same statement, so compare before writing. is distinct from, not <>,
  -- because a null on either side would make <> return null and skip a
  -- change that really happened.
  if new.email is distinct from old.email then
    update public.profiles
       set email = new.email
     where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute procedure public.sync_profile_email();
