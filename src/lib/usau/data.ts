// USAU data layer (read-only, from Supabase).
//
// The scraper writes via service role; the app reads via anon. RLS on
// every usau_* table is "world-readable" so no auth is required to query.
//
// One client for both runtimes: we use @supabase/supabase-js (not @supabase/ssr)
// because USAU reads don't require auth cookies — the anon key + world-readable
// RLS is sufficient. That lets the same file power both Server Components
// (e.g. /usau/events/[slug]) and Client Components (e.g. the sidebar search)
// without dynamic imports or runtime branching.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database.types';
import { namesMatch, surnameForPrefilter } from '@/lib/name-match';
import { loadNameAliases } from '@/lib/name-aliases';
import { supabaseUrl, supabaseAnonKey } from '@/lib/supabase/env';
import { flightForName, FLIGHT_LABELS, type Flight } from '@/lib/usau/flights';
import { usauTeamLogo } from '@/lib/usau/team-logo';
import { statesForEventName } from '@/lib/usau/regions';
import { isUnhealthyError } from '@/lib/supabase/health';
import { usauToday } from '@/lib/today';
import { gameWinnerId } from '@/lib/usau/game-winner';
import { SEASON_PREVIEW_DAYS } from '@/lib/season-windows';
import { seriesStageHref, seriesUnitLabel, type UsauLevel, type UsauSeriesStage } from '@/lib/league';
import {
  NATIONALS_DIVISIONS,
  buildNationalsField,
  type NationalsDivision,
  type NationalsEntrantRow,
  type NationalsField,
  type NationalsRankingSnapshot,
  type NationalsRegionalEventRow,
} from '@/lib/usau/nationals-field';

type DB = SupabaseClient<Database>;

let _client: DB | null = null;

async function supabase(): Promise<DB> {
  if (_client) return _client;
  _client = createClient<Database>(
    supabaseUrl(),
    supabaseAnonKey(),
    { auth: { persistSession: false } },
  );
  return _client;
}

// ─── Qualifying-event classifier (for player-identity clustering) ────────
//
// A "qualifying" event is one where a team's roster reliably reflects a real
// commitment — the official Series (Sectionals → Regionals → Nationals) plus
// the marquee invite tournaments where no one guests (TCT Pro Championships,
// U.S. Open). These are the events that let us conclude "two different teams,
// same season+track ⇒ two different people." Minor/fun tournaments are excluded
// because players guest on other teams there (not an identity signal).
//
// USAU exposes no structured event-type (event_type is uniformly 'other'), so
// we classify by name. Order/guards matter: "Championship"/"Nationals" appear
// in BOTH true Nationals ("USA Ultimate Club/College Championships") and invite
// events ("TCT Pro Championships", "U.S. Open Club Championships"), and warmups
// ("...at Nationals", "Nationals Tune Up") must not match.
export function isQualifyingSeriesEvent(rawName: string | null | undefined): boolean {
  if (!rawName) return false;
  const n = rawName.toLowerCase();

  // Warmups / non-competitive that happen to contain series words.
  if (/(tune up|tune-up|at nationals|warm ?up)/.test(n)) return false;

  // Official series stages by name.
  if (/sectional/.test(n)) return true;
  if (/regional/.test(n)) return true;
  if (/super qualifier/.test(n)) return true; // Masters/Grand-Masters series

  // Marquee invite tournaments where rosters are trustworthy (no guesting).
  if (/u\.?s\.? open/.test(n)) return true;
  if (/tct pro champ|pro championship|usau pro champ/.test(n)) return true;

  // True Nationals — anchored by "USA Ultimate", the College Championships
  // forms, or "Club Nationals". Guard against invite/HS/worlds/beach that also
  // carry "championship"/"nationals".
  const isNationalsName =
    /club nationals/.test(n) ||
    /club championship/.test(n) ||
    /college championship/.test(n) ||
    /usa ultimate national championship/.test(n) ||
    (/usa ultimate/.test(n) && /nationals/.test(n));
  const disqualified =
    /state championship/.test(n) ||
    /high school|\bhs\b/.test(n) ||
    /world|\(icc\)|- icc|\(ycc\)|wucc|wmucc|wjuc/.test(n) ||
    /beach/.test(n);
  if (isNationalsName && !disqualified) return true;

  return false;
}

// ─── Events ────────────────────────────────────────────────────────────

export interface UsauEventCard {
  id: string;
  slug: string;
  name: string;
  season: number;
  startDate: string | null; // ISO yyyy-mm-dd
  endDate: string | null;
  city: string | null;
  state: string | null;
  competitionLevel: string;
  /** Number of teams that participated, used as a "size" hint. */
  teamCount: number;
  /** Canonical USAU event page URL (e.g. play.usaultimate.org/events/{slug}). */
  url: string | null;
  /** Curated Triple Crown Tour flight, or null if unclassified. See flights.ts. */
  flight: Flight | null;
  /**
   * The event's decided winner for the card, or null if undecided/in-progress.
   * `champion` = won the championship-bracket final; `pool-leader` = the unique
   * best pool record when the event is pool-play-only (no bracket final). A
   * combined masters event can crown several divisions — we surface the single
   * most-recent championship final so the card stays one line; the detail page
   * shows every division's banner.
   */
  winner: { name: string; kind: 'champion' | 'pool-leader' } | null;
}

export type CompetitionLevel =
  | 'CLUB'
  | 'COLLEGE_D1'
  | 'COLLEGE_D3'
  | 'HS'
  | 'MS'
  | 'YC'
  | 'MASTERS'
  | 'GRAND_MASTERS'
  | 'GREAT_GRAND_MASTERS'
  | 'BEACH'
  | 'OTHER';

/** All scraped USAU events, newest first. */
/** Bracket-name tail after the group prefix ("Masters Mixed · 1st Place" →
 *  "1st place"), lowercased. Combined masters events prefix every bracket. */
function bracketTailLower(name: string | null | undefined): string {
  if (!name) return '';
  const i = name.lastIndexOf('·');
  return (i >= 0 ? name.slice(i + 1) : name).trim().toLowerCase();
}

/** Is this the CHAMPIONSHIP (gold-medal) bracket — not a placement side bracket?
 *  Server-side twin of usau-bracket-tree's isChampionshipBracket, kept in sync:
 *  accepts 1st/first-place/championship/finals/bracket-play, rejects anything
 *  carrying an ordinal ≥ the bare number (so "3rd Place" / "5th Place Bracket"
 *  never crown a champion) plus consolation/placement. */
export function isChampionshipBracketName(name: string | null | undefined): boolean {
  const b = bracketTailLower(name);
  if (!b) return false;
  if (/\b1st place\b/.test(b) || /\bfirst place\b/.test(b)) return true;
  // A bare "1st" section IS the championship bracket (Cooler Classic 37 names
  // its winner's bracket just "1st") — exact-match it before the ordinal
  // reject, which exists for SIDE brackets ("3rd Place", "21st").
  if (b === '1st') return true;
  // Reject placement side brackets (any ordinal) + consolation.
  if (/\b\d+(st|nd|rd|th)\b/.test(b)) return false;
  // Same rule the champion readers use: second place, game-to-go, etc.
  if (isPlacementBracketName(b)) return false;
  if (b === 'finals') return true;
  if (/(^|\s)championship(\s+(bracket|final|game))?$/.test(b)) return true;
  if (b === 'bracket' || b === 'bracket play' || b === 'sunday bracket') return true;
  // Novelty-named championship section (Portland Kleinman's "Champs", beside
  // its "Fiv-als"/"Ninals" placement siblings).
  if (b === 'champs') return true;
  return false;
}

/** A championship bracket's deciding game the scraper filed under another
 *  round: USAU structure column 0 ("the decider") labeled "Finals" / "The
 *  Championship" — 2026 NW Men "Finals" and SC Mixed (a lone-game section,
 *  no semis) came in as 'placement', NE Mixed "The Championship" as 'other'.
 *  The guards matter: older rows carry index-0 "Quarterfinals"/"Crossovers"
 *  columns inside championship-named sections. Mirrors mobile's
 *  isStructuredTitleDecider and usau-event-detail's client twin. */
export function isStructuredTitleDecider(g: {
  round: string;
  bracketName: string | null;
  bracketStage: string | null;
  bracketStageIndex: number | null;
}): boolean {
  if (g.bracketStageIndex !== 0) return false;
  if (g.round === 'prequarter' || g.round === 'quarter' || g.round === 'semi') return false;
  if (!isChampionshipBracketName(g.bracketName)) return false;
  const stage = (g.bracketStage ?? '').trim().toLowerCase();
  if (!stage || isPlacementBracketName(stage) || /quarter|semi|cross/.test(stage)) return false;
  return /\bfinals?\b|\bchampionship\b|\bchamps?\b|\b1st\b|\bfirst\b/.test(stage);
}

const WRITTEN_ORDINALS =
  'second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth';

/** Placement side brackets ("13th Place (tie)", "Fifth Place Bracket",
 *  "Second Place (Game to Go)", consolation) also carry round='final'/'semi'.
 *  One rule for the home and /scores champion readers so both crown the same
 *  team. A blacklist, unlike isChampionshipBracketName: unlabeled finals count. */
function isPlacementBracketName(name: string | null): boolean {
  const b = (name ?? '').toLowerCase();
  // First-place names are the title game, even when they double as the bid
  // game ("1st Place (Game to Go)") or pair two seeds ("First/Second Place").
  // \b keeps "21st"/"31st" side brackets out of this carve-out.
  if (/\b1st\b/.test(b) || /\bfirst\b/.test(b)) return false;
  if (/\b\d+(st|nd|rd|th)\b/.test(b)) return true;
  // Written-out places ("Second Place", "Championship Bracket: Third Place")
  // and a bare ordinal label ("Third"). "Second Place" is the next-bid
  // game-to-go, usually played AFTER the title game.
  if (new RegExp(`\\b(${WRITTEN_ORDINALS})\\s+place\\b`).test(b)) return true;
  if (new RegExp(`^(${WRITTEN_ORDINALS})$`).test(b.replace(/^.*[·:]\s*/, '').trim())) return true;
  // Next-bid games by another name.
  if (/backdoor|game[- ]to[- ]go|\bg2g\b/.test(b)) return true;
  return b.includes('consolation') || b.includes('placement');
}

/**
 * Resolve each event's card "winner": the championship-final winner, or (for a
 * pool-play-only event) the unique best pool record. Batched across all listed
 * events in two queries — one for `round='final'` games (bracket champions),
 * then a pool tally ONLY for events left without a champion (bounds the cost).
 * Returns Map<eventId, { name, kind }>; events with no decided winner are absent.
 */
async function resolveEventWinners(
  db: Awaited<ReturnType<typeof supabase>>,
  eventIds: string[],
): Promise<Map<string, { name: string; kind: 'champion' | 'pool-leader' }>> {
  const out = new Map<string, { name: string; kind: 'champion' | 'pool-leader' }>();
  if (eventIds.length === 0) return out;

  // ── Bracket champions: latest decided championship final per event ──────
  // Rounds beyond 'final' are fetched because scrapes historically misfiled
  // some championship finals as 'other'/'placement' (HoDown Showdown 2026's
  // final was h3="Championship" h4="Championship" → 'other'; Cooler Classic's
  // bare-ordinal "1st" section → 'placement'). For those groups the final is
  // RECOVERED the same way UsauBracketTree does: the decided non-semi game
  // whose two teams are both semi winners. A plain "latest decided game" pick
  // would be wrong — when a final is cancelled (HoDown Men) it would crown a
  // semi winner.
  // Two PostgREST limits apply here: a season-wide id list overflows the GET
  // URL (~500 uuids kills the fetch outright, error swallowed), and a single
  // response caps at 1000 rows — especially now that the 'other' round drags
  // in mislabeled pool games. Chunk the ids and page each chunk.
  const fetchGamesByEvent = async (
    ids: string[],
    select: string,
    rounds?: ('final' | 'semi' | 'placement' | 'other')[],
  ): Promise<Record<string, unknown>[]> => {
    const CHUNK = 100;
    const PAGE = 1000;
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      for (let from = 0; ; from += PAGE) {
        let q = db
          .from('usau_games')
          .select(select)
          .in('event_id', chunk)
          .eq('status', 'final')
          .order('id', { ascending: true }) // stable order so paged ranges don't skip/overlap
          .range(from, from + PAGE - 1);
        if (rounds) q = q.in('round', rounds);
        const { data: page } = await q;
        const got = (page ?? []) as unknown as Record<string, unknown>[];
        rows.push(...got);
        if (got.length < PAGE) break;
      }
    }
    return rows;
  };

  const finals = await fetchGamesByEvent(
    eventIds,
    'event_id, bracket_name, round, bracket_stage, bracket_stage_index, scheduled_at, score_a, score_b, ' +
      'winner_team_id, team_a_id, team_b_id, ' +
      'team_a:usau_teams!usau_games_team_a_id_fkey(name), ' +
      'team_b:usau_teams!usau_games_team_b_id_fkey(name)',
    ['final', 'semi', 'placement', 'other'],
  );

  type FinalRow = {
    event_id: string;
    bracket_name: string | null;
    round: string;
    bracket_stage: string | null;
    bracket_stage_index: number | null;
    scheduled_at: string | null;
    score_a: number | null;
    score_b: number | null;
    winner_team_id: string | null;
    team_a_id: string | null;
    team_b_id: string | null;
    team_a: { name: string } | null;
    team_b: { name: string } | null;
  };
  const winnerIdOf = (r: FinalRow) =>
    gameWinnerId({
      teamAId: r.team_a_id,
      teamBId: r.team_b_id,
      scoreA: r.score_a,
      scoreB: r.score_b,
      winnerTeamId: r.winner_team_id,
    });
  const decided = (r: FinalRow) => winnerIdOf(r) != null;

  // Group championship-bracket games per (event, bracket) — a combined masters
  // event has one championship bracket per division ("GM Women · Championship").
  const champGroups = new Map<string, FinalRow[]>();
  for (const r of finals as unknown as FinalRow[]) {
    if (!isChampionshipBracketName(r.bracket_name)) continue;
    const key = `${r.event_id}|${r.bracket_name ?? ''}`;
    const list = champGroups.get(key);
    if (list) list.push(r);
    else champGroups.set(key, [r]);
  }

  const bestFinalAt = new Map<string, string>();
  const consider = (r: FinalRow): void => {
    const winnerName = (winnerIdOf(r) === r.team_a_id ? r.team_a?.name : r.team_b?.name) ?? null;
    if (!winnerName) return;
    // Keep the LATEST final per event (a combined event has one per division;
    // one line on the card — detail page shows all).
    const at = r.scheduled_at ?? '';
    const prev = bestFinalAt.get(r.event_id);
    if (prev == null || at > prev) {
      bestFinalAt.set(r.event_id, at);
      out.set(r.event_id, { name: winnerName, kind: 'champion' });
    }
  };
  for (const games of champGroups.values()) {
    const tagged = games.filter((g) => g.round === 'final' && decided(g));
    if (tagged.length > 0) {
      for (const g of tagged) consider(g);
      continue;
    }
    // A structural decider next — it needs no semis, so it also covers a
    // lone-game "Finals" section (2026 SC Mixed) the recovery below can't.
    const structural = games.filter(
      (g) =>
        decided(g) &&
        isStructuredTitleDecider({
          round: g.round,
          bracketName: g.bracket_name,
          bracketStage: g.bracket_stage,
          bracketStageIndex: g.bracket_stage_index,
        }),
    );
    if (structural.length > 0) {
      for (const g of structural) consider(g);
      continue;
    }
    // Recovery: both teams of the candidate must have WON a semi in this group.
    const semiWinners = new Set(
      games
        .filter((g) => g.round === 'semi' && decided(g))
        .map((g) => winnerIdOf(g))
        .filter(Boolean),
    );
    if (semiWinners.size < 2) continue;
    const recovered = games.find(
      (g) =>
        g.round !== 'semi' &&
        decided(g) &&
        !!g.team_a_id &&
        !!g.team_b_id &&
        semiWinners.has(g.team_a_id) &&
        semiWinners.has(g.team_b_id),
    );
    if (recovered) consider(recovered);
  }

  // ── Pool leaders: only for events with NO bracket champion ──────────────
  const poolOnly = eventIds.filter((id) => !out.has(id));
  if (poolOnly.length > 0) {
    const poolRows = await fetchGamesByEvent(
      poolOnly,
      'event_id, bracket_name, round, score_a, score_b, winner_team_id, team_a_id, team_b_id, status, ' +
        'team_a:usau_teams!usau_games_team_a_id_fkey(name), ' +
        'team_b:usau_teams!usau_games_team_b_id_fkey(name)',
    );

    type PoolRow = {
      event_id: string;
      bracket_name: string | null;
      round: string;
      score_a: number | null;
      score_b: number | null;
      winner_team_id: string | null;
      team_a_id: string | null;
      team_b_id: string | null;
      team_a: { name: string } | null;
      team_b: { name: string } | null;
    };
    type Tally = { rec: Map<string, { name: string; w: number; l: number }>; seen: Set<string> };
    // `result` is the dedupe key's result part: the sorted scores, or the
    // forfeit winner (a forfeit counts as a W/L).
    const tallyGame = (
      t: Tally,
      an: string,
      bn: string,
      aWon: boolean,
      result: string,
    ): void => {
      const ka = an.toLowerCase();
      const kb = bn.toLowerCase();
      const pair = [ka, kb].sort();
      const gkey = `${pair[0]}|${pair[1]}|${result}`;
      if (t.seen.has(gkey)) return;
      t.seen.add(gkey);
      const wk = aWon ? ka : kb;
      const lk = aWon ? kb : ka;
      const wn = aWon ? an : bn;
      const ln = aWon ? bn : an;
      const rw = t.rec.get(wk) ?? { name: wn, w: 0, l: 0 };
      rw.w += 1;
      t.rec.set(wk, rw);
      const rl = t.rec.get(lk) ?? { name: ln, w: 0, l: 0 };
      rl.l += 1;
      t.rec.set(lk, rl);
    };
    // Per event: normalized-name W/L, deduped by matchup+score (dual-pipeline).
    // `all` tallies EVERY decided game and `structured` flags pool/tree
    // structure — together they back the unstructured-event fallback below.
    const perEvent = new Map<string, { pool: Tally; all: Tally; structured: boolean }>();
    const TREE_STRUCTURE_ROUNDS = ['prequarter', 'quarter', 'semi', 'final'];
    for (const r of poolRows as unknown as PoolRow[]) {
      let e = perEvent.get(r.event_id);
      if (!e) {
        e = {
          pool: { rec: new Map(), seen: new Set() },
          all: { rec: new Map(), seen: new Set() },
          structured: false,
        };
        perEvent.set(r.event_id, e);
      }
      const tail = bracketTailLower(r.bracket_name);
      const isPool = tail.startsWith('pool') && !tail.includes('crossover');
      if (isPool || TREE_STRUCTURE_ROUNDS.includes(r.round)) e.structured = true;
      const winnerId = gameWinnerId({
        teamAId: r.team_a_id,
        teamBId: r.team_b_id,
        scoreA: r.score_a,
        scoreB: r.score_b,
        winnerTeamId: r.winner_team_id,
      });
      if (!winnerId) continue;
      const an = r.team_a?.name?.trim();
      const bn = r.team_b?.name?.trim();
      if (!an || !bn) continue;
      const aWon = winnerId === r.team_a_id;
      const result =
        r.score_a != null && r.score_b != null
          ? [r.score_a, r.score_b].sort((x, y) => x - y).join('|')
          : `F|${(aWon ? an : bn).toLowerCase()}`;
      tallyGame(e.all, an, bn, aWon, result);
      if (isPool) tallyGame(e.pool, an, bn, aWon, result);
    }
    for (const [eventId, { pool, all, structured }] of perEvent) {
      const standings = Array.from(pool.rec.values()).sort((a, b) => b.w - a.w || a.l - b.l);
      const top = standings[0];
      if (top && !(top.w === 0 && top.l === 0)) {
        const tied = standings.filter((s) => s.w === top.w && s.l === top.l).length;
        if (tied === 1) out.set(eventId, { name: top.name, kind: 'pool-leader' });
        continue; // pools exist — ambiguous pools stay winner-less
      }
      // Unstructured-event fallback (Garbage Pla(c)e's Extra Fancy Tournament:
      // two novelty-named single-game "brackets", no pools, no tree rounds): a
      // team that won EVERY decided game, uniquely, is the winner. Gated to
      // events with no pool/bracket structure so a cancelled real final can
      // never be papered over by an undefeated run.
      if (structured) continue;
      const allStandings = Array.from(all.rec.values()).sort((a, b) => b.w - a.w || a.l - b.l);
      const best = allStandings[0];
      if (!best || best.w === 0 || best.l > 0) continue;
      const undefeated = allStandings.filter((s) => s.w > 0 && s.l === 0).length;
      if (undefeated > 1) continue; // two unbeaten teams — ambiguous
      out.set(eventId, { name: best.name, kind: 'champion' });
    }
  }

  return out;
}

export async function listEvents(opts?: {
  season?: number;
  competitionLevel?: CompetitionLevel;
  /** Filter to events that have at least one participating team in this
   *  gender division. USAU events themselves aren't tagged by gender —
   *  the division lives on the participating teams. We treat an event
   *  as "in the X division" if any of its teams.gender_division = X. */
  genderDivision?: 'Men' | 'Women' | 'Mixed';
  /** Filter to events curated into these Triple Crown Tour flights (see
   *  flights.ts). Flight is a hand-maintained code map, not a USAU-published
   *  tournament field. Empty/undefined ⇒ all flights (no filter). Multiple ⇒
   *  events matching ANY of them. */
  flights?: Flight[];
  limit?: number;
}): Promise<UsauEventCard[]> {
  const db = await supabase();

  // For a masters-family level, also surface combined-championship events tagged
  // with a sibling level that field this division (see MASTERS_FAMILY note). We
  // resolve those event IDs first, then broaden the filter to "own level OR one
  // of these IDs" instead of a strict server-side eq().
  const mastersInclusionIds =
    opts?.competitionLevel && isMastersFamily(opts.competitionLevel)
      ? await eventIdsWithTeamLevel(db, opts.competitionLevel)
      : null;

  let q = db
    .from('usau_events')
    .select('id, usau_slug, name, season, start_date, end_date, city, state, competition_level, url')
    .order('start_date', { ascending: false, nullsFirst: false })
    .order('name', { ascending: true });
  if (opts?.season != null) q = q.eq('season', opts.season);
  if (opts?.competitionLevel) {
    if (mastersInclusionIds && mastersInclusionIds.size > 0) {
      // own level OR any event that fields this division
      const idList = Array.from(mastersInclusionIds).join(',');
      q = q.or(`competition_level.eq.${opts.competitionLevel},id.in.(${idList})`);
    } else {
      q = q.eq('competition_level', opts.competitionLevel);
    }
  }
  if (opts?.limit) q = q.limit(opts.limit);
  const { data: events, error } = await q;
  if (error) throw error;

  // Pull team counts per event AND collect each event's gender divisions
  // (from the participating teams) so we can both report a count and
  // filter to the requested division. One query covers both.
  const ids = (events ?? []).map((e) => e.id);
  const countByEvent = new Map<string, number>();
  const divisionsByEvent = new Map<string, Set<string>>();
  if (ids.length > 0) {
    const { data: parts } = await db
      .from('usau_event_teams')
      .select('event_id, usau_teams(gender_division)')
      .in('event_id', ids);
    for (const r of (parts ?? []) as Array<{
      event_id: string;
      usau_teams: { gender_division: string | null } | null;
    }>) {
      countByEvent.set(r.event_id, (countByEvent.get(r.event_id) ?? 0) + 1);
      const div = r.usau_teams?.gender_division;
      if (div) {
        if (!divisionsByEvent.has(r.event_id)) divisionsByEvent.set(r.event_id, new Set());
        divisionsByEvent.get(r.event_id)!.add(div);
      }
    }
  }

  const flightSet = opts?.flights && opts.flights.length > 0 ? new Set(opts.flights) : null;
  const filtered = (events ?? []).filter((e) => {
    if (opts?.genderDivision) {
      const set = divisionsByEvent.get(e.id);
      if (!(set && set.has(opts.genderDivision))) return false;
    }
    if (flightSet) {
      const f = flightForName(e.name);
      if (!f || !flightSet.has(f)) return false;
    }
    return true;
  });

  // Card winner (championship-final winner, or unique pool leader for pool-only
  // events). Resolved over the FILTERED set so we don't fetch games for events
  // that won't render.
  const winners = await resolveEventWinners(db, filtered.map((e) => e.id));

  return filtered.map((e) => ({
    id: e.id,
    slug: e.usau_slug,
    name: e.name,
    season: e.season,
    startDate: e.start_date,
    endDate: e.end_date,
    city: e.city,
    state: e.state,
    competitionLevel: e.competition_level,
    teamCount: countByEvent.get(e.id) ?? 0,
    url: e.url ?? null,
    flight: flightForName(e.name),
    winner: winners.get(e.id) ?? null,
  }));
}

/**
 * Returns the most relevant tournament for "The Games" view.
 *
 * Ultimate runs on a weekly tournament cadence — events play Fri–Sun, then the
 * week is dead until the next weekend. So the headline follows the weekend, not
 * the literal "is anything live this second" question:
 *
 *   • Sun / Mon / Tue  → show LAST weekend's tournament (the just-finished one).
 *     Fans are still digesting results; the next event hasn't earned the spot.
 *   • Wed / Thu / Fri / Sat → show the UPCOMING weekend's tournament (preview).
 *     By Wednesday attention has shifted to who's playing this weekend.
 *
 * The cutover is Wednesday 00:00 Eastern (usauToday).
 *
 * Within whichever side we pick, ties (multiple events the same weekend) break
 * by FLIGHT_RANK — the marquee flight (Pro Elite Challenge) headlines over a
 * co-scheduled local tournament. If the preferred side has no event, we fall
 * back to the other side, then to older in-window events that have games; an
 * empty window returns null.
 *
 * We consider any tournament-grade level (Club, College D-I/D-III,
 * Masters, Grand Masters) — these are the ones with real bracket data.
 * HS/MS/Beach are excluded so we don't surface a state HS tournament
 * over a major club event.
 *
 * Returns the slug only; callers fetch the full event via getEvent().
 * `hasGames` is false when the chosen event has NO games ingested yet — UI
 * can render a "happening soon, brackets pending" fallback.
 */
const FLAGSHIP_LEVELS: CompetitionLevel[] = [
  'CLUB',
  'COLLEGE_D1',
  'COLLEGE_D3',
  'MASTERS',
  'GRAND_MASTERS',
  'GREAT_GRAND_MASTERS',
];

// The masters family shares combined-championship events: the USA Ultimate
// Masters Championships is ONE usau_events row (tagged with a single level,
// e.g. GRAND_MASTERS) but hosts Masters, Grand Masters, AND Great Grand
// Masters divisions — each team carries its own competition_level. So an event
// list filtered by the event's own level would hide the combined championships
// from the other two tabs even though those teams are present. For a
// masters-family request we therefore include an event if EITHER its own level
// matches OR it has a participating team at the requested level.
const MASTERS_FAMILY: CompetitionLevel[] = [
  'MASTERS',
  'GRAND_MASTERS',
  'GREAT_GRAND_MASTERS',
];

function isMastersFamily(level: CompetitionLevel): boolean {
  return (MASTERS_FAMILY as string[]).includes(level);
}

/**
 * Event IDs (from the given candidate set, or DB-wide when omitted) that have a
 * participating team tagged with `level`. Used to surface combined-championship
 * events under every masters-family tab whose division is actually present.
 * Pages defensively past the PostgREST 1000-row cap.
 */
async function eventIdsWithTeamLevel(
  db: Awaited<ReturnType<typeof supabase>>,
  level: CompetitionLevel,
  candidateIds?: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (candidateIds && candidateIds.length === 0) return out;
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = db
      .from('usau_event_teams')
      .select('event_id, usau_teams!inner(competition_level)')
      .eq('usau_teams.competition_level', level)
      // PK (event_id, team_id) → total order so paged ranges don't skip/overlap.
      .order('event_id', { ascending: true })
      .order('team_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (candidateIds) q = q.in('event_id', candidateIds);
    const { data: page } = await q;
    const rows = page ?? [];
    for (const r of rows) out.add((r as { event_id: string }).event_id);
    if (rows.length < PAGE) break;
  }
  return out;
}

// Headline importance — higher wins when several events share a weekend. This
// is a SUPERSET of the TCT flight tiers, because the true pinnacle events
// (Nationals, World Championships) sit ABOVE the regular-season flights but
// aren't "flights" in USAU's TCT taxonomy at all. Ordering (high → low):
//
//   PINNACLE (rank 10) — season/world championships, the top of the sport:
//     • Club Nationals / Club Championships
//     • World Club Championships (WUCC) and World Masters Club Champs (WMUCC)
//     • College Nationals (D-I/D-III Championships)
//   These outrank a same-weekend Pro Elite Challenge (Hunter: WMUCC is above
//   everything but Club Nationals / Club Worlds).
//
//   Then the TCT flights: triple-crown 5 > pro 4 > elite 3 > select 2 > classic 1.
//   Unclassified local tournaments → 0 (lose every tie).
const FLIGHT_RANK: Record<Flight, number> = {
  'triple-crown': 5,
  pro: 4,
  elite: 3,
  select: 2,
  classic: 1,
};

const PINNACLE_RANK = 10;

/** True for the sport's pinnacle championships — season Nationals + Worlds.
 *  Name-based (like flightForName) so it survives year-to-year slug drift.
 *  WMUCC/WUCC are World events USAU lists but does not classify as a flight. */
function isPinnacleEventName(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name
    .toLowerCase()
    .replace(/[.,()\-/&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // World championships (club, masters, junior) — WUCC / WMUCC / WJUC and the
  // spelled-out "world ... club championship" forms.
  if (/\bw[mj]?ucc\b/.test(n)) return true;
  if (n.includes('world') && n.includes('club') && n.includes('championship')) return true;
  if (n.includes('world masters') || n.includes('world ultimate club')) return true;
  // USA Ultimate season Nationals — Club + College. Guard out warmups/HS/state.
  const isNationals =
    n.includes('club nationals') ||
    n.includes('college championship') ||
    (n.includes('club championship') && !n.includes('open')) ||
    (n.includes('usa ultimate') && n.includes('nationals'));
  const disqualified =
    n.includes('at nationals') || n.includes('tune up') ||
    n.includes('high school') || n.includes('state championship');
  return isNationals && !disqualified;
}

/** Headline priority — higher = more prominent. Pinnacle events top the scale,
 *  then TCT flights, then unclassified (0). */
function flightRankForName(name: string | null | undefined): number {
  if (isPinnacleEventName(name)) return PINNACLE_RANK;
  const f = flightForName(name);
  return f ? FLIGHT_RANK[f] : 0;
}

/**
 * Best (lowest) official USAU rank among each event's entrants, keyed by event
 * id, plus EVERY ranked entrant's rank per event (feeds the average-rank depth
 * measure in getCurrentEvent's small-but-strong exception). Events with no
 * ranked entrant are simply absent from both maps.
 *
 * Matched by NAME + division, not by usau_rankings.team_id: the ranking rows
 * and usau_event_teams frequently point at different usau_teams rows for the
 * same real team (the known duplicate-team churn, where USAU issues a new
 * EventTeamId per scrape), so an id join silently drops real entrants — it lost
 * Vacationland's #14 Red Tide entirely. Division is part of the key because a
 * name-only match crosses RankSets (a Men's team matching a Club-Women ranking)
 * and would decide headlines off a false positive.
 */
async function bestOfficialRankByEvent(
  db: Awaited<ReturnType<typeof supabase>>,
  eventIds: string[],
): Promise<{ best: Map<string, number>; ranks: Map<string, number[]> }> {
  const out = new Map<string, number>();
  const ranksOut = new Map<string, number[]>();
  if (eventIds.length === 0) return { best: out, ranks: ranksOut };

  // Latest (season, week) per RankSet — rankings are scraped weekly, and the
  // divisions don't always land on the same week.
  const heads = new Map<string, { season: number; week: number }>();
  await Promise.all(
    OFFICIAL_RANK_DIVISIONS.map(async (division) => {
      const { data } = await db
        .from('usau_rankings')
        .select('season, week')
        .eq('division', division)
        .order('season', { ascending: false })
        .order('week', { ascending: false })
        .limit(1);
      const head = (data ?? [])[0] as { season: number; week: number } | undefined;
      if (head) heads.set(division, head);
    }),
  );
  if (heads.size === 0) return { best: out, ranks: ranksOut };

  // rankByKey: "division|lowercased team name" → rank.
  const rankByKey = new Map<string, number>();
  await Promise.all(
    Array.from(heads.entries()).map(async ([division, head]) => {
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data: page } = await db
          .from('usau_rankings')
          .select('rank, team_name')
          .eq('division', division)
          .eq('season', head.season)
          .eq('week', head.week)
          .order('rank', { ascending: true })
          .range(from, from + PAGE - 1);
        const rows = (page ?? []) as Array<{ rank: number; team_name: string | null }>;
        for (const r of rows) {
          if (!r.team_name) continue;
          const key = `${division}|${r.team_name.toLowerCase()}`;
          // Rows arrive rank-ascending, so the first write is the best rank.
          if (!rankByKey.has(key)) rankByKey.set(key, r.rank);
        }
        if (rows.length < PAGE) break;
      }
    }),
  );
  if (rankByKey.size === 0) return { best: out, ranks: ranksOut };

  // Entrants for the candidate events, paged past the 1000-row response cap.
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: page } = await db
      .from('usau_event_teams')
      .select('event_id, team_id, usau_teams(name, gender_division, competition_level)')
      .in('event_id', eventIds)
      .order('event_id', { ascending: true })
      .order('team_id', { ascending: true })
      .range(from, from + PAGE - 1);
    const rows = (page ?? []) as Array<{
      event_id: string;
      team_id: string;
      usau_teams: {
        name: string | null;
        gender_division: string | null;
        competition_level: string | null;
      } | null;
    }>;
    for (const r of rows) {
      const t = r.usau_teams;
      if (!t?.name) continue;
      const division = officialRankSetFor(t.competition_level, t.gender_division);
      if (!division) continue; // D-III / Masters — USAU publishes no rankings.
      const rank = rankByKey.get(`${division}|${t.name.toLowerCase()}`);
      if (rank === undefined) continue;
      const prev = out.get(r.event_id);
      if (prev === undefined || rank < prev) out.set(r.event_id, rank);
      const acc = ranksOut.get(r.event_id) ?? [];
      acc.push(rank);
      ranksOut.set(r.event_id, acc);
    }
    if (rows.length < PAGE) break;
  }
  return { best: out, ranks: ranksOut };
}

export async function getCurrentEvent(opts?: {
  /** Filter to events whose participating teams include this division. */
  genderDivision?: 'Men' | 'Women' | 'Mixed';
  /** Restrict to ONE competition level (e.g. 'MASTERS'). Default: all flagship levels. */
  competitionLevel?: CompetitionLevel;
  /** Restrict to a SET of levels (e.g. both College divisions). Ignored when
   *  competitionLevel is set. Default: all flagship levels. */
  competitionLevels?: CompetitionLevel[];
}): Promise<UsauCurrentPick | null> {
  const db = await supabase();
  const now = new Date();
  const today = usauToday(now);
  // The weekend rule only looks one weekend back or forward, so a tight window
  // is all we need — and it keeps the per-event count + division queries below
  // well clear of PostgREST's 1000-row response cap (a ±180d window spans 450+
  // events / 1300+ games, which silently truncates and drops events to "0
  // games"). Nothing inside the window → null.
  const windowBack = usauToday(new Date(now.getTime() - 45 * 86400_000));
  const windowForward = usauToday(new Date(now.getTime() + 45 * 86400_000));

  // One explicit level (or level set) filters exactly; otherwise any flagship
  // level headlines.
  const levelFilter = opts?.competitionLevel
    ? [opts.competitionLevel]
    : (opts?.competitionLevels ?? FLAGSHIP_LEVELS);

  // Masters-family: also headline combined-championship events that field this
  // division under a sibling tag (see MASTERS_FAMILY note).
  const mastersInclusionIds =
    opts?.competitionLevel && isMastersFamily(opts.competitionLevel)
      ? await eventIdsWithTeamLevel(db, opts.competitionLevel)
      : null;

  let windowQ = db
    .from('usau_events')
    .select('id, usau_slug, name, start_date, end_date, competition_level')
    // Series members compete as ONE stage candidate each (added below).
    .is('series_stage', null)
    .gte('start_date', windowBack)
    .lte('start_date', windowForward)
    .order('start_date', { ascending: true });
  windowQ =
    mastersInclusionIds && mastersInclusionIds.size > 0
      ? windowQ.or(
          `competition_level.eq.${opts!.competitionLevel},id.in.(${Array.from(mastersInclusionIds).join(',')})`,
        )
      : windowQ.in('competition_level', levelFilter);
  const { data: windowEvents } = await windowQ;

  type EventRow = {
    id: string;
    usau_slug: string;
    name: string | null;
    start_date: string | null;
    end_date: string | null;
    competition_level: string | null;
  };
  let events: EventRow[] = (windowEvents ?? []) as EventRow[];

  // Per-event game counts + gender divisions + team counts of participants.
  const counts = new Map<string, number>();
  const divisionsByEvent = new Map<string, Set<string>>();
  const teamCounts = new Map<string, number>();
  if (events.length > 0) {
    const eventIds = events.map((e) => e.id);

    // Games count (for "has games" + ranking). PostgREST caps a single response
    // at 1000 rows, so we page through with .range() until a short page tells us
    // we're done — otherwise a busy window silently undercounts and events get
    // mis-flagged as having no games.
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: page } = await db
        .from('usau_games')
        .select('event_id, id')
        .in('event_id', eventIds)
        .order('id', { ascending: true }) // stable order so paged ranges don't skip/overlap
        .range(from, from + PAGE - 1);
      const rows = page ?? [];
      for (const g of rows) {
        counts.set(g.event_id, (counts.get(g.event_id) ?? 0) + 1);
      }
      if (rows.length < PAGE) break;
    }

    // Participating teams: their divisions feed the optional gender filter, and
    // the per-event COUNT feeds the field-size term in the ranking below. The
    // count is always needed, so this no longer runs only when a division
    // filter is set. Team rows are far fewer than games, but page defensively
    // for the same cap reason.
    for (let from = 0; ; from += PAGE) {
      const { data: page } = await db
        .from('usau_event_teams')
        .select('event_id, team_id, usau_teams(gender_division)')
        .in('event_id', eventIds)
        // Composite key (event_id, team_id) → order by both for a total order
        // so paged ranges don't skip/overlap.
        .order('event_id', { ascending: true })
        .order('team_id', { ascending: true })
        .range(from, from + PAGE - 1);
      const rows = (page ?? []) as Array<{
        event_id: string;
        team_id: string;
        usau_teams: { gender_division: string | null } | null;
      }>;
      for (const r of rows) {
        teamCounts.set(r.event_id, (teamCounts.get(r.event_id) ?? 0) + 1);
        const div = r.usau_teams?.gender_division;
        if (div) {
          if (!divisionsByEvent.has(r.event_id)) divisionsByEvent.set(r.event_id, new Set());
          divisionsByEvent.get(r.event_id)!.add(div);
        }
      }
      if (rows.length < PAGE) break;
    }
    if (opts?.genderDivision) {
      events = events.filter((e) => divisionsByEvent.get(e.id)?.has(opts.genderDivision!) ?? false);
    }
  }

  // Best official USAU rank among each event's entrants — the tie-break below
  // flight. Most summer club tournaments carry no TCT flight, so flight rank is
  // 0 for every event sharing a weekend; without this the comparator returned 0
  // and the "winner" was whatever order PostgREST happened to return (web and
  // mobile picked different events from identical code).
  const { best: bestRankByEvent, ranks: ranksByEvent } = await bestOfficialRankByEvent(
    db,
    events.map((e) => e.id),
  );

  // Mean rank across an event's ranked entrants (see avgRank below).
  const avgRankByEvent = new Map<string, number>();
  for (const [eventId, ranks] of ranksByEvent) {
    if (ranks.length === 0) continue;
    avgRankByEvent.set(eventId, ranks.reduce((a, b) => a + b, 0) / ranks.length);
  }

  // Series stages ("2026 USAU Sectionals") compete as ONE candidate each,
  // ranked above every TCT flight and below Nationals/Worlds. Added after the
  // per-event DB enrichment so their synthetic ids never reach a uuid filter.
  const stageById = new Map<string, UsauSeriesStageCard>();
  if (!opts?.genderDivision) {
    const stages = await fetchSeriesStages(db, {
      startFrom: windowBack,
      startTo: windowForward,
      levels: levelFilter,
    });
    const stageGames = await Promise.all(
      stages.map((s) =>
        db.from('usau_games').select('id', { count: 'exact', head: true }).in('event_id', s.memberIds),
      ),
    );
    stages.forEach((s, i) => {
      const id = `series:${s.id}`;
      stageById.set(id, toStageCard(s));
      counts.set(id, stageGames[i].count ?? 0);
      events.push({
        id,
        usau_slug: '',
        name: s.name,
        start_date: s.startDate,
        end_date: s.endDate,
        competition_level: s.level,
      });
    });
  }
  const rankOf = (e: EventRow) => (stageById.has(e.id) ? SERIES_STAGE_RANK : flightRankForName(e.name));

  // Weekend cadence: before Wednesday we look back at last weekend; from
  // Wednesday on we look forward to the next weekend. The weekday comes from
  // the Eastern `today` so the cutover and the past/upcoming date split below
  // share one clock — the flip lands at Eastern midnight, not 8 pm ET
  // (getUTCDay rolled over four hours early).
  const lookForward = new Date(`${today}T12:00:00Z`).getUTCDay() >= 3; // Wed(3) → Sat(6)

  const endOf = (e: EventRow) => e.end_date ?? e.start_date ?? '';

  const bestRank = (e: EventRow) => bestRankByEvent.get(e.id) ?? Infinity;

  const teamCount = (e: EventRow) => teamCounts.get(e.id) ?? 0;

  /** Minimum field for an event to headline on size alone. Below this it's a
   *  scrimmage or a pre-sectional warm-up, not a tournament. */
  const MIN_HEADLINE_TEAMS = 8;

  /** How many ranked entrants a small event needs before its STRENGTH can earn
   *  it a headline slot despite the size floor. One ranked team is noise; a
   *  cluster means a genuinely strong small field. */
  const SMALL_EVENT_MIN_RANKED = 3;

  /** Whether an event clears the size floor — either on field size, or (for a
   *  small event) by fielding enough ranked teams that its AVERAGE rank can
   *  compete. Below-floor events aren't dropped, just demoted: they still
   *  headline when nothing else is available (early season, sparse weekend).
   *
   *  Hunter's rule: "any tournament with less than 8 teams shouldn't be
   *  included unless there are greater than 2 teams with an average rank higher
   *  than the other tournaments." */
  const clearsSizeFloor = (e: EventRow): boolean =>
    teamCount(e) >= MIN_HEADLINE_TEAMS || rankedCount(e) >= SMALL_EVENT_MIN_RANKED;

  /** Average official rank across an event's ranked entrants — the strength
   *  measure for the small-but-strong exception. Lower is better; an event with
   *  no ranked teams is Infinity so it never wins this comparison. Mean (not
   *  best) is deliberate: it's what distinguishes a deep field from one that
   *  happens to contain a single good team. */
  const avgRank = (e: EventRow) => avgRankByEvent.get(e.id) ?? Infinity;

  /** How many of an event's entrants carry an official ranking. */
  const rankedCount = (e: EventRow) => ranksByEvent.get(e.id)?.length ?? 0;

  // Quantize a start date to its tournament WEEKEND (the Saturday of the
  // Fri–Sun span) so co-scheduled events group together even when their
  // start days differ (a Fri-start flagship vs a Sat-start local), letting
  // flight break the tie within the weekend.
  const weekendKey = (d: string | null): string => {
    if (!d) return '';
    const dt = new Date(d + 'T00:00:00Z');
    if (isNaN(dt.getTime())) return d;
    const dow = dt.getUTCDay();
    // Sunday belongs to the weekend that began the day before; Thu/Fri (and
    // rare mid-week starts) roll forward to the coming Saturday.
    dt.setUTCDate(dt.getUTCDate() + (dow === 0 ? -1 : 6 - dow));
    return dt.toISOString().slice(0, 10);
  };

  // "Highest flight of the nearest WEEKEND": the closest weekend to now wins
  // first, and flight only breaks ties among that weekend's events. So last
  // weekend's Pro Elite Challenge headlines over a 5-week-old College
  // Championships, while a marquee event still out-headlines a co-scheduled
  // local tournament.
  const byWeekendThenFlight = (recentFirst: boolean) => (a: EventRow, b: EventRow) => {
    const wCmp = recentFirst
      ? weekendKey(b.start_date).localeCompare(weekendKey(a.start_date))
      : weekendKey(a.start_date).localeCompare(weekendKey(b.start_date));
    if (wCmp !== 0) return wCmp;
    const fCmp = rankOf(b) - rankOf(a);
    if (fCmp !== 0) return fCmp;
    // SIZE FLOOR, before strength of field. An event with a real field always
    // outranks a 2-team scrimmage or a 3-team pre-sectional, regardless of
    // whether the small one happens to contain a ranked team. A small event
    // still clears the floor when it fields 3+ ranked teams — then it competes
    // on average rank below, so a genuinely strong small field isn't buried.
    const aFloor = clearsSizeFloor(a) ? 1 : 0;
    const bFloor = clearsSizeFloor(b) ? 1 : 0;
    if (aFloor !== bFloor) return bFloor - aFloor;
    // Among small-but-strong events, DEPTH decides: mean rank across ranked
    // entrants, not the single best. (Only meaningful when both sides are
    // below the size floor — two full-size fields almost always both have
    // enough ranked teams that bestRank below is the sharper signal.)
    if (teamCount(a) < MIN_HEADLINE_TEAMS && teamCount(b) < MIN_HEADLINE_TEAMS) {
      const avgCmp = avgRank(a) - avgRank(b);
      if (avgCmp !== 0) return avgCmp;
    }
    // Strength of field: the event with the best-ranked entrant headlines.
    // Lower rank number = better, so this sorts ASCENDING; events with no
    // ranked team sort last (Infinity) rather than winning by default.
    const rCmp = bestRank(a) - bestRank(b);
    if (rCmp !== 0) return rCmp;
    // Equal strength → the bigger field wins (a 36-team and a 32-team event
    // both fielding a #13 team: the deeper one headlines).
    const tCmp = teamCount(b) - teamCount(a);
    if (tCmp !== 0) return tCmp;
    return recentFirst
      ? (b.start_date ?? '').localeCompare(a.start_date ?? '')
      : (a.start_date ?? '').localeCompare(b.start_date ?? '');
  };

  // IN-PROGRESS FIRST. A tournament happening RIGHT NOW (start ≤ today ≤ end)
  // always headlines Scores, ahead of both the weekend rule and flight rank.
  //
  // Without this, the weekend/flight sort could bury a live event: on a Sunday
  // the look-back bucket sorts by flight WITHIN the weekend, so a higher-flight
  // tournament that already ended Saturday out-ranked one still being played
  // today. Scores is the "what's on now" surface — a live event is the answer
  // whenever there is one.
  //
  // Ties among several in-progress events fall back to the same
  // weekend-then-flight comparator, so the marquee one still wins.
  const isInProgress = (e: EventRow) => {
    const start = e.start_date ?? '';
    const end = endOf(e);
    return start !== '' && start <= today && end >= today;
  };
  const inProgress = events.filter(isInProgress).sort(byWeekendThenFlight(true));
  const inProgressIds = new Set(inProgress.map((e) => e.id));
  const notLive = (e: EventRow) => !inProgressIds.has(e.id);
  const hasGames = (e: EventRow) => (counts.get(e.id) ?? 0) > 0;
  const startOf = (e: EventRow) => e.start_date ?? '';

  // Three buckets behind the live one:
  //   • UPCOMING — hasn't finished (end ≥ today), nearest weekend first. Games
  //     are NOT required: a Regionals whose brackets aren't posted yet is still
  //     the event everyone knows is next, and the slide reads "brackets
  //     pending". Hunter, 2026-09-17: "when there isn't an upcoming tournament
  //     we should always default to the next event we know is happening."
  //   • JUST PLAYED — started within the last 7 days and has results. This is
  //     "last weekend's tournament", and it must include one still finishing
  //     today (on the Sunday of a Sat–Sun flagship an ended-only rule once
  //     ranked a Saturday-only local over the live Pro Elite Challenge West).
  //   • OLDER — earlier in-window results, most recent first. Last resort.
  //
  // Direction only decides whether UPCOMING or JUST PLAYED comes first: from
  // Wednesday we look forward to the coming weekend, Sun–Tue we look back at
  // the one that just happened. Older results never beat a known upcoming
  // event. Before this, a gameless upcoming weekend fell through to ANY
  // in-window past event with games — and that list was sorted oldest-first
  // by a flipped comparator — so mid-September (Sectionals done, Regionals
  // nine days out) the hero showed an August 8 local tournament.
  const weekAgo = usauToday(new Date(now.getTime() - 7 * 86400_000));
  const upcoming = events
    .filter((e) => notLive(e) && endOf(e) >= today)
    .sort(byWeekendThenFlight(false));
  const justPlayed = events
    .filter((e) => notLive(e) && hasGames(e) && startOf(e) >= weekAgo && startOf(e) <= today)
    .sort(byWeekendThenFlight(true));
  const older = events
    .filter((e) => notLive(e) && hasGames(e) && startOf(e) !== '' && startOf(e) < weekAgo)
    .sort(byWeekendThenFlight(true));
  const ordered = lookForward
    ? [...inProgress, ...upcoming, ...justPlayed, ...older]
    : [...inProgress, ...justPlayed, ...upcoming, ...older];

  // hasGames=false → the preview shows "brackets pending".
  const pick = (e: EventRow, hasGames: boolean): UsauCurrentPick => {
    const series = stageById.get(e.id);
    return series ? { series, hasGames } : { slug: e.usau_slug, hasGames };
  };
  if (ordered.length > 0) return pick(ordered[0], hasGames(ordered[0]));
  return null;
}

/**
 * The next UPCOMING flagship event — for the home "Up next" card.
 *
 * getCurrentEvent() runs a look-back/look-forward weekend cadence tuned for the
 * hero + "recent results" slots: Sun–Tue it deliberately returns LAST weekend's
 * (now-finished) event. That's wrong for "Up next", which must always look
 * FORWARD — otherwise the USAU "Up next" card vanishes for half of every week
 * once last weekend's tournaments end.
 *
 * Only "flighted"-grade events qualify — the ones worth previewing: a recognized
 * TCT flight (Pro/Elite/Select/Classic/Triple-Crown), a pinnacle championship,
 * OR any Masters/College event (championships + regionals, which are the
 * division equivalent of a flagship). Unclassified local CLUB tournaments (MOB
 * Invite, Filling the Void, …) are skipped so the card jumps to the next event
 * that actually matters (e.g. Select Flight Invite over a co-scheduled local).
 *
 * Among qualifying events it picks the NEAREST UPCOMING WEEKEND, and within it
 * the HIGHEST FLIGHT. An event still in progress today counts as "upcoming"
 * (end_date ≥ today) so a live Sat–Sun event stays in "Up next" through its
 * final day. Returns the slug + hasGames, mirroring getCurrentEvent(); callers
 * fetch the full event via getEvent().
 */
export async function getNextUpcomingEvent(opts?: {
  genderDivision?: 'Men' | 'Women' | 'Mixed';
  competitionLevel?: CompetitionLevel;
}): Promise<{ slug: string; hasGames: boolean } | null> {
  const db = await supabase();
  const today = usauToday();
  // Look ~120d ahead: far enough to always find the next flagship weekend even
  // in a sparse stretch, tight enough to stay clear of the 1000-row cap.
  const windowForward = new Date(Date.now() + 120 * 86400_000)
    .toISOString()
    .slice(0, 10);

  const levelFilter = opts?.competitionLevel ? [opts.competitionLevel] : FLAGSHIP_LEVELS;

  // Masters-family: also include combined-championship events fielding this
  // division under a sibling tag (see MASTERS_FAMILY note).
  const mastersInclusionIds =
    opts?.competitionLevel && isMastersFamily(opts.competitionLevel)
      ? await eventIdsWithTeamLevel(db, opts.competitionLevel)
      : null;

  // Upcoming = not yet ended (end_date ≥ today), so a live event stays here
  // through its last day. Order soonest-first.
  let upcomingQ = db
    .from('usau_events')
    .select('id, usau_slug, name, start_date, end_date, competition_level')
    .gte('end_date', today)
    .lte('start_date', windowForward)
    .order('start_date', { ascending: true });
  upcomingQ =
    mastersInclusionIds && mastersInclusionIds.size > 0
      ? upcomingQ.or(
          `competition_level.eq.${opts!.competitionLevel},id.in.(${Array.from(mastersInclusionIds).join(',')})`,
        )
      : upcomingQ.in('competition_level', levelFilter);
  const { data: rows } = await upcomingQ;

  type Row = {
    id: string;
    usau_slug: string;
    name: string | null;
    start_date: string | null;
    end_date: string | null;
    competition_level: string | null;
  };
  let events = (rows ?? []) as Row[];

  // Keep only "flighted"-grade events. A plain CLUB tournament qualifies ONLY if
  // it maps to a real TCT flight or is a pinnacle championship; Masters, Grand
  // Masters, and College events always qualify (their championships + regionals
  // are the division equivalent of a flagship). This drops unclassified local
  // CLUB tournaments so "Up next" surfaces the next event that matters.
  const isFlighted = (e: Row): boolean => {
    if (e.competition_level !== 'CLUB') return true; // Masters/GM/College always
    return flightForName(e.name) !== null || isPinnacleEventName(e.name);
  };
  events = events.filter(isFlighted);
  if (events.length === 0) return null;

  // Optional division filter: keep only events with a participating team in the
  // requested gender division.
  if (opts?.genderDivision) {
    const ids = events.map((e) => e.id);
    const withDiv = new Set<string>();
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: page } = await db
        .from('usau_event_teams')
        .select('event_id, usau_teams!inner(gender_division)')
        .in('event_id', ids)
        .eq('usau_teams.gender_division', opts.genderDivision)
        // PK (event_id, team_id) → total order so paged ranges don't skip/overlap.
        .order('event_id', { ascending: true })
        .order('team_id', { ascending: true })
        .range(from, from + PAGE - 1);
      const pageRows = page ?? [];
      for (const r of pageRows) withDiv.add((r as { event_id: string }).event_id);
      if (pageRows.length < PAGE) break;
    }
    events = events.filter((e) => withDiv.has(e.id));
    if (events.length === 0) return null;
  }

  // Quantize each start to its tournament WEEKEND (the Saturday of the Fri–Sun
  // span) so a Fri-start flagship and a Sat-start local on the same weekend
  // group together — otherwise "earliest start_date" would isolate the Friday
  // events and miss a higher-flight Saturday event on the same weekend.
  const weekendKey = (d: string | null): string => {
    if (!d) return '';
    const dt = new Date(d + 'T00:00:00Z');
    if (isNaN(dt.getTime())) return d;
    const dow = dt.getUTCDay();
    dt.setUTCDate(dt.getUTCDate() + (dow === 0 ? -1 : 6 - dow));
    return dt.toISOString().slice(0, 10);
  };

  // Nearest upcoming weekend = the earliest weekend present. Restrict to that
  // weekend's events, then pick the highest flight (Select > local), tie-broken
  // by soonest start.
  const nearestWeekendKey = events
    .map((e) => weekendKey(e.start_date))
    .filter(Boolean)
    .sort()[0];
  const nearestWeekend = events.filter((e) => weekendKey(e.start_date) === nearestWeekendKey);
  nearestWeekend.sort((a, b) => {
    const fCmp = flightRankForName(b.name) - flightRankForName(a.name);
    if (fCmp !== 0) return fCmp;
    return (a.start_date ?? '').localeCompare(b.start_date ?? '');
  });
  const pick = nearestWeekend[0];

  const { count } = await db
    .from('usau_games')
    .select('*', { count: 'exact', head: true })
    .eq('event_id', pick.id);
  return { slug: pick.usau_slug, hasGames: (count ?? 0) > 0 };
}

export interface UpcomingUsauEvent {
  /** Stable row key: the event slug, or the stage id for a series stage. */
  key: string;
  /** Event page, or a series stage's list (Schedule until it starts, then Scores). */
  href: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  /** TCT flight display label ("Pro Flight", "Select Flight", …) when the event
   *  maps to one; null for pinnacle/Masters/College events (still listed). */
  flightLabel: string | null;
  /** Series stages only: "27 sections" — shown where an event shows its flight. */
  seriesLabel: string | null;
  /** usau_events.competition_level ('CLUB', 'COLLEGE_D1', …) — lets the home
   *  season-phase logic scope "next event" to one level. A stage carries the
   *  level its tier rolls up to. */
  competitionLevel: string | null;
  /** usau_events.season (a stage's season). The home college phase counts only
   *  events of a season after the last College Championships. */
  season: number | null;
}

/** getCurrentEvent's pick: an event slug, or a whole series stage. */
export type UsauCurrentPick =
  | { slug: string; hasGames: boolean }
  | { series: UsauSeriesStageCard; hasGames: boolean };

/**
 * The next N UPCOMING flighted USAU events — for the home "Up next" card, which
 * lists several upcoming tournaments rather than one event's pool games.
 *
 * Same "flighted-grade" filter as getNextUpcomingEvent (a plain CLUB event needs
 * a real TCT flight or pinnacle status; Masters/GM/College always qualify), so
 * unclassified local tournaments are excluded. Ordered by tournament WEEKEND
 * ascending (soonest first), and within a weekend by flight DESCENDING (the
 * marquee event leads its weekend). An in-progress event (end_date ≥ today)
 * still counts as upcoming so it stays listed through its final day.
 */
export async function listNextUpcomingEvents(limit = 5): Promise<UpcomingUsauEvent[]> {
  const db = await supabase();
  const today = usauToday();
  const windowForward = usauToday(new Date(Date.now() + SEASON_PREVIEW_DAYS * 86400_000));
  // A stage's members start within a few weekends of each other, so members
  // that started up to 30 days back rebuild any stage still in play.
  const stageFrom = usauToday(new Date(Date.now() - 30 * 86400_000));

  const [{ data: rows }, stages] = await Promise.all([
    db
      .from('usau_events')
      .select('id, usau_slug, name, season, start_date, end_date, competition_level')
      .in('competition_level', FLAGSHIP_LEVELS)
      // Series members roll up into their stage row below.
      .is('series_stage', null)
      .gte('end_date', today)
      .lte('start_date', windowForward)
      .order('start_date', { ascending: true }),
    fetchSeriesStages(db, { startFrom: stageFrom, startTo: windowForward, levels: FLAGSHIP_LEVELS }),
  ]);

  type Row = {
    id: string;
    usau_slug: string;
    name: string | null;
    season: number;
    start_date: string | null;
    end_date: string | null;
    competition_level: string | null;
  };
  const events = ((rows ?? []) as Row[]).filter((e) =>
    e.competition_level !== 'CLUB'
      ? true
      : flightForName(e.name) !== null || isPinnacleEventName(e.name),
  );

  type Candidate = UpcomingUsauEvent & { rank: number };
  const candidates: Candidate[] = [
    ...events.map((e) => {
      const flight = flightForName(e.name);
      return {
        key: e.usau_slug,
        href: `/usau/events/${e.usau_slug}`,
        name: e.name ?? e.usau_slug,
        startDate: e.start_date,
        endDate: e.end_date,
        flightLabel: flight ? FLIGHT_LABELS[flight] : null,
        seriesLabel: null,
        competitionLevel: e.competition_level,
        season: e.season,
        rank: flightRankForName(e.name),
      };
    }),
    // Same "not yet ended" rule as events, so a stage stays through its last day.
    ...stages
      .filter((s) => (s.endDate ?? '') >= today)
      .map((s) => ({
        key: s.id,
        href: seriesStageHref(s, today),
        name: s.name,
        startDate: s.startDate,
        endDate: s.endDate,
        flightLabel: null,
        seriesLabel: seriesUnitLabel(s.stage, s.groupCount),
        competitionLevel: s.level,
        season: s.season,
        rank: SERIES_STAGE_RANK,
      })),
  ];

  // Quantize to the tournament weekend (Saturday of the Fri–Sun span) so a
  // Fri-start flagship and a Sat-start event on the same weekend group together.
  const weekendKey = (d: string | null): string => {
    if (!d) return '';
    const dt = new Date(d + 'T00:00:00Z');
    if (isNaN(dt.getTime())) return d;
    const dow = dt.getUTCDay();
    dt.setUTCDate(dt.getUTCDate() + (dow === 0 ? -1 : 6 - dow));
    return dt.toISOString().slice(0, 10);
  };

  // Sort: nearest weekend first; within a weekend, highest flight first (a
  // series stage outranks every TCT flight), then soonest start, then name.
  candidates.sort((a, b) => {
    const wk = weekendKey(a.startDate).localeCompare(weekendKey(b.startDate));
    if (wk !== 0) return wk;
    const fl = b.rank - a.rank;
    if (fl !== 0) return fl;
    const st = (a.startDate ?? '').localeCompare(b.startDate ?? '');
    if (st !== 0) return st;
    return a.name.localeCompare(b.name);
  });

  return candidates.slice(0, limit).map((c) => ({
    key: c.key,
    href: c.href,
    name: c.name,
    startDate: c.startDate,
    endDate: c.endDate,
    flightLabel: c.flightLabel,
    seriesLabel: c.seriesLabel,
    competitionLevel: c.competitionLevel,
    season: c.season,
  }));
}

/**
 * Find a USAU player profile by name using the token-subset match (see
 * src/lib/name-match.ts). Handles "Mitchell McCarthy" ↔ "Robert Mitchell
 * McCarthy" — the surname must match exactly, and the shorter name's
 * given tokens must all appear in the longer name's given tokens.
 *
 * Returns the player_id of the most-active matching row (most roster
 * entries). Returns null if no match. Used by /players/{ufaSlug} to
 * deep-link to the same human's USAU career.
 */
export async function findUsauPlayerByName(name: string): Promise<string | null> {
  const surname = surnameForPrefilter(name);
  if (!surname) return null;
  const db = await supabase();

  // Prefer the shared RPC: it runs the same surname-prefilter → names_match →
  // most-rosters ordering in SQL, but normalizes BOTH sides of the prefilter so
  // accented names resolve. The client-side path below compares a normalized
  // token against the RAW display_name, so "Daan De Marree" never finds
  // "Daan De Marrée" and the whole USAU side goes missing.
  // A null result is authoritative ("no such player"), NOT a reason to fall
  // through — the fallback is strictly weaker, so re-running it on a miss would
  // spend queries only to maybe resurrect a match the RPC correctly rejected.
  // Only a transport/missing-function error degrades to the client-side path.
  const { data: rpcId, error: rpcError } = await db.rpc('find_usau_player_by_name', {
    p_name: name,
  });
  if (!rpcError) return (rpcId as string | null) ?? null;

  // App Health Rule #2 (2026-08-12 outage): when the RPC failed because the DB
  // is saturated, the fallback below costs MORE than what just failed — a
  // leading-wildcard ilike over 100k+ rows plus a second usau_rosters query.
  // Re-running it on a timeout is how load became collapse. Only degrade to the
  // client-side path for real contract errors (missing function, bad schema
  // cache); on a health error, fail fast and report no match.
  if (isUnhealthyError(rpcError)) {
    console.error('[findUsauPlayerByName] db unhealthy, failing fast', rpcError.message);
    return null;
  }

  // Fallback (RPC missing/errored): cheap SQL prefilter on anyone whose
  // display_name *contains* the surname, then the strict token-subset match in
  // JS. Accent-sensitive — see above.
  const { data: matches } = await db
    .from('usau_players')
    .select('id, display_name')
    .ilike('display_name', `%${surname}%`)
    .limit(500);
  const aliases = await loadNameAliases();
  const candidates = (matches ?? []).filter((m) => namesMatch(name, m.display_name, aliases));
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].id;
  // Multiple candidate IDs — pick the one with the most DISTINCT (team, season)
  // stints, matching the RPC's ordering (20260821170000): with per-event roster
  // rows, a raw row count scores one player-season once per event the team
  // attended, over-ranking players whose teams travelled more. event_id is
  // deliberately NOT part of the key — ~255k legacy rows carry it NULL, so
  // keying on it would drop real history (mobile parity).
  const ids = candidates.map((c) => c.id);
  const { data: rosters } = await db
    .from('usau_rosters')
    .select('player_id, team_id, season')
    .in('player_id', ids);
  const stints = new Map<string, Set<string>>();
  for (const r of rosters ?? []) {
    if (!stints.has(r.player_id)) stints.set(r.player_id, new Set());
    stints.get(r.player_id)!.add(`${r.team_id}|${r.season}`);
  }
  return ids.sort((a, b) => (stints.get(b)?.size ?? 0) - (stints.get(a)?.size ?? 0))[0];
}

/**
 * USAU Club National Champions by season.
 * Returns a map of `season → { teamId, teamName }`. We look for the
 * `round = 'final'` game inside the National Championship bracket of the
 * Club Nationals event; the team with the higher score is the champion.
 *
 * Since usau_teams has multiple rows per franchise (one per year), the
 * returned teamId is the specific season's row — useful for matching
 * against usau_rosters.team_id directly.
 */
export interface UsauChampion {
  teamId: string;
  teamName: string;
  division: 'Men' | 'Women' | 'Mixed' | null;
}

/**
 * USAU Club National Champions, keyed by season then division.
 *
 * USAU runs Men's, Women's, and Mixed Nationals as one event id — so a
 * single event can have THREE finals (one per division). We resolve the
 * winning team for each, look up its gender_division, and bucket
 * accordingly. Callers can also call championsForSeasonAndDivision() to
 * pluck out a specific (season, division) winner.
 */
export async function getUsauClubChampionsBySeason(): Promise<
  Map<number, Map<string, UsauChampion>>
> {
  const db = await supabase();
  const { data: nationals, error: nationalsError } = await db
    .from('usau_events')
    .select('id, season, usau_slug')
    .eq('competition_level', 'CLUB')
    .or(
      'usau_slug.ilike.%national-championships%,' +
        'usau_slug.ilike.%club-nationals%,' +
        'usau_slug.ilike.%usa-ultimate-club-championships%',
    )
    .not('usau_slug', 'ilike', '%us-open%');
  if (nationalsError) throw nationalsError;
  const nationalsBySeason = new Map<string, { id: string; season: number }>();
  for (const e of nationals ?? []) {
    nationalsBySeason.set(e.id, { id: e.id, season: e.season });
  }
  if (nationalsBySeason.size === 0) return new Map();

  // Pull every round='final' game at any Nationals event. With Men +
  // Women + Mixed all under one event_id, we expect up to 3 finals per
  // event — one per division.
  const { data: finals, error: finalsError } = await db
    .from('usau_games')
    .select(
      'event_id, team_a_id, team_b_id, score_a, score_b, scheduled_at, bracket_name, ' +
        'team_a:usau_teams!team_a_id(name, gender_division), ' +
        'team_b:usau_teams!team_b_id(name, gender_division)',
    )
    .in('event_id', Array.from(nationalsBySeason.keys()))
    .eq('round', 'final')
    .order('scheduled_at', { ascending: false, nullsFirst: false })
    .order('id');
  if (finalsError) throw finalsError;

  type TeamRef = { name: string; gender_division: string | null } | null;
  type Row = {
    event_id: string;
    team_a_id: string | null;
    team_b_id: string | null;
    score_a: number | null;
    score_b: number | null;
    scheduled_at: string | null;
    bracket_name: string | null;
    team_a: TeamRef;
    team_b: TeamRef;
  };

  // season → division → champion. Placement games are sometimes tagged
  // round='final' too ("11th Place", "13th Place" at 2016 + 2024 Nationals), so
  // only gold-medal-bracket finals count and the latest-scheduled one wins. Same
  // rule as mobile; rows come latest-first, ties by id, matching the Club subset
  // of SQL _usau_nationals_champions().
  const result = new Map<number, Map<string, UsauChampion>>();
  const finalAt = new Map<string, number>();
  for (const g of (finals ?? []) as unknown as Row[]) {
    if (!isChampionshipBracketName(g.bracket_name)) continue;
    if (g.score_a == null || g.score_b == null) continue;
    if (g.score_a === g.score_b) continue;
    if (g.team_a_id == null || g.team_b_id == null) continue;
    const ev = nationalsBySeason.get(g.event_id);
    if (!ev) continue;

    const aWon = g.score_a > g.score_b;
    const winnerId = aWon ? g.team_a_id : g.team_b_id;
    const winnerName = (aWon ? g.team_a?.name : g.team_b?.name) ?? 'Unknown';
    // Both teams in a final are the same division. Use either side's
    // gender_division — fall back to inferring from the bracket name
    // ("Women's Division Championship") if the team lacks it.
    let division = (aWon ? g.team_a?.gender_division : g.team_b?.gender_division) ?? null;
    if (!division) {
      const b = (g.bracket_name ?? '').toLowerCase();
      if (b.includes('mixed')) division = 'Mixed';
      else if (b.includes("women")) division = 'Women';
      else if (b.includes("men")) division = 'Men';
    }
    if (!division) continue;

    const at = g.scheduled_at ? new Date(g.scheduled_at).getTime() : 0;
    const key = `${ev.season}|${division}`;
    if ((finalAt.get(key) ?? -Infinity) >= at) continue;
    finalAt.set(key, at);

    if (!result.has(ev.season)) result.set(ev.season, new Map());
    const seasonMap = result.get(ev.season)!;
    seasonMap.set(division, {
      teamId: winnerId,
      teamName: winnerName,
      division: division as UsauChampion['division'],
    });
  }
  return result;
}

export interface UsauNationalsMedal {
  year: number;
  place: 1 | 2 | 3;
}

/**
 * True ONLY for the season's National Championships — the pinnacle Series event.
 * Purpose-built for medal derivation because it must catch every historical
 * naming variant ("USA Ultimate National Championships", "…Club Championships",
 * "Club Nationals") while rejecting the many other events that also carry
 * "Championship": Regionals/Sectionals, US Open, Pro Championships, Worlds, HS.
 * (isPinnacleEventName misses "National Championships" — singular "national" —
 * which cost real titles, so we don't reuse it here.)
 */
export function isNationalsChampionshipName(name: string): boolean {
  const n = name.toLowerCase();
  if (/regional|sectional|conference/.test(n)) return false;
  if (/u\.?\s?s\.?\s?open|pro[- ]?championship|pro[- ]?elite|tune ?up|warm ?up|\binvite\b/.test(n))
    return false;
  if (/wucc|wmucc|wjuc|worlds?\b/.test(n)) return false;
  if (/high school|middle school|\byouth\b|state championship/.test(n)) return false;
  return (
    /national championship/.test(n) ||
    /club nationals/.test(n) ||
    /club championship/.test(n) ||
    /college championship/.test(n) ||
    /masters championship/.test(n)
  );
}

/**
 * A team's National Championship podium finishes, one per season.
 *   1st = won the Nationals final
 *   2nd = lost the Nationals final
 *   3rd = WON the 3rd-place game (the game between the two teams that lost the
 *         National Championship SEMIS). The loser of that game is 4th → no medal.
 *
 * Bracket-aware on purpose: USAU runs many placement brackets at Nationals
 * (Fifth Place, Pro Flight Play-In, 13th Place…) that each have their own
 * semis/finals — a loss there is NOT a podium finish. Podium is derived ONLY
 * from the main "Championship" bracket, so e.g. a team that lost the main
 * quarters and then the 5th-place-bracket semi does not get bronze.
 *
 * Matched by team name + gender division (usau_team_id is unpopulated, so a
 * franchise is name+division+level). Games bucketed by played-year with a
 * name-year guard to survive corrupt legacy events. 3rd needs the 3rd-place
 * game to be ingested; absent, no bronze rather than a wrong one.
 */
export async function getTeamNationalsMedals(
  teamName: string,
  genderDivision: string | null,
  competitionLevel: string | null,
): Promise<UsauNationalsMedal[]> {
  if (!teamName || !competitionLevel) return [];
  const db = await supabase();

  // Nationals events for this competition level. The DB filter must be tight:
  // a broad '%championship%' matches every Regional/Sectional Championship
  // (thousands of rows) and would silently truncate at PostgREST's 1000-row
  // cap — dropping older Nationals events (this bit us: pre-2023 titles
  // vanished). These patterns match only Nationals-shaped names; the JS
  // classifier below then drops the few stragglers (US Open / Pro Champs).
  const { data: events } = await db
    .from('usau_events')
    .select('id, season, name')
    .eq('competition_level', competitionLevel as CompetitionLevel)
    .or(
      'name.ilike.%national championship%,' +
        'name.ilike.%club nationals%,' +
        'name.ilike.%club championship%,' +
        'name.ilike.%college championship%,' +
        'name.ilike.%masters championship%',
    );
  const bySeason = new Map<string, { season: number; name: string }>();
  for (const e of (events ?? []) as Array<{ id: string; season: number; name: string }>) {
    if (isNationalsChampionshipName(e.name)) bySeason.set(e.id, { season: e.season, name: e.name });
  }
  if (bySeason.size === 0) return [];

  // We need the National Championship bracket (final + semis) PLUS the separate
  // 3rd-place game (a placement game between the two semi losers, labeled
  // "Third Place" / "WUCC Qualification" / etc.). Scoping to just these keeps
  // the result small — fetching every bracket game across ~12 Nationals events
  // would risk the PostgREST 1000-row cap (pool play alone is ~24 games/event).
  const { data: games } = await db
    .from('usau_games')
    .select(
      'event_id, round, bracket_name, scheduled_at, score_a, score_b, ' +
        'team_a:usau_teams!team_a_id(name, gender_division), ' +
        'team_b:usau_teams!team_b_id(name, gender_division)',
    )
    .in('event_id', Array.from(bySeason.keys()))
    .or(
      // The top bracket is named inconsistently across years — "Championship",
      // "Championship Bracket", "First/1st Place Bracket" — so fetch all of
      // them. `round.eq.placement`/`qualification` bring in the 3rd-place game.
      'bracket_name.ilike.%championship%,' +
        'bracket_name.ilike.%first place%,' +
        'bracket_name.ilike.%1st place%,' +
        'round.eq.placement,' +
        'bracket_name.ilike.%qualification%',
    );

  type TeamRef = { name: string; gender_division: string | null } | null;
  type Row = {
    event_id: string;
    round: string;
    bracket_name: string | null;
    scheduled_at: string | null;
    score_a: number | null;
    score_b: number | null;
    team_a: TeamRef;
    team_b: TeamRef;
  };

  const wantName = teamName.trim().toLowerCase();
  const wantDiv = genderDivision ?? null;
  const nameOf = (t: TeamRef): string => (t ? t.name.trim().toLowerCase() : '');
  const isThisTeam = (t: TeamRef): boolean => !!t && nameOf(t) === wantName;
  const inDivision = (t: TeamRef): boolean =>
    !!t && (wantDiv == null || t.gender_division == null || t.gender_division === wantDiv);
  const decisive = (g: Row): boolean =>
    g.score_a != null && g.score_b != null && g.score_a !== g.score_b;
  const winnerOf = (g: Row): TeamRef => (g.score_a! > g.score_b! ? g.team_a : g.team_b);
  const loserOf = (g: Row): TeamRef => (g.score_a! > g.score_b! ? g.team_b : g.team_a);
  // The MAIN (gold-medal) bracket. USAU names it inconsistently across years:
  // "Championship" / "Championship Bracket" / "Men's Division Championship"
  // (2021+, 2016, 2024) AND "First Place Bracket" / "1st Place Bracket" (2017,
  // 2018, 2022) — the latter has a trailing space in some rows. The lower
  // placement brackets are always ordinal ("Fifth Place", "13th Place", "Pro
  // Flight Play-In", "WUCC Qualification") — never "championship" or the exact
  // top-of-bracket "first/1st place" phrase. Guard consolation just in case.
  const isChampBracket = (g: Row): boolean => {
    const b = (g.bracket_name ?? '').trim().toLowerCase();
    if (b.includes('consolation')) return false;
    return b.includes('championship') || b.includes('first place') || b.includes('1st place');
  };

  // Bucket games by the year they were actually PLAYED (scheduled_at), not the
  // event's season field. Some legacy events lack a year in the name and merge
  // multiple years of Nationals under one event id (e.g. a "USA Ultimate
  // National Championships" row with games from 2014, 2016 AND 2017) — bucketing
  // by scheduled year splits those back into the correct seasons. Falls back to
  // the event season when a game has no scheduled_at.
  const yearOf = (g: Row): number | null => {
    const ev = bySeason.get(g.event_id);
    if (!ev) return null;
    let y = ev.season;
    if (g.scheduled_at) {
      const sy = new Date(g.scheduled_at).getUTCFullYear();
      if (Number.isFinite(sy)) y = sy;
    }
    // Guard against corrupt legacy events that lack a year in their name and
    // merge multiple seasons under one id with inconsistent dates: only trust a
    // game's year if the event name actually contains it. Well-formed Nationals
    // events always carry the year ("2025 USA Ultimate Club Nationals"); the
    // corrupt no-year "USA Ultimate National Championships" row is dropped.
    return ev.name.includes(String(y)) ? y : null;
  };
  const byYear = new Map<number, Row[]>();
  for (const g of (games ?? []) as unknown as Row[]) {
    const y = yearOf(g);
    if (y == null) continue;
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(g);
  }

  const best = new Map<number, 1 | 2 | 3>();
  const note = (season: number, place: 1 | 2 | 3) => {
    const cur = best.get(season);
    if (cur == null || place < cur) best.set(season, place);
  };

  for (const [season, allYearGames] of byYear) {
    // Same-year contamination guard. Legacy slug collisions pull the mid-season
    // U.S. Open (played Aug) into the Nationals event alongside the real
    // Nationals bracket (played Sep–Oct) — both carry a "championship"/"first
    // place" bracket, so naïvely we'd read TWO finals for one year (e.g. 2022
    // Mixed: a bogus U.S. Open "AMP 14-12 NOISE" beside the true Nationals
    // "Seattle Mixtape 14-12 NOISE"). Nationals ends the season, so the REAL
    // title bracket is the one owning the LATEST-dated champ final. Keep only
    // that bracket_name's games for this year+division.
    const champAll = allYearGames.filter(
      (g) => isChampBracket(g) && decisive(g) && inDivision(g.team_a) && inDivision(g.team_b),
    );
    const finals = champAll.filter((g) => g.round === 'final' && g.scheduled_at);
    let evGames = allYearGames;
    if (finals.length > 1) {
      const latest = finals.reduce((a, b) =>
        new Date(a.scheduled_at!) >= new Date(b.scheduled_at!) ? a : b,
      );
      const keepBracket = (latest.bracket_name ?? '').trim().toLowerCase();
      evGames = allYearGames.filter(
        (g) => (g.bracket_name ?? '').trim().toLowerCase() === keepBracket || !isChampBracket(g),
      );
    }

    // Championship-bracket games in THIS team's division only. USAU's placement
    // brackets (Fifth Place, Pro Flight Play-In, 13th Place…) also have their
    // own semis/finals — a loss there is NOT a podium finish, so they're
    // excluded by isChampBracket.
    const champ = evGames.filter(
      (g) => isChampBracket(g) && decisive(g) && inDivision(g.team_a) && inDivision(g.team_b),
    );

    // 1st / 2nd — the championship final.
    const finalG = champ.find((g) => g.round === 'final');
    if (finalG) {
      if (isThisTeam(winnerOf(finalG))) note(season, 1);
      else if (isThisTeam(loserOf(finalG))) note(season, 2);
    }

    // 3rd — losing a Championship-bracket semifinal.
    //
    // When USAU stages a 3rd-place game between the two semi losers, only its
    // WINNER is 3rd (the loser is 4th). But many Nationals (and every year with
    // no bronze-medal game, e.g. 2023 Mixed) leave the two semi losers to TIE
    // for 3rd — both take a bronze, matching USAU's official final standings.
    const semiLosers = champ.filter((g) => g.round === 'semi').map(loserOf);
    if (semiLosers.some(isThisTeam) && semiLosers.length >= 2) {
      const other = semiLosers.find((t) => !isThisTeam(t));
      const otherName = other ? nameOf(other) : '';
      // The 3rd-place game: the (post-semi) BRACKET game whose two teams are
      // exactly this team + the other semi loser. Found by team pairing, so the
      // bracket label ("Third Place" / "WUCC Qualification") doesn't matter.
      // Must NOT count a pool-play meeting between the same two teams as a
      // "3rd-place game" (they often played earlier in pools, e.g. 2022 Mixed
      // XIST bt Drag'n Thrust in Pool A) — that would wrongly deny the loser a
      // tied-3rd bronze. Restrict to placement/qualification/champ games.
      const isBracketGame = (g: Row): boolean => {
        const b = (g.bracket_name ?? '').toLowerCase();
        return (
          g.round === 'placement' ||
          b.includes('place') ||
          b.includes('qualification') ||
          isChampBracket(g)
        );
      };
      const thirdGame = otherName
        ? evGames.find(
            (g) =>
              decisive(g) &&
              isBracketGame(g) &&
              !(isChampBracket(g) && g.round === 'semi') &&
              ((nameOf(g.team_a) === wantName && nameOf(g.team_b) === otherName) ||
                (nameOf(g.team_b) === wantName && nameOf(g.team_a) === otherName)),
          )
        : undefined;
      if (thirdGame) {
        // A 3rd-place game was played → only its winner medals (loser is 4th).
        if (isThisTeam(winnerOf(thirdGame))) note(season, 3);
      } else {
        // No 3rd-place game → the semi losers tie for 3rd; both medal.
        note(season, 3);
      }
    }
  }

  return [...best.entries()]
    .map(([year, place]) => ({ year, place }))
    .sort((a, b) => b.year - a.year);
}

// ─── Recent USAU Majors with Champions ─────────────────────────────────────

/** Minimum ranked entrants an event needs before its average rank is treated as
 *  a meaningful field-strength signal. Below this, a tiny invite with a couple
 *  of strong teams outranks a 48-team Nationals on a raw mean (measured: a
 *  6-team event scored 15.0, ahead of Club Nationals at 12.0). Events under the
 *  threshold get `fieldStrength: null` and sort after every ranked event. */
export const MIN_RANKED_ENTRANTS_FOR_STRENGTH = 8;

export interface UsauMajorWithChampions {
  slug: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  /** usau_events.season — set by recentUsauMajorsWithChampions (the home college
   *  phase compares it with upcoming events' seasons). */
  season?: number;
  flight: Flight | null;
  /** Mean official USAU rank across every ranked entrant, ALL divisions pooled
   *  (division lives on usau_teams, so one tournament spans Men/Women/Mixed and
   *  gets ONE number). Lower = stronger field. Null when the event has fewer
   *  than MIN_RANKED_ENTRANTS_FOR_STRENGTH ranked entrants — i.e. "not enough
   *  signal", which is NOT the same as "weak field". Purely an ordering
   *  tiebreaker (sortTournamentsByStrength) — never rendered. */
  fieldStrength: number | null;
  /** How many entrants carried an official ranking — the sample behind
   *  fieldStrength. */
  rankedEntrants: number;
  champions: Array<{
    division: 'Men' | 'Women' | 'Mixed';
    teamName: string;
    teamId: string;
    /** True when the "winner" was derived from best pool-play record rather
     *  than a bracket final (pool-play-only events with no bracket). The card
     *  labels these "Pool leader" instead of "Champion". */
    viaPoolRecord?: boolean;
    /** Loser of the bracket final — the home "Season complete" card's
     *  "Finalist" row. Absent for pool-record winners. */
    runnerUpName?: string;
    runnerUpId?: string;
    /** Losers of the championship-bracket semifinals (tied 3rd — USAU plays
     *  no 3rd-place game). The card's "Semis" row. Absent when no
     *  championship semis were scraped. */
    semifinalists?: Array<{ name: string; id: string }>;
  }>;
  /** Divisions whose championship final was cancelled with no champion (2026
   *  Vacationland washout). The card says "Final cancelled" instead of the
   *  indefinite "Results pending" — naming the division when other divisions
   *  DID decide, so the missing one isn't read as "not scraped yet". */
  cancelledFinals?: Array<'Men' | 'Women' | 'Mixed'>;
}

/**
 * Returns up to `limit` recently-completed USAU TCT/major events (those where
 * `flightForName(name) !== null`), newest first, each enriched with the
 * champion(s) derived from round='final' games.
 *
 * Events with no scraped finals are omitted (we can't show a champion for them).
 */
export interface RecentMajorsOpts {
  /** Competition levels to scan (default ['CLUB']). */
  competitionLevels?: CompetitionLevel[];
  /** Event-name predicate replacing the default "named TCT flight" filter —
   *  e.g. the College Championships, which carry no flight name. */
  nameFilter?: (name: string) => boolean;
}

export async function recentUsauMajorsWithChampions(
  limit = 3,
  opts: RecentMajorsOpts = {},
): Promise<UsauMajorWithChampions[]> {
  const db = await supabase();
  const today = usauToday();
  const levels = opts.competitionLevels ?? ['CLUB'];
  const isMajor = opts.nameFilter ?? ((name: string) => flightForName(name) !== null);

  // 1. Pull the most-recent completed CLUB events. Scan wide (300 ≈ a bit over
  // a full season of the club calendar): flight-named majors are a small
  // fraction of it, and early in the club season a short scan only reaches ONE
  // completed major — the home "Recent results" row wants up to 4, which means
  // reaching back through last season's majors (Nationals, Pro Champs, US Open…)
  // until this season catches up. Single indexed query; rows are tiny.
  const { data: events } = await db
    .from('usau_events')
    .select('id, usau_slug, name, season, start_date, end_date')
    .in('competition_level', levels)
    .lt('end_date', today)
    .order('end_date', { ascending: false, nullsFirst: false })
    .limit(300);

  // 2. Filter to named flights (TCT majors only).
  const majorEvents = ((events ?? []) as Array<{
    id: string;
    usau_slug: string;
    name: string;
    season: number;
    start_date: string | null;
    end_date: string | null;
  }>).filter((e) => isMajor(e.name));

  if (majorEvents.length === 0) return [];

  const eventIds = majorEvents.map((e) => e.id);

  // 3. Fetch every semi + final for these events. Placement brackets carry
  // round='final' too (13th/17th place at College Nationals), so bracket_name
  // decides which one is the title game — see the loop below.
  const { data: bracketGames } = await db
    .from('usau_games')
    .select(
      'event_id, round, team_a_id, team_b_id, score_a, score_b, scheduled_at, bracket_name, status, ' +
        'team_a:usau_teams!team_a_id(name, gender_division), ' +
        'team_b:usau_teams!team_b_id(name, gender_division)',
    )
    .in('event_id', eventIds)
    .in('round', ['semi', 'final']);

  type TeamRef = { name: string; gender_division: string | null } | null;
  type Row = {
    event_id: string;
    round: string;
    team_a_id: string | null;
    team_b_id: string | null;
    score_a: number | null;
    score_b: number | null;
    scheduled_at: string | null;
    bracket_name: string | null;
    status: string | null;
    team_a: TeamRef;
    team_b: TeamRef;
  };

  const divisionOf = (g: Row, preferA: boolean): 'Men' | 'Women' | 'Mixed' | null => {
    let division =
      (preferA ? g.team_a?.gender_division : g.team_b?.gender_division) ??
      g.team_a?.gender_division ??
      g.team_b?.gender_division ??
      null;
    if (!division) {
      const b = (g.bracket_name ?? '').toLowerCase();
      if (b.includes('mixed')) division = 'Mixed';
      else if (b.includes('women')) division = 'Women';
      else if (b.includes('men')) division = 'Men';
    }
    return division === 'Men' || division === 'Women' || division === 'Mixed' ? division : null;
  };

  // 4. Latest-scheduled decided championship final per (event, division) —
  // the title game — plus the losers of that bracket's semis.
  type Decided = {
    teamName: string;
    teamId: string;
    runnerUpName?: string;
    runnerUpId?: string;
    scheduledAt: string;
  };
  const bestByKey = new Map<string, Decided>();
  const semiLosersByKey = new Map<string, Array<{ name: string; id: string }>>();
  // Cancelled championship finals: no champion, and the pool-record fallback
  // must not crown a pool leader either (matches championsForEvents / Scores).
  const cancelledKeys = new Set<string>();
  for (const g of (bracketGames ?? []) as unknown as Row[]) {
    // Without this the College card crowned the 13th-place winner (2026-09-11).
    if (isPlacementBracketName(g.bracket_name)) continue;
    // Before the score guard: a cancelled game is stored 0-0.
    if (g.status === 'cancelled') {
      const division = g.round === 'final' ? divisionOf(g, true) : null;
      if (division) cancelledKeys.add(`${g.event_id}|${division}`);
      continue;
    }
    if (g.score_a == null || g.score_b == null || g.score_a === g.score_b) continue;
    if (g.team_a_id == null || g.team_b_id == null) continue;

    const aWon = g.score_a > g.score_b;
    const division = divisionOf(g, aWon);
    if (!division) continue;
    const key = `${g.event_id}|${division}`;
    const loserId = aWon ? g.team_b_id : g.team_a_id;
    const loserName = (aWon ? g.team_b?.name : g.team_a?.name) ?? undefined;

    if (g.round === 'semi') {
      if (!semiLosersByKey.has(key)) semiLosersByKey.set(key, []);
      const losers = semiLosersByKey.get(key)!;
      if (loserName && !losers.some((l) => l.id === loserId) && losers.length < 2) {
        losers.push({ name: loserName, id: loserId });
      }
      continue;
    }

    const sched = g.scheduled_at ?? '';
    const prev = bestByKey.get(key);
    if (!prev || sched > prev.scheduledAt) {
      bestByKey.set(key, {
        teamName: (aWon ? g.team_a?.name : g.team_b?.name) ?? 'Unknown',
        teamId: aWon ? g.team_a_id : g.team_b_id,
        runnerUpName: loserName,
        runnerUpId: loserId,
        scheduledAt: sched,
      });
    }
  }

  const championsByEvent = new Map<string, UsauMajorWithChampions['champions']>();
  // `${eventId}|${division}` pairs already settled by a bracket final — used to
  // skip the pool-record fallback for divisions that DID play a bracket, plus
  // cancelled-final divisions.
  const decidedKeys = new Set<string>(cancelledKeys);
  for (const [key, v] of bestByKey) {
    const [eventId, division] = key.split('|') as [string, 'Men' | 'Women' | 'Mixed'];
    if (!championsByEvent.has(eventId)) championsByEvent.set(eventId, []);
    const semis = semiLosersByKey.get(key);
    championsByEvent.get(eventId)!.push({
      division,
      teamName: v.teamName,
      teamId: v.teamId,
      runnerUpName: v.runnerUpName,
      runnerUpId: v.runnerUpId,
      ...(semis && semis.length > 0 ? { semifinalists: semis } : {}),
    });
    decidedKeys.add(key);
  }

  // 4b. Pool-record fallback — same rule as the /scores tab. Every event here
  // is officially over (end_date < today), so any division WITHOUT a decided
  // championship final gets the unique best-pool-record team as its de-facto
  // winner (Hunter, 2026-09-11) — pool-play-only divisions, and divisions
  // whose bracket final was never scraped. Divisions decided by a bracket are
  // skipped via decidedKeys; a tie for first yields nothing.
  const poolWinners = await bestPoolRecordWinners(db, eventIds, decidedKeys);
  for (const w of poolWinners) {
    if (!championsByEvent.has(w.eventId)) championsByEvent.set(w.eventId, []);
    championsByEvent.get(w.eventId)!.push({
      division: w.division,
      teamName: w.teamName,
      teamId: w.teamId,
      viaPoolRecord: true,
    });
  }

  // 5. Build results — only events with a champion or a cancelled final.
  const DIV_ORDER: Record<string, number> = { Men: 0, Women: 1, Mixed: 2 };
  const results: UsauMajorWithChampions[] = [];
  for (const e of majorEvents) {
    const champions = championsByEvent.get(e.id) ?? [];
    // Same as the Scores path: a later replayed final that DID decide the
    // division clears the flag via the champions check.
    const cancelledFinals = [...cancelledKeys]
      .map((k) => k.split('|') as [string, 'Men' | 'Women' | 'Mixed'])
      .filter(
        ([eventId, division]) =>
          eventId === e.id &&
          !champions.some((c) => c.division === division && !c.viaPoolRecord),
      )
      .map(([, division]) => division)
      .sort((a, b) => (DIV_ORDER[a] ?? 9) - (DIV_ORDER[b] ?? 9));
    if (champions.length === 0 && cancelledFinals.length === 0) continue;
    results.push({
      slug: e.usau_slug,
      name: e.name,
      season: e.season,
      startDate: e.start_date,
      endDate: e.end_date,
      flight: flightForName(e.name),
      // Home "recent majors" cards never sort by strength — skip the rankings
      // queries entirely rather than paying for an unused signal.
      fieldStrength: null,
      rankedEntrants: 0,
      champions: champions.sort(
        (a, b) => (DIV_ORDER[a.division] ?? 9) - (DIV_ORDER[b.division] ?? 9),
      ),
      ...(cancelledFinals.length > 0 ? { cancelledFinals } : {}),
    });
    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Mean official USAU rank of each event's entrants, keyed by event id.
 *
 * Matched by NAME + division rather than usau_event_teams.team_id: ranking rows
 * and event-team rows routinely point at different usau_teams rows for the same
 * real team (USAU issues a new EventTeamId per scrape), so an id join silently
 * drops real entrants. Division is part of the key because a name-only match
 * crosses RankSets and would score a field off a false positive.
 *
 * All divisions at an event are POOLED into one number: gender_division lives
 * on usau_teams, not usau_events, so a tournament is inherently multi-division
 * and the /scores card is one card per tournament.
 *
 * Returns mean rank + ranked-entrant count per event. Events with no ranked
 * entrant are absent. Callers apply MIN_RANKED_ENTRANTS_FOR_STRENGTH.
 */
async function fieldStrengthByEvent(
  db: Awaited<ReturnType<typeof supabase>>,
  eventIds: string[],
  competitionLevel: CompetitionLevel,
): Promise<Map<string, { mean: number; ranked: number }>> {
  const out = new Map<string, { mean: number; ranked: number }>();
  if (eventIds.length === 0) return out;

  // Which RankSets can this level even produce? D-III/Masters publish none, so
  // those events legitimately come back empty rather than mis-keyed.
  const divisions: Array<'Men' | 'Women' | 'Mixed'> = ['Men', 'Women', 'Mixed'];
  const rankSets = new Map<string, OfficialRankDivision>();
  for (const g of divisions) {
    const rs = officialRankSetFor(competitionLevel, g);
    if (rs) rankSets.set(g, rs);
  }
  if (rankSets.size === 0) return out;

  // Latest (season, week) per RankSet — rankings are scraped weekly and we want
  // the current standings, not an average across every historical week.
  const heads = new Map<OfficialRankDivision, { season: number; week: number }>();
  await Promise.all(
    [...new Set(rankSets.values())].map(async (division) => {
      const { data } = await db
        .from('usau_rankings')
        .select('season, week')
        .eq('division', division)
        .order('season', { ascending: false })
        .order('week', { ascending: false })
        .limit(1);
      const head = (data ?? [])[0] as { season: number; week: number } | undefined;
      if (head) heads.set(division, head);
    }),
  );
  if (heads.size === 0) return out;

  // rankByKey: "division|lowercased team name" → best rank.
  const rankByKey = new Map<string, number>();
  await Promise.all(
    [...heads.entries()].map(async ([division, head]) => {
      // Paginate: a full division head-week can exceed PostgREST's 1000-row cap,
      // which truncates SILENTLY and would quietly under-count strong entrants.
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data: page } = await db
          .from('usau_rankings')
          .select('rank, team_name')
          .eq('division', division)
          .eq('season', head.season)
          .eq('week', head.week)
          .order('rank', { ascending: true })
          .range(from, from + PAGE - 1);
        const rows = (page ?? []) as Array<{ rank: number; team_name: string | null }>;
        for (const r of rows) {
          if (!r.team_name) continue;
          const key = `${division}|${r.team_name.trim().toLowerCase()}`;
          // Rows arrive rank-ascending, so the first write is the best rank.
          if (!rankByKey.has(key)) rankByKey.set(key, r.rank);
        }
        if (rows.length < PAGE) break;
      }
    }),
  );
  if (rankByKey.size === 0) return out;

  // Entrants per event. Paginated for the same silent-truncation reason.
  const sums = new Map<string, { total: number; ranked: number }>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: page } = await db
      .from('usau_event_teams')
      .select('event_id, usau_teams!team_id(name, gender_division)')
      .in('event_id', eventIds)
      // PK (event_id, team_id) → total order so paged ranges don't skip/overlap.
      .order('event_id', { ascending: true })
      .order('team_id', { ascending: true })
      .range(from, from + PAGE - 1);
    const rows = (page ?? []) as unknown as Array<{
      event_id: string;
      usau_teams: { name: string | null; gender_division: string | null } | null;
    }>;
    for (const row of rows) {
      const team = row.usau_teams;
      if (!team?.name || !team.gender_division) continue;
      const division = rankSets.get(team.gender_division);
      if (!division) continue;
      const rank = rankByKey.get(`${division}|${team.name.trim().toLowerCase()}`);
      if (rank == null) continue;
      const acc = sums.get(row.event_id) ?? { total: 0, ranked: 0 };
      acc.total += rank;
      acc.ranked += 1;
      sums.set(row.event_id, acc);
    }
    if (rows.length < PAGE) break;
  }

  for (const [eventId, acc] of sums) {
    if (acc.ranked === 0) continue;
    out.set(eventId, { mean: acc.total / acc.ranked, ranked: acc.ranked });
  }
  return out;
}

/**
 * The Sunday that "owns" a tournament, used as the weekend grouping key.
 *
 * Tournaments start Thursday/Friday/Saturday but almost always END Sunday, so
 * end_date is the stable signal. Grouping by the RAW end date still splits one
 * weekend in two, because a minority of events finish Saturday. Rolling any end
 * date forward to its own week's Sunday puts the whole weekend in one bucket,
 * so field strength orders within a weekend rather than across a spurious
 * one-day split. (Mirrors mobile's weekendKey — keep in sync.)
 */
function weekendKey(endDate: string | null): string {
  if (!endDate) return '';
  // Parse as UTC — these are date-only strings; local parsing would shift the
  // day backwards for anyone west of UTC and mis-bucket Sunday events.
  const d = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return endDate;
  const dow = d.getUTCDay(); // 0 = Sunday
  if (dow !== 0) d.setUTCDate(d.getUTCDate() + (7 - dow));
  return d.toISOString().slice(0, 10);
}

/**
 * THE ordering for the recent-tournaments feed: WEEKEND first (newest weekend
 * first), then field strength within each weekend (lowest mean entrant rank =
 * strongest field). Applied unconditionally by recentUsauTournamentPage — there
 * is no user-facing sort control; strength is purely the tiebreaker.
 *
 * Within a weekend, events without a strength score — too few ranked entrants,
 * or a level USAU publishes no rankings for (D-III, Masters) — sort BELOW every
 * scored event rather than being dropped. Unscored means "not enough signal",
 * not "weak field". Returns a new array; does not mutate the input.
 * (Mirrors mobile's sortTournamentsByStrength — keep in sync.)
 */
export function sortTournamentsByStrength(
  cards: UsauMajorWithChampions[],
): UsauMajorWithChampions[] {
  return [...cards].sort((a, b) => {
    // 1. Weekend, newest first.
    const wk = weekendKey(b.endDate).localeCompare(weekendKey(a.endDate));
    if (wk !== 0) return wk;

    // 2. Field strength within the weekend.
    const as = a.fieldStrength;
    const bs = b.fieldStrength;
    if (as != null && bs != null) {
      if (as !== bs) return as - bs;
      // Tie on strength — the deeper ranked field wins.
      if (a.rankedEntrants !== b.rankedEntrants) return b.rankedEntrants - a.rankedEntrants;
    } else if (as != null) {
      return -1;
    } else if (bs != null) {
      return 1;
    }

    // 3. Exact end date, then name — a total order so paging can't drop or
    //    duplicate a card between pages on re-sort.
    const ed = (b.endDate ?? '').localeCompare(a.endDate ?? '');
    if (ed !== 0) return ed;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Recent USAU tournaments for the /scores?league=usau landing: the last ~14
 * days (≈ 2 weekends) of FLAGSHIP tournaments, each enriched with per-division
 * champions.
 *
 * Selection (per Hunter):
 *   • FLAGSHIP only — ranked-flight events (Pro Elite, Elite-Select, Select
 *     Flight, Nationals, US Open, …). We deliberately DON'T show the long tail
 *     of local summer invites; team-count doesn't distinguish them (locals run
 *     14-35 teams too), and they aren't results people track.
 *   • FINISHED only — a card appears only once the tournament has ≥1 division
 *     champion (a decided final). In-progress/unscraped events are omitted.
 *   • Newest weekend first, then higher flight first within a weekend, capped
 *     at `limit`.
 *
 * Champion detection is corrected vs. the older per-event helper: USAU
 * sometimes labels BOTH a semifinal and the title game round='final' in the
 * same championship bracket, so we keep the LATEST-scheduled final per
 * (event, division) rather than whichever row we happen to see first.
 */
export async function recentUsauTournamentCards(
  now: Date = new Date(),
  limit = 10,
  competitionLevel: CompetitionLevel = 'CLUB',
  /** Optional Triple Crown Tour flight filter (Club only) — mirrors /schedule.
   *  Only events whose name maps to ONE OF these flights are returned. Empty ⇒
   *  all flights. */
  flights: Flight[] = [],
  /** Optional season — "which season's results am I looking at". null ⇒ every
   *  season (the original "most recent completed events" behavior). */
  season?: number | null,
  /** Zero-based page of `limit`-sized pages over the completed-event history.
   *  Page 0 is the most recent. */
  page = 0,
): Promise<UsauMajorWithChampions[]> {
  return (await recentUsauTournamentPage(now, limit, competitionLevel, flights, season, page))
    .cards.flatMap((c) => (c.kind === 'event' ? [c] : []));
}

/**
 * Paged form of recentUsauTournamentCards: one page of cards plus the total
 * event count, so a pager can render "Page 2 of 158" without a second request.
 *
 * Paging strategy differs by filter, because `flight` is a NAME-DERIVED tag
 * rather than a column and so cannot be expressed in the query:
 *   • No flight filter → true server-side paging via .range(). Constant cost
 *     per page regardless of how deep the user goes.
 *   • Flight filter active → the flight test only exists in JS, so the matching
 *     set must be materialized before it can be paged. Bounded by
 *     FLIGHT_SCAN_CAP pages of scanning rather than fetching the whole table.
 *
 * The 2026-08-12 outage guidance applies: page size stays small and the
 * per-page enrichment (champions, field strength) runs only over the events on
 * the CURRENT page, never the whole history.
 * (Ported from mobile's recentUsauTournamentPage — keep in sync.)
 */
export interface UsauTournamentPage {
  /** Tournaments plus series-stage cards, in feed order. */
  cards: UsauFeedCard[];
  /** Total matching events across all pages — drives "Page N of M". */
  total: number;
  /** Zero-based index of the page returned. */
  page: number;
  /** Total page count (always ≥ 1, even when empty). */
  pageCount: number;
}

export async function recentUsauTournamentPage(
  now: Date = new Date(),
  limit = 10,
  competitionLevel: CompetitionLevel = 'CLUB',
  flights: Flight[] = [],
  season?: number | null,
  page = 0,
): Promise<UsauTournamentPage> {
  const db = await supabase();
  // Eastern, not UTC: toISOString() rolls over at 8pm ET, which surfaced the
  // NEXT day's tournaments under Scores the evening before they started.
  const today = usauToday(now);

  const hasFlightFilter = flights.length > 0;
  const flightSet = hasFlightFilter ? new Set(flights) : null;
  const pageSize = Math.max(1, limit);
  const safePage = Math.max(0, Math.floor(page));

  // usau_event_feed = ordinary events plus ONE row per series stage (see the
  // 20260911230000 migration), so sectionals weekend pages as one "2026 USAU
  // Sectionals" card instead of 81 per-division rows. has_games replaces the
  // old usau_games!inner join: result-less shells stay out until they have games.
  type FeedRow = {
    kind: 'event' | 'series';
    key: string;
    event_id: string | null;
    name: string | null;
    season: number;
    level: UsauLevel;
    series_stage: UsauSeriesStage | null;
    start_date: string | null;
    end_date: string | null;
    group_count: number;
  };

  const baseQuery = (head: boolean) => {
    let q = db
      .from('usau_event_feed')
      .select(
        'kind, key, event_id, name, season, level, series_stage, start_date, end_date, group_count',
        head ? { count: 'exact', head: false } : undefined,
      )
      .eq('level', competitionLevel)
      .eq('has_games', true)
      // Completed OR CURRENTLY IN PLAY. Was `.lt('end_date', today)` — strictly
      // completed — which left a tournament that had started but not finished
      // showing in neither place: too late for the future-facing schedule, not
      // yet eligible here. A tournament being played right now is exactly when
      // its scores matter most, so `start_date <= today` admits it (a stage from
      // its first day) and has_games keeps result-less shells out.
      .lte('start_date', today);
    if (season != null) q = q.eq('season', season);
    return q
      // sort_date = end_date for events; a stage's is the Sunday of its first
      // weekend, and kind_rank 0 puts it ahead of that weekend's events.
      .order('sort_date', { ascending: false, nullsFirst: false })
      .order('kind_rank', { ascending: true })
      // Flight breaks the date tie. A busy August weekend ends eight club
      // tournaments on the same day; ordering those by `id` alone meant the top
      // card was chosen by a random UUID, so a 42-game local invite outranked
      // the Elite Select Challenge (Hunter, 2026-08-22). flight_rank ASCENDS
      // with prestige (0 = Triple Crown … 9 = unclassified), and is a generated
      // column mirroring flightForName — see the 20260822120000 migration.
      .order('flight_rank', { ascending: true })
      // Final key so the server-side order is TOTAL. Without it Postgres may
      // return same-sort_date rows in a different order per request, which would
      // let a card appear on two pages or on none.
      .order('key', { ascending: true });
  };

  let recent: FeedRow[];
  let total: number;

  if (!flightSet) {
    // Server-side paging — constant cost per page however deep the user goes.
    const from = safePage * pageSize;
    const { data, count } = await baseQuery(true).range(from, from + pageSize - 1);
    recent = (data ?? []) as unknown as FeedRow[];
    total = count ?? recent.length;
  } else {
    // Flight is name-derived, so the matching set has to be materialized in JS
    // before it can be paged. Scan in bounded chunks rather than pulling the
    // whole table.
    const SCAN_PAGE = 500;
    const FLIGHT_SCAN_CAP = 6; // ≤3000 events — covers every level's history
    const matched: FeedRow[] = [];
    let scanned = 0;
    for (let i = 0; i < FLIGHT_SCAN_CAP; i++) {
      const from = i * SCAN_PAGE;
      const { data } = await baseQuery(false).range(from, from + SCAN_PAGE - 1);
      const rows = (data ?? []) as unknown as FeedRow[];
      scanned += rows.length;
      for (const e of rows) {
        const f = flightForName(e.name);
        if (f != null && flightSet.has(f)) matched.push(e);
      }
      if (rows.length < SCAN_PAGE) break;
    }
    total = matched.length;
    recent = matched.slice(safePage * pageSize, safePage * pageSize + pageSize);
    if (scanned >= SCAN_PAGE * FLIGHT_SCAN_CAP) {
      console.warn(
        `[usau] flight scan hit its ${SCAN_PAGE * FLIGHT_SCAN_CAP}-event cap; deep flight-filtered pages may be incomplete.`,
      );
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (recent.length === 0) return { cards: [], total, page: safePage, pageCount };

  const eventRows = recent.filter((r) => r.kind === 'event' && r.event_id != null);
  const stageCards = recent
    .filter((r) => r.kind === 'series' && r.series_stage != null)
    .map((r) =>
      seriesStageCard({
        season: r.season,
        stage: r.series_stage as UsauSeriesStage,
        level: r.level,
        startDate: r.start_date,
        endDate: r.end_date,
        groupCount: r.group_count,
      }),
    );
  const eventIds = eventRows.map((e) => e.event_id as string);
  const { championsByEvent, cancelledKeys } = await championsForEvents(
    db,
    eventRows.map((e) => ({ id: e.event_id as string, endDate: e.end_date })),
    today,
  );

  // Field strength (avg official rank of entrants) for the events on the
  // CURRENT page only — the extra rankings queries stay bounded to ≤10 events.
  const strengthByEvent = await fieldStrengthByEvent(db, eventIds, competitionLevel);

  const DIV_ORDER: Record<string, number> = { Men: 0, Women: 1, Mixed: 2 };
  const results: UsauMajorWithChampions[] = [];
  for (const e of eventRows) {
    const id = e.event_id as string;
    // Show every event in the window — including those with no champion yet
    // (no bracket final and no unique pool leader). Champions may be empty; the
    // card renders the event header with no winner row in that case.
    const champions = championsByEvent.get(id) ?? [];
    const strength = strengthByEvent.get(id);
    const ranked = strength?.ranked ?? 0;
    // Cancelled finals with no champion for that division (a later replayed
    // final that DID decide it clears the flag via the champions check).
    const cancelledFinals = [...cancelledKeys]
      .map((k) => k.split('|') as [string, 'Men' | 'Women' | 'Mixed'])
      .filter(
        ([eventId, division]) =>
          eventId === id &&
          !champions.some((c) => c.division === division && !c.viaPoolRecord),
      )
      .map(([, division]) => division)
      .sort((a, b) => (DIV_ORDER[a] ?? 9) - (DIV_ORDER[b] ?? 9));
    results.push({
      slug: e.key,
      name: e.name ?? e.key,
      startDate: e.start_date,
      endDate: e.end_date,
      flight: flightForName(e.name),
      fieldStrength:
        strength && ranked >= MIN_RANKED_ENTRANTS_FOR_STRENGTH ? strength.mean : null,
      rankedEntrants: ranked,
      champions: champions.sort((a, b) => (DIV_ORDER[a.division] ?? 9) - (DIV_ORDER[b.division] ?? 9)),
      ...(cancelledFinals.length > 0 ? { cancelledFinals } : {}),
    });
  }

  // Ordering WITHIN the page: WEEKEND first, then field strength as the
  // tiebreaker. Rows already arrive newest-end_date-first from the server,
  // which is what defines page membership; re-sorting here can only reorder
  // inside that page.
  //
  // NOTE: the pre-paging version floated marquee (high-flight) events to the
  // top across the whole result set. That is deliberately gone — with
  // server-side paging it would hoist a card above events the server placed on
  // an EARLIER page, so the same tournament could appear twice or vanish
  // depending on which page you were viewing. Date is the page key, so date
  // leads here too.
  return {
    // Stage cards slot in at the head of their weekend.
    cards: withSeriesStages(sortTournamentsByStrength(results), stageCards),
    total,
    page: safePage,
    pageCount,
  };
}

/**
 * Per-division champions for a set of events: the latest-scheduled decided
 * championship final per (event, division), then — once an event is over — the
 * unique best pool record for any division still without one. Shared by the
 * results feed and the series stage list.
 *
 * `divisionOf` pins every game of an event to one division. Series members are
 * single-division rows whose teams' own gender tags are null or wrong on ~100
 * entries, so their division comes from the member row instead.
 */
async function championsForEvents(
  db: Awaited<ReturnType<typeof supabase>>,
  events: Array<{ id: string; endDate: string | null }>,
  today: string,
  divisionOf: Map<string, 'Men' | 'Women' | 'Mixed'> = new Map(),
): Promise<{
  championsByEvent: Map<
    string,
    Array<{ division: 'Men' | 'Women' | 'Mixed'; teamName: string; teamId: string; viaPoolRecord?: boolean }>
  >;
  cancelledKeys: Set<string>;
}> {
  const eventIds = events.map((e) => e.id);
  if (eventIds.length === 0) return { championsByEvent: new Map(), cancelledKeys: new Set() };

  type TeamRef = { name: string; gender_division: string | null } | null;
  type Row = {
    event_id: string;
    team_a_id: string | null;
    team_b_id: string | null;
    score_a: number | null;
    score_b: number | null;
    winner_team_id: string | null;
    scheduled_at: string | null;
    bracket_name: string | null;
    status: string | null;
    round: string;
    bracket_stage: string | null;
    bracket_stage_index: number | null;
    team_a: TeamRef;
    team_b: TeamRef;
  };

  // round='final' games (plus every structure-column-0 game, for the
  // structural title deciders — see isStructuredTitleDecider) for all these
  // events, with scheduling to break the semi-vs-final ambiguity, and
  // bracket_name to drop placement brackets. Now
  // that we include EVERY club event in the window (not just flagships), page
  // through — a busy 2-weekend window can exceed PostgREST's 1000-row cap and
  // would otherwise silently drop finals.
  const PAGE = 1000;
  const finals: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data: page, error } = await db
      .from('usau_games')
      .select(
        'id, event_id, team_a_id, team_b_id, score_a, score_b, winner_team_id, scheduled_at, bracket_name, status, ' +
          'round, bracket_stage, bracket_stage_index, ' +
          'team_a:usau_teams!team_a_id(name, gender_division), ' +
          'team_b:usau_teams!team_b_id(name, gender_division)',
      )
      .in('event_id', eventIds)
      .or('round.eq.final,bracket_stage_index.eq.0')
      .order('id', { ascending: true }) // stable order so paged ranges don't skip/overlap
      .range(from, from + PAGE - 1);
    // A failed page (e.g. statement timeout) must not read as "no champion yet".
    if (error) throw error;
    const rows = (page ?? []) as unknown as Row[];
    finals.push(...rows);
    if (rows.length < PAGE) break;
  }

  // Keep the latest-scheduled decided final per (event, division), skipping
  // placement brackets (13th/17th place etc. also carry round='final').
  // tier 0 = a tagged final, 1 = a structural decider; a tagged final always
  // outranks a structural one, whatever the times.
  const best = new Map<
    string,
    { teamName: string; teamId: string; scheduledAt: string; tier: number }
  >();
  // `${eventId}|${division}` championship finals USAU cancelled — no champion
  // exists AND the pool-record fallback must not crown a Saturday pool leader
  // over a bracket that really reached its final (2026 Vacationland washout).
  const cancelledKeys = new Set<string>();
  for (const g of finals) {
    const b = (g.bracket_name ?? '').toLowerCase();
    const tier = g.round === 'final' ? 0 : 1;
    if (
      tier === 1 &&
      !isStructuredTitleDecider({
        round: g.round,
        bracketName: g.bracket_name,
        bracketStage: g.bracket_stage,
        bracketStageIndex: g.bracket_stage_index,
      })
    ) {
      continue;
    }
    if (isPlacementBracketName(g.bracket_name)) continue; // drop 5th/13th/17th, Third/Second Place…
    if (g.status === 'cancelled') {
      let division: string | null =
        divisionOf.get(g.event_id) ?? g.team_a?.gender_division ?? g.team_b?.gender_division ?? null;
      if (!division) {
        if (b.includes('mixed')) division = 'Mixed';
        else if (b.includes('women')) division = 'Women';
        else if (b.includes('men')) division = 'Men';
      }
      if (division) cancelledKeys.add(`${g.event_id}|${division}`);
      continue;
    }
    if (g.team_a_id == null || g.team_b_id == null) continue;
    // Scores, else a forfeit winner (USAU W/F letters).
    const winnerId = gameWinnerId({
      teamAId: g.team_a_id,
      teamBId: g.team_b_id,
      scoreA: g.score_a,
      scoreB: g.score_b,
      winnerTeamId: g.winner_team_id,
    });
    if (!winnerId) continue;

    const aWon = winnerId === g.team_a_id;
    const winnerName = (aWon ? g.team_a?.name : g.team_b?.name) ?? 'Unknown';
    let division: string | null =
      divisionOf.get(g.event_id) ?? (aWon ? g.team_a?.gender_division : g.team_b?.gender_division) ?? null;
    if (!division) {
      if (b.includes('mixed')) division = 'Mixed';
      else if (b.includes('women')) division = 'Women';
      else if (b.includes('men')) division = 'Men';
    }
    if (!division) continue;

    const key = `${g.event_id}|${division}`;
    const sched = g.scheduled_at ?? '';
    const prev = best.get(key);
    if (!prev || tier < prev.tier || (tier === prev.tier && sched > prev.scheduledAt)) {
      best.set(key, { teamName: winnerName, teamId: winnerId, scheduledAt: sched, tier });
    }
  }

  const championsByEvent = new Map<
    string,
    Array<{ division: 'Men' | 'Women' | 'Mixed'; teamName: string; teamId: string; viaPoolRecord?: boolean }>
  >();
  for (const [key, v] of best) {
    const [eventId, division] = key.split('|');
    if (!championsByEvent.has(eventId)) championsByEvent.set(eventId, []);
    championsByEvent
      .get(eventId)!
      .push({ division: division as 'Men' | 'Women' | 'Mixed', teamName: v.teamName, teamId: v.teamId });
  }

  // ── Pool-record fallback ────────────────────────────────────────────────
  // Some events (esp. lower-flight, pool-play-only weekends) never played a
  // bracket, so no (event, division) shows up in `best`. For those, the team
  // with the best pool-play record is the de-facto winner. We only declare one
  // when there's a UNIQUE best record — a tie for first in a pool-only format
  // has no clear champion, so we skip rather than guess.
  // Already won via bracket — plus cancelled-final divisions, where a pool
  // leader would misrepresent a bracket that reached its final.
  const decidedKeys = new Set([...best.keys(), ...cancelledKeys]);

  // No "Pool leader" while the event is still in play — a Saturday pool leader
  // is not a result. Once an event is officially over (end_date < today) every
  // division without a decided championship final gets its pool leader, even
  // when a bracket exists whose final was never scraped (Hunter, 2026-09-11;
  // matches the home "Recent results" reader).
  const poolEligibleIds = events
    .filter((e) => e.endDate != null && e.endDate < today)
    .map((e) => e.id);
  const poolWinners =
    poolEligibleIds.length > 0 ? await bestPoolRecordWinners(db, poolEligibleIds, decidedKeys, divisionOf) : [];
  for (const w of poolWinners) {
    if (!championsByEvent.has(w.eventId)) championsByEvent.set(w.eventId, []);
    championsByEvent.get(w.eventId)!.push({
      division: w.division,
      teamName: w.teamName,
      teamId: w.teamId,
      viaPoolRecord: true,
    });
  }

  return { championsByEvent, cancelledKeys };
}

/**
 * For (event, division) pairs with NO decided bracket final, derive the
 * de-facto winner from best pool-play record. Returns one winner per pair,
 * ONLY when the top record is unique (no tie for first) — a pool-only tie has
 * no clear champion. `decidedKeys` holds the `${eventId}|${division}` pairs
 * already settled by a bracket, which we skip.
 */
async function bestPoolRecordWinners(
  db: Awaited<ReturnType<typeof supabase>>,
  eventIds: string[],
  decidedKeys: Set<string>,
  /** Series members' own division (see championsForEvents). */
  divisionOf: Map<string, 'Men' | 'Women' | 'Mixed'> = new Map(),
): Promise<Array<{ eventId: string; division: 'Men' | 'Women' | 'Mixed'; teamName: string; teamId: string }>> {
  type TeamRef = { name: string; gender_division: string | null } | null;
  type Row = {
    event_id: string;
    team_a_id: string | null;
    team_b_id: string | null;
    score_a: number | null;
    score_b: number | null;
    winner_team_id: string | null;
    bracket_name: string | null;
    team_a: TeamRef;
    team_b: TeamRef;
  };

  // Pull all pool-play games across the candidate events, with each side's team
  // name + division for grouping and display. Page through — across every club
  // event in a 2-weekend window, pool games easily exceed PostgREST's 1000-row
  // cap, which would silently truncate records.
  //
  // Detect pool games by BRACKET NAME ("Pool A", "Pool Apple", …), NOT by
  // round='pool'. The ultirzr ingest tags pool games round='other' (its
  // classifyRound has no pool case), so ~90% of pool games in the DB are
  // round='other' — filtering on round would miss them and make round-robin
  // events read as "Results pending" even though the event page (which keys on
  // bracket_name) correctly shows a pool leader. Matching bracket_name keeps
  // the card and the event page in agreement.
  //
  // Fetch broadly with `%pool%` then confirm precisely on the bracket TAIL in
  // JS: combined masters events prefix every bracket with a group ("Masters Men
  // · Pool A"), so a `pool%` prefix filter MISSES them (the name starts with the
  // group, not "Pool") — which made masters Super Qualifiers read "Results
  // pending" despite a clear pool leader. `%pool%` also sweeps in crossovers
  // ("Pool B-C Crossover"), excluded by the tail check below.
  const PAGE = 1000;
  const poolGames: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data: page, error } = await db
      .from('usau_games')
      .select(
        'id, event_id, team_a_id, team_b_id, score_a, score_b, winner_team_id, bracket_name, ' +
          'team_a:usau_teams!team_a_id(name, gender_division), ' +
          'team_b:usau_teams!team_b_id(name, gender_division)',
      )
      .in('event_id', eventIds)
      .ilike('bracket_name', '%pool%')
      .order('id', { ascending: true }) // stable order so paged ranges don't skip/overlap
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (page ?? []) as unknown as Row[];
    poolGames.push(...rows);
    if (rows.length < PAGE) break;
  }

  // (eventId|division) → normalized team NAME → { wins, losses, name, teamId }.
  // ROBUSTNESS (dual-pipeline dedup, same as usau-event-detail's poolRecords):
  // the HTML + ultirzr ingest can create TWO team_ids for the same real team in
  // one event, so keying by team_id makes one team read as two identical rows →
  // a false tie that hides the pool winner (e.g. Brute Squad 6-0 twice → no
  // Women's champ). We (1) dedup games by matchup+score and (2) tally by
  // NORMALIZED NAME so duplicate team_ids collapse into one team.
  const norm = (n: string | null | undefined) => (n ?? '').trim().toLowerCase();
  const records = new Map<string, Map<string, { wins: number; losses: number; name: string; teamId: string }>>();
  const seenGameKeys = new Set<string>();

  const bump = (
    groupKey: string,
    teamId: string,
    name: string,
    won: boolean,
  ) => {
    if (!records.has(groupKey)) records.set(groupKey, new Map());
    const g = records.get(groupKey)!;
    const nk = norm(name);
    const r = g.get(nk) ?? { wins: 0, losses: 0, name, teamId };
    if (won) r.wins += 1;
    else r.losses += 1;
    g.set(nk, r);
  };

  for (const g of poolGames) {
    // Confirm this is a real pool game on the bracket TAIL (after any group
    // prefix): "Masters Men · Pool A" → "pool a". Excludes crossovers swept in
    // by the broad `%pool%` fetch ("Pool B-C Crossover").
    const tail = (() => {
      const n = g.bracket_name ?? '';
      const i = n.lastIndexOf('·');
      return (i >= 0 ? n.slice(i + 1) : n).trim().toLowerCase();
    })();
    if (!tail.startsWith('pool') || tail.includes('crossover')) continue;
    if (g.team_a_id == null || g.team_b_id == null) continue;
    // Scores, else a forfeit winner (a forfeit counts as a W/L).
    const winnerId = gameWinnerId({
      teamAId: g.team_a_id,
      teamBId: g.team_b_id,
      scoreA: g.score_a,
      scoreB: g.score_b,
      winnerTeamId: g.winner_team_id,
    });
    if (!winnerId) continue;
    // Division comes from the teams (pool games are single-division); require
    // both sides agree, else skip.
    const div = divisionOf.get(g.event_id) ?? g.team_a?.gender_division ?? g.team_b?.gender_division ?? null;
    if (div !== 'Men' && div !== 'Women' && div !== 'Mixed') continue;
    const groupKey = `${g.event_id}|${div}`;
    if (decidedKeys.has(groupKey)) continue; // bracket already settled this one

    // Dedup: one row per (event + division + unordered matchup + unordered
    // score). A repeat of the same result from the other pipeline is dropped.
    const na = norm(g.team_a?.name);
    const nb = norm(g.team_b?.name);
    if (!na || !nb) continue;
    const pair = [na, nb].sort();
    const aWon = winnerId === g.team_a_id;
    const result =
      g.score_a != null && g.score_b != null
        ? [g.score_a, g.score_b].sort((x, y) => x - y).join('|')
        : `F|${aWon ? na : nb}`;
    const gkey = `${groupKey}|${pair[0]}|${pair[1]}|${result}`;
    if (seenGameKeys.has(gkey)) continue;
    seenGameKeys.add(gkey);

    bump(groupKey, g.team_a_id, g.team_a?.name ?? 'Unknown', aWon);
    bump(groupKey, g.team_b_id, g.team_b?.name ?? 'Unknown', !aWon);
  }

  const winners: Array<{ eventId: string; division: 'Men' | 'Women' | 'Mixed'; teamName: string; teamId: string }> = [];
  for (const [groupKey, teamMap] of records) {
    const [eventId, division] = groupKey.split('|');
    const standings = Array.from(teamMap.values())
      .sort((a, b) => b.wins - a.wins || a.losses - b.losses);
    if (standings.length === 0) continue;
    const top = standings[0];
    // Unique best record only — a tie for the top win/loss line is ambiguous.
    const tiedForFirst = standings.filter(
      (s) => s.wins === top.wins && s.losses === top.losses,
    ).length;
    if (tiedForFirst > 1) continue;
    winners.push({
      eventId,
      division: division as 'Men' | 'Women' | 'Mixed',
      teamName: top.name,
      teamId: top.teamId,
    });
  }
  return winners;
}

/** Distinct seasons we have any event for, newest first. */
/** Lightweight top-N USAU club teams for the nav mega-menu PREVIEW (id + name
 *  + Nationals placement only), via the top_usau_club_teams RPC — ONE round
 *  trip, no ranking engine. Do NOT use for the real ranked Teams page; that's
 *  listRankedTeams(). */
export async function listTopUsauTeams(opts?: {
  genderDivision?: 'Men' | 'Women' | 'Mixed';
  limit?: number;
}): Promise<Array<{ id: string; name: string; nationalsPlacement: number | null }>> {
  const db = await supabase();
  // Cast: these RPCs are newer than the generated database.types.ts, so the
  // function-name union doesn't include them yet. Regenerate types to drop it.
  // NOTE: must call db.rpc(...) directly (bound) — extracting it into a local
  // `const rpc = db.rpc` detaches `this`, and supabase-js's rpc() then reads
  // `this.rest` → "Cannot read properties of undefined (reading 'rest')".
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpcDb = db as unknown as { rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: any; error: unknown }> };
  const { data, error } = await rpcDb.rpc('top_usau_club_teams', {
    p_gender_division: opts?.genderDivision ?? 'Men',
    p_limit: opts?.limit ?? 16,
  });
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string; name: string; nationals_placement: number | null }>).map(
    (r) => ({ id: r.id, name: r.name, nationalsPlacement: r.nationals_placement }),
  );
}

export async function listSeasons(): Promise<number[]> {
  const db = await supabase();
  // Distinct seasons via the pre-aggregated RPC. The naive
  // `.select('season')` over usau_events hit supabase-js's 1000-row cap —
  // with ~2000+ event rows ordered season-DESC, only the newest ~2-3 seasons
  // survived the cap, so the dropdown showed only 2024–2026 even though we
  // have data back to 2018. The RPC returns one row per distinct season.
  // Call db.rpc(...) DIRECTLY (bound) — a detached `const rpc = db.rpc` loses
  // `this` and supabase-js reads `this.rest` → "reading 'rest'" TypeError.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpcDb = db as unknown as { rpc: (fn: string) => Promise<{ data: any; error: unknown }> };
  const { data, error } = await rpcDb.rpc('distinct_usau_seasons');
  if (error) throw error;
  return ((data ?? []) as Array<{ season: number }>)
    .map((r) => r.season)
    .sort((a, b) => b - a);
}

// ─── Teams ─────────────────────────────────────────────────────────────

export interface UsauTeamCard {
  id: string;
  name: string;
  state: string | null;
  city: string | null;
  competitionLevel: string | null;
  genderDivision: string | null;
}

// ─── Players ───────────────────────────────────────────────────────────

export interface UsauPlayerCard {
  id: string;
  displayName: string;
  /** A team this player has been rostered on (deduped); used as a hint. */
  primaryTeam: string | null;
}

export interface UsauPlayerListRow {
  /** Anchor player_id — the one with the most roster rows for this name.
   *  Linking here picks up the full cluster via getPlayerProfile(). */
  id: string;
  displayName: string;
  /** Latest team this player played for. */
  latestTeam: string | null;
  latestTeamId: string | null;
  /** Most recent season we've seen them rostered. */
  latestSeason: number | null;
  /** Distinct (team, season) stints, summed across every player_id sharing
   *  this display name — an "activity" proxy until we have real cross-event
   *  stats. Counts DISTINCT team-seasons, not roster rows: usau_rosters is
   *  per-event, so a team playing 5 events would otherwise read as 5 stints. */
  appearances: number;
  /** Years this player's team won its level's Nationals (Club, College,
   *  Masters). Empty if none. */
  championYears: number[];
}

/**
 * Top N USAU players, ranked by national titles, then Nationals trips, finishes
 * and goals + assists, then Regionals finishes and trips (all computed in SQL).
 * Names are deduped so each human appears once even when the scraper
 * inserted multiple player_ids for them. The returned id is the anchor
 * with the most roster rows (richest profile).
 */
export async function listUsauPlayers(opts?: {
  limit?: number;
  season?: number;
  search?: string;
  /** Restrict to players whose team is in this gender division. */
  genderDivision?: 'Men' | 'Women' | 'Mixed';
  /** Restrict to players whose team is at this competition level (CLUB, MASTERS…). */
  competitionLevel?: CompetitionLevel;
}): Promise<UsauPlayerListRow[]> {
  const limit = opts?.limit ?? 60;
  const db = await supabase();

  // Aggregation lives in the list_usau_players RPC (one indexed SQL pass over
  // rosters⋈teams⋈players). The old client-side path paged the ENTIRE join
  // through PostgREST in 1000-row chunks per list view — the heaviest
  // table-read load on the DB (2026-08-11 diagnosis). Champions for every level
  // and the ranking are computed there too (_usau_nationals_champions), so
  // p_champions is no longer sent.

  const search = opts?.search?.trim();
  // Omitted (undefined) params fall through to the RPC's SQL defaults (null).
  const { data, error } = await db.rpc('list_usau_players', {
    p_limit: limit,
    p_season: opts?.season ?? undefined,
    p_division: opts?.genderDivision ?? undefined,
    p_level: opts?.competitionLevel ?? undefined,
    p_search: search && search.length >= 2 ? search : undefined,
  });
  if (error) throw error;
  return (data ?? []) as unknown as UsauPlayerListRow[];
}

// ─── Search ────────────────────────────────────────────────────────────

// SearchResult + resultHref live in ./search-nav (no supabase dependency) so
// the global nav search components can import them without pulling this whole
// data layer + supabase-js into the client bundle. Imported here for internal
// use (the search() query builds SearchResult[]) and re-exported for the
// server-side consumers that already import them from this module.
import { resultHref } from './search-nav';
import type { SearchResult } from './search-nav';
export { resultHref };
export type { SearchResult };

/** Prominence weight for a USAU team (higher = more prominent), from its
 *  competition level AND name. Adult club > college > youth. Many youth teams
 *  are mis-tagged as competition_level='CLUB' in the source data (e.g.
 *  "Colorado Cutthroat U-20 Boys", "... Academy", "Youth Club"), so we also
 *  detect youth markers in the NAME and demote them — otherwise a query like
 *  "Colorado" buries real clubs under U-17/U-20/Academy noise. We demote (not
 *  drop) youth so they still appear, just below senior teams. */
const YOUTH_NAME_RE = /\b(u-?\d{2}|under[- ]?\d{2}|youth|academy|middle school|high school|boys|girls|hs|ms)\b/i;
export function usauTeamProminence(name: string, level: string | null | undefined): number {
  if (YOUTH_NAME_RE.test(name)) return 0; // youth-by-name — lowest, below everything
  switch (level) {
    case 'CLUB':
    case 'MASTERS':
    case 'GRAND_MASTERS':
    case 'GREAT_GRAND_MASTERS':
      return 3; // adult club — most prominent
    case 'COLLEGE_D1':
    case 'COLLEGE_D3':
      return 2; // college
    default:
      return 1; // HS / MS / beach / other
  }
}

/**
 * One-shot text search across teams + players. Short-circuits on very
 * short queries (UI debounces but we still want a low floor).
 *
 * Dedupe behavior:
 *   - Teams: collapse by lowercased name + competition_level. The schema
 *     currently has one team row per event-participation (so "Revolver"
 *     appears 4 times if it played 4 events). The UI wants one card per
 *     canonical team, so we group here and pick the first row's UUID as
 *     the link target. Real fix is a canonical-team merge job; this is
 *     query-time good enough until then.
 *   - Players: collapse by lowercased display_name. Same rationale —
 *     same human on two different teams is currently two rows, but the
 *     search dropdown should show one entry that opens the unified
 *     profile.
 *
 * Uses Postgres ILIKE — fine at our current scale (220 teams, 5k
 * players). Swap in a tsvector + GIN index when we grow past ~50k rows.
 */
/** Compact date range for search hints, e.g. "Jun 13–14" or "Jun 28".
 *  Input is ISO yyyy-mm-dd (date-only); parse as UTC to avoid tz drift. */
function formatEventDateRange(start: string | null, end: string | null): string | null {
  if (!start) return null;
  const fmt = (iso: string) =>
    new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  const s = fmt(start);
  if (!end || end === start) return s;
  // Same month → "Jun 13–14"; else full "Jun 28 – Jul 1".
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  const e = sameMonth
    ? new Date(end + 'T00:00:00Z').toLocaleDateString('en-US', { day: 'numeric', timeZone: 'UTC' })
    : fmt(end);
  return `${s}–${e}`;
}

/** Sort two result names alphabetically, but when they're the SAME event across
 *  different years (identical text apart from a 4-digit year — leading like
 *  "2026 Rocky Mountain Sectional Championship" or trailing like
 *  "Heavyweights 2024"), order the year descending so the current season
 *  surfaces first instead of last. */
export function compareByNameThenYearDesc(a: string, b: string): number {
  const ya = splitYear(a);
  const yb = splitYear(b);
  if (ya.year != null && yb.year != null && ya.rest === yb.rest) return yb.year - ya.year;
  return ya.rest.localeCompare(yb.rest) || a.localeCompare(b);
}

function splitYear(name: string): { rest: string; year: number | null } {
  const m = name.match(/(^|[\s·(-])((?:19|20)\d{2})(?=$|[\s·)-])/);
  if (!m || m.index == null) return { rest: name.trim().toLowerCase(), year: null };
  const rest = `${name.slice(0, m.index)} ${name.slice(m.index + m[0].length)}`;
  return { rest: rest.replace(/[\s·-]+/g, ' ').trim().toLowerCase(), year: Number(m[2]) };
}

export async function search(query: string, limit = 8): Promise<SearchResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  // Pull a generous N from each side (3x the display limit) so dedupe
  // doesn't starve us — if "Revolver" returns 4 rows we still want 6
  // distinct teams in the dropdown.
  const overshoot = limit * 3;
  const db = await supabase();
  // Fuzzy (trigram) search via RPCs — tolerant of typos + word reordering,
  // ranked by similarity server-side. Falls back to substring matches too
  // (the RPC ORs ilike with word_similarity).
  // The new fuzzy RPCs aren't in the generated database.types.ts yet, so the
  // typed client rejects the names + return types — cast the client to a loose
  // rpc surface for these three calls.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpc = (db as any).rpc.bind(db);
  const [teamRes, playerRes, eventRes] = await Promise.all([
    rpc('search_usau_teams_fuzzy', { q, lim: overshoot }),
    rpc('search_usau_players_fuzzy', { q, lim: overshoot }),
    // One row per merged tournament (series divisions collapse to their group).
    rpc('search_usau_event_groups_fuzzy', { q, lim: overshoot }),
  ]);

  type TeamRow = { id: string; name: string; state: string | null; competition_level: string | null; gender_division: string | null };
  type PlayerRow = { id: string; display_name: string };
  type EventRow = { slug: string; name: string; season: number; start_date: string | null; end_date: string | null; division: string | null };

  // ── Dedupe teams by (lower(name), competition_level) ─────────────────
  // RPC returns rows already ranked by score; first occurrence wins.
  const teamMap = new Map<string, SearchResult>();
  for (const t of (teamRes.data ?? []) as TeamRow[]) {
    const key = `${t.name.toLowerCase()}${t.competition_level ?? ''}`;
    if (teamMap.has(key)) continue;
    const hintParts = [t.state, t.competition_level].filter(Boolean) as string[];
    teamMap.set(key, {
      kind: 'team',
      id: t.id,
      name: t.name,
      hint: hintParts.join(' · ') || null,
      league: 'usau',
      logoUrl: usauTeamLogo(t.name, t.gender_division, t.competition_level),
      prominence: usauTeamProminence(t.name, t.competition_level),
    });
  }

  // ── Dedupe players by lower(display_name) ────────────────────────────
  // The fuzzy player RPC omits the roster team (keeps it a cheap single-table
  // scan); the profile page shows career detail, so a null hint here is fine.
  const playerMap = new Map<string, SearchResult>();
  for (const p of (playerRes.data ?? []) as PlayerRow[]) {
    const key = p.display_name.toLowerCase();
    if (playerMap.has(key)) continue;
    playerMap.set(key, {
      kind: 'player',
      id: p.id,
      name: p.display_name,
      hint: null,
      league: 'usau',
    });
  }

  // ── Tournaments: keyed by slug (a merged series event's group key, else
  //    usau_slug). Hint = season + date range; the route uses the slug, not a
  //    UUID, plus ?div when one division matched best. ────────────────────────
  const tournamentMap = new Map<string, SearchResult>();
  for (const ev of (eventRes.data ?? []) as EventRow[]) {
    if (tournamentMap.has(ev.slug)) continue;
    const dates = formatEventDateRange(ev.start_date, ev.end_date);
    const hintParts = [String(ev.season), dates].filter(Boolean) as string[];
    tournamentMap.set(ev.slug, {
      kind: 'tournament',
      id: ev.slug,
      division: ev.division,
      name: ev.name,
      hint: hintParts.join(' · ') || null,
      flight: flightForName(ev.name),
      league: 'usau',
    });
  }

  const results: SearchResult[] = [
    ...teamMap.values(),
    ...playerMap.values(),
    ...tournamentMap.values(),
  ];

  // Prefix matches first, then alphabetical — except when two results are the
  // same event across years (e.g. "Heavyweights 2024" vs "Heavyweights 2026"),
  // where we want newest-first instead of oldest-first alphabetical.
  const lower = q.toLowerCase();
  results.sort((a, b) => {
    const ap = a.name.toLowerCase().startsWith(lower) ? 0 : 1;
    const bp = b.name.toLowerCase().startsWith(lower) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return compareByNameThenYearDesc(a.name, b.name);
  });

  return results.slice(0, limit * 2);
}

// ─── Detail pages: team / player / event ───────────────────────────────

export interface UsauPlayerSummary {
  id: string;
  displayName: string;
  /** Every distinct team this human (matched by lowercased name) has been on,
   *  with the events they played at on that team. */
  teamHistory: Array<{
    teamId: string;
    teamName: string;
    /** "Men" | "Women" | "Mixed" — passed through from usau_teams.gender_division.
     *  Required by UsauTeamLogo for accurate logo resolution (Men's vs Women's
     *  teams can share the same slug, e.g. "phoenix"). Null when unknown. */
    genderDivision: string | null;
    /** usau_teams.competition_level (e.g. "CLUB", "COLLEGE_D1"). Lets UsauTeamLogo
     *  resolve college crests from the College/ namespace. Null when unknown. */
    competitionLevel: string | null;
    season: number;
    jerseyNumber: string | null;
    /** True if this team won the Club Nationals championship that season. */
    isChampion: boolean;
    events: Array<{
      slug: string;
      name: string;
      season: number;
      startDate: string | null;
      goals: number | null;
      assists: number | null;
      seed: number | null;
      pool: string | null;
      /** True when USAU published a stats row for this event (a player only
       *  gets one if they had ≥1 G or A) — lets the UI show 0 (tracked, no
       *  score) instead of "—" (USAU never publishes stats here at all). */
      hasStats: boolean;
    }>;
  }>;
  /** Years this player won the USAU Club National Championship. */
  championYears: number[];
  /** US state postal codes this cluster's SERIES play maps to, derived from the
   *  section/region words in its Sectional/Regional event names (e.g. "Rocky
   *  Mountain" → CO). Used for cross-league pro-career attribution when a name
   *  splits into multiple people. Empty when no series region is recognized. */
  homeStates: string[];
  /** Did this display name split into MORE THAN ONE distinct human? False when
   *  every same-named row merged into a single cluster.
   *
   *  This is the precondition for using `homeStates` to attribute a pro career.
   *  Geography only ever answers "WHICH of the same-named people is the pro?" —
   *  with exactly one person there is nobody to confuse them with, and a state
   *  mismatch just means the player MOVED (Portland/Seattle club → Oakland
   *  Spiders). Dropping the career on that basis deletes real history. */
  nameIsAmbiguous: boolean;
}

/**
 * Build a player profile for the given USAU player id. We look up the
 * row's display name, then UNION across every player row whose
 * lowercased display name matches — that's the v1 cross-team identity.
 *
 * Known limitation: two real humans with the same exact name will merge
 * into one profile. We accept that for v1 (estimated < 2% collision rate
 * on the current dataset). Real fix is a `usau_canonical_players` +
 * `usau_player_identity_links` schema with auto-merge scoring (jersey
 * streak, roster overlap, geo, timeline) and a manual override table.
 * Design doc: ~/.claude/projects/<...>/memory/project_usau_player_identity.md
 */
/**
 * Build a predicate telling whether two team IDENTITY tuples are really the same
 * squad registered under two names (see the call site for why this exists).
 *
 * Decided by ROSTER OVERLAP, never by name shape: "Rhino"/"Rhino Slam!" share
 * 24 of 25 players, while genuine prefix-lookalikes ("Oregon"/"Oregon State",
 * "Virginia"/"Virginia Tech") share essentially none. We use CONTAINMENT — the
 * smaller roster's share of players also on the larger — because a team's
 * one-off tournament registration is often a partial squad.
 *
 * Only the candidate cluster's own teams are examined, so this adds one query
 * bounded by the namesakes' team count.
 */
async function buildTeamAliasChecker(
  db: Awaited<ReturnType<typeof supabase>>,
  candidateRosters: Array<{ team_id: string; season: number }>,
): Promise<(a: string, b: string) => boolean> {
  const teamIds = Array.from(new Set(candidateRosters.map((r) => r.team_id)));
  if (teamIds.length < 2) return () => false;

  // Every player on each candidate team, keyed by team, so we can compare
  // squads. Paged — a single Nationals team-event can approach the row cap.
  const membersByTeam = new Map<string, Set<string>>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data } = await db
      .from('usau_rosters')
      .select('team_id, player_id, usau_players(display_name)')
      .in('team_id', teamIds)
      // Unique key (team_id, season, event_id, player_id) so paged ranges
      // don't skip/overlap.
      .order('team_id', { ascending: true })
      .order('season', { ascending: true })
      .order('event_id', { ascending: true })
      .order('player_id', { ascending: true })
      .range(from, from + PAGE - 1);
    const rows = (data ?? []) as unknown as Array<{
      team_id: string;
      usau_players: { display_name: string } | null;
    }>;
    for (const r of rows) {
      // Compare by NAME, not player_id: the scraper mints a fresh player id per
      // event registration, so the same human on two of a team's events has two
      // ids and id-overlap would read as zero.
      const nm = r.usau_players?.display_name?.toLowerCase();
      if (!nm) continue;
      const set = membersByTeam.get(r.team_id) ?? new Set<string>();
      set.add(nm);
      membersByTeam.set(r.team_id, set);
    }
    if (rows.length < PAGE) break;
  }

  // Roll team rosters up to the IDENTITY tuple the conflict rule compares.
  const identityOf = new Map<string, string>();
  {
    const { data } = await db
      .from('usau_teams')
      .select('id, name, gender_division, competition_level')
      .in('id', teamIds);
    for (const t of (data ?? []) as Array<{
      id: string; name: string | null;
      gender_division: string | null; competition_level: string | null;
    }>) {
      identityOf.set(
        t.id,
        [(t.name ?? '').toLowerCase(), t.gender_division ?? '', t.competition_level ?? ''].join('|'),
      );
    }
  }
  const membersByIdentity = new Map<string, Set<string>>();
  for (const [teamId, members] of membersByTeam.entries()) {
    const ident = identityOf.get(teamId);
    if (!ident) continue;
    const set = membersByIdentity.get(ident) ?? new Set<string>();
    for (const m of members) set.add(m);
    membersByIdentity.set(ident, set);
  }

  // A real alias shares nearly its whole (smaller) roster. 0.6 sits far above
  // what distinct teams share (rivals overlap ~0, and even a few players moving
  // between clubs lands nowhere near this) and comfortably below the 0.96 the
  // Rhino registrations show, so it tolerates partial tournament squads.
  const ALIAS_CONTAINMENT = 0.6;
  const MIN_ROSTER = 5; // tiny rosters overlap by luck — don't judge them
  const cache = new Map<string, boolean>();
  return (a: string, b: string): boolean => {
    if (a === b) return true;
    const key = a < b ? `${a} ${b}` : `${b} ${a}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const sa = membersByIdentity.get(a);
    const sb = membersByIdentity.get(b);
    let result = false;
    if (sa && sb && sa.size >= MIN_ROSTER && sb.size >= MIN_ROSTER) {
      let shared = 0;
      const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
      for (const m of small) if (large.has(m)) shared++;
      result = shared / small.size >= ALIAS_CONTAINMENT;
    }
    cache.set(key, result);
    return result;
  };
}

export async function getPlayerProfile(playerId: string): Promise<UsauPlayerSummary | null> {
  const db = await supabase();
  const { data: anchor, error: anchorErr } = await db
    .from('usau_players')
    .select('id, display_name')
    .eq('id', playerId)
    .maybeSingle();
  if (anchorErr) throw anchorErr;
  if (!anchor) return null;

  // Identity rule (v1): merge every row with the same lowercased name,
  // EXCEPT split when two rows share a season but list different teams
  // (one human cannot roster on two club teams in the same season).
  // Paged in PK order past PostgREST's 1000-row cap.
  const namesakes: Array<{ id: string; display_name: string }> = [];
  {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: page } = await db
        .from('usau_players')
        .select('id, display_name')
        .ilike('display_name', anchor.display_name)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      const rows = page ?? [];
      namesakes.push(...rows);
      if (rows.length < PAGE) break;
    }
  }
  const candidateIds = (namesakes ?? [])
    .filter((p) => p.display_name.toLowerCase() === anchor.display_name.toLowerCase())
    .map((p) => p.id);

  if (candidateIds.length === 0) {
    return { id: anchor.id, displayName: anchor.display_name, teamHistory: [], championYears: [], homeStates: [], nameIsAmbiguous: false };
  }

  // Pull rosters for ALL candidates so we can compute the cluster.
  // gender_division is needed downstream to look up the right (season,
  // division) champion since 3 divisions share the same Nationals event.
  // Paged in unique-key order past PostgREST's 1000-row cap. The id list is
  // not chunked: one name spans at most ~50 player ids (2026-10).
  interface CandidateRosterRow {
    player_id: string;
    team_id: string;
    season: number;
    event_id: string | null;
    jersey_number: string | null;
    usau_teams: { name: string; gender_division: string | null; competition_level: string | null } | null;
  }
  const candidateRosters: CandidateRosterRow[] = [];
  {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: page } = await db
        .from('usau_rosters')
        .select('player_id, team_id, season, event_id, jersey_number, usau_teams(name, gender_division, competition_level)')
        .in('player_id', candidateIds)
        .order('team_id', { ascending: true })
        .order('season', { ascending: true })
        .order('event_id', { ascending: true })
        .order('player_id', { ascending: true })
        .range(from, from + PAGE - 1);
      const rows = (page ?? []) as unknown as CandidateRosterRow[];
      candidateRosters.push(...rows);
      if (rows.length < PAGE) break;
    }
  }

  // For the identity conflict rule we need to know which candidate TEAMS played
  // a QUALIFYING event (official series or a marquee tournament). Fetch the
  // events for every candidate team_id and mark the teams that qualify.
  // Paged in PK order; the team list is unchunked (≤~50 per name, 2026-10).
  const candTeamIds = Array.from(new Set((candidateRosters ?? []).map((r) => r.team_id)));
  const qualifyingTeamIds = new Set<string>();
  if (candTeamIds.length > 0) {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: candEventRows } = await db
        .from('usau_event_teams')
        .select('team_id, usau_events(name)')
        .in('team_id', candTeamIds)
        .order('event_id', { ascending: true })
        .order('team_id', { ascending: true })
        .range(from, from + PAGE - 1);
      const rows = candEventRows ?? [];
      for (const row of rows) {
        const ev = (row as { usau_events: { name: string } | null }).usau_events;
        if (ev && isQualifyingSeriesEvent(ev.name)) qualifyingTeamIds.add((row as { team_id: string }).team_id);
      }
      if (rows.length < PAGE) break;
    }
  }

  // Union-find over same-named player rows → one connected component per human.
  //
  // CONFLICT rule (what BLOCKS a merge → keeps two profiles separate). Two rows
  // conflict iff ALL of:
  //   1. same season, AND
  //   2. same competition TRACK (Club / College-D1 / College-D3), AND
  //   3. different team identity, AND
  //   4. BOTH teams played a QUALIFYING event that season (official series —
  //      Sectionals/Regionals/Nationals — or a marquee tournament like TCT Pro
  //      Championships / U.S. Open, where no one guests).
  //
  // Rationale:
  //   • A team commits to ONE series path per season per track, so two DIFFERENT
  //     teams both in official series (same track, same year) can't be one human
  //     → different people. This is the reliable split signal (e.g. two "Thomas
  //     Brewster"s: one on Thunderpants at Mixed Sectionals, one on shame. at
  //     Mixed Regionals+Nationals, same 2024 Mixed track → split).
  //   • Cross-track (college + club + masters same year) is NORMAL for one human
  //     → never conflicts (e.g. Zeke Thoreson: college Colorado + club Bravo).
  //   • Guesting at a NON-qualifying "fun" event for another team is NOT a split
  //     signal → if either team's only appearance is a minor event, no conflict
  //     (default to same person).
  //
  // Team identity is the tuple (name+gender+level), NOT the per-event team_id:
  // the scraper writes a separate team_id per event (Regionals vs Nationals are
  // different team_ids for the same team), so comparing raw team_id would
  // falsely conflict a player's own Regionals + Nationals rows. usau_team_id is
  // unpopulated, so the identity tuple is the reliable key.
  const parent = new Map<string, string>();
  candidateIds.forEach((id) => parent.set(id, id));
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  // Competition TRACK from a team's level. College D1/D3 are distinct tracks;
  // everything else (CLUB, plus Masters which folds into CLUB at team level) is
  // the "club" track. Masters-vs-open within a season is not distinguishable at
  // the team level (both CLUB) — an accepted limitation.
  const trackOf = (level: string): string =>
    level === 'COLLEGE_D1' || level === 'COLLEGE_D3' ? level : 'CLUB';
  const teamMeta = (r: {
    team_id: string;
    usau_teams?: { name?: string | null; gender_division?: string | null; competition_level?: string | null } | null;
  }): { track: string; identity: string; qualifying: boolean } => {
    const t = r.usau_teams;
    const level = t?.competition_level ?? '';
    const identity = [(t?.name ?? '').toLowerCase(), t?.gender_division ?? '', level].join('|');
    return { track: trackOf(level), identity, qualifying: qualifyingTeamIds.has(r.team_id) };
  };
  // ── Team ALIASES (same squad, two registered names) ─────────────────────
  // USAU sometimes registers one team under two names in a single season —
  // Portland's "Rhino" (Regionals/Nationals/US Open/Pro Champs) and "Rhino
  // Slam!" (Pro-Elite Challenge West), 2025 Men's CLUB. Both are qualifying
  // events, so the conflict rule below read them as two different teams in the
  // same season+track and SPLIT one real human into two profiles.
  //
  // Name shape cannot decide this: "Oregon"/"Oregon State" and "Virginia"/
  // "Virginia Tech" are prefix pairs too, but they are genuinely different
  // teams — a fuzzy-name rule would merge real rivals. ROSTER OVERLAP can:
  // the two Rhino registrations share 24 of 25 players (96%), while true
  // rivals share ~none. So two identities are aliases when one side's roster
  // is substantially contained in the other's.
  const identitiesAreAliases = await buildTeamAliasChecker(db, candidateRosters ?? []);
  const rostersByPlayer = new Map<
    string,
    Array<{ season: number; track: string; identity: string; qualifying: boolean }>
  >();
  for (const r of candidateRosters ?? []) {
    if (!rostersByPlayer.has(r.player_id)) rostersByPlayer.set(r.player_id, []);
    const { track, identity, qualifying } = teamMeta(r as never);
    rostersByPlayer.get(r.player_id)!.push({ season: r.season, track, identity, qualifying });
  }
  for (let i = 0; i < candidateIds.length; i++) {
    for (let j = i + 1; j < candidateIds.length; j++) {
      const ra = rostersByPlayer.get(candidateIds[i]) ?? [];
      const rb = rostersByPlayer.get(candidateIds[j]) ?? [];
      let conflict = false;
      outer: for (const sa of ra) {
        for (const sb of rb) {
          if (
            sa.season === sb.season &&
            sa.track === sb.track &&
            sa.identity !== sb.identity &&
            sa.qualifying &&
            sb.qualifying &&
            // Two registrations of the SAME squad are not a split signal.
            !identitiesAreAliases(sa.identity, sb.identity)
          ) {
            conflict = true;
            break outer;
          }
        }
      }
      if (!conflict) union(candidateIds[i], candidateIds[j]);
    }
  }
  const anchorCluster = find(anchor.id);
  const playerIds = candidateIds.filter((id) => find(id) === anchorCluster);
  const clusterRosters = (candidateRosters ?? []).filter((r) => playerIds.includes(r.player_id));

  // Stats only need this cluster's player ids.
  const { data: statsData } = await db
    .from('usau_player_event_stats')
    .select('player_id, event_id, team_id, goals, assists')
    .in('player_id', playerIds);
  const rosterRes = { data: clusterRosters };
  const statsRes = { data: statsData };

  const teamIds = Array.from(new Set((rosterRes.data ?? []).map((r) => r.team_id)));
  interface ParticipationRow {
    team_id: string;
    event_id: string;
    seed: number | null;
    pool: string | null;
    usau_events: { usau_slug: string; name: string; season: number; start_date: string | null } | null;
  }
  // Paged in PK (event_id, team_id) order past PostgREST's 1000-row cap.
  const participationRows: ParticipationRow[] = [];
  if (teamIds.length > 0) {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data } = await db
        .from('usau_event_teams')
        .select('team_id, event_id, seed, pool, usau_events(usau_slug, name, season, start_date)')
        .in('team_id', teamIds)
        .order('event_id', { ascending: true })
        .order('team_id', { ascending: true })
        .range(from, from + PAGE - 1);
      const rows = (data ?? []) as unknown as ParticipationRow[];
      participationRows.push(...rows);
      if (rows.length < PAGE) break;
    }
  }

  // Per-EVENT roster gate (mirror of the _build_player_profile prosrc patch,
  // 20260824100000): event-keyed usau_rosters rows say who was actually
  // rostered AT an event. Where coverage exists for a (team, event), the
  // stint shows the event only if this cluster is on that event's roster —
  // a guest stint (Nethercutt: Lotus at the 2021 Pro-Elite Challenge only)
  // must not inherit the team's whole season. Uncovered events keep the
  // whole-season projection. Paged: coverage rows span every player on the
  // team, and a Nationals team-event alone exceeds the 1000-row cap.
  const eventRosterCoverage = new Set<string>();
  if (teamIds.length > 0) {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: page } = await db
        .from('usau_rosters')
        .select('team_id, event_id')
        .in('team_id', teamIds)
        .not('event_id', 'is', null)
        // Unique key (team_id, season, event_id, player_id) so paged ranges
        // don't skip/overlap.
        .order('team_id', { ascending: true })
        .order('season', { ascending: true })
        .order('event_id', { ascending: true })
        .order('player_id', { ascending: true })
        .range(from, from + PAGE - 1);
      for (const row of page ?? []) {
        eventRosterCoverage.add(`${row.team_id}|${row.event_id}`);
      }
      if ((page ?? []).length < PAGE) break;
    }
  }
  const clusterEventRoster = new Set<string>();
  for (const r of clusterRosters) {
    const eid = (r as { event_id?: string | null }).event_id;
    if (eid) clusterEventRoster.add(`${r.team_id}|${eid}`);
  }

  // Build maps for the join.
  const eventsByTeamId = new Map<string, ParticipationRow[]>();
  for (const row of participationRows) {
    if (!eventsByTeamId.has(row.team_id)) eventsByTeamId.set(row.team_id, []);
    eventsByTeamId.get(row.team_id)!.push(row);
  }
  const statsByEvent = new Map<string, { goals: number; assists: number }>();
  for (const s of statsRes.data ?? []) {
    const prev = statsByEvent.get(s.event_id) ?? { goals: 0, assists: 0 };
    statsByEvent.set(s.event_id, {
      goals: prev.goals + (s.goals ?? 0),
      assists: prev.assists + (s.assists ?? 0),
    });
  }

  // Dedupe team-seasons into one stint per real-world team+season.
  //
  // A team like "Colorado" plays several events per season (Regionals →
  // Nationals), and the scraper writes a SEPARATE per-event usau_teams row for
  // each participation (distinct team_id). Grouping by team_id therefore split
  // one team-season into multiple cards. The persistent usau_team_id column is
  // not populated yet, so we key on the stable identity tuple instead:
  //   name + gender_division + competition_level + season
  // This correctly (a) merges a team's Regionals + Nationals + Sectionals into
  // one stint, while (b) keeping Men's vs Women's (gender_division) and
  // college vs club "Colorado" (competition_level) as distinct stints.
  //
  // Because one stint now spans multiple per-event team_ids, we track them in
  // a Set so the events + champion passes below can look up every participation.
  type Stint = UsauPlayerSummary['teamHistory'][number] & { _teamIds: Set<string> };
  const stintMap = new Map<string, Stint>();
  for (const r of rosterRes.data ?? []) {
    const teamRel = (
      r as { usau_teams: { name: string; gender_division: string | null; competition_level: string | null } | null }
    ).usau_teams;
    const teamName = teamRel?.name ?? 'Unknown team';
    const genderDivision = teamRel?.gender_division ?? null;
    const level = teamRel?.competition_level ?? '';
    const key = [teamName.toLowerCase(), genderDivision ?? '', level, r.season].join('|');
    const existing = stintMap.get(key);
    if (!existing) {
      stintMap.set(key, {
        teamId: r.team_id,
        teamName,
        genderDivision,
        competitionLevel: level || null,
        season: r.season,
        jerseyNumber: r.jersey_number,
        isChampion: false,
        events: [],
        _teamIds: new Set([r.team_id]),
      });
    } else {
      existing._teamIds.add(r.team_id);
      if (!existing.jerseyNumber && r.jersey_number) existing.jerseyNumber = r.jersey_number;
    }
  }

  for (const stint of stintMap.values()) {
    const seenEvents = new Set<string>();
    const events: typeof stint.events = [];
    // The stint spans every per-event team_id for this team+season, so gather
    // participations across all of them (dedup by event_id).
    const participations = [...stint._teamIds].flatMap((tid) => eventsByTeamId.get(tid) ?? []);
    for (const p of participations) {
      const ev = (p as { usau_events: { usau_slug: string; name: string; season: number; start_date: string | null } | null }).usau_events;
      if (!ev || ev.season !== stint.season) continue;
      if (seenEvents.has(p.event_id)) continue;
      const covKey = `${p.team_id}|${p.event_id}`;
      if (eventRosterCoverage.has(covKey) && !clusterEventRoster.has(covKey)) continue;
      seenEvents.add(p.event_id);
      const stats = statsByEvent.get(p.event_id);
      events.push({
        slug: ev.usau_slug,
        name: ev.name,
        season: ev.season,
        startDate: ev.start_date,
        goals: stats?.goals ?? null,
        assists: stats?.assists ?? null,
        seed: p.seed,
        pool: p.pool,
        hasStats: stats != null,
      });
    }
    events.sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''));
    stint.events = events;
  }

  const teamHistoryStints = Array.from(stintMap.values()).sort(
    (a, b) => b.season - a.season || a.teamName.localeCompare(b.teamName),
  );

  // Mark championship stints. Champions are keyed (season → division →
  // winner) since one Nationals event has separate Men/Women/Mixed
  // finals. We pull the stint's team's gender_division and look up the
  // matching division's winner for that year.
  const champions = await getUsauClubChampionsBySeason().catch(
    () => new Map<number, Map<string, UsauChampion>>(),
  );
  // Build a fast (team_id → division) lookup from the rosters we
  // already have, so we don't re-query.
  const divisionByTeamId = new Map<string, string>();
  for (const r of clusterRosters) {
    const tr = (r as { usau_teams: { gender_division: string | null } | null }).usau_teams;
    if (tr?.gender_division) divisionByTeamId.set(r.team_id, tr.gender_division);
  }
  const championYears: number[] = [];
  for (const stint of teamHistoryStints) {
    // The stint spans multiple per-event team_ids; it's a champion if ANY of
    // them is the season's division winner (the title is won at Nationals,
    // which is one of the stint's participations).
    const ids = stint._teamIds;
    let isChamp = false;
    for (const tid of ids) {
      const div = divisionByTeamId.get(tid);
      const champ = div ? champions.get(stint.season)?.get(div) : null;
      if (champ && champ.teamId === tid) {
        isChamp = true;
        break;
      }
    }
    if (isChamp) {
      stint.isChampion = true;
      championYears.push(stint.season);
    }
  }
  championYears.sort((a, b) => b - a);

  // Strip the internal _teamIds set from the wire shape.
  const teamHistory = teamHistoryStints.map(({ _teamIds, ...stint }) => {
    void _teamIds;
    return stint;
  });

  // Home states: union of the state-sets implied by this cluster's SERIES
  // event names (Sectionals/Regionals). Drives cross-league pro attribution.
  const homeStatesSet = new Set<string>();
  for (const stint of teamHistory) {
    for (const ev of stint.events) {
      for (const st of statesForEventName(ev.name)) homeStatesSet.add(st);
    }
  }

  return {
    id: anchor.id,
    displayName: anchor.display_name,
    teamHistory,
    championYears,
    homeStates: [...homeStatesSet],
    // Ambiguous only when the conflict rule actually SPLIT the namesakes into
    // more than one human. All rows landing in one cluster means this name
    // identifies a single person.
    nameIsAmbiguous: playerIds.length < candidateIds.length,
  };
}

export interface UsauTeamSummary {
  id: string;
  name: string;
  state: string | null;
  competitionLevel: string | null;
  genderDivision: string | null;
  /**
   * One entry per season this team has played, newest first. Within
   * each season the events are sorted by date (newest first) and the
   * roster is deduped by (player_name, jersey_number) so the same human
   * isn't listed multiple times when the scraper wrote them under
   * multiple player_ids.
   */
  seasons: Array<{
    season: number;
    events: Array<{
      slug: string;
      name: string;
      startDate: string | null;
      seed: number | null;
      pool: string | null;
      finalPlacement: number | null;
    }>;
    roster: Array<{
      playerId: string;
      name: string;
      jerseyNumber: string | null;
    }>;
  }>;
}

export async function getTeam(teamId: string): Promise<UsauTeamSummary | null> {
  const db = await supabase();
  const { data: anchor, error } = await db
    .from('usau_teams')
    .select('id, name, state, competition_level, gender_division')
    .eq('id', teamId)
    .maybeSingle();
  if (error) throw error;
  if (!anchor) return null;

  // Cluster team rows: the scraper writes one usau_teams row per
  // (name, season) instead of one canonical row, so "Johnny Bravo"
  // shows up as 5 separate ids (one per year). Treat any team with the
  // same name + competition_level + gender_division as the same team.
  const { data: clusterTeams } = await db
    .from('usau_teams')
    .select('id, name, state, competition_level, gender_division')
    .ilike('name', anchor.name);
  const teamIds = (clusterTeams ?? [])
    .filter(
      (t) =>
        t.name.toLowerCase() === anchor.name.toLowerCase() &&
        t.competition_level === anchor.competition_level &&
        t.gender_division === anchor.gender_division,
    )
    .map((t) => t.id);
  if (teamIds.length === 0) teamIds.push(anchor.id);

  const partRes = await db
    .from('usau_event_teams')
    .select('team_id, event_id, seed, pool, final_placement, usau_events(usau_slug, name, season, start_date)')
    .in('team_id', teamIds);

  interface PartRow {
    team_id: string;
    event_id: string;
    seed: number | null;
    pool: string | null;
    final_placement: number | null;
    usau_events: { usau_slug: string; name: string; season: number; start_date: string | null } | null;
  }
  interface RosterRow {
    player_id: string;
    team_id: string;
    season: number;
    jersey_number: string | null;
    usau_players: { display_name: string } | null;
  }

  // Paged: a big club's rows across all seasons pass PostgREST's 1000-row cap
  // (Johnny Bravo: 1,467), and the unpaged read silently dropped whole seasons.
  // Ordered by the table's unique key so paged ranges don't skip/overlap.
  const rosterRows: RosterRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: page, error: rosterError } = await db
      .from('usau_rosters')
      .select('player_id, team_id, season, jersey_number, usau_players(display_name)')
      .in('team_id', teamIds)
      .order('team_id', { ascending: true })
      .order('season', { ascending: true })
      .order('event_id', { ascending: true })
      .order('player_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (rosterError) throw rosterError;
    const rows = (page ?? []) as unknown as RosterRow[];
    rosterRows.push(...rows);
    if (rows.length < PAGE) break;
  }

  // Group by season.
  const eventsBySeason = new Map<number, UsauTeamSummary['seasons'][number]['events']>();
  const seenEventBySeason = new Map<number, Set<string>>();
  for (const p of (partRes.data ?? []) as unknown as PartRow[]) {
    const ev = p.usau_events;
    if (!ev) continue;
    const seenSet = seenEventBySeason.get(ev.season) ?? new Set<string>();
    if (seenSet.has(p.event_id)) continue;
    seenSet.add(p.event_id);
    seenEventBySeason.set(ev.season, seenSet);
    if (!eventsBySeason.has(ev.season)) eventsBySeason.set(ev.season, []);
    eventsBySeason.get(ev.season)!.push({
      slug: ev.usau_slug,
      name: ev.name,
      startDate: ev.start_date,
      seed: p.seed,
      pool: p.pool,
      finalPlacement: p.final_placement,
    });
  }

  // Roster: dedupe by (season, lowercased name) — NAME ONLY, not name+jersey.
  // When the same human shows up under multiple player_ids in the same
  // season, the scraper can also disagree on their jersey number across
  // event registrations (a placeholder '0' from one event, the real number
  // from another) — keying on name+jersey let both survive as separate rows
  // (Hunter, 2026-08-20: "Robert Mitchell McCarthy" listed as both #0 and
  // #59 on the same roster). A real jersey number always wins over a missing
  // or '0' one; between two real numbers, the first one seen wins (same
  // "first wins" caveat as the player profile clustering elsewhere in this
  // file — we have no signal for which registration is more authoritative).
  //
  // The jersey value itself is also NUMERICALLY normalized: different event
  // registrations of the same club get scraped with different zero-padding,
  // so one row says '03' and another '3' — without normalizing, the display
  // value (not just the key) would flip depending on which row won.
  // Non-numeric jerseys pass through as trimmed strings.
  const normalizeJersey = (j: string | null): string | null => {
    const raw = (j ?? '').trim();
    if (raw === '') return null;
    return /^\d+$/.test(raw) ? String(parseInt(raw, 10)) : raw;
  };
  const rosterBySeason = new Map<
    number,
    Map<string, UsauTeamSummary['seasons'][number]['roster'][number]>
  >();
  for (const r of rosterRows) {
    const player = r.usau_players;
    if (!player) continue;
    const jersey = normalizeJersey(r.jersey_number);
    const key = player.display_name.toLowerCase();
    if (!rosterBySeason.has(r.season)) rosterBySeason.set(r.season, new Map());
    const seasonMap = rosterBySeason.get(r.season)!;
    const existing = seasonMap.get(key);
    const existingIsReal = existing?.jerseyNumber != null && existing.jerseyNumber !== '0';
    const candidateIsReal = jersey != null && jersey !== '0';
    if (!existing || (!existingIsReal && candidateIsReal)) {
      seasonMap.set(key, {
        playerId: r.player_id,
        name: player.display_name,
        jerseyNumber: jersey,
      });
    }
  }

  // Assemble seasons.
  const allSeasons = new Set<number>();
  for (const s of eventsBySeason.keys()) allSeasons.add(s);
  for (const s of rosterBySeason.keys()) allSeasons.add(s);
  const seasons = Array.from(allSeasons)
    .sort((a, b) => b - a)
    .map((season) => {
      const events = (eventsBySeason.get(season) ?? []).slice().sort((a, b) =>
        (b.startDate ?? '').localeCompare(a.startDate ?? ''),
      );
      const roster = Array.from(rosterBySeason.get(season)?.values() ?? []).sort((a, b) => {
        const jersey = (s: string | null) => (s != null ? parseInt(s, 10) : 999);
        const ja = jersey(a.jerseyNumber);
        const jb = jersey(b.jerseyNumber);
        if (!isNaN(ja) && !isNaN(jb) && ja !== jb) return ja - jb;
        return a.name.localeCompare(b.name);
      });
      return { season, events, roster };
    });

  return {
    id: anchor.id,
    name: anchor.name,
    state: anchor.state,
    competitionLevel: anchor.competition_level,
    genderDivision: anchor.gender_division,
    seasons,
  };
}

/** One per-division USAU row merged into a series event (Sectionals /
 *  Regionals are published one event per division). */
export interface UsauEventMember {
  id: string;
  slug: string;
  name: string;
  url: string | null;
  division: 'Men' | 'Women' | 'Mixed' | null;
  startDate: string | null;
  endDate: string | null;
  city: string | null;
  state: string | null;
  venue: string | null;
  /** This division's own venue timezone. Divisions of one merged event can
   *  play in different states, so game times format per member. */
  venueTz: string | null;
}

/** Series identity of a merged event (see the 20260911200000 migration). */
export interface UsauEventSeries {
  season: number;
  /** club-sectionals | club-regionals | college-conferences | college-regionals | masters-regionals */
  stage: string;
  /** club | d-i | d-iii | dev | masters | grand-masters | great-grand-masters */
  tier: string;
  /** usau_competition_level derived from the tier (competition_level itself is
   *  wrong on GGM rows stored as GRAND_MASTERS). */
  level: string;
  groupKey: string;
}

export interface UsauEventSummary {
  id: string;
  slug: string;
  name: string;
  season: number;
  startDate: string | null;
  endDate: string | null;
  city: string | null;
  state: string | null;
  /** IANA zone the scraper resolved for game times (from `state`, or inferred
   *  from the entrant teams when USAU lists the venue as "TBD"). Pass
   *  `venueTz ?? state` to the venue-tz formatters. */
  venueTz: string | null;
  /** Venue name derived from game field names. Null on ~48% of events (games
   *  that store only a bare "Field 3"); the UI renders nothing in that case. */
  venue: string | null;
  competitionLevel: string;
  /** Canonical USAU event page URL, for the "View on USAU" link. */
  url: string | null;
  /** Curated Triple Crown Tour flight (derived from the name), or null. */
  flight: Flight | null;
  /** The per-division rows merged into this event, Men/Women/Mixed order.
   *  Empty for ordinary events. */
  members: UsauEventMember[];
  /** Series identity for a merged Sectional/Regional, null otherwise. */
  series: UsauEventSeries | null;
  /** Per-player goals/assists for this event, when USAU published them
   *  (flagship events only — Nationals, Pro Champs, U.S. Open, college
   *  championships). Empty for the vast majority of events. Drives the
   *  Leaders tab; the team's genderDivision (via `teams`) decides which
   *  division a row belongs to. */
  playerStats: Array<{
    playerId: string;
    playerName: string;
    teamId: string | null;
    goals: number;
    assists: number;
  }>;
  teams: Array<{
    teamId: string;
    teamName: string;
    seed: number | null;
    pool: string | null;
    finalPlacement: number | null;
    /** "Men" | "Women" | "Mixed" | "Open" — used to split mixed-gender events
     *  like College Championships into separate Men's/Women's brackets. */
    genderDivision: string | null;
    /** The TEAM's competition level ("MASTERS" | "GRAND_MASTERS" | …).
     *  Combined masters championships host both levels in ONE event, with
     *  each team tagged per-group — this is what lets the event page split
     *  a Masters Men bracket from a GM Men bracket. */
    competitionLevel: string | null;
  }>;
  games: Array<{
    id: string;
    round: string;
    bracketName: string | null;
    teamAId: string | null;
    teamAName: string | null;
    teamBId: string | null;
    teamBName: string | null;
    seedA: number | null;
    seedB: number | null;
    scoreA: number | null;
    scoreB: number | null;
    /** Forfeit winner (usau_games.winner_team_id): set only when USAU reports
     *  the result as W/F letters, so both scores are null. Use gameWinnerId(). */
    winnerTeamId: string | null;
    location: string | null;
    scheduledAt: string | null;
    status: string;
    /** USAU's own schedule-row number (usau_game_id, falling back to a numeric
     *  usau_event_game_id — the scraper populates one or the other per batch).
     *  Within one bracket these are assigned in bracket-sheet order: a round's
     *  games sort into USAU's G1…Gn, and slot k of the next round is fed by
     *  games 2k-1/2k. The bracket tree uses this for game numbering, "W of
     *  Quarters G1" placeholder labels, and feeder linkage. null when USAU's id
     *  is absent or non-numeric (some batches store an opaque hash). */
    usauGameOrder: number | null;
    /** USAU's own placeholder text for a TBD side, scraped verbatim from the
     *  bracket cell ("P1 of Saturday Pool Play Pool A", "W of Quarterfinals
     *  G1"). Null once the side is seeded, and on rows scraped before
     *  2026-08-18. */
    teamAPlaceholder: string | null;
    teamBPlaceholder: string | null;
    /** Bracket structure captured from USAU's own markup (2026-09-13; see
     *  migration 20260913170000). Null on pool rows and on rows scraped
     *  before the columns existed — readers fall back to round heuristics.
     *  bracketStage: column label verbatim ("6th Place Quarters", "1st Semis").
     *  bracketStageIndex: 0 = the section's deciding column, 1 feeds it, ….
     *  bracketSlot: USAU's sheet slot (G<n>); byes leave gaps (G2, G3 only).
     *  nextUsauGameId / nextSlotSide: the game (usau_game_id) this winner
     *  feeds and which side of it — HTML rows only, ultirzr has no link. */
    bracketStage: string | null;
    bracketStageIndex: number | null;
    bracketSlot: number | null;
    nextUsauGameId: string | null;
    nextSlotSide: 'top' | 'btm' | null;
    /** USAU's own row id (usau_game_id) — what nextUsauGameId points at. */
    usauGameId: string | null;
    /** Division of the member row this game came from, set only on merged
     *  series events whose members all carry a division. The event page
     *  filters on it directly — merged siblings reuse bracket names and USAU
     *  game-id ranges, so the single-event division heuristics would misfile
     *  their games. Null everywhere else. */
    division: string | null;
    /** Division of the USAU schedule page the row was scraped from
     *  (source_url `…/schedule/<Men|Women|Mixed>/…`). Authoritative for a
     *  team-less bracket row, which the event page can't place by its teams.
     *  Null on rows from other sources (play.usaultimate.org, ultirzr). */
    scheduleDivision: 'Men' | 'Women' | 'Mixed' | null;
  }>;
}

/** The division segment of an HTML-scraped schedule URL (…/schedule/Mixed/Club-Mixed/). */
function scheduleDivisionOf(url: string | null): 'Men' | 'Women' | 'Mixed' | null {
  const m = url?.match(/\/schedule\/(Men|Women|Mixed)\//);
  return m ? (m[1] as 'Men' | 'Women' | 'Mixed') : null;
}

/** USAU's schedule-row ids run sequentially down the bracket sheet (~420k in
 *  2026; no pre-2025 bracket round spans more than 86k). Games on USAU's 2025
 *  platform carry random 7–9 digit ids instead (2025 Club Nationals Women's
 *  QFs: 82554085, 510013619, 118427905, 632628857), which sorted every legacy
 *  bracket built from them into a scrambled order. */
const MAX_SHEET_ORDER_ID = 1_000_000;

/** Numeric USAU schedule-row id, preferring usau_game_id. Hash-form and
 *  random-platform ids → null, so seed order takes over. */
function parseUsauGameOrder(gameId: string | null, eventGameId: string | null): number | null {
  for (const v of [gameId, eventGameId]) {
    if (!v || !/^\d+$/.test(v.trim())) continue;
    const n = parseInt(v, 10);
    if (n < MAX_SHEET_ORDER_ID) return n;
  }
  return null;
}

type EventGameRow = UsauEventSummary['games'][number];

/**
 * Drop stale scheduled rows that a played game has already superseded.
 *
 * USAU publishes a provisional schedule, then rewrites slots as the day runs (a
 * rain delay, a reseed, a pool finishing early). The scraper inserts the
 * replacement as a NEW row, and the abandoned one is never updated again —
 * leaving a 0-0 'scheduled' ghost in a field/time slot that a completed game
 * already owns.
 *
 * Two games cannot occupy one field at one time, so a 'scheduled' row sharing a
 * slot with a completed one is the abandoned row. Anchoring on the COMPLETED
 * game (rather than on which row is newer) is what keeps this safe: a genuinely
 * upcoming game has no completed game in its slot and is always kept. That
 * matters because the bracket now shows scheduled games rather than hiding
 * them — without this, every ghost would become a visible phantom matchup.
 */
function dropSupersededGames(games: EventGameRow[]): EventGameRow[] {
  const playedSlots = new Set<string>();
  for (const g of games) {
    const status = g.status.toLowerCase();
    if (status !== 'final' && status !== 'forfeit') continue;
    if (!g.location || !g.scheduledAt) continue;
    playedSlots.add(`${g.location.trim().toLowerCase()}|${g.scheduledAt}`);
  }
  if (playedSlots.size === 0) return games;

  return games.filter((g) => {
    if (g.status.toLowerCase() !== 'scheduled') return true;
    if (!g.location || !g.scheduledAt) return true;
    return !playedSlots.has(`${g.location.trim().toLowerCase()}|${g.scheduledAt}`);
  });
}

const TREE_ROUND_ORDER = ['prequarter', 'quarter', 'semi', 'final'] as const;

function isInformativePlaceholder(s: string | null | undefined): boolean {
  return !!s && s.trim().toLowerCase() !== 'tbd';
}

/**
 * Drop bracket rounds nothing fed. USAU sometimes emits a round of fully blank
 * rows (null teams, null placeholders, no location) beside semis seeded straight
 * from pools — Midas the III showed a TBD Quarterfinals column USAU never had.
 * dropSupersededGames keys on field+time so it cannot see these.
 *
 * Grouped by EXACT bracket_name (ghost rows share their siblings' name). Walks
 * final → prequarters: a blank round is unfed only when the nearest round
 * downstream is fully seeded. A blank round with nothing seeded below it (an
 * upcoming final under seeded semis, a whole pre-tournament bracket) is real.
 * (Ported from mobile — keep in sync.)
 */
function dropUnfedUpstreamRounds(games: EventGameRow[]): EventGameRow[] {
  const blank = (g: EventGameRow) =>
    g.teamAId == null &&
    g.teamBId == null &&
    !isInformativePlaceholder(g.teamAPlaceholder) &&
    !isInformativePlaceholder(g.teamBPlaceholder);
  const seeded = (g: EventGameRow) => g.teamAId != null && g.teamBId != null;
  const byBracket = new Map<string, EventGameRow[]>();
  for (const g of games) {
    if (!g.bracketName || !(TREE_ROUND_ORDER as readonly string[]).includes(g.round)) continue;
    const list = byBracket.get(g.bracketName) ?? [];
    list.push(g);
    byBracket.set(g.bracketName, list);
  }
  const dropIds = new Set<string>();
  for (const list of byBracket.values()) {
    const rounds = TREE_ROUND_ORDER.map((r) => list.filter((g) => g.round === r));
    let downstreamSeeded = false;
    for (let i = rounds.length - 1; i >= 0; i--) {
      const round = rounds[i];
      if (round.length === 0) continue;
      if (round.every(seeded)) downstreamSeeded = true;
      else if (downstreamSeeded && round.every(blank)) for (const g of round) dropIds.add(g.id);
      else downstreamSeeded = false;
    }
  }
  return dropIds.size === 0 ? games : games.filter((g) => !dropIds.has(g.id));
}

const EVENT_COLUMNS =
  'id, usau_slug, name, season, start_date, end_date, city, state, venue_tz, venue, competition_level, url, ' +
  'series_stage, series_tier, series_division, series_group_name, series_group_key';

export interface UsauEventRow {
  id: string;
  usau_slug: string;
  name: string;
  season: number;
  start_date: string | null;
  end_date: string | null;
  city: string | null;
  state: string | null;
  venue_tz: string | null;
  venue: string | null;
  competition_level: string;
  url: string | null;
  series_stage: string | null;
  series_tier: string | null;
  series_division: string | null;
  series_group_name: string | null;
  series_group_key: string | null;
}

/** How an /usau/events/[slug] slug resolved:
 *  - event:  an ordinary USAU event
 *  - member: one division's row of a series event — the page redirects it to
 *            its group slug with ?div= so old per-division links keep working
 *  - group:  a merged series event, addressed by its series_group_key */
export type ResolvedUsauEvent =
  | { kind: 'event'; row: UsauEventRow }
  | { kind: 'member'; row: UsauEventRow }
  | { kind: 'group'; rows: UsauEventRow[] };

const SERIES_DIVISION_ORDER: Record<string, number> = { Men: 0, Women: 1, Mixed: 2 };

function sortSeriesMembers(rows: UsauEventRow[]): UsauEventRow[] {
  return rows
    .slice()
    .sort(
      (a, b) =>
        (SERIES_DIVISION_ORDER[a.series_division ?? ''] ?? 9) -
          (SERIES_DIVISION_ORDER[b.series_division ?? ''] ?? 9) || a.name.localeCompare(b.name),
    );
}

/** series_tier → the usau_competition_level the app filters on. */
const SERIES_TIER_LEVEL: Record<string, string> = {
  club: 'CLUB',
  'd-i': 'COLLEGE_D1',
  dev: 'COLLEGE_D1',
  'd-iii': 'COLLEGE_D3',
  masters: 'MASTERS',
  'grand-masters': 'GRAND_MASTERS',
  'great-grand-masters': 'GREAT_GRAND_MASTERS',
};

// ─── Series stages ─────────────────────────────────────────────────────────
// One card per (season, series_stage, level) — "2026 USAU Sectionals" — stands
// in for a stage's per-division member rows on Scores, Schedule and home.

/** Above every TCT flight (≤ 5), below Nationals/Worlds (10). */
const SERIES_STAGE_RANK = 6;

export interface UsauSeriesStageCard {
  /** `${stage}:${season}:${level}` — also the usau_event_feed key. */
  id: string;
  season: number;
  stage: UsauSeriesStage;
  level: UsauLevel;
  name: string;
  /** First day of the earliest member tournament → last day of the latest.
   *  Placeholder-dated members (span > 4 days) are ignored unless every member
   *  is one — the same rule as the usau_event_feed view. */
  startDate: string | null;
  endDate: string | null;
  /** Merged tournaments in the stage: 27 sections, 8 regions. */
  groupCount: number;
}

/** One card on the USAU results feed: a tournament, or a whole series stage. */
export type UsauFeedCard =
  | ({ kind: 'event' } & UsauMajorWithChampions)
  | ({ kind: 'series' } & UsauSeriesStageCard);

const SERIES_STAGE_TITLE: Record<UsauSeriesStage, string> = {
  'club-sectionals': 'USAU Sectionals',
  'club-regionals': 'USAU Regionals',
  'college-conferences': 'College Conferences',
  'college-regionals': 'College Regionals',
  'masters-regionals': 'Regionals',
};

const SERIES_LEVEL_PREFIX: Partial<Record<UsauLevel, string>> = {
  COLLEGE_D1: 'D-I ',
  COLLEGE_D3: 'D-III ',
  MASTERS: 'Masters ',
  GRAND_MASTERS: 'Grand Masters ',
  GREAT_GRAND_MASTERS: 'Great Grand Masters ',
};

/** A series stage's display name ("2026 USAU Sectionals", "2026 D-I College
 *  Regionals") — the stage card title and the event page's back crumb. */
export function seriesStageName(stage: UsauSeriesStage, level: UsauLevel, season: number): string {
  return `${season} ${SERIES_LEVEL_PREFIX[level] ?? ''}${SERIES_STAGE_TITLE[stage]}`;
}

function seriesStageCard(s: Omit<UsauSeriesStageCard, 'id' | 'name'>): UsauSeriesStageCard {
  return {
    ...s,
    id: `${s.stage}:${s.season}:${s.level}`,
    name: seriesStageName(s.stage, s.level, s.season),
  };
}

/** Levels → the series tiers that roll up into them (Developmental college
 *  regionals ride with D-I). */
function seriesTiersFor(levels: readonly string[]): string[] {
  return Object.keys(SERIES_TIER_LEVEL).filter((t) => levels.includes(SERIES_TIER_LEVEL[t]));
}

function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

type SeriesMemberRow = Pick<
  UsauEventRow,
  'id' | 'season' | 'start_date' | 'end_date' | 'series_stage' | 'series_tier' | 'series_group_key'
>;

interface SeriesStageAgg extends UsauSeriesStageCard {
  memberIds: string[];
  /** Latest member start — Schedule keeps a stage until every member has started. */
  lastStart: string;
}

function aggregateSeriesStages(rows: SeriesMemberRow[]): SeriesStageAgg[] {
  const byId = new Map<string, SeriesMemberRow[]>();
  for (const r of rows) {
    const level = SERIES_TIER_LEVEL[r.series_tier ?? ''];
    if (!level || !r.series_stage || !r.start_date) continue;
    const id = `${r.series_stage}:${r.season}:${level}`;
    const list = byId.get(id);
    if (list) list.push(r);
    else byId.set(id, [r]);
  }
  return [...byId.values()].map((members) => {
    const first = members[0];
    const real = members.filter(
      (m) => m.end_date != null && daysBetween(m.start_date as string, m.end_date) <= 4,
    );
    const dated = real.length > 0 ? real : members;
    const starts = dated.map((m) => m.start_date as string).sort();
    const ends = dated.map((m) => m.end_date ?? (m.start_date as string)).sort();
    const allStarts = members.map((m) => m.start_date as string).sort();
    return {
      ...seriesStageCard({
        season: first.season,
        stage: first.series_stage as UsauSeriesStage,
        level: SERIES_TIER_LEVEL[first.series_tier as string] as UsauLevel,
        startDate: starts[0],
        endDate: ends[ends.length - 1],
        groupCount: new Set(members.map((m) => m.series_group_key)).size,
      }),
      memberIds: members.map((m) => m.id),
      lastStart: allStarts[allStarts.length - 1],
    };
  });
}

function toStageCard(s: SeriesStageAgg): UsauSeriesStageCard {
  return {
    id: s.id,
    season: s.season,
    stage: s.stage,
    level: s.level,
    name: s.name,
    startDate: s.startDate,
    endDate: s.endDate,
    groupCount: s.groupCount,
  };
}

/** Series stages built from member rows whose start falls in the given
 *  window / season. One indexed read on the partial series index. */
async function fetchSeriesStages(
  db: DB,
  opts: { season?: number; startFrom?: string; startTo?: string; levels?: readonly string[] },
): Promise<SeriesStageAgg[]> {
  let q = db
    .from('usau_events')
    .select('id, season, start_date, end_date, series_stage, series_tier, series_group_key')
    .not('series_stage', 'is', null)
    .not('start_date', 'is', null);
  if (opts.season != null) q = q.eq('season', opts.season);
  if (opts.startFrom) q = q.gte('start_date', opts.startFrom);
  if (opts.startTo) q = q.lte('start_date', opts.startTo);
  if (opts.levels) q = q.in('series_tier', seriesTiersFor(opts.levels));
  const { data, error } = await q;
  if (error) throw error;
  return aggregateSeriesStages((data ?? []) as unknown as SeriesMemberRow[]);
}

/** Series stages whose members start in [startFrom, startTo] — the home
 *  "Recent results" stage rows. */
export async function listSeriesStages(opts: {
  startFrom: string;
  startTo: string;
  levels?: UsauLevel[];
}): Promise<UsauSeriesStageCard[]> {
  const db = await supabase();
  return (await fetchSeriesStages(db, opts)).map(toStageCard);
}

/** Slot each stage card at the head of its weekend — the weekend of its FIRST
 *  day (Hunter: a sectionals spanning two weekends dates from its earliest
 *  start), mirroring the feed view's sort_date + kind_rank. */
function withSeriesStages(
  events: UsauMajorWithChampions[],
  stages: UsauSeriesStageCard[],
): UsauFeedCard[] {
  const out: UsauFeedCard[] = events.map((e) => ({ kind: 'event' as const, ...e }));
  const newestFirst = [...stages].sort((a, b) =>
    weekendKey(b.startDate).localeCompare(weekendKey(a.startDate)),
  );
  for (const stage of newestFirst) {
    const wk = weekendKey(stage.startDate);
    const at = out.findIndex((c) => c.kind === 'event' && weekendKey(c.endDate) <= wk);
    out.splice(at === -1 ? out.length : at, 0, { kind: 'series' as const, ...stage });
  }
  return out;
}

export interface UsauSeriesDivisionResult {
  division: 'Men' | 'Women' | 'Mixed' | null;
  teamCount: number;
  startDate: string | null;
  endDate: string | null;
  champion: { teamName: string; teamId: string; viaPoolRecord?: boolean } | null;
  /** The championship final was cancelled with no champion (washout). */
  cancelled: boolean;
}

export interface UsauSeriesEventResult {
  /** series_group_key — the merged event's URL slug. */
  slug: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  /** Only when every division agrees (Capital's divisions play at two sites). */
  city: string | null;
  state: string | null;
  divisions: UsauSeriesDivisionResult[];
}

export interface UsauSeriesStageEvents {
  stage: UsauSeriesStageCard;
  events: UsauSeriesEventResult[];
}

/**
 * Every merged tournament in one series stage (a season's sectionals, one
 * level's regionals), each with its divisions' champion / pool leader /
 * cancelled final / team count. Backs the ?series= list on Scores and Schedule.
 * Bounded: one events read (~100 members), paged team counts, and champion
 * reads only over members that have started.
 */
export async function listSeriesStageEvents(
  today: string,
  season: number,
  stage: UsauSeriesStage,
  level: UsauLevel,
): Promise<UsauSeriesStageEvents | null> {
  const db = await supabase();
  const { data, error } = await db
    .from('usau_events')
    .select(EVENT_COLUMNS)
    .eq('series_stage', stage)
    .eq('season', season)
    .in('series_tier', seriesTiersFor([level]))
    .not('start_date', 'is', null);
  if (error) throw error;
  const rows = (data ?? []) as unknown as UsauEventRow[];
  if (rows.length === 0) return null;
  const ids = rows.map((r) => r.id);

  // Team counts per member, paged past the 1000-row cap (2026 sectionals
  // alone field ~540 entries).
  const teamCounts = new Map<string, number>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: page, error: teamsError } = await db
      .from('usau_event_teams')
      .select('event_id, team_id')
      .in('event_id', ids)
      .order('event_id', { ascending: true })
      .order('team_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (teamsError) throw teamsError;
    const pageRows = page ?? [];
    for (const r of pageRows) teamCounts.set(r.event_id, (teamCounts.get(r.event_id) ?? 0) + 1);
    if (pageRows.length < PAGE) break;
  }

  const divisionOf = new Map<string, 'Men' | 'Women' | 'Mixed'>();
  for (const r of rows) {
    const d = r.series_division;
    if (d === 'Men' || d === 'Women' || d === 'Mixed') divisionOf.set(r.id, d);
  }
  const started = rows.filter((r) => (r.start_date ?? '') <= today);
  const { championsByEvent, cancelledKeys } = await championsForEvents(
    db,
    started.map((r) => ({ id: r.id, endDate: r.end_date })),
    today,
    divisionOf,
  );

  const groups = new Map<string, UsauEventRow[]>();
  for (const r of rows) {
    const key = r.series_group_key as string;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const events: UsauSeriesEventResult[] = [...groups.entries()].map(([key, members]) => {
    const sorted = sortSeriesMembers(members);
    const divisions: UsauSeriesDivisionResult[] = [];
    for (const m of sorted) {
      const champs = championsByEvent.get(m.id) ?? [];
      const base = { teamCount: teamCounts.get(m.id) ?? 0, startDate: m.start_date, endDate: m.end_date };
      const pinned = divisionOf.get(m.id) ?? null;
      if (pinned || champs.length === 0) {
        const c = champs[0];
        divisions.push({
          ...base,
          division: pinned,
          champion: c ? { teamName: c.teamName, teamId: c.teamId, viaPoolRecord: c.viaPoolRecord } : null,
          cancelled: !c && pinned != null && cancelledKeys.has(`${m.id}|${pinned}`),
        });
      } else {
        // A gender-less member (2014's combined sectionals) crowns one team per division.
        for (const c of champs) {
          divisions.push({
            ...base,
            division: c.division,
            champion: { teamName: c.teamName, teamId: c.teamId, viaPoolRecord: c.viaPoolRecord },
            cancelled: false,
          });
        }
      }
    }
    const starts = sorted.map((m) => m.start_date).filter((d): d is string => !!d).sort();
    const ends = sorted.map((m) => m.end_date).filter((d): d is string => !!d).sort();
    return {
      slug: key,
      name: sorted[0].series_group_name ?? sorted[0].name,
      startDate: starts[0] ?? null,
      endDate: ends[ends.length - 1] ?? null,
      city: agreedValue(sorted, (r) => r.city),
      state: agreedValue(sorted, (r) => r.state),
      divisions,
    };
  });
  events.sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? '') || a.name.localeCompare(b.name));

  return { stage: toStageCard(aggregateSeriesStages(rows)[0]), events };
}

/**
 * The projected Club Nationals field for a season: per division, each
 * region's bids and the Regionals finishers holding them (pure logic in
 * ./nationals-field, mirrored verbatim from mobile). Null until the season has
 * club-regionals rows and a rankings snapshot before them. (Ported from the
 * mobile repo's src/lib/usau/data.ts getNationalsField.)
 *
 * Bids come from USA Ultimate's Final Regular Season Rankings, published just
 * before Sectionals: per division, the latest usau_rankings week scraped (UTC
 * date) strictly before the first Regional starts. Earlier weeks predate the
 * final rankings and later ones reflect the series (2026: weeks 36 and 40
 * both misallocate); week 39, scraped 05:00 UTC on Regionals' first day, is
 * kept out by the strict cutoff. Until the final rankings are out this is
 * just the latest week, so bids read that early are provisional.
 */
export async function getNationalsField(season: number): Promise<NationalsField | null> {
  const db = await supabase();
  const { data, error } = await db
    .from('usau_events')
    .select('id, start_date, end_date, series_division, series_group_name, series_group_key')
    .eq('season', season)
    .eq('series_stage', 'club-regionals')
    .in('series_division', [...NATIONALS_DIVISIONS]);
  if (error) throw error;
  const events = (data ?? []) as unknown as Array<
    NationalsRegionalEventRow & { start_date: string | null; end_date: string | null }
  >;
  const cutoff = events
    .map((e) => e.start_date)
    .filter((d): d is string => !!d)
    .sort()[0];
  if (!cutoff) return null;

  const snapshots: NationalsRankingSnapshot[] = [];
  await Promise.all(
    NATIONALS_DIVISIONS.map(async (division) => {
      const { data: head, error: headError } = await db
        .from('usau_rankings')
        .select('week')
        .eq('division', `Club-${division}`)
        .eq('season', season)
        .lt('scraped_at', `${cutoff}T00:00:00Z`)
        .order('week', { ascending: false })
        .limit(1);
      if (headError) throw headError;
      const week = head?.[0]?.week;
      if (week == null) return;
      // One division-week is ~200 rows, far under the 1000-row cap.
      const { data: rows, error: rowsError } = await db
        .from('usau_rankings')
        .select('rank, region, team_name')
        .eq('division', `Club-${division}`)
        .eq('season', season)
        .eq('week', week)
        .order('rank', { ascending: true });
      if (rowsError) throw rowsError;
      snapshots.push({ division, week, rows: rows ?? [] });
    }),
  );
  if (snapshots.length === 0) return null;

  // Placed entrants only, paged past the 1000-row cap.
  const ids = events.map((e) => e.id);
  const entrants: NationalsEntrantRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: page, error: teamsError } = await db
      .from('usau_event_teams')
      .select('event_id, team_id, final_placement, usau_teams(name)')
      .in('event_id', ids)
      .not('final_placement', 'is', null)
      .order('event_id', { ascending: true })
      .order('team_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (teamsError) throw teamsError;
    const pageRows = (page ?? []) as unknown as NationalsEntrantRow[];
    entrants.push(...pageRows);
    if (pageRows.length < PAGE) break;
  }

  // final_placement misses a champion whose title bracket names no place
  // (2026 North Central Women's "Bracket play"), so those come off the final.
  // Only Regionals still without a 1st: championsForEvents' pool-record
  // fallback would otherwise read every ended Regional's pool games.
  const hasFirst = new Set(entrants.filter((t) => t.final_placement === 1).map((t) => t.event_id));
  const unplaced = events.filter((e) => !hasFirst.has(e.id));
  const { championsByEvent } = await championsForEvents(
    db,
    unplaced.map((e) => ({ id: e.id, endDate: e.end_date })),
    usauToday(),
    new Map(unplaced.map((e) => [e.id, e.series_division as NationalsDivision])),
  );

  return buildNationalsField({ season, snapshots, events, entrants, champions: championsByEvent });
}

export type UsauScheduleItem =
  | { kind: 'event'; event: UsauEventCard }
  | { kind: 'series'; series: UsauSeriesStageCard };

export interface UsauScheduleUpcoming {
  items: UsauScheduleItem[];
  /** Something at this level already started this season — drives the
   *  "View completed tournaments" link out to /scores. */
  hasPrior: boolean;
}

/**
 * The future-facing USAU calendar for /schedule: this season's events that
 * haven't started yet, soonest first, with each series stage as ONE card that
 * stays until its last member tournament has started. Runs server-side so the
 * Eastern `today` decides "upcoming" (the client compared against the UTC
 * date, hiding next-day events every evening after 8pm ET), and team counts
 * page past the 1000-row cap (an unpaged read truncated 2026 Club's 1,879
 * entries).
 */
export async function listUsauScheduleUpcoming(
  today: string,
  season: number,
  level: CompetitionLevel,
  flights: Flight[] = [],
): Promise<UsauScheduleUpcoming> {
  const db = await supabase();
  const levels = isMastersFamily(level) ? MASTERS_FAMILY : [level];

  const [{ data, error }, stages, { count: priorCount, error: priorError }] = await Promise.all([
    db
      .from('usau_events')
      .select('id, usau_slug, name, season, start_date, end_date, city, state, competition_level, url')
      .eq('season', season)
      .in('competition_level', levels)
      .is('series_stage', null)
      .or(`start_date.gt.${today},start_date.is.null`)
      .order('start_date', { ascending: true, nullsFirst: false })
      .order('name', { ascending: true }),
    // Flights are a TCT concept; the series has none, so a flight filter hides stages.
    flights.length > 0 ? Promise.resolve([]) : fetchSeriesStages(db, { season, levels: [level] }),
    db
      .from('usau_events')
      .select('id', { count: 'exact', head: true })
      .eq('season', season)
      .in('competition_level', levels)
      .lte('start_date', today),
  ]);
  if (error) throw error;
  if (priorError) throw priorError;
  let events = data ?? [];

  // Masters family: a combined championship is ONE row tagged with a sibling
  // level (see MASTERS_FAMILY) — keep it only when it fields this level.
  if (isMastersFamily(level)) {
    const siblingIds = events.filter((e) => e.competition_level !== level).map((e) => e.id);
    const fielding = await eventIdsWithTeamLevel(db, level, siblingIds);
    events = events.filter((e) => e.competition_level === level || fielding.has(e.id));
  }
  if (flights.length > 0) {
    const flightSet = new Set(flights);
    events = events.filter((e) => {
      const f = flightForName(e.name);
      return f != null && flightSet.has(f);
    });
  }

  const teamCounts = new Map<string, number>();
  const ids = events.map((e) => e.id);
  const PAGE = 1000;
  for (let from = 0; ids.length > 0; from += PAGE) {
    const { data: page, error: teamsError } = await db
      .from('usau_event_teams')
      .select('event_id, team_id')
      .in('event_id', ids)
      .order('event_id', { ascending: true })
      .order('team_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (teamsError) throw teamsError;
    const pageRows = page ?? [];
    for (const r of pageRows) teamCounts.set(r.event_id, (teamCounts.get(r.event_id) ?? 0) + 1);
    if (pageRows.length < PAGE) break;
  }

  const items: UsauScheduleItem[] = [
    ...stages
      .filter((s) => s.lastStart > today)
      .map((s) => ({ kind: 'series' as const, series: toStageCard(s) })),
    ...events.map((e) => ({
      kind: 'event' as const,
      event: {
        id: e.id,
        slug: e.usau_slug,
        name: e.name,
        season: e.season,
        startDate: e.start_date,
        endDate: e.end_date,
        city: e.city,
        state: e.state,
        competitionLevel: e.competition_level,
        teamCount: teamCounts.get(e.id) ?? 0,
        url: e.url ?? null,
        flight: flightForName(e.name),
        winner: null,
      },
    })),
  ];
  // Soonest first, undated last; a stage leads its first day.
  const dateOf = (i: UsauScheduleItem) =>
    (i.kind === 'series' ? i.series.startDate : i.event.startDate) ?? '9999-12-31';
  items.sort(
    (a, b) =>
      dateOf(a).localeCompare(dateOf(b)) ||
      (a.kind === 'series' ? 0 : 1) - (b.kind === 'series' ? 0 : 1),
  );
  return { items, hasPrior: (priorCount ?? 0) > 0 };
}

/**
 * Resolve an event slug in ONE query. A slug is either a real usau_slug (an
 * ordinary event or one division's series row) or a merged group's
 * series_group_key — keys never collide with a usau_slug (checked across
 * every row when the migration shipped). Case-INSENSITIVE on usau_slug: the
 * HTML pipeline stored some mixed-case slugs that a later ultirzr re-ingest
 * lowercases, and old links must keep resolving.
 */
export async function resolveUsauEvent(slug: string): Promise<ResolvedUsauEvent | null> {
  const db = await supabase();
  const key = slug.toLowerCase();
  let rows: UsauEventRow[];
  if (/^[A-Za-z0-9-]+$/.test(slug)) {
    // Plain slug: safe inside PostgREST's or() syntax, and has no LIKE
    // metacharacters, so ilike is an exact case-insensitive match.
    const { data, error } = await db
      .from('usau_events')
      .select(EVENT_COLUMNS)
      .or(`usau_slug.ilike.${slug},series_group_key.eq.${key}`);
    if (error) throw error;
    rows = (data ?? []) as unknown as UsauEventRow[];
  } else {
    // Anything else can only be a real usau_slug (keys are [a-z0-9-]).
    const slugPattern = slug.replace(/[%_\\]/g, (c) => `\\${c}`);
    const { data, error } = await db
      .from('usau_events')
      .select(EVENT_COLUMNS)
      .ilike('usau_slug', slugPattern)
      .maybeSingle();
    if (error) throw error;
    rows = data ? [data as unknown as UsauEventRow] : [];
  }
  // Group first: if a USAU slug ever equals its own group key (a name with no
  // gender word), resolving it as a member would redirect to itself forever.
  const group = rows.filter((r) => r.series_group_key === key);
  if (group.length > 0) return { kind: 'group', rows: sortSeriesMembers(group) };
  const direct = rows.find((r) => r.usau_slug.toLowerCase() === key);
  if (!direct) return null;
  return direct.series_group_key ? { kind: 'member', row: direct } : { kind: 'event', row: direct };
}

/** The one value every member agrees on (nulls and "TBD" ignored), else null. */
function agreedValue(rows: UsauEventRow[], pick: (r: UsauEventRow) => string | null): string | null {
  const vals = new Set(rows.map(pick).filter((v): v is string => !!v && v !== 'TBD'));
  return vals.size === 1 ? [...vals][0] : null;
}

/**
 * Load teams + games for a resolved slug. A series member is expanded to its
 * whole group (one extra indexed query) so non-page callers — starred items,
 * For You, the home hero — always get the merged event.
 */
export async function loadUsauEvent(resolved: ResolvedUsauEvent): Promise<UsauEventSummary> {
  const db = await supabase();
  let rows: UsauEventRow[];
  if (resolved.kind === 'group') {
    rows = resolved.rows;
  } else if (resolved.kind === 'member') {
    const { data, error } = await db
      .from('usau_events')
      .select(EVENT_COLUMNS)
      .eq('series_group_key', resolved.row.series_group_key as string);
    if (error) throw error;
    const siblings = (data ?? []) as unknown as UsauEventRow[];
    rows = siblings.length > 0 ? sortSeriesMembers(siblings) : [resolved.row];
  } else {
    rows = [resolved.row];
  }
  const isSeries = resolved.kind !== 'event';
  // Division tags need every member to carry one; 2014 combined sectionals and
  // gender-less GGM regionals keep the classic team-derived path.
  const merged = isSeries && rows.every((r) => r.series_division != null);
  const ids = rows.map((r) => r.id);
  const divisionOf = new Map(rows.map((r) => [r.id, merged ? r.series_division : null]));

  // Entrants + games, paged in primary-key order past PostgREST's 1000-row cap
  // (a big event or merged series can exceed it, and the cap truncates
  // silently). Errors still degrade to an empty page, as the unpaged reads did.
  type PartRow = {
    event_id: string;
    team_id: string;
    seed: number | null;
    pool: string | null;
    final_placement: number | null;
    usau_teams: { name: string; gender_division: string | null; competition_level: string | null } | null;
  };
  type GameRow = {
    id: string;
    event_id: string;
    round: string;
    bracket_name: string | null;
    team_a_id: string | null;
    team_b_id: string | null;
    seed_a: number | null;
    seed_b: number | null;
    score_a: number | null;
    score_b: number | null;
    winner_team_id: string | null;
    location: string | null;
    scheduled_at: string | null;
    status: string;
    usau_game_id: string | null;
    usau_event_game_id: string | null;
    team_a_placeholder: string | null;
    team_b_placeholder: string | null;
    bracket_stage: string | null;
    bracket_stage_index: number | null;
    bracket_slot: number | null;
    next_usau_game_id: string | null;
    next_slot_side: string | null;
    source_url: string | null;
    team_a: { name: string } | null;
    team_b: { name: string } | null;
  };
  const [partRows, gameRows] = await Promise.all([
    (async () => {
      const out: PartRow[] = [];
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data: page } = await db
          .from('usau_event_teams')
          .select('event_id, team_id, seed, pool, final_placement, usau_teams(name, gender_division, competition_level)')
          .in('event_id', ids)
          .order('event_id', { ascending: true })
          .order('team_id', { ascending: true })
          .range(from, from + PAGE - 1);
        const rows = (page ?? []) as unknown as PartRow[];
        out.push(...rows);
        if (rows.length < PAGE) break;
      }
      return out;
    })(),
    (async () => {
      const out: GameRow[] = [];
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data: page } = await db
          .from('usau_games')
          .select(
            // usau_games has two FKs to usau_teams (team_a + team_b), so we
            // hint PostgREST with the !<columnName> syntax to disambiguate.
            `id, event_id, round, bracket_name, team_a_id, team_b_id,
             seed_a, seed_b, score_a, score_b, winner_team_id, location, scheduled_at, status,
             usau_game_id, usau_event_game_id, team_a_placeholder, team_b_placeholder,
             bracket_stage, bracket_stage_index, bracket_slot, next_usau_game_id, next_slot_side, source_url,
             team_a:usau_teams!team_a_id(name),
             team_b:usau_teams!team_b_id(name)`,
          )
          .in('event_id', ids)
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1);
        const rows = (page ?? []) as unknown as GameRow[];
        out.push(...rows);
        if (rows.length < PAGE) break;
      }
      return out;
    })(),
  ]);

  // Per-player goals/assists — published for flagship events only, so this is
  // usually empty. Paged (primary-key order) the same way every other
  // multi-hundred-row USAU read in this file is, since a Nationals field
  // alone is ~1,300 rows — past PostgREST's 1000-row cap.
  type StatRow = {
    player_id: string;
    team_id: string | null;
    goals: number | null;
    assists: number | null;
    usau_players: { display_name: string | null } | null;
  };
  const statRows: StatRow[] = [];
  {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: page, error: statsError } = await db
        .from('usau_player_event_stats')
        .select('player_id, team_id, goals, assists, usau_players(display_name)')
        .in('event_id', ids)
        // Full PK order: a merged series spans several events, and one player
        // can hold a row in more than one — player_id alone can tie across a
        // page boundary and skip/duplicate rows.
        .order('player_id', { ascending: true })
        .order('event_id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (statsError) throw statsError;
      const chunk = (page ?? []) as unknown as StatRow[];
      statRows.push(...chunk);
      if (chunk.length < PAGE) break;
    }
  }
  const playerStats = statRows
    .filter((r) => r.usau_players?.display_name)
    .map((r) => ({
      playerId: r.player_id,
      playerName: r.usau_players!.display_name!,
      teamId: r.team_id,
      goals: r.goals ?? 0,
      assists: r.assists ?? 0,
    }));

  const teams = partRows.map((p) => {
    const t = (p as { usau_teams: { name: string; gender_division: string | null; competition_level: string | null } | null }).usau_teams;
    return {
      teamId: p.team_id,
      teamName: t?.name ?? 'Unknown',
      seed: p.seed,
      pool: p.pool,
      finalPlacement: p.final_placement,
      // A merged member row is single-division by construction; its division
      // beats the team's own tag (42 series teams have none, 3 contradict).
      genderDivision: divisionOf.get(p.event_id) ?? t?.gender_division ?? null,
      competitionLevel: t?.competition_level ?? null,
    };
  });

  // Cleanup passes run PER member: siblings can play at different sites
  // (field + time is not unique across them) and reuse bracket names.
  const rawByEvent = new Map<string, EventGameRow[]>();
  for (const g of gameRows) {
    const ta = (g as { team_a: { name: string } | null }).team_a;
    const tb = (g as { team_b: { name: string } | null }).team_b;
    const list = rawByEvent.get(g.event_id) ?? [];
    list.push({
      id: g.id,
      round: g.round,
      bracketName: g.bracket_name,
      teamAId: g.team_a_id,
      teamAName: ta?.name ?? null,
      teamBId: g.team_b_id,
      teamBName: tb?.name ?? null,
      seedA: g.seed_a,
      seedB: g.seed_b,
      scoreA: g.score_a,
      scoreB: g.score_b,
      winnerTeamId: g.winner_team_id ?? null,
      location: g.location,
      scheduledAt: g.scheduled_at,
      status: g.status,
      usauGameOrder: parseUsauGameOrder(g.usau_game_id, g.usau_event_game_id),
      teamAPlaceholder: g.team_a_placeholder ?? null,
      teamBPlaceholder: g.team_b_placeholder ?? null,
      bracketStage: g.bracket_stage ?? null,
      bracketStageIndex: g.bracket_stage_index ?? null,
      bracketSlot: g.bracket_slot ?? null,
      nextUsauGameId: g.next_usau_game_id ?? null,
      nextSlotSide: g.next_slot_side === 'top' || g.next_slot_side === 'btm' ? g.next_slot_side : null,
      usauGameId: g.usau_game_id ?? null,
      division: divisionOf.get(g.event_id) ?? null,
      scheduleDivision: scheduleDivisionOf(g.source_url),
    });
    rawByEvent.set(g.event_id, list);
  }
  const games = rows.flatMap((r) => dropUnfedUpstreamRounds(dropSupersededGames(rawByEvent.get(r.id) ?? [])));

  const anchor = rows[0];
  if (!isSeries) {
    return {
      id: anchor.id,
      slug: anchor.usau_slug,
      name: anchor.name,
      season: anchor.season,
      startDate: anchor.start_date,
      endDate: anchor.end_date,
      city: anchor.city,
      state: anchor.state,
      venueTz: anchor.venue_tz ?? null,
      venue: anchor.venue ?? null,
      competitionLevel: anchor.competition_level,
      url: anchor.url ?? null,
      flight: flightForName(anchor.name),
      members: [],
      series: null,
      playerStats,
      teams,
      games,
    };
  }

  const starts = rows.map((r) => r.start_date).filter((d): d is string => !!d).sort();
  const ends = rows.map((r) => r.end_date).filter((d): d is string => !!d).sort();
  const groupName = anchor.series_group_name ?? anchor.name;
  const tier = anchor.series_tier ?? 'club';
  const level = SERIES_TIER_LEVEL[tier] ?? anchor.competition_level;
  return {
    id: anchor.id,
    slug: anchor.series_group_key as string,
    name: groupName,
    season: anchor.season,
    startDate: starts[0] ?? null,
    endDate: ends[ends.length - 1] ?? null,
    city: agreedValue(rows, (r) => r.city),
    state: agreedValue(rows, (r) => r.state),
    venueTz: rows.map((r) => r.venue_tz).find((v) => !!v) ?? null,
    venue: agreedValue(rows, (r) => r.venue),
    competitionLevel: level,
    // No single USAU page exists for a merged event; each member keeps its own.
    url: null,
    flight: flightForName(groupName),
    members: rows.map((r) => ({
      id: r.id,
      slug: r.usau_slug,
      name: r.name,
      url: r.url ?? null,
      division: (r.series_division as UsauEventMember['division']) ?? null,
      startDate: r.start_date,
      endDate: r.end_date,
      city: r.city,
      state: r.state,
      venue: r.venue ?? null,
      venueTz: r.venue_tz ?? null,
    })),
    series: {
      season: anchor.season,
      stage: anchor.series_stage as string,
      tier,
      level,
      groupKey: anchor.series_group_key as string,
    },
    playerStats,
    teams,
    games,
  };
}

/** Event by slug — an ordinary event, a merged series group, or a series
 *  member (returned as its merged group). */
export async function getEvent(slug: string): Promise<UsauEventSummary | null> {
  const resolved = await resolveUsauEvent(slug);
  return resolved ? loadUsauEvent(resolved) : null;
}

/** Quick test: is this id a USAU UUID (vs a UFA player slug like "cdykes")? */
export function looksLikeUsauUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

// ─── Ranked team lists ─────────────────────────────────────────────────

// ─── Official USAU rankings (scraped weekly) ──────────────────────────────
// USAU publishes an official weekly power-rating Top-20 per division. We
// scrape it into usau_rankings (see sync-usau-rankings Edge Function) and read
// the latest week here. Only these 5 RankSets are published (no D-III / Masters
// on the rankings page), so listOfficialUsauRankings supports exactly them.

export interface OfficialRankedTeam {
  /** usau_teams.id — links to the team profile / logo. Null when the ranked
   *  team couldn't be confidently matched to a usau_teams row (we still show
   *  the team by name; there's just no profile link/logo). */
  id: string | null;
  name: string;
  state: string | null;
  region: string | null;
  rank: number;
  rating: number | null;
  wins: number | null;
  losses: number | null;
}

/** RankSet keys used by usau_rankings.division + the scraper. */
type OfficialRankDivision =
  | 'Club-Men'
  | 'Club-Women'
  | 'Club-Mixed'
  | 'College-Men'
  | 'College-Women';

/** Every published RankSet — the 5 above. Read at call time (not module-eval
 *  time) by bestOfficialRankByEvent, which is defined earlier in the file. */
const OFFICIAL_RANK_DIVISIONS: OfficialRankDivision[] = [
  'Club-Men',
  'Club-Women',
  'Club-Mixed',
  'College-Men',
  'College-Women',
];

/** Map a (competitionLevel, genderDivision) to its published RankSet, or null
 *  if USAU doesn't publish rankings for that combination (D-III, Masters, etc.). */
export function officialRankSetFor(
  competitionLevel: string | null | undefined,
  genderDivision: string | null | undefined,
): OfficialRankDivision | null {
  const g = genderDivision;
  if (competitionLevel === 'CLUB') {
    if (g === 'Men') return 'Club-Men';
    if (g === 'Women') return 'Club-Women';
    if (g === 'Mixed') return 'Club-Mixed';
  }
  if (competitionLevel === 'COLLEGE_D1') {
    if (g === 'Men') return 'College-Men';
    if (g === 'Women') return 'College-Women';
  }
  return null;
}

/**
 * The latest official USAU ranking for one division, top N (default 16),
 * joined to usau_teams. Reads the most-recent (season, week) present in
 * usau_rankings for that RankSet. Returns an empty array when we haven't
 * scraped that division yet (so callers can fall back to seed-ordering).
 */
export async function listOfficialUsauRankings(
  division: OfficialRankDivision,
  limit = 16,
): Promise<{ season: number; week: number; scrapedAt: string | null; teams: OfficialRankedTeam[] }> {
  const db = await supabase();

  // Find the latest (season, week) we have for this division.
  const { data: latest } = await db
    .from('usau_rankings')
    .select('season, week')
    .eq('division', division)
    .order('season', { ascending: false })
    .order('week', { ascending: false })
    .limit(1);
  const head = (latest ?? [])[0] as { season: number; week: number } | undefined;
  if (!head) return { season: 0, week: 0, scrapedAt: null, teams: [] };

  // Read the ranking's own stored identity (team_name/state), plus the OPTIONAL
  // team_id link when we matched one. We no longer inner-join usau_teams (that
  // silently dropped unmatched teams and left holes in the rank sequence).
  const { data, error } = await db
    .from('usau_rankings')
    .select('rank, rating, wins, losses, region, scraped_at, team_id, team_name, state')
    .eq('division', division)
    .eq('season', head.season)
    .eq('week', head.week)
    .order('rank', { ascending: true })
    .limit(limit);
  if (error) throw error;

  type Row = {
    rank: number;
    rating: number | null;
    wins: number | null;
    losses: number | null;
    region: string | null;
    scraped_at: string | null;
    team_id: string | null;
    team_name: string;
    state: string | null;
  };
  const rows = (data ?? []) as unknown as Row[];
  const teams: OfficialRankedTeam[] = rows.map((r) => ({
    id: r.team_id,
    name: r.team_name,
    state: r.state,
    region: r.region,
    rank: r.rank,
    rating: r.rating,
    wins: r.wins,
    losses: r.losses,
  }));

  return {
    season: head.season,
    week: head.week,
    scrapedAt: rows[0]?.scraped_at ?? null,
    teams,
  };
}

export interface RankedTeam {
  id: string;
  name: string;
  state: string | null;
  competitionLevel: string | null;
  genderDivision: string | null;
  /** Most-recent Nationals placement (1 = champion). null if they didn't
   *  make Nationals that year, in which case we fall back to best
   *  Regionals placement (also nullable). */
  nationalsPlacement: number | null;
  bestRegionalsPlacement: number | null;
  /** The season we used to rank them. */
  season: number;
  /** Slug of the Nationals (or, if absent, Regional) event used. Lets the
   *  UI link back to the event that produced the rank. */
  rankedFromSlug: string | null;
}

/**
 * Teams ranked by their finish at last season's Nationals.
 * Top 16 (or however many made Nationals that year) come first, in
 * placement order. Below them: teams that played that season but didn't
 * make Nationals, ranked by best Regionals placement.
 *
 * @param genderDivision optional filter (e.g. 'Men' for Club Open). When
 *   omitted, returns everything.
 * @param season the season to rank by. Defaults to the most recent season
 *   that has a Nationals event with placement data.
 */
type RankableLevel =
  | 'CLUB'
  | 'COLLEGE_D1'
  | 'COLLEGE_D3'
  | 'MASTERS'
  | 'GRAND_MASTERS'
  | 'GREAT_GRAND_MASTERS';

// Per-level ILIKE patterns identifying a level's Nationals/Championship event,
// so College's "Championships" doesn't collide with Club's "Nationals".
const CHAMPIONSHIP_NAME_LIKE: Record<RankableLevel, string> = {
  CLUB: '%Nationals%',
  COLLEGE_D1: '%D-I College Championship%',
  COLLEGE_D3: '%D-III College Championship%',
  MASTERS: '%Masters Championship%',
  GRAND_MASTERS: '%Grand Masters Championship%',
  // GGM plays inside the SAME combined "USA Ultimate Masters Championships"
  // event as Masters/GM (there is no separately-named GGM championship), so it
  // matches on the shared event name; the team-level filter below isolates the
  // GGM teams within it.
  GREAT_GRAND_MASTERS: '%Masters Championship%',
};
function championshipNameLikeFor(level: RankableLevel): string {
  return CHAMPIONSHIP_NAME_LIKE[level];
}

/**
 * Fraction of the previous completed season's competing-team count that the
 * IN-PROGRESS season must reach (teams that have played ≥1 game) before we
 * start ranking by the current season instead of the last completed Nationals.
 *
 * Rationale: a single early-season tournament (e.g. one "Tune Up" with 8 teams)
 * isn't enough to rank the whole field. USAU's full field isn't even known
 * until Sectionals. Using the prior season's total team count as a stable,
 * known denominator, we wait until ~80% of that many distinct teams have
 * actually played this season — which naturally trips around Sectionals when
 * the bulk of the field registers and plays.
 *
 * NOTE / FUTURE WORK — USAU RANKING ALGORITHM:
 * Once we cross this threshold we currently still order by entry seed (see the
 * banner in usau-teams-ranked.tsx). The REAL goal is to implement USAU's
 * official ranking algorithm (the rating-based system that weights each game's
 * result by opponent strength and score differential, iterated to convergence)
 * to produce true in-season rankings from game results. When that lands it
 * replaces the seed-ordering AND can supersede this crude threshold with a
 * proper "enough connected results to rate" check. See vault: "USAU rating
 * algorithm formula" in the data-sources memory.
 */
const CURRENT_SEASON_RANK_THRESHOLD = 0.8;

/**
 * Pick the season to rank for a level:
 *   1. If the IN-PROGRESS season (the newest season with ANY events) has had
 *      ≥ CURRENT_SEASON_RANK_THRESHOLD × (prior season's competing-team count)
 *      distinct teams play at least one game, use the in-progress season.
 *   2. Otherwise fall back to the most recent season whose Nationals event has
 *      actually been PLAYED (has participating teams). We can't just take
 *      MAX(season) of Nationals events — USAU schedules next season's Nationals
 *      far in advance, so a future, unplayed event row (0 teams) would win and
 *      render the page empty.
 * Returns null if nothing qualifies.
 */
async function resolveRankableSeason(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  compLevel: RankableLevel,
): Promise<number | null> {
  // Distinct teams that have played ≥1 event in a given (season, level).
  const teamsPlayedInSeason = async (s: number): Promise<number> => {
    const { data } = await db
      .from('usau_event_teams')
      .select('team_id, usau_events!inner(season, competition_level)')
      .eq('usau_events.season', s)
      .eq('usau_events.competition_level', compLevel);
    const ids = new Set<string>();
    for (const r of (data ?? []) as Array<{ team_id: string }>) ids.add(r.team_id);
    return ids.size;
  };

  // Most recent season that has a PLAYED Nationals event (the safe fallback).
  const { data: natsEvents } = await db
    .from('usau_events')
    .select('id, season')
    .eq('competition_level', compLevel)
    .ilike('name', championshipNameLikeFor(compLevel))
    .order('season', { ascending: false })
    .limit(12);

  let completedNatsSeason: number | null = null;
  for (const ev of (natsEvents ?? []) as Array<{ id: string; season: number }>) {
    const { count } = await db
      .from('usau_event_teams')
      .select('team_id', { count: 'exact', head: true })
      .eq('event_id', ev.id);
    if ((count ?? 0) > 0) {
      completedNatsSeason = ev.season;
      break;
    }
  }

  // Newest season with any events at all (the in-progress season, if later).
  const { data: newestEvent } = await db
    .from('usau_events')
    .select('season')
    .eq('competition_level', compLevel)
    .order('season', { ascending: false })
    .limit(1);
  const newestSeason: number | null = newestEvent?.[0]?.season ?? null;

  // If there's a season newer than the last completed Nationals, test the 80%
  // threshold against the prior (completed) season's team count.
  if (
    newestSeason != null &&
    completedNatsSeason != null &&
    newestSeason > completedNatsSeason
  ) {
    const denom = await teamsPlayedInSeason(completedNatsSeason);
    const played = await teamsPlayedInSeason(newestSeason);
    if (denom > 0 && played >= denom * CURRENT_SEASON_RANK_THRESHOLD) {
      return newestSeason;
    }
  }

  // Fall back to the last completed Nationals season (or newest as last resort).
  return completedNatsSeason ?? newestSeason;
}

export async function listRankedTeams(opts?: {
  genderDivision?: 'Men' | 'Women' | 'Mixed';
  competitionLevel?: RankableLevel;
  season?: number;
}): Promise<{ season: number; teams: RankedTeam[] }> {
  const db = await supabase();
  const compLevel: RankableLevel = opts?.competitionLevel ?? 'CLUB';

  // For College championships USAU uses event-name patterns like
  // "D-I College Championships" / "D-III College Championships". The
  // Club Nationals events match a different phrase ("USA Ultimate Club
  // Nationals"). We use a level-specific regex so we don't accidentally
  // pick a different level's event when finding "the most recent
  // Nationals season" for this filter.
  const championshipNameLike = CHAMPIONSHIP_NAME_LIKE;
  // Regionals naming varies the same way: Club regions are named
  // "Mid-Atlantic Regional Championship"; College has "D-I College
  // Regionals", "D-III College Regionals"; Masters/GM use their own
  // qualifier names. We match the level-appropriate phrase plus a
  // generic "Regional" fallback so seed-by-Regionals still works for
  // levels where we don't yet know the exact naming.
  const regionalsNameLike: Record<RankableLevel, string> = {
    CLUB: '%Regional%',
    COLLEGE_D1: '%D-I College Regional%',
    COLLEGE_D3: '%D-III College Regional%',
    MASTERS: '%Masters%Regional%',
    GRAND_MASTERS: '%Grand Masters%Regional%',
    GREAT_GRAND_MASTERS: '%Masters%Regional%',
  };

  // Decide which season to rank.
  const season =
    opts?.season != null ? opts.season : await resolveRankableSeason(db, compLevel);
  if (season == null) {
    return { season: new Date().getUTCFullYear() - 1, teams: [] };
  }

  // Pull every Nationals + Regionals event for this (season, level).
  const { data: events } = await db
    .from('usau_events')
    .select('id, usau_slug, name')
    .eq('season', season)
    .eq('competition_level', compLevel)
    .or(
      `name.ilike.${championshipNameLike[compLevel]},name.ilike.${regionalsNameLike[compLevel]}`,
    );
  const eventsList = events ?? [];
  // Identify Nationals/Championship events by the level's championship phrase
  // so College's "Championships" doesn't collide with Club's "Nationals".
  const champRegex = new RegExp(
    championshipNameLike[compLevel].replace(/%/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    'i',
  );
  const nationalsIds = new Set(
    eventsList.filter((e) => champRegex.test(e.name)).map((e) => e.id),
  );
  const slugById = new Map(eventsList.map((e) => [e.id, e.usau_slug] as const));

  if (eventsList.length === 0) {
    return { season, teams: [] };
  }

  const { data: participations } = await db
    .from('usau_event_teams')
    .select('event_id, team_id, seed, final_placement, usau_teams(id, name, state, competition_level, gender_division)')
    .in('event_id', eventsList.map((e) => e.id));

  type Part = {
    event_id: string;
    team_id: string;
    seed: number | null;
    final_placement: number | null;
    usau_teams: {
      id: string;
      name: string;
      state: string | null;
      competition_level: string | null;
      gender_division: string | null;
    } | null;
  };

  // Aggregate: per team, find best Nationals placement (lowest non-null
  // final_placement at a Nationals event) and best Regionals placement
  // (lowest at a Regional event). Fall back to seed when placement is
  // null — at least it preserves the bracket order we saw.
  const byTeam = new Map<string, {
    team: NonNullable<Part['usau_teams']>;
    natPlacement: number | null;
    natSeed: number | null;
    regPlacement: number | null;
    regSeed: number | null;
  }>();

  for (const row of (participations ?? []) as unknown as Part[]) {
    if (!row.usau_teams) continue;
    const t = row.usau_teams;
    if (opts?.genderDivision && t.gender_division !== opts.genderDivision) continue;
    // Masters / Grand Masters / Great Grand Masters share events (the combined
    // championships are tagged one event-level but host teams of ALL three
    // levels, each team tagged per-group). Filtering events alone therefore
    // mixes the levels — also require the TEAM's own level to match. Scoped to
    // the masters family only: club/college teams are sometimes mis-tagged in
    // source data, and their events never mix levels, so the event filter alone
    // stays correct there.
    if (
      (compLevel === 'MASTERS' ||
        compLevel === 'GRAND_MASTERS' ||
        compLevel === 'GREAT_GRAND_MASTERS') &&
      t.competition_level !== compLevel
    ) {
      continue;
    }

    const isNationals = nationalsIds.has(row.event_id);
    const entry = byTeam.get(t.id) ?? {
      team: t,
      natPlacement: null,
      natSeed: null,
      regPlacement: null,
      regSeed: null,
    };

    if (isNationals) {
      if (row.final_placement != null && (entry.natPlacement == null || row.final_placement < entry.natPlacement)) {
        entry.natPlacement = row.final_placement;
      }
      if (row.seed != null && (entry.natSeed == null || row.seed < entry.natSeed)) {
        entry.natSeed = row.seed;
      }
    } else {
      if (row.final_placement != null && (entry.regPlacement == null || row.final_placement < entry.regPlacement)) {
        entry.regPlacement = row.final_placement;
      }
      if (row.seed != null && (entry.regSeed == null || row.seed < entry.regSeed)) {
        entry.regSeed = row.seed;
      }
    }
    byTeam.set(t.id, entry);
  }

  // Build the ranked list. Three tiers:
  //   1. Made Nationals + has placement → order by placement
  //   2. Made Nationals + no placement (rare; uses seed) → order by seed
  //   3. Didn't make Nationals → order by best Regionals (placement, then seed)
  const ranked = Array.from(byTeam.values())
    .map((e) => {
      const madeNationals = e.natPlacement != null || e.natSeed != null;
      const rankedFromEventId = madeNationals
        ? Array.from(nationalsIds).find((id) =>
            (participations ?? []).some((p) => p.team_id === e.team.id && p.event_id === id),
          )
        : eventsList
            .filter((ev) => !nationalsIds.has(ev.id))
            .find((ev) =>
              (participations ?? []).some(
                (p) => p.team_id === e.team.id && p.event_id === ev.id,
              ),
            )?.id;
      const slug = rankedFromEventId ? slugById.get(rankedFromEventId) ?? null : null;

      return {
        id: e.team.id,
        name: e.team.name,
        state: e.team.state,
        competitionLevel: e.team.competition_level,
        genderDivision: e.team.gender_division,
        nationalsPlacement: e.natPlacement,
        bestRegionalsPlacement: e.regPlacement,
        rankedFromSlug: slug,
        season,
        _tier: madeNationals ? 0 : 1,
        _natSort: e.natPlacement ?? e.natSeed ?? 999,
        _regSort: e.regPlacement ?? e.regSeed ?? 999,
      };
    })
    .sort((a, b) => {
      if (a._tier !== b._tier) return a._tier - b._tier;
      if (a._tier === 0) return a._natSort - b._natSort;
      return a._regSort - b._regSort;
    })
    .map(({ _tier, _natSort, _regSort, ...rest }) => rest);

  return { season, teams: ranked };
}

/** Gender + level for a handful of team ids (the For You card picks its
 *  official ranking set from the user's favorite USAU teams). */
export async function getUsauTeamDivisions(
  ids: string[],
): Promise<{ id: string; genderDivision: string | null; competitionLevel: string | null }[]> {
  if (ids.length === 0) return [];
  const db = await supabase();
  const { data, error } = await db
    .from('usau_teams')
    .select('id, gender_division, competition_level')
    .in('id', ids.slice(0, 100));
  if (error) throw error;
  return ((data ?? []) as { id: string; gender_division: string | null; competition_level: string | null }[]).map(
    (r) => ({ id: r.id, genderDivision: r.gender_division, competitionLevel: r.competition_level }),
  );
}
