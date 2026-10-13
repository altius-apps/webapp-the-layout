'use client';

// Unified page chrome for every non-home route — single layout regardless of
// theme. The light/dark toggle swaps CSS variables only, not the layout itself.
//
// Desktop (lg+): AppRail (52px, top — now carries the Scores/Schedule/Teams/
//   Players page-switcher pills, centered in the rail, plus the league slot
//   in its right-hand zone) + main column, full-width (no sidebar, no
//   second bar — the old below-rail GamesSubnav is gone).
// Mobile (<lg): AppRail (top, carries league switcher via gamesSlotMobile) + content + MobileBottomNav.
//   The league pill lives IN the AppRail on mobile — no separate below-rail strip.

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { usePaneScrollRestoration, previousUrl } from '@/lib/nav-history';
import { AppRail } from '@/components/app-rail';
import { SectionNavForRoute } from '@/components/games-subnav';
import { Breadcrumbs, type Crumb } from '@/components/breadcrumbs';
import { SiteFooter } from '@/components/site-footer';
import { isDraftRoomPath } from '@/lib/fantasy/draft-route';

// Hooks like useSearchParams() must be wrapped in Suspense for Next 14
// static prerendering — otherwise the whole tree falls back to CSR and
// the build errors out. We use empty fallbacks since the chrome is
// always interactive and these never block first paint meaningfully.
const SUSPENSE_FALLBACK = null;

interface AppShellProps {
  /** Optional content for the slim top bar's right edge. The in-page league
   * switcher was retired (league switching lives in the AppRail mega-menu), so
   * this defaults to empty; pass a node only if a page needs its own control. */
  topNavSlot?: React.ReactNode;
  /** Hide the SiteFooter on mobile (<lg) only. Desktop keeps it. Fantasy uses
   *  this — its own bottom nav + tall content leave no room for the footer on
   *  a phone, and it reads as clutter there. */
  hideFooterMobile?: boolean;
  children: React.ReactNode;
}

/**
 * Lean wrapper used directly by pages that render their own hero/header
 * (FeedPage, GameDetail). Pages that want the standard title/eyebrow row
 * should use `PageShell` instead — it composes AppShell + PageHeader.
 */
export function AppShell({ topNavSlot, hideFooterMobile, children }: AppShellProps) {
  // The in-page league switcher has been retired — league switching now lives
  // in the "The League" mega-menu in the top AppRail, so showing pills/dropdown
  // here too is redundant. We only render a top-nav slot when a page explicitly
  // passes one (some pages still use it for their own controls, e.g. an empty
  // span to hide the switcher on /players/[id]). With no slot, AppRail's
  // GamesLeagueSlot renders nothing and only the page-switcher pills show.
  const tab = topNavSlot ? (
    <Suspense fallback={SUSPENSE_FALLBACK}>{topNavSlot}</Suspense>
  ) : null;

  // Mobile mirrors desktop: only a caller-provided slot renders; no default
  // league dropdown.
  const mobileTab = topNavSlot ? (
    <Suspense fallback={SUSPENSE_FALLBACK}>{topNavSlot}</Suspense>
  ) : null;

  // The app scrolls in this nested pane, not the body, so browser scroll
  // restoration never applies — back-nav landed at the top of every page.
  // This saves/restores the pane's position across back/forward.
  const paneRef = useRef<HTMLElement>(null);
  usePaneScrollRestoration(paneRef, 'pane');
  const showFooter = !isDraftRoomPath(usePathname() ?? '');

  return (
    // h-screen + flex-col: AppRail (flex-shrink-0, now the only chrome bar)
    // then the content area gets the remaining height via flex-1.
    <div className="h-screen bg-bg text-ink flex flex-col">
      {/* Global top app rail — present on every breakpoint. AppRail always
          renders the Scores/Schedule/Teams/Players page-switcher pills
          (centered, self-gating) on lg+; gamesSlot threads this page's
          resolved league-slot node into the rail's right-hand zone —
          replaces the old below-rail GamesSubnav bar entirely.
          gamesSlotMobile threads the mobile league control into the rail on <lg. */}
      <AppRail
        gamesSlot={tab}
        gamesSlotMobile={mobileTab}
      />

      {/* ── Second nav (SectionNav) — page/section-specific tabs directly under
          the rail, above content. Replaces the section-switching role the
          bottom bar used to play. Left-aligned scrollable row on mobile;
          CENTERED under the rail on desktop (where there's no bottom bar).
          Renders nothing on pages with no section nav. Sits OUTSIDE the scroll
          panes so it stays pinned under the rail. ── */}
      <SectionNavForRoute />

      {/* ── One scroll pane for every breakpoint, so `children` mount ONCE.
          (It used to be a phone pane plus a desktop pane, which mounted every
          page twice: doubled fetches, racing inserts, and a second realtime
          subscribe that cut the visible copy's channel.)
          Phones (<lg): SiteFooter scrolls up from below the content and sits
          above the bottom nav's reserved space. The bar is flat and
          edge-to-edge: 58px of tabs on top of the safe-area inset, so
          clearance is exactly that plus a little breathing room.
          Desktop (lg+): no sidebar and no bottom bar, so content goes
          full-width and the footer sits at the bottom of short pages. ── */}
      <main
        ref={paneRef}
        className="flex-1 min-h-0 overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+70px)] lg:flex lg:flex-col lg:pb-14"
      >
        <div className="lg:flex-1">{children}</div>
        {showFooter && (
          <div className={hideFooterMobile ? 'hidden lg:block' : undefined}>
            <SiteFooter />
          </div>
        )}
      </main>

      {/* The global static bottom bar (MobileBottomNav) is mounted ONCE at the
          root layout now (app/layout.tsx), so it's app-wide regardless of shell
          and its fixed positioning resolves against the viewport. Not rendered
          here anymore. */}
    </div>
  );
}

interface PageShellProps {
  /** Big page title shown above content. */
  title: string;
  /** Title scale. 'default' is the 36/56px editorial size every page uses;
   *  'compact' (28px) is for hub pages whose content is a dense list and where
   *  the full-size title dwarfs it. Opt-in — omitting it changes nothing. */
  titleSize?: 'default' | 'compact';
  /** Short caption between the title and content. */
  subtitle?: string;
  /** Small uppercase eyebrow above the title (e.g., "UFA · 2026 Season"). */
  eyebrow?: string;
  /** Optional right-side controls in the page header (filter dropdowns, year selector, etc.). */
  controls?: React.ReactNode;
  /** Optional mark rendered left of the big title on the same row (e.g. the
   *  WFDF event logo). Mirrors the mobile app's PageShell `titleLeft`. */
  titleLeft?: React.ReactNode;
  /** Optional content for the top-bar slot. Empty by default (the league
   *  switcher was retired — see AppShell). */
  topNavSlot?: React.ReactNode;
  /** Optional breadcrumb trail rendered above the title. Shallowest first;
   *  last entry is the current page (rendered as plain text). */
  breadcrumbs?: Crumb[];
  /** Custom node rendered in the breadcrumb position INSTEAD of `breadcrumbs`
   *  (e.g. a client component that adjusts the back link from a search param
   *  without making the page dynamic). Wins over `breadcrumbs` when both set. */
  breadcrumbsSlot?: React.ReactNode;
  /** When set, a slim name bar sticks to the top on mobile once the page's
   *  big <h1> title scrolls out of view — so long stat tables (player
   *  profiles) never lose their "whose stats are these" context. Desktop
   *  is unaffected (plenty of vertical space there already). */
  stickyName?: string;
  /** Hide the SiteFooter on mobile (<lg) only; desktop keeps it. See AppShell. */
  hideFooterMobile?: boolean;
  /** Wider content cap for dashboard/bento layouts (e.g. For You) that need more
   *  horizontal room than the default reading width. */
  wide?: boolean;
  /** Mobile-only: collapse the breadcrumb + big italic <h1> block into a single
   *  compact row (back chevron + title + `controls` inline, e.g. a year pill).
   *  Desktop is unaffected — it keeps the standard breadcrumb/title stack.
   *  Needs `breadcrumbs` (for the back target) to render the chevron. */
  compactHeaderMobile?: boolean;
  children: React.ReactNode;
}

export function PageShell({
  title,
  subtitle,
  eyebrow,
  controls,
  titleLeft,
  titleSize,
  topNavSlot,
  breadcrumbs,
  breadcrumbsSlot,
  stickyName,
  hideFooterMobile,
  wide,
  compactHeaderMobile,
  children,
}: PageShellProps) {
  return (
    <AppShell topNavSlot={topNavSlot} hideFooterMobile={hideFooterMobile}>
      <div className={[
        'px-5 pt-4 pb-12 lg:pt-8 lg:pb-14 lg:mx-auto',
        wide ? 'lg:px-10 xl:px-8 lg:max-w-[1320px]' : 'lg:px-14 lg:max-w-[1080px]',
      ].join(' ')}>
        {stickyName && <StickyName name={stickyName} />}

        {/* Compact mobile header — back chevron + title + controls in one row.
            Desktop keeps the standard breadcrumb/eyebrow/h1 stack unchanged. */}
        {compactHeaderMobile && (
          <div className="lg:hidden">
            <CompactHeader title={title} breadcrumbs={breadcrumbs} controls={controls} />
          </div>
        )}

        <div className={compactHeaderMobile ? 'hidden lg:block' : undefined}>
          {breadcrumbsSlot ??
            (breadcrumbs && breadcrumbs.length > 0 && <Breadcrumbs crumbs={breadcrumbs} />)}
          <PageHeader
            title={title}
            subtitle={subtitle}
            eyebrow={eyebrow}
            titleLeft={titleLeft}
            titleSize={titleSize}
            controls={controls}
          />
        </div>

        {stickyName && <StickySentinel />}
        {children}
      </div>
    </AppShell>
  );
}

// The bar finds its sentinel and scroll pane from its own DOM position, so it
// needs no ref threaded through PageShell.
const STICKY_NAME_ID = 'page-shell-sticky-sentinel';

function StickySentinel() {
  return <div id={STICKY_NAME_ID} aria-hidden="true" />;
}

function StickyName({ name }: { name: string }) {
  const [titleVisible, setTitleVisible] = useState(true);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    // The sentinel is a sibling further down this same subtree.
    const el = bar.parentElement?.querySelector<HTMLDivElement>(`#${STICKY_NAME_ID}`);
    if (!el) return;
    const root = bar.closest('.overflow-y-auto');
    const observer = new IntersectionObserver(([entry]) => setTitleVisible(entry.isIntersecting), {
      root,
      // Fires as soon as the title scrolls out of the pane. The AppRail sits
      // OUTSIDE this scroll pane, so no rail-height offset — a -52px margin
      // here (and top-[52px] on the bar) left the bar stuck 52px below the
      // pane top, floating mid-screen over content.
      rootMargin: '0px',
      threshold: 0,
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    // ZERO-HEIGHT sticky wrapper — the bar must never take layout space. The
    // old max-height 0→44px animation grew the page under the reader's thumb:
    // expanding pushed the sentinel back into view, which collapsed the bar,
    // which pulled the sentinel out again — an oscillating half-faded bar
    // whenever you rested just past the name (Hunter, 2026-08-20). The bar now
    // overlays via a 0-height sticky anchor and animates transform/opacity
    // only, so toggling can't move the sentinel.
    <div
      ref={barRef}
      aria-hidden={titleVisible}
      className="sticky top-0 z-40 h-0 lg:hidden"
    >
      <div
        className={[
          'bg-bg/95 backdrop-blur shadow-soft',
          'transition-[transform,opacity] duration-150',
          titleVisible ? '-translate-y-full opacity-0 pointer-events-none' : 'translate-y-0 opacity-100',
        ].join(' ')}
      >
        <span className="block px-5 py-2.5 font-tight text-[15px] font-bold tracking-[-0.01em] text-ink truncate">
          {name}
        </span>
      </div>
    </div>
  );
}

function PageHeader({
  title,
  subtitle,
  eyebrow,
  titleLeft,
  titleSize,
  controls,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  titleLeft?: React.ReactNode;
  titleSize?: 'default' | 'compact';
  controls?: React.ReactNode;
}) {
  const h1 = (
    <h1
      className={[
        'm-0 font-display italic font-bold tracking-[-0.02em] leading-[0.95] text-ink',
        titleSize === 'compact' ? 'text-[28px]' : 'text-[36px] lg:text-[56px]',
      ].join(' ')}
    >
      {title}
    </h1>
  );
  return (
    <div className="flex flex-wrap items-end justify-between gap-6 mb-5 lg:mb-7">
      <div className="min-w-0">
        {eyebrow && (
          <div className="text-[10.5px] font-bold tracking-[0.18em] uppercase text-accent mb-2 font-sans">
            {eyebrow}
          </div>
        )}
        {titleLeft ? (
          <div className="flex items-center gap-3 lg:gap-4 min-w-0">
            {titleLeft}
            {h1}
          </div>
        ) : (
          h1
        )}
        {subtitle && (
          <p className="text-muted font-medium font-tight mt-2 text-[13px] lg:text-[15px]">
            {subtitle}
          </p>
        )}
      </div>
      {controls && <div className="flex items-center gap-3 flex-wrap">{controls}</div>}
    </div>
  );
}

// ── Compact mobile header (opt-in via PageShell `compactHeaderMobile`) ──────
//
// Collapses the breadcrumb + big italic <h1> stack into one row: back
// chevron, page title (truncates), and `controls` (e.g. a year pill)
// right-aligned. Reuses Breadcrumbs' smart-back logic (pop real history when
// it leads back to the same parent; otherwise a plain link) so behavior
// matches the desktop breadcrumb exactly — only the presentation differs.
function CompactHeader({
  title,
  breadcrumbs,
  controls,
}: {
  title: string;
  breadcrumbs?: Crumb[];
  controls?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();

  const parent = breadcrumbs && breadcrumbs.length >= 2 ? breadcrumbs[breadcrumbs.length - 2] : null;
  const href = parent?.href;

  return (
    <div className="flex items-center gap-2 mb-4 min-w-0">
      {href && (
        <Link
          href={href}
          onClick={(e) => {
            if (previousUrl(pathname) != null) {
              e.preventDefault();
              router.back();
            }
          }}
          aria-label={`Back to ${parent.label}`}
          className="flex-shrink-0 -ml-1.5 p-1.5 text-ink hover:text-accent transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
        >
          <svg width="18" height="18" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 2L4 7l5 5" />
          </svg>
        </Link>
      )}
      <h1 className="min-w-0 flex-1 truncate m-0 font-display italic text-[19px] font-bold tracking-[-0.01em] text-ink">
        {title}
      </h1>
      {controls && <div className="flex-shrink-0 flex items-center gap-2">{controls}</div>}
    </div>
  );
}
