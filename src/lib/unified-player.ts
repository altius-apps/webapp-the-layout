// Unified player profile data layer.
//
// Combines UFA + USAU + PUL careers under one identity. Identity match is by
// lowercased display name — the same v1 rule we use elsewhere (see
// memory/project_usau_player_identity.md). Two real humans with the same
// name will merge; acceptable until we build the canonical-identity layer.
//
// The page accepts a UFA slug (e.g. "tdecraene"), a USAU UUID, or a PUL UUID.
// We anchor on whichever the URL gives us, resolve the human's name, then
// fetch the OTHER leagues' data via name match.
//
// UUID DISAMBIGUATION NOTE: Both USAU and PUL use v4 UUIDs as player ids,
// so looksLikeUsauUuid() returns true for PUL ids too. The resolver handles
// this by trying USAU first; if that misses, it tries PUL. See the uuid
// anchor-resolution block in getUnifiedPlayerProfile.

import 'server-only';
import { cache } from 'react';
import {
  currentSeasonYear,
  getAllPlayerStats,
  getPlayerInfo,
  getStoredHeadshotUrl,
  getPlayerSeasons,
  getPlayerGameLog,
  getUfaChampionsByYear,
} from '@/lib/ufa/client';
import { teamMetaByAbbr, teamBySlugOrAbbr as teamMeta, type TeamMeta } from '@/lib/ufa/teams';
import { getUfaPlayerFromDb, findUfaSlugByNameFromDb } from '@/lib/ufa/db-player';
import { ufaTeamState, isUsStateCode, isStateCoveredByRegionMap } from '@/lib/usau/regions';
import type { UfaPlayerGameRow, UfaPlayerSeasonRow } from '@/lib/ufa/types';
import {
  findUsauPlayerByName,
  getPlayerProfile as getUsauPlayerProfile,
  looksLikeUsauUuid,
  type UsauPlayerSummary,
} from '@/lib/usau/data';
import {
  getPulPlayer,
  getPulPlayerCareerByName,
  findPulPlayerNameByName,
  listPulTeams,
  getPulPlayerGameLog,
  type PulTeam,
  type PulPlayerCareer,
  type PulPlayerGameRow,
} from '@/lib/pul/data';
import {
  getWulPlayer,
  getWulPlayerCareerByName,
  findWulPlayerNameByName,
  listWulTeams,
  getWulPlayerGameLog,
  type WulTeam,
  type WulPlayerCareer,
  type WulPlayerGameRow,
} from '@/lib/wul/data';
import { getWfdfPlayerStints, type WfdfPlayerStint } from '@/lib/wfdf/data';
import { namesMatch } from '@/lib/name-match';
import { loadNameAliases } from '@/lib/name-aliases';
import type { PlayerKind } from '@/lib/player-content/types';
// RPC fast path. This module imports our TYPES only (`import type`), so the
// cycle is erased at compile time and there's no runtime init-order hazard.
import { getProfileViaRpc, wfdfChampionTitles } from './unified-player-rpc';

// ── Output shape ─────────────────────────────────────────────────────────

export interface UfaSeasonStint {
  league: 'ufa';
  /** UFA franchise slug (the team page lives at /teams/{slug}). */
  teamId: string;
  teamMeta: TeamMeta;
  /** Combined reg-season + playoffs totals for the year. */
  totals: {
    gamesPlayed: number;
    goals: number;
    assists: number;
    blocks: number;
    plusMinus: number;
    completions: number;
    throwsAttempted: number;
    hucksCompleted: number;
    hucksAttempted: number;
  };
  /** Per-game log; populated when game data is available. */
  games: UfaPlayerGameRow[];
  /** Did this team win the UFA championship that year? */
  isChampion: boolean;
}

export interface UsauSeasonStint {
  league: 'usau';
  teamId: string;
  teamName: string;
  /** "Men" | "Women" | "Mixed" | "Club" | "College" — used for the chip
   *  next to the team name. We pass through whatever the team row had. */
  division: string | null;
  /** Raw gender division ("Men"|"Women"|"Mixed") from the team row — used to
   *  resolve the team logo (UsauTeamLogo keys on it). Distinct from `division`,
   *  which is a cosmetic chip label (currently a null placeholder). */
  genderDivision: string | null;
  /** usau_teams.competition_level — lets UsauTeamLogo resolve college crests. */
  competitionLevel: string | null;
  jerseyNumber: string | null;
  isChampion: boolean;
  events: UsauPlayerSummary['teamHistory'][number]['events'];
}

/**
 * PUL (Premier Ultimate League) stint — one season with one team.
 * PUL has no per-game API; stats are season totals only.
 *
 * teamName, teamLogoUrl, and teamAccentColor are resolved from the pul_teams
 * table at build time (batched — not fetched per-stint).
 */
export interface PulSeasonStint {
  league: 'pul';
  season: number;
  teamId: string;
  teamName: string;
  teamCity: string;
  teamLogoUrl: string | null;
  teamAccentColor: string | null;
  jerseyNumber: string;
  pronouns: string | null;
  stats: {
    gamesPlayed: number;
    goals: number;
    assists: number;
    blocks: number;
    turnovers: number;
    touches: number;
    oPoints: number;
    dPoints: number;
    plusMinus: number;
  };
  /** Per-game log for the season. Empty when no box scores exist (e.g. 2022). */
  games: PulPlayerGameRow[];
}

/**
 * WUL (Western Ultimate League) stint — one season with one team. Like PUL,
 * WUL is a women's semi-pro league overlapping USAU Club; it's kept in its own
 * sub-block (see UnifiedPlayerProfile.wul) and NOT added to the shared career
 * totals, to avoid double-counting overlapping competitive periods. WUL data is
 * per-game and richer than PUL, but the stint exposes the same season-totals
 * shape for a consistent UI.
 */
export interface WulSeasonStint {
  league: 'wul';
  season: number;
  teamId: string;
  teamName: string;
  teamCity: string;
  teamLogoUrl: string | null;
  teamAccentColor: string | null;
  jerseyNumber: string;
  stats: {
    gamesPlayed: number;
    goals: number;
    assists: number;
    blocks: number;
    turnovers: number;
    touches: number;
    oPoints: number;
    dPoints: number;
    plusMinus: number;
  };
  /** Per-game log for the season. */
  games: WulPlayerGameRow[];
}

// WFDF "Worlds" appearance — name-matched from a per-event roster. Player-level
// stats are just tournament goals/assists (no advanced stats upstream), and
// there's no standalone WFDF player id, so this is a merge-in stint only (WFDF
// never anchors a profile).
export interface WfdfSeasonStint {
  league: 'wfdf';
  season: number;
  teamId: string;
  teamName: string;
  countryCode: string | null;
  divisionName: string | null;
  eventName: string;
  eventSlug: string;
  jerseyNumber: string | null;
  isChampion: boolean;
  stats: {
    goals: number | null;
    assists: number | null;
  };
}

/** EUF/EUCS appearance. Event-scoped like WFDF, but club (not national) and it
 *  carries a derived final placement rather than a standing. */
export interface EufSeasonStint {
  league: 'euf';
  season: number;
  teamId: string;
  teamName: string;
  countryName: string | null;
  divisionName: string | null;
  eventName: string;
  eventSlug: string;
  /** euf_events.kind — 'eucf' marks the season-ending European championship.
   *  Gold "Champion" treatment is reserved for EUCF wins (Hunter, 2026-08-04);
   *  wins at other kinds render as a plain 1st. Null on stale cached payloads. */
  eventKind: string | null;
  jerseyNumber: string | null;
  finalPlacement: number | null;
  isChampion: boolean;
  stats: {
    goals: number | null;
    assists: number | null;
    games: number | null;
    points: number | null;
  };
}

/** WFDF world titles for one event series ("WUCC", "WBUC", ...), newest year
 *  first — the shape ChampionBanner takes (one banner per series). */
export interface WfdfChampionTitle {
  event: string;
  years: number[];
}

export type SeasonStint =
  | UfaSeasonStint
  | UsauSeasonStint
  | PulSeasonStint
  | WulSeasonStint
  | WfdfSeasonStint
  | EufSeasonStint;

export interface UnifiedYear {
  year: number;
  stints: SeasonStint[];
}

export interface UnifiedPlayerProfile {
  /** The anchor id the URL used. UFA slug, USAU UUID, or PUL UUID. */
  anchorId: string;
  /** Which side the URL anchored on. */
  anchorLeague: 'ufa' | 'usau' | 'pul' | 'wul';
  displayName: string;
  /** Pronouns resolved from PUL data when available; null otherwise. */
  pronouns: string | null;
  /** UFA player headshot (watchufa profile image). UFA is the only league that
   *  publishes these. Null for non-UFA-anchored players or the ~10% of UFA
   *  players without one — the UI falls back to a monogram. */
  headshotUrl: string | null;
  /** Year-by-year, newest first. */
  years: UnifiedYear[];
  /**
   * Combined hero stats — UFA ONLY. `goals`/`assists`/`blocks`/etc. here are
   * UFA per-game totals; USAU's event-level G/A live in the usau* fields
   * below instead, never mixed into these. USAU only publishes goals/assists
   * at a handful of flagship events (Nationals, Pro Champs, U.S. Open, college
   * championships) — folding those into a "UFA Games" cell overstated a
   * player's per-game production with numbers from a different sport format
   * (tournament totals, not per-game box scores). The UI renders a separate
   * "USAU career" block from usauGoals/usauAssists/usauEventsWithStats.
   *
   * PUL is kept as a SEPARATE sub-block (see `pul` field below) rather than
   * being added into these totals. Rationale: PUL is a women's/open semi-pro
   * league whose seasons overlap USAU Club Nationals; a player may accumulate
   * goals in both simultaneously. Mixing PUL goals into the same counter
   * would double-count effort in overlapping weeks. The UI can render PUL
   * totals from the `pul` block and keep them visually distinct.
   */
  career: {
    /** UFA games played + USAU events-played (kept separate to avoid
     *  conflating "ultimate game" with "tournament event"). */
    ufaGamesPlayed: number;
    usauEventsPlayed: number;
    /** UFA-only from here down — see the field doc above. */
    goals: number;
    assists: number;
    blocks: number;
    plusMinus: number;
    completions: number;
    throwsAttempted: number;
    /** USAU event-level goals/assists, summed across every event with a
     *  published stats row. Kept separate from `goals`/`assists` (UFA). */
    usauGoals: number;
    usauAssists: number;
    /** Count of USAU events where USAU actually published a stats row (a
     *  player only gets one if they had ≥1 G or A). Compare against
     *  `usauEventsPlayed` to know whether coverage is partial. */
    usauEventsWithStats: number;
  };
  /**
   * PUL career sub-totals. Null when the player has no PUL history.
   * Reported separately from `career` to avoid double-counting overlapping
   * competitive periods.
   */
  pul: {
    seasonsPlayed: number;
    gamesPlayed: number;
    goals: number;
    assists: number;
    blocks: number;
    turnovers: number;
    touches: number;
    plusMinus: number;
  } | null;
  /**
   * WUL career sub-totals. Null when the player has no WUL history. Reported
   * separately from `career` for the same reason as PUL — overlapping seasons.
   */
  wul: {
    seasonsPlayed: number;
    gamesPlayed: number;
    goals: number;
    assists: number;
    blocks: number;
    turnovers: number;
    touches: number;
    plusMinus: number;
  } | null;
  championYearsUfa: number[];
  championYearsUsau: number[];
  /** WFDF world titles, derived from the wfdf stints' isChampion. */
  championTitlesWfdf: WfdfChampionTitle[];
  /** The player's most-recent USAU gender division ('Men'|'Women'|'Mixed'), or
   *  null if they have no USAU stints. Lets the profile sync the nav's division
   *  so the "Teams" tab lands on the right division (e.g. a Mixed player → Mixed
   *  club teams). Most-recent chosen because a career can span divisions. */
  mostRecentUsauDivision: string | null;
  /** Every (league, id) pair this person is known by across the leagues that
   *  merged into this profile. User-uploaded content (player_content) is keyed
   *  by (player_kind, player_ref), and a person may have uploaded to ANY of
   *  their league ids — so the profile must fetch content for ALL of these, not
   *  just the anchor, or a photo added under (usau, uuid) won't show when the
   *  profile is reached via the UFA slug. See getApprovedContentForPlayers. */
  contentRefs: { kind: PlayerKind; ref: string }[];
}

// ── Builder ──────────────────────────────────────────────────────────────

/**
 * Builds a unified profile for a UFA slug, USAU UUID, or PUL UUID. All three
 * leagues are resolved in parallel where possible; a failure in any
 * cross-league lookup degrades gracefully (that league's stints are omitted).
 *
 * UUID DISAMBIGUATION:
 *   Both USAU and PUL use v4 UUIDs. When the anchor looks like a UUID we try
 *   USAU first (existing behavior, no regression for USAU links). If USAU
 *   returns nothing, we try PUL. This is a sequential fallback, not parallel,
 *   to keep the logic simple and correct without a race condition on the
 *   anchor-league determination.
 *
 * Cost: 1 UFA scrape + 1 UFA season fetch + N UFA game-log fetches (one
 * per year) + 1 USAU profile fetch + 1 PUL career fetch + 1 PUL teams fetch.
 * Each upstream call is cached 1h–24h via the existing library defaults.
 */
async function _getUnifiedPlayerProfile(
  anchorId: string,
): Promise<UnifiedPlayerProfile | null> {
  // ── Anchor resolution ───────────────────────────────────────────────────
  // Determine which league owns this id and pull the display name from it.
  // After this block we have: anchorLeague, anchorName, and the anchor-side
  // data object (sideUsau or sidePulCareer) already fetched.

  let anchorLeague: 'ufa' | 'usau' | 'pul' | 'wul';
  let anchorName: string | null = null;
  let anchorUsau: UsauPlayerSummary | null = null;
  let anchorPulCareer: PulPlayerCareer | null = null;
  let anchorWulCareer: WulPlayerCareer | null = null;
  let headshotUrl: string | null = null;

  if (!looksLikeUsauUuid(anchorId)) {
    // ── UFA slug anchor ────────────────────────────────────────────────
    anchorLeague = 'ufa';
    // Prefer our SELF-HOSTED headshot (fast, CDN-cached, served resized via the
    // image transform) over the live watchufa scrape. getPlayerInfo still
    // provides the display name; only fall back to ITS headshot if we have none
    // stored (rare — a brand-new player the sync hasn't self-hosted yet).
    // Name + stored headshot come from our own ufa_players row — one query, no
    // HTML scrape. getPlayerInfo() (which fetches and parses a watchufa.com
    // profile page) is only reached when the DB has neither, i.e. a player the
    // sync hasn't seen yet.
    const fromDb = await getUfaPlayerFromDb(anchorId).catch(() => null);
    anchorName = fromDb?.name ?? null;
    headshotUrl = fromDb?.headshotUrl ?? null;
    if (!anchorName || !headshotUrl) {
      const [info, stored] = await Promise.all([
        anchorName ? Promise.resolve(null) : getPlayerInfo(anchorId).catch(() => null),
        headshotUrl ? Promise.resolve(null) : getStoredHeadshotUrl(anchorId).catch(() => null),
      ]);
      anchorName = anchorName ?? info?.name ?? null;
      headshotUrl = headshotUrl ?? stored ?? info?.headshotUrl ?? null;
    }
  } else {
    // ── UUID anchor — try USAU first, then PUL ─────────────────────────
    // Both USAU and PUL use v4 UUIDs. We check USAU first (existing
    // behavior preserves all current /players/{usau-uuid} links).
    const usauProfile = await getUsauPlayerProfile(anchorId).catch(() => null);
    if (usauProfile) {
      anchorLeague = 'usau';
      anchorName = usauProfile.displayName ?? null;
      anchorUsau = usauProfile;
    } else {
      // USAU miss — try PUL.
      const pulPlayer = await getPulPlayer(anchorId).catch(() => null);
      if (pulPlayer) {
        anchorLeague = 'pul';
        anchorName = pulPlayer.playerName;
        // We need the full career (all seasons) for a PUL anchor, not just
        // the one row. Fetch by name so we get every season's stint.
        anchorPulCareer = await getPulPlayerCareerByName(pulPlayer.playerName).catch(() => null);
        anchorName = anchorPulCareer?.playerName ?? pulPlayer.playerName;
      } else {
        // PUL miss — try WUL (also v4 UUIDs).
        const wulPlayer = await getWulPlayer(anchorId).catch(() => null);
        if (wulPlayer) {
          anchorLeague = 'wul';
          anchorWulCareer = await getWulPlayerCareerByName(wulPlayer.playerName).catch(() => null);
          anchorName = anchorWulCareer?.playerName ?? wulPlayer.playerName;
        } else {
          // UUID matches none of USAU/PUL/WUL — unresolvable.
          return null;
        }
      }
    }
  }

  if (!anchorName) return null;

  // Resolve the UFA slug up front (anchor slug, else name-matched) so we can
  // both build the UFA side AND record it as a content ref below.
  const ufaSlug =
    anchorLeague === 'ufa'
      ? anchorId
      : await findUfaSlugByName(anchorName).catch(() => null);

  // ── Fetch all three sides in parallel ──────────────────────────────────
  // Each lookup is independent once we have a display name. Failures are
  // caught per-league so one bad network call doesn't kill the whole profile.
  const [sideUfa, sideUsau, sidePulCareer, teamMap, sideWulCareer, wulTeamMap, wfdfStints] =
    await Promise.all([
    // UFA side
    (ufaSlug ? buildUfaSide(ufaSlug) : Promise.resolve(null)).catch(() => null),

    // USAU side
    (anchorLeague === 'usau'
      ? Promise.resolve(anchorUsau)
      : findUsauPlayerByName(anchorName).then((id) =>
          id ? getUsauPlayerProfile(id) : null,
        )
    ).catch(() => null),

    // PUL side
    (anchorLeague === 'pul'
      ? Promise.resolve(anchorPulCareer)
      : findPulPlayerNameByName(anchorName).then((name) =>
          name ? getPulPlayerCareerByName(name) : null,
        )
    ).catch(() => null),

    // PUL team metadata — fetched once, used for all PUL stints.
    // listPulTeams() returns all 13 teams; we build a Map for O(1) lookup.
    listPulTeams()
      .then((teams) => new Map<string, PulTeam>(teams.map((t) => [t.id, t])))
      .catch(() => new Map<string, PulTeam>()),

    // WUL side — same pattern as PUL.
    (anchorLeague === 'wul'
      ? Promise.resolve(anchorWulCareer)
      : findWulPlayerNameByName(anchorName).then((name) =>
          name ? getWulPlayerCareerByName(name) : null,
        )
    ).catch(() => null),

    // WUL team metadata — fetched once, used for all WUL stints.
    listWulTeams()
      .then((teams) => new Map<string, WulTeam>(teams.map((t) => [t.id, t])))
      .catch(() => new Map<string, WulTeam>()),

    // WFDF "Worlds" side — name-matched across all events/rosters (all rosters,
    // club + national). WFDF never anchors; it's always a merge-in by name.
    getWfdfPlayerStints(anchorName).catch(() => [] as WfdfPlayerStint[]),
  ] as const);

  // ── Location-based UFA attribution ──────────────────────────────────────
  // When a name splits into multiple USAU people (e.g. two "Thomas Brewster"s
  // distinguished by playing different teams' series), the name-matched UFA
  // career must attach to the RIGHT person — the one whose USAU SERIES play is
  // in the same geography as the UFA team (e.g. UFA Colorado Apex → the
  // Brewster who played club "Johnny Bravo" in the Rocky Mountain section, not
  // the one on Mixed "Thunderpants" in East Plains).
  //
  // Signal: sideUsau.homeStates (states from the cluster's series event names)
  // vs the UFA team's state (ufaTeamState). Attach only when they intersect.
  // Conservative fallback per Hunter: if the USAU cluster has NO usable
  // home-state signal, don't suppress — keep the UFA career (default to same
  // person). We only DROP the UFA career when the cluster HAS location data and
  // it contradicts the UFA team's state.
  //
  // PRECONDITION — the name must actually be ambiguous. Geography only answers
  // "WHICH of the same-named people is the pro?"; when the USAU rows all merged
  // into ONE human there is nobody to confuse them with, and a state mismatch
  // means the player MOVED, not that this is someone else. Without this check
  // the gate deletes the real UFA career of every player whose club history is
  // in a different state than their UFA team — e.g. Chander Boyd-Fliegel
  // (Oregon/Rhino/Emerald City → NW states) signing with the Oakland Spiders
  // (CA): his whole 2026 championship season vanished from his profile.
  let attachUfa = true;
  if (sideUfa && sideUsau && sideUsau.nameIsAmbiguous && (sideUsau.homeStates?.length ?? 0) > 0) {
    const usauStates = new Set(sideUsau.homeStates);
    const ufaStates = sideUfa.stints
      .map(({ stint }) => ufaTeamState(stint.teamId))
      .filter((s): s is string => s != null && isUsStateCode(s));
    // Non-US UFA teams (e.g. Montreal/Toronto) have no US state → can't
    // contradict; keep them attached rather than drop on a null. They map to
    // PROVINCES (QC/ON), not null, so they must be filtered explicitly — a
    // province can never appear in homeStates, so comparing one would always
    // miss and drop the entire real UFA career.
    // A state the region map never lists can't be CONTRADICTED by it — the
    // absence is our gap, not evidence of a different person. Abstain unless
    // every UFA state is one the map actually covers. (Kept identical to the
    // RPC path's shouldAttachUfa; the two must not disagree on one player.)
    if (ufaStates.length > 0 && ufaStates.every((s) => isStateCoveredByRegionMap(s))) {
      attachUfa = ufaStates.some((s) => usauStates.has(s));
    }
  }

  // ── Merge into a Map<year, stints[]> ───────────────────────────────────

  const yearMap = new Map<number, SeasonStint[]>();

  if (sideUfa && attachUfa) {
    for (const { year, stint } of sideUfa.stints) {
      const list = yearMap.get(year) ?? [];
      list.push(stint);
      yearMap.set(year, list);
    }
  }

  if (sideUsau) {
    for (const stint of sideUsau.teamHistory) {
      const list = yearMap.get(stint.season) ?? [];
      list.push({
        league: 'usau',
        teamId: stint.teamId,
        teamName: stint.teamName,
        division: deriveUsauChip(stint),
        genderDivision: stint.genderDivision,
        competitionLevel: stint.competitionLevel,
        jerseyNumber: stint.jerseyNumber,
        isChampion: stint.isChampion,
        events: stint.events,
      });
      yearMap.set(stint.season, list);
    }
  }

  if (sidePulCareer) {
    // Fetch all PUL game logs in parallel — one per season stint.
    const pulGameLogs = await Promise.all(
      sidePulCareer.stints.map((pulStint) =>
        getPulPlayerGameLog(sidePulCareer.playerName, pulStint.season).catch(
          () => [] as PulPlayerGameRow[],
        ),
      ),
    );
    for (let i = 0; i < sidePulCareer.stints.length; i++) {
      const pulStint = sidePulCareer.stints[i];
      const list = yearMap.get(pulStint.season) ?? [];
      const team = teamMap.get(pulStint.player.teamId);
      list.push({
        league: 'pul',
        season: pulStint.season,
        teamId: pulStint.player.teamId,
        teamName: team?.name ?? pulStint.player.teamId,
        teamCity: team?.city ?? '',
        teamLogoUrl: team?.logoUrl ?? null,
        teamAccentColor: team?.accentColor ?? null,
        jerseyNumber: pulStint.player.jerseyNumber,
        pronouns: pulStint.player.pronouns,
        stats: {
          gamesPlayed: pulStint.player.gamesPlayed,
          goals: pulStint.player.goals,
          assists: pulStint.player.assists,
          blocks: pulStint.player.blocks,
          turnovers: pulStint.player.turnovers,
          touches: pulStint.player.touches,
          oPoints: pulStint.player.oPoints,
          dPoints: pulStint.player.dPoints,
          plusMinus: pulStint.player.plusMinus,
        },
        games: pulGameLogs[i],
      });
      yearMap.set(pulStint.season, list);
    }
  }

  if (sideWulCareer) {
    // Fetch all WUL game logs in parallel — one per season stint.
    const wulGameLogs = await Promise.all(
      sideWulCareer.stints.map((wulStint) =>
        getWulPlayerGameLog(sideWulCareer.playerName, wulStint.season).catch(
          () => [] as WulPlayerGameRow[],
        ),
      ),
    );
    for (let i = 0; i < sideWulCareer.stints.length; i++) {
      const wulStint = sideWulCareer.stints[i];
      const list = yearMap.get(wulStint.season) ?? [];
      const team = wulTeamMap.get(wulStint.player.teamId);
      list.push({
        league: 'wul',
        season: wulStint.season,
        teamId: wulStint.player.teamId,
        teamName: team?.name ?? wulStint.player.teamId,
        teamCity: team?.city ?? '',
        teamLogoUrl: team?.logoUrl ?? null,
        teamAccentColor: team?.accentColor ?? null,
        jerseyNumber: wulStint.player.jerseyNumber,
        stats: {
          gamesPlayed: wulStint.player.gamesPlayed,
          goals: wulStint.player.goals,
          assists: wulStint.player.assists,
          blocks: wulStint.player.blocks,
          turnovers: wulStint.player.turnovers,
          touches: wulStint.player.touches,
          oPoints: wulStint.player.oPoints,
          dPoints: wulStint.player.dPoints,
          plusMinus: wulStint.player.plusMinus,
        },
        games: wulGameLogs[i],
      });
      yearMap.set(wulStint.season, list);
    }
  }

  // WFDF "Worlds" stints — name-matched appearances at world championships.
  // One stint per (event, team) the person appeared on, bucketed by event year.
  for (const s of wfdfStints) {
    const list = yearMap.get(s.year) ?? [];
    list.push({
      league: 'wfdf',
      season: s.year,
      teamId: s.teamId,
      teamName: s.teamName,
      countryCode: s.countryCode,
      divisionName: s.divisionName,
      eventName: s.eventName,
      eventSlug: s.eventSlug,
      jerseyNumber: s.jerseyNumber,
      isChampion: s.isChampion,
      stats: { goals: s.goals, assists: s.assists },
    });
    yearMap.set(s.year, list);
  }

  const years: UnifiedYear[] = Array.from(yearMap.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([year, stints]) => ({ year, stints: sortStintsForYear(stints) }));

  // Most-recent USAU division — years are newest-first, so the first USAU
  // stint we encounter with a gender division is the latest. Drives the
  // "Teams" nav tab's division on the profile.
  let mostRecentUsauDivision: string | null = null;
  outer: for (const y of years) {
    for (const s of y.stints) {
      if (s.league === 'usau' && s.genderDivision) {
        mostRecentUsauDivision = s.genderDivision;
        break outer;
      }
    }
  }

  // ── Career aggregates ───────────────────────────────────────────────────
  // UFA + USAU add into the shared `career` block (same as before).
  // PUL is reported separately in the `pul` sub-block to avoid conflating
  // stats from potentially overlapping competitive periods.

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
        // USAU goals/assists are kept OUT of the shared `goals`/`assists`
        // counters — those are UFA-only now — and reported in their own
        // usau* fields instead (see the `career` field doc on
        // UnifiedPlayerProfile for why UFA and USAU stats don't mix).
        career.usauEventsPlayed += s.events.length;
        for (const ev of s.events) {
          if (ev.hasStats) career.usauEventsWithStats++;
          career.usauGoals += ev.goals ?? 0;
          career.usauAssists += ev.assists ?? 0;
        }
      }
      // PUL and WUL stints intentionally not added to `career` — see their
      // separate `pul` / `wul` sub-blocks (overlapping-season double-count).
    }
  }

  // PUL career sub-block. Use the pre-aggregated career from the data layer
  // rather than re-summing from the year-map to keep this clean.
  const pulCareerBlock = sidePulCareer
    ? {
        seasonsPlayed: sidePulCareer.career.seasonsPlayed,
        gamesPlayed: sidePulCareer.career.gamesPlayed,
        goals: sidePulCareer.career.goals,
        assists: sidePulCareer.career.assists,
        blocks: sidePulCareer.career.blocks,
        turnovers: sidePulCareer.career.turnovers,
        touches: sidePulCareer.career.touches,
        plusMinus: sidePulCareer.career.plusMinus,
      }
    : null;

  // WUL career sub-block — same treatment as PUL.
  const wulCareerBlock = sideWulCareer
    ? {
        seasonsPlayed: sideWulCareer.career.seasonsPlayed,
        gamesPlayed: sideWulCareer.career.gamesPlayed,
        goals: sideWulCareer.career.goals,
        assists: sideWulCareer.career.assists,
        blocks: sideWulCareer.career.blocks,
        turnovers: sideWulCareer.career.turnovers,
        touches: sideWulCareer.career.touches,
        plusMinus: sideWulCareer.career.plusMinus,
      }
    : null;

  // Pronouns: PUL data is the only league that tracks them. Surface when found.
  const pronouns =
    sidePulCareer?.pronouns ??
    (anchorPulCareer?.pronouns ?? null);

  // Content refs — every (league, id) this person is known by. User content is
  // keyed by (player_kind, player_ref); the profile fetches across ALL of these
  // so a photo uploaded under any of the person's league ids shows regardless of
  // which url the profile was reached by. Dedupe (kind,ref) pairs.
  const contentRefs: { kind: PlayerKind; ref: string }[] = [];
  const pushRef = (kind: PlayerKind, ref: string | null | undefined) => {
    if (ref && !contentRefs.some((r) => r.kind === kind && r.ref === ref)) {
      contentRefs.push({ kind, ref });
    }
  };
  pushRef('ufa', ufaSlug);
  pushRef('usau', sideUsau?.id);
  pushRef('pul', sidePulCareer?.anchorId ?? anchorPulCareer?.anchorId);
  pushRef('wul', sideWulCareer?.anchorId ?? anchorWulCareer?.anchorId);
  // Always include the anchor itself (covers any league not otherwise captured).
  pushRef(anchorLeague, anchorId);

  return {
    anchorId,
    anchorLeague,
    displayName: anchorName,
    pronouns,
    contentRefs,
    // Prefer the anchor-branch headshot (set only for UFA-anchored profiles);
    // otherwise fall back to the UFA side's headshot so a profile reached by a
    // USAU/PUL/WUL UUID still shows the player's UFA photo instead of a monogram.
    headshotUrl: headshotUrl ?? sideUfa?.headshotUrl ?? null,
    years,
    career,
    pul: pulCareerBlock,
    wul: wulCareerBlock,
    championYearsUfa: sideUfa?.championYears ?? [],
    championYearsUsau: sideUsau?.championYears ?? [],
    championTitlesWfdf: wfdfChampionTitles(years),
    mostRecentUsauDivision,
  };
}

/**
 * The multi-query assembler, exported so the RPC path can be diffed against it
 * (and so a future caller can force the slow path deliberately).
 */
export const getUnifiedPlayerProfileMultiQuery = _getUnifiedPlayerProfile;

/**
 * Resolve a unified profile, preferring the shared `get_player_profile` RPC.
 *
 * The RPC (co-owned with the mobile app) does the whole cross-league merge in
 * one round trip — ~2ms warm off its cache-aside table vs. the double-digit
 * fan-out of upstream calls the multi-query path above makes.
 *
 * Fallback policy (App Health Rule #2, 2026-08-12 outage). The old comment here
 * claimed falling back was "additive: worst case we do the work we were already
 * doing". That was wrong, and it is why load became collapse: when the DB is
 * saturated the RPC times out, and the assembler then fires 6-10 MORE queries
 * that also time out. The fallback cost more than the thing that failed.
 *
 * So we only fall back on 'shape' — the RPC answered, but the payload was
 * unmappable. That's a data defect with a healthy DB, and the assembler is a
 * genuinely different code path that may succeed. A null answer ('notfound') is
 * authoritative: no such player, no fallback. On 'unhealthy' (timeout,
 * connection failure, 5xx) we THROW, so the page fails with an uncached 500.
 * Returning null there made the page call notFound(), and ISR cached that 404
 * for a real player for the whole revalidate window (2026-10-16).
 *
 * The RPC path re-applies web's location-based UFA attribution itself, and
 * refuses payloads affected by the known upstream defects — see the header of
 * ./unified-player-rpc.ts.
 */
async function _getProfilePreferRpc(
  anchorId: string,
): Promise<UnifiedPlayerProfile | null> {
  const viaRpc = await getProfileViaRpc(anchorId);
  if (viaRpc.status === 'ok') return viaRpc.profile;
  if (viaRpc.status === 'notfound') return null;
  if (viaRpc.status === 'unhealthy') throw new Error(`player profile unavailable: ${viaRpc.reason}`);
  return _getUnifiedPlayerProfile(anchorId);
}

/**
 * Request-memoized wrapper. `/players/[id]` resolves the same profile in both
 * `generateMetadata` and the page body; `cache()` dedupes those two calls
 * within a single request so the expensive UFA/USAU fan-out runs once, not
 * twice. Cross-request caching still comes from the underlying library TTLs.
 */
export const getUnifiedPlayerProfile = cache(_getProfilePreferRpc);

// ── Reverse lookup: USAU → UFA via name ────────────────────────────────

/**
 * Find a UFA playerID by name using the token-subset match (see
 * src/lib/name-match.ts). Handles "Robert Mitchell McCarthy" (USAU) ↔
 * "Mitchell McCarthy" (UFA) — surname matches exactly, given tokens of
 * the shorter side are a subset of the longer side's.
 *
 * Walks the last 3 seasons' leaderboards. Each season fetch is cached
 * for 1h upstream so the cost is amortized across requests.
 */
async function findUfaSlugByName(name: string): Promise<string | null> {
  const aliases = await loadNameAliases();
  // DB first — one surname-narrowed query against ufa_players (all 3.6k players,
  // all seasons) instead of walking up to 3 full API leaderboards. Also strictly
  // better coverage: the API walk only saw the last 3 seasons, so a player who
  // retired before then was invisible to it.
  try {
    const hit = await findUfaSlugByNameFromDb(name, (a, b) => namesMatch(a, b, aliases));
    if (hit) return hit;
  } catch {
    // fall through to the API walk
  }

  const years = [currentSeasonYear(), currentSeasonYear() - 1, currentSeasonYear() - 2];
  for (const year of years) {
    try {
      const all = await getAllPlayerStats({ year, per: 'total' });
      const hit = all.find((p) => namesMatch(name, p.name, aliases));
      if (hit) return hit.playerID;
    } catch {
      // try next year
    }
  }
  return null;
}

// ── UFA helpers ──────────────────────────────────────────────────────────

interface UfaSideStint {
  year: number;
  stint: UfaSeasonStint;
}
interface UfaSide {
  stints: UfaSideStint[];
  championYears: number[];
  /** Self-hosted headshot for THIS UFA slug (stored first, live scrape fallback).
   *  Carried on the side so a non-UFA-anchored profile (e.g. reached by a USAU
   *  UUID) still recovers the player's UFA headshot instead of falling to a
   *  monogram. null when the player genuinely has none. */
  headshotUrl: string | null;
}

async function buildUfaSide(playerID: string): Promise<UfaSide | null> {
  // ── DB fast path ────────────────────────────────────────────────────────
  // Everything this function needs lives in our own tables (synced by
  // scripts/sync-ufa.ts, backfilled to 2014). Reading them costs 3 queries
  // regardless of career length, versus the API path below which makes one
  // game-log call PER SEASON plus a champion-detection fetch per season plus an
  // HTML scrape — the dominant cost of a profile load.
  //
  // Falls through to the API path on any error, or when the player resolves but
  // has no stat rows in the DB (a brand-new player the sync hasn't picked up
  // yet — the live API will still have them).
  try {
    const fromDb = await getUfaPlayerFromDb(playerID);
    if (fromDb && fromDb.stints.length > 0) {
      const stints: UfaSideStint[] = [];
      for (const s of fromDb.stints) {
        const tm = teamMeta(s.teamId);
        // Unknown slug → our TEAM_META is behind the DB; skip the stint rather
        // than render a broken card (mirrors the API path's teamMetaByAbbr miss).
        if (!tm) continue;
        stints.push({
          year: s.year,
          stint: {
            league: 'ufa',
            teamId: tm.id,
            teamMeta: tm,
            totals: s.totals,
            games: s.games,
            isChampion: fromDb.championYears.includes(s.year),
          },
        });
      }
      // Stored headshot first; only scrape when we genuinely have none.
      const headshot =
        fromDb.headshotUrl ??
        (await getPlayerInfo(playerID)
          .then((i) => i?.headshotUrl ?? null)
          .catch(() => null));
      return {
        stints,
        championYears: fromDb.championYears.filter((y) =>
          stints.some((s) => s.year === y && s.stint.isChampion),
        ),
        headshotUrl: headshot,
      };
    }
  } catch {
    // fall through to the live-API path
  }

  // ── Live-API fallback ───────────────────────────────────────────────────
  // Resolve the headshot for this slug up front so it's available regardless of
  // how many seasons/stints the player has (even a UFA player with no season
  // rows can still have a headshot). Stored (self-hosted) first, live scrape
  // fallback for a brand-new player the sync hasn't hosted yet.
  const headshotUrl = await getStoredHeadshotUrl(playerID)
    .then((stored) => stored ?? getPlayerInfo(playerID).then((i) => i?.headshotUrl ?? null))
    .catch(() => null);

  const seasons = await getPlayerSeasons(playerID).catch(() => [] as UfaPlayerSeasonRow[]);
  if (seasons.length === 0) return { stints: [], championYears: [], headshotUrl };

  // Group rows by (year, teamAbbrev). The UFA API emits a separate row
  // for regSeason vs playoffs and (rarely) for a mid-season trade — we
  // combine them all under one stint per team-year.
  const byYearTeam = new Map<string, UfaPlayerSeasonRow[]>();
  for (const r of seasons) {
    const key = `${r.year}|${r.teamAbbrev}`;
    if (!byYearTeam.has(key)) byYearTeam.set(key, []);
    byYearTeam.get(key)!.push(r);
  }

  const years = Array.from(new Set(seasons.map((r) => r.year))).sort((a, b) => b - a);
  const championMap = await getUfaChampionsByYear(years).catch(() => new Map<number, string>());

  // Game logs are per-year, not per-team — we fetch one per year and split
  // among the stints inside that year by team abbreviation.
  const gameLogs = await Promise.all(
    years.map((y) => getPlayerGameLog(playerID, y).catch(() => [] as UfaPlayerGameRow[])),
  );
  const logsByYear = new Map<number, UfaPlayerGameRow[]>();
  years.forEach((y, i) => logsByYear.set(y, gameLogs[i]));

  const stints: UfaSideStint[] = [];
  for (const [key, rows] of byYearTeam.entries()) {
    const [yearStr, teamAbbrev] = key.split('|');
    const year = Number(yearStr);
    const totals = sumUfaRows(rows);
    const tm = teamMetaByAbbr(teamAbbrev);
    if (!tm) continue;
    // getUfaChampionsByYear returns the team's slug (e.g. "empire"),
    // not its abbr ("NY"). Compare on slug.
    const champ = championMap.get(year);
    const isChampion = champ != null && tm.id.toLowerCase() === champ.toLowerCase();
    // Filter the year's game log to games involving this team's abbr —
    // mid-season trades are rare but this keeps us honest.
    const games = (logsByYear.get(year) ?? []).filter((g) => {
      const m = g.gameID.match(/^\d{4}-\d{2}-\d{2}-([A-Z]+)-([A-Z]+)$/);
      if (!m) return true;
      const [, away, home] = m;
      const homeMeta = teamMetaByAbbr(home);
      const awayMeta = teamMetaByAbbr(away);
      const myAbbr = tm.abbr;
      return (g.isHome && homeMeta?.abbr === myAbbr) || (!g.isHome && awayMeta?.abbr === myAbbr);
    });
    stints.push({
      year,
      stint: {
        league: 'ufa',
        teamId: tm.id,
        teamMeta: tm,
        totals,
        games,
        isChampion,
      },
    });
  }

  const championYears = Array.from(
    new Set(stints.filter((s) => s.stint.isChampion).map((s) => s.year)),
  ).sort((a, b) => b - a);

  return { stints, championYears, headshotUrl };
}

function sumUfaRows(rows: UfaPlayerSeasonRow[]): UfaSeasonStint['totals'] {
  return rows.reduce(
    (acc, r) => {
      acc.gamesPlayed += r.gamesPlayed;
      acc.goals += r.goals;
      acc.assists += r.assists;
      acc.blocks += r.blocks;
      acc.completions += r.completions;
      acc.throwsAttempted += r.throwsAttempted;
      acc.hucksCompleted += r.hucksCompleted;
      acc.hucksAttempted += r.hucksAttempted;
      acc.plusMinus += r.goals + r.assists + r.blocks - r.throwaways - r.drops - r.stalls;
      return acc;
    },
    {
      gamesPlayed: 0,
      goals: 0,
      assists: 0,
      blocks: 0,
      plusMinus: 0,
      completions: 0,
      throwsAttempted: 0,
      hucksCompleted: 0,
      hucksAttempted: 0,
    },
  );
}

// ── USAU helpers ─────────────────────────────────────────────────────────

/**
 * Pick the small label shown next to the team name (e.g. "USAU · Club"
 * or "USAU · College D-I Women"). We don't have the team's competition
 * level in the player-profile shape — fall back to plain "USAU" when we
 * can't infer.
 *
 * The stint we have only carries gender_division indirectly via the team
 * row; for v1 we use the trophy badge + the team name's natural division
 * cues. Until we plumb competition_level through, the chip stays generic.
 */
function deriveUsauChip(_stint: UsauPlayerSummary['teamHistory'][number]): string | null {
  // Placeholder hook — for now we just show "USAU" via the chip styling.
  return null;
}

// ── Ordering ─────────────────────────────────────────────────────────────

function sortStintsForYear(stints: SeasonStint[]): SeasonStint[] {
  // Ordering priority within a year: UFA (pro, per-game data) → PUL (semi-pro,
  // season totals) → USAU (club/college, tournament-style). Stable within each.
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
