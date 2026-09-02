-- ============================================================
-- Attendance: derive IN/OUT when the device doesn't send it.
--
-- The Realtime / OnlineRealSoft "Third Party Api" export sends only:
--   employee_code, employee_name, log_datetime, downloaded_at,
--   device_sn, device_name
-- There is no direction field, so every punch arrived as 'UNKNOWN'.
-- The webhook now derives it by position within the employee's IST day
-- (1st punch = IN, 2nd = OUT, 3rd = IN …), which is how attendance engines
-- normally do it. A real direction from the device always wins if one
-- ever starts arriving.
--
-- Run ONCE in Supabase → SQL Editor. Idempotent.
-- ============================================================

-- ---------- 1) Mark derived rows so the admin can tell them apart ----------
alter table public.attendance_logs
  add column if not exists direction_derived boolean not null default false;

-- ---------- 2) Dedupe must NOT include direction ----------
-- direction is now computed, and a later re-export can legitimately compute a
-- different parity (e.g. once a missing earlier punch arrives). If direction
-- stayed in the unique key, that would insert a SECOND row for the same punch
-- and email the employee twice. Identity is really
-- (who, exact instant, which device) — a person cannot punch twice on the same
-- reader in the same second.
drop index if exists public.attendance_logs_dedupe_uidx;
create unique index if not exists attendance_logs_dedupe_uidx
  on public.attendance_logs (employee_code, log_datetime, device_sn);

-- ---------- 3) Backfill the punches already stored as UNKNOWN ----------
with ordered as (
  select id,
         row_number() over (
           partition by employee_code, log_date
           order by log_datetime
         ) as seq
  from public.attendance_logs
  where direction = 'UNKNOWN'
)
update public.attendance_logs al
set direction = case when ordered.seq % 2 = 1 then 'IN' else 'OUT' end,
    direction_derived = true
from ordered
where al.id = ordered.id;

-- Done.
