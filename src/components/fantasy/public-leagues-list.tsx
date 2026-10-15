'use client';

// "Public" — open leagues anyone can join. Signed-in only (Hunter,
// 2026-10-14: signed-out users don't see fantasy leagues), so it loads in the
// browser with the viewer's session and the hub page itself stays ISR. Leagues
// you're already in are left out by the RPC — they live under My Leagues.
//
// The hub shows only the official (The Layout) leagues plus a link to
// /fantasy/public, which lists every open public league with the competition
// filter (Hunter, 2026-10-14: the full list could get long). The rows and the
// filter live in PublicLeaguesRows.

import { useEffect, useState } from 'react';
import Link from 'next/link';
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

/** The viewer's open public leagues, mapped for PublicLeaguesRows. Null until
 *  the first load lands (or while signed out). */
function usePublicLeagues(limit: number): PublicLeagueView[] | null {
  const { user } = useAuth();
  const [rows, setRows] = useState<PublicLeagueView[] | null>(null);

  useEffect(() => {
    if (!user) {
      setRows(null);
      return;
    }
    let cancelled = false;
    getPublicLeagues(limit)
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
  }, [user, limit]);

  return rows;
}

/** Hub section: official leagues you haven't joined, then the browse link. */
export function PublicLeaguesList() {
  const { user } = useAuth();
  const rows = usePublicLeagues(50);

  if (!user) return null;
  const official = (rows ?? []).filter((r) => r.isOfficial);

  return (
    <section aria-labelledby="public-leagues-heading" className="mb-8 lg:mb-10">
      <h2
        id="public-leagues-heading"
        className="font-display italic text-[22px] lg:text-[26px] font-bold tracking-[-0.02em] leading-[0.95] text-ink"
      >
        Public
      </h2>
      <p className="font-tight text-[12px] text-muted mt-1.5 mb-4">Open leagues anyone can join</p>
      <PublicLeaguesRows
        rows={official}
        filterable={false}
        footer={
          <Link
            href="/fantasy/public"
            className={[
              'flex items-center justify-between gap-3 px-5 py-4',
              'no-underline transition-colors duration-150 hover:bg-surface-hi',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
            ].join(' ')}
          >
            <span className="font-tight text-[14px] font-semibold text-ink">Browse public leagues</span>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="flex-shrink-0 text-faint">
              <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
        }
      />
    </section>
  );
}

/** /fantasy/public: every open public league you're not in, filterable. */
export function PublicLeaguesBrowser() {
  const rows = usePublicLeagues(100);

  if (rows === null) {
    return (
      <div className="space-y-3" aria-busy="true">
        <span className="sr-only">Loading…</span>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[68px] rounded-card-sm bg-ink/[0.06] animate-pulse" aria-hidden="true" />
        ))}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="bg-surface rounded-card-lg shadow-card px-5 py-6">
        <p className="font-tight text-[14px] text-muted">No open public leagues right now. Check back closer to the next event.</p>
      </div>
    );
  }
  return <PublicLeaguesRows rows={rows} />;
}
