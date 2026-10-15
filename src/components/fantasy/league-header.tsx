'use client';

// LeagueHeader — chrome row for every screen inside a fantasy league (contest).
// Back link → league logo → name + "{shortLabel} · {year}" (a division league
// reads "{shortLabel} · Men's · {year}") → settings gear (client island:
// resolves getMyLeagueRole; every member sees the gear — Settings holds Leave
// league). Invite moved to the League tab's join-code card and chat to the
// Chat tab, so the name has the row (Hunter, 2026-10-14).
// Web port of the mobile app's LeagueShell.tsx header row
// (altiusapps/mobileapp-thelayout · src/components/fantasy/LeagueShell.tsx).

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth/auth-provider';
import {
  getMyLeagueRole,
  type ContestView,
  type FantasyLeagueSummary,
  type LeagueRole,
} from '@/lib/fantasy/leagues';
import { divisionSuffix } from '@/lib/fantasy/competitions';
import { getGame } from '@/lib/fantasy/games';
import { LeagueLogo } from '@/components/fantasy/league-logo';
import { OfficialBadge } from '@/components/fantasy/official-badge';

interface Props {
  contest: ContestView;
  league: FantasyLeagueSummary | null;
}

export function LeagueHeader({ contest, league }: Props) {
  const { user } = useAuth();
  const [role, setRole] = useState<LeagueRole | null>(null);

  const title = league?.name ?? contest.name;
  const game = getGame(contest.competition);

  useEffect(() => {
    if (!user) {
      setRole(null);
      return;
    }
    let cancelled = false;
    getMyLeagueRole(contest.leagueId)
      .then((r) => !cancelled && setRole(r))
      .catch(() => !cancelled && setRole(null));
    return () => {
      cancelled = true;
    };
  }, [user, contest.leagueId]);

  return (
    <>
    <div className="flex items-center gap-3 py-3">
      <Link
        href="/fantasy"
        aria-label="Back to Fantasy"
        className={[
          'flex-shrink-0 -ml-1.5 w-9 h-9 flex items-center justify-center rounded-full',
          'text-ink hover:text-accent hover:bg-ink/5 transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        ].join(' ')}
      >
        <svg width="16" height="16" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M9 2.5L4.5 7 9 11.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Link>

      <LeagueLogo
        name={title}
        logoUrl={league?.logoUrl}
        logoIcon={league?.logoIcon}
        logoSrc={game?.logoSrc}
        size={32}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          {/* pr: truncate's overflow clip cut off the italic's last glyph. */}
          <h1 className="m-0 font-display italic text-[20px] lg:text-[22px] font-bold tracking-[-0.02em] leading-[1.1] text-ink truncate pr-[0.14em]">
            {title}
          </h1>
          {league?.isOfficial && <OfficialBadge />}
        </div>
        <p className="m-0 font-tight text-[12px] text-muted truncate">
          {contest.competitionDef.shortLabel}
          {divisionSuffix(contest.settings)} · {contest.seasonYear}
        </p>
      </div>

      {role && (
        <Link
          href={`/fantasy/l/${contest.id}/settings`}
          aria-label="League settings"
          className={[
            'flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-full',
            'text-ink hover:text-accent hover:bg-ink/5 transition-colors duration-150',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          ].join(' ')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx={12} cy={12} r={3} stroke="currentColor" strokeWidth={1.7} />
            <path
              d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
          </svg>
        </Link>
      )}
    </div>
    </>
  );
}

export default LeagueHeader;
