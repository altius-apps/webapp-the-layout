'use client';

// SquadBuilder — fill a formation's 7 typed slots from the user's owned
// collection, visualized as a literal field diagram (mock: utcg-squad-app.jsx
// Field/SLOTS/EDGES). Tapping an empty slot opens a bottom sheet listing
// eligible, unplaced cards — best-fit (in-position) first, then a
// clearly-labeled out-of-position section (mock: "OUT OF POSITION · EARNS NO
// CHEMISTRY"). Team chemistry + rating + Play Match live in a sticky summary
// bar, matching the mock's persistent footer.
//
// The field's colored link lines are a VISUALIZATION only — every number
// (per-slot chem tag, team total) comes straight from teamChemistry(), never
// recomputed here. A line is drawn between two formation-ADJACENT slots (per
// FORMATION_EDGES below, not every matching pair — otherwise 4 same-team
// cards would draw 6 crossing lines) when both are filled, in-position, and
// share a team (strong/coral) or division (soft/muted) link. A card with only
// the 'league' floor chem (no team/division partner) draws no line — the
// meter's fill already communicates it. Off-position slots draw a dashed
// "off" line to their neighbors instead.

import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import type { OwnedCard } from '@/lib/utcg/server';
import type { UtcgCard } from '@/lib/utcg/data';
import type { FormationKey, SlotType, Formation } from '@/lib/utcg/formations';
import { FORMATIONS, scoreSquad, type ScoredCard } from '@/lib/utcg/formations';
import { fitsSlot } from '@/lib/utcg/position';
import { teamChemistry, type ChemCard } from '@/lib/utcg/chemistry';
import { CardTile } from '@/components/utcg/card-tile';
import { ChemistryMeter } from '@/components/utcg/chemistry-meter';

/** A slot's assignment — the owned card's key, or null if empty. */
export type SquadAssignment = (string | null)[]; // aligned to formation.slots

// ─── Per-formation field layout ─────────────────────────────────────────────
// Pixel coordinates (top-left) + card size on a shared 330×452 canvas, and an
// adjacency edge list (slot index pairs) the link-line SVG draws between.
// `ho` reproduces the mock's exact layout; the other three are new, matching
// the shapes described for formation-select's mini diagrams: vert = a single
// deep column of cutters behind 2 back handlers, hex = a positionless
// hexagon, threeTwo = two side lanes (3 + 2) of cutters behind 2 handlers.

const CARD_W = 92;
// Full (non-compact) card height at CARD_W — portrait 3/4 photo + score /
// position / name / team·year / rarity-bar rows. The field shows real cards
// (same proportions + team·year as the collection), so slots are sized to fit
// the whole card rather than the old short "compact" strip.
const CARD_H = 210;
const FIELD_W = 330;
// Row pitch (vertical gap between stacked slots) and column pitch (horizontal)
// — must exceed the card footprint so cards never overlap.
const ROW_PITCH = CARD_H + 16; // 226
const COL_PITCH = CARD_W + 20; // 112

interface SlotPos {
  x: number;
  y: number;
}

const FORMATION_LAYOUT: Record<FormationKey, { positions: SlotPos[]; edges: [number, number][]; fieldH: number; fieldW?: number }> = {
  // slots order: H1 H2 H3 C1 C2 C3 C4 (indices 0-6). MOBILE/base Ho: 3 handlers
  // across the back, 4 cutters in a compact 2×2 below (a 4-wide row is too wide
  // for a phone). Desktop swaps to HO_WIDE (single cutter row). Full-size cards,
  // rows ROW_PITCH (226) apart.
  ho: {
    positions: [
      { x: 8, y: 28 }, { x: 120, y: 28 }, { x: 232, y: 28 }, // handlers, back row
      { x: 64, y: 254 }, { x: 232, y: 254 }, { x: 64, y: 480 }, { x: 232, y: 480 }, // cutters, 2×2
    ],
    edges: [[0, 1], [1, 2], [0, 3], [1, 3], [1, 4], [2, 4], [3, 4], [3, 5], [4, 6]],
    fieldW: 336,
    fieldH: 714, // 480 + 210 + 24
  },
  // slots order: H1 H2 C1 C2 C3 C4 C5 (indices 0-6). This is the TALL (portrait)
  // vert — 2 handlers across the bottom, 5 cutters climbing straight up. Used on
  // narrow/mobile viewports where a tall column fits the screen's aspect. On
  // WIDE viewports the Field swaps to VERT_WIDE (sideways row) so a phone stays
  // vertical and a desktop goes sideways — whichever fits the screen best.
  vert: {
    positions: [
      { x: 64, y: 1182 }, { x: 174, y: 1182 }, // handlers, back row (bottom; gap above for the Handlers label)
      { x: 119, y: 932 }, { x: 119, y: 706 }, { x: 119, y: 480 }, { x: 119, y: 254 }, { x: 119, y: 28 }, // 5-cutter column climbing up
    ],
    edges: [[0, 1], [0, 2], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]],
    fieldH: 1416, // 1182 (handlers) + 210 (card) + 24 breathing room
  },
  // hex / threeTwo are NOT selectable (FORMATION_ORDER = vert, ho) — kept only
  // so an in-flight run saved with one still renders. Simple non-overlapping
  // grids sized for full cards; not visually tuned since they're unreachable.
  // slots order: H1 H2 H3 H4 C1 C2 C3 (indices 0-6)
  hex: {
    positions: [
      { x: 8, y: 24 }, { x: 176, y: 24 }, { x: 344, y: 24 }, { x: 512, y: 24 }, // handlers row of 4
      { x: 92, y: 250 }, { x: 260, y: 250 }, { x: 428, y: 250 }, // cutters row of 3
    ],
    edges: [[0, 1], [0, 2], [1, 3], [2, 3], [1, 4], [3, 4], [3, 5], [3, 6], [2, 6]],
    fieldW: 612,
    fieldH: 484,
  },
  // slots order: H1 H2 C1 C2 C3 C4 C5 (indices 0-6)
  threeTwo: {
    positions: [
      { x: 8, y: 24 }, { x: 120, y: 24 }, // handlers
      { x: 232, y: 24 }, { x: 344, y: 24 }, { x: 456, y: 24 }, { x: 568, y: 24 }, { x: 680, y: 24 }, // 5 cutters
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]],
    fieldW: 784,
    fieldH: 258,
  },
};

// Wide/sideways vert — a single horizontal row of all 7 (2 handlers on the
// left = "back", then the 5-cutter stack running right). Swapped in for the
// tall vert on wide (desktop) viewports so the whole stack is visible in the
// screen's landscape aspect; the tall column stays on mobile. Column pitch =
// COL_PITCH (112) so cards never overlap.
const VERT_WIDE: (typeof FORMATION_LAYOUT)[FormationKey] = {
  positions: [
    { x: 8, y: 28 }, { x: 120, y: 28 }, // handlers (left)
    { x: 232, y: 28 }, { x: 344, y: 28 }, { x: 456, y: 28 }, { x: 568, y: 28 }, { x: 680, y: 28 }, // 5 cutters →
  ],
  edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]],
  fieldW: 784,
  fieldH: 262, // 28 (top gap for labels) + 210 (card) + 24 (breathing room)
};

// Wide/desktop Ho stack — 3 handlers on the back row, all 4 cutters in a SINGLE
// row below (instead of the 2×2 the narrow layout uses). Evenly spread at
// COL_PITCH so the row reads cleanly. Mobile keeps the more compact base `ho`.
const HO_WIDE: (typeof FORMATION_LAYOUT)[FormationKey] = {
  positions: [
    { x: 120, y: 28 }, { x: 288, y: 28 }, { x: 456, y: 28 }, // 3 handlers, back row (spread over the 4-wide row)
    { x: 8, y: 254 }, { x: 200, y: 254 }, { x: 392, y: 254 }, { x: 584, y: 254 }, // 4 cutters in one row
  ],
  edges: [[0, 1], [1, 2], [0, 3], [1, 3], [1, 4], [2, 4], [3, 4], [3, 5], [4, 6]],
  fieldW: 684,
  fieldH: 488, // 254 + 210 + 24
};

// True on wide (≥ sm/640px) viewports — desktop goes sideways for vert, mobile
// stays vertical. matchMedia so it reacts to resize/rotate. SSR-safe (false
// first paint → hydrates to real value).
function useIsWide(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)');
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

function cx(p: SlotPos): number { return p.x + CARD_W / 2; }
function cy(p: SlotPos): number { return p.y + CARD_H / 2; }

interface SquadBuilderProps {
  formationKey: FormationKey;
  owned: OwnedCard[];
  assignment: SquadAssignment;
  onAssignmentChange: (next: SquadAssignment) => void;
  onChangeFormation: () => void;
  onPlayMatch: () => void;
  /** CTA copy override, forwarded to the footer (PvP shows its stake). */
  ctaLabel?: string;
  onGoToPacks: () => void;
  /** Weekly Brawl legality gate (brawlSquadLegal mirror) — when set, the
   *  footer CTA stays disabled until the full squad also passes this check,
   *  with `label` shown as the reason. Boss mode has no squad-shape rule
   *  (any 7 cards are legal), so it omits this prop. */
  rule?: { legal: (cards: UtcgCard[]) => boolean; label: string };
  /** Brawl target / boss strength to beat — shown next to the live rating so
   *  the player can see how close they are before submitting. */
  targetStrength?: number;
}

function cardKeyOf(o: OwnedCard): string {
  return `${o.card.playerId}|${o.card.teamSlug}|${o.card.year}`;
}

export function SquadBuilder({
  formationKey,
  owned,
  assignment,
  onAssignmentChange,
  onChangeFormation,
  onPlayMatch,
  ctaLabel,
  onGoToPacks,
  rule,
  targetStrength,
}: SquadBuilderProps) {
  const formation = FORMATIONS[formationKey];
  const isWide = useIsWide();
  // On wide (desktop) viewports: vert goes SIDEWAYS and Ho puts all 4 cutters in
  // one row; on mobile both keep their more compact base layouts. Whichever fits
  // the screen's aspect best.
  const layout =
    isWide && formationKey === 'vert' ? VERT_WIDE
    : isWide && formationKey === 'ho' ? HO_WIDE
    : FORMATION_LAYOUT[formationKey];
  const [pickerSlot, setPickerSlot] = useState<number | null>(null);
  const [lastPlaced, setLastPlaced] = useState<number | null>(null);

  const ownedByKey = useMemo(() => {
    const m = new Map<string, OwnedCard>();
    for (const o of owned) m.set(cardKeyOf(o), o);
    return m;
  }, [owned]);

  const placedKeys = useMemo(() => new Set(assignment.filter((k): k is string => k !== null)), [assignment]);
  const filledCount = placedKeys.size;

  const eligibility = useMemo(() => {
    const handlerEligible = owned.filter((o) => fitsSlot(o.card.position, 'handler')).length;
    const cutterEligible = owned.filter((o) => fitsSlot(o.card.position, 'cutter')).length;
    return {
      handlerShort: handlerEligible < formation.handlers,
      cutterShort: cutterEligible < formation.cutters,
      short: handlerEligible < formation.handlers || cutterEligible < formation.cutters,
    };
  }, [owned, formation]);

  // Real chemistry — the ONLY source of per-slot/total numbers. `slot: null`
  // for out-of-position placements would earn 0 anyway (fitsSlot gate), but
  // we still pass the formation's real slot type so in-position cards score.
  const chemInput: ChemCard[] = useMemo(
    () =>
      assignment.map((key, i) => {
        const o = key ? ownedByKey.get(key) : null;
        return o
          ? { teamSlug: o.card.teamSlug, division: o.card.division, position: o.card.position, slot: formation.slots[i] }
          : { teamSlug: '', division: null, position: 'hybrid' as const, slot: null };
      }),
    [assignment, ownedByKey, formation],
  );
  const chemResult = useMemo(() => teamChemistry(chemInput), [chemInput]);

  const meanScore = useMemo(() => {
    const placed = assignment.map((key) => (key ? ownedByKey.get(key) : null)).filter((o): o is OwnedCard => !!o);
    if (placed.length === 0) return null;
    return placed.reduce((s, o) => s + o.card.playerScore, 0) / placed.length;
  }, [assignment, ownedByKey]);

  // Rating folds in chemistry the same way the live preview does elsewhere
  // (formations.ts scoreSquad uses a capped bonus) — here we mirror the
  // mock's simpler `avg + chem*0.35` for the LIVE in-progress readout only;
  // the authoritative post-match number still comes from scoreSquad()/the
  // server, this is just the builder's real-time estimate.
  const liveRating = useMemo(() => {
    if (meanScore === null) return null;
    return Math.round(meanScore + chemResult.total * 0.35);
  }, [meanScore, chemResult.total]);

  // Against-a-target estimate (Brawl/Boss): reuse the SAME scoreSquad() the
  // server evaluator mirrors, not liveRating's looser `+chem*0.35` — the two
  // formulas diverge (liveRating can run +7+, scoreSquad caps the chem bonus
  // at +3), and a target comparison needs to track what the server will
  // actually check. Only computed when a target is in play.
  const targetEstimate = useMemo(() => {
    if (targetStrength === undefined) return null;
    const placedCards: ScoredCard[] = [];
    for (let i = 0; i < assignment.length; i++) {
      const key = assignment[i];
      const o = key ? ownedByKey.get(key) : null;
      if (!o) continue;
      placedCards.push({
        teamSlug: o.card.teamSlug,
        division: o.card.division,
        position: o.card.position,
        slot: formation.slots[i],
        playerScore: o.card.playerScore,
        boost: o.card.boost,
      });
    }
    if (placedCards.length === 0) return null;
    return scoreSquad(placedCards).effectiveStrength;
  }, [assignment, ownedByKey, formation, targetStrength]);

  // Brawl's squad-shape rule (e.g. "all ≤85 OVR", "one team") — only checked
  // once the squad is full, mirroring brawlSquadLegal's own `length !== 7`
  // short-circuit. Boss mode has no such rule (rule is undefined).
  const ruleLegal = useMemo(() => {
    if (!rule) return true;
    const placedCards = assignment
      .map((key) => (key ? ownedByKey.get(key) : null))
      .filter((o): o is OwnedCard => !!o)
      .map((o) => o.card);
    if (placedCards.length !== formation.slots.length) return true; // don't show the failure mid-build
    return rule.legal(placedCards);
  }, [rule, assignment, ownedByKey, formation]);

  const handleSlotTap = useCallback((slotIndex: number) => setPickerSlot(slotIndex), []);

  const handleClearSlot = useCallback(
    (slotIndex: number) => {
      const next = [...assignment];
      next[slotIndex] = null;
      onAssignmentChange(next);
    },
    [assignment, onAssignmentChange],
  );

  const handlePlaceCard = useCallback(
    (key: string) => {
      if (pickerSlot === null) return;
      const next = [...assignment];
      next[pickerSlot] = key;
      onAssignmentChange(next);
      setLastPlaced(pickerSlot);
      setPickerSlot(null);
      try { navigator.vibrate?.(12); } catch { /* no-op */ }
    },
    [pickerSlot, assignment, onAssignmentChange],
  );

  const allSlotsFilled = filledCount === formation.slots.length;
  // With a rule gate (Brawl), the squad must ALSO pass it before the CTA
  // activates; Boss (no `rule`) only needs every slot filled.
  const allFilled = allSlotsFilled && ruleLegal;

  const handlerIndices = formation.slots.map((s, i) => (s === 'handler' ? i : -1)).filter((i) => i >= 0);
  const cutterIndices = formation.slots.map((s, i) => (s === 'cutter' ? i : -1)).filter((i) => i >= 0);

  const slotLabel = useCallback(
    (i: number): string => {
      const isHandler = formation.slots[i] === 'handler';
      const group = isHandler ? handlerIndices : cutterIndices;
      return `${isHandler ? 'H' : 'C'}${group.indexOf(i) + 1}`;
    },
    [formation, handlerIndices, cutterIndices],
  );

  return (
    <div className="flex flex-col gap-6 pb-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-bold tracking-[0.16em] uppercase text-muted font-tight mb-1">
            {formation.name}
          </p>
          <h2 className="font-display italic text-2xl sm:text-3xl font-bold text-ink leading-[0.95] tracking-[-0.02em]">
            Build your squad
          </h2>
        </div>
        <button
          type="button"
          onClick={onChangeFormation}
          className={[
            'text-[10px] font-bold uppercase tracking-[0.1em] text-faint font-tight',
            'hover:text-accent motion-safe:transition-colors motion-safe:duration-150',
            'cursor-pointer underline underline-offset-2 decoration-hairline',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm',
            'min-h-[44px] px-1 flex items-center flex-shrink-0',
          ].join(' ')}
        >
          Change formation
        </button>
      </div>

      {/* Chemistry + rating meter — sits directly under the heading (mock
          layout), so it's always visible without scrolling, not buried below
          the field where it used to get clipped behind the floating tab bar. */}
      <ChemistryMeter total={chemResult.total} perCard={chemResult.perCard} rating={liveRating} />

      {targetStrength !== undefined && (
        <p className="text-[11px] text-center font-tight -mt-3">
          <span className={targetEstimate !== null && targetEstimate > targetStrength ? 'text-accent font-bold' : 'text-faint'}>
            Est. strength {targetEstimate !== null ? targetEstimate.toFixed(1) : '—'} vs target {targetStrength.toFixed(1)}
          </span>
          <span className="text-faint"> · server strength decides it</span>
        </p>
      )}

      {allSlotsFilled && !ruleLegal && rule && (
        <p className="text-[11px] text-live font-tight -mt-2 text-center" role="alert">
          Squad doesn&rsquo;t meet this week&rsquo;s rule: {rule.label}
        </p>
      )}

      <Field
        formation={formation}
        layout={layout}
        assignment={assignment}
        ownedByKey={ownedByKey}
        chemResult={chemResult}
        lastPlaced={lastPlaced}
        onTap={handleSlotTap}
      />

      {(eligibility.handlerShort || eligibility.cutterShort) && (
        <p className="text-[11px] text-faint font-tight -mt-2 text-center">
          {eligibility.handlerShort && eligibility.cutterShort
            ? "You don't have enough eligible handlers or cutters yet."
            : eligibility.handlerShort
              ? "You don't have enough eligible handlers yet."
              : "You don't have enough eligible cutters yet."}
        </p>
      )}
      {eligibility.short && (
        <button
          type="button"
          onClick={onGoToPacks}
          className="self-center inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.1em] text-accent font-tight hover:opacity-80 motion-safe:transition-opacity motion-safe:duration-150 cursor-pointer min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm px-1 -mt-3"
        >
          Open more packs
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M2 6h8M6.5 2.5 10 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}

      {/* Spacer so scrolled content never sits under the sticky Play footer. */}
      <div className="h-20" aria-hidden="true" />

      <PlayMatchFooter
        allFilled={allFilled}
        remaining={formation.slots.length - filledCount}
        ruleBlocked={allSlotsFilled && !ruleLegal}
        onPlayMatch={onPlayMatch}
        ctaLabel={ctaLabel}
      />

      {pickerSlot !== null && (
        <SlotPicker
          slotType={formation.slots[pickerSlot]}
          slotLabel={slotLabel(pickerSlot)}
          owned={owned}
          placedKeys={placedKeys}
          currentKey={assignment[pickerSlot]}
          onPick={handlePlaceCard}
          onClose={() => setPickerSlot(null)}
        />
      )}
    </div>
  );
}

// ─── Field diagram ───────────────────────────────────────────────────────

function Field({
  formation,
  layout,
  assignment,
  ownedByKey,
  chemResult,
  lastPlaced,
  onTap,
}: {
  formation: Formation;
  layout: (typeof FORMATION_LAYOUT)[FormationKey];
  assignment: SquadAssignment;
  ownedByKey: Map<string, OwnedCard>;
  chemResult: ReturnType<typeof teamChemistry>;
  lastPlaced: number | null;
  onTap: (i: number) => void;
}) {
  const fieldW = layout.fieldW ?? FIELD_W;
  const fieldH = layout.fieldH;

  // Scale the field to fit the container's actual width (never upscale past 1x),
  // so it fills the space it has: a phone (~350px) and a desktop column both
  // show the whole squad without horizontal scroll, and cards render as large as
  // the available width allows rather than a hardcoded cap.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [avail, setAvail] = useState(342);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setAvail(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = Math.min(1, avail / fieldW);

  return (
    <div ref={wrapRef} className="w-full flex justify-center">
      <div
        className="relative flex-shrink-0 w-[var(--fw)] h-[var(--fh)]"
        style={{ '--fw': `${fieldW * scale}px`, '--fh': `${fieldH * scale}px` } as React.CSSProperties}
      >
        <div
          className="absolute top-0 left-0 origin-top-left w-[var(--fw)] h-[var(--fh)] [transform:var(--sc)]"
          style={{ '--fw': `${fieldW}px`, '--fh': `${fieldH}px`, '--sc': `scale(${scale})` } as React.CSSProperties}
        >
          {/* Group labels — anchored just above-left of each group's own slots
              (its min x / min y), so they sit over the right group whether the
              group is a vertical column (ho/hex/3-2) or a horizontal row (vert
              laid sideways), rather than always pinning to the field's left. */}
          {(['handler', 'cutter'] as const).map((type) => {
            const pts = layout.positions.filter((_, i) => formation.slots[i] === type);
            if (pts.length === 0) return null;
            const minX = Math.min(...pts.map((p) => p.x));
            const minY = Math.min(...pts.map((p) => p.y));
            return (
              <span
                key={type}
                className="absolute text-[10px] font-bold tracking-[0.22em] uppercase text-faint top-[var(--t)] left-[var(--l)]"
                style={{ '--t': `${minY - 22}px`, '--l': `${minX}px` } as React.CSSProperties}
              >
                {type === 'handler' ? 'Handlers' : 'Cutters'}
              </span>
            );
          })}

          {/* Link lines */}
          <svg className="absolute inset-0 pointer-events-none overflow-visible" width={fieldW} height={fieldH}>
            {layout.edges.map(([a, b]) => {
              const keyA = assignment[a];
              const keyB = assignment[b];
              const cardA = keyA ? ownedByKey.get(keyA) : null;
              const cardB = keyB ? ownedByKey.get(keyB) : null;
              if (!cardA || !cardB) return null;
              const resA = chemResult.perCard[a];
              const resB = chemResult.perCard[b];
              const offA = !resA?.inPosition;
              const offB = !resB?.inPosition;
              const off = offA || offB;

              let stroke = 'rgba(122,106,58,0.5)'; // off
              let width = 1.6;
              let dash: string | undefined = '4 4';
              if (!off) {
                const sameTeam = cardA.card.teamSlug === cardB.card.teamSlug;
                const sameDiv = cardA.card.division && cardA.card.division === cardB.card.division;
                if (sameTeam) {
                  stroke = '#FF3D00';
                  width = 2.6;
                  dash = undefined;
                } else if (sameDiv) {
                  // Theme-aware "muted ink" token, read directly since SVG
                  // stroke can't take a Tailwind text-color class.
                  stroke = 'rgb(var(--muted))';
                  width = 1.6;
                  dash = undefined;
                } else {
                  return null; // league-only or no shared link — no ambient line
                }
              }

              const posA = layout.positions[a];
              const posB = layout.positions[b];
              return (
                <line
                  key={`${a}-${b}`}
                  x1={cx(posA)}
                  y1={cy(posA)}
                  x2={cx(posB)}
                  y2={cy(posB)}
                  stroke={stroke}
                  strokeWidth={width}
                  strokeLinecap="round"
                  strokeDasharray={dash}
                  className="motion-safe:transition-[stroke,opacity] motion-safe:duration-300"
                />
              );
            })}
          </svg>

          {formation.slots.map((slotType, i) => {
            const pos = layout.positions[i];
            const key = assignment[i];
            const owned = key ? ownedByKey.get(key) : null;
            const res = chemResult.perCard[i];
            const off = !!owned && !res?.inPosition;
            const chem = res?.chem ?? 0;

            return (
              <div
                key={i}
                className="absolute z-[2] w-[var(--cw)] h-[var(--ch)] left-[var(--l)] top-[var(--t)]"
                style={{ '--cw': `${CARD_W}px`, '--ch': `${CARD_H}px`, '--l': `${pos.x}px`, '--t': `${pos.y}px` } as React.CSSProperties}
              >
                {owned ? (
                  <div className="relative w-full h-full" key={key + (lastPlaced === i ? '-p' : '')}>
                    <CardTile card={owned.card} onClick={() => onTap(i)} offRole={off} className="motion-safe:animate-card-flip-in" />
                    <span
                      className={[
                        'absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center',
                        'text-[9px] font-extrabold tabular leading-none shadow-soft',
                        chem > 0 ? 'bg-accent text-white' : 'bg-ink/20 text-faint',
                      ].join(' ')}
                    >
                      {off ? 0 : chem}
                    </span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => onTap(i)}
                    aria-label={`Fill empty ${slotType} slot`}
                    className={[
                      'w-full h-full rounded-card bg-ink/[0.03] flex flex-col items-center justify-center gap-1.5',
                      'shadow-[inset_0_2px_5px_rgba(0,0,0,0.06)]',
                      'text-faint hover:text-accent motion-safe:transition-colors motion-safe:duration-150',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      'cursor-pointer',
                    ].join(' ')}
                  >
                    <span className="text-2xl font-light leading-none opacity-50">+</span>
                    <span className="text-[9px] font-bold uppercase tracking-[0.14em]">{slotType}</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Sticky bottom summary — rating + chemistry + Play Match ──────────────

// Play Match footer — fixed (not sticky) directly above the app's floating
// tab bar, with enough bottom offset to clear it + the safe area, so the CTA
// is never hidden behind the tab bar the way the old sticky-in-flow version
// was. The tab bar now floats on every breakpoint (not just mobile), so the
// same clearance applies at all sizes.
function PlayMatchFooter({
  allFilled,
  remaining,
  ruleBlocked = false,
  onPlayMatch,
  ctaLabel,
}: {
  allFilled: boolean;
  remaining: number;
  /** Every slot is filled but the Brawl rule still fails — distinct from
   *  "slots remaining" so the CTA copy explains why it's still disabled. */
  ruleBlocked?: boolean;
  onPlayMatch: () => void;
  /** Overrides the CTA copy. PvP passes its stake here so the button never
   *  spends coins behind a generic "Play Match" label. */
  ctaLabel?: string;
}) {
  return (
    // Floats just above the 58px flat bottom bar (96px cleared the retired
    // floating pill and left it hovering mid-screen).
    <div className="fixed inset-x-4 sm:inset-x-6 bottom-[calc(env(safe-area-inset-bottom)+70px)] z-30 max-w-5xl mx-auto flex justify-center">
      <button
        type="button"
        onClick={onPlayMatch}
        disabled={!allFilled}
        className={[
          'w-full sm:w-auto sm:min-w-[280px] inline-flex items-center justify-center px-8 py-4 rounded-full',
          'text-[13px] font-bold tracking-[0.16em] uppercase font-tight',
          'min-h-[56px] shadow-hero',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
          'motion-safe:transition-all motion-safe:duration-150',
          allFilled
            ? 'bg-accent text-accent-ink hover:opacity-90 cursor-pointer motion-safe:animate-pulse-once'
            : 'bg-surface text-faint cursor-not-allowed',
        ].join(' ')}
      >
        {allFilled
          ? (ctaLabel ?? 'Play Match')
          : ruleBlocked
            ? "Doesn't meet this week's rule"
            : `${remaining} slot${remaining === 1 ? '' : 's'} left`}
      </button>
    </div>
  );
}

// ─── Bottom-sheet slot picker ──────────────────────────────────────────────

function SlotPicker({
  slotType,
  slotLabel,
  owned,
  placedKeys,
  currentKey,
  onPick,
  onClose,
}: {
  slotType: SlotType;
  slotLabel: string;
  owned: OwnedCard[];
  placedKeys: Set<string>;
  currentKey: string | null;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const avail = owned.filter((o) => {
    const key = cardKeyOf(o);
    return key === currentKey || !placedKeys.has(key);
  });
  const fit = avail.filter((o) => fitsSlot(o.card.position, slotType)).sort((a, b) => b.card.playerScore - a.card.playerScore);
  const offFit = avail.filter((o) => !fitsSlot(o.card.position, slotType)).sort((a, b) => b.card.playerScore - a.card.playerScore);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/40 motion-safe:animate-fade-in" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Choose a ${slotType}`}
        className="relative z-10 w-full sm:max-w-lg bg-bg rounded-t-card-lg sm:rounded-card-lg shadow-hero max-h-[85vh] flex flex-col"
      >
        <div className="flex items-center justify-between p-4 border-b border-hairline flex-shrink-0">
          <div>
            <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-accent font-tight mb-0.5">
              Filling {slotLabel}
            </p>
            <h3 className="font-display italic text-xl font-bold text-ink capitalize leading-none">
              {currentKey ? 'Swap' : 'Choose'} {slotType === 'handler' ? 'Handler' : 'Cutter'}
            </h3>
            <p className="text-[10px] font-semibold tracking-[0.08em] text-faint mt-1">
              {fit.length} eligible · best fit first
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-9 h-9 rounded-full flex items-center justify-center text-faint hover:text-ink hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-safe:transition-colors motion-safe:duration-150 cursor-pointer flex-shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2 2l10 10M12 2l-10 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto p-4">
          {fit.length === 0 && offFit.length === 0 ? (
            <p className="text-[13px] text-muted font-tight text-center py-8">
              No eligible {slotType}s available — open more packs.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                {fit.map((o) => {
                  const key = cardKeyOf(o);
                  return (
                    <CardTile key={key} card={o.card} copies={o.copies} selected={key === currentKey} onClick={() => onPick(key)} />
                  );
                })}
              </div>

              {offFit.length > 0 && (
                <>
                  <div className="flex items-center gap-2.5 my-4">
                    <span className="flex-1 h-px bg-hairline" aria-hidden="true" />
                    <span className="text-[9px] font-extrabold tracking-[0.14em] uppercase text-[#7a6a3a] whitespace-nowrap">
                      Out of position · earns no chemistry
                    </span>
                    <span className="flex-1 h-px bg-hairline" aria-hidden="true" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {offFit.map((o) => {
                      const key = cardKeyOf(o);
                      return (
                        <CardTile key={key} card={o.card} copies={o.copies} selected={key === currentKey} onClick={() => onPick(key)} offRole />
                      );
                    })}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
