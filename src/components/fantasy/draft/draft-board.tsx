'use client';

// DraftBoard — the Sleeper-style board shared by the snake room (rows = rounds)
// and the auction room (rows = roster slots). Columns are teams in draft order
// under a sticky header; the auction reuses that header as its budget strip
// (detail line, live-bid badge, lit high bidder). The board never sees picks or
// nominations: each room maps its own data to BoardCell states.
//
// It fills the room's stage and is the scroller (both axes, header sticky). The
// bottom sheet floats over its lower part, so it keeps `--sheet-peek` of padding
// under the last row and measures the sheet when deciding whether the pick on the
// clock is in view.
//
// Pick tiles are colored by the player's rank band, the stand-in for Sleeper's
// position colors (frisbee has no positions in our data, and the rating tier is
// ~80% "S"). Unrated players (contests without ratings) get one neutral tile.
// Tiles are always-light faces with dark navy text, in both app themes.

import { useEffect, useRef } from 'react';
import { AutoBadge } from './autodraft';

export type BoardTone = 'r1' | 'r2' | 'r3' | 'r4' | 'none';

export interface BoardColumn {
  id: string;
  name: string;
  /** Extra line under the name (auction: max bid + budget left). */
  detail?: React.ReactNode;
  /** Replaces the avatar with a round badge (auction: this team's live bid). */
  badge?: string | null;
  /** Lights the header (auction: the high bidder). */
  lit?: boolean;
  auto?: boolean;
}

export type BoardCell =
  | {
      kind: 'pick';
      playerName: string;
      /** Small line under the name (pro team, rank). */
      meta: string | null;
      /** Top-right label: pick number ("2.4") or price ("$34"). */
      corner: string;
      tone: BoardTone;
      auto: boolean;
      /** The pick that just landed: plays the slam-in once. */
      fresh: boolean;
    }
  | { kind: 'clock'; corner: string; remainingSec: number | null; mine: boolean }
  | { kind: 'empty'; corner: string };

const TONE_CLASS: Record<BoardTone, string> = {
  r1: 'bg-[#FFB020]',
  r2: 'bg-[#49E9CC]',
  r3: 'bg-[#4AD0EE]',
  r4: 'bg-[#B7C2EE]',
  none: 'bg-[#D5DDEA]',
};

const LEGEND: { tone: BoardTone; label: string }[] = [
  { tone: 'r1', label: 'Top 10' },
  { tone: 'r2', label: '11–30' },
  { tone: 'r3', label: '31–60' },
  { tone: 'r4', label: '61+' },
];

/** Rank band → tile color. null/undefined = unrated. */
export function toneForRank(rank: number | null | undefined): BoardTone {
  if (rank == null) return 'none';
  if (rank <= 10) return 'r1';
  if (rank <= 30) return 'r2';
  if (rank <= 60) return 'r3';
  return 'r4';
}

/** Sleeper's pick label: round.pick-in-round, no zero padding ("2.10"). */
export function pickLabel(overall: number, teamCount: number): string {
  const n = Math.max(teamCount, 1);
  return `${Math.floor((overall - 1) / n) + 1}.${((overall - 1) % n) + 1}`;
}

/** Where a snake pick sits on the board (0-based row/col in round-1 order). */
export function snakeCell(overall: number, teamCount: number): { row: number; col: number } {
  const n = Math.max(teamCount, 1);
  const row = Math.floor((overall - 1) / n);
  const pos = (overall - 1) % n;
  return { row, col: row % 2 === 0 ? pos : n - 1 - pos };
}

/** Countdown text: 0:07, 1:44, 2:03:10. */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return { first: '', last: parts[0] ?? '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

// ─── Team avatar (monogram; teams have no logos) ────────────────────────────

const AVATAR_TONES = [
  'bg-[#4F7CFF] text-white',
  'bg-[#14B8A6] text-white',
  'bg-[#8B5CF6] text-white',
  'bg-[#F43F5E] text-white',
  'bg-[#F59E0B] text-[#0B1426]',
  'bg-[#22C55E] text-[#0B1426]',
  'bg-[#EC4899] text-white',
  'bg-[#06B6D4] text-[#0B1426]',
];

const AVATAR_SIZE = {
  sm: 'w-7 h-7 text-[10px]',
  md: 'w-8 h-8 lg:w-9 lg:h-9 text-[11px] lg:text-[12px]',
  lg: 'w-12 h-12 text-[15px]',
};

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function TeamAvatar({ id, name, size = 'md' }: { id: string; name: string; size?: keyof typeof AVATAR_SIZE }) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (
    <span
      aria-hidden="true"
      className={[
        'flex-shrink-0 inline-flex items-center justify-center rounded-full font-tight font-extrabold tracking-[0.02em]',
        AVATAR_SIZE[size],
        AVATAR_TONES[h % AVATAR_TONES.length],
      ].join(' ')}
    >
      {initials(name)}
    </span>
  );
}

// ─── Board ──────────────────────────────────────────────────────────────────

const CELL_WIDTH = 'flex-1 basis-0 min-w-[96px] lg:min-w-[104px]';

export function DraftBoard({
  columns,
  rows,
  cellAt,
  arrows = false,
  myColumnId,
  focus = null,
  jumpSignal = 0,
  legend = false,
  before,
  ariaLabel,
}: {
  columns: BoardColumn[];
  rows: number;
  /** 0-based row and column. */
  cellAt: (row: number, col: number) => BoardCell;
  /** Snake direction arrows (→ / ← per round, ↓ where play turns). */
  arrows?: boolean;
  myColumnId: string | null;
  /** The cell to keep in view (the pick on the clock). */
  focus?: { row: number; col: number } | null;
  /** Bump to scroll `focus` into view even if it is already on screen. */
  jumpSignal?: number;
  /** Show the rank-color key (only when some pick has a rating). */
  legend?: boolean;
  /** Scrolls with the board, above the team header (the lobby panel). */
  before?: React.ReactNode;
  ariaLabel: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const n = columns.length;

  const scrollToFocus = (force: boolean) => {
    const box = scrollRef.current;
    if (!box || !focus) return;
    const el = box.querySelector<HTMLElement>(`[data-cell="${focus.row}:${focus.col}"]`);
    if (!el) return;
    const headerH = headerRef.current?.offsetHeight ?? 0;
    // The bottom sheet covers the lower part of the scroller: that part isn't "in view".
    const sheet = box.closest('[data-room-stage]')?.querySelector('[data-room-sheet]');
    const covered = sheet ? Math.max(0, box.getBoundingClientRect().bottom - sheet.getBoundingClientRect().top) : 0;
    const visible =
      el.offsetTop >= box.scrollTop + headerH &&
      el.offsetTop + el.offsetHeight <= box.scrollTop + box.clientHeight - covered &&
      el.offsetLeft >= box.scrollLeft &&
      el.offsetLeft + el.offsetWidth <= box.scrollLeft + box.clientWidth;
    if (visible && !force) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    box.scrollTo({
      top: Math.max(0, el.offsetTop - headerH - 6),
      left: Math.max(0, el.offsetLeft - (box.clientWidth - el.offsetWidth) / 2),
      behavior: reduce ? 'auto' : 'smooth',
    });
  };

  // Follow the clock into view, but leave the board alone while the current
  // pick is already visible (someone may be browsing another round).
  useEffect(() => {
    scrollToFocus(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.row, focus?.col]);

  useEffect(() => {
    if (jumpSignal > 0) scrollToFocus(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpSignal]);

  return (
    <div
      ref={scrollRef}
      className="relative h-full overflow-auto overscroll-contain px-3 pb-[calc(var(--sheet-peek,20rem)+1rem)] lg:px-5"
    >
      {before}
      {n === 0 ? (
        <div className="rounded-card-lg bg-surface p-8 text-center">
          <p className="font-tight text-[13px] text-muted">The board fills in once the draft order is set.</p>
        </div>
      ) : (
        <>
          {legend && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 pb-2 pt-1 font-tight text-[10.5px] text-muted">
              <span className="font-bold tracking-[0.12em] uppercase text-faint">Rank</span>
              {LEGEND.map((l) => (
                <span key={l.tone} className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className={['w-2.5 h-2.5 rounded-full', TONE_CLASS[l.tone]].join(' ')} />
                  {l.label}
                </span>
              ))}
            </div>
          )}

          <div role="table" aria-label={ariaLabel} className="w-max min-w-full">
            {/* Team header — sticky over the rounds as they scroll under it. */}
            <div ref={headerRef} role="row" className="sticky top-0 z-10 flex gap-1.5 bg-bg pb-2">
              {columns.map((c) => {
                const mine = c.id === myColumnId;
                return (
                  <div
                    key={c.id}
                    role="columnheader"
                    className={[
                      CELL_WIDTH,
                      'flex flex-col items-center gap-1 rounded-card-sm px-1.5 pt-1.5 pb-1.5 transition-colors duration-200',
                      c.lit ? 'bg-accent/15 ring-1 ring-inset ring-accent/60' : '',
                    ].join(' ')}
                  >
                    {c.badge ? (
                      <span
                        className={[
                          'inline-flex items-center justify-center min-w-8 h-8 lg:min-w-9 lg:h-9 px-1.5 rounded-full',
                          'font-tight text-[11px] lg:text-[12px] font-extrabold tabular',
                          c.lit ? 'bg-accent text-accent-ink' : 'bg-ink/15 text-ink',
                        ].join(' ')}
                      >
                        {c.badge}
                      </span>
                    ) : (
                      <TeamAvatar id={c.id} name={c.name} />
                    )}
                    <span className="flex items-center gap-1 max-w-full min-w-0">
                      <span
                        className={[
                          'font-tight text-[11px] lg:text-[12px] truncate',
                          mine ? 'font-extrabold text-ink' : 'font-semibold text-muted',
                        ].join(' ')}
                      >
                        {c.name}
                      </span>
                      {c.auto && <AutoBadge />}
                    </span>
                    {c.detail && <div className="w-full font-tight text-[10.5px] text-muted tabular">{c.detail}</div>}
                    {mine && <span aria-hidden="true" className="h-[3px] w-6 rounded-full bg-accent" />}
                  </div>
                );
              })}
            </div>

            <div className="flex flex-col gap-1.5">
              {Array.from({ length: rows }, (_, row) => (
                <div key={row} role="row" className="flex gap-1.5">
                  {columns.map((c, col) => {
                    const turn = arrows && row < rows - 1 && (row % 2 === 0 ? col === n - 1 : col === 0);
                    const dir: ArrowDir | null = !arrows ? null : turn ? 'down' : row % 2 === 0 ? 'right' : 'left';
                    return (
                      <Cell
                        key={c.id}
                        dataCell={`${row}:${col}`}
                        cell={cellAt(row, col)}
                        teamName={c.name}
                        mine={c.id === myColumnId}
                        dir={dir}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Cell ───────────────────────────────────────────────────────────────────

type ArrowDir = 'right' | 'left' | 'down';

function Cell({
  cell,
  dataCell,
  teamName,
  mine,
  dir,
}: {
  cell: BoardCell;
  dataCell: string;
  teamName: string;
  mine: boolean;
  dir: ArrowDir | null;
}) {
  const base = [CELL_WIDTH, 'relative h-[72px] rounded-[10px] px-2 pt-1.5 pb-1 flex flex-col overflow-hidden'].join(' ');

  if (cell.kind === 'pick') {
    const { first, last } = splitName(cell.playerName);
    return (
      <div
        role="cell"
        data-cell={dataCell}
        aria-label={`${cell.corner}, ${teamName}: ${cell.playerName}${cell.auto ? ' (autodraft)' : ''}`}
        className={[base, TONE_CLASS[cell.tone], 'text-[#0B1426]', cell.fresh ? 'motion-safe:animate-slam' : ''].join(' ')}
      >
        <div className="flex items-start justify-between gap-1">
          <span className="font-tight text-[11px] leading-[13px] truncate min-w-0">{first}</span>
          <span className="font-tight text-[10.5px] leading-[13px] font-bold tabular flex-shrink-0 opacity-80">
            {cell.corner}
          </span>
        </div>
        <span className="font-tight text-[14px] leading-[16px] font-extrabold truncate">{last}</span>
        <span className="font-tight text-[9.5px] leading-[12px] font-semibold uppercase tracking-[0.04em] truncate opacity-70">
          {cell.auto ? (cell.meta ? `Auto · ${cell.meta}` : 'Auto') : cell.meta}
        </span>
        {dir && <ArrowGlyph dir={dir} className="mt-auto opacity-55" />}
      </div>
    );
  }

  if (cell.kind === 'clock') {
    const low = cell.remainingSec !== null && cell.remainingSec <= 10;
    return (
      <div
        role="cell"
        data-cell={dataCell}
        aria-label={`${cell.corner}, ${teamName}: on the clock`}
        className={[base, 'bg-accent text-accent-ink motion-safe:animate-play-glow'].join(' ')}
      >
        <div className="flex items-start justify-between gap-1">
          <span className="font-tight text-[10px] leading-[12px] font-extrabold tracking-[0.08em] uppercase">
            {cell.mine ? 'Your pick' : 'On the clock'}
          </span>
          <span className="font-tight text-[10.5px] leading-[13px] font-bold tabular flex-shrink-0 opacity-85">
            {cell.corner}
          </span>
        </div>
        <div className="mt-auto flex items-end justify-between gap-1">
          {dir ? <ArrowGlyph dir={dir} className="opacity-70 mb-0.5" /> : <span />}
          <span
            className={[
              'inline-flex items-center gap-1 font-tight text-[17px] leading-none font-extrabold tabular',
              low ? 'motion-safe:animate-cue-pulse' : '',
            ].join(' ')}
          >
            <StopwatchIcon />
            {cell.remainingSec === null ? '—' : formatClock(cell.remainingSec)}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      role="cell"
      data-cell={dataCell}
      aria-label={`${cell.corner}, ${teamName}: open`}
      className={[base, mine ? 'bg-ink/[0.10]' : 'bg-ink/[0.05]'].join(' ')}
    >
      <span className="self-end font-tight text-[10.5px] leading-[13px] font-bold tabular text-faint">{cell.corner}</span>
      {dir && <ArrowGlyph dir={dir} className="mt-auto text-faint" />}
    </div>
  );
}

// ─── Glyphs ─────────────────────────────────────────────────────────────────

function ArrowGlyph({ dir, className = '' }: { dir: ArrowDir; className?: string }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className={[
        'flex-shrink-0',
        dir === 'left' ? 'rotate-180' : dir === 'down' ? 'rotate-90' : '',
        className,
      ].join(' ')}
    >
      <path d="M2 6h8m0 0L7 3m3 3L7 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StopwatchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="9" r="5.25" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 6.5V9l1.5 1.2M6.5 1.75h3M8 1.75v2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function CrosshairIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 1v3M8 12v3M1 8h3M12 8h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
