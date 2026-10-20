'use client';

// ProposeTradeDialog — modal to build a trade offer. Step 1 pick the other
// team (from standings, minus mine); step 2 pick 1-4 players from each
// roster (checkboxes), optional note, then send. Can be opened pre-seeded
// with a target team + a player already checked into `get` (players-panel's
// "Trade" button on another team's rostered player). Follows the DropModal
// portal + backdrop + escape-key + body-scroll-lock pattern from
// players-panel.tsx. Web port of the mobile app's ProposeTradeSheet.tsx
// (altiusapps/mobileapp-thelayout ·
// src/components/fantasy/trades/ProposeTradeSheet.tsx).

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { getTeamPlayers, proposeTrade, type ContestView, type TradeRef } from '@/lib/fantasy/leagues';

const MAX_PER_SIDE = 4;
const NOTE_MAX = 280;

interface TeamOption {
  teamId: string;
  teamName: string;
}

interface Props {
  contest: ContestView;
  myTeam: TeamOption;
  /** All other teams in the contest to trade with. */
  otherTeams: TeamOption[];
  /** Pre-select the other team (e.g. opened from a player row). */
  initialTeamId?: string;
  /** Pre-check this player of the target team into "get". */
  initialGetPlayerId?: string;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

export function ProposeTradeDialog({ contest, myTeam, otherTeams, initialTeamId, initialGetPlayerId, onClose, onDone }: Props) {
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

  const [step, setStep] = useState<'team' | 'players'>(initialTeamId ? 'players' : 'team');
  const [theirTeamId, setTheirTeamId] = useState<string | null>(initialTeamId ?? null);
  const [giveIds, setGiveIds] = useState<Set<string>>(new Set());
  const [getIds, setGetIds] = useState<Set<string>>(new Set(initialGetPlayerId ? [initialGetPlayerId] : []));
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [myRoster, setMyRoster] = useState<{ playerLeague: string; playerId: string; playerName: string }[]>([]);
  const [myLoading, setMyLoading] = useState(true);
  const [theirRoster, setTheirRoster] = useState<{ playerLeague: string; playerId: string; playerName: string }[]>([]);
  const [theirLoading, setTheirLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setMyLoading(true);
    getTeamPlayers(contest.id, myTeam.teamId)
      .then((rows) => !cancelled && setMyRoster(rows))
      .catch(() => !cancelled && setMyRoster([]))
      .finally(() => !cancelled && setMyLoading(false));
    return () => {
      cancelled = true;
    };
  }, [contest.id, myTeam.teamId]);

  useEffect(() => {
    if (!theirTeamId) {
      setTheirRoster([]);
      return;
    }
    let cancelled = false;
    setTheirLoading(true);
    getTeamPlayers(contest.id, theirTeamId)
      .then((rows) => !cancelled && setTheirRoster(rows))
      .catch(() => !cancelled && setTheirRoster([]))
      .finally(() => !cancelled && setTheirLoading(false));
    return () => {
      cancelled = true;
    };
  }, [contest.id, theirTeamId]);

  const theirTeam = useMemo(() => otherTeams.find((t) => t.teamId === theirTeamId) ?? null, [otherTeams, theirTeamId]);

  useEffect(() => {
    // Switching the target team invalidates any prior selection from theirs.
    setGetIds((prev) => {
      if (!theirTeamId) return new Set();
      return new Set([...prev].filter((id) => theirRoster.some((p) => p.playerId === id)));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theirTeamId, theirRoster]);

  const toggle = (set: Set<string>, setSet: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) {
      next.delete(id);
    } else {
      if (next.size >= MAX_PER_SIDE) return;
      next.add(id);
    }
    setSet(next);
  };

  const giveRefs: TradeRef[] = myRoster
    .filter((p) => giveIds.has(p.playerId))
    .map((p) => ({ playerLeague: p.playerLeague, playerId: p.playerId, playerName: p.playerName }));
  const getRefs: TradeRef[] = theirRoster
    .filter((p) => getIds.has(p.playerId))
    .map((p) => ({ playerLeague: p.playerLeague, playerId: p.playerId, playerName: p.playerName }));

  const canSend = Boolean(theirTeamId) && giveRefs.length > 0 && getRefs.length > 0 && !sending;

  const summaryLine =
    giveRefs.length > 0 && getRefs.length > 0
      ? `You give ${giveRefs.map((p) => p.playerName).join(', ')} for ${getRefs.map((p) => p.playerName).join(', ')}`
      : null;

  const handleSend = async () => {
    if (!theirTeamId || !canSend) return;
    setSending(true);
    setError(null);
    try {
      await proposeTrade(contest.id, theirTeamId, giveRefs, getRefs, note.trim() || undefined);
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send this trade — try again.');
    } finally {
      setSending(false);
    }
  };

  if (!mounted) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="propose-trade-title"
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full sm:max-w-[440px] max-h-[85%] overflow-y-auto bg-surface rounded-t-card-lg sm:rounded-card-lg shadow-hero">
        <div className="flex items-center justify-between gap-4 px-6 pt-5 pb-3">
          <span id="propose-trade-title" className="font-tight text-[15px] font-bold text-ink truncate">
            {step === 'team' ? 'Propose a trade' : `Trade with ${theirTeam?.teamName ?? 'team'}`}
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

        {step === 'team' ? (
          <div className="pb-6">
            {otherTeams.length === 0 ? (
              <p className="px-6 py-3 font-tight text-[13px] text-faint">No other teams to trade with yet.</p>
            ) : (
              otherTeams.map((t, idx) => (
                <button
                  key={t.teamId}
                  type="button"
                  onClick={() => {
                    setTheirTeamId(t.teamId);
                    setStep('players');
                  }}
                  className={[
                    'w-full text-left px-6 py-4 min-h-[48px] cursor-pointer',
                    'hover:bg-surface-hi transition-colors duration-150',
                    idx > 0 ? 'border-t border-hairline' : '',
                    'focus-visible:outline-none focus-visible:bg-surface-hi',
                  ].join(' ')}
                >
                  <span className="font-tight text-[15px] font-bold text-ink truncate">{t.teamName}</span>
                </button>
              ))
            )}
          </div>
        ) : (
          <div className="px-6 pb-6">
            <button
              type="button"
              onClick={() => setStep('team')}
              className="py-2 mb-1 font-tight text-[12.5px] font-bold text-accent cursor-pointer"
            >
              Choose a different team
            </button>

            <p className="font-tight text-[11px] font-bold tracking-[0.1em] uppercase text-muted mt-2 mb-1">
              You give ({giveIds.size}/{MAX_PER_SIDE})
            </p>
            {myLoading ? (
              <div className="py-3 flex justify-center">
                <div className="w-4 h-4 rounded-full border-2 border-ink/15 border-t-accent animate-spin" aria-hidden="true" />
              </div>
            ) : myRoster.length === 0 ? (
              <p className="py-3 font-tight text-[13px] text-faint">You have no rostered players.</p>
            ) : (
              <div className="rounded-card-sm shadow-soft overflow-hidden">
                {myRoster.map((p, idx) => (
                  <PlayerCheckRow
                    key={p.playerId}
                    label={p.playerName}
                    checked={giveIds.has(p.playerId)}
                    onToggle={() => toggle(giveIds, setGiveIds, p.playerId)}
                    first={idx === 0}
                  />
                ))}
              </div>
            )}

            <p className="font-tight text-[11px] font-bold tracking-[0.1em] uppercase text-muted mt-[18px] mb-1">
              {theirTeam?.teamName ?? 'They'} give ({getIds.size}/{MAX_PER_SIDE})
            </p>
            {theirLoading ? (
              <div className="py-3 flex justify-center">
                <div className="w-4 h-4 rounded-full border-2 border-ink/15 border-t-accent animate-spin" aria-hidden="true" />
              </div>
            ) : theirRoster.length === 0 ? (
              <p className="py-3 font-tight text-[13px] text-faint">That team has no rostered players.</p>
            ) : (
              <div className="rounded-card-sm shadow-soft overflow-hidden">
                {theirRoster.map((p, idx) => (
                  <PlayerCheckRow
                    key={p.playerId}
                    label={p.playerName}
                    checked={getIds.has(p.playerId)}
                    onToggle={() => toggle(getIds, setGetIds, p.playerId)}
                    first={idx === 0}
                  />
                ))}
              </div>
            )}

            <p className="font-tight text-[11px] font-bold tracking-[0.1em] uppercase text-muted mt-[18px] mb-1">
              Note (optional)
            </p>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
              placeholder="Say something about this offer…"
              maxLength={NOTE_MAX}
              aria-label="Trade note"
              className={[
                'w-full min-h-[60px] max-h-[100px] px-3.5 py-2.5 rounded-card-sm bg-ink/5',
                'font-tight text-[14px] text-ink placeholder:text-faint resize-none',
                'focus:outline-none focus:ring-2 focus:ring-accent',
              ].join(' ')}
            />

            {summaryLine && <p className="font-tight text-[12.5px] text-muted mt-3.5 leading-[18px]">{summaryLine}</p>}
            {error && (
              <p className="font-tight text-[12.5px] text-live mt-2.5" role="alert">
                {error}
              </p>
            )}

            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={!canSend}
              className={[
                'w-full mt-4 mb-2 min-h-[48px] rounded-full flex items-center justify-center',
                'font-tight text-[13px] font-bold tracking-[0.06em] uppercase cursor-pointer',
                'transition-opacity duration-150',
                canSend ? 'bg-accent text-accent-ink hover:opacity-90' : 'bg-ink/[0.08] text-faint cursor-not-allowed',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              ].join(' ')}
            >
              {sending ? (
                <span className="inline-block w-4 h-4 rounded-full border-2 border-accent-ink/30 border-t-accent-ink animate-spin" aria-hidden="true" />
              ) : (
                'Send offer'
              )}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function PlayerCheckRow({
  label,
  checked,
  onToggle,
  first,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  first: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      className={[
        'w-full flex items-center gap-3 px-3.5 py-3 min-h-[48px] text-left cursor-pointer',
        'hover:bg-surface-hi transition-colors duration-150',
        !first ? 'border-t border-hairline' : '',
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
            <path d="M2.5 7.2l3 3 6-6.4" stroke="currentColor" className="text-accent-ink" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className="flex-1 min-w-0 font-tight text-[14px] font-medium text-ink truncate">{label}</span>
    </button>
  );
}

export default ProposeTradeDialog;
