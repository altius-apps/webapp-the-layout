'use client';

// MobileBottomNav — the app's GLOBAL bottom bar (flat, edge-to-edge, surface
// fill with a hairline top border; active tab reads accent orange).
//
// Mobile-parity rewrite (matches altiusapps/mobileapp-thelayout's GlassTabBar):
// a FIXED 5-tab set of top-level destinations — Home · Leagues · Playbook ·
// Fantasy · For You — that NEVER swaps by section. Section switching
// (Scores/Schedule/Teams/Players, a fantasy league's tabs, etc.) is NO
// LONGER here; it moved to the second nav (SectionNav, rendered under the top
// rail — see section-nav.tsx / games-subnav.tsx's SectionNavForRoute).
//
// MOBILE ONLY: this renders on <lg. Desktop gets no bottom bar (the second nav
// under the rail carries page options there). The mount is gated `lg:hidden`.
//
// Tab targets:
//   Home     → "/"            (app landing)
//   Leagues  → "/leagues"     (league directory — home base for the league
//                              family, mirrors the mobile app's Leagues tab)
//   Playbook → "/playbook"
//   Fantasy  → "/fantasy"
//   For You  → "/for-you"

import { usePathname } from 'next/navigation';
import { FloatingTabBar, type FloatingTab } from '@/components/floating-tab-bar';
import { isDraftRoomPath } from '@/lib/fantasy/draft-route';

type TabId = 'home' | 'leagues' | 'playbook' | 'fantasy' | 'foryou';
type IconKind = 'home' | 'leagues' | 'playbook' | 'fantasy' | 'foryou';

interface StaticTab {
  id: TabId;
  label: string;
  href: string;
  icon: IconKind;
}

const TABS: StaticTab[] = [
  { id: 'home',     label: 'Home',     href: '/',         icon: 'home' },
  { id: 'leagues',  label: 'Leagues',  href: '/leagues',  icon: 'leagues' },
  { id: 'playbook', label: 'Playbook', href: '/playbook', icon: 'playbook' },
  { id: 'fantasy',  label: 'Fantasy',  href: '/fantasy',  icon: 'fantasy' },
  { id: 'foryou',   label: 'For You',  href: '/for-you',  icon: 'foryou' },
];

// League-family route prefixes → the Leagues tab lights up under all of them
// (the directory itself + every league's Scores/Schedule/Teams/Players +
// game/team/player detail).
const LEAGUE_PREFIXES = [
  '/leagues', '/scores', '/schedule', '/teams', '/players', '/g',
  '/usau', '/pul', '/wul', '/wfdf', '/euf',
];

function activeTab(pathname: string): TabId | null {
  if (pathname === '/') return 'home';
  if (pathname === '/for-you' || pathname.startsWith('/for-you')) return 'foryou';
  if (pathname === '/playbook' || pathname.startsWith('/playbook')) return 'playbook';
  if (pathname === '/fantasy' || pathname.startsWith('/fantasy')) return 'fantasy';
  if (LEAGUE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return 'leagues';
  return null;
}

export function MobileBottomNav() {
  const pathname = usePathname() ?? '/';
  const active = activeTab(pathname);
  // The draft room runs to the bottom of the screen; its X is the way out.
  if (isDraftRoomPath(pathname)) return null;

  const bars: FloatingTab[] = TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    href: tab.href,
    icon: ({ size }) => <Icon kind={tab.icon} size={size} />,
  }));

  return (
    // Global bottom bar — mobile only. Desktop uses the under-rail SectionNav
    // for page options and has no bottom bar.
    <div className="lg:hidden">
      <FloatingTabBar
        ariaLabel="App navigation"
        activeId={active ?? ''}
        tabs={bars}
        // Caps the tab ROW on wide phones/tablets; the bar itself is
        // edge-to-edge. 5 labels ("Playbook"/"For You") need the extra width.
        maxWidthClass="max-w-lg"
      />
    </div>
  );
}

// Nav icons — inherit color (currentColor) from the FloatingTabBar wrapper,
// which drives active/inactive tones on the dark glass.
function Icon({ kind, size = 22 }: { kind: IconKind; size?: number }) {
  switch (kind) {
    case 'home':
      // House glyph.
      return (
        <svg width={size} height={size} viewBox="0 0 22 22" fill="none" aria-hidden="true">
          <path
            d="M3.5 9.5 11 3.5l7.5 6M5 8.5v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'leagues':
      // Frisbee disc — reads as league/game content generically.
      return (
        <svg width={size} height={size} viewBox="0 0 22 22" fill="none" aria-hidden="true">
          <ellipse cx="11" cy="11" rx="9" ry="9" stroke="currentColor" strokeWidth="1.5" opacity="0.4" />
          <ellipse cx="11" cy="11" rx="9" ry="3.2" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case 'playbook':
      // Board with two dashed routes.
      return (
        <svg width={size} height={size} viewBox="0 0 22 22" fill="none" aria-hidden="true">
          <rect x="2" y="4" width="18" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          <line x1="6" y1="4" x2="6" y2="18" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2" />
          <line x1="16" y1="4" x2="16" y2="18" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2" />
        </svg>
      );
    case 'fantasy':
      // Trophy.
      return (
        <svg width={size} height={size} viewBox="0 0 22 22" fill="none" aria-hidden="true">
          <path d="M6 3h10v5a5 5 0 0 1-10 0V3Z" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 5H3v2a2 2 0 0 0 2 2M16 5h3v2a2 2 0 0 1-2 2" stroke="currentColor" strokeWidth="1.5" />
          <path d="M11 13v3M8 19h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case 'foryou':
      // Sparkle — "For You" personalized feed (distinct from the other glyphs).
      return (
        <svg width={size} height={size} viewBox="0 0 22 22" fill="none" aria-hidden="true">
          <path
            d="M11 2.5l1.9 4.6 4.6 1.9-4.6 1.9L11 15.5 9.1 10.9 4.5 9l4.6-1.9L11 2.5Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path d="M17.5 14.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      );
  }
}
