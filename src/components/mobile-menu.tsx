'use client';

// Right-side slide-in navigation panel — shared by mobile AND desktop. The
// hamburger (right of the account chip) opens it; it slides in from the right
// edge. Rendered via createPortal to document.body so it escapes the sticky
// rail's stacking context (backdrop-blur on the rail creates a new compositing
// layer that would trap any z-index set on a descendant).
//
// Three-layer accordion structure:
//   Layer 1 — sub-apps: The League (expandable) · PLAYBOOK · FANTASY · 12-0
//   Layer 2 — leagues: UFA · USAU · WUL · PUL · WFDF (expandable / direct)
//   Layer 3 — sub-pages: Scores · Schedule · Teams · Players (links with ?league=qs)
// Plus a persistent account footer (sign in/out, settings).
//
// Accordion default-open state: opens to the branch that matches the current URL
// so a user in USAU Teams sees The League→USAU expanded with Teams highlighted.
//
// Layer 2 → Layer 3 presentation differs by breakpoint:
//   MOBILE (<md): tapping a league row expands an INLINE sub-dropdown directly
//     beneath that row — tab links only, no team grids. See the
//     `isOpen && <div className="md:hidden">` block inside the league .map()
//     below.
//   DESKTOP (md+): tapping/hovering a league row opens the side-by-side
//     LeagueFlyout panel (header + tab links + team grid), rendered in a
//     `hidden md:flex` container after the main nav list.
// Both breakpoints share the same `flyoutLeague` state and the
// `LeagueFlyoutBody` tab-links component so that markup isn't duplicated.
//
// USAU is the one exception on BOTH breakpoints: instead of a single shared
// tab-link row, it renders `UsauLevelAccordion` — each competition level
// (Club/College D-I/College D-III/Masters/Grand Masters) is its own
// expandable row. Desktop additionally passes a `renderExtra` prop so CLUB
// and COLLEGE_D1 (the two levels with a cheap preview source) show a Top
// Teams grid under their links; mobile omits `renderExtra` (links only).
// Each breakpoint owns its own expanded-level state: mobile
// (`usauMobileExpandedLevel`) pre-expands whichever division matches the
// current `?level=`, unchanged from before. Desktop (`usauDesktopExpandedLevel`)
// is DIFFERENT — it always starts null (all collapsed) on every flyout open,
// regardless of the URL, so the user must pick a division before a page.

import { useEffect, useRef, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  buildLeagueQs,
  parseDivisionParam,
  parseLevelParam,
  levelLabel,
  USAU_LEVELS,
  type UsauLevel,
} from '@/lib/league';
import { useTheme } from '@/lib/use-theme';
import { useAuth } from '@/lib/auth/auth-provider';
import { AvatarIconView, iconResolvable } from '@/components/profile/avatar-icon-view';
import { getMyFavorites } from '@/lib/favorites/data';
import { FOR_YOU_ENABLED } from '@/lib/for-you/leagues';
import { LogoStrikeInline } from '@/components/logo-strike';
import { activeTeams } from '@/lib/ufa/teams';
import { allWulTeams, type WulTeamMeta } from '@/lib/wul/teams';
import { TeamLogo } from '@/components/team-logo';
import { UsauTeamLogo } from '@/components/usau/usau-team-logo';
import dynamic from 'next/dynamic';

// The auth modal is only needed once a signed-out visitor opens sign-in/up —
// load it on demand (same pattern as account-chip.tsx) so it stays out of
// the bundle every menu-open pays for.
const AuthModal = dynamic(() => import('@/components/auth/auth-modal').then((m) => m.AuthModal));

// ─── Types ─────────────────────────────────────────────────────────────────────

type SubApp = 'games' | 'playbook' | 'fantasy' | 'twelve-oh' | 'for-you' | 'jerseys';

type MegaLeagueId = 'ufa' | 'usau' | 'wul' | 'pul' | 'wfdf' | 'euf';

interface MegaLeague {
  id: MegaLeagueId;
  label: string;
  /** Full league name — shown as a muted subtitle next to the short label. */
  fullName: string;
  /** Logo image in /public (same assets as leagues-strip.tsx's LeagueMark). */
  img: string;
  real: boolean;
}

const MEGA_LEAGUES: MegaLeague[] = [
  { id: 'ufa',  label: 'UFA',  fullName: 'Ultimate Frisbee Association',   img: '/UFA-red.png',     real: true },
  { id: 'usau', label: 'USAU', fullName: 'USA Ultimate',                   img: '/USAU-logo.png',   real: true },
  { id: 'pul',  label: 'PUL',  fullName: 'Premier Ultimate League',        img: '/PUL.webp',        real: true }, // real=true: expandable with 4 sub-page links
  { id: 'wul',  label: 'WUL',  fullName: 'Western Ultimate League',        img: '/WUL-logo.jpeg',   real: true }, // real=true: expandable, but Teams-only (no scores/schedule/players yet)
  { id: 'wfdf', label: 'WFDF', fullName: 'World Flying Disc Federation',   img: '/WFDF_Logo.webp',  real: true }, // event-scoped hub (Events/Scores/Teams/Players under /wfdf/*)
  { id: 'euf',  label: 'EUCS', fullName: 'European Ultimate Club Season',  img: '/EUF_Logo.webp',   real: true }, // event-scoped hub (Events under /euf/*)
];

// ─── League fly-out preview data (ported from the old desktop mega-menu) ──────
// The fly-out panel shows each league's sub-pages + a team grid. UFA + WUL grids
// are static (in-memory); USAU + PUL + WFDF are lazy-fetched when first previewed.

const WUL_TEAMS_LIST: WulTeamMeta[] = allWulTeams();
type TopUsauTeam = { id: string; name: string; nationalsPlacement: number | null };
type UsauDivision = 'Men' | 'Women' | 'Mixed';
type UsauTeamsByDivision = Record<UsauDivision, TopUsauTeam[]>;
// College D-I preview rows (from the official-rankings reader) — same shape
// as TopUsauTeam but keyed by rank instead of nationals placement. id is null
// when the official ranking couldn't be matched to a usau_teams row (still
// shown by name, just not linkable — see the COLLEGE_D1 branch below).
type TopCollegeTeam = { id: string | null; name: string; rank: number };
type UsauCollegeTeamsByDivision = { Men: TopCollegeTeam[]; Women: TopCollegeTeam[] };
type TopPulTeam = { id: string; name: string; city: string; logoUrl: string | null };
type WfdfMenuEvent = { slug: string; name: string; year: number };

/** Flyout data from the cached /api/nav-menu route (built server-side at most
 *  hourly), instead of querying the DB from the browser on every open. */
async function navMenu<T>(section: string): Promise<T> {
  const res = await fetch(`/api/nav-menu/${section}`);
  if (!res.ok) throw new Error(`nav-menu ${section}: ${res.status}`);
  return (await res.json()) as T;
}

const UFA_DIVISIONS = ['East', 'Central', 'South', 'West'] as const;
type UfaDivision = (typeof UFA_DIVISIONS)[number];
const UFA_BY_DIVISION: Record<UfaDivision, ReturnType<typeof activeTeams>> = (() => {
  const grouped: Record<UfaDivision, ReturnType<typeof activeTeams>> = {
    East: [], Central: [], South: [], West: [],
  };
  for (const team of activeTeams()) {
    if (team.division && team.division in grouped) {
      grouped[team.division as UfaDivision].push(team);
    }
  }
  for (const div of UFA_DIVISIONS) {
    grouped[div].sort((a, b) => (a.city ?? '').localeCompare(b.city ?? ''));
  }
  return grouped;
})();

// Direct-link leagues navigate on tap instead of expanding.
// (None today — WFDF now expands into its own /wfdf/* sub-pages.)
const MEGA_LEAGUE_DIRECT_HREFS: Partial<Record<MegaLeagueId, string>> = {};

// WFDF section — event-scoped hub. All pages live under /wfdf/* (no ?league= qs),
// same no-qs treatment as WUL.
// No Scores item: /wfdf/scores duplicated the Events grid, deleted 2026-08-05.
const WFDF_NAV_ITEMS: GamesNavItem[] = [
  { label: 'Events',  href: '/wfdf/events',  match: '/wfdf/events' },
  { label: 'Teams',   href: '/wfdf/teams',   match: '/wfdf/teams' },
  { label: 'Players', href: '/wfdf/players', match: '/wfdf/players' },
];

// EUCS — event-scoped hub, no ?league= qs. "Teams" routes to /euf/clubs — the
// club identity layer (euf_teams rows are per-event; /euf/clubs merges them by
// name+division). No Scores item (duplicated Events, deleted 2026-08-04) and no
// Schedule item (same, deleted 2026-08-05 — /euf/events/[slug] already lists
// every game day-split within each round).
const EUF_NAV_ITEMS: GamesNavItem[] = [
  { label: 'Events',   href: '/euf/events',   match: '/euf/events' },
  { label: 'Teams',    href: '/euf/clubs',    match: '/euf/clubs', aliases: ['/euf/teams'] },
  { label: 'Players',  href: '/euf/players',  match: '/euf/players' },
];

interface GamesNavItem {
  label: string;
  href: string;
  match: string;
  aliases?: string[];
}

const GAMES_NAV_ITEMS: GamesNavItem[] = [
  { label: 'Scores',   href: '/scores',   match: '/scores',   aliases: ['/g', '/usau/events'] },
  { label: 'Schedule', href: '/schedule', match: '/schedule' },
  { label: 'Teams',    href: '/teams',    match: '/teams',    aliases: ['/usau/teams'] },
  { label: 'Players',  href: '/players',  match: '/players' },
];

// WUL section — all four pages route through the shared ?league=wul routes (same
// pattern as PUL). Schedule shows WUL's multi-season history (the source has no
// future fixtures, so it's an archive). Game detail lives at /wul/g/* (aliased
// under Scores so it stays highlighted on a matchup page).
const WUL_NAV_ITEMS: GamesNavItem[] = [
  { label: 'Scores',   href: '/scores?league=wul',   match: '/scores',   aliases: ['/wul/scores', '/wul/g'] },
  { label: 'Schedule', href: '/schedule?league=wul', match: '/schedule' },
  { label: 'Teams',    href: '/teams?league=wul',    match: '/teams',    aliases: ['/wul/teams'] },
  { label: 'Players',  href: '/players?league=wul',  match: '/players',  aliases: ['/wul/players'] },
];

function isGamesNavActive(pathname: string, item: GamesNavItem): boolean {
  if (item.match === '/') return pathname === '/';
  const matches = (prefix: string) =>
    pathname === prefix || pathname.startsWith(`${prefix}/`);
  if (matches(item.match)) return true;
  return item.aliases?.some(matches) ?? false;
}

// ─── APP_PREFIX_MAP (mirrors app-rail.tsx) ─────────────────────────────────────
const APP_PREFIX_MAP: Array<[string, SubApp]> = [
  ['/for-you',  'for-you'],
  ['/playbook', 'playbook'],
  ['/fantasy',  'fantasy'],
  ['/12-0',     'twelve-oh'],
  ['/utcg',     'twelve-oh'],  // UTCG lives in the same "Mini Games" group as 12-0
  ['/scores',   'games'],
  ['/schedule', 'games'],
  ['/teams',    'games'],
  ['/players',  'games'],
  ['/g/',       'games'],
  ['/g',        'games'],
  ['/usau',     'games'],
  ['/pul',      'games'],
  ['/wul',      'games'],
  ['/wfdf',     'games'],
  ['/euf',      'games'],
];

function detectSubApp(pathname: string): SubApp | null {
  for (const [prefix, app] of APP_PREFIX_MAP) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return app;
  }
  return null;
}

// ─── SVG icons ─────────────────────────────────────────────────────────────────

function ChevronDown({ className = '' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      width="10"
      height="10"
    >
      <path
        d="M2 3.5L5 6.5L8 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
      width="16"
      height="16"
    >
      <line x1="3" y1="3" x2="13" y2="13" />
      <line x1="13" y1="3" x2="3" y2="13" />
    </svg>
  );
}

// Per-sub-app line icons (20×20, 1.6 stroke) — give each top-level menu row a
// scannable glyph. Kept simple + on-brand (disc, clipboard, trophy, spark).
function SubAppIcon({ app, className = '' }: { app: SubApp; className?: string }) {
  const common = {
    className,
    width: 19,
    height: 19,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (app) {
    case 'games': // The League — a flying disc
      return (
        <svg {...common}>
          <ellipse cx="12" cy="12" rx="9" ry="4.2" />
          <path d="M4.2 10.5c1.4 1.2 4.3 2 7.8 2s6.4-.8 7.8-2" />
        </svg>
      );
    case 'playbook': // clipboard with a play line
      return (
        <svg {...common}>
          <rect x="5" y="4" width="14" height="17" rx="2" />
          <path d="M9 4h6v2H9z" />
          <path d="M8.5 11l3 3 4-5" />
        </svg>
      );
    case 'twelve-oh': // trophy (12-0 = the perfect season)
      return (
        <svg {...common}>
          <path d="M7 4h10v4a5 5 0 01-10 0V4z" />
          <path d="M7 6H4v1a3 3 0 003 3M17 6h3v1a3 3 0 01-3 3" />
          <path d="M12 13v4M9 20h6M10 20l.5-3h3l.5 3" />
        </svg>
      );
    case 'fantasy': // spark / star burst
      return (
        <svg {...common}>
          <path d="M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6L12 3z" />
        </svg>
      );
    case 'for-you': // bookmark — your saved/personalized feed (star is taken by Fantasy)
      return (
        <svg {...common}>
          <path d="M6 4h12v16l-6-4-6 4V4z" />
        </svg>
      );
  }
}

// A top-level direct-link menu row: large italic display heading · (beta) ·
// trailing arrow. No icon tile, no leading number — text-first, matching the
// reference design's editorial index treatment.
function SubAppRow({
  href,
  label,
  badge,
  active,
  onClose,
}: {
  app: SubApp;
  href: string;
  label: string;
  badge?: string;
  active: boolean;
  onClose: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClose}
      aria-current={active ? 'page' : undefined}
      className={[
        'group flex items-center justify-between gap-3 w-full px-2.5 py-3 rounded-xl',
        'no-underline transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        // Neutral highlight — a soft surface tint rather than an orange wash, so
        // the active row reads as "selected" without the loud accent fill.
        active ? 'bg-surface' : 'hover:bg-surface',
      ].join(' ')}
    >
      <span className="flex items-center gap-2 min-w-0">
        {/* No overflow/truncate clipping here — these labels are short, fixed
            strings, and italic display glyphs (e.g. the "y" descender) render
            slightly outside their advance-width box; clipping cuts them off
            even when the text technically fits. */}
        <span className="font-display italic font-bold text-[28px] leading-[0.95] tracking-[-0.02em] whitespace-nowrap text-ink">
          {label}
        </span>
        {badge && (
          <sup className="text-[9px] font-bold tracking-[0.14em] text-accent leading-none flex-shrink-0">
            {badge}
          </sup>
        )}
      </span>
      {/* Trailing arrow — subtle affordance that shifts toward the accent on
          hover/active. */}
      <svg
        className={[
          'w-4 h-4 flex-shrink-0 transition-colors duration-150',
          active ? 'text-ink' : 'text-faint group-hover:text-ink',
        ].join(' ')}
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path d="M4 8h8M8.5 4.5L12 8l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  );
}

// A sub-link inside the "Mini Games" accordion — indented under the group
// header, showing the game name + a one-line blurb. Mirrors the inset,
// left-spine treatment of the expanded League rows.
function MiniGameLink({
  href,
  label,
  blurb,
  active,
  onClose,
}: {
  href: string;
  label: string;
  blurb: string;
  active: boolean;
  onClose: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClose}
      aria-current={active ? 'page' : undefined}
      className={[
        'group flex items-center justify-between gap-3 w-full pl-4 pr-2.5 py-2.5 rounded-xl',
        'no-underline transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        // Left accent spine on the active game, matching the League fly-out rows.
        active ? 'bg-surface border-l-2 border-accent' : 'border-l-2 border-transparent hover:bg-surface',
      ].join(' ')}
    >
      <span className="flex flex-col min-w-0">
        <span className="font-display italic font-bold text-[22px] leading-[0.95] tracking-[-0.02em] whitespace-nowrap text-ink">
          {label}
        </span>
        <span className="text-[12px] text-muted font-tight leading-snug mt-0.5">
          {blurb}
        </span>
      </span>
      <svg
        className={[
          'w-4 h-4 flex-shrink-0 transition-colors duration-150',
          active ? 'text-ink' : 'text-faint group-hover:text-ink',
        ].join(' ')}
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path d="M4 8h8M8.5 4.5L12 8l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  );
}

// League mark — compact rounded-square badge showing a league's logo (falls
// back to its abbreviation monogram if no image loads). Same visual pattern
// as leagues-strip.tsx's LeagueMark (home page), reused here so the menu's
// league rows read consistently with the rest of the site.
function LeagueMark({ label, img, size = 36 }: { label: string; img: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className="inline-flex items-center justify-center rounded-[10px] flex-shrink-0 overflow-hidden bg-white shadow-[inset_0_0_0_1px_rgba(14,14,12,0.06)]"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={img} alt="" className="w-full h-full object-contain p-1" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
    </span>
  );
}

// ─── League fly-out content (pages + team grid) ──────────────────────────────
// Ported from the old desktop mega-menu's right pane. Renders one league's
// sub-page link row + team grid, adapted to the narrower fly-out panel.

interface FlyoutLeagueData {
  usau: { teams: UsauTeamsByDivision | null; loading: boolean; error: boolean };
  usauCollege: { teams: UsauCollegeTeamsByDivision | null; loading: boolean; error: boolean };
  pul: { teams: TopPulTeam[] | null; loading: boolean; error: boolean };
  wfdf: { events: WfdfMenuEvent[] | null; loading: boolean; error: boolean };
  euf: { events: WfdfMenuEvent[] | null; loading: boolean; error: boolean };
}

const gridLinkClass =
  'flex items-center gap-2 px-1.5 py-1.5 rounded-md text-[12px] font-medium font-tight text-ink transition-colors duration-150 no-underline hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

// Pill-tab styling for the SCORES/SCHEDULE/TEAMS/PLAYERS sub-page links —
// active = filled accent, resting = muted bg-ink/5 (matches the segmented
// pill control used elsewhere, e.g. games-subnav.tsx). Passed as
// LeagueFlyoutBody's tabLinkBase so both the desktop fly-out and the mobile
// inline dropdown render the same pill treatment.
// Rendered inside a 4-col grid (see tabRowBase callers) so all four sub-page
// tabs sit on ONE row — each pill fills its cell and centers, so PLAYERS no
// longer wraps to a second line. Padding is horizontal-minimal (the grid owns
// the width); tracking is slightly tighter so the longest label (SCHEDULE)
// fits the narrowest cell.
const pillLinkBase =
  'inline-flex items-center justify-center w-full h-8 px-1 rounded-full text-[10px] font-bold tracking-[0.08em] uppercase font-tight transition-colors duration-150 no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

// ── Shared body: sub-page tab links ─────────────────────────────────────────
// Used by the DESKTOP fly-out AND the MOBILE inline sub-dropdown for every
// league EXCEPT USAU. USAU's competition-level filter (Club/College D-I/
// College D-III/Masters/Grand Masters) instead renders as its own accordion —
// UsauLevelAccordion — on BOTH breakpoints: mobile because a horizontal chip
// row above a shared tab row didn't read as "this row's own filter" once
// stacked vertically in the mobile menu's nested-accordion structure, and
// desktop for the same nesting reason once it needed to hold a Top Teams
// preview per division too (see UsauLevelAccordion + its renderExtra prop).
// This component no longer has a USAU-specific branch — callers never pass
// league="usau" here anymore. Team grids for other leagues are desktop-only
// and live in LeagueFlyout, NOT here.
function LeagueFlyoutBody({
  league,
  pathname,
  leagueQsFor,
  onClose,
  // Sub-nav links stack VERTICALLY (one per row) — a horizontal pill row
  // wraps unpredictably in narrow panels (PLAYERS was falling onto its own
  // row on phones and in the 340px desktop fly-out).
  tabRowBase = 'flex flex-col gap-0.5 mb-2.5 pb-3 border-b border-hairline',
  tabLinkBase,
}: {
  league: MegaLeagueId;
  pathname: string;
  leagueQsFor: (id: MegaLeagueId) => string;
  onClose: () => void;
  /** Wrapper classes for the tab-link row — lets callers adjust indentation. */
  tabRowBase?: string;
  /** Per-link classes — defaults to the desktop fly-out treatment. */
  tabLinkBase?: string;
}) {
  // Sub-page link set: WUL + WFDF use their own routes (no ?league= qs).
  const navItems =
    league === 'wul' ? WUL_NAV_ITEMS
    : league === 'wfdf' ? WFDF_NAV_ITEMS
    : league === 'euf' ? EUF_NAV_ITEMS
    : GAMES_NAV_ITEMS;
  const noQs = league === 'wul' || league === 'wfdf' || league === 'euf';

  // Pill mode (tabLinkBase passed by the caller — the league fly-out/dropdown
  // treatment) gets a FILLED accent active state, matching the reference's
  // "SCORES active = filled accent, others = muted" pill row. Any other
  // caller (none currently) keeps the original tinted-text active state.
  const isPillMode = tabLinkBase != null;
  const linkClass =
    tabLinkBase ??
    [
      'flex items-center w-full px-3 min-h-[42px] rounded-md',
      'text-[11px] font-bold tracking-[0.1em] uppercase font-tight',
      'transition-colors duration-150 no-underline',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
    ].join(' ');

  return (
    <div className={tabRowBase}>
      {navItems.map((item) => {
        const active = isGamesNavActive(pathname, item);
        const qs = noQs ? '' : leagueQsFor(league);
        return (
          <Link
            key={item.href}
            href={`${item.href}${qs}`}
            role="menuitem"
            aria-current={active ? 'page' : undefined}
            onClick={onClose}
            className={[
              linkClass,
              active
                ? isPillMode ? 'bg-accent text-accent-ink' : 'text-accent bg-[rgb(var(--accent)/0.1)]'
                : isPillMode ? 'bg-ink/5 text-ink hover:bg-ink/10' : 'text-ink hover:bg-surface',
            ].join(' ')}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}

// ── USAU's per-division accordion — shared by MOBILE inline dropdown AND
// DESKTOP fly-out ──────────────────────────────────────────────────────────
// USAU is the one league with a competition-level filter, and it reads better
// as its own vertically-stacked accordion (one division per row, tap to
// reveal its content) than as a horizontal chip row sitting above a single
// shared tab-link row — chips floating above an unrelated-looking link row
// don't read as "this row's filter." Mobile uses this with `renderExtra`
// omitted (links only); desktop passes `renderExtra` to append each
// division's Top Teams preview (where a cheap source exists) after the links,
// reusing the exact same accordion shape instead of two parallel markups.
// One division open at a time; defaults to whichever matches the current
// ?level=.
function UsauLevelAccordion({
  pathname,
  urlDivision,
  expandedLevel,
  onToggleLevel,
  onClose,
  renderExtra,
}: {
  pathname: string;
  urlDivision: ReturnType<typeof parseDivisionParam>;
  expandedLevel: UsauLevel | null;
  onToggleLevel: (level: UsauLevel) => void;
  onClose: () => void;
  /** Desktop-only: renders a division's Top Teams preview below its links. */
  renderExtra?: (level: UsauLevel) => React.ReactNode;
}) {
  const divisionRowBase = [
    'flex items-center justify-between w-full pl-3 pr-3',
    'min-h-[44px] text-left cursor-pointer rounded-md',
    'text-[11px] font-bold tracking-[0.12em] uppercase font-tight',
    'transition-colors duration-150 no-underline',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
  ].join(' ');

  const linkClass = [
    'flex items-center w-full px-3 min-h-[44px] rounded-md',
    'text-[11px] font-bold tracking-[0.1em] uppercase font-tight',
    'transition-colors duration-150 no-underline',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
  ].join(' ');

  return (
    <div className="flex flex-col gap-0.5">
      {USAU_LEVELS.map((level) => {
        const isExpanded = expandedLevel === level;
        // CLUB is the default level — buildLeagueQs omits it from the qs.
        const qs = buildLeagueQs('usau', urlDivision, level);
        return (
          <div key={level}>
            <button
              type="button"
              aria-expanded={isExpanded}
              onClick={() => onToggleLevel(level)}
              className={[
                divisionRowBase,
                isExpanded ? 'text-ink bg-surface' : 'text-ink hover:bg-surface',
              ].join(' ')}
            >
              {levelLabel(level)}
              <ChevronDown
                className={[
                  'flex-shrink-0 transition-transform duration-200',
                  isExpanded ? 'rotate-180 text-accent' : 'text-faint',
                ].join(' ')}
              />
            </button>

            {isExpanded && (
              <div className="pl-3 pt-1 pb-1.5">
                <div className="flex flex-col gap-0.5">
                  {GAMES_NAV_ITEMS.map((item) => {
                    const active = isGamesNavActive(pathname, item);
                    return (
                      <Link
                        key={item.href}
                        href={`${item.href}${qs}`}
                        role="menuitem"
                        aria-current={active ? 'page' : undefined}
                        onClick={onClose}
                        className={[
                          linkClass,
                          active ? 'text-accent bg-[rgb(var(--accent)/0.1)]' : 'text-ink hover:bg-surface',
                        ].join(' ')}
                      >
                        {item.label}
                      </Link>
                    );
                  })}
                </div>
                {renderExtra?.(level)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// USAU Top Teams preview per level — CLUB and COLLEGE_D1 have a cheap
// preview source (club RPC / official rankings reader); COLLEGE_D3/MASTERS/
// GRAND_MASTERS have none yet and render links only. Passed as `renderExtra`
// to UsauLevelAccordion on both breakpoints (mobile omits it — see the call
// site in the mobile inline sub-dropdown). Hoisted to a standalone function
// so both the desktop LeagueFlyout and the mobile inline accordion can share
// the same JSX instead of duplicating it.
function usauTopTeamsExtra(
  usau: FlyoutLeagueData['usau'],
  usauCollege: FlyoutLeagueData['usauCollege'],
  onClose: () => void,
): (level: UsauLevel) => React.ReactNode {
  return (level: UsauLevel) => {
    if (level === 'CLUB') {
      return (
        <div className="mt-2.5">
          <p className="text-[9px] font-bold tracking-[0.14em] uppercase text-faint mb-1.5">Top Teams</p>
          {usau.loading && <GridSkeleton />}
          {!usau.loading && usau.error && <LoadError href="/teams?league=usau" onClose={onClose} />}
          {!usau.loading && !usau.error && usau.teams && (
            <div className="flex flex-col gap-2.5">
              {(['Men', 'Women', 'Mixed'] as const).map((div) => {
                const teams = usau.teams![div];
                if (!teams || teams.length === 0) return null;
                return (
                  <div key={div}>
                    <p className="text-[9px] font-bold tracking-[0.12em] uppercase text-muted mb-1">{div}</p>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                      {teams.map((team) => (
                        <Link key={team.id} href={`/usau/teams/${team.id}`} role="menuitem" onClick={onClose} className={gridLinkClass}>
                          <span className="text-[10px] font-bold text-faint tabular w-4 text-right flex-shrink-0">
                            {team.nationalsPlacement ?? ''}
                          </span>
                          <UsauTeamLogo name={team.name} genderDivision={div} size={20} />
                          <span className="truncate">{team.name}</span>
                        </Link>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    }
    if (level === 'COLLEGE_D1') {
      return (
        <div className="mt-2.5">
          <p className="text-[9px] font-bold tracking-[0.14em] uppercase text-faint mb-1.5">Top Teams</p>
          {usauCollege.loading && <GridSkeleton />}
          {!usauCollege.loading && usauCollege.error && (
            <LoadError href="/teams?league=usau&level=college-d1" onClose={onClose} />
          )}
          {!usauCollege.loading && !usauCollege.error && usauCollege.teams && (
            <div className="flex flex-col gap-2.5">
              {(['Men', 'Women'] as const).map((div) => {
                const teams = usauCollege.teams![div];
                if (!teams || teams.length === 0) return null;
                return (
                  <div key={div}>
                    <p className="text-[9px] font-bold tracking-[0.12em] uppercase text-muted mb-1">{div}</p>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                      {teams.map((team) => {
                        const inner = (
                          <>
                            <span className="text-[10px] font-bold text-faint tabular w-4 text-right flex-shrink-0">
                              {team.rank}
                            </span>
                            <UsauTeamLogo name={team.name} genderDivision={div} competitionLevel="COLLEGE_D1" size={20} />
                            <span className="truncate">{team.name}</span>
                          </>
                        );
                        // Unmatched teams (no usau_teams row) still preview here by
                        // name — just not as a link, since there's no profile page.
                        return team.id ? (
                          <Link key={team.rank} href={`/usau/teams/${team.id}`} role="menuitem" onClick={onClose} className={gridLinkClass}>
                            {inner}
                          </Link>
                        ) : (
                          <div key={team.rank} className={gridLinkClass}>
                            {inner}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    }
    // COLLEGE_D3 / MASTERS / GRAND_MASTERS: no cheap Top Teams source yet —
    // links only.
    return null;
  };
}

// Desktop-only fly-out: header + shared body + team grids. Rendered by the
// caller inside a `hidden md:flex` wrapper — mobile never mounts this.
function LeagueFlyout({
  league,
  pathname,
  urlDivision,
  leagueQsFor,
  leagueHomeHrefFor,
  onBack,
  onClose,
  pul,
  wfdf,
  euf,
  usau,
  usauCollege,
  expandedLevel,
  onToggleLevel,
}: {
  league: MegaLeagueId;
  pathname: string;
  urlDivision: ReturnType<typeof parseDivisionParam>;
  leagueQsFor: (id: MegaLeagueId) => string;
  leagueHomeHrefFor: (id: MegaLeagueId) => string;
  onBack: () => void;
  onClose: () => void;
  /** DESKTOP-only: which USAU division row is expanded in the single
   * flyout's UsauLevelAccordion. Starts null (all collapsed) — see
   * usauDesktopExpandedLevel in MobileMenu. */
  expandedLevel: UsauLevel | null;
  onToggleLevel: (level: UsauLevel) => void;
} & FlyoutLeagueData) {
  const label = MEGA_LEAGUES.find((l) => l.id === league)?.label ?? '';

  return (
    <div className="flex flex-col">
      {/* Fly-out header: back arrow + league name + "OPEN {LEAGUE} →" jump link. */}
      <div className="flex items-center gap-2 px-4 h-[52px] flex-shrink-0 border-b border-hairline sticky top-0 bg-bg z-10">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="inline-flex items-center justify-center w-8 h-8 rounded-full text-muted hover:text-ink hover:bg-surface transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent -ml-1"
        >
          <svg width="14" height="14" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M6.5 2L3.5 5L6.5 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span className="text-[12px] font-bold tracking-[0.14em] uppercase font-tight text-ink flex-1">
          {label}
        </span>
        <Link
          href={leagueHomeHrefFor(league)}
          onClick={onClose}
          className="inline-flex items-center gap-1 text-[10px] font-bold tracking-[0.14em] uppercase text-accent font-tight no-underline hover:opacity-80 transition-opacity duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
        >
          Open {label}
          <span aria-hidden="true">→</span>
        </Link>
      </div>

      <div className="p-4">
        {/* ── USAU: single-flyout accordion — the SAME component the mobile
            inline sub-dropdown uses. All 5 division rows start COLLAPSED
            (expandedLevel is reset to null whenever the flyout opens — see
            openFlyout in MobileMenu); the user must pick a division before
            a page. renderExtra appends the Top Teams preview grid for
            CLUB/COLLEGE_D1 (mobile omits renderExtra — links only). Every
            other league keeps the original LeagueFlyoutBody (tabs only) +
            its own team grid below. ── */}
        {league === 'usau' ? (
          <UsauLevelAccordion
            pathname={pathname}
            urlDivision={urlDivision}
            expandedLevel={expandedLevel}
            onToggleLevel={onToggleLevel}
            onClose={onClose}
            renderExtra={usauTopTeamsExtra(usau, usauCollege, onClose)}
          />
        ) : (
          <LeagueFlyoutBody
            league={league}
            pathname={pathname}
            leagueQsFor={leagueQsFor}
            onClose={onClose}
            tabRowBase="grid grid-cols-4 gap-1.5 mb-3"
            tabLinkBase={pillLinkBase}
          />
        )}

        <LeagueTeamGrid league={league} onClose={onClose} pul={pul} wfdf={wfdf} euf={euf} />
      </div>
    </div>
  );
}

// ── Team grid — the previewed league's team/event list ─────────────────────
// Shared by the DESKTOP fly-out (LeagueFlyout, above) and the MOBILE inline
// sub-dropdown so both breakpoints show identical data from one source.
// USAU's grid lives inside its own UsauLevelAccordion (via usauTopTeamsExtra)
// instead of here, since it's nested per-division rather than a flat grid.
function LeagueTeamGrid({
  league,
  onClose,
  pul,
  wfdf,
  euf,
}: {
  league: MegaLeagueId;
  onClose: () => void;
} & Pick<FlyoutLeagueData, 'pul' | 'wfdf' | 'euf'>) {
  if (league === 'ufa') {
    return (
      <div className="grid grid-cols-2 gap-x-3 gap-y-3">
        {UFA_DIVISIONS.map((div) => (
          <div key={div}>
            <p className="text-[9px] font-bold tracking-[0.14em] uppercase text-faint mb-1.5 px-1">
              {div}
            </p>
            <ul className="space-y-0.5">
              {UFA_BY_DIVISION[div].map((team) => (
                <li key={team.id}>
                  <Link href={`/teams/${team.id}`} role="menuitem" onClick={onClose} className={gridLinkClass}>
                    <TeamLogo team={team} size={20} />
                    <span className="truncate">{team.city}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    );
  }

  if (league === 'pul') {
    return (
      <div>
        <p className="text-[9px] font-bold tracking-[0.14em] uppercase text-faint mb-1.5">Teams</p>
        {pul.loading && <GridSkeleton />}
        {!pul.loading && pul.error && <LoadError href="/teams?league=pul" onClose={onClose} />}
        {!pul.loading && !pul.error && pul.teams && (
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {pul.teams.map((team) => (
              <Link key={team.id} href={`/pul/teams/${team.id}`} role="menuitem" onClick={onClose} className={gridLinkClass}>
                <PulTeamLogoMini logoUrl={team.logoUrl} city={team.city} />
                <span className="truncate">{team.city}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (league === 'wul') {
    return (
      <div>
        <p className="text-[9px] font-bold tracking-[0.14em] uppercase text-faint mb-1.5">Teams</p>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
          {WUL_TEAMS_LIST.map((team) => (
            <Link key={team.id} href={`/wul/teams/${team.id}`} role="menuitem" onClick={onClose} className={gridLinkClass}>
              <WulTeamLogoMini team={team} />
              <span className="truncate">{team.city}</span>
            </Link>
          ))}
        </div>
      </div>
    );
  }

  if (league === 'wfdf') {
    return (
      <div>
        <p className="text-[9px] font-bold tracking-[0.14em] uppercase text-faint mb-1.5">Recent Events</p>
        {wfdf.loading && <GridSkeleton />}
        {!wfdf.loading && wfdf.error && <LoadError href="/wfdf/events" onClose={onClose} />}
        {!wfdf.loading && !wfdf.error && wfdf.events && (
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {wfdf.events.map((e) => (
              <Link key={e.slug} href={`/wfdf/events/${e.slug}`} role="menuitem" onClick={onClose} className={gridLinkClass}>
                <span className="text-[10px] font-bold text-faint tabular w-8 text-right flex-shrink-0">{e.year}</span>
                <span className="truncate">{e.name}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (league === 'euf') {
    return (
      <div>
        <p className="text-[9px] font-bold tracking-[0.14em] uppercase text-faint mb-1.5">Recent Events</p>
        {euf.loading && <GridSkeleton />}
        {!euf.loading && euf.error && <LoadError href="/euf/events" onClose={onClose} />}
        {!euf.loading && !euf.error && euf.events && (
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {euf.events.map((e) => (
              <Link key={e.slug} href={`/euf/events/${e.slug}`} role="menuitem" onClick={onClose} className={gridLinkClass}>
                <span className="text-[10px] font-bold text-faint tabular w-8 text-right flex-shrink-0">{e.year}</span>
                <span className="truncate">{e.name}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  }

  return null;
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="h-7 rounded bg-surface animate-pulse" />
      ))}
    </div>
  );
}

function LoadError({ href, onClose }: { href: string; onClose: () => void }) {
  return (
    <div className="py-3 text-[12px] text-muted">
      Couldn&apos;t load —{' '}
      <Link
        href={href}
        onClick={onClose}
        className="text-ink underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
      >
        browse all
      </Link>
    </div>
  );
}

// PUL/WUL mini team logos (20px) — inline renderers matching the old mega-menu.
function PulTeamLogoMini({ logoUrl, city }: { logoUrl: string | null; city: string }) {
  const size = 20;
  if (logoUrl) {
    return (
      <span
        className="inline-flex items-center justify-center flex-shrink-0 overflow-hidden rounded-sm bg-white border border-[rgb(var(--ink)/0.08)]"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoUrl} alt="" className="object-contain" style={{ width: size * 0.84, height: size * 0.84 }} />
      </span>
    );
  }
  const initials = city.split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase();
  return (
    <span
      className="inline-flex items-center justify-center flex-shrink-0 rounded-sm"
      style={{ width: size, height: size, background: '#1d2535' }}
      aria-hidden="true"
    >
      <span className="font-display font-bold text-white" style={{ fontSize: 7, letterSpacing: '0.03em' }}>
        {initials}
      </span>
    </span>
  );
}

function WulTeamLogoMini({ team }: { team: WulTeamMeta }) {
  const size = 20;
  if (team.logo) {
    return (
      <span
        className="inline-flex items-center justify-center flex-shrink-0 overflow-hidden rounded-sm bg-white border border-[rgb(var(--ink)/0.08)]"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={team.logo} alt="" className="object-contain" style={{ width: size * 0.84, height: size * 0.84 }} />
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center justify-center flex-shrink-0 relative overflow-hidden rounded-sm"
      style={{ width: size, height: size, background: team.primary }}
      aria-hidden="true"
    >
      <span className="absolute inset-0" style={{ background: team.accent, opacity: 0.15 }} />
      <span className="relative z-10 font-display font-bold text-white" style={{ fontSize: 7, letterSpacing: '0.03em' }}>
        {team.abbr}
      </span>
    </span>
  );
}

// ─── Account footer ──────────────────────────────────────────────────────────
// Persistent bottom slot in the drawer. Signed in: avatar + name + "Manage
// account" + Settings/Sign out. Signed out: Sign in / Create account, wired
// to the same AuthModal + useAuth pattern as account-chip.tsx (the top-bar
// equivalent). Self-contained (owns its own useAuth + modal state) so it
// doesn't add props to MobileMenu just to thread auth through.
function AccountFooter({ onClose }: { onClose: () => void }) {
  const { user, loading, signOut } = useAuth();
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');

  if (loading) {
    return (
      <div className="flex-shrink-0 px-5 py-4 border-t border-hairline">
        <div className="h-11 rounded-xl bg-surface animate-pulse" aria-hidden="true" />
      </div>
    );
  }

  // ── Signed out ────────────────────────────────────────────────────────
  if (!user) {
    return (
      <div className="flex-shrink-0 flex items-center gap-2 px-5 py-4 border-t border-hairline">
        <button
          type="button"
          onClick={() => { setAuthMode('signup'); setAuthOpen(true); }}
          className="flex-1 inline-flex items-center justify-center h-11 rounded-xl bg-accent text-accent-ink text-[11px] font-bold tracking-[0.12em] uppercase font-tight cursor-pointer hover:opacity-90 transition-opacity duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Create account
        </button>
        <button
          type="button"
          onClick={() => { setAuthMode('signin'); setAuthOpen(true); }}
          className="flex-1 inline-flex items-center justify-center h-11 rounded-xl border border-hairline text-ink text-[11px] font-bold tracking-[0.12em] uppercase font-tight cursor-pointer hover:bg-surface transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Sign in
        </button>

        {authOpen && (
          <AuthModal
            open={authOpen}
            dismissible
            initialMode={authMode}
            onDismiss={() => setAuthOpen(false)}
          />
        )}
      </div>
    );
  }

  // ── Signed in ─────────────────────────────────────────────────────────
  return (
    <div className="flex-shrink-0 flex items-center gap-3 px-5 py-4 border-t border-hairline">
      {/* Icon precedence: picked team-logo/flag (synchronously resolvable —
          UFA/USAU/WUL/WFDF; a PUL icon needs a DB fetch so it falls back to
          initials here) → uploaded photo → initials. */}
      {user.profile?.avatar_icon && iconResolvable(user.profile.avatar_icon) ? (
        <span
          aria-hidden="true"
          className="inline-flex items-center justify-center flex-shrink-0 w-10 h-10 rounded-full overflow-hidden bg-ink/5"
        >
          <AvatarIconView icon={user.profile.avatar_icon} size={40} />
        </span>
      ) : user.profile?.avatar_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          aria-hidden="true"
          src={user.profile.avatar_url}
          alt=""
          className="flex-shrink-0 w-10 h-10 rounded-full object-cover bg-ink/5"
        />
      ) : (
        <span
          aria-hidden="true"
          className="inline-flex items-center justify-center flex-shrink-0 w-10 h-10 rounded-full bg-accent text-accent-ink font-bold text-[13px] font-tight"
        >
          {user.initials}
        </span>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-bold text-ink font-tight truncate">{user.name}</div>
        <div className="text-[11px] text-muted font-tight truncate">Manage account</div>
      </div>
      <div className="flex-shrink-0 flex items-center gap-3">
        <Link
          href="/settings"
          onClick={onClose}
          className="text-[10px] font-bold tracking-[0.12em] uppercase font-tight text-muted hover:text-ink no-underline transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
        >
          Settings
        </Link>
        <button
          type="button"
          onClick={async () => { await signOut(); onClose(); }}
          className="text-[10px] font-bold tracking-[0.12em] uppercase font-tight text-muted hover:text-ink cursor-pointer transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

// ─── MobileMenu ────────────────────────────────────────────────────────────────

interface MobileMenuProps {
  open: boolean;
  onClose: () => void;
  /** Ref to the hamburger button so we can return focus on close. */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}

export function MobileMenu({ open, onClose, triggerRef }: MobileMenuProps) {
  const pathname = usePathname() ?? '/';
  const searchParams = useSearchParams();
  const [mounted, setMounted] = useState(false);
  const [theme] = useTheme();
  const { user } = useAuth();

  // SSR guard — createPortal is browser-only.
  useEffect(() => { setMounted(true); }, []);

  // "For You" appears in the menu when the signed-in user has a favorite TEAM or
  // PLAYER (a favorite league alone isn't enough — the feed is team/player-driven,
  // matching the /for-you empty-state rule). Fetched as soon as the SESSION is
  // known — NOT gated on the menu opening — so the row is already resolved by the
  // time the menu renders (previously it popped in a beat late on every open, and
  // reset to hidden between opens, causing a flash). `null` = not-yet-known.
  const [hasFavorites, setHasFavorites] = useState<boolean | null>(null);
  useEffect(() => {
    if (!user) { setHasFavorites(false); return; }
    let cancelled = false;
    getMyFavorites()
      .then((f) => {
        // Only ever SET to the resolved value — never reset to false/null on a
        // refetch, so re-opening the menu can update the row in the background
        // without ever hiding a row that should show (no flash).
        if (!cancelled) setHasFavorites(f.teams.length > 0 || f.players.length > 0);
      })
      .catch(() => {
        // Keep any prior known value on a transient failure; only default to
        // hidden if we never resolved it.
        if (!cancelled) setHasFavorites((prev) => prev ?? false);
      });
    return () => { cancelled = true; };
    // Re-run when the session changes OR the menu opens, so a mid-session
    // favorite change is reflected — but the fetch on user-change means the row
    // is already resolved before the first open (no late render).
  }, [user, open]);

  // ── Derive initial expanded state from URL ──────────────────────────────
  const activeApp = detectSubApp(pathname);
  // Division persists onto the fly-out's UFA/USAU sub-page links via leagueQsFor.
  const urlDivision = parseDivisionParam(searchParams.get('div'));
  // USAU competition-level FILTER for the flyout's sub-tab row. Seeded from
  // the URL on open; purely local state afterward (selecting a chip doesn't
  // navigate — only the tab links below pick it up).
  const [usauLevel, setUsauLevel] = useState<UsauLevel>(() => parseLevelParam(searchParams.get('level')));

  // MOBILE-ONLY: which USAU division row is expanded in the inline
  // sub-dropdown accordion (UsauMobileLevelList). Independent of usauLevel
  // above (that one drives the DESKTOP chip row) but defaults to the same
  // URL-derived level so a user arriving at ?level=college-d1 sees College
  // D-I pre-expanded on mobile too. One division open at a time; null = all
  // collapsed (reachable by tapping the open division again).
  const [usauMobileExpandedLevel, setUsauMobileExpandedLevel] = useState<UsauLevel | null>(
    () => parseLevelParam(searchParams.get('level')),
  );

  // DESKTOP-ONLY: which USAU division row is expanded in the single flyout
  // accordion. Starts null (all collapsed) — the user must pick a division
  // before a page. Distinct from usauMobileExpandedLevel (mobile inline) and
  // from usauLevel (retained for the lazy team-fetch trigger below).
  const [usauDesktopExpandedLevel, setUsauDesktopExpandedLevel] = useState<UsauLevel | null>(null);

  // "The League" section is expanded by default when on a games page.
  const initialGamesOpen = activeApp === 'games';
  const [gamesOpen, setGamesOpen] = useState(initialGamesOpen);

  // "Mini Games" section (12-0 · UTCG) — expanded by default when on either.
  const [miniGamesOpen, setMiniGamesOpen] = useState(activeApp === 'twelve-oh');

  // ── League fly-out (the left panel showing a league's pages + team grid) ──
  // Set by hovering (desktop) or tapping (mobile) a league row. null = closed.
  const [flyoutLeague, setFlyoutLeague] = useState<MegaLeagueId | null>(null);
  const flyoutMountedRef = useRef(true);
  useEffect(() => () => { flyoutMountedRef.current = false; }, []);

  // Lazy team/event data for the fly-out grids (USAU / PUL / WFDF). UFA + WUL
  // grids are static (module-level). Fetched once when their league is first
  // previewed; cached for the component's lifetime.
  const [usauTeams, setUsauTeams] = useState<UsauTeamsByDivision | null>(null);
  const [usauLoading, setUsauLoading] = useState(false);
  const [usauError, setUsauError] = useState(false);
  const usauFetchedRef = useRef(false);

  // College D-I "Top Teams" preview — fed by the cheap usau_rankings reader
  // (listOfficialUsauRankings), NOT the club RPC. Fetched lazily the first
  // time COLLEGE_D1 is selected in the flyout, then cached for the
  // component's lifetime same as the club fetch above.
  const [usauCollegeTeams, setUsauCollegeTeams] = useState<UsauCollegeTeamsByDivision | null>(null);
  const [usauCollegeLoading, setUsauCollegeLoading] = useState(false);
  const [usauCollegeError, setUsauCollegeError] = useState(false);
  const usauCollegeFetchedRef = useRef(false);

  const [pulTeams, setPulTeams] = useState<TopPulTeam[] | null>(null);
  const [pulLoading, setPulLoading] = useState(false);
  const [pulError, setPulError] = useState(false);
  const pulFetchedRef = useRef(false);

  const [wfdfEvents, setWfdfEvents] = useState<WfdfMenuEvent[] | null>(null);
  const [wfdfLoading, setWfdfLoading] = useState(false);
  const [wfdfError, setWfdfError] = useState(false);
  const wfdfFetchedRef = useRef(false);
  const [eufEvents, setEufEvents] = useState<WfdfMenuEvent[] | null>(null);
  const [eufLoading, setEufLoading] = useState(false);
  const [eufError, setEufError] = useState(false);
  const eufFetchedRef = useRef(false);

  const fetchUsauTeams = useCallback(async () => {
    if (usauFetchedRef.current) return;
    usauFetchedRef.current = true;
    setUsauLoading(true);
    try {
      const teams = await navMenu<UsauTeamsByDivision>('usau');
      if (flyoutMountedRef.current) setUsauTeams(teams);
    } catch {
      if (flyoutMountedRef.current) setUsauError(true);
    } finally {
      if (flyoutMountedRef.current) setUsauLoading(false);
    }
  }, []);

  const fetchUsauCollegeTeams = useCallback(async () => {
    if (usauCollegeFetchedRef.current) return;
    usauCollegeFetchedRef.current = true;
    setUsauCollegeLoading(true);
    try {
      const teams = await navMenu<UsauCollegeTeamsByDivision>('usau-college');
      if (flyoutMountedRef.current) setUsauCollegeTeams(teams);
    } catch {
      if (flyoutMountedRef.current) setUsauCollegeError(true);
    } finally {
      if (flyoutMountedRef.current) setUsauCollegeLoading(false);
    }
  }, []);

  const fetchPulTeams = useCallback(async () => {
    if (pulFetchedRef.current) return;
    pulFetchedRef.current = true;
    setPulLoading(true);
    try {
      const teams = await navMenu<TopPulTeam[]>('pul');
      if (flyoutMountedRef.current) setPulTeams(teams);
    } catch {
      if (flyoutMountedRef.current) setPulError(true);
    } finally {
      if (flyoutMountedRef.current) setPulLoading(false);
    }
  }, []);

  const fetchWfdfEvents = useCallback(async () => {
    if (wfdfFetchedRef.current) return;
    wfdfFetchedRef.current = true;
    setWfdfLoading(true);
    try {
      const events = await navMenu<WfdfMenuEvent[]>('wfdf');
      if (flyoutMountedRef.current) setWfdfEvents(events);
    } catch {
      if (flyoutMountedRef.current) setWfdfError(true);
    } finally {
      if (flyoutMountedRef.current) setWfdfLoading(false);
    }
  }, []);

  const fetchEufEvents = useCallback(async () => {
    if (eufFetchedRef.current) return;
    eufFetchedRef.current = true;
    setEufLoading(true);
    try {
      const events = await navMenu<WfdfMenuEvent[]>('euf');
      if (flyoutMountedRef.current) setEufEvents(events);
    } catch {
      if (flyoutMountedRef.current) setEufError(true);
    } finally {
      if (flyoutMountedRef.current) setEufLoading(false);
    }
  }, []);

  // isDesktopViewport still gates the hover/focus auto-open behavior below
  // (touch taps synthesize hover events that would otherwise fight the tap
  // handler) — but the team-grid data fetches themselves are NOT gated by
  // it: the mobile inline sub-dropdown now shows the same team grid as the
  // desktop fly-out (LeagueTeamGrid, shared by both), so both breakpoints
  // need the underlying data.
  const isDesktopViewport = useCallback(() => {
    return typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches;
  }, []);

  // Open the fly-out for a league + kick its lazy fetch. USAU's top-teams
  // source depends on which level is currently selected (e.g. deep-linking
  // in with ?level=college-d1 already selected before the flyout opens) —
  // this pre-warms the fetch even though the accordion itself opens
  // collapsed, so the grid is ready the moment the user expands that row.
  // Also resets the desktop accordion to fully collapsed on every open, so
  // re-opening USAU after a prior expand-then-close starts fresh.
  const openFlyout = useCallback((id: MegaLeagueId) => {
    setFlyoutLeague(id);
    if (id === 'usau') {
      setUsauDesktopExpandedLevel(null);
      if (usauLevel === 'COLLEGE_D1') fetchUsauCollegeTeams();
      else if (usauLevel === 'CLUB') fetchUsauTeams();
    } else if (id === 'pul') fetchPulTeams();
    else if (id === 'wfdf') fetchWfdfEvents();
    else if (id === 'euf') fetchEufEvents();
  }, [usauLevel, fetchUsauTeams, fetchUsauCollegeTeams, fetchPulTeams, fetchWfdfEvents, fetchEufEvents]);

  // Retained: usauLevel/setUsauLevel is no longer changed by any desktop UI
  // interaction (the desktop accordion below has its own expand/collapse
  // state), but the value itself still feeds leagueQsFor's `?level=` qs and
  // openFlyout's pre-warm fetch above, both seeded from the URL on mount.

  // MOBILE-ONLY: toggling a division row in UsauMobileLevelList. Pure
  // accordion state — no data fetch (mobile never shows the team grids that
  // fetch feeds), no navigation. Tapping the already-expanded division
  // collapses it; tapping another switches to it (one open at a time).
  const handleUsauMobileLevelToggle = useCallback((level: UsauLevel) => {
    setUsauMobileExpandedLevel((prev) => (prev === level ? null : level));
  }, []);

  // DESKTOP-ONLY: toggling a division row in the single USAU flyout
  // accordion (UsauLevelAccordion's onToggleLevel there). Pure expand/collapse
  // state, no navigation — mirrors handleUsauMobileLevelToggle above but also
  // lazily kicks the CLUB/College D-I team fetch the first time that division
  // is EXPANDED (each fetch has its own ref guard, so this is a no-op if
  // already loaded — e.g. via openFlyout's pre-warm). Gated to fire only on
  // expand, never on collapse, since collapsing doesn't need fresh data.
  const handleUsauDesktopLevelToggle = useCallback((level: UsauLevel) => {
    setUsauDesktopExpandedLevel((prev) => {
      const next = prev === level ? null : level;
      if (next === 'CLUB') fetchUsauTeams();
      else if (next === 'COLLEGE_D1') fetchUsauCollegeTeams();
      return next;
    });
  }, [fetchUsauTeams, fetchUsauCollegeTeams]);

  // Close the fly-out whenever the main menu closes or the route changes.
  useEffect(() => { if (!open) setFlyoutLeague(null); }, [open]);
  useEffect(() => { setFlyoutLeague(null); }, [pathname]);

  // Re-derive "The League" expansion when the pathname changes (e.g. navigating
  // while the menu is open). The per-league fly-out closes on nav (see above).
  useEffect(() => {
    setGamesOpen(detectSubApp(pathname) === 'games');
  }, [pathname]);

  // ── Body scroll lock ────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // ── Focus management ────────────────────────────────────────────────────
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      // Small delay lets the portal render before focusing.
      const id = setTimeout(() => closeButtonRef.current?.focus(), 50);
      return () => clearTimeout(id);
    } else if (wasOpenRef.current) {
      // Return focus to the hamburger trigger — only after a real close, or
      // every page load painted a focus ring on it.
      wasOpenRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open, triggerRef]);

  // ── Esc to close ────────────────────────────────────────────────────────
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, handleKeyDown]);

  // ── league qs helper (mirrors GamesDropdown) ────────────────────────────
  // USAU carries both the gender division (from the URL, unrelated to this
  // task) and the competition level (the flyout's own filter state below).
  function leagueQsFor(lid: MegaLeagueId): string {
    if (lid === 'usau') return buildLeagueQs('usau', urlDivision, usauLevel);
    if (lid === 'pul') return buildLeagueQs('pul', null);
    return buildLeagueQs('ufa', urlDivision);
  }

  // "OPEN {LEAGUE} →" href — the league's main scores page. WUL/WFDF use
  // their own no-qs routes (same as WUL_NAV_ITEMS/WFDF_NAV_ITEMS above);
  // everything else lands on /scores with the league's query string.
  function leagueHomeHrefFor(lid: MegaLeagueId): string {
    if (lid === 'wul') return '/wul/scores';
    if (lid === 'wfdf') return '/wfdf/events';
    if (lid === 'euf') return '/euf/events';
    return `/scores${leagueQsFor(lid)}`;
  }

  // ── Row helpers ─────────────────────────────────────────────────────────
  // Nested league rows (inside the expanded "The League" section) — icon
  // tile + short label + full-name subtitle + trailing chevron.
  const subRowBase = [
    'flex items-center gap-3 w-full pl-3 pr-3.5 py-2.5',
    'min-h-[54px] text-left cursor-pointer rounded-lg',
    'transition-colors duration-150 no-underline',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
  ].join(' ');

  const pageRowBase = [
    'flex items-center w-full pl-9 pr-4',
    'min-h-[42px] text-left rounded-md',
    'text-[11px] font-semibold tracking-[0.1em] uppercase font-tight no-underline',
    'transition-colors duration-150',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
  ].join(' ');

  if (!mounted) return null;

  const panel = (
    // Backdrop — tap outside to close. overflow-hidden keeps the off-screen
    // (translate-x-full) closed panel from creating a horizontal scrollbar.
    <div
      className={[
        'fixed inset-0 z-[100] overflow-hidden',
        open ? 'pointer-events-auto' : 'pointer-events-none',
      ].join(' ')}
      aria-hidden={!open}
    >
      {/* Dim layer */}
      <div
        className={[
          'absolute inset-0 bg-black/50 transition-opacity',
          open ? 'opacity-100' : 'opacity-0',
          // Skip transition when reduced motion is preferred.
          'motion-reduce:transition-none',
        ].join(' ')}
        style={{ transitionDuration: '150ms' }}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel — two geometries by breakpoint:
          - MOBILE (<md): rolls DOWN from the top as a full-width dropdown
            sheet with a height cap + rounded bottom (translate-y animation).
          - DESKTOP (md+): the original right-anchored 360px side drawer
            sliding in from the right (translate-x animation). The league
            fly-out's md:right-[360px] positioning depends on this. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className={[
          // Mobile: full-screen sheet — always covers the whole viewport
          // regardless of how much content is expanded/collapsed.
          'absolute inset-0 w-full h-dvh max-h-dvh',
          // Desktop: right side drawer (original geometry). Right edge stays
          // flush to the viewport. The LEFT corners are the OUTER corners of the
          // whole popout — so they round on THIS panel only when no league
          // fly-out is open. When a fly-out IS open it sits to our left and owns
          // the outer rounded-left corners; our left edge must then go square so
          // the two panes seam flush (otherwise both are rounded and you see a
          // weird double-curve at the join). See the fly-out's matching radius.
          'md:inset-y-0 md:left-auto md:right-0 md:max-w-[360px] md:h-auto md:max-h-none',
          'md:rounded-r-none md:border-l',
          // Square our left corners only while the fly-out is actually visible
          // beside us (it renders under `gamesOpen && flyoutLeague`).
          gamesOpen && flyoutLeague ? 'md:rounded-l-none' : 'md:rounded-l-2xl',
          // Panel itself does NOT scroll — the <nav> below is the scroll region
          // (flex-1 min-h-0 overflow-y-auto). This keeps the header pinned at
          // the top and the AccountFooter frozen at the bottom, so neither
          // scrolls away when a league accordion expands and overflows.
          'flex flex-col bg-bg overflow-hidden shadow-2xl',
          // Mobile animates translate-y, desktop translate-x — both compose
          // into one transform, so the md: overrides neutralize the other axis.
          // Also transition border-radius so the left corners round/square
          // smoothly as the league fly-out opens/closes beside the panel.
          // Closed, it goes invisible once the slide ends: parked just off
          // screen, its shadow-2xl still bled into the top (phone) / right
          // (desktop) edge of every page.
          'transition-[transform,border-radius,visibility] motion-reduce:transition-none',
          open
            ? 'visible translate-y-0 translate-x-0'
            : 'invisible -translate-y-full md:translate-y-0 md:translate-x-full',
        ].join(' ')}
        style={{ transitionDuration: '240ms', transitionTimingFunction: 'ease-out' }}
      >
        {/* Faint top-right glow — kept very subtle (was a stronger accent wash)
            so the panel feels lit/smooth without an obvious orange cast. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-40"
          style={{
            background:
              'radial-gradient(120% 80% at 100% 0%, rgb(var(--accent) / 0.05), transparent 70%)',
          }}
        />

        {/* Header — logo + eyebrow, close button. */}
        <div className="relative flex items-center justify-between px-5 pt-5 pb-4 flex-shrink-0">
          <div className="flex flex-col gap-1.5">
            <LogoStrikeInline
              accentColor="rgb(var(--accent))"
              theme={theme === 'broadcast' ? 'dark' : 'light'}
              size={0.8}
            />
            <span className="text-[10px] font-bold tracking-[0.2em] uppercase font-tight text-faint">
              Menu · Index
            </span>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className={[
              'inline-flex items-center justify-center w-10 h-10 rounded-full self-start',
              'bg-surface border border-hairline text-muted',
              'hover:text-ink hover:border-ink transition-colors duration-150 cursor-pointer',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              '-mr-1',
            ].join(' ')}
          >
            <CloseIcon />
          </button>
        </div>

        {/* Nav list — the ONLY scrolling region (min-h-0 lets it shrink inside
            the flex column so overflow scrolls here, not the whole panel). */}
        <nav aria-label="Primary navigation" className="relative flex-1 min-h-0 overflow-y-auto px-3 pb-8 flex flex-col gap-1.5">

          {/* ── FOR YOU — first, shown when the user has a favorite team or
              player (resolved on session load so it doesn't render late).
              Gated by FOR_YOU_ENABLED (lib/for-you/leagues.ts). */}
          {FOR_YOU_ENABLED && hasFavorites && (
            <SubAppRow
              app="for-you"
              href="/for-you"
              label="For You"
              active={activeApp === 'for-you'}
              onClose={onClose}
            />
          )}

          {/* ── THE LEAGUE accordion row — large italic display heading,
              matching the other top-level rows below (Playbook/12-0/Fantasy).
              No icon tile, no leading number. ─────────────────────────── */}
          <button
            type="button"
            onClick={() =>
              setGamesOpen((v) => {
                const next = !v;
                // Collapsing "The League" also closes any open league fly-out —
                // otherwise the desktop sub-panel would linger beside a
                // collapsed accordion.
                if (!next) setFlyoutLeague(null);
                return next;
              })
            }
            aria-expanded={gamesOpen}
            className={[
              'group flex items-center justify-between gap-3 w-full px-2.5 py-3 rounded-xl text-left cursor-pointer',
              'transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              // Neutral highlight — soft surface tint, no orange wash.
              activeApp === 'games' || gamesOpen ? 'bg-surface' : 'hover:bg-surface',
            ].join(' ')}
          >
            <span className="font-display italic font-bold text-[28px] leading-[0.95] tracking-[-0.02em] text-ink">
              The League
            </span>
            <ChevronDown
              className={[
                'w-4 h-4 flex-shrink-0 transition-transform duration-200',
                gamesOpen ? 'rotate-180 text-ink' : 'text-faint',
              ].join(' ')}
            />
          </button>

          {/* THE LEAGUE expanded: league list. Each league is a FLY-OUT trigger
              — hover (desktop) or tap (mobile) opens the left panel showing that
              league's pages + team grid. Inset card w/ a left accent spine on
              the currently-open league. */}
          {gamesOpen && (
            <div className="mb-1 flex flex-col gap-0.5">
              {MEGA_LEAGUES.map((league) => {
                if (!league.real) {
                  return (
                    <div
                      key={league.id}
                      aria-disabled="true"
                      className={[subRowBase, 'text-faint cursor-not-allowed select-none'].join(' ')}
                    >
                      <LeagueMark label={league.label} img={league.img} />
                      <span className="flex-1 min-w-0 flex items-baseline gap-2">
                        <span className="text-[13px] font-bold font-tight">{league.label}</span>
                        <span className="text-[11px] text-faint font-tight truncate">{league.fullName}</span>
                      </span>
                      <sup className="text-[8px] font-bold tracking-[0.14em] text-faint leading-none ml-1">
                        SOON
                      </sup>
                    </div>
                  );
                }
                const isOpen = flyoutLeague === league.id;
                return (
                  <div key={league.id}>
                    <button
                      type="button"
                      aria-haspopup="menu"
                      aria-expanded={isOpen}
                      // Desktop: hover/focus opens the side fly-out. Mobile:
                      // tap toggles the inline sub-dropdown below this row.
                      // The hover/focus handlers MUST be desktop-gated —
                      // touch taps synthesize mouseenter+focus BEFORE click,
                      // so ungated they'd open the dropdown and the click's
                      // toggle would immediately close it again (tap = no-op).
                      onMouseEnter={() => { if (isDesktopViewport()) openFlyout(league.id); }}
                      onFocus={() => { if (isDesktopViewport()) openFlyout(league.id); }}
                      onClick={() => (isOpen ? setFlyoutLeague(null) : openFlyout(league.id))}
                      className={[
                        subRowBase,
                        isOpen ? 'bg-surface' : 'hover:bg-surface',
                        'w-full',
                      ].join(' ')}
                    >
                      <LeagueMark label={league.label} img={league.img} />
                      <span className="flex-1 min-w-0 flex items-baseline gap-2">
                        <span className="text-[13px] font-bold font-tight text-ink">
                          {league.label}
                        </span>
                        <span className="text-[11px] text-muted font-tight truncate">{league.fullName}</span>
                      </span>
                      {/* Desktop: left-pointing chevron — the fly-out opens to
                          the side. Mobile: down chevron that flips 180° when
                          expanded — the sub-dropdown opens BELOW this row. */}
                      <svg
                        className={[
                          'hidden md:block w-3 h-3 flex-shrink-0 transition-colors duration-150',
                          isOpen ? 'text-ink' : 'text-faint',
                        ].join(' ')}
                        viewBox="0 0 10 10"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path d="M6.5 2L3.5 5L6.5 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <ChevronDown
                        className={[
                          'md:hidden flex-shrink-0 transition-transform duration-200',
                          isOpen ? 'rotate-180 text-ink' : 'text-faint',
                        ].join(' ')}
                      />
                    </button>

                    {/* ── MOBILE inline sub-dropdown ──────────────────────
                        Renders directly beneath the row instead of the side
                        fly-out (which is desktop-only, see below). USAU gets
                        its own per-division accordion (UsauLevelAccordion,
                        no renderExtra — links only, no team grids on mobile);
                        every other league gets the shared LeagueFlyoutBody. */}
                    {isOpen && (
                      <div className="md:hidden pl-3 pr-2 pt-1 pb-3">
                        {/* "OPEN {LEAGUE} →" — jumps straight to the league's
                            main scores page, same href Scores below uses. */}
                        <div className="flex justify-end mb-2">
                          <Link
                            href={leagueHomeHrefFor(league.id)}
                            onClick={onClose}
                            className="inline-flex items-center gap-1 text-[10px] font-bold tracking-[0.14em] uppercase text-accent font-tight no-underline hover:opacity-80 transition-opacity duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
                          >
                            Open {league.label}
                            <span aria-hidden="true">→</span>
                          </Link>
                        </div>
                        {league.id === 'usau' ? (
                          // USAU keeps its existing structure on mobile —
                          // per-level links only, no team-grid renderExtra
                          // (unchanged from before this restyle).
                          <UsauLevelAccordion
                            pathname={pathname}
                            urlDivision={urlDivision}
                            expandedLevel={usauMobileExpandedLevel}
                            onToggleLevel={handleUsauMobileLevelToggle}
                            onClose={onClose}
                          />
                        ) : (
                          <>
                            <LeagueFlyoutBody
                              league={league.id}
                              pathname={pathname}
                              leagueQsFor={leagueQsFor}
                              onClose={onClose}
                              tabRowBase="grid grid-cols-4 gap-1.5 mb-3"
                              tabLinkBase={pillLinkBase}
                            />
                            {/* Team grid — same content the desktop fly-out
                                shows, restyled inline for the mobile sheet. */}
                            <LeagueTeamGrid
                              league={league.id}
                              onClose={onClose}
                              pul={{ teams: pulTeams, loading: pulLoading, error: pulError }}
                              wfdf={{ events: wfdfEvents, loading: wfdfLoading, error: wfdfError }}
                              euf={{ events: eufEvents, loading: eufLoading, error: eufError }}
                            />
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Divider between The League and the standalone sub-apps ── */}
          <div className="my-1.5 border-t border-hairline" aria-hidden="true" />

          {/* ── FANTASY ──────────────────────────────────────────────── */}
          <SubAppRow
            app="fantasy"
            href="/fantasy"
            label="Fantasy"
            active={activeApp === 'fantasy'}
            onClose={onClose}
          />

          {/* ── PLAYBOOK ─────────────────────────────────────────────── */}
          <SubAppRow
            app="playbook"
            href="/playbook"
            label="Playbook"
            active={activeApp === 'playbook'}
            onClose={onClose}
          />

          {/* ── MINI GAMES accordion (12-0 · UTCG) ───────────────────────
              An expandable group, same visual treatment as The League row.
              Collapsed by default unless the user is on one of the games. */}
          <button
            type="button"
            onClick={() => setMiniGamesOpen((v) => !v)}
            aria-expanded={miniGamesOpen}
            className={[
              'group flex items-center justify-between gap-3 w-full px-2.5 py-3 rounded-xl text-left cursor-pointer',
              'transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              activeApp === 'twelve-oh' || miniGamesOpen ? 'bg-surface' : 'hover:bg-surface',
            ].join(' ')}
          >
            <span className="font-display italic font-bold text-[28px] leading-[0.95] tracking-[-0.02em] text-ink">
              Mini Games
            </span>
            <ChevronDown
              className={[
                'w-4 h-4 flex-shrink-0 transition-transform duration-200',
                miniGamesOpen ? 'rotate-180 text-ink' : 'text-faint',
              ].join(' ')}
            />
          </button>

          {miniGamesOpen && (
            <div className="mb-1 flex flex-col gap-0.5">
              <MiniGameLink
                href="/12-0"
                label="12-0"
                blurb="Draft the perfect undefeated roster"
                active={pathname === '/12-0' || pathname.startsWith('/12-0/')}
                onClose={onClose}
              />
              <MiniGameLink
                href="/utcg"
                label="UTCG"
                blurb="Collect cards, open packs, build a squad"
                active={pathname === '/utcg' || pathname.startsWith('/utcg/')}
                onClose={onClose}
              />
            </div>
          )}

          {/* ── JERSEY EXCHANGE ──────────────────────────────────────────
              Community board for trading/selling real jerseys. Public to
              browse; posting and messaging need an account. */}
          <SubAppRow
            app="jerseys"
            href="/jerseys"
            label="Jersey Exchange"
            badge="NEW"
            active={pathname === '/jerseys' || pathname.startsWith('/jerseys/')}
            onClose={onClose}
          />

        </nav>

        {/* ── Account footer — persistent at the bottom of the drawer ── */}
        <AccountFooter onClose={onClose} />
      </div>

      {/* ── LEAGUE FLY-OUT — DESKTOP ONLY ───────────────────────────────────
          MOBILE (<md): no overlay — the league's pages render INLINE below
          the row it belongs to (see the sub-dropdown in the accordion above).
          DESKTOP (md+): sits just left of the 360px main drawer (360 + 340 =
          700px fits comfortably). Shows the previewed league's sub-pages +
          team grid — the old mega-menu content. For USAU, this is a SINGLE
          panel rendering UsauLevelAccordion (same component mobile uses) —
          all divisions collapsed on open; expandedLevel/onToggleLevel below
          are the desktop-specific accordion state. */}
      {gamesOpen && flyoutLeague && (
        <div
          role="menu"
          aria-label={`${MEGA_LEAGUES.find((l) => l.id === flyoutLeague)?.label ?? ''} navigation`}
          className={[
            'hidden md:flex md:flex-col bg-bg overflow-y-auto shadow-2xl',
            'absolute z-[1]',
            // Desktop: full-height column beside the right drawer (original).
            'md:inset-y-0 md:left-auto md:right-[360px] md:w-[340px] md:max-h-none',
            // Round the OUTER (left) corners to match the drawer's rounded left
            // edge — together the two panes read as one soft popout card. Inner
            // (right) edge stays square so the two panes seam flush.
            'md:rounded-l-2xl md:rounded-r-none md:border-b-0 md:border-l',
            'motion-reduce:animate-none',
          ].join(' ')}
          style={{ animation: 'gamesDropdownIn 160ms ease-out both' }}
        >
          <LeagueFlyout
            league={flyoutLeague}
            pathname={pathname}
            urlDivision={urlDivision}
            leagueQsFor={leagueQsFor}
            leagueHomeHrefFor={leagueHomeHrefFor}
            onBack={() => setFlyoutLeague(null)}
            onClose={onClose}
            usau={{ teams: usauTeams, loading: usauLoading, error: usauError }}
            usauCollege={{ teams: usauCollegeTeams, loading: usauCollegeLoading, error: usauCollegeError }}
            pul={{ teams: pulTeams, loading: pulLoading, error: pulError }}
            wfdf={{ events: wfdfEvents, loading: wfdfLoading, error: wfdfError }}
                              euf={{ events: eufEvents, loading: eufLoading, error: eufError }}
            expandedLevel={usauDesktopExpandedLevel}
            onToggleLevel={handleUsauDesktopLevelToggle}
          />
        </div>
      )}
    </div>
  );

  return createPortal(panel, document.body);
}
