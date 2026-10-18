// WUL (Western Ultimate League) data layer — public read-only, from Supabase.
//
// Mirrors src/lib/pul/data.ts. Ingest writes via direct DB connection
// (usau-scraper/scripts/ingest-wul.py); the app reads via the anon publishable
// key. RLS on wul_* is world-readable — same pattern as pul_*/usau_*.
// Uses @supabase/supabase-js (not @supabase/ssr) — no auth cookies needed.
//
// wul_* tables are not in database.types.ts; we cast rows via local interfaces,
// same approach as pul/data.ts. WUL data is per-game (Western Ultimate Stats
// dashboard CSV export) and carries richer advanced stats than PUL (yards,
// hucks, points-played). +/- can be fractional (.5), so it's `number`.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseUrl, supabaseAnonKey } from '@/lib/supabase/env';
import { defaultSeason, pickSeason } from '@/lib/season-windows';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

let _client: AnyClient | null = null;
function supabase(): AnyClient {
  if (_client) return _client;
  _client = createClient(supabaseUrl(), supabaseAnonKey(), {
    auth: { persistSession: false },
  });
  return _client;
}

// ─── DB row shapes ───────────────────────────────────────────────────────────

interface DbTeamRow {
  id: string;
  name: string;
  city: string;
  mascot: string;
  abbr: string | null;
  logo_url: string | null;
  accent_color: string | null;
}

interface DbPlayerRow {
  id: string;
  player_name: string;
  jersey_number: string;
  team_id: string;
  season: number;
  games_played: number;
  goals: number;
  assists: number;
  blocks: number;
  turnovers: number;
  touches: number;
  o_points: number;
  d_points: number;
  plus_minus: number;
  callahans: number;
  hucks_completed: number;
  yards_total: number;
}

// ─── Public types ────────────────────────────────────────────────────────────

export interface WulTeam {
  id: string;
  name: string;
  city: string;
  mascot: string;
  abbr: string | null;
  logoUrl: string | null;
  accentColor: string | null;
}

export interface WulPlayer {
  id: string;
  playerName: string;
  jerseyNumber: string;
  teamId: string;
  season: number;
  gamesPlayed: number;
  goals: number;
  assists: number;
  blocks: number;
  turnovers: number;
  touches: number;
  oPoints: number;
  dPoints: number;
  plusMinus: number;
  callahans: number;
  hucksCompleted: number;
  yardsTotal: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Logos live under /public/teams/wul/ (committed assets), so unlike PUL's R2
// bucket there's no remote-origin assertion needed — they're same-origin paths.
function mapTeam(row: DbTeamRow): WulTeam {
  return {
    id: row.id,
    name: row.name,
    city: row.city,
    mascot: row.mascot,
    abbr: row.abbr,
    logoUrl: row.logo_url,
    accentColor: row.accent_color,
  };
}

function mapPlayer(row: DbPlayerRow): WulPlayer {
  return {
    id: row.id,
    playerName: row.player_name,
    jerseyNumber: row.jersey_number,
    teamId: row.team_id,
    season: row.season,
    gamesPlayed: row.games_played,
    goals: row.goals,
    assists: row.assists,
    blocks: row.blocks,
    turnovers: row.turnovers,
    touches: row.touches,
    oPoints: row.o_points,
    dPoints: row.d_points,
    plusMinus: Number(row.plus_minus),
    callahans: row.callahans,
    hucksCompleted: row.hucks_completed,
    yardsTotal: row.yards_total,
  };
}

const PLAYER_COLS =
  'id, player_name, jersey_number, team_id, season, games_played, goals, assists, blocks, turnovers, touches, o_points, d_points, plus_minus, callahans, hucks_completed, yards_total';

/**
 * Sync fallback for the current WUL season. Calendar-derived (WUL seasons are
 * calendar-year-aligned) so it self-advances instead of being a hardcoded
 * literal. Prefer the async getWulCurrentSeason() where possible — it reads the
 * newest season actually present in the data, so it never points at an empty one.
 */
export const WUL_CURRENT_SEASON = new Date().getFullYear();

/**
 * The newest WUL season that actually has data, or the calendar year if the
 * table is empty/unreachable. Source of truth for "current season" on the
 * visible surfaces — advances on its own when new data is ingested, never
 * selects an empty season. Reuses listWulSeasons(). Never past the WUL default
 * season: next year's schedule lands ~December, before the February flip
 * (season-windows.ts).
 */
export async function getWulCurrentSeason(): Promise<number> {
  try {
    const seasons = await listWulSeasons();
    return pickSeason(seasons, defaultSeason('wul')) ?? WUL_CURRENT_SEASON;
  } catch {
    return WUL_CURRENT_SEASON;
  }
}

/**
 * The newest WUL season with a completed game — the default for results,
 * rosters and stats. Differs from getWulCurrentSeason() pre-season: the next
 * season's schedule lands ~December, months before any of its finals or player
 * rows exist, and those surfaces would open empty until spring.
 */
export async function getWulResultsSeason(): Promise<number> {
  try {
    const { data, error } = await supabase()
      .from('wul_games')
      .select('season')
      .eq('status', 'final')
      .lte('season', defaultSeason('wul'))
      .order('season', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data as { season: number } | null)?.season ?? WUL_CURRENT_SEASON;
  } catch {
    return WUL_CURRENT_SEASON;
  }
}

// ─── Teams ───────────────────────────────────────────────────────────────────

export async function listWulTeams(): Promise<WulTeam[]> {
  const db = supabase();
  const { data, error } = await db.from('wul_teams').select('*').order('name');
  if (error) throw error;
  return ((data ?? []) as unknown as DbTeamRow[]).map(mapTeam);
}

/**
 * Team ids that played at least one game in a given season. Used to hide
 * inactive/folded franchises (e.g. a team with 0 games this year) from
 * season-scoped surfaces like the Teams grid and standings — while keeping the
 * full team list (`listWulTeams`) intact for logo lookups, career resolution,
 * and historical browsing.
 */
export async function listWulActiveTeamIds(season: number): Promise<Set<string>> {
  const db = supabase();
  const { data, error } = await db
    .from('wul_games')
    .select('away_team_id, home_team_id')
    .eq('season', season);
  if (error) throw error;
  const active = new Set<string>();
  for (const r of (data ?? []) as unknown as {
    away_team_id: string;
    home_team_id: string;
  }[]) {
    active.add(r.away_team_id);
    active.add(r.home_team_id);
  }
  return active;
}

/**
 * Teams that are active in a given season (played ≥1 game). Powers the Teams
 * page grid so folded franchises with no games this season don't appear.
 * Defaults to the current WUL season.
 */
export async function listActiveWulTeams(
  season = WUL_CURRENT_SEASON,
): Promise<WulTeam[]> {
  const [teams, active] = await Promise.all([
    listWulTeams(),
    listWulActiveTeamIds(season),
  ]);
  return teams.filter((t) => active.has(t.id));
}

export async function getWulTeam(teamId: string): Promise<WulTeam | null> {
  const db = supabase();
  const { data, error } = await db.from('wul_teams').select('*').eq('id', teamId).maybeSingle();
  if (error) throw error;
  return data ? mapTeam(data as unknown as DbTeamRow) : null;
}

// ─── Players ─────────────────────────────────────────────────────────────────

export async function getWulRoster(
  teamId: string,
  season = WUL_CURRENT_SEASON,
): Promise<WulPlayer[]> {
  const db = supabase();
  const { data, error } = await db
    .from('wul_players')
    .select(PLAYER_COLS)
    .eq('team_id', teamId)
    .eq('season', season);
  if (error) throw error;
  const rows = ((data ?? []) as unknown as DbPlayerRow[]).map(mapPlayer);
  rows.sort((a, b) => {
    const sa = a.goals + a.assists;
    const sb = b.goals + b.assists;
    if (sb !== sa) return sb - sa;
    return a.playerName.localeCompare(b.playerName);
  });
  return rows;
}

export async function getWulPlayer(id: string): Promise<WulPlayer | null> {
  const db = supabase();
  const { data, error } = await db.from('wul_players').select(PLAYER_COLS).eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? mapPlayer(data as unknown as DbPlayerRow) : null;
}

/** Distinct seasons that have WUL data, newest first. */
export async function listWulSeasons(): Promise<number[]> {
  const db = supabase();
  const { data, error } = await db.from('wul_games').select('season');
  if (error) throw error;
  const seen = new Set<number>();
  for (const r of (data ?? []) as unknown as { season: number }[]) seen.add(r.season);
  return [...seen].sort((a, b) => b - a);
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────

export type WulSortField =
  | 'goals'
  | 'assists'
  | 'blocks'
  | 'plus_minus'
  | 'o_points'
  | 'd_points'
  | 'touches'
  | 'games_played'
  | 'hucks_completed'
  | 'yards_total';

/** All WUL players for a season, optionally sorted. Default: goals desc. */
export async function listWulPlayers(opts?: {
  season?: number;
  sortBy?: WulSortField;
  limit?: number;
}): Promise<WulPlayer[]> {
  const db = supabase();
  const sortBy: WulSortField = opts?.sortBy ?? 'goals';
  const season = opts?.season ?? WUL_CURRENT_SEASON;

  const { data, error } = await db
    .from('wul_players')
    .select(PLAYER_COLS)
    .eq('season', season)
    .order(sortBy, { ascending: false })
    .limit(opts?.limit ?? 500);

  if (error) throw error;
  return ((data ?? []) as unknown as DbPlayerRow[]).map(mapPlayer);
}

/** Lean player-search hit: one row per distinct name, most-recent season. */
export interface WulPlayerSearchHit {
  id: string;
  playerName: string;
  teamId: string;
  teamName: string | null;
}

/**
 * DB-side fuzzy player search (pg_trgm) via search_wul_players_fuzzy — name-
 * filtered in Postgres, replacing the fetch-whole-roster-then-filter path.
 */
export async function searchWulPlayers(
  query: string,
  limit = 12,
): Promise<WulPlayerSearchHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const db = supabase();
  const { data, error } = await db.rpc('search_wul_players_fuzzy', { q, lim: limit });
  if (error) throw error;
  return ((data ?? []) as {
    id: string; player_name: string; team_id: string; team_name: string | null;
  }[]).map((r) => ({
    id: r.id,
    playerName: r.player_name,
    teamId: r.team_id,
    teamName: r.team_name ?? null,
  }));
}

// ─── Career (cross-season + cross-league) ──────────────────────────────────────

export interface WulSeasonStint {
  season: number;
  teamId: string;
  player: WulPlayer;
}

export interface WulPlayerCareer {
  anchorId: string;
  playerName: string;
  stints: WulSeasonStint[];
  career: {
    seasonsPlayed: number;
    gamesPlayed: number;
    goals: number;
    assists: number;
    blocks: number;
    turnovers: number;
    touches: number;
    plusMinus: number;
  };
}

/** Full WUL career by NAME (case-insensitive). WUL has no cross-season player
 *  id (separate rows per season), so name is the join key — same model as PUL
 *  and the unified cross-league identity. Returns null if no rows. */
export async function getWulPlayerCareerByName(
  playerName: string,
): Promise<WulPlayerCareer | null> {
  const db = supabase();
  const { data, error } = await db
    .from('wul_players')
    .select(PLAYER_COLS)
    .ilike('player_name', playerName)
    .order('season', { ascending: false });
  if (error) throw error;
  const rows = ((data ?? []) as unknown as DbPlayerRow[]).map(mapPlayer);
  if (rows.length === 0) return null;

  const stints: WulSeasonStint[] = rows.map((p) => ({
    season: p.season,
    teamId: p.teamId,
    player: p,
  }));
  const career = rows.reduce(
    (acc, p) => ({
      seasonsPlayed: acc.seasonsPlayed + 1,
      gamesPlayed: acc.gamesPlayed + p.gamesPlayed,
      goals: acc.goals + p.goals,
      assists: acc.assists + p.assists,
      blocks: acc.blocks + p.blocks,
      turnovers: acc.turnovers + p.turnovers,
      touches: acc.touches + p.touches,
      plusMinus: acc.plusMinus + p.plusMinus,
    }),
    { seasonsPlayed: 0, gamesPlayed: 0, goals: 0, assists: 0, blocks: 0, turnovers: 0, touches: 0, plusMinus: 0 },
  );
  return { anchorId: rows[0].id, playerName: rows[0].playerName, stints, career };
}

/** Find a WUL player's canonical stored name by a candidate name, using the
 *  shared cross-league token-subset match. Used by the unified profile to
 *  attach a WUL career to a UFA/USAU/PUL anchor. */
export async function findWulPlayerNameByName(candidate: string): Promise<string | null> {
  const tokens = candidate.trim().split(/\s+/);
  const surname = tokens[tokens.length - 1];
  if (!surname) return null;
  const db = supabase();
  const { data, error } = await db
    .from('wul_players')
    .select('player_name')
    .ilike('player_name', `%${surname}%`);
  if (error) throw error;
  const names = [...new Set(((data ?? []) as unknown as { player_name: string }[]).map((r) => r.player_name))];
  const [{ namesMatch }, { loadNameAliases }] = await Promise.all([
    import('@/lib/name-match'),
    import('@/lib/name-aliases'),
  ]);
  const aliases = await loadNameAliases();
  for (const name of names) {
    if (namesMatch(candidate, name, aliases)) return name;
  }
  return null;
}

// ─── Games (scores + schedule) ─────────────────────────────────────────────────

export interface WulGameTeamSide {
  teamId: string;
  abbrev: string;
  city: string | null;
  mascot: string | null;
  logoUrl: string | null;
  accentColor: string | null;
  score: number | null;
}

export interface WulGame {
  id: string;            // '{season}/{date}/{AWAY}-vs-{HOME}'
  season: number;
  weekLabel: string;     // 'regular' | 'post'
  gameDate: string | null;
  gameTime: string | null; // scheduled rows only, preformatted e.g. '7:30pm PT'
  status: 'scheduled' | 'final';
  away: WulGameTeamSide;
  home: WulGameTeamSide;
}

interface DbGameRow {
  id: string;
  season: number;
  week_label: string;
  game_date: string | null;
  game_time: string | null;
  away_team_id: string;
  home_team_id: string;
  away_abbrev: string;
  home_abbrev: string;
  away_score: number | null;
  home_score: number | null;
  status: string;
}

const GAME_COLS =
  'id, season, week_label, game_date, game_time, away_team_id, home_team_id, away_abbrev, home_abbrev, away_score, home_score, status';

function buildSide(
  byId: Map<string, WulTeam>,
  teamId: string,
  abbrev: string,
  score: number | null,
): WulGameTeamSide {
  const t = byId.get(teamId);
  return {
    teamId,
    abbrev,
    city: t?.city ?? null,
    mascot: t?.mascot ?? null,
    logoUrl: t?.logoUrl ?? null,
    accentColor: t?.accentColor ?? null,
    score,
  };
}

function mapGame(r: DbGameRow, byId: Map<string, WulTeam>): WulGame {
  return {
    id: r.id,
    season: r.season,
    weekLabel: r.week_label,
    gameDate: r.game_date,
    gameTime: r.game_time,
    status: r.status === 'final' ? 'final' : 'scheduled',
    away: buildSide(byId, r.away_team_id, r.away_abbrev, r.away_score),
    home: buildSide(byId, r.home_team_id, r.home_abbrev, r.home_score),
  };
}

/** All games for a season, chronological (regular before post, then date). */
export async function listWulGames(opts: {
  season: number;
  onlyFinal?: boolean;
}): Promise<WulGame[]> {
  const db = supabase();
  let q = db.from('wul_games').select(GAME_COLS).eq('season', opts.season);
  if (opts.onlyFinal) q = q.eq('status', 'final');
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as unknown as DbGameRow[];

  const teams = await listWulTeams();
  const byId = new Map(teams.map((t) => [t.id, t]));
  const games = rows.map((r) => mapGame(r, byId));

  const weekRank = (label: string) => (label === 'post' ? 1 : 0);
  games.sort((a, b) => {
    const wa = weekRank(a.weekLabel);
    const wb = weekRank(b.weekLabel);
    if (wa !== wb) return wa - wb;
    return (a.gameDate ?? '').localeCompare(b.gameDate ?? '');
  });
  return games;
}

// ─── Postseason round derivation ───────────────────────────────────────────────
// The source only tags playoff games as week_label='post' (no semi/final
// distinction). But WUL's championship-weekend format is consistent across every
// season (2022–2026, verified): Day 1 = the two semifinals; Day 2 = the final
// (both teams won their Day-1 game) plus an optional 3rd-place game (both teams
// lost Day 1). So we can derive the round purely from date + who advanced — no
// DB change or re-scrape needed.

export type WulPostseasonRound = 'final' | 'semifinal' | 'third_place';

/** Classify a season's postseason games into final / semifinal / 3rd-place.
 *  Input may be a full game list or just the post games; non-post games are
 *  ignored. Returns a Map from game id → round. Games that don't fit the
 *  two-day format (e.g. a partial/in-progress bracket) are left unclassified
 *  and simply won't appear in the map. */
export function deriveWulPostseasonRounds(games: WulGame[]): Map<string, WulPostseasonRound> {
  const out = new Map<string, WulPostseasonRound>();
  const post = games.filter((g) => g.weekLabel === 'post' && g.status === 'final' && g.gameDate);
  if (post.length === 0) return out;

  // Bucket by date; earliest day(s) are semis, the last day is championship.
  const byDate = new Map<string, WulGame[]>();
  for (const g of post) {
    const d = g.gameDate as string;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(g);
  }
  const dates = [...byDate.keys()].sort();
  if (dates.length < 2) {
    // Only one day of data so far (e.g. semis played, final not yet) — treat
    // every game as a semifinal until the championship day exists.
    for (const g of post) out.set(g.id, 'semifinal');
    return out;
  }

  const finalDay = dates[dates.length - 1];
  const semiGames = dates.slice(0, -1).flatMap((d) => byDate.get(d)!);
  const winners = new Set<string>();
  for (const g of semiGames) {
    out.set(g.id, 'semifinal');
    const w =
      g.home.score !== null && g.away.score !== null && g.home.score > g.away.score
        ? g.home.teamId
        : g.away.teamId;
    winners.add(w);
  }

  // On the final day: the game between the two semifinal winners is the final;
  // any other game (both teams were semifinal losers) is the 3rd-place game.
  for (const g of byDate.get(finalDay)!) {
    const bothWon = winners.has(g.home.teamId) && winners.has(g.away.teamId);
    out.set(g.id, bothWon ? 'final' : 'third_place');
  }
  return out;
}

// ─── Standings ─────────────────────────────────────────────────────────────

/** A team's derived regular-season standing. WUL is a single division. */
export interface WulStandingRow {
  team: WulTeam;
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDiff: number;
  /** True if this team won the season's championship (final) game. */
  champion: boolean;
}

/**
 * Season standings for WUL, derived from final games (no standings table).
 * Regular-season record only (postseason games excluded from W-L), sorted by
 * wins → point differential. The championship winner (via
 * deriveWulPostseasonRounds) is flagged `champion` so the UI can badge them.
 */
export async function getWulStandings(season: number): Promise<WulStandingRow[]> {
  const [teams, games] = await Promise.all([
    listWulTeams(),
    listWulGames({ season, onlyFinal: true }),
  ]);

  // Champion = winner of the derived 'final' game.
  const rounds = deriveWulPostseasonRounds(games);
  let champion: string | null = null;
  for (const g of games) {
    if (rounds.get(g.id) !== 'final') continue;
    if (g.home.score == null || g.away.score == null) continue;
    champion = g.home.score > g.away.score ? g.home.teamId : g.away.teamId;
  }

  const rec = new Map<
    string,
    { wins: number; losses: number; pointsFor: number; pointsAgainst: number }
  >();
  const ensure = (id: string) => {
    if (!rec.has(id)) rec.set(id, { wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0 });
    return rec.get(id)!;
  };

  for (const g of games) {
    if (g.weekLabel === 'post') continue; // regular season only
    const a = g.away.score;
    const h = g.home.score;
    if (a == null || h == null || a === h) continue;
    const home = ensure(g.home.teamId);
    const away = ensure(g.away.teamId);
    home.pointsFor += h;
    home.pointsAgainst += a;
    away.pointsFor += a;
    away.pointsAgainst += h;
    if (h > a) {
      home.wins += 1;
      away.losses += 1;
    } else {
      away.wins += 1;
      home.losses += 1;
    }
  }

  return teams
    // Drop teams with no regular-season game this season (e.g. folded
    // franchises). A team must have actually played to appear in standings.
    .filter((team) => rec.has(team.id))
    .map((team) => {
      const r = rec.get(team.id)!;
      return {
        team,
        wins: r.wins,
        losses: r.losses,
        pointsFor: r.pointsFor,
        pointsAgainst: r.pointsAgainst,
        pointDiff: r.pointsFor - r.pointsAgainst,
        champion: team.id === champion,
      };
    })
    .sort(
      (a, b) =>
        b.wins - a.wins ||
        b.pointDiff - a.pointDiff ||
        a.team.name.localeCompare(b.team.name),
    );
}

export interface TeamPodium {
  year: number;
  place: 1 | 2 | 3;
}

/**
 * Every podium (top-3) finish for a WUL team across all seasons.
 *   1st = Final winner, 2nd = Final loser, 3rd = 3rd-place-game winner.
 * (WUL plays an explicit 3rd-place game, so bronze is that winner — the loser
 * is 4th and gets no medal.) Newest first.
 */
export async function getWulTeamPodiums(teamId: string): Promise<TeamPodium[]> {
  const seasons = await listWulSeasons().catch(() => [] as number[]);
  const out: TeamPodium[] = [];

  for (const year of seasons) {
    const games = await listWulGames({ season: year, onlyFinal: true }).catch(
      () => [] as WulGame[],
    );
    const rounds = deriveWulPostseasonRounds(games);

    for (const g of games) {
      const round = rounds.get(g.id);
      if (!round) continue;
      const a = g.away;
      const h = g.home;
      if (a.score == null || h.score == null || a.score === h.score) continue;
      const winner = a.score > h.score ? a.teamId : h.teamId;
      const loser = a.score > h.score ? h.teamId : a.teamId;

      if (round === 'final') {
        if (winner === teamId) out.push({ year, place: 1 });
        else if (loser === teamId) out.push({ year, place: 2 });
      } else if (round === 'third_place') {
        if (winner === teamId) out.push({ year, place: 3 });
      }
    }
  }

  const best = new Map<number, 1 | 2 | 3>();
  for (const m of out) {
    const cur = best.get(m.year);
    if (cur == null || m.place < cur) best.set(m.year, m.place);
  }
  return [...best.entries()]
    .map(([year, place]) => ({ year, place }))
    .sort((x, y) => y.year - x.year);
}

/** One game by id. Returns null if not found. Powers /wul/g/[...id]. */
export async function getWulGame(id: string): Promise<WulGame | null> {
  const db = supabase();
  const { data, error } = await db.from('wul_games').select(GAME_COLS).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const teams = await listWulTeams();
  const byId = new Map(teams.map((t) => [t.id, t]));
  return mapGame(data as unknown as DbGameRow, byId);
}

// ─── Per-game box score ────────────────────────────────────────────────────────

export interface WulBoxscoreRow {
  playerName: string;
  jerseyNumber: string | null;
  goals: number;
  assists: number;
  blocks: number;
  turnovers: number;
  touches: number;
  oPoints: number;
  dPoints: number;
  pointsPlayed: number;
  plusMinus: number;
  totalYards: number;
  completions: number;
  throws: number;
  /** wul_players.id for the SAME season — link target for /players/[id]. */
  profileId: string | null;
}

export interface WulGameBoxscore {
  away: WulBoxscoreRow[];
  home: WulBoxscoreRow[];
}

interface DbGameStatRow {
  team_id: string;
  player_name: string;
  jersey_number: string | null;
  goals: number;
  assists: number;
  blocks: number;
  turnovers: number;
  touches: number;
  o_points: number;
  d_points: number;
  points_played: number;
  plus_minus: number;
  total_yards: number;
  completions: number;
  throws: number;
}

/** Full per-player box score for one game, split into away/home by team_id,
 *  each row carrying profileId (same-season wul_players.id) for /players/[id]
 *  links. Sorted by goals+assists desc, then name. */
export async function getWulGameBoxscore(
  game: Pick<WulGame, 'id' | 'season' | 'away' | 'home'>,
): Promise<WulGameBoxscore> {
  const db = supabase();
  const { data, error } = await db
    .from('wul_game_player_stats')
    .select(
      'team_id, player_name, jersey_number, goals, assists, blocks, turnovers, touches, o_points, d_points, points_played, plus_minus, total_yards, completions, throws',
    )
    .eq('game_id', game.id);
  if (error) throw error;
  const statRows = (data ?? []) as unknown as DbGameStatRow[];
  if (statRows.length === 0) return { away: [], home: [] };

  // Resolve player_name → same-season profile id in one query.
  const names = [...new Set(statRows.map((r) => r.player_name))];
  const { data: profileRows } = await db
    .from('wul_players')
    .select('id, player_name')
    .eq('season', game.season)
    .in('player_name', names);
  const idByName = new Map(
    ((profileRows ?? []) as unknown as { id: string; player_name: string }[]).map((p) => [
      p.player_name.toLowerCase(),
      p.id,
    ]),
  );

  const map = (r: DbGameStatRow): WulBoxscoreRow => ({
    playerName: r.player_name,
    jerseyNumber: r.jersey_number ?? null,
    goals: r.goals,
    assists: r.assists,
    blocks: r.blocks,
    turnovers: r.turnovers,
    touches: r.touches,
    oPoints: r.o_points,
    dPoints: r.d_points,
    pointsPlayed: r.points_played,
    plusMinus: Number(r.plus_minus),
    totalYards: r.total_yards,
    completions: r.completions,
    throws: r.throws,
    profileId: idByName.get(r.player_name.toLowerCase()) ?? null,
  });
  const sortRows = (rows: WulBoxscoreRow[]) =>
    rows.sort((a, b) => {
      const sa = a.goals + a.assists;
      const sb = b.goals + b.assists;
      if (sb !== sa) return sb - sa;
      return a.playerName.localeCompare(b.playerName);
    });

  return {
    away: sortRows(statRows.filter((r) => r.team_id === game.away.teamId).map(map)),
    home: sortRows(statRows.filter((r) => r.team_id === game.home.teamId).map(map)),
  };
}

// ─── Per-player game log (for the unified profile's season dropdown) ─────────

/** One WUL game from a single player's perspective: their stat line + the
 *  matchup context (opponent, date, result). */
export interface WulPlayerGameRow {
  gameId: string;
  date: string | null;
  weekLabel: string;
  opponentAbbrev: string | null;
  /** 'W' | 'L' | null (null = no final score). From the player's team POV. */
  result: 'W' | 'L' | null;
  teamScore: number | null;
  oppScore: number | null;
  goals: number;
  assists: number;
  blocks: number;
  turnovers: number;
  touches: number;
  pointsPlayed: number;
  plusMinus: number;
  totalYards: number;
}

/**
 * A WUL player's game-by-game log for one season. Matches by player_name (the
 * box-score rows store name, not a stable id). Joins wul_games for the matchup
 * so the profile can show opponent + result per game. Sorted by date asc.
 */
export async function getWulPlayerGameLog(
  playerName: string,
  season: number,
): Promise<WulPlayerGameRow[]> {
  const db = supabase();
  const { data, error } = await db
    .from('wul_game_player_stats')
    .select(
      'game_id, team_id, goals, assists, blocks, turnovers, touches, points_played, plus_minus, total_yards, ' +
        'wul_games!inner(id, game_date, week_label, away_team_id, home_team_id, away_abbrev, home_abbrev, away_score, home_score, season)',
    )
    .eq('player_name', playerName)
    .eq('wul_games.season', season);
  if (error) throw error;

  type Row = {
    game_id: string;
    team_id: string;
    goals: number;
    assists: number;
    blocks: number;
    turnovers: number;
    touches: number;
    points_played: number;
    plus_minus: number;
    total_yards: number;
    wul_games: {
      id: string;
      game_date: string | null;
      week_label: string;
      away_team_id: string;
      home_team_id: string;
      away_abbrev: string;
      home_abbrev: string;
      away_score: number | null;
      home_score: number | null;
    } | null;
  };

  const rows = (data ?? []) as unknown as Row[];
  const out: WulPlayerGameRow[] = [];
  for (const r of rows) {
    const g = r.wul_games;
    if (!g) continue;
    const isHome = r.team_id === g.home_team_id;
    const teamScore = isHome ? g.home_score : g.away_score;
    const oppScore = isHome ? g.away_score : g.home_score;
    const opponentAbbrev = isHome ? g.away_abbrev : g.home_abbrev;
    let result: 'W' | 'L' | null = null;
    if (teamScore != null && oppScore != null && teamScore !== oppScore) {
      result = teamScore > oppScore ? 'W' : 'L';
    }
    out.push({
      gameId: g.id,
      date: g.game_date,
      weekLabel: g.week_label,
      opponentAbbrev,
      result,
      teamScore,
      oppScore,
      goals: r.goals,
      assists: r.assists,
      blocks: r.blocks,
      turnovers: r.turnovers,
      touches: r.touches,
      pointsPlayed: r.points_played,
      plusMinus: Number(r.plus_minus),
      totalYards: r.total_yards,
    });
  }
  out.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  return out;
}
