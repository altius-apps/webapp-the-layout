'use client';

// DraftSettingsCard — Settings → Draft. Three states, web port of mobile's
// DraftSettingsCard.tsx:
//   1. No draft yet   — commissioner configures type + settings + a time at
//      least 15 minutes out (no manual start — Hunter, 2026-10-13; 15 since 10-14), then
//      schedules it (scheduleDraft / scheduleAuctionDraft).
//   2. Scheduled      — read-only summary + a reschedule form. A MISSED
//      draft (readiness.missed) shows a banner and the reschedule floor
//      shifts to originalScheduledAt + 1 day when missed, else now + 15 min (readiness.rescheduleFloor).
//      Both pickers open on the first half-hour slot past the floor, not the
//      floor itself: the RPC re-takes now() on submit.
//   3. Live / complete — read-only summary + a link into the draft room.
//
// Team-count gating: the RPC itself refuses to schedule below minTeams, so we
// mirror that client-side (disable Schedule + show the note) rather than
// letting the request round-trip to fail.

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import {
  DRAFT_CLOCK_SECONDS,
  scheduleDraft,
  scheduleAuctionDraft,
  rescheduleDraft,
  type Draft,
  type DraftReadiness,
  type DraftType,
} from '@/lib/fantasy/draft-room';
import type { ContestView } from '@/lib/fantasy/leagues';
import { teamSize } from '@/lib/fantasy/competitions';
import { PillSelect, type PillSelectOption } from '@/components/pill-select';
import { Card, SaveButton, Feedback, NumberField } from './shared';

interface Props {
  contest: ContestView;
  draft: Draft | null;
  readiness: DraftReadiness | null;
  loading: boolean;
  onSaved: () => void;
}

const BID_SECONDS_OPTIONS = [10, 15, 20, 30].map((s) => ({ value: s, label: `${s}s` }));

function formatScheduled(iso: string | null): string {
  if (!iso) return 'Not set';
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
}

export function DraftSettingsCard({ contest, draft, readiness, loading, onSaved }: Props) {
  if (loading || !readiness) {
    return (
      <Card title="Draft">
        <p className="font-tight text-[13px] text-faint">Loading…</p>
      </Card>
    );
  }

  // Finished contest: nothing left to draft (fantasy_schedule_draft refuses a
  // contest that isn't open), so don't offer the schedule/reschedule forms.
  if (contest.status === 'complete' && (!draft || draft.status === 'scheduled')) {
    return (
      <Card title="Draft">
        <p className="font-tight text-[13px] text-faint">This season is over — there&apos;s no draft to schedule.</p>
      </Card>
    );
  }

  if (!draft) {
    return <ScheduleForm contest={contest} readiness={readiness} onSaved={onSaved} />;
  }

  if (draft.status === 'scheduled') {
    return <ScheduledView contest={contest} draft={draft} readiness={readiness} onSaved={onSaved} />;
  }

  return <ReadOnlyView contest={contest} draft={draft} />;
}

// ─── State 1: no draft yet ──────────────────────────────────────────────────

function ScheduleForm({
  contest,
  readiness,
  onSaved,
}: {
  contest: ContestView;
  readiness: DraftReadiness;
  onSaved: () => void;
}) {
  // Preselects the commissioner's Create a League pick; still changeable here.
  const [type, setType] = useState<DraftType>(contest.settings.draftType ?? 'snake');
  // Fixed by the game, not the commissioner (weekly 12, event 7).
  const rounds = teamSize(contest.settings);
  const [budget, setBudget] = useState(200);
  const [bidSeconds, setBidSeconds] = useState(15);
  const [minBid, setMinBid] = useState(1);
  const [floor] = useState(() => noticeFloor(readiness.earliestAt));
  const [at, setAt] = useState<string | null>(() => startAt(readiness.defaultAt, floor));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const belowMin = readiness.teamCount < readiness.minTeams;
  const canSchedule = !belowMin && !!at && !saving;

  const schedule = async () => {
    if (!canSchedule || !at) return;
    // The picker's times were set when the form opened; the notice counts from now.
    if (new Date(at).getTime() < Date.now() + NOTICE_MS) {
      setError("Give the league at least 15 minutes' notice — pick a later time.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (type === 'snake') {
        await scheduleDraft({ contestId: contest.id, at, rounds });
      } else {
        await scheduleAuctionDraft({
          contestId: contest.id,
          at,
          rounds,
          budget,
          bidSeconds,
          minBid,
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not schedule the draft.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Draft">
      <div className="flex flex-col gap-4">
        {!readiness.rostersReady && (
          <div className="rounded-card-sm bg-live/[0.08] px-3 py-2.5">
            <p className="font-tight text-[12px] text-live leading-snug">
              Rosters not set on {readiness.sourceLabel} — draft will be another day.
            </p>
          </div>
        )}

        <div className="flex gap-2" role="radiogroup" aria-label="Draft type">
          <TypeOption label="Snake" selected={type === 'snake'} onClick={() => setType('snake')} />
          <TypeOption label="Auction" selected={type === 'auction'} onClick={() => setType('auction')} />
        </div>

        <p className="font-tight text-[12px] text-faint">
          {rounds} rounds ·{' '}
          {contest.settings.mode === 'event' ? '7 players, no bench — set for the whole event' : '7 starters each week + 5 bench'}
          {' · '}
          {type === 'snake' ? `${DRAFT_CLOCK_SECONDS}-second pick clock` : `${DRAFT_CLOCK_SECONDS} seconds to nominate`}
        </p>

        {type === 'auction' && (
          <>
            <div className="grid grid-cols-2 items-end gap-3">
              <NumberField label="Budget" value={budget} onChange={setBudget} id="draft-budget" min={50} max={1000} step={10} />
              <NumberField label="Min bid" value={minBid} onChange={setMinBid} id="draft-min-bid" min={1} max={10} />
            </div>
            <div className="grid grid-cols-2 items-end gap-3">
              <PillField label="Bid clock" ariaLabel="Bid clock" value={bidSeconds} onChange={setBidSeconds} options={BID_SECONDS_OPTIONS} />
            </div>
          </>
        )}

        <p className="font-tight text-[12px] text-muted leading-snug">
          Give the league at least 15 minutes&apos; notice.
        </p>

        <DateTimeField label="Draft time" value={at} onChange={setAt} min={floor} max={readiness.lockAt} />

        <div className="flex items-center justify-between gap-3">
          <p className="font-tight text-[12px] text-live">
            {belowMin ? `Need ${readiness.minTeams} teams to draft (${readiness.teamCount} so far).` : ''}
          </p>
          <button
            type="button"
            disabled={!canSchedule}
            onClick={schedule}
            className={[
              'inline-flex items-center justify-center gap-2 flex-shrink-0',
              'px-5 py-2.5 rounded-full min-h-[44px]',
              'font-tight text-[12px] font-bold tracking-[0.06em] uppercase transition-colors duration-150',
              !canSchedule
                ? 'bg-ink/[0.08] text-faint cursor-not-allowed'
                : 'bg-accent text-accent-ink hover:opacity-90 cursor-pointer',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
            ].join(' ')}
          >
            {saving && (
              <span
                className="w-3.5 h-3.5 rounded-full border-2 border-current/30 border-t-current animate-spin"
                aria-hidden="true"
              />
            )}
            {saving ? 'Scheduling…' : 'Schedule draft'}
          </button>
        </div>
        <Feedback error={error} saved={false} />
      </div>
    </Card>
  );
}

// ─── State 2: scheduled ─────────────────────────────────────────────────────

function ScheduledView({
  contest,
  draft,
  readiness,
  onSaved,
}: {
  contest: ContestView;
  draft: Draft;
  readiness: DraftReadiness;
  onSaved: () => void;
}) {
  const rescheduleFloor = readiness.rescheduleFloor ?? readiness.earliestAt;
  const [at, setAt] = useState<string | null>(() => startAt(draft.scheduledAt, rescheduleFloor));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The time just saved, for the confirmation; cleared once the picker changes.
  const [changedTo, setChangedTo] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!at || saving) return;
    setSaving(true);
    setError(null);
    setChangedTo(null);
    try {
      await rescheduleDraft(draft.id, at);
      setChangedTo(at);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reschedule the draft.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Draft">
      <div className="flex flex-col gap-4">
        <div>
          <p className="font-tight text-[13.5px] font-semibold text-ink">
            {draft.draftType === 'snake' ? 'Snake' : 'Auction'} · {draft.rounds} rounds
          </p>
          <p className="font-tight text-[13.5px] font-semibold text-ink">Scheduled {formatScheduled(draft.scheduledAt)}</p>
        </div>

        {readiness.missed && (
          <div className="rounded-card-sm bg-live/[0.08] px-3 py-2.5">
            <p className="font-tight text-[12px] text-live leading-snug">
              The scheduled time passed before the draft started. Pick a new time at least a day after the
              original ({formatScheduled(readiness.originalScheduledAt)}).
            </p>
          </div>
        )}

        {!readiness.missed && (
          <p className="font-tight text-[12px] text-muted leading-snug">
            Give the league at least 15 minutes&apos; notice.
          </p>
        )}

        <form onSubmit={save} className="flex flex-col gap-4">
          <DateTimeField
            label="Reschedule"
            value={at}
            onChange={(v) => {
              setAt(v);
              setChangedTo(null);
            }}
            min={rescheduleFloor}
            max={readiness.lockAt}
          />
          <div className="flex items-center justify-between gap-3">
            <Link
              href={`/fantasy/l/${contest.id}/draft`}
              className="font-tight text-[12.5px] font-bold text-accent no-underline hover:underline"
            >
              Open draft room
            </Link>
            <SaveButton disabled={!at || saving} saving={saving} label="Reschedule" savingLabel="Saving…" />
          </div>
        </form>
        <Feedback
          error={error}
          saved={changedTo != null}
          savedText={`Draft time changed to ${formatScheduled(changedTo)}.`}
        />
      </div>
    </Card>
  );
}

// ─── State 3: live / complete ───────────────────────────────────────────────

function ReadOnlyView({ contest, draft }: { contest: ContestView; draft: Draft }) {
  return (
    <Card title="Draft">
      <div className="flex flex-col gap-4">
        <div>
          <p className="font-tight text-[13.5px] font-semibold text-ink">
            {draft.draftType === 'snake' ? 'Snake' : 'Auction'} · {draft.rounds} rounds
          </p>
          <p className="font-tight text-[13.5px] font-semibold text-ink">
            {draft.status === 'live' ? 'Live now' : 'Complete'}
          </p>
        </div>
        <Link
          href={`/fantasy/l/${contest.id}/draft`}
          className="font-tight text-[12.5px] font-bold text-accent no-underline hover:underline self-start"
        >
          Open draft room
        </Link>
      </div>
    </Card>
  );
}

// ─── Shared bits ────────────────────────────────────────────────────────────

export function TypeOption({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={[
        'flex-1 rounded-full border px-4 py-2.5 min-h-[40px]',
        'font-tight text-[12.5px] font-bold tracking-[0.06em] uppercase transition-colors duration-150',
        selected ? 'border-accent text-accent bg-accent/[0.06]' : 'border-hairline text-muted',
        'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

function PillField({
  label,
  ariaLabel,
  value,
  onChange,
  options,
}: {
  label: string;
  ariaLabel: string;
  value: number;
  onChange: (n: number) => void;
  options: { value: number; label: string }[];
}) {
  return (
    <div>
      <span className="block text-[10.5px] font-bold tracking-[0.14em] uppercase text-faint font-tight mb-1.5">
        {label}
      </span>
      <PillSelect value={value} options={options} onChange={onChange} ariaLabel={ariaLabel} />
    </div>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 60;
const NOTICE_MS = 15 * 60 * 1000;

/** The earliest draft time: 15 minutes from now, or the window's start if later. */
function noticeFloor(earliestAt: string | null): string {
  const ms = Math.max(Date.now() + NOTICE_MS, earliestAt ? new Date(earliestAt).getTime() : 0);
  return new Date(ms).toISOString();
}

/** The first local half-hour slot (the picker's steps) at or after `iso`. A
 *  now-based floor carries seconds, so this lands past it rather than on it. */
function firstSlot(iso: string): string {
  const d = new Date(iso);
  if (d.getMinutes() % 30 !== 0 || d.getSeconds() !== 0 || d.getMilliseconds() !== 0) {
    d.setMinutes(d.getMinutes() - (d.getMinutes() % 30) + 30, 0, 0);
  }
  return d.toISOString();
}

/** The picker's opening value: `preferred` while it clears the floor, else the first slot after it. */
function startAt(preferred: string | null, floor: string | null): string | null {
  if (!floor) return preferred;
  return preferred && new Date(preferred).getTime() >= new Date(floor).getTime() ? preferred : firstSlot(floor);
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayLabel(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function timeLabel(minutesOfDay: number): string {
  const h = Math.floor(minutesOfDay / 60);
  const m = minutesOfDay % 60;
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

function composeLocal(day: string, minutes: number): Date {
  const [y, mo, da] = day.split('-').map(Number);
  return new Date(y, mo - 1, da, Math.floor(minutes / 60), minutes % 60, 0, 0);
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const SLOTS = Array.from({ length: 48 }, (_, i) => i * 30);
const DEFAULT_MINUTES = 20 * 60; // 8 PM

/** Day + time picker on one row: a date pill that opens a month calendar in a
 *  centered modal (every day outside the window blocked) and a 30-minute time
 *  PillSelect showing 5 slots at a time (Hunter, 2026-10-14; the native datetime-local
 *  popup can't take our styling). The window is [max(now, min), max ?? +60
 *  days] — a day is clickable while one of its slots falls inside it. Times are
 *  the viewer's local day; the saved instant is UTC. */
function DateTimeField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: string | null;
  onChange: (iso: string | null) => void;
  min: string | null;
  max: string | null;
}) {
  const now = useMemo(() => new Date(), []);
  const floorMs = Math.max(now.getTime(), min ? new Date(min).getTime() : 0);
  const ceilMs = max ? new Date(max).getTime() : now.getTime() + DEFAULT_WINDOW_DAYS * DAY_MS;

  const parsed = value ? new Date(value) : null;
  const selectedDay = parsed ? dayKey(parsed) : null;
  const selectedMinutes = parsed ? parsed.getHours() * 60 + parsed.getMinutes() : null;

  const openSlots = (day: string) =>
    SLOTS.filter((m) => {
      const t = composeLocal(day, m).getTime();
      return t >= floorMs && t <= ceilMs;
    });

  const firstMonth = monthStart(new Date(floorMs));
  const lastMonth = monthStart(new Date(ceilMs));
  const [month, setMonth] = useState(() => monthStart(parsed ?? new Date(floorMs)));
  const [calOpen, setCalOpen] = useState(false);

  // Escape closes the calendar; a tap on the backdrop does too (below).
  useEffect(() => {
    if (!calOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCalOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [calOpen]);

  const toggleCalendar = () => {
    if (!calOpen) setMonth(monthStart(parsed ?? new Date(floorMs)));
    setCalOpen((o) => !o);
  };

  const cells = useMemo(() => {
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const days = Array.from({ length: count }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1));
    return [...Array<null>(month.getDay()).fill(null), ...days];
  }, [month]);

  const openDays = useMemo(
    () => new Set(cells.filter((d): d is Date => !!d && openSlots(dayKey(d)).length > 0).map(dayKey)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cells, floorMs, ceilMs],
  );

  // Keep the chosen time when the new day allows it, else 8 PM, else the day's first open slot.
  const pickDay = (day: string) => {
    const open = openSlots(day);
    const m =
      selectedMinutes != null && open.includes(selectedMinutes)
        ? selectedMinutes
        : open.includes(DEFAULT_MINUTES)
          ? DEFAULT_MINUTES
          : open[0];
    onChange(composeLocal(day, m).toISOString());
    setCalOpen(false);
  };

  const timeOptions = useMemo(() => {
    if (!selectedDay) return [];
    const steps = [...SLOTS];
    // A saved off-step time (7:40 PM) stays listed so the pill shows it.
    if (selectedMinutes != null && !steps.includes(selectedMinutes)) steps.push(selectedMinutes);
    return steps
      .sort((a, b) => a - b)
      .map((m): PillSelectOption<number> => {
        const t = composeLocal(selectedDay, m).getTime();
        return { value: m, label: timeLabel(m), disabled: t < floorMs || t > ceilMs };
      });
  }, [selectedDay, selectedMinutes, floorMs, ceilMs]);

  const todayKey = dayKey(now);
  const canPrev = month.getTime() > firstMonth.getTime();
  const canNext = month.getTime() < lastMonth.getTime();

  return (
    <div>
      <span className="block text-[10.5px] font-bold tracking-[0.14em] uppercase text-faint font-tight mb-1.5">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={calOpen}
          aria-label={`${label} day`}
          onClick={toggleCalendar}
          className={[
            'inline-flex items-center gap-2 pl-3.5 pr-2.5 py-[7px] rounded-full min-h-[36px]',
            'text-[11px] font-bold tracking-[0.14em] uppercase font-tight whitespace-nowrap',
            'bg-ink/5 text-ink cursor-pointer hover:bg-ink/10 transition-colors duration-150',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          ].join(' ')}
        >
          <span>{parsed ? dayLabel(parsed) : 'Pick a day'}</span>
          <svg
            width="10"
            height="10"
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
            className={['text-muted transition-transform duration-150', calOpen ? 'rotate-180' : ''].join(' ')}
          >
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {calOpen &&
          createPortal(
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 px-4 py-6 backdrop-blur-sm"
              onPointerDown={(e) => {
                if (e.target === e.currentTarget) setCalOpen(false);
              }}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-label={`${label} calendar`}
                className="w-full max-w-[340px] rounded-card-lg bg-surface p-4 shadow-hero"
              >
                <div className="mb-2 flex items-center justify-between">
                  <MonthButton dir="prev" disabled={!canPrev} onClick={() => setMonth(addMonths(month, -1))} />
                  <span className="font-tight text-[13.5px] font-bold text-ink" aria-live="polite">
                    {month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                  </span>
                  <MonthButton dir="next" disabled={!canNext} onClick={() => setMonth(addMonths(month, 1))} />
                </div>
                <div className="grid grid-cols-7 gap-y-1 text-center">
                  {WEEKDAYS.map((w, i) => (
                    <span key={i} aria-hidden="true" className="pb-1 font-tight text-[10px] font-bold tracking-[0.14em] text-faint">
                      {w}
                    </span>
                  ))}
                  {cells.map((d, i) => {
                    if (!d) return <span key={`pad-${i}`} />;
                    const key = dayKey(d);
                    const open = openDays.has(key);
                    const selected = key === selectedDay;
                    return (
                      <button
                        key={key}
                        type="button"
                        disabled={!open}
                        aria-pressed={selected}
                        aria-label={dayLabel(d)}
                        onClick={() => pickDay(key)}
                        className={[
                          'mx-auto flex h-10 w-10 items-center justify-center rounded-full font-tight text-[13px] tabular',
                          'transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                          selected
                            ? 'bg-accent text-accent-ink font-bold'
                            : open
                              ? 'text-ink font-semibold hover:bg-ink/[0.06] cursor-pointer'
                              : 'text-faint opacity-40 cursor-not-allowed',
                          key === todayKey && !selected ? 'ring-1 ring-inset ring-hairline' : '',
                        ].join(' ')}
                      >
                        {d.getDate()}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>,
            document.body,
          )}

        {selectedDay && selectedMinutes != null && (
          <PillSelect
            value={selectedMinutes}
            options={timeOptions}
            onChange={(m) => onChange(composeLocal(selectedDay, m).toISOString())}
            ariaLabel={`${label} time`}
            menuHeightClass="max-h-[182px]"
          />
        )}
      </div>
      <p className="mt-2 font-tight text-[12.5px] font-medium text-muted">
        {parsed && selectedMinutes != null ? `${dayLabel(parsed)} · ${timeLabel(selectedMinutes)}` : 'Pick a day'}
      </p>
    </div>
  );
}

function monthStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function MonthButton({ dir, disabled, onClick }: { dir: 'prev' | 'next'; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={dir === 'prev' ? 'Previous month' : 'Next month'}
      className={[
        'inline-flex h-10 w-10 items-center justify-center rounded-full transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        disabled ? 'text-faint opacity-40 cursor-not-allowed' : 'text-ink hover:bg-ink/[0.06] cursor-pointer',
      ].join(' ')}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={dir === 'prev' ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'} />
      </svg>
    </button>
  );
}
