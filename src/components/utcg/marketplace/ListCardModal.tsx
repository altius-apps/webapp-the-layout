'use client';

// ListCardModal — bottom-sheet for listing an owned card on the market,
// either for a coin price (Sell) or for open trade offers (Trade). Opened
// from CollectionGrid (tap a card -> onListCard) via UtcgGame's `listingCard`
// state. Same modal shell as SlotPicker in squad-builder.tsx (bg-black/40
// backdrop, bottom-sheet on mobile / centered on desktop, Escape-to-close).

import { useEffect, useState } from 'react';
import type { UtcgCard } from '@/lib/utcg/data';
import type { MarketAccess } from '@/lib/utcg/server';
import { CardTile } from '@/components/utcg/card-tile';
import { MarketUnlockChecklist } from '@/components/utcg/market-unlock';
import { MARKET_UNLOCK } from '@/lib/utcg/packs';
import { listCard, sellFloor, priceCeiling, sellerProceeds, type CardRef, type ListingKind } from '@/lib/utcg/market';

interface ListCardModalProps {
  card: UtcgCard;
  marketAccess: MarketAccess | null;
  onClose: () => void;
  onListed: () => void;
}

export function ListCardModal({ card, marketAccess, onClose, onListed }: ListCardModalProps) {
  const [kind, setKind] = useState<ListingKind>('sell');
  const [priceInput, setPriceInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const locked = marketAccess !== null && !marketAccess.unlocked;
  const floor = sellFloor(card);
  const ceiling = priceCeiling(card);
  const price = Number(priceInput);
  const priceValid = priceInput.trim() !== '' && Number.isFinite(price) && price >= floor && price <= ceiling;
  const overCeiling = priceInput.trim() !== '' && Number.isFinite(price) && price > ceiling;
  const canSubmit = !locked && (kind === 'trade' || priceValid);

  async function handleSubmit() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const ref: CardRef = { playerId: card.playerId, teamSlug: card.teamSlug, year: card.year };
      await listCard(ref, kind, kind === 'sell' ? Math.floor(price) : null);
      onListed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not list this card — try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/40 motion-safe:animate-fade-in" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`List ${card.name} on the market`}
        className="relative z-10 w-full sm:max-w-lg bg-bg rounded-t-card-lg sm:rounded-card-lg shadow-hero max-h-[85vh] flex flex-col"
      >
        <div className="flex items-center justify-between p-4 border-b border-hairline flex-shrink-0">
          <div>
            <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-accent font-tight mb-0.5">
              List on Market
            </p>
            <h3 className="font-display italic text-xl font-bold text-ink leading-none truncate max-w-[240px]">
              {card.name}
            </h3>
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
          <div className="w-32 mx-auto">
            <CardTile card={card} />
          </div>

          {locked && (
            <div className="rounded-card bg-ink/5 p-4 flex flex-col gap-2.5">
              <p className="text-[13px] font-bold text-ink font-tight">Market locked</p>
              <p className="text-[12px] text-muted font-tight">
                Listing cards unlocks after {MARKET_UNLOCK.days} days and {MARKET_UNLOCK.games} games on{' '}
                {MARKET_UNLOCK.playDays} different days.
              </p>
              <MarketUnlockChecklist access={marketAccess} />
            </div>
          )}

          {/* Sell / Trade toggle */}
          <div className="flex items-center gap-2" role="group" aria-label="Listing type">
            <ModeButton active={kind === 'sell'} onClick={() => setKind('sell')} label="Sell" />
            <ModeButton active={kind === 'trade'} onClick={() => setKind('trade')} label="Trade" />
          </div>

          {kind === 'sell' ? (
            <div className="flex flex-col gap-2">
              <label htmlFor="sell-price" className="text-[11px] font-bold tracking-[0.1em] uppercase text-muted font-tight">
                Asking price
              </label>
              <input
                id="sell-price"
                type="number"
                inputMode="numeric"
                min={floor}
                max={ceiling}
                step={1}
                value={priceInput}
                onChange={(e) => setPriceInput(e.target.value)}
                placeholder={`${floor.toLocaleString()}`}
                aria-describedby="sell-price-help"
                className="w-full px-4 py-3 rounded-full bg-ink/5 text-[13px] font-tight text-ink placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent min-h-[44px]"
              />
              <p id="sell-price-help" className="text-[11px] text-faint font-tight">
                Min {floor.toLocaleString()} · Max {ceiling.toLocaleString()}
              </p>
              {priceInput.trim() !== '' && !priceValid && !overCeiling && (
                <p className="text-[11px] text-live font-tight" role="alert">
                  Price must be at least {floor.toLocaleString()}.
                </p>
              )}
              {overCeiling && (
                <p className="text-[11px] text-live font-tight" role="alert">
                  Price can&rsquo;t exceed {ceiling.toLocaleString()}.
                </p>
              )}
              {priceValid && (
                <p className="text-[12px] text-muted font-tight">
                  You receive <span className="text-ink font-bold">{sellerProceeds(Math.floor(price)).toLocaleString()}</span> after the 5% market fee.
                </p>
              )}
            </div>
          ) : (
            <div className="rounded-card bg-ink/5 p-4 flex flex-col gap-1.5">
              <p className="text-[13px] font-bold text-ink font-tight">List for trade offers</p>
              <p className="text-[12px] text-muted font-tight">
                Other players can offer you cards and coins for this card. You choose whether to accept.
              </p>
            </div>
          )}

          {error && (
            <p className="text-[12px] text-live font-tight" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="p-4 border-t border-hairline flex-shrink-0">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
            className={[
              'w-full inline-flex items-center justify-center gap-2 px-6 py-4 rounded-full',
              'text-[13px] font-bold tracking-[0.14em] uppercase font-tight',
              'bg-accent text-accent-ink hover:opacity-90 transition-opacity duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
              'min-h-[52px] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed',
            ].join(' ')}
          >
            {submitting ? (
              <>
                <Spinner />
                Listing…
              </>
            ) : kind === 'sell' ? (
              `List for ${priceValid ? Math.floor(price).toLocaleString() : floor.toLocaleString()} coins`
            ) : (
              'List for Trade'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'flex-1 inline-flex items-center justify-center px-4 py-2.5 rounded-full',
        'text-[11px] font-bold tracking-[0.1em] uppercase font-tight',
        'motion-safe:transition-colors motion-safe:duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        'min-h-[44px] cursor-pointer',
        active ? 'bg-ink text-bg' : 'bg-ink/5 text-muted hover:bg-ink/10',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin w-4 h-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="2.5" strokeOpacity="0.3" />
      <path d="M10 2a8 8 0 0 1 8 8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
