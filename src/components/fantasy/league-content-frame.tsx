'use client';

// The league layout's content column. The live draft room gets a wider column
// on desktop so a 12-team board fits without 80px cells; every other tab (and
// draft/setup) keeps the standard 1080px.

import { useSelectedLayoutSegments } from 'next/navigation';

export function LeagueContentFrame({ children }: { children: React.ReactNode }) {
  const wide = useSelectedLayoutSegments().join('/') === 'draft';
  return (
    <div
      className={[
        'px-5 pt-6 pb-12 lg:pt-8 lg:pb-14 lg:mx-auto lg:px-14',
        wide ? 'lg:max-w-[1440px]' : 'lg:max-w-[1080px]',
      ].join(' ')}
    >
      {children}
    </div>
  );
}
