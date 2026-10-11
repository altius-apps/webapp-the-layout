// /euf/clubs/[name]?div= — one EUCS club-division across every event it entered.
//
// Routed BY NAME for the same reason the player route is: EUF team ids are
// PER-EVENT, so the name is the only stable key for a club. Division rides in a
// query param because clubs like Grut field Open, Women's AND Mixed squads —
// different rosters that share a name, so they get separate pages. This is the
// identity layer over /euf/teams/[id], which stays the single-event view.
//
// Structure mirrors /usau/teams/[id]: identity card with EUF flag + season/
// event stats, a "European Championships" medal shelf (EUCF finishes), then a
// season-picker history (tournaments + merged roster) via EufClubHistory.

import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { PageShell } from '@/components/page-shell';
import {
  getClubProfile,
  getClubCrossLeague,
  getClubSeasonRosters,
  EUF_DIVISIONS,
  type EufClubAppearance,
} from '@/lib/euf/data';
import { EufFlag } from '@/components/euf/euf-flag';
import { EufClubHistory, type EufClubSeason } from '@/components/euf/euf-club-history';
import { TeamMedals, type TeamMedal } from '@/components/team-medals';

export const revalidate = 300;

interface Props {
  params: { name: string };
  searchParams: { div?: string; season?: string };
}

/** Resolve ?div= against the known division list; defaults to Open. */
function divisionOf(raw: string | undefined): string {
  const match = EUF_DIVISIONS.find((d) => d.toLowerCase() === (raw ?? '').trim().toLowerCase());
  return match ?? 'Open';
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const name = decodeURIComponent(params.name);
  return { title: `${name} · ${divisionOf(searchParams.div)} · EUCS · The Layout` };
}

export default async function EufClubPage({ params, searchParams }: Props) {
  const name = decodeURIComponent(params.name);
  const division = divisionOf(searchParams.div);
  const club = await getClubProfile(name, division);
  if (!club) notFound();

  // ?season= deep link (player profiles pass the stint's year). Bad values
  // fall through to the newest season inside EufClubHistory.
  const seasonParam = Number.parseInt(searchParams.season ?? '', 10);
  const initialSeason = Number.isFinite(seasonParam) ? seasonParam : null;

  const { totals, appearances } = club;

  // Group appearances by season (year), oldest event first within each season
  // so getClubSeasonRosters's "most recent spelling wins" merge lands on the
  // right one. `appearances` itself is newest-event-first (RPC order).
  const byYear = new Map<number, EufClubAppearance[]>();
  for (const a of appearances) {
    if (!byYear.has(a.year)) byYear.set(a.year, []);
    byYear.get(a.year)!.push(a);
  }
  const years = [...byYear.keys()].sort((a, b) => b - a);

  // Cross-league and the season rosters are independent of each other — both
  // only need `club`, which we already have. Awaiting them separately cost a
  // full extra round-trip on a page that already waits on getClubProfile.
  const [cross, seasons] = await Promise.all([
    getClubCrossLeague(club.name, club.division).catch(() => []),
    Promise.all(
      years.map(async (year): Promise<EufClubSeason> => {
        const yearAppearances = [...byYear.get(year)!].sort((a, b) => a.eventName.localeCompare(b.eventName));
        const oldestFirst = [...yearAppearances].reverse();
        const roster = await getClubSeasonRosters(oldestFirst.map((a) => a.teamId)).catch(() => []);
        return { year, appearances: yearAppearances, roster };
      }),
    ),
  ]);

  // European Championships (EUCF) medals — the continent's top tier. Other
  // kinds (e2cf, tour stops, invites) don't carry the same prestige, so only
  // EUCF finishes get the trophy shelf, keyed on `kind` not name parsing.
  const medals: TeamMedal[] = appearances
    .filter((a) => a.kind === 'eucf' && a.finalPlacement != null && a.finalPlacement <= 3)
    .map((a) => ({ year: a.year, place: a.finalPlacement as 1 | 2 | 3 }));

  const seasonsCount = years.length;

  return (
    <PageShell
      title={club.name}
      eyebrow={`EUCS · ${club.division}`}
      subtitle={[
        club.countryName,
        `${totals.events} ${totals.events === 1 ? 'event' : 'events'}`,
      ]
        .filter(Boolean)
        .join(' · ')}
      stickyName={club.name}
      breadcrumbs={[
        { label: 'Home', href: '/' },
        { label: 'EUCS', href: '/euf/events' },
        { label: 'Teams', href: '/euf/clubs' },
        { label: `${club.name} · ${club.division}` },
      ]}
    >
      <div className="flex flex-col gap-6">
        {/* Other squads under the same club name — Grut fields Open, Women's
            and Mixed, and each is a separate roster with its own page. */}
        {club.siblingDivisions.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-bold tracking-[0.14em] uppercase text-faint font-tight">
              Also fields
            </span>
            {club.siblingDivisions.map((d) => (
              <Link
                key={d}
                href={`/euf/clubs/${encodeURIComponent(club.name)}?div=${encodeURIComponent(d)}`}
                className="text-[11px] font-tight text-ink no-underline px-2 py-0.5 rounded-full border border-hairline hover:bg-ink/[0.04] transition-colors"
              >
                {d}
              </Link>
            ))}
          </div>
        )}

        {/* Team-profile card — EufFlag anchors it (EUCS has no logo assets),
            stats sit opposite, matching the USAU team-page card exactly. */}
        <div className="rounded-card-lg shadow-card bg-surface overflow-hidden">
          <div className="flex items-center gap-4 p-4 lg:p-5">
            <span className="flex-shrink-0 flex items-center justify-center w-[52px] h-[52px] rounded-full bg-ink/[0.04]">
              <EufFlag countryName={club.countryName} size={30} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-bold tracking-[0.16em] uppercase text-faint font-tight">
                Club Profile
              </div>
              <div className="text-[13px] font-bold text-ink font-tight mt-1 truncate tracking-[-0.01em]">
                {[club.division, club.countryName].filter(Boolean).join(' · ')}
              </div>
            </div>
            <div className="flex items-stretch shrink-0">
              <SummaryStat label="Seasons" value={seasonsCount} />
              <span className="w-px self-stretch bg-hairline mx-3 lg:mx-4" aria-hidden="true" />
              <SummaryStat label="Events" value={totals.events} />
            </div>
          </div>

          {/* Honors row — only when the club has EUCF podium finishes. */}
          {medals.length > 0 && (
            <div className="border-t border-hairline bg-bg px-4 py-3.5 lg:px-5">
              <TeamMedals medals={medals} heading="European Championships" showPlace />
            </div>
          )}
        </div>

        <EufClubHistory seasons={seasons} initialSeason={initialSeason} />

        {/* Appearances outside EUCS. Matched on exact name + country (WFDF) or
            U.S.-Open-only participation (USAU) — see get_euf_club_cross_league. */}
        {cross.length > 0 && (
          <section>
            <h2 className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight pb-2 border-b border-hairline">
              Also Played
            </h2>
            <ul className="list-none p-0 m-0">
              {cross.map((c) => (
                <li
                  key={`${c.league}-${c.refId}-${c.year}-${c.eventName}`}
                  className="flex items-start gap-3 py-2 border-t border-hairline first:border-t-0"
                >
                  <span className="text-[9px] font-bold tracking-[0.14em] uppercase text-faint font-tight w-10 flex-shrink-0 pt-0.5">
                    {c.league === 'usau' ? 'USAU' : 'WFDF'}
                  </span>
                  {/* Event names here are long ("2025 U.S. Open Club
                      Championships (ICC)") — wrap rather than truncate, or the
                      whole label is unreadable on a phone. */}
                  <span className="flex items-start gap-1.5 min-w-0 flex-1 text-[13px] font-tight text-ink">
                    <span className="flex-shrink-0 pt-0.5">
                      <EufFlag countryName={c.countryName} size={13} />
                    </span>
                    <Link
                      href={
                        c.league === 'usau'
                          ? `/usau/events/${c.eventSlug}`
                          : `/wfdf/events/${c.eventSlug}`
                      }
                      prefetch={false}
                      className="no-underline hover:underline text-ink"
                    >
                      {c.eventName}
                    </Link>
                  </span>
                  {c.division && (
                    <span className="text-[11px] text-muted font-tight flex-shrink-0 pt-0.5">
                      {c.division}
                    </span>
                  )}
                  <span className="text-[11px] text-muted font-tight tabular-nums flex-shrink-0 pt-0.5">
                    {c.year}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </PageShell>
  );
}

/** A single vertical stat (number over label) for the club hero panel. Mirrors
 *  the USAU team page's SummaryStat exactly. */
function SummaryStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-1">
      <span className="tabular text-[22px] font-bold font-tight leading-none tracking-[-0.03em] text-ink">
        {value}
      </span>
      <span className="text-[9px] font-bold tracking-[0.16em] uppercase text-faint font-tight mt-1">
        {label}
      </span>
    </div>
  );
}
