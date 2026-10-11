'use client';

// Rank + projection pieces for the ranked player list on event contests
// (fantasy_player_ratings — see src/lib/fantasy/ratings.ts). Shared by the snake
// and auction draft rooms and the league Players tab so every surface reads the
// same: a "#rank · Proj · why" line under the player's name, and a "How
// rankings work" toggle above the list. The rank rides in that line rather
// than a column of its own — the desktop draft rail is only ~240px wide.

import { useId, useState } from 'react';
import type { CompetitionId } from '@/lib/fantasy/competitions';
import type { FantasyPlayerHit } from '@/lib/fantasy/data';
import { projectedEventPoints, ratingExplainer, ratingSummary, type PlayerRating } from '@/lib/fantasy/ratings';

/** Rows a ranked list shows up front, and how many each "Show more" adds. */
export const RANKED_PAGE_SIZE = 50;

/** A rating as the search-hit shape the pickers already take, so a ranked row
 *  drafts, queues and nominates through the same handlers as a search result. */
export function ratingToHit(r: PlayerRating): FantasyPlayerHit {
  return { playerId: r.playerId, fullName: r.playerName, teamId: null, teamName: r.teamName };
}

/** "#12 · Proj 22.4 · 15.3 G+A per event · 11× Nationals" on one truncating
 *  line. The rank is the contest's rank — within the division in a division
 *  league (gaps appear as players are drafted), never the list position.
 *  `compact` drops the why. */
export function RatingLine({ rating, compact = false }: { rating: PlayerRating | undefined; compact?: boolean }) {
  if (!rating) return null;
  const proj = projectedEventPoints(rating);
  return (
    <div className="font-tight text-[11px] text-muted truncate">
      <span className="font-bold tabular text-ink">
        <span className="sr-only">Rank </span>#{rating.rank}
      </span>
      {' · '}
      <span className="font-bold tabular text-ink">{proj != null ? `Proj ${proj}` : 'Proj —'}</span>
      {!compact && ` · ${ratingSummary(rating)}`}
    </div>
  );
}

/** The rating line as a full-width last line of a draft-room row, wrapped
 *  below the queue/draft buttons so it keeps its room on a phone. */
export function RatingRowLine({ rating }: { rating: PlayerRating | undefined }) {
  if (!rating) return null;
  return (
    <div className="basis-full min-w-0">
      <RatingLine rating={rating} />
    </div>
  );
}

/** Optional title on the left, "How rankings work" on the right; the toggle
 *  reveals the plain-language explainer for the contest's competition. */
export function RankingsHeader({
  competition,
  title,
  className = '',
}: {
  competition: CompetitionId;
  title?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className={className}>
      {/* Wraps: in the ~250px desktop draft rail the toggle drops below the title. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        {title && (
          <span className="font-tight text-[10.5px] font-bold tracking-[0.16em] uppercase text-muted whitespace-nowrap">
            {title}
          </span>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          className={[
            'ml-auto flex-shrink-0 inline-flex items-center gap-1.5 px-3 min-h-[36px] rounded-full',
            'font-tight text-[11.5px] font-bold text-muted hover:text-ink hover:bg-ink/5',
            'transition-colors duration-150 cursor-pointer',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          ].join(' ')}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8 7.25v3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="8" cy="5.1" r="0.85" fill="currentColor" />
          </svg>
          How rankings work
        </button>
      </div>
      {open && (
        <ul
          id={panelId}
          className="mt-1 mb-2 space-y-2 rounded-card-sm bg-ink/5 px-3.5 py-3 font-tight text-[12px] leading-snug text-muted"
        >
          {ratingExplainer(competition).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ShowMoreButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'w-full min-h-[40px] rounded-full bg-ink/5 text-ink',
        'font-tight text-[11px] font-bold tracking-[0.08em] uppercase',
        'hover:bg-ink/10 transition-colors duration-150 cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      ].join(' ')}
    >
      Show more
    </button>
  );
}
