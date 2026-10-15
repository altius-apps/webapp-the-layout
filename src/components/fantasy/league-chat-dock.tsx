'use client';

// LeagueChatDock — Sleeper-style league chat docked above the bottom nav on
// every league screen (Hunter, 2026-10-14, a trial: "if it doesn't feel right I
// might make it a tab"). Collapsed it's a bar showing the newest message or
// activity; tap it or swipe it up and the chat fills the screen (phones) or
// opens as a panel bottom-right (desktop). Swipe the header down, the chevron
// or Escape closes it. Oldest → newest with the composer at the bottom, unlike
// the feed page (/feed keeps its newest-first layout and hides the dock).
//
// Load (app health rule 1 — this mounts on every league page view): collapsed
// it reads only the newest entry, and only non-official leagues listen to
// realtime (an official league can have thousands of viewers); the full feed
// loads on first open, and an official league listens only while open.
//
// Positioned with top/bottom CSS values, never a transform: AuthModal and
// ConfirmDialog render `fixed inset-0` from inside it, and a transformed
// ancestor would clip them (see room-sheet.tsx). Open on a phone it tracks
// window.visualViewport so the composer stays above the keyboard.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePathname, useSelectedLayoutSegments } from 'next/navigation';
import { activityText } from '@/lib/fantasy/feed';
import type { ContestView } from '@/lib/fantasy/leagues';
import { useTextEntryFocused } from '@/lib/use-text-entry-focused';
import { BlurredText } from '@/components/fantasy/blurred-text';
import {
  useLeagueFeed,
  FeedComposer,
  FeedDialogs,
  FeedEntryRow,
  JoinToChat,
  type FeedEntry,
  type LeagueFeedState,
} from '@/components/fantasy/league-feed';

// FloatingTabBar's tab row is h-[58px] plus its 1px top border; the dock sits
// on top of it. BAR_H is the collapsed bar (handle + title + preview); the
// collapsed `top` class below is calc(100% - NAV_H - BAR_H - safe area).
const NAV_H = 59;
const BAR_H = 72;
const DRAG_SLOP_PX = 6;
const FLICK_PX_PER_MS = 0.5;
const SEEN_KEY = 'the-layout.league-chat-seen';

function readSeen(leagueId: string): string | null {
  try {
    return localStorage.getItem(`${SEEN_KEY}:${leagueId}`);
  } catch {
    return null; // storage unavailable — no unread dot
  }
}

function writeSeen(leagueId: string, at: string): void {
  try {
    localStorage.setItem(`${SEEN_KEY}:${leagueId}`, at);
  } catch {
    // storage unavailable — nothing to remember
  }
}

export function LeagueChatDock({ contest, isOfficial }: { contest: ContestView; isOfficial: boolean }) {
  const segments = useSelectedLayoutSegments().join('/');
  // The draft room has its own Chat tab; /feed is this same chat as a page.
  if (segments === 'draft' || segments === 'feed') return null;
  return <Dock contest={contest} isOfficial={isOfficial} />;
}

function Dock({ contest, isOfficial }: { contest: ContestView; isOfficial: boolean }) {
  const pathname = usePathname();
  const typing = useTextEntryFocused();
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState<null | 'from-bar' | 'from-open'>(null);
  // The full feed loads on the first open (or pull) and stays loaded.
  const [warm, setWarm] = useState(false);

  const feed = useLeagueFeed(contest.leagueId, isOfficial, {
    full: warm,
    live: open || !isOfficial,
  });
  const newest = feed.entries[0] ?? null;

  const sheetRef = useRef<HTMLElement | null>(null);
  const safeProbeRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const suppressClick = useRef(false);
  const stopDragRef = useRef<(() => void) | null>(null);

  const expand = useCallback(() => {
    setWarm(true);
    setOpen(true);
  }, []);

  useEffect(() => setOpen(false), [pathname]);
  useLayoutEffect(() => () => stopDragRef.current?.(), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Open: cover exactly the visible viewport, so the keyboard never hides the composer.
  useEffect(() => {
    const el = sheetRef.current;
    const vv = window.visualViewport;
    if (!open || !el || !vv) return;
    const sync = () => {
      el.style.setProperty('--vv-top', `${vv.offsetTop}px`);
      el.style.setProperty('--vv-bottom', `${Math.max(window.innerHeight - vv.offsetTop - vv.height, 0)}px`);
    };
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
    };
  }, [open]);

  // Newest at the bottom: land there on open, and follow new entries while
  // the reader is already near the bottom.
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!open || !list) {
      wasOpen.current = open;
      return;
    }
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    if (!wasOpen.current || nearBottom) list.scrollTop = list.scrollHeight;
    wasOpen.current = true;
  }, [open, feed.entries.length]);

  // ── Unread dot: anything newer than what this browser last saw open ──────
  const [seenAt, setSeenAt] = useState<string | null | undefined>(undefined);
  useEffect(() => setSeenAt(readSeen(contest.leagueId)), [contest.leagueId]);
  useEffect(() => {
    if (!newest || seenAt === undefined) return;
    // Open, or a first visit (nothing stored): the newest counts as seen.
    if (open || seenAt === null) {
      if (seenAt !== newest.at) {
        writeSeen(contest.leagueId, newest.at);
        setSeenAt(newest.at);
      }
    }
  }, [open, newest, seenAt, contest.leagueId]);
  const newestIsMine = newest?.type === 'message' && newest.item.userId === feed.user?.id;
  const unread = !open && !!newest && !!seenAt && newest.at > seenAt && !newestIsMine;

  // ── Drag the header: up from the bar opens, down from open closes ────────
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') return; // desktop: tap/click only
    if (window.matchMedia('(min-width: 1024px)').matches) return;
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return;
    stopDragRef.current?.();
    suppressClick.current = false;
    const header = e.currentTarget;
    const sheet = sheetRef.current;
    if (!sheet) return;
    const fromOpen = open;
    const top0 = sheet.getBoundingClientRect().top;
    const safe = safeProbeRef.current?.offsetHeight ?? 0;
    const barTop = window.innerHeight - NAV_H - BAR_H - safe;
    const minTop = window.visualViewport?.offsetTop ?? 0;
    const d = { id: e.pointerId, y0: e.clientY, moved: false, samples: [{ t: e.timeStamp, y: e.clientY }] };

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== d.id) return;
      const dy = ev.clientY - d.y0;
      if (!d.moved) {
        if (Math.abs(dy) < DRAG_SLOP_PX) return;
        d.moved = true;
        header.setPointerCapture(ev.pointerId);
        sheet.style.setProperty('--chat-top', `${top0}px`);
        setWarm(true);
        setDragging(fromOpen ? 'from-open' : 'from-bar');
      }
      sheet.style.setProperty('--chat-top', `${Math.min(Math.max(top0 + dy, minTop), barTop)}px`);
      d.samples.push({ t: ev.timeStamp, y: ev.clientY });
      if (d.samples.length > 6) d.samples.shift();
    };

    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== d.id) return;
      stop();
      if (!d.moved) return;
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 100);
      const last = d.samples[d.samples.length - 1];
      const from = d.samples.find((m) => m.t >= last.t - 100) ?? last;
      const v = ev.type === 'pointercancel' || last.t === from.t ? 0 : (last.y - from.y) / (last.t - from.t);
      const top = parseFloat(sheet.style.getPropertyValue('--chat-top')) || top0;
      // A flick decides; otherwise whichever end it's closer to.
      const toOpen = Math.abs(v) >= FLICK_PX_PER_MS ? v < 0 : top < (minTop + barTop) / 2;
      setDragging(null);
      setOpen(toOpen);
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

  const onHeaderClick = () => {
    if (suppressClick.current || open) return;
    expand();
  };

  // Typing somewhere else on the page: the bottom nav steps aside for the
  // keyboard, and so does the collapsed bar.
  if (typing && !open && !dragging) return null;

  const showBody = open || dragging !== null;

  const position = dragging
    ? [
        'top-[var(--chat-top)]',
        dragging === 'from-bar' ? 'bottom-[calc(env(safe-area-inset-bottom)+59px)]' : 'bottom-[var(--vv-bottom,0px)]',
        'z-[60] rounded-t-card-lg',
      ]
    : open
      ? [
          'top-[var(--vv-top,0px)] bottom-[var(--vv-bottom,0px)]',
          'lg:top-auto lg:bottom-0 lg:h-[min(70vh,640px)] lg:left-auto lg:right-6 lg:w-[400px]',
          'z-[60] lg:rounded-t-card-lg',
        ]
      : [
          'top-[calc(100%-131px-env(safe-area-inset-bottom))] bottom-[calc(env(safe-area-inset-bottom)+59px)]',
          'lg:top-auto lg:bottom-0 lg:h-[72px] lg:left-auto lg:right-6 lg:w-[380px]',
          'z-30 rounded-t-card-lg',
        ];

  return (
    <>
      <div ref={safeProbeRef} aria-hidden="true" className="fixed bottom-0 left-0 w-0 h-[env(safe-area-inset-bottom)] invisible pointer-events-none" />
      <section
        ref={sheetRef}
        aria-label="League chat"
        className={[
          'fixed inset-x-0 flex flex-col overflow-hidden overscroll-contain bg-surface shadow-lift border-t border-hairline',
          dragging ? '' : 'motion-safe:transition-[top,bottom] motion-safe:duration-200 motion-safe:ease-out',
          ...position,
        ].join(' ')}
      >
        {/* Header: the drag handle. Collapsed it's the whole tap target. */}
        <div
          onPointerDown={onPointerDown}
          onClick={onHeaderClick}
          role={open ? undefined : 'button'}
          tabIndex={open ? undefined : 0}
          aria-expanded={open ? undefined : false}
          onKeyDown={(e) => {
            if (!open && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              expand();
            }
          }}
          className={[
            'flex-shrink-0 touch-none select-none px-5 pt-2 pb-2.5',
            open ? '' : 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
          ].join(' ')}
        >
          <div aria-hidden="true" className="mx-auto mb-1.5 w-9 h-1 rounded-full bg-ink/15" />
          <div className="flex items-center gap-2">
            <ChatGlyph />
            <span className="font-tight text-[15px] font-bold text-ink">Chat</span>
            {unread && <span aria-label="New messages" className="w-2 h-2 rounded-full bg-live" />}
            <span className="flex-1" />
            {open ? (
              <button
                type="button"
                data-no-drag
                onClick={() => setOpen(false)}
                aria-label="Close chat"
                className="-mr-2 w-9 h-9 flex items-center justify-center rounded-full text-muted hover:text-ink hover:bg-ink/5 transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Chevron down />
              </button>
            ) : (
              <span className="text-faint">
                <Chevron />
              </span>
            )}
          </div>
          {!open && <Preview newest={newest} feed={feed} />}
        </div>

        {showBody && (
          <>
            <ol
              ref={listRef}
              aria-label="Chat messages"
              className="flex-1 min-h-0 overflow-y-auto overscroll-contain bg-bg px-4 py-3 flex flex-col gap-1.5"
            >
              {feed.entries.length === 0 ? (
                <li className="m-auto font-tight text-[14px] text-muted">
                  {feed.loading ? 'Loading…' : 'No activity yet — say hi to your league.'}
                </li>
              ) : (
                [...feed.entries].reverse().map((entry) => (
                  <li key={`${entry.type}:${entry.item.id}`}>
                    <FeedEntryRow entry={entry} feed={feed} contestId={contest.id} />
                  </li>
                ))
              )}
            </ol>
            <div className="flex-shrink-0 border-t border-hairline px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]">
              {feed.isMember ? <FeedComposer feed={feed} inputClassName="bg-bg" /> : <JoinToChat feed={feed} />}
            </div>
          </>
        )}

        {open && <FeedDialogs feed={feed} />}
      </section>
    </>
  );
}

function Preview({ newest, feed }: { newest: FeedEntry | null; feed: LeagueFeedState }) {
  let body: React.ReactNode;
  if (!newest) {
    body = feed.loading ? ' ' : feed.isMember ? 'Say hi to your league' : 'League activity and chat';
  } else if (newest.type === 'activity') {
    body = <BlurredText text={activityText(newest.item)} />;
  } else {
    const mine = newest.item.userId === feed.user?.id;
    const name = mine ? 'You' : (feed.nameByUserId.get(newest.item.userId) ?? 'Member');
    body = (
      <>
        <span className="font-semibold text-ink">{name}: </span>
        <BlurredText text={newest.item.body} />
      </>
    );
  }
  return <p className="m-0 mt-0.5 font-tight text-[12.5px] text-muted truncate">{body}</p>;
}

function ChatGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="text-ink">
      <path
        d="M4 5h16a1 1 0 011 1v9a1 1 0 01-1 1H9l-4.5 4V16H4a1 1 0 01-1-1V6a1 1 0 011-1z"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Chevron({ down = false }: { down?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d={down ? 'M3 6l5 5 5-5' : 'M3 10l5-5 5 5'}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
