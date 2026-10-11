-- Feature Backlog #31 (2026-10-11), DB hygiene:
-- 1. anon/authenticated held INSERT/UPDATE/DELETE/TRUNCATE on all six per-game
--    stat tables. None has a write policy, so RLS already denied row writes —
--    but TRUNCATE is not subject to RLS. Only the ingest functions (service
--    role / SECURITY DEFINER) write these tables; clients only read.
-- 2. usau_states_for_event_name had a mutable search_path (advisor
--    function_search_path_mutable). It only reads its own VALUES list.
revoke insert, update, delete, truncate on
  public.euf_game_player_stats,
  public.pul_game_player_stats,
  public.ufa_game_player_stats,
  public.usau_player_event_stats,
  public.wfdf_game_player_stats,
  public.wul_game_player_stats
from anon, authenticated;

alter function public.usau_states_for_event_name(text) set search_path = public;
