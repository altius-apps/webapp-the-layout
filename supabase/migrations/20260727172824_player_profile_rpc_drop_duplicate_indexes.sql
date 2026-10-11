-- Exported from the remote migration ledger on 2026-10-11 (Feature Backlog #37): applied to prod but never committed to this repo.
-- Cleanup: get_advisors (performance) flagged 3 duplicate indexes introduced
-- by the player_profile_rpc migration -- each of my new indexes duplicates
-- one that already existed under a different name from an earlier migration.
-- Drop the ones THIS migration added; keep the pre-existing originals.
drop index if exists public.idx_ufa_game_player_stats_player_id; -- duplicate of ufa_gps_player_idx
drop index if exists public.idx_ufa_players_full_name_lower;     -- duplicate of ufa_players_full_name_idx
drop index if exists public.idx_usau_rosters_player_id;          -- duplicate of usau_rosters_player_idx;
