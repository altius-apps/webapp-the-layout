// Multi-league draft + roster operations for CONTEST teams.
//
// Which player pool a contest drafts from, how a roster is composed, and when
// it locks all come from the ContestView (competition def + frozen settings
// snapshot).
//
// Player identity per league (fantasy_roster_slots.player_league + player_id):
//   ufa  → ufa_players.id (stable slug)
//   pul  → player_name (the pul_* natural key; name-keyed like player_edges)
//   wul  → player_name (same)
//   usau → usau_players.id (uuid — joins usau_player_event_stats for scoring)
//   wfdf → wfdf_rosters.id (uuid — the roster ROW carries the event stats)
//   euf  → euf_rosters.id (uuid — same shape as wfdf)
//
// Lock enforcement: fantasy_contest_periods is the DB authority (generic
// trigger). The client check here exists only for a friendly error message.

import { createClient as createSessionClient } from '@/lib/supabase/client';
import { createClient as createAnonClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseUrl, supabaseAnonKey } from '@/lib/supabase/env';
import { scoreStatLine, roundPoints, type FantasyRole } from './scoring';
import type { FantasyPlayerHit } from './data';
import { getContestPeriods, periodsToWeeks, type ContestView } from './leagues';
import { contestDivision, type FantasyDivision, type FantasyPlayerLeague } from './competitions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

let _anon: AnyClient | null = null;
function anon(): AnyClient {
  if (_anon) return _anon;
  _anon = createAnonClient(supabaseUrl(), supabaseAnonKey(), {
    auth: { persistSession: false },
  });
  return _anon;
}

function sessionClient(): AnyClient {
  return createSessionClient() as unknown as AnyClient;
}

function escapeIlike(needle: string): string {
  return needle.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** ilike body with any whitespace run as a wildcard: some stored names carry
 *  double spaces ("Jessica  Oh"), which a literal "Jessica Oh" never matches. */
function likeWords(needle: string): string {
  return needle.split(/\s+/).map(escapeIlike).join('%');
}

/** Runs a name search with a prefix pattern alongside the substring one,
 *  prefix rows first: an alphabetical LIMIT can otherwise cut every name that
 *  starts with a short query (UFA "Ma" ends at "Lochlan Margison"). */
async function prefixFirst(
  run: (pattern: string) => PromiseLike<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>,
  needle: string,
): Promise<Record<string, unknown>[]> {
  const body = likeWords(needle);
  const [prefix, sub] = await Promise.all([run(`${body}%`), run(`%${body}%`)]);
  if (prefix.error) throw new Error(prefix.error.message);
  if (sub.error) throw new Error(sub.error.message);
  return [...(prefix.data ?? []), ...(sub.data ?? [])];
}

/** 0 = the name starts with the needle, 1 = a later word does, 2 = mid-word. */
function matchRank(name: string, needle: string): number {
  const hay = name.toLowerCase().replace(/\s+/g, ' ');
  const q = needle.toLowerCase().replace(/\s+/g, ' ');
  if (hay.startsWith(q)) return 0;
  for (let i = hay.indexOf(q, 1); i > 0; i = hay.indexOf(q, i + 1)) {
    if (/[\s'’.-]/.test(hay[i - 1])) return 1;
  }
  return 2;
}

/** One hit per player (first row wins), best match first, ties A–Z. */
function rankHits(hits: FantasyPlayerHit[], needle: string, limit: number): FantasyPlayerHit[] {
  const byId = new Map<string, { hit: FantasyPlayerHit; rank: number }>();
  for (const hit of hits) {
    if (!byId.has(hit.playerId)) byId.set(hit.playerId, { hit, rank: matchRank(hit.fullName, needle) });
  }
  return [...byId.values()]
    .sort((a, b) => a.rank - b.rank || a.hit.fullName.localeCompare(b.hit.fullName, undefined, { sensitivity: 'base' }))
    .slice(0, limit)
    .map((r) => r.hit);
}

/** Roles valid for a contest mode. */
export type ContestRole = FantasyRole | 'flex';

export interface ContestRosterSlot {
  playerId: string;
  playerLeague: FantasyPlayerLeague;
  role: ContestRole;
  fullName: string;
  teamName: string | null;
}

// ─── Player search per contest ───────────────────────────────────────────────

/** Search the draftable player pool for a contest. */
/** First season of a PUL/WUL contest's player pool: the pool is its own
 *  season's players plus the season before's. Season rows only appear with a
 *  player's first game, so a pre-season league would otherwise find nobody,
 *  and in-season nobody who hasn't played yet. Same rule as SQL
 *  public.fantasy_pool_first_season (add/drop, waiver and best-available). */
async function poolFirstSeason(table: 'pul_players' | 'wul_players', seasonYear: number): Promise<number> {
  const { data, error } = await anon()
    .from(table)
    .select('season')
    .lt('season', seasonYear)
    .order('season', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.season as number | undefined) ?? seasonYear;
}

/** usau_teams.gender_division value for each non-'all' league division. */
const USAU_GENDER_DIVISION: Record<Exclude<FantasyDivision, 'all'>, string> = {
  men: 'Men',
  women: 'Women',
  mixed: 'Mixed',
};

export async function searchContestPlayers(
  contest: ContestView,
  query: string,
  limit = 20,
): Promise<FantasyPlayerHit[]> {
  // PostgREST reads '*' in like patterns as '%', and no name contains one.
  const needle = query.replace(/\*/g, '').trim();
  if (needle.length < 2) return [];
  const league = contest.competitionDef.playerLeague;
  // The DB LIMIT applies before ranking: fetch more than we show so mid-word
  // matches can't crowd out names that start with the query.
  const pool = Math.min(limit * 5, 200);

  if (league === 'ufa') {
    const rows = await prefixFirst(
      (p) =>
        anon()
          .from('ufa_players')
          .select('id, full_name, current_team_id, ufa_teams:current_team_id (name, full_name)')
          .ilike('full_name', p)
          .order('full_name')
          .limit(pool),
      needle,
    );
    const hits = rows.map((r) => {
      const team = r.ufa_teams as { name?: string; full_name?: string } | null;
      return {
        playerId: r.id as string,
        fullName: (r.full_name as string) ?? (r.id as string),
        teamId: (r.current_team_id as string) ?? null,
        teamName: team?.full_name ?? team?.name ?? null,
      };
    });
    return rankHits(hits, needle, limit);
  }

  if (league === 'pul' || league === 'wul') {
    const table = league === 'pul' ? 'pul_players' : 'wul_players';
    const teamsRel = league === 'pul' ? 'pul_teams' : 'wul_teams';
    const firstSeason = await poolFirstSeason(table, contest.seasonYear);
    const rows = await prefixFirst(
      (p) =>
        anon()
          .from(table)
          .select(`player_name, team_id, ${teamsRel}:team_id (name, city, mascot)`)
          .gte('season', firstSeason)
          .lte('season', contest.seasonYear)
          .ilike('player_name', p)
          .order('player_name')
          .order('season', { ascending: false }) // dedup below keeps the newest team
          .limit(pool),
      needle,
    );
    const seen = new Set<string>();
    const hits: FantasyPlayerHit[] = [];
    for (const r of rows) {
      const name = r.player_name as string;
      if (seen.has(name)) continue;
      seen.add(name);
      const team = r[teamsRel] as { name?: string; city?: string; mascot?: string } | null;
      hits.push({
        playerId: name,
        fullName: name,
        teamId: (r.team_id as string) ?? null,
        teamName: team?.name ?? [team?.city, team?.mascot].filter(Boolean).join(' ') ?? null,
      });
    }
    return rankHits(hits, needle, limit);
  }

  if (league === 'usau') {
    const eventId = contest.settings.mode === 'event' ? contest.settings.eventId : undefined;
    if (!eventId) return [];
    // The contest event's own roster: the only players who can score
    // (score-fantasy reads stats for this event). Other events' rosters on the
    // same teams added non-attendees and same-name twins. One row per player,
    // and the broadest 2-char query ("an": 387 at 2026 Club Nats) fits under
    // the 1000-row cap, so ranking sees every match. Roster-driven on purpose:
    // driving from usau_players seq-scans its 400k rows on 2-char queries.
    // A division league keeps only rosters on that division's teams (the team
    // join turns inner only then, so an All league never loses a row to it).
    const division = contestDivision(contest.settings);
    let rosterQuery = anon()
      .from('usau_rosters')
      .select(
        `player_id, team_id, usau_players!inner (display_name), usau_teams:team_id${division === 'all' ? '' : '!inner'} (name)`,
      )
      .eq('event_id', eventId)
      .ilike('usau_players.display_name', `%${likeWords(needle)}%`);
    if (division !== 'all') rosterQuery = rosterQuery.eq('usau_teams.gender_division', USAU_GENDER_DIVISION[division]);
    const { data, error } = await rosterQuery.limit(1000);
    if (error) throw new Error(error.message);
    const hits = (data ?? []).map((raw: Record<string, unknown>) => {
      const p = raw.usau_players as { display_name?: string } | null;
      const t = raw.usau_teams as { name?: string } | null;
      return {
        playerId: raw.player_id as string,
        fullName: p?.display_name ?? 'Unknown',
        teamId: (raw.team_id as string) ?? null,
        teamName: t?.name ?? null,
      };
    });
    return rankHits(hits, needle, limit);
  }

  // wfdf / euf — roster rows ARE the player pool for the event.
  const eventId = contest.settings.mode === 'event' ? contest.settings.eventId : undefined;
  if (!eventId) return [];
  const table = league === 'euf' ? 'euf_rosters' : 'wfdf_rosters';
  const teamsRel = league === 'euf' ? 'euf_teams' : 'wfdf_teams';
  const rows = await prefixFirst(
    (p) =>
      anon()
        .from(table)
        .select(`id, full_name, team_id, ${teamsRel}:team_id (name, country_code)`)
        .eq('event_id', eventId)
        .ilike('full_name', p)
        .order('full_name')
        .limit(pool),
    needle,
  );
  const hits = rows.map((raw) => {
    const t = raw[teamsRel] as { name?: string; country_code?: string } | null;
    return {
      playerId: raw.id as string,
      fullName: (raw.full_name as string) ?? 'Unknown',
      teamId: (raw.team_id as string) ?? null,
      teamName: t?.name ?? t?.country_code ?? null,
    };
  });
  return rankHits(hits, needle, limit);
}

// ─── Roster read (public) ────────────────────────────────────────────────────

/** A contest team's roster for one period, with display names resolved. */
export async function getContestTeamRoster(
  contest: ContestView,
  teamId: string,
  period: string,
): Promise<ContestRosterSlot[]> {
  const { data, error } = await anon()
    .from('fantasy_roster_slots')
    .select('player_id, player_league, role')
    .eq('team_id', teamId)
    .eq('week', period);
  if (error) throw new Error(error.message);
  const slots = (data ?? []).map((r: Record<string, unknown>) => ({
    playerId: r.player_id as string,
    playerLeague: r.player_league as FantasyPlayerLeague,
    role: r.role as ContestRole,
  }));
  if (slots.length === 0) return [];

  const ids = slots.map((s) => s.playerId);
  const league = contest.competitionDef.playerLeague;
  const names = new Map<string, { fullName: string; teamName: string | null }>();

  if (league === 'ufa') {
    const { data: rows } = await anon()
      .from('ufa_players')
      .select('id, full_name, ufa_teams:current_team_id (name, full_name)')
      .in('id', ids);
    for (const raw of rows ?? []) {
      const r = raw as Record<string, unknown>;
      const t = r.ufa_teams as { name?: string; full_name?: string } | null;
      names.set(r.id as string, {
        fullName: (r.full_name as string) ?? (r.id as string),
        teamName: t?.full_name ?? t?.name ?? null,
      });
    }
  } else if (league === 'pul' || league === 'wul') {
    const table = league === 'pul' ? 'pul_players' : 'wul_players';
    const teamsRel = league === 'pul' ? 'pul_teams' : 'wul_teams';
    const { data: rows } = await anon()
      .from(table)
      .select(`player_name, ${teamsRel}:team_id (name, city, mascot)`)
      .gte('season', await poolFirstSeason(table, contest.seasonYear))
      .lte('season', contest.seasonYear)
      .in('player_name', ids)
      .order('season'); // the newest season's team is set last
    for (const raw of rows ?? []) {
      const r = raw as Record<string, unknown>;
      const t = r[teamsRel] as { name?: string; city?: string; mascot?: string } | null;
      names.set(r.player_name as string, {
        fullName: r.player_name as string,
        teamName: t?.name ?? [t?.city, t?.mascot].filter(Boolean).join(' ') ?? null,
      });
    }
  } else if (league === 'usau') {
    const { data: rows } = await anon()
      .from('usau_players')
      .select('id, display_name')
      .in('id', ids);
    for (const raw of rows ?? []) {
      const r = raw as Record<string, unknown>;
      names.set(r.id as string, {
        fullName: (r.display_name as string) ?? 'Unknown',
        teamName: null,
      });
    }
    // Team names via the event's roster mapping (bounded: 7 players).
    const eventId = contest.settings.mode === 'event' ? contest.settings.eventId : undefined;
    if (eventId) {
      const { data: rosterRows } = await anon()
        .from('usau_rosters')
        .select('player_id, usau_teams:team_id (name)')
        .eq('season', contest.seasonYear)
        .in('player_id', ids);
      for (const raw of rosterRows ?? []) {
        const r = raw as Record<string, unknown>;
        const t = r.usau_teams as { name?: string } | null;
        const cur = names.get(r.player_id as string);
        if (cur && t?.name) cur.teamName = t.name;
      }
    }
  } else {
    // wfdf / euf
    const table = league === 'euf' ? 'euf_rosters' : 'wfdf_rosters';
    const teamsRel = league === 'euf' ? 'euf_teams' : 'wfdf_teams';
    const { data: rows } = await anon()
      .from(table)
      .select(`id, full_name, ${teamsRel}:team_id (name, country_code)`)
      .in('id', ids);
    for (const raw of rows ?? []) {
      const r = raw as Record<string, unknown>;
      const t = r[teamsRel] as { name?: string; country_code?: string } | null;
      names.set(r.id as string, {
        fullName: (r.full_name as string) ?? 'Unknown',
        teamName: t?.name ?? t?.country_code ?? null,
      });
    }
  }

  return slots.map((s) => {
    const n = names.get(s.playerId);
    return {
      ...s,
      fullName: n?.fullName ?? s.playerId,
      teamName: n?.teamName ?? null,
    };
  });
}

// ─── Roster save (session) ───────────────────────────────────────────────────

export interface ContestRosterInput {
  playerId: string;
  role: ContestRole;
}

/**
 * Replace a contest team's roster for one period. Validates composition
 * against the contest's frozen settings and the period lock (friendly errors);
 * the DB composition + lock triggers are the real enforcement.
 */
export async function saveContestRoster(
  contest: ContestView,
  teamId: string,
  period: string,
  slots: ContestRosterInput[],
): Promise<void> {
  const supabase = sessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const s = contest.settings;
  if (s.mode === 'weekly-stats') {
    const off = slots.filter((x) => x.role === 'offender').length;
    const def = slots.filter((x) => x.role === 'defender').length;
    if (slots.length !== s.offenders + s.defenders || off !== s.offenders || def !== s.defenders) {
      throw new Error(`Roster must be exactly ${s.offenders} offenders and ${s.defenders} defenders.`);
    }
  } else {
    const flex = slots.filter((x) => x.role === 'flex').length;
    if (slots.length !== s.flex || flex !== s.flex) {
      throw new Error(`Roster must be exactly ${s.flex} players.`);
    }
  }
  const unique = new Set(slots.map((x) => x.playerId));
  if (unique.size !== slots.length) throw new Error('A player can only be rostered once.');

  // Lock check against the period table (the DB trigger is the backstop).
  //
  // Checks lockAt directly, NOT `locked`: `locked` is true only inside
  // [lockAt, unlockAt), so a finished week reads unlocked again once its
  // unlock passes. Since the write below is DELETE-then-INSERT, a stale pass
  // here would wipe a scored roster before the trigger rejected the insert.
  // A week whose lock has passed is over — unlockAt opens the NEXT week.
  const weeks = periodsToWeeks(await getContestPeriods(contest.id));
  const target = weeks.find((w) => w.week === period);
  if (!target) throw new Error('This period is not open for rosters yet.');
  if (target.lockAt && new Date(target.lockAt).getTime() <= Date.now()) {
    throw new Error('This roster is locked — play has started.');
  }

  const del = await supabase
    .from('fantasy_roster_slots')
    .delete()
    .eq('team_id', teamId)
    .eq('week', period);
  if (del.error) throw new Error(del.error.message);

  const league = contest.competitionDef.playerLeague;
  const rows = slots.map((x) => ({
    team_id: teamId,
    week: period,
    player_id: x.playerId,
    player_league: league,
    role: x.role,
  }));
  const ins = await supabase.from('fantasy_roster_slots').insert(rows);
  if (ins.error) throw new Error(ins.error.message);
}

// ─── Draft preview (weekly-stats leagues only) ───────────────────────────────

/**
 * Season-to-date points a player would score in a role — the builder's
 * "gamble" hint. Uses the leagues' season-aggregate tables (cheap single-row
 * reads). Event-mode competitions return null (no meaningful prior data).
 */
export async function previewContestPlayerPoints(
  contest: ContestView,
  playerId: string,
  role: FantasyRole,
): Promise<number | null> {
  const league = contest.competitionDef.playerLeague;

  if (league === 'ufa') {
    const { data, error } = await anon()
      .from('ufa_game_player_stats')
      .select('goals, assists, blocks, throwaways, drops, stalls, yards_thrown, yards_received, ufa_games!inner(year)')
      .eq('player_id', playerId)
      .eq('ufa_games.year', contest.seasonYear);
    if (error) throw new Error(error.message);
    let total = 0;
    for (const raw of data ?? []) {
      const r = raw as unknown as Record<string, number>;
      total += scoreStatLine(
        {
          goals: r.goals ?? 0,
          assists: r.assists ?? 0,
          blocks: r.blocks ?? 0,
          turnovers: (r.throwaways ?? 0) + (r.drops ?? 0) + (r.stalls ?? 0),
          yards: (r.yards_thrown ?? 0) + (r.yards_received ?? 0),
        },
        role,
      );
    }
    return roundPoints(total);
  }

  if (league === 'pul' || league === 'wul') {
    const table = league === 'pul' ? 'pul_players' : 'wul_players';
    // pul_players has no yardage column at all — only select it for WUL.
    const cols = league === 'wul' ? 'goals, assists, blocks, turnovers, yards_total' : 'goals, assists, blocks, turnovers';
    const { data, error } = await anon()
      .from(table)
      .select(cols)
      .eq('season', contest.seasonYear)
      .eq('player_name', playerId);
    if (error) throw new Error(error.message);
    let total = 0;
    for (const raw of data ?? []) {
      const r = raw as unknown as Record<string, number | null>;
      total += scoreStatLine(
        {
          goals: r.goals ?? 0,
          assists: r.assists ?? 0,
          blocks: r.blocks ?? 0,
          turnovers: r.turnovers ?? 0,
          yards: league === 'wul' ? (r.yards_total as number | null) ?? 0 : 0,
        },
        role,
      );
    }
    return roundPoints(total);
  }

  return null; // event-mode: no pre-event preview
}
