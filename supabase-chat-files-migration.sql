-- Chat file sharing + clear chat.
-- 1) Private Storage bucket `chat-files`: users upload into their own
--    folder; any logged-in employee can view (signed URLs); users can
--    delete only their own files.
-- 2) messages DELETE policy so either participant can clear a thread.

insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-files', 'chat-files', false, 26214400) -- 25 MB cap per file
on conflict (id) do nothing;

drop policy if exists "chat files upload own" on storage.objects;
create policy "chat files upload own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'chat-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "chat files read all" on storage.objects;
create policy "chat files read all" on storage.objects
  for select to authenticated
  using (bucket_id = 'chat-files');

drop policy if exists "chat files delete own" on storage.objects;
create policy "chat files delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'chat-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "participants delete messages" on public.messages;
create policy "participants delete messages" on public.messages
  for delete to authenticated
  using (auth.uid() = sender_id or auth.uid() = recipient_id);
