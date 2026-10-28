-- USAU per-event Ds + turns (Hunter, 2026-10-28).
--
-- USAU's event-team roster table publishes Points (= goals), Assists, Ds and
-- Turns per player. We only stored goals/assists, read from leaderboard tables
-- USAU has since removed (nothing written after 2026-10-05, so 2026 Club
-- Nationals had no stats). sync-event-rosters now reads all four from the
-- roster table; this adds the two new columns and carries them into profiles.
--
-- Null = not scraped (rows written before today); profiles show "—", not 0.

alter table public.usau_player_event_stats
  add column ds integer,
  add column turns integer;

-- prosrc patch, NOT create-or-replace from committed text: _build_player_profile
-- is shared with the mobile repo and has remote-only migrations (per CLAUDE.md).
-- Guarded on the exact live body + attributes (VOLATILE since a remote-only
-- change; the 20260824 template's STABLE would silently reset it).
DO $migration$
DECLARE
  v_src text;
  v_ok  boolean;
  c_stats_old constant text :=
    'select s.event_id, sum(coalesce(s.goals,0)) as goals, sum(coalesce(s.assists,0)) as assists';
  c_stats_new constant text :=
    'select s.event_id, sum(coalesce(s.goals,0)) as goals, sum(coalesce(s.assists,0)) as assists,
           sum(s.ds) as ds, sum(s.turns) as turns';
  c_json_old constant text :=
E'''goals'', se.goals,\n        ''assists'', se.assists,';
  c_json_new constant text :=
E'''goals'', se.goals,\n        ''assists'', se.assists,\n        ''ds'', se.ds,\n        ''turns'', se.turns,';
BEGIN
  SELECT p.prosrc,
         l.lanname = 'plpgsql' AND p.provolatile = 'v' AND p.prosecdef
           AND p.proconfig = array['search_path=public']
    INTO v_src, v_ok
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
   WHERE p.oid = 'public._build_player_profile(text)'::regprocedure;
  IF position('sum(s.ds) as ds' in v_src) > 0 THEN
    RAISE NOTICE 'already patched; skipping'; RETURN;
  END IF;
  IF md5(v_src) <> '88b4ba8dc8f6d337481a52ca0cead356' OR NOT v_ok THEN
    RAISE EXCEPTION '_build_player_profile changed since 2026-10-28 (md5/attributes): re-read it before patching';
  END IF;

  v_src := replace(replace(v_src, c_stats_old, c_stats_new), c_json_old, c_json_new);

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public._build_player_profile(p_anchor_id text) '
    'RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS %L',
    v_src);
END
$migration$;

-- No mass profile invalidation: the stale_profile_on_usau_stats_* triggers
-- flag each profile whose stats row the re-scrape writes.

notify pgrst, 'reload schema';
