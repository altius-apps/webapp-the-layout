-- Feature Backlog #25 (2026-10-11): cover the foreign keys the performance
-- advisor flags as unindexed (unindexed_foreign_keys). All small tables, so a
-- plain CREATE INDEX is instant. Deliberately skipped: usau_rosters.season
-- (1.1M rows, a handful of distinct values, parent seasons are never deleted —
-- the index would only add write cost to the roster backfill).
create index if not exists euf_game_player_stats_team_id_idx on public.euf_game_player_stats (team_id);
create index if not exists wfdf_game_player_stats_team_id_idx on public.wfdf_game_player_stats (team_id);
create index if not exists wfdf_games_away_team_id_idx on public.wfdf_games (away_team_id);
create index if not exists wfdf_games_home_team_id_idx on public.wfdf_games (home_team_id);
create index if not exists jersey_reports_reported_user_id_idx on public.jersey_reports (reported_user_id);
create index if not exists jersey_reports_listing_id_idx on public.jersey_reports (listing_id);
create index if not exists jersey_reports_reviewed_by_idx on public.jersey_reports (reviewed_by);
create index if not exists jersey_reports_want_id_idx on public.jersey_reports (want_id);
create index if not exists fantasy_draft_nominations_team_id_idx on public.fantasy_draft_nominations (team_id);
create index if not exists fantasy_draft_nominations_high_team_id_idx on public.fantasy_draft_nominations (high_team_id);
create index if not exists fantasy_contests_created_by_idx on public.fantasy_contests (created_by);
create index if not exists fantasy_league_activity_actor_user_id_idx on public.fantasy_league_activity (actor_user_id);
create index if not exists fantasy_league_activity_contest_id_idx on public.fantasy_league_activity (contest_id);
create index if not exists fantasy_league_activity_team_id_idx on public.fantasy_league_activity (team_id);
create index if not exists fantasy_drafts_created_by_idx on public.fantasy_drafts (created_by);
create index if not exists player_content_reports_reporter_id_idx on public.player_content_reports (reporter_id);
create index if not exists player_content_reports_reviewed_by_idx on public.player_content_reports (reviewed_by);
create index if not exists fantasy_league_invites_invited_by_idx on public.fantasy_league_invites (invited_by);
create index if not exists fantasy_matchups_away_team_id_idx on public.fantasy_matchups (away_team_id);
create index if not exists fantasy_matchups_home_team_id_idx on public.fantasy_matchups (home_team_id);
create index if not exists fantasy_matchups_winner_team_id_idx on public.fantasy_matchups (winner_team_id);
create index if not exists pb_roster_players_created_by_idx on public.pb_roster_players (created_by);
create index if not exists pb_roster_players_user_id_idx on public.pb_roster_players (user_id);
create index if not exists fantasy_trades_receiver_team_id_idx on public.fantasy_trades (receiver_team_id);
create index if not exists fantasy_trades_proposer_team_id_idx on public.fantasy_trades (proposer_team_id);
create index if not exists fantasy_trades_created_by_idx on public.fantasy_trades (created_by);
create index if not exists fantasy_trades_decided_by_idx on public.fantasy_trades (decided_by);
create index if not exists utcg_coin_transfers_from_user_idx on public.utcg_coin_transfers (from_user);
create index if not exists utcg_coin_transfers_to_user_idx on public.utcg_coin_transfers (to_user);
create index if not exists utcg_objective_progress_objective_key_idx on public.utcg_objective_progress (objective_key);
create index if not exists fantasy_waiver_claims_team_id_idx on public.fantasy_waiver_claims (team_id);
create index if not exists feedback_reviewed_by_idx on public.feedback (reviewed_by);
create index if not exists pb_lines_created_by_idx on public.pb_lines (created_by);
create index if not exists utcg_season_progress_season_id_idx on public.utcg_season_progress (season_id);
create index if not exists jersey_messages_sender_id_idx on public.jersey_messages (sender_id);
create index if not exists fantasy_league_messages_user_id_idx on public.fantasy_league_messages (user_id);
create index if not exists utcg_sbc_submissions_sbc_key_idx on public.utcg_sbc_submissions (sbc_key);
create index if not exists fantasy_draft_bids_team_id_idx on public.fantasy_draft_bids (team_id);
create index if not exists utcg_flash_claims_challenge_key_idx on public.utcg_flash_claims (challenge_key);
create index if not exists fantasy_draft_queues_team_id_idx on public.fantasy_draft_queues (team_id);
create index if not exists utcg_card_evolutions_evo_key_idx on public.utcg_card_evolutions (evo_key);
