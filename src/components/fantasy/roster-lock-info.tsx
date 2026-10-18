'use client';

// RosterLockInfo — the Team tab's lock notice, folded into a clock icon button
// beside the "How scoring works" pill. The full-width banner it replaces sat
// between the pill and the roster and pushed the slots down a phone screen
// (Hunter, 2026-10-17). Tap the button for the same lock text in a small
// panel; tap it again, tap outside or press Esc to close.
//
// Render it inside a `relative` row: the panel anchors to that row, so it spans
// the content column rather than hanging off the icon (which sits right of the
// pill, so a panel anchored to it would run off a phone's right edge).

import { useEffect, useId, useRef, useState } from 'react';
import { periodsToWeeks, type ContestPeriod } from '@/lib/fantasy/leagues';
import { formatWeekLabel, type FantasyWeek } from '@/lib/fantasy/weeks';

type Tone = 'live' | 'quiet' | 'neutral';

interface RosterLockInfoProps {
  isEventMode: boolean;
  periods: ContestPeriod[];
  /** The period the roster builder is editing (null when the schedule is empty). */
  activeWeek: string | null;
}

export function RosterLockInfo({ isEventMode, periods, activeWeek }: RosterLockInfoProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const week = periodsToWeeks(periods).find((w) => w.week === activeWeek) ?? null;
  const notice = lockNotice(isEventMode, week, periods);
  if (!notice) return null;

  return (
    <>
      {/* The button is the 44px touch target; the visible disc is 32px so it
          sits level with the pill. -m-1.5 cancels the hit padding in layout. */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Roster lock info"
        title="Roster lock info"
        className="group -m-1.5 flex-shrink-0 w-11 h-11 flex items-center justify-center rounded-full cursor-pointer focus-visible:outline-none"
      >
        <span
          className={[
            'w-8 h-8 flex items-center justify-center rounded-full bg-ink/5',
            'group-hover:bg-ink/10 transition-colors duration-150',
            'group-focus-visible:ring-2 group-focus-visible:ring-accent',
            // Locked reads red without opening the panel (the old banner's tint).
            notice.tone === 'live' ? 'text-live' : 'text-ink',
          ].join(' ')}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8 4.75V8l2.25 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          className="absolute inset-x-0 top-full z-30 mt-2 max-w-sm bg-surface rounded-card-sm shadow-lift"
        >
          <div
            className={[
              'flex items-center gap-3 px-4 py-3 rounded-card-sm',
              notice.tone === 'live' ? 'bg-live/[0.08]' : 'bg-ink/[0.04]',
            ].join(' ')}
          >
            {notice.tone === 'live' && (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="flex-shrink-0 text-live">
                <rect x="3" y="7" width="10" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
                <path d="M5 7V5a3 3 0 116 0v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            )}
            <span className="font-tight text-[13px] font-medium text-ink">{notice.text}</span>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Notice copy ──────────────────────────────────────────────────────────────

/** What the roster's lock state says, or null when there's nothing to say
 *  (an event contest with no 'event' period). */
function lockNotice(
  isEventMode: boolean,
  week: FantasyWeek | null,
  periods: ContestPeriod[],
): { tone: Tone; text: string } | null {
  if (isEventMode) {
    const eventPeriod = periods.find((p) => p.period === 'event');
    if (!eventPeriod) return null;
    if (eventPeriod.complete) {
      return { tone: 'neutral', text: 'This event has finished — final scores are in.' };
    }
    if (week?.locked) {
      return { tone: 'live', text: 'Roster is locked — the event has started.' };
    }
    return {
      tone: 'quiet',
      text: `Locks when the event starts${eventPeriod.lockAt ? ` — ${formatEventStart(eventPeriod.lockAt)}` : ''}. Edit any time before then.`,
    };
  }

  if (!week) {
    return { tone: 'quiet', text: 'No active period found. Check back once the schedule is published.' };
  }

  if (week.locked) {
    return {
      tone: 'live',
      text: `${formatWeekLabel(week.week)} is locked for the weekend${week.unlockAt ? ` — editing reopens ${formatReopen(week.unlockAt)}` : ' — roster changes are disabled'}.`,
    };
  }

  return {
    tone: 'quiet',
    text: week.lockAt
      ? `Locks at first game — ${formatLock(week.lockAt)}. Edit any time before then.`
      : 'Edit your roster any time before games start.',
  };
}

// "Fri, Jul 10, 7:00 PM ET" for a lock instant.
function formatLock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'first game';
  const s = d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  });
  return `${s} ET`;
}

function formatReopen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Monday';
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
}

function formatEventStart(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'the event start';
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}
