// score-fantasy: compute + persist fantasy scores — CONTEST-AWARE. (v4)
//
// Every fantasy team belongs to a private-league fantasy_contests row. Each run:
//
//   1. Refreshes fantasy_contest_periods via fantasy_rebuild_all_periods()
//      (SQL owns the lock schedule — this fn only READS periods).
//   2. For every non-complete contest, scores every LOCKED period's FROZEN
//      rosters against that contest's competition data and upserts one
//      fantasy_scores row per (team, period). Idempotent.
//   3. (v4) format=h2h weekly contests additionally get their fantasy_matchups
//      rows filled in from those same scores, and — once the regular season
//      completes — semifinal/final/third-place rows generated from standings.
//
// Competition sources:
//   ufa  — ufa_game_player_stats per native week           (full statline)
//   pul  — pul_game_player_stats per week_label            (no yards)
//   wul  — wul_game_player_stats per synthesized week      (Monday buckets,
//          'week-N' by chronological order — MIRRORS fantasy_rebuild_contest_periods)
//   usau — usau_player_event_stats event totals (G/A only; no placement bonus
//          in v1 — final_placement coverage is too sparse to be fair)
//   wfdf — wfdf_rosters event totals (G/A/callahans) + final_standing bonus
//   euf  — euf_rosters event totals (G/A only; no placement bonus — mirrors USAU)
//
// Scope rule (unchanged, confirmed 2026-07-05): a period scores the roster
// saved FOR that period. No roster → no row (0). New teams start scoring from
// the next period they set a lineup for.
//
// Request body (all optional): { "contest": "<uuid>" } → only score that one.
//
// Auth: verify_jwt. Called by pg_cron with the vault service-role key.
//
// ⚠️ MIRROR: the scoring matrices duplicate src/lib/fantasy/scoring.ts and
// src/lib/fantasy/event-adapter.ts (edge fns can't import src/). Change BOTH.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

// ── Scoring matrices (keep in lockstep with src/lib/fantasy/) ────────────────
type FantasyRole = 'offender' | 'defender' | 'flex';
const SCORING = {
  offender: { goal: 3, assist: 3, block: 2, turnover: -1 },
  defender: { goal: 2, assist: 2, block: 5, turnover: -1 },
  yardsPerPoint: 100,
} as const;

const EVENT_SCORING = { goal: 3, assist: 3, callahan: 5 } as const;

// USAU/WFDF/EUCS player ids are uuids (usau_player_event_stats.player_id,
// wfdf_rosters.id, euf_rosters.id): one junk id in an .in() list makes
// PostgREST 400 the whole query.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function placementBonus(placement: number | null | undefined): number {
  if (placement == null || placement < 1) return 0;
  if (placement === 1) return 30;
  if (placement === 2) return 20;
  if (placement <= 4) return 12;
  if (placement <= 8) return 6;
  return 0;
}

interface StatLine {
  goals: number;
  assists: number;
  blocks: number;
  turnovers: number;
  yards: number;
}

function scoreStatLine(line: StatLine, role: 'offender' | 'defender'): number {
  const v = SCORING[role];
  return (
    line.goals * v.goal +
    line.assists * v.assist +
    line.blocks * v.block +
    line.turnovers * v.turnover +
    line.yards / SCORING.yardsPerPoint
  );
}

function db(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key, { auth: { persistSession: false } });
}

// Page helper — PostgREST caps a response at 1000 rows.
async function fetchAll<T>(
  build: (from: number, to: number) => any,
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Types ────────────────────────────────────────────────────────────────────

type Competition =
  | 'ufa'
  | 'pul'
  | 'wul'
  | 'usau-club-nationals'
  | 'usau-college-nationals'
  | 'wfdf-wucc'
  | 'eucs';

interface ContestRow {
  id: string;
  league_id: string;
  competition: Competition;
  season_year: number;
  status: string;
  settings: { mode?: string; eventId?: string; format?: 'h2h' | 'points'; schedule?: { regular: string[]; semifinal: string; final: string } } | null;
}

interface PeriodRow {
  contest_id: string;
  period: string;
  lock_at: string | null;
  complete: boolean;
}

interface TeamRow {
  id: string;
  contest_id: string;
}

interface SlotRow {
  team_id: string;
  week: string;
  player_id: string;
  player_league: string;
  role: FantasyRole;
}

// ── Weekly-stats contexts (per competition+season, cached across contests) ──
// weekLines: period → playerKey → summed StatLine for that period.

type WeekLines = Map<string, Map<string, StatLine>>;

function addLine(
  weekLines: WeekLines,
  period: string,
  key: string,
  add: StatLine,
): void {
  let per = weekLines.get(period);
  if (!per) {
    per = new Map();
    weekLines.set(period, per);
  }
  const line = per.get(key) ?? { goals: 0, assists: 0, blocks: 0, turnovers: 0, yards: 0 };
  line.goals += add.goals;
  line.assists += add.assists;
  line.blocks += add.blocks;
  line.turnovers += add.turnovers;
  line.yards += add.yards;
  per.set(key, line);
}

async function ufaWeekLines(supabase: SupabaseClient, year: number): Promise<WeekLines> {
  const games = await fetchAll<{ id: string; week: string | null }>((from, to) =>
    supabase
      .from('ufa_games')
      .select('id, week')
      .eq('year', year)
      .not('week', 'is', null)
      .order('id')
      .range(from, to),
  );
  const weekOf = new Map(games.map((g) => [g.id, g.week as string]));
  const out: WeekLines = new Map();
  const ids = games.map((g) => g.id);
  for (const part of chunk(ids, 150)) {
    const stats = await fetchAll<Record<string, any>>((from, to) =>
      supabase
        .from('ufa_game_player_stats')
        .select('game_id, player_id, goals, assists, blocks, throwaways, drops, stalls, yards_thrown, yards_received')
        .in('game_id', part)
        .order('game_id')
        .range(from, to),
    );
    for (const s of stats) {
      const wk = weekOf.get(s.game_id);
      if (!wk) continue;
      addLine(out, wk, s.player_id, {
        goals: s.goals ?? 0,
        assists: s.assists ?? 0,
        blocks: s.blocks ?? 0,
        turnovers: (s.throwaways ?? 0) + (s.drops ?? 0) + (s.stalls ?? 0),
        yards: (s.yards_thrown ?? 0) + (s.yards_received ?? 0),
      });
    }
  }
  return out;
}

async function pulWeekLines(supabase: SupabaseClient, season: number): Promise<WeekLines> {
  const games = await fetchAll<{ id: string; week_label: string | null }>((from, to) =>
    supabase
      .from('pul_games')
      .select('id, week_label')
      .eq('season', season)
      .not('week_label', 'is', null)
      .order('id')
      .range(from, to),
  );
  const periodOf = new Map(games.map((g) => [g.id, g.week_label as string]));
  const out: WeekLines = new Map();
  for (const part of chunk(games.map((g) => g.id), 150)) {
    const stats = await fetchAll<Record<string, any>>((from, to) =>
      supabase
        .from('pul_game_player_stats')
        .select('game_id, player_name, goals, assists, blocks, turnovers')
        .in('game_id', part)
        .order('game_id')
        .range(from, to),
    );
    for (const s of stats) {
      const period = periodOf.get(s.game_id);
      if (!period) continue;
      addLine(out, period, s.player_name, {
        goals: s.goals ?? 0,
        assists: s.assists ?? 0,
        blocks: s.blocks ?? 0,
        turnovers: s.turnovers ?? 0,
        yards: 0, // PUL tracks no yardage
      });
    }
  }
  return out;
}

/** Monday (ISO week start) of a 'YYYY-MM-DD' date — the WUL synthesized-week
 *  bucket key. MIRRORS date_trunc('week', game_date) in
 *  fantasy_rebuild_contest_periods; both must bucket identically. */
function mondayKey(date: string): string | null {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}

async function wulWeekLines(supabase: SupabaseClient, season: number): Promise<WeekLines> {
  const games = await fetchAll<{ id: string; game_date: string | null }>((from, to) =>
    supabase
      .from('wul_games')
      .select('id, game_date')
      .eq('season', season)
      .not('game_date', 'is', null)
      .order('id')
      .range(from, to),
  );
  // Chronological Monday buckets → 'week-N' (mirrors the SQL dense_rank).
  const mondays = [...new Set(games.map((g) => mondayKey(g.game_date as string)).filter(Boolean))] as string[];
  mondays.sort();
  const labelOf = new Map(mondays.map((m, i) => [m, `week-${i + 1}`]));
  const periodOf = new Map(
    games.map((g) => [g.id, labelOf.get(mondayKey(g.game_date as string) ?? '') ?? null]),
  );

  const out: WeekLines = new Map();
  for (const part of chunk(games.map((g) => g.id), 150)) {
    const stats = await fetchAll<Record<string, any>>((from, to) =>
      supabase
        .from('wul_game_player_stats')
        .select('game_id, player_name, goals, assists, blocks, turnovers, throw_yards, receive_yards, total_yards')
        .in('game_id', part)
        .order('game_id')
        .range(from, to),
    );
    for (const s of stats) {
      const period = periodOf.get(s.game_id);
      if (!period) continue;
      addLine(out, period, s.player_name, {
        goals: s.goals ?? 0,
        assists: s.assists ?? 0,
        blocks: s.blocks ?? 0,
        turnovers: s.turnovers ?? 0,
        yards: s.total_yards ?? (s.throw_yards ?? 0) + (s.receive_yards ?? 0),
      });
    }
  }
  return out;
}

// ── Event contexts (per eventId): playerKey → event points ──────────────────

async function usauEventPoints(
  supabase: SupabaseClient,
  eventId: string,
  playerIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = playerIds.filter((id) => UUID_RE.test(id));
  if (ids.length === 0) return out;

  // NO placement bonus for USAU in v1: usau_event_teams.final_placement
  // coverage is sparse/inconsistent (verified 2026-08-15 — e.g. 42/48 at 2025
  // Club Nats, 0–8/40 at College), so a bonus would pay some teams and
  // silently skip others in the SAME event. G/A only until placement
  // derivation is built. WFDF keeps its bonus (final_standing is complete).

  // Event stat totals (G/A only — that's all USAU publishes).
  for (const part of chunk(ids, 150)) {
    const stats = await fetchAll<Record<string, any>>((from, to) =>
      supabase
        .from('usau_player_event_stats')
        .select('player_id, goals, assists')
        .eq('event_id', eventId)
        .in('player_id', part)
        .order('player_id')
        .range(from, to),
    );
    for (const s of stats) {
      const pts = (s.goals ?? 0) * EVENT_SCORING.goal + (s.assists ?? 0) * EVENT_SCORING.assist;
      out.set(s.player_id, (out.get(s.player_id) ?? 0) + pts);
    }
  }
  return out;
}

async function eufEventPoints(
  supabase: SupabaseClient,
  eventId: string,
  playerIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = playerIds.filter((id) => UUID_RE.test(id));
  if (ids.length === 0) return out;

  // No placement bonus for EUF in v1 — mirrors USAU (no final-standing data
  // ingested for EUCS yet). G/A only.
  for (const part of chunk(ids, 150)) {
    const rows = await fetchAll<Record<string, any>>((from, to) =>
      supabase
        .from('euf_rosters')
        .select('id, event_id, goals, assists')
        .eq('event_id', eventId)
        .in('id', part)
        .order('id')
        .range(from, to),
    );
    for (const r of rows) {
      const pts = (r.goals ?? 0) * EVENT_SCORING.goal + (r.assists ?? 0) * EVENT_SCORING.assist;
      out.set(r.id, pts);
    }
  }
  return out;
}

async function wfdfEventPoints(
  supabase: SupabaseClient,
  eventId: string,
  playerIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = playerIds.filter((id) => UUID_RE.test(id));
  if (ids.length === 0) return out;

  const teams = await fetchAll<{ id: string; final_standing: number | null }>((from, to) =>
    supabase
      .from('wfdf_teams')
      .select('id, final_standing')
      .eq('event_id', eventId)
      .order('id')
      .range(from, to),
  );
  const standingOf = new Map(teams.map((t) => [t.id, t.final_standing]));

  for (const part of chunk(ids, 150)) {
    const rows = await fetchAll<Record<string, any>>((from, to) =>
      supabase
        .from('wfdf_rosters')
        .select('id, team_id, goals, assists, callahans')
        .in('id', part)
        .order('id')
        .range(from, to),
    );
    for (const r of rows) {
      const pts =
        (r.goals ?? 0) * EVENT_SCORING.goal +
        (r.assists ?? 0) * EVENT_SCORING.assist +
        (r.callahans ?? 0) * EVENT_SCORING.callahan +
        placementBonus(standingOf.get(r.team_id));
      out.set(r.id, pts);
    }
  }
  return out;
}

// ── Main run ─────────────────────────────────────────────────────────────────

async function run(body: { contest?: string }) {
  const supabase = db();
  const nowMs = Date.now();

  // 1. Refresh the lock schedule (SQL owns it).
  const { error: rebuildErr } = await supabase.rpc('fantasy_rebuild_all_periods');
  if (rebuildErr) console.error('[score-fantasy] period rebuild failed:', rebuildErr.message);

  // 1b. Roster moves that were waiting on a clock: accepted trades past their
  // 24 h review and due FAAB waiver claims (both no-op inside a lock window
  // and get retried next tick). Service-role-only RPCs.
  const { data: tradesRun, error: tradesErr } = await supabase.rpc('fantasy_execute_due_trades');
  if (tradesErr) console.error('[score-fantasy] execute_due_trades failed:', tradesErr.message);
  const { data: waiversRun, error: waiversErr } = await supabase.rpc('fantasy_process_waivers');
  if (waiversErr) console.error('[score-fantasy] process_waivers failed:', waiversErr.message);

  // 2. Contests to score.
  const contests = await fetchAll<ContestRow>((from, to) => {
    let q = supabase
      .from('fantasy_contests')
      .select('id, league_id, competition, season_year, status, settings')
      .neq('status', 'complete')
      .order('id')
      .range(from, to);
    if (body.contest) q = q.eq('id', body.contest);
    return q;
  });
  if (contests.length === 0) return { contestsScored: 0, contestsFailed: [] as string[], rowsUpserted: 0, note: 'no contests', tradesExecuted: (tradesRun as number) ?? 0, waiversWon: (waiversRun as number) ?? 0 };

  // 3. Locked periods per contest.
  const periods = await fetchAll<PeriodRow>((from, to) =>
    supabase
      .from('fantasy_contest_periods')
      .select('contest_id, period, lock_at, complete')
      .in('contest_id', contests.map((c) => c.id))
      .order('contest_id')
      .range(from, to),
  );
  const lockedPeriods = new Map<string, Set<string>>(); // contest → periods
  const completePeriods = new Map<string, Set<string>>(); // contest → periods with every game final
  for (const p of periods) {
    if (!p.lock_at || nowMs < new Date(p.lock_at).getTime()) continue;
    let set = lockedPeriods.get(p.contest_id);
    if (!set) {
      set = new Set();
      lockedPeriods.set(p.contest_id, set);
    }
    set.add(p.period);
    if (p.complete) {
      let done = completePeriods.get(p.contest_id);
      if (!done) {
        done = new Set();
        completePeriods.set(p.contest_id, done);
      }
      done.add(p.period);
    }
  }

  // 4. Teams → contest.
  const teams = await fetchAll<TeamRow>((from, to) =>
    supabase
      .from('fantasy_teams')
      .select('id, contest_id')
      .order('id')
      .range(from, to),
  );
  const contestOfTeam = new Map<string, string>();
  for (const t of teams) {
    contestOfTeam.set(t.id, t.contest_id);
  }

  // 5. All roster slots, attributed to (contest, period); keep only locked ones.
  const slots = await fetchAll<SlotRow>((from, to) =>
    supabase
      .from('fantasy_roster_slots')
      .select('team_id, week, player_id, player_league, role')
      .order('id')
      .range(from, to),
  );
  // contest → team → period → slots
  const work = new Map<string, Map<string, Map<string, SlotRow[]>>>();
  const playersByContest = new Map<string, Set<string>>();
  for (const s of slots) {
    const cid = contestOfTeam.get(s.team_id);
    if (!cid) continue;
    if (!lockedPeriods.get(cid)?.has(s.week)) continue;
    let byTeam = work.get(cid);
    if (!byTeam) {
      byTeam = new Map();
      work.set(cid, byTeam);
    }
    let byPeriod = byTeam.get(s.team_id);
    if (!byPeriod) {
      byPeriod = new Map();
      byTeam.set(s.team_id, byPeriod);
    }
    const arr = byPeriod.get(s.week);
    if (arr) arr.push(s);
    else byPeriod.set(s.week, [s]);
    let ps = playersByContest.get(cid);
    if (!ps) {
      ps = new Set();
      playersByContest.set(cid, ps);
    }
    ps.add(s.player_id);
  }

  // 6. Score contest by contest (stat contexts cached per competition+season).
  const weeklyCache = new Map<string, WeekLines>();
  // comp:season stat loads that threw this run: the other contests on them
  // fail fast instead of re-running the failing query.
  const failedLines = new Set<string>();
  const upserts: { team_id: string; week: string; points: number; computed_at: string }[] = [];
  let contestsScored = 0;
  // One contest's bad data must not block every other league's scores.
  const contestsFailed: string[] = [];

  for (const contest of contests) {
    const byTeam = work.get(contest.id);
    if (!byTeam || byTeam.size === 0) continue;
    contestsScored += 1;
    const comp = contest.competition;
    try {
      if (comp === 'ufa' || comp === 'pul' || comp === 'wul') {
        const cacheKey = `${comp}:${contest.season_year}`;
        let lines = weeklyCache.get(cacheKey);
        if (!lines) {
          if (failedLines.has(cacheKey)) throw new Error(`${cacheKey} stats already failed this run`);
          failedLines.add(cacheKey);
          lines =
            comp === 'ufa'
              ? await ufaWeekLines(supabase, contest.season_year)
              : comp === 'pul'
                ? await pulWeekLines(supabase, contest.season_year)
                : await wulWeekLines(supabase, contest.season_year);
          failedLines.delete(cacheKey);
          weeklyCache.set(cacheKey, lines);
        }
        for (const [teamId, byPeriod] of byTeam) {
          for (const [period, roster] of byPeriod) {
            const per = lines.get(period);
            let points = 0;
            for (const slot of roster) {
              if (slot.role === 'flex') continue; // not valid in weekly mode
              const line = per?.get(slot.player_id);
              if (line) points += scoreStatLine(line, slot.role);
            }
            upserts.push({
              team_id: teamId,
              week: period,
              points: Math.round(points * 100) / 100,
              computed_at: new Date().toISOString(),
            });
          }
        }
      } else {
        // Event mode.
        const eventId = contest.settings?.eventId;
        if (!eventId) {
          console.error(`[score-fantasy] contest ${contest.id} (${comp}) has no eventId — skipped`);
          continue;
        }
        const playerIds = [...(playersByContest.get(contest.id) ?? [])];
        const pointsOf =
          comp === 'wfdf-wucc'
            ? await wfdfEventPoints(supabase, eventId, playerIds)
            : comp === 'eucs'
              ? await eufEventPoints(supabase, eventId, playerIds)
              : await usauEventPoints(supabase, eventId, playerIds);
        for (const [teamId, byPeriod] of byTeam) {
          for (const [period, roster] of byPeriod) {
            let points = 0;
            for (const slot of roster) points += pointsOf.get(slot.player_id) ?? 0;
            upserts.push({
              team_id: teamId,
              week: period,
              points: Math.round(points * 100) / 100,
              computed_at: new Date().toISOString(),
            });
          }
        }
      }
    } catch (err) {
      console.error(`[score-fantasy] contest ${contest.id} (${comp}) failed:`, err);
      contestsFailed.push(contest.id);
    }
  }

  // 7. Chunked upsert on (team_id, week).
  for (const part of chunk(upserts, 500)) {
    const { error } = await supabase.from('fantasy_scores').upsert(part, { onConflict: 'team_id,week' });
    if (error) throw error;
  }

  // 8. H2H fill-in: for format=h2h weekly contests, write matchup points/
  // winners from the scores just computed (or already on file, for locked
  // periods this run didn't touch), then seed playoff rounds once eligible.
  let matchupsUpdated = 0;
  const decidedMatchupIds: string[] = []; // rows this run set scored=true → matchup_result pushes
  const decidedRows: Array<{ contest: ContestRow; matchup: Record<string, any>; period: string; homePts: number; awayPts: number; winnerTeamId: string | null }> = [];
  // A contest that failed to score this run must not finalize matchups on its
  // stale scores.
  const failed = new Set(contestsFailed);
  const h2hContests = contests.filter(
    (c) =>
      !failed.has(c.id) &&
      (c.competition === 'ufa' || c.competition === 'pul' || c.competition === 'wul') &&
      c.settings?.format === 'h2h',
  );

  if (h2hContests.length > 0) {
    // team_id|week -> points, seeded from this run's upserts.
    const scoreMap = new Map<string, number>();
    for (const u of upserts) scoreMap.set(`${u.team_id}|${u.week}`, u.points);

    for (const contest of h2hContests) {
      const matchups = await fetchAll<Record<string, any>>((from, to) =>
        supabase
          .from('fantasy_matchups')
          .select('id, period, stage, home_team_id, away_team_id, scored')
          .eq('contest_id', contest.id)
          .eq('scored', false)
          .order('id')
          .range(from, to),
      );
      if (matchups.length === 0) continue;

      const locked = lockedPeriods.get(contest.id) ?? new Set<string>();
      const pending = matchups.filter((m) => m.away_team_id !== null && locked.has(m.period));
      if (pending.length === 0) continue;

      // Fallback: read fantasy_scores for any (team, period) not covered by
      // this run's upserts (a period locked in a prior run, not rescored now).
      const missingKeys: { team_id: string; week: string }[] = [];
      for (const m of pending) {
        for (const teamId of [m.home_team_id, m.away_team_id as string]) {
          if (!scoreMap.has(`${teamId}|${m.period}`)) missingKeys.push({ team_id: teamId, week: m.period });
        }
      }
      if (missingKeys.length > 0) {
        const teamIds = [...new Set(missingKeys.map((k) => k.team_id))];
        const fallback = await fetchAll<{ team_id: string; week: string; points: number }>((from, to) =>
          supabase.from('fantasy_scores').select('team_id, week, points').in('team_id', teamIds).order('team_id').range(from, to),
        );
        for (const f of fallback) scoreMap.set(`${f.team_id}|${f.week}`, Number(f.points));
      }

      // Period completeness = every matchup for that (contest, period) is
      // now resolvable (home + away both have a score on file).
      const periodRows = new Map<string, typeof pending>();
      for (const m of pending) {
        const arr = periodRows.get(m.period) ?? [];
        arr.push(m);
        periodRows.set(m.period, arr);
      }

      // A matchup is only FINAL (scored=true, winner set) once its period is
      // complete — every game in the week is Final. While the week is still in
      // play the hourly run keeps refreshing the running points only, so a
      // result is never frozen on a half-played week.
      const complete = completePeriods.get(contest.id) ?? new Set<string>();

      for (const [period, rows] of periodRows) {
        const isFinal = complete.has(period);

        for (const m of rows) {
          const homePts = scoreMap.get(`${m.home_team_id}|${period}`) ?? 0;
          const awayPts = scoreMap.get(`${(m.away_team_id as string)}|${period}`) ?? 0;
          let winnerTeamId: string | null = null;
          if (isFinal) {
            if (homePts !== awayPts) {
              winnerTeamId = homePts > awayPts ? m.home_team_id : (m.away_team_id as string);
            } else if (m.stage !== 'regular') {
              // Playoff tie-break: higher seed wins (home is always the higher
              // seed for semis/final per the seeding pass below).
              winnerTeamId = m.home_team_id;
            }
          }
          const { error } = await supabase
            .from('fantasy_matchups')
            .update({
              home_points: Math.round(homePts * 100) / 100,
              away_points: Math.round(awayPts * 100) / 100,
              winner_team_id: winnerTeamId,
              scored: isFinal,
            })
            .eq('id', m.id);
          if (error) throw error;
          matchupsUpdated += 1;
          if (isFinal) {
            decidedMatchupIds.push(m.id as string);
            decidedRows.push({ contest, matchup: m, period, homePts, awayPts, winnerTeamId });
          }
        }
      }
    }

    // League feed: one matchup_final activity row per decided matchup.
    if (decidedRows.length > 0) {
      const teamIds = [...new Set(decidedRows.flatMap((d) => [d.matchup.home_team_id as string, d.matchup.away_team_id as string]))];
      const { data: teamRows } = await supabase.from('fantasy_teams').select('id, team_name').in('id', teamIds);
      const nameOf = new Map((teamRows ?? []).map((t: Record<string, any>) => [t.id as string, t.team_name as string]));
      const label = (period: string, stage: string) => {
        if (stage === 'semifinal') return 'Semifinal';
        if (stage === 'final') return 'Final';
        if (stage === 'third') return 'Third-place game';
        const wk = period.match(/^week-(\d+)$/);
        return wk ? `Week ${wk[1]}` : period;
      };
      const { error: actErr } = await supabase.from('fantasy_league_activity').insert(
        decidedRows.map((d) => ({
          league_id: d.contest.league_id,
          contest_id: d.contest.id,
          kind: 'matchup_final',
          payload: {
            matchupId: d.matchup.id,
            period: d.period,
            stage: d.matchup.stage,
            label: label(d.period, d.matchup.stage as string),
            homeName: nameOf.get(d.matchup.home_team_id as string) ?? 'Home',
            awayName: nameOf.get(d.matchup.away_team_id as string) ?? 'Away',
            homePoints: Math.round(d.homePts * 100) / 100,
            awayPoints: Math.round(d.awayPts * 100) / 100,
            winnerTeamId: d.winnerTeamId,
            tie: d.winnerTeamId == null,
          },
        })),
      );
      if (actErr) console.error('[score-fantasy] activity insert failed:', actErr.message);
    }

    // 9. Playoff seeding: once every regular-season matchup for a contest is
    // scored and semifinal rows don't exist yet, seed semis from standings
    // (#1 v #4, #2 v #3, home = higher seed). Once both semis are scored and
    // no final exists, seed the final (winners) + third-place (losers).
    for (const contest of h2hContests) {
      const schedule = contest.settings?.schedule;
      if (!schedule?.regular?.length) continue;

      const regularRows = await fetchAll<{ id: string; scored: boolean }>((from, to) =>
        supabase
          .from('fantasy_matchups')
          .select('id, scored')
          .eq('contest_id', contest.id)
          .eq('stage', 'regular')
          .order('id')
          .range(from, to),
      );
      const regularComplete = regularRows.length > 0 && regularRows.every((r) => r.scored);

      const semiRows = await fetchAll<Record<string, any>>((from, to) =>
        supabase.from('fantasy_matchups').select('*').eq('contest_id', contest.id).eq('stage', 'semifinal').order('id').range(from, to),
      );

      if (regularComplete && semiRows.length === 0) {
        const { data: standings, error: standingsErr } = await supabase.rpc('fantasy_h2h_standings', { p_contest: contest.id });
        if (standingsErr) {
          console.error('[score-fantasy] fantasy_h2h_standings failed:', standingsErr.message);
        } else {
          const top4 = ((standings ?? []) as Record<string, any>[]).slice(0, 4);
          if (top4.length === 4) {
            const [s1, s2, s3, s4] = top4;
            const { error } = await supabase.from('fantasy_matchups').insert([
              {
                contest_id: contest.id,
                period: schedule.semifinal,
                stage: 'semifinal',
                home_team_id: s1.team_id,
                away_team_id: s4.team_id,
                home_seed: s1.rank,
                away_seed: s4.rank,
              },
              {
                contest_id: contest.id,
                period: schedule.semifinal,
                stage: 'semifinal',
                home_team_id: s2.team_id,
                away_team_id: s3.team_id,
                home_seed: s2.rank,
                away_seed: s3.rank,
              },
            ]);
            if (error && (error as { code?: string }).code !== '23505') throw error;
          }
        }
      }

      if (semiRows.length === 2 && semiRows.every((r) => r.scored)) {
        const finalRows = await fetchAll<Record<string, any>>((from, to) =>
          supabase.from('fantasy_matchups').select('id').eq('contest_id', contest.id).eq('stage', 'final').order('id').range(from, to),
        );
        if (finalRows.length === 0) {
          const winners: { teamId: string; seed: number | null }[] = [];
          const losers: { teamId: string; seed: number | null }[] = [];
          for (const s of semiRows) {
            const winnerId = s.winner_team_id as string | null;
            if (!winnerId) continue; // unresolved tie with no seed rule available — skip seeding this run
            const loserId = winnerId === s.home_team_id ? s.away_team_id : s.home_team_id;
            const winnerSeed = winnerId === s.home_team_id ? s.home_seed : s.away_seed;
            const loserSeed = winnerId === s.home_team_id ? s.away_seed : s.home_seed;
            winners.push({ teamId: winnerId, seed: winnerSeed });
            losers.push({ teamId: loserId, seed: loserSeed });
          }
          if (winners.length === 2 && losers.length === 2) {
            winners.sort((a, b) => (a.seed ?? 99) - (b.seed ?? 99));
            losers.sort((a, b) => (a.seed ?? 99) - (b.seed ?? 99));
            const { error } = await supabase.from('fantasy_matchups').insert([
              {
                contest_id: contest.id,
                period: schedule.final,
                stage: 'final',
                home_team_id: winners[0].teamId,
                away_team_id: winners[1].teamId,
                home_seed: winners[0].seed,
                away_seed: winners[1].seed,
              },
              {
                contest_id: contest.id,
                period: schedule.final,
                stage: 'third',
                home_team_id: losers[0].teamId,
                away_team_id: losers[1].teamId,
                home_seed: losers[0].seed,
                away_seed: losers[1].seed,
              },
            ]);
            if (error && (error as { code?: string }).code !== '23505') throw error;
          }
        }
      }
    }
  }

  // 10. Weekly-result pushes for the matchups decided this run. Fire-and-
  // forget into notify-fantasy (it dedups per matchup+team) — a push failure
  // must never fail a scoring run.
  if (decidedMatchupIds.length > 0) {
    try {
      const url = Deno.env.get('SUPABASE_URL');
      const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      const res = await fetch(`${url}/functions/v1/notify-fantasy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ event: 'matchups', matchupIds: decidedMatchupIds }),
      });
      if (!res.ok) console.error('[score-fantasy] notify-fantasy HTTP', res.status);
    } catch (err) {
      console.error('[score-fantasy] notify-fantasy failed:', err);
    }
  }

  return { contestsScored, contestsFailed, rowsUpserted: upserts.length, matchupsUpdated, matchupsDecided: decidedMatchupIds.length, tradesExecuted: (tradesRun as number) ?? 0, waiversWon: (waiversRun as number) ?? 0 };
}

// verify_jwt only proves the bearer token was signed by this project — any
// signed-in user's access token passes it. This function runs with the
// service role and calls service-only RPCs, so it must additionally require
// the caller to BE the service role: the raw service key (what pg_cron sends
// from the vault) or a JWT whose role claim is service_role.
function isServiceCaller(req: Request): boolean {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (serviceKey && token === serviceKey) return true;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload?.role === 'service_role';
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (!isServiceCaller(req)) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  let body: { contest?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty ok */
  }

  try {
    const result = await run(body);
    // Other contests were still scored; a 500 keeps the cron health check
    // flagging the ones that weren't.
    const ok = result.contestsFailed.length === 0;
    return new Response(JSON.stringify({ ok, ...result }), {
      status: ok ? 200 : 500,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[score-fantasy] failed:', err);
    return new Response(JSON.stringify({ ok: false, error: 'scoring failed — see function logs' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
