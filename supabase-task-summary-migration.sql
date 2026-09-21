-- ============================================================================
-- Task status summary (migration 13). Run AFTER
-- supabase-crm-all-companies-migration.sql. Idempotent; adds one column.
--
-- Bitrix24's "Task status summary is required": the person who completes a
-- task writes what was done. The create page sets the flag; completing such
-- a task asks for the summary and posts it as the task's comment.
-- ============================================================================

alter table public.tasks add column if not exists result_required boolean not null default false;

-- Done.
