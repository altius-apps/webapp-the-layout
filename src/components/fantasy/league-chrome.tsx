'use client';

// The league layout's header + section nav. The live draft room is a
// full-screen surface that covers them, so they're left out of the page there
// instead of sitting invisible behind it in the tab order. draft/setup is a
// normal page and keeps them.

import { useSelectedLayoutSegments } from 'next/navigation';

export function LeagueChrome({ children }: { children: React.ReactNode }) {
  const inRoom = useSelectedLayoutSegments().join('/') === 'draft';
  return inRoom ? null : <>{children}</>;
}
