'use client';

// Post-signup favorites onboarding — a SKIPPABLE modal overlay, NOT a home-page
// card. Mounted app-wide (in the root layout, inside AuthProvider). Self-gates:
// shows once, the first time the user has a real session AND zero favorites AND
// hasn't already seen/skipped it (localStorage). Works whether the session
// arrives instantly (email-confirm off) or later (email-confirm on) — it keys
// off "authed + empty + unseen", not the signup form. After this, favorites are
// edited only in Settings.
//
// Invite links (fantasy join/invite, playbook invite) defer it until the user
// reaches Home, so someone signing up mid-invite lands in the league/team they
// were invited to without a preferences picker on top of it (Hunter, 2026-10-07).

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth/auth-provider';
import {
  getMyFavorites,
  type FavoriteLeague,
  type FavoriteTeam,
  type FavoritePlayer,
} from '@/lib/favorites/data';
import { FavoritesPicker } from '@/components/settings/favorites-picker';
import { FOR_YOU_ENABLED } from '@/lib/for-you/leagues';

const SEEN_KEY = 'favorites-onboarding-seen';
const DEFER_KEY = 'favorites-onboarding-defer';

/** Called by invite pages on mount: hold the onboarding picker until Home. */
export function deferOnboardingUntilHome() {
  try {
    localStorage.setItem(DEFER_KEY, '1');
  } catch {
    // private mode — the picker just shows as it did before
  }
}

export function FavoritesOnboardingModal() {
  const { user, loading: authLoading } = useAuth();
  const pathname = usePathname();
  const [phase, setPhase] = useState<'idle' | 'checking' | 'open' | 'done'>('idle');
  const [initial, setInitial] = useState<{
    leagues: FavoriteLeague[];
    teams: FavoriteTeam[];
    players: FavoritePlayer[];
  } | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    // Onboarding only exists to drive the "For You" page — suppressed entirely
    // while that page is hidden (2026-07-10). Flip FOR_YOU_ENABLED to restore.
    if (!FOR_YOU_ENABLED) return;
    if (authLoading || phase === 'done' || phase === 'open') return;
    // Reaching Home ends any invite deferral, signed in or not.
    if (pathname === '/') {
      try {
        localStorage.removeItem(DEFER_KEY);
      } catch {
        // private mode — nothing was stored
      }
    }
    if (!user) return; // no session → nothing to onboard
    if (typeof window !== 'undefined' && localStorage.getItem(SEEN_KEY) === '1') {
      setPhase('done');
      return;
    }
    // Deferred by an invite link — re-runs on navigation and opens on Home.
    if (pathname !== '/' && localStorage.getItem(DEFER_KEY) === '1') return;
    let cancelled = false;
    setPhase('checking');
    getMyFavorites()
      .then((f) => {
        if (cancelled) return;
        const empty = f.leagues.length === 0 && f.teams.length === 0 && f.players.length === 0;
        if (empty) {
          setInitial({ leagues: f.leagues, teams: f.teams, players: f.players });
          setPhase('open');
        } else {
          // Already has favorites → never prompt; mark seen so we don't re-check.
          markSeen();
          setPhase('done');
        }
      })
      .catch(() => {
        if (!cancelled) setPhase('done');
      });
    return () => {
      cancelled = true;
    };
  }, [user, authLoading, phase, pathname]);

  function markSeen() {
    try {
      localStorage.setItem(SEEN_KEY, '1');
      localStorage.removeItem(DEFER_KEY);
    } catch {
      // private mode — best effort; the empty-favorites check still gates re-show
    }
  }

  function close() {
    markSeen();
    setPhase('done');
  }

  if (!mounted || phase !== 'open' || !initial) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="fav-onboarding-title"
      className="fixed inset-0 z-[100] flex items-center justify-center px-4 py-6 bg-black/40 backdrop-blur-sm"
      onPointerDown={(e) => {
        // Click-outside = skip (skippable by design).
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="w-full max-w-[480px] max-h-full overflow-y-auto bg-surface rounded-card-lg shadow-hero flex flex-col">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 flex flex-col gap-2 border-b border-hairline">
          <span className="text-[10px] font-bold tracking-[0.18em] uppercase text-accent font-tight">
            Welcome
          </span>
          <h2
            id="fav-onboarding-title"
            className="m-0 font-display italic text-[24px] font-bold tracking-[-0.02em] leading-[0.95] text-ink"
          >
            Make it yours.
          </h2>
          <p className="text-[13px] text-muted font-tight leading-snug">
            Pick the leagues you follow — and a favorite team or two — so we can
            tailor your feed. You can skip this and set it up later in Settings.
          </p>
        </div>

        {/* Picker */}
        <div className="px-6 py-5">
          <FavoritesPicker
            initialLeagues={initial.leagues}
            initialTeams={initial.teams}
            initialPlayers={initial.players}
          />
        </div>

        {/* Footer actions */}
        <div className="px-6 py-4 border-t border-hairline flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={close}
            className={[
              'inline-flex items-center justify-center px-3 min-h-[44px] rounded-full cursor-pointer',
              'text-[11px] font-bold tracking-[0.14em] uppercase font-tight text-muted',
              'hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            ].join(' ')}
          >
            Skip for now
          </button>
          <button
            type="button"
            onClick={close}
            className={[
              'inline-flex items-center justify-center px-6 min-h-[44px] rounded-full cursor-pointer',
              'bg-accent text-accent-ink font-tight text-[11px] font-bold tracking-[0.14em] uppercase',
              'hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            ].join(' ')}
          >
            Done
          </button>
        </div>

        {/* Settings hint */}
        <div className="px-6 pb-5 -mt-1">
          <Link
            href="/settings"
            onClick={close}
            className="text-[11px] font-tight text-faint hover:text-muted transition-colors"
          >
            Manage favorites anytime in Settings →
          </Link>
        </div>
      </div>
    </div>,
    document.body,
  );
}
