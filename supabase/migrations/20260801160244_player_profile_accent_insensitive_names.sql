-- get_player_profile fix: accent-insensitive cross-league name resolution.
--
-- BUG (mobile report, 2026-08-01): opening Daan De Marrée from UFA NY Empire
-- showed no USAU career (Chicago Machine missing entirely), while opening the
-- same person from Machine's roster showed both careers. The asymmetry:
--
--   * UUID -> UFA resolves via lower(full_name) = lower(v_anchor_name); both
--     stored names carry the accent ("Marrée") so the exact match hits.
--   * UFA -> USAU/PUL/WUL resolves via the prefilter
--       <name column> ilike '%' || <last token of normalize_player_name(name)> || '%'
--     normalize_player_name() STRIPS accents ("marree"), but the raw column
--     keeps them ("Marrée") -- ILIKE does no unaccenting, so the prefilter
--     returns zero candidates, v_usau_id stays null, and the entire USAU side
--     silently drops from the profile. Every accented name breaks the same
--     way at all five prefilter sites: USAU, PUL, WUL, the UFA ilike
--     fallback, and the WFDF roster match (r.last_name ilike '%<normalized
--     surname>%' -- that one fails for accented WFDF roster names in EVERY
--     direction, not just UFA-anchored opens, dropping Worlds stints).
--     names_match() normalizes both args internally -- the ILIKE prefilters
--     are the ONLY accent-sensitive gates in the chain.
--
-- FIX: normalize the COLUMN side of each prefilter to match the token side:
--       public.normalize_player_name(<col>) ilike '%<token>%'
-- backed by expression trigram indexes on the normalized names. The indexes
-- are load-bearing, not an optimization: measured on live data, the patched
-- predicate without one seq-scans usau_players and runs plpgsql names_match
-- on all 203k rows (14.5s); with the trgm index the prefilter narrows to the
-- surname cluster first and names_match only sees a handful of rows -- the
-- same shape the raw-column trgm indexes gave the old predicate.
--
-- Patches prosrc in place -- same rationale and pattern as 20260729000000:
-- the deployed body carries revisions that exist only in remote-only
-- migrations, so `create or replace` restating any committed file's text
-- would silently revert them. Idempotent: re-running detects the already-
-- patched body and exits. Asserts every site was hit before installing.

-- ============================================================================
-- 1. Expression trigram indexes on normalized name columns
-- ============================================================================
-- normalize_player_name is IMMUTABLE, so it is legal in an index expression.
-- usau_players (203k rows) and wfdf_rosters (21k) genuinely need these; the
-- other three are small but get the same index so all five patched predicates
-- keep the same prefilter-first plan shape.
create index if not exists usau_players_display_name_norm_trgm
  on public.usau_players using gin (public.normalize_player_name(display_name) gin_trgm_ops);
create index if not exists ufa_players_full_name_norm_trgm
  on public.ufa_players using gin (public.normalize_player_name(full_name) gin_trgm_ops);
create index if not exists pul_players_player_name_norm_trgm
  on public.pul_players using gin (public.normalize_player_name(player_name) gin_trgm_ops);
create index if not exists wul_players_player_name_norm_trgm
  on public.wul_players using gin (public.normalize_player_name(player_name) gin_trgm_ops);
create index if not exists wfdf_rosters_last_name_norm_trgm
  on public.wfdf_rosters using gin (public.normalize_player_name(last_name) gin_trgm_ops);

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
  if strpos(v_orig, 'public.normalize_player_name(display_name) ilike') > 0 then
    raise notice '_build_player_profile already accent-insensitive; skipping';
    return;
  end if;

  -- UFA name-match fallback (one site).
  v_body := replace(v_orig,
    'full_name ilike ''%'' || split_part',
    'public.normalize_player_name(full_name) ilike ''%'' || split_part');
  -- USAU resolution (one site).
  v_body := replace(v_body,
    'display_name ilike ''%'' || split_part',
    'public.normalize_player_name(display_name) ilike ''%'' || split_part');
  -- PUL and WUL resolutions share the identical text (both prefilter
  -- player_name) -- replace() hitting both occurrences is intended.
  v_body := replace(v_body,
    'player_name ilike ''%'' || split_part',
    'public.normalize_player_name(player_name) ilike ''%'' || split_part');
  -- WFDF roster match (one site; ws.surname is already normalized).
  v_body := replace(v_body,
    'r.last_name ilike ''%'' || ws.surname',
    'public.normalize_player_name(r.last_name) ilike ''%'' || ws.surname');

  -- Refuse to install a partially-applied patch. The space-delimited probes
  -- match only the UNpatched form: after patching, each column is preceded by
  -- "(" not " " (…normalize_player_name(full_name) ilike…), so any hit here
  -- means an anchor string failed to match the deployed body.
  if strpos(v_body, ' full_name ilike ') > 0
     or strpos(v_body, ' display_name ilike ') > 0
     or strpos(v_body, ' player_name ilike ') > 0
     or strpos(v_body, ' r.last_name ilike ') > 0
     or strpos(v_body, 'public.normalize_player_name(full_name) ilike') = 0
     or strpos(v_body, 'public.normalize_player_name(display_name) ilike') = 0
     or strpos(v_body, 'public.normalize_player_name(player_name) ilike') = 0
     or strpos(v_body, 'public.normalize_player_name(r.last_name) ilike') = 0 then
    raise exception
      'patch did not apply cleanly -- an anchor string no longer matches the '
      'deployed _build_player_profile body; re-derive the replacements against '
      'current prosrc before rerunning';
  end if;

  -- Signature/attributes restated exactly as deployed (SECURITY INVOKER,
  -- pinned search_path) -- create or replace resets anything not respecified.
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
  'TeamMeta/logos exactly as the pre-RPC path does. Revised 2026-08-01: the '
  'cross-league name-resolution prefilters normalize the column side '
  '(normalize_player_name(col) ilike ...), making them accent-insensitive -- '
  'an accented stored name ("Marrée") previously matched nothing because the '
  'search token was unaccented, silently dropping the whole USAU/PUL/WUL side '
  'from profiles opened via a UFA anchor. Backed by expression trgm indexes '
  'on the normalized name columns.';

-- ============================================================================
-- 3. Invalidate the cache
-- ============================================================================
-- Cached rows for accented-name players were built with the missing sides
-- baked in; there is no cheap way to identify just those rows, so truncate
-- (same rationale as 20260729000000 -- pure derived data, defined cache-miss
-- rebuild path, no negative caching).
truncate table public.player_profiles;
