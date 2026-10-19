-- USAU Players tab ranking (Hunter, 2026-10-19):
--   1.  National titles
--   1b. Nationals trips + how the team finished
--   2.  Regionals finishes
--   2b. Regionals attended
-- then the previous order (latest season, appearances) and the name.
--
-- * Titles come from _usau_nationals_champions(): every level's Nationals
--   (Club, College D-I / D-III, Masters / GM / GGM), the gold-medal-bracket final
--   (_usau_is_championship_bracket), latest final per season × level × division,
--   keyed by the winning team row (one usau_teams row per team-season). The Club
--   subset equals the retired _usau_club_champions_json() (33 champions).
-- * championYears (the trophy chips) and the title count share one basis: on the
--   champion team's roster that season. The client's p_champions (Club only) is
--   kept for the RPC contract but no longer read.
-- * Attendance: a per-event roster row credits that event; a season roster row
--   (no event_id, about a quarter of rows) credits every Nationals/Regionals the
--   team played that season.
-- * Points (tunable):
--   - Nationals trip = 10 + (17 - finish), 0 if outside the top 16, 5 if unknown.
--   - Regionals = 13 - finish, 0 if outside the top 12, 3 if unknown; then trips.
--   Finishes are usau_event_teams.final_placement, which is sparse for College and
--   Masters Nationals (D-I ~20%), so those lists lean on titles and attendance.

create function public._usau_is_nationals_event(p_name text, p_series_stage text)
returns boolean
language sql
immutable
set search_path to 'public', 'pg_temp'
as $fn$
  select p_series_stage is null
     and coalesce(p_name, '') ~* '(usa ultimate national championships|usa ultimate club (championships|nationals)|college championships|masters championships)'
     and coalesce(p_name, '') !~* '(tune|qualif|invite|open|phights|regional|sectional|conference)'
$fn$;
revoke execute on function public._usau_is_nationals_event(text, text) from public, anon, authenticated;

create function public._usau_nationals_champions()
returns table (season integer, team_id uuid)
language sql
stable
set search_path to 'public', 'pg_temp'
as $fn$
  with finals as (
    select e.season, g.scheduled_at, g.id as game_id,
           case when g.score_a > g.score_b then g.team_a_id else g.team_b_id end as winner
      from public.usau_events e
      join public.usau_games g on g.event_id = e.id
     where public._usau_is_nationals_event(e.name, e.series_stage)
       and g.round = 'final' and g.score_a is not null and g.score_b is not null
       and g.score_a <> g.score_b
       and g.team_a_id is not null and g.team_b_id is not null
       and public._usau_is_championship_bracket(g.bracket_name)
  )
  select distinct on (f.season, t.competition_level, t.gender_division) f.season, f.winner
    from finals f
    join public.usau_teams t on t.id = f.winner
   where t.competition_level is not null and t.gender_division is not null
   order by f.season, t.competition_level, t.gender_division, f.scheduled_at desc nulls last, f.game_id
$fn$;
revoke execute on function public._usau_nationals_champions() from public, anon, authenticated;

do $guard$
begin
  if (select md5(prosrc) from pg_proc where oid = to_regprocedure('public._list_usau_players_live(integer,integer,text,text,text,jsonb)'))
     <> '16b207cd8d6cb4d4d17412ac73234d2e' then
    raise exception '_list_usau_players_live changed since 2026-10-18 (md5): re-read it before replacing';
  end if;
  if (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.refresh_usau_player_list_cache(boolean)'))
     <> '868f136431bc751595428e867b1ba8c1' then
    raise exception 'refresh_usau_player_list_cache changed since 2026-10-18 (md5): re-read it before replacing';
  end if;
end
$guard$;

create or replace function public._list_usau_players_live(p_limit integer DEFAULT 60, p_season integer DEFAULT NULL::integer, p_division text DEFAULT NULL::text, p_level text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_champions jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
with stints as materialized (
  select r.player_id, r.season, r.team_id, r.event_id,
         p.display_name, lower(p.display_name) as name_key,
         t.name as team_name
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
champs as materialized (
  select c.season, c.team_id from public._usau_nationals_champions() c
),
champ_years as (
  select s.name_key, array_agg(distinct s.season order by s.season desc) as years
  from stints s
  join champs c on c.season = s.season and c.team_id = s.team_id
  group by s.name_key
),
team_events as materialized (
  select et.team_id, et.event_id, et.final_placement,
         case when e.series_stage like '%regionals' then 'reg' else 'nat' end as kind
    from usau_event_teams et
    join usau_events e on e.id = et.event_id
   where et.team_id in (select distinct team_id from stints)
     and (e.series_stage like '%regionals' or public._usau_is_nationals_event(e.name, e.series_stage))
),
apps as (
  select distinct s.name_key, te.kind, te.event_id, te.team_id, te.final_placement
    from (select distinct name_key, team_id, event_id from stints) s
    join team_events te on te.team_id = s.team_id and (s.event_id is null or s.event_id = te.event_id)
),
rank_stats as (
  select name_key,
         sum(case when kind = 'nat' then 10 + coalesce(greatest(0, 17 - final_placement), 5) else 0 end) as nat_points,
         sum(case when kind = 'reg' then coalesce(greatest(0, 13 - final_placement), 3) else 0 end) as reg_points,
         count(*) filter (where kind = 'reg') as reg_count
    from apps
   group by name_key
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
  left join rank_stats rs using (name_key)
  order by coalesce(cardinality(cy.years), 0) desc,
           coalesce(rs.nat_points, 0) desc,
           coalesce(rs.reg_points, 0) desc,
           coalesce(rs.reg_count, 0) desc,
           g.latest_season desc nulls last,
           g.appearances desc,
           g.name_key
  limit least(greatest(coalesce(p_limit, 60), 1), 500)
) as row;
$function$;

create or replace procedure public.refresh_usau_player_list_cache(p_force boolean default false)
language plpgsql
as $fn$
declare
  v_writes   bigint;
  v_last     bigint;
  v_at       timestamptz;
  v_md5      text;
  v_last_md5 text;
  r          record;
begin
  select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) into v_writes
    from pg_catalog.pg_stat_user_tables
   where schemaname = 'public' and relname in ('usau_rosters', 'usau_players', 'usau_teams');
  v_md5 := md5(coalesce((select string_agg(c.season || ':' || c.team_id, ',' order by c.season, c.team_id)
                           from public._usau_nationals_champions() c), ''));
  select roster_writes, refreshed_at, champions_md5 into v_last, v_at, v_last_md5
    from public.usau_player_list_state;
  -- Rebuild after roster writes (counters moved, or reset by a restart), when
  -- any level's national champions change, and at least daily (placements).
  if not p_force and v_writes = v_last and v_md5 = v_last_md5
     and v_at > now() - interval '1 day' then
    return;
  end if;

  for r in
    select l.level, d.division
      from unnest(array['CLUB', 'COLLEGE_D1', 'COLLEGE_D3', 'MASTERS', 'GRAND_MASTERS', 'GREAT_GRAND_MASTERS']) as l(level)
     cross join unnest(array['Men', 'Women', 'Mixed']) as d(division)
     where not (l.level like 'COLLEGE%' and d.division = 'Mixed')   -- college has no Mixed
  loop
    insert into public.usau_player_list_cache as c (level, division, rows, built_at)
    values (r.level, r.division, public._list_usau_players_live(500, null, r.division, r.level, null, null), now())
    on conflict (level, division) do update set rows = excluded.rows, built_at = excluded.built_at;
    commit;
  end loop;

  update public.usau_player_list_state
     set roster_writes = v_writes, champions_md5 = v_md5, refreshed_at = now();
  commit;
end
$fn$;
revoke execute on procedure public.refresh_usau_player_list_cache(boolean) from public, anon, authenticated;

-- Replaced by _usau_nationals_champions(); the procedure above no longer calls it.
drop function public._usau_club_champions_json();

notify pgrst, 'reload schema';
