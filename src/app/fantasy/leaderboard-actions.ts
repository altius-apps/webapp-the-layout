'use server';

// Cached leaderboard pages for the client standings list. The RPC aggregates
// the whole field, so every page goes through the 60 s server cache.

import { getContestLeaderboardCached, LEADERBOARD_PAGE_SIZE } from '@/lib/fantasy/public-leagues-cached';
import type { LeaderboardEntry } from '@/lib/fantasy/leagues';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_OFFSET = 5_000;

export async function fetchLeaderboardPage(contestId: string, page: number): Promise<LeaderboardEntry[]> {
  if (typeof contestId !== 'string' || !UUID_RE.test(contestId) || !Number.isInteger(page) || page < 0) return [];
  const offset = page * LEADERBOARD_PAGE_SIZE;
  if (offset > MAX_OFFSET) return [];
  return getContestLeaderboardCached(contestId, offset);
}
