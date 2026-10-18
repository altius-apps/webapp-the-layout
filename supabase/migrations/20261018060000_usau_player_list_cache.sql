-- USAU Players default lists, precomputed (Hunter, 2026-10-18: "yes").
--
-- Why: the /players USAU default list (no search, no season) aggregates every
-- season's rosters for a level × division: ~1.5 s average, up to ~3 s, so under
-- load it hit anon's 3 s statement_timeout (57014) and the page showed nothing.
-- Mobile calls the same RPC.
--
-- Now:
-- * usau_player_list_cache holds the top 500 for every level × division, built
--   by _list_usau_players_live (the previous list_usau_players body, verbatim).
-- * list_usau_players serves a slice of the cached list when there is no search
--   and no season and both level and division are given; anything else runs the
--   live query exactly as before. Same signature and jsonb shape, so web and
--   mobile need no change. SECURITY DEFINER so the cache table stays private.
-- * Club champion years in the cache come from _usau_club_champions_json, the
--   SQL mirror of web getUsauClubChampionsBySeason (src/lib/usau/data.ts). Both
--   now let the latest-scheduled final win: placement games are sometimes
--   tagged round='final' ("11th Place" at 2016 + 2024 Nationals). Verified: the
--   fixed web logic and this function produce the same 33 champions.
-- * refresh_usau_player_list_cache runs hourly at :45 but only rebuilds after
--   writes to usau_rosters / usau_players / usau_teams (pg_stat counters moved)
--   or when the last build is a day old — "nightly and after roster imports".
--   A procedure, so each level × division commits on its own; invoker with no
--   SET clause, because transaction control is not allowed otherwise.
--
-- Shared DB with mobile: list_usau_players is replaced in full (the body
-- becomes a cache-or-live wrapper), guarded by the live md5.

-- Club champions as (season, division, team_id) triples.
create function public._usau_club_champions_json()
returns jsonb
language sql
stable
set search_path to 'public'
as $fn$
  with nationals as (
    select e.id, e.season from public.usau_events e
     where e.competition_level = 'CLUB'
       and (e.usau_slug ilike '%national-championships%' or e.usau_slug ilike '%club-nationals%'
            or e.usau_slug ilike '%usa-ultimate-club-championships%')
       and e.usau_slug not ilike '%us-open%'
  ),
  finals as (
    select n.season, g.scheduled_at, g.id as game_id,
           case when g.score_a > g.score_b then g.team_a_id else g.team_b_id end as team_id,
           coalesce(case when g.score_a > g.score_b then ta.gender_division::text else tb.gender_division::text end,
                    case when lower(coalesce(g.bracket_name, '')) like '%mixed%' then 'Mixed'
                         when lower(coalesce(g.bracket_name, '')) like '%women%' then 'Women'
                         when lower(coalesce(g.bracket_name, '')) like '%men%' then 'Men' end) as division
      from public.usau_games g
      join nationals n on n.id = g.event_id
      left join public.usau_teams ta on ta.id = g.team_a_id
      left join public.usau_teams tb on tb.id = g.team_b_id
     where g.round = 'final' and g.score_a is not null and g.score_b is not null
       and g.team_a_id is not null and g.team_b_id is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object('season', season, 'division', division, 'team_id', team_id)), '[]'::jsonb)
  from (select distinct on (season, division) season, division, team_id
          from finals where division is not null
         order by season, division, scheduled_at desc nulls last, game_id) w;
$fn$;
revoke execute on function public._usau_club_champions_json() from public, anon, authenticated;

-- The previous list_usau_players body, verbatim (pg_get_functiondef 2026-10-18,
-- md5(prosrc) 16b207cd8d6cb4d4d17412ac73234d2e).
create function public._list_usau_players_live(p_limit integer DEFAULT 60, p_season integer DEFAULT NULL::integer, p_division text DEFAULT NULL::text, p_level text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_champions jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
with champs as (
  select (c->>'season')::int as season, c->>'division' as division, c->>'team_id' as team_id
  from jsonb_array_elements(coalesce(p_champions, '[]'::jsonb)) as c
),
stints as materialized (
  select r.player_id, r.season, r.team_id,
         p.display_name, lower(p.display_name) as name_key,
         t.name as team_name, t.gender_division::text as gender_division
  from usau_rosters r
  join usau_teams t on t.id = r.team_id
  join usau_players p on p.id = r.player_id
  where p.display_name is not null
    and (p_season is null or r.season = p_season)
    and (p_division is null or t.gender_division = p_division::usau_gender_division)
    and (p_level is null or t.competition_level = p_level::usau_competition_level)
    and (p_search is null or p.display_name ilike
         '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%')
),
grouped as (
  select name_key,
         count(distinct (team_id, season)) as appearances,
         max(season) as latest_season
  from stints group by name_key
),
anchor as (
  select distinct on (name_key) name_key, player_id as anchor_id, display_name
  from (
    select name_key, player_id, display_name, count(distinct (team_id, season)) as n
    from stints group by name_key, player_id, display_name
  ) per_player
  order by name_key, n desc, player_id
),
latest as (
  select distinct on (name_key) name_key, team_name as latest_team, team_id as latest_team_id
  from stints
  order by name_key, season desc
),
champ_years as (
  select s.name_key, array_agg(distinct s.season order by s.season desc) as years
  from stints s
  join champs c on c.season = s.season and s.team_id::text = c.team_id
    and c.division = s.gender_division
  group by s.name_key
)
select coalesce(jsonb_agg(to_jsonb(row)), '[]'::jsonb)
from (
  select a.anchor_id as "id",
         a.display_name as "displayName",
         l.latest_team as "latestTeam",
         l.latest_team_id as "latestTeamId",
         g.latest_season as "latestSeason",
         g.appearances as "appearances",
         coalesce(cy.years, '{}'::int[]) as "championYears"
  from grouped g
  join anchor a using (name_key)
  join latest l using (name_key)
  left join champ_years cy using (name_key)
  order by g.latest_season desc nulls last, g.appearances desc
  limit least(greatest(coalesce(p_limit, 60), 1), 500)
) as row;
$function$;
revoke execute on function public._list_usau_players_live(integer, integer, text, text, text, jsonb) from public, anon, authenticated;

-- Internal tables (definer-only: RLS on, no policies, no grants).
create table public.usau_player_list_cache (
  level    text not null,
  division text not null,
  rows     jsonb not null,
  built_at timestamptz not null default now(),
  primary key (level, division)
);
create table public.usau_player_list_state (
  id            boolean primary key default true check (id),
  roster_writes bigint not null default -1,              -- pg_stat writes to the roster tables at the last build
  refreshed_at  timestamptz not null default '-infinity'
);
insert into public.usau_player_list_state default values;
alter table public.usau_player_list_cache enable row level security;
alter table public.usau_player_list_state enable row level security;
revoke all on public.usau_player_list_cache, public.usau_player_list_state from public, anon, authenticated;

do $guard$
begin
  if (select md5(prosrc) from pg_proc
       where oid = to_regprocedure('public.list_usau_players(integer,integer,text,text,text,jsonb)'))
     <> '16b207cd8d6cb4d4d17412ac73234d2e' then
    raise exception 'list_usau_players changed since 2026-10-18 (md5): re-read it before replacing';
  end if;
end
$guard$;

create or replace function public.list_usau_players(p_limit integer DEFAULT 60, p_season integer DEFAULT NULL::integer, p_division text DEFAULT NULL::text, p_level text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_champions jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(
    -- Default list: a slice of the precomputed top 500 (an existing row with
    -- no players still answers '[]' without falling through).
    (select coalesce((select jsonb_agg(e.v order by e.i)
                        from jsonb_array_elements(c.rows) with ordinality as e(v, i)
                       where e.i <= least(greatest(coalesce(p_limit, 60), 1), 500)), '[]'::jsonb)
       from public.usau_player_list_cache c
      where p_search is null and p_season is null
        and c.level = p_level and c.division = p_division),
    public._list_usau_players_live(p_limit, p_season, p_division, p_level, p_search, p_champions)
  );
$function$;

create procedure public.refresh_usau_player_list_cache(p_force boolean default false)
language plpgsql
as $fn$
declare
  v_writes bigint;
  v_last   bigint;
  v_at     timestamptz;
  v_champs jsonb;
  r        record;
begin
  select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) into v_writes
    from pg_catalog.pg_stat_user_tables
   where schemaname = 'public' and relname in ('usau_rosters', 'usau_players', 'usau_teams');
  select roster_writes, refreshed_at into v_last, v_at from public.usau_player_list_state;
  -- Rebuild after roster writes (counters moved, or reset by a restart) and at
  -- least daily; otherwise nothing to do.
  if not p_force and v_writes = v_last and v_at > now() - interval '1 day' then
    return;
  end if;

  v_champs := public._usau_club_champions_json();
  for r in
    select l.level, d.division
      from unnest(array['CLUB', 'COLLEGE_D1', 'COLLEGE_D3', 'MASTERS', 'GRAND_MASTERS', 'GREAT_GRAND_MASTERS']) as l(level)
     cross join unnest(array['Men', 'Women', 'Mixed']) as d(division)
     where not (l.level like 'COLLEGE%' and d.division = 'Mixed')   -- college has no Mixed
  loop
    insert into public.usau_player_list_cache as c (level, division, rows, built_at)
    values (r.level, r.division,
            public._list_usau_players_live(500, null, r.division, r.level, null,
              case when r.level = 'CLUB' then v_champs else '[]'::jsonb end),
            now())
    on conflict (level, division) do update set rows = excluded.rows, built_at = excluded.built_at;
    commit;
  end loop;

  update public.usau_player_list_state set roster_writes = v_writes, refreshed_at = now();
  commit;
end
$fn$;
revoke execute on procedure public.refresh_usau_player_list_cache(boolean) from public, anon, authenticated;

-- Hourly at :45 (clear of the :00 jobs); a no-op unless rosters changed or a day passed.
-- Must stay a single CALL statement (the procedure COMMITs).
select cron.schedule('refresh-usau-player-lists', '45 * * * *', 'call public.refresh_usau_player_list_cache()');

notify pgrst, 'reload schema';
