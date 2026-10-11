// /euf/teams/[id] — one team's roster + results at a single EUCS event.
//
// EUF teams are PER-EVENT entries (the same club at EUCF 2025 and Elite Invite
// 2025 is two rows), so this page is scoped to one event by construction.

import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { PageShell } from '@/components/page-shell';
import { getTeam, getTeamRoster, listTeamGames } from '@/lib/euf/data';
import { eufGameDate } from '@/lib/euf/format-date';
import { EufFlag } from '@/components/euf/euf-flag';

export const revalidate = 300;

// SSG mode with on-demand paths — see /players/[id]. Without this export the
// revalidate above never engages and every hit is request-rendered (578
// crawlable team URLs).
export function generateStaticParams(): { id: string }[] {
  return [];
}

interface Props {
  params: { id: string };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const t = await getTeam(params.id).catch(() => null);
  if (!t) return { title: 'Team not found · The Layout' };
  return { title: `${t.name} · ${t.eventName} · The Layout` };
}

export default async function EufTeamPage({ params }: Props) {
  const team = await getTeam(params.id);
  if (!team) notFound();

  const [roster, games] = await Promise.all([
    getTeamRoster(team.id).catch(() => []),
    listTeamGames(team.id).catch(() => []),
  ]);

  return (
    <PageShell
      title={team.name}
      eyebrow={`EUCS · ${team.division}`}
      subtitle={[team.countryName, team.eventName].filter(Boolean).join(' · ')}
      breadcrumbs={[
        { label: 'Home', href: '/' },
        { label: 'EUCS', href: '/euf/events' },
        { label: 'Teams', href: '/euf/clubs' },
        {
          label: `${team.name} · ${team.division}`,
          href: `/euf/clubs/${encodeURIComponent(team.name)}?div=${encodeURIComponent(team.division)}&season=${team.eventYear}`,
        },
        { label: team.eventName },
      ]}
    >
      <div className="flex flex-col gap-6">
        {/* This page is ONE event. The club page merges every appearance of
            this club in THIS division (its other squads get their own pages). */}
        <Link
          href={`/euf/clubs/${encodeURIComponent(team.name)}?div=${encodeURIComponent(team.division)}&season=${team.eventYear}`}
          className="text-[12px] font-tight text-accent no-underline hover:underline"
        >
          View {team.name}&rsquo;s full {team.division} history →
        </Link>
        {/* Results */}
        <section>
          <h2 className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight pb-2 border-b border-hairline">
            Results
          </h2>
          {games.length === 0 ? (
            <p className="text-muted font-tight text-[13px] py-4">No games recorded.</p>
          ) : (
            <ul className="list-none p-0 m-0">
              {games.map((g) => {
                const isHome = g.homeTeamId === team.id;
                const us = isHome ? g.homeScore : g.awayScore;
                const them = isHome ? g.awayScore : g.homeScore;
                const oppName = isHome ? g.awayName : g.homeName;
                const oppCountry = isHome ? g.awayCountry : g.homeCountry;
                const oppId = isHome ? g.awayTeamId : g.homeTeamId;
                const won = (us ?? 0) > (them ?? 0);
                return (
                  <li
                    key={g.id}
                    className="flex items-center gap-3 py-2 border-t border-hairline first:border-t-0"
                  >
                    <span
                      className={[
                        'w-5 text-[11px] font-bold font-tight flex-shrink-0',
                        won ? 'text-ink' : 'text-muted',
                      ].join(' ')}
                    >
                      {won ? 'W' : 'L'}
                    </span>
                    <span className="text-[13px] font-tight tabular-nums text-ink flex-shrink-0">
                      {us ?? '–'}–{them ?? '–'}
                    </span>
                    <span className="flex items-center gap-1.5 min-w-0 flex-1 text-[13px] font-tight text-muted">
                      <EufFlag countryName={oppCountry} size={13} />
                      {oppId ? (
                        <Link
                          href={`/euf/teams/${oppId}`}
                          prefetch={false}
                          className="truncate no-underline hover:underline text-muted"
                        >
                          {oppName}
                        </Link>
                      ) : (
                        <span className="truncate">{oppName}</span>
                      )}
                    </span>
                    {/* Round + date, desktop only — the phone row is already
                        full with result/score/opponent. */}
                    {(g.roundName || g.scheduledAt) && (
                      <span className="text-[10px] text-muted font-tight flex-shrink-0 hidden sm:inline">
                        {[g.roundName, eufGameDate(g.scheduledAt)].filter(Boolean).join(' · ')}
                      </span>
                    )}
                    <Link
                      href={`/euf/g/${g.id}`}
                      prefetch={false}
                      aria-label={`Box score vs ${oppName}`}
                      className="text-[10px] font-bold tracking-[0.1em] uppercase text-muted font-tight flex-shrink-0 no-underline hover:text-accent transition-colors"
                    >
                      Box
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Roster — EUCS publishes goals/assists totals per event. */}
        <section>
          <h2 className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight pb-2 border-b border-hairline">
            Roster
          </h2>
          {roster.length === 0 ? (
            <p className="text-muted font-tight text-[13px] py-4">No roster available.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[380px] border-collapse">
                <thead>
                  <tr className="text-[10px] font-bold tracking-[0.12em] uppercase text-muted font-tight">
                    <th className="text-left py-2 pr-2 font-bold">Player</th>
                    <th className="text-right py-2 px-2 font-bold">G</th>
                    <th className="text-right py-2 px-2 font-bold">A</th>
                    <th className="text-right py-2 pl-2 font-bold">Pts</th>
                  </tr>
                </thead>
                <tbody>
                  {roster.map((p) => (
                    <tr key={p.id} className="border-t border-hairline">
                      <td className="py-2 pr-2 text-[13px] font-tight text-ink">
                        {p.jerseyNumber && (
                          <span className="text-muted tabular-nums mr-2">{p.jerseyNumber}</span>
                        )}
                        {/* EUF player ids are per-event, so the profile is keyed
                            by NAME — same routing the leaders table uses. */}
                        <Link
                          href={`/euf/players/by-name/${encodeURIComponent(p.fullName)}`}
                          prefetch={false}
                          className="no-underline hover:underline text-ink"
                        >
                          {p.fullName}
                        </Link>
                      </td>
                      <td className="text-right py-2 px-2 text-[13px] font-tight tabular-nums text-ink">
                        {p.goals ?? 0}
                      </td>
                      <td className="text-right py-2 px-2 text-[13px] font-tight tabular-nums text-muted">
                        {p.assists ?? 0}
                      </td>
                      <td className="text-right py-2 pl-2 text-[13px] font-tight tabular-nums text-ink font-semibold">
                        {p.total ?? 0}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </PageShell>
  );
}
