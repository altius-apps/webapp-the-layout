// /wfdf/events/[slug] — a single WFDF Worlds event.
// Server-fetches the event (divisions, teams, games) and hands it to the
// client WfdfEventDetail, which tabs by division and shows standings + games.

import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { PageShell } from '@/components/page-shell';
import { getEvent, type WfdfEventDetail as WfdfEventDetailType } from '@/lib/wfdf/data';
import { WfdfEventDetail } from '@/components/wfdf/wfdf-event-detail';
import { WfdfEventLogo } from '@/components/wfdf/wfdf-event-logo';
import { WfdfSourceLink } from '@/components/wfdf/wfdf-source-link';
import { EventFavoriteStar } from '@/components/favorites/event-favorite-star';
import { wfdfEventUrl } from '@/lib/wfdf/source-links';

export const revalidate = 120;

// SSG mode with on-demand paths — see /players/[id]. Without this export the
// revalidate above never engages and every hit is request-rendered.
export function generateStaticParams(): { slug: string }[] {
  return [];
}

interface Props {
  params: { slug: string };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const ev = await getEvent(params.slug).catch(() => null);
  if (!ev) return { title: 'Event not found · The Layout' };
  return { title: `${ev.name} · WFDF · The Layout` };
}

// "Aug 15–22, 2026" within a month, "Jun 28 – Jul 5, 2026" across one.
function fmtDates(start: string | null, end: string | null): string | undefined {
  if (!start) return undefined;
  const s = new Date(start + 'T00:00:00Z');
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  const startStr = s.toLocaleDateString('en-US', opts);
  if (!end || end === start) return `${startStr}, ${s.getUTCFullYear()}`;
  const e = new Date(end + 'T00:00:00Z');
  if (e.getUTCFullYear() !== s.getUTCFullYear()) {
    return `${startStr}, ${s.getUTCFullYear()} – ${e.toLocaleDateString('en-US', opts)}, ${e.getUTCFullYear()}`;
  }
  if (e.getUTCMonth() === s.getUTCMonth()) return `${startStr}–${e.getUTCDate()}, ${e.getUTCFullYear()}`;
  return `${startStr} – ${e.toLocaleDateString('en-US', opts)}, ${e.getUTCFullYear()}`;
}

export default async function WfdfEventPage({ params }: Props) {
  const ev = await getEvent(params.slug);
  if (!ev) notFound();

  const metaLine = [fmtDates(ev.startDate, ev.endDate), ev.location].filter(Boolean).join(' · ');

  return (
    <>
      {/* Preload the header mark so it lands with the HTML instead of after
          hydration (same hint the events grid uses for its logo batch). */}
      {ev.logoUrl && <link rel="preload" as="image" href={ev.logoUrl} />}
      <PageShell
      title={ev.name}
      eyebrow={`WFDF · ${ev.isNationalTeams ? 'National Teams' : 'Club'}`}
      // One header row, same on the app (Hunter, 2026-10-27): logo, name, star
      // and WFDF link inline; dates · venue on one muted line under the name.
      // Phones get the compact row (back chevron, no eyebrow); desktop keeps
      // the eyebrow and full-size title.
      titleLeft={<WfdfEventLogo logoUrl={ev.logoUrl} year={ev.year} variant="hero" />}
      metaLine={metaLine || undefined}
      compactHeaderMobile
      controls={
        <div className="flex items-center gap-1">
          <EventFavoriteStar
            event={{
              league: 'wfdf',
              eventId: ev.id,
              name: ev.name,
              startDate: ev.startDate,
              endDate: ev.endDate,
            }}
          />
          <WfdfSourceLink
            href={wfdfEventUrl({ sourceOrigin: ev.sourceOrigin, staticBase: ev.staticBase })}
            label="WFDF site"
          />
        </div>
      }
      breadcrumbs={[
        { label: 'Home', href: '/' },
        { label: 'WFDF', href: '/wfdf/events' },
        { label: ev.name },
      ]}
    >
      {/* Suspense is load-bearing: the detail reads useSearchParams (?div/?tab
          view state), which otherwise bails the whole static render to CSR. */}
      <Suspense fallback={null}>
        <WfdfEventDetail event={ev} />
      </Suspense>
      </PageShell>
    </>
  );
}
