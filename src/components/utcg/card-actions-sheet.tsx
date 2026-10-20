'use client';

// CardActionsSheet — bottom-sheet opened by tapping a card in the Collection
// grid. Replaces the old "tap always opens ListCardModal" behavior: a card
// can now also be crafted (spend pack points for another untradeable copy),
// and an all-untradeable card has nothing to list, so it needs *some* tap
// target. Shell copied from SquadBuilder's SlotPicker (bg-black/40 backdrop +
// bottom-sheet-on-mobile/centered-on-desktop + Escape-to-close), the
// established modal idiom for the whole game.

import { useEffect, useMemo } from 'react';
import type { UtcgCard } from '@/lib/utcg/data';
import { craftCost } from '@/lib/utcg/sinks';
import type { EvolutionState } from '@/lib/utcg/boosts';
import { evolutionEligible, MAX_ACTIVE_EVOLUTIONS } from '@/lib/utcg/boosts';
import { CoinGlyph } from '@/components/utcg/coin-glyph';
import { CardTile } from '@/components/utcg/card-tile';

function cardKeyOf(c: { playerId: string; teamSlug: string; year: number }): string {
  return `${c.playerId}|${c.teamSlug}|${c.year}`;
}

interface CardActionsSheetProps {
  card: UtcgCard;
  copies: number;
  untradeable: number;
  packPoints: number;
  onList: () => void;
  onCraft: () => void;
  crafting: boolean;
  craftError: string | null;
  onClose: () => void;
  /** Evolutions state, for the "Evolve" entry point. Omitted where the
   *  caller hasn't loaded it (null = feature unavailable this session). */
  evolutions?: EvolutionState | null;
  onEvolve?: (evoKey: string) => void;
  evolving?: boolean;
  evolveError?: string | null;
}

export function CardActionsSheet({
  card,
  copies,
  untradeable,
  packPoints,
  onList,
  onCraft,
  crafting,
  craftError,
  onClose,
  evolutions,
  onEvolve,
  evolving = false,
  evolveError = null,
}: CardActionsSheetProps) {
  const tradeable = copies - untradeable;
  const cost = craftCost(card);
  const canAffordCraft = packPoints >= cost;

  // Eligible evolution defs for THIS card — same eligibility rule as
  // evolutions-board.tsx's picker (base playerScore/year + not already
  // evolving), gated additionally by the global 3-active cap.
  const eligibleEvos = useMemo(() => {
    if (!evolutions) return [];
    const alreadyEvolving = evolutions.mine.some((e) => cardKeyOf(e) === cardKeyOf(card));
    if (alreadyEvolving) return [];
    return evolutions.defs.filter((d) => evolutionEligible(d, card));
  }, [evolutions, card]);
  const activeEvoCount = evolutions?.mine.filter((e) => !e.completed).length ?? 0;
  const atEvoCap = activeEvoCount >= MAX_ACTIVE_EVOLUTIONS;

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
        aria-label={`${card.name} actions`}
        className="relative z-10 w-full sm:max-w-sm bg-bg rounded-t-card-lg sm:rounded-card-lg shadow-hero max-h-[85vh] flex flex-col"
      >
        <div className="flex items-center justify-between p-4 border-b border-hairline flex-shrink-0">
          <div>
            <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-accent font-tight mb-0.5">
              {tradeable > 0 ? `${tradeable} tradeable · ${untradeable} reward` : `${untradeable} reward · none tradeable`}
            </p>
            <h3 className="font-display italic text-xl font-bold text-ink leading-none">{card.name}</h3>
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

        <div className="overflow-y-auto p-4 flex flex-col gap-4">
          <div className="w-[120px] mx-auto">
            <CardTile card={card} copies={copies} untradeable={untradeable} />
          </div>

          {/* Boost labels — CardTile's own pill only shows the FIRST label as
              a hover title, which touch can't reach. List every active label
              explicitly here (TOTW / Champion / Evolution, capped +8 total). */}
          {!!card.boost && card.boostLabels && card.boostLabels.length > 0 && (
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              <span className="text-[10px] font-extrabold tabular px-2 py-1 rounded-full bg-accent/15 text-accent">
                +{card.boost} total
              </span>
              {card.boostLabels.map((label) => (
                <span key={label} className="text-[9.5px] font-bold tracking-[0.02em] px-2 py-1 rounded-full bg-ink/5 text-ink/70">
                  {label}
                </span>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-2.5">
            <button
              type="button"
              onClick={onList}
              disabled={tradeable <= 0}
              className={[
                'w-full inline-flex items-center justify-center px-5 py-3 rounded-full min-h-[48px]',
                'text-[12px] font-bold tracking-[0.1em] uppercase font-tight',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                'motion-safe:transition-opacity motion-safe:duration-150',
                tradeable > 0 ? 'bg-ink text-bg hover:opacity-90 cursor-pointer' : 'bg-ink/5 text-faint cursor-not-allowed',
              ].join(' ')}
            >
              {tradeable > 0 ? 'List on Market' : 'No tradeable copies'}
            </button>

            <button
              type="button"
              onClick={onCraft}
              disabled={!canAffordCraft || crafting}
              className={[
                'w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-full min-h-[48px]',
                'text-[12px] font-bold tracking-[0.1em] uppercase font-tight',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                'motion-safe:transition-opacity motion-safe:duration-150',
                canAffordCraft && !crafting
                  ? 'bg-accent text-accent-ink hover:opacity-90 cursor-pointer'
                  : 'bg-ink/5 text-faint cursor-not-allowed',
              ].join(' ')}
            >
              {crafting ? 'Crafting…' : (
                <>
                  Craft another copy · {cost} pts
                </>
              )}
            </button>
            <p className="text-[10.5px] text-faint font-tight text-center">
              <span className="inline-flex items-center gap-1">
                <CoinGlyph size={10} className="text-faint" />
                {packPoints.toLocaleString()} pack points
              </span>
              {!canAffordCraft && ` · need ${(cost - packPoints).toLocaleString()} more`}
              {' · crafted copies are untradeable'}
            </p>
            {craftError && (
              <p className="text-[12px] text-live font-tight text-center" role="alert">{craftError}</p>
            )}

            {eligibleEvos.length > 0 && onEvolve && (
              <>
                <span className="h-px bg-hairline my-1" aria-hidden="true" />
                {eligibleEvos.map((def) => (
                  <button
                    key={def.key}
                    type="button"
                    onClick={() => onEvolve(def.key)}
                    disabled={atEvoCap || evolving}
                    className={[
                      'w-full inline-flex items-center justify-center px-5 py-3 rounded-full min-h-[48px]',
                      'text-[12px] font-bold tracking-[0.1em] uppercase font-tight',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      'motion-safe:transition-opacity motion-safe:duration-150',
                      atEvoCap || evolving
                        ? 'bg-ink/5 text-faint cursor-not-allowed'
                        : 'bg-ink text-bg hover:opacity-90 cursor-pointer',
                    ].join(' ')}
                  >
                    {evolving ? 'Starting…' : atEvoCap ? `Max ${MAX_ACTIVE_EVOLUTIONS} evolutions active` : `Evolve · ${def.name}`}
                  </button>
                ))}
                <p className="text-[10px] text-faint font-tight text-center">
                  Locks one copy as untradeable and starts tracking games played with it.
                </p>
                {evolveError && (
                  <p className="text-[12px] text-live font-tight text-center" role="alert">{evolveError}</p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
