-- find_usau_player_by_name: server-side name -> usau_players.id resolution.
--
-- Replaces the client-side findUsauPlayerByName() fallback (mobile + web
-- src/lib/usau/data.ts), which had the same accent bug just fixed inside
-- _build_player_profile by 20260801100000: it ILIKE'd the RAW display_name
-- column with an UNACCENTED surname token, so "Marrée" never matched
-- '%marree%' and the lookup returned null for every accented name. PostgREST
-- filters can't target the normalize_player_name() expression index, so the
-- accent-insensitive predicate has to live in an RPC.
--
-- Semantics mirror the client version exactly:
--   1. Prefilter by surname containment -- normalize_player_name() on BOTH
--      sides, served by usau_players_display_name_norm_trgm (20260801100000).
--   2. Strict names_match() token-subset filter.
--   3. Multiple candidates: the most-rostered (most active) id wins, matching
--      the client's roster-count sort; ties broken by id for determinism
--      (client tie order was whatever PostgREST returned).
-- Returns null for no match, unparseable names, and null input (normalize
-- yields null -> the ILIKE predicate is null -> zero rows).
--
-- STABLE (reads tables, no writes), SECURITY INVOKER -- usau_players and
-- usau_rosters both grant public SELECT. Pinned search_path per house
-- convention.
create or replace function public.find_usau_player_by_name(p_name text)
returns uuid
language sql
stable
set search_path to 'public'
as $$
  select p.id
  from public.usau_players p
  where public.normalize_player_name(p.display_name) ilike
        '%' || split_part(public.normalize_player_name(p_name), ' ',
              array_length(regexp_split_to_array(public.normalize_player_name(p_name), '\s+'), 1)) || '%'
    and public.names_match(p_name, p.display_name)
  order by (select count(*) from public.usau_rosters r where r.player_id = p.id) desc, p.id
  limit 1;
$$;

comment on function public.find_usau_player_by_name(text) is
  'Resolves a display name to the most-active matching usau_players.id using '
  'the accent-insensitive normalized-name prefilter plus the strict '
  'names_match token-subset rule; null when nothing matches. Server-side '
  'replacement for the client findUsauPlayerByName() fallback, whose raw-'
  'column ILIKE could never match accented stored names ("Marrée" vs '
  '%marree%). Candidates ranked by roster count desc (ties by id). Relies on '
  'usau_players_display_name_norm_trgm from 20260801100000.';

revoke all on function public.find_usau_player_by_name(text) from public;
grant execute on function public.find_usau_player_by_name(text) to anon, authenticated;
