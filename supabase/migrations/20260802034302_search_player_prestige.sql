-- search_usau_players_fuzzy v2: prestige-aware ranking + trigram-indexed scan.
--
-- FEATURE (Hunter, 2026-08-01): player search should surface accomplished
-- players first among equal name matches — "quinn" puts Quinn Finer (UFA +
-- national-champion club team) above other Quinns. Signals, additive:
--
--     +40  has a UFA career (exact lower(full_name) match — indexed)
--     +30  rostered on a team that played USAU CLUB Nationals (any season)
--     +30  rostered on a Nationals CHAMPION team (final_placement = 1)
--
-- so UFA-only (40) still outranks plain players, a Nationals participant (30)
-- ranks without any UFA requirement, and a champion + UFA (100) tops the pile.
-- prestige is a TIEBREAK inside name_search_rank's coarse buckets (4.0 name
-- prefix / 3.0 word prefix / 1.0 substring), so relevance still dominates:
-- an exact-prefix nobody beats a substring-match legend.
--
-- The candidate set is overshot 3x before the prestige re-rank so a
-- prestigious player buried past the raw limit can still promote into the cut.
-- Prestige is computed ONLY for those <=150 candidates via hashed/indexed
-- subplans (~480-row nationals team set, pkey-only roster probes, hashed
-- lower(full_name) set).
--
-- PERF: the old body's `word_similarity(q, display_name) >= 0.5` is a function
-- call — unindexable, so every search seq-scanned all 203k usau_players
-- (measured 845ms). The operator form `q <% display_name` hits the existing
-- display_name trgm GIN index with IDENTICAL semantics (threshold pinned to
-- 0.5 via the function-level SET, matching the old explicit constant):
-- measured 20ms for the same 532 candidate rows. Prestige adds ~10ms on top.
--
-- RETURNS TABLE gains a `prestige` column -> drop + recreate (create-or-
-- replace can't change the out-row shape). Additive for existing callers:
-- web/mobile read rows by field name and ignore extras; row ORDER improves
-- for both immediately.
drop function if exists public.search_usau_players_fuzzy(text, integer);

-- plpgsql + runtime set_config rather than a function-level SET clause:
-- Supabase denies `SET pg_trgm.word_similarity_threshold` in CREATE FUNCTION
-- (restricted placeholder GUC), but the parameter is USERSET at runtime.
-- is_local=true scopes it to the wrapping transaction (one PostgREST request).
create function public.search_usau_players_fuzzy(q text, lim integer default 24)
returns table(id uuid, display_name text, score real, prestige integer)
language plpgsql
stable
set search_path to 'public', 'extensions'
as $$
begin
  perform set_config('pg_trgm.word_similarity_threshold', '0.5', true);
  return query
  with candidates as (
    -- ORDER BY is positional (3 = the rank expression): inside plpgsql the
    -- OUT parameters (score/prestige) shadow bare output-column aliases, so
    -- `order by score` would read the null variable, not the column.
    select p.id, p.display_name, public.name_search_rank(q, p.display_name) as score
    from public.usau_players p
    where p.display_name ilike '%' || q || '%' or q <% p.display_name
    order by 3 desc, length(p.display_name), p.display_name
    limit least(coalesce(lim, 24), 50) * 3
  ),
  nats_teams as (
    -- Every team-entry at a USAU CLUB Nationals (same event filter as
    -- _build_player_profile's usau_club_nationals_events CTE): ~480 rows.
    select et.team_id, et.final_placement
    from public.usau_event_teams et
    join public.usau_events e on e.id = et.event_id
    where e.competition_level = 'CLUB'
      and (e.usau_slug ilike '%national-championships%'
        or e.usau_slug ilike '%club-nationals%'
        or e.usau_slug ilike '%usa-ultimate-club-championships%')
      and e.usau_slug not ilike '%us-open%'
  )
  select c.id, c.display_name, c.score,
    (case when exists (
        select 1 from public.ufa_players u where lower(u.full_name) = lower(c.display_name)
      ) then 40 else 0 end)
    + (case when exists (
        select 1 from public.usau_rosters r
        join nats_teams nt on nt.team_id = r.team_id
        where r.player_id = c.id
      ) then 30 else 0 end)
    + (case when exists (
        select 1 from public.usau_rosters r
        join nats_teams nt on nt.team_id = r.team_id and nt.final_placement = 1
        where r.player_id = c.id
      ) then 30 else 0 end)
    as prestige
  from candidates c
  order by c.score desc, 4 desc, length(c.display_name), c.display_name
  limit least(coalesce(lim, 24), 50);
end;
$$;

comment on function public.search_usau_players_fuzzy(text, integer) is
  'Fuzzy player-name search over usau_players, ranked by name_search_rank with '
  'a prestige tiebreak (+40 UFA career by exact name, +30 rostered at Club '
  'Nationals, +30 rostered on a Nationals champion). Candidates come from the '
  'display_name trgm index (ilike OR <% at threshold 0.5 — the operator form '
  'of the old word_similarity()>=0.5, which seq-scanned); prestige is computed '
  'only for the 3x-overshot candidate set. Order: score desc, prestige desc, '
  'shortest name. Consumed by mobile + web search; the namesake id with the '
  'Nationals roster outranks its scraper-duplicate siblings, so the client''s '
  'first-occurrence name dedupe also keeps the best anchor id.';

revoke all on function public.search_usau_players_fuzzy(text, integer) from public;
grant execute on function public.search_usau_players_fuzzy(text, integer) to anon, authenticated;
