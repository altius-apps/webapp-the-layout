'use client';

// "How it works" rules button + modal for Fantasy.
//
// Renders a compact trigger button; clicking it opens a dismissible modal that
// hosts the shared FantasyRulesContent (rules + scoring table). Used on the
// league, team and settings tabs so the rules are one tap away without occupying the
// page. Never opens on its own (Hunter, 2026-10-07 — the League tab shows an
// "i" icon instead). Visual language matches AuthModal: portal to <body>, dark
// scrim, bg-bg card, Esc / backdrop / close-button to dismiss.

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FantasyRulesContent } from './fantasy-rules';
import type { CompetitionId, ContestMode, FantasyPlayerLeague } from '@/lib/fantasy/competitions';

interface FantasyRulesModalProps {
  /** Event contests score event totals + placement bonus, not the weekly
   *  role matrix. Defaults to weekly. */
  mode?: ContestMode;
  playerLeague?: FantasyPlayerLeague;
  /** Picks the club vs college wording of the event player-ranking section. */
  competition?: CompetitionId;
  /** Button label (the aria-label for `icon`). Defaults to "Rules". */
  label?: string;
  /** Visual weight of the trigger. `ghost` = bordered subtle; `link` = text;
   *  `icon` = the info glyph alone. */
  variant?: 'ghost' | 'link' | 'icon';
}

export function FantasyRulesModal({
  mode,
  playerLeague,
  competition,
  label = 'Rules',
  variant = 'ghost',
}: FantasyRulesModalProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const close = useCallback(() => setOpen(false), []);

  // Esc closes; lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, close]);

  const triggerClass =
    variant === 'icon'
      ? [
          'flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-full',
          'text-muted hover:text-ink hover:bg-ink/5 transition-colors duration-150 cursor-pointer',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        ].join(' ')
      : variant === 'link'
      ? [
          'inline-flex items-center gap-1.5 text-accent font-tight text-[13px] font-bold tracking-[0.04em]',
          'hover:opacity-80 transition-opacity duration-150 cursor-pointer',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-full',
        ].join(' ')
      : [
          'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-ink/5',
          'text-ink font-tight text-[12px] font-bold tracking-[0.04em]',
          'hover:bg-ink/10 transition-colors duration-150 cursor-pointer',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        ].join(' ');

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={triggerClass}
        aria-haspopup="dialog"
        aria-label={variant === 'icon' ? label : undefined}
      >
        <svg
          width={variant === 'icon' ? 18 : 13}
          height={variant === 'icon' ? 18 : 13}
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 7.25v3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="5.1" r="0.85" fill="currentColor" />
        </svg>
        {variant !== 'icon' && label}
      </button>

      {mounted &&
        open &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="fantasy-rules-modal-title"
            className="fixed inset-0 z-[100] flex items-center justify-center px-4 py-6 bg-black/40 backdrop-blur-sm"
            onPointerDown={(e) => {
              if (e.target === e.currentTarget) close();
            }}
          >
            <div className="w-full max-w-[520px] max-h-full overflow-y-auto bg-surface rounded-card-lg shadow-hero">
              {/* Header with close button */}
              <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-1">
                <span className="text-[10px] font-bold tracking-[0.18em] uppercase text-accent font-tight pt-1">
                  How it works
                </span>
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close rules"
                  className={[
                    'flex-shrink-0 -mr-1.5 w-8 h-8 rounded-full flex items-center justify-center',
                    'text-faint hover:text-ink hover:bg-ink/5',
                    'transition-colors duration-150 cursor-pointer',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  ].join(' ')}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
              </div>

              <div className="px-6 pb-6">
                <FantasyRulesContent
                  headingId="fantasy-rules-modal-title"
                  mode={mode}
                  playerLeague={playerLeague}
                  competition={competition}
                />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
