// /wfdf/teams/[id] — a single WFDF team's page: event context, record, roster,
// and games. Roster rows link to unified player profiles (name-matched), which
// is the whole point of ingesting WFDF rosters.

import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';
import { PageShell } from '@/components/page-shell';
import { getTeam, findClubTwin } from '@/lib/wfdf/data';
import { wfdfGameTime } from '@/lib/wfdf/format-date';
import { WfdfFlag } from '@/components/wfdf/wfdf-flag';
import { WfdfSourceLink } from '@/components/wfdf/wfdf-source-link';
import { wfdfTeamUrl } from '@/lib/wfdf/source-links';

export const revalidate = 120;

// SSG mode with on-demand paths — see /players/[id]. Without this export the
// revalidate above never engages and every hit is request-rendered (1,174
// crawlable team URLs).
export function generateStaticParams(): { id: string }[] {
  return [];
}

interface Props {
  params: { id: string };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const team = await getTeam(params.id).catch(() => null);
  if (!team) return { title: 'Team not found · The Layout' };
  return { title: `${team.name} · WFDF · The Layout` };
}

export default async function WfdfTeamPage({ params }: Props) {
  const team = await getTeam(params.id);
  if (!team) notFound();

  // This page is ONE Worlds appearance. When the entry resolves to a
  // league-wide club identity (EUCS club, or a USAU club for US entries), link
  // out to the full club profile rather than dead-ending here.
  const clubTwin = await findClubTwin(team);

  const eyebrowParts = [team.divisionName, team.countryName].filter(Boolean).join(' · ');

  return (
    <PageShell
      title={team.name}
      eyebrow={`WFDF${eyebrowParts ? ` · ${eyebrowParts}` : ''}`}
      controls={
        <WfdfSourceLink
          href={wfdfTeamUrl(
            { sourceOrigin: team.eventSourceOrigin, staticBase: team.eventStaticBase },
            { wfdfTeamId: team.wfdfTeamId, name: team.name, divisionName: team.divisionName },
          )}
        />
      }
      breadcrumbs={[
        { label: 'Home', href: '/' },
        { label: 'WFDF', href: '/wfdf/events' },
        { label: team.eventName, href: `/wfdf/events/${team.eventSlug}` },
        { label: team.name },
      ]}
    >
      {clubTwin && (
        <Link
          href={
            clubTwin.kind === 'euf'
              ? `/euf/clubs/${encodeURIComponent(clubTwin.clubName)}?div=${encodeURIComponent(clubTwin.division)}`
              : `/usau/teams/${clubTwin.teamId}`
          }
          className="inline-flex items-center gap-1 mb-4 text-[12px] font-semibold font-tight text-accent no-underline hover:text-ink transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
        >
          {clubTwin.kind === 'euf'
            ? `View ${clubTwin.clubName}'s full ${clubTwin.division} club history →`
            : `View ${clubTwin.teamName}'s full USAU club profile →`}
        </Link>
      )}

      {/* Hero panel — mirrors the USAU team hero shape. */}
      <div className="mb-8 bg-surface rounded-card-lg shadow-card overflow-hidden">
        <div className="flex items-center gap-4 p-4 lg:p-5">
          <WfdfFlag flagFile={team.flagFile} countryCode={team.countryCode} size={40} />
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold tracking-[0.16em] uppercase text-accent font-tight">
              <Link href={`/wfdf/events/${team.eventSlug}`} className="hover:text-ink transition-colors">
                {team.eventName}
              </Link>
            </div>
            {eyebrowParts && (
              <div className="text-[13px] font-bold text-ink font-tight mt-1 truncate tracking-[-0.01em]">
                {eyebrowParts}
              </div>
            )}
          </div>
          <div className="flex items-stretch shrink-0">
            {team.finalStanding != null && <Stat label="Finish" value={ordinal(team.finalStanding)} />}
            {(team.wins != null || team.losses != null) && (
              <>
                <Divider />
                <Stat label="Record" value={`${team.wins ?? 0}–${team.losses ?? 0}`} />
              </>
            )}
            {team.spiritAvg != null && (
              <>
                <Divider />
                <Stat label="Spirit" value={team.spiritAvg.toFixed(1)} />
              </>
            )}
          </div>
        </div>
      </div>

      {/* Roster */}
      {team.roster.length > 0 && (
        <section aria-labelledby="wfdf-roster-heading" className="mb-8">
          <h2
            id="wfdf-roster-heading"
            className="flex items-center justify-between text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight mb-3 pb-2 border-b border-hairline"
          >
            <span>Roster</span>
            <span className="text-faint tabular">{team.roster.length}</span>
          </h2>
          <div className="overflow-x-auto bg-surface rounded-card-lg shadow-card">
            {/* No min-width: five narrow columns fit a phone viewport; a 480px
                floor forced a scroll just to reach GP. Rare over-long names
                truncate (cap on the Link) instead of widening the table. */}
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  {['#', 'Player', 'G', 'A', 'GP'].map((h, i) => (
                    <th
                      key={h}
                      className={[
                        'px-3 py-3 text-[9px] font-bold tracking-[0.16em] uppercase text-faint font-tight whitespace-nowrap',
                        i < 2 ? 'text-left' : 'text-right',
                        i === 0 ? 'pl-5' : '',
                        i === 4 ? 'pr-5' : '',
                      ].join(' ')}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {team.roster.map((p, i) => (
                  <tr key={p.wfdfPlayerId} className="hover:bg-surface-hi transition-colors duration-100">
                    <td className={`px-3 py-2.5 text-[13px] text-left tabular text-faint font-tight w-10 pl-5 ${i > 0 ? 'border-t border-hairline' : ''}`}>
                      {p.jerseyNumber ?? '—'}
                    </td>
                    {/* Roster names link to a name-resolver route. WFDF isn't
                        an anchor league (players have no standalone WFDF id), so
                        the link goes to /wfdf/players/by-name/[name], which
                        redirects to the person's unified profile if they exist
                        in an anchor league (USAU/UFA), else shows a WFDF-only
                        career view. Never a dead end. */}
                    <td className={`px-3 py-2.5 text-[13px] text-left font-medium font-tight ${i > 0 ? 'border-t border-hairline' : ''}`}>
                      <Link
                        href={`/wfdf/players/by-name/${encodeURIComponent(p.fullName)}`}
                        prefetch={false}
                        className="block max-w-[24ch] truncate text-ink hover:text-accent transition-colors duration-150 no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
                        title={p.fullName}
                      >
                        {p.fullName}
                      </Link>
                    </td>
                    <td className={`px-3 py-2.5 text-[13px] text-right tabular text-muted font-tight ${i > 0 ? 'border-t border-hairline' : ''}`}>
                      {p.goals ?? '—'}
                    </td>
                    <td className={`px-3 py-2.5 text-[13px] text-right tabular text-muted font-tight ${i > 0 ? 'border-t border-hairline' : ''}`}>
                      {p.assists ?? '—'}
                    </td>
                    <td className={`px-3 py-2.5 text-[13px] text-right tabular text-muted font-tight pr-5 ${i > 0 ? 'border-t border-hairline' : ''}`}>
                      {p.games ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Games */}
      {team.games.length > 0 && (
        <section aria-labelledby="wfdf-games-heading">
          <h2
            id="wfdf-games-heading"
            className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight mb-3 pb-2 border-b border-hairline"
          >
            Games
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {team.games.map((g) => {
              const isHome = g.homeTeamId === team.id;
              const us = isHome ? g.homeScore : g.awayScore;
              const them = isHome ? g.awayScore : g.homeScore;
              const oppName = isHome ? g.awayTeam : g.homeTeam;
              const oppId = isHome ? g.awayTeamId : g.homeTeamId;
              const done = g.status === 'completed' && us != null && them != null;
              const won = done && (us ?? 0) > (them ?? 0);
              const sotg = g.awaySotg ?? g.homeSotg;
              const timeLabel = wfdfGameTime(g.scheduledAt);
              const hasFooter = timeLabel != null || sotg != null;
              return (
                <div
                  key={g.id}
                  className="bg-surface rounded-card shadow-card px-3 py-2.5"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 flex items-center gap-2">
                      {done && (
                        <span
                          className={[
                            'text-[9px] font-bold tracking-[0.14em] uppercase font-tight flex-shrink-0',
                            won ? 'text-accent' : 'text-faint',
                          ].join(' ')}
                        >
                          {won ? 'W' : 'L'}
                        </span>
                      )}
                      <span className="text-[10px] text-faint font-tight flex-shrink-0">
                        {g.isBracket ? 'Bracket' : g.poolName ?? 'Pool'}
                      </span>
                      {oppId ? (
                        <Link
                          href={`/wfdf/teams/${oppId}`}
                          prefetch={false}
                          className="text-[13px] font-tight text-ink truncate hover:text-accent"
                        >
                          {oppName ?? 'TBD'}
                        </Link>
                      ) : (
                        <span className="text-[13px] font-tight text-ink truncate">{oppName ?? 'TBD'}</span>
                      )}
                    </span>
                    <span className="font-tight text-[14px] tabular flex-shrink-0 text-ink">
                      {done ? `${us}–${them}` : '–'}
                    </span>
                  </div>
                  {hasFooter && (
                    <div className="flex items-center justify-between gap-2 mt-1.5 pt-1.5 border-t border-hairline text-[10px] font-tight text-faint">
                      <span className="truncate">{timeLabel ?? ''}</span>
                      {sotg != null && (
                        <span className="tabular flex-shrink-0" title="Spirit of the Game">
                          SOTG {sotg}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </PageShell>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-1">
      <span className="tabular text-[20px] font-bold font-tight leading-none tracking-[-0.03em] text-ink">
        {value}
      </span>
      <span className="text-[9px] font-bold tracking-[0.16em] uppercase text-faint font-tight mt-1">
        {label}
      </span>
    </div>
  );
}

function Divider() {
  return <span className="w-px self-stretch bg-hairline mx-3 lg:mx-4" aria-hidden="true" />;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
