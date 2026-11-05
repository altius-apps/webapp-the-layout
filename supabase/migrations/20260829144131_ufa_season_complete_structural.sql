-- UFA champion chips: stop gating "season complete" on EVERY game being Final.
--
-- BUG (2026-08-29): no 2026 UFA player showed the "UFA Champion 2026" chip on
-- their profile, even though the title game (2026-08-28-MIN-OAK, spiders def.
-- windchill 21-16) had been played and ingested.
--
-- CAUSE: _build_player_profile gates ufa_champion_by_year behind
--
--     ufa_season_complete: bool_and(status in ('Final','Completed'))
--
-- i.e. EVERY row of that year in ufa_games must be terminal. 2026 had exactly
-- one row that never went terminal: 2026-07-17-IND-PIT, week-13, status
-- 'Upcoming', scores null. That game does not exist upstream at all -- UFA
-- rescheduled it to 2026-07-19-IND-PIT (Final 29-25, same two teams, same
-- week) and DELETED the original row. UFA's feed has no "Cancelled" status;
-- their 2026 season is 144 games, all 'Final'. sync-ufa is upsert-only, so the
-- superseded row is never removed and stays 'Upcoming' forever.
--
-- One orphaned row therefore suppressed the champion chip for every player on
-- the championship roster. That is far too brittle: reschedules and
-- cancellations are normal, and the gate should not depend on the absence of
-- upstream churn.
--
-- FIX: make the gate STRUCTURAL. A season is "complete" when its championship
-- game has actually been decided -- which is precisely the thing
-- ufa_championship_game already computes. Stragglers (never-played,
-- superseded, or mis-ingested rows) can no longer suppress a real title.
--
-- ufa_championship_game selects `distinct on (year)` from ufa_finals_ranked,
-- which is built exclusively from ufa_decided_finals (status = 'Final' AND
-- home_score <> away_score AND not the all-star exhibition). So its mere
-- existence for a year IS the completeness signal, and the separate
-- ufa_season_complete join becomes redundant.
--
-- This DELIBERATELY makes a champion appear as soon as the title game is
-- decided rather than waiting for the last regular-season straggler to settle.
-- For a season still in progress no championship game resolves (the bracket
-- hasn't been played), so no champion is emitted -- the pre-existing behaviour
-- for in-flight seasons is preserved.
--
-- NOTE the orphan rows themselves are a separate defect, fixed independently by
-- adding prune-on-sync to the sync-ufa Edge Function. This migration only makes
-- the gate resilient to them.
--
-- Prosrc string-patch, same convention as 20260729000000 / 20260801100000 /
-- 20260801120000 (the deployed body carries remote-only revisions, so it is
-- patched in place rather than re-stated). Idempotent + assert-guarded.
--
-- IMPORTANT: the earlier string-patch migrations re-created this function with
-- `security invoker`, but the deployed function is SECURITY DEFINER with
-- search_path=public. Recreating it as invoker would silently downgrade it and
-- break profile reads. This migration preserves the deployed attributes
-- (definer + pinned search_path) rather than copying that template verbatim.
do $outer$
declare
  v_orig text;
  v_body text;
  v_anchor constant text :=
    '  ufa_season_complete as (' || E'\n' ||
    '    select year, bool_and(status in (''Final'', ''Completed'')) as complete' || E'\n' ||
    '    from ufa_season_games' || E'\n' ||
    '    group by year' || E'\n' ||
    '  ),';
  v_join constant text :=
    '    join ufa_season_complete sc on sc.year = cg.year and sc.complete';
begin
  select prosrc into v_orig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = '_build_player_profile';

  if v_orig is null then
    raise exception '_build_player_profile not found -- apply 20260727000000_player_profile_rpc.sql first';
  end if;

  -- Already structural (the join is gone) -> nothing to do.
  if strpos(v_orig, v_join) = 0 then
    raise notice '_build_player_profile already uses the structural season gate; skipping';
    return;
  end if;

  if strpos(v_orig, v_anchor) = 0 then
    raise exception
      'patch did not apply cleanly -- the ufa_season_complete CTE no longer '
      'matches the deployed _build_player_profile body; re-derive against current prosrc';
  end if;

  -- 1. Drop the now-unused CTE definition.
  v_body := replace(v_orig, v_anchor || E'\n', '');

  -- 2. Drop the join that gated champions on it. ufa_championship_game is
  --    itself derived only from decided finals, so its existence for a year is
  --    the completeness signal.
  v_body := replace(v_body, E'\n' || v_join, '');

  if strpos(v_body, 'ufa_season_complete') > 0 then
    raise exception
      'patch left a dangling ufa_season_complete reference -- aborting rather '
      'than deploying a body that will fail to parse';
  end if;

  execute format(
    'create or replace function public._build_player_profile(p_anchor_id text) '
    'returns jsonb language plpgsql security definer set search_path to ''public'' as %L',
    v_body
  );
end
$outer$;

-- Cached profiles were built under the old gate (2026 champions suppressed).
-- Rebuild so the chips appear immediately rather than after the 24h TTL.
truncate table public.player_profiles;
