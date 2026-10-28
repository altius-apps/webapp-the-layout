'use client';

// Home "Standout Performances" — a rotating carousel of the best individual
// player stat-lines from recent games (see lib/home/standouts.ts for selection).
// A horizontal scroll-snap rail that auto-advances one card at a time, pauses on
// hover/focus, and respects prefers-reduced-motion. Shows ~1.2 cards on mobile
// up to ~4 on wide screens; arrows (desktop) + dots for manual control.
//
// UFA lines carry a headshot; cards without one show no portrait at all. Each
// card links to the player's profile when we could resolve an id.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { StandoutLine, AwardWatch } from '@/lib/home/standouts';

const LEAGUE_LABEL: Record<StandoutLine['league'], string> = {
  ufa: 'UFA',
  pul: 'PUL',
  wul: 'WUL',
  usau: 'USAU',
};

const AWARD_LABEL: Record<AwardWatch, string> = {
  MVP: 'MVP Watch',
  OPOY: 'OPOY Watch',
  DPOY: 'DPOY Watch',
  ROY: 'ROY Watch',
};

export function StandoutsCarousel({ lines }: { lines: StandoutLine[] }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = lines.length;

  const prefersReducedRef = useRef(false);
  useEffect(() => {
    prefersReducedRef.current =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  // Scroll a given card index into view (snap start).
  const scrollTo = useCallback((i: number) => {
    const track = trackRef.current;
    if (!track) return;
    const child = track.children[i] as HTMLElement | undefined;
    if (child) {
      track.scrollTo({ left: child.offsetLeft - track.offsetLeft, behavior: 'smooth' });
    }
  }, []);

  const go = useCallback(
    (i: number) => {
      const next = ((i % count) + count) % count;
      setActive(next);
      scrollTo(next);
    },
    [count, scrollTo],
  );

  // Auto-advance.
  useEffect(() => {
    if (count <= 1 || paused || prefersReducedRef.current) return;
    const t = setInterval(() => {
      setActive((a) => {
        const n = (a + 1) % count;
        scrollTo(n);
        return n;
      });
    }, 4200);
    return () => clearInterval(t);
  }, [count, paused, scrollTo]);

  // Keep the active dot in sync when the user scrolls/swipes manually.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const children = Array.from(track.children) as HTMLElement[];
        const left = track.scrollLeft + track.offsetLeft;
        let nearest = 0;
        let best = Infinity;
        children.forEach((c, i) => {
          const d = Math.abs(c.offsetLeft - left);
          if (d < best) { best = d; nearest = i; }
        });
        setActive(nearest);
      });
    };
    track.addEventListener('scroll', onScroll, { passive: true });
    return () => track.removeEventListener('scroll', onScroll);
  }, []);

  if (count === 0) return null;

  // The per-card league label only earns its place when the rail mixes
  // leagues (PUL + WUL in May); a single-league rail read as "UFA-branded"
  // (Hunter, 2026-09-11).
  const mixedLeagues = new Set(lines.map((l) => l.league)).size > 1;

  return (
    <div
      className="relative"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div
        ref={trackRef}
        className="flex gap-4 overflow-x-auto snap-x snap-mandatory no-scrollbar pb-1"
        role="list"
        aria-label="Standout performances"
      >
        {lines.map((line) => (
          <div
            key={line.id}
            role="listitem"
            // Mobile: one full-width card, centered (matches the other full-width
            // cards on the page — no peeking neighbor). sm+: multi-up with a peek.
            className="snap-center sm:snap-start shrink-0 w-full sm:w-[46%] lg:w-[31%] xl:w-[23.5%]"
          >
            <StandoutCard line={line} showLeague={mixedLeagues} />
          </div>
        ))}
      </div>

      {count > 1 && (
        <>
          {/* Arrows — desktop only */}
          <div className="hidden lg:block">
            <RailArrow side="left" onClick={() => go(active - 1)} />
            <RailArrow side="right" onClick={() => go(active + 1)} />
          </div>

          {/* Dots */}
          <div className="mt-3 flex items-center justify-center gap-2" role="tablist" aria-label="Standouts">
            {lines.map((l, i) => (
              <button
                key={l.id}
                role="tab"
                aria-selected={i === active}
                aria-label={`Go to standout ${i + 1}`}
                onClick={() => go(i)}
                className={[
                  'rounded-full transition-all duration-300 cursor-pointer',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  i === active ? 'w-[22px] h-[7px] bg-ink' : 'w-[7px] h-[7px] bg-ink/25 hover:bg-ink/45',
                ].join(' ')}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Card ───────────────────────────────────────────────────────────────────────

function StandoutCard({ line, showLeague }: { line: StandoutLine; showLeague: boolean }) {
  const inner = (
    <>
      {/* Faint accent wash + header: portrait, name, league/date */}
      <div className="relative flex items-start gap-3.5 px-5 pt-5 pb-4">
        {/* Portrait only when we have a headshot — no placeholder circle. */}
        {line.headshotUrl && (
          <span className="shrink-0 w-14 h-14 rounded-full overflow-hidden bg-ink/5 ring-1 ring-hairline">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={line.headshotUrl} alt={line.playerName} className="w-full h-full object-cover" loading="lazy" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 flex-wrap">
            {showLeague && (
              <span className="text-[9px] font-bold tracking-[0.14em] uppercase font-tight text-accent">
                {LEAGUE_LABEL[line.league]}
              </span>
            )}
            <span className="text-[9px] font-semibold tracking-[0.04em] uppercase font-tight text-faint truncate max-w-[160px]">
              {line.dateLabel}
              {line.opponent && <span className="normal-case tracking-normal"> · vs {line.opponent}</span>}
            </span>
            {line.awardWatch && <WatchTag award={line.awardWatch} />}
            {line.callahan && <CallahanTag />}
          </span>
          <span className="block font-tight font-bold text-[16px] leading-tight text-ink truncate mt-1 group-hover:text-accent transition-colors">
            {line.playerName}
          </span>
          {line.teamName && (
            <span className="block text-[11.5px] font-medium text-muted font-tight truncate mt-0.5">
              {line.teamName}
            </span>
          )}
        </span>
      </div>

      {/* Stat tiles */}
      <div className="relative px-5 pb-5 pt-1">
        <div className="grid grid-cols-4 gap-2">
          {line.stats.slice(0, 4).map((s) => (
            <StatTile key={s.label} label={s.label} value={s.value} />
          ))}
        </div>
        {line.stats.length > 4 && (
          <div className="grid grid-cols-2 gap-2 mt-2">
            {line.stats.slice(4).map((s) => (
              <StatTile key={s.label} label={s.label} value={s.value} />
            ))}
          </div>
        )}
      </div>
    </>
  );

  // A title contender (award watch) gets an accent ring so it visibly pops
  // above ordinary standouts.
  const cardClass = [
    'group relative block h-full bg-surface rounded-card shadow-card overflow-hidden',
    line.awardWatch ? 'ring-1 ring-inset ring-accent/40' : '',
  ].join(' ');

  if (line.href) {
    return (
      <Link
        href={line.href}
        className={[
          cardClass,
          'hover:shadow-lift transition-shadow cursor-pointer',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset',
        ].join(' ')}
      >
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-gradient-to-br from-accent/[0.05] to-transparent" />
        {inner}
      </Link>
    );
  }
  return (
    <div className={cardClass}>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-gradient-to-br from-accent/[0.05] to-transparent" />
      {inner}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-2 rounded-card-sm bg-bg">
      <span className="font-display font-bold text-[19px] leading-none text-ink tabular">{value}</span>
      <span className="mt-1 text-[8.5px] font-bold tracking-[0.1em] uppercase font-tight text-faint">{label}</span>
    </div>
  );
}

/** Season award-watch tag — a filled accent chip so title contenders pop. */
function WatchTag({ award }: { award: AwardWatch }) {
  return (
    <span className="inline-flex items-center rounded-full bg-accent px-2 py-0.5 text-[8px] font-bold tracking-[0.1em] uppercase font-tight text-accent-ink">
      {AWARD_LABEL[award]}
    </span>
  );
}

/** Callahan acknowledgment — the rarest play (a D caught in the endzone for a
 *  score). A distinct chip with a spark so it reads as a highlight, not a stat. */
function CallahanTag() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-ink px-2 py-0.5 text-[8px] font-bold tracking-[0.1em] uppercase font-tight text-bg">
      <svg width="8" height="8" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        <path d="M6 0l1.6 3.9L12 4.4 8.8 7.2 9.7 12 6 9.6 2.3 12l.9-4.8L0 4.4l4.4-.5z" />
      </svg>
      Callahan
    </span>
  );
}

function RailArrow({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  const isLeft = side === 'left';
  return (
    <button
      aria-label={isLeft ? 'Previous' : 'Next'}
      onClick={onClick}
      className={[
        'absolute top-[calc(50%-18px)] -translate-y-1/2 z-10',
        isLeft ? '-left-3' : '-right-3',
        'flex items-center justify-center rounded-full w-9 h-9',
        'bg-surface border border-hairline shadow-card',
        'text-muted hover:text-ink hover:bg-surface-hi transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent cursor-pointer',
      ].join(' ')}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ transform: isLeft ? 'scaleX(-1)' : 'none' }}>
        <path d="M5 3l5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
