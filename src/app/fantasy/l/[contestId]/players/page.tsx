// /fantasy/l/[contestId]/players — the Players tab. Chrome from the parent
// layout; body is PlayersPanel (search, filter, add/drop).

import { getContest } from '@/lib/fantasy/leagues';
import { getLeagueCached } from '@/lib/fantasy/league-cached';
import { PlayersPanel } from '@/components/fantasy/players-panel';

export const revalidate = 60;

export default async function ContestPlayersPage({ params }: { params: { contestId: string } }) {
  const contest = await getContest(params.contestId).catch(() => null);
  if (!contest) return null;

  const league = await getLeagueCached(contest.leagueId).catch(() => null);
  return <PlayersPanel contest={contest} isOfficial={league?.isOfficial ?? false} />;
}
