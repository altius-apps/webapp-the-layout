'use client';

// LeagueSectionNav — the in-league contest sub-tabs (Match/League · Team ·
// Players · Chat · League), rendered via the shared SectionNav (route mode). Web
// port of the mobile app's contestSubTabs (altiusapps/mobileapp-thelayout ·
// src/components/nav/league-sub-tabs.ts):
//   weekly + h2h format → Match · Team · Players · Chat · League
//   everything else     → League · Team · Players · Chat
// Chat is a tab on web only. The mobile app docks it at the bottom of the
// screen instead (Hunter, 2026-10-14: deliberate difference).

import { usePathname } from 'next/navigation';
import { SectionNav, type SectionRouteTab } from '@/components/section-nav';
import { contestFormat } from '@/lib/fantasy/competitions';
import type { ContestView } from '@/lib/fantasy/leagues';

export function LeagueSectionNav({ contest }: { contest: ContestView }) {
  const pathname = usePathname() ?? '';
  const base = `/fantasy/l/${contest.id}`;
  const isH2HWeekly = contest.settings.mode === 'weekly-stats' && contestFormat(contest.settings) === 'h2h';

  const tabs: SectionRouteTab[] = [];
  tabs.push({
    label: isH2HWeekly ? 'Match' : 'League',
    href: base,
    active: pathname === base,
  });
  tabs.push({
    label: 'Team',
    href: `${base}/team`,
    active: pathname.startsWith(`${base}/team`),
  });
  tabs.push({
    label: 'Players',
    href: `${base}/players`,
    active: pathname.startsWith(`${base}/players`),
  });
  tabs.push({
    label: 'Chat',
    href: `${base}/feed`,
    active: pathname.startsWith(`${base}/feed`),
  });
  if (isH2HWeekly) {
    tabs.push({
      label: 'League',
      href: `${base}/league`,
      active: pathname.startsWith(`${base}/league`),
    });
  }

  return <SectionNav tabs={tabs} ariaLabel="League sections" />;
}

export default LeagueSectionNav;
