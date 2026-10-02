-- 25. Admin controls for actual punches and scheduled shift notices.
-- Existing companies keep punch messages; scheduled notices require opt-in.
alter table public.bitrix_targets
  add column if not exists punch_enabled boolean not null default true,
  add column if not exists auto_login boolean not null default false,
  add column if not exists auto_logout boolean not null default false;

alter table public.bitrix_log drop constraint if exists bitrix_log_kind_ck;
alter table public.bitrix_log add constraint bitrix_log_kind_ck
  check (kind in ('punch', 'leave', 'test', 'auto_logout', 'shift_switch', 'scheduled_login', 'scheduled_logout'));

-- bitrix_targets already has RLS and no browser policies. Changes go through
-- the authenticated admin API; messages use the service-only delivery queue.
notify pgrst, 'reload schema';
