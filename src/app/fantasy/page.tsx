// /fantasy — Fantasy hub. Server Component, public + ISR. Sleeper-style
// front door: My Leagues → Start a League, with a "Join league" button in the
// header (signed in, every width). Creating starts only from a Start a League
// row's Create pill (Hunter, 2026-10-07). Replaces the old "pick a game" card
// grid — game selection now happens inside league creation (Start a League /
// create-league form), not as the hub's primary landing.
// Port of the mobile app's fantasy hub (altiusapps/mobileapp-thelayout ·
// app/(app)/fantasy/index.tsx). See vault: Features/Fantasy V2 — Game Hub.

import { PageShell } from '@/components/page-shell';
import { PlayMenu } from '@/components/fantasy/play-menu';
import { MyLeaguesList } from '@/components/fantasy/my-leagues-list';
import { PublicLeaguesList } from '@/components/fantasy/public-leagues-list';
import { StartALeagueList } from '@/components/fantasy/start-a-league-list';
import { hubGames } from '@/lib/fantasy/games';
import { sortGamesBySoonest } from '@/lib/fantasy/game-dates';
import { getGameStartDatesCached } from '@/lib/fantasy/game-dates-cached';

export const revalidate = 60;

export default async function FantasyHubPage() {
  const starts = await getGameStartDatesCached();
  const orderedGames = sortGamesBySoonest(hubGames(), starts);

  return (
    <PageShell title="Fantasy Ultimate" titleSize="compact" controls={<PlayMenu />} hideFooterMobile>
      <MyLeaguesList />
      <PublicLeaguesList />
      <StartALeagueList games={orderedGames} starts={starts} />
    </PageShell>
  );
}
