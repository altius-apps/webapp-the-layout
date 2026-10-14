'use client';

// EventFavoriteStar — the header-controls star for USAU/WFDF event pages
// (Push Notifications.md plan: a starred tournament gets milestone pushes —
// start, bracket-begins, championship result). Same optimistic
// toggle-with-rollback pattern as FavoritesPicker's team/player rows, just
// inline instead of inside the settings picker, since there's no existing
// standalone star component to extend (favorites today are only edited from
// Settings → the picker's checkbox+search rows).
//
// Signed-out click opens AuthModal, mirroring WantDetail/JerseyDetail's
// handleMessage pattern (check viewer, setAuthOpen(true), no-op otherwise).

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth/auth-provider';
import { AuthModal } from '@/components/auth/auth-modal';
import {
  addFavoriteEvent,
  addFavoriteGame,
  isAnyEventFavorited,
  isGameFavorited,
  removeFavoriteEvents,
  removeFavoriteGame,
  type FavoriteEvent,
  type FavoriteGame,
} from '@/lib/favorites/data';

export function StarGlyph({ filled, size = 18 }: { filled: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 2.2l2.36 4.78 5.28.77-3.82 3.72.9 5.26L10 14.1l-4.72 2.63.9-5.26-3.82-3.72 5.28-.77z" />
    </svg>
  );
}

/** Starred tournament (USAU/WFDF/EUF event pages). `memberIds` = every row of
 *  a merged USAU series event: the star is stored once on `event.eventId`
 *  (mobile reads stars by uuid, so one row per division would triple them),
 *  shows filled when any member is starred, and unstarring clears them all. */
export function EventFavoriteStar({ event, memberIds }: { event: FavoriteEvent; memberIds?: string[] }) {
  const ids = memberIds && memberIds.length > 0 ? memberIds : [event.eventId];
  return (
    <FavoriteStar
      id={`${event.league}:${ids.join(',')}`}
      noun="tournament"
      subhead="Sign in to get notified for tournaments you follow."
      isFavorited={() => isAnyEventFavorited(event.league, ids)}
      add={() => addFavoriteEvent(event)}
      remove={() => removeFavoriteEvents(event.league, ids)}
    />
  );
}

/** Starred game (UFA/PUL/WUL game pages) — the pro-league twin. */
export function GameFavoriteStar({ game }: { game: FavoriteGame }) {
  return (
    <FavoriteStar
      id={`${game.league}:${game.gameId}`}
      noun="game"
      subhead="Sign in to get notified for games you follow."
      isFavorited={() => isGameFavorited(game.league, game.gameId)}
      add={() => addFavoriteGame(game)}
      remove={() => removeFavoriteGame(game.league, game.gameId)}
    />
  );
}

function FavoriteStar({
  id,
  noun,
  subhead,
  isFavorited,
  add,
  remove,
}: {
  /** Stable identity of the starred thing — re-reads state when it changes. */
  id: string;
  noun: 'tournament' | 'game';
  subhead: string;
  isFavorited: () => Promise<boolean>;
  add: () => Promise<void>;
  remove: () => Promise<void>;
}) {
  const { user } = useAuth();
  const [starred, setStarred] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);

  useEffect(() => {
    if (!user) {
      setStarred(false);
      setLoaded(true);
      return;
    }
    let cancelled = false;
    isFavorited()
      .then((v) => {
        if (!cancelled) setStarred(v);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // isFavorited is a fresh closure every render; `id` is its real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, id]);

  async function handleClick() {
    if (!user) {
      setAuthOpen(true);
      return;
    }
    if (busy) return;
    const next = !starred;
    setStarred(next);
    setBusy(true);
    try {
      if (next) {
        await add();
      } else {
        await remove();
      }
    } catch {
      setStarred(!next);
    } finally {
      setBusy(false);
    }
  }

  const label = starred ? `Unstar this ${noun}` : `Star this ${noun}`;

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={loaded && busy}
        aria-pressed={starred}
        aria-label={label}
        title={label}
        className={[
          'inline-flex items-center justify-center w-11 h-11 rounded-full flex-shrink-0 transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent cursor-pointer',
          starred ? 'text-accent' : 'text-faint hover:text-ink',
          busy ? 'opacity-70' : '',
        ].join(' ')}
      >
        <StarGlyph filled={starred} />
      </button>

      <AuthModal
        open={authOpen}
        dismissible
        onDismiss={() => setAuthOpen(false)}
        headline={`Star this ${noun}.`}
        subhead={subhead}
      />
    </>
  );
}
