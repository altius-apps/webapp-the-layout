// RPC-backed fast path for the unified player profile.
//
// The shared `get_player_profile(p_anchor_id text)` function (deployed to the
// Supabase project, co-owned with the mobile app) reproduces the cross-league
// merge in one round trip: ~2ms warm off a cache-aside table, <300ms cold.
// The multi-query assembler in ./unified-player.ts stays as the fallback — any
// RPC error, a null return, or a payload we can't faithfully map degrades to it,
// so the rollout carries no behavioral risk.
//
// ── Two things the RPC does NOT give us, and how we handle them ─────────────
//
// 1. UFA ATTRIBUTION (correctness-critical). The RPC name-matches a UFA slug
//    with a bare `names_match` + `limit 1`. Its namesake conflict-graph splits
//    apart distinct humans WITHIN USAU, but nothing verifies that the matched
//    UFA career belongs to the person the anchor resolved to. Web guards this
//    with a geography check (see the attribution block in ./unified-player.ts):
//    if the USAU cluster's home states and the UFA team's state are both known
//    and disjoint, the UFA career is NOT this person's. The RPC omits
//    `homeStates` entirely, so we re-derive it here from the series-event names
//    already present in the payload — no extra query. This path prefers
//    `payload.homeStates` when present, so the day mobile adds it we switch over
//    with no code change; homeStatesFromPayload() then becomes dead code.
//
// 2. HEADSHOT LIVE-SCRAPE. The RPC returns the STORED headshot url only, by
//    design. A brand-new UFA player the sync hasn't self-hosted yet has none, so
//    a null headshot falls back to the live watchufa scrape — same order of
//    preference the fallback assembler uses (stored → live → monogram).
//
// ── Payload tripwires (both upstream defects FIXED as of 2026-09-13) ────────
//
// The shared function once had the two defects below. Both are fixed upstream
// — verified 2026-09-13: 0 of the 100 most recently built player_profiles trip
// either guard, so the fast path serves nearly every profile. The guards stay
// as tripwires: if a regression reintroduces either defect, the profile hands
// off to the multi-query assembler (SLOW but never WRONG) instead of rendering
// bad numbers.
//
//   a. UFA per-game rows omitting `throwaways`/`drops`/`stalls`. The profile's
//      game log computes +/- as G+A+B−throwaways−drops−stalls; without them every
//      row would overstate +/-. Guard: ufaGamesArePresentable().
//   b. USAU `events` empty for every stint (the event flatten aggregated the
//      inner array rather than the event object). That zeroes
//      career.usauEventsPlayed and the USAU goals/assists contribution.
//      Guard: usauEventsArePresentable().
//   (A third guard, ufaCoverageIsComplete, was retired 2026-09-13 once
//   `ufa_games` was backfilled to 2012 — see the note above mapRpcProfile.)

import 'server-only';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { supabaseUrl, supabaseAnonKey } from '@/lib/supabase/env';
import type { Database } from '@/lib/supabase/database.types';
import { getPlayerInfo } from '@/lib/ufa/client';
import { teamBySlugOrAbbr } from '@/lib/ufa/teams';
import {
  ufaTeamState,
  statesForEventName,
  isUsStateCode,
  isStateCoveredByRegionMap,
} from '@/lib/usau/regions';
import type { UfaPlayerGameRow } from '@/lib/ufa/types';
import { isUnhealthyError } from '@/lib/supabase/health';
import type { PlayerKind } from '@/lib/player-content/types';
import type {
  UnifiedPlayerProfile,
  UnifiedYear,
  SeasonStint,
  UfaSeasonStint,
  UsauSeasonStint,
  PulSeasonStint,
  WulSeasonStint,
  WfdfSeasonStint,
  WfdfChampionTitle,
  EufSeasonStint,
} from './unified-player';

// ── Wire shape ───────────────────────────────────────────────────────────
// Mirrors the jsonb the SQL function builds. Every field is treated as
// possibly-absent: this is a shared contract we don't own, and a shape drift
// should degrade to the fallback assembler rather than throw into a 500.

interface RpcUfaGame {
  gameId?: string | null;
  isHome?: boolean | null;
  goals?: number | null;
  assists?: number | null;
  blocks?: number | null;
  completions?: number | null;
  throwsAttempted?: number | null;
  hucksCompleted?: number | null;
  hucksAttempted?: number | null;
  throwaways?: number | null;
  drops?: number | null;
  stalls?: number | null;
  homeTeamId?: string | null;
  awayTeamId?: string | null;
  homeScore?: number | null;
  awayScore?: number | null;
  startTimestamp?: string | null;
}

interface RpcUfaStint {
  year?: number | null;
  teamId?: string | null;
  totals?: Record<string, number | null> | null;
  isChampion?: boolean | null;
  games?: RpcUfaGame[] | null;
}

/** Wire shape of one USAU event inside an RpcUsauStint. NOT the same as
 *  UsauSeasonStint['events'][number] — the RPC's jsonb has no `hasStats` key
 *  (it doesn't distinguish "no stats row" from "stats row, nulled 0"), so that
 *  field is derived at map time in mapUsauEvent() instead of trusted off the
 *  wire. See the comment there for what that costs us. */
interface RpcUsauEvent {
  slug?: string | null;
  name?: string | null;
  season?: number | null;
  startDate?: string | null;
  goals?: number | null;
  assists?: number | null;
  ds?: number | null;
  turns?: number | null;
  seed?: number | null;
  pool?: string | null;
}

interface RpcUsauStint {
  season?: number | null;
  teamId?: string | null;
  teamName?: string | null;
  genderDivision?: string | null;
  competitionLevel?: string | null;
  jerseyNumber?: string | null;
  isChampion?: boolean | null;
  events?: RpcUsauEvent[] | null;
}

interface RpcLeagueBlock<TStint> {
  stints?: TStint[] | null;
  career?: Record<string, number | null> | null;
}

interface RpcPulStint {
  season?: number | null;
  teamId?: string | null;
  teamName?: string | null;
  teamCity?: string | null;
  teamLogoUrl?: string | null;
  teamAccentColor?: string | null;
  jerseyNumber?: string | null;
  pronouns?: string | null;
  stats?: Record<string, number | null> | null;
}

interface RpcWulStint extends Omit<RpcPulStint, 'pronouns'> {
  games?: unknown[] | null;
}

interface RpcWfdfStint {
  season?: number | null;
  teamId?: string | null;
  teamName?: string | null;
  countryCode?: string | null;
  divisionName?: string | null;
  eventName?: string | null;
  eventSlug?: string | null;
  jerseyNumber?: string | null;
  isChampion?: boolean | null;
  stats?: { goals?: number | null; assists?: number | null } | null;
}

interface RpcEufStint {
  season?: number | null;
  teamId?: string | null;
  teamName?: string | null;
  countryName?: string | null;
  divisionName?: string | null;
  eventName?: string | null;
  eventSlug?: string | null;
  /** euf_events.kind ('eucf' | 'e2cf' | 'elite_invite' | …). Absent on payloads
   *  built before the 20260804 eventKind patch — treat as null. */
  eventKind?: string | null;
  jerseyNumber?: string | null;
  finalPlacement?: number | null;
  isChampion?: boolean | null;
  stats?: {
    goals?: number | null; assists?: number | null;
    games?: number | null; points?: number | null;
  } | null;
}

interface RpcProfile {
  anchorId?: string | null;
  anchorLeague?: string | null;
  displayName?: string | null;
  ufaSlug?: string | null;
  usauId?: string | null;
  /** EVERY usau_players id in the resolved cluster, not just the anchor's.
   *  The scraper mints one id per event registration, so one human routinely has
   *  many; content is keyed per-id, so all of them are needed to build a
   *  complete gallery. Absent on pre-20260801120000 payloads — treat as empty. */
  usauClusterIds?: string[] | null;
  pulAnchorId?: string | null;
  wulAnchorId?: string | null;
  headshotUrl?: string | null;
  pronouns?: string | null;
  /** Not currently emitted by the shared function — see note (1) at the top.
   *  Declared so that the day mobile adds it, this path picks it up for free. */
  homeStates?: string[] | null;
  ufaStints?: RpcUfaStint[] | null;
  championYearsUfa?: number[] | null;
  usauTeamHistory?: RpcUsauStint[] | null;
  championYearsUsau?: number[] | null;
  pul?: RpcLeagueBlock<RpcPulStint> | null;
  wul?: RpcLeagueBlock<RpcWulStint> | null;
  wfdfStints?: RpcWfdfStint[] | null;
  /** Absent on payloads built before the 20260803 EUF patch — treat as empty. */
  eufStints?: RpcEufStint[] | null;
}

const num = (v: number | null | undefined): number => (typeof v === 'number' ? v : 0);
const str = (v: string | null | undefined): string => (typeof v === 'string' ? v : '');

/**
 * Rebuild the `gameID` the UI keys on ("2024-05-11-ATX-DAL") from the RPC's
 * structured columns. The UI parses this string for the date, the opponent, and
 * the /g/{id} link, so it has to be byte-identical to the UFA API's own id.
 *
 * The RPC returns the raw `ufa_games.id`, which IS that string — we prefer it
 * verbatim and only synthesize when it's absent.
 */
function ufaGameId(g: RpcUfaGame): string | null {
  if (g.gameId) return g.gameId;
  const date = g.startTimestamp?.slice(0, 10);
  const home = g.homeTeamId ? teamBySlugOrAbbr(g.homeTeamId)?.abbr : null;
  const away = g.awayTeamId ? teamBySlugOrAbbr(g.awayTeamId)?.abbr : null;
  if (!date || !home || !away) return null;
  return `${date}-${away}-${home}`;
}

/**
 * Map an RPC game row onto UfaPlayerGameRow. The UI reads a narrow slice of
 * this type — gameID, isHome, scoreHome/scoreAway, goals, assists, blocks,
 * throwaways/drops/stalls (per-game +/-), completions, throwsAttempted, hucks —
 * and every one of those is present in the RPC payload. Fields the UI does not
 * read on this surface (hockeyAssists, yards, seconds, o/d points, catches,
 * pulls, callahans) are zero-filled to satisfy the type.
 *
 * NOTE: zero-fill is safe ONLY while those fields stay unread on the profile.
 * If a future stat column surfaces one of them here, it must be added to the
 * shared function's `games` payload first — otherwise it silently renders 0.
 */
function mapUfaGame(g: RpcUfaGame): UfaPlayerGameRow | null {
  const gameID = ufaGameId(g);
  if (!gameID) return null;
  const isHome = g.isHome === true;
  return {
    gameID,
    isHome,
    scoreHome: num(g.homeScore),
    scoreAway: num(g.awayScore),
    assists: num(g.assists),
    goals: num(g.goals),
    hockeyAssists: 0,
    completions: num(g.completions),
    throwaways: num(g.throwaways),
    stalls: num(g.stalls),
    throwsAttempted: num(g.throwsAttempted),
    catches: 0,
    drops: num(g.drops),
    blocks: num(g.blocks),
    callahans: 0,
    pulls: 0,
    obPulls: 0,
    recordedPulls: 0,
    recordedPullsHangtime: 0,
    oPointsPlayed: 0,
    oPointsScored: 0,
    dPointsPlayed: 0,
    dPointsScored: 0,
    secondsPlayed: 0,
    yardsReceived: 0,
    yardsThrown: 0,
    hucksCompleted: num(g.hucksCompleted),
    hucksAttempted: num(g.hucksAttempted),
  };
}

/**
 * Does the RPC's UFA game payload carry the fields the profile's game-log table
 * renders? The per-game +/- column is computed from throwaways/drops/stalls and
 * the result cell from homeScore/awayScore — if the shared function ever stops
 * emitting them, every row would silently render +/- as (G+A+B) and a 0–0
 * score. That's a wrong-data failure, not a cosmetic one, so we detect it and
 * hand off to the fallback assembler instead.
 *
 * Checked on the shape (key presence), not the values — a genuine 0 throwaway
 * game is normal and must not trip this.
 */
function ufaGamesArePresentable(stints: RpcUfaStint[]): boolean {
  for (const st of stints) {
    for (const g of st.games ?? []) {
      const hasPlusMinusInputs =
        'throwaways' in g && 'drops' in g && 'stalls' in g;
      const hasScores = 'homeScore' in g && 'awayScore' in g;
      if (!hasPlusMinusInputs || !hasScores) return false;
    }
  }
  return true;
}

/**
 * Does the RPC's USAU payload carry per-stint `events`?
 *
 * The shared function once returned EVERY stint with `events: []` (its event
 * flatten aggregated the inner array instead of the event object) — fixed
 * upstream, verified 2026-09-13. Those events drive `career.usauEventsPlayed`
 * and the goals/assists that USAU contributes to career totals, so a
 * regression would silently zero out a real chunk of the hero stats; this
 * guard catches it.
 *
 * A player genuinely CAN have a roster spot with no event participation, so an
 * empty array is not by itself proof of the bug. We only reject when EVERY
 * stint is empty while there is at least one stint — the signature of the
 * systemic failure rather than of a sparse individual season.
 */
function usauEventsArePresentable(usauStints: RpcUsauStint[]): boolean {
  if (usauStints.length === 0) return true;
  return usauStints.some((st) => (st.events?.length ?? 0) > 0);
}

/**
 * Map one wire event to the app shape, deriving `hasStats`.
 *
 * KNOWN LIMITATION: the RPC's jsonb has no field marking whether USAU
 * published a stats row for this event — only `goals`/`assists`, which the
 * shared SQL collapses to null both when there's no row AND when the row's
 * own goals/assists are null. We treat "either stat is non-null" as
 * hasStats=true, same signal the pre-existing code already had; this is not a
 * regression, just not yet the same fidelity as the multi-query assembler
 * (which reads usau_player_event_stats directly and knows the row's presence
 * for certain — see getPlayerProfile in usau/data.ts).
 */
function mapUsauEvent(ev: RpcUsauEvent): UsauSeasonStint['events'][number] {
  const goals = ev.goals ?? null;
  const assists = ev.assists ?? null;
  const ds = ev.ds ?? null;
  const turns = ev.turns ?? null;
  return {
    slug: str(ev.slug),
    name: str(ev.name),
    season: ev.season ?? 0,
    startDate: ev.startDate ?? null,
    goals,
    assists,
    ds,
    turns,
    seed: ev.seed ?? null,
    pool: ev.pool ?? null,
    hasStats: goals != null || assists != null || ds != null || turns != null,
  };
}

/**
 * Recover the `homeStates` signal the RPC omits — see note (1) at the top.
 *
 * Derived exactly the way the multi-query path derives it: the union of states
 * implied by the USAU cluster's SERIES (Sectionals/Regionals) event names. We
 * read the event names straight off the RPC payload we already hold, so this
 * costs no extra query at all in the common case.
 */
function homeStatesFromPayload(usauStints: RpcUsauStint[]): string[] {
  const states = new Set<string>();
  for (const st of usauStints) {
    for (const ev of st.events ?? []) {
      if (!ev?.name) continue;
      for (const s of statesForEventName(ev.name)) states.add(s);
    }
  }
  return [...states];
}

/**
 * The geography gate. Mirrors the attribution block in ./unified-player.ts
 * one-for-one, including its conservative fallback: we only DROP the UFA career
 * when the USAU cluster HAS a usable location signal AND it contradicts the UFA
 * team's state. No signal, or a non-US UFA team with no state, means keep.
 *
 * `nameIsAmbiguous` is the precondition: geography only ever answers "WHICH of
 * the same-named people is the pro?". With a single unambiguous human a state
 * mismatch means the player MOVED (club in one state, UFA team in another) —
 * dropping on that deletes a real career (it deleted Chander Boyd-Fliegel's
 * entire 2026 Oakland Spiders championship season). The RPC payload cannot
 * distinguish "one human" from "one of several", because `usauClusterIds`
 * carries only the RESOLVED cluster and never the namesake rows that were split
 * off — so this path can never prove ambiguity and always abstains. That is the
 * same conservative direction as the coverage rules above: keep the career and
 * let the multi-query path, which computes the cluster itself, do the dropping.
 */
function shouldAttachUfa(
  ufaStints: RpcUfaStint[],
  usauStints: RpcUsauStint[],
  homeStates: string[],
  nameIsAmbiguous: boolean,
): boolean {
  if (ufaStints.length === 0) return true;
  if (usauStints.length === 0) return true;
  if (!nameIsAmbiguous) return true;
  if (homeStates.length === 0) return true;

  const usauStates = new Set(homeStates);
  // Non-US codes are dropped, not compared. Canadian franchises map to
  // provinces (royal→QC, rush/lions→ON), which can never appear in homeStates
  // (US codes only) — comparing them would guarantee a miss and drop the whole
  // real UFA career. A non-US team is no signal, so we keep, per the doc above.
  const ufaStates = ufaStints
    .map((st) => (st.teamId ? ufaTeamState(st.teamId) : null))
    .filter((s): s is string => s != null && isUsStateCode(s));
  if (ufaStates.length === 0) return true;
  // A state the region map never lists can't be CONTRADICTED by it — the
  // absence is our gap, not evidence of a different person. Abstain (keep the
  // career) unless every UFA state is one the map actually covers. Without
  // this, one missing state in USAU_REGION_STATES silently deletes a whole
  // real UFA career (it deleted every Salt Lake Shred player's).
  if (!ufaStates.every((s) => isStateCoveredByRegionMap(s))) return true;
  return ufaStates.some((s) => usauStates.has(s));
}

/**
 * WFDF world titles grouped by event series. The series is eventName minus its
 * trailing year ("WUCC 2026" → "WUCC"); the stint's season is the title year.
 * Lives here (not unified-player.ts) because that module already imports this
 * one at runtime — the reverse would add an import cycle. Both builders call it.
 */
export function wfdfChampionTitles(years: UnifiedYear[]): WfdfChampionTitle[] {
  const byEvent = new Map<string, Set<number>>();
  for (const y of years) {
    for (const s of y.stints) {
      if (s.league !== 'wfdf' || !s.isChampion) continue;
      const event = s.eventName.replace(/\s*\d{4}$/, '').trim() || 'WFDF';
      const set = byEvent.get(event) ?? new Set<number>();
      set.add(s.season);
      byEvent.set(event, set);
    }
  }
  return Array.from(byEvent, ([event, set]) => ({
    event,
    years: Array.from(set).sort((a, b) => b - a),
  })).sort((a, b) => b.years[0] - a.years[0]);
}

function sortStintsForYear(stints: SeasonStint[]): SeasonStint[] {
  const leagueOrder: Record<SeasonStint['league'], number> = {
    ufa: 0,
    pul: 1,
    wul: 2,
    usau: 3,
    wfdf: 4,
    euf: 5,
  };
  return [...stints].sort((a, b) => leagueOrder[a.league] - leagueOrder[b.league]);
}

/**
 * Map the RPC payload onto UnifiedPlayerProfile. Returns null when the payload
 * can't be faithfully represented — the caller then runs the fallback
 * assembler, so a null here is a safe degradation, never a user-visible error.
 */
export async function mapRpcProfile(
  anchorId: string,
  payload: RpcProfile,
): Promise<UnifiedPlayerProfile | null> {
  const anchorLeague = payload.anchorLeague;
  if (
    anchorLeague !== 'ufa' &&
    anchorLeague !== 'usau' &&
    anchorLeague !== 'pul' &&
    anchorLeague !== 'wul'
  ) {
    return null;
  }
  const displayName = payload.displayName;
  if (!displayName) return null;

  const rpcUfaStints = payload.ufaStints ?? [];
  const rpcUsauStints = payload.usauTeamHistory ?? [];

  // Bail to the fallback if either league's payload can't be rendered
  // faithfully. Better a slower correct page than a fast wrong one.
  if (!ufaGamesArePresentable(rpcUfaStints)) return null;
  if (!usauEventsArePresentable(rpcUsauStints)) return null;

  // ── UFA attribution gate ────────────────────────────────────────────────
  // Prefer a homeStates the shared function supplies (not emitted today);
  // otherwise derive it from the event names already in this payload.
  const homeStates =
    payload.homeStates && payload.homeStates.length > 0
      ? payload.homeStates
      : homeStatesFromPayload(rpcUsauStints);
  // The payload carries no namesake-split signal, so ambiguity is never
  // provable here — see shouldAttachUfa's doc. Passing false makes this path
  // abstain from the geography drop entirely.
  const attachUfa = shouldAttachUfa(rpcUfaStints, rpcUsauStints, homeStates, false);

  const yearMap = new Map<number, SeasonStint[]>();
  const push = (year: number, stint: SeasonStint) => {
    const list = yearMap.get(year) ?? [];
    list.push(stint);
    yearMap.set(year, list);
  };

  // ── UFA ────────────────────────────────────────────────────────────────
  const championYearsUfa: number[] = [];
  if (attachUfa) {
    for (const st of rpcUfaStints) {
      const year = st.year;
      const teamMeta = st.teamId ? teamBySlugOrAbbr(st.teamId) : null;
      // An unknown team slug means our TEAM_META is out of date relative to the
      // DB; the fallback path skips such stints too (teamMetaByAbbr → continue).
      if (typeof year !== 'number' || !teamMeta) continue;
      const t = st.totals ?? {};
      const games = (st.games ?? [])
        .map(mapUfaGame)
        .filter((g): g is UfaPlayerGameRow => g != null);
      const stint: UfaSeasonStint = {
        league: 'ufa',
        teamId: teamMeta.id,
        teamMeta,
        totals: {
          gamesPlayed: num(t.gamesPlayed),
          goals: num(t.goals),
          assists: num(t.assists),
          blocks: num(t.blocks),
          plusMinus: num(t.plusMinus),
          completions: num(t.completions),
          throwsAttempted: num(t.throwsAttempted),
          hucksCompleted: num(t.hucksCompleted),
          hucksAttempted: num(t.hucksAttempted),
        },
        games,
        isChampion: st.isChampion === true,
      };
      if (stint.isChampion) championYearsUfa.push(year);
      push(year, stint);
    }
  }

  // ── USAU ───────────────────────────────────────────────────────────────
  for (const st of rpcUsauStints) {
    const season = st.season;
    if (typeof season !== 'number') continue;
    const stint: UsauSeasonStint = {
      league: 'usau',
      teamId: str(st.teamId),
      teamName: str(st.teamName),
      // Matches deriveUsauChip()'s current placeholder-null behavior.
      division: null,
      genderDivision: st.genderDivision ?? null,
      competitionLevel: st.competitionLevel ?? null,
      jerseyNumber: st.jerseyNumber ?? null,
      isChampion: st.isChampion === true,
      events: (st.events ?? []).map(mapUsauEvent),
    };
    push(season, stint);
  }

  // ── PUL ────────────────────────────────────────────────────────────────
  for (const st of payload.pul?.stints ?? []) {
    const season = st.season;
    if (typeof season !== 'number') continue;
    const s = st.stats ?? {};
    const stint: PulSeasonStint = {
      league: 'pul',
      season,
      teamId: str(st.teamId),
      teamName: str(st.teamName) || str(st.teamId),
      teamCity: str(st.teamCity),
      teamLogoUrl: st.teamLogoUrl ?? null,
      teamAccentColor: st.teamAccentColor ?? null,
      jerseyNumber: str(st.jerseyNumber),
      pronouns: st.pronouns ?? null,
      stats: {
        gamesPlayed: num(s.gamesPlayed),
        goals: num(s.goals),
        assists: num(s.assists),
        blocks: num(s.blocks),
        turnovers: num(s.turnovers),
        touches: num(s.touches),
        oPoints: num(s.oPoints),
        dPoints: num(s.dPoints),
        plusMinus: num(s.plusMinus),
      },
      // PUL per-game logs are not in the RPC payload. The fallback path fetches
      // them per-season; here the season-totals view renders without them, the
      // same way a 2022 PUL season (which genuinely has no box scores) does.
      games: [],
    };
    push(season, stint);
  }

  // ── WUL ────────────────────────────────────────────────────────────────
  for (const st of payload.wul?.stints ?? []) {
    const season = st.season;
    if (typeof season !== 'number') continue;
    const s = st.stats ?? {};
    const stint: WulSeasonStint = {
      league: 'wul',
      season,
      teamId: str(st.teamId),
      teamName: str(st.teamName) || str(st.teamId),
      teamCity: str(st.teamCity),
      teamLogoUrl: st.teamLogoUrl ?? null,
      teamAccentColor: st.teamAccentColor ?? null,
      jerseyNumber: str(st.jerseyNumber),
      stats: {
        gamesPlayed: num(s.gamesPlayed),
        goals: num(s.goals),
        assists: num(s.assists),
        blocks: num(s.blocks),
        turnovers: num(s.turnovers),
        touches: num(s.touches),
        oPoints: num(s.oPoints),
        dPoints: num(s.dPoints),
        plusMinus: num(s.plusMinus),
      },
      // The RPC's WUL game objects use a different shape than WulPlayerGameRow
      // (gameId/date/weekLabel/opponentAbbrev vs the data-layer row). Rather
      // than half-map it, leave empty — see the WUL note in the summary.
      games: [],
    };
    push(season, stint);
  }

  // ── WFDF ───────────────────────────────────────────────────────────────
  for (const st of payload.wfdfStints ?? []) {
    const season = st.season;
    if (typeof season !== 'number') continue;
    const stint: WfdfSeasonStint = {
      league: 'wfdf',
      season,
      teamId: str(st.teamId),
      teamName: str(st.teamName),
      countryCode: st.countryCode ?? null,
      divisionName: st.divisionName ?? null,
      eventName: str(st.eventName),
      eventSlug: str(st.eventSlug),
      jerseyNumber: st.jerseyNumber ?? null,
      isChampion: st.isChampion === true,
      stats: {
        goals: st.stats?.goals ?? null,
        assists: st.stats?.assists ?? null,
      },
    };
    push(season, stint);
  }

  // ── EUF / EUCS ─────────────────────────────────────────────────────────
  for (const st of payload.eufStints ?? []) {
    const season = st.season;
    if (typeof season !== 'number') continue;
    const stint: EufSeasonStint = {
      league: 'euf',
      season,
      teamId: str(st.teamId),
      teamName: str(st.teamName),
      countryName: st.countryName ?? null,
      divisionName: st.divisionName ?? null,
      eventName: str(st.eventName),
      eventSlug: str(st.eventSlug),
      eventKind: st.eventKind ?? null,
      jerseyNumber: st.jerseyNumber ?? null,
      finalPlacement: st.finalPlacement ?? null,
      isChampion: st.isChampion === true,
      stats: {
        goals: st.stats?.goals ?? null,
        assists: st.stats?.assists ?? null,
        games: st.stats?.games ?? null,
        points: st.stats?.points ?? null,
      },
    };
    push(season, stint);
  }

  const years: UnifiedYear[] = Array.from(yearMap.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([year, stints]) => ({ year, stints: sortStintsForYear(stints) }));

  // ── Most-recent USAU division ──────────────────────────────────────────
  let mostRecentUsauDivision: string | null = null;
  outer: for (const y of years) {
    for (const s of y.stints) {
      if (s.league === 'usau' && s.genderDivision) {
        mostRecentUsauDivision = s.genderDivision;
        break outer;
      }
    }
  }

  // ── Career aggregates ──────────────────────────────────────────────────
  // Recomputed from the mapped stints rather than read off the payload, so the
  // attribution gate above actually removes the UFA contribution when it fires.
  const career = {
    ufaGamesPlayed: 0,
    usauEventsPlayed: 0,
    goals: 0,
    assists: 0,
    blocks: 0,
    plusMinus: 0,
    completions: 0,
    throwsAttempted: 0,
    usauGoals: 0,
    usauAssists: 0,
    usauEventsWithStats: 0,
  };
  for (const year of years) {
    for (const s of year.stints) {
      if (s.league === 'ufa') {
        career.ufaGamesPlayed += s.totals.gamesPlayed;
        career.goals += s.totals.goals;
        career.assists += s.totals.assists;
        career.blocks += s.totals.blocks;
        career.plusMinus += s.totals.plusMinus;
        career.completions += s.totals.completions;
        career.throwsAttempted += s.totals.throwsAttempted;
      } else if (s.league === 'usau') {
        // USAU goals/assists kept OUT of the shared goals/assists (UFA-only
        // now) — see the field doc on UnifiedPlayerProfile.career.
        career.usauEventsPlayed += s.events.length;
        for (const ev of s.events) {
          if (ev.hasStats) career.usauEventsWithStats++;
          career.usauGoals += ev.goals ?? 0;
          career.usauAssists += ev.assists ?? 0;
        }
      }
    }
  }

  const pulCareer = payload.pul?.career;
  const pulBlock = payload.pul
    ? {
        seasonsPlayed: num(pulCareer?.seasonsPlayed),
        gamesPlayed: num(pulCareer?.gamesPlayed),
        goals: num(pulCareer?.goals),
        assists: num(pulCareer?.assists),
        blocks: num(pulCareer?.blocks),
        turnovers: num(pulCareer?.turnovers),
        touches: num(pulCareer?.touches),
        plusMinus: num(pulCareer?.plusMinus),
      }
    : null;

  const wulCareer = payload.wul?.career;
  const wulBlock = payload.wul
    ? {
        seasonsPlayed: num(wulCareer?.seasonsPlayed),
        gamesPlayed: num(wulCareer?.gamesPlayed),
        goals: num(wulCareer?.goals),
        assists: num(wulCareer?.assists),
        blocks: num(wulCareer?.blocks),
        turnovers: num(wulCareer?.turnovers),
        touches: num(wulCareer?.touches),
        plusMinus: num(wulCareer?.plusMinus),
      }
    : null;

  // ── Content refs ───────────────────────────────────────────────────────
  // Rebuilt from the per-league ids the RPC returns. A photo uploaded under ANY
  // of the person's league ids must show regardless of which url reached the
  // profile — so this list has to stay complete. The UFA ref is included even
  // when the attribution gate detached the UFA CAREER: the gate is about whose
  // stats these are, and suppressing the ref would only hide the merged-in
  // content, matching the fallback path's behavior (it pushes ufaSlug too).
  const contentRefs: { kind: PlayerKind; ref: string }[] = [];
  const pushRef = (kind: PlayerKind, ref: string | null | undefined) => {
    if (ref && !contentRefs.some((r) => r.kind === kind && r.ref === ref)) {
      contentRefs.push({ kind, ref });
    }
  };
  pushRef('ufa', payload.ufaSlug);
  pushRef('usau', payload.usauId);
  // Every id in the USAU cluster, not just the anchor's. Without these the
  // gallery's contents depend on WHICH cluster id you navigated in through —
  // content uploaded under a sibling registration id would silently vanish.
  for (const id of payload.usauClusterIds ?? []) pushRef('usau', id);
  pushRef('pul', payload.pulAnchorId);
  pushRef('wul', payload.wulAnchorId);
  pushRef(anchorLeague, anchorId);

  // ── Headshot ───────────────────────────────────────────────────────────
  // The RPC returns the STORED url only. Null means either the player has none
  // or the sync hasn't self-hosted them yet — fall back to the live scrape, the
  // same preference order the multi-query path uses.
  let headshotUrl = payload.headshotUrl ?? null;
  if (!headshotUrl && payload.ufaSlug) {
    headshotUrl = await getPlayerInfo(payload.ufaSlug)
      .then((i) => i?.headshotUrl ?? null)
      .catch(() => null);
  }

  return {
    anchorId,
    anchorLeague,
    displayName,
    pronouns: payload.pronouns ?? null,
    contentRefs,
    headshotUrl,
    years,
    career,
    pul: pulBlock,
    wul: wulBlock,
    championYearsUfa: attachUfa
      ? (payload.championYearsUfa ?? championYearsUfa).slice().sort((a, b) => b - a)
      : [],
    championYearsUsau: (payload.championYearsUsau ?? []).slice().sort((a, b) => b - a),
    championTitlesWfdf: wfdfChampionTitles(years),
    mostRecentUsauDivision,
  };
}

/**
 * Call the shared RPC and map it. Returns null on any error, a null payload, or
 * an unmappable shape — the caller falls back to the multi-query assembler.
 */
// Cookie-free anon client: profile data is public, and the cookie-bound SSR
// client makes cookies() throw inside an SSG render — /players/[id] has
// generateStaticParams, so every render 500'd with "Page changed from static to
// dynamic at runtime, reason: cookies". Same fix already applied to the
// approved-content reader in lib/player-content/server.ts.
let _anonDb: ReturnType<typeof createSupabaseClient<Database>> | null = null;
function anonDb() {
  if (_anonDb) return _anonDb;
  _anonDb = createSupabaseClient<Database>(supabaseUrl(), supabaseAnonKey(), {
    auth: { persistSession: false },
  });
  return _anonDb;
}

/**
 * Outcome of the RPC fast path, so the caller can tell "the RPC answered but I
 * couldn't use the answer" from "the database is in trouble".
 *
 * App Health Rule #2 — a fallback must be CHEAPER than what failed. The
 * multi-query assembler behind this RPC costs 6-10 queries; running it because
 * the DB just timed out is how the 2026-08-12 outage turned load into collapse
 * (every timeout bought 6-10 more timeouts). So:
 *   - 'ok'       → use the profile.
 *   - 'notfound' → the RPC answered null: no such player. Authoritative (the
 *                  RPC resolves ufa/usau/pul/wul, the same sources as the
 *                  assembler; mobile treats null the same way). No fallback, so
 *                  a junk id costs one cheap RPC, not the assembler.
 *   - 'shape'    → the RPC replied but the payload was unmappable. The
 *                  assembler is a legitimate alternate path here; it's a data
 *                  defect, not a load problem, and the DB is answering fine.
 *   - 'unhealthy'→ timeout / network / 5xx. FAIL FAST. Do not run the
 *                  assembler; let the caller degrade.
 */
export type RpcProfileResult =
  | { status: 'ok'; profile: UnifiedPlayerProfile }
  | { status: 'notfound' }
  | { status: 'shape' }
  | { status: 'unhealthy'; reason: string };

export async function getProfileViaRpc(anchorId: string): Promise<RpcProfileResult> {
  try {
    const db = anonDb();
    // NOTE: call db.rpc(...) on the client object DIRECTLY (bound) — pulling it
    // into a local `const rpc = db.rpc` detaches `this` and supabase-js then
    // reads `this.rest` → "Cannot read properties of undefined (reading 'rest')".
    const { data, error } = await db.rpc('get_player_profile', {
      p_anchor_id: anchorId,
    });
    if (error) {
      if (isUnhealthyError(error)) {
        console.error('[getProfileViaRpc] db unhealthy, failing fast', anchorId, error.message);
        return { status: 'unhealthy', reason: error.code ?? error.message };
      }
      console.error('[getProfileViaRpc] rpc error', anchorId, error.message);
      return { status: 'shape' };
    }
    if (!data) return { status: 'notfound' };
    const profile = await mapRpcProfile(anchorId, data as RpcProfile);
    return profile ? { status: 'ok', profile } : { status: 'shape' };
  } catch (e) {
    // Log before falling back. A bare `catch {}` here turned a cookies()-in-SSG
    // throw into a silent 500 with nothing in the logs (fixed in 76889b1) — the
    // fallback is meant for a bad RPC payload, not for hiding runtime faults.
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[getProfileViaRpc] threw', anchorId, msg);
    // A thrown fetch (network down, socket reset, abort) is a health signal, not
    // a shape defect — don't let it buy 6-10 more queries.
    if (isUnhealthyError({ message: msg })) {
      return { status: 'unhealthy', reason: msg };
    }
    return { status: 'shape' };
  }
}
