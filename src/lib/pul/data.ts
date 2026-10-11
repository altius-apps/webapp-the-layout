// PUL (Premier Ultimate League) data layer — public read-only, from Supabase.
//
// Backfill writes via service role; the app reads via the anon publishable key.
// RLS on pul_* is world-readable — same pattern as usau_* and twelve_oh_*.
// Uses @supabase/supabase-js (not @supabase/ssr) — no auth cookies needed.
//
// pul_* tables are not yet in database.types.ts (regenerate after first backfill).
// We cast rows explicitly via local interfaces — same unknown-cast pattern as
// usau/data.ts and twelve-oh/data.ts.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseUrl, supabaseAnonKey } from '@/lib/supabase/env';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

let _client: AnyClient | null = null;

function supabase(): AnyClient {
  if (_client) return _client;
  _client = createClient(
    supabaseUrl(),
    supabaseAnonKey(),
    { auth: { persistSession: false } },
  );
  return _client;
}

// ─── Internal DB row shapes ──────────────────────────────────────────────────

interface DbTeamRow {
  id: string;
  name: string;
  city: string;
  mascot: string;
  logo_url: string | null;
  accent_color: string | null;
}

interface DbPlayerRow {
  id: string;
  player_name: string;
  jersey_number: string;
  pronouns: string | null;
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
}

// ─── Public Types ────────────────────────────────────────────────────────────

export interface PulTeam {
  id: string;           // slug: 'atlanta'
  name: string;         // 'Atlanta Soul'
  city: string;
  mascot: string;
  logoUrl: string | null;
  accentColor: string | null; // e.g. '#87CEEB' from island _accentColor
}

export interface PulPlayer {
  id: string;           // uuid
  playerName: string;
  jerseyNumber: string;
  pronouns: string | null;
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
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Logos are self-hosted committed assets under /public/teams/PUL/<id>.png (one
// per team id), same idiom as WUL — no remote R2 dependency, no image-transform
// quota exposure, and New York (which never had an R2 logo) works too. Derived
// from the team id, so the DB logo_url column is no longer read for rendering.
const PUL_TEAM_IDS = new Set([
  'atlanta', 'austin', 'columbus', 'dc', 'indy', 'la', 'medellin', 'milwaukee',
  'minnesota', 'nashville', 'newyork', 'philadelphia', 'portland', 'raleigh',
]);
function pulLogoPath(id: string): string | null {
  return PUL_TEAM_IDS.has(id) ? `/teams/PUL/${id}.png` : null;
}

function mapTeam(row: DbTeamRow): PulTeam {
  return {
    id: row.id,
    name: row.name,
    city: row.city,
    mascot: row.mascot,
    logoUrl: pulLogoPath(row.id),
    accentColor: row.accent_color ?? null,
  };
}

function mapPlayer(row: DbPlayerRow): PulPlayer {
  return {
    id: row.id,
    playerName: row.player_name,
    jerseyNumber: row.jersey_number,
    pronouns: row.pronouns ?? null,
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
    plusMinus: row.plus_minus,
  };
}

// ─── Season constants ──────────────────────────────────────────────────────────

/**
 * Sync fallback for the current PUL season. Calendar-derived (PUL seasons are
 * calendar-year-aligned) so it self-advances instead of being a hardcoded
 * literal someone has to bump each year. Prefer the async getPulCurrentSeason()
 * where possible — it reads the newest season actually present in the data, so
 * it never points at a season with no games yet.
 */
export const PUL_CURRENT_SEASON = new Date().getFullYear();

/**
 * The newest PUL season in pul_games, or the calendar year if the table is
 * empty/unreachable. This is the source of truth for "current season" on the
 * visible surfaces (home, standings, default views). Read from GAMES, like
 * getWulCurrentSeason: the new season's schedule lands weeks before any of its
 * player rows, and a players-derived season kept the home page on last season
 * through the new season's opening weekend. One row.
 */
export async function getPulCurrentSeason(): Promise<number> {
  try {
    const { data, error } = await supabase()
      .from('pul_games')
      .select('season')
      .order('season', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data as { season: number } | null)?.season ?? PUL_CURRENT_SEASON;
  } catch {
    return PUL_CURRENT_SEASON;
  }
}

/**
 * Distinct seasons that have player data, newest first. Drives the season
 * switcher on PUL pages. pul_players is past PostgREST's 1000-row response cap,
 * so it is paged — a single read silently drops rows.
 */
export async function listPulSeasons(): Promise<number[]> {
  const db = supabase();
  const seen = new Set<number>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('pul_players')
      .select('season')
      .order('season', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as { season: number }[];
    for (const row of rows) seen.add(row.season);
    if (rows.length < PAGE) break;
  }
  return [...seen].sort((a, b) => b - a);
}

// ─── Teams ───────────────────────────────────────────────────────────────────

/** All 13 PUL teams, alphabetical by name. */
export async function listPulTeams(): Promise<PulTeam[]> {
  const db = supabase();
  const { data, error } = await db
    .from('pul_teams')
    .select('id, name, city, mascot, logo_url, accent_color')
    .order('name', { ascending: true });

  if (error) throw error;

  return ((data ?? []) as unknown as DbTeamRow[]).map(mapTeam);
}

/** Single team by slug, or null. */
export async function getPulTeam(teamId: string): Promise<PulTeam | null> {
  const db = supabase();
  const { data, error } = await db
    .from('pul_teams')
    .select('id, name, city, mascot, logo_url, accent_color')
    .eq('id', teamId)
    .maybeSingle();

  if (error) throw error;
  return data ? mapTeam(data as unknown as DbTeamRow) : null;
}

/**
 * Lightweight team list for the GAMES mega-menu preview — name + logo only,
 * ordered by city for a stable grid. Mirrors listTopUsauTeams' role.
 */
export async function listTopPulTeams(): Promise<
  { id: string; name: string; city: string; logoUrl: string | null }[]
> {
  const teams = await listPulTeams();
  return teams
    .slice()
    .sort((a, b) => a.city.localeCompare(b.city))
    .map((t) => ({ id: t.id, name: t.name, city: t.city, logoUrl: t.logoUrl }));
}

// ─── Roster ──────────────────────────────────────────────────────────────────

/**
 * All players for a given team in a season, sorted by (goals + assists) desc.
 * Default season is 2025.
 */
export async function getPulRoster(
  teamId: string,
  season = PUL_CURRENT_SEASON,
): Promise<PulPlayer[]> {
  const db = supabase();
  const { data, error } = await db
    .from('pul_players')
    .select('id, player_name, jersey_number, pronouns, team_id, season, games_played, goals, assists, blocks, turnovers, touches, o_points, d_points, plus_minus')
    .eq('team_id', teamId)
    .eq('season', season)
    .order('goals', { ascending: false });

  if (error) throw error;

  // Secondary sort: goals desc is the DB order; sort assists desc as tiebreak client-side.
  const rows = ((data ?? []) as unknown as DbPlayerRow[]).map(mapPlayer);
  rows.sort((a, b) => {
    const scoreA = a.goals + a.assists;
    const scoreB = b.goals + b.assists;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.playerName.localeCompare(b.playerName);
  });
  return rows;
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────

export type PulSortField = 'goals' | 'assists' | 'blocks' | 'plus_minus' | 'o_points' | 'd_points' | 'touches' | 'games_played';

/**
 * All PUL players for a season, optionally sorted.
 * Default: goals desc. Useful for a leaderboard page.
 */
export async function listPulPlayers(opts?: {
  season?: number;
  sortBy?: PulSortField;
  limit?: number;
}): Promise<PulPlayer[]> {
  const db = supabase();
  const sortBy: PulSortField = opts?.sortBy ?? 'goals';
  const season = opts?.season ?? PUL_CURRENT_SEASON;

  const { data, error } = await db
    .from('pul_players')
    .select('id, player_name, jersey_number, pronouns, team_id, season, games_played, goals, assists, blocks, turnovers, touches, o_points, d_points, plus_minus')
    .eq('season', season)
    .order(sortBy, { ascending: false })
    .limit(opts?.limit ?? 500);

  if (error) throw error;

  return ((data ?? []) as unknown as DbPlayerRow[]).map(mapPlayer);
}

/** Lean player-search hit: one row per distinct name, most-recent season. */
export interface PulPlayerSearchHit {
  id: string;
  playerName: string;
  teamId: string;
  teamName: string | null;
}

/**
 * DB-side fuzzy player search (pg_trgm). Name-filtered in Postgres via the
 * search_pul_players_fuzzy RPC — replaces pulling the whole roster and
 * filtering in Node. Returns at most `limit` (RPC clamps to 50).
 */
export async function searchPulPlayers(
  query: string,
  limit = 12,
): Promise<PulPlayerSearchHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const db = supabase();
  const { data, error } = await db.rpc('search_pul_players_fuzzy', { q, lim: limit });
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

// ─── Player profile / career ─────────────────────────────────────────────────

/** One season-stint of a PUL player's career (their row for a given season). */
export interface PulSeasonStint {
  season: number;
  teamId: string;
  player: PulPlayer;
}

/** A PUL player's full career: identity + every season stint, newest first. */
export interface PulPlayerCareer {
  /** The row id used to anchor the profile (most-recent season's row). */
  anchorId: string;
  playerName: string;
  pronouns: string | null;
  stints: PulSeasonStint[];   // newest season first
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

/** Single player row by uuid, or null. */
export async function getPulPlayer(id: string): Promise<PulPlayer | null> {
  const db = supabase();
  const { data, error } = await db
    .from('pul_players')
    .select('id, player_name, jersey_number, pronouns, team_id, season, games_played, goals, assists, blocks, turnovers, touches, o_points, d_points, plus_minus')
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return data ? mapPlayer(data as unknown as DbPlayerRow) : null;
}

/**
 * Assemble a player's full PUL career by NAME (case-insensitive exact match on
 * the stored player_name). PUL has no canonical player id across seasons — the
 * same human appears as separate rows per season — so name is the join key,
 * same as the cross-league identity model. Returns null if no rows.
 */
export async function getPulPlayerCareerByName(
  playerName: string,
): Promise<PulPlayerCareer | null> {
  const db = supabase();
  const { data, error } = await db
    .from('pul_players')
    .select('id, player_name, jersey_number, pronouns, team_id, season, games_played, goals, assists, blocks, turnovers, touches, o_points, d_points, plus_minus')
    .ilike('player_name', playerName)
    .order('season', { ascending: false });

  if (error) throw error;

  const rows = ((data ?? []) as unknown as DbPlayerRow[]).map(mapPlayer);
  if (rows.length === 0) return null;

  const stints: PulSeasonStint[] = rows.map((p) => ({
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

  return {
    anchorId: rows[0].id,   // most-recent season's row id
    playerName: rows[0].playerName,
    pronouns: rows.find((r) => r.pronouns)?.pronouns ?? null,
    stints,
    career,
  };
}

/**
 * Find a PUL player's canonical stored name by a candidate name, using the
 * shared cross-league name-match rule (token-subset). Returns the matched
 * stored player_name (so the caller can build a career), or null.
 *
 * Used by the unified cross-league profile to attach a PUL career to a
 * UFA/USAU anchor. Prefilters by surname via ilike, then applies namesMatch.
 */
export async function findPulPlayerNameByName(
  candidate: string,
): Promise<string | null> {
  const tokens = candidate.trim().split(/\s+/);
  const surname = tokens[tokens.length - 1];
  if (!surname) return null;

  const db = supabase();
  const { data, error } = await db
    .from('pul_players')
    .select('player_name')
    .ilike('player_name', `%${surname}%`);

  if (error) throw error;

  const names = [...new Set(((data ?? []) as unknown as { player_name: string }[]).map((r) => r.player_name))];
  // Lazy import to keep this module free of a hard dep cycle at top level.
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

// ─── Games (schedule + scores) ───────────────────────────────────────────────

export interface PulGameTeamSide {
  teamId: string;
  abbrev: string;
  /** Resolved from pul_teams; null if the team row is missing. */
  city: string | null;
  mascot: string | null;
  logoUrl: string | null;
  accentColor: string | null; // team brand color, for score block + bars
  score: number | null; // null until the game is final
}

export interface PulGame {
  id: string;            // '{season}/{week}/{AWAY}-vs-{HOME}'
  season: number;
  weekLabel: string;     // 'week-7' | 'semifinals' | 'finals'
  weekNum: number | null;
  status: 'scheduled' | 'final';
  gameDate: string | null; // ISO yyyy-mm-dd
  gameTime: string | null;
  location: string | null;
  away: PulGameTeamSide;
  home: PulGameTeamSide;
}

interface DbGameRow {
  id: string;
  season: number;
  week_label: string;
  week_num: number | null;
  away_team_id: string;
  home_team_id: string;
  away_abbrev: string;
  home_abbrev: string;
  game_date: string | null;
  game_time: string | null;
  location: string | null;
  away_score: number | null;
  home_score: number | null;
  status: string;
}

/**
 * All games for a season, chronological (date asc; playoffs after weeks via a
 * stable ordering), with each side's team identity + logo resolved.
 *
 * `onlyFinal: true` returns only completed games (for the Scores view); omit it
 * (Schedule view) to get the full fixture list including upcoming games.
 */
export async function listPulGames(opts: {
  season: number;
  onlyFinal?: boolean;
}): Promise<PulGame[]> {
  const db = supabase();

  let q = db
    .from('pul_games')
    .select(
      'id, season, week_label, week_num, away_team_id, home_team_id, away_abbrev, home_abbrev, game_date, game_time, location, away_score, home_score, status',
    )
    .eq('season', opts.season);
  if (opts.onlyFinal) q = q.eq('status', 'final');

  const { data, error } = await q;
  if (error) throw error;

  const rows = (data ?? []) as unknown as DbGameRow[];

  // Resolve team identities once (small table) rather than a join per row.
  const teams = await listPulTeams();
  const byId = new Map(teams.map((t) => [t.id, t]));

  const side = (teamId: string, abbrev: string, score: number | null): PulGameTeamSide => {
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
  };

  const games: PulGame[] = rows.map((r) => ({
    id: r.id,
    season: r.season,
    weekLabel: r.week_label,
    weekNum: r.week_num,
    status: r.status === 'final' ? 'final' : 'scheduled',
    gameDate: r.game_date,
    gameTime: r.game_time,
    location: r.location,
    away: side(r.away_team_id, r.away_abbrev, r.away_score),
    home: side(r.home_team_id, r.home_abbrev, r.home_score),
  }));

  // Order: by date asc (nulls last), then regular-season weeks before playoffs,
  // then playoff order semifinals → finals.
  const playoffRank = (label: string): number =>
    label === 'finals' ? 2 : label === 'semifinals' ? 1 : 0;
  games.sort((a, b) => {
    const da = a.gameDate ?? '9999-12-31';
    const dbb = b.gameDate ?? '9999-12-31';
    if (da !== dbb) return da.localeCompare(dbb);
    const pa = playoffRank(a.weekLabel);
    const pb = playoffRank(b.weekLabel);
    if (pa !== pb) return pa - pb;
    return (a.weekNum ?? 0) - (b.weekNum ?? 0);
  });

  return games;
}

// ─── Standings ─────────────────────────────────────────────────────────────

/** A team's derived regular-season standing. PUL is a single division. */
export interface PulStandingRow {
  team: PulTeam;
  wins: number;
  losses: number;
  /** Total points scored / allowed across counted games (for point diff). */
  pointsFor: number;
  pointsAgainst: number;
  pointDiff: number;
  /** True if this team won the season's Finals game. */
  champion: boolean;
}

/**
 * Season standings for PUL, derived from final games (no standings table).
 * Regular-season record only (playoff weeks excluded from W-L so the table
 * reads as "regular-season standings"), sorted by wins → point differential.
 * The Finals winner is flagged `champion` so the UI can badge them.
 */
export async function getPulStandings(season: number): Promise<PulStandingRow[]> {
  // The whole schedule, not just finals: it also says which teams are in this
  // season (pul_teams holds every franchise ever, so a 0-game team showed 0-0).
  const [teams, schedule] = await Promise.all([listPulTeams(), listPulGames({ season })]);
  const games = schedule.filter((g) => g.status === 'final');
  const inSeason = new Set(schedule.flatMap((g) => [g.home.teamId, g.away.teamId]));

  const isPlayoff = (label: string) => label === 'semifinals' || label === 'finals';

  const rec = new Map<
    string,
    { wins: number; losses: number; pointsFor: number; pointsAgainst: number }
  >();
  const ensure = (id: string) => {
    if (!rec.has(id)) rec.set(id, { wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0 });
    return rec.get(id)!;
  };

  let champion: string | null = null;
  for (const g of games) {
    const a = g.away.score;
    const h = g.home.score;
    if (a == null || h == null || a === h) continue;
    const homeWon = h > a;
    if (g.weekLabel === 'finals') {
      champion = homeWon ? g.home.teamId : g.away.teamId;
    }
    // Only regular-season games count toward the standings record.
    if (isPlayoff(g.weekLabel)) continue;
    const home = ensure(g.home.teamId);
    const away = ensure(g.away.teamId);
    home.pointsFor += h;
    home.pointsAgainst += a;
    away.pointsFor += a;
    away.pointsAgainst += h;
    if (homeWon) {
      home.wins += 1;
      away.losses += 1;
    } else {
      away.wins += 1;
      home.losses += 1;
    }
  }

  // No schedule posted yet: keep listing every team rather than none.
  return teams
    .filter((team) => inSeason.size === 0 || inSeason.has(team.id))
    .map((team) => {
      const r = rec.get(team.id) ?? { wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0 };
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
 * Every podium (top-3) playoff finish for a PUL team, across all seasons.
 *   1st = Finals winner, 2nd = Finals loser, 3rd = each Semifinal loser.
 * Used for the medals row on the team page. Newest first.
 */
export async function getPulTeamPodiums(teamId: string): Promise<TeamPodium[]> {
  const seasons = await listPulSeasons().catch(() => [] as number[]);
  const out: TeamPodium[] = [];

  for (const year of seasons) {
    const games = await listPulGames({ season: year, onlyFinal: true }).catch(
      () => [] as PulGame[],
    );

    for (const g of games) {
      const a = g.away;
      const h = g.home;
      if (a.score == null || h.score == null || a.score === h.score) continue;
      const winner = a.score > h.score ? a.teamId : h.teamId;
      const loser = a.score > h.score ? h.teamId : a.teamId;

      if (g.weekLabel === 'finals') {
        if (winner === teamId) out.push({ year, place: 1 });
        else if (loser === teamId) out.push({ year, place: 2 });
      } else if (g.weekLabel === 'semifinals') {
        // Both semifinal losers tie for 3rd.
        if (loser === teamId) out.push({ year, place: 3 });
      }
    }
  }

  // A team can't hold two places in one season; if it somehow appears twice
  // (data quirk), keep the best. Dedupe by year keeping the lowest place.
  const best = new Map<number, 1 | 2 | 3>();
  for (const m of out) {
    const cur = best.get(m.year);
    if (cur == null || m.place < cur) best.set(m.year, m.place);
  }
  return [...best.entries()]
    .map(([year, place]) => ({ year, place }))
    .sort((x, y) => y.year - x.year);
}

/**
 * One game by its id ('{season}/{week}/{AWAY}-vs-{HOME}'), with both sides'
 * team identity resolved. Returns null if not found. Powers /pul/g/[id].
 */
export async function getPulGame(id: string): Promise<PulGame | null> {
  const db = supabase();
  const { data, error } = await db
    .from('pul_games')
    .select(
      'id, season, week_label, week_num, away_team_id, home_team_id, away_abbrev, home_abbrev, game_date, game_time, location, away_score, home_score, status',
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const r = data as unknown as DbGameRow;
  const teams = await listPulTeams();
  const byId = new Map(teams.map((t) => [t.id, t]));
  const side = (teamId: string, abbrev: string, score: number | null): PulGameTeamSide => {
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
  };

  return {
    id: r.id,
    season: r.season,
    weekLabel: r.week_label,
    weekNum: r.week_num,
    status: r.status === 'final' ? 'final' : 'scheduled',
    gameDate: r.game_date,
    gameTime: r.game_time,
    location: r.location,
    away: side(r.away_team_id, r.away_abbrev, r.away_score),
    home: side(r.home_team_id, r.home_abbrev, r.home_score),
  };
}

// ─── Per-game box score ──────────────────────────────────────────────────────

/** One player's stat line in a single game (from pul_game_player_stats). */
export interface PulBoxscoreRow {
  playerName: string;
  jerseyNumber: string | null;
  goals: number;
  assists: number;
  blocks: number;
  turnovers: number;
  touches: number;
  oPoints: number;
  dPoints: number;
  plusMinus: number;
  /** pul_players.id for the SAME season — the link target for /players/[id].
   *  null when the box-score name has no matching season profile row. */
  profileId: string | null;
}

/** Both teams' box scores for one game, split by team_id. */
export interface PulGameBoxscore {
  away: PulBoxscoreRow[];
  home: PulBoxscoreRow[];
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
  plus_minus: number;
}

/**
 * Full per-player box score for one game, split into away/home by team_id,
 * with each row carrying the profileId (same-season pul_players.id) so the UI
 * can link a stat line straight to /players/[id]. Rows are sorted by
 * goals+assists desc, then name. Empty arrays when a game has no player stats
 * (e.g. 2022 — see project memory; only 2023+ carry box scores).
 */
export async function getPulGameBoxscore(
  game: Pick<PulGame, 'id' | 'season' | 'away' | 'home'>,
): Promise<PulGameBoxscore> {
  const db = supabase();
  const { data, error } = await db
    .from('pul_game_player_stats')
    .select(
      'team_id, player_name, jersey_number, goals, assists, blocks, turnovers, touches, o_points, d_points, plus_minus',
    )
    .eq('game_id', game.id);
  if (error) throw error;

  const statRows = (data ?? []) as unknown as DbGameStatRow[];
  if (statRows.length === 0) return { away: [], home: [] };

  // Resolve player_name → same-season profile id in ONE query (not per row).
  const names = [...new Set(statRows.map((r) => r.player_name))];
  const { data: profileRows } = await db
    .from('pul_players')
    .select('id, player_name')
    .eq('season', game.season)
    .in('player_name', names);
  const idByName = new Map(
    ((profileRows ?? []) as unknown as { id: string; player_name: string }[]).map((p) => [
      p.player_name.toLowerCase(),
      p.id,
    ]),
  );

  const map = (r: DbGameStatRow): PulBoxscoreRow => ({
    playerName: r.player_name,
    jerseyNumber: r.jersey_number ?? null,
    goals: r.goals,
    assists: r.assists,
    blocks: r.blocks,
    turnovers: r.turnovers,
    touches: r.touches,
    oPoints: r.o_points,
    dPoints: r.d_points,
    plusMinus: r.plus_minus,
    profileId: idByName.get(r.player_name.toLowerCase()) ?? null,
  });

  const sortRows = (rows: PulBoxscoreRow[]) =>
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

/** One PUL game from a single player's perspective: their stat line + matchup
 *  context (opponent, date, result). PUL box scores lack yards/points-played;
 *  o/d points are available. */
export interface PulPlayerGameRow {
  gameId: string;
  date: string | null;
  weekLabel: string;
  opponentAbbrev: string | null;
  result: 'W' | 'L' | null;
  teamScore: number | null;
  oppScore: number | null;
  goals: number;
  assists: number;
  blocks: number;
  turnovers: number;
  touches: number;
  oPoints: number;
  dPoints: number;
  plusMinus: number;
}

/**
 * A PUL player's game-by-game log for one season. Matches by player_name; joins
 * pul_games for the matchup (opponent + result). Sorted by date asc. Only
 * 2023+ seasons carry box scores (2022 has none) — returns [] otherwise.
 */
export async function getPulPlayerGameLog(
  playerName: string,
  season: number,
): Promise<PulPlayerGameRow[]> {
  const db = supabase();
  const { data, error } = await db
    .from('pul_game_player_stats')
    .select(
      'game_id, team_id, goals, assists, blocks, turnovers, touches, o_points, d_points, plus_minus, ' +
        'pul_games!inner(id, game_date, week_label, away_team_id, home_team_id, away_abbrev, home_abbrev, away_score, home_score, season)',
    )
    .eq('player_name', playerName)
    .eq('pul_games.season', season);
  if (error) throw error;

  type Row = {
    game_id: string;
    team_id: string;
    goals: number;
    assists: number;
    blocks: number;
    turnovers: number;
    touches: number;
    o_points: number;
    d_points: number;
    plus_minus: number;
    pul_games: {
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
  const out: PulPlayerGameRow[] = [];
  for (const r of rows) {
    const g = r.pul_games;
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
      oPoints: r.o_points,
      dPoints: r.d_points,
      plusMinus: Number(r.plus_minus),
    });
  }
  out.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  return out;
}
