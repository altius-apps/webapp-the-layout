'use client';

// League page join CTA for signed-out viewers and non-members — client
// island. The Members list was removed from the league page (Hunter,
// 2026-10-09); email invites moved into the join code's Invite popup
// (invite-code-row.tsx), and Leave league lives in Settings
// (leave-league-card.tsx).
//
// Resolves "am I a member" itself — the caller only supplies the league id.

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth/auth-provider';
import { AuthModal } from '@/components/auth/auth-modal';
import { JoinPublicLeagueButton } from '@/components/fantasy/join-public-league-button';
import { getMyLeagueRole, type LeagueRole } from '@/lib/fantasy/leagues';

interface Props {
  leagueId: string;
  isPublic?: boolean;
  /** Official leagues show the count only — the member list can be thousands. */
  memberCount?: number;
}

export function LeagueMembersPanel({ leagueId, isPublic = false, memberCount }: Props) {
  const { user, loading } = useAuth();
  const [authOpen, setAuthOpen] = useState(false);

  const [myRole, setMyRole] = useState<LeagueRole | null>(null);
  const [roleLoading, setRoleLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setMyRole(null);
      setRoleLoading(false);
      return;
    }
    setRoleLoading(true);
    getMyLeagueRole(leagueId)
      .then(setMyRole)
      .catch(() => setMyRole(null))
      .finally(() => setRoleLoading(false));
  }, [user, leagueId]);

  const isMember = myRole !== null;

  return (
    <div className="space-y-8">
      {/* ── Signed out / not a member: join CTA ──────────────────────────── */}
      {!loading && !roleLoading && !isMember && (
        <div className="bg-surface rounded-card-lg shadow-soft p-6 flex flex-col sm:flex-row sm:items-center gap-4">
          <p className="text-muted font-tight text-[13px] flex-1">
            {isPublic
              ? `This league is open to everyone.${memberCount != null ? ` ${memberCount.toLocaleString('en-US')} ${memberCount === 1 ? 'player' : 'players'} so far.` : ''}`
              : user
                ? "You're not a member of this league. Ask the commissioner for an invite link or join code."
                : 'Sign in to see if you belong to this league, or ask the commissioner for an invite.'}
          </p>
          {isPublic && <JoinPublicLeagueButton leagueId={leagueId} />}
          {!isPublic && !user && (
            <button
              type="button"
              onClick={() => setAuthOpen(true)}
              className={[
                'inline-flex items-center justify-center gap-2 flex-shrink-0',
                'px-5 py-2.5 rounded-full min-h-[44px]',
                'bg-accent text-accent-ink font-tight text-[12px] font-bold tracking-[0.1em] uppercase',
                'hover:opacity-90 transition-opacity duration-150 cursor-pointer',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
              ].join(' ')}
            >
              Sign in
            </button>
          )}
        </div>
      )}

      <AuthModal
        open={authOpen}
        dismissible
        initialMode="signin"
        onDismiss={() => setAuthOpen(false)}
        headline="Sign in"
      />
    </div>
  );
}
