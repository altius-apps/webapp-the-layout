'use client';

// LimitsCard — Settings → Teams. Commissioner-only team cap: a stepper through
// TEAM_LIMIT_STOPS (2–16, then ∞ = unlimited) for every competition (web port
// of mobile's LimitsCard.tsx). Mirrors NameCard/RosterCard's save/dirty/Feedback
// shape so the whole Settings screen reads as one system. stepTeams +
// StepButton are shared with Create a League's Total teams.

import { useState } from 'react';
import { setContestLimits, type ContestView } from '@/lib/fantasy/leagues';
import { MIN_TEAMS, DEFAULT_MAX_TEAMS, TEAM_LIMIT_STOPS } from '@/lib/fantasy/competitions';
import { Card, SaveButton, Feedback } from './shared';

const UNLIMITED = Infinity;

/** Next stop in `dir` (∞ is the last); an off-list stored value (e.g. 11) steps to the nearest stop that way. */
export function stepTeams(current: number, dir: 1 | -1): number {
  if (dir === 1) return TEAM_LIMIT_STOPS.find((n) => n > current) ?? current;
  return [...TEAM_LIMIT_STOPS].reverse().find((n) => n < current) ?? current;
}

interface Props {
  contest: ContestView;
  onSaved: () => void;
}

export function LimitsCard({ contest, onSaved }: Props) {
  const s = contest.settings;
  const initial = s.unlimitedTeams ? UNLIMITED : (s.maxTeams ?? DEFAULT_MAX_TEAMS);

  const [maxTeams, setMaxTeams] = useState<number>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty = maxTeams !== initial;
  const canSave = dirty && !saving;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const unlimited = maxTeams === UNLIMITED;
      await setContestLimits(contest.id, unlimited ? DEFAULT_MAX_TEAMS : maxTeams, unlimited);
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update team limits.');
    } finally {
      setSaving(false);
    }
  };

  const step = (dir: 1 | -1) => {
    setMaxTeams((v) => stepTeams(v, dir));
    setError(null);
    setSaved(false);
  };

  return (
    <Card title="Teams">
      <form onSubmit={save}>
        <span
          id={`max-teams-label-${contest.id}`}
          className="block text-[10.5px] font-bold tracking-[0.14em] uppercase text-faint font-tight mb-1.5"
        >
          Max teams
        </span>
        <div className="flex items-center justify-between gap-3">
          <div role="group" aria-labelledby={`max-teams-label-${contest.id}`} className="flex items-center gap-2.5">
            <StepButton
              label="Fewer teams"
              disabled={maxTeams !== UNLIMITED && maxTeams <= MIN_TEAMS}
              onClick={() => step(-1)}
            >
              −
            </StepButton>
            <span aria-live="polite" className="min-w-[40px] text-center font-tight text-[15px] font-bold text-ink tabular">
              {maxTeams === UNLIMITED ? '∞' : maxTeams}
            </span>
            <StepButton label="More teams" disabled={maxTeams === UNLIMITED} onClick={() => step(1)}>
              +
            </StepButton>
          </div>
          <SaveButton disabled={!canSave} saving={saving} />
        </div>
        <p className="mt-1.5 font-tight text-[12px] text-faint">Minimum {MIN_TEAMS} teams to draft.</p>
      </form>
      <Feedback error={error} saved={saved} />
    </Card>
  );
}

export function StepButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="w-11 h-11 rounded-full flex items-center justify-center bg-ink/[0.05] hover:bg-ink/10 transition-colors duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed font-tight text-[17px] font-bold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {children}
    </button>
  );
}
