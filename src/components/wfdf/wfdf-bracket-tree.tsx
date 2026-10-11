'use client';

// WFDF bracket trees — reconstructs the championship AND placement brackets for
// one division of a WFDF event and renders each as a left-to-right tree
// (Round 1 → Quarterfinals → Semifinals → Final) with a final-placement rail.
//
// HOW THE TREES ARE DERIVED (modern events only — 2025-26 static-cache data):
//   WFDF game `pool_name` encodes the round: "Playoff (1-16)",
//   "Playoff (1-16) Quarterfinals/Semifinals/Finals". Each round holds BOTH the
//   championship-path games and the parallel placement (consolation) games; the
//   "Finals" round holds one game per adjacent rank pair (1/2 = gold, 3/4 =
//   bronze, 5/6, 7/8, 9/10 …). Separate "Playoff (17-24)" etc. groups are their
//   own brackets.
//
//   We partition into brackets by REACHABILITY: pick the lowest-rank final not
//   yet assigned, then grow its team set backwards (final's teams → their SF →
//   QF → R1 games). Because a top-8 team never plays a 9-16 team in the bracket,
//   each reachable team set is exactly one self-contained bracket. The lowest
//   final (ranks 1/2) yields the Championship bracket; the next yields 5th–8th
//   or 9th–16th, etc. Each bracket's placement rail comes from `final_standing`.
//
//   Layout reuses the USAU bracket approach: each later-round card sits at the
//   vertical midpoint of its source cards, so the feed reads without connectors.

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { assignPositions as sharedAssignPositions } from '@/lib/bracket-tree';
import Link from 'next/link';
import type { WfdfEventDetail } from '@/lib/wfdf/data';
import {
  buildStructuralRails,
  classifyStructRound,
  type StructuralRail,
} from '@/lib/wfdf/bracket-structure';
import { BracketScroller } from '@/components/bracket-scroller';
import { WfdfFlag } from './wfdf-flag';

type Game = WfdfEventDetail['games'][number];
type Team = WfdfEventDetail['teams'][number];

interface Props {
  divisionName: string;
  games: Game[];
  teams: Team[];
}

// Enriched game with the resolved round + per-team seed/standing/flag.
interface BracketGame {
  id: string;
  level: RoundLevel;
  homeId: string | null;
  homeName: string | null;
  homeSeed: number | null;
  homeFlag: string | null;
  homeCountry: string | null;
  homeScore: number | null;
  awayId: string | null;
  awayName: string | null;
  awaySeed: number | null;
  awayFlag: string | null;
  awayCountry: string | null;
  awayScore: number | null;
  status: string;
  scheduledAt: string | null;
  /** Field number for the card's header strip — every matchup shows where and
   *  when it's played (Hunter, 2026-08-18). */
  fieldName: string | null;
  /** Placement tag for final-column games ("3rd Place") — the sibling finals
   *  share the "Final" column, so cards carry their own rank. */
  finalLabel: string | null;
  /** Placeholder labels for unseeded sides ("W of R1 G3", "1st Pool A") —
   *  structural rails only; legacy results-walk games leave them null. */
  homeFallback: string | null;
  awayFallback: string | null;
  /** Explicit feeder game ids (structural rails) — lets the layout engine
   *  order and connect columns whose teams aren't decided yet. */
  sourceIds?: string[];
}

// Canonical round LEVEL within a playoff group. A group has whatever levels
// exist (a small 8-team group skips QF; a 4-team group skips QF+SF), always
// ending at FINAL. We chain through the present levels in order rather than
// assuming a fixed depth — this is what makes variable-size brackets work.
const LEVEL_BASE = 0; // the un-suffixed "Playoff (N-M)" round (first round)
const LEVEL_QF = 1; // "… Quarterfinals"
const LEVEL_SF = 2; // "… Semifinals"
const LEVEL_FINAL = 3; // "… Finals"
type RoundLevel = 0 | 1 | 2 | 3;

interface RoundColumn {
  label: string;
  level: RoundLevel;
  games: BracketGame[];
}

// One reconstructed bracket (championship or a placement range).
interface Bracket {
  /** Stable id for keys. */
  id: string;
  /** Human title, e.g. "Championship Bracket", "9th–16th Place". */
  title: string;
  columns: RoundColumn[];
  /** Sibling placement finals (3rd Place, 11th Place, …) — decided alongside
   *  the rail's own final but rendered in a small section BELOW the tree:
   *  stacked into the Final column they crowded the card above and clipped
   *  their placement tags (Hunter, 2026-08-20). */
  extras: BracketGame[];
  /** Final placement rail (rank → team), sorted ascending by rank. */
  rail: { rank: number; teamName: string; countryCode: string | null; flagFile: string | null }[];
  /** Gold/silver/bronze (only set on the championship bracket). */
  medals: { gold: string | null; silver: string | null; bronze: string | null } | null;
}

/** Height of the placement tag rendered above a card (text + mb-1). */
const PLACE_TAG_H_PX = 16;

// Classify a bracket game's pool_name into { group, level }. The base
// "Playoff (N-M)" name (no round suffix) is the FIRST round of that group.
// Returns null for names that aren't a numbered playoff group.
function classifyRound(pool: string | null): { group: string; level: RoundLevel } | null {
  if (!pool) return null;
  const m = pool.match(/^(Playoff \(\d+-\d+\)|Placement \(\d+-\d+\))(?:\s+(Quarterfinals|Semifinals|Finals))?$/);
  if (!m) return null;
  const group = m[1].trim();
  const suffix = m[2];
  if (suffix === 'Quarterfinals') return { group, level: LEVEL_QF };
  if (suffix === 'Semifinals') return { group, level: LEVEL_SF };
  if (suffix === 'Finals') return { group, level: LEVEL_FINAL };
  return { group, level: LEVEL_BASE };
}

/** Whether a bracket tree is derivable for this division (drives the flat-list
 *  fallback in the event detail). */
export function hasWfdfBracket(
  divisionName: string,
  games: Game[],
  teams: Team[],
): boolean {
  return buildBrackets(divisionName, games, teams).length > 0;
}

/** Ids of every bracket game the trees will actually RENDER for a division.
 *  classifyRound only places `Playoff (N-M)` / `Placement (N-M)` rounds, so
 *  "Pre-quarter", "Crossover", "Round of 32" and the placement round-robins
 *  ("Pool D (13-18)") fall through it. The event detail lists those in a flat
 *  section below the trees so no played bracket game is ever invisible. */
export function wfdfBracketCoveredIds(
  divisionName: string,
  games: Game[],
  teams: Team[],
): Set<string> {
  const ids = new Set<string>();
  for (const b of buildBrackets(divisionName, games, teams)) {
    for (const col of b.columns) {
      for (const g of col.games) ids.add(g.id);
    }
    for (const g of b.extras) ids.add(g.id);
  }
  return ids;
}

export function WfdfBracketTree({ divisionName, games, teams }: Props) {
  const brackets = useMemo(
    () => buildBrackets(divisionName, games, teams),
    [divisionName, games, teams],
  );

  if (brackets.length === 0) return null;

  return (
    <div className="flex flex-col gap-10">
      {brackets.map((b) => (
        <BracketSection key={b.id} bracket={b} />
      ))}
    </div>
  );
}

function BracketSection({ bracket }: { bracket: Bracket }) {
  // assignPositions establishes the vertical order (side effect on the column
  // arrays), so the scroller columns derive in the same memo, after it.
  const { positions, cols } = useMemo(() => {
    const positions = assignPositions(bracket.columns);
    const cols = bracket.columns
      .filter((c) => c.games.length > 0)
      .map((c) => ({ key: c.label, label: c.label, games: c.games }));
    return { positions, cols };
  }, [bracket.columns]);
  if (cols.length === 0) return null;

  return (
    <section aria-label={bracket.title}>
      {/* NOTE: the gold/silver/bronze medal tags that sat right of this title
          are removed for now (Hunter, 2026-08-21): `medals` derives from the
          EVENT-WIDE team list's finalStanding, so another division's medalist
          leaked in ("Bronze Fury" on the Mixed bracket — Fury is a women's
          team). Re-add only once the rail filters teams to this division. */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h3 className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight">
          {bracket.title}
        </h3>
      </div>

      {/* Horizontal tree at EVERY width — scroll right for later rounds, the
          same way the USAU bracket reads (Hunter, 2026-08-18). The scroller
          collapses passed rounds ESPN-style as the user swipes (Hunter,
          2026-08-20). Cards carrying a placement tag lift by its height so
          the card body stays aligned with the connector elbows. */}
      <BracketScroller
        columns={cols}
        positions={positions}
        cardLift={(g) => (g.finalLabel ? PLACE_TAG_H_PX : 0)}
        renderCard={(g) => <MatchCard game={g} />}
      />

      {/* Sibling placement finals (3rd Place, 11th Place, …) — same cards,
          own small grid so their tags never crowd the tree's final. */}
      {bracket.extras.length > 0 && (
        <div className="mt-5">
          <div className="text-[10px] font-bold tracking-[0.18em] uppercase text-faint font-tight mb-3">
            Placement games
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-x-6 gap-y-4">
            {bracket.extras.map((g) => (
              <div key={g.id}>
                <MatchCard game={g} />
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// Field number for the header strip — bare numbers get the "Field " prefix,
// same rule as the game cards / USAU's fieldLabel.
function fieldLabel(fieldName: string | null): string | null {
  const f = fieldName?.trim();
  if (!f) return null;
  return /^\d+[A-Za-z]?$/.test(f) ? `Field ${f}` : f;
}

// Compact header time, USAU-card shape ("Sat 1:30 PM"). WFDF scheduled_at is
// the venue wall clock stored as UTC (see lib/wfdf/format-date) — render in
// UTC so it reads unshifted.
function headerTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

// `compact` (tighter team-line padding) is now the norm: the header strip
// added ~28px, and the shared 104px row pitch only fits the card with the
// USAU-style compact lines.
function MatchCard({ game, compact = true }: { game: BracketGame; compact?: boolean }) {
  const router = useRouter();
  const done = game.status === 'completed' && game.homeScore != null && game.awayScore != null;
  const homeWon = done && (game.homeScore ?? 0) > (game.awayScore ?? 0);
  const awayWon = done && (game.awayScore ?? 0) > (game.homeScore ?? 0);
  const live = game.status === 'in_progress';
  const whenWhere = [fieldLabel(game.fieldName), headerTime(game.scheduledAt)]
    .filter(Boolean)
    .join(' · ');
  // Whole card opens the game matchup page — same pattern as the flat game
  // rows (role=link + push; team links inside stopPropagation).
  return (
    <>
      {/* Placement tag ("3RD PLACE") disambiguates sibling finals sharing the
          Final column. It sits ABOVE the card rather than inside the status
          strip: in-strip it competed with field + time and truncated both on
          narrow cards (Hunter, 2026-08-20). */}
      {game.finalLabel && (
        <div className="text-[9px] font-bold tracking-[0.16em] uppercase text-muted font-tight whitespace-nowrap mb-1 px-0.5">
          {game.finalLabel}
        </div>
      )}
      <article
        className="bg-surface rounded-card shadow-card overflow-hidden cursor-pointer hover:shadow-card-hover transition-shadow"
        role="link"
        tabIndex={0}
        onClick={() => router.push(`/wfdf/g/${game.id}`)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') router.push(`/wfdf/g/${game.id}`);
        }}
      >
        {/* Status strip: field + venue wall clock ALWAYS show (Hunter,
            2026-08-18). No Upcoming/Final text label — it crowded the strip and
            truncated the field/time on narrow cards (Hunter, 2026-08-20); only
            Live earns a label. */}
        {(live || whenWhere) && (
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-hairline">
            {live && (
              <span className="flex items-center gap-1.5 text-[9px] font-bold tracking-[0.16em] uppercase font-tight text-accent">
                <span className="w-[6px] h-[6px] rounded-full bg-accent animate-pulse" aria-hidden />
                Live
              </span>
            )}
            {whenWhere && (
              <span className="text-[9px] font-bold tracking-[0.16em] uppercase text-faint font-tight tabular truncate ml-auto">
                {whenWhere}
              </span>
            )}
          </div>
        )}
        <TeamLine
          teamId={game.homeId}
          name={game.homeName}
          fallback={game.homeFallback}
          seed={game.homeSeed}
          flag={game.homeFlag}
          country={game.homeCountry}
          score={game.homeScore}
          won={homeWon}
          lost={awayWon}
          done={done}
          compact={compact}
        />
        <div className="h-px bg-hairline" />
        <TeamLine
          teamId={game.awayId}
          name={game.awayName}
          fallback={game.awayFallback}
          seed={game.awaySeed}
          flag={game.awayFlag}
          country={game.awayCountry}
          score={game.awayScore}
          won={awayWon}
          lost={homeWon}
          done={done}
          compact={compact}
        />
      </article>
    </>
  );
}

function TeamLine({
  teamId,
  name,
  fallback,
  seed,
  flag,
  country,
  score,
  won,
  lost,
  done,
  compact,
}: {
  teamId: string | null;
  name: string | null;
  /** Placeholder text for an unseeded slot ("W of R1 G3", "1st Pool A"). */
  fallback?: string | null;
  seed: number | null;
  flag: string | null;
  country: string | null;
  score: number | null;
  won: boolean;
  lost: boolean;
  done: boolean;
  compact?: boolean;
}) {
  const isPlaceholder = name == null;
  const labelColor = won ? 'text-ink' : lost || isPlaceholder ? 'text-faint' : 'text-muted';
  const scoreColor = won ? 'text-accent' : lost ? 'text-faint' : 'text-muted';
  const fontWeight = won ? 'font-bold' : isPlaceholder ? 'font-medium' : 'font-semibold';

  const inner = (
    <span className={`flex items-center gap-2 flex-1 min-w-0 ${labelColor}`}>
      {seed != null && (
        <span className="tabular text-[10px] text-faint font-bold w-4 text-right shrink-0">{seed}</span>
      )}
      <WfdfFlag flagFile={flag} countryCode={country} size={14} />
      <span className={`text-[13px] font-tight truncate ${fontWeight}`}>
        {name ?? fallback ?? 'TBD'}
      </span>
    </span>
  );

  return (
    <div className={`flex items-center gap-3 px-3 ${compact ? 'py-1.5' : 'py-2'}`}>
      {teamId ? (
        <Link
          href={`/wfdf/teams/${teamId}`}
          prefetch={false}
          className="flex-1 min-w-0 hover:opacity-80 transition-opacity no-underline"
          onClick={(e) => e.stopPropagation()}
        >
          {inner}
        </Link>
      ) : (
        <span className="flex-1 min-w-0">{inner}</span>
      )}
      <span className={`tabular text-[15px] font-bold font-tight leading-none w-7 text-right ${scoreColor}`}>
        {done ? score : '–'}
      </span>
    </div>
  );
}

// ── Tree construction ──────────────────────────────────────────────────────

function buildBrackets(divisionName: string, games: Game[], teams: Team[]): Bracket[] {
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const divisionGames = games.filter((g) => g.divisionName === divisionName);

  // ── Structural pass (modern events with scheduling metadata) ──────────────
  // Each playoff group first tries the source-described full structure —
  // future rounds included, TBD slots showing their placeholder text. Groups
  // the metadata can't fully describe fall through to the legacy results-walk
  // below, so legacy events render exactly as before.
  const structuralBrackets: Bracket[] = [];
  const structuralGroups = new Set<string>();
  {
    const groupNames = new Set<string>();
    for (const g of divisionGames) {
      if (!g.isBracket) continue;
      const c = classifyStructRound(g.poolName);
      if (c) groupNames.add(c.group);
    }
    for (const group of groupNames) {
      const rails = buildStructuralRails(group, divisionGames);
      if (!rails) continue;
      structuralGroups.add(group);
      for (const rail of rails) structuralBrackets.push(railToBracket(rail, teamById));
    }
  }

  // ── Legacy results-walk (groups without usable scheduling metadata) ───────
  // Collect this division's numbered-playoff bracket games, tagged by round +
  // group. Multiple groups may coexist (e.g. "Playoff (1-16)" and
  // "Placement (17-24)") — we handle each group's brackets independently.
  const byGroup = new Map<string, BracketGame[]>();
  for (const g of divisionGames) {
    if (!g.isBracket) continue;
    const c = classifyRound(g.poolName);
    if (!c || structuralGroups.has(c.group)) continue;
    if (!byGroup.has(c.group)) byGroup.set(c.group, []);
    byGroup.get(c.group)!.push(enrich(g, c.level, teamById));
  }
  if (byGroup.size === 0) {
    structuralBrackets.sort((a, b) => bracketMinRank(a) - bracketMinRank(b));
    return structuralBrackets;
  }

  const standingOf = (id: string | null) => (id ? teamById.get(id)?.finalStanding ?? 9999 : 9999);

  const brackets: Bracket[] = [];

  // Sort groups so the top group (lowest starting rank) comes first.
  const groups = [...byGroup.entries()].sort((a, b) => startRank(a[0]) - startRank(b[0]));

  for (const [group, tagged] of groups) {
    // Bucket by canonical level; keep only the levels that actually exist.
    const byLevel = new Map<RoundLevel, BracketGame[]>();
    for (const g of tagged) {
      if (!byLevel.has(g.level)) byLevel.set(g.level, []);
      byLevel.get(g.level)!.push(g);
    }
    const presentLevels = [...byLevel.keys()].sort((a, b) => a - b); // ascending
    if (!byLevel.has(LEVEL_FINAL)) continue; // no finals → can't rank a tree
    const baseLevel = presentLevels[0];

    // PARTITION into sub-brackets. Each "final" decides two adjacent ranks. We
    // grow each bracket's team set backwards through the NON-BASE levels only.
    // Rationale: the base round pairs a team that advances up with one that
    // drops to a lower bracket, so base games bridge sibling brackets and would
    // collapse them if walked. Each base game is instead assigned to its
    // WINNER's bracket. For narrow groups (base + final only, no middle rounds)
    // there's nothing to bridge, so the whole group is one bracket.
    const finals = [...(byLevel.get(LEVEL_FINAL) ?? [])].sort(
      (a, b) =>
        Math.min(standingOf(a.homeId), standingOf(a.awayId)) -
        Math.min(standingOf(b.homeId), standingOf(b.awayId)),
    );
    const usedFinals = new Set<string>();

    // A group is WIDE (its base round splits into a top bracket + a lower
    // "N/2..N" bracket) iff it has a Quarterfinals round. WFDF only emits a QF
    // suffix on the big 16-team groups ("Playoff (1-16)", "Playoff (17-32)")
    // that split; the 8-team groups ("Playoff (1-8)", "Playoff (9-16)") run
    // base→Semifinals→Finals with the base losers staying in the SAME bracket
    // for 5th-8th, and the tiny 4-team groups ("Playoff (1-4)") run
    // base→Finals. So: wide = QF present; narrow = no QF.
    const isWide = byLevel.has(LEVEL_QF);

    // For a WIDE group we walk the middle rounds and split at the base (winner
    // up / loser down). For a NARROW group the base round belongs wholly to the
    // one bracket, so we DON'T treat it as a splitter — walk every non-final
    // round including the base.
    const walkLevels = presentLevels
      .filter((l) => l < LEVEL_FINAL && (isWide ? l > baseLevel : true))
      .sort((a, b) => b - a);

    for (const finalGame of finals) {
      if (usedFinals.has(finalGame.id)) continue;

      const bracketGames: BracketGame[] = [finalGame];
      const teamSet = new Set<string>(
        [finalGame.homeId, finalGame.awayId].filter((x): x is string => !!x),
      );

      // Walk down through the walk levels collecting sources. For a narrow
      // group this includes the base round (all its teams stay in-bracket); for
      // a wide group it stops above the base (the base is winner-split below).
      let frontier: BracketGame[] = [finalGame];
      for (const lvl of walkLevels) {
        const src = frontier.flatMap((f) => winnerSources(f, byLevel.get(lvl) ?? []));
        collect(src, bracketGames, teamSet);
        frontier = src;
      }

      // Rank set = teams connected through the walked rounds. For a wide group
      // that's the top-half only (base losers drop to the sibling bracket); for
      // a narrow group it's the whole bracket (base losers rank here).
      const rankTeamIds = new Set(teamSet);

      // Sibling finals (bronze / 5th-6th / 7th-8th …) belong to this bracket
      // when BOTH their teams are in the RANK set — i.e. placement games among
      // this bracket's own round losers. We match against rankTeamIds (the
      // walked, pre-base set) so that for a WIDE group the lower bracket's
      // finals don't get absorbed once base losers are folded in below.
      const siblingFinals = finals.filter(
        (f) =>
          f.id !== finalGame.id &&
          !usedFinals.has(f.id) &&
          rankTeamIds.has(f.homeId ?? '') &&
          rankTeamIds.has(f.awayId ?? ''),
      );
      for (const f of siblingFinals) {
        usedFinals.add(f.id);
        bracketGames.push(f);
        if (f.homeId) rankTeamIds.add(f.homeId);
        if (f.awayId) rankTeamIds.add(f.awayId);
      }
      usedFinals.add(finalGame.id);

      // WIDE groups only: the base round splits — assign each base game to its
      // WINNER's bracket (the loser drops to the sibling bracket, ranked there).
      // Done AFTER sibling matching so base losers don't leak into this rail.
      if (isWide) {
        const baseGames = (byLevel.get(baseLevel) ?? []).filter((g) => {
          if (bracketGames.some((bg) => bg.id === g.id)) return false;
          const w = winnerOf(g);
          return w != null && teamSet.has(w);
        });
        collect(baseGames, bracketGames, teamSet);
      }

      const bracket = assembleBracket(group, bracketGames, rankTeamIds, presentLevels, teamById);
      if (bracket) brackets.push(bracket);
    }
  }

  // Order: championship (contains rank 1) first, then by starting rank.
  const merged = [...structuralBrackets, ...brackets];
  merged.sort((a, b) => bracketMinRank(a) - bracketMinRank(b));
  return merged;
}

// ─── Structural rail → Bracket (rendering shape) ─────────────────────────────

function railToBracket(rail: StructuralRail, teamById: Map<string, Team>): Bracket {
  const gameCols = rail.columns.map((col) =>
    col.map((g) => {
      const bg = enrich(g, LEVEL_BASE as RoundLevel, teamById);
      const fb = rail.fallbacks.get(g.id);
      bg.homeFallback = fb?.home ?? null;
      bg.awayFallback = fb?.away ?? null;
      bg.finalLabel = rail.finalLabels.get(g.id) ?? null;
      const src = rail.sources.get(g.id);
      if (src && src.length > 0) bg.sourceIds = src;
      return bg;
    }),
  );
  // The rail's final column is [primary final, …sibling placement finals]
  // (bracket-structure contract) — siblings render below the tree, not in it.
  const extras = gameCols.length > 0 ? gameCols[gameCols.length - 1].splice(1) : [];
  const relLabels = relativeRoundLabels(gameCols.length);
  const columns: RoundColumn[] = gameCols.map((gs, i) => ({
    level: (i === gameCols.length - 1 ? LEVEL_FINAL : LEVEL_BASE) as RoundLevel,
    label: relLabels[i],
    games: gs,
  }));

  // Rail = the teams whose final placements land in this section's rank range
  // (drives medals; empty until standings post).
  const railRows = [...teamById.values()]
    .filter(
      (t) =>
        t.finalStanding != null &&
        t.finalStanding >= rail.minRank &&
        t.finalStanding <= rail.maxRank,
    )
    .sort((a, b) => (a.finalStanding ?? 0) - (b.finalStanding ?? 0))
    .map((t) => ({
      rank: t.finalStanding as number,
      teamName: t.name,
      countryCode: t.countryCode,
      flagFile: t.flagFile,
    }));

  let title: string;
  let medals: Bracket['medals'] = null;
  if (rail.minRank === 1) {
    title = 'Championship Bracket';
    medals = {
      gold: railRows.find((r) => r.rank === 1)?.teamName ?? null,
      silver: railRows.find((r) => r.rank === 2)?.teamName ?? null,
      bronze: railRows.find((r) => r.rank === 3)?.teamName ?? null,
    };
    if (!medals.gold && !medals.silver && !medals.bronze) medals = null;
  } else {
    title = `${ordinal(rail.minRank)}–${ordinal(rail.maxRank)} Place`;
  }

  return { id: `${rail.group}-${rail.minRank}`, title, columns, extras, rail: railRows, medals };
}

function winnerOf(g: BracketGame): string | null {
  if (g.homeScore == null || g.awayScore == null) return null;
  if (g.homeScore === g.awayScore) return null;
  return g.homeScore > g.awayScore ? g.homeId : g.awayId;
}

function assembleBracket(
  group: string,
  gamesIn: BracketGame[],
  rankTeamIds: Set<string>,
  presentLevels: RoundLevel[],
  teamById: Map<string, Team>,
): Bracket | null {
  const dedupe = (arr: BracketGame[]) =>
    Array.from(new Map(arr.map((g) => [g.id, g])).values());
  const all = dedupe(gamesIn);

  const byLevel = new Map<RoundLevel, BracketGame[]>();
  for (const g of all) {
    if (!byLevel.has(g.level)) byLevel.set(g.level, []);
    byLevel.get(g.level)!.push(g);
  }

  const standingOf = (id: string | null) => (id ? teamById.get(id)?.finalStanding ?? 9999 : 9999);
  const topFinal = [...(byLevel.get(LEVEL_FINAL) ?? [])].sort(
    (a, b) =>
      Math.min(standingOf(a.homeId), standingOf(a.awayId)) -
      Math.min(standingOf(b.homeId), standingOf(b.awayId)),
  )[0];
  if (!topFinal) return null;

  // Build the winner's-path columns by walking down through the present levels
  // (final → each lower present level in turn). A missing level (e.g. no QF in
  // an 8-team bracket) is simply skipped — the walk chains SF directly onto the
  // base round. Column order is deepest-round → final.
  const levelsDesc = presentLevels.filter((l) => l < LEVEL_FINAL).sort((a, b) => b - a);
  const columnsDesc: BracketGame[][] = [];
  let frontier: BracketGame[] = [topFinal];
  for (const lvl of levelsDesc) {
    const src = dedupe(frontier.flatMap((f) => winnerSources(f, byLevel.get(lvl) ?? [])));
    if (src.length > 0) {
      columnsDesc.push(src);
      frontier = src;
    }
  }
  // columnsDesc is deepest-first already (we pushed SF, then QF/base). Reverse
  // to render left→right, then append the final.
  const orderedGameCols = [...columnsDesc].reverse();
  orderedGameCols.push([topFinal]);

  // Placement tag when this section's final ISN'T the gold-medal game — legacy
  // events derive it from the finalists' final standings.
  {
    const r = Math.min(standingOf(topFinal.homeId), standingOf(topFinal.awayId));
    if (r > 1 && r < 9000) topFinal.finalLabel = `${ordinal(r)} Place`;
  }

  // Sibling placement finals (bronze, 5/6, …) render below the tree. These
  // were previously collected into the bracket but never given a column, so
  // legacy events silently dropped them.
  const extras = [...(byLevel.get(LEVEL_FINAL) ?? [])]
    .filter((g) => g.id !== topFinal.id)
    .sort(
      (a, b) =>
        Math.min(standingOf(a.homeId), standingOf(a.awayId)) -
        Math.min(standingOf(b.homeId), standingOf(b.awayId)),
    );
  for (const e of extras) {
    const r = Math.min(standingOf(e.homeId), standingOf(e.awayId));
    if (r > 1 && r < 9000) e.finalLabel = `${ordinal(r)} Place`;
  }

  // Relative labels: last col = Final, filling backward SF/QF/Round 1.
  const relLabels = relativeRoundLabels(orderedGameCols.length);
  const columns: RoundColumn[] = orderedGameCols.map((gs, i) => ({
    level: (i === orderedGameCols.length - 1 ? LEVEL_FINAL : LEVEL_BASE) as RoundLevel,
    label: relLabels[i],
    games: gs,
  }));

  // Placement rail — the teams that RANK in this bracket (its own rank range),
  // ascending. Uses rankTeamIds (SF/QF-connected set), NOT every team in the
  // games, so R1 losers who drop to a lower bracket aren't listed here.
  const rail = [...rankTeamIds]
    .map((id) => teamById.get(id))
    .filter((t): t is Team => !!t && t.finalStanding != null)
    .sort((a, b) => (a.finalStanding ?? 0) - (b.finalStanding ?? 0))
    .map((t) => ({
      rank: t.finalStanding as number,
      teamName: t.name,
      countryCode: t.countryCode,
      flagFile: t.flagFile,
    }));

  const minRank = rail.length ? rail[0].rank : startRank(group);
  const maxRank = rail.length ? rail[rail.length - 1].rank : 9999;

  let title: string;
  let medals: Bracket['medals'] = null;
  if (minRank === 1) {
    title = 'Championship Bracket';
    medals = {
      gold: rail.find((r) => r.rank === 1)?.teamName ?? null,
      silver: rail.find((r) => r.rank === 2)?.teamName ?? null,
      bronze: rail.find((r) => r.rank === 3)?.teamName ?? null,
    };
  } else if (rail.length) {
    title = `${ordinal(minRank)}–${ordinal(maxRank)} Place`;
  } else {
    title = groupTitle(group);
  }

  return { id: `${group}-${minRank}`, title, columns, extras, rail, medals };
}

// Round labels for a bracket with `n` columns, ending in Final. e.g. n=4 →
// [Round of 16, Quarterfinals, Semifinals, Final]; n=2 → [Semifinals, Final].
// Beyond the named tail the label comes from the round's SLOT count — a column
// k rounds before the final nominally holds 2^(k+1) teams, so n=5 leads with
// "Round of 32" (the old fixed tail made every early column read "Round 1",
// so WUCC showed two "Round 1" columns side by side — Hunter, 2026-08-20).
// Derived from position, not this column's game count, so byes/partial data
// don't mislabel the round.
function relativeRoundLabels(n: number): string[] {
  const tail = ['Final', 'Semifinals', 'Quarterfinals'];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const fromEnd = n - 1 - i;
    out.push(fromEnd < tail.length ? tail[fromEnd] : `Round of ${2 ** (fromEnd + 1)}`);
  }
  return out;
}

function enrich(g: Game, level: RoundLevel, teamById: Map<string, Team>): BracketGame {
  const home = g.homeTeamId ? teamById.get(g.homeTeamId) : null;
  const away = g.awayTeamId ? teamById.get(g.awayTeamId) : null;
  return {
    id: g.id,
    level,
    homeId: g.homeTeamId,
    homeName: g.homeTeam,
    homeSeed: home?.seed ?? null,
    homeFlag: home?.flagFile ?? null,
    homeCountry: g.homeCountry,
    homeScore: g.homeScore,
    awayId: g.awayTeamId,
    awayName: g.awayTeam,
    awaySeed: away?.seed ?? null,
    awayFlag: away?.flagFile ?? null,
    awayCountry: g.awayCountry,
    awayScore: g.awayScore,
    status: g.status,
    scheduledAt: g.scheduledAt,
    fieldName: g.fieldName,
    finalLabel: null,
    homeFallback: null,
    awayFallback: null,
  };
}

// Add games to the accumulator + register their teams in the set.
function collect(games: BracketGame[], into: BracketGame[], teamSet: Set<string>) {
  for (const g of games) {
    into.push(g);
    if (g.homeId) teamSet.add(g.homeId);
    if (g.awayId) teamSet.add(g.awayId);
  }
}

// The prev-round games that fed `game`: those sharing at least one team id.
function sourcesFor(game: BracketGame, prev: BracketGame[]): BracketGame[] {
  const ids = [game.homeId, game.awayId].filter((x): x is string => !!x);
  if (ids.length === 0) return [];
  const out: BracketGame[] = [];
  for (const c of prev) {
    if ((c.homeId && ids.includes(c.homeId)) || (c.awayId && ids.includes(c.awayId))) {
      out.push(c);
    }
  }
  return out;
}

// Winner-path-aware version of sourcesFor: a DECIDED source game only feeds
// `game` if its winner actually advanced into it. Every round spans ALL
// placement rails at once, so a loose either-team match lets a sibling rail's
// losers (e.g. 5th-8th's semifinalists, who are the championship QF losers)
// re-absorb the championship's own QF/R1 games. Undecided games keep the
// loose match so mid-event trees still chain before results are in.
function winnerSources(game: BracketGame, prev: BracketGame[]): BracketGame[] {
  const ids = new Set([game.homeId, game.awayId].filter((x): x is string => !!x));
  return sourcesFor(game, prev).filter((c) => {
    const w = winnerOf(c);
    return w == null || ids.has(w);
  });
}

function startRank(group: string): number {
  const m = group.match(/\((\d+)-\d+\)/);
  return m ? Number(m[1]) : 9999;
}

function groupTitle(group: string): string {
  const m = group.match(/\((\d+)-(\d+)\)/);
  if (m) return `${ordinal(Number(m[1]))}–${ordinal(Number(m[2]))} Place`;
  return group;
}

function bracketMinRank(b: Bracket): number {
  return b.rail.length ? b.rail[0].rank : Number(b.id.split('-').pop()) || 9999;
}

// ── Vertical positioning (midpoint-of-sources, same as USAU tree) ──────────

// Layout math lives in src/lib/bracket-tree.ts, shared with the USAU and EUF
// trees. WFDF's BracketGame already uses homeId/awayId, so it feeds the engine
// directly. (This local copy also lacked USAU's de-overlap pass; the shared
// engine has it, so co-located WFDF cards no longer paint on top of each other.)
const assignPositions = sharedAssignPositions;

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
