-- Follow-up to playbook_videos_select_scoped (same day): a play's video_url is
-- writable by its owner/editors and the "only your own uploads" check lives in
-- the client, so a user could point their own play at someone else's object
-- and gain read access through the play. The referencing play must now belong
-- to the UPLOADER (the object's {uid}/ folder): they own it, or they're a
-- member of its team.
drop policy if exists playbook_videos_select_uploader_or_play_viewer on storage.objects;

create policy playbook_videos_select_uploader_or_play_viewer on storage.objects
  for select to authenticated
  using (
    bucket_id = 'playbook-videos'
    and (
      (storage.foldername(objects.name))[1] = (select auth.uid())::text
      or exists (
        select 1 from public.pb_plays p
         where p.video_url = 'storage:' || objects.name
           and (
             p.owner_id::text = (storage.foldername(objects.name))[1]
             or exists (
               select 1 from public.pb_team_members m
                where m.team_id = p.team_id
                  and m.user_id::text = (storage.foldername(objects.name))[1]
             )
           )
      )
    )
  );
