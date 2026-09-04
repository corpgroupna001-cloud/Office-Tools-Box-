-- ============================================================
-- A record of every message WorkSuite tried to send to Bitrix24
--
-- Until now a failure only reached Vercel's function log, which means
-- nobody looking at the admin panel could tell whether the group had
-- actually been posted to. This is the audit trail: one row per attempt,
-- successes included, so "did the 09:31 punch reach Jobways?" is a
-- question the admin screen can answer.
--
-- Deliberately stores the MESSAGE TEXT but never the webhook URL. The URL
-- is the credential, and lib/bitrix.js redacts it out of every detail
-- string before it gets this far.
--
-- Run ONCE in Supabase -> SQL Editor. Idempotent.
-- ============================================================

create table if not exists public.bitrix_log (
  id         bigserial primary key,
  created_at timestamptz not null default now(),
  kind       text not null,            -- punch | leave | test
  company    text,
  dialog_id  text,
  ok         boolean not null,
  reason     text,                     -- null when ok
  detail     text,
  message    text,                     -- what was sent, so a bad line is visible
  lines      int                       -- how many punches the message carried
);

alter table public.bitrix_log drop constraint if exists bitrix_log_kind_ck;
alter table public.bitrix_log add constraint bitrix_log_kind_ck
  check (kind in ('punch', 'leave', 'test'));

-- The panel reads "most recent first", and the purge reads "older than".
create index if not exists bitrix_log_time_idx on public.bitrix_log (created_at desc);
-- Failures are what people come looking for, so make that filter cheap.
create index if not exists bitrix_log_fail_idx on public.bitrix_log (ok, created_at desc);

-- ============================================================
-- No policies, deliberately - same reasoning as salaries and
-- bitrix_targets. RLS on with nothing granting select means an employee
-- token reads zero rows; only the service_role key behind the admin
-- password reaches it. The log carries who punched and when, which is
-- attendance data, not something for the whole company to browse.
-- ============================================================
alter table public.bitrix_log enable row level security;
