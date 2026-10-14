'use client';

// RoomStage — the draft room's working area under the top bar: an optional
// pinned header (the pick clock, the auction stage), the board filling the rest,
// and a bottom sheet (Players / Queue / Team / Chat) floating over the lower
// part of it. Snake and auction share it.
//
// The sheet rests at three heights: `min` (handle + tabs only), `peek` (45% of
// the stage, the default) and `full` (the whole stage, under the top bar). It
// drags on the handle and tab strip, and (touch) on the panel too when a pull
// DOWN starts with the list already at its top (Hunter, 2026-10-14). Every
// other gesture in the panel scrolls the list natively.
//
// It is positioned with `top: var(--sheet-top)`, never a transform: ConfirmDialog
// and AuthModal render `fixed inset-0` from inside the sheet (Chat, Players),
// and a transformed ancestor would become their containing block and clip them
// to the sheet. The variable is set imperatively while dragging (no re-render
// per move); the board reads `--sheet-peek` to leave room under its last row.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RoomTabs, roomTabId, type RoomTab } from './room-tabs';

export type SheetSnap = 'min' | 'peek' | 'full';

const HANDLE_H = 24; // the handle row's h-6
const TABS_H = 44; // RoomTabs' h-11
const MIN_H = HANDLE_H + TABS_H;
const PEEK_FRACTION = 0.45;
const DRAG_SLOP_PX = 6;
const FLICK_PX_PER_MS = 0.5;
const FLICK_LOOKAHEAD_MS = 180;
const PANEL_ID = 'room-sheet-panel';

const SNAPS: readonly SheetSnap[] = ['min', 'peek', 'full'];

type Tops = Record<SheetSnap, number>;

/** The sheet's state, owned by the room so it can open it (and pick the tab) itself. */
export interface SheetControl {
  tab: RoomTab;
  snap: SheetSnap;
  setTab: (tab: RoomTab) => void;
  setSnap: (snap: SheetSnap) => void;
}

interface Drag {
  id: number;
  y0: number;
  top0: number;
  moved: boolean;
  samples: { t: number; y: number }[];
}

function nearestSnap(top: number, tops: Tops): SheetSnap {
  return SNAPS.reduce((best, s) => (Math.abs(tops[s] - top) < Math.abs(tops[best] - top) ? s : best), 'peek' as SheetSnap);
}

/** The next resting height past `top` in the flick's direction (up = toward full). */
function snapInDirection(top: number, up: boolean, tops: Tops): SheetSnap | null {
  const ahead = SNAPS.filter((s) => (up ? tops[s] < top - 1 : tops[s] > top + 1));
  if (ahead.length === 0) return null;
  return ahead.reduce((best, s) => (Math.abs(tops[s] - top) < Math.abs(tops[best] - top) ? s : best));
}

export function RoomStage({
  header,
  children,
  sheet,
  renderPanel,
  status,
}: {
  /** Pinned above the board: the pick clock strip or the auction stage. */
  header?: React.ReactNode;
  /** The board. Fills the space and scrolls itself, with `var(--sheet-peek)` of
   *  bottom padding so its last row can scroll clear of the sheet. */
  children: React.ReactNode;
  sheet: SheetControl;
  /** `collapsed` = the sheet is at `min`, so nothing in it is on screen. */
  renderPanel: (tab: RoomTab, collapsed: boolean) => React.ReactNode;
  /** Shown in the handle row while the sheet covers the header (the pick clock). */
  status?: React.ReactNode;
}) {
  const { tab, snap, setTab: onTab, setSnap: onSnap } = sheet;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLElement | null>(null);
  const topRef = useRef(0);
  const draggingRef = useRef(false);
  const suppressClick = useRef(false);

  const safeProbeRef = useRef<HTMLDivElement | null>(null);

  const [stageH, setStageH] = useState(0);
  // The room runs to the bottom of the screen, so `min` sits above the home
  // indicator; env() can't be read from JS, so a probe element measures it.
  const [safeBottom, setSafeBottom] = useState(0);
  const [ready, setReady] = useState(false);

  const tops = useMemo<Tops>(() => {
    const min = Math.max(stageH - MIN_H - safeBottom, 0);
    const peek = Math.min(Math.max(stageH - Math.round(stageH * PEEK_FRACTION), 0), min);
    return { min, peek, full: 0 };
  }, [stageH, safeBottom]);

  const applyTop = useCallback((px: number) => {
    topRef.current = px;
    sheetRef.current?.style.setProperty('--sheet-top', `${px}px`);
  }, []);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      setStageH(stage.clientHeight);
      setSafeBottom(safeProbeRef.current?.offsetHeight ?? 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (stageH === 0) return;
    stageRef.current?.style.setProperty('--sheet-peek', `${stageH - tops.peek}px`);
    if (!draggingRef.current) applyTop(tops[snap]);
  }, [stageH, tops, snap, applyTop]);

  // No slide on the first placement: the sheet starts where it belongs.
  useLayoutEffect(() => {
    if (stageH === 0) return;
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, [stageH]);

  const latest = useRef({ tops, onSnap });
  latest.current = { tops, onSnap };
  const stopDragRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => () => stopDragRef.current?.(), []);

  // Snap a finished drag: a flick goes to the next height in its direction,
  // otherwise the nearest height to where it was heading.
  const settle = useCallback(
    (samples: Drag['samples'], cancelled: boolean) => {
      draggingRef.current = false;
      sheetRef.current?.setAttribute('data-dragging', 'false');
      const { tops: t, onSnap: setSnap } = latest.current;
      const last = samples[samples.length - 1];
      const from = samples.find((m) => m.t >= last.t - 100) ?? last;
      const v = cancelled || last.t === from.t ? 0 : (last.y - from.y) / (last.t - from.t); // px/ms, + = down
      const top = topRef.current;
      const target =
        (Math.abs(v) >= FLICK_PX_PER_MS ? snapInDirection(top, v < 0, t) : null) ?? nearestSnap(top + v * FLICK_LOOKAHEAD_MS, t);
      applyTop(t[target]);
      setSnap(target);
    },
    [applyTop],
  );

  // Pull-down on the panel moves the sheet while the list is at its top. Touch
  // only, with non-passive listeners so the takeover can stop the native
  // scroll/overscroll; a gesture that starts as a scroll stays a scroll.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    let g: { x0: number; y0: number; top0: number; mode: 'pending' | 'sheet' | 'scroll'; samples: Drag['samples'] } | null = null;
    // A pull released over a button (Draft, the star) must not press it.
    let blockClickUntil = 0;

    // Anything between the finger and the panel that is scrolled down keeps the gesture.
    const atTop = (target: EventTarget | null) => {
      for (let el = target as HTMLElement | null; el && el !== panel.parentElement; el = el.parentElement) {
        if (el.scrollTop > 0) return false;
      }
      return true;
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || (e.target as HTMLElement).closest('textarea')) {
        g = null;
        return;
      }
      const t = e.touches[0];
      g = { x0: t.clientX, y0: t.clientY, top0: topRef.current, mode: 'pending', samples: [{ t: e.timeStamp, y: t.clientY }] };
    };

    const onMove = (e: TouchEvent) => {
      if (!g || g.mode === 'scroll') return;
      const t = e.touches[0];
      const dy = t.clientY - g.y0;
      if (g.mode === 'pending') {
        const pullDown = dy > 0 && dy >= Math.abs(t.clientX - g.x0) && atTop(e.target);
        if (!pullDown) {
          if (Math.abs(dy) >= DRAG_SLOP_PX) g.mode = 'scroll';
          return;
        }
        // Claim it from the first move, or iOS starts its own overscroll.
        e.preventDefault();
        if (dy < DRAG_SLOP_PX) return;
        g.mode = 'sheet';
        draggingRef.current = true;
        sheetRef.current?.setAttribute('data-dragging', 'true');
      }
      e.preventDefault();
      const { tops: tp } = latest.current;
      applyTop(Math.min(Math.max(g.top0 + dy, tp.full), tp.min));
      g.samples.push({ t: e.timeStamp, y: t.clientY });
      if (g.samples.length > 6) g.samples.shift();
    };

    const onEnd = (e: TouchEvent) => {
      if (g?.mode === 'sheet') {
        blockClickUntil = e.timeStamp + 400;
        settle(g.samples, e.type === 'touchcancel');
      }
      g = null;
    };

    const onClickCapture = (e: MouseEvent) => {
      if (e.timeStamp > blockClickUntil) return;
      e.preventDefault();
      e.stopPropagation();
    };

    panel.addEventListener('touchstart', onStart, { passive: true });
    panel.addEventListener('touchmove', onMove, { passive: false });
    panel.addEventListener('touchend', onEnd);
    panel.addEventListener('touchcancel', onEnd);
    panel.addEventListener('click', onClickCapture, true);
    return () => {
      panel.removeEventListener('click', onClickCapture, true);
      panel.removeEventListener('touchstart', onStart);
      panel.removeEventListener('touchmove', onMove);
      panel.removeEventListener('touchend', onEnd);
      panel.removeEventListener('touchcancel', onEnd);
    };
  }, [tab, applyTop, settle]);

  // The move/up listeners go on window while a press is down, so a quick mouse
  // drag that leaves the 68px header is still followed.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    stopDragRef.current?.();
    suppressClick.current = false;
    const header = e.currentTarget;
    const d: Drag = { id: e.pointerId, y0: e.clientY, top0: topRef.current, moved: false, samples: [{ t: e.timeStamp, y: e.clientY }] };

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== d.id) return;
      // A mouse released outside the window never reports pointerup.
      if (ev.pointerType === 'mouse' && ev.buttons === 0) return end(ev, true);
      const dy = ev.clientY - d.y0;
      if (!d.moved) {
        if (Math.abs(dy) < DRAG_SLOP_PX) return;
        d.moved = true;
        draggingRef.current = true;
        // Captured only once it is a drag: capturing on press would retarget the
        // click of a plain tap on a tab.
        header.setPointerCapture(ev.pointerId);
        sheetRef.current?.setAttribute('data-dragging', 'true');
      }
      const { tops: t } = latest.current;
      applyTop(Math.min(Math.max(d.top0 + dy, t.full), t.min));
      d.samples.push({ t: ev.timeStamp, y: ev.clientY });
      if (d.samples.length > 6) d.samples.shift();
    };

    const end = (ev: PointerEvent, cancelled = ev.type === 'pointercancel') => {
      if (ev.pointerId !== d.id) return;
      stop();
      if (!d.moved) return;
      // The release can still click the button it ended on; that isn't a tap.
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 100);
      settle(d.samples, cancelled);
    };

    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      stopDragRef.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    stopDragRef.current = stop;
  };

  const selectTab = (id: RoomTab) => {
    if (suppressClick.current) return;
    onTab(id);
    if (snap === 'min') onSnap('peek');
  };

  const onHandleClick = () => {
    if (suppressClick.current) return;
    onSnap(snap === 'peek' ? 'full' : 'peek');
  };

  const onHandleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const at = SNAPS.indexOf(snap);
    onSnap(SNAPS[Math.min(Math.max(at + (e.key === 'ArrowUp' ? 1 : -1), 0), SNAPS.length - 1)]);
  };

  // A phone keyboard would bury a field in a half-height sheet: go to full.
  const onFieldFocus = (e: React.FocusEvent) => {
    if (snap === 'full') return;
    const el = e.target as HTMLElement;
    if (!el.matches('textarea, input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit])')) return;
    if (window.matchMedia('(min-width: 1024px)').matches) return;
    onSnap('full');
  };

  return (
    <div ref={stageRef} data-room-stage="" className="relative flex flex-1 min-h-0 flex-col">
      <div
        ref={safeProbeRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute h-[env(safe-area-inset-bottom)] w-0"
      />
      {header && (
        <div className="shrink-0 max-h-[calc(100%-4.25rem)] overflow-y-auto overscroll-contain pb-2 lg:px-5">
          <div className="mx-auto max-w-[1080px]">{header}</div>
        </div>
      )}
      <div className="relative flex-1 min-h-0">{children}</div>

      <section
        ref={sheetRef}
        data-room-sheet=""
        data-snap={snap}
        data-dragging="false"
        data-ready={ready ? 'true' : 'false'}
        aria-label="Draft tools"
        className={[
          'absolute inset-x-0 bottom-0 top-[var(--sheet-top,55%)] z-20 lg:mx-auto lg:max-w-[1080px]',
          'flex flex-col overflow-hidden rounded-t-card-lg bg-surface shadow-hero',
          'motion-safe:data-[ready=true]:data-[dragging=false]:transition-[top] motion-safe:data-[ready=true]:data-[dragging=false]:duration-300 motion-safe:data-[ready=true]:data-[dragging=false]:ease-out',
        ].join(' ')}
      >
        <div
          className="relative shrink-0 touch-none select-none bg-surface"
          onPointerDown={onPointerDown}
        >
          <button
            type="button"
            aria-expanded={snap === 'full'}
            aria-label={snap === 'full' ? 'Collapse draft tools' : 'Expand draft tools'}
            onClick={onHandleClick}
            onKeyDown={onHandleKeyDown}
            className="flex h-6 w-full cursor-grab items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
          >
            <span aria-hidden="true" className="h-1 w-9 rounded-full bg-ink/20" />
          </button>
          {status && snap === 'full' && (
            <span className="pointer-events-none absolute right-3 top-0 flex h-6 items-center lg:right-5">{status}</span>
          )}
          <RoomTabs active={tab} onSelect={selectTab} panelId={PANEL_ID} />
        </div>

        <div
          key={tab}
          ref={panelRef}
          id={PANEL_ID}
          role="tabpanel"
          aria-labelledby={roomTabId(tab)}
          onFocusCapture={onFieldFocus}
          className={[
            'flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))] lg:px-5',
            // At min nothing in the panel is on screen, so it also leaves the
            // tab order. The transition holds it visible until the slide ends.
            'motion-safe:transition-[visibility] motion-safe:duration-300',
            snap === 'min' ? 'invisible' : '',
          ].join(' ')}
        >
          {renderPanel(tab, snap === 'min')}
        </div>
      </section>
    </div>
  );
}

/** The pick clock in the handle row, for while the full sheet covers the clock strip. */
export function SheetClock({ label, value, urgent = false }: { label: string; value: string; urgent?: boolean }) {
  return (
    <span aria-hidden="true" className="inline-flex items-center gap-1.5 font-tight">
      <span className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-muted">{label}</span>
      <span
        className={['text-[13px] font-extrabold leading-none text-ink tabular', urgent ? 'motion-safe:animate-cue-pulse' : ''].join(' ')}
      >
        {value}
      </span>
    </span>
  );
}
