-- Fantasy player ratings v2 (Hunter's eye test, 2026-10-11).
--
-- The order was career goals + assists per stat-tracked event, with Nationals
-- and TCT only breaking exact ties (so a deep-team cutter like Quinn Finer sat
-- at #188 of 1,235). It is now a blend over the LAST 5 SEASONS (this one
-- included), each season weighted 0.5^(seasons ago / 3):
--   stats      50%  G+A per event the player has a stat line for, pulled toward
--                   the pool median until there are a few events
--                   ((weighted G+A + 3 × median) / (weighted events + 3))
--   finishes   30%  Nationals finish points: 1st 10 · 2nd 7 · semis 5 ·
--                   quarters 3 · 9–12 1.5 · 13–16 0.5
--   Nationals  10%  Nationals attended
--   TCT        10%  TCT events attended
-- Each part is divided by the pool's p99 value and capped at 1. No stat line at
-- an event = did not play: it leaves the averages (still an appearance).
-- Mirrors the eye-test page (claude.ai/artifact/6R7SYKY4Wg9Fb4TnJmK61c) exactly;
-- verified 0 rank differences on the 2026 Club Nationals pool before applying.
--
-- New columns: score (0..1), division ('men'|'women'|'mixed', the player's team
-- at the event) and division_rank (1..n within the division, same order as
-- rank) for division leagues. stat_events / avg_goals / avg_assists now
-- describe the 5-season window; nationals / tct_events / flight counts stay
-- career totals. The team-coverage CTEs (lines / scored_goals / covered) are
-- gone with the did-not-play rule.

alter table public.fantasy_player_ratings
  add column score numeric(8,6),
  add column division text check (division in ('men', 'women', 'mixed')),
  add column division_rank integer;

create unique index fantasy_player_ratings_division_rank_key
  on public.fantasy_player_ratings (event_id, player_league, division, division_rank);

create or replace function public.fantasy_rebuild_player_ratings(p_event uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.usau_events;
  v_rows  integer;
begin
  select * into v_event from public.usau_events where id = p_event;
  if not found then
    raise exception 'fantasy_rebuild_player_ratings: no usau_events row %', p_event;
  end if;

  -- Overlapping rebuilds of one event queue here instead of colliding on the keys.
  perform pg_advisory_xact_lock(hashtext('fantasy_player_ratings'), hashtext(p_event::text));

  delete from public.fantasy_player_ratings
  where event_id = p_event and player_league = 'usau';

  insert into public.fantasy_player_ratings (
    event_id, player_league, player_id, player_name, team_name, rank, tier,
    stat_events, avg_goals, avg_assists, nationals, tct_events,
    pro_elite_events, elite_select_events, select_events, computed_at,
    score, division, division_rank
  )
  with pool as (
    -- The draft pool: the event's own roster, one row per player.
    select r.player_id,
           up.display_name,
           (array_agg(r.team_id order by r.team_id))[1] as team_id
    from public.usau_rosters r
    join public.usau_players up on up.id = r.player_id
    where r.event_id = p_event
    group by r.player_id, up.display_name
  ),
  stints as (
    select p.player_id as pool_id, up.id as stint_id
    from pool p
    cross join lateral (
      select lower(btrim(regexp_replace(p.display_name, '\s+', ' ', 'g'))) as clean
    ) n
    join public.usau_players up
      on lower(up.display_name) in (lower(p.display_name), n.clean, regexp_replace(n.clean, ' ', '  '))
  ),
  events as (
    -- This level's events up to this one's start.
    select e.id,
           e.season,
           e.start_date < v_event.start_date and e.id <> p_event as is_history,
           e.series_stage is not null or public.usau_is_nationals_name(e.name) as is_series,
           not exists (select 1 from public.usau_rosters r where r.event_id = e.id) as no_event_rosters,
           case
             when public.usau_is_nationals_name(e.name) then 'nationals'
             when e.template_key in ('us_open', 'pro_championships')
               or (e.template_key is null and e.flight_rank = 0)
               or public.usau_normalize_event_name(e.name) ~ 'pro (flight )?finale' then 'tct'
             when e.template_key in ('pro_elite_east', 'pro_elite_west')
               or (e.template_key is null
                   and public.usau_normalize_event_name(e.name) ~ 'pro elite challenge') then 'pro_elite'
             when e.template_key = 'elite_select'
               or (e.template_key is null and e.flight_rank = 2) then 'elite_select'
             when e.template_key in ('select_flight_east', 'select_flight_west')
               or (e.template_key is null and e.flight_rank = 3) then 'select'
             else 'other'
           end as kind
    from public.usau_events e
    where e.competition_level = v_event.competition_level
      and e.start_date <= v_event.start_date
  ),
  history as (
    select id, kind, no_event_rosters from events where is_history
  ),
  stint_rows as (
    -- Every roster row of those stints on a team at this level that fits the
    -- pool player's division: no Men's stints for a Women's player or the
    -- reverse (Mixed fits either).
    select s.pool_id, s.stint_id, r.event_id, r.team_id, r.season, t.name as team_name
    from stints s
    join pool p on p.player_id = s.pool_id
    left join public.usau_teams pt on pt.id = p.team_id
    join public.usau_rosters r on r.player_id = s.stint_id
    join public.usau_teams t on t.id = r.team_id
    where t.competition_level = v_event.competition_level
      and not (coalesce(pt.gender_division::text, '') = 'Women' and coalesce(t.gender_division::text, '') = 'Men')
      and not (coalesce(pt.gender_division::text, '') = 'Men' and coalesce(t.gender_division::text, '') = 'Women')
  ),
  series_rows as (
    select sr.pool_id, sr.stint_id, sr.season, sr.team_id, sr.team_name
    from stint_rows sr
    join events e on e.id = sr.event_id and e.is_series
  ),
  series_seasons as (
    select pool_id, season, count(distinct team_id) as teams
    from series_rows
    group by pool_id, season
  ),
  chain_names as (
    -- The pool player's own team, and their Series team in every other season
    -- that has just one.
    select p.player_id as pool_id, t.name as team_name
    from pool p
    join public.usau_teams t on t.id = p.team_id
    union
    select sr.pool_id, sr.team_name
    from series_rows sr
    join series_seasons ss on ss.pool_id = sr.pool_id and ss.season = sr.season
    where ss.teams = 1 and sr.season <> v_event.season
  ),
  season_chain as (
    select sr.pool_id, sr.season, count(distinct sr.team_id) as chain_teams
    from series_rows sr
    join series_seasons ss on ss.pool_id = sr.pool_id and ss.season = sr.season and ss.teams > 1
    join chain_names cn on cn.pool_id = sr.pool_id and cn.team_name = sr.team_name
    group by sr.pool_id, sr.season
  ),
  namesakes as (
    -- Two Series teams in one season are two people: keep only the stint whose
    -- team is the single one continuing the chain. The pool player's own
    -- stint always stays.
    select distinct sr.pool_id, sr.stint_id
    from series_rows sr
    join series_seasons ss on ss.pool_id = sr.pool_id and ss.season = sr.season and ss.teams > 1
    left join season_chain sc on sc.pool_id = sr.pool_id and sc.season = sr.season
    where sr.stint_id <> sr.pool_id
      and not (
        coalesce(sc.chain_teams, 0) = 1
        and exists (
          select 1 from chain_names cn where cn.pool_id = sr.pool_id and cn.team_name = sr.team_name
        )
      )
  ),
  career_stints as (
    select distinct sr.pool_id, sr.stint_id
    from stint_rows sr
    where not exists (
      select 1 from namesakes ns where ns.pool_id = sr.pool_id and ns.stint_id = sr.stint_id
    )
  ),
  attended as (
    -- Rostered at the event, or a stat line there…
    select sr.pool_id, sr.event_id, sr.team_id
    from stint_rows sr
    join career_stints cs on cs.pool_id = sr.pool_id and cs.stint_id = sr.stint_id
    where sr.event_id is not null
    union
    select cs.pool_id, st.event_id, st.team_id
    from career_stints cs
    join public.usau_player_event_stats st on st.player_id = cs.stint_id
    union
    -- …or, where the event has no per-event rosters, on the roster (that
    -- season) of a team that played it.
    select sr.pool_id, et.event_id, sr.team_id
    from stint_rows sr
    join career_stints cs on cs.pool_id = sr.pool_id and cs.stint_id = sr.stint_id
    join public.usau_event_teams et on et.team_id = sr.team_id
    join history h on h.id = et.event_id and h.no_event_rosters
  ),
  per_event as (
    select distinct a.pool_id, a.event_id, h.kind
    from attended a
    join history h on h.id = a.event_id
  ),
  event_lines as (
    -- One line per player per event; a same-name twin at the same event
    -- keeps the bigger line rather than adding to it.
    select distinct on (cs.pool_id, st.event_id)
           cs.pool_id, st.event_id,
           coalesce(st.goals, 0) as goals,
           coalesce(st.assists, 0) as assists
    from career_stints cs
    join public.usau_player_event_stats st on st.player_id = cs.stint_id
    join history h on h.id = st.event_id
    order by cs.pool_id, st.event_id, coalesce(st.goals, 0) + coalesce(st.assists, 0) desc
  ),
  career as (
    -- No stat line = did not play (Hunter, 2026-10-11): only events with a
    -- line count toward the averages; every event still counts as attended.
    select pe.pool_id,
           count(el.pool_id) as stat_events,
           coalesce(sum(el.goals), 0) as goals,
           coalesce(sum(el.assists), 0) as assists,
           count(*) filter (where pe.kind = 'nationals') as nationals,
           count(*) filter (where pe.kind = 'tct') as tct_events,
           count(*) filter (where pe.kind = 'pro_elite') as pro_elite_events,
           count(*) filter (where pe.kind = 'elite_select') as elite_select_events,
           count(*) filter (where pe.kind = 'select') as select_events
    from per_event pe
    left join event_lines el on el.pool_id = pe.pool_id and el.event_id = pe.event_id
    group by pe.pool_id
  ),
  win_events as (
    -- The rating looks at the last 5 seasons (this one included; this
    -- season's TCT events count), each weighted 0.5^(seasons ago / 3).
    select pe.pool_id, pe.kind,
           el.pool_id is not null as has_line,
           coalesce(el.goals, 0) as goals,
           coalesce(el.assists, 0) as assists,
           power(0.5::float8, (v_event.season - e.season) / 3.0::float8) as w,
           case when pe.kind = 'nationals' then (
             select min(et.final_placement)
             from attended a
             join public.usau_event_teams et on et.event_id = a.event_id and et.team_id = a.team_id
             where a.pool_id = pe.pool_id and a.event_id = pe.event_id
           ) end as placement
    from per_event pe
    join events e on e.id = pe.event_id
    left join event_lines el on el.pool_id = pe.pool_id and el.event_id = pe.event_id
    where e.season > v_event.season - 5
  ),
  win as (
    select pool_id,
           count(*) filter (where has_line) as lined,
           coalesce(sum(goals) filter (where has_line), 0) as goals,
           coalesce(sum(assists) filter (where has_line), 0) as assists,
           sum(w) filter (where has_line) as w_events,
           sum(w * (goals + assists)) filter (where has_line) as w_ga,
           coalesce(sum(w) filter (where kind = 'nationals'), 0) as w_nats,
           coalesce(sum(w) filter (where kind = 'tct'), 0) as w_tct,
           -- Nationals finish: 1st 10 · 2nd 7 · semis 5 · quarters 3 · 9–12 1.5 · 13–16 0.5
           coalesce(sum(w * case when placement = 1 then 10 when placement = 2 then 7 when placement <= 4 then 5
                                 when placement <= 8 then 3 when placement <= 12 then 1.5 when placement > 12 then 0.5
                                 else 0 end) filter (where kind = 'nationals'), 0) as w_place
    from win_events
    group by pool_id
  ),
  prior as (
    -- What a thin sample is pulled toward: the pool's median weighted G+A per
    -- event among players with 3+ lined events in the window.
    select coalesce((
      select s.x from (
        select w_ga / w_events as x,
               row_number() over (order by w_ga / w_events) - 1 as i,
               count(*) over () as n
        from win where lined >= 3
      ) s
      where s.i = s.n / 2
    ), 0) as v
  ),
  comp as (
    select p.player_id,
           case when coalesce(w.lined, 0) > 0 then (w.w_ga + 3 * pr.v) / (w.w_events + 3) else 0 end as prod,
           coalesce(w.w_place, 0) as place,
           coalesce(w.w_nats, 0) as nats,
           coalesce(w.w_tct, 0) as tct
    from pool p
    cross join prior pr
    left join win w on w.pool_id = p.player_id
  ),
  ranked_comp as (
    select c.*,
           row_number() over (order by c.prod) - 1 as i_prod,
           row_number() over (order by c.place) - 1 as i_place,
           row_number() over (order by c.nats) - 1 as i_nats,
           row_number() over (order by c.tct) - 1 as i_tct,
           count(*) over () as n
    from comp c
  ),
  caps as (
    -- Each part is scaled to the pool's top 1% (its p99 value) and capped at 1.
    select coalesce(nullif(max(prod) filter (where i_prod = floor(0.99 * (n - 1))), 0), 1) as prod,
           coalesce(nullif(max(place) filter (where i_place = floor(0.99 * (n - 1))), 0), 1) as place,
           coalesce(nullif(max(nats) filter (where i_nats = floor(0.99 * (n - 1))), 0), 1) as nats,
           coalesce(nullif(max(tct) filter (where i_tct = floor(0.99 * (n - 1))), 0), 1) as tct
    from ranked_comp
  ),
  scored as (
    select p.player_id,
           p.display_name,
           t.name as team_name,
           lower(t.gender_division::text) as division,
           coalesce(w.lined, 0) as stat_events,
           coalesce(w.goals, 0) as goals,
           coalesce(w.assists, 0) as assists,
           case when coalesce(c.stat_events, 0) > 0
                then (c.goals + c.assists)::numeric / c.stat_events
                else 0 end as avg_ga,
           cp.prod,
           -- Weights from Hunter's eye test (2026-10-11): stats 50 · Nationals
           -- finishes 30 · Nationals appearances 10 · TCT appearances 10.
           0.5 * least(1, cp.prod / cap.prod) + 0.3 * least(1, cp.place / cap.place)
             + 0.1 * least(1, cp.nats / cap.nats) + 0.1 * least(1, cp.tct / cap.tct) as score,
           coalesce(c.nationals, 0) as nationals,
           coalesce(c.tct_events, 0) as tct_events,
           coalesce(c.pro_elite_events, 0) as pro_elite_events,
           coalesce(c.elite_select_events, 0) as elite_select_events,
           coalesce(c.select_events, 0) as select_events
    from pool p
    left join public.usau_teams t on t.id = p.team_id
    left join career c on c.pool_id = p.player_id
    left join win w on w.pool_id = p.player_id
    join comp cp on cp.player_id = p.player_id
    cross join caps cap
  )
  select p_event,
         'usau',
         s.player_id::text,
         s.display_name,
         s.team_name,
         row_number() over (order by s.score desc, s.prod desc, lower(s.display_name), s.player_id),
         case
           when s.avg_ga > 0 then 'S'
           when s.nationals > 0 or s.tct_events > 0 then 'A'
           when s.pro_elite_events + s.elite_select_events + s.select_events > 0 then 'B'
           else 'C'
         end,
         s.stat_events,
         case when s.stat_events > 0 then round(s.goals::numeric / s.stat_events, 2) else 0 end,
         case when s.stat_events > 0 then round(s.assists::numeric / s.stat_events, 2) else 0 end,
         s.nationals,
         s.tct_events,
         s.pro_elite_events,
         s.elite_select_events,
         s.select_events,
         now(),
         round(s.score::numeric, 6),
         s.division,
         row_number() over (partition by s.division order by s.score desc, s.prod desc, lower(s.display_name), s.player_id)
  from scored s;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke execute on function public.fantasy_rebuild_player_ratings(uuid) from public, anon, authenticated;
