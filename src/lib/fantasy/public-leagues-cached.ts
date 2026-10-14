// Server-only caches for the public/official league reads. The hub is ISR and
// the leaderboard RPC aggregates the whole field (official leagues reach
// thousands of teams), so neither may run per request (App Health rules 1, 3).

import 'server-only';
import { unstable_cache } from 'next/cache';
import { getContestLeaderboard, getPublicLeagues } from './leagues';

const PUBLIC_LEAGUES_REVALIDATE_SECONDS = 120;
const LEADERBOARD_REVALIDATE_SECONDS = 60;
export const LEADERBOARD_PAGE_SIZE = 100;

export const getPublicLeaguesCached = unstable_cache(() => getPublicLeagues(), ['fantasy-public-leagues'], {
  revalidate: PUBLIC_LEAGUES_REVALIDATE_SECONDS,
  tags: ['fantasy-public-leagues'],
});

export const getContestLeaderboardCached = unstable_cache(
  (contestId: string, offset: number) => getContestLeaderboard(contestId, LEADERBOARD_PAGE_SIZE, offset),
  ['fantasy-contest-leaderboard'],
  { revalidate: LEADERBOARD_REVALIDATE_SECONDS, tags: ['fantasy-contest-leaderboard'] },
);
