// /fantasy/l/[contestId]/league — the 4th tab, h2h weekly contests only
// (LeagueSectionNav doesn't render this tab for anything else). A contest
// that isn't h2h weekly lands the League tab body at the contest root
// instead — redirect there so a stale/typed-in link doesn't dead-end.

import { redirect } from 'next/navigation';
import { getContest } from '@/lib/fantasy/leagues';
import { getLeagueCached } from '@/lib/fantasy/league-cached';
import { contestFormat } from '@/lib/fantasy/competitions';
import { LeagueView } from '@/components/fantasy/league-view';

export const revalidate = 60;

export default async function ContestLeaguePage({ params }: { params: { contestId: string } }) {
  const contest = await getContest(params.contestId).catch(() => null);
  if (!contest) return null;

  const isH2HWeekly = contest.settings.mode === 'weekly-stats' && contestFormat(contest.settings) === 'h2h';
  if (!isH2HWeekly) redirect(`/fantasy/l/${contest.id}`);

  const league = await getLeagueCached(contest.leagueId).catch(() => null);
  return <LeagueView contest={contest} league={league} />;
}
