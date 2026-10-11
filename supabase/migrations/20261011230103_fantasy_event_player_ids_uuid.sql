-- Security review of 20261011225108: WFDF and EUCS player ids are uuids too
-- (wfdf_rosters.id, euf_rosters.id), so a junk id there still 400'd scoring
-- for that contest. Widen the uuid rule from usau to all three event leagues,
-- lower-case their ids on the way in like usau, and reject a non-uuid
-- settings.eventId on contests (it 400'd scoring and raised on every
-- autodraft tick via fantasy_draft_best_available).
-- Shared with mobile: patched in place, guarded on today's md5.

alter table public.fantasy_roster_slots drop constraint fantasy_roster_slots_usau_player_id_uuid;
alter table public.fantasy_team_players drop constraint fantasy_team_players_usau_player_id_uuid;
alter table public.fantasy_draft_picks drop constraint fantasy_draft_picks_usau_player_id_uuid;
alter table public.fantasy_draft_nominations drop constraint fantasy_draft_nominations_usau_player_id_uuid;

alter table public.fantasy_roster_slots
  add constraint fantasy_roster_slots_event_player_id_uuid
  check (player_league not in ('usau', 'wfdf', 'euf') or player_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
alter table public.fantasy_team_players
  add constraint fantasy_team_players_event_player_id_uuid
  check (player_league not in ('usau', 'wfdf', 'euf') or player_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
alter table public.fantasy_draft_picks
  add constraint fantasy_draft_picks_event_player_id_uuid
  check (player_league not in ('usau', 'wfdf', 'euf') or player_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
alter table public.fantasy_draft_nominations
  add constraint fantasy_draft_nominations_event_player_id_uuid
  check (player_league not in ('usau', 'wfdf', 'euf') or player_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

alter table public.fantasy_contests
  add constraint fantasy_contests_event_id_uuid
  check (settings ->> 'eventId' is null
         or settings ->> 'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

create or replace function public.fantasy_draft_queue_entry_ok(p_contest public.fantasy_contests, p_entry jsonb)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_entry) <> 'object' then false
    when not coalesce(public.fantasy_draft_player_league_valid(p_contest.competition, p_entry ->> 'playerLeague'), false) then false
    when coalesce(p_entry ->> 'playerId', '') = '' then false
    when p_entry ->> 'playerLeague' in ('usau', 'wfdf', 'euf')
         and p_entry ->> 'playerId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then false
    else public.fantasy_draft_player_in_division(p_contest, p_entry ->> 'playerLeague', p_entry ->> 'playerId')
  end;
$$;

create or replace function pg_temp.replace_n(p_src text, p_old text, p_new text, p_n int, p_what text)
returns text
language plpgsql
as $$
begin
  if (length(p_src) - length(replace(p_src, p_old, ''))) / length(p_old) <> p_n then
    raise exception '%: anchor not found exactly % time(s) — aborting rather than guessing', p_what, p_n;
  end if;
  return replace(p_src, p_old, p_new);
end;
$$;

do $mig$
declare
  v text;
begin
  if (select md5(prosrc) from pg_proc where oid = 'public.fantasy_make_pick(uuid, text, text, text)'::regprocedure)
     <> 'e550088c1e6bbdc57a436e97388bcb55' then
    raise exception 'fantasy_make_pick changed since 20261011225108 — re-derive this patch from the live body';
  end if;
  v := pg_get_functiondef('public.fantasy_make_pick(uuid, text, text, text)'::regprocedure);
  v := pg_temp.replace_n(v,
'  if p_player_league = ''usau'' then
    p_player_id := lower(p_player_id);',
'  if p_player_league in (''usau'', ''wfdf'', ''euf'') then
    p_player_id := lower(p_player_id);', 1, 'make_pick lower-case');
  v := pg_temp.replace_n(v,
'  if p_player_league = ''usau''
     and p_player_id !~',
'  if p_player_league in (''usau'', ''wfdf'', ''euf'')
     and p_player_id !~', 1, 'make_pick uuid check');
  execute v;

  if (select md5(prosrc) from pg_proc where oid = 'public.fantasy_nominate(uuid, text, text, text, integer)'::regprocedure)
     <> 'c16c7aa4d9f822d3b429c7909dfc4114' then
    raise exception 'fantasy_nominate changed since 20261011225108 — re-derive this patch from the live body';
  end if;
  v := pg_get_functiondef('public.fantasy_nominate(uuid, text, text, text, integer)'::regprocedure);
  v := pg_temp.replace_n(v,
'  if p_player_league = ''usau'' then
    p_player_id := lower(p_player_id);',
'  if p_player_league in (''usau'', ''wfdf'', ''euf'') then
    p_player_id := lower(p_player_id);', 1, 'nominate lower-case');
  v := pg_temp.replace_n(v,
'  if p_player_league = ''usau''
     and p_player_id !~',
'  if p_player_league in (''usau'', ''wfdf'', ''euf'')
     and p_player_id !~', 1, 'nominate uuid check');
  execute v;

  if (select md5(prosrc) from pg_proc where oid = 'public.fantasy_set_queue(uuid, jsonb)'::regprocedure)
     <> '5f4925a1ca3d7279fb4c3dee5e4cc456' then
    raise exception 'fantasy_set_queue changed since 20261011225108 — re-derive this patch from the live body';
  end if;
  v := pg_get_functiondef('public.fantasy_set_queue(uuid, jsonb)'::regprocedure);
  v := pg_temp.replace_n(v,
'case when x.e ->> ''playerLeague'' = ''usau'' and x.e ? ''playerId''',
'case when x.e ->> ''playerLeague'' in (''usau'', ''wfdf'', ''euf'') and x.e ? ''playerId''', 1, 'set_queue lower-case');
  execute v;
end;
$mig$;
