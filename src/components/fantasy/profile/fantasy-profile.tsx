// Fantasy Profile — a team's page inside a league (Hunter, 2026-10-09; laid
// out after a Sleeper-style team screen). Server Component: every read is
// public, so it renders signed out. The viewer-specific Trade action lives in
// the ProfileActions client island.
//
//   Header card: monogram · team name · record and ranks · this period's
//   points (and the opponent's, in H2H) · action row
//   Starters (weekly) / Roster (event) for the current period, then Bench
//   Schedule (H2H) and Transactions (weekly)
//
// There's no per-player points column: the engine stores team totals only
// (fantasy_scores), so rows show role, player and pro team.

import Link from 'next/link';
import {
  getContestPeriods,
  getContestStandings,
  getContestTeam,
  getH2HStandings,
  getMatchups,
  getTeamPlayers,
  getTeamTransactions,
  periodsToWeeks,
  type ContestView,
  type TeamTransaction,
} from '@/lib/fantasy/leagues';
import { getContestTeamRoster, type ContestRosterSlot } from '@/lib/fantasy/draft';
import { getDraftStatusServer } from '@/lib/fantasy/server';
import { contestFormat } from '@/lib/fantasy/competitions';
import { formatWeekLabel } from '@/lib/fantasy/weeks';
import { ordinal } from '@/lib/bracket-tree';
import { ProfileActions } from './profile-actions';

const SECTION_HEADING = 'font-display italic text-[22px] lg:text-[24px] font-bold tracking-[-0.02em] leading-[0.95] text-ink';

export async function FantasyProfile({ contest, teamId }: { contest: ContestView; teamId: string }) {
  const team = await getContestTeam(teamId).catch(() => null);
  if (!team || team.contestId !== contest.id) return null;

  const isEvent = contest.settings.mode === 'event';
  const isH2H = !isEvent && contestFormat(contest.settings) === 'h2h';
  const isDrafted = contest.settings.draft === true;

  const [periods, standings, h2h, matchups, draftStatus, transactions, owned] = await Promise.all([
    getContestPeriods(contest.id).catch(() => []),
    getContestStandings(contest.id).catch(() => []),
    isH2H ? getH2HStandings(contest.id).catch(() => []) : Promise.resolve([]),
    isH2H ? getMatchups(contest.id).catch(() => []) : Promise.resolve([]),
    !isEvent && isDrafted
      ? getDraftStatusServer(contest.id).catch((err) => {
          console.error('[fantasy profile] getDraftStatusServer failed', err);
          return null;
        })
      : Promise.resolve(null),
    isEvent ? Promise.resolve([] as TeamTransaction[]) : getTeamTransactions(contest.id, teamId).catch(() => []),
    isEvent ? Promise.resolve([]) : getTeamPlayers(contest.id, teamId).catch(() => []),
  ]);

  // Current period: the one being played, else the next to lock, else the last.
  const weeks = periodsToWeeks(periods);
  const nowMs = Date.now();
  const current =
    weeks.find((w) => w.locked) ??
    weeks.find((w) => w.lockAt != null && new Date(w.lockAt).getTime() > nowMs) ??
    weeks[weeks.length - 1] ??
    null;
  const period = current?.week ?? (isEvent ? 'event' : null);
  const periodLabel = isEvent ? 'Event' : formatWeekLabel(period);

  const roster: ContestRosterSlot[] = period
    ? await getContestTeamRoster(contest, teamId, period).catch(() => [])
    : [];
  const rosterKeys = new Set(roster.map((s) => `${s.playerLeague}:${s.playerId}`));
  const bench = owned.filter((p) => !rosterKeys.has(`${p.playerLeague}:${p.playerId}`));

  const teamNames = new Map(standings.map((s) => [s.teamId, s.teamName]));
  const periodPoints = period ? team.weeklyPoints.find((w) => w.week === period)?.points ?? null : null;

  // Record and ranks.
  const pointsRank = standings.findIndex((s) => s.teamId === teamId) + 1;
  const myH2H = h2h.find((r) => r.teamId === teamId) ?? null;
  const rankOf = (key: 'pointsFor' | 'pointsAgainst') =>
    [...h2h].sort((a, b) => b[key] - a[key]).findIndex((r) => r.teamId === teamId) + 1;
  const statLine =
    isH2H && myH2H
      ? [
          `${myH2H.wins}-${myH2H.losses}${myH2H.ties ? `-${myH2H.ties}` : ''}`,
          ordinal(myH2H.rank),
          `PF ${ordinal(rankOf('pointsFor'))}`,
          `PA ${ordinal(rankOf('pointsAgainst'))}`,
        ].join(' · ')
      : pointsRank > 0
        ? `${ordinal(pointsRank)} of ${standings.length} · ${team.totalPoints} pts`
        : `${team.totalPoints} pts`;

  // This period's matchup (H2H).
  const myMatchups = matchups
    .filter((m) => m.homeTeamId === teamId || m.awayTeamId === teamId)
    .sort((a, b) => a.period.localeCompare(b.period, undefined, { numeric: true }));
  const currentMatchup = period ? myMatchups.find((m) => m.period === period) ?? null : null;
  const opponentId = currentMatchup
    ? currentMatchup.homeTeamId === teamId
      ? currentMatchup.awayTeamId
      : currentMatchup.homeTeamId
    : null;
  const opponentPoints = currentMatchup
    ? currentMatchup.homeTeamId === teamId
      ? currentMatchup.awayPoints
      : currentMatchup.homePoints
    : null;

  const tradesOpen = !isEvent && isDrafted && draftStatus === 'complete';
  const owner = team.ownerUsername ? `@${team.ownerUsername}` : team.ownerDisplayName;
  const base = `/fantasy/l/${contest.id}`;

  return (
    <div className="space-y-8">
      {/* ── Header card ──────────────────────────────────────────────────── */}
      <section className="bg-surface rounded-card-lg shadow-card p-5 lg:p-6" aria-label={`${team.teamName} profile`}>
        {owner && <p className="m-0 mb-3 font-tight text-[12.5px] font-semibold text-muted truncate">{owner}</p>}
        <div className="flex items-center gap-4">
          <Monogram name={team.teamName} size={60} />
          <div className="min-w-0 flex-1">
            <h1 className="m-0 font-display italic text-[24px] lg:text-[28px] font-bold tracking-[-0.02em] leading-[0.95] text-ink truncate">
              {team.teamName}
            </h1>
            <p className="m-0 mt-1.5 font-tight text-[12.5px] font-semibold text-muted tabular">{statLine}</p>
          </div>
          {period && (
            <div className="flex-shrink-0 text-right">
              <p className="m-0 font-tight text-[22px] font-bold tabular text-ink leading-none">
                {periodPoints != null ? periodPoints.toFixed(1) : '–'}
              </p>
              <p className="m-0 mt-1 font-tight text-[10.5px] font-bold tracking-[0.12em] uppercase text-faint">
                {periodLabel}
              </p>
              {isH2H && currentMatchup && (
                <p className="m-0 mt-1 font-tight text-[11.5px] text-muted tabular max-w-[120px] truncate">
                  {opponentId
                    ? `vs ${teamNames.get(opponentId) ?? 'Team'}${opponentPoints != null ? ` ${opponentPoints.toFixed(1)}` : ''}`
                    : 'Bye'}
                </p>
              )}
            </div>
          )}
        </div>

        <ProfileActions
          contest={contest}
          teamId={teamId}
          ownerId={team.ownerId}
          ownerName={owner ?? team.teamName}
          teams={standings.map((s) => ({ teamId: s.teamId, teamName: s.teamName }))}
          tradesOpen={tradesOpen}
          showSchedule={isH2H && myMatchups.length > 0}
          showTransactions={!isEvent}
        />
      </section>

      {/* ── Starters / Roster ────────────────────────────────────────────── */}
      <section aria-labelledby="starters-heading">
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <h2 id="starters-heading" className={SECTION_HEADING}>
            {isEvent ? 'Roster' : 'Starters'}
          </h2>
          {period && !isEvent && (
            <span className="font-tight text-[11px] font-bold tracking-[0.14em] uppercase text-faint">{periodLabel}</span>
          )}
        </div>
        {roster.length === 0 ? (
          <EmptyCard text={period ? `No lineup set for ${isEvent ? 'the event' : periodLabel} yet.` : 'No lineup yet.'} />
        ) : (
          <ul className="bg-surface rounded-card-lg shadow-card overflow-hidden">
            {sortSlots(roster).map((s, idx) => (
              <PlayerRow
                key={`${s.playerLeague}:${s.playerId}`}
                chip={s.role === 'offender' ? 'OFF' : s.role === 'defender' ? 'DEF' : 'FLEX'}
                chipTone={s.role === 'defender' ? 'accent' : 'ink'}
                name={s.fullName}
                sub={s.teamName}
                href={playerHref(s.playerLeague, s.playerId)}
                first={idx === 0}
              />
            ))}
          </ul>
        )}
      </section>

      {/* ── Bench (weekly) ───────────────────────────────────────────────── */}
      {!isEvent && bench.length > 0 && (
        <section aria-labelledby="bench-heading">
          <h2 id="bench-heading" className={`${SECTION_HEADING} mb-3`}>
            Bench
          </h2>
          <ul className="bg-surface rounded-card-lg shadow-card overflow-hidden">
            {bench.map((p, idx) => (
              <PlayerRow
                key={`${p.playerLeague}:${p.playerId}`}
                chip="BN"
                chipTone="muted"
                name={p.playerName}
                sub={null}
                href={playerHref(p.playerLeague, p.playerId)}
                first={idx === 0}
              />
            ))}
          </ul>
        </section>
      )}

      {/* ── Schedule (H2H) ───────────────────────────────────────────────── */}
      {isH2H && myMatchups.length > 0 && (
        <section id="schedule" aria-labelledby="schedule-heading" className="scroll-mt-24">
          <h2 id="schedule-heading" className={`${SECTION_HEADING} mb-3`}>
            Schedule
          </h2>
          <ul className="bg-surface rounded-card-lg shadow-card overflow-hidden">
            {myMatchups.map((m, idx) => {
              const home = m.homeTeamId === teamId;
              const oppId = home ? m.awayTeamId : m.homeTeamId;
              const mine = home ? m.homePoints : m.awayPoints;
              const theirs = home ? m.awayPoints : m.homePoints;
              const result = !m.scored
                ? null
                : m.winnerTeamId == null
                  ? 'T'
                  : m.winnerTeamId === teamId
                    ? 'W'
                    : 'L';
              return (
                <li
                  key={m.id}
                  className={['flex items-center gap-3 px-5 py-3', idx > 0 ? 'border-t border-hairline' : ''].join(' ')}
                >
                  <span className="w-16 flex-shrink-0 font-tight text-[12px] font-bold text-faint">
                    {m.stage === 'regular' ? formatWeekLabel(m.period) : m.stage === 'third' ? '3rd place' : m.stage === 'final' ? 'Final' : 'Semis'}
                  </span>
                  <span className="flex-1 min-w-0 font-tight text-[14px] font-semibold text-ink truncate">
                    {oppId ? (
                      <Link href={`${base}/t/${oppId}`} className="no-underline text-ink hover:text-accent transition-colors duration-150">
                        vs {teamNames.get(oppId) ?? 'Team'}
                      </Link>
                    ) : (
                      'Bye'
                    )}
                  </span>
                  <span className="flex-shrink-0 font-tight text-[13px] tabular text-muted">
                    {result ? (
                      <>
                        <span className={result === 'W' ? 'text-accent font-bold' : result === 'L' ? 'text-live font-bold' : 'font-bold'}>
                          {result}
                        </span>{' '}
                        {(mine ?? 0).toFixed(1)}–{(theirs ?? 0).toFixed(1)}
                      </>
                    ) : (
                      'Upcoming'
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* ── Transactions (weekly) ───────────────────────────────────────── */}
      {!isEvent && (
        <section id="transactions" aria-labelledby="transactions-heading" className="scroll-mt-24">
          <h2 id="transactions-heading" className={`${SECTION_HEADING} mb-3`}>
            Transactions
          </h2>
          {transactions.length === 0 ? (
            <EmptyCard text="No adds, drops or trades yet." />
          ) : (
            <ul className="bg-surface rounded-card-lg shadow-card overflow-hidden">
              {transactions.map((t, idx) => (
                <li
                  key={t.id}
                  className={['flex items-start gap-3 px-5 py-3', idx > 0 ? 'border-t border-hairline' : ''].join(' ')}
                >
                  <span className="w-16 flex-shrink-0 pt-0.5 font-tight text-[10.5px] font-bold tracking-[0.12em] uppercase text-faint">
                    {t.kind === 'trade' ? 'Trade' : t.kind === 'waiver' ? 'Waiver' : 'Add/drop'}
                  </span>
                  <span className="flex-1 min-w-0 font-tight text-[13.5px] text-ink">
                    {t.addedName && (
                      <span className="block truncate">
                        <span className="text-accent font-bold">+</span> {t.addedName}
                      </span>
                    )}
                    {t.droppedName && (
                      <span className="block truncate text-muted">
                        <span className="text-live font-bold">−</span> {t.droppedName}
                      </span>
                    )}
                  </span>
                  <span className="flex-shrink-0 font-tight text-[11.5px] text-faint tabular">
                    {new Date(t.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

const ROLE_ORDER: Record<string, number> = { offender: 0, defender: 1, flex: 2 };

function sortSlots(slots: ContestRosterSlot[]): ContestRosterSlot[] {
  return [...slots].sort((a, b) => (ROLE_ORDER[a.role] ?? 3) - (ROLE_ORDER[b.role] ?? 3));
}

/** Players with a profile page we can link: UFA ids and USAU UUIDs. */
function playerHref(league: string, playerId: string): string | null {
  return league === 'ufa' || league === 'usau' ? `/players/${playerId}` : null;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

function Monogram({ name, size }: { name: string; size: number }) {
  return (
    <span
      aria-hidden="true"
      className={[
        'flex-shrink-0 inline-flex items-center justify-center rounded-full bg-accent/10 text-accent font-tight font-bold',
        size >= 56 ? 'w-[60px] h-[60px] text-[20px]' : 'w-10 h-10 text-[13px]',
      ].join(' ')}
    >
      {initials(name)}
    </span>
  );
}

function PlayerRow({
  chip,
  chipTone,
  name,
  sub,
  href,
  first,
}: {
  chip: string;
  chipTone: 'ink' | 'accent' | 'muted';
  name: string;
  sub: string | null;
  href: string | null;
  first: boolean;
}) {
  return (
    <li className={['flex items-center gap-3 px-4 py-3 lg:px-5', first ? '' : 'border-t border-hairline'].join(' ')}>
      <span
        className={[
          'flex-shrink-0 inline-flex items-center justify-center w-12 h-9 rounded-card-sm bg-ink/5',
          'font-tight text-[11px] font-bold tracking-[0.08em]',
          chipTone === 'accent' ? 'text-accent' : chipTone === 'muted' ? 'text-faint' : 'text-ink',
        ].join(' ')}
      >
        {chip}
      </span>
      <Monogram name={name} size={40} />
      <span className="flex-1 min-w-0">
        {href ? (
          <Link
            href={href}
            prefetch={false}
            className="block font-tight text-[15px] font-bold text-ink truncate no-underline hover:text-accent transition-colors duration-150"
          >
            {name}
          </Link>
        ) : (
          <span className="block font-tight text-[15px] font-bold text-ink truncate">{name}</span>
        )}
        {sub && <span className="block font-tight text-[12px] text-muted truncate">{sub}</span>}
      </span>
    </li>
  );
}

function EmptyCard({ text }: { text: string }) {
  return (
    <div className="bg-surface rounded-card-lg shadow-card px-5 py-8 text-center">
      <p className="m-0 font-tight text-[14px] text-muted">{text}</p>
    </div>
  );
}
