-- Feature Backlog #27 (2026-10-11): SELECT on the playbook-videos bucket only
-- checked bucket_id, so any signed-in user could list or sign any team's
-- videos. Now: the uploader (objects live under {uid}/…, same rule as the
-- insert/delete policies), or anyone who can see a play that references the
-- object (pb_plays.video_url = 'storage:' || path). The pb_plays subquery runs
-- under the caller's own RLS, so "can see" means play owner or team member.
-- objects.name is qualified on purpose: pb_plays has its own name column.
drop policy if exists playbook_videos_select_authenticated on storage.objects;

create policy playbook_videos_select_uploader_or_play_viewer on storage.objects
  for select to authenticated
  using (
    bucket_id = 'playbook-videos'
    and (
      (storage.foldername(objects.name))[1] = (select auth.uid())::text
      or exists (
        select 1 from public.pb_plays p
         where p.video_url = 'storage:' || objects.name
      )
    )
  );
