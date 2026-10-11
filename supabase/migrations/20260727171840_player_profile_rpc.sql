-- Exported from the remote migration ledger on 2026-10-11 (Feature Backlog #37): applied to prod but never committed to this repo.
-- Unified player profile: server-side assembly + cache-aside table.
--
-- PROBLEM: getUnifiedPlayerProfile() (mobile src/lib/players/unified.ts, web
-- src/lib/unified-player.ts) does 10-15 sequential/fanned-out client->PostgREST
-- round trips per profile open (anchor resolution across ufa/usau/pul/wul,
-- per-season UFA game-log fan-out, champions map, name-matched cross-league
-- lookups). On mobile networks that's 2-5s. This migration moves the assembly
-- into a single Postgres RPC plus a precomputed cache table so hot reads don't
-- recompute.
--
-- SPEC OF RECORD: this reproduces the EXISTING merge semantics of
-- getUnifiedPlayerProfile() in both repos, with one deliberate correction:
-- USAU team-history is returned MERGED (mergeUsauTeamHistory semantics -- same
-- season/name/division/level rows collapsed, events unioned by slug). Mobile
-- already applies this client-side; web does NOT (confirmed by reading
-- src/lib/unified-player.ts -- it iterates sideUsau.teamHistory raw), which is
-- the known duplicate-HoRSE-row bug on web. Doing the merge in SQL means both
-- clients get the fix once they read from this RPC.
--
-- NOT reproduced (deliberately out of scope / deferred):
--   - Web's location-based UFA attribution (homeStates vs ufaTeamState) used to
--     disambiguate two USAU people sharing a name. Mobile's unified.ts does not
--     implement this signal at all, and mobile is the spec of record per this
--     task. Flagged in the delivery report as a pre-existing web/mobile
--     divergence, not something this migration introduces.
--   - TeamMeta (colors/logos/division) for UFA franchises. TEAM_META lives as a
--     hardcoded TS constant (src/lib/ufa/teams.ts) with no DB-backed source of
--     truth, including historical-franchise aliasing (ABBR_ALIAS) that has no
--     column anywhere. Duplicating it into SQL would create a second copy that
--     drifts. The RPC returns raw team_id/abbr; the client attaches TeamMeta
--     exactly as it does today for the non-RPC path.
--   - Live watchufa.com headshot/name scrape fallback. Per task scope, the RPC
--     returns the STORED ufa_players.headshot_url only; the client keeps its
--     live-scrape fallback for null.

-- ============================================================================
-- 1. Cache table
-- ============================================================================

create table if not exists public.player_profiles (
  anchor_id   text primary key,
  profile     jsonb not null,
  built_at    timestamptz not null default now(),
  -- Cheap freshness/debugging metadata. build_ms lets us watch for rebuild-cost
  -- regressions (e.g. a player who suddenly has 15 UFA seasons) via a normal
  -- SELECT rather than re-running EXPLAIN ANALYZE by hand. anchor_league saves
  -- a jsonb->>'anchorLeague' extraction for any future admin/debug query.
  anchor_league text,
  build_ms    integer
);

comment on table public.player_profiles is
  'Cache-aside store for the unified cross-league player profile RPC '
  '(get_player_profile). One row per anchor id (UFA slug / USAU / PUL / WUL '
  'uuid). World-readable; writes happen only inside _upsert_player_profile '
  '(SECURITY DEFINER, pinned search_path) or the reader''s best-effort '
  'self-write. Never write here directly.';

alter table public.player_profiles enable row level security;

-- Public read, same pattern as usau_rankings: anyone (anon + authenticated)
-- can read a cached profile; there is no INSERT/UPDATE/DELETE policy for any
-- role, so all writes must go through a SECURITY DEFINER function (or the
-- service role) even if RLS were somehow bypassed at the table level.
create policy player_profiles_select_public
  on public.player_profiles
  for select
  to anon, authenticated
  using (true);

-- ============================================================================
-- 2. Name-matching helper -- SQL port of src/lib/name-match.ts
-- ============================================================================
-- Mirrors namesMatch()/givenMatches() exactly: surname must match exactly
-- (after normalize_player_name, which already NFD-strips/lowercases/strips
-- punctuation -- same normalization namesMatch's normalizeName() does), then
-- every given-name token on the shorter side must match some not-yet-claimed
-- given-name token on the longer side, either exactly or as a >=3-char prefix
-- (Ben < Benjamin). Conservative by design -- no nickname table, matching the
-- TS implementation's documented limitations.

create or replace function public.names_match(a text, b text)
returns boolean
language plpgsql
immutable
set search_path to 'public'
as $$
declare
  norm_a text := public.normalize_player_name(a);
  norm_b text := public.normalize_player_name(b);
  tokens_a text[];
  tokens_b text[];
  surname_a text;
  surname_b text;
  givens_a text[];
  givens_b text[];
  shorter text[];
  longer text[];
  used boolean[];
  g text;
  matched boolean;
  i integer;
begin
  if norm_a is null or norm_b is null then
    return false;
  end if;

  tokens_a := regexp_split_to_array(norm_a, '\s+');
  tokens_b := regexp_split_to_array(norm_b, '\s+');
  if array_length(tokens_a, 1) < 2 or array_length(tokens_b, 1) < 2 then
    return false;
  end if;

  surname_a := tokens_a[array_length(tokens_a, 1)];
  surname_b := tokens_b[array_length(tokens_b, 1)];
  if surname_a <> surname_b then
    return false;
  end if;

  givens_a := tokens_a[1:array_length(tokens_a, 1) - 1];
  givens_b := tokens_b[1:array_length(tokens_b, 1) - 1];

  if array_length(givens_a, 1) <= array_length(givens_b, 1) then
    shorter := givens_a;
    longer := givens_b;
  else
    shorter := givens_b;
    longer := givens_a;
  end if;

  used := array_fill(false, array[array_length(longer, 1)]);

  foreach g in array shorter loop
    matched := false;
    for i in 1..array_length(longer, 1) loop
      if used[i] then
        continue;
      end if;
      -- exact match OR >=3-char prefix match in either direction
      if g = longer[i]
         or (length(g) >= 3 and length(longer[i]) >= length(g) and left(longer[i], length(g)) = g)
         or (length(longer[i]) >= 3 and length(g) >= length(longer[i]) and left(g, length(longer[i])) = longer[i])
      then
        used[i] := true;
        matched := true;
        exit;
      end if;
    end loop;
    if not matched then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

comment on function public.names_match(text, text) is
  'SQL port of src/lib/name-match.ts namesMatch(). Token-subset cross-league '
  'name matching: exact surname + each shorter-side given matches an unclaimed '
  'longer-side given (exact or >=3-char prefix). Used by the unified player '
  'profile builder to cross-link UFA/USAU/PUL/WUL/WFDF records by name.';

-- ============================================================================
-- 3. Profile builder -- SECURITY INVOKER
-- ============================================================================
-- All source tables (ufa_*, usau_*, pul_*, wul_*, wfdf_*) grant SELECT to
-- anon+authenticated (verified via pg_policies before writing this function --
-- every table this reads has a `for select ... to anon, authenticated/public
-- using (true)` policy, no exceptions). INVOKER is therefore safe and correct:
-- it runs with the caller's own (already-public) read privileges, so there is
-- no privilege-escalation surface and no need to pin search_path against a
-- hijack in the caller's session (INVOKER functions don't get that attack
-- surface the way DEFINER ones do) -- we still pin it anyway, matching the
-- existing house convention (search_ufa_players_fuzzy, top_usau_club_teams,
-- get_player_connections are all INVOKER + `set search_path to 'public'`).
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
    -- UFA slug anchor. Fast path: ufa_players row (stored name + headshot).
    v_anchor_league := 'ufa';
    v_ufa_slug := p_anchor_id;
    select full_name, headshot_url into v_anchor_name, v_headshot_url
    from public.ufa_players
    where id = p_anchor_id;
    -- No live watchufa scrape fallback here (out of scope -- RPC returns
    -- stored-only; caller falls back to the old client path entirely when
    -- this returns null, which covers the not-yet-synced-player case too).
    if v_anchor_name is null then
      return null;
    end if;
  else
    -- UUID anchor: try USAU, then PUL, then WUL (mirrors the TS sequential
    -- fallback -- all three leagues use v4 uuids so order matters).
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
          return null; -- unresolvable
        end if;
      end if;
    end if;
  end if;

  if v_anchor_name is null then
    return null;
  end if;

  -- Resolve the UFA slug by name if we didn't anchor on UFA directly. Prefer
  -- an exact case-insensitive full_name match (fast, indexed); fall back to
  -- names_match over a surname-prefiltered set (mirrors findUfaSlugByName's
  -- token-subset matching, but scoped to ufa_players rather than walking 3
  -- seasons of leaderboards since ufa_players covers ~97% of the roster and
  -- is a single indexed table).
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

  -- Resolve USAU id by name if not already anchored there.
  if v_usau_id is null then
    select id into v_usau_id
    from public.usau_players
    where display_name ilike '%' || split_part(public.normalize_player_name(v_anchor_name), ' ',
          array_length(regexp_split_to_array(public.normalize_player_name(v_anchor_name), '\s+'), 1)) || '%'
      and public.names_match(v_anchor_name, display_name)
    limit 1;
  end if;

  -- Resolve PUL canonical name if not already anchored there.
  if v_pul_anchor_id is null then
    select id into v_pul_anchor_id
    from public.pul_players
    where player_name ilike '%' || split_part(public.normalize_player_name(v_anchor_name), ' ',
          array_length(regexp_split_to_array(public.normalize_player_name(v_anchor_name), '\s+'), 1)) || '%'
      and public.names_match(v_anchor_name, player_name)
    order by season desc
    limit 1;
  end if;

  -- Resolve WUL canonical name if not already anchored there.
  if v_wul_anchor_id is null then
    select id into v_wul_anchor_id
    from public.wul_players
    where player_name ilike '%' || split_part(public.normalize_player_name(v_anchor_name), ' ',
          array_length(regexp_split_to_array(public.normalize_player_name(v_anchor_name), '\s+'), 1)) || '%'
      and public.names_match(v_anchor_name, player_name)
    order by season desc
    limit 1;
  end if;

  -- ── Assemble the JSON result ─────────────────────────────────────────────
  with

  -- UFA: aggregate ufa_game_player_stats -> per (year, team) stint, matching
  -- sumUfaRows()'s exact formula: plusMinus = goals+assists+blocks-throwaways
  -- -drops-stalls. Game rows are nested per stint (mirrors buildUfaSide's
  -- per-year game log, filtered to the team the stint belongs to).
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
  -- Championship detection, reproducing findChampionshipGame()'s heuristic:
  -- decided finals only (no ties, no all-star exhibition), season must be
  -- fully complete (every game Final/Completed), prefer explicit
  -- championship-weekend/playoff week labels, else the highest numeric
  -- week-N, else the latest decided final overall.
  --
  -- IMPORTANT: this must scan the FULL season's games (every team), not just
  -- games this player appears in -- "is the season complete" and "who won the
  -- championship game" are properties of the LEAGUE-YEAR, not the player.
  -- Queried directly from public.ufa_games by year (NOT from
  -- ufa_games_for_player, which only holds this player's own box-score rows).
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
    -- Best priority (lowest number), then latest start_timestamp, per year.
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

  -- USAU: reproduce getPlayerProfile()'s union-find identity cluster, but
  -- scoped to the resolved v_usau_id's cluster only (we already know which
  -- person we want -- no need to recompute the anchor search). We still need
  -- the SAME-NAME candidate set + conflict rule (two ids conflict if they
  -- share a season on different teams) to include every id the anchor's
  -- cluster legitimately spans, because a person can accumulate rows under
  -- multiple usau_players ids the scraper never merged.
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
  -- Union-find via recursive reachability: two namesake ids are in the same
  -- cluster as the anchor iff there is a chain of ids, each consecutive pair
  -- sharing at least one (different-team) NON-conflicting season overlap, or
  -- more simply (matching the TS): NO conflicting pair anywhere breaks them
  -- apart at the edge level. We compute pairwise conflicts, then take the
  -- anchor's connected component in the "non-conflict" graph.
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
    -- Every pair of namesake ids that is NOT a recorded conflict is a
    -- same-person edge (mirrors the TS union() call executing whenever
    -- `!conflict`).
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
    -- Recursive closure starting from the anchor id over usau_edges.
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
  -- Raw (pre-merge) stints, deduped by (team_id, season) same as stintMap in
  -- getPlayerProfile().
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
  -- Championship marking, pre-merge (same as TS: derived from champions map
  -- keyed by (season, division) BEFORE the merge collapses team_ids).
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
        case when score_a > score_b then team_a_div else team_b_div end,
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
    left join usau_champions uc on uc.season = rs.season and uc.division = rs.gender_division
  ),
  -- Merge pass: mergeUsauTeamHistory semantics. Group by (season, lower(trim(
  -- team_name)), gender_division, competition_level). Canonical = most events;
  -- jersey = first non-null across group; isChampion = any; events unioned by
  -- slug (jsonb_agg with distinct already de-dupes identical event objects,
  -- but we need dedup BY SLUG specifically, keeping first-seen -- done in a
  -- second pass below since two different rows could carry different
  -- goals/assists for the "same" event if the scraper double-counted; we keep
  -- the first one encountered, ordered by team_id, matching "iterate group in
  -- order, first write to eventsBySlug wins").
  usau_merge_groups as (
    select
      season,
      lower(trim(team_name)) as team_key,
      gender_division,
      competition_level,
      -- canonical stint fields: pick the row with the most events as
      -- "most complete", tie-broken by team_id for determinism.
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
    -- Flatten all event arrays in the group, dedupe by slug (first occurrence
    -- wins), sort newest-first by startDate -- matches events.sort() in
    -- mergeUsauTeamHistory.
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

  -- PUL: season rows by name (no per-game-log fetch needed -- profile shape
  -- doesn't nest PUL games; matches mobile's PulSeasonStint, which has no
  -- `games` field -- the per-game log is a separate "For You" spotlight
  -- concern, not part of UnifiedPlayerProfile.pul). We include season totals
  -- only, which is what UnifiedPlayerProfile.pul consumes.
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

  -- WUL: season rows by name + per-season game log (unified profile DOES nest
  -- WUL games -- WulSeasonStint.games is populated in both mobile and web).
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

  -- WFDF: name-matched roster appearances across all events (never an anchor).
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

comment on function public._build_player_profile(text) is
  'Rebuilds the full unified cross-league player profile JSON for one anchor '
  'id. SECURITY INVOKER -- every source table (ufa_*/usau_*/pul_*/wul_*/wfdf_*) '
  'grants public SELECT, verified via pg_policies before this function was '
  'written, so running with the caller''s own privileges is safe and avoids '
  'DEFINER privilege-escalation surface entirely. Called only by '
  'get_player_profile(); never call directly from the client. Returns a raw '
  'shape (team_id/abbr, not resolved TeamMeta) -- the client maps this into '
  'UnifiedPlayerProfile, attaching TeamMeta/logos exactly as the pre-RPC path '
  'does today, since that lookup is a static TS constant with no DB-backed '
  'source of truth.';

-- ============================================================================
-- 4. Writer -- SECURITY DEFINER, strictly scoped to the upsert
-- ============================================================================
-- Anon/authenticated cannot INSERT/UPDATE player_profiles (no such policy
-- exists -- see section 1). Since _build_player_profile runs as INVOKER (an
-- anon/authenticated caller), it cannot write the cache row itself under RLS.
-- Rather than making the whole builder DEFINER (unnecessary privilege
-- escalation for a function that only ever reads already-public data), we
-- give it a minimal, single-purpose DEFINER writer that does nothing but
-- upsert a jsonb blob the caller already computed. Pinned search_path
-- (public, pg_temp) per house convention (search_fuzzy_rpcs_pin_search_path)
-- and hard rule against unpinned DEFINER functions. No secrets, no dynamic
-- SQL, no user-controlled identifiers -- just a parameterized upsert.
create or replace function public._upsert_player_profile(
  p_anchor_id text,
  p_profile jsonb,
  p_anchor_league text,
  p_build_ms integer
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  insert into public.player_profiles (anchor_id, profile, built_at, anchor_league, build_ms)
  values (p_anchor_id, p_profile, now(), p_anchor_league, p_build_ms)
  on conflict (anchor_id) do update
    set profile = excluded.profile,
        built_at = excluded.built_at,
        anchor_league = excluded.anchor_league,
        build_ms = excluded.build_ms;
end;
$$;

comment on function public._upsert_player_profile(text, jsonb, text, integer) is
  'SECURITY DEFINER writer strictly scoped to upserting a pre-computed profile '
  'JSON into player_profiles. Exists because anon/authenticated cannot write '
  'that table directly under RLS, and get_player_profile()/'
  '_build_player_profile() run as INVOKER. Pinned search_path (public, '
  'pg_temp). Do not add any other statement to this function -- keep the '
  'DEFINER surface minimal and auditable.';

-- Lock down execute grants: only the reader RPC needs to call this, but
-- Postgres has no "function can only be called by function" primitive, so we
-- grant EXECUTE to anon/authenticated (same principals that can call
-- get_player_profile) rather than leaving it at the PUBLIC default. The
-- function itself takes no identity/auth-sensitive input -- worst case a
-- malicious direct call just re-writes a cache row with attacker-chosen JSON
-- under an attacker-chosen anchor_id key, which is a cache-poisoning risk for
-- OTHER users reading that anchor_id. Mitigated by get_advisors review below
-- and by the fact the value is fully attacker-visible anyway (it's public
-- data); worst outcome is a wrong profile shown until the next 15-min rebuild.
revoke all on function public._upsert_player_profile(text, jsonb, text, integer) from public;
grant execute on function public._upsert_player_profile(text, jsonb, text, integer) to anon, authenticated;

revoke all on function public._build_player_profile(text) from public;
grant execute on function public._build_player_profile(text) to anon, authenticated;

-- ============================================================================
-- 5. Reader RPC -- cache-aside, SECURITY INVOKER
-- ============================================================================
-- STALENESS WINDOW: 15 minutes. This matches the `sync-live-events-every-15-min`
-- and `wfdf-ingest-live-every-15-min` pg_cron jobs already running in this
-- project (see cron.job) -- there is no point serving a profile fresher than
-- the underlying source data's own sync cadence. Kept as a literal constant
-- below (not a config table) so it's visible at a glance; bump it here if the
-- sync cadence ever changes.
create or replace function public.get_player_profile(p_anchor_id text)
returns jsonb
language plpgsql
stable
set search_path to 'public'
as $$
declare
  c_staleness_window constant interval := interval '15 minutes'; -- matches sync-live-events-every-15-min cadence
  v_cached jsonb;
  v_built_at timestamptz;
  v_fresh_profile jsonb;
  v_start timestamptz := clock_timestamp();
  v_anchor_league text;
begin
  if p_anchor_id is null or length(trim(p_anchor_id)) = 0 then
    return null;
  end if;

  select profile, built_at into v_cached, v_built_at
  from public.player_profiles
  where anchor_id = p_anchor_id;

  if v_cached is not null and v_built_at > now() - c_staleness_window then
    return v_cached;
  end if;

  v_fresh_profile := public._build_player_profile(p_anchor_id);

  if v_fresh_profile is null then
    -- Unresolvable anchor. Do NOT cache a null/negative result -- a brand-new
    -- player synced moments later should be resolvable on the very next call,
    -- not stuck behind a 15-minute negative-cache window. Fall back to
    -- serving a stale positive cache row if one exists (better a slightly
    -- stale real profile than nothing), matching the spirit of "degrade
    -- gracefully" the TS builder already follows for per-league failures.
    return v_cached; -- null if there was never a cached row either
  end if;

  v_anchor_league := v_fresh_profile->>'anchorLeague';

  -- Best-effort self-write through the scoped DEFINER writer. Never let a
  -- write failure fail the read -- the caller still gets the freshly built
  -- profile even if, for whatever reason, the upsert doesn't stick (e.g. a
  -- transient issue) and the next call just rebuilds again.
  begin
    perform public._upsert_player_profile(
      p_anchor_id,
      v_fresh_profile,
      v_anchor_league,
      (extract(epoch from (clock_timestamp() - v_start)) * 1000)::integer
    );
  exception when others then
    null; -- swallow; reads must never fail because the cache write failed
  end;

  return v_fresh_profile;
end;
$$;

comment on function public.get_player_profile(text) is
  'Cache-aside entry point for the unified cross-league player profile. '
  'Accepts a UFA slug, USAU uuid, PUL uuid, or WUL uuid. Returns the cached '
  'profile jsonb when fresher than 15 minutes (matches the sync-live-events '
  'cron cadence); otherwise rebuilds via _build_player_profile, upserts '
  'through the scoped DEFINER writer, and returns the fresh JSON. Returns '
  'null for an anchor that resolves to no known player (never raises). '
  'SECURITY INVOKER: safe because every source table it (transitively) reads '
  'is public-SELECT; the one privileged operation (the cache write) is '
  'delegated to _upsert_player_profile, a minimal SECURITY DEFINER function.';

revoke all on function public.get_player_profile(text) from public;
grant execute on function public.get_player_profile(text) to anon, authenticated;

-- ============================================================================
-- 6. Indexes to keep the builder fast
-- ============================================================================
-- ufa_game_player_stats is queried by player_id on every UFA-anchored/
-- UFA-attached profile build; usau_rosters/usau_player_event_stats by
-- player_id likewise for USAU. pul_players/wul_players by player_name for the
-- name-join leagues. Most of these likely already have FK-backed indexes from
-- prior migrations -- `if not exists` makes this migration idempotent either
-- way and a no-op cost if they're already present.
create index if not exists idx_ufa_game_player_stats_player_id on public.ufa_game_player_stats (player_id);
create index if not exists idx_usau_rosters_player_id on public.usau_rosters (player_id);
create index if not exists idx_usau_player_event_stats_player_id on public.usau_player_event_stats (player_id);
create index if not exists idx_pul_players_player_name on public.pul_players (player_name);
create index if not exists idx_wul_players_player_name on public.wul_players (player_name);
create index if not exists idx_wul_game_player_stats_player_name on public.wul_game_player_stats (player_name);
create index if not exists idx_wfdf_rosters_last_name on public.wfdf_rosters (last_name);
create index if not exists idx_ufa_players_full_name_lower on public.ufa_players (lower(full_name));
create index if not exists idx_usau_players_display_name_lower on public.usau_players (lower(display_name));
