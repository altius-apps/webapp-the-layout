'use client';

// JOIN pill for a public league — joins (no invite code), then lands on the
// league page, where EnsureContestTeam creates the team. Signed out opens the
// sign-in modal first.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/auth-provider';
import { AuthModal } from '@/components/auth/auth-modal';
import { joinPublicLeague } from '@/lib/fantasy/leagues';
import { LEAGUE_JOINED_EVENT } from './ensure-contest-team';

interface Props {
  leagueId: string;
  /** Where to go after joining; omit to stay and refresh the current page. */
  contestId?: string;
}

export function JoinPublicLeagueButton({ leagueId, contestId }: Props) {
  const { user } = useAuth();
  const router = useRouter();
  const [authOpen, setAuthOpen] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = async () => {
    if (!user) {
      setAuthOpen(true);
      return;
    }
    setJoining(true);
    setError(null);
    try {
      await joinPublicLeague(leagueId);
      if (contestId) {
        router.push(`/fantasy/l/${contestId}`);
      } else {
        window.dispatchEvent(new CustomEvent(LEAGUE_JOINED_EVENT, { detail: leagueId }));
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join this league.');
      setJoining(false);
    }
  };

  return (
    <div className="flex flex-shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        onClick={join}
        disabled={joining}
        className={[
          'inline-flex items-center justify-center px-4 py-2 rounded-full min-h-[36px]',
          'bg-accent text-accent-ink font-tight text-[11px] font-bold tracking-[0.06em] uppercase',
          'hover:opacity-90 transition-opacity duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
        ].join(' ')}
      >
        {joining ? 'Joining…' : 'Join'}
      </button>
      {error && (
        <p role="alert" className="max-w-[180px] text-right font-tight text-[11px] text-live">
          {error}
        </p>
      )}
      <AuthModal
        open={authOpen}
        dismissible
        initialMode="signin"
        onDismiss={() => setAuthOpen(false)}
        headline="Sign in to join this league"
      />
    </div>
  );
}
