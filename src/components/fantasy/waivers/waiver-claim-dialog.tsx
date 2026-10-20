'use client';

// WaiverClaimDialog — modal to place a FAAB bid on a waiver player. Header
// shows budget left, a bid stepper (clamped to what's left), and an optional
// single-select "drop a player" list from my roster. Follows the same
// portal + backdrop + escape-key + body-scroll-lock pattern as
// propose-trade-dialog.tsx. Web port of the mobile app's
// WaiverClaimSheet.tsx (altiusapps/mobileapp-thelayout ·
// src/components/fantasy/waivers/WaiverClaimSheet.tsx).

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  getTeamPlayers,
  getFaabSpent,
  claimWaiver,
  waiverSettings,
  type ContestView,
  type TradeRef,
} from '@/lib/fantasy/leagues';

interface Props {
  contest: ContestView;
  teamId: string;
  addPlayer: { playerId: string; playerName: string };
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

export function WaiverClaimDialog({ contest, teamId, addPlayer, onClose, onDone }: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const league = contest.competitionDef.playerLeague;
  const { budget } = waiverSettings(contest.settings);

  const [spent, setSpent] = useState(0);
  useEffect(() => {
    let cancelled = false;
    getFaabSpent(contest.id, teamId)
      .then((n) => !cancelled && setSpent(n))
      .catch(() => !cancelled && setSpent(0));
    return () => {
      cancelled = true;
    };
  }, [contest.id, teamId]);

  const remaining = Math.max(0, budget - spent);

  const [myRoster, setMyRoster] = useState<{ playerLeague: string; playerId: string; playerName: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    getTeamPlayers(contest.id, teamId)
      .then((rows) => !cancelled && setMyRoster(rows))
      .catch(() => !cancelled && setMyRoster([]));
    return () => {
      cancelled = true;
    };
  }, [contest.id, teamId]);

  const [bid, setBid] = useState(0);
  useEffect(() => setBid(Math.min(1, remaining)), [remaining]);
  const [dropId, setDropId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clampBid = (n: number) => Math.max(0, Math.min(remaining, n));

  const dropRef: TradeRef | null = dropId
    ? (() => {
        const p = myRoster.find((r) => r.playerId === dropId);
        return p ? { playerLeague: p.playerLeague, playerId: p.playerId, playerName: p.playerName } : null;
      })()
    : null;

  const handleSubmit = async () => {
    setSending(true);
    setError(null);
    try {
      await claimWaiver(
        contest.id,
        { playerLeague: league, playerId: addPlayer.playerId, playerName: addPlayer.playerName },
        bid,
        dropRef,
      );
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not place this claim — try again.');
    } finally {
      setSending(false);
    }
  };

  if (!mounted) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="waiver-claim-title"
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full sm:max-w-[440px] max-h-[85%] overflow-y-auto bg-surface rounded-t-card-lg sm:rounded-card-lg shadow-hero">
        <div className="flex items-center justify-between gap-4 px-6 pt-5 pb-3">
          <span id="waiver-claim-title" className="font-tight text-[15px] font-bold text-ink truncate">
            Claim {addPlayer.playerName}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={[
              'w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0',
              'text-faint hover:text-ink hover:bg-ink/5 transition-colors duration-150 cursor-pointer',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            ].join(' ')}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <p className="px-6 pb-3 font-tight text-[12.5px] text-muted">
          Budget left ${remaining} of ${budget}
        </p>

        <div className="px-6 pb-6">
          <p className="font-tight text-[11px] font-bold tracking-[0.1em] uppercase text-muted mb-2">Bid</p>
          <div className="flex items-center gap-2 mb-5">
            <button
              type="button"
              onClick={() => setBid((v) => clampBid(v - 5))}
              aria-label="Decrease bid by 5 dollars"
              className="min-h-[40px] px-3 rounded-full flex items-center justify-center bg-ink/[0.05] hover:bg-ink/10 transition-colors duration-150 cursor-pointer font-tight text-[13px] font-bold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              −5
            </button>
            <button
              type="button"
              onClick={() => setBid((v) => clampBid(v - 1))}
              aria-label="Decrease bid by 1 dollar"
              className="min-h-[40px] px-3 rounded-full flex items-center justify-center bg-ink/[0.05] hover:bg-ink/10 transition-colors duration-150 cursor-pointer font-tight text-[13px] font-bold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              −1
            </button>
            <span className="flex-1 text-center font-tight text-[20px] font-bold text-ink tabular">${bid}</span>
            <button
              type="button"
              onClick={() => setBid((v) => clampBid(v + 1))}
              aria-label="Increase bid by 1 dollar"
              className="min-h-[40px] px-3 rounded-full flex items-center justify-center bg-ink/[0.05] hover:bg-ink/10 transition-colors duration-150 cursor-pointer font-tight text-[13px] font-bold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              +1
            </button>
            <button
              type="button"
              onClick={() => setBid((v) => clampBid(v + 5))}
              aria-label="Increase bid by 5 dollars"
              className="min-h-[40px] px-3 rounded-full flex items-center justify-center bg-ink/[0.05] hover:bg-ink/10 transition-colors duration-150 cursor-pointer font-tight text-[13px] font-bold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              +5
            </button>
          </div>

          <p className="font-tight text-[11px] font-bold tracking-[0.1em] uppercase text-muted mb-1">
            Drop a player (optional)
          </p>
          {myRoster.length === 0 ? (
            <p className="py-3 font-tight text-[13px] text-faint">You have no rostered players.</p>
          ) : (
            <div className="rounded-card-sm shadow-soft overflow-hidden">
              {myRoster.map((p, idx) => {
                const checked = dropId === p.playerId;
                return (
                  <button
                    key={p.playerId}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    aria-label={`Drop ${p.playerName}`}
                    onClick={() => setDropId(checked ? null : p.playerId)}
                    className={[
                      'w-full flex items-center gap-3 px-3.5 py-3 min-h-[48px] text-left cursor-pointer',
                      'hover:bg-surface-hi transition-colors duration-150',
                      idx > 0 ? 'border-t border-hairline' : '',
                      'focus-visible:outline-none focus-visible:bg-surface-hi',
                    ].join(' ')}
                  >
                    <span
                      className={[
                        'w-[22px] h-[22px] rounded-[6px] border-[1.5px] flex items-center justify-center flex-shrink-0',
                        checked ? 'bg-accent border-accent' : 'border-ink/20',
                      ].join(' ')}
                    >
                      {checked && (
                        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                          <path
                            d="M2.5 7.2l3 3 6-6.4"
                            stroke="currentColor"
                            className="text-accent-ink"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </span>
                    <span className="flex-1 min-w-0 font-tight text-[14px] font-medium text-ink truncate">
                      {p.playerName}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {error && (
            <p className="font-tight text-[12.5px] text-live mt-3" role="alert">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={sending}
            className={[
              'w-full mt-5 min-h-[48px] rounded-full flex items-center justify-center',
              'bg-accent text-accent-ink font-tight text-[13px] font-bold tracking-[0.06em] uppercase',
              'hover:opacity-90 transition-opacity duration-150 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            ].join(' ')}
          >
            {sending ? (
              <span className="inline-block w-4 h-4 rounded-full border-2 border-accent-ink/30 border-t-accent-ink animate-spin" aria-hidden="true" />
            ) : (
              'Place claim'
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default WaiverClaimDialog;
