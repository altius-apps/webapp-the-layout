'use client';

// /euf/events grid — reads ?season= via useSearchParams so the Server
// Component parent (page.tsx) never touches searchParams, keeping the route
// ISR-cacheable (App Health Rule 3). The page header (eyebrow/title/season
// select) lives in PageShell itself; this component is just the season-
// filtered event grid below it.

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { EufEventCard } from '@/lib/euf/data';
import { eufDateRange } from '@/lib/euf/format-date';
import { resolveEufSeason, EUF_ALL_SEASONS } from '@/components/euf/euf-season-select';

const KIND_LABEL: Record<string, string> = {
  eucf: 'European Championship Finals',
  e2cf: 'Second-Tier Finals',
  elite_invite: 'Elite Invite',
  spring_tour: 'Spring Tour',
  summer_tour: 'Summer Tour',
  regional: 'Regional',
  other: 'Event',
};

/** Newest year first, and within "All seasons" mode, newest event first
 *  within each year — listEvents() is already ordered year DESC so insertion
 *  order carries; only the within-year date sort needs doing here. */
function groupByYear(events: EufEventCard[]): Array<[number, EufEventCard[]]> {
  const byYear = new Map<number, EufEventCard[]>();
  for (const e of events) {
    if (!byYear.has(e.year)) byYear.set(e.year, []);
    byYear.get(e.year)!.push(e);
  }
  for (const list of byYear.values()) {
    list.sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''));
  }
  return [...byYear.entries()];
}

export function EufEventsBody({ events, years }: { events: EufEventCard[]; years: number[] }) {
  const searchParams = useSearchParams();
  const season = resolveEufSeason(searchParams, years);

  if (events.length === 0) {
    return (
      <div className="rounded-card-lg bg-surface shadow-card p-10 text-center">
        <p className="text-muted font-tight text-[14px]">No EUCS events available yet.</p>
      </div>
    );
  }

  if (season === EUF_ALL_SEASONS) {
    return (
      <div className="flex flex-col gap-8">
        {groupByYear(events).map(([year, list]) => (
          <section key={year}>
            <h2 className="text-[11px] font-bold tracking-[0.18em] uppercase text-ink font-tight pb-2 mb-3 border-b border-hairline">
              {year}
              <span className="ml-2 text-muted">
                {list.length} {list.length === 1 ? 'event' : 'events'}
              </span>
            </h2>
            <EventGrid events={list} />
          </section>
        ))}
      </div>
    );
  }

  // Single season: that year's events, newest start_date first.
  const yearEvents = events
    .filter((e) => e.year === season)
    .sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''));

  if (yearEvents.length === 0) {
    return (
      <div className="rounded-card-lg bg-surface shadow-card p-10 text-center">
        <p className="text-muted font-tight text-[14px]">No EUCS events in the {season} season.</p>
      </div>
    );
  }

  return <EventGrid events={yearEvents} />;
}

function EventGrid({ events }: { events: EufEventCard[] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {events.map((e) => (
        <EventCard key={e.id} event={e} />
      ))}
    </div>
  );
}

function TrophyIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 4h12v3a6 6 0 0 1-12 0V4Z M6 5H3v2a3 3 0 0 0 3 3 M18 5h3v2a3 3 0 0 1-3 3 M9 14.5h6 M10 18h4 M9 18h6v2H9z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EventCard({ event: e }: { event: EufEventCard }) {
  return (
    <Link
      href={`/euf/events/${e.slug}`}
      prefetch={false}
      className={[
        'group flex flex-col gap-3 bg-surface rounded-card shadow-card p-4',
        'transition-shadow hover:shadow-lift cursor-pointer no-underline',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      ].join(' ')}
    >
      <div className="min-w-0">
        <div className="text-[10px] font-bold tracking-[0.16em] uppercase text-accent font-tight">
          {KIND_LABEL[e.kind] ?? 'Event'}
        </div>
        <div className="text-[15px] font-semibold text-ink font-tight truncate">{e.name}</div>
        {/* Dates lead — the fastest way to tell two same-named tour stops apart. */}
        <div className="text-[12px] text-muted font-tight truncate">
          {[eufDateRange(e.startDate, e.endDate) || null, e.location].filter(Boolean).join(' · ') ||
            '—'}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-muted font-tight">
          {e.teamCount} {e.teamCount === 1 ? 'team' : 'teams'}
        </span>
        {e.divisions.map((d) => (
          <span
            key={d}
            className="text-[9px] font-bold tracking-[0.1em] uppercase text-muted font-tight px-1.5 py-0.5 rounded-full border border-hairline"
          >
            {d}
          </span>
        ))}
      </div>
      {/* Per-division champions — only events derive_euf_placements has run
          for (a bracket exists and finished) carry any rows here. */}
      {e.champions.length > 0 && (
        <div className="flex flex-col gap-1 pt-2 border-t border-hairline">
          {e.champions.map((c) => (
            <div key={c.division} className="flex items-center gap-1.5 min-w-0">
              <span className="text-accent flex-shrink-0">
                <TrophyIcon />
              </span>
              <span className="text-[12.5px] font-tight font-semibold text-ink truncate">
                {c.teamName}
              </span>
              <span className="text-[9px] font-bold tracking-[0.1em] uppercase text-faint flex-shrink-0">
                {c.division}
              </span>
            </div>
          ))}
        </div>
      )}
    </Link>
  );
}
