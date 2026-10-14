'use client';

// Create-league form — auth-gated, create-only (joining moved to the hub's
// Join league button, Hunter 2026-10-07). name + game + total teams + draft
// type (+ division, for USAU Nationals) → createLeague + createContest (setup
// in the contest's single INSERT) → revalidate → redirect into the league.
// Total teams and draft type stay commissioner-editable in League Settings
// until the draft goes live; the division is fixed at creation.
// Players per team isn't asked: it's fixed by the game (teamSize).
//
// The game is chosen HERE (2026-08-27, Hunter): a league is created FOR a game.
// It used to be a bare name, with a separate "enter this league into another
// game" panel on the league page afterwards — which exposed the internal
// "contest" concept the IA plan says should stay hidden, and left every new
// league in an empty, unusable state until the commissioner found that panel.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthGate } from '@/components/auth/auth-gate';
import { PillSelect, type PillSelectOption } from '@/components/pill-select';
import { ToggleSwitch } from '@/components/fantasy/settings/shared';
import { StepButton, stepTeams } from '@/components/fantasy/settings/limits-card';
import { TypeOption } from '@/components/fantasy/settings/draft-settings-card';
import { createLeague, createContest, setLeaguePublic } from '@/lib/fantasy/leagues';
import { nextStartForGame, type GameStartMap } from '@/lib/fantasy/game-dates';
import { revalidateFantasyLeague } from '@/app/fantasy/leagues/actions';
import {
  DEFAULT_MAX_TEAMS,
  MIN_TEAMS,
  divisionLabel,
  supportedDivisions,
  type CompetitionId,
  type FantasyDivision,
} from '@/lib/fantasy/competitions';
import type { DraftType } from '@/lib/fantasy/draft-room';
import { GAMES } from '@/lib/fantasy/games';

interface CreateLeagueFormProps {
  /** Preseeds the game picker (from the hub's ?game= query string). Only
   *  applied when that game can start a league right now — otherwise the
   *  picker starts empty rather than quietly swapping in another game. */
  initialGameId?: CompetitionId;
  /** Per-game startability + season/event, resolved on the server by the
   *  same getGameStartDates the hub renders, so the picker and hub agree. */
  starts: GameStartMap;
}

export function CreateLeagueForm({ initialGameId, starts }: CreateLeagueFormProps) {
  return (
    <AuthGate
      headline="Sign in to create a league."
      subhead="Leagues are free — start one and invite your friends."
    >
      <div className="max-w-[480px]">
        <Form initialGameId={initialGameId} starts={starts} />
      </div>
    </AuthGate>
  );
}

// A game is selectable only when it can start a league NOW: live in the
// registry AND its next season/event still has its first lock ahead
// (starts[id].startable — the hub's rule). The rest render disabled so the
// roadmap stays visible. No "soon" suffix — unavailability is carried by the
// disabled state alone (Hunter, 2026-09-08: no "beta"/"coming soon" wording).
type GameChoice = CompetitionId | '';

function isStartable(id: CompetitionId, starts: GameStartMap): boolean {
  return GAMES.some((g) => g.id === id && g.status === 'live') && !!starts[id]?.startable;
}

function Form({ initialGameId, starts }: CreateLeagueFormProps) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [gameId, setGameId] = useState<GameChoice>(
    initialGameId && isStartable(initialGameId, starts) ? initialGameId : '',
  );
  const [maxTeams, setMaxTeams] = useState(DEFAULT_MAX_TEAMS);
  const [draftType, setDraftType] = useState<DraftType>('snake');
  const [division, setDivision] = useState<FantasyDivision>('all');
  const [isPublic, setIsPublic] = useState(false);
  // Set once createLeague succeeds, so a retry after a failed contest step
  // reuses that league instead of creating a second one.
  const [leagueId, setLeagueId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options: PillSelectOption<GameChoice>[] = [
    { value: '', label: 'Choose a game', disabled: true },
    ...GAMES.filter((g) => g.status !== 'hidden').map((g) => ({
      value: g.id,
      label: g.name,
      disabled: !isStartable(g.id, starts),
    })),
  ];

  // Only USAU Nationals have divisions; a pick the new game doesn't offer
  // (Mixed → College) falls back to All.
  const divisions = gameId === '' ? [] : supportedDivisions(gameId);
  const handleGameChange = (next: GameChoice) => {
    setGameId(next);
    if (next === '' || !supportedDivisions(next).includes(division)) setDivision('all');
  };

  const trimmed = name.trim();
  const canSubmit = trimmed.length >= 1 && trimmed.length <= 60 && gameId !== '' && !saving;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return; // canSubmit implies a game is chosen (narrows gameId)
    const seasonYear = starts[gameId]?.seasonYear;
    if (seasonYear == null) return;
    setSaving(true);
    setError(null);
    try {
      // Re-check right before anything is created: the page's start data can
      // be a few minutes old, and a league must never be left without a
      // contest because its event started in the meantime.
      const fresh = await nextStartForGame(gameId);
      if (!fresh.startable || fresh.seasonYear !== seasonYear) {
        throw new Error('That game just stopped taking new leagues — reload the page to see what can start now.');
      }
      const id = leagueId ?? (await createLeague(trimmed));
      setLeagueId(id);
      if (isPublic) await setLeaguePublic(id, true);
      const contestId = await createContest(id, gameId, seasonYear, undefined, { maxTeams, draftType, division });
      await revalidateFantasyLeague(id, contestId).catch(() => null);
      router.push(`/fantasy/l/${contestId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create your league. Please try again.');
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="bg-surface rounded-card shadow-card p-4 lg:p-6">
        <label
          htmlFor="league-name"
          className="block text-[11px] font-bold tracking-[0.14em] uppercase text-faint font-tight mb-1.5"
        >
          League Name
        </label>
        <input
          id="league-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          placeholder="e.g. The Huckin' Crew"
          className={[
            'w-full px-3.5 py-2.5 rounded-card-sm bg-ink/5',
            'font-tight text-[14px] text-ink placeholder:text-faint',
            'focus:outline-none focus:ring-2 focus:ring-accent',
            'min-h-[44px]',
          ].join(' ')}
        />
        <p className="mt-1 text-[11px] text-faint font-tight">{trimmed.length}/60 characters</p>

        <div className="mt-4 lg:mt-5">
          <div className="block text-[11px] font-bold tracking-[0.14em] uppercase text-faint font-tight mb-1.5">
            Game
          </div>
          <PillSelect
            value={gameId}
            onChange={handleGameChange}
            ariaLabel="Which game is this league for"
            options={options}
          />
          <p className="mt-1.5 text-[11px] text-faint font-tight">
            Everyone in this league drafts and scores in this game.
          </p>
        </div>

        {divisions.length > 0 && (
          <div className="mt-4 lg:mt-5">
            <span
              id="division-label"
              className="block text-[11px] font-bold tracking-[0.14em] uppercase text-faint font-tight mb-1.5"
            >
              Division
            </span>
            <div
              role="radiogroup"
              aria-labelledby="division-label"
              className={[
                'grid grid-cols-2 gap-2',
                divisions.length === 4 ? 'sm:grid-cols-4' : 'sm:grid-cols-3',
              ].join(' ')}
            >
              {divisions.map((d) => (
                <TypeOption
                  key={d}
                  label={d === 'all' ? 'All' : divisionLabel(d)}
                  selected={division === d}
                  onClick={() => setDivision(d)}
                />
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-faint font-tight">
              Only players in this division are in the draft. This can&apos;t be changed later.
            </p>
          </div>
        )}

        <div className="mt-4 lg:mt-5">
          <span
            id="total-teams-label"
            className="block text-[11px] font-bold tracking-[0.14em] uppercase text-faint font-tight mb-1.5"
          >
            Total teams
          </span>
          <div role="group" aria-labelledby="total-teams-label" className="flex items-center gap-2.5">
            <StepButton
              label="Fewer teams"
              disabled={maxTeams !== Infinity && maxTeams <= MIN_TEAMS}
              onClick={() => setMaxTeams((v) => stepTeams(v, -1))}
            >
              −
            </StepButton>
            <span aria-live="polite" className="min-w-[40px] text-center font-tight text-[15px] font-bold text-ink tabular">
              {maxTeams === Infinity ? '∞' : maxTeams}
            </span>
            <StepButton
              label="More teams"
              disabled={maxTeams === Infinity}
              onClick={() => setMaxTeams((v) => stepTeams(v, 1))}
            >
              +
            </StepButton>
          </div>
          <p className="mt-1.5 text-[11px] text-faint font-tight">Minimum {MIN_TEAMS} teams to draft.</p>
        </div>

        <div className="mt-4 lg:mt-5">
          <span
            id="draft-type-label"
            className="block text-[11px] font-bold tracking-[0.14em] uppercase text-faint font-tight mb-1.5"
          >
            Draft
          </span>
          <div role="radiogroup" aria-labelledby="draft-type-label" className="flex gap-2">
            <TypeOption label="Snake" selected={draftType === 'snake'} onClick={() => setDraftType('snake')} />
            <TypeOption label="Auction" selected={draftType === 'auction'} onClick={() => setDraftType('auction')} />
          </div>
          <p className="mt-1.5 text-[11px] text-faint font-tight">
            You&apos;ll set the draft time later in League Settings.
          </p>
        </div>

        <div className="mt-4 lg:mt-5 flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <span id="public-league-label" className="block font-tight text-[13.5px] font-semibold text-ink">
              Public league
            </span>
            <p className="mt-0.5 text-[11px] text-faint font-tight">
              Anyone can find and join it from Fantasy → Public. Drafted leagues still cap at 16 teams.
            </p>
          </div>
          <ToggleSwitch checked={isPublic} onChange={() => setIsPublic((v) => !v)} label="Public league" />
        </div>

        {error && (
          <div className="mt-4 px-4 py-3 rounded-card-sm bg-live/[0.08]">
            <span className="font-tight text-[13px] text-ink">{error}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className={[
            'mt-4 lg:mt-5 inline-flex items-center justify-center gap-2',
            'px-6 py-3 rounded-full min-h-[44px] w-full sm:w-auto',
            'font-tight text-[13px] font-bold tracking-[0.06em] uppercase',
            'transition-all duration-150',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
            canSubmit
              ? 'bg-accent text-accent-ink hover:opacity-90 cursor-pointer'
              : 'bg-ink/[0.08] text-faint cursor-not-allowed',
          ].join(' ')}
        >
          {saving && (
            <span
              className="w-4 h-4 rounded-full border-2 border-current/30 border-t-current animate-spin"
              aria-hidden="true"
            />
          )}
          {saving ? 'Creating…' : 'Create league'}
        </button>
      </div>
    </form>
  );
}
