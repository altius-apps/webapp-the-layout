// /wfdf/events — WFDF "Worlds" event browser (the league's landing page).
//
// WFDF is event-centric: each World Championship (WMUCC, WJUC, WBUC, WWUC…) is
// a distinct tournament. This grid is the entry point — pick an event to see
// its divisions, standings, and games. Mirrors the USAU events grid shape.

import Link from 'next/link';
import type { Metadata } from 'next';
import { PageShell } from '@/components/page-shell';
import { listEvents } from '@/lib/wfdf/data';
import { WfdfEventLogo } from '@/components/wfdf/wfdf-event-logo';

export const revalidate = 300;

export const metadata: Metadata = {
  title: 'WFDF Worlds · The Layout',
  description: 'World Flying Disc Federation championships — results, standings, and rosters.',
};

const KIND_LABEL: Record<string, string> = {
  club: 'Club Worlds',
  national: 'National Teams',
  masters: 'Masters',
  beach: 'Beach',
  junior: 'Junior',
  u24: 'U24',
  other: 'Championship',
};

export default async function WfdfEventsPage() {
  const events = await listEvents().catch(() => []);
  // Preload hints for the above-fold logo batch so the browser fetches them
  // alongside the HTML instead of discovering them after hydration/paint.
  const preloadLogos = events.slice(0, 9).map((e) => e.logoUrl).filter((u): u is string => !!u);

  return (
    <>
      {preloadLogos.map((url) => (
        <link key={url} rel="preload" as="image" href={url} />
      ))}
      <PageShell
      title="WFDF Worlds"
      eyebrow="WFDF · World Championships"
      subtitle="World Flying Disc Federation events — pick a championship for standings, games, and rosters."
      breadcrumbs={[
        { label: 'Home', href: '/' },
        { label: 'WFDF' },
      ]}
    >
      {events.length === 0 ? (
        <div className="rounded-card-lg bg-surface shadow-card p-10 text-center">
          <p className="text-muted font-tight text-[14px]">No WFDF events available yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {events.map((e) => (
            <Link
              key={e.id}
              href={`/wfdf/events/${e.slug}`}
              prefetch={false}
              className={[
                'group flex flex-col gap-3 bg-surface rounded-card shadow-card p-4',
                'transition-shadow hover:shadow-lift cursor-pointer no-underline',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              ].join(' ')}
            >
              <div className="flex items-start gap-3">
                <WfdfEventLogo logoUrl={e.logoUrl} year={e.year} />
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-bold tracking-[0.16em] uppercase text-accent font-tight">
                    {KIND_LABEL[e.kind] ?? 'Championship'}
                  </div>
                  <div className="text-[15px] font-bold text-ink font-tight tracking-[-0.02em] leading-tight mt-0.5 truncate">
                    {e.name}
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between text-[11px] font-tight text-muted mt-auto pt-2.5 border-t border-hairline">
                <span className="truncate">{e.location ?? '—'}</span>
                <span className="tabular flex-shrink-0 ml-2 text-faint">
                  {e.teamCount} {e.teamCount === 1 ? 'team' : 'teams'}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
      </PageShell>
    </>
  );
}
