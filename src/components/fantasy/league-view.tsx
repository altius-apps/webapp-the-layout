'use client';

// LeagueView — the "League" tab body (root tab for points/event contests;
// 4th tab for h2h weekly contests). Top → bottom: draft card (until the
// draft is done), standings (h2h or points), invite code (until the draft is
// done), trades, playoffs mini-section, schedule strip (weekly only), join
// CTA, then the draft card once the draft is done. Web port of the
// mobile app's LeagueView.tsx
// (altiusapps/mobileapp-thelayout · src/components/fantasy/LeagueView.tsx).
//
// Client component: standings/periods/matchups are user-agnostic public
// reads but change frequently (live scoring) and the page needs a `use
// client` boundary anyway for DraftCard/LeagueMembersPanel
// — fetching here keeps one loading story instead of mixing server + client
// data sources for the same section.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  getContestPeriods,
  getContestStandings,
  getH2HStandings,
  getMatchups,
  periodsToWeeks,
  waiverSettings,
  type ContestView,
  type FantasyLeagueSummary,
  type Matchup,
  type H2HStandingRow,
} from '@/lib/fantasy/leagues';
import type { LeaderboardRow } from '@/lib/fantasy/data';
import { contestFormat } from '@/lib/fantasy/competitions';
import { formatWeekLabel } from '@/lib/fantasy/weeks';
import type { FantasyWeek } from '@/lib/fantasy/weeks';
import { DraftCard, useDraftCardData } from '@/components/fantasy/draft-card';
import { TradesCard } from '@/components/fantasy/trades/trades-card';
import { WaiversCard } from '@/components/fantasy/waivers-card';
import { H2HStandings } from '@/components/fantasy/h2h-standings';
import { PlayoffBracket } from '@/components/fantasy/playoff-bracket';
import { InviteCodeRow } from '@/components/fantasy/invite-code-row';
import { LeagueMembersPanel } from '@/components/fantasy/league-members-panel';
import { NoDraftCard } from '@/components/fantasy/no-draft-card';
import { OfficialStandings } from '@/components/fantasy/official-standings';
import { FantasyRulesModal } from '@/components/fantasy/fantasy-rules-modal';

function periodLockLabel(w: FantasyWeek): string {
  if (w.complete) return 'Final';
  if (w.locked) return 'Locked';
  if (!w.lockAt) return 'Open';
  const d = new Date(w.lockAt);
  if (Number.isNaN(d.getTime())) return 'Open';
  const s = d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
  return `Locks ${s}`;
}

export function LeagueView({ contest, league }: { contest: ContestView; league: FantasyLeagueSummary | null }) {
  const isOfficial = league?.isOfficial ?? false;
  const isH2H = contestFormat(contest.settings) === 'h2h';
  const isWeekly = contest.settings.mode === 'weekly-stats';
  const isFaab = waiverSettings(contest.settings).mode === 'faab';
  // After the draft its card (the way back to the board) drops to the very
  // bottom and the invite card goes away (Hunter, 2026-10-13).
  const draftCard = useDraftCardData(contest, contest.leagueId);
  const draftDone = draftCard.shown?.draft?.status === 'complete';

  const [weeks, setWeeks] = useState<FantasyWeek[]>([]);
  const [pointsStandings, setPointsStandings] = useState<LeaderboardRow[]>([]);
  const [h2hStandings, setH2hStandings] = useState<H2HStandingRow[]>([]);
  const [matchups, setMatchups] = useState<Matchup[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getContestPeriods(contest.id).catch(() => []),
      isH2H ? getH2HStandings(contest.id).catch(() => []) : Promise.resolve([]),
      !isH2H && !isOfficial ? getContestStandings(contest.id).catch(() => []) : Promise.resolve([]),
      getMatchups(contest.id).catch(() => []),
    ]).then(([periods, h2h, points, m]) => {
      if (cancelled) return;
      setWeeks(isWeekly ? periodsToWeeks(periods) : []);
      setH2hStandings(h2h);
      setPointsStandings(points);
      setMatchups(m);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [contest.id, isH2H, isWeekly, isOfficial]);

  const hasSchedule = isWeekly && weeks.length > 0;
  const playoffMatchups = matchups.filter((m) => m.stage !== 'regular');
  const hasPlayoffs = playoffMatchups.length > 0;

  return (
    <div className="space-y-8">
      {/* ── Draft card (until the draft is done) ── */}
      {isOfficial ? (
        <NoDraftCard contest={contest} />
      ) : (
        !draftDone && <DraftCard contest={contest} data={draftCard} />
      )}

      {/* ── Standings ──────────────────────────────────────────────────── */}
      <section aria-labelledby="standings-heading">
        <div className="flex items-center justify-between mb-4">
          <h2
            id="standings-heading"
            className="m-0 font-display italic text-[26px] lg:text-[30px] font-bold tracking-[-0.02em] leading-[0.95] text-ink"
          >
            Standings
          </h2>
          <FantasyRulesModal
            label="How scoring works"
            variant="icon"
            mode={contest.settings.mode}
            playerLeague={contest.competitionDef.playerLeague}
            competition={contest.competition}
          />
        </div>

        {loading ? (
          <div className="bg-surface rounded-card-lg shadow-card p-8 text-center">
            <div className="inline-block w-5 h-5 rounded-full border-2 border-ink/15 border-t-accent animate-spin" aria-hidden="true" />
          </div>
        ) : isH2H ? (
          <H2HStandings contestId={contest.id} rows={h2hStandings} />
        ) : isOfficial ? (
          <OfficialStandings contestId={contest.id} />
        ) : pointsStandings.length === 0 ? (
          <div className="bg-surface rounded-card-lg shadow-card p-8 text-center">
            <p className="text-muted font-tight text-[14px]">No teams yet — be the first to build one.</p>
          </div>
        ) : (
          <div className="bg-surface rounded-card-lg shadow-card overflow-hidden">
            <div className="hidden sm:grid grid-cols-[2.5rem_1fr_auto] items-center px-5 py-3">
              <span className="text-[10px] font-bold tracking-[0.16em] uppercase text-faint font-tight">#</span>
              <span className="text-[10px] font-bold tracking-[0.16em] uppercase text-faint font-tight">Team</span>
              <span className="text-[10px] font-bold tracking-[0.16em] uppercase text-faint font-tight text-right">
                Pts
              </span>
            </div>
            <ol aria-label="Contest standings">
              {pointsStandings.map((row, idx) => {
                const rank = idx + 1;
                const isTop3 = rank <= 3;
                return (
                  <li key={row.teamId}>
                    <Link
                      href={`/fantasy/l/${contest.id}/t/${row.teamId}`}
                      className={[
                        'grid grid-cols-[2.5rem_1fr_auto] items-center px-5 py-3.5',
                        'no-underline transition-colors duration-150',
                        'hover:bg-surface-hi',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
                        'border-t border-hairline sm:first:border-t-0',
                      ].join(' ')}
                    >
                      <span
                        className={[
                          'font-tight text-[13px] font-bold tabular',
                          isTop3 ? 'text-accent' : 'text-faint',
                        ].join(' ')}
                        aria-label={`Rank ${rank}`}
                      >
                        {rank}
                      </span>
                      <span className="min-w-0 flex flex-col gap-0.5">
                        <span className="font-tight text-[14px] font-semibold text-ink truncate">
                          {row.teamName}
                        </span>
                        {(row.ownerDisplayName || row.ownerUsername) &&
                          (row.ownerDisplayName ?? row.ownerUsername) !== row.teamName && (
                          <span className="font-tight text-[11px] text-muted truncate">
                            {row.ownerDisplayName ?? row.ownerUsername}
                          </span>
                        )}
                      </span>
                      <span className="font-tight text-[15px] font-bold tabular text-right text-ink">
                        {row.totalPoints}
                        <span className="text-[11px] font-medium text-faint ml-1">pts</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </section>

      {/* ── Invite: under the standings, where the league's members are
          (moved out of the header, Hunter 2026-10-14). Commissioner-only. ── */}
      {!draftDone && !isOfficial && <InviteCodeRow leagueId={contest.leagueId} />}

      {/* ── Trades ─────────────────────────────── */}
      <TradesCard contest={contest} />

      {/* ── Waivers (private FAAB weekly leagues only) ────────────────── */}
      {isWeekly && isFaab && <WaiversCard contest={contest} />}

      {/* ── Playoffs ───────────────────────────────────────────────────── */}
      {hasPlayoffs && (
        <section>
          <h2 className="text-[11px] font-bold tracking-[0.16em] uppercase text-muted font-tight mb-3">
            Playoffs
          </h2>
          <PlayoffBracket matchups={playoffMatchups} standings={h2hStandings} />
        </section>
      )}

      {/* ── Schedule strip ─────────────────────────────────────────────── */}
      {hasSchedule && (
        <section>
          <h2 className="text-[11px] font-bold tracking-[0.16em] uppercase text-muted font-tight mb-3">
            Schedule
          </h2>
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
            {weeks.map((w) => (
              <div
                key={w.week}
                className="flex-shrink-0 bg-surface rounded-card-sm shadow-soft px-4 py-2.5 min-w-[130px]"
              >
                <div className="font-tight text-[12px] font-bold text-ink">{formatWeekLabel(w.week)}</div>
                <div className="font-tight text-[10.5px] text-faint mt-0.5">{periodLockLabel(w)}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Join CTA ───────────────────── */}
      <LeagueMembersPanel
        leagueId={contest.leagueId}
        isPublic={league?.isPublic}
        memberCount={isOfficial ? league?.memberCount : undefined}
      />

      {/* ── Draft card (after the draft: results link, last) ── */}
      {draftDone && !isOfficial && <DraftCard contest={contest} data={draftCard} />}
    </div>
  );
}

export default LeagueView;
