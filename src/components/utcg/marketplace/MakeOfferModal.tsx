'use client';

// MakeOfferModal — bottom-sheet for building a trade offer against a trade
// listing: pick up to 5 owned cards + optional coins, submit via makeOffer().
// Same modal shell as SlotPicker in squad-builder.tsx.

import { useEffect, useMemo, useState } from 'react';
import type { OwnedCard } from '@/lib/utcg/server';
import { CardTile } from '@/components/utcg/card-tile';
import { CoinGlyph } from '@/components/utcg/coin-glyph';
import { makeOffer, priceCeiling, tradeFee, OFFER_MAX_QTY, type Listing } from '@/lib/utcg/market';

const MAX_CARDS = 5;

function ownedKey(o: OwnedCard): string {
  return `${o.card.playerId}|${o.card.teamSlug}|${o.card.year}`;
}

interface MakeOfferModalProps {
  listing: Listing;
  owned: OwnedCard[];
  coins: number;
  onClose: () => void;
  onOffered: () => void;
}

export function MakeOfferModal({ listing, owned, coins, onClose, onOffered }: MakeOfferModalProps) {
  // card key -> qty offered (1..min(OFFER_MAX_QTY, copies owned)).
  const [selected, setSelected] = useState<Map<string, number>>(new Map());
  const [coinInput, setCoinInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Only copies beyond untradeable (e.g. free-pack grants) can be offered.
  const eligible = useMemo(() => owned.filter((o) => o.copies - o.untradeable > 0), [owned]);
  const byKey = useMemo(() => new Map(eligible.map((o) => [ownedKey(o), o])), [eligible]);

  const coinCeiling = priceCeiling(listing.card);
  const offeredCoins = coinInput.trim() === '' ? 0 : Math.max(0, Math.floor(Number(coinInput)) || 0);
  const coinsOverCeiling = offeredCoins > coinCeiling;

  const selectedCards = useMemo(
    () =>
      Array.from(selected.entries())
        .map(([key, qty]) => {
          const o = byKey.get(key);
          return o ? { card: o.card, qty } : null;
        })
        .filter((c): c is { card: OwnedCard['card']; qty: number } => c !== null),
    [selected, byKey],
  );
  // Charged now, refunded if the offer is declined or withdrawn.
  const fee = tradeFee(selectedCards);
  const totalCost = offeredCoins + fee;
  const coinsExceedBalance = totalCost > coins;
  const atMaxCards = selected.size >= MAX_CARDS;
  const canSubmit = (selected.size > 0 || offeredCoins > 0) && !coinsExceedBalance && !coinsOverCeiling;

  function toggleCard(key: string, maxQty: number) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        if (next.size >= MAX_CARDS) return prev;
        next.set(key, Math.min(1, maxQty));
      }
      return next;
    });
  }

  function setQty(key: string, qty: number, maxQty: number) {
    setSelected((prev) => {
      const next = new Map(prev);
      next.set(key, Math.max(1, Math.min(qty, maxQty)));
      return next;
    });
  }

  async function handleSubmit() {
    if (submitting || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      // Built from selectedCards (already filtered to keys still present in
      // `owned`) rather than re-reading byKey here — owned can refresh out
      // from under an open modal via router.refresh(), and a stale key would
      // otherwise throw mid-submit instead of failing cleanly.
      const cards = selectedCards.map(({ card, qty }) => ({
        ref: { playerId: card.playerId, teamSlug: card.teamSlug, year: card.year },
        qty,
      }));
      await makeOffer(listing.id, cards, offeredCoins);
      onOffered();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send that offer — try again.');
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
        aria-label={`Make an offer for ${listing.card.name}`}
        className="relative z-10 w-full sm:max-w-lg bg-bg rounded-t-card-lg sm:rounded-card-lg shadow-hero max-h-[85vh] flex flex-col"
      >
        <div className="flex items-center gap-3 p-4 border-b border-hairline flex-shrink-0">
          <div className="w-14 flex-shrink-0">
            <CardTile card={listing.card} compact />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-accent font-tight mb-0.5">
              Make an Offer
            </p>
            <h3 className="font-display italic text-lg font-bold text-ink leading-none truncate">
              For {listing.card.name}
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
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] font-bold tracking-[0.1em] uppercase text-muted font-tight">
                Your cards
              </p>
              <p className="text-[11px] text-faint font-tight">
                {selected.size}/{MAX_CARDS} selected
              </p>
            </div>
            {eligible.length === 0 ? (
              <p className="text-[13px] text-muted font-tight text-center py-6">
                You don&apos;t have any cards to offer.
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-2.5">
                {eligible.map((o) => {
                  const key = ownedKey(o);
                  const qty = selected.get(key);
                  const isSelected = qty !== undefined;
                  const maxQty = Math.min(OFFER_MAX_QTY, o.copies - o.untradeable);
                  return (
                    <div key={key} className="flex flex-col gap-1">
                      <CardTile
                        card={o.card}
                        copies={o.copies}
                        compact
                        selected={isSelected}
                        disabled={!isSelected && atMaxCards}
                        onClick={() => toggleCard(key, maxQty)}
                      />
                      {isSelected && maxQty > 1 && (
                        <QtyStepper
                          qty={qty}
                          max={maxQty}
                          onChange={(next) => setQty(key, next, maxQty)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {atMaxCards && (
              <p className="text-[11px] text-faint font-tight mt-2">Up to {MAX_CARDS} cards.</p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="offer-coins" className="text-[11px] font-bold tracking-[0.1em] uppercase text-muted font-tight">
              Add coins (optional)
            </label>
            <div className="relative">
              <input
                id="offer-coins"
                type="number"
                inputMode="numeric"
                min={0}
                max={Math.min(coins, coinCeiling)}
                step={1}
                value={coinInput}
                onChange={(e) => setCoinInput(e.target.value)}
                placeholder="0"
                className="w-full pl-4 pr-11 py-3 rounded-full bg-ink/5 text-[13px] font-tight text-ink placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent min-h-[44px]"
              />
              <CoinGlyph size={15} className="text-accent absolute right-4 top-1/2 -translate-y-1/2" />
            </div>
            <p className="text-[11px] text-faint font-tight">
              You have {coins.toLocaleString()} coins · max offer {coinCeiling.toLocaleString()}.
            </p>
            {coinsOverCeiling && (
              <p className="text-[11px] text-live font-tight" role="alert">
                Coin offer can&rsquo;t exceed {coinCeiling.toLocaleString()}.
              </p>
            )}
            {coinsExceedBalance && !coinsOverCeiling && (
              <p className="text-[11px] text-live font-tight" role="alert">
                You only have {coins.toLocaleString()} coins ({totalCost.toLocaleString()} needed with the trade fee).
              </p>
            )}
          </div>

          {/* Live summary */}
          <div className="rounded-card bg-ink/5 p-4 flex flex-col gap-1.5">
            <p className="text-[12px] text-muted font-tight">
              Offering:{' '}
              <span className="text-ink font-bold">
                {selected.size} card{selected.size === 1 ? '' : 's'}
                {offeredCoins > 0 ? ` + ${offeredCoins.toLocaleString()} coins` : ''}
              </span>{' '}
              for <span className="text-ink font-bold">{listing.card.name}</span>
            </p>
            {fee > 0 && (
              <p className="text-[11px] text-faint font-tight">
                Trade fee <span className="text-ink font-bold">{fee.toLocaleString()}</span> — charged now,
                refunded if declined or withdrawn. Total cost{' '}
                <span className="text-ink font-bold">{totalCost.toLocaleString()}</span> coins.
              </p>
            )}
          </div>

          {!canSubmit && !coinsExceedBalance && !coinsOverCeiling && (
            <p className="text-[11px] text-faint font-tight">
              Select at least one card or add coins to make an offer.
            </p>
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
                Sending…
              </>
            ) : (
              'Send Offer'
            )}
          </button>
        </div>
      </div>
    </div>
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

/** Minus/qty/plus row under a selected card — lets the offerer bump how many
 *  copies of that card go into the offer, capped at min(OFFER_MAX_QTY, owned). */
function QtyStepper({ qty, max, onChange }: { qty: number; max: number; onChange: (next: number) => void }) {
  return (
    <div className="flex items-center justify-center gap-1.5">
      <button
        type="button"
        onClick={() => onChange(qty - 1)}
        disabled={qty <= 1}
        aria-label="Decrease quantity"
        className="w-6 h-6 rounded-full bg-ink/8 text-ink text-[13px] font-bold flex items-center justify-center cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed hover:bg-ink/15 motion-safe:transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        −
      </button>
      <span className="text-[11px] font-bold text-ink tabular min-w-[18px] text-center">{qty}</span>
      <button
        type="button"
        onClick={() => onChange(qty + 1)}
        disabled={qty >= max}
        aria-label="Increase quantity"
        className="w-6 h-6 rounded-full bg-ink/8 text-ink text-[13px] font-bold flex items-center justify-center cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed hover:bg-ink/15 motion-safe:transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        +
      </button>
    </div>
  );
}
