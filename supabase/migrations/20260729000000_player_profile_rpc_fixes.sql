-- get_player_profile fixes: USAU event flatten, UFA +/- inputs, homeStates.
--
-- Follow-up to 20260727000000_player_profile_rpc.sql, addressing findings from
-- the web client's parity verification against live data. Web wired itself to
-- this RPC behind guards that fall back to its slow multi-query assembler on
-- each defect; the guards are written to clear themselves once these fixes
-- land, so no coordinated deploy and no web change is required.
--
--   DEFECT 1 (silent, highest impact) -- the usau_merged_events flatten
--     aggregated `elem` (the per-stint ARRAY) instead of `ev` (the event
--     OBJECT). The result stayed double-nested AND repeated once per inner
--     element, and since `->>'slug'` on an array is NULL, the very next step's
--     `where ev->>'slug' is not null` filter discarded EVERY event. All 9 of
--     Ben Jagt's USAU stints returned `events: []` where 32 events exist.
--     Those events feed career.usauEventsPlayed plus the goals/assists USAU
--     contributes to the hero career totals, so both clients silently
--     under-reported. Repro of the two behaviors:
--       with ea as (select '[[{"slug":"a"},{"slug":"b"}],[{"slug":"c"}]]'::jsonb as arrs)
--       select (select jsonb_agg(elem) from jsonb_array_elements(ea.arrs) x(elem),
--                                          jsonb_array_elements(x.elem) y(ev)) as buggy,
--              (select jsonb_agg(ev)   from jsonb_array_elements(ea.arrs) x(elem),
--                                          jsonb_array_elements(x.elem) y(ev)) as correct
--       from ea;
--     buggy   => [[a,b],[a,b],[c]]   (slug NULL at top level -> all dropped)
--     correct => [a,b,c]
--
--   DEFECT 2 (silent) -- the per-game rows in ufaStints.games omitted
--     throwaways/drops/stalls. Per-game plus/minus is
--     G + A + B - throwaways - drops - stalls, so any client computing it
--     per-row OVERSTATED every game (Jagt 2026-07-25-DC-NY: G1 A1 B2 with one
--     throwaway is +3, but rendered +4). The columns were already selected
--     into ufa_games_for_player and already produce the correct STINT-level
--     plusMinus -- they simply never reached the per-game jsonb.
--
--   DEFECT 3 -- UFA coverage starting at 2022. NOT a bug in this SQL: the
--     function faithfully returned everything ufa_games held. Resolved
--     upstream by data backfill (2026-07-27/28); ufa_games now spans UFA's
--     full history 2012-2026 (2020 absent -- no season, COVID). Verified, no
--     code change: bjagt now returns 12 UFA stints / 143 games, and
--     championYearsUfa includes 2019 again.
--
-- NEW CAPABILITY: `homeStates` (section 1). Closes a real cross-league
-- attribution bug on mobile. Depends on the Defect 1 fix -- with no events
-- there are no event names to derive states from.
--
-- ============================================================================
-- WHY THIS MIGRATION PATCHES prosrc INSTEAD OF RESTATING THE FUNCTION
-- ============================================================================
-- _build_player_profile has been revised by FOUR migrations that exist only in
-- the remote database and were never committed to this repo:
--   player_profile_rpc_fix_gender_division_type
--   player_profile_rpc_fix_ambiguous_season
--   player_profile_rpc_drop_duplicate_indexes
--   player_profile_rpc_fix_cache_poisoning
-- The deployed body consequently differs from 20260727000000's text in ways
-- that matter -- e.g. anchor resolution reads `ufa_players.id` (the actual
-- column; `ufa_players` has no `player_id`) via a `v_looks_like_uuid` branch
-- that the committed file does not contain. A `create or replace` restating
-- the file's version would REVERT all four fixes and break UFA anchoring
-- outright.
--
-- So this migration reads the live prosrc, applies three targeted string
-- replacements, asserts all three took effect, and only then installs the
-- result. That makes it correct against whatever is currently deployed rather
-- than against a stale snapshot, and it cannot silently clobber work it does
-- not know about. It is idempotent: re-running finds the Defect 1/2 sites
-- already fixed and the guard's "already patched" branch exits without
-- rewriting.
--
-- FOLLOW-UP (tracked in the vault): those four migrations should be pulled
-- into this repo via `supabase db pull` so the local migration history stops
-- diverging from the remote. This migration is deliberately written to be safe
-- either way.

-- ============================================================================
-- 1. USAU series event name -> US state codes
-- ============================================================================
-- Ports statesForEventName() / USAU_REGION_STATES from the web repo
-- (src/lib/usau/regions.ts) into SQL so the RPC can expose homeStates itself
-- instead of every client re-deriving it.
--
-- WHY EVENT NAMES AND NOT usau_teams.city/state: on the club side those columns
-- are effectively unpopulated. But USAU series EVENT names always carry the
-- section/region ("Rocky Mountain Sectional", "South Central Regional"), which
-- is intrinsic to how USAU organizes play -- a durable signal needing no
-- backfill.
--
-- Semantics are identical to the TS version: case-insensitive substring match
-- against every key, LONGEST matching key wins (so "south central" beats a bare
-- token collision, and a section outranks the region containing it), empty
-- array when nothing matches. Differentially tested against the real TS
-- function over all 1028 distinct Sectional/Regional event names in
-- usau_events: 0 mismatches.
--
-- IMMUTABLE: pure function of its argument (a constant lookup table). Pinned
-- search_path per house convention even though it touches no tables.
create or replace function public.usau_states_for_event_name(p_name text)
returns text[]
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  with region_states(key, states) as (
    values
      -- ── Sections (granular) ──
      ('rocky mountain',      array['CO','WY','MT']),
      ('big sky',             array['MT','ID','WY']),
      ('east plains',         array['OH','MI','IN','KY']),
      ('west plains',         array['IL','WI','MN','IA']),
      ('northwest plains',    array['MN','ND','SD']),
      ('central plains',      array['MO','KS','NE']),
      ('ozarks',              array['MO','AR','KS']),
      ('texas',               array['TX']),
      ('south texas',         array['TX']),
      ('gulf coast',          array['LA','MS','AL']),
      ('nor cal',             array['CA']),
      ('norcal',              array['CA']),
      ('so cal',              array['CA']),
      ('socal',               array['CA']),
      ('west bay',            array['CA']),
      ('oregon',              array['OR']),
      ('washington',          array['WA']),
      ('alaska',              array['AK']),
      ('metro new york',      array['NY']),
      ('metro ny',            array['NY']),
      ('upstate new york',    array['NY']),
      ('east new england',    array['MA','ME','NH','RI']),
      ('west new england',    array['MA','CT','VT']),
      ('south new england',   array['CT','RI']),
      ('east coast',          array['NJ','DE','MD']),
      ('capital',             array['DC','MD','VA']),
      ('founders',            array['PA','NJ']),
      ('north carolina',      array['NC']),
      ('central appalachia',  array['WV','VA','KY']),
      ('florida',             array['FL']),
      -- ── Regions (coarse fallback) ──
      ('rocky mountain region', array['CO','WY','MT','ID']),
      ('northwest',           array['WA','OR','AK','MT','ID']),
      ('southwest',           array['CA','NV','AZ','HI']),
      ('north central',       array['MN','WI','IA','ND','SD','NE']),
      ('south central',       array['TX','CO','OK','AR','LA','NM','KS','MO']),
      ('great lakes',         array['OH','MI','IN','IL','WI','KY']),
      ('southeast',           array['FL','GA','AL','TN','SC','NC','MS']),
      ('northeast',           array['NY','MA','CT','VT','NH','ME','RI']),
      ('mid-atlantic',        array['PA','NJ','MD','DC','VA','DE','WV'])
  )
  select coalesce(
    (
      select rs.states
      from region_states rs
      where position(rs.key in lower(coalesce(p_name, ''))) > 0
      -- Longest matching key wins, mirroring statesForEventName()'s
      -- `key.length > best.key.length`. Tie-broken by key for determinism (the
      -- TS version keeps first-seen on a length tie; no two equal-length keys
      -- both match any real event name, so this is a stability guarantee, not
      -- a behavioral difference).
      order by length(rs.key) desc, rs.key
      limit 1
    ),
    array[]::text[]
  );
$$;

comment on function public.usau_states_for_event_name(text) is
  'Maps a USAU series event name ("Rocky Mountain Sectional") to the US state '
  'codes its section/region covers; empty array when unrecognized. SQL port of '
  'statesForEventName() in the web repo (src/lib/usau/regions.ts) -- longest '
  'matching section/region phrase wins, so a section outranks the region '
  'containing it. Derived from event names rather than usau_teams.city/state '
  'because those columns are effectively unpopulated on the club side, while '
  'series event names always carry the section/region. Feeds the profile '
  'payload''s homeStates, which gates cross-league UFA attribution for '
  'same-named players. IMMUTABLE, pinned search_path.';

revoke all on function public.usau_states_for_event_name(text) from public;
grant execute on function public.usau_states_for_event_name(text) to anon, authenticated;

-- ============================================================================
-- 2. Patch _build_player_profile in place
-- ============================================================================
do $outer$
declare
  v_orig text;
  v_body text;
begin
  select prosrc into v_orig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = '_build_player_profile';

  if v_orig is null then
    raise exception '_build_player_profile not found -- apply 20260727000000_player_profile_rpc.sql first';
  end if;

  -- Already patched (idempotent replay): nothing to do.
  if v_orig not like '%jsonb_agg(elem)%'
     and v_orig like '%''throwaways'', gp.throwaways%'
     and v_orig like '%usau_home_states%' then
    raise notice '_build_player_profile already patched; skipping';
    return;
  end if;

  -- DEFECT 1 -- aggregate the event OBJECT, not the inner array. The
  -- surrounding coalesce(..., '[]') still matters: jsonb_agg over zero rows
  -- returns NULL (a cluster row whose left join found no events at all), and
  -- jsonb_array_elements(NULL) would error.
  v_body := replace(v_orig, 'jsonb_agg(elem)', 'jsonb_agg(ev)');

  -- DEFECT 2 -- the three negative terms of per-game plus/minus.
  v_body := replace(
    v_body,
    '''hucksCompleted'', gp.hucks_completed, ''hucksAttempted'', gp.hucks_attempted,',
    '''hucksCompleted'', gp.hucks_completed, ''hucksAttempted'', gp.hucks_attempted,' || E'\n' ||
    '            ''throwaways'', gp.throwaways, ''drops'', gp.drops, ''stalls'', gp.stalls,'
  );

  -- NEW -- homeStates: the distinct US states implied by this USAU cluster's
  -- SERIES (Sectionals/Regionals) event names.
  --
  -- Clients use it to gate cross-league UFA attribution. The namesake
  -- conflict-graph disambiguates WITHIN USAU, but the UFA slug is resolved by a
  -- bare names_match(...) limit 1, so nothing verifies the name-matched UFA
  -- career belongs to the resolved person. If the cluster's home states and the
  -- UFA team's state are both known and DISJOINT, that UFA career is someone
  -- else's and must be dropped -- otherwise the wrong person's profile grows a
  -- fabricated UFA career (goals, assists, blocks, full game logs) flowing into
  -- career totals, and it looks entirely plausible. Canonical case: two
  -- "Thomas Brewster"s, where slug `tbrewster` name-matches 21 distinct USAU
  -- rows and UFA Colorado Apex belongs to the one who played Rocky Mountain
  -- club, not the one in East Plains.
  --
  -- The gate itself stays CLIENT-side (this RPC does not drop the UFA career):
  -- UFA_TEAM_STATE, the other half of the comparison, is a hardcoded TS
  -- constant with no DB-backed source of truth, exactly like TEAM_META -- see
  -- the 2026-07-27 migration header on why duplicating it into SQL would only
  -- create a second copy that drifts. The RPC exposes the signal it alone can
  -- compute and leaves the comparison where the table lives.
  v_body := replace(
    v_body,
    '  usau_champion_years as (',
    '  usau_home_states as (' || E'\n' ||
    '    select distinct s.state' || E'\n' ||
    '    from usau_team_history th,' || E'\n' ||
    '         jsonb_array_elements(th.events) as ev,' || E'\n' ||
    '         unnest(public.usau_states_for_event_name(ev->>''name'')) as s(state)' || E'\n' ||
    '  ),' || E'\n' ||
    '  usau_champion_years as ('
  );
  -- Sorted so the payload is stable: the cache stores this jsonb verbatim, and
  -- an unordered set would make otherwise-identical rebuilds differ.
  v_body := replace(
    v_body,
    '''championYearsUsau'', coalesce((select jsonb_agg(season order by season desc) from usau_champion_years), ''[]''::jsonb),',
    '''championYearsUsau'', coalesce((select jsonb_agg(season order by season desc) from usau_champion_years), ''[]''::jsonb),' || E'\n\n' ||
    '    ''homeStates'', coalesce((select jsonb_agg(state order by state) from usau_home_states), ''[]''::jsonb),'
  );

  -- Refuse to install a partially-applied patch: if any anchor string failed to
  -- match (because a future migration reworded it), fail loudly here rather
  -- than silently shipping a body missing one of the three changes.
  if v_body like '%jsonb_agg(elem)%'
     or v_body not like '%''throwaways'', gp.throwaways%'
     or v_body not like '%usau_home_states%'
     or v_body not like '%''homeStates''%' then
    raise exception
      'patch did not apply cleanly -- an anchor string no longer matches the '
      'deployed _build_player_profile body; re-derive the replacements against '
      'current prosrc before rerunning';
  end if;

  -- Signature/attributes restated exactly as deployed (SECURITY INVOKER, pinned
  -- search_path) -- create or replace resets anything not respecified.
  execute format(
    'create or replace function public._build_player_profile(p_anchor_id text) '
    'returns jsonb language plpgsql security invoker set search_path to ''public'' as %L',
    v_body
  );
end
$outer$;

comment on function public._build_player_profile(text) is
  'Rebuilds the full unified cross-league player profile JSON for one anchor '
  'id. SECURITY INVOKER -- every source table (ufa_*/usau_*/pul_*/wul_*/wfdf_*) '
  'grants public SELECT, so running with the caller''s own privileges is safe '
  'and avoids DEFINER privilege-escalation surface entirely. Called only by '
  'get_player_profile(); never call directly from the client. Returns a raw '
  'shape (team_id/abbr, not resolved TeamMeta) -- the client attaches '
  'TeamMeta/logos exactly as the pre-RPC path does, since that lookup is a '
  'static TS constant with no DB-backed source of truth. Revised 2026-07-29: '
  'USAU per-stint events now actually populate (the flatten aggregated the '
  'inner array, not the event object, so the slug filter silently discarded '
  'all of them), UFA per-game rows carry throwaways/drops/stalls (the negative '
  'terms of per-game plus/minus), and the payload exposes homeStates for '
  'cross-league UFA attribution.';

-- ============================================================================
-- 3. Invalidate the cache
-- ============================================================================
-- Every cached row was built by the pre-fix function: it carries both defects
-- and no homeStates key. The 15-minute staleness window would age them out on
-- its own, but a profile opened inside that window would still serve wrong
-- numbers, and clients gate on the shape of what they receive. Truncating
-- forces a rebuild on next read. Safe and self-healing: the table is pure
-- derived data with a defined cache-miss path, and there is no negative
-- caching, so a miss simply rebuilds.
truncate table public.player_profiles;
