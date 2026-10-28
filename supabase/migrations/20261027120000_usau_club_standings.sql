-- USAU Club season-final standings, precomputed (Hunter, 2026-10-27: "yes").
--
-- Why: after Club Nationals the Teams page and home Rankings card still showed
-- USAU's pre-Nationals poll. Once a season's Nationals is fully placed, Club now
-- ranks every team by how it finished:
--   tier 1  Nationals finish (ties broken by rating)
--   tier 2  out at Regionals, by places short of a bid (place − teams from that
--           Regionals who reached Nationals; a team that earned a bid but didn't
--           go counts as 0), then USAU rating
--   tier 3  out at Sectionals, same rule against teams that reached Regionals
--   tier 4  in that season's final USAU poll with no Series result, by rating
-- Unplaced teams sit at the bottom of their tier, by rating.
--
-- * usau_club_standings_cache holds one row per Club division: the latest season
--   whose Nationals is fully placed for that division, and its ordered rows.
-- * list_usau_club_standings serves it only while no later season's poll exists,
--   so web and mobile flip back to the official poll when the next season's
--   first ranking lands. Null means "use the poll". SECURITY DEFINER so the
--   cache table stays private.
-- * refresh_usau_club_standings runs hourly at :35 but only rebuilds after
--   writes to the event / team / ranking tables (pg_stat counters moved) or
--   when the last build is a day old. Same shape as refresh_usau_player_list_cache.
--
-- Poll rows match Series teams by team_id, then by normalized name, preferring
-- the poll row in the team's region (a Sectionals event takes the region its
-- advancing teams played Regionals in); each poll row is used once.

create function public._usau_club_standings_rows(p_season integer, p_division text)
returns jsonb
language sql
stable
set search_path to 'public'
as $fn$
with ev as (
  select e.id, e.name,
         case when e.template_key = 'club_nationals' then 1
              when e.series_stage = 'club-regionals' then 2
              else 3 end as tier
    from public.usau_events e
   where e.season = p_season and e.competition_level = 'CLUB'
     and (e.template_key = 'club_nationals' or e.series_stage in ('club-regionals', 'club-sectionals'))
),
parts as (
  select et.event_id, et.team_id, t.name, t.state, ev.tier, ev.name as event_name, et.final_placement as place
    from public.usau_event_teams et
    join ev on ev.id = et.event_id
    join public.usau_teams t on t.id = et.team_id
   where t.gender_division = p_division::public.usau_gender_division
),
reached as (select team_id, min(tier) as best_tier from parts group by team_id),
adv as (   -- teams from each event that reached a higher stage = its bids
  select p.event_id, count(*) filter (where r.best_tier < p.tier) as bids
    from parts p join reached r using (team_id)
   group by p.event_id
),
reg_ev as (
  select id, substring(name from '^\d{4} (.+?) (?:Mens|Womens|Mixed) Club Regional') as region
    from ev where tier = 2
),
sec_region as (
  select p.event_id, mode() within group (order by re.region) as region
    from parts p
    join parts p2 on p2.team_id = p.team_id
    join reg_ev re on re.id = p2.event_id
   where p.tier = 3
   group by p.event_id
),
team_region as (
  select distinct on (p.team_id) p.team_id, coalesce(re.region, sr.region) as region
    from parts p
    left join reg_ev re on re.id = p.event_id
    left join sec_region sr on sr.event_id = p.event_id
   where p.tier in (2, 3)
   order by p.team_id, p.tier
),
best as (  -- each team's last stage
  select distinct on (p.team_id) p.*,
         case when p.place is not null then greatest(p.place - a.bids, 0) end as out_by,
         exists (select 1 from parts q where q.event_id = p.event_id and q.place = p.place
                   and q.team_id <> p.team_id) as tied,
         lower(regexp_replace(p.name, '[^A-Za-z0-9]', '', 'g')) as k
    from parts p
    join reached r on r.team_id = p.team_id and r.best_tier = p.tier
    join adv a on a.event_id = p.event_id
   order by p.team_id, p.place nulls last
),
poll_week as (
  select max(week) as week from public.usau_rankings
   where season = p_season and division = 'Club-' || p_division
),
poll as (
  select r.rank, r.team_id, r.team_name, r.state, r.region, r.rating, r.wins, r.losses,
         lower(regexp_replace(r.team_name, '[^A-Za-z0-9]', '', 'g')) as k
    from public.usau_rankings r
    join poll_week w on w.week = r.week
   where r.season = p_season and r.division = 'Club-' || p_division
),
cand as (
  select b.team_id, p.rank,
         case when p.team_id = b.team_id then 0 when p.region = tr.region then 1 else 2 end as score
    from best b
    left join team_region tr using (team_id)
    join poll p on p.team_id = b.team_id or p.k = b.k
),
link as (
  select distinct on (rank) team_id, rank
    from (select distinct on (team_id) * from cand order by team_id, score, rank) t
   order by rank, score
),
standing as (
  select b.team_id, b.name, coalesce(b.state, p.state) as state, b.tier, b.place, b.tied, b.out_by,
         case b.tier when 1 then 'Nationals'
           else regexp_replace(regexp_replace(b.event_name, '^\d{4} | (Mens|Womens|Mixed)| Club', '', 'g'),
                               ' (Regional|Sectional) Championships?$', ' \1s') end as event_label,
         p.rating, p.wins, p.losses
    from best b
    left join link l on l.team_id = b.team_id
    left join poll p on p.rank = l.rank
  union all
  select p.team_id, p.team_name, p.state, 4, null, false, null, null, p.rating, p.wins, p.losses
    from poll p
   where not exists (select 1 from link l where l.rank = p.rank)
),
ranked as (
  select row_number() over (order by tier, case when tier = 1 then place else out_by end nulls last,
                                     rating desc nulls last, name) as rank, *
    from standing
)
select coalesce(jsonb_agg(jsonb_build_object(
         'rank', rank, 'id', team_id, 'name', name, 'state', state, 'tier', tier,
         'place', place, 'tied', tied, 'eventLabel', event_label,
         'rating', rating, 'wins', wins, 'losses', losses) order by rank), '[]'::jsonb)
  from ranked;
$fn$;
revoke execute on function public._usau_club_standings_rows(integer, text) from public, anon, authenticated;

-- Internal tables (definer-only: RLS on, no policies, no grants).
create table public.usau_club_standings_cache (
  division text primary key check (division in ('Men', 'Women', 'Mixed')),
  season   integer not null,
  rows     jsonb not null,
  built_at timestamptz not null default now()
);
create table public.usau_club_standings_state (
  id           boolean primary key default true check (id),
  writes       bigint not null default -1,              -- pg_stat writes to the source tables at the last build
  refreshed_at timestamptz not null default '-infinity'
);
insert into public.usau_club_standings_state default values;
alter table public.usau_club_standings_cache enable row level security;
alter table public.usau_club_standings_state enable row level security;
revoke all on public.usau_club_standings_cache, public.usau_club_standings_state from public, anon, authenticated;

-- { season, builtAt, teams: [...] } for a Club division ('Men' | 'Women' | 'Mixed'),
-- or null while the official poll should show instead.
create function public.list_usau_club_standings(p_division text, p_limit integer default 500)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $fn$
  select jsonb_build_object(
           'season', c.season,
           'builtAt', c.built_at,
           'teams', coalesce((select jsonb_agg(e.v order by e.i)
                                from jsonb_array_elements(c.rows) with ordinality as e(v, i)
                               where e.i <= least(greatest(coalesce(p_limit, 500), 1), 1000)), '[]'::jsonb))
    from public.usau_club_standings_cache c
   where c.division = p_division
     and c.season >= coalesce((select max(r.season) from public.usau_rankings r
                                where r.division = 'Club-' || p_division), 0);
$fn$;
revoke execute on function public.list_usau_club_standings(text, integer) from public;
grant execute on function public.list_usau_club_standings(text, integer) to anon, authenticated;

create procedure public.refresh_usau_club_standings(p_force boolean default false)
language plpgsql
as $fn$
declare
  v_writes bigint;
  v_last   bigint;
  v_at     timestamptz;
  r        record;
begin
  select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) into v_writes
    from pg_catalog.pg_stat_user_tables
   where schemaname = 'public'
     and relname in ('usau_event_teams', 'usau_events', 'usau_teams', 'usau_rankings');
  select writes, refreshed_at into v_last, v_at from public.usau_club_standings_state;
  if not p_force and v_writes = v_last and v_at > now() - interval '1 day' then
    return;
  end if;

  -- Per division, the latest season whose Club Nationals has teams and every
  -- one of them placed.
  for r in
    select d.division,
           (select max(e.season)
              from public.usau_events e
             where e.template_key = 'club_nationals' and e.competition_level = 'CLUB'
               and exists (select 1 from public.usau_event_teams et
                             join public.usau_teams t on t.id = et.team_id
                            where et.event_id = e.id and t.gender_division::text = d.division)
               and not exists (select 1 from public.usau_event_teams et
                                 join public.usau_teams t on t.id = et.team_id
                                where et.event_id = e.id and t.gender_division::text = d.division
                                  and et.final_placement is null)) as season
      from unnest(array['Men', 'Women', 'Mixed']) as d(division)
  loop
    if r.season is not null then
      insert into public.usau_club_standings_cache as c (division, season, rows, built_at)
      values (r.division, r.season, public._usau_club_standings_rows(r.season, r.division), now())
      on conflict (division) do update
        set season = excluded.season, rows = excluded.rows, built_at = excluded.built_at;
    end if;
    commit;
  end loop;

  update public.usau_club_standings_state set writes = v_writes, refreshed_at = now();
  commit;
end
$fn$;
revoke execute on procedure public.refresh_usau_club_standings(boolean) from public, anon, authenticated;

-- Hourly at :35 (clear of the :45 player-list job); a no-op unless the source
-- tables changed or a day passed. Must stay a single CALL statement (the
-- procedure COMMITs).
select cron.schedule('refresh-usau-club-standings', '35 * * * *', 'call public.refresh_usau_club_standings()');

notify pgrst, 'reload schema';
