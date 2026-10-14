'use client';

// "Public" — the fantasy hub's open-leagues section. Signed-in only (Hunter,
// 2026-10-14: signed-out users don't see fantasy leagues), so it loads in the
// browser with the viewer's session and the hub page itself stays ISR. The
// rows and the competition filter live in PublicLeaguesRows.

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth/auth-provider';
import { getPublicLeagues } from '@/lib/fantasy/leagues';
import { getGame } from '@/lib/fantasy/games';
import {
  PublicLeaguesRows,
  type PublicLeagueView,
} from '@/components/fantasy/public-leagues-rows';

function lockLabel(iso: string | null): string {
  if (!iso) return 'In progress';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'In progress';
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  return `Locks ${day}`;
}

export function PublicLeaguesList() {
  const { user } = useAuth();
  const [rows, setRows] = useState<PublicLeagueView[]>([]);

  useEffect(() => {
    if (!user) {
      setRows([]);
      return;
    }
    let cancelled = false;
    getPublicLeagues()
      .then((leagues) => {
        if (cancelled) return;
        setRows(
          leagues.map((l) => ({
            leagueId: l.leagueId,
            contestId: l.contestId,
            name: l.name,
            logoUrl: l.logoUrl,
            logoIcon: l.logoIcon,
            logoSrc: getGame(l.competition)?.logoSrc ?? null,
            isOfficial: l.isOfficial,
            open: l.open,
            competition: l.competition,
            competitionLabel: l.competitionDef.shortLabel,
            memberCount: l.memberCount,
            lockLabel: lockLabel(l.nextLockAt),
          })),
        );
      })
      .catch(() => !cancelled && setRows([]));
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (rows.length === 0) return null;

  return (
    <section aria-labelledby="public-leagues-heading" className="mb-8 lg:mb-10">
      <h2
        id="public-leagues-heading"
        className="font-display italic text-[22px] lg:text-[26px] font-bold tracking-[-0.02em] leading-[0.95] text-ink"
      >
        Public
      </h2>
      <p className="font-tight text-[12px] text-muted mt-1.5 mb-4">Open leagues anyone can join</p>
      <PublicLeaguesRows rows={rows} />
    </section>
  );
}
