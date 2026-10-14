// /fantasy/leagues/[id] — legacy league-home URL. The league's real home is
// now its newest contest at /fantasy/l/[contestId] (canonical in-league
// route tree); this is a thin redirect so old links/bookmarks still resolve.

import { redirect } from 'next/navigation';
import { getLeagueContests } from '@/lib/fantasy/leagues';
import { getServerUserId } from '@/lib/fantasy/server';
import { FantasySignInGate } from '@/components/fantasy/fantasy-sign-in-gate';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

export default async function LeagueHomeRedirect({ params }: { params: { id: string } }) {
  if (!(await getServerUserId().catch(() => null))) return <FantasySignInGate />;
  const contests = await getLeagueContests(params.id).catch(() => []);
  redirect(contests[0] ? `/fantasy/l/${contests[0].id}` : '/fantasy');
}
