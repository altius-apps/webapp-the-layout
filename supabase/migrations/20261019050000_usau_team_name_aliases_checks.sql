-- Security-review hardening for usau_team_name_aliases (2026-10-19): an empty or
-- un-normalized key would never match (or match every blank name), and a blank
-- canonical name would wipe team names through the usau_teams trigger.
alter table public.usau_team_name_aliases
  add constraint usau_team_name_aliases_key_nonempty check (alias_key <> ''),
  add constraint usau_team_name_aliases_key_normalized check (alias_key = public.usau_team_name_key(alias_key)),
  add constraint usau_team_name_aliases_canonical_nonblank check (btrim(canonical_name) <> '');
