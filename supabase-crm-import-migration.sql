-- ============================================================
-- CRM import — deals and leads brought in from another system
-- (a Bitrix24 export) keep where they came from and everything
-- the file said about them.
--
--   external_ref  The id the record had there ("bitrix:deal:17639"), so
--                 importing the same file twice updates those rows
--                 instead of making a second copy.
--   source_row    Every filled-in cell of the record's row, under the
--                 file's own column names. WorkSuite's own columns hold
--                 what the CRM works with (title, stage, value, owner);
--                 this keeps the rest — payments, incentives, visa,
--                 interview timings — so nothing in the export is lost.
--   crm_import_layouts
--                 The file's columns, in the file's order, so the admin
--                 console shows and exports deals and leads in exactly
--                 the format they arrived in.
--
-- Safe to run more than once, and safe after the first version of this
-- file. Records already in WorkSuite are not touched: their external_ref
-- and source_row simply stay empty.
-- Run in Supabase → SQL Editor, after supabase-messenger-calls-migration.sql.
-- ============================================================

alter table public.crm_deals add column if not exists external_ref text;
alter table public.crm_leads add column if not exists external_ref text;

-- One row per source id.
--
-- The first version of this file made these PARTIAL indexes
-- (… where external_ref is not null). Postgres cannot use a partial index
-- for INSERT … ON CONFLICT (external_ref), which is how the import writes,
-- so every import batch failed with "there is no unique or exclusion
-- constraint matching the ON CONFLICT specification". A plain unique index
-- allows just as many hand-made records: NULLs never collide with each other.
drop index if exists public.crm_deals_external_ref_uidx;
drop index if exists public.crm_leads_external_ref_uidx;
create unique index if not exists crm_deals_external_ref_key on public.crm_deals (external_ref);
create unique index if not exists crm_leads_external_ref_key on public.crm_leads (external_ref);

-- The record's row as the file had it: { "column name": "cell", … }, filled cells only.
alter table public.crm_deals add column if not exists source_row jsonb;
alter table public.crm_leads add column if not exists source_row jsonb;
alter table public.crm_deals drop constraint if exists crm_deals_source_row_ck;
alter table public.crm_deals add constraint crm_deals_source_row_ck
  check (source_row is null or jsonb_typeof(source_row) = 'object');
alter table public.crm_leads drop constraint if exists crm_leads_source_row_ck;
alter table public.crm_leads add constraint crm_leads_source_row_ck
  check (source_row is null or jsonb_typeof(source_row) = 'object');

-- The columns of the files imported so far, in file order, one list per kind.
create table if not exists public.crm_import_layouts (
  entity      text primary key,
  headers     text[] not null default '{}',
  updated_at  timestamptz not null default now()
);
alter table public.crm_import_layouts drop constraint if exists crm_import_layouts_entity_ck;
alter table public.crm_import_layouts add constraint crm_import_layouts_entity_ck
  check (entity in ('deal', 'lead'));

-- Written and read only by the admin console, which uses the service role.
-- Row level security with no policies keeps it out of every browser session.
alter table public.crm_import_layouts enable row level security;
revoke all on public.crm_import_layouts from anon, authenticated;
