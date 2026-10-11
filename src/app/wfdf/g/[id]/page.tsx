// /wfdf/g/[id] — WFDF game matchup: scoreline + game-progress chart +
// point-by-point goal log + per-team box scores.
//
// Ports app/(app)/wfdf/g/[id].tsx from mobile (same data via getGameDetail).
// goals/playerStats are only populated for live-scored modern events (WUCC
// 2026) — every section below degrades gracefully to just the scoreline when
// absent, same as EUF's /euf/g/[id] page.

import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { PageShell } from '@/components/page-shell';
import {
  getGameDetail,
  type WfdfGoalRow,
  type WfdfGameStatLine,
} from '@/lib/wfdf/data';
import { wfdfGameTime } from '@/lib/wfdf/format-date';
import { WfdfFlag } from '@/components/wfdf/wfdf-flag';
import { WfdfSourceLink } from '@/components/wfdf/wfdf-source-link';
import { wfdfGameUrl } from '@/lib/wfdf/source-links';

export const revalidate = 300;

export function generateStaticParams(): { id: string }[] {
  return [];
}

interface Props {
  params: { id: string };
}

function fieldLabel(fieldName: string | null): string | null {
  const f = fieldName?.trim();
  if (!f) return null;
  return /^\d+[A-Za-z]?$/.test(f) ? `Field ${f}` : f;
}

function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const detail = await getGameDetail(params.id).catch(() => null);
  if (!detail) return { title: 'Game not found · The Layout' };
  const { game } = detail;
  const score =
    game.homeScore != null && game.awayScore != null ? ` ${game.homeScore}–${game.awayScore} ` : ' vs ';
  return {
    title: `${game.homeTeam ?? 'TBD'}${score}${game.awayTeam ?? 'TBD'} · ${detail.eventName} · The Layout`,
    description: `${game.homeTeam ?? 'TBD'} vs ${game.awayTeam ?? 'TBD'} — WFDF ${detail.eventName} box score and game log.`,
  };
}

export default async function WfdfGamePage({ params }: Props) {
  const detail = await getGameDetail(params.id);
  if (!detail) notFound();

  const { game } = detail;
  const homeStats = detail.playerStats.filter((s) => s.teamId && s.teamId === game.homeTeamId);
  const awayStats = detail.playerStats.filter((s) => s.teamId && s.teamId === game.awayTeamId);

  const isFinal = game.status === 'completed';
  const isLive = game.status === 'in_progress';
  const homeWon = isFinal && (game.homeScore ?? 0) > (game.awayScore ?? 0);
  const awayWon = isFinal && (game.awayScore ?? 0) > (game.homeScore ?? 0);

  const sotg = game.awaySotg ?? game.homeSotg;

  const lede = [
    detail.eventName,
    wfdfGameTime(game.scheduledAt),
    game.isBracket ? 'Bracket' : game.poolName,
    fieldLabel(game.fieldName),
  ]
    .filter(Boolean)
    .join(' · ');

  const goals = detail.goals;
  const hasChart = goals.length > 0 && goals.some((g) => g.timeS != null);
  const hasPointByPoint = goals.length > 0;
  const hasBoxScore = homeStats.length > 0 || awayStats.length > 0;
  const showNoDataNote = !hasPointByPoint && !hasBoxScore;

  return (
    <PageShell
      title={`${game.homeTeam ?? 'TBD'} vs ${game.awayTeam ?? 'TBD'}`}
      eyebrow={`WFDF · ${game.divisionName ?? ''}`}
      subtitle={lede}
      controls={
        <WfdfSourceLink
          href={wfdfGameUrl(
            { sourceOrigin: detail.eventSourceOrigin, staticBase: detail.eventStaticBase },
            game,
          )}
        />
      }
      breadcrumbs={[
        { label: 'Home', href: '/' },
        { label: 'WFDF', href: '/wfdf/events' },
        { label: detail.eventName, href: `/wfdf/events/${detail.eventSlug}` },
        { label: `${game.homeTeam ?? 'TBD'} vs ${game.awayTeam ?? 'TBD'}` },
      ]}
    >
      <div className="flex flex-col gap-6">
        {/* Scoreline */}
        <section className="rounded-card-lg bg-surface shadow-card p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3 text-[10px] font-bold tracking-[0.14em] uppercase text-faint font-tight mb-3">
            <span className={isLive ? 'text-live' : undefined}>
              {isFinal ? 'Final' : isLive ? 'Live' : 'Scheduled'}
            </span>
            {sotg != null && (
              <span className="tabular-nums" title="Spirit of the Game">
                SOTG {sotg}
              </span>
            )}
          </div>
          <ScoreRow
            teamId={game.homeTeamId}
            name={game.homeTeam}
            country={game.homeCountry}
            score={game.homeScore}
            won={homeWon}
          />
          <div className="h-px bg-hairline my-2" />
          <ScoreRow
            teamId={game.awayTeamId}
            name={game.awayTeam}
            country={game.awayCountry}
            score={game.awayScore}
            won={awayWon}
          />
        </section>

        {/* Game progress chart */}
        {hasChart && (
          <GameProgressChart goals={goals} homeTeam={game.homeTeam} awayTeam={game.awayTeam} />
        )}

        {/* Point by point */}
        {hasPointByPoint && (
          <section>
            <h2 className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight pb-2 border-b border-hairline">
              Point by Point
            </h2>
            <div className="rounded-card-lg bg-surface shadow-card overflow-hidden">
              {goals.map((g, i) => (
                <div key={g.num}>
                  {i > 0 && <div className="h-px bg-hairline" />}
                  <GoalRowView goal={g} />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Box scores */}
        {hasBoxScore && (
          <>
            <BoxScore title={game.homeTeam ?? 'Home'} rows={homeStats} />
            <BoxScore title={game.awayTeam ?? 'Away'} rows={awayStats} />
          </>
        )}

        {showNoDataNote && (
          <p className="text-muted font-tight text-[13px]">No point-by-point data for this game.</p>
        )}
      </div>
    </PageShell>
  );
}

function ScoreRow({
  teamId,
  name,
  country,
  score,
  won,
}: {
  teamId: string | null;
  name: string | null;
  country: string | null;
  score: number | null;
  won: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <WfdfFlag countryCode={country} size={16} />
      <span className="flex-1 min-w-0">
        {teamId ? (
          <Link
            href={`/wfdf/teams/${teamId}`}
            className={[
              'no-underline hover:underline text-[15px] font-tight truncate',
              won ? 'text-ink font-semibold' : 'text-muted',
            ].join(' ')}
          >
            {name ?? 'TBD'}
          </Link>
        ) : (
          <span className="text-[15px] font-tight text-muted truncate">{name ?? 'TBD'}</span>
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

// ── Game progress chart (inline SVG, no chart dep — mirrors mobile's step line) ──

const CHART_HEIGHT = 190;
const CHART_PAD_LEFT = 32;
const CHART_PAD_RIGHT = 8;
const CHART_PAD_TOP = 10;
const CHART_PAD_BOTTOM = 24;
const CHART_WIDTH = 640;

function buildStepPath(
  points: { t: number; score: number }[],
  xForT: (t: number) => number,
  yForScore: (s: number) => number,
): string {
  if (points.length === 0) return '';
  let d = `M ${xForT(0)} ${yForScore(0)}`;
  let prevScore = 0;
  for (const p of points) {
    d += ` L ${xForT(p.t)} ${yForScore(prevScore)}`;
    d += ` L ${xForT(p.t)} ${yForScore(p.score)}`;
    prevScore = p.score;
  }
  return d;
}

function yStepFor(maxScore: number): number {
  if (maxScore <= 10) return 2;
  return 5;
}

function GameProgressChart({
  goals,
  homeTeam,
  awayTeam,
}: {
  goals: WfdfGoalRow[];
  homeTeam: string | null;
  awayTeam: string | null;
}) {
  const plotW = CHART_WIDTH - CHART_PAD_LEFT - CHART_PAD_RIGHT;
  const plotH = CHART_HEIGHT - CHART_PAD_TOP - CHART_PAD_BOTTOM;

  const timed = goals.filter((g): g is WfdfGoalRow & { timeS: number } => g.timeS != null);
  const maxT = timed.length > 0 ? Math.max(...timed.map((g) => g.timeS)) : 0;
  const maxScore =
    timed.length > 0 ? Math.max(...timed.map((g) => Math.max(g.homeScore, g.awayScore))) : 0;

  const xForT = (t: number) => CHART_PAD_LEFT + (maxT > 0 ? (t / maxT) * plotW : 0);
  const yForScore = (s: number) =>
    CHART_PAD_TOP + plotH - (maxScore > 0 ? (s / maxScore) * plotH : 0);

  const homePoints = timed.map((g) => ({ t: g.timeS, score: g.homeScore }));
  const awayPoints = timed.map((g) => ({ t: g.timeS, score: g.awayScore }));

  const homePath = buildStepPath(homePoints, xForT, yForScore);
  const awayPath = buildStepPath(awayPoints, xForT, yForScore);

  const yStep = yStepFor(maxScore);
  const yTicks: number[] = [];
  for (let v = 0; v <= maxScore; v += yStep) yTicks.push(v);
  if (yTicks[yTicks.length - 1] !== maxScore) yTicks.push(maxScore);

  const X_TICK_COUNT = 4;
  const xTicks: number[] = [];
  for (let i = 0; i <= X_TICK_COUNT; i++) xTicks.push((maxT / X_TICK_COUNT) * i);

  const lastHome = homePoints[homePoints.length - 1];
  const lastAway = awayPoints[awayPoints.length - 1];

  return (
    <section>
      <h2 className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight pb-2 border-b border-hairline mb-3">
        Game Progress
      </h2>
      <div className="rounded-card-lg bg-surface shadow-card p-3.5">
        <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} className="w-full h-auto" preserveAspectRatio="none">
          {yTicks.map((v) => (
            <g key={`y-${v}`}>
              <line
                x1={CHART_PAD_LEFT}
                x2={CHART_WIDTH - CHART_PAD_RIGHT}
                y1={yForScore(v)}
                y2={yForScore(v)}
                className="stroke-hairline"
                strokeWidth={1}
              />
              <text
                x={CHART_PAD_LEFT - 6}
                y={yForScore(v) + 3}
                fontSize={9}
                className="fill-faint"
                textAnchor="end"
              >
                {v}
              </text>
            </g>
          ))}

          {xTicks.map((t, i) => (
            <text
              key={`x-${i}`}
              x={xForT(t)}
              y={CHART_HEIGHT - 6}
              fontSize={9}
              className="fill-faint"
              textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
            >
              {formatElapsed(t)}
            </text>
          ))}

          <path d={awayPath} className="stroke-ink" strokeWidth={2} fill="none" strokeLinejoin="round" />
          <path d={homePath} className="stroke-accent" strokeWidth={2} fill="none" strokeLinejoin="round" />

          {lastHome && (
            <circle cx={xForT(lastHome.t)} cy={yForScore(lastHome.score)} r={3} className="fill-accent" />
          )}
          {lastAway && (
            <circle cx={xForT(lastAway.t)} cy={yForScore(lastAway.score)} r={3} className="fill-ink" />
          )}
        </svg>

        <div className="flex items-center gap-4 mt-2.5 pt-2.5 border-t border-hairline">
          <span className="flex items-center gap-1.5 min-w-0 flex-shrink">
            <span className="w-2 h-2 rounded-full bg-accent flex-shrink-0" />
            <span className="text-[11px] font-tight text-muted truncate">{homeTeam ?? 'Home'}</span>
          </span>
          <span className="flex items-center gap-1.5 min-w-0 flex-shrink">
            <span className="w-2 h-2 rounded-full bg-ink flex-shrink-0" />
            <span className="text-[11px] font-tight text-muted truncate">{awayTeam ?? 'Away'}</span>
          </span>
        </div>
      </div>
    </section>
  );
}

// ── Point by point ─────────────────────────────────────────────────────────────

function GoalRowView({ goal }: { goal: WfdfGoalRow }) {
  const scorer = goal.scorerName ?? 'Unknown';
  const assistLine = goal.assistName ? `${scorer} ← ${goal.assistName}` : scorer;
  const time = goal.timeS != null ? formatElapsed(goal.timeS) : null;

  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5 min-h-[44px]">
      <span className="w-11 flex-shrink-0 text-[14px] font-tight font-bold tabular-nums text-muted">
        <span className={goal.isHomeGoal ? 'text-ink' : undefined}>{goal.homeScore}</span>
        <span className="text-faint">–</span>
        <span className={!goal.isHomeGoal ? 'text-ink' : undefined}>{goal.awayScore}</span>
      </span>
      <span className="flex-1 min-w-0 flex items-center gap-2">
        <span className="text-[13px] font-tight text-ink truncate">{assistLine}</span>
        {goal.isCallahan && (
          <span className="flex-shrink-0 px-1.5 py-0.5 rounded-sm bg-accent/10 text-[8px] font-bold tracking-[0.1em] uppercase text-accent">
            Callahan
          </span>
        )}
      </span>
      {time && (
        <span className="flex-shrink-0 text-[11px] font-tight tabular-nums text-faint">{time}</span>
      )}
    </div>
  );
}

// ── Box score ────────────────────────────────────────────────────────────────

function sortStatLines(rows: WfdfGameStatLine[]): WfdfGameStatLine[] {
  return [...rows].sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    if (b.goals !== a.goals) return b.goals - a.goals;
    return (a.fullName ?? '').localeCompare(b.fullName ?? '');
  });
}

function BoxScore({ title, rows }: { title: string; rows: WfdfGameStatLine[] }) {
  if (rows.length === 0) return null;
  const sorted = sortStatLines(rows);

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
            {sorted.map((s, i) => (
              <tr key={`${s.wfdfPlayerId}-${i}`} className="border-t border-hairline">
                <td className="py-2 pr-2 text-[13px] font-tight text-ink">
                  {s.jerseyNumber && (
                    <span className="text-muted tabular-nums mr-2">{s.jerseyNumber}</span>
                  )}
                  {s.fullName ? (
                    <Link
                      href={`/wfdf/players/by-name/${encodeURIComponent(s.fullName)}`}
                      prefetch={false}
                      className="no-underline hover:underline text-ink"
                    >
                      {s.fullName}
                    </Link>
                  ) : (
                    'Unknown'
                  )}
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
