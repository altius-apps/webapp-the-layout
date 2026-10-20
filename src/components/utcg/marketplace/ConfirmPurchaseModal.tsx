'use client';

// ConfirmPurchaseModal — a confirmation step between tapping "Buy" and actually
// spending coins on a market listing.
//
// Why: buying was a single tap that immediately debited the wallet with no
// undo. A mis-tap on a 5,000-coin listing was unrecoverable. Every other
// destructive/irreversible UTCG action (draft pick, cash out) already
// double-confirms; this brings the market in line.
//
// Same bottom-sheet shell as MakeOfferModal / ListCardModal so the market's
// three modals read as one family.

import { useEffect } from 'react';
import { CardTile } from '@/components/utcg/card-tile';
import { CoinGlyph } from '@/components/utcg/coin-glyph';
import type { Listing } from '@/lib/utcg/market';

interface ConfirmPurchaseModalProps {
  listing: Listing;
  /** Buyer's current coin balance, for the before/after summary. */
  coins: number;
  /** True while the buy RPC is in flight. */
  buying: boolean;
  /** Server-side failure to surface in place (e.g. listing already sold). */
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmPurchaseModal({
  listing,
  coins,
  buying,
  error,
  onConfirm,
  onCancel,
}: ConfirmPurchaseModalProps) {
  // Escape closes — but not mid-request, so a stray keypress can't orphan a
  // purchase that's already been sent to the server.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !buying) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, buying]);

  const price = listing.askPrice ?? 0;
  const after = coins - price;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div
        className="absolute inset-0 bg-black/40 motion-safe:animate-fade-in"
        onClick={buying ? undefined : onCancel}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Confirm purchase of ${listing.card.name}`}
        className="relative z-10 w-full sm:max-w-md bg-bg rounded-t-card-lg sm:rounded-card-lg shadow-hero flex flex-col"
      >
        <div className="flex items-center gap-3 p-4 border-b border-hairline flex-shrink-0">
          <div className="w-14 flex-shrink-0">
            <CardTile card={listing.card} compact />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-accent font-tight mb-0.5">
              Confirm Purchase
            </p>
            <h3 className="font-display italic text-lg font-bold text-ink leading-none truncate">
              {listing.card.name}
            </h3>
            <p className="text-[10.5px] text-faint font-tight mt-1 truncate">
              {listing.card.teamAbbr} · {listing.card.year}
            </p>
          </div>
        </div>

        <div className="p-4 flex flex-col gap-3">
          <Row label="Price">
            <span className="inline-flex items-center gap-1 text-[14px] font-bold text-ink tabular">
              <CoinGlyph size={13} />
              {price.toLocaleString()}
            </span>
          </Row>
          <Row label="Your balance">
            <span className="text-[13px] font-semibold text-muted tabular">
              {coins.toLocaleString()}
            </span>
          </Row>
          <div className="h-px bg-hairline" />
          <Row label="Balance after">
            <span
              className={[
                'text-[14px] font-bold tabular',
                after < 0 ? 'text-live' : 'text-ink',
              ].join(' ')}
            >
              {after.toLocaleString()}
            </span>
          </Row>

          {error && (
            <p className="text-[11px] text-live font-tight" role="alert">
              {error}
            </p>
          )}

          <div className="flex gap-2 mt-1">
            <button
              type="button"
              onClick={onCancel}
              disabled={buying}
              className={[
                'flex-1 min-h-[44px] rounded-full text-[11px] font-bold tracking-[0.06em] uppercase font-tight',
                'bg-ink/5 text-muted hover:bg-ink/10 hover:text-ink',
                'motion-safe:transition-colors motion-safe:duration-150 cursor-pointer',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              ].join(' ')}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={buying || after < 0}
              className={[
                'flex-1 min-h-[44px] rounded-full text-[11px] font-bold tracking-[0.06em] uppercase font-tight',
                'bg-accent text-accent-ink hover:opacity-90',
                'motion-safe:transition-opacity motion-safe:duration-150 cursor-pointer',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                'inline-flex items-center justify-center gap-2',
              ].join(' ')}
            >
              {buying ? (
                <>
                  <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="2.5" strokeOpacity="0.3" />
                    <path d="M10 2a8 8 0 0 1 8 8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                  </svg>
                  Buying…
                </>
              ) : (
                'Confirm Buy'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[11px] font-bold tracking-[0.1em] uppercase text-muted font-tight">
        {label}
      </span>
      {children}
    </div>
  );
}
