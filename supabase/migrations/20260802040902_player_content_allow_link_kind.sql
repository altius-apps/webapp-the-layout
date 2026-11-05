-- player_content: allow kind='link' through the payload CHECK.
--
-- The player_content_kind enum has had 'link' from the start, the web
-- uploader's link tab inserts it for any non-YouTube/Vimeo URL, and both
-- clients' galleries render 'link' tiles — but player_content_payload_check
-- only ever permitted image/video (storage_path) or video_link (external_url),
-- so every generic-link submission has been failing the constraint. Mobile's
-- new link tab (2026-08-01) hits the same wall. Widen the external_url branch
-- to cover both link kinds; the shape rule stays identical (external_url-only
-- rows carry no storage object, and vice versa).
alter table public.player_content
  drop constraint player_content_payload_check;

alter table public.player_content
  add constraint player_content_payload_check check (
    (
      kind in ('image', 'video')
      and storage_path is not null
      and external_url is null
    )
    or (
      kind in ('video_link', 'link')
      and external_url is not null
      and storage_path is null
    )
  );
