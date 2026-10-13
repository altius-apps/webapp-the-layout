'use client';

// DraftCard — the league page's private-league draft status card. Replaces
// draft-schedule-card.tsx's role on league pages (that component stays a
// commissioner scheduling form; this one is the mobile-parity status card
// with live countdown, matching the mobile app's DraftCard.tsx
// (altiusapps/mobileapp-thelayout · src/components/fantasy/DraftCard.tsx).
//
// States: no draft row → commissioner "Set up the draft" / member waiting
// copy; scheduled → date + live countdown + snake/auction summary + "Enter
// draft room" (enabled only inside the 4h pre-open window); missed /
// rosters-not-ready → warning strips; live → full-bleed accent CTA;
// complete → "View results". Signed-out users see nothing (getDraftReadiness
// is signed-in only).

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth/auth-provider';
import { getDraftReadiness, getDraft, type Draft, type DraftReadiness } from '@/lib/fantasy/draft-room';
import { getMyLeagueRole } from '@/lib/fantasy/leagues';
import type { ContestView } from '@/lib/fantasy/leagues';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

// Last-seen card per contest, so switching tabs or reloading paints the card at
// once while it re-fetches in the background; a status change (scheduled →
// live → complete) swaps in and is cached (Hunter, 2026-10-12). The module map
// covers in-app navigation; localStorage covers a reload.
type CardState = {
  userId: string;
  readiness: DraftReadiness | null;
  draft: Draft | null;
  isCommissioner: boolean;
};
const CACHE_PREFIX = 'the-layout.fantasy-draft-card:';
const memoryCache = new Map<string, CardState>();

function readCache(contestId: string): CardState | null {
  const hit = memoryCache.get(contestId);
  if (hit) return hit;
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + contestId);
    return raw ? (JSON.parse(raw) as CardState) : null;
  } catch {
    return null; // storage unavailable (private mode) or corrupt — fetch as before
  }
}

function writeCache(contestId: string, state: CardState): void {
  memoryCache.set(contestId, state);
  try {
    localStorage.setItem(CACHE_PREFIX + contestId, JSON.stringify(state));
  } catch {
    // storage unavailable — the in-memory copy still covers tab switches
  }
}

function formatScheduled(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Draft scheduled';
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'Starting…';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export interface DraftCardData {
  /** Auth still resolving: the cached card (if any) shows meanwhile. */
  authLoading: boolean;
  userId: string | null;
  /** The card to render, or null until the first read lands. */
  shown: CardState | null;
}

/** The card's data, read once by its page so the page can also place the card
 *  and react to the draft's status (LeagueView moves it to the bottom after the
 *  draft and drops the invite card). */
export function useDraftCardData(contest: ContestView, leagueId: string): DraftCardData {
  const { user, loading } = useAuth();
  // Keyed on the id, not the user object: that object is rebuilt when the
  // profile loads and on every token refresh, which re-ran the fetch.
  const userId = user?.id ?? null;
  // In-app navigation has the module map filled, so the first render already
  // has the card. A reload starts empty (matching the server render) and fills
  // from localStorage in the effect below.
  const [card, setCard] = useState<CardState | null>(() => memoryCache.get(contest.id) ?? null);

  useEffect(() => {
    setCard(readCache(contest.id));
  }, [contest.id]);

  useEffect(() => {
    if (loading || !userId) return;
    let cancelled = false;
    Promise.all([
      getDraftReadiness(contest.id).catch(() => null),
      getDraft(contest.id).catch(() => null),
      getMyLeagueRole(leagueId).catch(() => null),
    ]).then(([r, d, role]) => {
      if (cancelled) return;
      const next: CardState = { userId, readiness: r, draft: d, isCommissioner: role === 'commissioner' };
      setCard(next);
      writeCache(contest.id, next);
    });
    return () => {
      cancelled = true;
    };
  }, [loading, userId, contest.id, leagueId]);

  // While auth resolves, show the cached card; once it has, only that user's.
  const shown = card && (loading || card.userId === userId) ? card : null;
  return { authLoading: loading, userId, shown };
}

export function DraftCard({ contest, data }: { contest: ContestView; data: DraftCardData }) {
  const { authLoading, userId, shown } = data;
  const readiness = shown?.readiness ?? null;
  const draft = shown?.draft ?? null;
  const isCommissioner = shown?.isCommissioner ?? false;

  const ticking = draft?.status === 'scheduled' && !!draft.scheduledAt;
  const now = useNow(ticking ? 1000 : 60_000);

  if (!authLoading && !userId) return null; // signed out
  if (!shown) {
    return (
      <div className="bg-surface rounded-card-lg shadow-card p-6">
        <div className="h-11 w-48 rounded-card-sm bg-ink/[0.06] animate-pulse" />
      </div>
    );
  }
  if (!readiness) return null; // readiness fetch failed
  // Finished contest (fantasy_rebuild_all_periods marks it complete): nothing
  // left to set up or wait for — only a completed draft keeps its results link.
  if (contest.status === 'complete' && draft?.status !== 'complete') return null;

  const roomPath = `/fantasy/l/${contest.id}/draft`;
  const setupPath = `/fantasy/l/${contest.id}/draft/setup`;
  const teamCountCaption = `${readiness.teamCount}/${readiness.maxTeams ?? '∞'} teams · min ${readiness.minTeams}`;

  // ── No draft scheduled ──────────────────────────────────────────────────
  if (!draft) {
    return (
      <div className="bg-surface rounded-card-lg shadow-card p-5 lg:p-6">
        <div className="text-[10.5px] font-bold tracking-[0.14em] uppercase text-faint font-tight mb-2">
          Draft
        </div>
        {isCommissioner ? (
          <>
            <h3 className="font-display italic text-[20px] font-bold tracking-[-0.02em] text-ink mb-2.5">
              No draft scheduled
            </h3>
            <Link
              href={setupPath}
              className={[
                'inline-flex items-center justify-center gap-2 px-5 py-3 rounded-full min-h-[44px]',
                'bg-accent text-accent-ink font-tight text-[12px] font-bold tracking-[0.06em] uppercase',
                'hover:opacity-90 transition-opacity duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
              ].join(' ')}
            >
              Set up the draft
            </Link>
          </>
        ) : (
          <p className="font-tight text-[14px] text-muted leading-relaxed">
            The commissioner hasn&apos;t scheduled the draft yet.
          </p>
        )}
        <p className="mt-2.5 font-tight text-[11.5px] text-faint">{teamCountCaption}</p>
      </div>
    );
  }

  // ── Live ─────────────────────────────────────────────────────────────────
  if (draft.status === 'live') {
    return (
      <Link
        href={roomPath}
        className={[
          'block bg-accent text-accent-ink rounded-card-lg shadow-card p-5 lg:p-6',
          'hover:opacity-90 transition-opacity duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
        ].join(' ')}
      >
        <div className="text-[10.5px] font-bold tracking-[0.14em] uppercase text-accent-ink/80 font-tight mb-2">
          Draft
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="font-display italic text-[20px] font-bold tracking-[-0.02em]">
            Draft in progress
          </span>
          <span className="font-tight text-[12px] font-bold tracking-[0.06em] uppercase whitespace-nowrap">
            Enter room →
          </span>
        </div>
      </Link>
    );
  }

  // ── Complete ─────────────────────────────────────────────────────────────
  if (draft.status === 'complete') {
    return (
      <div className="bg-surface rounded-card-lg shadow-card p-5 lg:p-6">
        <div className="text-[10.5px] font-bold tracking-[0.14em] uppercase text-faint font-tight mb-2">
          Draft
        </div>
        <h3 className="font-display italic text-[20px] font-bold tracking-[-0.02em] text-ink mb-2.5">
          Draft complete
        </h3>
        <Link
          href={roomPath}
          className={[
            'inline-flex items-center justify-center gap-2 px-5 py-3 rounded-full min-h-[44px]',
            'bg-accent text-accent-ink font-tight text-[12px] font-bold tracking-[0.06em] uppercase',
            'hover:opacity-90 transition-opacity duration-150',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
          ].join(' ')}
        >
          View results
        </Link>
      </div>
    );
  }

  // ── Scheduled ────────────────────────────────────────────────────────────
  const scheduledAtMs = draft.scheduledAt ? new Date(draft.scheduledAt).getTime() : null;
  const msUntil = scheduledAtMs != null ? scheduledAtMs - now : null;
  const roomOpen = msUntil != null && msUntil <= FOUR_HOURS_MS;
  const typeSummary =
    draft.draftType === 'auction'
      ? `Auction · $${draft.budget} budget · ${draft.rounds} rounds`
      : `Snake · ${draft.rounds} rounds · ${draft.pickSeconds}s per pick`;

  return (
    <div className="bg-surface rounded-card-lg shadow-card p-5 lg:p-6">
      <div className="text-[10.5px] font-bold tracking-[0.14em] uppercase text-faint font-tight mb-2">
        Draft{draft.scheduledAt ? ` · ${formatScheduled(draft.scheduledAt)}` : ''}
      </div>

      {msUntil != null && (
        <div className="flex items-baseline gap-2 mt-1.5 mb-1">
          <span className="font-tight text-[22px] font-bold tabular text-ink">{formatCountdown(msUntil)}</span>
        </div>
      )}

      <p className="font-tight text-[13px] text-muted mb-3.5">{typeSummary}</p>

      <Link
        href={roomOpen ? roomPath : '#'}
        aria-disabled={!roomOpen}
        onClick={(e) => {
          if (!roomOpen) e.preventDefault();
        }}
        className={[
          'inline-flex items-center justify-center gap-2 px-5 py-3 rounded-full min-h-[44px]',
          'font-tight text-[12px] font-bold tracking-[0.06em] uppercase transition-opacity duration-150',
          roomOpen
            ? 'bg-accent text-accent-ink hover:opacity-90 cursor-pointer'
            : 'bg-ink/[0.08] text-faint cursor-not-allowed',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
        ].join(' ')}
      >
        Enter draft room
      </Link>
      {!roomOpen && <p className="mt-2.5 font-tight text-[11.5px] text-faint">Room opens 4 hours before</p>}

      {readiness.missed && (
        <div className="flex gap-2.5 px-3.5 py-3 rounded-card-sm bg-live/[0.08] mt-3.5">
          <p className="font-tight text-[12.5px] leading-relaxed text-ink">
            Draft time passed — the commissioner needs to reschedule (at least a day after the
            original).
          </p>
        </div>
      )}
      {!readiness.rostersReady && (
        <div className="flex gap-2.5 px-3.5 py-3 rounded-card-sm bg-live/[0.08] mt-3.5">
          <p className="font-tight text-[12.5px] leading-relaxed text-ink">
            Rosters not set on {readiness.sourceLabel} — draft will be another day.
          </p>
        </div>
      )}

      <p className="mt-2.5 font-tight text-[11.5px] text-faint">{teamCountCaption}</p>
    </div>
  );
}

export default DraftCard;
