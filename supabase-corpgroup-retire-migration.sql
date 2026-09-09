-- Retire the CORPGROUP company name. Everything on it moves to
-- "Nova Sportsmart Private Limited", which already shared its sender mailbox
-- (SMTP_USER_1) and its Bitrix group ("SportsMart Working Hours").
--
-- Attendance, payroll, leave and typing history are keyed on user_id, not on
-- the company name, so nothing is lost — the people keep every record they had.
-- Run this BEFORE deploying the release that drops CORPGROUP from lib/mailer.js,
-- otherwise punches for anyone still on CORPGROUP would fail to find a sender.
begin;

-- The allowed-company CHECK has to go first: it still lists CORPGROUP, and
-- would block the very UPDATE that empties it.
alter table public.profiles drop constraint if exists profiles_company_allowed_ck;

-- ---------- 1) People ----------
update public.profiles set company  = 'Nova Sportsmart Private Limited' where company  = 'CORPGROUP';
update public.profiles set company2 = 'Nova Sportsmart Private Limited' where company2 = 'CORPGROUP';
-- A dual-role person whose two roles have now collapsed into one company has no
-- second role left. Both columns clear together — a secondary shift without a
-- secondary company is rejected by the employee editor.
update public.profiles set company2 = null, shift2_id = null
  where company2 is not null and company2 = company;

-- ---------- 2) Per-company settings ----------
-- company is unique in these tables, so a CORPGROUP row cannot simply be
-- renamed onto an existing Nova row: keep Nova's settings, drop the duplicate.
delete from public.company_policies
  where company = 'CORPGROUP'
    and exists (select 1 from public.company_policies where company = 'Nova Sportsmart Private Limited');
update public.company_policies set company = 'Nova Sportsmart Private Limited' where company = 'CORPGROUP';

delete from public.bitrix_targets
  where company = 'CORPGROUP'
    and exists (select 1 from public.bitrix_targets where company = 'Nova Sportsmart Private Limited');
update public.bitrix_targets set company = 'Nova Sportsmart Private Limited' where company = 'CORPGROUP';

-- ---------- 3) Holidays ----------
-- One holiday per date per company. Where Nova already has that date, the
-- CORPGROUP copy is redundant; otherwise it becomes Nova's.
delete from public.holidays h
  where h.company = 'CORPGROUP'
    and exists (select 1 from public.holidays n
                where n.holiday_date = h.holiday_date
                  and n.company = 'Nova Sportsmart Private Limited');
update public.holidays set company = 'Nova Sportsmart Private Limited' where company = 'CORPGROUP';

-- ---------- 4) History (labels only — no unique constraint to worry about) ----------
update public.bitrix_log set company = 'Nova Sportsmart Private Limited' where company = 'CORPGROUP';
-- mail_events only exists after supabase-admin-management-migration.sql.
do $$ begin
  if to_regclass('public.mail_events') is not null then
    update public.mail_events set company = 'Nova Sportsmart Private Limited' where company = 'CORPGROUP';
  end if;
end $$;

-- ---------- 5) Put the guard back, without CORPGROUP ----------
-- 'Raise a Player' is the legacy spelling the mailer still answers to; it is
-- listed so an old row cannot fail the constraint on its next update.
alter table public.profiles
  add constraint profiles_company_allowed_ck
  check (company is null or company in (
    'Nova Sportsmart Private Limited',
    'Protathlitis Sportsmart LLP',
    'Jobways Point LLP',
    'Genie Lamp Private Limited',
    'Navyug Raise A Player Foundation',
    'Raise a Player'
  ));

commit;

-- Confirm nothing is left on the old name.
select 'profiles'         as table, count(*) from public.profiles where company = 'CORPGROUP' or company2 = 'CORPGROUP'
union all select 'company_policies', count(*) from public.company_policies where company = 'CORPGROUP'
union all select 'bitrix_targets',   count(*) from public.bitrix_targets   where company = 'CORPGROUP'
union all select 'holidays',         count(*) from public.holidays         where company = 'CORPGROUP';
