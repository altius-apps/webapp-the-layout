'use client';

// CommissionerBar — commissioner-only draft controls (undo, skip clock).
// Rendered by DraftRoom above the room content while the draft is live. There
// is no pause: once a draft starts it runs to the end (Hunter, 2026-10-08).
// Destructive actions (undo, skip) confirm before calling.
// Ported from mobile CommissionerBar.tsx by intent.

import { useState } from 'react';
import { undoLastPick, skipClock, type Draft } from '@/lib/fantasy/draft-room';

interface CommissionerBarProps {
  draft: Draft;
  pickCount: number;
  refetch: () => Promise<void> | void;
}

export function CommissionerBar({ draft, pickCount, refetch }: CommissionerBarProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showError = (err: unknown, fallback: string) => {
    setError(err instanceof Error ? err.message : fallback);
    setTimeout(() => setError(null), 4000);
  };

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refetch();
    } catch (err) {
      showError(err, fallback);
    } finally {
      setBusy(false);
    }
  };

  const confirmUndo = () => {
    if (!window.confirm('Undo last pick? This reverts the most recent pick and restarts the clock.')) return;
    run(() => undoLastPick(draft.id), 'Could not undo the last pick.');
  };

  const confirmSkip = () => {
    if (!window.confirm('Skip the clock? The team on the clock is autopicked right now and switched to autodraft.')) return;
    run(() => skipClock(draft.id), 'Could not skip the clock.');
  };

  return (
    <div className="bg-surface rounded-card-lg shadow-card px-4 py-3.5 lg:px-5">
      <div className="text-[10.5px] font-bold tracking-[0.14em] uppercase text-muted font-tight mb-2">
        Commissioner
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={confirmUndo}
          disabled={busy || pickCount === 0}
          className={[
            'px-4 py-2 rounded-full min-h-[44px] border-[1.5px] border-ink/15',
            'font-tight text-[11px] font-bold tracking-[0.08em] uppercase text-ink transition-opacity duration-150',
            'hover:opacity-80 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed',
          ].join(' ')}
        >
          Undo pick
        </button>
        <button
          type="button"
          onClick={confirmSkip}
          disabled={busy}
          className={[
            'px-4 py-2 rounded-full min-h-[44px] border-[1.5px] border-ink/15',
            'font-tight text-[11px] font-bold tracking-[0.08em] uppercase text-ink transition-opacity duration-150',
            'hover:opacity-80 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed',
          ].join(' ')}
        >
          Skip clock
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-live font-tight">
          {error}
        </p>
      )}
    </div>
  );
}
