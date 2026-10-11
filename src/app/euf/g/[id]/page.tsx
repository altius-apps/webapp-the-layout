// /euf/g/[id] — EUCS game detail: final score + per-team box score.
//
// Plain [id] (not PUL's catch-all [...id]): EUF game ids are UUIDs with no
// slashes. 1,491 of 1,632 games have box-score rows in euf_game_player_stats;
// the rest render the scoreline with a "no box score" note rather than 404ing,
// since the game itself is real data.

import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { PageShell } from '@/components/page-shell';
import { getGame, getGameStats, type EufDivision, type EufGameStatLine } from '@/lib/euf/data';
import { eufGameDate, eufGameTime } from '@/lib/euf/format-date';
import { EufFlag } from '@/components/euf/euf-flag';
import { EufExternalLink } from '@/components/euf/euf-event-detail';

export const revalidate = 300;

// SSG mode with on-demand paths — see /players/[id]. Without this export the
// revalidate above never engages and every hit is request-rendered (1,632
// crawlable game URLs).
export function generateStaticParams(): { id: string }[] {
  return [];
}

interface Props {
  params: { id: string };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const g = await getGame(params.id).catch(() => null);
  if (!g) return { title: 'Game not found · The Layout' };
  const score =
    g.homeScore != null && g.awayScore != null ? ` ${g.homeScore}–${g.awayScore} ` : ' vs ';
  return {
    title: `${g.homeName}${score}${g.awayName} · ${g.eventName} · The Layout`,
    description: `${g.homeName} vs ${g.awayName} — EUCS ${g.eventName} box score and player stats.`,
  };
}

export default async function EufGamePage({ params }: Props) {
  const game = await getGame(params.id);
  if (!game) notFound();

  const stats = await getGameStats(game.id).catch(() => []);

  // Box-score rows carry team_id, so split by side. Rows with no team_id (the
  // source occasionally omits it) go under "Other" rather than being dropped.
  const homeStats = stats.filter((s) => s.teamId && s.teamId === game.homeTeamId);
  const awayStats = stats.filter((s) => s.teamId && s.teamId === game.awayTeamId);
  const orphanStats = stats.filter(
    (s) => !s.teamId || (s.teamId !== game.homeTeamId && s.teamId !== game.awayTeamId),
  );

  const homeWon = (game.homeScore ?? 0) > (game.awayScore ?? 0);

  return (
    <PageShell
      title={`${game.homeName} vs ${game.awayName}`}
      eyebrow={`EUCS · ${game.division}`}
      subtitle={[
        game.eventName,
        eufGameDate(game.scheduledAt, true) || null,
        game.roundName,
        game.field ? `Field ${game.field}` : null,
      ]
        .filter(Boolean)
        .join(' · ')}
      breadcrumbs={[
        { label: 'Home', href: '/' },
        { label: 'EUCS', href: '/euf/events' },
        { label: game.eventName, href: `/euf/events/${game.eventSlug}` },
        { label: `${game.homeName} vs ${game.awayName}` },
      ]}
    >
      <div className="flex flex-col gap-6">
        {/* "View on EUCS" — mirrors USAU's event-page link. Only 128 forfeit
            rows lack a euf_game_id and get no link. */}
        {game.eufGameId != null && game.sourceOrigin && (
          <div className="flex justify-end">
            <EufExternalLink
              url={`${game.sourceOrigin}/?view=gameplay&game=${game.eufGameId}`}
            />
          </div>
        )}

        {/* Scoreline */}
        <section className="rounded-card-lg bg-surface shadow-card p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3 text-[10px] font-bold tracking-[0.14em] uppercase text-faint font-tight mb-3">
            <span>{game.status === 'forfeit' ? 'Forfeit' : 'Final'}</span>
            {/* Prefer the full instant; start_time is a bare time-of-day and
                would read as a floating "9:05" with no day attached. */}
            {(eufGameTime(game.scheduledAt) || game.startTime) && (
              <span className="tabular-nums">
                {eufGameTime(game.scheduledAt) || game.startTime}
              </span>
            )}
          </div>
          <ScoreRow
            teamId={game.homeTeamId}
            name={game.homeName}
            division={game.division}
            country={game.homeCountry}
            score={game.homeScore}
            won={homeWon}
            season={game.eventYear}
          />
          <div className="h-px bg-hairline my-2" />
          <ScoreRow
            teamId={game.awayTeamId}
            name={game.awayName}
            division={game.division}
            country={game.awayCountry}
            score={game.awayScore}
            won={!homeWon}
            season={game.eventYear}
          />
        </section>

        {/* Box scores */}
        {stats.length === 0 ? (
          <p className="text-muted font-tight text-[13px]">
            No box score published for this game.
          </p>
        ) : (
          <>
            <BoxScore title={game.homeName} rows={homeStats} />
            <BoxScore title={game.awayName} rows={awayStats} />
            {orphanStats.length > 0 && <BoxScore title="Other" rows={orphanStats} />}
          </>
        )}
      </div>
    </PageShell>
  );
}

function ScoreRow({
  teamId,
  name,
  division,
  country,
  score,
  won,
  season,
}: {
  teamId: string | null;
  name: string;
  division: EufDivision;
  country: string | null;
  score: number | null;
  won: boolean;
  season: number;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <EufFlag countryName={country} size={16} />
      <span className="flex-1 min-w-0">
        {teamId ? (
          <Link
            href={`/euf/clubs/${encodeURIComponent(name)}?div=${encodeURIComponent(division)}&season=${season}`}
            className={[
              'no-underline hover:underline text-[15px] font-tight truncate',
              won ? 'text-ink font-semibold' : 'text-muted',
            ].join(' ')}
          >
            {name}
          </Link>
        ) : (
          <span className="text-[15px] font-tight text-muted truncate">{name}</span>
        )}
      </span>
      <span
        className={[
          'text-[20px] font-tight tabular-nums flex-shrink-0',
          won ? 'text-ink font-semibold' : 'text-muted',
        ].join(' ')}
      >
        {score ?? '–'}
      </span>
    </div>
  );
}

function BoxScore({ title, rows }: { title: string; rows: EufGameStatLine[] }) {
  if (rows.length === 0) return null;
  return (
    <section>
      <h2 className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight pb-2 border-b border-hairline">
        {title}
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[300px] border-collapse">
          <thead>
            <tr className="text-[10px] font-bold tracking-[0.12em] uppercase text-muted font-tight">
              <th className="text-left py-2 pr-2 font-bold">Player</th>
              <th className="text-right py-2 px-2 font-bold">G</th>
              <th className="text-right py-2 px-2 font-bold">A</th>
              <th className="text-right py-2 pl-2 font-bold">Pts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s, i) => (
              <tr key={`${s.fullName}-${i}`} className="border-t border-hairline">
                <td className="py-2 pr-2 text-[13px] font-tight text-ink">
                  {s.jerseyNumber && (
                    <span className="text-muted tabular-nums mr-2">{s.jerseyNumber}</span>
                  )}
                  <Link
                    href={`/euf/players/by-name/${encodeURIComponent(s.fullName)}`}
                    prefetch={false}
                    className="no-underline hover:underline text-ink"
                  >
                    {s.fullName}
                  </Link>
                </td>
                <td className="text-right py-2 px-2 text-[13px] font-tight tabular-nums text-ink">
                  {s.goals}
                </td>
                <td className="text-right py-2 px-2 text-[13px] font-tight tabular-nums text-muted">
                  {s.assists}
                </td>
                <td className="text-right py-2 pl-2 text-[13px] font-tight tabular-nums text-ink font-semibold">
                  {s.total}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
