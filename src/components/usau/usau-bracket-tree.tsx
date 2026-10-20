'use client';

// Tournament bracket tree visualization for USAU events.
//
// Takes a flat list of championship-bracket games (already gender-filtered
// by the parent UsauEventDetail) and derives a left-to-right tree:
//   R1 (8 games) → QFs (8) → SFs (4) → Final
//
// The parser stores Friday R1 + Saturday QFs both as round='quarter'. We
// split them by scheduled date: earliest-date quarters = R1, later = QFs.
//
// Layout strategy: dependency-driven. Each card in column N+1 is positioned
// at the vertical midpoint of its source card(s) in column N. This makes
// the visual flow read "R1 game → QF game" without explicit connector
// lines. Source detection is by team participation — a QF feeding from R1
// must contain at least one of the R1 winners (or both teams if neither
// had a bye).

import { useMemo } from 'react';
import {
  bracketBucket,
  type BracketBucket,
  assignPositions as sharedAssignPositions,
} from '@/lib/bracket-tree';
import { BracketScroller } from '@/components/bracket-scroller';
import Link from 'next/link';
import type { UsauEventSummary } from '@/lib/usau/data';
import { formatGameTime } from '@/lib/usau/venue-tz';
import { gameWinnerId, isForfeit } from '@/lib/usau/game-winner';

type Game = UsauEventSummary['games'][number];
type Team = UsauEventSummary['teams'][number];

interface Props {
  games: Game[];
  /** Currently filtered teams. Reserved for future use (e.g. displaying
   *  bye seeds explicitly); the bracket tree itself derives everything
   *  from the games array. */
  teams: Team[];
  /** The event's US state — game times are shown as the VENUE's wall clock
   *  (scheduled_at is a true UTC instant; see lib/usau/venue-tz). */
  venueState?: string | null;
  /** Render placement brackets (5th/9th/13th …) as extra trees alongside the
   *  championship. Off by default: the event page surfaces placement through
   *  its own dropdown filter, and rendering both duplicates every game. */
  includePlacement?: boolean;
  /** The event's season, appended to team links as `?season=` so clicking a
   *  team from a 2014 tournament lands on that team's 2014 page instead of its
   *  most recent one (UsauTeamHistory reads the param and falls back to the
   *  newest season when the team has no row for it). Optional: omit and links
   *  keep today's behavior. */
  season?: number | null;
}

interface RoundColumn {
  /** Display label for this column. */
  label: string;
  /** Stable key. */
  key: 'r16' | 'r1' | 'qf' | 'sf' | 'final';
  games: Game[];
}

// Vertical pitch (height per "row slot") on desktop. The base column sets the
// unit; every later column anchors to its row slots so cards line up. Card
// height ≈ 88px; we leave a bit of breathing room.
// Layout math is shared across every league's bracket tree — see
// src/lib/bracket-tree.ts. USAU slots name their teams via the underlying
// game's teamAId/teamBId (null for placeholders), so we adapt to the engine's
// homeId/awayId shape at this boundary rather than renaming fields through a
// shipped component. Placeholder slots carry no team ids, so their linkage
// rides entirely on sourceIds — see slotToNode below for real-slot fallback.
function slotNode(s: Slot) {
  return {
    id: s.id,
    homeId: s.game?.teamAId ?? s.aResolved?.teamId ?? null,
    awayId: s.game?.teamBId ?? s.bResolved?.teamId ?? null,
    sourceIds: s.sourceIds,
  };
}

function assignPositions(columns: SlotColumn[]): Map<string, number> {
  const adapted = columns.map((c) => ({
    key: c.key,
    label: c.label,
    games: c.slots.map(slotNode),
  }));
  const positions = sharedAssignPositions(adapted);
  // The engine re-sorts each column into vertical order; mirror that ordering
  // back onto the real slot arrays so render order matches the layout.
  columns.forEach((col, i) => {
    const order = new Map(adapted[i].games.map((g, idx) => [g.id, idx]));
    col.slots.sort((x, y) => (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0));
  });
  return positions;
}

/** The group prefix of a combined-event bracket name ("GM Women · 1st
 *  Place" → "GM Women"); '' when unprefixed. Combined masters championships
 *  run several INDEPENDENT championship brackets in one event (Masters /
 *  GM / GGM per gender) — the prefix is the only reliable way to tell a GM
 *  Women game from a GGM Women game within the games already loaded for the
 *  combined event. */
export function bracketGroupPrefix(name: string | null | undefined): string {
  if (!name) return '';
  const i = name.lastIndexOf('·');
  return i >= 0 ? name.slice(0, i).trim() : '';
}

/**
 * Renders a single already-filtered game list (one placement bracket, e.g.
 * "9th Place Bracket") as a bracket tree, with no heading of its own — the
 * caller (usau-event-detail's Bracket tab) supplies the label. Reuses the
 * same column-building + positioning as the championship tree so placement
 * brackets that are genuinely multi-round get the identical tree treatment.
 */
export function UsauPlacementBracketTree({
  games,
  venueState,
  season,
}: {
  games: Game[];
  venueState?: string | null;
  season?: number | null;
}) {
  return (
    <BracketTreeGroup
      games={games}
      label={null}
      venueState={venueState ?? null}
      season={season ?? null}
    />
  );
}

/**
 * Flat placement groups ("Third", "Eleventh Place") rendered with the SAME
 * MatchCard + scroller column sizing as the trees around them — a full-width
 * one-off card sandwiched between trees read as a different component
 * (Hunter, 2026-08-27). The caller pre-groups games into labeled round
 * columns (it owns the round-remap rules); this only lays them out. Synthetic
 * slots carry no feeders, so no connector lines draw.
 */
export function UsauFlatBracketCards({
  rounds,
  venueState,
  season,
}: {
  rounds: Array<{ label: string; games: Game[] }>;
  venueState?: string | null;
  season?: number | null;
}) {
  const { nodeColumns, positions } = useMemo(() => {
    const columns: SlotColumn[] = rounds.map((r, ci) => ({
      key: `flat-${ci}`,
      label: r.label,
      slots: r.games.map((g, i) => ({
        id: g.id,
        game: g,
        number: i + 1,
        sourceIds: [],
        aFallback: null,
        bFallback: null,
        aResolved: null,
        bResolved: null,
      })),
    }));
    const positions = assignPositions(columns);
    const nodeColumns = columns
      .filter((c) => c.slots.length > 0)
      .map((c) => ({
        key: c.key,
        label: c.label,
        games: c.slots.map((s) => ({ ...slotNode(s), slot: s })),
      }));
    return { nodeColumns, positions };
  }, [rounds]);

  if (nodeColumns.length === 0) return null;

  return (
    <BracketScroller
      columns={nodeColumns}
      positions={positions}
      renderCard={(g) => <MatchCard slot={g.slot} venueState={venueState ?? null} season={season ?? null} />}
    />
  );
}

export function UsauBracketTree({ games, venueState, includePlacement = false, season }: Props) {
  // ── Which brackets this tree renders ──────────────────────────────────
  // Tournaments run parallel placement brackets (5th, 9th, 13th …) that decide
  // real finishes, and this component can bucket EVERY bracket game by
  // (group prefix, placement bucket) into its own labeled tree.
  //
  // But the event page already routes placement brackets to their own "5th
  // Place" / "9th Place" dropdown filter, so rendering them here too showed the
  // SAME games twice — and the duplicate read as a stray, final-less
  // "SEMIFINALS" column hanging off the championship tree (the 5th-place
  // bracket at the 2026 U.S. Open is 6 semis with no final). Default to
  // championship-only; callers with no placement UI of their own opt in.
  //
  // Group prefix still splits combined-masters events (Masters Mixed vs Grand
  // Masters Open) so unrelated brackets never share a tree.
  const groups = useMemo(() => {
    const bracketGames = games.filter(
      (g) => isBracketGame(g) && (includePlacement || isChampionshipBracket(g)),
    );
    const byKey = new Map<string, { prefix: string; bucket: BracketBucket; games: Game[] }>();
    for (const g of bracketGames) {
      const prefix = bracketGroupPrefix(g.bracketName);
      const bucket = bracketBucket(g.bracketName);
      const k = `${prefix}|${bucket.key}`;
      if (!byKey.has(k)) byKey.set(k, { prefix, bucket, games: [] });
      byKey.get(k)!.games.push(g);
    }
    return Array.from(byKey.values()).sort(
      (a, b) => a.prefix.localeCompare(b.prefix) || a.bucket.order - b.bucket.order,
    );
  }, [games, includePlacement]);

  if (groups.length === 0) return null;

  const multiPrefix = new Set(groups.map((g) => g.prefix)).size > 1;

  return (
    <section className="mb-10" aria-labelledby="bracket-heading">
      <h2
        id="bracket-heading"
        className="text-[10px] font-bold tracking-[0.18em] uppercase text-muted font-tight mb-4"
      >
        {groups.length > 1 ? 'Brackets' : 'Championship bracket'}
      </h2>
      <div className="flex flex-col gap-8">
        {groups.map((group) => (
          <BracketTreeGroup
            key={`${group.prefix}|${group.bucket.key}`}
            games={group.games}
            label={
              groups.length > 1
                ? [multiPrefix ? group.prefix : '', group.bucket.label]
                    .filter(Boolean)
                    .join(' · ')
                : null
            }
            venueState={venueState ?? null}
            season={season ?? null}
          />
        ))}
      </div>
    </section>
  );
}

function BracketTreeGroup({
  games,
  label,
  venueState,
  season,
}: {
  games: Game[];
  label: string | null;
  venueState: string | null;
  season?: number | null;
}) {
  // ── Split into round columns, complete the bracket, assign positions ───
  // assignPositions establishes the vertical slot order (side effect), so the
  // scroller's node columns derive in the same memo, after it. Each node keeps
  // its slot so renderCard can hand MatchCard the real thing.
  const { nodeColumns, positions } = useMemo(() => {
    // Structure scraped from USAU's own bracket markup wins whenever any row
    // carries it (2026-09-13); the round-based heuristics below stay for rows
    // written before the structure columns existed.
    const columns = hasBracketStructure(games)
      ? buildStructuredColumns(games)
      : completeBracket(buildColumns(games));
    const positions = assignPositions(columns);
    const nodeColumns = columns
      .filter((c) => c.slots.length > 0)
      .map((c) => ({
        key: c.key,
        label: c.label,
        games: c.slots.map((s) => ({ ...slotNode(s), slot: s })),
      }));
    return { nodeColumns, positions };
  }, [games]);

  if (nodeColumns.length === 0) {
    return null;
  }

  return (
    <div>
      {label && (
        <h3 className="font-display italic font-bold text-[20px] leading-tight tracking-[-0.02em] text-ink mb-3">
          {label}
        </h3>
      )}

      {/* Horizontal tree at EVERY width — scroll right for later rounds, same
          as the WFDF bracket and the native app (Hunter, 2026-08-20; replaces
          the old stacked-rounds mobile variant, whose latest-first list read
          as "the Final has two games"). The scroller collapses passed rounds
          ESPN-style as the user swipes. */}
      <BracketScroller
        columns={nodeColumns}
        positions={positions}
        renderCard={(g) => <MatchCard slot={g.slot} venueState={venueState} season={season ?? null} />}
      />
    </div>
  );
}

// ── Match card ────────────────────────────────────────────────────────────

function MatchCard({
  slot,
  venueState,
  compact = false,
  season,
}: {
  slot: Slot;
  venueState: string | null;
  compact?: boolean;
  season?: number | null;
}) {
  const game = slot.game;
  const tag = `G${slot.number}`;

  // Wholly-synthesized slot (no stored row at all): a pure placeholder card
  // with only its "W of …" side labels and game-number tag. The blank span
  // keeps the strip the same height as real cards when the tag is hidden
  // (mobile), which the tree's row pitch assumes.
  if (!game) {
    return (
      <article className="bg-surface rounded-card-sm overflow-hidden shadow-card">
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-hairline">
          <StatusPill tone="upcoming" label="" tag={tag} />
          <span className="text-[9px] font-bold tracking-[0.16em] uppercase text-faint font-tight">{' '}</span>
        </div>
        <TeamLine
          teamId={slot.aResolved?.teamId ?? null}
          name={slot.aResolved?.name ?? null}
          fallback={slot.aFallback}
          seed={slot.aResolved?.seed ?? null}
          score={null}
          won={false}
          lost={false}
          compact={compact}
          season={season}
        />
        <div className="h-px bg-hairline" />
        <TeamLine
          teamId={slot.bResolved?.teamId ?? null}
          name={slot.bResolved?.name ?? null}
          fallback={slot.bFallback}
          seed={slot.bResolved?.seed ?? null}
          score={null}
          won={false}
          lost={false}
          compact={compact}
          season={season}
        />
      </article>
    );
  }

  const forfeit = isForfeit(game);
  const aWon = forfeit
    ? game.winnerTeamId === game.teamAId
    : game.scoreA != null && game.scoreB != null && game.scoreA > game.scoreB;
  const bWon = forfeit
    ? game.winnerTeamId === game.teamBId
    : game.scoreA != null && game.scoreB != null && game.scoreB > game.scoreA;
  let tone = matchTone(game);
  const label = statusLabel(game);
  // A slot that names its origin isn't a bare "TBD" card anymore — it's a
  // scheduled game whose participants are pending, so it reads as upcoming
  // (cancelled keeps its own treatment via matchTone/statusLabel).
  if (
    (slot.aFallback || slot.bFallback || slot.aResolved || slot.bResolved) &&
    tone === 'tbd' &&
    game.status !== 'cancelled'
  ) {
    tone = 'upcoming';
  }
  // Cancelled games carry 0–0 in the DB, and so does USAU's unplayed
  // placeholder on a scheduled game (rows scraped before 2026-09-11) — "0 0"
  // under either reads like a played shutout, so blank the scores instead.
  const unplayed = game.status === 'scheduled' && game.scoreA === 0 && game.scoreB === 0;
  // A forfeit shows USAU's own W/F letters in place of the scores.
  const scoreA = forfeit ? (aWon ? 'W' : 'F') : tone === 'cancelled' || unplayed ? null : game.scoreA;
  const scoreB = forfeit ? (bWon ? 'W' : 'F') : tone === 'cancelled' || unplayed ? null : game.scoreB;

  return (
    <article
      className={[
        'bg-surface rounded-card-sm overflow-hidden transition-shadow',
        tone === 'live' ? 'shadow-lift ring-1 ring-accent/40' : 'shadow-card',
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-hairline">
        <StatusPill tone={tone} label={label} tag={tag} />
        {/* Field + time. The bracket previously showed time only, so the field
            number was unavailable on exactly the games spectators travel for.
            `location` is usually a bare number ("7") but occasionally a full
            venue string, so only prefix "Field" for the bare-number form. */}
        <span className="text-[9px] font-bold tracking-[0.16em] uppercase text-faint font-tight tabular truncate">
          {[
            game.location
              ? /^\d+[A-Za-z]?$/.test(game.location.trim())
                ? `Field ${game.location.trim()}`
                : game.location.trim()
              : null,
            formatGameTime(game.scheduledAt, venueState) || null,
          ]
            .filter(Boolean)
            .join(' · ') || ' '}
        </span>
      </div>
      <TeamLine
        teamId={game.teamAId ?? slot.aResolved?.teamId ?? null}
        name={game.teamAName ?? slot.aResolved?.name ?? null}
        fallback={slot.aFallback}
        seed={game.seedA ?? slot.aResolved?.seed ?? null}
        score={scoreA}
        won={aWon}
        lost={bWon}
        compact={compact}
        season={season}
      />
      <div className="h-px bg-hairline" />
      <TeamLine
        teamId={game.teamBId ?? slot.bResolved?.teamId ?? null}
        name={game.teamBName ?? slot.bResolved?.name ?? null}
        fallback={slot.bFallback}
        seed={game.seedB ?? slot.bResolved?.seed ?? null}
        score={scoreB}
        won={bWon}
        lost={aWon}
        compact={compact}
        season={season}
      />
    </article>
  );
}

function TeamLine({
  teamId,
  name,
  fallback,
  seed,
  score,
  won,
  lost,
  compact,
  season,
}: {
  season?: number | null;
  teamId: string | null;
  name: string | null;
  /** Shown in place of "TBD" when the team isn't decided yet but the slot's
   *  origin is known — USAU-style "W of Quarters G1". */
  fallback?: string | null;
  seed: number | null;
  /** A number, or "W"/"F" for a forfeit. */
  score: number | string | null;
  won: boolean;
  lost: boolean;
  compact?: boolean;
}) {
  const labelColor = won ? 'text-ink' : lost ? 'text-faint' : 'text-muted';
  const scoreColor = won ? 'text-accent' : lost ? 'text-faint' : 'text-muted';
  const fontWeight = won ? 'font-bold' : 'font-semibold';

  const inner = (
    <span className={`flex items-center gap-2 flex-1 min-w-0 ${labelColor}`}>
      {seed != null && (
        <span className="tabular text-[10px] text-faint font-bold w-4 text-right shrink-0">
          {seed}
        </span>
      )}
      <span className={`text-[13px] font-tight truncate ${fontWeight}`}>
        {name ?? fallback ?? 'TBD'}
      </span>
    </span>
  );

  return (
    <div className={`flex items-center gap-3 px-3 ${compact ? 'py-1.5' : 'py-2'}`}>
      {teamId ? (
        <Link
          href={season != null ? `/usau/teams/${teamId}?season=${season}` : `/usau/teams/${teamId}`}
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

// ── Status pill ───────────────────────────────────────────────────────────

type Tone = 'final' | 'live' | 'upcoming' | 'tbd' | 'cancelled';

function StatusPill({
  tone,
  label,
  tag,
}: {
  tone: Tone;
  label: string;
  /** Game number within its round ("G1") — USAU's own bracket-sheet numbering.
   *  Leads the strip, before the status label. Desktop only: on mobile's
   *  narrow columns it truncated the field/time (Hunter, 2026-10-20). */
  tag?: string;
}) {
  const toneClass = {
    final: 'text-faint',
    live: 'text-accent',
    upcoming: 'text-muted',
    tbd: 'text-faint',
    cancelled: 'text-faint',
  }[tone];

  return (
    <span className="inline-flex items-center gap-1.5">
      {tag && (
        <span className="hidden lg:inline-flex items-center rounded-full bg-ink/5 px-1.5 py-0.5 text-[9px] font-bold tracking-[0.1em] text-muted font-tight tabular">
          {tag}
        </span>
      )}
      {label && (
        <span
          className={`inline-flex items-center gap-1.5 text-[9px] font-bold tracking-[0.16em] uppercase font-tight ${toneClass}`}
        >
          {tone === 'live' && (
            <span className="w-[6px] h-[6px] rounded-full bg-accent animate-pulse" aria-hidden />
          )}
          {label}
        </span>
      )}
    </span>
  );
}

// 'forfeit' counts as decided and 'cancelled' gets its own pill — both
// otherwise fell through to "Upcoming", which read as a lie on games USAU
// called off (2026 Vacationland final washout).
function matchTone(game: Game): Tone {
  if (game.status === 'in_progress') return 'live';
  if (game.status === 'final' || game.status === 'forfeit') return 'final';
  if (game.status === 'cancelled') return 'cancelled';
  if (!game.teamAName && !game.teamBName) return 'tbd';
  return 'upcoming';
}

// Only Live and Cancelled earn a text label — Upcoming/Final/TBD crowded the
// strip and truncated the field/time on narrow cards (Hunter, 2026-08-20);
// scores already say "final" and blank scores say "upcoming".
function statusLabel(game: Game): string {
  if (game.status === 'in_progress') return 'Live';
  if (game.status === 'cancelled') return 'Cancelled';
  return '';
}

// ── Helpers: filter, columns, position assignment ────────────────────────

/**
 * Decide whether a game belongs to the "the championship bracket" — the
 * main winner's bracket of the event, which we render as a visual tree.
 *
 * USAU's bracket_name values are inconsistent across events:
 *   D-I Nationals 2026          → "1st Place"
 *   North Central Regional      → "Championship Bracket"
 *   Many regionals              → "Championship"
 *   Older events                → "First Place Bracket" / "Championship Final"
 *   Multi-format events         → "Open Championship" / "Women's Division Championship"
 *
 * Match strategy: lowercased name either (a) contains a "1st/first place"
 * marker, or (b) is exactly one of the known championship phrases (or a
 * "{division} Championship" form), or (c) lacks a bracket_name but has a
 * tree-round (legacy fallback).
 */
/**
 * Is this game part of ANY single-elimination bracket (championship or a
 * placement bracket)?
 *
 * isChampionshipBracket() below answers a narrower question — "is this the MAIN
 * bracket" — and is still used by the event page for its champion/medal logic.
 * The TREE uses this wider predicate so 5th/9th/13th-place brackets render too.
 *
 * A game qualifies when it has a tree-shaped round (prequarter/quarter/semi/
 * final) and its bracket name isn't a pool. Pool-play rows carry pool names and
 * non-tree rounds, so they're excluded; "Pool E"-style second-phase pools are
 * excluded here as well because they're round-robins, not trees.
 */
const TREE_ROUNDS = ['prequarter', 'quarter', 'semi', 'final'];

export function isBracketGame(g: Game): boolean {
  // A row carrying scraped bracket structure sits in a bracket column by
  // definition, whatever coarse `round` the label classifier gave it (a
  // placement bracket's decider stores round='placement').
  const structured = g.bracketStageIndex != null;
  // 'other' is admitted so buildColumns can recover a round-of-16 / mislabeled
  // final from it (see recoverFeederRound). Games it doesn't claim are simply
  // ignored when the columns are built, so this widening can't leak stray
  // boxes into the tree.
  if (!structured && !TREE_ROUNDS.includes(g.round) && g.round !== 'other') return false;
  const raw = (g.bracketName ?? '').trim();
  if (!raw) return true; // untagged but tree-rounded — legacy events
  const lastDot = raw.lastIndexOf('\u00b7');
  const tail = (lastDot >= 0 ? raw.slice(lastDot + 1) : raw).trim().toLowerCase();
  if (/^pool\b/.test(tail)) return false;
  return true;
}

export function isChampionshipBracket(g: Game): boolean {
  const raw = g.bracketName ?? '';
  // Combined masters events prefix every bracket with a group ("Masters Mixed ·
  // Bracket Play"). Match on the TAIL after the last "·" so the exact-match
  // rules below ("bracket play", "championship", …) still fire — otherwise a
  // group-prefixed first-place bracket reads as unrecognized and its winner
  // never surfaces as champion.
  const lastDot = raw.lastIndexOf('·');
  const tail = lastDot >= 0 ? raw.slice(lastDot + 1) : raw;
  const b = tail.trim().toLowerCase();

  if (!b && ['prequarter', 'quarter', 'semi', 'final'].includes(g.round)) return true;
  if (!b) return false;

  // Word-boundary the "1st place" / "first place" check — a naive substring
  // match also fires on "2**1st place**" / "3**1st place**", which pulled
  // Heavyweights' "21st/31st Place" side brackets into the championship tree and
  // overlapped the real semifinals. The \b before "1" fails inside "21".
  if (/\b1st place\b/.test(b) || /\bfirst place\b/.test(b)) return true;

  // Bare "1st" / "champs" brackets (Cooler Classic, Portland) — accepted by the
  // server-side twin in data.ts since 2026-08-10; without them here the event
  // crowns a champion but renders no tree. Must run BEFORE the ordinal reject
  // ("1st" would fail it).
  if (b === '1st' || b === 'champs') return true;

  // Allow "Championship", "Championship Bracket", "Championship Final",
  // "National Championship", "Sectional Championship", "Regional
  // Championship", or "<Division> Championship" — but exclude things that
  // happen to contain "championship" plus an ordinal place ("5th Place
  // Championship") which signals a side bracket, not the main one.
  if (/\b\d+(st|nd|rd|th)\b/.test(b)) return false;
  // Written-out ordinals too: "Second Place" (game-to-go) and "Championship
  // Bracket: Third Place" are placement games, never the title.
  if (/\b(second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth)\s+place\b/.test(b)) return false;
  if (/backdoor|game[- ]to[- ]go|\bg2g\b/.test(b)) return false;
  // Seeding crossovers are NOT championship-bracket games: they only set
  // seeding for the bracket that follows.
  if (
    b.includes('consolation') ||
    b.includes('placement') ||
    b.includes('play in') ||
    b.includes('play-in') ||
    b.includes('crossover')
  ) return false;
  if (b === 'finals') return true;
  // The main pattern: "championship" possibly preceded by qualifiers, possibly followed by "bracket" or "final" or "game".
  if (/(^|\s)championship(\s+(bracket|final|game))?$/.test(b)) return true;
  if (/^(national|sectional|regional|open|men'?s|women'?s|mixed|men'?s division|women'?s division|mixed division)\s+championship$/.test(b)) return true;

  // Catch-all: generic "(the) bracket" / "bracket play" / "sunday bracket" names
  // used by smaller events where there's only one bracket on the page.
  if (b === 'bracket' || b === 'bracket play' || b === 'sunday bracket' || b === 'champion bracket') return true;

  // Championship play-in rounds stored as their own bracket ("Pre-Quarters" —
  // Ski Town Mixed). Exact match only, placed AFTER the ordinal reject so
  // "9th Place Pre-Quarters" still reads as a side bracket.
  if (b === 'pre-quarters' || b === 'prequarters' || b === 'pre quarters') return true;

  return false;
}

/**
 * Recover a feeder round stored as round='other' (the enum has no round-of-16).
 *
 * A game qualifies when it is outside the tree rounds and its WINNER appears in
 * one of the `openers` — the column that currently starts the tree. Matching on
 * the winner (not either team) is what keeps this tight: the loser of a real
 * feeder game drops to a placement bracket and never reappears upstream, so a
 * placement or consolation game can't sneak in.
 *
 * Only fires when the openers have known teams; an all-TBD opener column would
 * otherwise match nothing and cost nothing.
 */
function recoverFeederRound(games: Game[], openers: Game[]): Game[] {
  if (openers.length === 0) return [];

  const openerTeams = new Set<string>();
  for (const g of openers) {
    if (g.teamAId) openerTeams.add(g.teamAId);
    if (g.teamBId) openerTeams.add(g.teamBId);
  }
  if (openerTeams.size === 0) return [];

  return games.filter((g) => {
    if (TREE_ROUNDS.includes(g.round)) return false;
    if (!g.teamAId || !g.teamBId) return false;
    const winner = gameWinnerId(g);
    return !!winner && openerTeams.has(winner);
  });
}

function buildColumns(games: Game[]): RoundColumn[] {
  // PRE-QUARTERS are a real round in the data (`usau_game_round` has an explicit
  // 'prequarter' value — 1,347 club games across 245 events carry it), but this
  // builder used to look only at quarter/semi/final and so dropped every one of
  // them from the tree. A 16-team bracket rendered as if it started at the QFs.
  //
  // Prefer the explicit round. The old behavior — splitting round='quarter' by
  // scheduled DATE and calling the earlier day "Round 1" — is kept ONLY as a
  // fallback for events whose scraper run predates the prequarter tagging, so
  // those brackets don't regress to a single collapsed column.
  const prequarters = games.filter((g) => g.round === 'prequarter');
  const semis = games.filter((g) => g.round === 'semi');
  let finals = games.filter((g) => g.round === 'final');
  const quarters = games.filter((g) => g.round === 'quarter');

  // USAU routinely mislabels a bracket's FINAL as an out-of-tree round: a
  // placement bracket's semis store round='semi' but the deciding game stores
  // 'other' or 'placement', so the tree draws semis with no final. Recover it —
  // a game outside the tree rounds whose two teams are both semi WINNERS is the
  // final. This MUST run before feeder recovery below: the recovered final's
  // winner also appears in the bracket's own quarters (they advanced through
  // them), so feeder recovery would otherwise claim the SAME game as a
  // phantom "Pre-Quarters" column and render it twice (ESC 2026 9th place).
  if (finals.length === 0 && semis.length > 0) {
    const semiWinners = new Set(
      semis
        .map((g) => gameWinnerId(g))
        .filter((id): id is string => !!id),
    );
    finals = games.filter(
      (g) =>
        !TREE_ROUNDS.includes(g.round) &&
        !!g.teamAId && !!g.teamBId &&
        semiWinners.has(g.teamAId) &&
        semiWinners.has(g.teamBId),
    );
    // Unplayed semis have no winners to match, and a decider fed from outside
    // the bracket ("W of 6th Place Semis G1" vs "L of 5th Place G1") never has
    // two semi winners. Fall back to schedule: a non-tree game strictly after
    // the last semi is the decider, unless both sides are losers (a 3rd-place
    // consolation). 2026 West Plains Men's 6th Place dropped its final without it.
    if (finals.length === 0) {
      const semiLosers = new Set(
        semis
          .map((g) => {
            const w = treeWinnerId(g);
            return w ? (w === g.teamAId ? g.teamBId : g.teamAId) : null;
          })
          .filter((id): id is string => !!id),
      );
      const isLoserSide = (teamId: string | null, placeholder: string | null | undefined) =>
        teamId ? semiLosers.has(teamId) : /^L(?:oser)?\s+of\b/i.test(placeholder ?? '');
      const latestSemiAt = semis.reduce(
        (m, g) => (g.scheduledAt && g.scheduledAt > m ? g.scheduledAt : m),
        '',
      );
      finals = games.filter(
        (g) =>
          !TREE_ROUNDS.includes(g.round) &&
          !!latestSemiAt && !!g.scheduledAt && g.scheduledAt > latestSemiAt &&
          !(isLoserSide(g.teamAId, g.teamAPlaceholder) && isLoserSide(g.teamBId, g.teamBPlaceholder)),
      );
    }
  }
  const claimedFinalIds = new Set(finals.map((g) => g.id));

  // Round-of-16 recovery. The usau_game_round enum tops out at 'prequarter', so
  // a bracket that opens with a round of 16 is stored as round='other' and was
  // dropped entirely — isBracketGame() rejects 'other' by default, so a whole
  // played round vanished from the tree while its winners appeared in the QFs.
  //
  // Identify it structurally rather than by name: an 'other' game in this
  // bracket whose winner plays in the round that opens the tree. That keeps a
  // genuinely unclassifiable game out while recovering a real feeder round.
  const openers = prequarters.length > 0 ? prequarters : quarters;
  const recovered = recoverFeederRound(games, openers).filter(
    (g) => !claimedFinalIds.has(g.id),
  );
  // Type the recovered round by SIZE: more games than the openers is a round
  // of 16; equal-or-fewer is a play-in/prequarter round feeding the openers
  // (Ski Town Mixed stores its play-ins as round='other', bracket
  // "Pre-Quarters"). Only claims the prequarter column when none is explicitly
  // tagged.
  const recoveredAsPrequarters =
    prequarters.length === 0 && recovered.length > 0 && recovered.length <= openers.length;
  const r16 = recoveredAsPrequarters ? [] : recovered;

  let r1: Game[];
  let qf: Game[];
  if (prequarters.length > 0) {
    // Explicitly tagged: pre-quarters are their own column, quarters stay whole.
    r1 = prequarters;
    qf = quarters;
  } else if (recoveredAsPrequarters) {
    // Recovered play-in round takes the prequarter column; the date-split
    // fallback below must not also fire (it would double-claim quarters).
    r1 = recovered;
    qf = quarters;
  } else {
    // Legacy fallback: infer an opening round from a two-date quarter split.
    const quarterDates = Array.from(
      new Set(
        quarters
          .map((g) => g.scheduledAt?.slice(0, 10))
          .filter((d): d is string => !!d),
      ),
    ).sort();
    if (quarterDates.length >= 2) {
      const earliest = quarterDates[0];
      r1 = quarters.filter((g) => g.scheduledAt?.slice(0, 10) === earliest);
      qf = quarters.filter((g) => g.scheduledAt?.slice(0, 10) !== earliest);
    } else {
      r1 = [];
      qf = quarters;
    }
  }

  // USAU's schedule-row ids are assigned in bracket-sheet order within a
  // bracket, and slot k of a round is fed by games 2k-1/2k of the previous
  // one. Sorting each column by that id makes the column order USAU's own
  // G1…Gn — which completeBracket then relies on for game numbers, feeder
  // pairing, and "W of …" labels. Seed order is the fallback for batches
  // whose ids are opaque hashes.
  const sortByBracketOrder = (a: Game, b: Game) =>
    (a.usauGameOrder ?? Number.MAX_SAFE_INTEGER) - (b.usauGameOrder ?? Number.MAX_SAFE_INTEGER) ||
    (a.seedA ?? a.seedB ?? 99) - (b.seedA ?? b.seedB ?? 99);

  return [
    { key: 'r16', label: 'Round of 16', games: r16.slice().sort(sortByBracketOrder) },
    {
      key: 'r1',
      // Name the column for what it actually is when the round is tagged or
      // recovered; the date-split fallback can't know, so it stays "Round 1".
      label: prequarters.length > 0 || recoveredAsPrequarters ? 'Pre-Quarters' : 'Round 1',
      games: r1.slice().sort(sortByBracketOrder),
    },
    { key: 'qf', label: 'Quarterfinals', games: qf.slice().sort(sortByBracketOrder) },
    { key: 'sf', label: 'Semifinals', games: semis.slice().sort(sortByBracketOrder) },
    { key: 'final', label: 'Final', games: finals.slice().sort(sortByBracketOrder) },
  ];
}

// ─── Full-bracket completion (USAU-parity placeholder slots) ─────────────────
//
// USAU renders the WHOLE bracket up front: every downstream game shows as a
// slot ("W of Quarters G1" vs "W of Quarters G2") with its round + game number,
// even before any team is known. The rows themselves are purely data-driven, so
// this pass adds the structural layer on top of buildColumns' output:
//
//   • every game gets its USAU game number within its round (G1…Gn — column
//     order is bracket-sheet order, see sortByBracketOrder),
//   • a real row whose team(s) aren't decided yet gets "W of <round> G<n>"
//     side labels derived from its feeder slots, plus explicit sourceIds so
//     the layout engine can order/connect it despite having no team ids,
//   • rounds USAU omitted entirely are synthesized as placeholder slots, so a
//     bracket that only has its opening round stored still renders its full
//     shape through the final.

interface Slot {
  /** Real row id, or a synthetic `ph-…` id for a synthesized slot. */
  id: string;
  game: Game | null;
  /** 1-based game number within the round (USAU's G1…Gn). */
  number: number;
  /** Feeder slot ids in the previous column. */
  sourceIds: string[];
  /** Side labels used when the team is unknown ("W of Quarters G1"). */
  aFallback: string | null;
  bFallback: string | null;
  /** Winner of a DECIDED feeder game, shown in place of the "W of …" label
   *  while the row itself still stores TBD — the team advances on screen the
   *  moment its game goes final, not whenever the next scrape lands. */
  aResolved: ResolvedSide | null;
  bResolved: ResolvedSide | null;
}

interface ResolvedSide {
  teamId: string | null;
  name: string;
  seed: number | null;
}

export interface SlotColumn {
  key: string;
  label: string;
  slots: Slot[];
}

/** Short round names for "W of …" labels (USAU wording). */
const FEEDER_SHORT: Record<string, string> = {
  r16: 'R16',
  r1: 'Prequarters',
  qf: 'Quarters',
  sf: 'Semis',
};

function wOf(prevKey: string, n: number): string {
  return `W of ${FEEDER_SHORT[prevKey] ?? 'Round'} G${n}`;
}

/** USAU's scraped placeholder text, shortened for a bracket card:
 *  "P1 of Saturday Pool Play Pool A" → "P1 Pool A"; round words compressed
 *  ("L of Ninth Place Semifinals G2" → "L of Ninth Place Semis G2"). Used when
 *  structural feeder linkage can't derive a label itself — most usefully the
 *  pool-fed opening round, which has no feeder games at all. */
export function shortPlaceholder(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const pool = raw.match(/^P(\d+) of .*?(Pool\s+\S+)$/i);
  if (pool) return `P${pool[1]} ${pool[2]}`;
  return raw.replace(/Quarterfinals?/g, 'Quarters').replace(/Semifinals?/g, 'Semis');
}

function isDecidedForTree(g: Game): boolean {
  const s = g.status.toLowerCase();
  if (s === 'forfeit') return true;
  return s === 'final' && gameWinnerId(g) != null;
}

function treeWinnerId(g: Game): string | null {
  return isDecidedForTree(g) ? gameWinnerId(g) : null;
}

/** The winner of a feeder slot's game, when decided — id/name/seed for the
 *  downstream card to render in place of its "W of …" label. */
function resolvedWinner(f: Slot): ResolvedSide | null {
  const g = f.game;
  if (!g) return null;
  const wid = treeWinnerId(g);
  if (!wid) return null;
  const won = wid === g.teamAId;
  const name = won ? g.teamAName : g.teamBName;
  const seed = won ? g.seedA : g.seedB;
  return name ? { teamId: wid, name, seed } : null;
}

// ── Duplicate-row collapse (dual-pipeline safety) ───────────────────────────
// Mid-tournament, the HTML scrape and the ultirzr ingest can BOTH hold rows
// for the same structural game (different ids, one pair stale) — the 2026
// Elite Select semis rendered as FOUR cards: the fresh pair plus a stale
// TBD-vs-TBD pair carrying the quarters' old times. Two rows are the same
// game when they resolve to the same feeder pair, name the same scraped
// origins, or hold the same two teams; and a column never gets more cards
// than its feeders can supply (4 QFs → 2 semis → 1 final).

function statusRank(g: Game): number {
  const s = g.status.toLowerCase();
  if (s === 'final' || s === 'forfeit') return 3;
  if (s === 'in_progress') return 2;
  return 1;
}

/** >0 when `a` is the better duplicate to keep: more resolved teams, a
 *  further-along status, then the later scheduled time (the stale row carries
 *  the superseded slot's earlier time). */
function rowScore(a: Game, b: Game): number {
  const resolved = (g: Game) => (g.teamAId ? 1 : 0) + (g.teamBId ? 1 : 0);
  return (
    resolved(a) - resolved(b) ||
    statusRank(a) - statusRank(b) ||
    (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? '')
  );
}

/** Feeder game number a scraped placeholder points at ("W of Quarterfinals
 *  G3" → 3) — only when the round it names IS the previous column, so a
 *  label reaching further back can't forge a false link. */
function placeholderFeederNumber(
  raw: string | null | undefined,
  prevKey: string,
): number | null {
  if (!raw) return null;
  const m = raw.match(/^W(?:inner)?\s+of\b(.*)\bG\s*(\d+)\s*$/i);
  if (!m) return null;
  const round = m[1].toLowerCase();
  const matches =
    prevKey === 'qf'
      ? /quarter/.test(round) && !/pre/.test(round)
      : prevKey === 'sf'
        ? /semi/.test(round)
        : prevKey === 'r16'
          ? /16/.test(round)
          : prevKey === 'r1'
            ? /pre.?quarter|round\s*1/.test(round)
            : false;
  return matches ? Number(m[2]) : null;
}

/** Which previous-round game number feeds this side: a resolved team links to
 *  the feeder it WON; an open side links through its scraped placeholder. */
function feederRef(
  teamId: string | null,
  placeholder: string | null | undefined,
  prev: Slot[] | null,
  prevKey: string,
  trustPlaceholders: boolean,
): number | null {
  if (!prev) return null;
  if (teamId) {
    const f = prev.find((s) => s.game && treeWinnerId(s.game) === teamId);
    return f ? f.number : null;
  }
  return trustPlaceholders ? placeholderFeederNumber(placeholder, prevKey) : null;
}

/** A scraped placeholder distinguishes games only when it says something —
 *  a literal "TBD" is the same text on every unseeded slot, so treating a
 *  TBD|TBD pair as a duplicate signature collapsed whole pre-tournament
 *  rounds to one card (mobile parity, 2026-08-26). */
function isInformativePlaceholder(raw: string | null | undefined): boolean {
  return !!raw && raw.trim().toLowerCase() !== 'tbd';
}

function dupSignature(
  g: Game,
  prev: Slot[] | null,
  prevKey: string,
  trustPlaceholders: boolean,
): string | null {
  if (g.teamAId && g.teamBId) {
    return `t:${[g.teamAId, g.teamBId].sort().join('|')}`;
  }
  if (
    !g.teamAId && !g.teamBId &&
    g.teamAPlaceholder && g.teamBPlaceholder &&
    (isInformativePlaceholder(g.teamAPlaceholder) || isInformativePlaceholder(g.teamBPlaceholder))
  ) {
    return `p:${[g.teamAPlaceholder, g.teamBPlaceholder].sort().join('|')}`;
  }
  const ra = feederRef(g.teamAId, g.teamAPlaceholder, prev, prevKey, trustPlaceholders);
  const rb = feederRef(g.teamBId, g.teamBPlaceholder, prev, prevKey, trustPlaceholders);
  if (ra != null && rb != null && ra !== rb) {
    return `f:${Math.min(ra, rb)},${Math.max(ra, rb)}`;
  }
  return null;
}

/** Collapse duplicate rows within one round, keeping the most informative of
 *  each pair, then enforce `cap` (structural max for halving rounds) by
 *  dropping the least informative extras. Unrecognizable rows (no signature)
 *  are never merged — only capped. */
function dedupeRound(
  games: Game[],
  prev: Slot[] | null,
  prevKey: string,
  cap: number | null,
  trustPlaceholders: boolean,
): Game[] {
  const bySig = new Map<string, number>();
  const kept: Game[] = [];
  for (const g of games) {
    const sig = dupSignature(g, prev, prevKey, trustPlaceholders);
    if (!sig) {
      kept.push(g);
      continue;
    }
    const at = bySig.get(sig);
    if (at == null) {
      bySig.set(sig, kept.length);
      kept.push(g);
    } else if (rowScore(g, kept[at]) > 0) {
      kept[at] = g;
    }
  }
  if (cap != null && kept.length > cap) {
    const keep = new Set(
      kept
        .slice()
        .sort((a, b) => rowScore(b, a))
        .slice(0, cap),
    );
    return kept.filter((g) => keep.has(g));
  }
  return kept;
}

/** Rounds whose game count is structurally half the named previous round —
 *  the transitions dedupeRound may cap. r1 (prequarters) → qf is deliberately
 *  absent: play-in rounds don't halve. */
const HALVES_FROM: Record<string, string> = { qf: 'r16', sf: 'qf', final: 'sf' };

/** Smallest power of two ≥ n (n ≥ 1). A bracket round's full sheet width. */
function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Slot for a real row: attach feeders, derive side labels for unknown sides,
 *  and resolve a decided feeder's winner into the open side. */
function makeRealSlot(
  g: Game,
  idx: number,
  feeders: Slot[],
  prevKey: string,
  prevAll: Slot[],
  trustPlaceholders: boolean,
): Slot {
  const known = [g.teamAId, g.teamBId].filter((id): id is string => !!id);

  // The structural pairing (slot k ← feeders 2k-1/2k) is an assumption about
  // USAU's sheet — verify it wherever the data can speak, and drop the linkage
  // for this slot when contradicted (team-id links still apply naturally).
  let fs = feeders;
  if (fs.length > 0 && known.length > 0) {
    const winners = fs
      .map((f) => (f.game ? treeWinnerId(f.game) : null))
      .filter((id): id is string => !!id);
    const contradicted =
      known.length === 2
        ? winners.some((w) => !known.includes(w))
        : winners.length === fs.length && !winners.includes(known[0]);
    if (contradicted) fs = [];
  }

  let aFallback: string | null = null;
  let bFallback: string | null = null;
  let aFeeder: Slot | null = null;
  let bFeeder: Slot | null = null;
  if (fs.length === 2) {
    // Which feeder feeds which side: when a side's team already appears in a
    // feeder's row, that feeder is its source; otherwise positional (top
    // feeder → side A).
    const inFeeder = (teamId: string | null, f: Slot): boolean =>
      teamId != null &&
      f.game != null &&
      (f.game.teamAId === teamId || f.game.teamBId === teamId);
    let [fa, fb] = fs;
    if (inFeeder(g.teamAId, fb) || inFeeder(g.teamBId, fa)) [fa, fb] = [fb, fa];
    aFeeder = fa;
    bFeeder = fb;
    if (g.teamAId == null) aFallback = wOf(prevKey, fa.number);
    if (g.teamBId == null) bFallback = wOf(prevKey, fb.number);
  } else if (fs.length === 1) {
    // Play-in feeder (prequarter → quarter): only the open side gets a label.
    if (g.teamAId == null) {
      aFeeder = fs[0];
      aFallback = wOf(prevKey, fs[0].number);
    } else if (g.teamBId == null) {
      bFeeder = fs[0];
      bFallback = wOf(prevKey, fs[0].number);
    }
  } else if (trustPlaceholders) {
    // No structural linkage — USAU's scraped "W of <round> G<n>" text still
    // names the feeder, so an open side can resolve its winner through it.
    // Skipped entirely when the column's sheet numbering disagrees with our
    // stored slots (see completeBracket's trust check).
    const byNumber = (n: number | null) =>
      n == null ? null : (prevAll.find((s) => s.number === n) ?? null);
    if (g.teamAId == null) {
      aFeeder = byNumber(placeholderFeederNumber(g.teamAPlaceholder, prevKey));
    }
    if (g.teamBId == null) {
      bFeeder = byNumber(placeholderFeederNumber(g.teamBPlaceholder, prevKey));
    }
  }

  return {
    id: g.id,
    game: g,
    number: idx + 1,
    sourceIds: (fs.length > 0 ? fs : [aFeeder, bFeeder].filter((f): f is Slot => !!f)).map(
      (f) => f.id,
    ),
    aResolved: g.teamAId == null && aFeeder ? resolvedWinner(aFeeder) : null,
    bResolved: g.teamBId == null && bFeeder ? resolvedWinner(bFeeder) : null,
    // Structure-derived labels win (consistent wording with synthesized
    // slots); USAU's scraped text fills slots the linkage couldn't label —
    // unlinked play-in rounds, non-halving columns, pool-fed sides.
    aFallback: aFallback ?? (g.teamAId ? null : shortPlaceholder(g.teamAPlaceholder)),
    bFallback: bFallback ?? (g.teamBId ? null : shortPlaceholder(g.teamBPlaceholder)),
  };
}

// Rounds a synthesized chain can step through. 'r1' (prequarters) never
// synthesizes forward: a prequarter round is by definition a partial play-in
// (some quarter slots are byes), so its count says nothing about the quarters'.
const SYNTH_NEXT: Record<string, { key: string; label: string }> = {
  r16: { key: 'qf', label: 'Quarterfinals' },
  qf: { key: 'sf', label: 'Semifinals' },
  sf: { key: 'final', label: 'Final' },
};

/**
 * Turn buildColumns' output into slot columns: number every game, link each
 * round to its feeders, label undecided sides, and synthesize wholly-missing
 * downstream rounds.
 *
 * Feeder linkage between two present rounds fires when the counts relate
 * structurally: next = prev/2 (two feeders per slot) or next = prev (play-in,
 * one feeder per slot). Anything else leaves the games unlinked — team-id
 * linkage still applies — rather than guessing.
 *
 * Synthesis fires only past the LAST stored round, only from a power-of-2
 * column that can halve cleanly to a final, and only while that round is not
 * fully decided — a decided round with no stored successor is historical data
 * that genuinely ends there, and a synthesized never-resolving slot would
 * misread as an upcoming game.
 */
function completeBracket(cols: RoundColumn[]): SlotColumn[] {
  const present = cols.filter((c) => c.games.length > 0);
  if (present.length === 0) return [];

  const out: SlotColumn[] = [
    {
      key: present[0].key,
      label: present[0].label,
      // Opening round has no feeder column, but dual-pipeline duplicates still
      // collapse via team-pair / scraped-origin signatures.
      slots: dedupeRound(present[0].games, null, '', null, true).map((g, i) => ({
        id: g.id,
        game: g,
        number: i + 1,
        sourceIds: [],
        aResolved: null,
        bResolved: null,
        // The opening round has no feeder games to derive labels from, but
        // USAU's own scraped text covers it ("P1 Pool A" pool-fed slots).
        aFallback: g.teamAId ? null : shortPlaceholder(g.teamAPlaceholder),
        bFallback: g.teamBId ? null : shortPlaceholder(g.teamBPlaceholder),
      })),
    },
  ];

  for (let i = 1; i < present.length; i++) {
    const col = present[i];
    const prev = out[out.length - 1];
    // A round can't hold more games than its feeders supply — cap halving
    // steps so duplicate rows can never widen a column past the bracket's
    // real shape (4 QFs → 2 semis → 1 final). Size the cap from the round's
    // EXPECTED width (next power of two), not the stored count: byes leave
    // gaps USAU never stores as rows, so 2 stored quarters (Rocky Mountain
    // Mixed 2026: G2 + G3, seeds 1 and 3 skipped the round) still feed TWO
    // real semis — a cap of ceil(2/2)=1 deleted one of them.
    const cap =
      HALVES_FROM[col.key] === prev.key
        ? Math.max(1, nextPow2(prev.slots.length) / 2)
        : null;
    // Sheet-numbering trust (mobile parity, 2026-08-26): scraped "W of
    // <round> G<n>" labels use USAU's SHEET numbering, which can count bye
    // slots we don't store (Fruit Bowl QFs cite Pre-Quarters G2/G4/G6/G8
    // against our 4 stored games G1–G4). If any cited number exceeds the
    // previous column's slot count, the numbering schemes disagree — drop
    // placeholder-derived linkage for the WHOLE column rather than mislink.
    const trustPlaceholders = col.games.every((g) => {
      for (const raw of [g.teamAPlaceholder, g.teamBPlaceholder]) {
        const n = placeholderFeederNumber(raw, prev.key);
        if (n != null && n > prev.slots.length) return false;
      }
      return true;
    });
    const games = dedupeRound(col.games, prev.slots, prev.key, cap, trustPlaceholders);
    const half = games.length * 2 === prev.slots.length;
    // Positional linkage is only trusted for the halving case and 1↔1 chains.
    // Same-sized rounds (4 play-ins → 4 QFs) looked positional but real data
    // disproved it — Ski Town Mixed slots play-in G4's winner into QF G1, so an
    // equal-count guess renders wrong "W of …" labels on unplayed rounds.
    // (Played feeders get rescued by the winner-contradiction check either
    // way; unplayed ones have nothing to contradict.)
    const chain = games.length === 1 && prev.slots.length === 1;
    out.push({
      key: col.key,
      label: col.label,
      slots: games.map((g, j) =>
        makeRealSlot(
          g,
          j,
          half
            ? [prev.slots[2 * j], prev.slots[2 * j + 1]]
            : chain
              ? [prev.slots[0]]
              : [],
          prev.key,
          prev.slots,
          trustPlaceholders,
        ),
      ),
    });
  }

  let last = out[out.length - 1];
  const isPow2 = (n: number) => n >= 2 && (n & (n - 1)) === 0;
  while (
    SYNTH_NEXT[last.key] != null &&
    isPow2(last.slots.length) &&
    last.slots.some((s) => !s.game || !isDecidedForTree(s.game))
  ) {
    const next = SYNTH_NEXT[last.key];
    const slots: Slot[] = [];
    for (let j = 0; j < last.slots.length / 2; j++) {
      const fa = last.slots[2 * j];
      const fb = last.slots[2 * j + 1];
      slots.push({
        id: `ph-${next.key}-${j}`,
        game: null,
        number: j + 1,
        sourceIds: [fa.id, fb.id],
        // A decided feeder slots its winner straight into the synthesized
        // card ("W of Quarters G3" becomes the team the moment G3 is final).
        aResolved: resolvedWinner(fa),
        bResolved: resolvedWinner(fb),
        aFallback: wOf(last.key, fa.number),
        bFallback: wOf(last.key, fb.number),
      });
    }
    last = { key: next.key, label: next.label, slots };
    out.push(last);
  }

  return out;
}

// ─── Structured brackets (scraped from USAU's own markup, 2026-09-13) ───────
//
// play.usaultimate.org's bracket HTML encodes the whole graph and the scraper
// now stores it on each row: the column label (bracketStage), the column's
// distance from the section's deciding game (bracketStageIndex, 0 = decider),
// USAU's sheet slot (bracketSlot — byes leave gaps, so a quarters column can
// be G2 + G3 only) and, from the HTML pipeline, the game each winner feeds
// (nextUsauGameId + nextSlotSide). ultirzr rows carry everything but the link.
//
// With that, no halving / synthesis / sheet-number guessing is needed: the
// columns ARE the scraped columns, the numbers ARE USAU's, and connectors
// follow the scraped relation (falling back to sheet-number pairing for
// link-less rows). Any bracket shape USAU draws renders as drawn.

/** Does any row in this group carry scraped bracket structure? */
export function hasBracketStructure(games: Game[]): boolean {
  return games.some((g) => g.bracketStageIndex != null);
}

/** Display label for a scraped column: USAU repeats the section's ordinal on
 *  every column ("6th Place Quarters", "1st Semis", "3rd Finals"), which is
 *  noise under a heading that already names the bracket, and phrases the
 *  decider a dozen ways ("1st Place", "5th", "Fival", "6th Place (Game to
 *  Go)"). Strip the ordinal prefix, unwrap parentheses, and call a bare
 *  ordinal / "Game" / "Final(s)" decider "Final". Anything else is shown as
 *  USAU wrote it. */
export function structuredColumnLabel(
  stage: string | null,
  section: string | null,
  isDecider: boolean,
): string {
  const raw = (stage ?? '').trim();
  if (!raw) return isDecider ? 'Final' : 'Round';
  let t = raw;
  const sectionTail = (section ?? '').split('\u00b7').pop()?.trim() ?? '';
  if (sectionTail && t.toLowerCase().startsWith(sectionTail.toLowerCase())) {
    t = t.slice(sectionTail.length);
  } else {
    t = t.replace(/^\d+(st|nd|rd|th)\s+(place\s+)?/i, '');
    t = t.replace(
      /^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth)\s+place\s+/i,
      '',
    );
  }
  t = t.trim().replace(/^[-–—:]\s*/, '').replace(/^\((.*)\)$/, '$1').trim();
  if (!t || /^(game|finals?|place|place game)$/i.test(t)) return isDecider ? 'Final' : raw;
  return t;
}

/** "Quarterfinals" → "Quarters" style compression for "W of … G<n>" labels. */
function shortColumnLabel(label: string): string {
  return label.replace(/Quarterfinals?/g, 'Quarters').replace(/Semifinals?/g, 'Semis');
}

/** Two structured rows are the same game when they occupy the same scraped
 *  slot or hold the same two teams (dual-pipeline duplicates). The better row
 *  (rowScore) is kept, but it inherits the other's id/link fields when it has
 *  none — an ultirzr row that wins on freshness must not cost the slot its
 *  HTML-only feeder link. */
function dedupeStructured(games: Game[]): Game[] {
  const byKey = new Map<string, number>();
  const kept: Game[] = [];
  const keysOf = (g: Game): string[] => {
    const keys: string[] = [];
    if (g.bracketSlot != null) keys.push(`s:${g.bracketStageIndex}:${g.bracketSlot}`);
    if (g.teamAId && g.teamBId) keys.push(`t:${[g.teamAId, g.teamBId].sort().join('|')}`);
    return keys;
  };
  const merge = (winner: Game, loser: Game): Game => ({
    ...winner,
    usauGameId: winner.usauGameId ?? loser.usauGameId,
    nextUsauGameId: winner.nextUsauGameId ?? loser.nextUsauGameId,
    nextSlotSide: winner.nextSlotSide ?? loser.nextSlotSide,
    bracketSlot: winner.bracketSlot ?? loser.bracketSlot,
    bracketStage: winner.bracketStage ?? loser.bracketStage,
    teamAPlaceholder: winner.teamAPlaceholder ?? loser.teamAPlaceholder,
    teamBPlaceholder: winner.teamBPlaceholder ?? loser.teamBPlaceholder,
  });
  for (const g of games) {
    const keys = keysOf(g);
    const at = keys.map((k) => byKey.get(k)).find((i) => i != null);
    if (at == null) {
      for (const k of keys) byKey.set(k, kept.length);
      kept.push(g);
      continue;
    }
    kept[at] = rowScore(g, kept[at]) > 0 ? merge(g, kept[at]) : merge(kept[at], g);
    for (const k of keysOf(kept[at])) byKey.set(k, at);
  }
  return kept;
}

/**
 * Build slot columns straight from scraped structure.
 *
 * Column = distance from the deciding game. When the rows carry feeder links
 * that distance is walked along the links (so a play-in section whose games
 * feed another section's quarters lands one column further left, whatever its
 * own stage index says); rows without links use their scraped stage index.
 * Slots keep USAU's sheet numbers. Feeders come from the links, else from
 * sheet-number pairing (slot k ← 2k-1, 2k) when the previous column has no
 * link data at all. Rows in the group with no structure (a stray from the
 * other pipeline that no structured row matched) are filed by their coarse
 * round so nothing silently disappears.
 */
export function buildStructuredColumns(games: Game[]): SlotColumn[] {
  const structured = dedupeStructured(games.filter((g) => g.bracketStageIndex != null));
  if (structured.length === 0) return [];

  const byUsauId = new Map<string, Game>();
  for (const g of structured) if (g.usauGameId) byUsauId.set(g.usauGameId, g);

  // Depth: follow winner links to the decider; else the scraped stage index.
  const depthMemo = new Map<string, number>();
  const depthOf = (g: Game, seen = new Set<string>()): number => {
    const memo = depthMemo.get(g.id);
    if (memo != null) return memo;
    let d = g.bracketStageIndex ?? 0;
    const next = g.nextUsauGameId ? byUsauId.get(g.nextUsauGameId) : undefined;
    if (next && next.id !== g.id && !seen.has(g.id)) {
      seen.add(g.id);
      d = depthOf(next, seen) + 1;
    }
    depthMemo.set(g.id, d);
    return d;
  };

  const byDepth = new Map<number, Game[]>();
  for (const g of structured) {
    const d = depthOf(g);
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(g);
  }

  // Strays: unstructured rows that no structured row absorbed. Team-pair
  // matches are duplicates; the rest file into a column by coarse round.
  const structuredPairs = new Set(
    structured
      .filter((g) => g.teamAId && g.teamBId)
      .map((g) => [g.teamAId, g.teamBId].sort().join('|')),
  );
  const strays = games.filter(
    (g) =>
      g.bracketStageIndex == null &&
      !(g.teamAId && g.teamBId && structuredPairs.has([g.teamAId, g.teamBId].sort().join('|'))),
  );

  const depths = Array.from(byDepth.keys()).sort((a, b) => b - a); // deepest (earliest round) first
  const labelFor = (rows: Game[], depth: number): string => {
    const counts = new Map<string, number>();
    for (const g of rows) {
      const l = structuredColumnLabel(g.bracketStage, g.bracketName, depth === 0);
      counts.set(l, (counts.get(l) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? (depth === 0 ? 'Final' : 'Round');
  };
  const columnsRaw = depths.map((d) => ({ depth: d, label: labelFor(byDepth.get(d)!, d), games: byDepth.get(d)! }));

  for (const s of strays) {
    const r = s.round;
    const match =
      r === 'prequarter'
        ? columnsRaw.find((c) => /pre/i.test(c.label))
        : r === 'quarter'
          ? columnsRaw.find((c) => /quarter/i.test(c.label) && !/pre/i.test(c.label))
          : r === 'semi'
            ? columnsRaw.find((c) => /semi/i.test(c.label))
            : columnsRaw.find((c) => c.depth === 0);
    (match ?? columnsRaw[columnsRaw.length - 1]).games.push(s);
  }

  const bySlot = (a: Game, b: Game) =>
    (a.bracketSlot ?? Number.MAX_SAFE_INTEGER) - (b.bracketSlot ?? Number.MAX_SAFE_INTEGER) ||
    (a.usauGameOrder ?? Number.MAX_SAFE_INTEGER) - (b.usauGameOrder ?? Number.MAX_SAFE_INTEGER) ||
    (a.seedA ?? a.seedB ?? 99) - (b.seedA ?? b.seedB ?? 99);

  const out: SlotColumn[] = [];
  for (const col of columnsRaw) {
    const rows = col.games.slice().sort(bySlot);
    const prev = out[out.length - 1] ?? null;
    const prevHasLinks = !!prev && prev.slots.some((s) => s.game?.nextUsauGameId);
    const usedNumbers = new Set<number>();
    const slots: Slot[] = rows.map((g, i) => {
      let number = g.bracketSlot ?? i + 1;
      while (usedNumbers.has(number)) number += 1;
      usedNumbers.add(number);

      let feeders: Slot[] = [];
      if (prev) {
        if (g.usauGameId && prevHasLinks) {
          feeders = prev.slots.filter((s) => s.game?.nextUsauGameId === g.usauGameId);
        } else if (!prevHasLinks) {
          // Link-less pipeline: USAU's sheet pairs slot k with 2k-1 / 2k.
          feeders = prev.slots.filter((s) => s.number === 2 * number - 1 || s.number === 2 * number);
        }
      }
      return makeStructuredSlot(g, number, feeders, prev?.label ?? '');
    });
    out.push({ key: `stage-${col.depth}`, label: col.label, slots });
  }
  return out;
}

/** Slot for a structured row. Sides follow the scraped link side (top → A,
 *  btm → B) when known, else the team already in the feeder's row, else
 *  position. Same contradiction guard as makeRealSlot: a decided feeder whose
 *  winner isn't in this row drops the linkage rather than mislabel. */
function makeStructuredSlot(g: Game, number: number, feeders: Slot[], prevLabel: string): Slot {
  const known = [g.teamAId, g.teamBId].filter((id): id is string => !!id);
  let fs = feeders;
  if (fs.length > 0 && known.length > 0) {
    const winners = fs
      .map((f) => (f.game ? treeWinnerId(f.game) : null))
      .filter((id): id is string => !!id);
    const contradicted =
      known.length === 2
        ? winners.some((w) => !known.includes(w))
        : winners.length === fs.length && !winners.includes(known[0]);
    if (contradicted) fs = [];
  }

  const inFeeder = (teamId: string | null, f: Slot): boolean =>
    teamId != null && f.game != null && (f.game.teamAId === teamId || f.game.teamBId === teamId);
  let aFeeder: Slot | null = null;
  let bFeeder: Slot | null = null;
  for (const f of fs) {
    const side = f.game?.nextSlotSide ?? null;
    if (side === 'top' && !aFeeder) aFeeder = f;
    else if (side === 'btm' && !bFeeder) bFeeder = f;
    else if (inFeeder(g.teamAId, f) && !aFeeder) aFeeder = f;
    else if (inFeeder(g.teamBId, f) && !bFeeder) bFeeder = f;
    else if (!aFeeder) aFeeder = f;
    else if (!bFeeder) bFeeder = f;
  }
  // A single link-less feeder (bye opponent already seeded) goes to the open side.
  if (fs.length === 1 && aFeeder && !fs[0].game?.nextSlotSide && g.teamAId && !g.teamBId) {
    bFeeder = aFeeder;
    aFeeder = null;
  }

  const wOfLabel = (f: Slot) => `W of ${shortColumnLabel(prevLabel) || 'Round'} G${f.number}`;
  return {
    id: g.id,
    game: g,
    number,
    sourceIds: fs.map((f) => f.id),
    aResolved: g.teamAId == null && aFeeder ? resolvedWinner(aFeeder) : null,
    bResolved: g.teamBId == null && bFeeder ? resolvedWinner(bFeeder) : null,
    aFallback: g.teamAId ? null : aFeeder ? wOfLabel(aFeeder) : shortPlaceholder(g.teamAPlaceholder),
    bFallback: g.teamBId ? null : bFeeder ? wOfLabel(bFeeder) : shortPlaceholder(g.teamBPlaceholder),
  };
}

/**
 * Assign each game a vertical pixel offset so:
 *   - R1 column lays out evenly top-to-bottom
 *   - Each later-round game sits at the midpoint between its source games
 *   - When a game has only one identifiable source (the other team had a
 *     bye), it sits at the row of its source
 *   - Games without any identifiable source fall back to an even distribution
 *
 * Returns a Map<game.id, top-px-offset>.
 *
 * Side-effect: also mutates each column's games array to be **ordered by
 * vertical position** so the bracket reads top-to-bottom in render order.
 * (We re-sort the array, not just compute positions, so the column lays
 * out without depending on insertion order.)
 */

/**
 * Find the games in `prevCol` that fed into `game`. A prev-col game is a
 * source if it contains either of `game`'s participating team ids. (A team
 * with a bye won't have a prev-col game — that participant gets ignored.)
 */
