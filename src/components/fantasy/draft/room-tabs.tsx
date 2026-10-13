'use client';

// Tab strip for the draft room's bottom sheet: Players / Queue / Team / Chat in
// both the snake and the auction room. Same look as the app's section tabs
// (SectionNav / LeagueSectionNav): quiet labels, the active one in ink over a
// short accent bar. Arrow keys move between tabs, as a tablist should.

import { useRef } from 'react';

export type RoomTab = 'players' | 'queue' | 'team' | 'chat';

export const ROOM_TABS: readonly { id: RoomTab; label: string }[] = [
  { id: 'players', label: 'Players' },
  { id: 'queue', label: 'Queue' },
  { id: 'team', label: 'Team' },
  { id: 'chat', label: 'Chat' },
];

export const roomTabId = (id: RoomTab) => `room-tab-${id}`;

export function RoomTabs({
  active,
  onSelect,
  panelId,
}: {
  active: RoomTab;
  onSelect: (id: RoomTab) => void;
  /** The one tabpanel these tabs switch the content of. */
  panelId: string;
}) {
  const buttons = useRef<Partial<Record<RoomTab, HTMLButtonElement | null>>>({});

  const onKeyDown = (e: React.KeyboardEvent) => {
    const at = ROOM_TABS.findIndex((t) => t.id === active);
    const last = ROOM_TABS.length - 1;
    const to =
      e.key === 'ArrowRight' ? (at === last ? 0 : at + 1)
      : e.key === 'ArrowLeft' ? (at === 0 ? last : at - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : -1;
    if (to < 0) return;
    e.preventDefault();
    const next = ROOM_TABS[to].id;
    onSelect(next);
    buttons.current[next]?.focus();
  };

  return (
    <div role="tablist" aria-label="Draft room sections" onKeyDown={onKeyDown} className="flex h-11 items-stretch px-2 lg:px-4">
      {ROOM_TABS.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            ref={(el) => {
              buttons.current[t.id] = el;
            }}
            id={roomTabId(t.id)}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={panelId}
            tabIndex={on ? 0 : -1}
            onClick={() => onSelect(t.id)}
            className={[
              'group flex-1 min-w-0 inline-flex items-center justify-center cursor-pointer',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent rounded-card-sm',
            ].join(' ')}
          >
            <span className="inline-flex flex-col items-center">
              <span
                className={[
                  'font-tight text-[11.5px] font-bold tracking-[0.12em] uppercase transition-colors duration-150',
                  on ? 'text-ink' : 'text-muted group-hover:text-ink',
                ].join(' ')}
              >
                {t.label}
              </span>
              <span
                aria-hidden="true"
                className={['mt-1.5 h-[2px] w-full rounded-full', on ? 'bg-accent' : 'bg-transparent'].join(' ')}
              />
            </span>
          </button>
        );
      })}
    </div>
  );
}
