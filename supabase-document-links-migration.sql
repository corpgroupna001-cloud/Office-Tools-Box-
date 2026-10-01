-- ============================================================================
-- Public document links (migration 18). Run AFTER supabase-otp-limits-migration.sql
-- (17). Idempotent; adds a column and functions. The only change to existing
-- data: the "published" storage bucket becomes private.
--
-- Before: publishing a file copied it into the public "published" bucket under
-- the link's token, and turning the link off deleted that copy from the
-- browser. When the delete failed the token was cleared anyway: the copy stayed
-- downloadable from its permanent public URL, and nobody could delete it any
-- more (SEC-07).
--
-- Now there is no copy. A public file is served by /api/public-document,
-- which looks the token up on every request (ws_published_file, server only)
-- and redirects to a signed URL of the original file that lives 60 seconds
-- (15 minutes for audio and video, so playback does not stop half way).
-- Turning a link off, letting it expire, or deleting the document stops new
-- views at once; a viewer who already has the page open can finish that
-- signed URL's lifetime. Old copies in the bucket stop being reachable now
-- (the bucket is private) and Admin -> Overview -> Setup health removes them.
--
-- Links can also expire (F-05): documents.published_expires_at, checked by the
-- database on every view.
-- ============================================================================

alter table public.documents add column if not exists published_expires_at timestamptz;
alter table public.documents drop constraint if exists documents_published_expiry_ck;
alter table public.documents add constraint documents_published_expiry_ck
  check (published_expires_at is null or published_token is not null) not valid;

-- An expiry belongs to one link: a new token or no token resets it unless set
-- with it, and an expiry in the past is refused when it is set.
create or replace function public.documents_published_expiry()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.published_token is null then
    new.published_expires_at := null;
  elsif new.published_expires_at is distinct from old.published_expires_at
        and new.published_expires_at is not null and new.published_expires_at <= now() then
    raise exception 'A link cannot expire in the past' using errcode = '22023';
  elsif new.published_token is distinct from old.published_token
        and new.published_expires_at is not distinct from old.published_expires_at then
    new.published_expires_at := null;
  end if;
  return new;
end;
$$;
drop trigger if exists documents_published_expiry on public.documents;
create trigger documents_published_expiry before update of published_token, published_expires_at on public.documents
  for each row execute procedure public.documents_published_expiry();

-- No more public copies: the bucket is private and browsers may not add to it.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    update storage.buckets set public = false where id = 'published';
  end if;
end
$$;
drop policy if exists "published write by owner" on storage.objects;

/** The public share page: what a live link shows. Anyone may call it; the token is the key. */
create or replace function public.ws_published_document(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('name', d.name, 'doc_kind', d.doc_kind, 'mime_type', d.mime_type, 'size_bytes', d.size_bytes,
                            -- speaker notes are for the presenter, never for the public link
                            'content', case when d.doc_kind = 'presentation' and jsonb_typeof(d.content -> 'slides') = 'array'
                                              then jsonb_set(d.content, '{slides}', coalesce((select jsonb_agg(case when jsonb_typeof(s) = 'object' then s - 'notes' else s end)
                                                                                                   from jsonb_array_elements(d.content -> 'slides') s), '[]'::jsonb))
                                            when d.doc_kind <> 'file' then d.content end,
                            'file', d.doc_kind = 'file',
                            'published_at', d.published_at,
                            'expires_at', d.published_expires_at)
    from public.documents d
   where p_token is not null and length(p_token) >= 24 and d.published_token = p_token and d.archived_at is null
     and (d.published_expires_at is null or d.published_expires_at > now());
$$;
grant execute on function public.ws_published_document(text) to anon, authenticated;

/** Where a live link's file is stored. Server only: /api/public-document signs it. */
create or replace function public.ws_published_file(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('bucket', coalesce(d.bucket, 'documents'), 'path', d.storage_path,
                            'name', d.name, 'mime_type', d.mime_type, 'size_bytes', d.size_bytes)
    from public.documents d
   where p_token is not null and length(p_token) >= 24 and d.published_token = p_token
     and d.doc_kind = 'file' and d.storage_path is not null and d.archived_at is null
     and (d.published_expires_at is null or d.published_expires_at > now());
$$;
revoke execute on function public.ws_published_file(text) from public, anon, authenticated;
grant execute on function public.ws_published_file(text) to service_role;

/** Files left in the retired "published" bucket. Server only: the admin console removes them through the Storage API. */
create or replace function public.ws_published_leftovers(p_limit int default 500)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select o.name from storage.objects o where o.bucket_id = 'published' order by o.name limit greatest(1, least(p_limit, 1000));
$$;
revoke execute on function public.ws_published_leftovers(int) from public, anon, authenticated;
grant execute on function public.ws_published_leftovers(int) to service_role;

-- New tables (none here) and the gate (migration 16) stay in step.
select public.ws_apply_session_gate();

-- Done.
