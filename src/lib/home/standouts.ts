// Home-page "Standout Performances" — the best individual player stat-lines
// from recent games, for the rotating carousel. UFA / PUL / WUL are wired
// (per-game box scores), plus USAU Club Nationals (event-level G/A/D/T totals).
// Every wired league contributes whenever it has recent games; a card retires
// on its own significance — a good line lasts a few days, a killer performance
// up to WINDOW_DAYS — so after a season ends the rail thins out line by line,
// goes quiet within three weeks of the final, and lights back up when the
// next wired league (PUL → WUL → UFA) starts. UFA award cards outlast the
// game lines and close the rail four weeks after the final (Hunter,
// 2026-09-19).
//
// Data is cheap: we mirror per-game box scores into Supabase
// (ufa_game_player_stats / pul_game_player_stats / wul_game_player_stats, all
// world-readable via the anon key), so a standout is a small windowed read +
// a perf score computed in TS — no per-game API fan-out.
//
// PERF SCORE (0-ish to ~50): weighted blend of counting stats + throwing, with
// completion % that only matters at LOW counting volume (a 6+ combined G/A/Blk
// line gets ~0 from completion %). Tuned against real recent UFA lines so a
// 4G/9A/761yd distributor game and a 6G/5Blk two-way game both surface, and a
// 7-block defender shows up on the blocks weight.
//
// SELECTION = strength-gated recency: the most recent weekend's best lines
// appear easily; an older line must clear a higher perf bar to survive, and
// nothing outlives WINDOW_DAYS. Age is wall-clock (now − game time) — the
// earlier design froze ages at the league's latest final so a finished season
// held its whole finals slate for a fixed grace window, then dropped it in one
// step; Hunter wants the lines to fade by how good they were instead. See
// gateThreshold().

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseUrl, supabaseAnonKey } from '@/lib/supabase/env';
import { usauToday } from '@/lib/today';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

let _client: AnyClient | null = null;
function supabase(): AnyClient {
  if (_client) return _client;
  _client = createClient(supabaseUrl(), supabaseAnonKey(), { auth: { persistSession: false } });
  return _client;
}

export type StandoutLeague = 'ufa' | 'pul' | 'wul' | 'usau';

export interface StandoutStat {
  label: string;
  value: string;
}

/** UFA season awards a standout can be "on watch" for. ROY = Rookie of the Year
 *  (plumbed but not yet computable — no rookie-year data stored). */
export type AwardWatch = 'MVP' | 'OPOY' | 'DPOY' | 'ROY';

export interface StandoutLine {
  id: string; // `${league}-${gameId}-${playerKey}`
  league: StandoutLeague;
  /** League player id (UFA slug), or null (PUL/WUL box rows carry no id). Used
   *  to match a card to its season award-watch status. */
  playerId: string | null;
  playerName: string;
  /** Route to the profile, or null when we can't resolve an id (PUL/WUL). */
  href: string | null;
  /** UFA headshot (only league with them); null → monogram fallback. */
  headshotUrl: string | null;
  teamName: string | null;
  /** Human date label of the game, e.g. "Jul 19", or "Season" for a season card. */
  dateLabel: string;
  /** Opponent name/abbr for "vs {opp}" next to the date. Null for season cards. */
  opponent: string | null;
  /** True when the card shows SEASON totals (an award leader whose latest game
   *  wasn't standout-worthy) rather than a single game line. */
  seasonMode: boolean;
  /** The stat tiles to show on the card. */
  stats: StandoutStat[];
  /** Season award this player currently leads/contends (tag on the card). A
   *  player never gets a duplicate card — their watch status rides their
   *  standout line. Null when they're not an award leader. */
  awardWatch: AwardWatch | null;
  /** True when this game line included a Callahan (a D-block caught in the
   *  endzone for a score — the rarest play; always acknowledged). */
  callahan: boolean;
  /** Internal — perf score + timestamp (for selection, not shown raw). */
  perf: number;
  ts: number;
  /** Internal — `${league}-${gameId}` for the per-game cap. */
  gameKey: string;
  /** Internal — rotation lane: the league, or `usau-${division}` for USAU
   *  (each Nationals division gets its own share of the rail). */
  lane: string;
}

const MS_DAY = 86_400_000;
/** Fetch window AND the hard cap on how long the very best line can linger
 *  ("3-ish weeks" — Hunter, 2026-09-11). gateThreshold() decides what survives
 *  inside it. */
const WINDOW_DAYS = 21;
const MAX_CARDS = 15; // fits Club Nationals' 3 divisions × USAU_PER_DIVISION
const PER_GAME_CAP = 1; // at most one standout per game so one blowout doesn't flood
const PER_PLAYER_CAP = 1; // at most one card per player — their single best recent game
/** PostgREST max-rows: one response never holds more, whatever .range asks. */
const PAGE = 1000;
/** UFA award-watch (MVP/OPOY/DPOY) tags, exemptions and season-total fallback
 *  cards apply for this long after the UFA's latest final — four weeks, so the
 *  season's award leaders outlast every game line (gone by WINDOW_DAYS) and
 *  close out the rail (Hunter, 2026-09-19: "4 weeks max after season ends"). */
const AWARD_GRACE_DAYS = 28;
/** USAU Club Nationals event-total cards (no per-game lines to decay) stay
 *  this long after the event's end_date. */
const USAU_EVENT_GRACE_DAYS = 14;

// ─── Perf score ───────────────────────────────────────────────────────────────

interface RawLine {
  goals: number;
  assists: number;
  blocks: number;
  plusMinus: number;
  totalYards: number | null;
  completions: number | null;
  throwsAttempted: number | null;
  /** Callahans in the game — each is a defensive score, the rarest highlight;
   *  weighted heavily so a callahan line ranks up and gets acknowledged. */
  callahans?: number;
}

/** Weighted performance score. See file header for the model + rationale. */
function perfScore(l: RawLine): number {
  const counting = l.goals + l.assists + l.blocks;
  let s =
    l.goals * 2.2 +
    l.assists * 2.0 +
    l.blocks * 2.6 +
    l.plusMinus * 1.4 +
    (l.callahans ?? 0) * 6; // a callahan is a marquee play → strong boost

  if (l.totalYards != null) s += l.totalYards / 100; // ~250yd → +2.5

  // Completion-% bonus, only meaningful at low counting volume: the weight
  // fades to 0 by ~8 combined G/A/Blk, so a big box line isn't padded by cmp%.
  if (l.throwsAttempted != null && l.throwsAttempted >= 10 && l.completions != null) {
    const cmpPct = (100 * l.completions) / l.throwsAttempted;
    const lowVolWeight = Math.max(0, 1 - counting / 8);
    s += (cmpPct - 85) * lowVolWeight * 0.08;
  }
  return s;
}

/**
 * Strength-gated recency threshold: how strong a line must be to survive at a
 * given wall-clock age. A worthy line makes the rail for a few days; only a
 * killer performance lasts into the third week; nothing outlives WINDOW_DAYS.
 *
 * Calibrated against real lines (a mid-season perf tops ~50-65; the 2026 UFA
 * title weekend peaked at 38/37/35 with five more lines at 30-32; the sparse
 * Jul 24-26 playoff slate peaked at 33-40). So two weeks after the final ~6
 * title-weekend lines still show, by day 15 only the two monster lines, and on
 * day 21 the rail goes dark — while a mid-season playoff slate still clears
 * the two-week bar.
 */
function gateThreshold(ageDays: number): number {
  if (ageDays <= 3) return 10; // latest slate — easy to appear
  if (ageDays <= 7) return 18; // ~1 week back — good line
  if (ageDays <= 14) return 26; // ~2 weeks — solid line
  if (ageDays <= WINDOW_DAYS) return 36; // ~3 weeks — killer performance only
  return Infinity;
}

// ─── UFA ──────────────────────────────────────────────────────────────────────

interface UfaStatRow {
  game_id: string;
  player_id: string;
  team_id: string;
  goals: number;
  assists: number;
  blocks: number;
  callahans: number;
  throwaways: number;
  drops: number;
  stalls: number;
  yards_thrown: number;
  yards_received: number;
  completions: number;
  throws_attempted: number;
}

async function ufaStandouts(now: number): Promise<StandoutLine[]> {
  const db = supabase();
  const since = new Date(now - WINDOW_DAYS * MS_DAY).toISOString();

  // Recent final games (id → date + teams).
  const { data: games } = await db
    .from('ufa_games')
    .select('id, start_timestamp, status, home_team_id, away_team_id')
    .gt('start_timestamp', since)
    .ilike('status', '%final%');
  const gameMeta = new Map<string, { ts: number; homeTeamId: string; awayTeamId: string }>();
  for (const g of (games ?? []) as { id: string; start_timestamp: string; home_team_id: string; away_team_id: string }[]) {
    gameMeta.set(g.id, { ts: new Date(g.start_timestamp).getTime(), homeTeamId: g.home_team_id, awayTeamId: g.away_team_id });
  }
  if (gameMeta.size === 0) return [];

  const gameIds = [...gameMeta.keys()];
  // ~28 players/game over three weeks runs past the 1000-row cap mid-season
  // (1,000–1,550 rows), so page it in stable id order.
  const statRows: UfaStatRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data: page } = await db
      .from('ufa_game_player_stats')
      .select(
        'game_id, player_id, team_id, goals, assists, blocks, callahans, throwaways, drops, stalls, yards_thrown, yards_received, completions, throws_attempted',
      )
      .in('game_id', gameIds)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    const chunk = (page ?? []) as UfaStatRow[];
    statRows.push(...chunk);
    if (chunk.length < PAGE) break;
  }
  if (statRows.length === 0) return [];

  // Season award watch (MVP/OPOY/DPOY) keyed by player_id — a tag on whichever
  // standout cards belong to a current award leader. Gated to week ≥ 5.
  const awardByPlayer = await ufaAwardWatch(now).catch(() => new Map<string, AwardWatch>());

  // Resolve player names + headshots + team names in bulk. Include BOTH sides of
  // each game so we can name the opponent ("vs {opp}").
  const playerIds = [...new Set(statRows.map((r) => r.player_id))];
  const teamIds = [
    ...new Set([
      ...statRows.map((r) => r.team_id),
      ...[...gameMeta.values()].flatMap((m) => [m.homeTeamId, m.awayTeamId]),
    ]),
  ];
  const [playersRes, teamsRes] = await Promise.all([
    db.from('ufa_players').select('id, full_name, headshot_url').in('id', playerIds),
    db.from('ufa_teams').select('id, name, city').in('id', teamIds),
  ]);
  const players = new Map<string, { full_name: string; headshot_url: string | null }>();
  for (const p of (playersRes.data ?? []) as { id: string; full_name: string; headshot_url: string | null }[]) {
    players.set(p.id, { full_name: p.full_name, headshot_url: p.headshot_url });
  }
  const teams = new Map<string, string>();
  for (const t of (teamsRes.data ?? []) as { id: string; name: string; city: string }[]) {
    teams.set(t.id, [t.city, t.name].filter(Boolean).join(' ') || t.name);
  }

  const lines: StandoutLine[] = statRows.map((r) => {
    const plusMinus = r.goals + r.assists + r.blocks - r.throwaways - r.drops - r.stalls;
    const totalYards = (r.yards_thrown ?? 0) + (r.yards_received ?? 0);
    const perf = perfScore({
      goals: r.goals,
      assists: r.assists,
      blocks: r.blocks,
      plusMinus,
      totalYards,
      completions: r.completions,
      throwsAttempted: r.throws_attempted,
      callahans: r.callahans ?? 0,
    });
    const p = players.get(r.player_id);
    const meta = gameMeta.get(r.game_id);
    const ts = meta?.ts ?? now;
    // Opponent = the game's other team (not the player's team_id).
    const oppTeamId = meta ? (meta.homeTeamId === r.team_id ? meta.awayTeamId : meta.homeTeamId) : null;
    return {
      id: `ufa-${r.game_id}-${r.player_id}`,
      gameKey: `ufa-${r.game_id}`,
      lane: 'ufa',
      league: 'ufa' as const,
      playerId: r.player_id,
      playerName: p?.full_name?.trim() || r.player_id,
      href: `/players/${r.player_id}`,
      headshotUrl: p?.headshot_url ?? null,
      teamName: teams.get(r.team_id) ?? null,
      dateLabel: dateLabel(ts),
      opponent: oppTeamId ? teams.get(oppTeamId) ?? null : null,
      seasonMode: false,
      stats: buildStats({
        goals: r.goals, assists: r.assists, blocks: r.blocks, plusMinus,
        totalYards, completions: r.completions, throwsAttempted: r.throws_attempted,
      }),
      awardWatch: awardByPlayer.get(r.player_id) ?? null,
      callahan: (r.callahans ?? 0) > 0,
      perf,
      ts,
    };
  });
  return lines;
}

// ─── UFA season award watch (MVP / OPOY / DPOY) ────────────────────────────────

const AWARD_MIN_WEEK = 5; // don't crown a watch until there's enough sample

/**
 * Compute the current UFA award-watch leaders for the live season, keyed by
 * player_id. Returns an empty map before week 5, or if the season has no games.
 *
 *   - OPOY (Offensive POY) — offensive production: goals + assists + yards.
 *   - DPOY (Defensive POY) — blocks (+ callahans, which are defensive scores).
 *   - MVP                  — overall two-way value (a blend of the above + +/-).
 *   - ROY (Rookie)         — NOT computed: we don't store rookie-year/experience
 *     data. Plumbed so it lights up the moment that data exists.
 *
 * One leader per award. If the same player would lead two awards (e.g. MVP and
 * OPOY), MVP wins on their card — award precedence MVP > OPOY > DPOY — so no
 * player carries two tags.
 */
type SeasonAgg = { g: number; a: number; blk: number; cal: number; yds: number; pm: number; gp: number };

interface AwardData {
  /** player_id → award. */
  awards: Map<string, AwardWatch>;
  /** player_id → season totals (for building a season card when a leader has
   *  no recent game in the standouts window). */
  agg: Map<string, SeasonAgg>;
}

/**
 * Shared computation: the current UFA award-watch leaders + every player's
 * season aggregate. See ufaAwardWatch / ufaAwardSeasonCards for the two callers.
 * Returns empty maps before week 5 or if the season has no games.
 *
 * Memoized per `now` value: within one getStandoutPerformances() run this is
 * called twice (ufaAwardWatch during ufaStandouts, then again in
 * ufaAwardSeasonCards). Each call is a paginated full-season stat scan — the
 * heaviest part of the load — so caching the in-flight promise on `now` makes
 * the second call instant and roughly halves the award work. The key is the
 * exact `now` timestamp of the fetch, so a later refetch (new now) recomputes
 * rather than serving stale data.
 */
let _awardDataCache: { now: number; promise: Promise<AwardData> } | null = null;

function ufaAwardData(now: number): Promise<AwardData> {
  if (_awardDataCache && _awardDataCache.now === now) return _awardDataCache.promise;
  const promise = computeUfaAwardData(now).catch((e) => {
    // Don't cache a rejection — clear so the next call can retry cleanly.
    if (_awardDataCache && _awardDataCache.now === now) _awardDataCache = null;
    throw e;
  });
  _awardDataCache = { now, promise };
  return promise;
}

async function computeUfaAwardData(now: number): Promise<AwardData> {
  const db = supabase();
  const empty: AwardData = { awards: new Map(), agg: new Map() };

  // Current season = the newest year with a game already played.
  const { data: latest } = await db
    .from('ufa_games')
    .select('year, week, start_timestamp')
    .lt('start_timestamp', new Date(now).toISOString())
    .order('start_timestamp', { ascending: false })
    .limit(1)
    .maybeSingle();
  const season = (latest as { year?: number } | null)?.year;
  if (!season) return empty;

  // Games this season (final) → their ids + the max week reached (the gate).
  const { data: games } = await db
    .from('ufa_games')
    .select('id, week, status')
    .eq('year', season)
    .ilike('status', '%final%');
  const gameRows = (games ?? []) as { id: string; week: string | null }[];
  if (gameRows.length === 0) return empty;
  const maxWeek = gameRows.reduce((m, g) => Math.max(m, weekNum(g.week)), 0);
  if (maxWeek < AWARD_MIN_WEEK) return empty;

  const seasonGameIds = gameRows.map((g) => g.id);
  // Page the stat fetch in 1000-row chunks so a season's worth of rows can NEVER
  // silently truncate at the PostgREST cap (an incomplete read would compute the
  // wrong award leaders — e.g. a partial season made Taylor outrank Decraene).
  type StatPick = Pick<UfaStatRow, 'player_id' | 'goals' | 'assists' | 'blocks' | 'callahans' | 'throwaways' | 'drops' | 'stalls' | 'yards_thrown' | 'yards_received'>;
  const statRows: StatPick[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data: page } = await db
      .from('ufa_game_player_stats')
      .select('player_id, goals, assists, blocks, callahans, throwaways, drops, stalls, yards_thrown, yards_received')
      .in('game_id', seasonGameIds)
      .order('id', { ascending: true }) // stable order → pages don't overlap/skip
      .range(from, from + PAGE - 1);
    const chunk = (page ?? []) as StatPick[];
    statRows.push(...chunk);
    if (chunk.length < PAGE) break;
  }
  if (statRows.length === 0) return empty;

  // Aggregate season totals per player.
  const agg = new Map<string, SeasonAgg>();
  for (const r of statRows) {
    const cur = agg.get(r.player_id) ?? { g: 0, a: 0, blk: 0, cal: 0, yds: 0, pm: 0, gp: 0 };
    cur.g += r.goals; cur.a += r.assists; cur.blk += r.blocks; cur.cal += r.callahans ?? 0;
    cur.yds += (r.yards_thrown ?? 0) + (r.yards_received ?? 0);
    cur.pm += r.goals + r.assists + r.blocks - r.throwaways - r.drops - r.stalls;
    cur.gp += 1;
    agg.set(r.player_id, cur);
  }
  const players = [...agg.entries()];
  const awards = new Map<string, AwardWatch>();

  // Best player by a scoring fn, EXCLUDING already-tagged players so each award
  // goes to a distinct person. (Often the MVP also leads offense — without this,
  // OPOY would vanish instead of falling to the next-best offensive player.)
  const bestExcluding = (score: (v: SeasonAgg) => number): string | null =>
    players.reduce<{ id: string; s: number } | null>((best, [id, v]) => {
      if (awards.has(id)) return best;
      const s = score(v);
      return !best || s > best.s ? { id, s } : best;
    }, null)?.id ?? null;

  // Precedence MVP > OPOY > DPOY; each takes the best still-untagged player.
  const mvp = bestExcluding((v) => v.g + v.a + v.blk * 1.4 + v.pm * 0.6 + v.yds / 150);
  if (mvp) awards.set(mvp, 'MVP');
  const opoy = bestExcluding((v) => v.g + v.a + v.yds / 100);
  if (opoy) awards.set(opoy, 'OPOY');
  const dpoy = bestExcluding((v) => v.blk + v.cal * 1.5);
  if (dpoy) awards.set(dpoy, 'DPOY');
  return { awards, agg };
}

/** player_id → current award (MVP/OPOY/DPOY). Thin wrapper over ufaAwardData. */
async function ufaAwardWatch(now: number): Promise<Map<string, AwardWatch>> {
  return (await ufaAwardData(now)).awards;
}

/**
 * Build a SEASON-stats card for every award-watch player who did NOT earn a
 * game card (no standout-worthy recent game — a quiet week, or no game at all).
 * `gameEarnerIds` = award players who already have a gate-clearing game card.
 * This is what makes an MVP contender with a mediocre latest game show SEASON
 * totals (Decraene's 32G/59A/+71) instead of that one quiet line.
 */
async function ufaAwardSeasonCards(
  now: number,
  gameEarnerIds: Set<string | null>,
): Promise<StandoutLine[]> {
  const { awards, agg } = await ufaAwardData(now);
  const missing = [...awards.entries()].filter(([id]) => !gameEarnerIds.has(id));
  if (missing.length === 0) return [];

  const db = supabase();
  const ids = missing.map(([id]) => id);
  const { data: playersData } = await db
    .from('ufa_players')
    .select('id, full_name, headshot_url, current_team_id')
    .in('id', ids);
  const teamIds = [...new Set(((playersData ?? []) as { current_team_id: string | null }[]).map((p) => p.current_team_id).filter(Boolean))] as string[];
  const { data: teamsData } = teamIds.length
    ? await db.from('ufa_teams').select('id, name, city').in('id', teamIds)
    : { data: [] as { id: string; name: string; city: string }[] };
  const pmeta = new Map<string, { full_name: string; headshot_url: string | null; team: string | null }>();
  const teamName = new Map<string, string>();
  for (const t of (teamsData ?? []) as { id: string; name: string; city: string }[]) {
    teamName.set(t.id, [t.city, t.name].filter(Boolean).join(' ') || t.name);
  }
  for (const p of (playersData ?? []) as { id: string; full_name: string; headshot_url: string | null; current_team_id: string | null }[]) {
    pmeta.set(p.id, { full_name: p.full_name, headshot_url: p.headshot_url, team: p.current_team_id ? teamName.get(p.current_team_id) ?? null : null });
  }

  return missing.map(([id, award]) => {
    const v = agg.get(id)!;
    const meta = pmeta.get(id);
    return {
      id: `ufa-season-${id}`,
      gameKey: `ufa-season-${id}`,
      lane: 'ufa',
      league: 'ufa' as const,
      playerId: id,
      playerName: meta?.full_name?.trim() || id,
      href: `/players/${id}`,
      headshotUrl: meta?.headshot_url ?? null,
      teamName: meta?.team ?? null,
      dateLabel: 'Season',
      opponent: null,
      seasonMode: true,
      stats: [
        { label: 'G', value: String(v.g) },
        { label: 'A', value: String(v.a) },
        { label: 'Blk', value: String(v.blk) },
        { label: '+/-', value: (v.pm >= 0 ? '+' : '') + v.pm },
        { label: 'Yds', value: String(v.yds) },
      ],
      awardWatch: award,
      callahan: false,
      // Season cards aren't "recent" — give them a high perf so they still lead,
      // and a ts of now so recency math never drops them.
      perf: 1000,
      ts: now,
    };
  });
}

/** UFA week labels are "week-11" / "week-1" etc.; playoffs sort high. */
function weekNum(week: string | null): number {
  if (!week) return 0;
  const m = week.match(/(\d+)/);
  if (m) return parseInt(m[1], 10);
  // Non-numeric (playoffs/championship) → treat as late-season.
  return 99;
}

// ─── PUL / WUL (Supabase, no yards for PUL) ─────────────────────────────────────

interface ProStatRow {
  game_id: string;
  team_id: string;
  player_name: string;
  goals: number;
  assists: number;
  blocks: number;
  turnovers: number;
  plus_minus: number;
  // WUL-only:
  total_yards?: number | null;
  completions?: number | null;
  throws?: number | null;
  callahans?: number | null;
}

async function proStandouts(league: 'pul' | 'wul', now: number): Promise<StandoutLine[]> {
  const db = supabase();
  const sinceDate = usauToday(new Date(now - WINDOW_DAYS * MS_DAY));
  const gamesTable = league === 'pul' ? 'pul_games' : 'wul_games';
  const statsTable = league === 'pul' ? 'pul_game_player_stats' : 'wul_game_player_stats';
  const teamsTable = league === 'pul' ? 'pul_teams' : 'wul_teams';

  const { data: games } = await db
    .from(gamesTable)
    .select('id, game_date, status, home_team_id, away_team_id')
    .gte('game_date', sinceDate)
    .eq('status', 'final');
  const gameMeta = new Map<string, { ts: number; homeTeamId: string; awayTeamId: string }>();
  for (const g of (games ?? []) as { id: string; game_date: string | null; home_team_id: string; away_team_id: string }[]) {
    gameMeta.set(g.id, {
      ts: g.game_date ? new Date(g.game_date).getTime() : now,
      homeTeamId: g.home_team_id,
      awayTeamId: g.away_team_id,
    });
  }
  if (gameMeta.size === 0) return [];

  const gameIds = [...gameMeta.keys()];
  const cols =
    league === 'wul'
      ? 'game_id, team_id, player_name, goals, assists, blocks, turnovers, plus_minus, total_yards, completions, throws, callahans'
      : 'game_id, team_id, player_name, goals, assists, blocks, turnovers, plus_minus';
  const { data: rows } = await db.from(statsTable).select(cols).in('game_id', gameIds).range(0, 4999);
  const statRows = (rows ?? []) as unknown as ProStatRow[];
  if (statRows.length === 0) return [];

  const teamIds = [
    ...new Set([
      ...statRows.map((r) => r.team_id),
      ...[...gameMeta.values()].flatMap((m) => [m.homeTeamId, m.awayTeamId]),
    ]),
  ];
  const { data: teamRows } = await db.from(teamsTable).select('id, name, city').in('id', teamIds);
  const teams = new Map<string, string>();
  for (const t of (teamRows ?? []) as { id: string; name: string; city: string | null }[]) {
    teams.set(t.id, [t.city, t.name].filter(Boolean).join(' ') || t.name);
  }

  return statRows.map((r, i) => {
    const totalYards = league === 'wul' ? r.total_yards ?? null : null;
    const perf = perfScore({
      goals: r.goals,
      assists: r.assists,
      blocks: r.blocks,
      plusMinus: r.plus_minus,
      totalYards,
      completions: league === 'wul' ? r.completions ?? null : null,
      throwsAttempted: league === 'wul' ? r.throws ?? null : null,
      callahans: league === 'wul' ? r.callahans ?? 0 : 0,
    });
    const meta = gameMeta.get(r.game_id);
    const ts = meta?.ts ?? now;
    const oppTeamId = meta ? (meta.homeTeamId === r.team_id ? meta.awayTeamId : meta.homeTeamId) : null;
    return {
      id: `${league}-${r.game_id}-${r.player_name}-${i}`,
      gameKey: `${league}-${r.game_id}`,
      lane: league,
      league,
      playerId: null,
      playerName: r.player_name,
      href: null, // PUL/WUL box rows don't carry a profile id; link resolution TODO
      headshotUrl: null,
      teamName: teams.get(r.team_id) ?? null,
      dateLabel: dateLabel(ts),
      opponent: oppTeamId ? teams.get(oppTeamId) ?? null : null,
      seasonMode: false,
      stats: buildStats({
        goals: r.goals, assists: r.assists, blocks: r.blocks, plusMinus: r.plus_minus,
        totalYards, completions: league === 'wul' ? r.completions ?? null : null,
        throwsAttempted: league === 'wul' ? r.throws ?? null : null,
      }),
      awardWatch: null, // award watch is UFA-only for now
      callahan: league === 'wul' ? (r.callahans ?? 0) > 0 : false,
      perf,
      ts,
    };
  });
}

// ─── USAU (Club Nationals — event-level G/A totals) ─────────────────────────────

const USAU_PER_DIVISION = 5; // top 5 per division — Men, Mixed, Women (Hunter, 2026-10-28)
const USAU_MIN_GAD = 3; // event totals build over the weekend; don't card a 1-goal line

/**
 * Club Nationals standouts. USAU publishes per-EVENT totals only
 * (usau_player_event_stats: goals, assists, Ds, turns — no yards), and
 * Nationals is the one club event with national attention, so: cards show
 * event totals for the top 5 performers in each division, ranked by the same
 * perfScore as the pro leagues (Ds as blocks, +/- = G+A+D−T), appear while
 * Nationals runs, and retire USAU_EVENT_GRACE_DAYS after end_date. ts = now
 * keeps them exempt from the age gate — the event date-window here is the only
 * on/off switch. Each division is its own lane in the rail's rotation.
 */
async function usauStandouts(now: number): Promise<StandoutLine[]> {
  const db = supabase();
  const today = usauToday(new Date(now));
  const graceCutoff = usauToday(new Date(now - USAU_EVENT_GRACE_DAYS * MS_DAY));
  // template_key is the real Nationals signal — name ILIKE also matched U.S.
  // Open ICC / WUCC events (whose names happen to contain "championships"),
  // which then rendered mislabeled "Nationals" cards.
  const { data: events } = await db
    .from('usau_events')
    .select('id, name, start_date, end_date')
    .eq('template_key', 'club_nationals')
    .lte('start_date', today)
    .gte('end_date', graceCutoff);
  const eventRows = (events ?? []) as { id: string }[];
  if (eventRows.length === 0) return [];

  // A Nationals field is ~1,300 player rows — past the 1000-row cap — so page
  // it (primary-key order) before ranking. Embeds the player name and team
  // directly (usau_players(display_name), usau_teams(name)) instead of a
  // separate name-lookup query after ranking.
  type EventStat = {
    player_id: string;
    event_id: string;
    team_id: string | null;
    goals: number | null;
    assists: number | null;
    ds: number | null;
    turns: number | null;
    usau_players: { display_name: string | null } | null;
    usau_teams: { name: string; gender_division: string | null } | null;
  };
  const stats: EventStat[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data: page } = await db
      .from('usau_player_event_stats')
      .select(
        'player_id, event_id, team_id, goals, assists, ds, turns, usau_players(display_name), usau_teams(name, gender_division)',
      )
      .in('event_id', eventRows.map((e) => e.id))
      .order('player_id', { ascending: true })
      .order('event_id', { ascending: true })
      .range(from, from + PAGE - 1);
    const chunk = (page ?? []) as unknown as EventStat[];
    stats.push(...chunk);
    if (chunk.length < PAGE) break;
  }

  // Dedupe by (event, team, lowercased name) BEFORE ranking — the same human
  // can have two usau_players ids (one per team-season row), and without this
  // they'd win two separate cards for the same performance.
  type Best = EventStat & { name: string; division: string; perf: number };
  const byKey = new Map<string, Best>();
  for (const r of stats) {
    const name = r.usau_players?.display_name;
    const division = r.usau_teams?.gender_division;
    if (!name || !division) continue; // nothing to dedupe, display or lane on — skip
    const g = r.goals ?? 0;
    const a = r.assists ?? 0;
    const d = r.ds ?? 0;
    if (g + a + d < USAU_MIN_GAD) continue;
    // Null turns = not tracked (older pages), so no +/- rather than a fake one.
    const plusMinus = r.turns == null ? 0 : g + a + d - r.turns;
    const perf = perfScore({ goals: g, assists: a, blocks: d, plusMinus, totalYards: null, completions: null, throwsAttempted: null });
    const key = `${r.event_id}|${r.team_id ?? ''}|${name.toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing || perf > existing.perf) byKey.set(key, { ...r, name, division, perf });
  }

  const byDivision = new Map<string, Best[]>();
  for (const r of byKey.values()) byDivision.set(r.division, [...(byDivision.get(r.division) ?? []), r]);
  const ranked = [...byDivision.values()].flatMap((rows) =>
    rows.sort((x, y) => y.perf - x.perf).slice(0, USAU_PER_DIVISION),
  );

  return ranked.map((r) => {
    const stat = (label: string, v: number | null) => (v == null ? [] : [{ label, value: String(v) }]);
    return {
      id: `usau-${r.event_id}-${r.player_id}`,
      // Per-player key: these are event totals, so the per-game cap must not
      // collapse the whole event into one card.
      gameKey: `usau-${r.event_id}-${r.player_id}`,
      lane: `usau-${r.division}`,
      league: 'usau' as const,
      playerId: r.player_id,
      playerName: r.name,
      href: `/players/${r.player_id}?from=usau`,
      headshotUrl: null,
      teamName: r.usau_teams?.name ?? null,
      dateLabel: `Nationals · ${r.division}`,
      opponent: null,
      seasonMode: true, // event totals, not a single game line
      stats: [
        { label: 'G', value: String(r.goals ?? 0) },
        { label: 'A', value: String(r.assists ?? 0) },
        ...stat('D', r.ds),
        ...stat('T', r.turns),
      ],
      awardWatch: null,
      callahan: false,
      perf: r.perf,
      ts: now,
    };
  });
}

// ─── Shared helpers ─────────────────────────────────────────────────────────────

function buildStats(l: RawLine): StandoutStat[] {
  const out: StandoutStat[] = [
    { label: 'G', value: String(l.goals) },
    { label: 'A', value: String(l.assists) },
    { label: 'Blk', value: String(l.blocks) },
    { label: '+/-', value: (l.plusMinus >= 0 ? '+' : '') + l.plusMinus },
  ];
  if (l.totalYards != null && l.totalYards > 0) {
    out.push({ label: 'Yds', value: String(Math.round(l.totalYards)) });
  }
  if (l.throwsAttempted != null && l.throwsAttempted >= 10 && l.completions != null) {
    const pct = Math.round((100 * l.completions) / l.throwsAttempted);
    out.push({ label: 'Cmp%', value: String(pct) });
  }
  return out;
}

function dateLabel(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── Public entry ───────────────────────────────────────────────────────────────

/**
 * The standout stat-lines for the home carousel. Fans out to all wired leagues
 * (only ones with recent games contribute), applies the strength-gated recency
 * filter, caps to one line per game, and returns up to MAX_CARDS, rotating
 * across leagues (and USAU divisions) so every active one shows.
 */
export async function getStandoutPerformances(): Promise<StandoutLine[]> {
  const now = Date.now();
  const perLeague = await Promise.all([
    ufaStandouts(now).catch(() => [] as StandoutLine[]),
    proStandouts('pul', now).catch(() => [] as StandoutLine[]),
    proStandouts('wul', now).catch(() => [] as StandoutLine[]),
    usauStandouts(now).catch(() => [] as StandoutLine[]),
  ]);

  const all = perLeague.flat();

  // Strength-gated recency on WALL-CLOCK age: keep only lines that cleared
  // the age-scaled bar (a real standout game). This applies to award lines
  // too — a sub-gate award line is dropped and replaced by a season card below.
  const clearsGate = (l: StandoutLine) => l.perf >= gateThreshold((now - l.ts) / MS_DAY);
  const gated = all.filter(clearsGate);

  // UFA award treatment (tags, cap exemptions, season-total fallback cards)
  // rides for AWARD_GRACE_DAYS after the UFA's latest final — the season's
  // MVP/OPOY/DPOY stay on the rail as the wrap-up after every game line has
  // faded, then the rail goes dark (Hunter, 2026-09-19: "4 weeks max after
  // season ends"). Past that the leaders are ordinary lines like everyone.
  const ufaLatestTs = Math.max(0, ...all.filter((l) => l.league === 'ufa').map((l) => l.ts));
  const awardsLive = ufaLatestTs > 0 && now - ufaLatestTs <= AWARD_GRACE_DAYS * MS_DAY;
  if (!awardsLive) for (const l of gated) l.awardWatch = null;

  // Cap the field: at most PER_GAME_CAP standouts per game (so one blowout
  // doesn't flood the rail) AND at most PER_PLAYER_CAP card per player (so a
  // player with several standout weeks shows only their single best recent
  // game, not a stack of cards). Lines are sorted by perf desc, so the first
  // time we see a game/player is their best line. Award players are exempt from
  // the per-player cap — an award leader's real game line still competes with
  // their season-totals fallback below (award dedup keeps one per award).
  gated.sort((a, b) => b.perf - a.perf);
  const perGame = new Map<string, number>();
  const perPlayer = new Map<string, number>();
  const capped: StandoutLine[] = [];
  for (const l of gated) {
    const gN = (perGame.get(l.gameKey) ?? 0) + 1;
    perGame.set(l.gameKey, gN);
    if (gN > PER_GAME_CAP) continue;
    // Per-player cap keyed by playerId (UFA) or name (PUL/WUL box rows have no
    // id). Skip the cap for award-watch players (handled by award dedup).
    if (!l.awardWatch) {
      const pKey = l.playerId ?? `${l.league}:${l.playerName}`;
      const pN = (perPlayer.get(pKey) ?? 0) + 1;
      perPlayer.set(pKey, pN);
      if (pN > PER_PLAYER_CAP) continue;
    }
    capped.push(l);
  }

  // SEASON cards for award players who did NOT land a game card in the rail
  // (quiet week, no game, or their line got squeezed out by a cap) — so the
  // MVP/OPOY/DPOY always appears while the UFA season is live. Earners are
  // computed from CAPPED, not the pre-cap pool: an award line dropped by the
  // per-game cap must still fall through to a season card, or that award
  // silently vanishes (this is exactly how OPOY went missing).
  const awardGameEarners = new Set<string | null>();
  for (const l of capped) {
    if (l.awardWatch && l.playerId) awardGameEarners.add(l.playerId);
  }
  const seasonCards = awardsLive
    ? await ufaAwardSeasonCards(now, awardGameEarners).catch(() => [] as StandoutLine[])
    : [];
  capped.push(...seasonCards);

  // De-dup: keep only ONE card per award (their best line already sorted first),
  // so a leader with several recent games isn't shown repeatedly.
  const seenAward = new Set<AwardWatch>();
  const deduped: StandoutLine[] = [];
  for (const l of capped) {
    if (l.awardWatch) {
      if (seenAward.has(l.awardWatch)) continue;
      seenAward.add(l.awardWatch);
    }
    deduped.push(l);
  }

  // Award cards LEAD the carousel (in award precedence MVP → OPOY → DPOY) and
  // are exempt from the MAX_CARDS budget so they're always present regardless
  // of a quiet week.
  const AWARD_ORDER: Record<AwardWatch, number> = { MVP: 0, OPOY: 1, DPOY: 2, ROY: 3 };
  const awards = deduped
    .filter((l) => l.awardWatch)
    .sort((a, b) => AWARD_ORDER[a.awardWatch!] - AWARD_ORDER[b.awardWatch!]);

  // Everything else shares the rail by lane (UFA, PUL, WUL, each USAU Nationals
  // division): lanes take turns, each adding its next-best line (callahans
  // first, then perf), until the budget runs out. A single perf sort let one
  // league crowd out the rest — PUL has no yards, so its lines always sank to
  // the back (Hunter, 2026-10-28: show every league when seasons overlap).
  const rank = (a: StandoutLine, b: StandoutLine) =>
    (b.callahan ? 1 : 0) - (a.callahan ? 1 : 0) || b.perf - a.perf;
  const byLane = new Map<string, StandoutLine[]>();
  for (const l of deduped) {
    if (!l.awardWatch) byLane.set(l.lane, [...(byLane.get(l.lane) ?? []), l]);
  }
  const lanes = [...byLane.values()].map((ls) => ls.sort(rank)).sort((a, b) => rank(a[0], b[0]));
  const budget = Math.max(0, MAX_CARDS - awards.length);
  const rest: StandoutLine[] = [];
  for (let i = 0; rest.length < budget && lanes.some((ls) => i < ls.length); i++) {
    for (const ls of lanes) if (i < ls.length && rest.length < budget) rest.push(ls[i]);
  }
  return [...awards, ...rest];
}
