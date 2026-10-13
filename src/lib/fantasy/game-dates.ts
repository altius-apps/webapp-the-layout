// "Can a league start in this game right now — and against which season or
// event?" ONE function behind the hub's Start a League list AND the
// create-league page (2026-09-13), so the list, the form's game picker and
// createContest can never disagree. A game is startable only while its next
// season/event still has its first lock ahead — never one that has started:
//   • event games (USAU Nationals, WFDF, EUCS) → resolveEventForCompetition:
//     the next event whose start_date (its only lock, 00:00 ET) is after today.
//   • UFA → the earliest ufa_games week whose first game (the lock
//     fantasy_rebuild_contest_periods builds from that same table) is still
//     ahead. The row reads just "{season} season", no date (Hunter,
//     2026-09-13: the season runs April–August).
//   • PUL / WUL (coming soon, display only) → the next scheduled game.
// The season always comes from that data, never from the calendar year.
//
// Client-safe (anon reads only): the create form re-checks its game with
// nextStartForGame at submit time. Pages read it through the cached wrapper
// in game-dates-cached.ts.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseUrl, supabaseAnonKey } from '@/lib/supabase/env';
import { usauToday } from '@/lib/today';
import type { CompetitionId } from './competitions';
import { getCompetition } from './competitions';
import { resolveEventForCompetition } from './leagues';
import { GAMES } from './games';
import type { GameDef } from './games';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

let _anon: AnyClient | null = null;
function anon(): AnyClient {
  if (_anon) return _anon;
  _anon = createClient(supabaseUrl(), supabaseAnonKey(), {
    auth: { persistSession: false },
  });
  return _anon;
}

export interface GameStart {
  /** A league founded now has something to play: the season/event below
   *  still has its first lock ahead. */
  startable: boolean;
  /** Season of that upcoming start, from the data. Null when nothing is startable. */
  seasonYear: number | null;
  /** 'YYYY-MM-DD' dates the row prints (event dates, next PUL/WUL game). Null
   *  for UFA (label only) and when nothing is scheduled. */
  startDate: string | null;
  endDate: string | null;
  /** 'YYYY-MM-DD' (ET) of the real next start — orders the hub list. */
  sortDate: string | null;
  /** Event name for tournaments, "2027 season" for leagues. */
  label: string | null;
}

const UNSCHEDULED: GameStart = {
  startable: false,
  seasonYear: null,
  startDate: null,
  endDate: null,
  sortDate: null,
  label: null,
};

async function eventStart(competition: CompetitionId): Promise<GameStart> {
  const ev = await resolveEventForCompetition(competition, null);
  if (!ev) return UNSCHEDULED;
  return {
    startable: true,
    seasonYear: ev.seasonYear,
    startDate: ev.startDate,
    endDate: ev.endDate,
    sortDate: ev.startDate,
    label: ev.name,
  };
}

/** Earliest UFA week whose first game — its period lock
 *  (fantasy_rebuild_contest_periods: lock_at = min(start_timestamp) per week)
 *  — is still ahead. Read from ufa_games, the table the contest's periods are
 *  built from, so "startable" always means the contest gets an open week. */
async function ufaStart(): Promise<GameStart> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  let afterSeason: number | null = null;
  // Two passes at most: the season of the next game, then — if that season's
  // remaining games all sit in weeks that already locked — the following one.
  for (let pass = 0; pass < 2; pass++) {
    let q = anon().from('ufa_games').select('year').gt('start_timestamp', nowIso).not('week', 'is', null);
    if (afterSeason != null) q = q.gt('year', afterSeason);
    const { data: next, error } = await q.order('start_timestamp', { ascending: true }).limit(1).maybeSingle();
    if (error) throw new Error(error.message);
    if (!next) return UNSCHEDULED;
    const season = next.year as number;

    // One season's schedule (~150 rows, well under the 1000-row response cap).
    const { data: games, error: gamesError } = await anon()
      .from('ufa_games')
      .select('week, start_timestamp')
      .eq('year', season)
      .not('week', 'is', null);
    if (gamesError) throw new Error(gamesError.message);
    const lockByWeek = new Map<string, number>();
    for (const g of (games ?? []) as { week: string; start_timestamp: string }[]) {
      if (g.week.trim() === '') continue;
      const t = Date.parse(g.start_timestamp);
      const cur = lockByWeek.get(g.week);
      if (cur == null || t < cur) lockByWeek.set(g.week, t);
    }
    const nextLock = [...lockByWeek.values()].filter((t) => t > now).sort((a, b) => a - b)[0];
    if (nextLock != null) {
      return {
        startable: true,
        seasonYear: season,
        startDate: null,
        endDate: null,
        sortDate: usauToday(new Date(nextLock)),
        label: `${season} season`,
      };
    }
    afterSeason = season;
  }
  return UNSCHEDULED;
}

/** PUL / WUL: the next scheduled game. Games are date-only and lock at 00:00
 *  ET, so one that's today has already locked. */
async function leagueStart(table: 'pul_games' | 'wul_games'): Promise<GameStart> {
  const { data, error } = await anon()
    .from(table)
    .select('season, game_date')
    .gt('game_date', usauToday())
    .order('game_date', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return UNSCHEDULED;
  const season = data.season as number;
  return {
    startable: true,
    seasonYear: season,
    startDate: data.game_date as string,
    endDate: null,
    sortDate: data.game_date as string,
    label: `${season} season`,
  };
}

export async function nextStartForGame(competition: CompetitionId): Promise<GameStart> {
  const def = getCompetition(competition);
  if (!def) return UNSCHEDULED;
  if (def.mode === 'event') return eventStart(competition);
  if (competition === 'ufa') return ufaStart();
  if (competition === 'pul') return leagueStart('pul_games');
  if (competition === 'wul') return leagueStart('wul_games');
  return UNSCHEDULED;
}

export type GameStartMap = Partial<Record<CompetitionId, GameStart>>;

/** Every hub game's start, resolved in parallel (one failure never hides
 *  the rest — a failed lookup reads as "Dates TBA"). */
export async function getGameStartDates(games: GameDef[] = GAMES): Promise<GameStartMap> {
  const entries = await Promise.all(
    games.map(async (g) => {
      const start = await nextStartForGame(g.id).catch((): GameStart => UNSCHEDULED);
      return [g.id, start] as const;
    }),
  );
  const out: GameStartMap = {};
  for (const [id, start] of entries) out[id] = start;
  return out;
}

/** Sort games by their real next start (sortDate); unknown last, registry
 *  order preserved within each group. */
export function sortGamesBySoonest(games: GameDef[], starts: GameStartMap): GameDef[] {
  return games
    .map((g, idx) => ({ g, idx, date: starts[g.id]?.sortDate ?? null }))
    .sort((a, b) => {
      if (a.date && b.date) return a.date < b.date ? -1 : a.date > b.date ? 1 : a.idx - b.idx;
      if (a.date) return -1;
      if (b.date) return 1;
      return a.idx - b.idx;
    })
    .map((x) => x.g);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 22–25" · "Oct 31 – Nov 2" · "Apr 3" · "Apr 3, 2027" when not this year. */
export function formatStartRange(start: string | null, end: string | null): string {
  if (!start) return 'Dates TBA';
  const parse = (iso: string): Date => new Date(`${iso}T12:00:00Z`);
  const s = parse(start);
  if (Number.isNaN(s.getTime())) return 'Dates TBA';
  const thisYear = new Date().getFullYear();
  const yearSuffix = s.getUTCFullYear() !== thisYear ? `, ${s.getUTCFullYear()}` : '';
  const sm = MONTHS[s.getUTCMonth()];
  const sd = s.getUTCDate();
  if (!end || end === start) return `${sm} ${sd}${yearSuffix}`;
  const e = parse(end);
  if (Number.isNaN(e.getTime())) return `${sm} ${sd}${yearSuffix}`;
  const em = MONTHS[e.getUTCMonth()];
  const ed = e.getUTCDate();
  return sm === em ? `${sm} ${sd}–${ed}${yearSuffix}` : `${sm} ${sd} – ${em} ${ed}${yearSuffix}`;
}
