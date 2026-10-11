// /players — league-aware player directory.
//
//   - ?league=ufa  → top UFA players by goals/assists (current season default).
//   - ?league=usau → most-active USAU players (sorted by most recent stint).
//
// Server Component. Reads ?league= and ?year= from searchParams, fetches
// the relevant dataset, and hands it to the client PlayersSearchList for
// the hero search bar + live filtering.

import type { Metadata } from 'next';
import {
  getAllPlayerStats,
  currentSeasonYear,
  getUfaChampionsByYear,
  UFA_FIRST_SEASON,
} from '@/lib/ufa/client';
import type { UfaPlayerStat } from '@/lib/ufa/types';
import { PageShell } from '@/components/page-shell';
import { YearSelector } from '@/components/year-selector';
import { type UsauPlayerListRow } from '@/lib/usau/data';
import {
  listUsauPlayersCached,
  listPulPlayersCached,
  listWulPlayersCached,
} from '@/lib/cached-readers';
import { levelLabel, parseDivisionParam, parseLeagueParam, parseLevelParam } from '@/lib/league';
import { PlayersSearchList } from '@/components/players/players-search-list';
import { UsauDivisionSelect } from '@/components/usau/usau-division-select';
import { UsauLevelSelect } from '@/components/usau/usau-level-select';
import { SortControl } from '@/components/sort-control';
import { SortableTh } from '@/components/players/sortable-th';
import {
  STICKY_LEAD_HEAD,
  STICKY_NAME_HEAD,
  STICKY_LEAD_BODY,
  STICKY_NAME_BODY,
} from '@/components/sticky-cols';
import Link from 'next/link';
import { Suspense } from 'react';
import { PulTeamLogo } from '@/components/pul-team-logo';
import { PulSeasonSelect } from '@/components/pul-season-select';
import {
  listPulTeams,
  listPulSeasons,
  getPulCurrentSeason,
  type PulPlayer,
  type PulTeam,
  type PulSortField,
} from '@/lib/pul/data';
import { WulTeamLogo } from '@/components/wul-team-logo';
import {
  listWulTeams,
  getWulResultsSeason,
  type WulPlayer,
  type WulTeam,
  type WulSortField,
} from '@/lib/wul/data';

// Fields the UFA API actually sorts on (verified live). Any ?sort= value not
// in this set falls back to 'scores' so arbitrary strings never reach the API.
const UFA_SORT_FIELDS = new Set([
  'goals',
  'assists',
  'scores',
  'hockeyAssists',
  'completions',
  'throwaways',
  'drops',
  'blocks',
  'plusMinus',
  'gamesPlayed',
]);

// 'impact' is OUR derived metric (Goals + Assists + Blocks), NOT an API sort
// field — it's computed and sorted server-side over the fetched rows. It's the
// default so the list ranks by overall two-way production out of the box.
const UFA_SORT_OPTIONS = [
  { value: 'impact', label: 'Impact' },
  { value: 'scores', label: 'Scores' },
  { value: 'goals', label: 'Goals' },
  { value: 'assists', label: 'Assists' },
  { value: 'hockeyAssists', label: 'Hockey Assists' },
  { value: 'completions', label: 'Completions' },
  { value: 'throwaways', label: 'Throwaways' },
  { value: 'drops', label: 'Drops' },
  { value: 'blocks', label: 'Blocks' },
  { value: 'plusMinus', label: '+/−' },
  { value: 'gamesPlayed', label: 'Games' },
];

/** Impact = Goals + Assists + Blocks. A player's combined offensive (scores)
 *  and defensive (blocks) production in one number. Local to this route (Next
 *  page files may only export its reserved names). */
function ufaImpact(p: UfaPlayerStat): number {
  return (p.goals ?? 0) + (p.assists ?? 0) + (p.blocks ?? 0);
}

export const revalidate = 600;

// First WUL season in wul_players (checked 2026-10-11) — floor for the ?season= clamp.
const WUL_FIRST_SEASON = 2022;

export const metadata: Metadata = {
  title: 'Players · The Layout',
};

// PUL-specific sort allowlist
const PUL_SORT_FIELDS = new Set<PulSortField>([
  'goals', 'assists', 'blocks', 'plus_minus', 'o_points', 'd_points', 'touches', 'games_played',
]);

const PUL_SORT_OPTIONS = [
  { value: 'goals',       label: 'Goals'   },
  { value: 'assists',     label: 'Assists'  },
  { value: 'blocks',      label: 'Blocks'   },
  { value: 'plus_minus',  label: '+/−'      },
  { value: 'touches',     label: 'Touches'  },
  { value: 'o_points',    label: 'O-Pts'   },
  { value: 'd_points',    label: 'D-Pts'   },
  { value: 'games_played', label: 'Games'  },
];

// WUL carries the same core stats as PUL plus two WUL-only fields (hucks, yards).
const WUL_SORT_FIELDS = new Set<WulSortField>([
  'goals', 'assists', 'blocks', 'plus_minus', 'o_points', 'd_points',
  'touches', 'games_played', 'hucks_completed', 'yards_total',
]);

const WUL_SORT_OPTIONS = [
  { value: 'goals',           label: 'Goals'   },
  { value: 'assists',         label: 'Assists'  },
  { value: 'blocks',          label: 'Blocks'   },
  { value: 'plus_minus',      label: '+/−'      },
  { value: 'touches',         label: 'Touches'  },
  { value: 'o_points',        label: 'O-Pts'   },
  { value: 'd_points',        label: 'D-Pts'   },
  { value: 'games_played',    label: 'Games'   },
  { value: 'hucks_completed', label: 'Hucks'   },
  { value: 'yards_total',     label: 'Yards'   },
];

// WUL plus_minus can be fractional (.5). PUL/UFA are integers; keep this
// WUL-specific formatter so half-values render correctly.
function formatWulPlusMinus(val: number): string {
  const abs = Number.isInteger(val) ? String(Math.abs(val)) : Math.abs(val).toFixed(1);
  if (val > 0) return `+${abs}`;
  if (val < 0) return `-${abs}`;
  return '0';
}

interface Props {
  searchParams: { year?: string; league?: string; div?: string; level?: string; sort?: string; dir?: string; season?: string };
}

export default async function PlayersPage({ searchParams }: Props) {
  const league = parseLeagueParam(searchParams.league);

  // PUL branch: season-filtered, sortable leaderboard. Each row links to
  // the unified player profile at /players/{uuid}.
  if (league === 'pul') {
    const rawSort = searchParams.sort ?? '';
    const sortBy: PulSortField = PUL_SORT_FIELDS.has(rawSort as PulSortField)
      ? (rawSort as PulSortField)
      : 'goals';
    const rawDir = searchParams.dir ?? '';
    const dir: 'asc' | 'desc' = rawDir === 'asc' ? 'asc' : 'desc';

    // The leaderboard defaults to the newest season WITH player stats, not the
    // games-based current season: next season's schedule lands weeks before
    // any player rows, and the games-based default opened this page empty
    // until opening day.
    const playerSeasons = await listPulSeasons().catch((): number[] => []);
    const currentSeason = playerSeasons[0] ?? (await getPulCurrentSeason());
    const seasons = playerSeasons.length > 0 ? playerSeasons : [currentSeason];
    const requestedSeason = parseInt(searchParams.season ?? '', 10);
    const season = seasons.includes(requestedSeason) ? requestedSeason : currentSeason;

    const [players, teams] = await Promise.all([
      listPulPlayersCached({ season, sortBy, limit: 500 }).catch((): PulPlayer[] => []),
      listPulTeams().catch((): PulTeam[] => []),
    ]);

    // Client-side asc re-sort (DB always returns desc).
    const ranked = dir === 'asc' ? [...players].reverse() : players;
    const teamMap = new Map<string, PulTeam>(teams.map((t) => [t.id, t]));

    return (
      <PageShell
        title="Players"
        eyebrow={`PUL · Premier Ultimate League · ${season}`}
        controls={
          <div className="flex flex-wrap items-center gap-2">
            {/* Season switcher — client component, must be in Suspense */}
            <Suspense fallback={null}>
              <PulSeasonSelect seasons={seasons} currentSeason={season} />
            </Suspense>
            {/* Sort control */}
            <Suspense fallback={null}>
              <SortControl
                options={PUL_SORT_OPTIONS}
                currentSort={sortBy}
                currentDir={dir}
              />
            </Suspense>
          </div>
        }
      >
        {ranked.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center bg-surface rounded-card-lg shadow-card">
            <div className="text-[14px] font-semibold uppercase tracking-[0.18em] text-muted mb-2 font-tight">
              No players yet
            </div>
            <div className="text-[13px] text-faint max-w-sm">
              PUL player stats will appear here as the {season} season progresses.
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto bg-surface rounded-card-lg shadow-card">
            <table className="w-full min-w-[700px] border-collapse table-fixed">
              <thead>
                <tr>
                  {[
                    { label: '#',       title: 'Rank',                     left: true,  w: 'w-10',                 sort: null },
                    { label: 'Player',  title: 'Player name',              left: true,  w: 'w-[140px] sm:w-[180px]', sort: null },
                    { label: 'Team',    title: 'Team',                     left: true,  w: 'w-[120px]',            sort: null },
                    { label: 'G',       title: 'Goals',                    left: false, w: '',                     sort: 'goals' },
                    { label: 'A',       title: 'Assists',                  left: false, w: '',                     sort: 'assists' },
                    { label: 'Blk',     title: 'Blocks',                   left: false, w: '',                     sort: 'blocks' },
                    { label: 'TO',      title: 'Turnovers',                left: false, w: '',                     sort: null },
                    { label: 'Touch',   title: 'Touches',                  left: false, w: '',                     sort: 'touches' },
                    { label: 'O-Pts',   title: 'Offensive Points Played',  left: false, w: '',                     sort: 'o_points' },
                    { label: 'D-Pts',   title: 'Defensive Points Played',  left: false, w: '',                     sort: 'd_points' },
                    { label: '+/−',     title: 'Plus / Minus',             left: false, w: '',                     sort: 'plus_minus' },
                  ].map((h, hi, arr) => {
                    // Freeze # + Player so identity stays put while stats (and the
                    // Team column) scroll on mobile. See sticky-cols.ts.
                    const frozen = hi === 0
                      ? `${STICKY_LEAD_HEAD} bg-surface`
                      : hi === 1
                        ? `${STICKY_NAME_HEAD} bg-surface`
                        : '';
                    const cls = [
                      'px-3 py-3 text-[10px] font-bold tracking-wide uppercase',
                      'whitespace-nowrap',
                      h.left ? 'text-left' : 'text-right',
                      hi === arr.length - 1 ? 'pr-5' : '',
                      // Frozen col 0 uses LEAD_W (from `frozen`); others keep h.w.
                      hi === 0 ? '' : h.w,
                      frozen,
                    ].join(' ');
                    return h.sort ? (
                      <SortableTh
                        key={h.label}
                        label={h.label}
                        title={h.title}
                        sortField={h.sort}
                        currentSort={sortBy}
                        currentDir={dir}
                        className={cls}
                      />
                    ) : (
                      <th key={h.label} scope="col" title={h.title} className={`${cls} text-faint`}>
                        {h.label}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {ranked.map((player, i) => {
                  const team = teamMap.get(player.teamId);
                  return (
                    <tr key={player.id} className="group hover:bg-surface-hi transition-colors duration-100">
                      <td className={`px-3 py-2.5 text-[13px] text-left text-faint tabular font-tight ${STICKY_LEAD_BODY} bg-surface group-hover:bg-surface-hi ${i === 0 ? '' : 'border-t border-hairline'}`}>
                        {i + 1}
                      </td>
                      <td className={`px-3 py-2.5 text-[13px] text-left w-[140px] sm:w-[180px] ${STICKY_NAME_BODY} bg-surface group-hover:bg-surface-hi ${i === 0 ? '' : 'border-t border-hairline'}`}>
                        <Link
                          href={`/players/${player.id}?from=pul`} prefetch={false}
                          className="block font-medium font-tight text-ink hover:text-accent transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded whitespace-nowrap overflow-x-auto no-scrollbar"
                        >
                          {player.playerName}
                        </Link>
                      </td>
                      <td className={`px-3 py-2.5 text-left w-[120px] ${i === 0 ? '' : 'border-t border-hairline'}`}>
                        {team ? (
                          <Link
                            href={`/pul/teams/${team.id}`}
                            className="flex items-center gap-2 no-underline text-[12px] font-medium font-tight text-muted hover:text-ink transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
                          >
                            <span className="flex-shrink-0 inline-flex"><PulTeamLogo team={team} size={22} /></span>
                            <span className="truncate">{team.mascot}</span>
                          </Link>
                        ) : (
                          <span className="text-[12px] text-faint font-tight">—</span>
                        )}
                      </td>
                      {[player.goals, player.assists, player.blocks, player.turnovers, player.touches, player.oPoints, player.dPoints].map((val, ci) => (
                        <td key={ci} className={`px-3 py-2.5 text-[13px] text-right tabular text-muted font-tight ${i === 0 ? '' : 'border-t border-hairline'}`}>
                          {val}
                        </td>
                      ))}
                      <td className={`px-3 py-2.5 text-[13px] text-right tabular text-muted font-tight pr-5 ${i === 0 ? '' : 'border-t border-hairline'}`}>
                        {player.plusMinus > 0 ? `+${player.plusMinus}` : player.plusMinus}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </PageShell>
    );
  }

  // WUL branch: structurally identical to PUL — season-filtered, sortable
  // leaderboard. Carries two WUL-only columns (no extra UI difference). Rows
  // link to /players/{uuid}?from=wul so the profile back-link returns here.
  if (league === 'wul') {
    const rawSort = searchParams.sort ?? '';
    const sortBy: WulSortField = WUL_SORT_FIELDS.has(rawSort as WulSortField)
      ? (rawSort as WulSortField)
      : 'goals';
    const rawDir = searchParams.dir ?? '';
    const dir: 'asc' | 'desc' = rawDir === 'asc' ? 'asc' : 'desc';

    // Same rule as PUL: the newest season with results (player stats land in
    // the same scrape), not the newest with any game — next season's schedule
    // is in wul_games months before its first stat line.
    const currentSeason = await getWulResultsSeason();
    const requestedSeason = parseInt(searchParams.season ?? '', 10);
    const season =
      requestedSeason >= WUL_FIRST_SEASON && requestedSeason <= currentSeasonYear()
        ? requestedSeason
        : currentSeason;

    const [players, teams] = await Promise.all([
      listWulPlayersCached({ season, sortBy, limit: 500 }).catch((): WulPlayer[] => []),
      listWulTeams().catch((): WulTeam[] => []),
    ]);

    // Client-side asc re-sort (DB always returns desc).
    const ranked = dir === 'asc' ? [...players].reverse() : players;
    const teamMap = new Map<string, WulTeam>(teams.map((t) => [t.id, t]));

    return (
      <PageShell
        title="Players"
        eyebrow={`WUL · Western Ultimate League · ${season}`}
        controls={
          <div className="flex flex-wrap items-center gap-2">
            <Suspense fallback={null}>
              <SortControl
                options={WUL_SORT_OPTIONS}
                currentSort={sortBy}
                currentDir={dir}
              />
            </Suspense>
          </div>
        }
      >
        {ranked.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center bg-surface rounded-card-lg shadow-card">
            <div className="text-[14px] font-semibold uppercase tracking-[0.18em] text-muted mb-2 font-tight">
              No players yet
            </div>
            <div className="text-[13px] text-faint max-w-sm">
              WUL player stats will appear here as the {season} season progresses.
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto bg-surface rounded-card-lg shadow-card">
            <table className="w-full min-w-[700px] border-collapse table-fixed">
              <thead>
                <tr>
                  {[
                    { label: '#',      title: 'Rank',                     left: true,  w: 'w-10',                 sort: null },
                    { label: 'Player', title: 'Player name',              left: true,  w: 'w-[140px] sm:w-[180px]', sort: null },
                    { label: 'Team',   title: 'Team',                     left: true,  w: 'w-[120px]',            sort: null },
                    { label: 'G',      title: 'Goals',                    left: false, w: '',                     sort: 'goals' },
                    { label: 'A',      title: 'Assists',                  left: false, w: '',                     sort: 'assists' },
                    { label: 'Blk',    title: 'Blocks',                   left: false, w: '',                     sort: 'blocks' },
                    { label: 'TO',     title: 'Turnovers',                left: false, w: '',                     sort: null },
                    { label: 'Touch',  title: 'Touches',                  left: false, w: '',                     sort: 'touches' },
                    { label: 'O-Pts',  title: 'Offensive Points Played',  left: false, w: '',                     sort: 'o_points' },
                    { label: 'D-Pts',  title: 'Defensive Points Played',  left: false, w: '',                     sort: 'd_points' },
                    { label: '+/−',    title: 'Plus / Minus',             left: false, w: '',                     sort: 'plus_minus' },
                  ].map((h, hi, arr) => {
                    // Freeze # + Player so identity stays put while stats (and the
                    // Team column) scroll on mobile. See sticky-cols.ts.
                    const frozen = hi === 0
                      ? `${STICKY_LEAD_HEAD} bg-surface`
                      : hi === 1
                        ? `${STICKY_NAME_HEAD} bg-surface`
                        : '';
                    const cls = [
                      'px-3 py-3 text-[10px] font-bold tracking-wide uppercase',
                      'whitespace-nowrap',
                      h.left ? 'text-left' : 'text-right',
                      hi === arr.length - 1 ? 'pr-5' : '',
                      // Frozen col 0 uses LEAD_W (from `frozen`); others keep h.w.
                      hi === 0 ? '' : h.w,
                      frozen,
                    ].join(' ');
                    return h.sort ? (
                      <SortableTh
                        key={h.label}
                        label={h.label}
                        title={h.title}
                        sortField={h.sort}
                        currentSort={sortBy}
                        currentDir={dir}
                        className={cls}
                      />
                    ) : (
                      <th key={h.label} scope="col" title={h.title} className={`${cls} text-faint`}>
                        {h.label}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {ranked.map((player, i) => {
                  const team = teamMap.get(player.teamId);
                  return (
                    <tr key={player.id} className="group hover:bg-surface-hi transition-colors duration-100">
                      <td className={`px-3 py-2.5 text-[13px] text-left text-faint tabular font-tight ${STICKY_LEAD_BODY} bg-surface group-hover:bg-surface-hi ${i === 0 ? '' : 'border-t border-hairline'}`}>
                        {i + 1}
                      </td>
                      <td className={`px-3 py-2.5 text-[13px] text-left w-[140px] sm:w-[180px] ${STICKY_NAME_BODY} bg-surface group-hover:bg-surface-hi ${i === 0 ? '' : 'border-t border-hairline'}`}>
                        <Link
                          href={`/players/${player.id}?from=wul`} prefetch={false}
                          className="block font-medium font-tight text-ink hover:text-accent transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded whitespace-nowrap overflow-x-auto no-scrollbar"
                        >
                          {player.playerName}
                        </Link>
                      </td>
                      <td className={`px-3 py-2.5 text-left w-[120px] ${i === 0 ? '' : 'border-t border-hairline'}`}>
                        {team ? (
                          <Link
                            href={`/wul/teams/${team.id}`}
                            className="flex items-center gap-2 no-underline text-[12px] font-medium font-tight text-muted hover:text-ink transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
                          >
                            <span className="flex-shrink-0 inline-flex">
                              <WulTeamLogo team={team} size={22} />
                            </span>
                            <span className="truncate">{team.mascot}</span>
                          </Link>
                        ) : (
                          <span className="text-[12px] text-faint font-tight">—</span>
                        )}
                      </td>
                      {[
                        player.goals,
                        player.assists,
                        player.blocks,
                        player.turnovers,
                        player.touches,
                        player.oPoints,
                        player.dPoints,
                      ].map((val, ci) => (
                        <td
                          key={ci}
                          className={`px-3 py-2.5 text-[13px] text-right tabular text-muted font-tight ${i === 0 ? '' : 'border-t border-hairline'}`}
                        >
                          {val}
                        </td>
                      ))}
                      <td className={`px-3 py-2.5 text-[13px] text-right tabular text-muted font-tight pr-5 ${i === 0 ? '' : 'border-t border-hairline'}`}>
                        {formatWulPlusMinus(player.plusMinus)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </PageShell>
    );
  }

  if (league === 'usau') {
    const division = parseDivisionParam(searchParams.div);
    const level = parseLevelParam(searchParams.level);
    // College has no Mixed division — quietly coerce so the page doesn't
    // render empty when a user lands here via a stale `?div=mixed` link.
    const isCollege = level === 'COLLEGE_D1' || level === 'COLLEGE_D3';
    const effectiveDivision = isCollege && division === 'Mixed' ? 'Men' : division;
    const players = await listUsauPlayersCached({
      limit: 200,
      genderDivision: effectiveDivision,
      competitionLevel: level,
    }).catch(() => [] as UsauPlayerListRow[]);
    return (
      <PageShell
        title="Players"
        eyebrow={`USAU · ${levelLabel(level)} · ${effectiveDivision}`}
        controls={
          <div className="flex flex-wrap items-center gap-2">
            <UsauLevelSelect />
            <UsauDivisionSelect />
          </div>
        }
      >
        <PlayersSearchList
          mode={{ kind: 'usau', players, division: effectiveDivision, level }}
          scopeLabel={`${levelLabel(level)} · ${effectiveDivision}'s · all seasons`}
        />
      </PageShell>
    );
  }

  // UFA: pull leaders for the selected year. Sort via API (server-side).
  const currentYear = currentSeasonYear();
  // Clamp to seasons that exist — an unbounded ?year= is an upstream fetch per
  // garbage URL.
  const requestedYear = parseInt(searchParams.year ?? '', 10);
  const year =
    requestedYear >= UFA_FIRST_SEASON && requestedYear <= currentYear ? requestedYear : currentYear;

  // Validate sort/dir against the allowlist — never forward arbitrary user input.
  // Default is 'impact' (our derived Goals+Assists+Blocks metric). 'impact' is
  // NOT an API sort field, so we don't forward it upstream — we fetch by the
  // closest proxy and rank ourselves (see below).
  const rawSort = searchParams.sort ?? '';
  const sort = rawSort === 'impact' || UFA_SORT_FIELDS.has(rawSort) ? rawSort : 'impact';
  const rawDir = searchParams.dir ?? '';
  const dir: 'asc' | 'desc' = rawDir === 'asc' ? 'asc' : 'desc';

  const sortByImpact = sort === 'impact';
  // For API-sortable fields we only need the top 200 (7 pages). For Impact we
  // must rank ALL players ourselves — a high-block defender can have top-tier
  // Impact yet a middling 'scores' rank — so we fetch the full season pool (via
  // the 'scores' proxy for a stable order) and sort locally. Cached for 10min.
  const [stats, champions] = await Promise.all([
    getAllPlayerStats(
      { year, per: 'total', sort: sortByImpact ? 'scores' : sort, dir },
      { maxPages: sortByImpact ? 30 : 7 },
    ).catch(() => [] as UfaPlayerStat[]),
    getUfaChampionsByYear([year]).catch(() => new Map<number, string>()),
  ]);

  // Impact: compute + sort ourselves; otherwise the API already returned rows
  // in order. Cap at 200 either way (all we render).
  const ordered = sortByImpact
    ? [...stats].sort((a, b) => {
        const d = ufaImpact(b) - ufaImpact(a);
        // Tie-break by scores then name for a stable, sensible order.
        if (d !== 0) return dir === 'asc' ? -d : d;
        const s = (b.scores ?? 0) - (a.scores ?? 0);
        if (s !== 0) return dir === 'asc' ? -s : s;
        return a.name.localeCompare(b.name);
      })
    : stats;
  const ranked = ordered.slice(0, 200);
  // Champion of the year the list is showing. Single-season list scopes
  // the trophy chip to "this year's reigning champ" rather than career
  // history (full career is on the player profile).
  const championTeamIds = champions.get(year) ? [champions.get(year)!] : [];

  return (
    <PageShell
      title="Players"
      eyebrow={`UFA · ${year}`}
      controls={
        <>
          <YearSelector currentYear={year} />
          <SortControl
            options={UFA_SORT_OPTIONS}
            currentSort={sort}
            currentDir={dir}
          />
        </>
      }
    >
      <PlayersSearchList
        mode={{ kind: 'ufa', stats: ranked, championTeamIds, year }}
        scopeLabel={`${year} UFA leaders`}
        currentSort={sort}
        currentDir={dir}
      />
    </PageShell>
  );
}
