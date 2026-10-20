'use client';

// Feedback submit modal — opened from the profile dropdown. A signed-in user
// picks an optional category, types a message, and submits. On success it shows
// a brief thank-you then auto-closes. Insert is client-side via submitFeedback
// (RLS scopes it to the caller). Mirrors the create-play-dialog modal shell.

import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { usePathname } from 'next/navigation';
import {
  submitFeedback,
  FEEDBACK_CATEGORIES,
  type FeedbackCategory,
} from '@/lib/feedback/data';

type Phase = 'editing' | 'submitting' | 'done';

const MAX_LEN = 4000;

export function FeedbackModal({ onClose }: { onClose: () => void }) {
  const pathname = usePathname() ?? '/';
  const [category, setCategory] = useState<FeedbackCategory | null>(null);
  const [message, setMessage] = useState('');
  const [phase, setPhase] = useState<Phase>('editing');
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  // Portal target is only available after mount (SSR-safe).
  useEffect(() => setMounted(true), []);

  // Focus the textarea on open; close on Esc (unless submitting).
  useEffect(() => {
    const t = setTimeout(() => textRef.current?.focus(), 30);
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && phase !== 'submitting') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, phase]);

  // Auto-close shortly after a successful submit.
  useEffect(() => {
    if (phase !== 'done') return;
    const t = setTimeout(onClose, 1400);
    return () => clearTimeout(t);
  }, [phase, onClose]);

  const handleSubmit = useCallback(async () => {
    if (phase === 'submitting') return;
    setPhase('submitting');
    setError(null);
    const err = await submitFeedback({
      message,
      category: category ?? undefined,
      pagePath: pathname,
    });
    if (err) {
      setError(err);
      setPhase('editing');
      return;
    }
    setPhase('done');
  }, [message, category, pathname, phase]);

  if (!mounted) return null;

  // Portaled to <body> so the fixed overlay escapes the sticky, backdrop-blurred
  // header rail. A `backdrop-filter` ancestor becomes the containing block for
  // fixed descendants (CSS spec), which otherwise collapses this dialog into the
  // ~52px header strip instead of covering the viewport.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="feedback-title"
      className="fixed inset-0 z-[100] flex items-center justify-center px-4 py-6 bg-black/40 backdrop-blur-sm"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && phase !== 'submitting') onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
        className="w-full max-w-[480px] max-h-full overflow-y-auto bg-surface rounded-card-lg shadow-hero flex flex-col"
      >
        <div className="px-5 py-4 border-b border-hairline">
          <h2
            id="feedback-title"
            className="font-display italic text-[24px] font-bold tracking-[-0.02em] leading-[0.95] text-ink m-0"
          >
            Send feedback
          </h2>
          <p className="mt-2 text-[12.5px] text-muted font-tight leading-snug">
            Found a bug or have an idea? We read every note.
          </p>
        </div>

        {phase === 'done' ? (
          <div className="px-5 py-8 flex flex-col items-center text-center gap-2">
            <div className="text-[28px]" aria-hidden="true">✓</div>
            <p className="m-0 text-[15px] font-bold text-ink font-tight">Thanks for the feedback!</p>
            <p className="m-0 text-[12.5px] text-muted font-tight">We appreciate you taking the time.</p>
          </div>
        ) : (
          <>
            <div className="px-5 py-5 flex flex-col gap-4">
              {/* Category chips (optional) */}
              <div className="flex flex-col gap-1.5">
                <span className="text-[9px] font-bold tracking-[0.18em] uppercase text-faint font-tight">
                  Category
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {FEEDBACK_CATEGORIES.map((c) => {
                    const on = category === c;
                    return (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setCategory(on ? null : c)}
                        className={[
                          'px-3 h-8 rounded-full text-[11px] font-bold tracking-[0.08em] uppercase font-tight cursor-pointer transition-colors',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                          on ? 'bg-accent text-accent-ink' : 'bg-ink/5 text-muted hover:text-ink hover:bg-ink/10',
                        ].join(' ')}
                      >
                        {c}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Message */}
              <label className="flex flex-col gap-1.5">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-[9px] font-bold tracking-[0.18em] uppercase text-faint font-tight">
                    Message
                  </span>
                  <span className="text-[9px] font-medium text-faint font-tight tabular">
                    {message.length}/{MAX_LEN}
                  </span>
                </span>
                <textarea
                  ref={textRef}
                  value={message}
                  maxLength={MAX_LEN}
                  onChange={(e) => {
                    setMessage(e.target.value);
                    if (error) setError(null);
                  }}
                  disabled={phase === 'submitting'}
                  rows={5}
                  className={[
                    'w-full bg-ink/5 px-3.5 py-2.5 text-[14px] font-medium text-ink font-tight rounded-card-sm resize-none',
                    'ring-1 ring-inset ring-transparent',
                    'focus-visible:outline-none focus-visible:ring-accent',
                    'disabled:opacity-60',
                  ].join(' ')}
                  placeholder="Tell us what's on your mind…"
                />
              </label>

              {error && (
                <p className="m-0 text-[12px] font-medium text-live font-tight">{error}</p>
              )}
            </div>

            <div className="px-5 py-4 border-t border-hairline flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={onClose}
                disabled={phase === 'submitting'}
                className={[
                  'px-4 py-2.5 rounded-card-sm cursor-pointer text-[12px] font-bold tracking-[0.08em] uppercase font-tight',
                  'text-muted hover:text-ink transition-colors duration-150',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  'disabled:opacity-60',
                ].join(' ')}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!message.trim() || phase === 'submitting'}
                className={[
                  'px-4 py-2.5 rounded-card-sm cursor-pointer text-[12px] font-bold tracking-[0.08em] uppercase font-tight',
                  'bg-accent text-accent-ink',
                  'hover:opacity-90 transition-opacity duration-150',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                ].join(' ')}
              >
                {phase === 'submitting' ? 'Sending…' : 'Send feedback'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>,
    document.body,
  );
}
