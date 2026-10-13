'use client';

// TradeCard — one trade in TradesPanel. Two columns ("{proposer} gives" /
// "{receiver} gives") of player names, note, status pill, and role-gated
// action buttons: receiver on proposed → Accept/Reject; proposer on
// proposed|accepted → Cancel; commissioner on proposed|accepted → Veto, and
// on accepted → Approve now. All destructive/committing actions confirm via
// ConfirmDialog; RPC errors render inline. Web port of the mobile app's
// TradeCard.tsx (altiusapps/mobileapp-thelayout ·
// src/components/fantasy/trades/TradeCard.tsx).

import { useState } from 'react';
import { respondTrade, type Trade, type TradeAction } from '@/lib/fantasy/leagues';
import { ConfirmDialog } from '@/components/confirm-dialog';

interface TeamLabel {
  teamId: string;
  teamName: string;
}

interface Props {
  trade: Trade;
  proposerTeam: TeamLabel | null;
  receiverTeam: TeamLabel | null;
  /** My team id in this contest, or null if I don't have one. */
  myTeamId: string | null;
  isCommissioner: boolean;
  onChanged: () => Promise<void> | void;
}

function statusClasses(status: Trade['status']): string {
  if (status === 'proposed' || status === 'accepted') return 'bg-accent/15 text-accent';
  if (status === 'executed') return 'bg-ink text-surface';
  return 'bg-ink/8 text-muted';
}

function statusLabel(status: Trade['status']): string {
  switch (status) {
    case 'proposed':
      return 'Pending';
    case 'accepted':
      return 'Accepted';
    case 'executed':
      return 'Executed';
    case 'rejected':
      return 'Rejected';
    case 'cancelled':
      return 'Cancelled';
    case 'vetoed':
      return 'Vetoed';
    default:
      return status;
  }
}

function formatExecutesAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const CONFIRM_COPY: Record<TradeAction, { title: string; body: string; confirmLabel: string; destructive?: boolean }> = {
  accept: {
    title: 'Accept trade?',
    body: 'This trade will execute in 24 hours unless the commissioner vetoes it.',
    confirmLabel: 'Accept',
  },
  reject: {
    title: 'Reject trade?',
    body: 'This cannot be undone.',
    confirmLabel: 'Reject',
    destructive: true,
  },
  cancel: {
    title: 'Cancel trade?',
    body: 'This will withdraw your proposal.',
    confirmLabel: 'Cancel trade',
    destructive: true,
  },
  veto: {
    title: 'Veto this trade?',
    body: 'The trade will be rejected and will not execute.',
    confirmLabel: 'Veto',
    destructive: true,
  },
  approve: {
    title: 'Approve now?',
    body: 'This skips the 24-hour review and executes the trade immediately.',
    confirmLabel: 'Approve',
  },
};

export function TradeCard({ trade, proposerTeam, receiverTeam, myTeamId, isCommissioner, onChanged }: Props) {
  const [busyAction, setBusyAction] = useState<TradeAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<TradeAction | null>(null);

  const isReceiver = myTeamId != null && myTeamId === trade.receiverTeamId;
  const isProposer = myTeamId != null && myTeamId === trade.proposerTeamId;

  const run = async (action: TradeAction) => {
    setError(null);
    setBusyAction(action);
    try {
      await respondTrade(trade.id, action);
      setConfirming(null);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong — try again.');
    } finally {
      setBusyAction(null);
    }
  };

  const actions: TradeAction[] = [];
  if (trade.status === 'proposed') {
    if (isReceiver) actions.push('accept', 'reject');
    if (isProposer) actions.push('cancel');
    if (isCommissioner) actions.push('veto');
  } else if (trade.status === 'accepted') {
    if (isProposer) actions.push('cancel');
    if (isCommissioner) actions.push('veto', 'approve');
  }

  const proposerName = proposerTeam?.teamName ?? 'A team';
  const receiverName = receiverTeam?.teamName ?? 'A team';

  return (
    <div className="bg-surface rounded-card-lg shadow-card p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span
          className={[
            'inline-flex items-center px-2.5 py-1 rounded-full font-tight text-[10px] font-bold tracking-[0.06em] uppercase',
            statusClasses(trade.status),
          ].join(' ')}
        >
          {statusLabel(trade.status)}
        </span>
        <span className="font-tight text-[11px] text-faint">{formatExecutesAt(trade.createdAt)}</span>
      </div>

      <div className="flex gap-3">
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <span className="block font-tight text-[10.5px] font-bold tracking-[0.1em] uppercase text-muted truncate">
            {proposerName} gives
          </span>
          {trade.give.map((p) => (
            <span key={`${p.playerLeague}:${p.playerId}`} className="block font-tight text-[13.5px] font-medium text-ink truncate">
              {p.playerName}
            </span>
          ))}
        </div>
        <div className="w-px bg-hairline" />
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <span className="block font-tight text-[10.5px] font-bold tracking-[0.1em] uppercase text-muted truncate">
            {receiverName} gives
          </span>
          {trade.get.map((p) => (
            <span key={`${p.playerLeague}:${p.playerId}`} className="block font-tight text-[13.5px] font-medium text-ink truncate">
              {p.playerName}
            </span>
          ))}
        </div>
      </div>

      {trade.note && <p className="font-tight text-[12.5px] text-muted italic">&ldquo;{trade.note}&rdquo;</p>}

      {trade.status === 'accepted' && trade.executesAt && (
        <p className="font-tight text-[12px] font-bold text-accent">
          Executes {formatExecutesAt(trade.executesAt)} unless vetoed
        </p>
      )}

      {error && (
        <p className="font-tight text-[12px] text-live" role="alert">
          {error}
        </p>
      )}

      {actions.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-0.5">
          {actions.map((action) => {
            const danger = action === 'reject' || action === 'veto';
            return (
              <button
                key={action}
                type="button"
                onClick={() => {
                  setError(null);
                  setConfirming(action);
                }}
                disabled={busyAction != null}
                className={[
                  'min-h-[40px] px-4 rounded-full font-tight text-[12.5px] font-bold cursor-pointer',
                  'disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150',
                  danger ? 'bg-live/10 text-live hover:bg-live/15' : 'bg-ink/5 text-ink hover:bg-ink/10',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                ].join(' ')}
              >
                {busyAction === action ? (
                  <span
                    className={[
                      'inline-block w-4 h-4 rounded-full border-2 border-t-transparent animate-spin align-middle',
                      danger ? 'border-live/40' : 'border-ink/25',
                    ].join(' ')}
                    aria-hidden="true"
                  />
                ) : (
                  CONFIRM_COPY[action].confirmLabel
                )}
              </button>
            );
          })}
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          open
          title={CONFIRM_COPY[confirming].title}
          body={CONFIRM_COPY[confirming].body}
          confirmLabel={CONFIRM_COPY[confirming].confirmLabel}
          busy={busyAction != null}
          error={error}
          onConfirm={() => void run(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

export default TradeCard;
