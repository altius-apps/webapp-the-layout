-- Fantasy league data is signed-in only (Hunter, 2026-10-14; aligned with the
-- mobile session). Signed-out users see a sign-in prompt on both apps; this
-- stops the DB serving league/member data to the anon key.
--
-- Applied 2026-10-14 after the web build that reads league data with the user's
-- session (src/lib/fantasy/reader.ts) is deployed. The previous web build read
-- with the anon client and would break for everyone. fantasy_roster_slots is
-- locked too (Hunter: "no one is really using" the shipped mobile build, and a
-- new build is going out the same day); the old build's Team tab opens empty
-- for signed-in users until they update.
--

-- 1. League data: the "<table> public read" policies move from anon +
--    authenticated to authenticated only (USING true is unchanged).
do $p$
declare
  t text;
begin
  foreach t in array array[
    'fantasy_leagues', 'fantasy_league_members', 'fantasy_contests', 'fantasy_contest_periods',
    'fantasy_teams', 'fantasy_team_players', 'fantasy_scores', 'fantasy_matchups',
    'fantasy_drafts', 'fantasy_draft_picks', 'fantasy_draft_nominations', 'fantasy_draft_bids',
    'fantasy_draft_prices', 'fantasy_transactions', 'fantasy_waiver_players'
  ] loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t and policyname = t || ' public read'
    ) then
      raise exception 'policy "% public read" not found', t;
    end if;
    execute format('alter policy %I on public.%I to authenticated', t || ' public read', t);
  end loop;
end
$p$;

alter policy "fantasy_slots public read" on public.fantasy_roster_slots to authenticated;

-- STAYS anon: fantasy_player_ratings (player data, not league data).

-- 2. League-data RPCs: signed-in only.
revoke execute on function public.fantasy_public_leagues(integer) from public, anon;
revoke execute on function public.fantasy_contest_leaderboard(uuid, integer, integer) from public, anon;
revoke execute on function public.fantasy_contest_team_rank(uuid) from public, anon;
revoke execute on function public.fantasy_contest_roster_pct(uuid, text) from public, anon;
revoke execute on function public.fantasy_h2h_standings(uuid) from public, anon;
grant execute on function public.fantasy_public_leagues(integer) to authenticated;
grant execute on function public.fantasy_contest_leaderboard(uuid, integer, integer) to authenticated;
grant execute on function public.fantasy_contest_team_rank(uuid) to authenticated;
grant execute on function public.fantasy_contest_roster_pct(uuid, text) to authenticated;
grant execute on function public.fantasy_h2h_standings(uuid) to authenticated;

-- STAYS anon: fantasy_preview_league_invite (invite landing), fantasy_handle_available
-- (sign-up), fantasy_player_projections (player stats).

notify pgrst, 'reload schema';
