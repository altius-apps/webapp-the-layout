// /schedule — past, present, and future UFA games grouped by week.
// Server Component. Reads ?year=YYYY from searchParams.
//
// Display order: current week (expanded by default), upcoming weeks (collapsed),
// then prior weeks (collapsed). The native <details> elements keep this fully
// server-rendered — no client component needed for collapse state.

import type { Metadata } from 'next';
import { getCurrentGames, getAllGamesByYears, currentSeasonYear, UFA_FIRST_SEASON } from '@/lib/ufa/client';
import type { UfaGame } from '@/lib/ufa/types';
import { PageShell } from '@/components/page-shell';
import { GameCard } from '@/components/game-card';
import { YearSelector } from '@/components/year-selector';
import { parseLeagueParam, parseLevelParam, parseSeriesParam, levelLabel, buildLeagueQs } from '@/lib/league';
import { UsauSchedule } from '@/components/usau/usau-schedule';
import { UsauScheduleControls } from '@/components/usau/usau-schedule-controls';
import { UsauSeriesStageList } from '@/components/usau/usau-series-cards';
import { listSeriesStageEventsCached, listUsauSeasonsCached, usauScheduleCached } from '@/lib/cached-readers';
import { usauToday } from '@/lib/today';
import { parseFlightsParam, FLIGHT_LABELS } from '@/lib/usau/flights';
import { PulSchedule } from '@/components/pul/pul-schedule';
import { getPulCurrentSeason } from '@/lib/pul/data';
import { WulSchedule } from '@/components/wul/wul-schedule';

export const revalidate = 300;

// First PUL season in pul_games (checked 2026-10-11) — floor for the ?season= clamp.
const PUL_FIRST_SEASON = 2022;

export const metadata: Metadata = {
  title: 'Schedule · The Layout',
};

interface Props {
  searchParams: {
    year?: string;
    season?: string;
    league?: string;
    div?: string;
    level?: string;
    flight?: string;
    series?: string;
  };
}

export default async function SchedulePage({ searchParams }: Props) {
  const league = parseLeagueParam(searchParams.league);

  if (league === 'pul') {
    const currentSeason = await getPulCurrentSeason();
    const requestedSeason = parseInt(searchParams.season ?? '', 10);
    const season =
      requestedSeason >= PUL_FIRST_SEASON && requestedSeason <= currentSeasonYear()
        ? requestedSeason
        : currentSeason;
    return (
      <PageShell
        title="Schedule"
        eyebrow={`PUL · ${season} Season`}
      >
        <PulSchedule season={season} />
      </PageShell>
    );
  }

  // WUL's schedule is every season (upcoming fixtures + history) grouped by
  // season. Distinct from /scores (one season's finals only).
  if (league === 'wul') {
    return (
      <PageShell
        title="Schedule"
        eyebrow="WUL · Western Ultimate League · All seasons"
      >
        <WulSchedule />
      </PageShell>
    );
  }

  if (league === 'usau') {
    const level = parseLevelParam(searchParams.level);
    // Flight is OPTIONAL + MULTI: absent ?flight ⇒ all flights; ?flight=pro,elite
    // ⇒ those tiers. Flights are a CLUB-ONLY concept (Triple Crown Tour tiers),
    // so ignore any persisted ?flight off-Club — otherwise switching
    // Club→Masters carries the flight over and filters out every event (no
    // masters event has a flight), and the eyebrow shows a stray "N flights".
    // The flight control itself already only renders for Club.
    // (Division + season filters removed for mobile parity 2026-08-16 —
    // the schedule is future-facing; season browsing lives on /scores.)
    const flights = level === 'CLUB' ? parseFlightsParam(searchParams.flight) : [];
    const eyebrow = [
      'USAU',
      levelLabel(level),
      flights.length === 1 ? FLIGHT_LABELS[flights[0]] : flights.length > 1 ? `${flights.length} flights` : null,
    ].filter(Boolean).join(' · ');
    // Always the latest season's calendar (season browsing lives on /scores).
    // Read server-side against the Eastern date.
    const today = usauToday();
    const season = (await listUsauSeasonsCached())[0] ?? null;
    // ?series=sectionals|regionals → that stage's merged tournaments.
    const seriesStage = parseSeriesParam(searchParams.series, level);
    const series =
      seriesStage && season != null
        ? await listSeriesStageEventsCached(today, season, seriesStage, level)
        : null;
    const schedule =
      series || season == null
        ? { items: [], hasPrior: false }
        : await usauScheduleCached(today, season, level, flights).catch((err) => {
            console.error('Failed to load the USAU schedule:', err);
            return null;
          });
    return (
      <PageShell
        title="Schedule"
        eyebrow={eyebrow}
        controls={<UsauScheduleControls level={level} />}
      >
        {series ? (
          <UsauSeriesStageList
            data={series}
            today={today}
            backHref={`/schedule${buildLeagueQs('usau', null, level)}`}
            backLabel="Schedule"
          />
        ) : (
          <UsauSchedule schedule={schedule} competitionLevel={level} />
        )}
      </PageShell>
    );
  }

  const currentYear = currentSeasonYear();
  // Clamp to seasons that exist — an unbounded ?year= is an upstream fetch per
  // garbage URL.
  const requestedYear = parseInt(searchParams.year ?? '', 10);
  const year =
    requestedYear >= UFA_FIRST_SEASON && requestedYear <= currentYear ? requestedYear : currentYear;
  const isCurrentSeason = year === currentYear;

  // Fetch games for the selected year; overlay live data for current season.
  let games: UfaGame[] = [];
  try {
    const [seasonGames, liveGames] = await Promise.all([
      getAllGamesByYears([year]),
      isCurrentSeason ? getCurrentGames() : Promise.resolve<UfaGame[]>([]),
    ]);

    // Dedupe by gameID — live data wins for current-season games.
    const byId = new Map<string, UfaGame>();
    for (const g of seasonGames) byId.set(g.gameID, g);
    for (const g of liveGames) byId.set(g.gameID, g); // overwrite with richer live fields
    games = Array.from(byId.values());
  } catch (err) {
    console.error('Failed to fetch schedule:', err);
  }

  // Group by week, then split into current / upcoming / prior based on today.
  const weekGroups = groupByWeek(games);
  const currentWeekLabel = pickCurrentWeek(games, Date.now());
  const { current, upcoming, prior } = partitionWeeks(weekGroups, currentWeekLabel);

  return (
    <PageShell
      title="Schedule"
      eyebrow={`UFA · ${year} Season`}
      controls={<YearSelector currentYear={year} />}
    >
      {weekGroups.length === 0 ? (
        <EmptyState year={year} />
      ) : (
        <div className="flex flex-col gap-8">
          {current && <WeekSection group={current} eyebrow="This week" emphasized />}

          {upcoming.length > 0 && (
            <CollapsibleWeeks
              summary={`Upcoming weeks · ${upcoming.length}`}
              groups={upcoming}
            />
          )}

          {prior.length > 0 && (
            <CollapsibleWeeks
              summary={`Prior weeks · ${prior.length}`}
              groups={prior}
            />
          )}
        </div>
      )}
    </PageShell>
  );
}

function WeekSection({
  group,
  eyebrow,
  emphasized,
}: {
  group: WeekGroup;
  eyebrow?: string;
  emphasized?: boolean;
}) {
  const id = `week-${group.label}`;
  return (
    <section aria-labelledby={id}>
      <div
        id={id}
        className={[
          'flex items-baseline justify-between gap-3 mb-3 pb-2 border-b',
          emphasized ? 'border-ink' : 'border-hairline',
        ].join(' ')}
      >
        <span
          className={[
            'text-[10px] font-bold tracking-[0.18em] uppercase font-tight',
            emphasized ? 'text-ink' : 'text-muted',
          ].join(' ')}
        >
          {formatWeekLabel(group.label)}
        </span>
        {eyebrow && (
          <span className="text-[10px] font-bold tracking-[0.18em] uppercase text-accent font-tight">
            {eyebrow}
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 md:gap-3">
        {group.games.map((g) => (
          <GameCard key={g.gameID} game={g} />
        ))}
      </div>
    </section>
  );
}

function CollapsibleWeeks({
  summary,
  groups,
}: {
  summary: string;
  groups: WeekGroup[];
}) {
  return (
    <details className="group">
      <summary
        className={[
          'list-none cursor-pointer flex items-center justify-between gap-3',
          'py-3 px-4 rounded-card bg-surface shadow-card hover:shadow-lift transition-shadow duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        ].join(' ')}
      >
        <span className="text-[11px] font-bold tracking-[0.18em] uppercase text-ink font-tight">
          {summary}
        </span>
        <span className="inline-flex items-center gap-2 text-[10px] font-bold tracking-[0.16em] uppercase text-muted font-tight group-hover:text-ink transition-colors">
          <span className="group-open:hidden">Show</span>
          <span className="hidden group-open:inline">Hide</span>
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="transition-transform duration-150 group-open:rotate-180"
          >
            <path d="M2 4l3 3 3-3" />
          </svg>
        </span>
      </summary>
      <div className="flex flex-col gap-8 mt-5">
        {groups.map((g) => (
          <WeekSection key={g.label} group={g} />
        ))}
      </div>
    </details>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface WeekGroup {
  label: string;
  sortKey: string;
  games: UfaGame[];
}

function groupByWeek(games: UfaGame[]): WeekGroup[] {
  const map = new Map<string, UfaGame[]>();

  for (const g of games) {
    const key = g.week ?? 'unscheduled';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(g);
  }

  // Sort each week's games by startTimestamp ascending.
  const groups: WeekGroup[] = [];
  for (const [label, weekGames] of map) {
    weekGames.sort((a, b) => {
      const ta = a.startTimestamp ? new Date(a.startTimestamp).getTime() : Infinity;
      const tb = b.startTimestamp ? new Date(b.startTimestamp).getTime() : Infinity;
      return ta - tb;
    });
    groups.push({ label, sortKey: weekSortKey(label), games: weekGames });
  }

  // Sort weeks ascending by sortKey so prior weeks come first chronologically;
  // the page-level partition then peels them into prior / current / upcoming.
  // "unscheduled" is pinned to the bottom regardless.
  groups.sort((a, b) => {
    if (a.label === 'unscheduled') return 1;
    if (b.label === 'unscheduled') return -1;
    return a.sortKey.localeCompare(b.sortKey);
  });
  return groups;
}

/**
 * Picks the "current" week label for this schedule view.
 * Strategy:
 *   1. The week containing the next-upcoming or in-progress game (start >= today).
 *      We include games up to 12h in the past so a game-in-progress still counts.
 *   2. If every game is in the past (offseason), the most recent week.
 *   3. If there are no timestamped games at all, null.
 */
function pickCurrentWeek(games: UfaGame[], nowMs: number): string | null {
  const cutoff = nowMs - 12 * 60 * 60 * 1000;
  const withTs = games.filter((g) => g.startTimestamp && g.week);

  let upcoming: UfaGame | undefined;
  let upcomingMs = Infinity;
  let mostRecent: UfaGame | undefined;
  let mostRecentMs = -Infinity;

  for (const g of withTs) {
    const t = new Date(g.startTimestamp!).getTime();
    if (t >= cutoff && t < upcomingMs) {
      upcoming = g;
      upcomingMs = t;
    }
    if (t < cutoff && t > mostRecentMs) {
      mostRecent = g;
      mostRecentMs = t;
    }
  }

  return upcoming?.week ?? mostRecent?.week ?? null;
}

/**
 * Splits the (ascending-sorted) week groups around `currentWeekLabel`.
 * `unscheduled` is treated as a bottom-of-prior bucket so it stays out of the
 * way but is still findable.
 */
function partitionWeeks(
  groups: WeekGroup[],
  currentWeekLabel: string | null,
): { current: WeekGroup | null; upcoming: WeekGroup[]; prior: WeekGroup[] } {
  if (!currentWeekLabel) return { current: null, upcoming: [], prior: [...groups].reverse() };

  const currentKey = weekSortKey(currentWeekLabel);
  let current: WeekGroup | null = null;
  const upcoming: WeekGroup[] = [];
  const prior: WeekGroup[] = [];

  for (const g of groups) {
    if (g.label === currentWeekLabel) {
      current = g;
    } else if (g.label === 'unscheduled') {
      prior.push(g);
    } else if (g.sortKey > currentKey) {
      upcoming.push(g);
    } else {
      prior.push(g);
    }
  }

  // Upcoming earliest-first (next up at the top of the accordion).
  upcoming.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  // Prior most-recent-first (last week at the top of the accordion).
  prior.sort((a, b) => {
    if (a.label === 'unscheduled') return 1;
    if (b.label === 'unscheduled') return -1;
    return b.sortKey.localeCompare(a.sortKey);
  });
  return { current, upcoming, prior };
}

/** Makes "week-4" sort before "week-10". */
function weekSortKey(label: string): string {
  if (label === 'unscheduled') return 'z-unscheduled';
  const n = parseInt(label.replace(/\D/g, ''), 10);
  return isNaN(n) ? label : `week-${String(n).padStart(3, '0')}`;
}

function formatWeekLabel(label: string): string {
  if (label === 'unscheduled') return 'Unscheduled';
  const n = parseInt(label.replace(/\D/g, ''), 10);
  if (!isNaN(n)) return `Week ${n}`;
  return label.replace(/-/g, ' ');
}

function EmptyState({ year }: { year: number }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center bg-surface rounded-card-lg shadow-card">
      <div className="text-[14px] font-semibold uppercase tracking-[0.18em] text-muted mb-2 font-tight">
        No games scheduled
      </div>
      <div className="text-[13px] text-faint max-w-sm">
        No games scheduled for the {year} season yet. Check back during the regular season.
      </div>
    </div>
  );
}
