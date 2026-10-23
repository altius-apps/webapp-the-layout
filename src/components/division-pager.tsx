'use client';

// DivisionPager (web) — segmented division control + touch-swipe paging
// between divisions. Web port of the mobile app's DivisionPager
// (Hunter, 2026-08-18): one rounded segmented box (raised chip = active
// division) sits BELOW the view tabs (screens render those above this
// component), and the division-scoped content swipes left/right on touch.
//
// LIVE PREVIEW WHILE DRAGGING: content renders through `renderDivision(value)`
// so the pager can mount the incoming division's REAL content beside the
// active one — no blank page tracking the finger. The prev/next neighbors are
// ALWAYS mounted (not on first drag movement — mounting mid-gesture cost a
// jank frame, Hunter 2026-08-19), parked off-screen at ±stride and riding the
// drag translation; a drag frame is then pure transform work, zero React
// mounting. On commit, the active/outgoing pair takes over as two live layers
// (outgoing keeps rendering the old division while it exits) and slides on a
// progress value; onChange fires at release so the incoming layer becomes the
// active render seamlessly. Mounting ceiling is active+2 neighbors — Worlds
// events field 10+ divisions, mounting all of them would be too heavy.
//
// STRIDE = clientWidth minus ONE gutter (contentWidth() below) — the same
// math as mobile's `width - gutterBleed`. Every side layer carries the
// identical px-5 gutter as the active layer, and every offset (park position
// + commit interpolation) uses this same stride, so a parked neighbor's cards
// sit exactly at the clip edge at rest (fully hidden) and the gap between two
// divisions' cards at any point mid-swipe equals the cards' own screen-edge
// margin (Hunter, 2026-08-20 — subtracting both gutters parked neighbors 20px
// too close: card slivers visible at rest, cards touching mid-swipe).
//
// Gesture negotiation mirrors the mobile component: only decisively-horizontal
// moves are claimed (vertical page scroll passes through untouched), and a
// touch that starts inside a horizontally-scrollable descendant (bracket
// trees) is left alone — swiping over a bracket pans the bracket.
//
// With 0–1 divisions it renders the single division bare: no tabs, no swipe.
//
// EACH DIVISION IS ITS OWN PAGE (Hunter, 2026-09-26): the active layer is
// keyed by division so a switch mounts the incoming division fresh — pool
// disclosures opened in Men don't arrive pre-opened in Women (same component
// tree + same "Pool A" keys otherwise carried the useState across) — and the
// scroll pane resets to the top, the same as loading the division's URL cold.

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface DivisionPagerOption<V extends string> {
  value: V;
  label: string;
  /** Screen-reader name; defaults to `${label} division`. For labels that
   *  don't read as a division name ("All" → "All divisions"). */
  ariaLabel?: string;
}

interface DivisionPagerProps<V extends string> {
  divisions: DivisionPagerOption<V>[];
  active: V | null;
  onChange: (v: V) => void;
  /** Renders one division's content. Called for the active division every
   *  render, and for the NEIGHBOR division while a swipe is in flight — must
   *  be pure-ish and cheap enough to mount mid-gesture. */
  renderDivision: (value: V) => ReactNode;
  /** Layout classes for the swiped content wrapper (e.g. "flex flex-col
   *  gap-8") — screens whose tab sections relied on the page root's flex gap
   *  pass it here, since the pager re-parents them. Applied to every layer
   *  (active/outgoing/incoming) so mid-slide layout matches. */
  contentClassName?: string;
  /** Rendered LEFT of the division control on the same row (the screen's
   *  view tabs — Pools/Bracket/Standings). With it, the control right-aligns
   *  and its scroller shrinks to the leftover width; without it, the control
   *  centers as before (Hunter's tournament-header layout, 2026-08-20). */
  tabRowLeading?: ReactNode;
  /** Rendered RIGHT of the division control on lg+ only (USAU event page's
   *  year picker, Hunter 2026-10-22). Passing it — even null — centers the
   *  control between the leading tabs and this slot on lg+. */
  tabRowTrailing?: ReactNode;
  /** Control-only headers (no tabRowLeading): stretch the control full width
   *  with equal segments, the same as the event pages' control under the view
   *  tabs on mobile widths — 16px above, 14px to the content. */
  fill?: boolean;
  /** false = tap-only: no swipe and no parked neighbor layers, so only the
   *  active division is ever rendered. For long public lists where mounting
   *  neighbors would double the page weight (Teams pages, Hunter 2026-10-06). */
  swipe?: boolean;
}

// Swipe must travel this fraction of the container (or flick faster than
// FLICK_VELOCITY, px/ms) to commit a division change; less springs back.
const COMMIT_FRACTION = 0.22;
const FLICK_VELOCITY = 0.3;
// Minimum travel before a fast flick counts — guards a jittery tap from
// registering as a page change.
const FLICK_MIN_TRAVEL = 16;
const SLIDE_MS = 280;
const EASE = 'cubic-bezier(0.33, 1, 0.68, 1)'; // ease-out cubic

// Slide/park distance ("stride") = clientWidth minus ONE gutter — the web
// equivalent of mobile's `width - gutterBleed`. The side layers span the full
// padding box (inset-x-0) and carry the same px-5 as the container, so a
// layer parked at ±(clientWidth − gutter) puts its cards exactly at the clip
// edge at rest (nothing peeks through the gutter) and one full gutter away
// from the active cards mid-swipe. Subtracting BOTH paddings parked neighbors
// a gutter short: card slivers visible at rest, zero gap mid-swipe.
function contentWidth(container: HTMLDivElement): number {
  const cs = getComputedStyle(container);
  return container.clientWidth - parseFloat(cs.paddingLeft);
}

/** True when the touch landed inside a descendant that scrolls horizontally
 *  itself (bracket trees) — that scroller owns the gesture. */
function insideHorizontalScroller(target: EventTarget | null, stop: HTMLElement): boolean {
  let el = target instanceof Element ? target : null;
  while (el && el !== stop) {
    if (el.scrollWidth > el.clientWidth + 1) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
    el = el.parentElement;
  }
  return false;
}

/**
 * Call from a view-tab click inside `tabRowLeading`: if the reader has scrolled
 * past the frozen header, bring the pane back so the new section starts right
 * under it — switching Pools → Bracket from the bottom of Pools used to land at
 * the bottom of Bracket (Hunter, 2026-10-03). Above that point, nothing moves.
 * The pane is PageShell's nested overflow-y-auto, same lookup as commitChange.
 */
export function scrollToSectionTop(fromTab: HTMLElement): void {
  const header = fromTab.closest('.sticky');
  const pane = fromTab.closest('.overflow-y-auto');
  const block = header?.parentElement;
  if (!pane || !block) return;
  const top = block.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
  if (pane.scrollTop > top) pane.scrollTop = top;
}

export function DivisionPager<V extends string>({
  divisions,
  active,
  onChange,
  renderDivision,
  contentClassName,
  tabRowLeading,
  tabRowTrailing,
  fill = false,
  swipe = true,
}: DivisionPagerProps<V>) {
  const centered = tabRowTrailing !== undefined;
  const trailing = tabRowTrailing != null && (
    <div className="hidden lg:flex lg:items-center lg:justify-end">{tabRowTrailing}</div>
  );
  // Optimistic active. Screens hold `active` in the URL (?div= via
  // useViewParam → router.replace), so the prop updates FRAMES after
  // onChange. Rendering from the prop alone painted the OLD division into
  // the incoming layer at release — the preview blipped to stale content,
  // then snapped back once the router caught up. `pending` is set
  // synchronously at commit and wins until the prop agrees.
  const [pending, setPending] = useState<V | null>(null);
  if (pending != null && pending === active) {
    setPending(null); // prop caught up — render-phase reset, same output
  }
  const pendingIndex = pending != null ? divisions.findIndex((d) => d.value === pending) : -1;
  const activeIndex =
    pendingIndex >= 0
      ? pendingIndex
      : Math.max(0, divisions.findIndex((d) => d.value === active));
  const count = divisions.length;
  const activeValue = divisions[activeIndex]?.value ?? active;

  const containerRef = useRef<HTMLDivElement>(null);

  const commitChange = (v: V) => {
    setPending(v);
    onChange(v);
    // The app scrolls in PageShell's nested overflow-y-auto pane, not the
    // body (router.replace's scroll option can't reach it) — find this
    // instance's own pane, same lookup as PageShell's StickyName.
    const pane = containerRef.current?.closest('.overflow-y-auto');
    if (pane) pane.scrollTop = 0;
  };
  const contentRef = useRef<HTMLDivElement>(null);
  const prevRef = useRef<HTMLDivElement>(null);
  const parkedPrevRef = useRef<HTMLDivElement>(null);
  const parkedNextRef = useRef<HTMLDivElement>(null);
  const tabRowRef = useRef<HTMLDivElement>(null);
  const tabFramesRef = useRef<Map<string, { offsetLeft: number; width: number }>>(new Map());

  // Latest values for the touch handlers without re-binding them mid-gesture.
  // onChange routes through commitChange so a swipe commit lands optimistically.
  const stateRef = useRef({ activeIndex, count, divisions, onChange: commitChange });
  stateRef.current = { activeIndex, count, divisions, onChange: commitChange };
  const renderRef = useRef(renderDivision);
  renderRef.current = renderDivision;

  const gestureRef = useRef<{
    startX: number;
    startY: number;
    lastX: number;
    lastT: number;
    vx: number;
    claimed: boolean;
    claimOffset: number;
    ignored: boolean;
  } | null>(null);
  const transitioningRef = useRef(false);
  const [transition, setTransition] = useState<{
    prevValue: V;
    dir: 1 | -1;
    fromDx: number;
  } | null>(null);

  // The parked neighbors are ALWAYS mounted (not spun up on first drag
  // movement) so a drag frame is pure transform work — see the header note.
  const prevIndex = swipe && activeIndex > 0 ? activeIndex - 1 : null;
  const nextIndex = swipe && activeIndex < count - 1 ? activeIndex + 1 : null;
  const parkedPrev = prevIndex != null ? divisions[prevIndex] : null;
  const parkedNext = nextIndex != null ? divisions[nextIndex] : null;

  // Park both neighbors at rest at ±stride, clearing any leftover transform.
  const parkNeighbors = () => {
    const container = containerRef.current;
    if (!container) return;
    const w = contentWidth(container);
    const p = parkedPrevRef.current;
    const n = parkedNextRef.current;
    if (p) {
      p.style.transition = 'none';
      p.style.transform = `translateX(${-w}px)`;
    }
    if (n) {
      n.style.transition = 'none';
      n.style.transform = `translateX(${w}px)`;
    }
  };

  // Re-park on active-division change AND when a commit transition ends. The
  // parked layers are unmounted for the whole transition, so the activeIndex
  // pass runs against null refs; when they remount on transition-end they'd
  // otherwise sit untransformed at translateX(0) — stacked directly over the
  // active division, painting the WRONG division's cards on top of it.
  useLayoutEffect(() => {
    parkNeighbors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, transition]);

  // Park offsets are px values measured at park time — a viewport resize (or
  // the lg breakpoint toggling the gutter) leaves them stale, pulling a
  // neighbor inside the clip where it renders as a phantom second division
  // on desktop. Re-measure whenever the container resizes at rest.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => {
      if (transitioningRef.current || gestureRef.current?.claimed) return;
      parkNeighbors();
    });
    ro.observe(container);
    return () => ro.disconnect();
    // count > 1 gates the container's existence — divisions arrive async, so
    // the observer must attach when the pager goes from bare to paged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count > 1]);

  // Runs the committed slide: both layers positioned from where the finger
  // left off, then transitioned — outgoing to off-screen, incoming to 0.
  useLayoutEffect(() => {
    if (!transition) return;
    const container = containerRef.current;
    const content = contentRef.current;
    const prev = prevRef.current;
    if (!container || !content || !prev) return;
    const w = contentWidth(container);
    const { dir, fromDx } = transition;
    content.style.transition = 'none';
    prev.style.transition = 'none';
    content.style.transform = `translateX(${fromDx + dir * w}px)`;
    prev.style.transform = `translateX(${fromDx}px)`;
    void content.offsetHeight; // commit start positions before arming the transition
    content.style.transition = `transform ${SLIDE_MS}ms ${EASE}`;
    prev.style.transition = `transform ${SLIDE_MS}ms ${EASE}`;
    content.style.transform = 'translateX(0px)';
    prev.style.transform = `translateX(${-dir * w}px)`;
    const done = window.setTimeout(() => {
      content.style.transition = '';
      content.style.transform = '';
      transitioningRef.current = false;
      setTransition(null);
    }, SLIDE_MS + 40);
    return () => window.clearTimeout(done);
  }, [transition]);

  // Keep the active tab on-screen when it changes (swipe can select a tab
  // that's scrolled out of the row's viewport).
  useEffect(() => {
    const row = tabRowRef.current;
    const frame = activeValue != null ? tabFramesRef.current.get(String(activeValue)) : null;
    if (!row || !frame) return;
    const target = frame.offsetLeft + frame.width / 2 - row.clientWidth / 2;
    row.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
  }, [activeValue]);

  const springBack = () => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    const w = contentWidth(container);
    const p = parkedPrevRef.current;
    const n = parkedNextRef.current;
    content.style.transition = `transform 200ms ${EASE}`;
    content.style.transform = 'translateX(0px)';
    if (p) {
      p.style.transition = `transform 200ms ${EASE}`;
      p.style.transform = `translateX(${-w}px)`;
    }
    if (n) {
      n.style.transition = `transform 200ms ${EASE}`;
      n.style.transform = `translateX(${w}px)`;
    }
    window.setTimeout(() => {
      content.style.transition = '';
      content.style.transform = '';
      if (p) {
        p.style.transition = '';
        p.style.transform = `translateX(${-w}px)`;
      }
      if (n) {
        n.style.transition = '';
        n.style.transform = `translateX(${w}px)`;
      }
    }, 240);
  };

  const onTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!swipe || !container || transitioningRef.current || stateRef.current.count <= 1) return;
    const t = e.touches[0];
    gestureRef.current = {
      startX: t.clientX,
      startY: t.clientY,
      lastX: t.clientX,
      lastT: e.timeStamp,
      vx: 0,
      claimed: false,
      claimOffset: 0,
      ignored: insideHorizontalScroller(e.target, container),
    };
  };

  const onTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    const content = contentRef.current;
    if (!g || g.ignored || !content) return;
    const t = e.touches[0];
    const dx = t.clientX - g.startX;
    const dy = t.clientY - g.startY;
    if (!g.claimed) {
      // Vertical-dominant movement hands the gesture to the page scroll for good.
      if (Math.abs(dy) > 14 && Math.abs(dy) >= Math.abs(dx)) {
        g.ignored = true;
        return;
      }
      // Any decisively horizontal move claims the gesture — requiring a 1.6×
      // horizontal bias meant a natural, slightly-diagonal thumb swipe never
      // registered (Hunter, 2026-08-18).
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
        g.claimed = true;
        // Measure from the claim point so content doesn't jump on frame one.
        g.claimOffset = dx;
        content.style.transition = 'none';
      } else {
        return;
      }
    }
    const dt = e.timeStamp - g.lastT;
    if (dt > 0) g.vx = (t.clientX - g.lastX) / dt;
    g.lastX = t.clientX;
    g.lastT = e.timeStamp;
    const { activeIndex: i, count: n } = stateRef.current;
    let visual = dx - g.claimOffset;
    // Rubber-band past the first/last division — nothing parked past the end.
    const atStart = i === 0 && visual > 0;
    const atEnd = i === n - 1 && visual < 0;
    if (atStart || atEnd) visual /= 3;
    content.style.transform = `translateX(${visual}px)`;
    // Both parked neighbors ride the same drag translation every frame —
    // pure transform work, no React mount/unmount mid-gesture.
    const container = containerRef.current;
    if (container) {
      const w = contentWidth(container);
      const p = parkedPrevRef.current;
      const nEl = parkedNextRef.current;
      if (p) {
        p.style.transition = 'none';
        p.style.transform = `translateX(${visual - w}px)`;
      }
      if (nEl) {
        nEl.style.transition = 'none';
        nEl.style.transform = `translateX(${visual + w}px)`;
      }
    }
  };

  const onTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    const container = containerRef.current;
    if (!g || !g.claimed || !container) return;
    const { activeIndex: i, count: n, divisions: divs, onChange: change } = stateRef.current;
    const t = e.changedTouches[0];
    const dx = t.clientX - g.startX;
    const w = contentWidth(container);
    const commit = w * COMMIT_FRACTION;
    const goNext =
      i < n - 1 && (dx < -commit || (dx < -FLICK_MIN_TRAVEL && g.vx < -FLICK_VELOCITY));
    const goPrev = i > 0 && (dx > commit || (dx > FLICK_MIN_TRAVEL && g.vx > FLICK_VELOCITY));
    const dir = goNext ? 1 : goPrev ? -1 : 0;
    if (dir === 0) {
      springBack();
      return;
    }
    transitioningRef.current = true;
    setTransition({ prevValue: divs[i].value, dir, fromDx: dx - g.claimOffset });
    change(divs[i + dir].value);
  };

  const onTouchCancel = () => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (g?.claimed) springBack();
  };

  if (count <= 1) {
    const only = activeValue ?? divisions[0]?.value;
    if (only == null) return null;
    // Single division: no segmented control, but the leading view tabs still
    // belong on the page. Same frozen-header treatment as the paged branch.
    if (tabRowLeading == null) return <>{renderRef.current(only)}</>;
    return (
      <div className="flex flex-col">
        <div className="sticky top-0 z-30 bg-bg pt-4 pb-4 lg:flex lg:items-center lg:justify-between lg:gap-3">
          {tabRowLeading}
          {trailing}
        </div>
        {renderRef.current(only)}
      </div>
    );
  }

  // Segmented control — one rounded box, active division a raised chip
  // inside it. Horizontal-scrolls (never wraps) when 10+ divisions overflow.
  // With a leading view-tabs slot: full-width on its own line under the tabs
  // on mobile (the shared row overflowed the screen — Hunter, 2026-08-20),
  // right-aligned beside them on lg+. Centered on its own row otherwise.
  const stretch = tabRowLeading != null || fill;
  const segmentScroller = (
      <div
        ref={tabRowRef}
        className={[
          'flex overflow-x-auto scrollbar-none',
          tabRowLeading != null
            ? centered
              ? 'min-w-0 w-full lg:w-auto lg:justify-center'
              : 'min-w-0 w-full lg:w-auto lg:flex-1 lg:justify-end'
            : fill
              ? 'min-w-0 w-full'
              : 'justify-center pb-2',
        ].join(' ')}
      >
        <div
          className={[
            'inline-flex items-center gap-0.5 p-[3px] rounded-card bg-ink/5 flex-shrink-0',
            stretch ? 'min-w-full lg:min-w-0' : '',
          ].join(' ')}
        >
          {divisions.map((d, i) => {
            const isActive = i === activeIndex;
            return (
              <button
                key={d.value}
                ref={(el) => {
                  if (el) {
                    tabFramesRef.current.set(String(d.value), {
                      offsetLeft: el.offsetLeft,
                      width: el.offsetWidth,
                    });
                  }
                }}
                type="button"
                onClick={() => {
                  if (i !== activeIndex) commitChange(d.value);
                }}
                role="tab"
                aria-selected={isActive}
                aria-label={d.ariaLabel ?? `${d.label} division`}
                className={[
                  'px-3.5 py-[5px] rounded-[15px] whitespace-nowrap',
                  'text-[11px] font-bold tracking-[0.06em] uppercase font-tight',
                  'transition-colors cursor-pointer',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  stretch ? 'flex-1 lg:flex-none' : '',
                  isActive ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink',
                ].join(' ')}
              >
                {d.label}
              </button>
            );
          })}
        </div>
      </div>
  );

  return (
    // The view-tab + division-control header is FROZEN: sticky against the
    // scroll pane so the reader always sees where they are and can switch
    // section/division from anywhere down the page (Hunter, 2026-08-21).
    // Solid bg-bg so content slides under it cleanly; the old parent gap-2.5
    // moved into the header's own padding — a transparent gap strip below the
    // stuck header would show cards scrolling through it.
    <div className="flex flex-col">
      {tabRowLeading != null ? (
        <div
          className={[
            'sticky top-0 z-30 bg-bg flex flex-col gap-3.5 pt-4 pb-4 lg:items-center lg:gap-3',
            // Equal 1fr side columns keep the control dead-center on the row.
            centered ? 'lg:grid lg:grid-cols-[1fr_auto_1fr]' : 'lg:flex-row lg:justify-between',
          ].join(' ')}
        >
          <div className="shrink-0">{tabRowLeading}</div>
          {segmentScroller}
          {trailing}
        </div>
      ) : (
        <div
          className={['sticky top-0 z-30 bg-bg pt-4', fill ? 'pb-3.5' : 'pb-2.5'].join(' ')}
        >
          {segmentScroller}
        </div>
      )}

      {/* Edge-bleed the TOUCH surface, not the layout: PageShell's px-5 gutter
          left 20px dead strips down both screen edges where a swipe that
          started there never reached this handler at all (Hunter, 2026-08-18).
          The negative margin + equal padding cancel out, so content sits
          exactly where it did — same trick the view-tab rows use. Desktop
          (lg) keeps its own gutter, where there's no touch to catch. */}
      <div
        ref={containerRef}
        className="relative overflow-hidden -mx-5 px-5 lg:mx-0 lg:px-0"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
      >
        <div ref={contentRef} className={['will-change-transform', contentClassName ?? ''].join(' ')}>
          {/* Keyed by division so a switch remounts the content fresh (see
              header note) — the wrapper div above stays put for contentRef. */}
          {activeValue != null ? (
            <Fragment key={String(activeValue)}>{renderRef.current(activeValue)}</Fragment>
          ) : null}
        </div>

        {/* Outgoing division during the commit slide — LIVE render, not a
            snapshot, so scores/skeletons keep painting on the way out. */}
        {transition && (
          <div
            ref={prevRef}
            className={[
              // inset-x-0 resolves against the PADDING box, so this layer must
              // carry the same px-5 as the container or it renders 40px wider
              // than the live content and shifts mid-slide.
              'absolute inset-x-0 top-0 px-5 lg:px-0 pointer-events-none will-change-transform',
              contentClassName ?? '',
            ].join(' ')}
            aria-hidden
          >
            {renderRef.current(transition.prevValue)}
          </div>
        )}

        {/* Parked neighbors — ALWAYS mounted (see header note), riding the
            drag transform every frame so a swipe never has to spin up React
            mid-gesture. Same px-5 gutter as the active layer so the gap
            between two divisions' cards at any point equals the page's own
            edge margin, not zero. Hidden while the commit transition owns
            the prev/content pair above (transition already carries the
            outgoing division; showing both would double-render it). */}
        {!transition && parkedPrev && (
          <div
            ref={parkedPrevRef}
            className={[
              'absolute inset-x-0 top-0 px-5 lg:px-0 pointer-events-none will-change-transform',
              contentClassName ?? '',
            ].join(' ')}
            aria-hidden
          >
            {renderRef.current(parkedPrev.value)}
          </div>
        )}
        {!transition && parkedNext && (
          <div
            ref={parkedNextRef}
            className={[
              'absolute inset-x-0 top-0 px-5 lg:px-0 pointer-events-none will-change-transform',
              contentClassName ?? '',
            ].join(' ')}
            aria-hidden
          >
            {renderRef.current(parkedNext.value)}
          </div>
        )}
      </div>
    </div>
  );
}
