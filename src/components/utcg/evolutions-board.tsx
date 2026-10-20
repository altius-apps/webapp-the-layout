'use client';

// EvolutionsBoard — Collection tab's "Evolutions" sub-tab. Lists evolution
// defs with their stage ladders, shows in-progress/completed evolutions
// against the owner's real cards (joined by key so it's a real CardTile, not
// a fabricated one), and opens a picker (same SlotPicker/SbcPicker shell
// idiom) to start a new evolution on an eligible owned card.
//
// Eligibility = evolutionEligible(def, card) on the card's BASE playerScore
// (boost is a separate field — using playerScore alone matches the RPC's own
// gate) AND the card has no existing entry in `mine` (evolutionEligible
// itself only checks score/year; "already evolved" is this component's own
// filter, mirroring the brief's "exclude cards already evolved").

import { useEffect, useMemo, useState } from 'react';
import type { OwnedCard } from '@/lib/utcg/server';
import type { EvolutionState, EvolutionDef, CardEvolution } from '@/lib/utcg/boosts';
import { evolutionEligible, MAX_ACTIVE_EVOLUTIONS } from '@/lib/utcg/boosts';
import { CardTile } from '@/components/utcg/card-tile';

function cardKeyOf(c: { playerId: string; teamSlug: string; year: number }): string {
  return `${c.playerId}|${c.teamSlug}|${c.year}`;
}

interface EvolutionsBoardProps {
  evolutions: EvolutionState;
  owned: OwnedCard[];
  onStart: (evoKey: string, playerId: string, teamSlug: string, year: number) => void;
  starting: boolean;
  startingKey: string | null;
  startError: string | null;
}

export function EvolutionsBoard({ evolutions, owned, onStart, starting, startingKey, startError }: EvolutionsBoardProps) {
  const { defs, mine } = evolutions;
  const [pickerDef, setPickerDef] = useState<EvolutionDef | null>(null);

  const evolvedKeys = useMemo(() => new Set(mine.map(cardKeyOf)), [mine]);
  const ownedByKey = useMemo(() => {
    const m = new Map<string, OwnedCard>();
    for (const o of owned) m.set(cardKeyOf(o.card), o);
    return m;
  }, [owned]);

  const activeCount = mine.filter((e) => !e.completed).length;
  const atCap = activeCount >= MAX_ACTIVE_EVOLUTIONS;

  if (defs.length === 0) {
    return <p className="text-[13px] text-muted font-tight text-center py-12">No evolutions available right now.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {startError && (
        <p className="text-[12px] text-live font-tight" role="alert">{startError}</p>
      )}

      <p className="text-[10.5px] text-faint font-tight leading-relaxed px-1">
        Committing a card locks that copy as untradeable. Progress is games played with it in Squad
        Battle, Brawl, Boss, or Rivals (max 10 counted per card per day). {activeCount}/{MAX_ACTIVE_EVOLUTIONS} active.
      </p>

      {mine.length > 0 && (
        <div className="flex flex-col gap-3">
          <p className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight">Your evolutions</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {mine.map((e) => {
              const def = defs.find((d) => d.key === e.evoKey);
              const o = ownedByKey.get(cardKeyOf(e));
              if (!def || !o) return null;
              return <MyEvolutionCard key={cardKeyOf(e)} evo={e} def={def} card={o.card} />;
            })}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <p className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight">Available</p>
        <div className="flex flex-col gap-2.5">
          {defs.map((def) => (
            <EvolutionDefRow
              key={def.key}
              def={def}
              disabled={atCap}
              onStart={() => setPickerDef(def)}
            />
          ))}
        </div>
      </div>

      {pickerDef && (
        <EvolutionPicker
          def={pickerDef}
          owned={owned}
          evolvedKeys={evolvedKeys}
          onClose={() => setPickerDef(null)}
          onPick={(card) => {
            onStart(pickerDef.key, card.playerId, card.teamSlug, card.year);
            setPickerDef(null);
          }}
          starting={starting && startingKey === pickerDef.key}
        />
      )}
    </div>
  );
}

function MyEvolutionCard({
  evo,
  def,
  card,
}: {
  evo: CardEvolution;
  def: EvolutionDef;
  card: OwnedCard['card'];
}) {
  const nextStage = def.stages[evo.stage];
  const pct = nextStage ? Math.min(100, (evo.games / nextStage.games) * 100) : 100;

  return (
    <div className="flex flex-col gap-2">
      <div className="w-full">
        <CardTile card={card} />
      </div>
      <p className="text-[10.5px] font-bold text-ink font-tight truncate">{def.name}</p>
      {evo.completed ? (
        <span className="inline-flex items-center gap-1 text-[9.5px] font-extrabold uppercase tracking-[0.08em] text-accent font-tight">
          Complete · +{evo.boost}
        </span>
      ) : nextStage ? (
        <>
          <div
            className="h-1.5 rounded-full bg-ink/10 overflow-hidden"
            role="progressbar"
            aria-label={`${def.name} progress to next stage`}
            aria-valuenow={evo.games}
            aria-valuemin={0}
            aria-valuemax={nextStage.games}
          >
            <div className="h-full rounded-full bg-accent motion-safe:transition-[width] motion-safe:duration-500 w-[var(--pct)]" style={{ '--pct': `${pct}%` } as React.CSSProperties} />
          </div>
          <p className="text-[9.5px] text-faint font-tight tabular">
            {evo.games}/{nextStage.games} games · +{evo.boost} now, +{nextStage.boost} next
          </p>
        </>
      ) : (
        <span className="text-[9.5px] text-faint font-tight">+{evo.boost} boost</span>
      )}
    </div>
  );
}

function EvolutionDefRow({ def, disabled, onStart }: { def: EvolutionDef; disabled: boolean; onStart: () => void }) {
  return (
    <div className="rounded-card-lg bg-surface shadow-card p-4 flex flex-col gap-3">
      <div>
        <p className="font-display italic text-lg font-bold text-ink leading-tight">{def.name}</p>
        <p className="text-[12px] text-muted font-tight mt-0.5">{def.description}</p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {(def.maxScore !== null || def.maxYear !== null) && (
          <span className="text-[9.5px] font-bold tracking-[0.04em] uppercase px-2 py-1 rounded-full bg-ink/5 text-ink/70 leading-none">
            {def.maxScore !== null ? `≤${def.maxScore} OVR` : ''}
            {def.maxScore !== null && def.maxYear !== null ? ' · ' : ''}
            {def.maxYear !== null ? `${def.maxYear} or earlier` : ''}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {def.stages.map((s, i) => (
          <span key={i} className="inline-flex items-center gap-1 text-[10px] font-semibold text-faint font-tight tabular">
            {i > 0 && <span className="text-faint">→</span>}
            {s.games}g · +{s.boost}
          </span>
        ))}
      </div>

      <button
        type="button"
        onClick={onStart}
        disabled={disabled}
        className={[
          'self-start inline-flex items-center justify-center px-4 py-2 rounded-full min-h-[36px]',
          'text-[10.5px] font-bold uppercase tracking-[0.06em] font-tight',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          'motion-safe:transition-opacity motion-safe:duration-150',
          disabled ? 'bg-ink/5 text-faint cursor-not-allowed' : 'bg-ink text-bg hover:opacity-90 cursor-pointer',
        ].join(' ')}
      >
        {disabled ? `Max ${MAX_ACTIVE_EVOLUTIONS} active` : 'Start'}
      </button>
    </div>
  );
}

function EvolutionPicker({
  def,
  owned,
  evolvedKeys,
  onClose,
  onPick,
  starting,
}: {
  def: EvolutionDef;
  owned: OwnedCard[];
  evolvedKeys: Set<string>;
  onClose: () => void;
  onPick: (card: OwnedCard['card']) => void;
  starting: boolean;
}) {
  const eligible = useMemo(
    () =>
      owned
        .filter((o) => !evolvedKeys.has(cardKeyOf(o.card)) && evolutionEligible(def, o.card))
        .sort((a, b) => b.card.playerScore - a.card.playerScore),
    [owned, evolvedKeys, def],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/40 motion-safe:animate-fade-in" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Choose a card for ${def.name}`}
        className="relative z-10 w-full sm:max-w-2xl bg-bg rounded-t-card-lg sm:rounded-card-lg shadow-hero max-h-[85vh] flex flex-col"
      >
        <div className="flex items-center justify-between p-4 border-b border-hairline flex-shrink-0">
          <div>
            <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-accent font-tight mb-0.5">
              {eligible.length} eligible
            </p>
            <h3 className="font-display italic text-xl font-bold text-ink leading-none">{def.name}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-9 h-9 rounded-full flex items-center justify-center text-faint hover:text-ink hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-safe:transition-colors motion-safe:duration-150 cursor-pointer flex-shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2 2l10 10M12 2l-10 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto p-4">
          {eligible.length === 0 ? (
            <p className="text-[13px] text-muted font-tight text-center py-8">
              No eligible cards for this evolution — it needs a card within its score/year limits that
              isn&rsquo;t already evolving.
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {eligible.map((o) => (
                <button
                  key={cardKeyOf(o.card)}
                  type="button"
                  onClick={() => !starting && onPick(o.card)}
                  disabled={starting}
                  aria-label={`Start ${def.name} on ${o.card.name}`}
                  className="cursor-pointer disabled:cursor-wait disabled:opacity-60"
                >
                  <CardTile card={o.card} copies={o.copies} />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-hairline flex-shrink-0">
          <p className="text-[10px] text-faint font-tight text-center">
            One copy will be locked as untradeable once you pick a card.
          </p>
        </div>
      </div>
    </div>
  );
}
