-- Security review (handed over 2026-10-11, fix before the 10/17 drafts):
--  MEDIUM: a non-uuid USAU player id (e.g. 'x', via fantasy_make_pick, a queue,
--  or a direct fantasy_roster_slots insert on your own team) made score-fantasy's
--  .in('player_id', ...) against a uuid column 400, failing the single global
--  run for every league. CHECKs on the 4 tables that hold drafted/rostered ids,
--  and clean errors in make_pick / nominate / set_queue.
--  LOW: fantasy_auction_advance's queue loop never checked the entry's league,
--  so a queued playerLeague 'zzz' + autodraft raised on every tick (and skip /
--  resolve re-raised it). Both autodraft loops now share one entry check.
-- Shared with mobile: patched in place, guarded on today's md5.

alter table public.fantasy_roster_slots
  add constraint fantasy_roster_slots_usau_player_id_uuid
  check (player_league <> 'usau' or player_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
alter table public.fantasy_team_players
  add constraint fantasy_team_players_usau_player_id_uuid
  check (player_league <> 'usau' or player_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
alter table public.fantasy_draft_picks
  add constraint fantasy_draft_picks_usau_player_id_uuid
  check (player_league <> 'usau' or player_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
alter table public.fantasy_draft_nominations
  add constraint fantasy_draft_nominations_usau_player_id_uuid
  check (player_league <> 'usau' or player_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

-- One check for a queued entry, used by set_queue and both autodraft loops:
-- an object, a league this contest drafts, a non-empty id (a uuid for USAU),
-- and in the league's division.
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
    when p_entry ->> 'playerLeague' = 'usau'
         and p_entry ->> 'playerId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then false
    else public.fantasy_draft_player_in_division(p_contest, p_entry ->> 'playerLeague', p_entry ->> 'playerId')
  end;
$$;

revoke execute on function public.fantasy_draft_queue_entry_ok(public.fantasy_contests, jsonb) from public, anon, authenticated;

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
  v_lower constant text :=
'    p_player_id := lower(p_player_id);
  end if;
';
  v_lower_and_check constant text :=
'    p_player_id := lower(p_player_id);
  end if;
  if p_player_league = ''usau''
     and p_player_id !~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'' then
    raise exception ''that isn''''t a valid player'';
  end if;
';
begin
  if (select md5(prosrc) from pg_proc where oid = 'public.fantasy_make_pick(uuid, text, text, text)'::regprocedure)
     <> '1aad37aee0f18f9f58caf08d96d82b98' then
    raise exception 'fantasy_make_pick changed since 2026-10-11 — re-derive this patch from the live body';
  end if;
  v := pg_get_functiondef('public.fantasy_make_pick(uuid, text, text, text)'::regprocedure);
  v := pg_temp.replace_n(v, v_lower, v_lower_and_check, 1, 'make_pick uuid check');
  execute v;

  if (select md5(prosrc) from pg_proc where oid = 'public.fantasy_nominate(uuid, text, text, text, integer)'::regprocedure)
     <> '1fdb91d4b2cda23a8bebf38e7abd8c36' then
    raise exception 'fantasy_nominate changed since 2026-10-11 — re-derive this patch from the live body';
  end if;
  v := pg_get_functiondef('public.fantasy_nominate(uuid, text, text, text, integer)'::regprocedure);
  v := pg_temp.replace_n(v, v_lower, v_lower_and_check, 1, 'nominate uuid check');
  execute v;

  if (select md5(prosrc) from pg_proc where oid = 'public.fantasy_set_queue(uuid, jsonb)'::regprocedure)
     <> '465ee66dce2cb07d8d11b9765ceea7fa' then
    raise exception 'fantasy_set_queue changed since 2026-10-11 — re-derive this patch from the live body';
  end if;
  v := pg_get_functiondef('public.fantasy_set_queue(uuid, jsonb)'::regprocedure);
  v := pg_temp.replace_n(v,
'  insert into public.fantasy_draft_queues (draft_id, team_id, entries, updated_at)
',
'  -- Autodraft trusts the queue, so reject anything it couldn''t draft.
  if exists (
    select 1
    from public.fantasy_contests c, jsonb_array_elements(p_entries) e
    where c.id = v_contest and not public.fantasy_draft_queue_entry_ok(c, e)
  ) then
    raise exception ''your queue has a player who isn''''t in this draft'';
  end if;

  insert into public.fantasy_draft_queues (draft_id, team_id, entries, updated_at)
', 1, 'set_queue entry check');
  execute v;

  if (select md5(prosrc) from pg_proc where oid = 'public.fantasy_draft_run_clock(uuid)'::regprocedure)
     <> '8dad67b6a3dc172c82469fb6d29cdffa' then
    raise exception 'fantasy_draft_run_clock changed since 2026-10-11 — re-derive this patch from the live body';
  end if;
  v := pg_get_functiondef('public.fantasy_draft_run_clock(uuid)'::regprocedure);
  v := pg_temp.replace_n(v,
'        if public.fantasy_draft_player_league_valid(v_contest.competition, v_entry ->> ''playerLeague'')
           and public.fantasy_draft_player_in_division(v_contest, v_entry ->> ''playerLeague'', v_entry ->> ''playerId'')
',
'        if public.fantasy_draft_queue_entry_ok(v_contest, v_entry)
', 1, 'run_clock queue check');
  execute v;

  if (select md5(prosrc) from pg_proc where oid = 'public.fantasy_auction_advance(uuid)'::regprocedure)
     <> 'd3ba75496ca95b8c4d28e88dc6c3c96f' then
    raise exception 'fantasy_auction_advance changed since 2026-10-11 — re-derive this patch from the live body';
  end if;
  v := pg_get_functiondef('public.fantasy_auction_advance(uuid)'::regprocedure);
  v := pg_temp.replace_n(v,
'public.fantasy_draft_player_in_division(v_contest, v_entry ->> ''playerLeague'', v_entry ->> ''playerId'')',
'public.fantasy_draft_queue_entry_ok(v_contest, v_entry)', 1, 'auction_advance queue check');
  execute v;
end;
$mig$;
