'use client';

// Every member gets a team without a form (Hunter, 2026-10-09): on first visit
// to any tab of a contest, a member with no team gets one named after their
// display name; they rename it in Settings. Lives in the league layout so it
// covers every entry path (create, join link, email invite, mobile-joined) and
// every tab. Once a team is created the tab remounts so its standings / draft
// counts refetch with the new team in them. ensureMyContestTeam skips members
// without a usable display name (the name prompt is up); the effect re-runs
// when the name changes, so the team takes the name the member picks.

import { Fragment, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth/auth-provider';
import { ensureMyContestTeam } from '@/lib/fantasy/leagues';
import { revalidateFantasyLeague } from '@/app/fantasy/leagues/actions';

/** Fired by a join on the league page itself (detail: leagueId): the layout
 *  is already mounted, so it re-runs the team check for the new member. */
export const LEAGUE_JOINED_EVENT = 'fantasy:league-joined';

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
  const [joins, setJoins] = useState(0);

  const displayName = user?.profile?.display_name ?? null;

  useEffect(() => {
    const onJoined = (e: Event) => {
      if ((e as CustomEvent<string>).detail === leagueId) setJoins((n) => n + 1);
    };
    window.addEventListener(LEAGUE_JOINED_EVENT, onJoined);
    return () => window.removeEventListener(LEAGUE_JOINED_EVENT, onJoined);
  }, [leagueId]);

  useEffect(() => {
    if (!user) return;
    const key = `${user.id}:${contestId}:${displayName ?? ''}:${joins}`;
    if (ranFor.current === key) return;
    ranFor.current = key;
    const showTeam = async () => {
      await revalidateFantasyLeague(leagueId, contestId).catch(() => null);
      setVersion((v) => v + 1);
    };
    ensureMyContestTeam(contestId, leagueId, seasonYear)
      .then((created) => (created ? showTeam() : undefined))
      .catch((err) => {
        // A run keyed on the old name can win the insert when the name changes
        // mid-flight; the team exists either way.
        if (err instanceof Error && err.message === 'You already have a team in this contest.') return showTeam();
        setError(err instanceof Error ? err.message : 'Could not create your team.');
      });
  }, [user, displayName, contestId, leagueId, seasonYear, joins]);

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
