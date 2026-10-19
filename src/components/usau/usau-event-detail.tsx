'use client';

// Shared event-detail body: pools + brackets for one USAU tournament.
// Used by /usau/events/[slug] and the /scores?league=usau view, which
// renders the most-recent club tournament with this same UI.
//
// Gender filter:
// The page reads the global `?div=men|women|mixed` URL param (managed by
// the top-of-page UsauDivisionSelect dropdown) and filters the entire
// view — pools, pool games, bracket tree, and bracket-play list — to that
// division. Each gender's bracket is independent, so showing both at once
// would mix unrelated games into the same pool cards.
//
// Single-division events (regional sectionals, regular-season tournaments)
// auto-fall-back to their available division so the URL filter doesn't
// accidentally hide everything.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { UsauEventSummary } from '@/lib/usau/data';
import { useDivision, type UsauDivision } from '@/lib/use-division';
import { useLevel, type UsauLevel } from '@/lib/use-level';
import { useViewParam } from '@/lib/use-view-param';
import { useRememberedEventView } from '@/lib/use-remembered-event-view';
import { USAU_LEVELS } from '@/lib/league';
import { UsauBracketTree, UsauPlacementBracketTree, UsauFlatBracketCards, isChampionshipBracket, bracketGroupPrefix, shortPlaceholder, hasBracketStructure, structuredColumnLabel } from './usau-bracket-tree';
import { formatGameTime, formatGameDate, formatGameClock } from '@/lib/usau/venue-tz';
import { gameWinnerId, isForfeit } from '@/lib/usau/game-winner';
import { UsauTeamLogo } from '@/components/usau/usau-team-logo';
import { DivisionPager, scrollToSectionTop } from '@/components/division-pager';
import { UsauLevelSelect } from '@/components/usau/usau-level-select';
import { NationalsFieldPanel, type NationalsFieldState } from '@/components/usau/nationals-field';
import { NATIONALS_DIVISIONS } from '@/lib/usau/nationals-field';

// Masters combined events prefix every bracket with its group ("GM Women ·
// Pool A", "Masters Mixed · 1st Place"). Pool detection and display labels
// need the tail, not the raw name.
function bracketTail(name: string): string {
  const i = name.lastIndexOf('·');
  return i >= 0 ? name.slice(i + 1).trim() : name;
}

function isPoolBracket(name: string | null | undefined): boolean {
  if (!name) return false;
  const t = bracketTail(name).toLowerCase();
  // A crossover is NOT a pool even if it says "Pool B-C Crossover".
  if (t.includes('crossover')) return false;
  return t.startsWith('pool');
}

/** Crossover games bridge pool play and the bracket (e.g. "Pool B-C Crossover",
 *  "9th Place Crossover X"). Identified by bracket_name — there's no crossover
 *  round type. Their own tab keeps them out of both Pool Games and Bracket. */
function isCrossoverBracket(name: string | null | undefined): boolean {
  if (!name) return false;
  return bracketTail(name).toLowerCase().includes('crossover');
}

/** Does a bracket_name read as a placement group? ("9th Place", "Placement",
 *  "21st (3 games each)"). Mirrors the scraper's isPlacementLabel so a
 *  placement-ish 'other' game never migrates into the Rounds tab. */
function isPlacementName(name: string | null | undefined): boolean {
  if (!name) return false;
  const t = bracketTail(name).toLowerCase();
  return (
    /placement/.test(t) ||
    /\b\d+(st|nd|rd|th)\s+place\b/.test(t) ||
    /^\s*\d+(st|nd|rd|th)\b/.test(t) ||
    // Written-out ordinals: "Second Place" (game-to-go), bare "Third".
    /\b(second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth)\s+place\b/.test(t) ||
    /^(second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth)$/.test(t.trim()) ||
    // Next-bid games (Hunter, 2026-09-12: they belong with the placements).
    /backdoor|game[- ]to[- ]go|\bg2g\b/.test(t)
  );
}

/** A championship bracket's deciding game stored under another round (USAU
 *  structure column 0 labeled "Finals" / "The Championship", typed 'placement'
 *  or 'other'). Client twin of data.ts isStructuredTitleDecider — keep in
 *  sync. "1st"/"first" stages skip the placement reject, as the server's
 *  isPlacementBracketName carve-out does. */
function isStructuredTitleDecider(g: Game): boolean {
  if (g.bracketStageIndex !== 0) return false;
  if (g.round === 'prequarter' || g.round === 'quarter' || g.round === 'semi') return false;
  if (!isChampionshipBracket(g)) return false;
  const stage = (g.bracketStage ?? '').trim().toLowerCase();
  if (!stage || /quarter|semi|cross/.test(stage)) return false;
  if (!/\b1st\b|\bfirst\b/.test(stage) && isPlacementName(stage)) return false;
  return /\bfinals?\b|\bchampionship\b|\bchamps?\b|\b1st\b|\bfirst\b/.test(stage);
}

/** A placement group played round-robin rather than as a bracket. Either named
 *  like a pool ("11th Place Pool", "Consolation Pool", "13th Place Round Robin",
 *  "Pool 11-13") and shaped like one — 3+ teams and at least as many games as
 *  teams, which excludes 2-team "Pool B Placement" games and a 4-team
 *  semis-plus-final "Pool B 1st Place" — or, whatever its name, a COMPLETE
 *  round robin: no bracket column, every pairing once, n(n-1)/2 games. That
 *  second rule catches 2026 SC Men "9th-12th Place" / "13th-16th Place", which
 *  USAU draws as pools (mobile's rule, adopted 2026-09-29). */
function isPlacementPoolGroup(name: string, games: Game[]): boolean {
  const t = bracketTail(name).toLowerCase();
  if (/crossover/.test(t)) return false;
  const ids = new Set(games.flatMap((g) => [g.teamAId, g.teamBId]).filter(Boolean));
  if (!/bracket/.test(t) && /\bpools?\b|round[- ]?robin/.test(t)) {
    return ids.size >= 3 && games.length >= ids.size;
  }
  if (ids.size < 3 || games.some((g) => g.bracketStageIndex != null || !g.teamAId || !g.teamBId)) return false;
  const pairs = new Set(games.map((g) => [g.teamAId, g.teamBId].sort().join('|')));
  return pairs.size === games.length && games.length === (ids.size * (ids.size - 1)) / 2;
}

/** Matchup rounds — pool-less Saturday phases like Cooler Classic 37 Men's
 *  "Sat Round 1/2/3": stored round='other' with the tab label as bracket_name.
 *  Not a pool, not a crossover, not placement — they get their own Rounds tab. */
function isMatchupRound(g: { round: string; bracketName: string | null }): boolean {
  return (
    g.round === 'other' &&
    !isCrossoverBracket(g.bracketName) &&
    !isPoolBracket(g.bracketName) &&
    !isPlacementName(g.bracketName)
  );
}

type Game = UsauEventSummary['games'][number];
type Team = UsauEventSummary['teams'][number];

/** A merged series event (USAU publishes Sectionals/Regionals one row per
 *  division) whose members all carry a division — its games and teams are
 *  tagged with that division and filtered on it directly. */
function isMergedSeries(event: UsauEventSummary): boolean {
  return event.members.length > 0 && event.members.every((m) => m.division != null);
}

/** Timezone key for a division's game times. A merged event's divisions can
 *  play in different states (Capital: VA sites; 2024 East Coast: SC/TN), and
 *  the event-level state is null when they disagree — which would fall back
 *  to UTC — so use the division's own member. */
function venueKeyFor(event: UsauEventSummary, division: string): string | null {
  const member = event.members.find((m) => m.division === division);
  return member ? (member.venueTz ?? member.state) : (event.venueTz ?? event.state);
}

/** The real USAU slug behind a division — a merged event's own slug is our
 *  group key, which USAU's site doesn't know. */
function usauSlugFor(event: UsauEventSummary, division: string): string {
  const member = event.members.find((m) => m.division === division) ?? event.members[0];
  return member?.slug ?? event.slug;
}

interface Props {
  event: UsauEventSummary;
  /** The projected Club Nationals field (FIELD tab). The route passes it only
   *  for a club Nationals with no teams posted; null/absent everywhere else. */
  nationalsField?: NationalsFieldState | null;
}

export function UsauEventDetail({ event, nationalsField = null }: Props) {
  // The FIELD tab exists once the field has a qualifier (or its read failed,
  // which shows the generic error copy). Before any qualifier, nothing new
  // renders at all.
  const field =
    nationalsField != null &&
    (nationalsField.status === 'error' || nationalsField.field.divisions.some((d) => d.qualifiedCount > 0))
      ? nationalsField
      : null;

  // ── Detect available competition levels ───────────────────────────────
  // Combined masters championships host Masters AND Grand Masters groups in
  // ONE event (each team is tagged per-group). Those must be viewed one
  // level at a time — mixing them would blend two unrelated brackets.
  // Single-level events (all club, all D-I, …) skip this entirely.
  // A merged series event is single-level by construction (each member is one
  // division of one tier). Stray CLUB-tagged teams inside Masters/College
  // members used to flip the Level select to CLUB and hide the real teams.
  const mergedDivisions = isMergedSeries(event);
  const availableLevels = useMemo(() => {
    if (mergedDivisions) return [];
    const set = new Set<string>();
    for (const t of event.teams) {
      if (t.competitionLevel) set.add(t.competitionLevel);
    }
    return USAU_LEVELS.filter((l) => set.has(l));
  }, [event.teams, mergedDivisions]);

  const [urlLevel] = useLevel();
  const level: UsauLevel | '' =
    availableLevels.length > 1
      ? (availableLevels.includes(urlLevel) ? urlLevel : availableLevels[0])
      : '';

  // Teams narrowed to the active level (no-op for single-level events).
  const levelTeams = useMemo(
    () => (level ? event.teams.filter((t) => t.competitionLevel === level) : event.teams),
    [event.teams, level],
  );

  // ── Detect available genders (within the active level) ────────────────
  const availableGenders = useMemo(() => {
    // Merged events: one tab per division USAU published, even before any
    // team is posted (the empty state explains it), in Men/Women/Mixed order.
    if (mergedDivisions) return event.members.map((m) => m.division as string);
    // A pre-teams Club Nationals: the projected field's divisions drive the
    // pills (all three if its read failed).
    if (event.teams.length === 0 && field) {
      return field.status === 'ready'
        ? field.field.divisions.map((d) => d.division as string)
        : [...NATIONALS_DIVISIONS];
    }
    const set = new Set<string>();
    for (const t of levelTeams) {
      if (t.genderDivision) set.add(t.genderDivision);
    }
    return Array.from(set);
  }, [levelTeams, mergedDivisions, event.members, event.teams.length, field]);

  // Source of truth: the global ?div URL param, set by the
  // UsauDivisionSelect dropdown at the top of the page.
  const [division] = useDivision();

  // Decide the active gender filter:
  //   - If the event has the URL-selected gender, use it.
  //   - Otherwise fall back to the event's only/first gender so we don't
  //     hide all content (e.g. ?div=men on a Women's-only sectional).
  const gender =
    availableGenders.includes(division)
      ? division
      : (availableGenders[0] ?? '');

  // Per-division derivation (teams/games filter, pools, brackets, tabs, …) is
  // pulled out into buildDivisionData() below, called once per division by
  // DivisionPager's renderDivision — this component no longer computes it for
  // a single closed-over "active" division.

  // Divisions this event actually fielded, in canonical order — drives the
  // scoped division switcher below (only shown when there's more than one).
  const eventDivisions = (['Men', 'Women', 'Mixed'] as const).filter((d) =>
    availableGenders.includes(d),
  ) as UsauDivision[];

  return (
    <EventTabsView
      event={event}
      level={level}
      availableLevels={availableLevels}
      levelTeams={levelTeams}
      eventDivisions={eventDivisions}
      gender={gender}
      field={field}
    />
  );
}

type ViewTab = 'pools' | 'bracket' | 'leaders' | 'field';

/** A division's view tabs plus FIELD (last) when the projected field shows.
 *  FIELD is the landing tab only when the division has neither pools nor
 *  bracket — the Pools-first rule is unchanged (mobile parity). */
function withFieldTab(
  visibleTabs: Array<{ key: ViewTab; label: string; show: boolean }>,
  defaultTab: ViewTab,
  hasField: boolean,
): { tabs: Array<{ key: ViewTab; label: string; show: boolean }>; defaultTab: ViewTab } {
  if (!hasField) return { tabs: visibleTabs, defaultTab };
  const hasPoolsOrBracket = visibleTabs.some((t) => t.key === 'pools' || t.key === 'bracket');
  return {
    tabs: [...visibleTabs, { key: 'field', label: 'Field', show: true }],
    defaultTab: hasPoolsOrBracket ? defaultTab : 'field',
  };
}

/** Everything derived FOR ONE DIVISION — pools, games, brackets, standings,
 *  and which view tabs it can fill. DivisionPager's renderDivision calls this
 *  for the active division every render, and for the neighbor division mid-
 *  swipe, so it must be a pure function of `division` (not the closed-over
 *  active gender that the pre-pager version relied on). */
function buildDivisionData(event: UsauEventSummary, levelTeams: Team[], division: string) {
  // ── Filter teams + games by gender ────────────────────────────────────
  // (Same logic/comments as the pre-pager version — see git history — just
  // parameterized on `division` instead of the closed-over `gender`.)
  const filteredTeams = division
    ? levelTeams.filter((t) => t.genderDivision === division)
    : levelTeams;
  let teams: Team[];
  let games: Game[];
  if (isMergedSeries(event)) {
    // Exact source tags. Merged siblings reuse bracket names and USAU game-id
    // ranges, so the field-cluster / schedule-block heuristics below would
    // misfile their team-less bracket rows.
    teams = filteredTeams;
    games = event.games.filter((g) => g.division === division);
  } else if (filteredTeams.length === event.teams.length) {
    teams = event.teams;
    games = event.games;
  } else {
    const teamIds = new Set(filteredTeams.map((t) => t.teamId));
    const inDivision = (g: Game) =>
      (g.teamAId != null && teamIds.has(g.teamAId)) ||
      (g.teamBId != null && teamIds.has(g.teamBId));
    const fieldCluster = (loc: string) =>
      loc.trim().toLowerCase().replace(/^(\d+)[a-z]$/, '$1');
    const divisionFields = new Map<string, Set<string>>();
    for (const g of event.games) {
      if (!g.bracketName || !g.location || !inDivision(g)) continue;
      const set = divisionFields.get(g.bracketName) ?? new Set<string>();
      set.add(fieldCluster(g.location));
      divisionFields.set(g.bracketName, set);
    }
    // SCHEDULE-BLOCK FALLBACK (Hunter, 2026-08-22 — ESC showed no Bracket tab).
    // The field-cluster rule needs a SEEDED game in the same bracket_name group,
    // but a pre-tournament bracket has none: at Elite-Select Challenge all 72
    // bracket rows are placeholder-only, pools sit under bracket_name "Pool A–D"
    // while brackets are "Championship"/"Ninth Place Bracket", and most bracket
    // rows have NO location. divisionFields came out empty, every bracket row was
    // dropped, and hasBracket went false — hiding the tab the placeholders exist
    // to fill. Fields can't rescue it: ESC divisions SHARE clusters (11/13/15/24/26).
    //
    // USAU numbers a combined event's schedule in one contiguous block per
    // division, each division's bracket ids running on from its own pool ids
    // (ESC: Women 413987-414034, Mixed 414035-414091, Men 414092+). So a
    // team-less row goes to the division whose seeded games have the nearest id
    // at or below it; late-added tail rows fall to the last block, which is right.
    const idFloor = (pred: (g: Game) => boolean): number | null => {
      let floor: number | null = null;
      for (const g of event.games) {
        if (g.usauGameOrder == null || !pred(g)) continue;
        if (floor == null || g.usauGameOrder < floor) floor = g.usauGameOrder;
      }
      return floor;
    };
    const myFloor = idFloor(inDivision);
    const otherFloors = new Set<number>();
    for (const d of new Set(event.teams.map((t) => t.genderDivision))) {
      if (!d || d === division) continue;
      const ids = new Set(
        event.teams.filter((t) => t.genderDivision === d).map((t) => t.teamId),
      );
      const f = idFloor(
        (g) => (g.teamAId != null && ids.has(g.teamAId)) || (g.teamBId != null && ids.has(g.teamBId)),
      );
      if (f != null) otherFloors.add(f);
    }
    const nextFloor =
      myFloor == null
        ? null
        : Math.min(...[...otherFloors].filter((f) => f > myFloor), Number.POSITIVE_INFINITY);

    games = event.games.filter((g) => {
      if (inDivision(g)) return true;
      if (g.teamAId != null || g.teamBId != null) return false;
      // The division page USAU listed the row on is authoritative. The id-block
      // rule below misfiled 2026 Club Nationals, whose ids run Mixed pools →
      // Women → Mixed bracket → Men, so Mixed lost its Bracket tab and Women
      // showed two brackets. The page only names the GENDER, so on a multi-level
      // event (combined masters) it would pull every level's rows into each level:
      // single-level events only. The heuristics stay for everything else.
      if (g.scheduleDivision && levelTeams.length === event.teams.length) return g.scheduleDivision === division;
      if (g.bracketName && g.location) {
        if (divisionFields.get(g.bracketName)?.has(fieldCluster(g.location))) return true;
      }
      if (myFloor == null || g.usauGameOrder == null) return false;
      return g.usauGameOrder >= myFloor && g.usauGameOrder < (nextFloor ?? Infinity);
    });
    teams = filteredTeams;
  }

  // ── Second-phase pools ("Pool E") ─────────────────────────────────────
  const poolToken = (name: string): string | null => {
    const m = name.trim().toLowerCase().match(/^pool\s+(\S+)/);
    return m ? m[1] : null;
  };
  const assignedPoolTokens = new Set<string>();
  let teamsWithoutPool = 0;
  for (const t of teams) {
    const tok = t.pool ? poolToken(t.pool) : null;
    if (tok) assignedPoolTokens.add(tok);
    else teamsWithoutPool++;
  }
  const poolAssignmentsComplete = assignedPoolTokens.size > 0 && teamsWithoutPool === 0;
  const isSecondPhasePool = (name: string | null | undefined): boolean => {
    if (!name || !poolAssignmentsComplete) return false;
    if (!isPoolBracket(name)) return false;
    const tok = poolToken(bracketTail(name));
    return tok != null && !assignedPoolTokens.has(tok);
  };

  // ── Group-prefix awareness ────────────────────────────────────────────
  const groupPrefixSet = new Set<string>();
  for (const g of games) {
    const p = bracketGroupPrefix(g.bracketName);
    if (p) groupPrefixSet.add(p);
  }
  const showGroupPrefixes = groupPrefixSet.size > 1;
  const bracketLabel = (name: string) => (showGroupPrefixes ? name : bracketTail(name));

  // ── Pools (from filtered teams) ───────────────────────────────────────
  let pools: Array<{ name: string; teams: Team[] }> = [];
  const teamsByPool = new Map<string, Team[]>();
  if (!showGroupPrefixes) {
    for (const t of teams) {
      if (!t.pool) continue;
      if (!teamsByPool.has(t.pool)) teamsByPool.set(t.pool, []);
      teamsByPool.get(t.pool)!.push(t);
    }
  }
  if (teamsByPool.size > 0) {
    pools = Array.from(teamsByPool.entries())
      .map(([name, ts]) => ({
        name,
        teams: ts.slice().sort((a, b) => (a.seed ?? 99) - (b.seed ?? 99)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } else {
    const poolTeamIds = new Map<string, Set<string>>();
    for (const g of games) {
      if (!g.bracketName || !isPoolBracket(g.bracketName)) continue;
      if (!poolTeamIds.has(g.bracketName)) poolTeamIds.set(g.bracketName, new Set());
      if (g.teamAId) poolTeamIds.get(g.bracketName)!.add(g.teamAId);
      if (g.teamBId) poolTeamIds.get(g.bracketName)!.add(g.teamBId);
    }
    const teamById = new Map(teams.map((t) => [t.teamId, t] as const));
    pools = Array.from(poolTeamIds.entries())
      .map(([name, ids]) => ({
        name,
        teams: Array.from(ids)
          .map((id) => teamById.get(id))
          .filter((t): t is Team => !!t)
          .sort((a, b) => (a.seed ?? 99) - (b.seed ?? 99)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ── Placement brackets (filtered games) ───────────────────────────────
  const bracketKey = (g: Game) => g.bracketName ?? 'Bracket';
  const byBracket = new Map<string, Game[]>();
  for (const g of games) {
    if (isPoolBracket(g.bracketName) && !isSecondPhasePool(g.bracketName)) continue;
    if (isMatchupRound(g)) continue;
    if (isChampionshipBracket(g)) continue;
    const k = bracketKey(g);
    if (!byBracket.has(k)) byBracket.set(k, []);
    byBracket.get(k)!.push(g);
  }
  // A group whose name canonicalPlacement can't rank ("Third", first scraped
  // as USAU's generic tab text, landed in the order-999 bucket and rendered
  // BELOW 15th place at the 2026 Elite Select Challenge) still has structure:
  // its teams fell out of the championship somewhere, and that round names the
  // places it decides — semi losers play for 3rd, QF losers for 5th–8th,
  // prequarter losers for 9th+. Derive the order from the participants' exit
  // (+0.5 so a recognized bracket with the same start place sorts first).
  const champLossRound = new Map<string, string>();
  for (const g of games) {
    if (!isChampionshipBracket(g)) continue;
    if (g.round === 'final') continue; // final's loser is 2nd — no placement game
    const winner = gameWinnerId(g);
    if (!winner) continue;
    const loser = winner === g.teamAId ? g.teamBId : g.teamAId;
    if (loser) champLossRound.set(loser, g.round);
  }
  const EXIT_START: Record<string, number> = { semi: 3, quarter: 5, prequarter: 9 };
  const derivedPlacementOrder = (gs: Game[]): number => {
    let best = Number.POSITIVE_INFINITY;
    for (const g of gs) {
      for (const id of [g.teamAId, g.teamBId]) {
        if (!id) continue;
        const start = EXIT_START[champLossRound.get(id) ?? ''];
        if (start != null && start < best) best = start;
      }
    }
    return Number.isFinite(best) ? best + 0.5 : 999;
  };
  // Next fallback: the place USAU's column headings name — "Select Flight Play
  // In" is headed "5th Place Semifinals" / "5th Place Final", so it sits after
  // 3rd Place, where USAU's page puts it (it rendered last pre-tournament).
  const stagePlacementOrder = (gs: Game[]): number | null => {
    const places = gs
      .map((g) => bracketOrder(g.bracketStage ?? ''))
      .filter((o) => o >= 2 && o < 500);
    return places.length > 0 ? Math.min(...places) + 0.5 : null;
  };
  const placementOrder = (name: string, gs: Game[]): number => {
    const o = bracketOrder(name);
    return o === 999 ? (stagePlacementOrder(gs) ?? derivedPlacementOrder(gs)) : o;
  };
  const placementGroups = Array.from(byBracket.entries())
    .map(([name, gs]) => ({
      name,
      games: gs.slice().sort((a, b) => roundOrder(a.round) - roundOrder(b.round)),
    }))
    .sort((a, b) => placementOrder(a.name, a.games) - placementOrder(b.name, b.games));

  // ── Placement pools — round-robin placement groups ("11th Place Pool",
  // "13th Place Round Robin", second-phase "Pool 11-13") render in the Pools
  // tab below the main pools, as standings + games (Hunter, 2026-09-29).
  const teamIndex = new Map(teams.map((t) => [t.teamId, t] as const));
  const placementPools: Array<{
    name: string;
    teams: Team[];
    games: Game[];
    records: Map<string, { wins: number; losses: number; diff: number }>;
  }> = [];
  const placementBrackets: typeof placementGroups = [];
  for (const grp of placementGroups) {
    if (!isPlacementPoolGroup(grp.name, grp.games)) {
      placementBrackets.push(grp);
      continue;
    }
    const records = new Map<string, { wins: number; losses: number; diff: number }>();
    for (const g of grp.games) {
      if (g.status !== 'final' || !g.teamAId || !g.teamBId) continue;
      const winner = gameWinnerId(g);
      if (!winner) continue;
      const loser = winner === g.teamAId ? g.teamBId : g.teamAId;
      const margin = isForfeit(g) ? 0 : Math.abs(g.scoreA! - g.scoreB!);
      const rw = records.get(winner) ?? { wins: 0, losses: 0, diff: 0 };
      records.set(winner, { wins: rw.wins + 1, losses: rw.losses, diff: rw.diff + margin });
      const rl = records.get(loser) ?? { wins: 0, losses: 0, diff: 0 };
      records.set(loser, { wins: rl.wins, losses: rl.losses + 1, diff: rl.diff - margin });
    }
    const ids = new Set(grp.games.flatMap((g) => [g.teamAId, g.teamBId]).filter((id): id is string => !!id));
    placementPools.push({
      name: grp.name,
      teams: [...ids]
        .map((id) => teamIndex.get(id))
        .filter((t): t is Team => !!t)
        .sort((a, b) => (a.seed ?? 99) - (b.seed ?? 99)),
      games: grp.games.slice().sort((a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? '')),
      records,
    });
  }

  // ── Matchup rounds ("Sat Round 1/2/3") — pool-less Saturday phases. ─────
  const roundGroupsMap = new Map<string, Game[]>();
  for (const g of games) {
    if (!isMatchupRound(g)) continue;
    const k = g.bracketName ?? 'Rounds';
    if (!roundGroupsMap.has(k)) roundGroupsMap.set(k, []);
    roundGroupsMap.get(k)!.push(g);
  }
  const roundGroups = Array.from(roundGroupsMap.entries())
    .map(([name, gs]) => ({
      name,
      games: gs.slice().sort((a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? '')),
    }))
    .sort((a, b) => (a.games[0]?.scheduledAt ?? '').localeCompare(b.games[0]?.scheduledAt ?? ''));

  // ── Pool play games ───────────────────────────────────────────────────
  const poolGames = new Map<string, Game[]>();
  for (const g of games) {
    if (!g.bracketName || !isPoolBracket(g.bracketName)) continue;
    if (isSecondPhasePool(g.bracketName)) continue;
    if (!poolGames.has(g.bracketName)) poolGames.set(g.bracketName, []);
    poolGames.get(g.bracketName)!.push(g);
  }
  for (const gs of poolGames.values()) {
    gs.sort((a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''));
  }

  // ── Pool-play records (per team, from that pool's completed games) ──────
  const normName = (n: string | null | undefined) => (n ?? '').trim().toLowerCase();
  const nameRecords = new Map<string, { wins: number; losses: number; diff: number; name: string }>();
  const seenGameKeys = new Set<string>();
  for (const gs of poolGames.values()) {
    for (const g of gs) {
      if (g.status !== 'final') continue;
      const winner = gameWinnerId(g);
      if (!winner) continue;
      const na = normName(g.teamAName);
      const nb = normName(g.teamBName);
      if (!na || !nb) continue;
      const aWon = winner === g.teamAId;
      const pair = [na, nb].sort();
      const scores = isForfeit(g) ? ['F', aWon ? na : nb] : [g.scoreA!, g.scoreB!].sort((x, y) => x - y);
      const gkey = `${pair[0]}|${pair[1]}|${scores[0]}|${scores[1]}`;
      if (seenGameKeys.has(gkey)) continue;
      seenGameKeys.add(gkey);

      const winName = aWon ? na : nb;
      const loseName = aWon ? nb : na;
      const winDisplay = aWon ? (g.teamAName ?? '') : (g.teamBName ?? '');
      const loseDisplay = aWon ? (g.teamBName ?? '') : (g.teamAName ?? '');
      // A forfeit is a W/L with 0 point diff — USAU's own tiebreak math.
      const margin = isForfeit(g) ? 0 : Math.abs(g.scoreA! - g.scoreB!);
      const rw = nameRecords.get(winName) ?? { wins: 0, losses: 0, diff: 0, name: winDisplay };
      rw.wins += 1;
      rw.diff += margin;
      nameRecords.set(winName, rw);
      const rl = nameRecords.get(loseName) ?? { wins: 0, losses: 0, diff: 0, name: loseDisplay };
      rl.losses += 1;
      rl.diff -= margin;
      nameRecords.set(loseName, rl);
    }
  }
  const poolRecords = new Map<string, { wins: number; losses: number; diff: number }>();
  for (const t of teams) {
    const rec = nameRecords.get(normName(t.teamName));
    if (rec) poolRecords.set(t.teamId, { wins: rec.wins, losses: rec.losses, diff: rec.diff });
  }

  // ── Championship finals (for the top-of-page result banners) ───────────
  const championshipGames = games.filter(isChampionshipBracket);
  const isDecided = (g: Game) => {
    const status = g.status.toLowerCase();
    if (status === 'forfeit') return true;
    if (status !== 'final') return false;
    return gameWinnerId(g) != null;
  };

  const explicitFinals = championshipGames.filter((g) => g.round === 'final' && isDecided(g));
  // Groups with no tagged final: a structural decider (needs no semis, so it
  // also covers a lone-game "Finals" section like 2026 SC Mixed).
  const structuralFinals = championshipGames.filter(
    (g) =>
      g.round !== 'final' &&
      isStructuredTitleDecider(g) &&
      isDecided(g) &&
      !explicitFinals.some((f) => bracketGroupPrefix(f.bracketName) === bracketGroupPrefix(g.bracketName)),
  );

  const byGroupSemis = new Map<string, Game[]>();
  for (const g of championshipGames) {
    if (g.round !== 'semi') continue;
    const k = bracketGroupPrefix(g.bracketName);
    if (!byGroupSemis.has(k)) byGroupSemis.set(k, []);
    byGroupSemis.get(k)!.push(g);
  }
  const recoveredFinals: Game[] = [];
  for (const [k, semis] of byGroupSemis) {
    if ([...explicitFinals, ...structuralFinals].some((g) => bracketGroupPrefix(g.bracketName) === k)) continue;
    const semiWinners = new Set(
      semis
        .map((g) => gameWinnerId(g))
        .filter((id): id is string => !!id),
    );
    const recovered = championshipGames.find(
      (g) =>
        g.round !== 'prequarter' && g.round !== 'quarter' && g.round !== 'semi' && g.round !== 'final' &&
        bracketGroupPrefix(g.bracketName) === k &&
        !!g.teamAId && !!g.teamBId &&
        semiWinners.has(g.teamAId) && semiWinners.has(g.teamBId) &&
        isDecided(g),
    );
    if (recovered) recoveredFinals.push(recovered);
  }

  const finals = [...explicitFinals, ...structuralFinals, ...recoveredFinals];
  const byGroup = new Map<string, Game>();
  for (const g of finals) {
    const k = bracketGroupPrefix(g.bracketName);
    const prev = byGroup.get(k);
    if (!prev || (g.scheduledAt ?? '') > (prev.scheduledAt ?? '')) byGroup.set(k, g);
  }
  const champFinals = Array.from(byGroup.entries())
    .map(([label, game]) => ({ label, game }))
    .sort((a, b) => a.label.localeCompare(b.label));

  // ── Pool leader (fallback winner when there's no bracket final) ─────────
  let poolLeader: { team: Team; wins: number; losses: number } | null = null;
  if (champFinals.length === 0) {
    const teamByName = new Map(teams.map((t) => [normName(t.teamName), t] as const));
    const standings = Array.from(nameRecords.values())
      .map((r) => ({ team: teamByName.get(normName(r.name)) ?? null, name: r.name, wins: r.wins, losses: r.losses }))
      .sort((a, b) => b.wins - a.wins || a.losses - b.losses);
    const top = standings[0];
    if (top && !(top.wins === 0 && top.losses === 0) && top.team) {
      const tiedForFirst = standings.filter(
        (s) => s.wins === top.wins && s.losses === top.losses,
      ).length;
      if (tiedForFirst <= 1) poolLeader = { team: top.team, wins: top.wins, losses: top.losses };
    }
  }

  // ── View tabs (#6): Pools / Bracket ──────────────────────────────────────
  // The Bracket tab shows as soon as USAU publishes the bracket SHAPE — before
  // any team is seeded into it. USAU's own page draws the full structure with
  // "P1 of Pool A" / "W of Quarterfinals G1" placeholders pre-tournament, and
  // the tree already renders those (completeBracket). Gating on a real team id
  // hid the whole tab until Sunday (Hunter, 2026-08-21).
  const hasBracket =
    games.some((g) => isChampionshipBracket(g)) || placementBrackets.length > 0;
  // Pools shows whenever the division has teams: a bracket-only event falls
  // back to an "All Teams" list by seed (mobile parity, Hunter 2026-10-02).
  const hasPools =
    pools.length > 0 || poolGames.size > 0 || roundGroups.length > 0 || placementPools.length > 0 || teams.length > 0;

  // ── Leaders (goals/assists) — this division's slice of event.playerStats,
  // scoped by team id since stats rows carry a team, not a division. Sorted
  // G+A desc, then goals, matching the EUCS leaders page. USAU only publishes
  // these at flagship events, so `leaderRows` is empty for the vast majority
  // of events — the tab simply doesn't show then.
  const divisionTeamIds = new Set(teams.map((t) => t.teamId));
  const leaderRows = event.playerStats
    .filter((r) => r.teamId != null && divisionTeamIds.has(r.teamId))
    .map((r) => ({ ...r, teamName: r.teamId ? (teamById(teams, r.teamId)?.teamName ?? null) : null }))
    .sort((a, b) => (b.goals + b.assists - (a.goals + a.assists)) || (b.goals - a.goals));
  const hasLeaders = leaderRows.length > 0;

  const TABS: Array<{ key: ViewTab; label: string; show: boolean }> = [
    { key: 'pools',      label: 'Pools',      show: hasPools },
    { key: 'bracket',    label: 'Bracket',    show: hasBracket },
    { key: 'leaders',    label: 'Leaders',    show: hasLeaders },
  ];
  const visibleTabs = TABS.filter((t) => t.show);
  // Always land on Pools when it exists — a returning visitor gets the tab they
  // left off on instead (useRememberedEventView; Hunter, 2026-10-03).
  const defaultTab: ViewTab = visibleTabs[0]?.key ?? 'pools';

  return {
    teams, games, showGroupPrefixes, bracketLabel, pools, placementBrackets, placementPools,
    roundGroups, poolGames, poolRecords, champFinals, poolLeader, leaderRows,
    visibleTabs, defaultTab,
  };
}

/** Small lookup helper — `teams` is a per-division array, not a Map, since
 *  most callers just iterate it; the leaders table is the one place that
 *  needs a team name by id. */
function teamById(teams: Team[], teamId: string): Team | undefined {
  return teams.find((t) => t.teamId === teamId);
}

/**
 * Presentational tabbed body. Split out from UsauEventDetail so it can hold the
 * active-tab useState without complicating the data-derivation parent. Banners
 * + level/division switchers stay ABOVE the tabs; the four tab views render the
 * previously-stacked sections one at a time.
 */
function EventTabsView(props: {
  event: UsauEventSummary;
  level: UsauLevel | '';
  availableLevels: UsauLevel[];
  levelTeams: Team[];
  eventDivisions: UsauDivision[];
  gender: string;
  field: NationalsFieldState | null;
}) {
  const { event, level, availableLevels, levelTeams, eventDivisions, gender, field } = props;

  // Tab lives in the URL (?tab=) so back-nav from a team page and hard refresh
  // both keep it (Hunter ruling 2026-08-16; div/level were already URL-backed).
  const [tabParam, setTabParam] = useViewParam('tab');
  const [, setDivision] = useDivision();
  useRememberedEventView();
  const tabRequested =
    tabParam === 'pools' || tabParam === 'bracket' || tabParam === 'leaders' || tabParam === 'field'
      ? tabParam
      : null;

  const activeGender = eventDivisions.includes(gender as UsauDivision)
    ? (gender as UsauDivision)
    : null;

  // The ACTIVE division's view tabs render in the shared control row (left of
  // the division pills — Hunter's tournament-header layout, 2026-08-20), so
  // they're derived here rather than inside the per-division content.
  // buildDivisionData is pure and memoized; DivisionContent still runs it per
  // rendered division for the sections themselves.
  const effectiveDivision = activeGender ?? eventDivisions[0] ?? '';
  const divisionData = useMemo(
    () => buildDivisionData(event, levelTeams, effectiveDivision),
    [event, levelTeams, effectiveDivision],
  );
  const { tabs: visibleTabs, defaultTab } = withFieldTab(divisionData.visibleTabs, divisionData.defaultTab, field != null);
  const activeTab: ViewTab =
    tabRequested != null && visibleTabs.some((t) => t.key === tabRequested)
      ? tabRequested
      : defaultTab;

  return (
    <>
      {/* Row 1 — Level select (right), only when the event fielded 2+
          (combined masters championships; writes the URL param read via
          useLevel() above). The Division switcher moved below the view tabs as
          centered pills (DivisionPager), mirroring the mobile app's layout.
          The source link and the venue live in the page header's controls
          slot (Hunter, 2026-08-22 / 2026-10-07) — see the route file. */}
      {availableLevels.length > 1 && (
        <div className="mb-6 flex items-center justify-end gap-3">
          <span className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight">
            Level
          </span>
          <UsauLevelSelect
            restrictTo={availableLevels}
            value={level || undefined}
          />
        </div>
      )}

      {/* Centered division pills + swipeable division content — tap a pill or
          swipe the content left/right on touch to change division (ported
          from the mobile app; replaces the header's Division dropdown).
          Writes the same ?div= URL param. renderDivision is called for the
          active division every render, AND for the neighbor division while a
          swipe is in flight (live preview), so every per-division value
          (pools/games/brackets/tabs) is derived fresh per call via
          buildDivisionData/DivisionContent — nothing here closes over a
          single "active" division anymore. */}
      <DivisionPager
        divisions={eventDivisions.map((d) => ({ value: d, label: d }))}
        active={activeGender}
        onChange={setDivision}
        // Always passed, even for a one-tab division: without it the pager
        // lays the division pills out compact and centered, so switching into
        // a pools-only or bracket-only division resized the switcher.
        tabRowLeading={
            <div role="tablist" aria-label="Tournament views" className="flex items-center justify-between gap-5 lg:justify-start">
              {visibleTabs.map((t) => {
                const on = t.key === activeTab;
                return (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={(e) => {
                      setTabParam(t.key);
                      scrollToSectionTop(e.currentTarget);
                    }}
                    className={[
                      'flex-1 lg:flex-none flex justify-center lg:justify-start whitespace-nowrap',
                      'text-[12px] font-bold tracking-[0.1em] uppercase font-tight cursor-pointer',
                      'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      on ? 'text-ink' : 'text-muted hover:text-ink',
                    ].join(' ')}
                  >
                    <span className={['pb-1 border-b-2 transition-colors', on ? 'border-accent' : 'border-transparent'].join(' ')}>
                      {t.label}
                    </span>
                  </button>
                );
              })}
            </div>
        }
        renderDivision={(division) => (
          <DivisionContent
            event={event}
            level={level}
            levelTeams={levelTeams}
            division={division}
            tabRequested={tabRequested}
            field={field}
          />
        )}
        contentClassName="flex flex-col gap-6"
      />
    </>
  );
}

/** One division's full body: champion/pool-leader banners and the active
 *  tab's content — parameterized by `division` so DivisionPager can render it
 *  for any division (not just the globally-active one). The view-tab row
 *  itself lives up in EventTabsView's shared control row. */
function DivisionContent({
  event,
  level,
  levelTeams,
  division,
  tabRequested,
  field,
}: {
  event: UsauEventSummary;
  level: UsauLevel | '';
  levelTeams: Team[];
  division: string;
  tabRequested: ViewTab | null;
  field: NationalsFieldState | null;
}) {
  const {
    teams, games, showGroupPrefixes, bracketLabel, pools, placementBrackets, placementPools,
    roundGroups, poolGames, poolRecords, champFinals, poolLeader, leaderRows,
    visibleTabs: divisionTabs, defaultTab: divisionDefault,
  } = useMemo(
    () => buildDivisionData(event, levelTeams, division),
    [event, levelTeams, division],
  );
  const { tabs: visibleTabs, defaultTab } = withFieldTab(divisionTabs, divisionDefault, field != null);

  // A tab requested via the URL only applies here when THIS division can fill
  // it — otherwise this division falls back to its OWN first-filled tab, not
  // whatever tab another division resolved to (fixes a blank swipe-preview
  // when swiping into a division lacking the currently-active tab's content).
  const active: ViewTab =
    tabRequested != null && visibleTabs.some((t) => t.key === tabRequested)
      ? tabRequested
      : defaultTab;

  return (
    <>
      {/* Champion banner — leads the page for a finished tournament so the
          title result is the first thing seen (esp. on mobile, where the
          bracket tree scrolls horizontally and hides the final). */}
      {champFinals.map(({ label, game }) => (
        <ChampionBanner
          key={game.id}
          game={game}
          label={showGroupPrefixes ? label || null : null}
          competitionLevel={level || event.competitionLevel}
          genderDivision={division || null}
          season={event.season}
        />
      ))}

      {/* Pool leader — shown for a pool-play-only division (no bracket final).
          The best (unique) pool record is the de-facto winner. */}
      {champFinals.length === 0 && poolLeader && (
        <PoolLeaderBanner
          team={poolLeader.team}
          wins={poolLeader.wins}
          losses={poolLeader.losses}
          competitionLevel={level || event.competitionLevel}
          season={event.season}
        />
      )}

      {/* View tabs render in the shared control row up in EventTabsView
          (DivisionPager's tabRowLeading) — this content keeps only its own
          per-division `active` fallback. */}

      {/* ── Pools — standings cards + per-pool game lists (merged) ───────── */}
      {active === 'pools' && (
        <section aria-labelledby="pools-heading" className="flex flex-col gap-8">
          <h2 id="pools-heading" className="sr-only">Pools</h2>

          {/* Standings cards, each with its games merged in behind a
              collapsed-by-default disclosure (mobile parity). */}
          {pools.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              {pools.map((pool) => (
                <PoolCard
                  key={pool.name}
                  pool={{ name: bracketLabel(pool.name), teams: pool.teams }}
                  competitionLevel={level || event.competitionLevel}
                  records={poolRecords}
                  games={poolGames.get(pool.name) ?? []}
                  venueState={venueKeyFor(event, division)}
                  season={event.season}
                />
              ))}
            </div>
          )}

          {/* Desktop: full per-pool schedule tables beneath the standings row,
              matching USAU's own event page (Hunter, 2026-08-22). The cards
              above hide their "Games" disclosure at lg+ so the schedule lives
              in exactly one place; below lg the disclosure carries it, because
              a 7-column table doesn't fit a phone. */}
          {pools.length > 0 && poolGames.size > 0 && (
            <div className="hidden lg:flex flex-col gap-4">
              {pools.map((pool) => (
                <PoolScheduleTable
                  key={pool.name}
                  poolName={bracketLabel(pool.name)}
                  games={poolGames.get(pool.name) ?? []}
                  venueState={venueKeyFor(event, division)}
                  season={event.season}
                />
              ))}
            </div>
          )}

          {pools.length > 0 && poolGames.size === 0 && <PoolGamesEmpty slug={usauSlugFor(event, division)} />}

          {pools.length === 0 && teams.length > 0 && (
            <AllTeamsCard teams={teams} competitionLevel={level || event.competitionLevel} season={event.season} />
          )}

          {/* Matchup rounds — pool-less Saturday phases ("Sat Round 1/2/3"),
              folded into Pool Play as generic sections below the pools. */}
          {roundGroups.length > 0 && (
            <div className="flex flex-col gap-5">
              {roundGroups.map((grp) => (
                <section key={grp.name} aria-label={grp.name}>
                  <h2 className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight pb-2 border-b border-hairline">
                    {grp.name}
                  </h2>
                  <ul className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
                    {grp.games.map((g) => (
                      <GameRow key={g.id} game={g} venueState={venueKeyFor(event, division)} season={event.season} />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}

          {/* Placement pools — round-robin placement groups, pulled out of the
              Bracket tab so their records and scores read like pool play. */}
          {placementPools.length > 0 && (
            <section aria-labelledby="placement-pools-heading" className="flex flex-col gap-3">
              <h2
                id="placement-pools-heading"
                className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight pb-2 border-b border-hairline"
              >
                Placement Pools
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                {placementPools.map((pp) => (
                  <PoolCard
                    key={pp.name}
                    pool={{ name: bracketLabel(pp.name), teams: pp.teams }}
                    competitionLevel={level || event.competitionLevel}
                    records={pp.records}
                    games={pp.games}
                    venueState={venueKeyFor(event, division)}
                    season={event.season}
                  />
                ))}
              </div>
              <div className="hidden lg:flex flex-col gap-4 mt-5">
                {placementPools.map((pp) => (
                  <PoolScheduleTable
                    key={pp.name}
                    poolName={bracketLabel(pp.name)}
                    games={pp.games}
                    venueState={venueKeyFor(event, division)}
                    season={event.season}
                  />
                ))}
              </div>
            </section>
          )}
        </section>
      )}

      {/* ── Bracket — championship tree, then every placement group stacked ─ */}
      {active === 'bracket' && (
        <BracketView
          games={games}
          teams={teams}
          placementBrackets={placementBrackets}
          bracketLabel={bracketLabel}
          venueState={venueKeyFor(event, division)}
          season={event.season}
        />
      )}

      {/* ── Leaders — goals/assists, published for flagship events only ──── */}
      {active === 'leaders' && <LeadersTable rows={leaderRows} season={event.season} />}

      {/* ── Field — projected Club Nationals qualifiers, pre-teams only ───── */}
      {active === 'field' && field && <NationalsFieldPanel state={field} division={division} season={event.season} />}

      {visibleTabs.length === 0 && (
        <div className="text-[12px] text-faint font-tight">
          {games.length > 0
            ? 'Schedule published, matchups not set yet — teams are seeded once pool play begins.'
            : 'No pool or bracket data scraped for this event yet.'}
        </div>
      )}
    </>
  );
}

/**
 * "Bracket" tab body: the championship tree FIRST, then every placement
 * group stacked below it, ascending by place (3rd → 5th → 7th → 9th …).
 * Each placement group renders as its own tree when it's genuinely
 * multi-round (label reads "bracket", or its games span ≥2 of
 * prequarter/quarter/semi plus a decider); otherwise it's a flat list of
 * game cards. When there's no championship tree at all, everything falls
 * back to the pre-existing flat grouped list (never double-rendered against
 * the tree-plus-stack path above).
 */
function BracketView({
  games,
  teams,
  placementBrackets,
  bracketLabel,
  venueState,
  season,
}: {
  games: Game[];
  teams: Team[];
  placementBrackets: Array<{ name: string; games: Game[] }>;
  bracketLabel: (name: string) => string;
  venueState: string | null;
  season?: number | null;
}) {
  const hasTree = games.some((g) => isChampionshipBracket(g));

  // Placement groups already arrive sorted ascending by place (bracketOrder,
  // via canonicalPlacement) from the parent. Decide tree-vs-flat per group.
  const renderGroups = useMemo(
    () =>
      placementBrackets.map((bracket) => ({
        bracket,
        isTree: isDerivableBracketGroup(bracket.name, bracket.games),
      })),
    [placementBrackets],
  );

  if (!hasTree) {
    // No championship tree at all — keep the existing flat grouped fallback.
    return (
      <div className="flex flex-col gap-7">
        {placementBrackets.map((bracket) => (
          <BracketBlock
            key={bracket.name}
            bracket={{ name: bracketLabel(bracket.name), games: bracket.games }}
            venueState={venueState}
            season={season}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-9">
      <UsauBracketTree games={games} teams={teams} venueState={venueState} season={season} />

      {renderGroups.length > 0 && (
        <div className="flex flex-col gap-7">
          {renderGroups.map(({ bracket, isTree }) =>
            isTree ? (
              <PlacementTree
                key={bracket.name}
                label={bracketLabel(bracket.name)}
                games={bracket.games}
                venueState={venueState}
                season={season}
              />
            ) : (
              <BracketBlock
                key={bracket.name}
                bracket={{ name: bracketLabel(bracket.name), games: bracket.games }}
                venueState={venueState}
                season={season}
                treeSized
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** One division's scoring leaders — Player · Team · G · A · Pts, sorted by
 *  G+A desc then goals (same order buildDivisionData already sorted `rows`
 *  in, so this just renders). Reuses the column layout of the EUCS leaders
 *  page (/euf/events/[slug]/leaders); styled to this file's own tokens.
 *  `overflow-x-auto` keeps a 5-column table off the page's own horizontal
 *  scroll on a 390px screen — the table scrolls, the page doesn't. */
function LeadersTable({
  rows,
  season,
}: {
  rows: Array<{ playerId: string; playerName: string; teamId: string | null; teamName: string | null; goals: number; assists: number }>;
  season?: number | null;
}) {
  if (rows.length === 0) {
    return (
      <div className="text-[12px] text-faint font-tight">
        No player stats published for this division yet.
      </div>
    );
  }
  const thBase = 'py-2.5 text-[10px] font-bold tracking-[0.12em] uppercase text-muted font-tight whitespace-nowrap';
  const tdBase = 'py-2.5 text-[13px] font-tight whitespace-nowrap';
  return (
    <section aria-labelledby="leaders-heading" className="bg-surface rounded-card shadow-card overflow-hidden">
      <h2 id="leaders-heading" className="sr-only">Scoring leaders</h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] border-collapse">
          <thead>
            <tr className="border-b border-hairline">
              <th scope="col" className={`${thBase} text-left pl-4 pr-2`}>Player</th>
              <th scope="col" className={`${thBase} text-left px-2`}>Team</th>
              <th scope="col" className={`${thBase} text-right px-2`}>G</th>
              <th scope="col" className={`${thBase} text-right px-2`}>A</th>
              <th scope="col" className={`${thBase} text-right pr-4 pl-2`}>Pts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={`${r.teamId}-${r.playerId}-${i}`}
                className={i > 0 ? 'border-t border-hairline' : ''}
              >
                <td className={`${tdBase} pl-4 pr-2`}>
                  <Link
                    href={`/players/${r.playerId}`}
                    prefetch={false}
                    className="inline-flex items-center min-h-[44px] text-ink hover:text-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
                  >
                    {r.playerName}
                  </Link>
                </td>
                <td className={`${tdBase} px-2 text-muted`}>
                  {r.teamId && r.teamName ? (
                    <Link
                      href={season != null ? `/usau/teams/${r.teamId}?season=${season}` : `/usau/teams/${r.teamId}`}
                      prefetch={false}
                      className="inline-flex items-center min-h-[44px] text-muted hover:text-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded truncate max-w-[220px]"
                    >
                      {r.teamName}
                    </Link>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
                <td className={`${tdBase} px-2 text-right tabular text-ink`}>{r.goals}</td>
                <td className={`${tdBase} px-2 text-right tabular text-muted`}>{r.assists}</td>
                <td className={`${tdBase} pr-4 pl-2 text-right tabular text-ink font-bold`}>
                  {r.goals + r.assists}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// A placement group derives a tree (instead of the flat chronological list)
// when either:
//   (a) its label contains "bracket" ("Ninth Place Bracket", "Thirteenth
//       Place Bracket") — USAU's own signal that it's bracket-shaped, or
//   (b) its games actually span ≥2 distinct rounds from prequarter/quarter/
//       semi PLUS a deciding game — e.g. "Fifth Place Bracket" carries semis
//       + final without "bracket" always appearing verbatim upstream.
// A single-game placement final ("Eleventh Place", "Fifteenth Place") hits
// neither condition and stays flat — a 2-team tree would just be a game
// card with extra steps. Mirrors mobile's isDerivableBracketGroup.
const CHAIN_ROUNDS_FOR_TREE = ['prequarter', 'quarter', 'semi'];

function isDerivableBracketGroup(label: string, games: Game[]): boolean {
  // Scraped structure (2026-09-13) settles it outright: the group is a tree
  // when USAU drew it with two or more columns. One column is a lone decider
  // ("5th Place Game") and stays a flat card.
  if (hasBracketStructure(games)) {
    return new Set(games.map((g) => g.bracketStageIndex).filter((i) => i != null)).size >= 2;
  }
  // The tree only builds columns from tree rounds, so a "… Bracket" group made
  // entirely of round='placement' games (2026 West Plains Men's Second/Fifth
  // Place Bracket) rendered its heading over an empty tree. Those go flat.
  if (label.toLowerCase().includes('bracket')) {
    return games.some((g) => [...CHAIN_ROUNDS_FOR_TREE, 'final'].includes(g.round));
  }
  const chainRoundsPresent = new Set(
    games.map((g) => g.round).filter((r) => CHAIN_ROUNDS_FOR_TREE.includes(r)),
  );
  if (chainRoundsPresent.size < 2) return false;
  // A deciding game: an explicit final, or an 'other'/'placement'-tagged game
  // riding along with the chain rounds — buildColumns recovers either as the
  // final. USAU stores a placement bracket's decider as 'placement' ("6th
  // Place (Game to Go)" under quarters + semis, Rocky Mountain 2026), which
  // this gate used to reject, flattening the whole bracket.
  return games.some((g) => g.round === 'final' || g.round === 'other' || g.round === 'placement');
}

/** Renders one placement group as its own bracket tree, labeled by our own
 *  heading (the shared championship-tree component owns the "Championship
 *  bracket" heading, so placement groups use the headless variant). */
function PlacementTree({
  label,
  games,
  venueState,
  season,
}: {
  label: string;
  games: Game[];
  venueState: string | null;
  season?: number | null;
}) {
  return (
    <div>
      <h3 className="font-display italic font-bold text-[22px] leading-tight tracking-[-0.02em] text-ink mb-3">
        {label}
      </h3>
      <UsauPlacementBracketTree games={games} venueState={venueState} season={season} />
    </div>
  );
}

function PoolGamesEmpty({ slug }: { slug: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-card-sm bg-ink/[0.03]">
      <span className="text-[11px] font-tight text-muted">
        Pool play games not available in our data — likely scored before our
        scraper picked up this event.
      </span>
      <a
        href={`https://play.usaultimate.org/events/${slug}/`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-[10px] font-bold tracking-[0.14em] uppercase font-tight text-accent hover:underline whitespace-nowrap no-underline"
      >
        View on USAU
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M4 2h6v6M10 2L4 8M2 4v6h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </a>
    </div>
  );
}

function ChampionBanner({
  game,
  label,
  competitionLevel,
  genderDivision,
  season,
}: {
  game: Game;
  /** Bracket-group qualifier ("GGM Women") when the view holds multiple
   *  independent championship brackets; null on single-group views. */
  label?: string | null;
  competitionLevel: string;
  genderDivision: string | null;
  /** Event season → `?season=` on team links, so a team clicked from a 2014
   *  tournament opens its 2014 page. See UsauTeamHistory's param read. */
  season?: number | null;
}) {
  const aWon = gameWinnerId(game) === game.teamAId;
  const winnerName = aWon ? game.teamAName : game.teamBName;
  const winnerId = aWon ? game.teamAId : game.teamBId;
  const loserName = aWon ? game.teamBName : game.teamAName;
  const winScore = aWon ? game.scoreA : game.scoreB;
  const loseScore = aWon ? game.scoreB : game.scoreA;
  const resultLabel = isForfeit(game) ? 'forfeit' : `${winScore}–${loseScore}`;

  const WinnerInner = (
    <span className="flex items-center gap-3 min-w-0">
      <UsauTeamLogo name={winnerName ?? ''} genderDivision={genderDivision} competitionLevel={competitionLevel} size={40} />
      <span className="flex flex-col min-w-0">
        <span className="font-display italic font-bold text-[20px] lg:text-[24px] leading-none tracking-[-0.02em] text-ink truncate pr-[0.1em] pb-[0.12em] -mb-[0.12em]">
          {winnerName ?? '—'}
        </span>
        {loserName && (
          <span className="text-[11px] text-muted font-tight truncate mt-1">
            def. {loserName} · {resultLabel}
          </span>
        )}
      </span>
    </span>
  );

  return (
    <section
      aria-label="Champion"
      className="mb-6 rounded-card-lg shadow-card bg-surface overflow-hidden"
    >
      {/* accent tint / trophy row */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-hairline bg-accent/[0.06]">
        <TrophyIcon />
        <span className="text-[10px] font-bold tracking-[0.18em] uppercase text-accent font-tight">
          Champion{label ? ` · ${label}` : ''}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3 px-4 py-4">
        {winnerId ? (
          <Link
            href={season != null ? `/usau/teams/${winnerId}?season=${season}` : `/usau/teams/${winnerId}`}
            className="min-w-0 flex-1 hover:opacity-80 transition-opacity no-underline"
          >
            {WinnerInner}
          </Link>
        ) : (
          <span className="min-w-0 flex-1">{WinnerInner}</span>
        )}
      </div>
    </section>
  );
}

function PoolLeaderBanner({
  team,
  wins,
  losses,
  competitionLevel,
  season,
}: {
  team: Team;
  wins: number;
  losses: number;
  competitionLevel: string;
  season?: number | null;
}) {
  const Inner = (
    <span className="flex items-center gap-3 min-w-0">
      <UsauTeamLogo
        name={team.teamName}
        genderDivision={team.genderDivision}
        competitionLevel={competitionLevel}
        size={40}
      />
      <span className="flex flex-col min-w-0">
        <span className="font-display italic font-bold text-[20px] lg:text-[24px] leading-none tracking-[-0.02em] text-ink truncate pr-[0.1em] pb-[0.12em] -mb-[0.12em]">
          {team.teamName}
        </span>
        <span className="text-[11px] text-muted font-tight truncate mt-1">
          Best pool record · <span className="tabular">{wins}–{losses}</span>
        </span>
      </span>
    </span>
  );

  return (
    <section
      aria-label="Pool leader"
      className="mb-6 rounded-card-lg shadow-card bg-surface overflow-hidden"
    >
      <div className="flex items-center gap-2 px-4 py-2 border-b border-hairline bg-accent/[0.06]">
        <TrophyIcon />
        <span className="text-[10px] font-bold tracking-[0.18em] uppercase text-accent font-tight">
          Pool leader
        </span>
      </div>
      <div className="flex items-center justify-between gap-3 px-4 py-4">
        <Link
          href={season != null ? `/usau/teams/${team.teamId}?season=${season}` : `/usau/teams/${team.teamId}`}
          className="min-w-0 flex-1 hover:opacity-80 transition-opacity no-underline"
        >
          {Inner}
        </Link>
      </div>
    </section>
  );
}

function TrophyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="flex-shrink-0">
      <path
        d="M4 2h8v3a4 4 0 01-8 0V2zM4 3H2v1a2 2 0 002 2M12 3h2v1a2 2 0 01-2 2M6 9.5V11m4-1.5V11M5 14h6M6.5 11h3l.5 3h-4l.5-3z"
        stroke="rgb(var(--accent))"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Pools-tab fallback for a division with no pools (bracket-only events):
 *  every team by seed, in PoolCard's row style. Column-major on wider screens
 *  so the ranking still reads top-to-bottom. Final placements are
 *  all-or-nothing per division (mobile parity, Hunter 2026-10-02): the
 *  derivation leaves ambiguous teams unplaced, and a partial column reads as
 *  wrong. */
function AllTeamsCard({
  teams,
  competitionLevel,
  season,
}: {
  teams: Team[];
  competitionLevel: string;
  season?: number | null;
}) {
  const sorted = teams.slice().sort((a, b) => (a.seed ?? 9999) - (b.seed ?? 9999));
  const showPlacement = sorted.every((t) => t.finalPlacement != null);
  return (
    <div className="bg-surface rounded-card shadow-card overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="text-[10px] font-bold tracking-[0.18em] uppercase text-ink font-tight">All Teams</span>
        <span className="tabular text-[11px] font-bold text-muted font-tight">{sorted.length}</span>
      </div>
      <ul className="md:columns-2 lg:columns-3 md:gap-x-0">
        {sorted.map((t, i) => (
          <li key={t.teamId} className="border-t border-hairline break-inside-avoid">
            <Link
              href={season != null ? `/usau/teams/${t.teamId}?season=${season}` : `/usau/teams/${t.teamId}`}
              className="flex items-center gap-3 px-4 py-2.5 hover:bg-ink/[0.03] transition-colors no-underline"
            >
              <span className="tabular text-[11px] font-bold text-faint font-tight w-5 text-right flex-shrink-0">
                {t.seed ?? i + 1}
              </span>
              <UsauTeamLogo
                name={t.teamName}
                genderDivision={t.genderDivision}
                competitionLevel={competitionLevel}
                size={20}
              />
              <span className="flex-1 min-w-0 text-[13px] font-semibold text-ink font-tight truncate">
                {t.teamName}
              </span>
              {showPlacement && (
                <span className="tabular font-display italic font-bold text-[14px] text-accent flex-shrink-0">
                  #{t.finalPlacement}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PoolCard({
  pool,
  competitionLevel,
  records,
  games,
  venueState,
  season,
}: {
  pool: { name: string; teams: Team[] };
  competitionLevel: string;
  season?: number | null;
  records: Map<string, { wins: number; losses: number; diff: number }>;
  /** That pool's games, sorted by scheduled time — rendered in a collapsed-
   *  by-default "Games" disclosure beneath the standings (mobile parity:
   *  per-pool games merge under the pool's standings card). */
  games: Game[];
  venueState?: string | null;
}) {
  // Rank by pool record when we have any completed games — the incoming team
  // order is by seed, which stays as the final tiebreak within equal records.
  const anyRecords = pool.teams.some((t) => t.teamId && records.has(t.teamId));

  // USAU breaks a tied record on point differential in the games AMONG THE
  // TIED TEAMS ONLY — not overall pool diff. Sorting on overall diff let a team
  // win a pool on a blowout against the bottom seed instead of on who beat whom
  // (ESC 2026 Women's Pool A: a genuine 3-way tie at 2-1 put Flipside on top
  //  purely for its 15-5 over last-place Siege, when Pop had beaten Flipside
  //  head to head — Hunter/mobile session, 2026-08-22).
  //
  // Computed per tie GROUP: a mini-diff is meaningless outside a team's own
  // group, and grouping keeps this inert when nothing is tied. Overall diff
  // stays as the NEXT tiebreak, which is what separates two teams that are
  // still level after their head-to-head (Flipside -1 vs Parcha -1 → +9 vs +4).
  const miniDiff = useMemo(() => {
    const out = new Map<string, number>();
    if (!anyRecords) return out;

    const byRecord = new Map<string, string[]>();
    for (const t of pool.teams) {
      if (!t.teamId) continue;
      const r = records.get(t.teamId);
      if (!r) continue;
      const k = `${r.wins}-${r.losses}`;
      const list = byRecord.get(k);
      if (list) list.push(t.teamId);
      else byRecord.set(k, [t.teamId]);
    }

    for (const ids of byRecord.values()) {
      if (ids.length < 2) continue; // not a tie — leave every member at 0
      const tied = new Set(ids);
      for (const id of ids) out.set(id, 0);
      for (const g of games) {
        // Same guards the records pass uses: decided games only, no live
        // in-progress scores, no ties.
        if (g.status !== 'final') continue;
        if (g.scoreA == null || g.scoreB == null || g.scoreA === g.scoreB) continue;
        if (!g.teamAId || !g.teamBId) continue;
        if (!tied.has(g.teamAId) || !tied.has(g.teamBId)) continue;
        const m = g.scoreA - g.scoreB;
        out.set(g.teamAId, (out.get(g.teamAId) ?? 0) + m);
        out.set(g.teamBId, (out.get(g.teamBId) ?? 0) - m);
      }
    }
    return out;
  }, [anyRecords, pool.teams, records, games]);

  const ranked = anyRecords
    ? pool.teams
        .slice()
        .sort((a, b) => {
          const ra = (a.teamId && records.get(a.teamId)) || { wins: 0, losses: 0, diff: 0 };
          const rb = (b.teamId && records.get(b.teamId)) || { wins: 0, losses: 0, diff: 0 };
          if (rb.wins !== ra.wins) return rb.wins - ra.wins;
          if (ra.losses !== rb.losses) return ra.losses - rb.losses;
          const ma = a.teamId ? (miniDiff.get(a.teamId) ?? 0) : 0;
          const mb = b.teamId ? (miniDiff.get(b.teamId) ?? 0) : 0;
          if (mb !== ma) return mb - ma;
          if (rb.diff !== ra.diff) return rb.diff - ra.diff;
          return (a.seed ?? 99) - (b.seed ?? 99);
        })
    : pool.teams;

  const [gamesOpen, setGamesOpen] = useState(false);
  const panelId = `pool-games-${pool.name}`;

  return (
    <div className="bg-surface rounded-card shadow-card overflow-hidden">
      <div className="px-4 py-3">
        <span className="text-[10px] font-bold tracking-[0.18em] uppercase text-ink font-tight">
          {pool.name}
        </span>
      </div>
      <ul>
        {ranked.map((t) => {
          const rec = t.teamId ? records.get(t.teamId) : undefined;
          return (
            <li key={t.teamId} className="border-t border-hairline">
              <Link
                href={season != null ? `/usau/teams/${t.teamId}?season=${season}` : `/usau/teams/${t.teamId}`}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-ink/[0.03] transition-colors no-underline"
              >
                <span className="tabular text-[11px] font-bold text-faint font-tight w-5 text-right flex-shrink-0">
                  {t.seed ?? '—'}
                </span>
                <UsauTeamLogo
                  name={t.teamName}
                  genderDivision={t.genderDivision}
                  competitionLevel={competitionLevel}
                  size={20}
                />
                <span className="flex-1 min-w-0 text-[13px] font-semibold text-ink font-tight truncate">
                  {t.teamName}
                </span>
                <span className="tabular text-[11px] font-bold text-muted font-tight flex-shrink-0">
                  {rec ? `${rec.wins}–${rec.losses}` : '—'}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>

      {/* Hidden at lg+: the desktop layout renders full per-pool schedule
          tables below the standings row instead (PoolScheduleTable), so the
          games would otherwise appear twice. */}
      {games.length > 0 && (
        <div className="border-t border-hairline lg:hidden">
          <button
            type="button"
            aria-expanded={gamesOpen}
            aria-controls={panelId}
            onClick={() => setGamesOpen((o) => !o)}
            className={[
              'w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left cursor-pointer',
              'hover:bg-ink/[0.03] transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset',
            ].join(' ')}
          >
            <span className="flex items-center gap-2 min-w-0">
              <PoolGamesChevron open={gamesOpen} />
              <span className="text-[10px] font-bold tracking-[0.18em] uppercase text-ink font-tight">
                Games
              </span>
            </span>
            <span className="tabular text-[10px] font-bold text-faint font-tight">
              {games.length}
            </span>
          </button>
          {gamesOpen && (
            <ul id={panelId} className="flex flex-col gap-2 px-3 pb-3">
              {games.map((g) => (
                <GameRow key={g.id} game={g} venueState={venueState} season={season} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function PoolGamesChevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className={['shrink-0 text-faint transition-transform duration-150', open ? 'rotate-90' : ''].join(' ')}
    >
      <path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BracketBlock({
  bracket,
  venueState,
  treeSized = false,
  season,
}: {
  bracket: { name: string; games: Game[] };
  venueState?: string | null;
  season?: number | null;
  /** Render the games as tree-sized MatchCards (BracketScroller columns)
   *  instead of full-width GameRows — used when the group sits alongside
   *  bracket trees so every card on the tab is the same size. */
  treeSized?: boolean;
}) {
  // The ingest classifier tags a placement bracket's DECIDING game round='other'
  // (its classifyRound has no placement-final case), so it renders as "OTHER"
  // and — since roundOrder('other')=1 — sorts ABOVE the semis. Reclassify: when
  // a bracket has semifinals, treat its trailing 'other' game(s) (the ones
  // scheduled after the semis, or the sole non-semi) as the Final so the label
  // and ordering are correct. Pure display remap — no data change.
  const hasSemis = bracket.games.some((g) => g.round === 'semi');
  const latestSemiAt = hasSemis
    ? bracket.games
        .filter((g) => g.round === 'semi')
        .reduce((m, g) => (g.scheduledAt && g.scheduledAt > m ? g.scheduledAt : m), '')
    : '';
  const displayRound = (g: Game): string => {
    if (g.round !== 'other' || !hasSemis) return g.round;
    // An 'other' game that comes at/after the last semi is the placement final.
    if (!g.scheduledAt || !latestSemiAt || g.scheduledAt >= latestSemiAt) return 'final';
    return g.round;
  };

  // Scraped structure names the column outright ("5th Place Game" → Final);
  // legacy rows fall back to the coarse round.
  const structured = hasBracketStructure(bracket.games);
  const byRound = new Map<string, { label: string; order: number; games: Game[] }>();
  for (const g of bracket.games) {
    const key = structured ? `stage:${g.bracketStageIndex ?? 'x'}` : displayRound(g);
    if (!byRound.has(key)) {
      byRound.set(key, {
        label: structured
          ? structuredColumnLabel(g.bracketStage, g.bracketName, g.bracketStageIndex === 0)
          : prettyRound(key),
        // Structured columns run deepest-first (higher index = earlier round).
        order: structured ? -(g.bracketStageIndex ?? -1) : roundOrder(key),
        games: [],
      });
    }
    byRound.get(key)!.games.push(g);
  }
  const rounds = Array.from(byRound.values()).sort((a, b) => a.order - b.order);

  return (
    <div>
      <h3 className="font-display italic font-bold text-[22px] leading-tight tracking-[-0.02em] text-ink mb-3">
        {bracket.name}
      </h3>
      {treeSized ? (
        <UsauFlatBracketCards
          rounds={rounds.map(({ label, games }) => ({ label, games }))}
          venueState={venueState}
          season={season}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {rounds.map(({ label, games }) => (
            <div key={label}>
              <div className="text-[10px] font-bold tracking-[0.18em] uppercase text-faint font-tight mb-2">
                {label}
              </div>
              <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {games.map((g) => (
                  <GameRow key={g.id} game={g} venueState={venueState} season={season} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * "Pool A Schedule & Scores" — the full per-pool game table USAU's own event
 * page renders beneath the standings row (Hunter, 2026-08-22). DESKTOP ONLY:
 * on lg+ the standings cards drop their collapsed "Games" disclosure and these
 * tables carry the schedule instead, so a coach can read a whole pool's slate
 * without opening four accordions. Mobile keeps the merged-card behavior —
 * a 7-column table does not fit a phone.
 */
function PoolScheduleTable({
  poolName,
  games,
  venueState,
  season,
}: {
  poolName: string;
  games: Game[];
  venueState?: string | null;
  season?: number | null;
}) {
  if (games.length === 0) return null;

  return (
    <section className="bg-surface rounded-card shadow-card overflow-hidden">
      <div className="px-4 py-3 border-b border-hairline">
        <h3 className="text-[10px] font-bold tracking-[0.18em] uppercase text-ink font-tight">
          {poolName} Schedule &amp; Scores
        </h3>
      </div>
      {/* Wide content scrolls inside its own container rather than pushing the
          page sideways. */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px] font-tight">
          <thead>
            <tr className="text-left">
              {['Date', 'Time', 'Field', 'Team 1', 'Team 2', 'Score', 'Status'].map((h) => (
                <th
                  key={h}
                  scope="col"
                  className="px-4 py-2 text-[10px] font-bold tracking-[0.14em] uppercase text-muted font-tight whitespace-nowrap bg-ink/[0.02]"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {games.map((g) => {
              const status = g.status.toLowerCase();
              const isCancelled = status === 'cancelled';
              // Rows scraped before 2026-09-11 store USAU's unplayed "0 - 0"
              // placeholder as a real score; a scheduled 0-0 is not a result.
              const hasScore =
                g.scoreA != null && g.scoreB != null && !(g.scoreA === 0 && g.scoreB === 0 && status === 'scheduled');
              const isFinal = hasScore || status === 'final';
              const forfeit = isForfeit(g);
              const aWon = forfeit ? g.winnerTeamId === g.teamAId : hasScore && isFinal && (g.scoreA ?? 0) > (g.scoreB ?? 0);
              const bWon = forfeit ? g.winnerTeamId === g.teamBId : hasScore && isFinal && (g.scoreB ?? 0) > (g.scoreA ?? 0);
              // Date and time are split into their own columns here (the card
              // view folds them into one status strip), both in the VENUE's
              // wall clock — see formatGameTime.
              const dateLabel = formatGameDate(g.scheduledAt, venueState ?? null);
              const timeLabel = formatGameClock(g.scheduledAt, venueState ?? null);
              const field = g.location?.trim() || '—';

              return (
                <tr key={g.id} className="border-t border-hairline hover:bg-ink/[0.03] transition-colors">
                  <td className="px-4 py-2.5 text-muted whitespace-nowrap tabular">{dateLabel || '—'}</td>
                  <td className="px-4 py-2.5 text-muted whitespace-nowrap tabular">{timeLabel || '—'}</td>
                  <td className="px-4 py-2.5 text-muted whitespace-nowrap tabular">{field}</td>
                  <td className="px-4 py-2.5">
                    <TeamCell name={g.teamAName} teamId={g.teamAId} won={aWon} season={season} />
                  </td>
                  <td className="px-4 py-2.5">
                    <TeamCell name={g.teamBName} teamId={g.teamBId} won={bWon} season={season} />
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap tabular font-bold">
                    {hasScore || forfeit ? (
                      <span className="text-ink">
                        <span className={aWon ? '' : 'text-muted'}>{forfeit ? (aWon ? 'W' : 'F') : g.scoreA}</span>
                        <span className="text-faint"> – </span>
                        <span className={bWon ? '' : 'text-muted'}>{forfeit ? (bWon ? 'W' : 'F') : g.scoreB}</span>
                      </span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-[11px] font-bold tracking-[0.12em] uppercase">
                    <span className={isCancelled ? 'text-live' : isFinal ? 'text-faint' : 'text-muted'}>
                      {isCancelled ? 'Cancelled' : isFinal ? 'Final' : 'Scheduled'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** One team cell in the schedule table — links out when we resolved an id. */
function TeamCell({
  name,
  teamId,
  won,
  season,
}: {
  name: string | null;
  teamId: string | null;
  won: boolean;
  season?: number | null;
}) {
  const label = name ?? 'TBD';
  const cls = ['truncate', won ? 'font-bold text-ink' : 'font-medium text-muted'].join(' ');
  if (!teamId || !name) return <span className={cls}>{label}</span>;
  return (
    <Link
      href={season != null ? `/usau/teams/${teamId}?season=${season}` : `/usau/teams/${teamId}`}
      className={`${cls} no-underline hover:text-accent transition-colors`}
    >
      {label}
    </Link>
  );
}

function GameRow({
  game,
  showBracket,
  bracketLabel,
  venueState,
  season,
}: {
  game: Game;
  /** Event season → `?season=` on the team links inside this row. */
  season?: number | null;
  /** Crossovers span several bracket_names in one list — show which one. */
  showBracket?: boolean;
  bracketLabel?: (name: string) => string;
  /** Event's US state — times render as the venue's wall clock. */
  venueState?: string | null;
}) {
  const status = game.status.toLowerCase();
  const isCancelled = status === 'cancelled';

  // Mobile parity (GameCard): a game is FINAL when scores are present or its
  // status is final — not by the raw status string, which can leak values
  // like 'in_progress' straight into the UI.
  // A scheduled 0-0 is USAU's unplayed placeholder (rows scraped before
  // 2026-09-11 still carry it), not a result.
  const hasScore =
    game.scoreA != null && game.scoreB != null && !(game.scoreA === 0 && game.scoreB === 0 && status === 'scheduled');
  const isFinal = hasScore || status === 'final';
  const forfeit = isForfeit(game);
  const aWon = forfeit ? game.winnerTeamId === game.teamAId : hasScore && isFinal && (game.scoreA ?? 0) > (game.scoreB ?? 0);
  const bWon = forfeit ? game.winnerTeamId === game.teamBId : hasScore && isFinal && (game.scoreB ?? 0) > (game.scoreA ?? 0);

  // Bracket name is shown on the left (crossovers span several bracket_names
  // in one list). Field + time fold into the right-hand status strip along
  // with FINAL/TBD (mobile parity) instead of the raw status string.
  const bracket = showBracket && game.bracketName
    ? (bracketLabel ? bracketLabel(game.bracketName) : game.bracketName)
    : null;
  // `location` is usually a bare field number ("7") but sometimes a full venue
  // string ("Devens - Rogers Field - 12"). Only prefix "Field" when it's the
  // bare-number form, so we don't render "Field Devens - Rogers Field - 12".
  const fieldLabel = game.location
    ? /^\d+[A-Za-z]?$/.test(game.location.trim())
      ? `Field ${game.location.trim()}`
      : game.location.trim()
    : null;
  const time = formatGameTime(game.scheduledAt, venueState ?? null);
  // Time stays visible on FINAL games too (mobile parity) — previously it was
  // replaced by the word FINAL, which threw away when/where the game was played.
  const statusLabel = isCancelled
    ? 'Cancelled'
    : [isFinal ? 'FINAL' : '', time || (isFinal ? '' : 'TBD'), fieldLabel].filter(Boolean).join(' · ');
  const statusClass = isCancelled ? 'text-muted' : isFinal ? 'text-faint' : 'text-muted';

  return (
    <li className="bg-surface rounded-card-sm shadow-soft p-3">
      <div className="flex items-center justify-between mb-2 text-[10px] font-bold tracking-[0.14em] uppercase font-tight">
        {bracket ? (
          <span className="text-muted truncate">{bracket}</span>
        ) : (
          <span />
        )}
        <span className={statusClass}>{statusLabel}</span>
      </div>
      {/* Unseeded sides show USAU's own placeholder ("P1 Pool A", "W of
          Quarters G1") — same vocabulary as the bracket tree's cards — so a
          pre-tournament flat list reads as the bracket logic, not a wall of
          dashes. */}
      <TeamLine
        name={game.teamAName ?? shortPlaceholder(game.teamAPlaceholder)}
        seed={game.seedA}
        teamId={game.teamAId}
        score={forfeit ? (aWon ? 'W' : 'F') : hasScore ? game.scoreA : null}
        won={aWon}
        lost={bWon}
        season={season}
      />
      <TeamLine
        name={game.teamBName ?? shortPlaceholder(game.teamBPlaceholder)}
        seed={game.seedB}
        teamId={game.teamBId}
        score={forfeit ? (bWon ? 'W' : 'F') : hasScore ? game.scoreB : null}
        won={bWon}
        lost={aWon}
        season={season}
      />
    </li>
  );
}

function TeamLine({
  name,
  seed,
  teamId,
  score,
  won,
  lost,
  season,
}: {
  name: string | null;
  seed: number | null;
  teamId: string | null;
  /** A number, or "W"/"F" for a forfeit. */
  score: number | string | null;
  won: boolean;
  lost: boolean;
  season?: number | null;
}) {
  const inner = (
    <span
      className={[
        'flex items-center gap-2 flex-1 min-w-0',
        won ? 'text-ink font-bold' : lost ? 'text-faint' : 'text-muted',
      ].join(' ')}
    >
      {seed != null && (
        <span className="tabular text-[10px] text-faint font-bold w-4 text-right">
          {seed}
        </span>
      )}
      <span className="text-[13px] font-tight font-bold truncate">{name ?? '—'}</span>
    </span>
  );

  return (
    <div className="flex items-center gap-3 py-1">
      {teamId ? (
        <Link
          href={season != null ? `/usau/teams/${teamId}?season=${season}` : `/usau/teams/${teamId}`}
          className="flex-1 min-w-0 hover:text-accent transition-colors no-underline"
        >
          {inner}
        </Link>
      ) : (
        <span className="flex-1 min-w-0">{inner}</span>
      )}
      {score != null && (
        <span
          className={[
            'tabular text-[16px] font-bold font-tight leading-none w-8 text-right',
            won ? 'text-ink' : lost ? 'text-faint' : 'text-muted',
          ].join(' ')}
        >
          {score}
        </span>
      )}
    </div>
  );
}

function roundOrder(round: string): number {
  switch (round) {
    case 'final':
      return 5;
    case 'semi':
      return 4;
    case 'quarter':
      return 3;
    case 'prequarter':
      return 2;
    case 'placement':
    case 'consolation':
      return 6;
    default:
      return 1;
  }
}

function prettyRound(round: string): string {
  switch (round) {
    case 'final':
      return 'Final';
    case 'semi':
      return 'Semifinals';
    case 'quarter':
      return 'Quarterfinals';
    case 'prequarter':
      return 'Prequarters';
    case 'placement':
      return 'Placement';
    case 'consolation':
      return 'Consolation';
    case 'pool':
      return 'Pool';
    default:
      return round;
  }
}

// ─── Placement-bracket normalization (#7) ───────────────────────────────────
// USAU bracket_name is wildly inconsistent — "Championship Bracket", "1st Place",
// "Championship", "1st Place Bracket", "First Place" are all THE SAME bracket,
// and "5th Place" / "5th Place Bracket" / "Fifth Place" / "5th place" collapse
// too. canonicalPlacement() maps any variant → a stable { key, label, order } so
// placement games can be grouped into navigable sub-tabs.

const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fifteenth: 15, seventeenth: 17,
};

export interface PlacementBucket {
  /** Stable identity for grouping (e.g. 'championship', '5th'). */
  key: string;
  /** Sub-tab label (e.g. 'Championship', '5th Place'). */
  label: string;
  /** Sort order — championship first, then ascending by place. */
  order: number;
}

/** Normalize a bracket_name into its placement bucket. */
export function canonicalPlacement(name: string | null | undefined): PlacementBucket {
  const t = (name ?? '').toLowerCase();

  // Championship = 1st place, however it's spelled.
  if (
    t.includes('championship') ||
    /\b1st\b/.test(t) || t.includes('first place') ||
    t === 'finals' || t === 'final' || t === 'ninals'
  ) {
    return { key: 'championship', label: 'Championship', order: 0 };
  }

  // Numeric ordinal: "5th", "13th place", etc.
  const num = t.match(/\b(\d+)(st|nd|rd|th)\b/);
  let place: number | null = num ? parseInt(num[1], 10) : null;

  // Word ordinal: "fifth place", "ninth place bracket".
  if (place == null) {
    for (const [word, n] of Object.entries(ORDINAL_WORDS)) {
      if (t.includes(word)) { place = n; break; }
    }
  }

  // Game-to-go / backdoor with no place in the name is the second-place game.
  if (place == null && /backdoor|game[- ]to[- ]go|\bg2g\b/.test(t)) place = 2;

  if (place != null && place >= 2) {
    const suffix = place % 10 === 1 && place % 100 !== 11 ? 'st'
      : place % 10 === 2 && place % 100 !== 12 ? 'nd'
      : place % 10 === 3 && place % 100 !== 13 ? 'rd' : 'th';
    return { key: `p${place}`, label: `${place}${suffix} Place`, order: place };
  }

  // Second-phase pools routed into the bracket view ("Pool E" — a placement
  // or power round-robin whose name carries no ordinal). Each gets its own
  // filter entry, after the numbered places.
  const pool = t.match(/^pool\s+(\S+)$/);
  if (pool) {
    return { key: `pool-${pool[1]}`, label: (name ?? '').trim(), order: 500 };
  }

  // Consolation / anything unrecognized → an "Other" bucket last.
  return { key: 'other', label: 'Other Brackets', order: 999 };
}

function bracketOrder(name: string): number {
  return canonicalPlacement(name).order;
}
