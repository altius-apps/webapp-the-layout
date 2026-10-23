// /usau/events/[slug] — single event page.
//
// Shows two views of the event's games:
//   - Pools section: teams grouped by pool, sorted by seed within pool.
//   - Bracket section: games grouped by round + bracket name.
//
// Both lists ultimately surface the same data we ingested from USAU's
// schedule page. We don't have W-L records aggregated yet — that's a
// future enhancement (compute from usau_games rows).

import { cache, Suspense } from 'react';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { PageShell } from '@/components/page-shell';
import { SourceLink } from '@/components/source-link';
import {
  getNationalsField,
  getTournamentEditions,
  isNationalsChampionshipName,
  loadUsauEvent,
  resolveUsauEvent,
  seriesStageName,
  type UsauEventSummary,
} from '@/lib/usau/data';
import type { NationalsFieldState } from '@/components/usau/nationals-field';
import { usauEventHref } from '@/lib/usau/event-href';
import { usauToday } from '@/lib/today';
import { UsauMemberSourceLink } from '@/components/usau/usau-member-source-link';
import { EventVenue, UsauEventVenue } from '@/components/usau/usau-event-venue';
import { UsauSeriesFavoriteStar } from '@/components/usau/usau-series-favorite-star';
import { findWorldsTwinSlug } from '@/lib/wfdf/data';
import { UsauEventDetail } from '@/components/usau/usau-event-detail';
import { UsauEditionSelect } from '@/components/usau/usau-edition-select';
import { EventFavoriteStar } from '@/components/favorites/event-favorite-star';
import { FLIGHT_LABELS } from '@/lib/usau/flights';
import { USAU_LEVELS, buildLeagueQs, seriesListHref, type UsauLevel, type UsauSeriesStage } from '@/lib/league';

export const revalidate = 60;

// SSG mode with on-demand paths — see /players/[id]. Without this export the
// revalidate above never engages and every hit is request-rendered (3,742
// crawlable event URLs, the largest event surface).
export function generateStaticParams(): { slug: string }[] {
  return [];
}

interface Props {
  params: { slug: string };
}

// generateMetadata and the page share one resolve + one load per request
// (React cache), so a merged series event costs 3 PostgREST calls per render.
const resolveEventCached = cache(resolveUsauEvent);
const loadEventCached = cache(async (slug: string) => {
  const resolved = await resolveEventCached(slug);
  return resolved ? loadUsauEvent(resolved) : null;
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const resolved = await resolveEventCached(params.slug).catch(() => null);
  if (!resolved) return { title: 'Event not found · The Layout' };
  const row = resolved.kind === 'group' ? resolved.rows[0] : resolved.row;
  const name = resolved.kind === 'event' ? row.name : row.series_group_name ?? row.name;
  const canonical = resolved.kind === 'event' ? row.usau_slug : (row.series_group_key as string);
  return {
    title: `${name} · USAU · The Layout`,
    // One URL per tournament: collapses ?div= variants, mixed-case slugs, and
    // the per-division member URLs that redirect here.
    alternates: { canonical: `/usau/events/${canonical}` },
  };
}

export default async function UsauEventPage({ params }: Props) {
  const resolved = await resolveEventCached(params.slug);
  if (!resolved) notFound();

  // One division's row of a series event (USAU publishes Sectionals/Regionals
  // per division) → the merged event, preselecting that division. Decided from
  // the member row itself, never from searchParams, so the route stays ISR.
  // 307 for now: switch to permanentRedirect once the group keys have held for
  // a season (a browser caches a 308 forever).
  if (resolved.kind === 'member') {
    redirect(usauEventHref(resolved.row.series_group_key as string, resolved.row.series_division));
  }

  const event = await loadEventCached(params.slug);
  if (!event) notFound();

  // WFDF-hosted events (WUCC/WJUC/WMUCC) leak into usau_events as stubs that
  // never grow games — the real data comes from the WFDF pipeline. When we've
  // ingested the WFDF twin, every USAU-side link lands there instead.
  const worldsTwin = await findWorldsTwinSlug(event.name, Number(event.season));
  if (worldsTwin) redirect(`/wfdf/events/${worldsTwin}`);

  // Club Nationals before USA Ultimate posts its teams has nothing to show, so
  // the projected field (Regionals qualifiers by region) stands in as a FIELD
  // tab. The cheap name check gates the read — no other event ever runs it —
  // and the season is the loaded event row's own, never a route param.
  const isClubNationals = event.competitionLevel === 'CLUB' && isNationalsChampionshipName(event.name);
  const noTeamsPosted = event.teams.length === 0;
  // Drop `&& noTeamsPosted` to keep the FIELD tab once pools are published.
  const fieldEligible = isClubNationals && noTeamsPosted;
  const nationalsField: NationalsFieldState | null = fieldEligible ? await loadNationalsField(event.season) : null;

  // Other years of the same tournament (Club Nationals, US Open, TCT flights…)
  // for the header's year picker. Untracked events return [] without a read.
  // A failed read just hides the picker.
  const editions = await getTournamentEditions(event.name).catch((err) => {
    console.error('[usau/events] getTournamentEditions failed', err);
    return [];
  });

  const subtitle = formatSubtitle(event);
  const eyebrowParts = [
    event.competitionLevel,
    event.season,
    event.flight ? FLIGHT_LABELS[event.flight] : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // "The Games" back-link carries the event's competition level so you land on
  // the games tab filtered to the SAME level (e.g. a Masters event → Masters
  // games), not always Club. Only for real UsauLevel values — HS/BEACH/OTHER
  // aren't level-filter options, so they fall back to the plain games tab.
  const eventLevel = USAU_LEVELS.includes(event.competitionLevel as UsauLevel)
    ? (event.competitionLevel as UsauLevel)
    : null;
  const gamesHref = `/scores${buildLeagueQs('usau', null, eventLevel)}`;
  // The venue the default division shows (UsauEventVenue's rule): a merged
  // series event uses its first member's, any other event its own.
  const mergedSeries = event.members.length > 0 && event.members.every((m) => m.division != null);
  const fallbackVenue = mergedSeries ? (event.members[0]?.venue ?? null) : event.venue;
  // A series tournament backs out to its stage's list (the "2026 USAU
  // Sectionals" page it's opened from): Scores once it's underway, Schedule
  // before. Without this crumb a fresh load backed out to The Games.
  const series = event.series;
  const seriesCrumb = series
    ? {
        label: seriesStageName(series.stage as UsauSeriesStage, series.level as UsauLevel, series.season),
        href: seriesListHref(event.startDate != null && event.startDate <= usauToday() ? 'scores' : 'schedule', {
          stage: series.stage as UsauSeriesStage,
          level: series.level as UsauLevel,
          season: series.season,
        }),
      }
    : null;

  return (
    <PageShell
      title={event.name}
      eyebrow={`USAU${eyebrowParts ? ` · ${eyebrowParts}` : ''}`}
      subtitle={subtitle ?? undefined}
      // Source link sits beside the title in the header's controls slot, same
      // as the WFDF event page — a quiet accent link, not a pill on its own row
      // (Hunter, 2026-08-22).
      controls={
        (
          <div className="flex flex-wrap items-center gap-x-1 gap-y-2">
            {/* Desktop shows the year picker in the view-tab row instead
                (UsauEventDetail, Hunter 2026-10-22). */}
            {editions.length > 0 && (
              <div className="lg:hidden">
                <UsauEditionSelect season={event.season} editions={editions} />
              </div>
            )}
            {event.members.length > 0 ? (
              // A merged event links the USAU page of the division being viewed.
              <Suspense
                fallback={
                  <SourceLink
                    href={event.members.find((m) => m.url)?.url ?? null}
                    label="USAU site"
                    ariaLabel={`View ${event.name} on USA Ultimate`}
                  />
                }
              >
                <UsauMemberSourceLink members={event.members} eventName={event.name} />
              </Suspense>
            ) : (
              event.url && (
                <SourceLink
                  href={event.url}
                  label="USAU site"
                  ariaLabel={`View ${event.name} on USA Ultimate`}
                />
              )
            )}
            {event.members.length > 0 ? (
                // Merged event: the star is stored on the division being viewed
                // (pushes follow that division, as before the merge) and shows
                // filled when any division is starred.
                <Suspense
                  fallback={
                    <EventFavoriteStar
                      event={{ league: 'usau', eventId: event.id, name: event.name, startDate: event.startDate, endDate: event.endDate }}
                      memberIds={event.members.map((m) => m.id)}
                    />
                  }
                >
                  <UsauSeriesFavoriteStar
                    event={{ league: 'usau', eventId: event.id, name: event.name, startDate: event.startDate, endDate: event.endDate }}
                    members={event.members}
                  />
                </Suspense>
              ) : (
                <EventFavoriteStar
                  event={{
                    league: 'usau',
                    eventId: event.id,
                    name: event.name,
                    startDate: event.startDate,
                    endDate: event.endDate,
                  }}
                />
              )}
            {/* Venue shares this row (Hunter, 2026-10-07). Fallback = what the
                default division shows, so the first paint doesn't jump. */}
            <Suspense fallback={fallbackVenue ? <EventVenue venue={fallbackVenue} /> : null}>
              <UsauEventVenue
                venue={event.venue}
                members={event.members.map((m) => ({ division: m.division, venue: m.venue }))}
              />
            </Suspense>
          </div>
        )
      }
      breadcrumbs={[
        { label: 'Home', href: '/' },
        { label: 'The Games', href: gamesHref },
        ...(seriesCrumb ? [seriesCrumb] : []),
        { label: event.name },
      ]}
    >
      {/* The "View on USAU" link renders inside UsauEventDetail, sharing a
          row with the Level/Division selects (right-aligned) so mobile gets
          one compact header row instead of stacked controls. */}
      {/* Suspense is load-bearing: UsauEventDetail reads useSearchParams()
          (useDivision/useLevel), which throws missing-suspense-with-csr-bailout
          during the static render this route opted into — every event page
          500'd (FUNCTION_INVOCATION_FAILED) until this boundary. Same pattern
          as page-shell.tsx and usau-team-history.tsx. */}
      <Suspense>
        <UsauEventDetail event={event} nationalsField={nationalsField} editions={editions} />
      </Suspense>
    </PageShell>
  );
}

/** The FIELD tab's data. A failed read renders the tab's generic error copy
 *  (the spec's error state) instead of failing the whole event page; the real
 *  error is logged. Null = no field this season → no tab. */
async function loadNationalsField(season: number): Promise<NationalsFieldState | null> {
  try {
    const field = await getNationalsField(season);
    return field ? { status: 'ready', field } : null;
  } catch (err) {
    console.error('[usau/events] getNationalsField failed', err);
    return { status: 'error' };
  }
}

function formatSubtitle(event: UsauEventSummary): string | null {
  const parts: string[] = [];
  if (event.startDate) {
    const start = new Date(event.startDate + 'T00:00:00');
    const sl = start.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    if (event.endDate && event.endDate !== event.startDate) {
      const end = new Date(event.endDate + 'T00:00:00');
      const el = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      parts.push(`${sl} – ${el}`);
    } else {
      parts.push(sl);
    }
  }
  const place = [event.city, event.state].filter(Boolean).join(', ');
  if (place) parts.push(place);
  return parts.length > 0 ? parts.join(' · ') : null;
}
