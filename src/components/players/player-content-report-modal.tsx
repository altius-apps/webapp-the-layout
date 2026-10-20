'use client';

// Report-content modal — opened from a gallery tile's flag button or the
// Lightbox's Report affordance. Signed-in users submit a reason, which
// inserts into player_content_reports (RLS: reporter_id = auth.uid()).
// A duplicate report (23505) and a fresh one both land on the same "thanks"
// state — the user doesn't need to know it was already reported. Signed-out
// users get a fallback mailto link instead of the form. Mirrors FeedbackModal.

import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '@/lib/auth/auth-provider';
import { createClient } from '@/lib/supabase/client';

const REPORT_REASON_MAX = 500;

type Phase = 'editing' | 'submitting' | 'done';

export function PlayerContentReportModal({
  contentId,
  onClose,
}: {
  contentId: string;
  onClose: () => void;
}) {
  const { user, loading } = useAuth();
  const [reason, setReason] = useState('');
  const [phase, setPhase] = useState<Phase>('editing');
  const [doneMessage, setDoneMessage] = useState('Reported — thanks.');
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => setMounted(true), []);

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

  useEffect(() => {
    if (phase !== 'done') return;
    const t = setTimeout(onClose, 1400);
    return () => clearTimeout(t);
  }, [phase, onClose]);

  const handleSubmit = useCallback(async () => {
    if (phase === 'submitting' || !user) return;
    const trimmed = reason.trim();
    if (!trimmed) return;
    setPhase('submitting');
    setError(null);

    const supabase = createClient();
    const { error: insertError } = await supabase.from('player_content_reports').insert({
      content_id: contentId,
      reporter_id: user.id,
      reason: trimmed,
    });

    if (insertError) {
      if (insertError.code === '23505') {
        setDoneMessage('Already reported — thanks.');
        setPhase('done');
        return;
      }
      // Rate-limit message is ours (authored in the DB trigger) → show verbatim;
      // any other failure gets a generic line so raw Postgres text never leaks.
      setError(
        insertError.code === '23514'
          ? insertError.message
          : 'Could not submit report. Please try again.',
      );
      setPhase('editing');
      return;
    }

    setDoneMessage('Reported — thanks.');
    setPhase('done');
  }, [reason, contentId, user, phase]);

  if (!mounted || loading) return null;

  const mailtoHref = `mailto:info@altiusapps.com?subject=${encodeURIComponent(
    `Report content (${contentId})`,
  )}`;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-title"
      className="fixed inset-0 z-[100] flex items-center justify-center px-4 py-6 bg-black/40 backdrop-blur-sm"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && phase !== 'submitting') onClose();
      }}
    >
      <div className="w-full max-w-[440px] max-h-full overflow-y-auto bg-surface rounded-card-lg shadow-hero flex flex-col">
        <div className="px-5 py-4 border-b border-hairline">
          <h2
            id="report-title"
            className="font-display italic text-[22px] font-bold tracking-[-0.02em] leading-[0.95] text-ink m-0"
          >
            Report content
          </h2>
        </div>

        {!user ? (
          <div className="px-5 py-6 flex flex-col gap-3">
            <p className="m-0 text-[12.5px] text-muted font-tight leading-snug">
              Sign in to submit a report, or email us directly.
            </p>
            <a
              href={mailtoHref}
              className="inline-flex items-center justify-center rounded-card-sm px-4 py-2.5 bg-ink text-bg text-[12px] font-bold tracking-[0.08em] uppercase font-tight hover:opacity-90 transition-opacity cursor-pointer"
            >
              Email support
            </a>
            <button
              type="button"
              onClick={onClose}
              className="text-[11px] font-bold tracking-[0.16em] uppercase text-faint hover:text-ink font-tight transition-colors cursor-pointer self-center"
            >
              Cancel
            </button>
          </div>
        ) : phase === 'done' ? (
          <div className="px-5 py-8 flex flex-col items-center text-center gap-2">
            <div className="text-[28px]" aria-hidden="true">✓</div>
            <p className="m-0 text-[15px] font-bold text-ink font-tight">{doneMessage}</p>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSubmit();
            }}
            className="flex flex-col"
          >
            <div className="px-5 py-5 flex flex-col gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-[9px] font-bold tracking-[0.18em] uppercase text-faint font-tight">
                    Reason
                  </span>
                  <span className="text-[9px] font-medium text-faint font-tight tabular">
                    {reason.length}/{REPORT_REASON_MAX}
                  </span>
                </span>
                <textarea
                  ref={textRef}
                  value={reason}
                  maxLength={REPORT_REASON_MAX}
                  onChange={(e) => {
                    setReason(e.target.value);
                    if (error) setError(null);
                  }}
                  disabled={phase === 'submitting'}
                  rows={4}
                  className={[
                    'w-full bg-ink/5 px-3.5 py-2.5 text-[14px] font-medium text-ink font-tight rounded-card-sm resize-none',
                    'ring-1 ring-inset ring-transparent',
                    'focus-visible:outline-none focus-visible:ring-accent',
                    'disabled:opacity-60',
                  ].join(' ')}
                  placeholder="What's wrong with this content?"
                />
              </label>

              <p className="m-0 text-[11px] text-faint font-tight leading-snug">
                Reports go straight to the admin review queue.
              </p>

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
                disabled={!reason.trim() || phase === 'submitting'}
                className={[
                  'px-4 py-2.5 rounded-card-sm cursor-pointer text-[12px] font-bold tracking-[0.08em] uppercase font-tight',
                  'bg-accent text-accent-ink',
                  'hover:opacity-90 transition-opacity duration-150',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                ].join(' ')}
              >
                {phase === 'submitting' ? 'Submitting…' : 'Submit report'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}
