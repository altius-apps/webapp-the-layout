// Server-side fetchers for the UFA backend.
// Components in app/ use these directly via Server Components; the browser
// (and any future React Native client) goes through /api/ufa/[...path].
//
// Verified upstream constraints (2026-05-14):
//   - max `limit` per request is 30 (35+ returns 400 "Invalid parmeters")
//   - career mode = OMIT the `year` param (sending year=all returns 400)
//   - `teamID` is an integer; pass slug-style IDs through teamInternalID()
//   - the player-stats response includes `total`, so we can paginate ourselves

import 'server-only';
import type {
  UfaBoxscorePlayerRow,
  UfaGame,
  UfaGameBoxscore,
  UfaGameStatsResponse,
  UfaGamesResponse,
  UfaPlayerGameResponse,
  UfaPlayerGameRow,
  UfaPlayerInfo,
  UfaPlayerSeasonResponse,
  UfaPlayerSeasonRow,
  UfaPlayerStat,
  UfaPlayerStatsResponse,
  UfaRosterPlayer,
  UfaRosterReportsResponse,
  UfaStanding,
  UfaTeamStat,
  UfaTeamStatsResponse,
} from './types';
import { defaultSeason } from '@/lib/season-windows';
import { teamInternalID } from './teams';
import { isFinalStatus } from './format';
import { getStatsPagesRoster } from './stats-pages';

export const UFA_BASE = 'https://www.backend.ufastats.com/web-v1';
const UA = 'Mozilla/5.0 (the-layout)';

/** Upstream caps `limit` at 30 for player-stats / team-stats. */
export const MAX_LIMIT = 30;

/** Games endpoint has a stricter cap: max `limit=20`, and the param is REQUIRED. */
export const MAX_GAMES_LIMIT = 20;

interface CallOpts {
  revalidate: number; // seconds
  tag?: string;
}

async function call<T>(path: string, opts: CallOpts): Promise<T> {
  const res = await fetch(`${UFA_BASE}/${path}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    next: { revalidate: opts.revalidate, tags: opts.tag ? [opts.tag] : undefined },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`UFA ${path} → HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return (await res.json()) as T;
}

function resolveTeamID(teamID: number | string | undefined): number | undefined {
  if (teamID == null) return undefined;
  const n = teamInternalID(teamID);
  return n == null || n === 0 ? undefined : n;
}

// ── Games ────────────────────────────────────────────────────────────────────

/** Today's slate plus near-term upcoming games. Live + Upcoming + recently Final. */
export async function getCurrentGames(): Promise<UfaGame[]> {
  const data = await call<UfaGamesResponse>('games?current=true', { revalidate: 30 });
  return data.games ?? [];
}

/** Single game by gameID. The API has no /games/{id} endpoint; this filters via ?gameID=X. */
export async function getGameById(gameID: string): Promise<UfaGame | null> {
  const path = `games?gameID=${encodeURIComponent(gameID)}`;
  const data = await call<UfaGamesResponse>(path, { revalidate: 30 });
  return data.games?.[0] ?? null;
}

/** First page of games for one or more years, optionally filtered by team (slug or int).
 *  `limit` is required by upstream and capped at 20; we always pass a value. */
export async function getGamesByYears(
  years: number[],
  opts?: { teamID?: number | string; limit?: number; page?: number },
): Promise<UfaGame[]> {
  const params = new URLSearchParams({
    years: years.join(','),
    limit: String(Math.min(opts?.limit ?? MAX_GAMES_LIMIT, MAX_GAMES_LIMIT)),
  });
  const tid = resolveTeamID(opts?.teamID);
  if (tid != null) params.set('teamID', String(tid));
  if (opts?.page) params.set('page', String(opts.page));
  const data = await call<UfaGamesResponse>(`games?${params}`, { revalidate: 300 });
  return data.games ?? [];
}

/** Walk every page and return the union — for full-season schedule views.
 *  Default `maxPages=15` covers ~300 games (plenty for one UFA season + playoffs). */
export async function getAllGamesByYears(
  years: number[],
  opts?: { teamID?: number | string; maxPages?: number },
): Promise<UfaGame[]> {
  const maxPages = opts?.maxPages ?? 15;
  const out: UfaGame[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({
      years: years.join(','),
      limit: String(MAX_GAMES_LIMIT),
      page: String(page),
    });
    const tid = resolveTeamID(opts?.teamID);
    if (tid != null) params.set('teamID', String(tid));
    const data = await call<UfaGamesResponse>(`games?${params}`, { revalidate: 300 });
    const rows = data.games ?? [];
    out.push(...rows);
    if (rows.length < MAX_GAMES_LIMIT) break;
  }
  return out;
}

// ── Standings ────────────────────────────────────────────────────────────────

export async function getStandings(): Promise<UfaStanding[]> {
  return call<UfaStanding[]>('standings', { revalidate: 600 });
}

// ── Player stats ─────────────────────────────────────────────────────────────

export interface PlayerStatsQuery {
  /** Specific year, or omit / pass `'career'` for all-time totals. */
  year?: number | 'career';
  per?: 'total' | 'game' | 'points' | 'possessions' | 'minutes';
  sort?: string;
  dir?: 'asc' | 'desc';
  page?: number;
  /** Capped at MAX_LIMIT (30) per upstream rules. */
  limit?: number;
  /** Slug like 'empire' or the integer ID — both work. */
  teamID?: number | string;
}

function buildPlayerStatsQuery(q: PlayerStatsQuery): URLSearchParams {
  const params = new URLSearchParams({ limit: String(Math.min(q.limit ?? 20, MAX_LIMIT)) });
  if (q.year != null && q.year !== 'career') params.set('year', String(q.year));
  if (q.per) params.set('per', q.per);
  if (q.sort) params.set('sort', q.sort);
  if (q.dir) params.set('dir', q.dir);
  if (q.page) params.set('page', String(q.page));
  const tid = resolveTeamID(q.teamID);
  if (tid != null) params.set('teamID', String(tid));
  return params;
}

export async function getPlayerStats(q: PlayerStatsQuery = {}): Promise<UfaPlayerStatsResponse> {
  const params = buildPlayerStatsQuery(q);
  return call<UfaPlayerStatsResponse>(`player-stats?${params}`, { revalidate: 3600 });
}

/**
 * Walks every page of player-stats matching the query and returns the union.
 * Upstream caps each page at 30 rows and reports `total`, so we know when to stop.
 * Cap `maxPages` to keep this from running away (default 30 pages = 900 rows).
 */
export async function getAllPlayerStats(
  q: PlayerStatsQuery = {},
  opts: { maxPages?: number } = {},
): Promise<UfaPlayerStat[]> {
  const maxPages = opts.maxPages ?? 30;
  const limit = Math.min(q.limit ?? MAX_LIMIT, MAX_LIMIT);
  const out: UfaPlayerStat[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const res = await getPlayerStats({ ...q, limit, page });
    const rows = res.stats ?? [];
    out.push(...rows);
    if (rows.length < limit) break;
    if (out.length >= res.total) break;
  }
  return out;
}

// ── Player profile (direct endpoints) ────────────────────────────────────────
// Both undocumented; sourced from watchufa.com's player-stats Svelte bundle.
//   /web-v1/roster-stats-for-player?playerID=X
//   /web-v1/roster-game-stats-for-player?playerID=X&year=Y

/** All season rows for a player (one per year × team × regSeason flag). */
export async function getPlayerSeasons(playerID: string): Promise<UfaPlayerSeasonRow[]> {
  const path = `roster-stats-for-player?playerID=${encodeURIComponent(playerID)}`;
  const data = await call<UfaPlayerSeasonResponse>(path, { revalidate: 3600 });
  return data.stats ?? [];
}

/** Per-game breakdown for a player in one specific year. */
export async function getPlayerGameLog(playerID: string, year: number): Promise<UfaPlayerGameRow[]> {
  const path = `roster-game-stats-for-player?playerID=${encodeURIComponent(playerID)}&year=${year}`;
  const data = await call<UfaPlayerGameResponse>(path, { revalidate: 3600 });
  return data.stats ?? [];
}

/**
 * Scrape display name + current team from the watchufa.com player profile page.
 * The UFA API doesn't expose a player-info endpoint; the name lives only in
 * the Drupal HTML. Result is cached for 24h since names rarely change.
 */
export async function getPlayerInfo(playerID: string): Promise<UfaPlayerInfo | null> {
  const url = `https://www.watchufa.com/league/players/${encodeURIComponent(playerID)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      next: { revalidate: 86400 },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const html = await res.text();

  const nameMatch = html.match(/audl-player-display-name"[^>]*>\s*([^<]+?)\s*</);
  const teamMatch = html.match(/audl-player-current-team-position"[^>]*>\s*([^<]+?)\s*</);
  // Headshot lives on this same page as
  //   <img ... src=".../profile-images/{id}_profile.{ext}">  (ext varies)
  // ~90% of players have one; null when absent.
  const headshotMatch = html.match(/src="(https:\/\/[^"]*\/profile-images\/[^"]*_profile\.[A-Za-z]+)"/i);

  if (!nameMatch) return null;
  return {
    playerID,
    name: nameMatch[1].trim(),
    currentTeam: teamMatch ? teamMatch[1].trim() : null,
    headshotUrl: headshotMatch ? headshotMatch[1] : null,
  };
}

/**
 * The player's SELF-HOSTED headshot URL from our ufa_players table (a Supabase
 * Storage object we serve through the image transform). Preferred over the live
 * watchufa scrape in getPlayerInfo — it's fast, cached, and won't 404 if
 * watchufa changes. Returns null when we have no headshot for the player (UI
 * falls back to a monogram); callers may then fall back to the live scrape.
 */
export async function getStoredHeadshotUrl(playerID: string): Promise<string | null> {
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const { supabaseUrl, supabaseAnonKey } = await import('@/lib/supabase/env');
    const db = createClient(supabaseUrl(), supabaseAnonKey(), { auth: { persistSession: false } });
    const { data } = await db
      .from('ufa_players')
      .select('headshot_url')
      .eq('id', playerID)
      .maybeSingle();
    return (data?.headshot_url as string | null) ?? null;
  } catch {
    return null;
  }
}

// ── Team stats ───────────────────────────────────────────────────────────────

export interface TeamStatsQuery {
  year: number;
  perGame?: boolean;
  limit?: number;
}

export async function getTeamStats(q: TeamStatsQuery): Promise<UfaTeamStatsResponse> {
  const params = new URLSearchParams({
    year: String(q.year),
    limit: String(Math.min(q.limit ?? 25, MAX_LIMIT)),
  });
  if (q.perGame) params.set('perGame', 'true');
  return call<UfaTeamStatsResponse>(`team-stats?${params}`, { revalidate: 3600 });
}

// ── Per-game stats (single game) ─────────────────────────────────────────────
// Both endpoints are what watchufa.com's game-center uses.
//   /web-v1/game-stats?gameID=X        → team totals + 6 stat-leader categories
//   /web-v1/roster-reports?gameID=X    → roster availability + jersey numbers
//
// For Upcoming games, game-stats returns only { awayTeam, homeTeam } — callers
// should treat the rich fields as optional.

export async function getGameStats(gameID: string): Promise<UfaGameStatsResponse> {
  const path = `game-stats?gameID=${encodeURIComponent(gameID)}`;
  return call<UfaGameStatsResponse>(path, { revalidate: 30 });
}

export async function getGameRoster(gameID: string): Promise<UfaRosterReportsResponse> {
  const path = `roster-reports?gameID=${encodeURIComponent(gameID)}`;
  return call<UfaRosterReportsResponse>(path, { revalidate: 300 });
}

/** Year prefix from a gameID like "2026-05-15-MAD-PIT" → 2026. */
function yearFromGameID(gameID: string): number {
  const m = gameID.match(/^(\d{4})-/);
  return m ? Number(m[1]) : currentSeasonYear();
}

/**
 * Composes a full per-player breakdown for a single game by:
 *   1. fetching the game's roster (roster-reports)
 *   2. for every rostered player on each side, fetching their season game log
 *      (roster-game-stats-for-player) in parallel
 *   3. selecting the row matching this gameID
 *
 * Heavy on the first cold call (~70 fan-out fetches per game) but each
 * per-player game log is cached for an hour, so subsequent calls for any game
 * the same player appeared in resolve from cache.
 *
 * Per-player fetch failures degrade silently (stats = null) — we'd rather show
 * a partial table than fail the whole boxscore on one upstream hiccup.
 */
export async function getGameBoxscore(gameID: string): Promise<UfaGameBoxscore> {
  const year = yearFromGameID(gameID);
  const roster = await getGameRoster(gameID);

  let rosterAway = roster.away ?? [];
  let rosterHome = roster.home ?? [];

  // roster-reports has no roster for championship-weekend and all-star games
  // (2/144 in 2026, including the title game). Only the ROSTER is missing for
  // those — per-player stats still resolve normally — so swap in the
  // stats-pages roster and run the same fan-out below.
  //
  // The all-star game stays empty by design: its rosters are WUL/PUL players
  // who have no rows in UFA's player index, so nothing resolves for them and
  // the UI falls through to its existing empty state.
  if (rosterAway.length === 0 && rosterHome.length === 0) {
    const fallback = await getStatsPagesRoster(gameID, year);
    if (fallback) {
      rosterAway = fallback.away;
      rosterHome = fallback.home;
    }
  }

  const resolve = async (players: UfaRosterPlayer[]): Promise<UfaBoxscorePlayerRow[]> => {
    const rows = await Promise.all(
      players.map(async (p): Promise<UfaBoxscorePlayerRow> => {
        let stats: UfaPlayerGameRow | null = null;
        try {
          const log = await getPlayerGameLog(p.playerID, year);
          stats = log.find((r) => r.gameID === gameID) ?? null;
        } catch {
          // Soft-fail: log is missing → row shows dashes.
        }
        return {
          playerID: p.playerID,
          firstName: p.firstName,
          lastName: p.lastName,
          jerseyNumber: p.jerseyNumber,
          status: p.status,
          stats,
        };
      }),
    );
    return rows;
  };

  const [away, home] = await Promise.all([resolve(rosterAway), resolve(rosterHome)]);
  return { gameID, year, away, home };
}

// ── Champions ────────────────────────────────────────────────────────────────

/** First UFA (then AUDL) season. 2020 was cancelled — the API returns no games
 *  for it, which the `games.length === 0` guard already handles. */
export const UFA_FIRST_SEASON = 2012;

// Game start time as a sortable number; missing timestamps sort last.
function gameTs(g: UfaGame): number {
  return g.startTimestamp ? new Date(g.startTimestamp).getTime() : -Infinity;
}

// The UFA all-star game is a non-competitive exhibition that lands in the
// final weeks of the schedule and must never be mistaken for the title game.
// It shows up as a gameID like "2025-08-23-allstar-game" / "2022-11-12-allstar-game".
function isAllStarGame(g: UfaGame): boolean {
  const id = (g.gameID ?? '').toLowerCase();
  const wk = (g.week ?? '').toLowerCase();
  return id.includes('allstar') || id.includes('all-star') || wk.includes('allstar') || wk.includes('all-star');
}

// Decided Finals only (no ties, no all-star exhibition).
function decidedFinals(games: UfaGame[]): UfaGame[] {
  return games.filter(
    (g) => g.status === 'Final' && g.awayScore !== g.homeScore && !isAllStarGame(g),
  );
}

/**
 * Identify the championship game for one fully-completed season.
 *
 * There is NO single field the UFA API exposes that marks the title game,
 * and the `week` labeling convention has changed every season:
 *   2021  week="championship-weekend"
 *   2022  week="championship-weekend" (+ "playoffs", "week-allstars")
 *   2023  week="semi-finals" / "divisional-champ" / "playoffs" (no "championship")
 *   2024  all "week-N" — no playoff label at all
 *   2025  all "week-N" (+ the all-star game)
 *
 * So we try the strongest marker available, in priority order, and fall
 * back to the structural one (last decided final in the highest week).
 * Returns the championship game, or null if none can be identified.
 */
export function findChampionshipGame(games: UfaGame[]): UfaGame | null {
  const finals = decidedFinals(games);
  if (finals.length === 0) return null;

  const latest = (pool: UfaGame[]): UfaGame | null =>
    pool.length === 0 ? null : pool.reduce((a, b) => (gameTs(b) > gameTs(a) ? b : a));

  const weekIs = (g: UfaGame, ...labels: string[]) =>
    labels.includes((g.week ?? '').toLowerCase());

  // (a) Explicit "championship-weekend" label (2021, 2022) — the title game
  //     is the last decided final within it.
  const champWeekend = finals.filter((g) => weekIs(g, 'championship-weekend'));
  if (champWeekend.length > 0) return latest(champWeekend);

  // (b) Other playoff labels (2023). The final is the last decided game
  //     across the playoff-tagged weeks. 'semi-finals' here actually holds
  //     the 2023 final (UFA mislabeled it), so include it.
  const playoffLabeled = finals.filter((g) =>
    weekIs(g, 'semi-finals', 'semifinals', 'divisional-champ', 'playoffs', 'championship', 'final', 'finals'),
  );
  if (playoffLabeled.length > 0) return latest(playoffLabeled);

  // (c) No playoff labels (2024, 2025): the bracket lives in the highest
  //     week number. Take the last decided final inside that top week —
  //     that's the title game (semis are earlier in the same week).
  const weekNum = (g: UfaGame): number => {
    const m = (g.week ?? '').match(/^week-(\d+)$/);
    return m ? parseInt(m[1], 10) : -1;
  };
  const maxWeek = Math.max(...finals.map(weekNum));
  if (maxWeek >= 0) {
    const topWeek = finals.filter((g) => weekNum(g) === maxWeek);
    if (topWeek.length > 0) return latest(topWeek);
  }

  // Last resort: the latest decided final overall.
  return latest(finals);
}

export type UfaPlayoffRound = 'championship' | 'semifinal';

// `week` labels that decide the round on their own. No season observed
// (2012-2026) actually uses these, but they're the natural labels for a title
// game if UFA ever adds one, so they stay as a cheap fast path.
const CHAMPIONSHIP_WEEKS = ['championship', 'final', 'finals'];

// `week` labels that mark a season's bracket GROUP without naming the round.
// UFA labels the ENTIRE final weekend with one of these — semis and the title
// game alike ('championship-weekend' in 2012-22, 'semi-finals' in 2023) — so a
// game carrying one is in the bracket but its round still has to be resolved
// positionally, below. Ordered most- to least-specific; the first label present
// in the season wins.
const BRACKET_WEEKS = ['championship-weekend', 'semi-finals', 'semifinals'];

// A season's playoff bracket is small. 2024+ carries no playoff labels at all
// — the bracket is simply the highest `week-N`, which holds exactly 3
// non-all-star games (2 semis + 1 final). Cap the structural path at that size
// so a full regular-season week can never be read as a bracket.
const MAX_BRACKET_GAMES = 4;

function weekNumber(g: UfaGame): number {
  const m = (g.week ?? '').match(/^week-(\d+)$/);
  return m ? parseInt(m[1], 10) : -1;
}

/**
 * Classify a single game as the season's title game or a semifinal, or null for
 * anything else (regular season, all-star, undecidable).
 *
 * `seasonGames` is the full game list for that game's season; it is required
 * because NO season observed (2012-2026) labels its title game as such. Every
 * one either labels the whole final weekend with a single group label
 * ('championship-weekend' in 2012-22, 'semi-finals' in 2023 — yes, the 2023
 * FINAL is labeled 'semi-finals') or carries no playoff label at all (2024+,
 * where the bracket is just the highest `week-N`). In all cases the title game
 * is the last game of the bracket, which no single game can reveal on its own.
 * Pass an empty list and nothing resolves.
 *
 * The all-star exhibition always returns null: it can carry the same
 * `week-16` as the real bracket.
 */
export function ufaPlayoffRound(
  game: UfaGame,
  seasonGames: UfaGame[],
): UfaPlayoffRound | null {
  if (isAllStarGame(game)) return null;

  // (a) A label that names the round outright — decidable from the game alone.
  const wk = (game.week ?? '').toLowerCase();
  if (CHAMPIONSHIP_WEEKS.includes(wk)) return 'championship';

  // Everything below needs the season's bracket for context.
  const bracketPool = seasonGames.filter((g) => !isAllStarGame(g));
  if (bracketPool.length === 0) return null;

  // (b) A bracket-group label ('championship-weekend' in 2012-22, 'semi-finals'
  // in 2023) covers semis AND the final, so the final has to be picked out of
  // the group positionally.
  // (c) 2024+: no labels at all — the bracket is the highest week-N.
  let bracket: UfaGame[] | null = null;
  for (const label of BRACKET_WEEKS) {
    const group = bracketPool.filter((g) => (g.week ?? '').toLowerCase() === label);
    if (group.length === 0) continue;
    // The season uses this label, so its bracket is exactly this group — a game
    // outside it isn't a playoff game.
    if (wk !== label) return null;
    bracket = group;
    break;
  }
  if (!bracket) {
    const gameWeek = weekNumber(game);
    if (gameWeek < 0) return null;
    const maxWeek = Math.max(...bracketPool.map(weekNumber));
    if (gameWeek !== maxWeek) return null;
    bracket = bracketPool.filter((g) => weekNumber(g) === maxWeek);
  }

  if (bracket.length > MAX_BRACKET_GAMES) return null;

  // The final is the last game of the bracket. findChampionshipGame only
  // considers DECIDED finals, so it can't answer while the bracket is still
  // being played; fall back to the latest-scheduled bracket game, which is the
  // title game by construction.
  const decided = findChampionshipGame(bracket);
  const final =
    decided ?? bracket.reduce((a, b) => (gameTs(b) > gameTs(a) ? b : a));

  return final.gameID === game.gameID ? 'championship' : 'semifinal';
}

/**
 * UFA champions by year. Returns a map of `year → teamID` (lowercased).
 *
 * Crucially, a champion is awarded ONLY for a season that is actually
 * complete — i.e. has zero remaining Upcoming/Live games. Mid-season the
 * "latest final played" is just a regular-season result, not a title, so
 * awarding it (the previous behavior) produced a bogus "champion" every
 * weekend. In-progress seasons are omitted from the map entirely.
 *
 * For completed seasons the title game is found via `findChampionshipGame`,
 * which copes with UFA's year-to-year `week`-labeling drift.
 */
export async function getUfaChampionsByYear(years: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  await Promise.all(
    years.map(async (year) => {
      try {
        const games = await getAllGamesByYears([year]);
        if (games.length === 0) return;

        // Gate: season must be over. If ANY game isn't Final yet (Upcoming or
        // an in-play phase like "Fourth Quarter"), the championship hasn't been
        // played — no champion yet. Must classify by isFinalStatus, not by
        // matching a literal "Live" the feed never sends (that bug would let a
        // title-weekend in-progress game slip through and crown a bogus champ).
        const seasonComplete = games.every((g) => isFinalStatus(g.status));
        if (!seasonComplete) return;

        const finalGame = findChampionshipGame(games);
        if (!finalGame) return;

        const winner =
          finalGame.awayScore > finalGame.homeScore
            ? finalGame.awayTeamID
            : finalGame.homeTeamID;
        if (winner) result.set(year, winner.toLowerCase());
      } catch (err) {
        console.error(`getUfaChampionsByYear: failed for ${year}`, err);
      }
    }),
  );
  return result;
}

export interface TeamPodium {
  year: number;
  place: 1 | 2 | 3;
}

/**
 * A UFA team's championship-game finishes by year: 1st (won the final) or 2nd
 * (lost it). We deliberately DO NOT report 3rd — UFA's API gives no reliable
 * semifinal marker (2024+ playoff games are all `week-N`), so we can't identify
 * the losing semifinalists without guessing. Gold + silver only, newest first.
 *
 * Scans every UFA season (2012→current) — `findChampionshipGame`'s label
 * handling is validated across all of them. Only completed seasons yield a
 * result; 2020 (cancelled) returns no games and is skipped.
 */
export async function getUfaTeamPodiums(teamSlug: string): Promise<TeamPodium[]> {
  const current = currentSeasonYear();
  const years: number[] = [];
  for (let y = current; y >= UFA_FIRST_SEASON; y--) years.push(y);
  const slug = teamSlug.toLowerCase();
  const out: TeamPodium[] = [];

  await Promise.all(
    years.map(async (year) => {
      try {
        const games = await getAllGamesByYears([year]);
        if (games.length === 0) return;
        if (!games.every((g) => isFinalStatus(g.status))) return; // season not over
        const finalGame = findChampionshipGame(games);
        if (!finalGame) return;
        const awayWon = finalGame.awayScore > finalGame.homeScore;
        const winner = (awayWon ? finalGame.awayTeamID : finalGame.homeTeamID)?.toLowerCase();
        const loser = (awayWon ? finalGame.homeTeamID : finalGame.awayTeamID)?.toLowerCase();
        if (winner === slug) out.push({ year, place: 1 });
        else if (loser === slug) out.push({ year, place: 2 });
      } catch (err) {
        console.error(`getUfaTeamPodiums: failed for ${year}`, err);
      }
    }),
  );

  return out.sort((a, b) => b.year - a.year);
}

// ── Season helpers ───────────────────────────────────────────────────────────

/** Current UFA season year. Season runs ~April through August; the default
 *  flips to the new year on February 1 (season-windows.ts). */
export function currentSeasonYear(now: Date = new Date()): number {
  return defaultSeason('ufa', now);
}

/** Default years dropdown — most recent down through 2022 (UFA rebrand window). */
export function recentSeasons(n: number = 5): number[] {
  const cur = currentSeasonYear();
  return Array.from({ length: n }, (_, i) => cur - i);
}

// Re-exports for convenience
export type { UfaGame, UfaPlayerStat, UfaStanding, UfaTeamStat };
