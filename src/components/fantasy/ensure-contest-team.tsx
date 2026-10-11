'use client';

// Every member gets a team without a form (Hunter, 2026-10-09): on first visit
// to any tab of a contest, a member with no team gets one named after their
// display name; they rename it in Settings. Lives in the league layout so it
// covers every entry path (create, join link, email invite, mobile-joined) and
// every tab. Once a team is created the tab remounts so its standings / draft
// counts refetch with the new team in them.

import { Fragment, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth/auth-provider';
import { ensureMyContestTeam } from '@/lib/fantasy/leagues';
import { revalidateFantasyLeague } from '@/app/fantasy/leagues/actions';

export function EnsureContestTeam({
  contestId,
  leagueId,
  seasonYear,
  children,
}: {
  contestId: string;
  leagueId: string;
  seasonYear: number;
  children: React.ReactNode;
}) {
  const { user } = useAuth();
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // StrictMode re-runs effects; a second insert would hit the unique key.
  const ranFor = useRef<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const key = `${user.id}:${contestId}`;
    if (ranFor.current === key) return;
    ranFor.current = key;
    ensureMyContestTeam(contestId, leagueId, seasonYear)
      .then(async (created) => {
        if (!created) return;
        await revalidateFantasyLeague(leagueId, contestId).catch(() => null);
        setVersion((v) => v + 1);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not create your team.'));
  }, [user, contestId, leagueId, seasonYear]);

  return (
    <>
      {error && (
        <p role="alert" className="mb-6 bg-surface rounded-card-lg shadow-card p-5 text-[13px] text-live font-tight">
          {error}
        </p>
      )}
      <Fragment key={version}>{children}</Fragment>
    </>
  );
}
