'use client';

// EUF bracket tree — renders one bracket group (e.g. "Bracket 1-8") as a
// USAU-style tree: round columns left to right, cards positioned by the
// shared bracket-tree layout engine (src/lib/bracket-tree.ts), same card
// language as usau-bracket-tree.tsx (status row, team lines, box-score link).
//
// EUCS brackets are PLACEMENT brackets: the "Finals" round is four simultaneous
// games deciding 1st/3rd/5th/7th, not a single title game. So we label each
// final with the places it awards rather than calling them all "Final".
//
// Those labels come from the STORED euf_teams.final_placement (derived once by
// derive_euf_placements() in SQL) — this component does NOT re-derive them.
// An earlier version mirrored the SQL ordering rule here; that's the same
// TS-vs-SQL drift footgun as the 12-0 scoring mirror, and it can silently
// disagree with the standings table on the same page. Reading the stored value
// means a not-yet-derived event renders an unlabelled card instead of a
// confidently wrong one.

import { useMemo } from 'react';
import Link from 'next/link';
import type { EufDivision, EufGameCard } from '@/lib/euf/data';
import {
  bracketBucket,
  ordinal as sharedOrdinal,
  assignPositions as sharedAssignPositions,
  type BracketColumn,
} from '@/lib/bracket-tree';
import { eufGameDate, eufGameTime } from '@/lib/euf/format-date';
import { BracketScroller } from '@/components/bracket-scroller';
import { EufFlag } from './euf-flag';

/** Height of the placement tag rendered above a card (text + mb-1). */
const PLACE_TAG_H_PX = 16;

/** "Bracket 1-8 Semifinals" → "Bracket 1-8"
 *
 *  Upstream writes the bracket range on EITHER side of the word: the tour stops
 *  use "Bracket 1-8 Finals" while EUCF 2023 uses "1-16 Bracket Finals". Only the
 *  prefix form was matched before, so EUCF 2023's 44 bracket games — the whole
 *  championship — fell through to the flat round lists and never drew a tree.
 *  Both shapes normalize to the same "Bracket {lo}-{hi}" key so bracketBucket()
 *  labels them identically. */
function bracketOf(roundName: string | null): string | null {
  if (!roundName) return null;
  const stripped = roundName.replace(/\s+(Quarterfinals|Semifinals|Finals)$/, '');
  const prefix = stripped.match(/^Bracket (\d+)-(\d+)$/);
  if (prefix) return `Bracket ${prefix[1]}-${prefix[2]}`;
  const suffix = stripped.match(/^(\d+)-(\d+) Bracket$/);
  if (suffix) return `Bracket ${suffix[1]}-${suffix[2]}`;
  return null;
}

/** Column index within a bracket. A BARE bracket round name ("Bracket 1-8",
 *  "1-16 Bracket" — no round word) is the bracket's OPENING round: quarters in
 *  an 8-team bracket, the round of 16 in EUCF 2023's 16-team one, where it
 *  coexists with an explicit Quarterfinals round and must NOT share its depth
 *  (they used to collide at 1 and stack into one column). Labels are assigned
 *  per tree from the right — Final, Semifinals, Quarterfinals, Round of 16 —
 *  so a bare opening round still reads "Quarterfinals" when it is one. */
function depthOf(roundName: string | null): number {
  if (!roundName) return 0;
  if (/Quarterfinals$/.test(roundName)) return 1;
  if (/Semifinals$/.test(roundName)) return 2;
  if (/Finals$/.test(roundName)) return 3;
  return 0;
}

const ORDINAL = sharedOrdinal;

export function hasEufBracket(games: EufGameCard[]): boolean {
  return games.some((g) => bracketOf(g.roundName));
}

/** teamId → final_placement, from the standings rows. */
export type PlacementMap = ReadonlyMap<string, number>;

export function EufBracketTree({
  games,
  placements,
  season,
}: {
  games: EufGameCard[];
  placements: PlacementMap;
  /** Event year → `&season=` on club links. */
  season: number;
}) {
  const bracketGames = games.filter((g) => bracketOf(g.roundName));
  if (!bracketGames.length) return null;

  // A placement game's places ARE its two teams' stored placements. Sorting the
  // finals by the better of the two puts the gold game first, 3rd/4th next, and
  // so on — no re-derivation, and it stays correct if the SQL rule ever changes.
  const placesOf = (g: EufGameCard): [number, number] | null => {
    const h = g.homeTeamId ? placements.get(g.homeTeamId) : undefined;
    const a = g.awayTeamId ? placements.get(g.awayTeamId) : undefined;
    if (h == null || a == null) return null;
    return h < a ? [h, a] : [a, h];
  };

  // Group into source brackets ("Bracket 1-8", "Bracket 9-16"), then split each
  // into placement chains — one rendered tree per chain.
  const brackets = new Map<string, EufGameCard[]>();
  for (const g of bracketGames) {
    const b = bracketOf(g.roundName)!;
    if (!brackets.has(b)) brackets.set(b, []);
    brackets.get(b)!.push(g);
  }

  const trees = [...brackets.entries()]
    .flatMap(([name, list]) => splitBracketGroup(name, list, placesOf))
    .sort((a, b) => a.order - b.order);

  return (
    <div className="flex flex-col gap-8">
      {trees.map((tree) => (
        <TreeSection key={tree.id} tree={tree} placesOf={placesOf} season={season} />
      ))}
    </div>
  );
}

interface RoundColumn {
  key: string;
  label: string;
  games: EufGameCard[];
}

interface SubTree {
  id: string;
  label: string;
  order: number;
  columns: RoundColumn[];
}

function sharesTeam(a: EufGameCard, b: EufGameCard): boolean {
  const ids = [a.homeTeamId, a.awayTeamId].filter((x): x is string => !!x);
  return (b.homeTeamId != null && ids.includes(b.homeTeamId)) ||
    (b.awayTeamId != null && ids.includes(b.awayTeamId));
}

/**
 * Split one source bracket group into separately-rendered placement chains.
 *
 * EUCS publishes an ENTIRE placement structure as one bracket ("Bracket 1-8"):
 * its Semifinals round mixes winner semis with the losers' 5th–8th semis, and
 * its Finals round is four simultaneous games deciding 1st/3rd/5th/7th. Drawn
 * as one tree, the loser games share sources with the winner games, land on the
 * same midpoints, and interleave into an unreadable mesh.
 *
 * So: walk the finals in placement order, each claiming its transitive sources
 * by team overlap (a final's semis are the games its teams came from; those
 * semis' quarters likewise). A final that claims play games roots a NEW tree —
 * "Championship" (1st), "5th–8th Place" (5th) — while a final whose sources are
 * already claimed (3rd/4th rides the winner semis, 7th/8th the loser semis)
 * attaches to the tree that owns them, stacking under that tree's title game.
 * The result reads like USAU club: Quarterfinals → Semifinals → Final.
 */
/** Labels assigned from the FINAL leftwards, so a bare opening round still
 *  reads "Quarterfinals" when the bracket has no deeper rounds. */
const ROUND_LABELS_FROM_FINAL = ['Final', 'Semifinals', 'Quarterfinals', 'Round of 16'];

function toColumns(
  rounds: EufGameCard[][],
  finals: EufGameCard[],
  /** Standalone consolation tree (a lone 3rd/4th game, no feeder rounds of its
   *  own). Its single column is the game itself, not a "Final". */
  isStandalone = false,
): RoundColumn[] {
  const present = rounds.filter((r) => r.length > 0);
  const cols: RoundColumn[] = present.map((games, i) => ({
    key: `d${i}`,
    // Distance from the final slot — identical with or without a finals round,
    // since the deepest play round always sits one step left of it.
    label: ROUND_LABELS_FROM_FINAL[present.length - i] ?? 'Early Round',
    games,
  }));
  if (finals.length) {
    cols.push({ key: 'final', label: isStandalone ? 'Placement Game' : 'Final', games: finals });
  }
  return cols;
}

function splitBracketGroup(
  name: string,
  games: EufGameCard[],
  placesOf: (g: EufGameCard) => [number, number] | null,
): SubTree[] {
  const byDepth = (d: number) => games.filter((g) => depthOf(g.roundName) === d);
  const r0All = byDepth(0);
  const qfAll = byDepth(1);
  const sfAll = byDepth(2);
  const finals = byDepth(3)
    .slice()
    .sort((a, b) => (placesOf(a)?.[0] ?? 99) - (placesOf(b)?.[0] ?? 99));

  const fallbackLabel = bracketBucket(name).label;
  const bucketLo = Number(name.match(/(\d+)-/)?.[1] ?? 99);

  // No finals round (mid-tournament scrape or odd shape): render as one tree.
  if (finals.length === 0) {
    return [
      { id: name, label: fallbackLabel, order: bucketLo * 100, columns: toColumns([r0All, qfAll, sfAll], []) },
    ];
  }

  const claimed = new Set<string>();
  const trees: { finals: EufGameCard[]; rounds: EufGameCard[][] }[] = [];

  for (const f of finals) {
    // Claim this final's transitive sources, latest round first: its semis are
    // the games its teams came from, those semis' quarters likewise, and so on.
    const chain: EufGameCard[][] = [];
    let seed: EufGameCard[] = [f];
    for (const pool of [sfAll, qfAll, r0All]) {
      const claimedHere = pool.filter(
        (g) => !claimed.has(g.id) && seed.some((s) => sharesTeam(s, g)),
      );
      claimedHere.forEach((g) => claimed.add(g.id));
      chain.unshift(claimedHere);
      if (claimedHere.length) seed = claimedHere;
    }

    const claimedAny = chain.some((r) => r.length > 0);
    if (claimedAny || trees.length === 0) {
      trees.push({ finals: [f], rounds: chain });
    } else {
      // A final whose sources are all claimed — 3rd/4th rides the winner semis,
      // 7th/8th the losers'. It gets its OWN tree, never stacked into the host's
      // finals column.
      //
      // USAU PARITY: a 3rd-place game is not a round of the championship
      // bracket. USAU tags it as a separate bracket ("3rd Place" / "3rd Place
      // Game") that isChampionshipBracket() explicitly rejects, so the
      // championship tree is strictly Quarterfinals → Semifinals → Final with a
      // SINGLE title card. Stacking the consolation game under the final made
      // the Championship column read as two co-equal finals.
      trees.push({ finals: [f], rounds: [[], [], []] });
    }
  }

  // Never drop a game: play games nothing claimed (TBD teams, forfeits with a
  // null side) ride along with the first tree.
  if (trees.length) {
    [r0All, qfAll, sfAll].forEach((pool, i) => {
      const orphans = pool.filter((g) => !claimed.has(g.id));
      trees[0].rounds[i].push(...orphans);
    });
  }

  return trees.map((t, i) => {
    // Range across EVERY game in the tree, not just its finals. A 5th–8th
    // bracket's final decides 5th/6th, so reading the finals alone mislabelled
    // the whole tree "5th–6th Place" while its semis were deciding 5th–8th.
    const places = [...t.rounds.flat(), ...t.finals]
      .flatMap((g) => placesOf(g) ?? [])
      .sort((a, b) => a - b);
    const lo = places[0];
    const hi = places[places.length - 1];
    // A standalone consolation game reads by the place it awards — "3rd Place",
    // matching USAU's own bracket_name for it — not as a range spanning both
    // teams ("3rd–4th Place"), which USAU never uses as a bracket title.
    const hasPlay = t.rounds.some((r) => r.length > 0);
    const label =
      lo === 1
        ? 'Championship'
        : lo == null
          ? fallbackLabel
          : !hasPlay
            ? `${ORDINAL(lo)} Place`
            : hi != null
              ? `${ORDINAL(lo)}–${ORDINAL(hi)} Place`
              : `${ORDINAL(lo)} Place`;
    return {
      id: `${name}-${i}`,
      label,
      order: bucketLo * 100 + (lo ?? 99),
      columns: toColumns(t.rounds, t.finals, !hasPlay),
    };
  });
}

function TreeSection({
  tree,
  placesOf,
  season,
}: {
  tree: SubTree;
  placesOf: (g: EufGameCard) => [number, number] | null;
  season: number;
}) {
  // Horizontal tree at EVERY width via the shared scroll-collapsing scroller
  // (Hunter, 2026-08-20 — WFDF/USAU parity; replaces the desktop-only tree +
  // stacked-rounds mobile variant, and matches the mobile app, whose shared
  // renderer collapses EUF too). assignPositions establishes the vertical
  // order (side effect), so the scroller columns derive in the same memo.
  const { nodeColumns, positions } = useMemo(() => {
    const positions = assignPositions(tree.columns);
    const nodeColumns = tree.columns
      .filter((c) => c.games.length > 0)
      .map((c) => ({
        key: c.key,
        label: c.label,
        games: c.games.map((g) => ({
          ...gameNode(g),
          game: g,
          places: c.key === 'final' ? placesOf(g) : null,
        })),
      }));
    return { nodeColumns, positions };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree.columns]);

  if (nodeColumns.length === 0) return null;

  return (
    <div>
      <h3 className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight pb-2 border-b border-hairline mb-4">
        {tree.label}
      </h3>

      {/* Placement-tagged cards lift by the tag's height so the card body
          stays aligned with the connector elbows. */}
      <BracketScroller
        columns={nodeColumns}
        positions={positions}
        cardLift={(g) => (g.places ? PLACE_TAG_H_PX : 0)}
        renderCard={(g) => <MatchCard game={g.game} places={g.places} season={season} compact />}
      />
    </div>
  );
}

// ── Match card ────────────────────────────────────────────────────────────

function MatchCard({
  game,
  places,
  season,
  compact = false,
}: {
  game: EufGameCard;
  places: [number, number] | null;
  season: number;
  compact?: boolean;
}) {
  const homeWon =
    game.homeScore != null && game.awayScore != null && game.homeScore > game.awayScore;
  const awayWon =
    game.homeScore != null && game.awayScore != null && game.awayScore > game.homeScore;
  const isForfeit = game.status === 'forfeit';

  const fieldLabel = game.field
    ? /^\d+[A-Za-z]?$/.test(game.field.trim())
      ? `Field ${game.field.trim()}`
      : game.field.trim()
    : null;
  const meta = [
    fieldLabel,
    eufGameDate(game.scheduledAt) || null,
    eufGameTime(game.scheduledAt) || null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      {/* Placement tag sits ABOVE the card — inside the status strip it
          competed with field + date + time and truncated them all. */}
      {places && (
        <div className="text-[9px] font-bold tracking-[0.16em] uppercase text-muted font-tight whitespace-nowrap mb-1 px-0.5">
          {`${ORDINAL(places[0])} / ${ORDINAL(places[1])} place`}
        </div>
      )}
      <article className="bg-surface rounded-card-sm shadow-card overflow-hidden">
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-hairline gap-2">
          <span className="text-[9px] font-bold tracking-[0.16em] uppercase text-faint font-tight truncate">
            {meta || (isForfeit ? 'Forfeit' : '')}
          </span>
          {isForfeit && (
            <span className="text-[9px] font-bold tracking-[0.16em] uppercase text-muted font-tight flex-shrink-0">
              FF
            </span>
          )}
          {/* Box score lives on the game page. Team names below are their own
              links, so this is a separate affordance rather than wrapping the
              whole node — same rule as the flat game rows elsewhere in EUF. */}
          {game.eufGameId != null && (
            <Link
              href={`/euf/g/${game.id}`}
              prefetch={false}
              aria-label={`Box score: ${game.homeName} vs ${game.awayName}`}
              className="text-muted no-underline hover:text-accent transition-colors flex-shrink-0 text-[9px] font-bold tracking-[0.16em] uppercase font-tight"
            >
              Box
            </Link>
          )}
        </div>
        <TeamLine
          teamId={game.homeTeamId}
          name={game.homeName}
          division={game.division}
          country={game.homeCountry}
          score={game.homeScore}
          won={homeWon}
          lost={awayWon}
          compact={compact}
          season={season}
        />
        <div className="h-px bg-hairline" />
        <TeamLine
          teamId={game.awayTeamId}
          name={game.awayName}
          division={game.division}
          country={game.awayCountry}
          score={game.awayScore}
          won={awayWon}
          lost={homeWon}
          compact={compact}
          season={season}
        />
      </article>
    </>
  );
}

function TeamLine({
  teamId,
  name,
  division,
  country,
  score,
  won,
  lost,
  compact,
  season,
}: {
  teamId: string | null;
  name: string;
  division: EufDivision;
  country: string | null;
  score: number | null;
  won: boolean;
  lost: boolean;
  compact?: boolean;
  season: number;
}) {
  const labelColor = won ? 'text-ink' : lost ? 'text-faint' : 'text-muted';
  const scoreColor = won ? 'text-accent' : lost ? 'text-faint' : 'text-muted';
  const fontWeight = won ? 'font-bold' : 'font-semibold';

  const inner = (
    <span className={`flex items-center gap-2 flex-1 min-w-0 ${labelColor}`}>
      <EufFlag countryName={country} size={13} />
      <span className={`text-[13px] font-tight truncate ${fontWeight}`}>{name}</span>
    </span>
  );

  return (
    <div className={`flex items-center gap-3 px-3 ${compact ? 'py-1.5' : 'py-2'}`}>
      {teamId ? (
        <Link
          href={`/euf/clubs/${encodeURIComponent(name)}?div=${encodeURIComponent(division)}&season=${season}`}
          prefetch={false}
          className="flex-1 min-w-0 hover:opacity-80 transition-opacity no-underline"
        >
          {inner}
        </Link>
      ) : (
        <span className="flex-1 min-w-0">{inner}</span>
      )}
      <span
        className={`tabular text-[15px] font-bold font-tight leading-none w-7 text-right ${scoreColor}`}
      >
        {score ?? '–'}
      </span>
    </div>
  );
}

// ── Layout adapter ───────────────────────────────────────────────────────
// EUF games name their teams homeTeamId/awayTeamId; the shared engine wants
// homeId/awayId. Adapt at this boundary rather than renaming fields through a
// shipped component (same pattern as usau-bracket-tree.tsx's assignPositions).
function gameNode(g: EufGameCard) {
  return { id: g.id, homeId: g.homeTeamId, awayId: g.awayTeamId };
}

function assignPositions(columns: RoundColumn[]): Map<string, number> {
  const adapted: BracketColumn[] = columns.map((c) => ({
    key: c.key,
    label: c.label,
    games: c.games.map(gameNode),
  }));
  const positions = sharedAssignPositions(adapted);
  columns.forEach((col, i) => {
    const order = new Map(adapted[i].games.map((g, idx) => [g.id, idx]));
    col.games.sort((x, y) => (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0));
  });
  return positions;
}
