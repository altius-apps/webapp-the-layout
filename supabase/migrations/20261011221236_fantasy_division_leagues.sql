-- Division leagues, server side (Hunter, 2026-10-11). A USAU Nationals league
-- drafts from one division ('men' | 'women' | 'mixed'; College Nationals has no
-- Mixed) or from all of them (settings.division absent). The web create form
-- writes it in createContest's insert and says it can't be changed later:
--   • CHECK: only valid divisions for the contest's competition.
--   • trigger: settings.division can't change after the insert.
--   • picks, nominations, queue autodraft (snake + auction) and best-available
--     all skip players whose team at the event is in another division.
-- Ranks within a division: fantasy_player_ratings.division_rank (20261011213620).
--
-- fantasy_draft_best_available / make_pick / nominate / draft_run_clock /
-- auction_advance are shared with mobile and have drifted from committed SQL,
-- so they're patched in place: exact-anchor replace, guarded on today's md5.

alter table public.fantasy_contests
  add constraint fantasy_contests_division_valid check (
    coalesce(settings ->> 'division', 'all') = 'all'
    or (competition in ('usau-club-nationals', 'usau-college-nationals') and settings ->> 'division' in ('men', 'women'))
    or (competition = 'usau-club-nationals' and settings ->> 'division' = 'mixed')
  );

create or replace function public.fantasy_contests_division_locked()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.settings -> 'division' is distinct from old.settings -> 'division' then
    raise exception 'a league''s division is set when it''s created and can''t be changed';
  end if;
  return new;
end;
$$;

revoke execute on function public.fantasy_contests_division_locked() from public, anon, authenticated;

create trigger fantasy_contests_division_locked
  before update of settings on public.fantasy_contests
  for each row execute function public.fantasy_contests_division_locked();

-- True when the player can be drafted in this contest's division: always for
-- all-division leagues; otherwise the player's team at the event must be in it.
create or replace function public.fantasy_draft_player_in_division(
  p_contest public.fantasy_contests,
  p_player_league text,
  p_player_id text
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when coalesce(p_contest.settings ->> 'division', 'all') = 'all' then true
    when p_player_league is distinct from 'usau'
      or p_player_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then false
    else exists (
      select 1
      from public.usau_rosters r
      join public.usau_teams t on t.id = r.team_id
      where r.event_id = (p_contest.settings ->> 'eventId')::uuid
        and r.player_id = p_player_id::uuid
        and lower(t.gender_division::text) = p_contest.settings ->> 'division'
    )
  end;
$$;

revoke execute on function public.fantasy_draft_player_in_division(public.fantasy_contests, text, text) from public, anon, authenticated;

-- ── In-place patches ────────────────────────────────────────────────────────
create or replace function pg_temp.replace_once(p_src text, p_old text, p_new text, p_what text)
returns text
language plpgsql
as $$
begin
  if (length(p_src) - length(replace(p_src, p_old, ''))) / length(p_old) <> 1 then
    raise exception '%: anchor not found exactly once — aborting rather than guessing', p_what;
  end if;
  return replace(p_src, p_old, p_new);
end;
$$;

do $mig$
declare
  v text;
begin
  if (select md5(prosrc) from pg_proc where oid = 'public.fantasy_make_pick(uuid, text, text, text)'::regprocedure) <> '913d5998ff486f31097b254b5d57af53' then
    raise exception 'fantasy_make_pick changed since 2026-10-11 — re-derive this patch from the live body';
  end if;
  v := pg_get_functiondef('public.fantasy_make_pick(uuid, text, text, text)'::regprocedure);
  v := pg_temp.replace_once(v,
'  if not public.fantasy_draft_player_league_valid(v_contest.competition, p_player_league) then
    raise exception ''player_league % is not valid for %'', p_player_league, v_contest.competition;
  end if;
',
'  if not public.fantasy_draft_player_league_valid(v_contest.competition, p_player_league) then
    raise exception ''player_league % is not valid for %'', p_player_league, v_contest.competition;
  end if;
  if not public.fantasy_draft_player_in_division(v_contest, p_player_league, p_player_id) then
    raise exception ''that player isn''''t in this league''''s division'';
  end if;
',
'make_pick division check');
  execute v;

  if (select md5(prosrc) from pg_proc where oid = 'public.fantasy_nominate(uuid, text, text, text, integer)'::regprocedure) <> '363a69ec5fb7d3a516a59a789c929b03' then
    raise exception 'fantasy_nominate changed since 2026-10-11 — re-derive this patch from the live body';
  end if;
  v := pg_get_functiondef('public.fantasy_nominate(uuid, text, text, text, integer)'::regprocedure);
  v := pg_temp.replace_once(v,
'  if not public.fantasy_draft_player_league_valid(v_contest.competition, p_player_league) then
    raise exception ''player_league % is not valid for %'', p_player_league, v_contest.competition;
  end if;
',
'  if not public.fantasy_draft_player_league_valid(v_contest.competition, p_player_league) then
    raise exception ''player_league % is not valid for %'', p_player_league, v_contest.competition;
  end if;
  if not public.fantasy_draft_player_in_division(v_contest, p_player_league, p_player_id) then
    raise exception ''that player isn''''t in this league''''s division'';
  end if;
',
'nominate division check');
  execute v;

  if (select md5(prosrc) from pg_proc where oid = 'public.fantasy_draft_run_clock(uuid)'::regprocedure) <> 'b94524baeb0cf89b19fd1804c41b6d10' then
    raise exception 'fantasy_draft_run_clock changed since 2026-10-11 — re-derive this patch from the live body';
  end if;
  v := pg_get_functiondef('public.fantasy_draft_run_clock(uuid)'::regprocedure);
  v := pg_temp.replace_once(v,
'        if public.fantasy_draft_player_league_valid(v_contest.competition, v_entry ->> ''playerLeague'')
           and not exists (',
'        if public.fantasy_draft_player_league_valid(v_contest.competition, v_entry ->> ''playerLeague'')
           and public.fantasy_draft_player_in_division(v_contest, v_entry ->> ''playerLeague'', v_entry ->> ''playerId'')
           and not exists (',
'run_clock queue division');
  execute v;

  if (select md5(prosrc) from pg_proc where oid = 'public.fantasy_auction_advance(uuid)'::regprocedure) <> '0f4500bcd51407cebe01c3118a8a8cb5' then
    raise exception 'fantasy_auction_advance changed since 2026-10-11 — re-derive this patch from the live body';
  end if;
  v := pg_get_functiondef('public.fantasy_auction_advance(uuid)'::regprocedure);
  v := pg_temp.replace_once(v,
'            if not exists (
              select 1 from public.fantasy_draft_picks
              where draft_id = p_draft and player_league = (v_entry ->> ''playerLeague'') and player_id = (v_entry ->> ''playerId'')
            ) and not exists (',
'            if public.fantasy_draft_player_in_division(v_contest, v_entry ->> ''playerLeague'', v_entry ->> ''playerId'') and not exists (
              select 1 from public.fantasy_draft_picks
              where draft_id = p_draft and player_league = (v_entry ->> ''playerLeague'') and player_id = (v_entry ->> ''playerId'')
            ) and not exists (',
'auction_advance queue division');
  execute v;

  if (select md5(prosrc) from pg_proc where oid = 'public.fantasy_draft_best_available(uuid, public.fantasy_contests)'::regprocedure) <> 'cf90feb47fe53276bf0192138998e078' then
    raise exception 'fantasy_draft_best_available changed since 2026-10-11 — re-derive this patch from the live body';
  end if;
  v := pg_get_functiondef('public.fantasy_draft_best_available(uuid, public.fantasy_contests)'::regprocedure);
  v := pg_temp.replace_once(v,
'        where dp.draft_id = p_draft and dp.player_league = ''usau'' and dp.player_id = fr.player_id
      )
    order by fr.rank',
'        where dp.draft_id = p_draft and dp.player_league = ''usau'' and dp.player_id = fr.player_id
      )
      and public.fantasy_draft_player_in_division(p_contest, ''usau'', fr.player_id)
    order by fr.rank',
'best_available division filter');
  v := pg_temp.replace_once(v,
'dp.player_id = pes.player_id::text
        )
      order by (coalesce(pes.goals,0) + coalesce(pes.assists,0)) desc',
'dp.player_id = pes.player_id::text
        )
        and public.fantasy_draft_player_in_division(p_contest, ''usau'', pes.player_id::text)
      order by (coalesce(pes.goals,0) + coalesce(pes.assists,0)) desc',
'best_available division filter');
  v := pg_temp.replace_once(v,
'dp.player_id = r.player_id::text
        )
      order by up.display_name',
'dp.player_id = r.player_id::text
        )
        and public.fantasy_draft_player_in_division(p_contest, ''usau'', r.player_id::text)
      order by up.display_name',
'best_available division filter');
  execute v;
end;
$mig$;
