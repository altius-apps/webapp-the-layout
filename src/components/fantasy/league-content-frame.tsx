'use client';

// The league layout's content column. The live draft room is a fixed
// full-screen surface, so on that segment the column drops its padding and width
// cap; every other tab (and draft/setup) keeps the standard 1080px, with room
// at the bottom on phones for the chat dock's bar (LeagueChatDock). The element
// stays a div either way so the page below isn't remounted when navigating in
// and out of the room.

import { useSelectedLayoutSegments } from 'next/navigation';

export function LeagueContentFrame({ children }: { children: React.ReactNode }) {
  const inRoom = useSelectedLayoutSegments().join('/') === 'draft';
  return (
    <div className={inRoom ? undefined : 'px-5 pt-6 pb-20 lg:pt-8 lg:pb-14 lg:mx-auto lg:px-14 lg:max-w-[1080px]'}>
      {children}
    </div>
  );
}
