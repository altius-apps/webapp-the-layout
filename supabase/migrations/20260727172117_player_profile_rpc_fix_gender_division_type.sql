-- Exported from the remote migration ledger on 2026-10-11 (Feature Backlog #37): applied to prod but never committed to this repo.
-- Fix: usau_champions.division is computed as plain text (coalesce/case chain
-- over team_a_div/team_b_div which are usau_gender_division enum, plus text
-- literals from the bracket_name fallback), but usau_stints_with_champion
-- joined it against rs.gender_division (still the enum type) with no cast,
-- which raised "COALESCE types usau_gender_division and text cannot be
-- matched" the first time get_player_profile() was invoked end-to-end.
-- Caught during post-migration verification (calling the RPC for real
-- anchors), before any client code depended on it.
create or replace function public._build_player_profile(p_anchor_id text)
returns jsonb
language plpgsql
stable
set search_path to 'public'
as $$
declare
  v_anchor_league text;
  v_anchor_name text;
  v_ufa_slug text;
  v_headshot_url text;
  v_usau_id uuid;
  v_pul_anchor_id uuid;
  v_wul_anchor_id uuid;
  v_looks_like_uuid boolean;
  v_result jsonb;
begin
  v_looks_like_uuid := p_anchor_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  -- ── Anchor resolution ────────────────────────────────────────────────────
  if not v_looks_like_uuid then
    v_anchor_league := 'ufa';
    v_ufa_slug := p_anchor_id;
    select full_name, headshot_url into v_anchor_name, v_headshot_url
    from public.ufa_players
    where id = p_anchor_id;
    if v_anchor_name is null then
      return null;
    end if;
  else
    select display_name into v_anchor_name
    from public.usau_players
    where id = p_anchor_id::uuid;

    if v_anchor_name is not null then
      v_anchor_league := 'usau';
      v_usau_id := p_anchor_id::uuid;
    else
      select player_name into v_anchor_name
      from public.pul_players
      where id = p_anchor_id::uuid;

      if v_anchor_name is not null then
        v_anchor_league := 'pul';
        v_pul_anchor_id := p_anchor_id::uuid;
      else
        select player_name into v_anchor_name
        from public.wul_players
        where id = p_anchor_id::uuid;

        if v_anchor_name is not null then
          v_anchor_league := 'wul';
          v_wul_anchor_id := p_anchor_id::uuid;
        else
          return null;
        end if;
      end if;
    end if;
  end if;

  if v_anchor_name is null then
    return null;
  end if;

  if v_ufa_slug is null then
    select id, headshot_url into v_ufa_slug, v_headshot_url
    from public.ufa_players
    where lower(full_name) = lower(v_anchor_name)
    limit 1;

    if v_ufa_slug is null then
      select id, headshot_url into v_ufa_slug, v_headshot_url
      from public.ufa_players
      where full_name ilike '%' || split_part(public.normalize_player_name(v_anchor_name), ' ',
            array_length(regexp_split_to_array(public.normalize_player_name(v_anchor_name), '\s+'), 1)) || '%'
        and public.names_match(v_anchor_name, full_name)
      limit 1;
    end if;
  end if;

  if v_usau_id is null then
    select id into v_usau_id
    from public.usau_players
    where display_name ilike '%' || split_part(public.normalize_player_name(v_anchor_name), ' ',
          array_length(regexp_split_to_array(public.normalize_player_name(v_anchor_name), '\s+'), 1)) || '%'
      and public.names_match(v_anchor_name, display_name)
    limit 1;
  end if;

  if v_pul_anchor_id is null then
    select id into v_pul_anchor_id
    from public.pul_players
    where player_name ilike '%' || split_part(public.normalize_player_name(v_anchor_name), ' ',
          array_length(regexp_split_to_array(public.normalize_player_name(v_anchor_name), '\s+'), 1)) || '%'
      and public.names_match(v_anchor_name, player_name)
    order by season desc
    limit 1;
  end if;

  if v_wul_anchor_id is null then
    select id into v_wul_anchor_id
    from public.wul_players
    where player_name ilike '%' || split_part(public.normalize_player_name(v_anchor_name), ' ',
          array_length(regexp_split_to_array(public.normalize_player_name(v_anchor_name), '\s+'), 1)) || '%'
      and public.names_match(v_anchor_name, player_name)
    order by season desc
    limit 1;
  end if;

  with

  ufa_games_for_player as (
    select
      g.id as game_id,
      g.year,
      g.week,
      g.start_timestamp,
      g.status,
      g.home_team_id,
      g.away_team_id,
      g.home_score,
      g.away_score,
      s.team_id,
      s.is_home,
      s.goals, s.assists, s.blocks, s.completions, s.throws_attempted,
      s.hucks_completed, s.hucks_attempted, s.throwaways, s.drops, s.stalls
    from public.ufa_game_player_stats s
    join public.ufa_games g on g.id = s.game_id
    where s.player_id = v_ufa_slug
  ),
  ufa_stints as (
    select
      year,
      team_id,
      sum(goals) as goals,
      sum(assists) as assists,
      sum(blocks) as blocks,
      sum(completions) as completions,
      sum(throws_attempted) as throws_attempted,
      sum(hucks_completed) as hucks_completed,
      sum(hucks_attempted) as hucks_attempted,
      count(*) as games_played,
      sum(goals + assists + blocks - throwaways - drops - stalls) as plus_minus
    from ufa_games_for_player
    group by year, team_id
  ),
  ufa_years_played as (
    select distinct year from ufa_games_for_player
  ),
  ufa_season_games as (
    select g.*
    from public.ufa_games g
    where g.year in (select year from ufa_years_played)
  ),
  ufa_season_complete as (
    select year, bool_and(status in ('Final', 'Completed')) as complete
    from ufa_season_games
    group by year
  ),
  ufa_decided_finals as (
    select *
    from ufa_season_games
    where status = 'Final'
      and home_score is distinct from away_score
      and lower(coalesce(id, '')) not like '%allstar%'
      and lower(coalesce(id, '')) not like '%all-star%'
      and lower(coalesce(week, '')) not like '%allstar%'
      and lower(coalesce(week, '')) not like '%all-star%'
  ),
  ufa_champ_weekend as (
    select f.*, 1 as priority
    from ufa_decided_finals f
    where lower(f.week) = 'championship-weekend'
  ),
  ufa_playoff_labeled as (
    select f.*, 2 as priority
    from ufa_decided_finals f
    where lower(f.week) in ('semi-finals', 'semifinals', 'divisional-champ', 'playoffs', 'championship', 'final', 'finals')
      and f.id not in (select id from ufa_champ_weekend)
  ),
  ufa_week_numbered as (
    select f.*,
      (regexp_match(lower(f.week), '^week-(\d+)$'))[1]::int as week_num,
      3 as priority
    from ufa_decided_finals f
    where f.week ~* '^week-\d+$'
  ),
  ufa_top_week as (
    select w.*
    from ufa_week_numbered w
    where w.week_num = (select max(week_num) from ufa_week_numbered w2 where w2.year = w.year)
  ),
  ufa_finals_ranked as (
    select id, year, home_team_id, away_team_id, home_score, away_score, start_timestamp, priority
    from ufa_champ_weekend
    union all
    select id, year, home_team_id, away_team_id, home_score, away_score, start_timestamp, priority
    from ufa_playoff_labeled
    union all
    select id, year, home_team_id, away_team_id, home_score, away_score, start_timestamp, priority
    from ufa_top_week
    union all
    select id, year, home_team_id, away_team_id, home_score, away_score, start_timestamp, 4 as priority
    from ufa_decided_finals
  ),
  ufa_championship_game as (
    select distinct on (year)
      year,
      case when home_score > away_score then home_team_id else away_team_id end as champion_team_id
    from ufa_finals_ranked
    order by year, priority asc, start_timestamp desc nulls last
  ),
  ufa_champion_by_year as (
    select cg.year, cg.champion_team_id
    from ufa_championship_game cg
    join ufa_season_complete sc on sc.year = cg.year and sc.complete
  ),

  usau_anchor as (
    select id, display_name from public.usau_players where id = v_usau_id
  ),
  usau_namesakes as (
    select p.id
    from public.usau_players p, usau_anchor a
    where lower(p.display_name) = lower(a.display_name)
  ),
  usau_namesake_rosters as (
    select r.player_id, r.team_id, r.season
    from public.usau_rosters r
    where r.player_id in (select id from usau_namesakes)
  ),
  usau_pair_conflicts as (
    select distinct ra.player_id as a, rb.player_id as b
    from usau_namesake_rosters ra
    join usau_namesake_rosters rb
      on ra.player_id < rb.player_id
     and ra.season = rb.season
     and ra.team_id <> rb.team_id
  ),
  usau_all_namesake_ids as (
    select id from usau_namesakes
  ),
  usau_edges as (
    select n1.id as a, n2.id as b
    from usau_all_namesake_ids n1
    cross join usau_all_namesake_ids n2
    where n1.id < n2.id
      and not exists (
        select 1 from usau_pair_conflicts c
        where (c.a = n1.id and c.b = n2.id) or (c.a = n2.id and c.b = n1.id)
      )
  ),
  usau_cluster as (
    with recursive reach(id) as (
      select v_usau_id
      union
      select case when e.a = r.id then e.b else e.a end
      from reach r
      join usau_edges e on e.a = r.id or e.b = r.id
    )
    select id from reach
  ),
  usau_cluster_rosters as (
    select r.player_id, r.team_id, r.season, r.jersey_number,
           t.name as team_name, t.gender_division, t.competition_level
    from public.usau_rosters r
    join public.usau_teams t on t.id = r.team_id
    where r.player_id in (select id from usau_cluster)
  ),
  usau_stats_by_event as (
    select s.event_id, sum(coalesce(s.goals,0)) as goals, sum(coalesce(s.assists,0)) as assists
    from public.usau_player_event_stats s
    where s.player_id in (select id from usau_cluster)
    group by s.event_id
  ),
  usau_participation as (
    select et.team_id, et.event_id, et.seed, et.pool,
           e.usau_slug, e.name as event_name, e.season as event_season, e.start_date
    from public.usau_event_teams et
    join public.usau_events e on e.id = et.event_id
    where et.team_id in (select team_id from usau_cluster_rosters)
  ),
  usau_raw_stints as (
    select
      r.team_id, r.season, r.team_name, r.gender_division, r.competition_level,
      (array_agg(r.jersey_number) filter (where r.jersey_number is not null))[1] as jersey_number
    from usau_cluster_rosters r
    group by r.team_id, r.season, r.team_name, r.gender_division, r.competition_level
  ),
  usau_raw_stint_events as (
    select
      rs.team_id, rs.season,
      jsonb_agg(distinct jsonb_build_object(
        'slug', p.usau_slug,
        'name', p.event_name,
        'season', p.event_season,
        'startDate', p.start_date,
        'goals', se.goals,
        'assists', se.assists,
        'seed', p.seed,
        'pool', p.pool
      )) filter (where p.event_id is not null) as events
    from usau_raw_stints rs
    left join usau_participation p on p.team_id = rs.team_id and p.event_season = rs.season
    left join usau_stats_by_event se on se.event_id = p.event_id
    group by rs.team_id, rs.season
  ),
  usau_club_nationals_events as (
    select e.id, e.season
    from public.usau_events e
    where e.competition_level = 'CLUB'
      and (e.usau_slug ilike '%national-championships%'
        or e.usau_slug ilike '%club-nationals%'
        or e.usau_slug ilike '%usa-ultimate-club-championships%')
      and e.usau_slug not ilike '%us-open%'
  ),
  usau_nationals_finals as (
    select g.event_id, g.team_a_id, g.team_b_id, g.score_a, g.score_b, g.bracket_name,
           ta.name as team_a_name, ta.gender_division as team_a_div,
           tb.name as team_b_name, tb.gender_division as team_b_div,
           ne.season
    from public.usau_games g
    join usau_club_nationals_events ne on ne.id = g.event_id
    join public.usau_teams ta on ta.id = g.team_a_id
    join public.usau_teams tb on tb.id = g.team_b_id
    where g.round = 'final' and g.score_a is not null and g.score_b is not null
  ),
  usau_champions as (
    select
      season,
      coalesce(
        (case when score_a > score_b then team_a_div else team_b_div end)::text,
        case
          when bracket_name ilike '%mixed%' then 'Mixed'
          when bracket_name ilike '%women%' then 'Women'
          when bracket_name ilike '%men%' then 'Men'
        end
      ) as division,
      case when score_a > score_b then team_a_id else team_b_id end as champion_team_id
    from usau_nationals_finals
  ),
  usau_stints_with_champion as (
    select rs.*, coalesce(uc.champion_team_id = rs.team_id, false) as is_champion
    from usau_raw_stints rs
    left join usau_champions uc on uc.season = rs.season and uc.division = rs.gender_division::text
  ),
  usau_merge_groups as (
    select
      season,
      lower(trim(team_name)) as team_key,
      gender_division,
      competition_level,
      (array_agg(team_id order by coalesce(jsonb_array_length(events), 0) desc, team_id))[1] as canonical_team_id,
      (array_agg(team_name order by coalesce(jsonb_array_length(events), 0) desc, team_id))[1] as canonical_team_name,
      (array_agg(jersey_number order by (jersey_number is null), team_id))[1] as merged_jersey_number,
      bool_or(is_champion) as merged_is_champion,
      jsonb_agg(events) as event_arrays
    from usau_stints_with_champion sc
    left join usau_raw_stint_events se on se.team_id = sc.team_id and se.season = sc.season
    group by season, lower(trim(team_name)), gender_division, competition_level
  ),
  usau_merged_events as (
    select
      g.season, g.team_key, g.gender_division, g.competition_level,
      (
        select jsonb_agg(ev order by (ev->>'startDate') desc nulls last)
        from (
          select distinct on (ev->>'slug') ev
          from jsonb_array_elements(
            coalesce((select jsonb_agg(elem) from jsonb_array_elements(g.event_arrays) as arr(elem), jsonb_array_elements(arr.elem) as e2(ev)), '[]'::jsonb)
          ) as ev
          where ev->>'slug' is not null
          order by ev->>'slug'
        ) dedup
      ) as merged_events
    from usau_merge_groups g
  ),
  usau_team_history as (
    select
      g.season,
      g.canonical_team_id as team_id,
      g.canonical_team_name as team_name,
      g.gender_division,
      g.competition_level,
      g.merged_jersey_number as jersey_number,
      g.merged_is_champion as is_champion,
      coalesce(me.merged_events, '[]'::jsonb) as events
    from usau_merge_groups g
    left join usau_merged_events me
      on me.season = g.season and me.team_key = g.team_key
     and me.gender_division is not distinct from g.gender_division
     and me.competition_level is not distinct from g.competition_level
  ),
  usau_champion_years as (
    select distinct season from usau_team_history where is_champion
  ),

  pul_by_name as (
    select p.* from public.pul_players p
    where p.player_name = (
      select player_name from public.pul_players where id = v_pul_anchor_id
    )
  ),
  pul_stints as (
    select
      pn.season, pn.team_id, t.name as team_name, t.city as team_city,
      t.logo_url as team_logo_url, t.accent_color as team_accent_color,
      pn.jersey_number, pn.pronouns,
      pn.games_played, pn.goals, pn.assists, pn.blocks, pn.turnovers,
      pn.touches, pn.o_points, pn.d_points, pn.plus_minus
    from pul_by_name pn
    left join public.pul_teams t on t.id = pn.team_id
    where v_pul_anchor_id is not null
  ),

  wul_by_name as (
    select p.* from public.wul_players p
    where v_wul_anchor_id is not null
      and p.player_name = (select player_name from public.wul_players where id = v_wul_anchor_id)
  ),
  wul_game_rows as (
    select
      s.game_id, s.team_id, s.goals, s.assists, s.blocks, s.turnovers,
      s.touches, s.points_played, s.plus_minus, s.total_yards,
      g.game_date, g.week_label, g.away_team_id, g.home_team_id,
      g.away_abbrev, g.home_abbrev, g.away_score, g.home_score, g.season
    from public.wul_game_player_stats s
    join public.wul_games g on g.id = s.game_id
    where v_wul_anchor_id is not null
      and s.player_name = (select player_name from public.wul_players where id = v_wul_anchor_id)
  ),
  wul_stints as (
    select
      wn.season, wn.team_id, t.name as team_name, t.city as team_city,
      t.logo_url as team_logo_url, t.accent_color as team_accent_color,
      wn.jersey_number,
      wn.games_played, wn.goals, wn.assists, wn.blocks, wn.turnovers,
      wn.touches, wn.o_points, wn.d_points, wn.plus_minus,
      (
        select jsonb_agg(jsonb_build_object(
          'gameId', gr.game_id,
          'date', gr.game_date,
          'weekLabel', gr.week_label,
          'opponentAbbrev', case when gr.team_id = gr.home_team_id then gr.away_abbrev else gr.home_abbrev end,
          'result', case
            when gr.home_score is null or gr.away_score is null or gr.home_score = gr.away_score then null
            when gr.team_id = gr.home_team_id then (case when gr.home_score > gr.away_score then 'W' else 'L' end)
            else (case when gr.away_score > gr.home_score then 'W' else 'L' end)
          end,
          'teamScore', case when gr.team_id = gr.home_team_id then gr.home_score else gr.away_score end,
          'oppScore', case when gr.team_id = gr.home_team_id then gr.away_score else gr.home_score end,
          'goals', gr.goals, 'assists', gr.assists, 'blocks', gr.blocks,
          'turnovers', gr.turnovers, 'touches', gr.touches,
          'pointsPlayed', gr.points_played, 'plusMinus', gr.plus_minus,
          'totalYards', gr.total_yards
        ) order by gr.game_date asc nulls last)
        from wul_game_rows gr
        where gr.season = wn.season and gr.team_id = wn.team_id
      ) as games
    from wul_by_name wn
    left join public.wul_teams t on t.id = wn.team_id
  ),

  wfdf_surname as (
    select nullif(split_part(public.normalize_player_name(v_anchor_name), ' ',
      array_length(regexp_split_to_array(public.normalize_player_name(v_anchor_name), '\s+'), 1)), '') as surname
  ),
  wfdf_stints as (
    select
      r.full_name, r.jersey_number, r.goals, r.assists,
      t.id as team_id, t.name as team_name, t.country_code, t.final_standing,
      d.name as division_name,
      e.name as event_name, e.slug as event_slug, e.year
    from public.wfdf_rosters r
    join public.wfdf_teams t on t.id = r.team_id
    join public.wfdf_events e on e.id = t.event_id
    left join public.wfdf_divisions d on d.id = t.division_id
    cross join wfdf_surname ws
    where ws.surname is not null
      and r.last_name ilike '%' || ws.surname || '%'
      and public.names_match(v_anchor_name, r.full_name)
  )

  select jsonb_build_object(
    'anchorId', p_anchor_id,
    'anchorLeague', v_anchor_league,
    'displayName', v_anchor_name,
    'ufaSlug', v_ufa_slug,
    'usauId', v_usau_id,
    'pulAnchorId', v_pul_anchor_id,
    'wulAnchorId', v_wul_anchor_id,
    'headshotUrl', v_headshot_url,
    'pronouns', (select pronouns from pul_by_name order by season desc limit 1),

    'ufaStints', coalesce((
      select jsonb_agg(jsonb_build_object(
        'year', st.year,
        'teamId', st.team_id,
        'totals', jsonb_build_object(
          'gamesPlayed', st.games_played,
          'goals', st.goals,
          'assists', st.assists,
          'blocks', st.blocks,
          'plusMinus', st.plus_minus,
          'completions', st.completions,
          'throwsAttempted', st.throws_attempted,
          'hucksCompleted', st.hucks_completed,
          'hucksAttempted', st.hucks_attempted
        ),
        'isChampion', coalesce(cy.champion_team_id = st.team_id, false),
        'games', (
          select jsonb_agg(jsonb_build_object(
            'gameId', gp.game_id,
            'isHome', gp.is_home,
            'goals', gp.goals, 'assists', gp.assists, 'blocks', gp.blocks,
            'completions', gp.completions, 'throwsAttempted', gp.throws_attempted,
            'hucksCompleted', gp.hucks_completed, 'hucksAttempted', gp.hucks_attempted,
            'homeTeamId', gp.home_team_id, 'awayTeamId', gp.away_team_id,
            'homeScore', gp.home_score, 'awayScore', gp.away_score,
            'startTimestamp', gp.start_timestamp
          ))
          from ufa_games_for_player gp
          where gp.year = st.year and gp.team_id = st.team_id
        )
      ) order by st.year desc)
      from ufa_stints st
      left join ufa_champion_by_year cy on cy.year = st.year
    ), '[]'::jsonb),

    'championYearsUfa', coalesce((
      select jsonb_agg(distinct st.year order by st.year desc)
      from ufa_stints st
      join ufa_champion_by_year cy on cy.year = st.year and cy.champion_team_id = st.team_id
    ), '[]'::jsonb),

    'usauTeamHistory', coalesce((
      select jsonb_agg(jsonb_build_object(
        'season', th.season,
        'teamId', th.team_id,
        'teamName', th.team_name,
        'genderDivision', th.gender_division,
        'competitionLevel', th.competition_level,
        'jerseyNumber', th.jersey_number,
        'isChampion', th.is_champion,
        'events', th.events
      ) order by th.season desc, th.team_name)
      from usau_team_history th
    ), '[]'::jsonb),

    'championYearsUsau', coalesce((select jsonb_agg(season order by season desc) from usau_champion_years), '[]'::jsonb),

    'pul', case when v_pul_anchor_id is null then null else jsonb_build_object(
      'stints', coalesce((
        select jsonb_agg(jsonb_build_object(
          'season', ps.season, 'teamId', ps.team_id, 'teamName', ps.team_name,
          'teamCity', ps.team_city, 'teamLogoUrl', ps.team_logo_url,
          'teamAccentColor', ps.team_accent_color, 'jerseyNumber', ps.jersey_number,
          'pronouns', ps.pronouns,
          'stats', jsonb_build_object(
            'gamesPlayed', ps.games_played, 'goals', ps.goals, 'assists', ps.assists,
            'blocks', ps.blocks, 'turnovers', ps.turnovers, 'touches', ps.touches,
            'oPoints', ps.o_points, 'dPoints', ps.d_points, 'plusMinus', ps.plus_minus
          )
        ) order by ps.season desc)
        from pul_stints ps
      ), '[]'::jsonb),
      'career', jsonb_build_object(
        'seasonsPlayed', (select count(*) from pul_stints),
        'gamesPlayed', (select coalesce(sum(games_played),0) from pul_stints),
        'goals', (select coalesce(sum(goals),0) from pul_stints),
        'assists', (select coalesce(sum(assists),0) from pul_stints),
        'blocks', (select coalesce(sum(blocks),0) from pul_stints),
        'turnovers', (select coalesce(sum(turnovers),0) from pul_stints),
        'touches', (select coalesce(sum(touches),0) from pul_stints),
        'plusMinus', (select coalesce(sum(plus_minus),0) from pul_stints)
      )
    ) end,

    'wul', case when v_wul_anchor_id is null then null else jsonb_build_object(
      'stints', coalesce((
        select jsonb_agg(jsonb_build_object(
          'season', ws.season, 'teamId', ws.team_id, 'teamName', ws.team_name,
          'teamCity', ws.team_city, 'teamLogoUrl', ws.team_logo_url,
          'teamAccentColor', ws.team_accent_color, 'jerseyNumber', ws.jersey_number,
          'stats', jsonb_build_object(
            'gamesPlayed', ws.games_played, 'goals', ws.goals, 'assists', ws.assists,
            'blocks', ws.blocks, 'turnovers', ws.turnovers, 'touches', ws.touches,
            'oPoints', ws.o_points, 'dPoints', ws.d_points, 'plusMinus', ws.plus_minus
          ),
          'games', coalesce(ws.games, '[]'::jsonb)
        ) order by ws.season desc)
        from wul_stints ws
      ), '[]'::jsonb),
      'career', jsonb_build_object(
        'seasonsPlayed', (select count(*) from wul_stints),
        'gamesPlayed', (select coalesce(sum(games_played),0) from wul_stints),
        'goals', (select coalesce(sum(goals),0) from wul_stints),
        'assists', (select coalesce(sum(assists),0) from wul_stints),
        'blocks', (select coalesce(sum(blocks),0) from wul_stints),
        'turnovers', (select coalesce(sum(turnovers),0) from wul_stints),
        'touches', (select coalesce(sum(touches),0) from wul_stints),
        'plusMinus', (select coalesce(sum(plus_minus),0) from wul_stints)
      )
    ) end,

    'wfdfStints', coalesce((
      select jsonb_agg(jsonb_build_object(
        'season', wf.year, 'teamId', wf.team_id, 'teamName', wf.team_name,
        'countryCode', wf.country_code, 'divisionName', wf.division_name,
        'eventName', wf.event_name, 'eventSlug', wf.event_slug,
        'jerseyNumber', wf.jersey_number,
        'isChampion', coalesce(wf.final_standing = 1, false),
        'stats', jsonb_build_object('goals', wf.goals, 'assists', wf.assists)
      ) order by wf.year desc)
      from wfdf_stints wf
    ), '[]'::jsonb)

  ) into v_result;

  return v_result;
end;
$$;
