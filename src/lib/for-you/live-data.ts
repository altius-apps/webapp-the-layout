'use server';

// "For You" LIVE data — the real games / team snapshots / league standings for a
// signed-in user's favorites. Server action (heavy per-league fetching stays on
// the server); the client passes its already-loaded favorites and gets back a
// ForYouFeed. Replaces buildPreview() from preview-data.ts.
//
// SCHEDULE ASYMMETRY (important): UFA/PUL/WUL are scheduled leagues with per-team
// game feeds → they populate the games strip. USAU + WFDF are tournament/event-
// based with no ongoing team schedule → they contribute team snapshots + league
// context but NOT games. This is expected, not a gap.

import type { FavoriteLeague, FavoriteTeam, FavoritePlayer } from '@/lib/favorites/data';
import { LEAGUE_DISPLAY } from '@/lib/for-you/leagues';
import { resultHref } from '@/lib/usau/search-nav';
import {
  getCurrentGames,
  getGamesByYears,
  getStandings,
  getTeamStats,
  getAllPlayerStats,
  getPlayerSeasons,
  getPlayerGameLog,
  getStoredHeadshotUrl,
  currentSeasonYear,
} from '@/lib/ufa/client';
import { gameUiState } from '@/lib/ufa/format';
import { teamMeta, teamMetaByAbbr } from '@/lib/ufa/teams';
import type { UfaGame, UfaTeamStat, UfaPlayerStat } from '@/lib/ufa/types';
import {
  listPulGames,
  getPulStandings,
  getPulTeam,
  getPulRoster,
  getPulPlayer,
  getPulPlayerCareerByName,
  getPulPlayerGameLog,
  type PulPlayer,
} from '@/lib/pul/data';
import {
  listWulGames,
  getWulStandings,
  getWulTeam,
  getWulRoster,
  getWulPlayer,
  getWulPlayerCareerByName,
  getWulPlayerGameLog,
  type WulPlayer,
} from '@/lib/wul/data';
import {
  getTeam as getUsauTeam,
  getEvent as getUsauEvent,
  getPlayerProfile as getUsauPlayerProfile,
  getUsauTeamDivisions,
  listOfficialUsauRankings,
} from '@/lib/usau/data';
import { flightForName } from '@/lib/usau/flights';
import { usauTeamLogo } from '@/lib/usau/team-logo';
import { venueTimeZone } from '@/lib/usau/venue-tz';

/** The 5 official USAU rank-sets (OfficialRankDivision isn't exported from
 *  usau/data — mirror the literal here). */
type UsauRankDivision =
  | 'Club-Men' | 'Club-Women' | 'Club-Mixed'
  | 'College-Men' | 'College-Women';
import {
  getTeam as getWfdfTeam,
  getCurrentWfdfEvent,
  getEvent as getWfdfEvent,
  listEvents as listWfdfEvents,
} from '@/lib/wfdf/data';
import {
  getTeam as getEufTeam,
  listTeamGames as listEufTeamGames,
  getClubProfile as getEufClubProfile,
} from '@/lib/euf/data';

// ─── Output shapes (mirror preview-data, isPreview:false) ───────────────────

/** A "player to watch" on the expanded hero (upcoming-game) card. */
export interface HeroWatchPlayer {
  playerId: string | null;
  name: string;
  /** Headshot URL (UFA) or null → monogram. */
  headshotUrl: string | null;
  /** One-line season stat blurb, e.g. "38G · 52A · 6Blk". */
  statLine: string;
  href: string | null;
}

export interface FeedGame {
  id: string;
  league: FavoriteLeague;
  status: 'upcoming' | 'live' | 'final';
  home: { name: string; teamId: string; score: number | null; logoUrl: string | null };
  away: { name: string; teamId: string; score: number | null; logoUrl: string | null };
  when: string;
  /** Which favorited team surfaced this game. */
  favoriteTeamName: string;
  /** Sort key — epoch ms; games with no date sort last. */
  sortTs: number;
  /** Top players to watch per side — populated ONLY for the hero (featured)
   *  upcoming game, where the extra per-team fetch is worth the detail. */
  playersToWatch?: { away: HeroWatchPlayer[]; home: HeroWatchPlayer[] };
  isPreview: false;
}

/** A labeled team stat tile (e.g. { label: 'PF', value: '210' }). */
export interface TeamStat {
  label: string;
  value: string;
}

/** A stat leader on a favorite team — top scorer/assist/block/etc. */
export interface TeamLeader {
  /** Player profile id for the link, or null (unlinked). */
  playerId: string | null;
  name: string;
  /** Stat category label (e.g. 'Goals', 'Assists', 'Blocks', '+/-'). */
  statLabel: string;
  /** Formatted value (e.g. '63', '+41'). */
  statValue: string;
  /** How to route: /players/[id]?from=<league> for anchor leagues. */
  league: FavoriteLeague;
}

export interface TeamSnapshot {
  team: FavoriteTeam;
  /** WFDF only — IOC country code, for the flag shown when no crest resolves. */
  countryCode?: string | null;
  record: string | null;
  standing: string | null;
  /**
   * Rank-in-context line that replaces the standings table — e.g.
   * "1st in East · 1 game up on Machine" or "3rd · 1 back of Empire". Folds the
   * one useful fact out of the full table onto the card itself.
   */
  rankContext: string | null;
  /**
   * Recent form, most-recent-first — e.g. ['W','W','L','W','W']. Empty for
   * event-based leagues (USAU/WFDF) with no per-team game feed.
   */
  form: Array<'W' | 'L'>;
  /** Team-level stat tiles (PF/PA/Cmp/TO/Blk…), league-dependent. */
  stats: TeamStat[];
  /** Top players on the team by a few categories. */
  leaders: TeamLeader[];
  /**
   * Full roster (USAU club/college teams only — event-based leagues don't
   * expose per-game stats, so the roster IS the substance). Rendered scrollable
   * inside the card. Empty for UFA/PUL/WUL (those get leaders instead).
   */
  roster: Array<{ playerId: string | null; name: string; jersey: string | null }>;
  /**
   * Notable finishes — e.g. [{ placement: 3, event: 'Pro Elite Challenge West' }].
   * USAU teams surface these instead of a season record. Empty otherwise.
   */
  accolades: Array<{ placement: number; event: string; season: number }>;
  isPreview: false;
}

/**
 * A tournament a favorite team is entered in / played. USAU + WFDF are event-
 * based (no per-team game schedule), so their favorites surface tournaments
 * here instead of the games strip. Upcoming = not yet finished (no placement or
 * a future start date); past = has a final placement.
 */
export interface FeedTournament {
  id: string;
  league: FavoriteLeague;
  name: string;
  /** Event page slug → /usau/events/[slug], /wfdf/events/[slug], or /euf/events/[slug]. */
  slug: string;
  /** YYYY-MM-DD or null. */
  startDate: string | null;
  /** Final placement at this event, or null if upcoming / unplaced. */
  placement: number | null;
  status: 'upcoming' | 'past';
  /** Which favorited team(s) surfaced this tournament — several are joined
   *  with " & ", best-placed first. */
  favoriteTeamName: string;
  sortTs: number;
}

/**
 * A favorite PLAYER's 2K-style card: current-season stat line + headshot +
 * where to go for the full profile. Pro leagues (UFA/PUL/WUL) carry a rich
 * box-score stat line; USAU carries events-played (no per-player box score);
 * WFDF is name-routed with minimal stats.
 */
/** One recent game line for the spotlight player's "last 3 games" strip. */
export interface PlayerGameLine {
  /** Short date, e.g. "Jul 12". */
  dateLabel: string;
  /** Opponent name (e.g. "Seattle Cascades") or short abbr, or null. */
  opponent: string | null;
  /** Opponent team logo URL for the row, or null → no logo shown. */
  opponentLogoUrl: string | null;
  /** 'W' | 'L' | null (from the player's team POV). */
  result: 'W' | 'L' | null;
  /** "24–18" team–opp score, or null. */
  score: string | null;
  /** Box stat tiles for that game (G/A/Blk/+-, plus Yds where available). */
  stats: TeamStat[];
}

export interface FeedPlayer {
  league: FavoriteLeague;
  /** The stored favorite id (UUID for anchor leagues, name for WFDF). */
  playerId: string;
  name: string;
  /** Their team this season, if known. */
  teamName: string | null;
  /** UFA headshot URL, or null → the card shows an initials monogram. */
  headshotUrl: string | null;
  /** The season these stats are for (e.g. 2026), or null if unknown. */
  season: number | null;
  /** Stat tiles for the card (G/A/Blk/+- for pro; "Events" for USAU). */
  stats: TeamStat[];
  /** Secondary context line — e.g. "5 USAU events in 2026" or "12 games". */
  contextLine: string | null;
  /** Route to the full profile (/players/[id] or /wfdf/players/by-name/[name]). */
  href: string;
  /** Last few games (most recent first) — populated ONLY for the spotlight
   *  player (the featured card), where the extra fetch is worth the detail. */
  recentGames?: PlayerGameLine[];
}

/** One ranked row in a league-level card (top of the standings / rankings). */
export interface LeagueTopRow {
  rank: number;
  teamId: string | null;
  name: string;
  logoUrl: string | null;
  /** Right-aligned context — "12-2" (record) or "#1 · 1980" (rating), etc. */
  detail: string | null;
  /** WFDF only — IOC country code, for the flag fallback when no crest resolves. */
  countryCode?: string | null;
  /** WFDF only — lets the UI resolve a club crest via UsauTeamLogo. */
  genderDivision?: 'Men' | 'Women' | 'Mixed' | null;
  competitionLevel?: string | null;
}

/**
 * A LEAGUE-level summary card — shown for a favorited league so following a
 * league (not just a team) surfaces real content: the top of that league's
 * standings/rankings. UFA/PUL/WUL → season standings; USAU → official Top-N
 * rankings for a rank-set; WFDF → most-recent Worlds medalists.
 */
export interface FeedLeague {
  league: FavoriteLeague;
  /** Section eyebrow — e.g. "UFA Standings", "USAU Club-Men", "Worlds 2025". */
  label: string;
  /** Sub-label for grouping (e.g. UFA division name, USAU rank-set). */
  scope: string | null;
  /** Flattened rows (every section's rows in order) — always populated. */
  rows: LeagueTopRow[];
  /** Tournament-based leagues (WFDF) split the card by division, top 3 each. */
  sections?: { title: string; rows: LeagueTopRow[] }[];
  /** Where "see all" routes (league landing / standings page). */
  href: string;
}

export interface ForYouFeed {
  /**
   * The single most important game to feature big at the top: a live game if any,
   * else the soonest upcoming game, else the most recent final. Null if the user
   * follows only event-based (USAU/WFDF) teams with no scheduled game.
   */
  heroGame: FeedGame | null;
  /** The remaining games (hero excluded) for the secondary strip. */
  games: FeedGame[];
  tournaments: FeedTournament[];
  teams: TeamSnapshot[];
  /** Favorite players (2K-style cards). Empty when the user follows no players. */
  players: FeedPlayer[];
  /** League-level summary cards for favorited leagues. */
  leagues: FeedLeague[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const MS_DAY = 86_400_000;

/** Short "Sat 3:00 PM" / "Final" / "Live" label from a date + status.
 *
 *  `timeZone` MUST be passed for any league whose kickoff is a real UTC instant
 *  (USAU stores venue-local converted to UTC). Without it, toLocaleString uses
 *  the RUNTIME's zone — and this runs in a Server Component on Vercel, where
 *  that is UTC. A 14:50Z game in Indianapolis then rendered as "2:50 PM"
 *  instead of 10:50 AM, and the viewer's own device zone never entered into it
 *  because the HTML arrives pre-formatted (Hunter, 2026-08-22). */
function whenLabel(
  date: Date | null,
  status: 'upcoming' | 'live' | 'final',
  timeZone?: string,
): string {
  if (status === 'live') return 'Live';
  if (status === 'final') return 'Final';
  if (!date) return 'TBD';
  const full = date.toLocaleString('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
  // Rows ingested without a time-of-day sit at midnight; show just the weekday
  // rather than a fake "12:00 AM" (same rule as formatGameTime in venue-tz).
  if (full.endsWith('12:00 AM')) {
    return date.toLocaleString('en-US', { weekday: 'short', ...(timeZone ? { timeZone } : {}) });
  }
  return full;
}

/**
 * Keep upcoming games within the next 60d (drop far-future); drop nothing on the
 * past side here. Recent-finals trimming happens AFTER sorting (keep the most
 * recent N per team), so an offseason league whose last game was weeks ago still
 * shows its results instead of an empty strip. `live` always kept.
 */
function inWindow(ts: number, now: number, status: 'upcoming' | 'live' | 'final'): boolean {
  if (status === 'live') return true;
  if (status === 'final') return true; // trimmed later by recency rank, not a hard window
  return ts <= now + 60 * MS_DAY;
}

/** Max recent finals to keep per favorite team (their season may be over). */
const RECENT_FINALS_PER_TEAM = 3;

// ─── Rank context + form (replaces the standings table) ─────────────────────

/** Ordinal ("1st", "2nd", "3rd", "11th"). */
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

/** "1 game" / "2 games" plural helper. */
function games(n: number): string {
  return `${n} game${n === 1 ? '' : 's'}`;
}

/**
 * The rank-in-context line for a team, derived from an ordered standings list
 * (already sorted best→worst). Returns e.g. "1st · 1 game up on Machine",
 * "3rd · 1 game back of Empire", or just "1st" / "Last" when there's no neighbor
 * to compare. `scope` is an optional trailing qualifier ("in East").
 *
 * "Games up/back" uses the classic (wins-losses) differential / 2 vs the
 * relevant neighbor — the team above when you're chasing, the team below when
 * you're leading.
 */
function rankContextLine(
  rows: Array<{ teamId: string; wins: number; losses: number; name: string }>,
  teamId: string,
  scope: string | null,
): string | null {
  const idx = rows.findIndex((r) => r.teamId === teamId);
  if (idx < 0) return null;
  const me = rows[idx];
  const rankLabel = ordinal(idx + 1) + (scope ? ` in ${scope}` : '');
  const diff2 = (a: { wins: number; losses: number }, b: { wins: number; losses: number }) =>
    ((a.wins - a.losses) - (b.wins - b.losses)) / 2;

  if (idx === 0) {
    // Leading — how far up on the next team down?
    const next = rows[idx + 1];
    if (!next) return rankLabel;
    const up = diff2(me, next);
    if (up <= 0) return `${rankLabel} · tied with ${next.name}`;
    return `${rankLabel} · ${games(up)} up on ${next.name}`;
  }
  // Chasing — how far back of the team directly above?
  const above = rows[idx - 1];
  const back = diff2(above, me);
  if (back <= 0) return `${rankLabel} · tied with ${above.name}`;
  return `${rankLabel} · ${games(back)} back of ${above.name}`;
}

/**
 * Recent form (most-recent-first, capped at 5) for a team, from that team's
 * already-fetched FeedGames. Only finals with a decided score count.
 */
function formFromGames(feedGames: FeedGame[], teamId: string): Array<'W' | 'L'> {
  return feedGames
    .filter((g) => g.status === 'final' && (g.home.teamId === teamId || g.away.teamId === teamId))
    .filter((g) => g.home.score !== null && g.away.score !== null)
    .sort((a, b) => b.sortTs - a.sortTs)
    .slice(0, 5)
    .map((g) => {
      const isHome = g.home.teamId === teamId;
      const mine = isHome ? g.home.score! : g.away.score!;
      const theirs = isHome ? g.away.score! : g.home.score!;
      return mine >= theirs ? ('W' as const) : ('L' as const);
    });
}

// ─── UFA games ──────────────────────────────────────────────────────────────

function ufaStatus(g: UfaGame): 'upcoming' | 'live' | 'final' {
  const s = gameUiState(g);
  return s.isLive ? 'live' : s.isFinal ? 'final' : 'upcoming';
}

async function ufaGamesFor(favTeamIds: Set<string>, now: number, year: number): Promise<FeedGame[]> {
  if (favTeamIds.size === 0) return [];
  const isCurrent = year >= currentSeasonYear();
  // Current slate covers live + near-term; the season pull backfills recents.
  // For a PAST year we only need that season's completed games (no live slate),
  // and we keep ALL of them (the recency window doesn't apply to history — the
  // snapshot uses these to compute that season's record + form).
  const [current, season] = await Promise.all([
    isCurrent ? getCurrentGames().catch(() => [] as UfaGame[]) : Promise.resolve([] as UfaGame[]),
    getGamesByYears([year]).catch(() => [] as UfaGame[]),
  ]);
  const byId = new Map<string, UfaGame>();
  for (const g of [...season, ...current]) byId.set(g.gameID, g); // current wins (fresher)

  const out: FeedGame[] = [];
  for (const g of byId.values()) {
    const favIsAway = favTeamIds.has(g.awayTeamID);
    const favIsHome = favTeamIds.has(g.homeTeamID);
    if (!favIsAway && !favIsHome) continue;

    const status = ufaStatus(g);
    const date = g.startTimestamp ? new Date(g.startTimestamp) : null;
    const ts = date ? date.getTime() : now; // dateless → treat as "now" (keep)
    // Recency windowing only applies to the live current season; past-year
    // history keeps every completed game so the snapshot's record is accurate.
    if (isCurrent && date && !inWindow(ts, now, status)) continue;

    const favName = favIsHome ? `${g.homeTeamCity} ${g.homeTeamName}` : `${g.awayTeamCity} ${g.awayTeamName}`;
    out.push({
      id: `ufa-${g.gameID}`,
      league: 'ufa',
      status,
      away: { name: `${g.awayTeamCity} ${g.awayTeamName}`, teamId: g.awayTeamID, score: status === 'upcoming' ? null : g.awayScore, logoUrl: teamMeta(g.awayTeamID).logo ?? null },
      home: { name: `${g.homeTeamCity} ${g.homeTeamName}`, teamId: g.homeTeamID, score: status === 'upcoming' ? null : g.homeScore, logoUrl: teamMeta(g.homeTeamID).logo ?? null },
      when: whenLabel(date, status),
      favoriteTeamName: favName,
      sortTs: ts,
      isPreview: false,
    });
  }
  return out;
}

// ─── PUL / WUL games (identical shape) ──────────────────────────────────────

type LeagueGame = {
  id: string;
  status: 'scheduled' | 'final';
  gameDate: string | null;
  away: { teamId: string; city: string | null; mascot: string | null; score: number | null; logoUrl: string | null };
  home: { teamId: string; city: string | null; mascot: string | null; score: number | null; logoUrl: string | null };
};

function sideName(s: { city: string | null; mascot: string | null }, fallback: string): string {
  return [s.city, s.mascot].filter(Boolean).join(' ') || fallback;
}

function proLeagueGamesFor(
  league: 'pul' | 'wul',
  games: LeagueGame[],
  favTeamIds: Set<string>,
  now: number,
): FeedGame[] {
  const out: FeedGame[] = [];
  for (const g of games) {
    const favIsAway = favTeamIds.has(g.away.teamId);
    const favIsHome = favTeamIds.has(g.home.teamId);
    if (!favIsAway && !favIsHome) continue;

    const status: 'upcoming' | 'final' = g.status === 'final' ? 'final' : 'upcoming';
    const date = g.gameDate ? new Date(g.gameDate) : null;
    const ts = date ? date.getTime() : now;
    if (date && !inWindow(ts, now, status)) continue;

    const awayName = sideName(g.away, 'Away');
    const homeName = sideName(g.home, 'Home');
    out.push({
      id: `${league}-${g.id}`,
      league,
      status,
      away: { name: awayName, teamId: g.away.teamId, score: g.away.score, logoUrl: g.away.logoUrl },
      home: { name: homeName, teamId: g.home.teamId, score: g.home.score, logoUrl: g.home.logoUrl },
      when: whenLabel(date, status),
      favoriteTeamName: favIsHome ? homeName : awayName,
      sortTs: ts,
      isPreview: false,
    });
  }
  return out;
}

// ─── Team snapshots (record / standing / stats / leaders) ───────────────────

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};
const plusMinus = (n: number): string => (n >= 0 ? `+${n}` : String(n));

/** Top players by a set of categories, one leader each, deduped by category. */
function topLeaders<T>(
  players: T[],
  league: FavoriteLeague,
  getName: (p: T) => string,
  getId: (p: T) => string | null,
  cats: Array<{ label: string; get: (p: T) => number; fmt?: (n: number) => string }>,
): TeamLeader[] {
  const out: TeamLeader[] = [];
  for (const c of cats) {
    let best: T | null = null;
    let bestV = -Infinity;
    for (const p of players) {
      const v = c.get(p);
      if (v > bestV) { bestV = v; best = p; }
    }
    if (best && bestV > 0) {
      out.push({
        playerId: getId(best),
        name: getName(best),
        statLabel: c.label,
        statValue: c.fmt ? c.fmt(bestV) : String(bestV),
        league,
      });
    }
  }
  return out;
}

async function ufaSnapshot(
  team: FavoriteTeam,
  standingsById: Map<string, { wins: number; losses: number; division: string; pointDiff: number }>,
  divisionRows: Map<string, Array<{ teamId: string; wins: number; losses: number; name: string }>>,
  teamStatsById: Map<string, UfaTeamStat>,
  teamGames: FeedGame[],
  year: number,
): Promise<TeamSnapshot> {
  const s = standingsById.get(team.teamId);
  const teamStatsRes = teamStatsById.get(team.teamId) ?? null;
  const players = await getAllPlayerStats(
    { year, per: 'total', teamID: team.teamId, limit: 30 },
    { maxPages: 2 },
  ).catch(() => [] as UfaPlayerStat[]);

  const stats: TeamStat[] = [];
  if (teamStatsRes) {
    stats.push(
      { label: 'PF', value: String(num(teamStatsRes.scoresFor)) },
      { label: 'PA', value: String(num(teamStatsRes.scoresAgainst)) },
      { label: 'Blk', value: String(num(teamStatsRes.blocks)) },
      { label: 'TO', value: String(num(teamStatsRes.turnovers)) },
    );
  }
  const leaders = topLeaders(
    players, 'ufa',
    (p) => p.name, (p) => p.playerID,
    [
      { label: 'Goals', get: (p) => p.goals ?? 0 },
      { label: 'Assists', get: (p) => p.assists ?? 0 },
      { label: 'Blocks', get: (p) => p.blocks ?? 0 },
      { label: '+/-', get: (p) => p.plusMinus ?? 0, fmt: plusMinus },
    ],
  );

  // Rank within the team's own division (UFA standings are divisional).
  const divRows = s ? divisionRows.get(s.division) ?? [] : [];
  const rankContext = s ? rankContextLine(divRows, team.teamId, s.division) : null;

  // Record: from live standings when available (current season); otherwise
  // derive it from the season's completed games (past-year lens).
  const record = s
    ? `${s.wins}-${s.losses}`
    : recordFromGames(teamGames, team.teamId);
  const standing = s ? `${s.division} Division` : `${year} season`;

  return {
    team: { ...team, logoUrl: teamMeta(team.teamId).logo ?? team.logoUrl },
    record,
    standing,
    rankContext,
    form: formFromGames(teamGames, team.teamId),
    stats,
    leaders,
    roster: [],
    accolades: [],
    isPreview: false,
  };
}

/** Win-loss record for a team from a set of FeedGames (decided finals only). */
function recordFromGames(games: FeedGame[], teamId: string): string | null {
  let w = 0;
  let l = 0;
  for (const g of games) {
    if (g.status !== 'final') continue;
    if (g.home.score == null || g.away.score == null) continue;
    const isHome = g.home.teamId === teamId;
    const isAway = g.away.teamId === teamId;
    if (!isHome && !isAway) continue;
    const mine = isHome ? g.home.score : g.away.score;
    const theirs = isHome ? g.away.score : g.home.score;
    if (mine > theirs) w++;
    else if (mine < theirs) l++;
  }
  return w + l > 0 ? `${w}-${l}` : null;
}

/** PUL + WUL share PulPlayer/WulPlayer stat shape — one enricher. */
async function proSnapshot(
  team: FavoriteTeam,
  league: 'pul' | 'wul',
  standings: { teamId: string; wins: number; losses: number; place: number; name: string }[],
  teamGames: FeedGame[],
  season: number,
): Promise<TeamSnapshot> {
  const row = standings.find((r) => r.teamId === team.teamId);
  const [teamMetaRow, roster] = await Promise.all([
    league === 'pul' ? getPulTeam(team.teamId).catch(() => null) : getWulTeam(team.teamId).catch(() => null),
    (league === 'pul'
      ? getPulRoster(team.teamId, season).catch(() => [] as PulPlayer[])
      : getWulRoster(team.teamId, season).catch(() => [] as WulPlayer[])) as Promise<Array<PulPlayer | WulPlayer>>,
  ]);
  const name = teamMetaRow?.name ?? team.name;

  // Team stat tiles aggregated from the roster (PUL/WUL have no team-stats API).
  const agg = roster.reduce(
    (a, p) => {
      a.goals += p.goals ?? 0; a.assists += p.assists ?? 0;
      a.blocks += p.blocks ?? 0; a.turnovers += p.turnovers ?? 0;
      return a;
    },
    { goals: 0, assists: 0, blocks: 0, turnovers: 0 },
  );
  const stats: TeamStat[] = roster.length
    ? [
        { label: 'G', value: String(agg.goals) },
        { label: 'A', value: String(agg.assists) },
        { label: 'Blk', value: String(agg.blocks) },
        { label: 'TO', value: String(agg.turnovers) },
      ]
    : [];

  const leaders = topLeaders(
    roster, league,
    (p) => p.playerName, (p) => p.id,
    [
      { label: 'Goals', get: (p) => p.goals ?? 0 },
      { label: 'Assists', get: (p) => p.assists ?? 0 },
      { label: 'Blocks', get: (p) => p.blocks ?? 0 },
      { label: '+/-', get: (p) => p.plusMinus ?? 0, fmt: plusMinus },
    ],
  );

  const rankContext = rankContextLine(standings, team.teamId, null);

  return {
    team: { ...team, name, logoUrl: teamMetaRow?.logoUrl ?? team.logoUrl },
    record: row ? `${row.wins}-${row.losses}` : null,
    standing: row ? ordinal(row.place) + ` in ${league.toUpperCase()}` : null,
    rankContext,
    form: formFromGames(teamGames, team.teamId),
    stats,
    leaders,
    roster: [],
    accolades: [],
    isPreview: false,
  };
}

async function usauSnapshot(team: FavoriteTeam, year: number): Promise<TeamSnapshot> {
  const t = await getUsauTeam(team.teamId).catch(() => null);
  // USAU logos resolve from the local manifest by name + division + level (not a
  // stored URL), so the denormalized favorite carries none — resolve it here so
  // the card shows the club/college crest instead of a monogram.
  const logoUrl =
    (t && usauTeamLogo(t.name, t.genderDivision, t.competitionLevel)) || team.logoUrl || null;
  const teamWithLogo: FavoriteTeam = { ...team, logoUrl };
  // Prefer the CURRENT season; fall back to the newest the team has.
  const season = t?.seasons?.find((s) => s.season === year) ?? t?.seasons?.[0] ?? null;
  const latest = season?.events?.[0] ?? null;
  const placement = latest?.finalPlacement ?? null;

  // Full roster is the substance for an event-based team (no per-game stats).
  const roster = (season?.roster ?? []).map((p) => ({
    playerId: p.playerId,
    name: p.name,
    jersey: p.jerseyNumber,
  }));
  const rosterSize = roster.length;
  const stats: TeamStat[] = rosterSize > 0 ? [{ label: 'Roster', value: String(rosterSize) }] : [];

  // Accolades: TOP-3 finishes at TCT events only (the Triple Crown Tour flights
  // — US Open / Pro Championships / Club Nationals + Pro/Elite/Select flight
  // tournaments), across ALL seasons, best placement first. TCT membership uses
  // the same flightForName() classifier the rest of the app labels events with,
  // so this stays in sync with what's shown as "TCT" elsewhere.
  const accolades: TeamSnapshot['accolades'] = [];
  for (const s of t?.seasons ?? []) {
    for (const ev of s.events) {
      if (ev.finalPlacement != null && ev.finalPlacement <= 3 && flightForName(ev.name) !== null) {
        accolades.push({ placement: ev.finalPlacement, event: ev.name, season: s.season });
      }
    }
  }
  accolades.sort((a, b) => a.placement - b.placement || b.season - a.season);

  return {
    team: teamWithLogo,
    record: null, // USAU is event-based; no season W-L record here
    standing: placement != null ? `Finished ${ordinal(placement)} · ${latest?.name ?? ''}`.trim() : (latest?.name ?? null),
    rankContext: null,
    form: [],
    stats,
    leaders: [], // USAU per-player stats aren't reliably per-team; roster only
    roster,
    accolades,
    isPreview: false,
  };
}

/**
 * A favorite USAU team's tournaments for the CURRENT year — upcoming + played.
 * USAU has no per-team game schedule, so tournaments are the team's "feed".
 * getUsauTeam already aggregates every row of the real team (name + level +
 * gender), so its seasons cover the current year's events.
 */
async function usauTournamentsFor(team: FavoriteTeam, now: number, year: number): Promise<FeedTournament[]> {
  const t = await getUsauTeam(team.teamId).catch(() => null);
  const season = t?.seasons?.find((s) => s.season === year);
  if (!season) return [];
  return season.events.map((ev) => {
    const date = ev.startDate ? new Date(ev.startDate) : null;
    const ts = date ? date.getTime() : now;
    // Past once it has a final placement OR its start date is in the past.
    const past = ev.finalPlacement != null || (date != null && ts < now);
    return {
      id: `usau-${ev.slug}`,
      league: 'usau' as const,
      name: ev.name,
      slug: ev.slug,
      startDate: ev.startDate,
      placement: ev.finalPlacement,
      status: past ? ('past' as const) : ('upcoming' as const),
      favoriteTeamName: team.name,
      sortTs: ts,
    };
  });
}

/** Events for the user's favorited WFDF teams. A WFDF team row is per-event
 *  (its summary carries exactly one eventSlug), so each favorite contributes
 *  at most one tournament row — for the selected year only. Event dates come
 *  from the events list (the team summary doesn't carry them); one shared
 *  fetch covers every favorite. */
async function wfdfTournamentsFor(
  favTeams: FavoriteTeam[],
  now: number,
  year: number,
): Promise<FeedTournament[]> {
  if (favTeams.length === 0) return [];
  const [summaries, events] = await Promise.all([
    Promise.all(favTeams.map((t) => getWfdfTeam(t.teamId).catch(() => null))),
    listWfdfEvents().catch(() => []),
  ]);
  const eventBySlug = new Map(events.map((e) => [e.slug, e]));
  const out: FeedTournament[] = [];
  favTeams.forEach((fav, i) => {
    const t = summaries[i];
    if (!t || t.eventYear !== year) return;
    const ev = eventBySlug.get(t.eventSlug);
    const startDate = ev?.startDate ?? null;
    const ts = startDate ? new Date(startDate).getTime() : now;
    // A multi-day event in progress isn't "past" — run out the END date
    // (inclusive) before flipping, unless a final standing already exists.
    const endTs = ev?.endDate ? new Date(ev.endDate).getTime() + MS_DAY : ts;
    const past = t.finalStanding != null || (startDate != null && endTs < now);
    out.push({
      // Event-level id so two followed teams at one event merge into one row.
      id: `wfdf-${t.eventSlug}`,
      league: 'wfdf',
      name: t.eventName,
      slug: t.eventSlug,
      startDate,
      placement: t.finalStanding,
      status: past ? 'past' : 'upcoming',
      favoriteTeamName: fav.name,
      sortTs: ts,
    });
  });
  return out;
}

/** Events for one favorited EUCS club. The favorite's `teamId` carries
 *  "name|division" (club identity — see resultRoute); the club profile's
 *  appearances are its event history, filtered to the selected year. */
async function eufTournamentsFor(
  team: FavoriteTeam,
  now: number,
  year: number,
): Promise<FeedTournament[]> {
  const sep = team.teamId.lastIndexOf('|');
  const name = sep >= 0 ? team.teamId.slice(0, sep) : team.teamId;
  const division = sep >= 0 ? team.teamId.slice(sep + 1) : '';
  const profile = await getEufClubProfile(name, division).catch(() => null);
  if (!profile) return [];
  return profile.appearances
    .filter((a) => a.year === year)
    .map((a) => {
      const ts = a.startDate ? new Date(a.startDate).getTime() : now;
      const past = a.finalPlacement != null || (a.startDate != null && ts < now);
      return {
        // Event-level id so two followed clubs at one event merge into one row.
        id: `euf-${a.eventSlug}`,
        league: 'euf' as const,
        name: a.eventName,
        slug: a.eventSlug,
        startDate: a.startDate,
        placement: a.finalPlacement,
        status: past ? ('past' as const) : ('upcoming' as const),
        favoriteTeamName: team.name,
        sortTs: ts,
      };
    });
}

/**
 * A favorite USAU team's UPCOMING scheduled games (real pool-play matchups with
 * kickoff times) for the current year. USAU is event-based, so unlike UFA there's
 * no team-wide schedule endpoint — we walk the team's current-year events, fetch
 * each one that could still have unplayed games (starts within the next ~30d or
 * started within the last ~3d, since a tournament plays Fri–Sun), and pull that
 * team's games with status 'scheduled' + a future kickoff.
 *
 * Games are keyed on per-season team ids that differ from the favorite's stored
 * teamId, so we match by NAME (same clustering the rest of the USAU layer uses).
 */
async function usauUpcomingGamesFor(team: FavoriteTeam, now: number, year: number): Promise<FeedGame[]> {
  const t = await getUsauTeam(team.teamId).catch(() => null);
  const season = t?.seasons?.find((s) => s.season === year);
  if (!season) return [];

  // Only fetch events that plausibly still have unplayed games (a full event
  // fetch each is not free). Window: start within +30d, or started within -3d.
  const candidateSlugs = season.events
    .filter((ev) => {
      if (!ev.startDate) return true; // undated → check it
      const ts = new Date(ev.startDate).getTime();
      return ts >= now - 3 * MS_DAY && ts <= now + 30 * MS_DAY;
    })
    .map((ev) => ev.slug);
  const uniqueSlugs = [...new Set(candidateSlugs)];
  if (uniqueSlugs.length === 0) return [];

  const teamNameLc = t!.name.toLowerCase();
  const events = await Promise.all(uniqueSlugs.map((slug) => getUsauEvent(slug).catch(() => null)));

  const out: FeedGame[] = [];
  // Member slugs resolve to their merged series event, so two members of one
  // group (a team cluster whose gender tag is wrong on one entry) load the same
  // event twice — walk each merged event once or its games tile twice.
  const seenEvents = new Set<string>();
  for (const ev of events) {
    if (!ev || seenEvents.has(ev.slug)) continue;
    seenEvents.add(ev.slug);
    // Game times are true UTC instants; render them in the VENUE's wall clock,
    // not the server's (see whenLabel). Null state → undefined → UTC, which
    // renders the stored clock unshifted, same fallback as formatGameTime.
    const tz = venueTimeZone(ev.venueTz ?? ev.state) ?? undefined;
    // A merged series event's divisions can play in different states — format
    // each game in its own division's zone.
    const tzFor = (division: string | null) => {
      const member = division ? ev.members.find((m) => m.division === division) : undefined;
      return member ? (venueTimeZone(member.venueTz ?? member.state) ?? undefined) : tz;
    };
    // Logos need the team's gender division, which lives on the event's team
    // list rather than the game row — index it once per event.
    const divisionByTeamName = new Map<string, string | null>();
    for (const t of ev.teams) divisionByTeamName.set(t.teamName.toLowerCase(), t.genderDivision);
    const logoFor = (name: string | null) =>
      name ? usauTeamLogo(name, divisionByTeamName.get(name.toLowerCase()) ?? null, ev.competitionLevel) : null;

    for (const g of ev.games) {
      const aLc = g.teamAName?.toLowerCase() ?? '';
      const bLc = g.teamBName?.toLowerCase() ?? '';
      const favIsA = aLc === teamNameLc;
      const favIsB = bLc === teamNameLc;
      if (!favIsA && !favIsB) continue;
      // A merged series event carries every division; a same-named team in
      // another division (a college's Men's and Women's teams) isn't this one.
      if (g.division && t!.genderDivision && g.division !== t!.genderDivision) continue;
      if (g.status !== 'scheduled') continue; // finals handled by the tournament/results path
      const date = g.scheduledAt ? new Date(g.scheduledAt) : null;
      const ts = date ? date.getTime() : now;
      if (ts < now) continue; // only genuinely upcoming
      if (!g.teamAName || !g.teamBName) continue; // need both sides to show a matchup

      out.push({
        id: `usau-${g.id}`,
        league: 'usau',
        status: 'upcoming',
        away: { name: g.teamAName, teamId: g.teamAId ?? '', score: null, logoUrl: logoFor(g.teamAName) },
        home: { name: g.teamBName, teamId: g.teamBId ?? '', score: null, logoUrl: logoFor(g.teamBName) },
        when: whenLabel(date, 'upcoming', tzFor(g.division)),
        favoriteTeamName: team.name,
        sortTs: ts,
        isPreview: false,
      });
    }
  }
  return out;
}

function genderOf(divisionName: string | null): 'Men' | 'Women' | 'Mixed' | null {
  const d = (divisionName ?? '').toLowerCase();
  if (d.includes('mixed')) return 'Mixed';
  if (d.includes('women')) return 'Women';
  if (d.includes('open') || d.includes('men')) return 'Men';
  return null;
}

async function wfdfSnapshot(team: FavoriteTeam): Promise<TeamSnapshot> {
  const t = await getWfdfTeam(team.teamId).catch(() => null);
  const record = t && t.wins != null && t.losses != null ? `${t.wins}-${t.losses}` : null;
  const standing = t?.finalStanding != null
    ? `${ordinal(t.finalStanding)} · ${t.eventName}`
    : (t?.eventName ?? null);
  const stats: TeamStat[] = [];
  if (t?.scoresFor != null) stats.push({ label: 'PF', value: String(t.scoresFor) });
  if (t?.scoresAgainst != null) stats.push({ label: 'PA', value: String(t.scoresAgainst) });
  if (t?.spiritAvg != null) stats.push({ label: 'Spirit', value: t.spiritAvg.toFixed(1) });
  const rosterSize = t?.roster?.length ?? 0;
  if (rosterSize > 0) stats.push({ label: 'Roster', value: String(rosterSize) });
  // Worlds clubs are often USAU clubs — use the crest when the manifest has one;
  // otherwise the card falls back to the country flag.
  const gender = genderOf(t?.divisionName ?? null);
  const crest = t && gender ? usauTeamLogo(t.name, gender, 'CLUB') : null;
  return {
    team: { ...team, logoUrl: crest ?? team.logoUrl },
    countryCode: t?.countryCode ?? null,
    record, standing, rankContext: null, form: [], stats, leaders: [], roster: [], accolades: [], isPreview: false,
  };
}

/** EUF: a per-event club entry. Record is derived from its games (EUCS publishes
 *  none), and the standing is the derived final placement + event name. */
async function eufSnapshot(team: FavoriteTeam): Promise<TeamSnapshot> {
  const [t, games] = await Promise.all([
    getEufTeam(team.teamId).catch(() => null),
    listEufTeamGames(team.teamId).catch(() => []),
  ]);
  let w = 0;
  let l = 0;
  let pf = 0;
  let pa = 0;
  for (const g of games) {
    const home = g.homeTeamId === team.teamId;
    const us = home ? g.homeScore : g.awayScore;
    const them = home ? g.awayScore : g.homeScore;
    if (us == null || them == null) continue;
    pf += us;
    pa += them;
    if (us > them) w++;
    else if (us < them) l++;
  }
  const stats: TeamStat[] = [];
  if (games.length > 0) {
    stats.push({ label: 'PF', value: String(pf) });
    stats.push({ label: 'PA', value: String(pa) });
  }
  return {
    team,
    record: games.length > 0 ? `${w}-${l}` : null,
    standing: t ? [t.division, t.eventName].filter(Boolean).join(' · ') : null,
    rankContext: null,
    form: [],
    stats,
    leaders: [],
    roster: [],
    accolades: [],
    isPreview: false,
  };
}

// ─── League standings teasers ───────────────────────────────────────────────
// LEAGUE_DISPLAY lives in ./leagues (a plain module) — this file is 'use server'
// and can only export async functions, so display constants can't live here.

// ─── Favorite players (2K-style cards) ──────────────────────────────────────

/** Route a favorite player to their profile (reuses the app's routing switch). */
function playerHref(p: FavoritePlayer): string {
  return resultHref({ kind: 'player', id: p.playerId, name: p.name, hint: null, league: p.league });
}

/**
 * Build a FeedPlayer for one favorite, honoring the selected `year`:
 *   - UFA        → getPlayerSeasons, picked for `year` (reg+playoffs) + headshot
 *   - PUL / WUL  → career-by-name, the stint matching `year` (id is season-bound)
 *   - USAU       → getPlayerProfile → events played that season (no box score)
 *   - WFDF       → name-routed; minimal (no id-based stat source), card links out
 * Returns null on a hard fetch failure so one bad player doesn't sink the feed.
 */
async function playerSnapshotFor(p: FavoritePlayer, year: number): Promise<FeedPlayer | null> {
  const base = {
    league: p.league,
    playerId: p.playerId,
    name: p.name,
    teamName: p.teamName,
    href: playerHref(p),
  };

  try {
    switch (p.league) {
      case 'ufa': {
        const [rows, headshot] = await Promise.all([
          getPlayerSeasons(p.playerId).catch(() => []),
          getStoredHeadshotUrl(p.playerId).catch(() => null),
        ]);
        const seasonRows = rows.filter((r) => r.year === year);
        const use = seasonRows.length > 0 ? seasonRows : rows.filter((r) => r.year === Math.max(...rows.map((x) => x.year)));
        const season = use[0]?.year ?? null;
        const sum = use.reduce(
          (a, r) => {
            a.g += r.goals; a.as += r.assists; a.blk += r.blocks; a.gp += r.gamesPlayed;
            a.thr += r.throwaways; a.drp += r.drops; a.stl += r.stalls;
            return a;
          },
          { g: 0, as: 0, blk: 0, gp: 0, thr: 0, drp: 0, stl: 0 },
        );
        const pm = sum.g + sum.as + sum.blk - sum.thr - sum.drp - sum.stl;
        return {
          ...base,
          headshotUrl: headshot ?? p.headshotUrl ?? null,
          season,
          stats: use.length
            ? [
                { label: 'G', value: String(sum.g) },
                { label: 'A', value: String(sum.as) },
                { label: 'Blk', value: String(sum.blk) },
                { label: '+/-', value: plusMinus(pm) },
              ]
            : [],
          contextLine: use.length ? `${sum.gp} game${sum.gp === 1 ? '' : 's'}${season ? ` · ${season}` : ''}` : null,
        };
      }
      case 'pul':
      case 'wul': {
        // PUL/WUL store one row per player per SEASON, keyed by a season-specific
        // id — so the favorite's stored id only resolves one season. To honor the
        // year filter we fetch the player's whole career BY NAME and pick the
        // stint for the selected year (falling back to the id-row, then newest).
        const career = p.league === 'pul'
          ? await getPulPlayerCareerByName(p.name).catch(() => null)
          : await getWulPlayerCareerByName(p.name).catch(() => null);
        const stints = career?.stints ?? [];
        const chosen =
          stints.find((s) => s.season === year)?.player ??
          // fall back to the saved id-row, then the newest season on record
          (await (p.league === 'pul' ? getPulPlayer(p.playerId) : getWulPlayer(p.playerId)).catch(() => null)) ??
          stints[0]?.player ??
          null;
        if (!chosen) return { ...base, headshotUrl: null, season: null, stats: [], contextLine: null };
        return {
          ...base,
          headshotUrl: null,
          season: chosen.season,
          teamName: base.teamName,
          stats: [
            { label: 'G', value: String(chosen.goals) },
            { label: 'A', value: String(chosen.assists) },
            { label: 'Blk', value: String(chosen.blocks) },
            { label: '+/-', value: plusMinus(chosen.plusMinus) },
          ],
          contextLine: `${chosen.gamesPlayed} game${chosen.gamesPlayed === 1 ? '' : 's'} · ${chosen.season}`,
        };
      }
      case 'usau': {
        const prof = await getUsauPlayerProfile(p.playerId).catch(() => null);
        if (!prof) return { ...base, headshotUrl: null, season: null, stats: [], contextLine: null };
        // Current-season events; fall back to the most recent season present.
        const seasons = prof.teamHistory.map((h) => h.season);
        const useSeason = seasons.includes(year) ? year : (seasons.length ? Math.max(...seasons) : null);
        const seasonStints = useSeason == null ? [] : prof.teamHistory.filter((h) => h.season === useSeason);
        const events = seasonStints.flatMap((h) => h.events);
        const teamName = seasonStints[0]?.teamName ?? base.teamName;
        return {
          ...base,
          headshotUrl: null,
          season: useSeason,
          teamName,
          stats: [{ label: 'Events', value: String(events.length) }],
          contextLine: useSeason != null
            ? `${events.length} USAU event${events.length === 1 ? '' : 's'} in ${useSeason}`
            : null,
        };
      }
      case 'wfdf':
        // WFDF players are name-routed with no id-keyed stat source here — the
        // card is a link-out with whatever we stored at favorite time.
        return { ...base, headshotUrl: null, season: null, stats: [], contextLine: 'View WFDF profile' };
      case 'euf':
        // Same as WFDF: EUF player ids are per-event, so favorites are keyed by
        // NAME and there's no id-based stat source to hydrate from here.
        return { ...base, headshotUrl: null, season: null, stats: [], contextLine: 'View EUCS profile' };
    }
  } catch {
    return { ...base, headshotUrl: null, season: null, stats: [], contextLine: null };
  }
}

/** How many recent games to show on the spotlight card. */
const SPOTLIGHT_RECENT_GAMES = 3;

/** Short "Jul 12" from a UFA date-embedded gameID ("2026-07-12-COL-NY") or ISO. */
function gameDateLabel(dateStr: string | null): string {
  if (!dateStr) return '';
  const iso = /^\d{4}-\d{2}-\d{2}/.exec(dateStr)?.[0];
  const d = iso ? new Date(iso + 'T00:00:00') : new Date(dateStr);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * The spotlight player's last few game lines (most-recent-first). Only called
 * for the featured card, so the extra per-game fetch is one player deep.
 * Pro leagues (UFA/PUL/WUL) have box scores; USAU/WFDF have none → empty.
 */
async function recentGamesFor(p: FavoritePlayer, year: number): Promise<PlayerGameLine[]> {
  try {
    if (p.league === 'ufa') {
      const log = await getPlayerGameLog(p.playerId, year).catch(() => []);
      // UFA rows have no explicit date/opponent name; the gameID embeds the date
      // and the two team abbrevs ("2026-07-12-COL-NY"). Sort by that date desc.
      const sorted = [...log].sort((a, b) => (a.gameID < b.gameID ? 1 : -1));
      return sorted.slice(0, SPOTLIGHT_RECENT_GAMES).map((g) => {
        const parts = g.gameID.split('-');
        const date = parts.slice(0, 3).join('-');
        const mine = g.isHome ? g.scoreHome : g.scoreAway;
        const opp = g.isHome ? g.scoreAway : g.scoreHome;
        // gameID is "YYYY-MM-DD-<AWAY>-<HOME>" (parts[3]=away, parts[4]=home).
        // The OPPONENT is the OTHER side: if the player was home, the opponent is
        // the away abbrev; if away, the home abbrev. (This was inverted — it
        // showed the player's OWN team as the opponent.)
        const oppAbbr = g.isHome ? parts[3] : parts[4];
        const oppMeta = oppAbbr ? teamMetaByAbbr(oppAbbr) : null;
        const oppName = oppMeta ? [oppMeta.city, oppMeta.name].filter(Boolean).join(' ') : oppAbbr ?? null;
        const pm = g.goals + g.assists + g.blocks - g.throwaways - g.drops - g.stalls;
        const yds = (g.yardsThrown ?? 0) + (g.yardsReceived ?? 0);
        const stats: TeamStat[] = [
          { label: 'G', value: String(g.goals) },
          { label: 'A', value: String(g.assists) },
          { label: 'Blk', value: String(g.blocks) },
          { label: '+/-', value: plusMinus(pm) },
        ];
        if (yds > 0) stats.push({ label: 'Yds', value: String(yds) });
        return {
          dateLabel: gameDateLabel(date),
          opponent: oppName,
          opponentLogoUrl: oppMeta?.logo ?? null,
          result: mine != null && opp != null ? (mine >= opp ? 'W' : 'L') : null,
          score: mine != null && opp != null ? `${mine}–${opp}` : null,
          stats,
        };
      });
    }

    if (p.league === 'pul' || p.league === 'wul') {
      const log = p.league === 'pul'
        ? await getPulPlayerGameLog(p.name, year).catch(() => [])
        : await getWulPlayerGameLog(p.name, year).catch(() => []);
      const sorted = [...log].sort((a, b) => ((a.date ?? '') < (b.date ?? '') ? 1 : -1));
      return sorted.slice(0, SPOTLIGHT_RECENT_GAMES).map((g) => {
        const stats: TeamStat[] = [
          { label: 'G', value: String(g.goals) },
          { label: 'A', value: String(g.assists) },
          { label: 'Blk', value: String(g.blocks) },
          { label: '+/-', value: plusMinus(g.plusMinus) },
        ];
        if ('totalYards' in g && g.totalYards) stats.push({ label: 'Yds', value: String(g.totalYards) });
        return {
          dateLabel: gameDateLabel(g.date),
          opponent: g.opponentAbbrev,
          opponentLogoUrl: null, // PUL/WUL logs carry no opponent team id → no logo
          result: g.result,
          score: g.teamScore != null && g.oppScore != null ? `${g.teamScore}–${g.oppScore}` : null,
          stats,
        };
      });
    }

    return []; // USAU / WFDF: no per-game box scores
  } catch {
    return [];
  }
}

/** Top N players to watch on one UFA team this season, by Impact (G+A+Blk). */
async function heroWatchTeam(teamId: string, year: number, n: number): Promise<HeroWatchPlayer[]> {
  const rows = await getAllPlayerStats(
    { year, per: 'total', teamID: teamId, limit: 30 },
    { maxPages: 2 },
  ).catch(() => [] as UfaPlayerStat[]);
  const ranked = [...rows]
    .sort((a, b) =>
      ((b.goals ?? 0) + (b.assists ?? 0) + (b.blocks ?? 0)) -
      ((a.goals ?? 0) + (a.assists ?? 0) + (a.blocks ?? 0)),
    )
    .slice(0, n);
  // Headshots in parallel (UFA is the only league with them).
  return Promise.all(
    ranked.map(async (p) => ({
      playerId: p.playerID,
      name: p.name,
      headshotUrl: await getStoredHeadshotUrl(p.playerID).catch(() => null),
      statLine: `${p.goals ?? 0}G · ${p.assists ?? 0}A · ${p.blocks ?? 0}Blk`,
      href: `/players/${p.playerID}?from=ufa`,
    })),
  );
}

/** Players-to-watch for both sides of the hero upcoming game (2 per team). */
async function heroWatchPlayers(
  awayTeamId: string,
  homeTeamId: string,
  year: number,
): Promise<{ away: HeroWatchPlayer[]; home: HeroWatchPlayer[] }> {
  const [away, home] = await Promise.all([
    heroWatchTeam(awayTeamId, year, 2),
    heroWatchTeam(homeTeamId, year, 2),
  ]);
  return { away, home };
}

// ─── League-level summary cards ─────────────────────────────────────────────
// Shown for a favorited league so following a LEAGUE (not just a team) surfaces
// real content. UFA/PUL/WUL are built from standings the main entry already
// fetched (no extra calls). USAU/WFDF fetch their own (cheap, cached where
// possible).

const LEAGUE_TOP_N = 5;

/** UFA: top of each division (UFA is multi-division). One card per division. */
function ufaLeagueCards(
  divisionRows: Map<string, Array<{ teamId: string; wins: number; losses: number; name: string }>>,
): FeedLeague[] {
  const cards: FeedLeague[] = [];
  for (const [division, rows] of divisionRows) {
    if (rows.length === 0) continue;
    cards.push({
      league: 'ufa',
      label: 'UFA',
      scope: division,
      href: '/teams',
      rows: rows.slice(0, LEAGUE_TOP_N).map((r, i) => ({
        rank: i + 1,
        teamId: r.teamId,
        name: r.name,
        logoUrl: teamMeta(r.teamId).logo ?? null,
        detail: `${r.wins}-${r.losses}`,
      })),
    });
  }
  return cards;
}

/** PUL/WUL: single-division standings → one card. */
function proLeagueCard(
  league: 'pul' | 'wul',
  places: { teamId: string; wins: number; losses: number; place: number; name: string }[],
  logoById: Map<string, string | null>,
): FeedLeague | null {
  if (places.length === 0) return null;
  return {
    league,
    label: league.toUpperCase(),
    scope: 'Standings',
    href: league === 'pul' ? '/pul/teams' : '/wul/teams',
    rows: places.slice(0, LEAGUE_TOP_N).map((r) => ({
      rank: r.place,
      teamId: r.teamId,
      name: r.name,
      logoUrl: logoById.get(r.teamId) ?? null,
      detail: `${r.wins}-${r.losses}`,
    })),
  };
}

/** USAU: official Top-N rankings for a rank-set (default Club-Men). */
/** The official ranking set to show: the one most of the user's favorite USAU
 *  teams play in (ties → the first favorite's), else Club-Men. Masters and
 *  other levels have no official ranking, so they don't count. */
async function usauRankDivisionFor(favTeams: FavoriteTeam[]): Promise<UsauRankDivision> {
  const ids = favTeams.filter((t) => t.league === 'usau').map((t) => t.teamId);
  const rows = await getUsauTeamDivisions(ids).catch(() => []);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const counts = new Map<UsauRankDivision, number>();
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) continue;
    const g = r.genderDivision;
    const level = r.competitionLevel ?? '';
    let d: UsauRankDivision | null = null;
    if (level === 'CLUB' && (g === 'Men' || g === 'Women' || g === 'Mixed')) d = `Club-${g}`;
    else if (level.startsWith('COLLEGE') && (g === 'Men' || g === 'Women')) d = `College-${g}`;
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best: UsauRankDivision = 'Club-Men';
  let bestN = 0;
  for (const [d, n] of counts) if (n > bestN) [best, bestN] = [d, n];
  return best;
}

async function usauLeagueCard(division: UsauRankDivision): Promise<FeedLeague | null> {
  const res = await listOfficialUsauRankings(division, LEAGUE_TOP_N).catch(() => null);
  if (!res || res.teams.length === 0) return null;
  // Resolve each team's crest from the manifest by name + division (the rank-set
  // encodes gender + level). Previously null → every league-card row rendered a
  // monogram even when a crest exists.
  const gender: 'Men' | 'Women' | 'Mixed' = division.endsWith('Women')
    ? 'Women'
    : division.endsWith('Mixed')
      ? 'Mixed'
      : 'Men';
  const level = division.startsWith('College') ? 'COLLEGE_D1' : 'CLUB';
  return {
    league: 'usau',
    label: 'USAU',
    scope: `${division.replace('-', ' · ')} · ${res.season}`,
    href: '/teams?league=usau',
    rows: res.teams.slice(0, LEAGUE_TOP_N).map((t) => ({
      rank: t.rank,
      teamId: t.id,
      name: t.name,
      logoUrl: usauTeamLogo(t.name, gender, level),
      detail: t.rating != null ? `${t.rating}` : (t.wins != null ? `${t.wins}-${t.losses}` : null),
    })),
  };
}

/** WFDF: most-recent Worlds event medalists (finalStanding ≤ 3), split by
 *  division in first-appearance order. wfdf_teams.name already IS the club
 *  (Revolver, PoNY, Chicago Machine) — never club_name, which is NULL on every
 *  row. Gender + CLUB level let the UI resolve the club crest via UsauTeamLogo,
 *  with the country flag as fallback. */
async function wfdfLeagueCard(): Promise<FeedLeague | null> {
  const ev = await getCurrentWfdfEvent().catch(() => null);
  if (!ev) return null;
  const detail = await getWfdfEvent(ev.slug).catch(() => null);
  if (!detail) return null;
  const medalists = detail.teams
    .filter((t) => t.finalStanding != null && t.finalStanding <= LEAGUE_TOP_N)
    .sort((a, b) => (a.finalStanding ?? 99) - (b.finalStanding ?? 99));
  if (medalists.length === 0) return null;
  const byDivision = new Map<string, LeagueTopRow[]>();
  for (const t of medalists) {
    const title = t.divisionName ?? 'Overall';
    const list = byDivision.get(title) ?? [];
    if (list.length >= LEAGUE_TOP_N) continue;
    list.push({
      rank: t.finalStanding ?? 0,
      teamId: t.id,
      name: t.name,
      logoUrl: null,
      detail: null,
      countryCode: t.countryCode,
      genderDivision: genderOf(t.divisionName),
      competitionLevel: 'CLUB',
    });
    byDivision.set(title, list);
  }
  const sections = [...byDivision].map(([title, rows]) => ({ title, rows }));
  return {
    league: 'wfdf',
    label: 'Worlds',
    scope: `${ev.name}`,
    href: `/wfdf/events/${ev.slug}`,
    rows: sections.flatMap((s) => s.rows),
    sections,
  };
}

// ─── Main entry ─────────────────────────────────────────────────────────────

export async function getForYouFeed(
  favorites: {
    leagues: FavoriteLeague[];
    teams: FavoriteTeam[];
    players?: FavoritePlayer[];
  },
  opts?: { year?: number },
): Promise<ForYouFeed> {
  const now = Date.now();
  const teams = favorites.teams;
  const favPlayers = favorites.players ?? [];

  // Year lens. Default = the live current year (full feed: live games, upcoming,
  // hero, current standings). A PAST year is a HISTORY lens — the games strip and
  // hero are current-season/live concepts with no meaning in a finished season,
  // so they're suppressed; the payoff is season-scoped USAU tournaments/placements
  // and per-player season lines. Scheduled leagues (UFA/PUL/WUL) show whatever
  // season-scoped data they can for that year.
  const liveYear = new Date(now).getFullYear();
  const selectedYear = opts?.year ?? liveYear;
  const isCurrentYear = selectedYear >= liveYear;

  const favByLeague = (lg: FavoriteLeague) =>
    new Set(teams.filter((t) => t.league === lg).map((t) => t.teamId));

  // Which leagues do we actually need data for? (favorited as a league OR has a
  // favorited team in it.)
  const activeLeagues = new Set<FavoriteLeague>([
    ...favorites.leagues,
    ...teams.map((t) => t.league),
  ]);

  // ── Fetch league-wide data once (shared by games + snapshots + teasers) ──
  const needUfa = activeLeagues.has('ufa');
  const needPul = activeLeagues.has('pul');
  const needWul = activeLeagues.has('wul');

  const [
    ufaGamesRaw,
    ufaStandingsRaw,
    pulGamesRaw,
    pulStandingsRaw,
    wulGamesRaw,
    wulStandingsRaw,
    ufaTeamStatsRaw,
  ] = await Promise.all([
    needUfa ? ufaGamesFor(favByLeague('ufa'), now, selectedYear) : Promise.resolve([] as FeedGame[]),
    // Standings API is CURRENT-season only (no year param). For a past year the
    // snapshot derives record + rank from that season's games instead.
    needUfa && isCurrentYear ? getStandings().catch(() => []) : Promise.resolve([]),
    // PUL/WUL seasons ARE calendar years, so the selected year maps directly to
    // the season — the year filter works across every league's team data.
    needPul ? listPulGames({ season: selectedYear }).catch(() => []) : Promise.resolve([]),
    needPul ? getPulStandings(selectedYear).catch(() => []) : Promise.resolve([]),
    needWul ? listWulGames({ season: selectedYear }).catch(() => []) : Promise.resolve([]),
    needWul ? getWulStandings(selectedYear).catch(() => []) : Promise.resolve([]),
    needUfa ? getTeamStats({ year: selectedYear }).then((r) => r.stats ?? []).catch(() => [] as UfaTeamStat[]) : Promise.resolve([] as UfaTeamStat[]),
  ]);

  // UFA standings index (teamID → wins/losses/division/pointDiff)
  const ufaStandingsById = new Map<string, { wins: number; losses: number; division: string; pointDiff: number }>();
  for (const s of ufaStandingsRaw) {
    ufaStandingsById.set(s.teamID, { wins: s.wins, losses: s.losses, division: s.divisionName, pointDiff: s.pointDiff });
  }
  // UFA division-ordered rows (division → best→worst) for rank-in-context.
  const ufaDivisionRows = new Map<string, Array<{ teamId: string; wins: number; losses: number; name: string }>>();
  for (const s of ufaStandingsRaw) {
    const arr = ufaDivisionRows.get(s.divisionName) ?? [];
    arr.push({ teamId: s.teamID, wins: s.wins, losses: s.losses, name: s.teamName });
    ufaDivisionRows.set(s.divisionName, arr);
  }
  for (const arr of ufaDivisionRows.values()) {
    arr.sort((a, b) => b.wins - a.wins || (a.losses - b.losses));
  }
  // UFA team-stats index (teamID → team stat row).
  const ufaTeamStatsById = new Map<string, UfaTeamStat>();
  for (const ts of ufaTeamStatsRaw) ufaTeamStatsById.set(ts.teamID, ts);

  // PUL/WUL standings → {teamId, wins, losses, place, name} ordered lists
  const pulPlaces = pulStandingsRaw.map((r, i) => ({ teamId: r.team.id, wins: r.wins, losses: r.losses, place: i + 1, name: r.team.name }));
  const wulPlaces = wulStandingsRaw.map((r, i) => ({ teamId: r.team.id, wins: r.wins, losses: r.losses, place: i + 1, name: r.team.name }));

  // ── Games strip: UFA (pre-shaped) + PUL/WUL ──
  const pulGames = proLeagueGamesFor(
    'pul',
    (pulGamesRaw as unknown as LeagueGame[]),
    favByLeague('pul'),
    now,
  );
  const wulGames = proLeagueGamesFor(
    'wul',
    (wulGamesRaw as unknown as LeagueGame[]),
    favByLeague('wul'),
    now,
  );

  // ── USAU upcoming scheduled games (pool play) for favorite USAU teams ──
  // Event-based → walk each favorite USAU team's near-term events for its
  // not-yet-played matchups. Only meaningful for the live current year (there
  // are no "upcoming" games in a finished past season).
  const usauFavTeams = teams.filter((t) => t.league === 'usau');
  const usauGameLists = isCurrentYear
    ? await Promise.all(
        usauFavTeams.map((t) => usauUpcomingGamesFor(t, now, selectedYear).catch(() => [] as FeedGame[])),
      )
    : [];
  // A game between two followed USAU teams comes back once per team — keep one
  // row naming both.
  const usauById = new Map<string, FeedGame>();
  for (const g of usauGameLists.flat()) {
    const prev = usauById.get(g.id);
    usauById.set(
      g.id,
      prev && prev.favoriteTeamName !== g.favoriteTeamName
        ? { ...prev, favoriteTeamName: `${prev.favoriteTeamName} & ${g.favoriteTeamName}` }
        : prev ?? g,
    );
  }
  const usauGames = [...usauById.values()];

  // For a past year the games strip + hero are suppressed (live/upcoming/recent
  // results are current-season concepts). We still compute `allGames` for the
  // current year so form pips + the strip work; past years get an empty set.
  const allGames = (isCurrentYear
    ? [...ufaGamesRaw, ...pulGames, ...wulGames, ...usauGames]
    : []
  ).sort((a, b) => {
    // Upcoming/live first (ascending by time), then finals (most recent first).
    const aFinal = a.status === 'final';
    const bFinal = b.status === 'final';
    if (aFinal !== bFinal) return aFinal ? 1 : -1;
    return aFinal ? b.sortTs - a.sortTs : a.sortTs - b.sortTs;
  });

  // Trim finals to the most-recent few PER favorite team so a wrapped-up season
  // still surfaces its latest results without one team flooding the strip.
  const finalsPerTeam = new Map<string, number>();
  const games = allGames.filter((g) => {
    if (g.status !== 'final') return true; // keep all upcoming/live
    const key = `${g.league}:${g.favoriteTeamName}`;
    const n = (finalsPerTeam.get(key) ?? 0) + 1;
    finalsPerTeam.set(key, n);
    return n <= RECENT_FINALS_PER_TEAM;
  });

  // ── Team snapshots (per favorite team) — record/standing + stats + leaders ──
  // UFA honors the selected year: team-stats + leaders come from that season
  // (getTeamStats/getAllPlayerStats take a year), and record + form come from
  // that season's games (ufaGamesRaw). The live standings API is current-only,
  // so a PAST year has no standings row → the snapshot derives record from games
  // and drops the divisional rank-context (can't reconstruct final standings).
  // Form uses ufaGamesRaw (the selected-year UFA set) — NOT allGames, which is
  // empty on a past-year lens where the strip is suppressed.
  const snapshots = await Promise.all(
    teams.map((t) => {
      switch (t.league) {
        case 'ufa': return ufaSnapshot(t, ufaStandingsById, ufaDivisionRows, ufaTeamStatsById, ufaGamesRaw, selectedYear);
        case 'pul': return proSnapshot(t, 'pul', pulPlaces, allGames, selectedYear);
        case 'wul': return proSnapshot(t, 'wul', wulPlaces, allGames, selectedYear);
        case 'usau': return usauSnapshot(t, selectedYear);
        case 'wfdf': return wfdfSnapshot(t);
        case 'euf': return eufSnapshot(t);
      }
    }),
  );

  // ── Tournaments (USAU/WFDF/EUCS favorite teams — selected year) ──
  // These leagues are event-based with no per-team game schedule, so a
  // favorite's "feed" is its tournament entries. WFDF favorites share one
  // events-list fetch; each EUCS favorite is a club-profile fetch. (currentYear
  // + usauFavTeams are computed above with the USAU games fetch.)
  const wfdfFavTeams = teams.filter((t) => t.league === 'wfdf');
  const eufFavTeams = teams.filter((t) => t.league === 'euf');
  const tournamentLists = await Promise.all([
    ...usauFavTeams.map((t) => usauTournamentsFor(t, now, selectedYear).catch(() => [] as FeedTournament[])),
    wfdfTournamentsFor(wfdfFavTeams, now, selectedYear).catch(() => [] as FeedTournament[]),
    ...eufFavTeams.map((t) => eufTournamentsFor(t, now, selectedYear).catch(() => [] as FeedTournament[])),
  ]);
  // A tournament where the user follows two teams comes back once per team —
  // keep one row naming both, best-placed team first (unplaced last), carrying
  // the best placement.
  const tournamentRowsById = new Map<string, FeedTournament[]>();
  for (const t of tournamentLists.flat()) {
    const rows = tournamentRowsById.get(t.id);
    if (rows) rows.push(t);
    else tournamentRowsById.set(t.id, [t]);
  }
  const mergedTournaments = [...tournamentRowsById.values()].map((rows) => {
    if (rows.length === 1) return rows[0];
    const ranked = [...rows].sort(
      (a, b) => (a.placement ?? Number.MAX_SAFE_INTEGER) - (b.placement ?? Number.MAX_SAFE_INTEGER),
    );
    const names = [...new Set(ranked.map((r) => r.favoriteTeamName))];
    return {
      ...rows[0],
      // Played if ANY followed team's row is: the kept placement may come from a
      // different row than rows[0].
      status: (rows.some((r) => r.status === 'past') ? 'past' : 'upcoming') as FeedTournament['status'],
      placement: ranked[0].placement, favoriteTeamName: names.join(' & ') };
  });
  const tournaments = mergedTournaments.sort((a, b) => {
    // Upcoming first, then past — latest event leads within BOTH groups
    // (mobile parity, Hunter 2026-08-16).
    const aPast = a.status === 'past';
    const bPast = b.status === 'past';
    if (aPast !== bPast) return aPast ? 1 : -1;
    return b.sortTs - a.sortTs;
  });

  // ── Hero game: the one game to feature big ──
  // Priority: a live game > the soonest upcoming game > the most recent final.
  // `games` is already sorted (live/upcoming ascending, then finals descending),
  // so the first element is exactly that. Pull it out so the strip shows the rest.
  let heroGame = games.length > 0 ? games[0] : null;
  const stripGames = heroGame ? games.slice(1) : games;

  // Enrich the hero UPCOMING game with per-team "players to watch" (UFA only —
  // the league with per-team season stats + headshots). One game, two fetches.
  if (heroGame && heroGame.league === 'ufa' && heroGame.status === 'upcoming') {
    const watch = await heroWatchPlayers(heroGame.away.teamId, heroGame.home.teamId, selectedYear).catch(() => null);
    if (watch) heroGame = { ...heroGame, playersToWatch: watch };
  }

  // ── Favorite players (2K-style cards) — fetched per player by their league ──
  // Order is FIRST-ADDED first (getMyFavorites returns players ascending), so
  // players[0] is the spotlight. Nulls (hard fetch failures) are dropped.
  const playerSnaps = await Promise.all(favPlayers.map((p) => playerSnapshotFor(p, selectedYear)));
  const players = playerSnaps.filter((p): p is FeedPlayer => p !== null);

  // Enrich ONLY the spotlight player (players[0]) with their last-few game lines
  // — a richer featured card without an N-player fan-out. Match the FavoritePlayer
  // back by (league, playerId) rather than index (a failed snapshot could shift it).
  if (players.length > 0) {
    const spot = players[0];
    const fav = favPlayers.find((f) => f.league === spot.league && f.playerId === spot.playerId);
    if (fav) {
      const recentGames = await recentGamesFor(fav, selectedYear).catch(() => []);
      if (recentGames.length > 0) players[0] = { ...spot, recentGames };
    }
  }

  // ── League-level cards — one per FAVORITED league (following a league, not a
  // team, still surfaces the top of that league). UFA/PUL/WUL reuse standings
  // already fetched above; USAU/WFDF fetch their own (cheap/cached). Suppressed
  // on a past-year lens (these are current-season standings/rankings).
  const leagueCards: FeedLeague[] = [];
  if (isCurrentYear) {
    const favLeagues = new Set(favorites.leagues);

    if (favLeagues.has('ufa')) leagueCards.push(...ufaLeagueCards(ufaDivisionRows));

    if (favLeagues.has('pul')) {
      const logos = new Map<string, string | null>(
        pulStandingsRaw.map((r) => [r.team.id, r.team.logoUrl ?? null]),
      );
      const c = proLeagueCard('pul', pulPlaces, logos);
      if (c) leagueCards.push(c);
    }
    if (favLeagues.has('wul')) {
      const logos = new Map<string, string | null>(
        wulStandingsRaw.map((r) => [r.team.id, r.team.logoUrl ?? null]),
      );
      const c = proLeagueCard('wul', wulPlaces, logos);
      if (c) leagueCards.push(c);
    }

    // USAU + WFDF fetch on demand (only when favorited).
    const [usauCard, wfdfCard] = await Promise.all([
      favLeagues.has('usau')
        ? usauRankDivisionFor(teams).then((d) => usauLeagueCard(d))
        : Promise.resolve(null),
      favLeagues.has('wfdf') ? wfdfLeagueCard() : Promise.resolve(null),
    ]);
    if (usauCard) leagueCards.push(usauCard);
    if (wfdfCard) leagueCards.push(wfdfCard);
  }

  return { heroGame, games: stripGames, tournaments, teams: snapshots, players, leagues: leagueCards };
}
