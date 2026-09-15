-- ============================================================
-- CRM import — remember where an imported record came from.
--
-- A deal or lead brought in from another system (a Bitrix24 export,
-- say) keeps the id it had there, so importing the same file twice
-- updates those rows instead of making a second copy.
--
-- Safe to run more than once. Records already in WorkSuite are not
-- touched: their external_ref simply stays empty.
-- Run in Supabase → SQL Editor.
-- ============================================================

alter table public.crm_deals add column if not exists external_ref text;
alter table public.crm_leads add column if not exists external_ref text;

-- One row per source id. Records typed in by hand (external_ref null) are
-- not covered by the index, so there can be as many of those as you like.
create unique index if not exists crm_deals_external_ref_uidx
  on public.crm_deals (external_ref) where external_ref is not null;
create unique index if not exists crm_leads_external_ref_uidx
  on public.crm_leads (external_ref) where external_ref is not null;
