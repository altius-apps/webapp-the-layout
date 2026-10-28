'use client';

// USAU rankings division toggle — interactive tab strip + a 4×4 grid of the
// top 16 teams in the active division. Each cell is a compact tile: mono
// rank (accent for top 3), team logo, bold truncated name, and rating/record
// as small mono text — sized to sit 4-across, matching the width of the UFA
// division cards directly above this card on the home page.
// Receives all 5 divisions' pre-fetched data from the server component
// parent (rankings-card.tsx); no data fetching here.

import { useState } from 'react';
import Link from 'next/link';
import type { UsauDivisionData } from '@/components/home/rankings-card';
import { UsauTeamLogo } from '@/components/usau/usau-team-logo';

interface RankingsDivisionToggleProps {
  divisions: UsauDivisionData[];
}

export function RankingsDivisionToggle({ divisions }: RankingsDivisionToggleProps) {
  const [activeDivKey, setActiveDivKey] = useState(divisions[0]?.key ?? '');

  const active = divisions.find((d) => d.key === activeDivKey) ?? divisions[0];

  if (!active) return null;

  return (
    <div className="flex flex-col">
      {/* Tab strip — pill segmented control. All 5 pills fit one row on mobile
          via tighter padding/size below sm, scaling up on larger screens. */}
      <div className="flex flex-nowrap sm:flex-wrap gap-0.5 sm:gap-1.5 mb-3.5" role="tablist" aria-label="USAU divisions">
        {divisions.map((div) => {
          const isActive = div.key === activeDivKey;
          return (
            <button
              key={div.key}
              role="tab"
              aria-selected={isActive}
              aria-controls={`usau-panel-${div.key}`}
              onClick={() => setActiveDivKey(div.key)}
              className={[
                'flex-1 sm:flex-none px-1.5 sm:px-3.5 py-1.5 sm:py-2 rounded-full font-tight text-[11px] sm:text-[12px] font-bold whitespace-nowrap transition-colors cursor-pointer text-center',
                isActive ? 'bg-ink text-bg' : 'bg-[rgb(var(--ink)/0.05)] text-muted hover:text-ink',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              ].join(' ')}
            >
              {/* Ultra-compact label on phones, roomier on ≥sm. */}
              <span className="sm:hidden">{div.tinyLabel}</span>
              <span className="hidden sm:inline">{div.shortLabel}</span>
            </button>
          );
        })}
      </div>

      {active.caption && (
        <span className="font-mono text-[10.5px] text-faint tracking-[0.06em] mb-3">{active.caption}</span>
      )}

      {/* Top-16 grid for the active division — 4 across on desktop so it
          reads as a companion block to the UFA division cards above. */}
      <div
        id={`usau-panel-${active.key}`}
        role="tabpanel"
        aria-label={active.label}
        className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3"
      >
        {active.teams.length === 0 ? (
          <span className="font-mono text-[11px] text-faint py-4 col-span-full">No rankings available.</span>
        ) : (
          active.teams.map((team) => {
            // Final standings show the season finish where the poll shows W-L.
            const record =
              team.finish ?? (team.wins != null && team.losses != null ? `${team.wins}-${team.losses}` : null);
            const rating = team.rating != null ? team.rating.toFixed(0) : null;

            // Ranked teams we couldn't match to a usau_teams row (team.id null)
            // still appear — as a static tile (no profile link), since there's
            // no team page to point at.
            const inner = (
              <>
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={[
                      'font-mono text-[12px] font-bold tabular flex-shrink-0',
                      team.rank <= 3 ? 'text-accent' : 'text-faint',
                    ].join(' ')}
                  >
                    {String(team.rank).padStart(2, '0')}
                  </span>
                  <span className="inline-flex rounded-full overflow-hidden flex-shrink-0">
                    <UsauTeamLogo
                      name={team.name}
                      genderDivision={active.genderDivision}
                      competitionLevel={active.competitionLevel}
                      size={24}
                    />
                  </span>
                  <span className="font-sans font-bold text-[13px] text-ink truncate min-w-0">{team.name}</span>
                </div>
                {(rating || record) && (
                  <div className="flex items-center justify-between gap-2 pl-[26px]">
                    {rating && (
                      <span className="font-display italic font-bold text-[14px] text-ink tabular">{rating}</span>
                    )}
                    {record && <span className="font-mono text-[10.5px] text-muted tabular truncate min-w-0">{record}</span>}
                  </div>
                )}
              </>
            );

            const tileClass =
              'flex flex-col gap-2 rounded-card-sm border border-border bg-surface p-3 transition-colors duration-150';
            return team.id ? (
              <Link
                key={team.rank}
                href={`/usau/teams/${team.id}`}
                className={`${tileClass} hover:border-accent hover:bg-accent/[0.03]`}
              >
                {inner}
              </Link>
            ) : (
              <div key={team.rank} className={tileClass}>
                {inner}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
