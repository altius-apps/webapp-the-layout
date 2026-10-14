// /fantasy/l/[contestId] — contest root. "Match" tab for h2h weekly contests
// (MatchupView), "League" tab body otherwise (LeagueView). Chrome (header +
// sub-tabs) comes entirely from the parent layout, which already renders the
// not-found card when the contest doesn't resolve — this page renders
// nothing extra in that case since the layout won't render `children` then.

import { getContest } from '@/lib/fantasy/leagues';
import { getLeagueCached } from '@/lib/fantasy/league-cached';
import { contestFormat } from '@/lib/fantasy/competitions';
import { LeagueView } from '@/components/fantasy/league-view';
import { MatchupView } from '@/components/fantasy/matchup-view';

export const revalidate = 60;

export default async function ContestRootPage({ params }: { params: { contestId: string } }) {
  const contest = await getContest(params.contestId).catch(() => null);
  if (!contest) return null;

  const league = await getLeagueCached(contest.leagueId).catch(() => null);

  const isH2HWeekly = contest.settings.mode === 'weekly-stats' && contestFormat(contest.settings) === 'h2h';

  return isH2HWeekly ? <MatchupView contest={contest} /> : <LeagueView contest={contest} league={league} />;
}
