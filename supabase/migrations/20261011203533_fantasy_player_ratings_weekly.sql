-- Fantasy player ratings: hourly → weekly (Hunter, 2026-10-11). The rating
-- formula is being reworked; rebuilds run by hand until it's final
-- (select public.fantasy_refresh_player_ratings(); or
--  select public.fantasy_rebuild_player_ratings('<usau_events.id>');).
-- Mondays 10:44 UTC: after the 09:10 roster sync and the 09:20 prestige
-- refresh, clear of the Monday 05:00–07:25 USAU jobs.
select cron.unschedule('fantasy-player-ratings-hourly');

select cron.schedule(
  'fantasy-player-ratings-weekly',
  '44 10 * * 1',
  $$select public.fantasy_refresh_player_ratings()$$
);
