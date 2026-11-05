-- get_player_profile: expose the USAU identity cluster as usauClusterIds.
--
-- BUG (2026-08-01, "Hunter May's gallery is missing content"): user content is
-- keyed by (player_kind, player_ref), and the profile fetches it for every
-- contentRef the client can name. But the payload only ever named ONE usau id
-- (v_usau_id = whatever the caller anchored on, or the name-resolution pick),
-- while the scraper routinely mints multiple usau_players ids for the same
-- human — Hunter May has NINE, including three separate ids for the same
-- Johnny Bravo 2025 squad (one per event registration). The profile MERGES all
-- their careers via the namesake conflict-graph cluster, so the page looks
-- right — but content uploaded under cluster id X is invisible when the
-- profile was reached via cluster id Y. Which id a roster tap hands you is an
-- accident of dedupe order, so the same person's gallery differed by
-- navigation path (and between web and mobile).
--
-- FIX: emit the cluster's ids (the usau_cluster CTE the payload already
-- computes for career merging) as a top-level usauClusterIds array. Clients
-- push each as an ('usau', id) content ref, making the gallery
-- entry-point-independent. Empty array when the profile has no USAU side.
--
-- Prosrc string-patch, same rationale as 20260729000000 / 20260801100000 (the
-- deployed body carries remote-only revisions). Idempotent + assert-guarded.
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

  if strpos(v_orig, '''usauClusterIds''') > 0 then
    raise notice '_build_player_profile already emits usauClusterIds; skipping';
    return;
  end if;

  -- The usau_cluster CTE already exists (it drives career merging). With a
  -- null v_usau_id the recursive seed row is NULL, so filter it out — the
  -- coalesce then yields [] rather than [null].
  v_body := replace(v_orig,
    '''usauId'', v_usau_id,',
    '''usauId'', v_usau_id,' || E'\n' ||
    '    ''usauClusterIds'', coalesce((select jsonb_agg(id) filter (where id is not null) from usau_cluster), ''[]''::jsonb),');

  if strpos(v_body, '''usauClusterIds''') = 0 then
    raise exception
      'patch did not apply cleanly -- the ''usauId'' anchor no longer matches '
      'the deployed _build_player_profile body; re-derive against current prosrc';
  end if;

  execute format(
    'create or replace function public._build_player_profile(p_anchor_id text) '
    'returns jsonb language plpgsql security invoker set search_path to ''public'' as %L',
    v_body
  );
end
$outer$;

-- Cached rows were built without the key; the mapper tolerates its absence,
-- but the whole point is making existing profiles complete now — rebuild.
truncate table public.player_profiles;
