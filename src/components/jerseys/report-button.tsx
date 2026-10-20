'use client';

// ReportButton — the ONLY thing that summons an admin in this feature.
// Listings publish instantly; nothing is reviewed unless someone flags it.
//
// For a message thread, filing a report is ALSO what unlocks admin read access
// to that conversation (jersey_thread_messages_for_admin). Admins cannot open a
// thread nobody reported, so this button is the consent mechanism.

import { useEffect, useState } from 'react';
import { reportContent } from '@/lib/jerseys/data';
import { REPORT_REASONS, type ReportReason } from '@/lib/jerseys/types';

export function ReportButton({
  listingId,
  wantId,
  threadId,
  reportedUserId,
  signedIn,
  label = 'Report',
}: {
  listingId?: string;
  wantId?: string;
  threadId?: string;
  reportedUserId?: string | null;
  signedIn: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason>(REPORT_REASONS[0]);
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!signedIn) return null;

  async function submit() {
    setBusy(true);
    setError(null);
    const err = await reportContent({ listingId, wantId, threadId, reportedUserId, reason, detail });
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    setDone(true);
    setTimeout(() => {
      setOpen(false);
      setDone(false);
      setDetail('');
    }, 1400);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 min-h-[36px] rounded-full text-[11px] font-semibold text-faint hover:text-ink font-tight cursor-pointer motion-safe:transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <FlagGlyph />
        {label}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40 motion-safe:animate-fade-in"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Report this"
            className="relative z-10 w-full sm:max-w-md bg-bg rounded-t-card-lg sm:rounded-card-lg shadow-hero max-h-[85vh] flex flex-col"
          >
            <div className="flex items-center justify-between p-4 border-b border-hairline flex-shrink-0">
              <span className="font-display italic text-xl font-bold text-ink">Report</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="w-9 h-9 grid place-items-center rounded-full bg-ink/5 text-muted hover:bg-ink/10 cursor-pointer"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {done ? (
              <div className="p-6 text-center flex flex-col gap-1.5">
                <span className="font-display italic text-2xl font-bold text-ink">Thanks</span>
                <span className="text-[13px] text-muted font-tight">
                  We&rsquo;ll take a look. You won&rsquo;t see a response, but every report is read.
                </span>
              </div>
            ) : (
              <>
                <div className="overflow-y-auto p-4 flex flex-col gap-4">
                  <fieldset className="flex flex-col gap-2">
                    <legend className="text-[10.5px] font-bold tracking-[0.12em] uppercase text-muted font-tight mb-1">
                      What&rsquo;s wrong?
                    </legend>
                    {REPORT_REASONS.map((r) => (
                      <label
                        key={r}
                        className="flex items-center gap-2.5 px-3 py-2.5 rounded-card bg-surface cursor-pointer hover:bg-ink/5 motion-safe:transition-colors"
                      >
                        <input
                          type="radio"
                          name="report-reason"
                          value={r}
                          checked={reason === r}
                          onChange={() => setReason(r)}
                          className="accent-[color:var(--accent)]"
                        />
                        <span className="text-[13px] text-ink font-tight">{r}</span>
                      </label>
                    ))}
                  </fieldset>

                  <label className="flex flex-col gap-1.5">
                    <span className="text-[10.5px] font-bold tracking-[0.12em] uppercase text-muted font-tight">
                      Anything else? (optional)
                    </span>
                    <textarea
                      value={detail}
                      onChange={(e) => setDetail(e.target.value)}
                      rows={3}
                      maxLength={2000}
                      className="w-full px-3 py-2.5 rounded-card bg-surface text-[13px] text-ink font-tight resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      placeholder="Context helps us act faster."
                    />
                  </label>

                  {threadId && (
                    <p className="text-[11.5px] text-faint font-tight leading-snug">
                      Reporting a conversation lets an admin read it. Messages are private
                      otherwise.
                    </p>
                  )}

                  {error && (
                    <p className="text-[12px] text-accent font-tight" role="alert">
                      {error}
                    </p>
                  )}
                </div>

                <div className="p-4 border-t border-hairline flex-shrink-0">
                  <button
                    type="button"
                    onClick={submit}
                    disabled={busy}
                    className="w-full inline-flex items-center justify-center min-h-[52px] rounded-full bg-accent text-accent-ink text-[12.5px] font-bold tracking-[0.08em] uppercase font-tight disabled:opacity-60 cursor-pointer hover:opacity-90"
                  >
                    {busy ? 'Sending…' : 'Send report'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function FlagGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 1v10M2.5 2h6l-1 2 1 2h-6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
