'use client';

import { useId, useState, type ReactNode } from 'react';

/** Section h2 with an "i" button right after the label that opens a note
 *  inline under the header. Replaces the standalone note cards on /teams
 *  (matches mobile). */
export function UsauSectionHeaderNote({
  id,
  label,
  count,
  noteLabel,
  note,
}: {
  id: string;
  label: ReactNode;
  count: ReactNode;
  noteLabel: string;
  note: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const noteId = useId();
  return (
    <>
      <h2
        id={id}
        className="flex items-center justify-between text-[10px] font-bold tracking-[0.18em] uppercase text-muted mb-4 font-tight"
      >
        <span className="flex items-center">
          <span>{label}</span>
          {/* 44px hit area; the negative margins keep the row at text height. */}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={noteId}
            aria-label={open ? `Hide ${noteLabel}` : `Show ${noteLabel}`}
            className={`-my-[15px] -ml-[11px] inline-flex h-11 w-11 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${open ? 'text-accent' : 'text-faint'}`}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4" />
              <path d="M12 8h.01" />
            </svg>
          </button>
        </span>
        <span className="text-faint normal-case tracking-[0.1em]">{count}</span>
      </h2>
      <p
        id={noteId}
        hidden={!open}
        className="rounded-card-sm bg-bg px-3 py-2.5 mb-4 text-[11px] font-medium text-faint font-tight"
      >
        <span className="font-bold text-muted uppercase tracking-[0.16em] text-[10px]">
          {noteLabel} ·
        </span>{' '}
        {note}
      </p>
    </>
  );
}
