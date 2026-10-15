// /fantasy/l/[contestId]/feed — the Chat tab: league activity + chat (Hunter,
// 2026-10-14: a tab on web; the mobile app docks chat at the bottom instead).
// Chrome comes entirely from the parent layout; this page renders only the
// feed body.

import { notFound } from 'next/navigation';
import { getContest } from '@/lib/fantasy/leagues';
import { getLeagueCached } from '@/lib/fantasy/league-cached';
import { LeagueFeed } from '@/components/fantasy/league-feed';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

export default async function ContestFeedPage({ params }: { params: { contestId: string } }) {
  const contest = await getContest(params.contestId).catch(() => null);
  if (!contest) notFound();

  const league = await getLeagueCached(contest.leagueId).catch(() => null);
  return <LeagueFeed contest={contest} isOfficial={league?.isOfficial ?? false} />;
}
