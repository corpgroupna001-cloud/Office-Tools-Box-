-- Per-employee WFH device requirements. Admin toggles which devices each
-- WFH employee owns; the Friday check-in only asks for those clips.
-- Default true = existing behaviour (all three required).

alter table public.profiles
  add column if not exists req_mobile boolean not null default true,
  add column if not exists req_laptop boolean not null default true,
  add column if not exists req_tab    boolean not null default true;
