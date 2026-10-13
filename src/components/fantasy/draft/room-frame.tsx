'use client';

// RoomFrame — the draft room as a full-screen surface: fixed over the page,
// from under the 52px top rail (the one piece of app nav kept, on every
// breakpoint) to the bottom of the screen. The bottom bar and site footer
// aren't rendered on this route (isDraftRoomPath); the X is the way out.
// z-[55] puts it above the page and below the rail's dropdown menus (z-[60]);
// everything inside stays under z-50 except the dialogs and toasts that must
// cover the sheet.
//
// Slim top bar in every state: X to leave, a status eyebrow over the league
// name, and a gear for the settings popover (autodraft, commissioner link). A
// team on autodraft also gets a pill under the bar that opens the same popover.

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';

export function RoomFrame({
  eyebrow,
  title,
  exitHref,
  autoOn = false,
  menu,
  children,
}: {
  eyebrow: string;
  /** The league name, as the league header shows it. */
  title: string;
  exitHref: string;
  /** My team is on autodraft: show the pill so that state can't be missed. */
  autoOn?: boolean;
  /** Body of the gear popover. */
  menu: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const gearRef = useRef<HTMLButtonElement | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if ([popRef, gearRef, pillRef].some((r) => r.current?.contains(target))) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      gearRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <section
      aria-label="Draft room"
      className={[
        'fixed inset-x-0 top-[52px] bottom-0',
        'z-[55] flex flex-col bg-bg text-ink',
      ].join(' ')}
    >
      <header className="shrink-0">
        <div className="grid h-14 grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center gap-2 px-2 lg:px-4">
          <Link
            href={exitHref}
            aria-label="Leave draft room"
            className="flex h-11 w-11 items-center justify-center rounded-full text-ink transition-colors duration-150 hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <svg width="16" height="16" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </Link>

          <div className="min-w-0 text-center">
            <p className="m-0 truncate font-tight text-[10px] font-extrabold uppercase leading-none tracking-[0.16em] text-accent">
              {eyebrow}
            </p>
            <h1 className="m-0 mt-0.5 truncate font-display text-[19px] font-bold italic leading-[1.2] tracking-[-0.02em] text-ink lg:text-[21px]">
              {title}
            </h1>
          </div>

          <div className="relative">
            <button
              ref={gearRef}
              type="button"
              aria-label="Draft settings"
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-controls={open ? menuId : undefined}
              onClick={() => setOpen((v) => !v)}
              className={[
                'flex h-11 w-11 cursor-pointer items-center justify-center rounded-full text-ink transition-colors duration-150',
                'hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                open ? 'bg-ink/5' : '',
              ].join(' ')}
            >
              <GearIcon />
            </button>
            {open && (
              <div
                ref={popRef}
                id={menuId}
                role="dialog"
                aria-label="Draft settings"
                className="absolute right-0 top-full z-40 mt-1 w-[min(19rem,calc(100vw-1rem))] rounded-card bg-surface p-4 shadow-lift"
              >
                {menu}
              </div>
            )}
          </div>
        </div>

        {autoOn && (
          <div className="flex justify-center pb-2">
            <button
              ref={pillRef}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-controls={open ? menuId : undefined}
              onClick={() => setOpen((v) => !v)}
              className={[
                // before: widens the 32px pill to a 44px touch target
                'relative inline-flex h-8 cursor-pointer items-center gap-2 rounded-full px-3.5',
                'bg-accent/15 ring-1 ring-inset ring-accent/60 text-ink',
                'font-tight text-[10.5px] font-extrabold uppercase tracking-[0.12em]',
                'before:absolute before:-inset-x-2 before:-inset-y-1.5 before:content-[""]',
                'transition-colors duration-150 hover:bg-accent/25',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              ].join(' ')}
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
              Autodraft on
            </button>
          </div>
        )}
      </header>

      <div className="relative flex flex-1 min-h-0 flex-col">{children}</div>
    </section>
  );
}

/** A gate (no draft yet, room not open, load error): one card centered in the frame. */
export function RoomGate({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-6">
      <div className="m-auto w-full max-w-md">{children}</div>
    </div>
  );
}

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx={12} cy={12} r={3} stroke="currentColor" strokeWidth={1.7} />
      <path
        d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  );
}
