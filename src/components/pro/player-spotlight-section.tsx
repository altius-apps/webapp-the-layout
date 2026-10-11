'use client';

// Shared pro game-detail "Player Spotlight" section. Renders one player per team
// side by side, flipping its heading + content by game state:
//
//   • upcoming / live  → "Players to watch"   (season-best per team)
//   • final            → "Player of the game"  (this game's best per team)
//
// League-agnostic: each caller (UFA / PUL / WUL) resolves its own picks via
// lib/pro/player-spotlight and passes an already-rendered team logo node, so
// this component needs no league-specific team types. Matches the visual
// language of the existing stat-leader cards (logo + uppercase side label +
// name + big stat line). Renders nothing when neither side resolves a player.

import { useId, useState } from 'react';
import Link from 'next/link';
import type { SpotlightPlayer } from '@/lib/pro/player-spotlight';

export interface SpotlightSide {
  /** Team abbreviation, e.g. "SD". */
  abbr: string;
  /** Pre-rendered team logo (each league brings its own logo component). */
  logo: React.ReactNode;
  /** The resolved pick for this side, or null (no usable data). */
  player: SpotlightPlayer | null;
}

interface Props {
  /** true → "Player of the game" (final); false → "Players to watch". */
  isFinal: boolean;
  away: SpotlightSide;
  home: SpotlightSide;
  /** Whether to render the headshot/monogram avatar circle. Default true (UFA,
   *  which has real headshots for ~89% of players and a monogram fallback for
   *  the rest). PUL/WUL have no headshots at all, so they pass false to skip
   *  the avatar entirely rather than show a meaningless monogram placeholder. */
  showAvatar?: boolean;
}

export function PlayerSpotlightSection({ isFinal, away, home, showAvatar = true }: Props) {
  const headingId = useId();
  // Nothing to show on either side → don't render an empty shell.
  if (!away.player && !home.player) return null;

  const heading = isFinal ? 'Player of the game' : 'Players to watch';
  const eyebrow = isFinal ? 'Top performer' : 'One to watch';

  return (
    <section
      aria-labelledby={headingId}
      className="px-6 py-6 md:px-14 md:py-8 border-t border-hairline"
    >
      {/* Heading grammar matches the host page's own stat-leaders heading: the
          small-caps eyebrow with a bottom hairline. */}
      <h2
        id={headingId}
        className="flex items-baseline justify-between text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight mb-5 pb-2 border-b border-hairline"
      >
        <span>{heading}</span>
        <span className="text-faint">{eyebrow}</span>
      </h2>

      <div className="grid grid-cols-2 gap-2 md:gap-3">
        <SpotlightCard side={away} label="Away" showAvatar={showAvatar} />
        <SpotlightCard side={home} label="Home" showAvatar={showAvatar} />
      </div>
    </section>
  );
}

function SpotlightCard({
  side,
  label,
  showAvatar,
}: {
  side: SpotlightSide;
  label: 'Away' | 'Home';
  showAvatar: boolean;
}) {
  const p = side.player;
  // Fall back to the initials monogram if the headshot fails to load (a stale /
  // 404'd URL) instead of showing a broken-image glyph.
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = !!p?.headshotUrl && !imgFailed;

  const inner = (
    <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3.5 min-w-0">
      {showAvatar && (
        <span className="shrink-0 w-9 h-9 md:w-12 md:h-12 rounded-full overflow-hidden bg-ink/5 ring-1 ring-hairline flex items-center justify-center">
          {showImg ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={p!.headshotUrl!}
              alt={p!.name}
              className="w-full h-full object-cover"
              loading="lazy"
              onError={() => setImgFailed(true)}
            />
          ) : (
            <span className="font-display italic font-bold text-[12px] md:text-[15px] text-muted" aria-hidden="true">
              {p ? initials(p.name) : '—'}
            </span>
          )}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center gap-1.5 shrink-0 min-w-0">
            <span className="w-3.5 h-3.5 md:w-4 md:h-4 inline-flex items-center justify-center shrink-0">{side.logo}</span>
            <span className="text-[9px] font-bold tracking-[0.08em] md:tracking-[0.18em] uppercase text-faint font-tight truncate">
              {label} · {side.abbr}
            </span>
          </span>
        </div>
        {p ? (
          <>
            <div className="text-[13px] md:text-[15px] font-bold text-ink font-tight truncate mt-0.5 group-hover:text-accent transition-colors">
              {p.name}
            </div>
            {/* ESPN-style stat strip: each number sits above its own label in an
                evenly-spaced column. Replaces the old single "11G · 32A · 1Blk ·
                3472 yds · 7 GP · +31" sentence, which wrapped to three ragged
                lines in a ~180px mobile column and was hard to scan.
                Falls back to the compact string if `stats` is somehow empty. */}
            {/* Fixed 3-up grid so the cells line up in tidy columns and rows
                (G/A/BLK then YDS/GP/+/-) instead of flex-wrapping into ragged
                rows whose widths shift with the value lengths. */}
            {p.stats && p.stats.length > 0 ? (
              <div className="mt-1.5 grid grid-cols-3 gap-x-2 md:gap-x-3 gap-y-2">
                {p.stats.map((s) => (
                  <div key={s.label} className="flex flex-col leading-none min-w-0">
                    <span className="text-[13px] md:text-[15px] font-bold text-ink font-tight tabular truncate">
                      {s.value}
                    </span>
                    <span className="mt-1 text-[9px] font-bold tracking-[0.08em] md:tracking-[0.1em] uppercase text-faint font-tight truncate">
                      {s.label}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[10.5px] md:text-[12px] font-semibold text-muted font-tight tabular mt-0.5 leading-snug break-words">
                {p.statLine}
                {p.sub && <span className="text-faint font-medium"> · {p.sub}</span>}
              </div>
            )}
          </>
        ) : (
          <div className="text-[11px] md:text-[13px] text-faint italic font-tight mt-1">No data</div>
        )}
      </div>
    </div>
  );

  // Recessed inside the page's surface card: bg-bg + rounded-card-sm (mirrors
  // FieldLeaderCard).
  const base = 'group block bg-bg rounded-card-sm px-2.5 py-3 md:px-4 md:py-3.5';

  // Link to the unified profile when we resolved an id; otherwise a plain card.
  if (p?.profileId) {
    return (
      <Link
        href={`/players/${p.profileId}`} prefetch={false}
        className={[
          base,
          'hover:bg-surface-hi transition-colors cursor-pointer',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        ].join(' ')}
      >
        {inner}
      </Link>
    );
  }
  return <div className={base}>{inner}</div>;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
