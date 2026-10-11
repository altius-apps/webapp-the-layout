-- 2026-10-11: EUCS avatar icons store the club's COUNTRY NAME
-- ('euf:Great Britain', 'euf:Czech Republic'), but the format CHECK had no
-- space in its character class, so multi-word countries could never be saved
-- (reported by the mobile session). Allow a space after the first character.
-- Strictly wider than before, so every existing value still passes.
alter table public.profiles drop constraint profiles_avatar_icon_format;
alter table public.profiles add constraint profiles_avatar_icon_format
  check (avatar_icon is null or avatar_icon ~ '^(ufa|usau|pul|wul|wfdf|euf):[A-Za-z0-9][A-Za-z0-9/_ -]{0,79}$');
