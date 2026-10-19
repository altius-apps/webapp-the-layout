-- USAU Players ranking: add Nationals goals + assists (Hunter, 2026-10-19:
-- "throw in the Nationals stats ... pick the best place to add & weight it").
--
-- Placed inside the Nationals score (rank key 2, after titles): G/A is
-- Nationals performance, it separates teammates whose team results are
-- identical, and it can never outrank a title. Weight: (goals + assists) / 2 per
-- Nationals, capped at 10 — a typical scorer (~9 G+A) adds ~4, a top-10% line
-- (17+) about one extra Nationals trip. usau_player_event_stats covers Club
-- Nationals 2015-2025, College D-I/D-III 10 of 12-13, Masters 6 of 11; a player
-- with no row scored nothing there.

do $guard$
begin
  if (select md5(prosrc) from pg_proc where oid = to_regprocedure('public._list_usau_players_live(integer,integer,text,text,text,jsonb)'))
     <> '0101cf3ff5670e1cc360949ecfa2f137' then
    raise exception '_list_usau_players_live changed since 2026-10-19 (md5): re-read it before replacing';
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
),
-- Nationals goals + assists: half a point each, capped at 10 per Nationals, so
-- a star tournament is worth about one extra trip. Duplicate registrations at
-- one event count once (max).
nat_stats as (
  select x.name_key, sum(least(10, (x.g + x.a) / 2.0)) as stat_points
    from (
      select s.name_key, st.event_id, max(coalesce(st.goals, 0)) as g, max(coalesce(st.assists, 0)) as a
        from (select distinct name_key, player_id from stints) s
        join usau_player_event_stats st on st.player_id = s.player_id
       where st.event_id in (select event_id from team_events where kind = 'nat')
       group by s.name_key, st.event_id
    ) x
   group by x.name_key
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
  left join nat_stats ns using (name_key)
  order by coalesce(cardinality(cy.years), 0) desc,
           coalesce(rs.nat_points, 0) + coalesce(ns.stat_points, 0) desc,
           coalesce(rs.reg_points, 0) desc,
           coalesce(rs.reg_count, 0) desc,
           g.latest_season desc nulls last,
           g.appearances desc,
           g.name_key
  limit least(greatest(coalesce(p_limit, 60), 1), 500)
) as row;
$function$;

notify pgrst, 'reload schema';
