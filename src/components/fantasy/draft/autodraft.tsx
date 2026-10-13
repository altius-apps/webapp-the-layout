'use client';

// Autodraft (Hunter, 2026-10-08). A missed pick drafts the next player in line
// (the team's queue, then the best available) and puts the team on autodraft.
// A manager can turn it on or off for their own team. A team on autodraft
// picks, or nominates, the moment it's up. fantasy_set_autodraft enforces
// "own team only". The toggle lives in the room's settings popover (gear).

import { useState } from 'react';
import { setAutodraft } from '@/lib/fantasy/draft-room';
import { ToggleSwitch } from '@/components/fantasy/settings/shared';

export function AutoBadge() {
  return (
    <span className="flex-shrink-0 px-1.5 py-0.5 rounded-sm bg-ink/[0.08] text-muted font-tight text-[9.5px] font-bold tracking-[0.14em] uppercase">
      Auto
    </span>
  );
}

export function AutodraftToggle({
  draftId,
  on,
  onChanged,
}: {
  draftId: string;
  on: boolean;
  /** Called with the new state once the server has it. */
  onChanged: (next: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onChanged(await setAutodraft(draftId, !on));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change autodraft.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="m-0 font-tight text-[13.5px] font-bold text-ink">Autodraft</p>
          <p className="m-0 font-tight text-[12px] text-muted leading-snug">
            {on
              ? "You're on autodraft. Turn it off to pick yourself."
              : "We'll pick for you instantly — your queue first, then the top-ranked player left."}
          </p>
        </div>
        <ToggleSwitch checked={on} onChange={toggle} disabled={busy} label="Autodraft" />
      </div>
      {error && (
        <p role="alert" className="mt-2 mb-0 text-[12px] text-live font-tight">
          {error}
        </p>
      )}
    </div>
  );
}
