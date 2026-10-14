// /fantasy/l/[contestId]/* — canonical in-league layout (Sleeper model,
// 2026-09-07 IA). Server Component: resolves the contest (+ league, when
// private) and renders the shared league chrome — back link, league logo,
// name, commissioner gear, and the in-league sub-tabs (Match/League · Team ·
// Players · League) — around whatever page the route renders as `children`.
//
// Web port of the mobile app's LeagueShell.tsx
// (altiusapps/mobileapp-thelayout · src/components/fantasy/LeagueShell.tsx).
// Every screen inside a league (root, team, players, league, draft,
// settings, t/[teamId]) shares this one shell instead of each page
// re-fetching the contest and re-rendering the header. The one exception is the
// draft room (/draft), a full-screen surface that covers the header and nav, so
// LeagueChrome leaves them out there.

import { AppShell } from '@/components/page-shell';
import { getContest } from '@/lib/fantasy/leagues';
import { getLeagueCached } from '@/lib/fantasy/league-cached';
import { LeagueHeader } from '@/components/fantasy/league-header';
import { LeagueSectionNav } from '@/components/fantasy/league-section-nav';
import { LeagueChrome } from '@/components/fantasy/league-chrome';
import { EnsureContestTeam } from '@/components/fantasy/ensure-contest-team';
import { LeagueContentFrame } from '@/components/fantasy/league-content-frame';
import { FantasySignInGate } from '@/components/fantasy/fantasy-sign-in-gate';
import { getServerUserId } from '@/lib/fantasy/server';

export default async function LeagueLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { contestId: string };
}) {
  // Leagues are signed-in only (RLS backs this up).
  const userId = await getServerUserId().catch(() => null);
  if (!userId) return <FantasySignInGate />;

  const contest = await getContest(params.contestId).catch(() => null);

  if (!contest) {
    return (
      <AppShell hideFooterMobile>
        <div className="px-5 pt-4 pb-12 lg:pt-8 lg:pb-14 lg:mx-auto lg:px-14 lg:max-w-[1080px]">
          <div className="bg-surface rounded-card-lg shadow-card p-10 text-center">
            <p className="text-muted font-tight text-[14px]">
              This league doesn&apos;t exist, or you don&apos;t have access to it.
            </p>
          </div>
        </div>
      </AppShell>
    );
  }

  const league = await getLeagueCached(contest.leagueId).catch(() => null);

  return (
    <AppShell hideFooterMobile>
      <LeagueChrome>
        <div className="px-5 lg:mx-auto lg:px-14 lg:max-w-[1080px]">
          <LeagueHeader contest={contest} league={league} />
        </div>
        <LeagueSectionNav contest={contest} />
      </LeagueChrome>
      <LeagueContentFrame>
        <EnsureContestTeam contestId={contest.id} leagueId={contest.leagueId} seasonYear={contest.seasonYear}>
          {children}
        </EnsureContestTeam>
      </LeagueContentFrame>
    </AppShell>
  );
}
