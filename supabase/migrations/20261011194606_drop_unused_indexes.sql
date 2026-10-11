-- Backlog #25. Zero scans since the 2026-08-12 stats reset (~60 days, covering
-- USAU club series + the roster LaunchAgent, EUCF, WFDF reads), and no query in
-- web/mobile/edge functions/pg_proc filters or sorts on the indexed expression
-- in a way the planner can use:
--  - usau_event_teams url_id (partial IS NOT NULL) / event_team_id: every
--    lookup also filters event_id, which the PK leads with; resolver queries
--    want url_id IS NULL, which the partial index can't serve.
--  - euf/wfdf name btrees: reads use ilike (trigram) or name keys instead.
--  - euf_rosters_name_last_norm_trgm: the only reader ORs it with a reversed
--    ilike, so the planner can't use it.
--  - usau_event_templates_key_idx duplicates the unique usau_event_templates_key_key.
-- Kept on purpose: unique/PK/FK-covering indexes, and indexes on 0-5 row
-- feature tables (jersey_*, player_content*, invite_sends, utcg pvp) where
-- zero scans says nothing. Recreate statements: vault Security & Efficiency Backlog.
set local lock_timeout = '5s';

drop index if exists public.usau_event_teams_url_id_idx;
drop index if exists public.usau_event_teams_event_team_id_idx;
drop index if exists public.idx_euf_gps_name;
drop index if exists public.euf_rosters_name_last_norm_trgm;
drop index if exists public.idx_wfdf_rosters_last_name;
drop index if exists public.idx_wfdf_rosters_lastname;
drop index if exists public.idx_euf_rosters_name;
drop index if exists public.idx_euf_rosters_compact_name;
drop index if exists public.idx_wfdf_teams_name;
drop index if exists public.idx_euf_teams_name;
drop index if exists public.usau_event_templates_key_idx;
