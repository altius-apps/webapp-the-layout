-- Feature Backlog #42 (2026-10-11): 598 WFDF games (10 events, 2022–2025)
-- were filed under the wrong division — e.g. "Australia Mixed v Japan Mixed"
-- under Women's. Every division names its pools "Pool A/B/…", and older
-- ingests resolved a game's division from that shared label. Both teams' own
-- division agrees in all 598 (and matches their names), so re-file each game
-- under its teams' division. The 21 games whose two teams disagree are left
-- alone. Old values are kept in a backup table for rollback.
create table if not exists public.wfdf_games_division_backup_20261011 as
select g.id, g.division_id as old_division_id
from public.wfdf_games g
join public.wfdf_teams h on h.id = g.home_team_id
join public.wfdf_teams a on a.id = g.away_team_id
join public.wfdf_divisions hd on hd.id = h.division_id
where h.division_id = a.division_id
  and hd.event_id = g.event_id
  and g.division_id is distinct from h.division_id;

alter table public.wfdf_games_division_backup_20261011 enable row level security;
revoke all on public.wfdf_games_division_backup_20261011 from anon, authenticated;

update public.wfdf_games g
   set division_id = h.division_id, updated_at = now()
  from public.wfdf_teams h, public.wfdf_teams a, public.wfdf_divisions hd
 where h.id = g.home_team_id
   and a.id = g.away_team_id
   and hd.id = h.division_id
   and h.division_id = a.division_id
   and hd.event_id = g.event_id
   and g.division_id is distinct from h.division_id;
