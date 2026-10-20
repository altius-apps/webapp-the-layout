'use client';

// UtcgGame — the whole client-side game orchestrator (phase/tab state
// machine, like TwelveOhGame). Owns coins/owned/recentPulls/squad-in-progress
// state, lifted here and passed down via props. No context/redux.

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { UtcgSnapshot, OwnedCard } from '@/lib/utcg/server';
import type { PackKind } from '@/lib/utcg/packs';
import { PACKS, FREE_PACK_INTERVAL_MS, DRAFT_PAID_RUNS_PER_DAY } from '@/lib/utcg/packs';
import type { PackPull, SquadCardRef } from '@/lib/utcg/actions';
import {
  openPack,
  quicksell,
  recordMatch,
  getPullHeadshots,
  enterPvp,
  cancelPvp,
  PVP_STAKE,
  claimObjective,
  openRewardPack,
  playWeekly,
  submitSbc,
  claimMilestone,
  craftCard,
  enterRivals,
  cancelRivals,
  claimRivals,
  claimFlash,
  startEvolution,
} from '@/lib/utcg/actions';
import type { PvpOutcome } from '@/lib/utcg/actions';
import type { FormationKey } from '@/lib/utcg/formations';
import { FORMATIONS, scoreSquad, type SquadScoreResult, type ScoredCard } from '@/lib/utcg/formations';
import type { DraftRun, DraftRoundResult } from '@/lib/utcg/draft';
import { mapDraftRun, startDraft, pickDraftCard, playDraftRound, abandonDraft, DRAFT_ENTRY_FEE } from '@/lib/utcg/draft';
import type { WeeklyPlayResult } from '@/lib/utcg/brawl';
import { brawlSquadLegal, BRAWL_FIRST_WIN_PACK, BOSS_FIRST_WIN_PACK } from '@/lib/utcg/brawl';
import type { RivalsOutcome } from '@/lib/utcg/rivals';
import { RIVALS_TIERS } from '@/lib/utcg/rivals';
import type { WeekExtras } from '@/lib/utcg/boosts';
import { AuthModal } from '@/components/auth/auth-modal';
import { useAuth } from '@/lib/auth/auth-provider';
import { SectionNav } from '@/components/section-nav';
import { PackStore } from '@/components/utcg/pack-store';
import { PackOpenAnimation } from '@/components/utcg/pack-open-animation';
import { CollectionGrid, FilterPill } from '@/components/utcg/collection-grid';
import { FormationSelect } from '@/components/utcg/formation-select';
import { SquadBuilder, type SquadAssignment } from '@/components/utcg/squad-builder';
import { MatchResult } from '@/components/utcg/match-result';
import { PvpResult } from '@/components/utcg/pvp-result';
import { PvpHistory } from '@/components/utcg/pvp-history';
import { WeeklyResult } from '@/components/utcg/weekly-result';
import { RivalsResult } from '@/components/utcg/rivals-result';
import { RivalsBoard } from '@/components/utcg/rivals-board';
import { TotwStrip } from '@/components/utcg/totw-strip';
import { ProgressHub } from '@/components/utcg/progress-hub';
import { SbcBoard } from '@/components/utcg/sbc-board';
import { CollectionGoals } from '@/components/utcg/collection-goals';
import { EvolutionsBoard } from '@/components/utcg/evolutions-board';
import { CardActionsSheet } from '@/components/utcg/card-actions-sheet';
import { CardTile } from '@/components/utcg/card-tile';
import { CoinGlyph } from '@/components/utcg/coin-glyph';
import { PlayModeSelect, type PlayMode } from '@/components/utcg/draft-mode';
import { DraftPick } from '@/components/utcg/draft-pick';
import { DraftGauntlet } from '@/components/utcg/draft-gauntlet';
import { Marketplace } from '@/components/utcg/marketplace/Marketplace';
import { ListCardModal } from '@/components/utcg/marketplace/ListCardModal';
import type { UtcgCard } from '@/lib/utcg/data';

// ─── Types ───────────────────────────────────────────────────────────────

type Tab = 'play' | 'packs' | 'collection' | 'market';
// 'build' phases sit under the Play tab, Squad Battle/Brawl/Boss sub-flow:
// mode-select -> formation-select -> squad-builder -> result
type BuildPhase = 'mode-select' | 'formation-select' | 'squad-builder' | 'result';
// Draft sub-flow phases, entered from mode-select's Draft card.
type DraftPhase = 'formation-select' | 'run';
// Collection tab's own sub-tabs (cards / SBCs / goals / evolutions).
type CollectionSubTab = 'cards' | 'sbcs' | 'goals' | 'evolutions';

function ownedKey(o: { playerId: string; teamSlug: string; year: number }): string {
  return `${o.playerId}|${o.teamSlug}|${o.year}`;
}

interface UtcgGameProps {
  snapshot: UtcgSnapshot;
}

export function UtcgGame({ snapshot }: UtcgGameProps) {
  const router = useRouter();
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('play');

  // Sign-in reconciliation: `snapshot.signedIn` is computed server-side at
  // render time. When the user signs in via the AuthModal on this page, the
  // client AuthProvider picks up the new session but the server snapshot is
  // stale, so the signed-out CTA lingers until a manual reload. Once the client
  // sees a user while the server still thinks we're signed out, refresh so the
  // page re-runs getUtcgSnapshot() with the new session cookie and admits them.
  useEffect(() => {
    if (user && !snapshot.signedIn) router.refresh();
  }, [user, snapshot.signedIn, router]);

  // Wallet + collection — seeded from snapshot, optimistically mutated.
  const [coins, setCoins] = useState(snapshot.wallet?.coins ?? 0);
  const [owned, setOwned] = useState<OwnedCard[]>(snapshot.owned);
  const [freePackReadyInMs, setFreePackReadyInMs] = useState(snapshot.wallet?.freePackReadyInMs ?? 0);
  const [packPoints, setPackPoints] = useState(snapshot.collection?.packPoints ?? 0);

  // Re-sync local state whenever the server snapshot prop reference changes
  // (i.e. after router.refresh() re-runs getUtcgSnapshot() on the page).
  const snapshotRef = useRef(snapshot);
  useEffect(() => {
    if (snapshotRef.current === snapshot) return;
    snapshotRef.current = snapshot;
    setCoins(snapshot.wallet?.coins ?? 0);
    setOwned(snapshot.owned);
    setFreePackReadyInMs(snapshot.wallet?.freePackReadyInMs ?? 0);
    setPackPoints(snapshot.collection?.packPoints ?? 0);
  }, [snapshot]);

  // Pack opening flow
  const [opening, setOpening] = useState<PackKind | null>(null);
  const [recentPulls, setRecentPulls] = useState<PackPull[] | null>(null);
  const [openingPackKind, setOpeningPackKind] = useState<PackKind | null>(null);
  const [packError, setPackError] = useState<string | null>(null);
  const [selling, setSelling] = useState(false);
  const [sellError, setSellError] = useState<string | null>(null);

  // Build/play flow — starts at the Squad Battle vs Draft mode picker.
  const [buildPhase, setBuildPhase] = useState<BuildPhase>('mode-select');
  const [formationKey, setFormationKey] = useState<FormationKey | null>(null);
  const [assignment, setAssignment] = useState<SquadAssignment>([]);
  const [matchResultData, setMatchResultData] = useState<SquadScoreResult | null>(null);
  const [coinsAwarded, setCoinsAwarded] = useState<number | null>(null);
  const [rewardCapped, setRewardCapped] = useState(false);
  // Squad Battles played today (UTC) as of the last recordMatch() response —
  // drives MatchResult's pay-decay context line (matchPayMultiplier).
  const [lastMatchesToday, setLastMatchesToday] = useState<number | null>(null);
  const [matchError, setMatchError] = useState<string | null>(null);
  // PvP result for the squad just submitted — either 'queued' (parked as the
  // open challenge) or 'resolved' (played an opponent's stored squad).
  const [pvpOutcome, setPvpOutcome] = useState<PvpOutcome | null>(null);
  const [pvpCancelling, setPvpCancelling] = useState(false);

  // Rivals — same queued/resolved shape as PvP, but unstaked (weekly points,
  // not coins). Reuses the Squad Battle formation-select/squad-builder flow.
  const [rivalsOutcome, setRivalsOutcome] = useState<RivalsOutcome | null>(null);
  const [rivalsError, setRivalsError] = useState<string | null>(null);
  const [rivalsCancelling, setRivalsCancelling] = useState(false);
  const [claimingRivalsWeek, setClaimingRivalsWeek] = useState<string | null>(null);
  const [rivalsClaimError, setRivalsClaimError] = useState<string | null>(null);
  const [claimingFlashKey, setClaimingFlashKey] = useState<string | null>(null);
  const [flashClaimError, setFlashClaimError] = useState<string | null>(null);

  // Weekly Brawl / Featured Boss — reuses the Squad Battle formation-select +
  // squad-builder flow (playMode === 'brawl' | 'boss' routes the same
  // formation-select/squad-builder/result branches down in the JSX).
  const [weeklyResult, setWeeklyResult] = useState<WeeklyPlayResult | null>(null);
  const [weeklyError, setWeeklyError] = useState<string | null>(null);

  // Progression — season/streak/objectives/reward packs (ProgressHub, Play tab).
  const [claimingObjectiveKey, setClaimingObjectiveKey] = useState<string | null>(null);
  const [objectiveClaimError, setObjectiveClaimError] = useState<string | null>(null);

  // Reward-pack reveal (season/streak/Brawl/Boss/SBC/milestone grants) reuses
  // PackOpenAnimation via the SAME recentPulls/openingPackKind state as store
  // packs — openingRewardId tracks which reward pack is in flight so its row
  // can show its own spinner, and revealReturnTab remembers which tab to
  // return to on close (store packs always return to 'packs'; reward packs
  // can open from Play or Collection and must come back to where they started).
  const [openingRewardId, setOpeningRewardId] = useState<string | null>(null);
  const [revealReturnTab, setRevealReturnTab] = useState<Tab>('packs');

  // Collection tab's own sub-tabs + the SBC/milestone/craft mutation state.
  const [collectionSubTab, setCollectionSubTab] = useState<CollectionSubTab>('cards');
  const [sbcSubmitting, setSbcSubmitting] = useState(false);
  const [sbcSubmittingKey, setSbcSubmittingKey] = useState<string | null>(null);
  const [sbcError, setSbcError] = useState<string | null>(null);
  // TOTW Upgrade SBC grants a card directly (submitSbc's {kind:'card'}
  // branch) — shown in its own small panel since there's no reward pack to
  // open for it.
  const [sbcGrantedCard, setSbcGrantedCard] = useState<SquadCardRef | null>(null);
  const [claimingMilestone, setClaimingMilestone] = useState<string | null>(null);
  const [milestoneClaimError, setMilestoneClaimError] = useState<string | null>(null);

  // Card actions sheet (Collection -> tap a card): List on Market / Craft / Evolve.
  const [actionsCard, setActionsCard] = useState<UtcgCard | null>(null);
  const [crafting, setCrafting] = useState(false);
  const [craftError, setCraftError] = useState<string | null>(null);
  const [evolving, setEvolving] = useState(false);
  const [evolveError, setEvolveError] = useState<string | null>(null);
  const [startingEvoKey, setStartingEvoKey] = useState<string | null>(null);

  // ── Draft mode ────────────────────────────────────────────────────────
  // Seed from the snapshot's activeDraftRun (server-resolved, survives a
  // reload) so a run mid-draft or mid-gauntlet resumes on its own screen
  // rather than dropping the user back at mode-select.
  const [draftRun, setDraftRun] = useState<DraftRun | null>(() =>
    snapshot.activeDraftRun ? mapDraftRun(snapshot.activeDraftRun) : null,
  );
  const [playMode, setPlayMode] = useState<PlayMode | null>(() => (snapshot.activeDraftRun ? 'draft' : null));
  const [draftPhase, setDraftPhase] = useState<DraftPhase>(() => (snapshot.activeDraftRun ? 'run' : 'formation-select'));
  const [draftPicking, setDraftPicking] = useState(false);
  const [draftPickError, setDraftPickError] = useState<string | null>(null);
  const [draftPlaying, setDraftPlaying] = useState(false);
  const [draftRoundResult, setDraftRoundResult] = useState<DraftRoundResult | null>(null);
  const [draftGauntletError, setDraftGauntletError] = useState<string | null>(null);
  const [draftStartError, setDraftStartError] = useState<string | null>(null);
  // Headshots for the players in the active draft run (deals + picks). The RPC
  // payload stays thin, so we resolve photos client-side from ufa_players —
  // same idiom as the pack reveal — and pass them into draftCardToUtcgCard so
  // draft & gauntlet cards show real photos instead of always-monogram.
  const [draftHeadshots, setDraftHeadshots] = useState<Map<string, string>>(() => new Map());

  // Market — the card currently open in the ListCardModal (Collection tab's
  // "tap a card to list it" entry point). null = modal closed.
  const [listingCard, setListingCard] = useState<UtcgCard | null>(null);

  // Auth CTA
  const [authOpen, setAuthOpen] = useState(false);

  // Coin pill "charge" flash — briefly pulses the header pill after a paid
  // pack purchase fires, giving purchase feedback while the request is in
  // flight (mock: .coinpill-in.flash). Free-pack opens don't spend coins, so
  // they're excluded.
  const [flashCoins, setFlashCoins] = useState(false);
  useEffect(() => {
    if (!opening || opening === 'free') return;
    setFlashCoins(true);
    const t = setTimeout(() => setFlashCoins(false), 700);
    return () => clearTimeout(t);
  }, [opening]);

  const ownedByKey = useCallback(
    (key: string) => owned.find((o) => ownedKey(o.card) === key) ?? null,
    [owned],
  );

  // ── Pack opening ─────────────────────────────────────────────────────────

  const handleOpenPack = useCallback(
    async (kind: PackKind) => {
      setPackError(null);
      setOpening(kind);
      try {
        const pulls = await openPack(kind);
        // Optimistic: decrement coins immediately for a snappy feel.
        setCoins((c) => Math.max(0, c - PACKS[kind].price));
        // Optimistically fold pulls into `owned` so the collection feels live
        // even before router.refresh() reconciles the authoritative list.
        setOwned((prev) => {
          const next = [...prev];
          for (const p of pulls) {
            const key = `${p.playerId}|${p.teamSlug}|${p.year}`;
            const idx = next.findIndex((o) => ownedKey(o.card) === key);
            if (idx >= 0) {
              next[idx] = { ...next[idx], copies: next[idx].copies + 1 };
            }
            // New cards (isNew) aren't hydrated to a full UtcgCard here — the
            // reveal screen shows them from `recentPulls` instead; the
            // background refresh reconciles `owned` with full card data.
          }
          return next;
        });
        if (kind === 'free') setFreePackReadyInMs(FREE_PACK_INTERVAL_MS);
        setRecentPulls(pulls);
        setOpeningPackKind(kind);
        // Reconcile the authoritative owned list + wallet in the background.
        router.refresh();
      } catch (err) {
        setPackError(err instanceof Error ? err.message : 'Could not open pack — try again.');
      } finally {
        setOpening(null);
      }
    },
    [router],
  );

  const handleSellDuplicates = useCallback(
    async (dupes: { playerId: string; teamSlug: string; year: number; qty: number }[]) => {
      setSelling(true);
      setSellError(null);
      try {
        let wallet = null;
        for (const d of dupes) {
          wallet = await quicksell(d.playerId, d.teamSlug, d.year, d.qty);
        }
        if (wallet) setCoins(wallet.coins);
        // Locally decrement/remove sold copies from owned.
        setOwned((prev) =>
          prev
            .map((o) => {
              const dupe = dupes.find((d) => ownedKey(o.card) === `${d.playerId}|${d.teamSlug}|${d.year}`);
              if (!dupe) return o;
              return { ...o, copies: Math.max(0, o.copies - dupe.qty) };
            })
            .filter((o) => o.copies > 0),
        );
        router.refresh();
      } catch (err) {
        setSellError(err instanceof Error ? err.message : 'Could not sell duplicates — try again.');
      } finally {
        setSelling(false);
      }
    },
    [router],
  );

  const handleDonePack = useCallback(() => {
    setRecentPulls(null);
    setOpeningPackKind(null);
    setOpeningRewardId(null);
    setSellError(null);
    // Store packs always land on Packs; reward packs return to wherever they
    // were opened from (Play's ProgressHub/WeeklyResult, or Collection's SBC
    // board / milestones) — revealReturnTab tracks which.
    setTab(revealReturnTab);
  }, [revealReturnTab]);

  // ── Build / Play flow (Squad Battle) ─────────────────────────────────────

  const handleSelectSquadBattle = useCallback(() => {
    setPlayMode('squad');
    setBuildPhase('formation-select');
  }, []);

  // PvP reuses the ENTIRE squad flow (formation picker → builder). Only the
  // submit RPC and the result screen differ, so there's no second builder.
  const handleSelectPvp = useCallback(() => {
    setPlayMode('pvp');
    setBuildPhase('formation-select');
  }, []);

  // Weekly Brawl / Featured Boss ALSO reuse the squad flow — same formation
  // picker + builder, gated by brawlSquadLegal (Brawl only) and scored
  // against the week's target/boss strength instead of a 12-game record.
  const handleSelectBrawl = useCallback(() => {
    setPlayMode('brawl');
    setBuildPhase('formation-select');
  }, []);

  const handleSelectBoss = useCallback(() => {
    setPlayMode('boss');
    setBuildPhase('formation-select');
  }, []);

  // Rivals ALSO reuses the squad flow — unstaked, so no market gate (unlike
  // staked PvP's PvpModeCard).
  const handleSelectRivals = useCallback(() => {
    setPlayMode('rivals');
    setBuildPhase('formation-select');
  }, []);

  const handleSelectFormation = useCallback((key: FormationKey) => {
    setFormationKey(key);
    setAssignment(new Array(FORMATIONS[key].slots.length).fill(null));
    setBuildPhase('squad-builder');
  }, []);

  // Back out of a chosen game mode (Squad Battle / Draft) at the formation
  // picker, returning to the Play mode-select screen. Clears any in-progress
  // formation choice and the draft start error.
  const handleBackToModeSelect = useCallback(() => {
    setPlayMode(null);
    setFormationKey(null);
    setAssignment([]);
    setDraftStartError(null);
    setDraftPhase('formation-select');
    setBuildPhase('mode-select');
  }, []);

  const handleChangeFormation = useCallback(() => {
    setFormationKey(null);
    setAssignment([]);
    setBuildPhase('formation-select');
  }, []);

  /** Ordered cards + refs for the current assignment, one per slot (handlers
   *  first). Shared by Squad Battle and PvP — both submit the same shape. */
  const buildSquadPayload = useCallback(() => {
    const formation = FORMATIONS[formationKey as FormationKey];
    const cards: ScoredCard[] = [];
    const refs: SquadCardRef[] = [];
    for (let i = 0; i < assignment.length; i++) {
      const key = assignment[i];
      if (!key) continue;
      const o = ownedByKey(key);
      if (!o) continue;
      cards.push({
        teamSlug: o.card.teamSlug,
        division: o.card.division,
        position: o.card.position,
        slot: formation.slots[i],
        playerScore: o.card.playerScore,
      });
      refs.push({ playerId: o.card.playerId, teamSlug: o.card.teamSlug, year: o.card.year });
    }
    return { cards, refs };
  }, [formationKey, assignment, ownedByKey]);

  const handlePlayPvp = useCallback(async () => {
    if (!formationKey) return;
    const { cards, refs } = buildSquadPayload();

    // Preview the squad's own numbers immediately; the SERVER decides the
    // match and the coins.
    setMatchResultData(scoreSquad(cards));
    setPvpOutcome(null);
    setCoinsAwarded(null);
    setRewardCapped(false);
    setMatchError(null);
    setBuildPhase('result');

    try {
      const outcome = await enterPvp(formationKey, refs);
      setCoins(outcome.coins);
      setPvpOutcome(outcome);
      router.refresh();
    } catch (err) {
      setMatchError(err instanceof Error ? err.message : 'Could not enter PvP — no coins were staked.');
    }
  }, [formationKey, buildSquadPayload, router]);

  // Rivals submit — same preview-then-reconcile shape as handlePlayPvp, but
  // unstaked: no coins move either way, so there's no optimistic wallet
  // change and no "insufficient coins" failure mode.
  const handlePlayRivals = useCallback(async () => {
    if (!formationKey) return;
    const { refs } = buildSquadPayload();
    setRivalsOutcome(null);
    setRivalsError(null);
    setBuildPhase('result');

    try {
      const outcome = await enterRivals(formationKey, refs);
      setRivalsOutcome(outcome);
      router.refresh();
    } catch (err) {
      setRivalsError(err instanceof Error ? err.message : 'Could not enter Rivals — try again.');
    }
  }, [formationKey, buildSquadPayload, router]);

  const handlePlayMatch = useCallback(async () => {
    if (!formationKey) return;
    const { cards, refs } = buildSquadPayload();

    // Local scoreSquad() drives the instant preview (record + strength bar);
    // the SERVER recomputes authoritatively and its numbers win for coins.
    const result = scoreSquad(cards);
    setMatchResultData(result);
    setCoinsAwarded(null);
    setRewardCapped(false);
    setMatchError(null);
    setBuildPhase('result');

    try {
      const outcome = await recordMatch(formationKey, refs);
      setCoins(outcome.coins);
      setCoinsAwarded(outcome.reward);
      setRewardCapped(outcome.capped);
      setLastMatchesToday(outcome.matchesToday);
      // Reconcile the displayed record to the server's authoritative result
      // (near-always identical to the preview; this guarantees they never drift).
      setMatchResultData((prev) =>
        prev
          ? { ...prev, record: { ...prev.record, wins: outcome.wins, losses: outcome.losses } }
          : prev,
      );
      router.refresh();
    } catch (err) {
      setMatchError(err instanceof Error ? err.message : 'Could not record match — coins not awarded.');
    }
  }, [formationKey, buildSquadPayload, router]);

  // Weekly Brawl / Featured Boss submit — same "preview-then-reconcile"
  // shape as handlePlayPvp: jump to the result screen immediately, then fill
  // it in once the server responds. No coins move either way; a win only
  // pays a reward pack, and only on the week's first win (rewardPackId null
  // on replays).
  const handlePlayWeekly = useCallback(async () => {
    if (!formationKey || (playMode !== 'brawl' && playMode !== 'boss')) return;
    const { refs } = buildSquadPayload();
    setWeeklyResult(null);
    setWeeklyError(null);
    setBuildPhase('result');
    try {
      const result = await playWeekly(playMode, formationKey, refs);
      setWeeklyResult(result);
      router.refresh();
    } catch (err) {
      setWeeklyError(err instanceof Error ? err.message : 'Could not submit your squad — try again.');
    }
  }, [formationKey, playMode, buildSquadPayload, router]);

  const handleBuildAgain = useCallback(() => {
    setFormationKey(null);
    setAssignment([]);
    setMatchResultData(null);
    setCoinsAwarded(null);
    setRewardCapped(false);
    setLastMatchesToday(null);
    setMatchError(null);
    setPvpOutcome(null);
    setWeeklyResult(null);
    setWeeklyError(null);
    setRivalsOutcome(null);
    setRivalsError(null);
    setBuildPhase('mode-select');
  }, []);

  // Declared AFTER handleBuildAgain — it calls it, and these are const
  // bindings, so the reverse order would be a TDZ error.
  const handleCancelPvp = useCallback(async () => {
    setPvpCancelling(true);
    setMatchError(null);
    try {
      const res = await cancelPvp();
      setCoins(res.coins);
      handleBuildAgain();
      router.refresh();
    } catch (err) {
      // Most likely "squad was just played" — a challenger beat us to it.
      setMatchError(err instanceof Error ? err.message : 'Could not withdraw.');
    } finally {
      setPvpCancelling(false);
    }
  }, [handleBuildAgain, router]);

  // Rivals withdraw — unstaked, so there's no refund to report, just a clean
  // return to mode-select (same "beat by a challenger" failure mode as PvP).
  const handleCancelRivals = useCallback(async () => {
    setRivalsCancelling(true);
    setRivalsError(null);
    try {
      await cancelRivals();
      handleBuildAgain();
      router.refresh();
    } catch (err) {
      setRivalsError(err instanceof Error ? err.message : 'Could not withdraw.');
    } finally {
      setRivalsCancelling(false);
    }
  }, [handleBuildAgain, router]);

  const handleBackToPlay = useCallback(() => {
    handleBuildAgain();
    setTab('play');
  }, [handleBuildAgain]);

  const goToPacks = useCallback(() => setTab('packs'), []);

  // ── Draft mode ────────────────────────────────────────────────────────

  const handleSelectDraft = useCallback(() => {
    setPlayMode('draft');
    // A run is already active (resumed from the snapshot, or started earlier
    // this session) — jump straight to its current screen instead of the
    // formation picker.
    if (draftRun) {
      setDraftPhase('run');
      return;
    }
    setDraftPhase('formation-select');
    setBuildPhase('formation-select'); // reuse the shared formation-select render branch below
  }, [draftRun]);

  // Resolve headshots for whoever is currently in the run (dealt candidates +
  // locked picks). Fetches only ids we don't already have, so advancing a slot
  // or a gauntlet round only pulls the new faces. Cosmetic — failures are
  // swallowed by getPullHeadshots and just fall back to monograms.
  useEffect(() => {
    if (!draftRun) return;
    const ids = [
      ...draftRun.deals.map((c) => c.playerId),
      ...draftRun.picks.map((c) => c.playerId),
    ];
    const missing = ids.filter((id) => !draftHeadshots.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    getPullHeadshots(missing).then((map) => {
      if (cancelled || map.size === 0) return;
      setDraftHeadshots((prev) => {
        const next = new Map(prev);
        for (const [id, url] of map) next.set(id, url);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [draftRun, draftHeadshots]);

  const handleSelectDraftFormation = useCallback(
    async (key: FormationKey) => {
      setDraftStartError(null);
      // Past the daily paid-run cap this starts a free practice run — no
      // entry fee is charged server-side, so the optimistic decrement below
      // must not fire either (it was firing unconditionally, which briefly
      // showed a charge that never happened and was only fixed by the
      // router.refresh() reconciliation a moment later).
      // snapshot.wallet is only null when signed out, unreachable from here —
      // fallback defaults to "paid" (matches the server's own default for a
      // wallet with no draft_paid_day recorded yet) rather than "practice".
      const willCharge = (snapshot.wallet?.draftPaidRunsLeft ?? DRAFT_PAID_RUNS_PER_DAY) > 0;
      try {
        // Optimistic: decrement the header coin count immediately. The
        // server is authoritative — a failed start (insufficient coins, a
        // run already active) never actually charges, and router.refresh()
        // below reconciles the real balance either way.
        if (willCharge) setCoins((c) => Math.max(0, c - DRAFT_ENTRY_FEE));
        const run = await startDraft(key);
        setDraftRun(run);
        setDraftPhase('run');
        router.refresh();
      } catch (err) {
        // Roll back the optimistic decrement — the entry fee was never charged.
        if (willCharge) setCoins((c) => c + DRAFT_ENTRY_FEE);
        const message = err instanceof Error ? err.message : 'Could not start draft — try again.';
        setDraftStartError(message);
        // "already in progress" — the server has a run we don't know about
        // locally yet (e.g. a second tab). Reconcile from a fresh snapshot
        // read instead of leaving the user stuck on a start error.
        if (/already in progress/i.test(message)) {
          router.refresh();
        }
      }
    },
    [router, snapshot.wallet?.draftPaidRunsLeft],
  );

  const handleDraftPick = useCallback(
    async (index: number) => {
      if (!draftRun) return;
      setDraftPicking(true);
      setDraftPickError(null);
      try {
        const next = await pickDraftCard(draftRun.id, index);
        setDraftRun(next);
      } catch (err) {
        setDraftPickError(err instanceof Error ? err.message : 'Could not lock in that pick — try again.');
      } finally {
        setDraftPicking(false);
      }
    },
    [draftRun],
  );

  const handlePlayDraftRound = useCallback(async () => {
    if (!draftRun) return;
    setDraftPlaying(true);
    setDraftGauntletError(null);
    try {
      const result = await playDraftRound(draftRun.id);
      setDraftRoundResult(result);
      setDraftRun((prev) =>
        prev
          ? {
              ...prev,
              status: result.status,
              round: result.round,
              bank: result.bank,
              payout: result.payout,
            }
          : prev,
      );
      if (result.coins !== null) setCoins(result.coins);
      if (result.status === 'complete') router.refresh();
    } catch (err) {
      setDraftGauntletError(err instanceof Error ? err.message : 'Could not play that round — try again.');
    } finally {
      setDraftPlaying(false);
    }
  }, [draftRun, router]);

  const handleDraftCashOut = useCallback(async () => {
    if (!draftRun) return;
    try {
      // abandonDraft's payout is already folded into the returned coins
      // balance — no need to apply it separately.
      const { coins: newCoins } = await abandonDraft(draftRun.id);
      setCoins(newCoins);
      setDraftRun(null);
      setDraftRoundResult(null);
      setPlayMode(null);
      setBuildPhase('mode-select');
      router.refresh();
    } catch (err) {
      // Cash-out failing is rare (network) — surface inline rather than
      // silently stranding the user on the draft screen.
      setDraftGauntletError(err instanceof Error ? err.message : 'Could not cash out — try again.');
    }
  }, [draftRun, router]);

  const handleDraftRunDone = useCallback(
    (again: boolean) => {
      setDraftRun(null);
      setDraftRoundResult(null);
      setDraftPickError(null);
      setDraftGauntletError(null);
      if (again) {
        setPlayMode('draft');
        setDraftPhase('formation-select');
        setBuildPhase('formation-select');
      } else {
        setPlayMode(null);
        setBuildPhase('mode-select');
      }
    },
    [],
  );

  // ── Progression: objectives, reward packs, SBCs, milestones, crafting ────

  const handleClaimObjective = useCallback(
    async (key: string, periodKey: string) => {
      setClaimingObjectiveKey(key);
      setObjectiveClaimError(null);
      try {
        const res = await claimObjective(key, periodKey);
        setCoins(res.coins);
        router.refresh();
      } catch (err) {
        setObjectiveClaimError(err instanceof Error ? err.message : 'Could not claim that objective — try again.');
      } finally {
        setClaimingObjectiveKey(null);
      }
    },
    [router],
  );

  // Shared by every reward-pack source (season/streak/Brawl/Boss/SBC/
  // milestone) — opens the SAME PackOpenAnimation store packs use, just fed
  // from utcg_open_reward_pack instead of utcg_open_pack. `fromTab` records
  // where to land back on close (handleDonePack reads revealReturnTab).
  const handleOpenRewardPack = useCallback(
    async (id: string, packKind: PackKind, fromTab: Tab = tab) => {
      setOpeningRewardId(id);
      setRevealReturnTab(fromTab);
      setPackError(null);
      try {
        const pulls = await openRewardPack(id);
        setOwned((prev) => {
          const next = [...prev];
          for (const p of pulls) {
            const key = `${p.playerId}|${p.teamSlug}|${p.year}`;
            const idx = next.findIndex((o) => ownedKey(o.card) === key);
            if (idx >= 0) {
              next[idx] = { ...next[idx], copies: next[idx].copies + 1, untradeable: next[idx].untradeable + 1 };
            }
            // New cards aren't hydrated here (same as store packs) — the
            // reveal shows them from `recentPulls`; router.refresh() reconciles.
          }
          return next;
        });
        setRecentPulls(pulls);
        setOpeningPackKind(packKind);
        router.refresh();
      } catch (err) {
        setPackError(err instanceof Error ? err.message : 'Could not open that pack — try again.');
      } finally {
        setOpeningRewardId(null);
      }
    },
    [tab],
  );

  const handleSubmitSbc = useCallback(
    async (key: string, cards: { playerId: string; teamSlug: string; year: number }[]) => {
      setSbcSubmitting(true);
      setSbcSubmittingKey(key);
      setSbcError(null);
      try {
        const res = await submitSbc(key, cards);
        // Consume the handed-in copies locally (untradeable first, mirroring
        // the server) so the picker/grid don't sit stale for a round-trip —
        // same pattern as handleSellDuplicates.
        setOwned((prev) => {
          const consumed = new Map<string, number>();
          for (const c of cards) {
            const k = `${c.playerId}|${c.teamSlug}|${c.year}`;
            consumed.set(k, (consumed.get(k) ?? 0) + 1);
          }
          return prev
            .map((o) => {
              const qty = consumed.get(ownedKey(o.card));
              if (!qty) return o;
              const untradeableTaken = Math.min(o.untradeable, qty);
              return { ...o, copies: Math.max(0, o.copies - qty), untradeable: Math.max(0, o.untradeable - untradeableTaken) };
            })
            .filter((o) => o.copies > 0);
        });
        if (res.kind === 'pack') {
          handleOpenRewardPack(res.rewardPackId, res.rewardPack, 'collection');
        } else {
          // TOTW Upgrade SBC grants a card directly — no pack to open, so
          // there's nothing for handleOpenRewardPack to do. Show it in its
          // own small panel instead (sbcGrantedCard) — router.refresh() alone
          // would leave the user staring at the board with no feedback that
          // anything happened.
          setSbcGrantedCard(res.card);
          router.refresh();
        }
      } catch (err) {
        setSbcError(err instanceof Error ? err.message : 'Could not submit that SBC — try again.');
      } finally {
        setSbcSubmitting(false);
        setSbcSubmittingKey(null);
      }
    },
    [handleOpenRewardPack, router],
  );

  const handleClaimMilestone = useCallback(
    async (milestone: string) => {
      setClaimingMilestone(milestone);
      setMilestoneClaimError(null);
      try {
        const res = await claimMilestone(milestone);
        handleOpenRewardPack(res.rewardPackId, res.rewardPack, 'collection');
      } catch (err) {
        setMilestoneClaimError(err instanceof Error ? err.message : 'Could not claim that milestone — try again.');
      } finally {
        setClaimingMilestone(null);
      }
    },
    [handleOpenRewardPack],
  );

  // Rivals tier claim — can grant MULTIPLE reward packs at once (every tier
  // reached but unclaimed). handleOpenRewardPack only opens one id at a time,
  // so a single-pack claim opens it immediately (kind resolved from
  // claimedTier via RIVALS_TIERS); a multi-pack claim just refreshes and
  // leaves the rest sitting in ProgressHub's "Unopened packs" tray, same as
  // any other reward source.
  const handleClaimRivals = useCallback(
    async (weekKey: string) => {
      setClaimingRivalsWeek(weekKey);
      setRivalsClaimError(null);
      try {
        const res = await claimRivals(weekKey);
        if (res.rewardPackIds.length === 1) {
          const tierDef = RIVALS_TIERS.find((t) => t.tier === res.claimedTier);
          if (tierDef) {
            handleOpenRewardPack(res.rewardPackIds[0], tierDef.pack, 'play');
            return;
          }
        }
        router.refresh();
      } catch (err) {
        setRivalsClaimError(err instanceof Error ? err.message : 'Could not claim that tier — try again.');
      } finally {
        setClaimingRivalsWeek(null);
      }
    },
    [handleOpenRewardPack, router],
  );

  const handleClaimFlash = useCallback(
    async (key: string) => {
      setClaimingFlashKey(key);
      setFlashClaimError(null);
      try {
        const res = await claimFlash(key);
        handleOpenRewardPack(res.rewardPackId, res.rewardPack, 'play');
      } catch (err) {
        setFlashClaimError(err instanceof Error ? err.message : 'Could not claim that challenge — try again.');
      } finally {
        setClaimingFlashKey(null);
      }
    },
    [handleOpenRewardPack],
  );

  // Card actions sheet (Collection -> tap a card).
  const handleTapCard = useCallback((card: UtcgCard) => {
    setCraftError(null);
    setEvolveError(null);
    setActionsCard(card);
  }, []);

  const handleListFromSheet = useCallback(() => {
    if (!actionsCard) return;
    setListingCard(actionsCard);
    setActionsCard(null);
  }, [actionsCard]);

  const handleCraft = useCallback(async () => {
    if (!actionsCard) return;
    setCrafting(true);
    setCraftError(null);
    try {
      const card = actionsCard;
      const res = await craftCard(card.playerId, card.teamSlug, card.year);
      setPackPoints(res.packPoints);
      setOwned((prev) => {
        const key = ownedKey(card);
        const idx = prev.findIndex((o) => ownedKey(o.card) === key);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { ...next[idx], copies: next[idx].copies + 1, untradeable: next[idx].untradeable + 1 };
          return next;
        }
        // First copy of a card the user didn't already own — router.refresh()
        // below hydrates it properly; this just keeps the sheet's own count
        // from looking wrong for the instant before that lands.
        return [...prev, { card, copies: 1, untradeable: 1 }];
      });
      setActionsCard(null);
      router.refresh();
    } catch (err) {
      setCraftError(err instanceof Error ? err.message : 'Could not craft that card — try again.');
    } finally {
      setCrafting(false);
    }
  }, [actionsCard, router]);

  // Shared by both entry points: the Card Actions Sheet (Collection -> tap a
  // card -> Evolve, implicit actionsCard) and the Evolutions board's own
  // picker (Collection -> Evolutions tab -> Start, explicit ref). Committing
  // locks one copy as untradeable server-side (utcg_evolution_start).
  const runStartEvolution = useCallback(
    async (evoKey: string, ref: SquadCardRef) => {
      setEvolving(true);
      setStartingEvoKey(evoKey);
      setEvolveError(null);
      try {
        await startEvolution(evoKey, ref.playerId, ref.teamSlug, ref.year);
        setActionsCard(null);
        router.refresh();
      } catch (err) {
        setEvolveError(err instanceof Error ? err.message : 'Could not start that evolution — try again.');
      } finally {
        setEvolving(false);
        setStartingEvoKey(null);
      }
    },
    [router],
  );

  const handleEvolveFromSheet = useCallback(
    (evoKey: string) => {
      if (!actionsCard) return;
      runStartEvolution(evoKey, actionsCard);
    },
    [actionsCard, runStartEvolution],
  );

  // ── Signed-out state ─────────────────────────────────────────────────────

  if (!snapshot.signedIn) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-16">
        <div className="max-w-md w-full text-center flex flex-col items-center gap-6">
          <p className="text-[11px] font-bold tracking-[0.2em] uppercase text-muted font-tight">
            UTCG
          </p>
          <h1 className="font-display italic text-4xl sm:text-5xl font-bold text-ink leading-[0.95] tracking-[-0.02em]">
            Collect. Build. <span className="text-accent">Go undefeated.</span>
          </h1>
          <p className="text-sm text-muted font-tight max-w-[320px]">
            Open packs of UFA player cards, build a squad around real chemistry, and simulate your season.
          </p>
          <button
            type="button"
            onClick={() => setAuthOpen(true)}
            className={[
              'inline-flex items-center justify-center px-8 py-3.5 rounded-full',
              'text-[12px] font-bold tracking-[0.16em] uppercase font-tight',
              'bg-accent text-accent-ink hover:opacity-90 transition-opacity duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
              'min-h-[52px] cursor-pointer',
            ].join(' ')}
          >
            Sign in to play
          </button>
        </div>
        <AuthModal
          open={authOpen}
          dismissible
          initialMode="signin"
          onDismiss={() => setAuthOpen(false)}
          headline="Sign in to collect cards"
        />
      </div>
    );
  }

  const showPackReveal = recentPulls !== null && openingPackKind !== null;
  // Draft's pick/gauntlet screens are full-screen takeovers (same idiom as
  // PackOpenAnimation), shown whenever a run exists and we're in the 'run'
  // draft phase — regardless of which tab is active, mirroring how a pack
  // reveal also overlays everything.
  const showDraftRun = playMode === 'draft' && draftPhase === 'run' && draftRun !== null;

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {/* Header: compact single row (wordmark + eyebrow, coin pill) + a
          desktop-only segmented tab row beneath it. The full marketing
          tagline only belongs on the signed-out hero above — once signed in,
          the user already knows what UTCG is, so this stays slim and lets
          tab content start higher on screen. */}
      <div className="border-b border-hairline px-4 py-3 sm:px-6 lg:px-10">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-baseline gap-2.5 min-w-0">
              <h1 className="font-display italic text-2xl font-bold text-ink leading-none tracking-[-0.02em]">
                UTCG
              </h1>
              <p className="text-[10px] font-bold tracking-[0.16em] uppercase text-muted font-tight truncate">
                The Layout
              </p>
            </div>
            <div
              className={[
                'flex-shrink-0 inline-flex items-center gap-1.5 rounded-full bg-ink/5 px-3.5 py-2 min-h-[36px]',
                'motion-safe:transition-transform motion-safe:duration-300',
                flashCoins ? 'motion-safe:scale-110' : 'motion-safe:scale-100',
              ].join(' ')}
            >
              <CoinGlyph size={15} className="text-accent" />
              <span className="font-display font-bold text-[15px] text-ink tabular leading-none">
                {coins.toLocaleString()}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Game options as the second nav — directly under the header, Strava-style
          underline tabs. Centered on desktop, scrollable row on mobile. Replaces
          the old floating bottom tab bar (UTCG's game options "move back to a
          second nav bar"). Hidden while a full-screen pack reveal / draft run is
          up. State-driven (UTCG's tabs are internal state, not routes). */}
      {!showPackReveal && !showDraftRun && (
        <SectionNav
          mode="state"
          ariaLabel="UTCG game sections"
          tabs={UTCG_TABS.map((t) => ({ id: t.id, label: t.label }))}
          activeId={tab}
          onChange={(id) => setTab(id as Tab)}
        />
      )}

      {/* Phase content. The GLOBAL flat bottom bar (58px, root layout) covers
          this pane on <lg, so the pane clears it; desktop has no bar. */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-10 py-4 sm:py-6 pb-[calc(env(safe-area-inset-bottom)+80px)] lg:pb-8">
          {tab === 'play' && (
            <>
              {/* First-time onboarding — a new user owns no cards yet, so they
                  can't build a Squad Battle squad. Prompt them to open their
                  first (free) pack right away instead of the mode picker —
                  Draft doesn't need this gate (its cards are server-dealt,
                  not from the collection), but a brand-new signed-in user
                  reaching UTCG for the first time should meet the free-pack
                  hook before either mode, matching the existing first-run flow. */}
              {owned.length === 0 && buildPhase === 'mode-select' ? (
                <FirstPackPrompt
                  freePackReadyInMs={freePackReadyInMs}
                  opening={opening === 'free'}
                  onOpenFreePack={() => handleOpenPack('free')}
                  onGoToPacks={goToPacks}
                  error={packError}
                />
              ) : (
                buildPhase === 'mode-select' && (
                  <>
                    {snapshot.progress && (
                      <ProgressHub
                        progress={snapshot.progress}
                        onClaimObjective={handleClaimObjective}
                        claimingKey={claimingObjectiveKey}
                        claimError={objectiveClaimError}
                        onOpenRewardPack={(id, kind) => handleOpenRewardPack(id, kind, 'play')}
                        openingRewardId={openingRewardId}
                      />
                    )}
                    {snapshot.extras && (
                      <TotwStrip
                        totw={snapshot.extras.totw}
                        flash={snapshot.extras.flash}
                        onClaimFlash={handleClaimFlash}
                        claimingFlashKey={claimingFlashKey}
                        claimError={flashClaimError}
                      />
                    )}
                    <PlayModeSelect
                      activeDraftRun={draftRun}
                      draftPaidRunsLeft={snapshot.wallet?.draftPaidRunsLeft ?? DRAFT_PAID_RUNS_PER_DAY}
                      marketAccess={snapshot.marketAccess}
                      weekly={snapshot.weekly}
                      onSelectSquad={handleSelectSquadBattle}
                      onSelectDraft={handleSelectDraft}
                      onSelectPvp={handleSelectPvp}
                      onSelectBrawl={handleSelectBrawl}
                      onSelectBoss={handleSelectBoss}
                      onSelectRivals={handleSelectRivals}
                    />
                    <PvpHistory matches={snapshot.pvpMatches} openSquad={snapshot.openPvpSquad} />
                    <RivalsBoard
                      rivals={snapshot.weekly?.rivals ?? null}
                      onClaim={handleClaimRivals}
                      claimingWeek={claimingRivalsWeek}
                      claimError={rivalsClaimError}
                      onWithdraw={handleCancelRivals}
                      withdrawing={rivalsCancelling}
                      withdrawError={rivalsError}
                    />
                  </>
                )
              )}
              {buildPhase === 'formation-select' && (playMode === 'squad' || playMode === 'pvp' || playMode === 'brawl' || playMode === 'boss' || playMode === 'rivals') && (
                <FormationSelect onSelect={handleSelectFormation} onBack={handleBackToModeSelect} />
              )}
              {buildPhase === 'formation-select' && playMode === 'draft' && (
                <>
                  {draftStartError && (
                    <p className="text-[12px] text-center text-muted font-tight rounded-card bg-surface shadow-card px-4 py-3 mb-4" role="alert">
                      {draftStartError}
                      {/insufficient/i.test(draftStartError) && (
                        <button
                          type="button"
                          onClick={goToPacks}
                          className="ml-2 font-bold text-accent underline underline-offset-2 cursor-pointer"
                        >
                          Open Packs
                        </button>
                      )}
                    </p>
                  )}
                  <FormationSelect onSelect={handleSelectDraftFormation} onBack={handleBackToModeSelect} />
                </>
              )}
              {buildPhase === 'squad-builder' && formationKey && (
                <SquadBuilder
                  formationKey={formationKey}
                  owned={owned}
                  assignment={assignment}
                  onAssignmentChange={setAssignment}
                  onChangeFormation={handleChangeFormation}
                  onPlayMatch={
                    playMode === 'pvp'
                      ? handlePlayPvp
                      : playMode === 'rivals'
                        ? handlePlayRivals
                        : playMode === 'brawl' || playMode === 'boss'
                          ? handlePlayWeekly
                          : handlePlayMatch
                  }
                  ctaLabel={
                    playMode === 'pvp'
                      ? `Stake ${PVP_STAKE} · Find Match`
                      : playMode === 'rivals'
                        ? 'Enter Rivals'
                        : playMode === 'brawl'
                          ? 'Submit to Brawl'
                          : playMode === 'boss'
                            ? 'Challenge Boss'
                            : undefined
                  }
                  onGoToPacks={goToPacks}
                  rule={
                    playMode === 'brawl' && snapshot.weekly
                      ? { legal: (cards) => brawlSquadLegal(snapshot.weekly!.brawl.rule, cards), label: snapshot.weekly.brawl.label }
                      : undefined
                  }
                  targetStrength={
                    playMode === 'brawl' && snapshot.weekly
                      ? snapshot.weekly.brawl.target
                      : playMode === 'boss' && snapshot.weekly?.boss
                        ? snapshot.weekly.boss.strength
                        : undefined
                  }
                />
              )}
              {buildPhase === 'result' && playMode === 'pvp' && (
                <PvpResult
                  outcome={pvpOutcome}
                  error={matchError}
                  onPlayAgain={handleBuildAgain}
                  onBackToPlay={handleBackToPlay}
                  onGoToPacks={goToPacks}
                  onCancel={handleCancelPvp}
                  cancelling={pvpCancelling}
                />
              )}
              {buildPhase === 'result' && playMode === 'rivals' && (
                <RivalsResult
                  outcome={rivalsOutcome}
                  error={rivalsError}
                  onPlayAgain={handleBuildAgain}
                  onBackToPlay={handleBackToPlay}
                  onCancel={handleCancelRivals}
                  cancelling={rivalsCancelling}
                />
              )}
              {buildPhase === 'result' && (playMode === 'brawl' || playMode === 'boss') && (
                <WeeklyResult
                  mode={playMode}
                  result={weeklyResult}
                  error={weeklyError}
                  onOpenRewardPack={(id) => handleOpenRewardPack(id, playMode === 'brawl' ? BRAWL_FIRST_WIN_PACK : BOSS_FIRST_WIN_PACK, 'play')}
                  openingReward={openingRewardId !== null}
                  onPlayAgain={handleBuildAgain}
                  onBackToPlay={handleBackToPlay}
                />
              )}
              {buildPhase === 'result' && playMode === 'squad' && matchResultData && (
                <MatchResult
                  result={matchResultData}
                  coinsAwarded={coinsAwarded}
                  rewardCapped={rewardCapped}
                  matchError={matchError}
                  matchesToday={lastMatchesToday}
                  onBuildAgain={handleBuildAgain}
                  onBackToPlay={handleBackToPlay}
                />
              )}
            </>
          )}

          {tab === 'packs' && (
            <PackStore
              coins={coins}
              freePackReadyInMs={freePackReadyInMs}
              onOpenPack={handleOpenPack}
              opening={opening}
              actionError={packError}
            />
          )}

          {tab === 'collection' && (
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap items-center gap-2">
                {COLLECTION_SUB_TABS.map((t) => (
                  <FilterPill
                    key={t.id}
                    active={collectionSubTab === t.id}
                    onClick={() => setCollectionSubTab(t.id)}
                    label={t.label}
                  />
                ))}
              </div>
              {collectionSubTab === 'cards' && <CollectionGrid owned={owned} onTapCard={handleTapCard} />}
              {collectionSubTab === 'sbcs' && snapshot.collection && (
                <SbcBoard
                  sbcs={snapshot.collection.sbcs}
                  owned={owned}
                  onSubmit={handleSubmitSbc}
                  submitting={sbcSubmitting}
                  submitError={sbcError}
                  submittingKey={sbcSubmittingKey}
                />
              )}
              {collectionSubTab === 'goals' && snapshot.collection && (
                <CollectionGoals
                  collection={snapshot.collection}
                  onClaimMilestone={handleClaimMilestone}
                  claimingMilestone={claimingMilestone}
                  claimError={milestoneClaimError}
                />
              )}
              {collectionSubTab === 'evolutions' && snapshot.evolutions && (
                <EvolutionsBoard
                  evolutions={snapshot.evolutions}
                  owned={owned}
                  onStart={(evoKey, playerId, teamSlug, year) => runStartEvolution(evoKey, { playerId, teamSlug, year })}
                  starting={evolving}
                  startingKey={startingEvoKey}
                  startError={evolveError}
                />
              )}
            </div>
          )}

          {tab === 'market' && (
            <Marketplace
              owned={owned}
              coins={coins}
              userId={snapshot.userId}
              marketAccess={snapshot.marketAccess}
              onCoinsChange={setCoins}
              onMutated={() => router.refresh()}
            />
          )}
        </div>
      </div>

      {actionsCard && (
        <CardActionsSheet
          card={actionsCard}
          copies={ownedByKey(ownedKey(actionsCard))?.copies ?? 0}
          untradeable={ownedByKey(ownedKey(actionsCard))?.untradeable ?? 0}
          packPoints={packPoints}
          onList={handleListFromSheet}
          onCraft={handleCraft}
          crafting={crafting}
          craftError={craftError}
          onClose={() => setActionsCard(null)}
          evolutions={snapshot.evolutions}
          onEvolve={handleEvolveFromSheet}
          evolving={evolving}
          evolveError={evolveError}
        />
      )}

      {listingCard && (
        <ListCardModal
          card={listingCard}
          marketAccess={snapshot.marketAccess}
          onClose={() => setListingCard(null)}
          onListed={() => {
            setListingCard(null);
            router.refresh();
          }}
        />
      )}

      {sbcGrantedCard && (
        <SbcCardGrantedModal
          grant={sbcGrantedCard}
          owned={owned}
          totw={snapshot.extras?.totw ?? []}
          onClose={() => setSbcGrantedCard(null)}
        />
      )}

      {showPackReveal && (
        <PackOpenAnimation
          pulls={recentPulls}
          packKind={openingPackKind}
          onSellDuplicates={handleSellDuplicates}
          selling={selling}
          sellError={sellError}
          onDone={handleDonePack}
        />
      )}

      {showDraftRun && draftRun && (
        draftRun.status === 'drafting' ? (
          <DraftPick
            run={draftRun}
            headshots={draftHeadshots}
            onPick={handleDraftPick}
            onCashOut={handleDraftCashOut}
            picking={draftPicking}
            error={draftPickError}
          />
        ) : (
          <DraftGauntlet
            run={draftRun}
            headshots={draftHeadshots}
            lastResult={draftRoundResult}
            onPlayRound={handlePlayDraftRound}
            onCashOut={handleDraftCashOut}
            onDone={handleDraftRunDone}
            playing={draftPlaying}
            error={draftGauntletError}
          />
        )
      )}
    </div>
  );
}

// SbcCardGrantedModal — shown after the TOTW Upgrade SBC (the one SBC that
// grants a card directly instead of a reward pack). `owned` has already been
// optimistically decremented for the handed-in cards but NOT hydrated with
// the new grant yet (that lands once router.refresh() resolves), so this
// falls back to the week's TOTW list (by key) for name/score/+3 in the gap
// between submit and refresh, then prefers the real hydrated OwnedCard (with
// a full CardTile) once it's there.
function SbcCardGrantedModal({
  grant,
  owned,
  totw,
  onClose,
}: {
  grant: SquadCardRef;
  owned: OwnedCard[];
  totw: WeekExtras['totw'];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const key = ownedKey(grant);
  const hydrated = owned.find((o) => ownedKey(o.card) === key) ?? null;
  const fallback = totw.find((t) => ownedKey(t) === key) ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/40 motion-safe:animate-fade-in" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="TOTW card granted"
        className="relative z-10 w-full sm:max-w-sm bg-bg rounded-t-card-lg sm:rounded-card-lg shadow-hero flex flex-col items-center gap-4 p-6"
      >
        <p className="text-[11px] font-bold tracking-[0.2em] uppercase text-accent font-tight">TOTW Upgrade</p>
        {hydrated ? (
          <div className="w-[140px]">
            <CardTile card={hydrated.card} copies={hydrated.copies} untradeable={hydrated.untradeable} />
          </div>
        ) : fallback ? (
          <div className="flex flex-col items-center gap-1 py-4">
            <p className="font-display italic text-2xl font-bold text-ink leading-none">{fallback.name}</p>
            <p className="text-[12px] text-muted font-tight tabular">
              {fallback.score.toFixed(0)} <span className="text-accent">+{fallback.boost}</span> · {fallback.teamAbbr} {fallback.year}
            </p>
          </div>
        ) : (
          <p className="text-[13px] text-muted font-tight text-center py-4">Card granted — reconciling your collection…</p>
        )}
        <p className="text-[12px] text-muted font-tight text-center">
          Untradeable — it plays, but can&rsquo;t be listed, offered, or quicksold.
        </p>
        <button
          type="button"
          onClick={onClose}
          className="px-5 min-h-[40px] rounded-full bg-ink text-bg text-[12px] font-bold tracking-[0.06em] uppercase font-tight cursor-pointer hover:opacity-90 motion-safe:transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Done
        </button>
      </div>
    </div>
  );
}

// First-run onboarding shown on the Play tab when the user owns no cards yet.
// Prompts them to open their free pack (a full 7-card squad) right away.
function FirstPackPrompt({
  freePackReadyInMs,
  opening,
  onOpenFreePack,
  onGoToPacks,
  error,
}: {
  freePackReadyInMs: number;
  opening: boolean;
  onOpenFreePack: () => void;
  onGoToPacks: () => void;
  error: string | null;
}) {
  const freeReady = freePackReadyInMs <= 0;
  return (
    <div className="flex flex-col items-center text-center gap-6 py-10 sm:py-16 max-w-md mx-auto">
      <span className="inline-flex items-center px-3 py-1 rounded-full bg-accent/10 text-accent text-[10px] font-bold uppercase tracking-[0.16em] font-tight">
        Welcome
      </span>
      <h2 className="font-display italic text-3xl sm:text-4xl font-bold text-ink leading-[0.95] tracking-[-0.02em]">
        Open your <span className="text-accent">first pack</span>
      </h2>
      <p className="text-sm text-muted font-tight max-w-[320px]">
        Every pack is a full 7-card squad. Rip your free one to get your starting
        lineup — then build for chemistry and play your first match.
      </p>

      {freeReady ? (
        <button
          type="button"
          onClick={onOpenFreePack}
          disabled={opening}
          className={[
            'inline-flex items-center justify-center gap-2 px-8 py-4 rounded-full',
            'text-[13px] font-bold tracking-[0.14em] uppercase font-tight',
            'bg-accent text-accent-ink hover:opacity-90 transition-opacity duration-150',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
            'min-h-[56px] min-w-[220px] cursor-pointer disabled:opacity-60 disabled:cursor-wait',
          ].join(' ')}
        >
          {opening ? (
            <>
              <svg className="animate-spin w-4 h-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="2.5" strokeOpacity="0.3" />
                <path d="M10 2a8 8 0 0 1 8 8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
              Opening…
            </>
          ) : (
            'Open Free Pack'
          )}
        </button>
      ) : (
        <button
          type="button"
          onClick={onGoToPacks}
          className={[
            'inline-flex items-center justify-center px-8 py-4 rounded-full',
            'text-[13px] font-bold tracking-[0.14em] uppercase font-tight',
            'bg-accent text-accent-ink hover:opacity-90 transition-opacity duration-150',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
            'min-h-[56px] min-w-[220px] cursor-pointer',
          ].join(' ')}
        >
          Browse Packs
        </button>
      )}

      {error && (
        <p className="text-[12px] text-live font-tight" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// Tab definitions — the four UTCG sections, rendered as the top SectionNav
// (Strava underline tabs). Text-only, so no per-tab icons anymore.
const UTCG_TABS: { id: Tab; label: string }[] = [
  { id: 'play', label: 'Play' },
  { id: 'packs', label: 'Packs' },
  { id: 'collection', label: 'Cards' },
  { id: 'market', label: 'Market' },
];

// Collection tab's own sub-tabs (Cards / SBCs / Goals / Evolutions) — only 4
// options, so the app's FilterPill row pattern (not PillSelect) still fits,
// matching CollectionGrid's own position-filter pills.
const COLLECTION_SUB_TABS: { id: CollectionSubTab; label: string }[] = [
  { id: 'cards', label: 'Cards' },
  { id: 'sbcs', label: 'SBCs' },
  { id: 'goals', label: 'Goals' },
  { id: 'evolutions', label: 'Evolutions' },
];
