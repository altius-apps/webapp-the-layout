'use client';

// AuctionRoom — draft.status === 'live', draft.draftType === 'auction'.
// Phase derives from whether an open nomination exists: BIDDING (someone's
// player is up) vs NOMINATING (waiting for the next team to put one up).
// Ported from mobile AuctionRoom.tsx by intent; restyled after Sleeper's
// auction (Hunter, 2026-10-10): the nominated player is the main character of
// a stage with the live bid, a ladder of who bid what, and the bid stepper;
// below it the shared DraftBoard, whose team headers double as the budget
// strip (max bid, money left, live-bid badge, high bidder lit). Renders inside
// DraftRoom's navy .draft-theme arena.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  auctionTeamState,
  getNominationBids,
  nominatePlayer,
  placeBid,
  teamToNominate,
  saveDraftQueue,
  type AuctionTeamState,
  type Draft,
  type DraftBid,
  type DraftPick,
  type DraftRef,
  type DraftNomination,
  type DraftPrice,
} from '@/lib/fantasy/draft-room';
import { searchContestPlayers } from '@/lib/fantasy/draft';
import type { ContestView } from '@/lib/fantasy/leagues';
import type { FantasyPlayerHit } from '@/lib/fantasy/data';
import {
  projectedEventPoints,
  ratingKey,
  toRatingMap,
  type PlayerRating,
  type RatingMap,
} from '@/lib/fantasy/ratings';
import {
  RANKED_PAGE_SIZE,
  RankingsHeader,
  RatingLine,
  RatingRowLine,
  ShowMoreButton,
  ratingToHit,
} from '@/components/fantasy/player-rating';
import { AutoBadge } from './autodraft';
import { DraftBoard, TeamAvatar, formatClock, toneForRank, type BoardColumn, type BoardCell } from './draft-board';
import { NominateSheet } from './nominate-sheet';
import { RoomTabs } from './room-tabs';

interface TeamInfo {
  id: string;
  teamName: string;
}

type RoomTab = 'players' | 'queue' | 'results';
const ROOM_TABS: readonly { id: RoomTab; label: string }[] = [
  { id: 'players', label: 'Players' },
  { id: 'queue', label: 'Queue' },
  { id: 'results', label: 'Results' },
];

const SOLD_MS = 4000; // how long the SOLD stamp stays on the stage

function priceFor(prices: DraftPrice[], league: string, playerId: string): number | null {
  const hit = prices.find((p) => p.playerLeague === league && p.playerId === playerId);
  return hit ? hit.price : null;
}

export function AuctionRoom({
  contest,
  draft,
  picks,
  teamById,
  myTeam,
  queue,
  setQueue,
  ratings,
  openNomination,
  nominations,
  prices,
  bidRemainingMs,
  nominationRemainingMs,
  autodraftTeamIds,
  controls,
  onRequireAuth,
  refetch,
}: {
  contest: ContestView;
  draft: Draft;
  picks: DraftPick[];
  teamById: Map<string, TeamInfo>;
  myTeam: TeamInfo | null;
  queue: DraftRef[];
  setQueue: (q: DraftRef[]) => void;
  ratings: PlayerRating[];
  openNomination: DraftNomination | null;
  nominations: DraftNomination[];
  prices: DraftPrice[];
  bidRemainingMs: number | null;
  nominationRemainingMs: number | null;
  /** Teams on autodraft — they nominate the moment they're up. */
  autodraftTeamIds: Set<string>;
  /** Autodraft toggle + commissioner controls, shown under the board. */
  controls: React.ReactNode;
  onRequireAuth: () => void;
  refetch: () => void;
}) {
  const [tab, setTab] = useState<RoomTab>('players');
  const [actionError, setActionError] = useState<string | null>(null);
  const [nominateSheet, setNominateSheet] = useState<FantasyPlayerHit | null>(null);
  const panelsRef = useRef<HTMLDivElement | null>(null);

  const myState = myTeam ? auctionTeamState(draft, picks, myTeam.id) : null;
  const nominatingTeamId = teamToNominate(draft);
  const isMyNominateTurn = Boolean(myTeam) && nominatingTeamId === myTeam?.id && !openNomination;

  const ratingMap = useMemo(() => toRatingMap(ratings), [ratings]);
  const draftedByKey = useMemo(
    () => new Map(picks.map((p) => [`${p.playerLeague}:${p.playerId}`, p.teamId])),
    [picks],
  );

  const bids = useNominationBids(openNomination);
  // Bids come oldest first, so each team ends on its latest amount.
  const liveBidByTeam = useMemo(() => new Map(bids.map((b) => [b.teamId, b.amount])), [bids]);
  const sold = useSoldMoment(openNomination, nominations);

  const handleQueue = (ref: DraftRef) => {
    if (queue.some((q) => q.playerId === ref.playerId && q.playerLeague === ref.playerLeague)) return;
    const next = [...queue, ref];
    setQueue(next);
    saveDraftQueue(draft.id, next).catch(() => {});
  };

  const openNominateSheet = (hit: FantasyPlayerHit) => {
    if (!myTeam) {
      onRequireAuth();
      return;
    }
    setActionError(null);
    setNominateSheet(hit);
  };

  const handleNominate = async (opening: number) => {
    if (!nominateSheet) return;
    setActionError(null);
    try {
      await nominatePlayer(
        draft.id,
        { playerLeague: contest.competitionDef.playerLeague, playerId: nominateSheet.playerId, playerName: nominateSheet.fullName },
        opening,
      );
      setNominateSheet(null);
      refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not nominate that player.');
    }
  };

  const handleBid = async (amount: number) => {
    setActionError(null);
    try {
      await placeBid(draft.id, amount);
      refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not place that bid.');
    }
  };

  const showPlayers = () => {
    setTab('players');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    panelsRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  };

  const wonResults = nominations.filter((n) => n.status === 'won').sort((a, b) => b.overall - a.overall);

  const playersPanel = (
    <AuctionPlayersPanel
      contest={contest}
      draftedByKey={draftedByKey}
      teamById={teamById}
      ratings={ratings}
      queue={queue}
      onQueue={handleQueue}
      canNominate={isMyNominateTurn}
      onNominate={openNominateSheet}
      actionError={!nominateSheet && !openNomination ? actionError : null}
    />
  );
  const queuePanel = (
    <AuctionQueuePanel
      draftId={draft.id}
      myTeam={myTeam}
      queue={queue}
      setQueue={setQueue}
      ratings={ratings}
      onRequireAuth={onRequireAuth}
    />
  );
  const resultsPanel = <ResultsPanel wonResults={wonResults} teamById={teamById} />;

  return (
    <div className="space-y-4 lg:space-y-6">
      {/* Always mounted so the text change is announced; the stamp is the sighted copy. */}
      <p className="sr-only" aria-live="polite">
        {sold && `Sold: ${sold.playerName} to ${teamById.get(sold.highTeamId)?.teamName ?? 'Team'} for $${sold.highBid}`}
      </p>

      <AuctionStage
        draft={draft}
        nomination={openNomination}
        sold={sold}
        lastSold={wonResults[0] ?? null}
        teamById={teamById}
        ratingMap={ratingMap}
        bids={bids}
        myTeam={myTeam}
        myState={myState}
        nominatingTeamId={nominatingTeamId}
        isMyNominateTurn={isMyNominateTurn}
        nominatingAuto={Boolean(nominatingTeamId && autodraftTeamIds.has(nominatingTeamId))}
        bidRemainingMs={bidRemainingMs}
        nominationRemainingMs={nominationRemainingMs}
        onBid={handleBid}
        onRequireAuth={onRequireAuth}
        onPickPlayer={showPlayers}
        error={openNomination ? actionError : null}
      />

      <AuctionBoard
        draft={draft}
        picks={picks}
        teamById={teamById}
        ratingMap={ratingMap}
        myTeamId={myTeam?.id ?? null}
        liveBidByTeam={liveBidByTeam}
        highTeamId={openNomination?.highTeamId ?? null}
        autodraftTeamIds={autodraftTeamIds}
        sold={sold}
      />

      {controls}

      <div ref={panelsRef} className="scroll-mt-4">
        {/* Mobile: tabs under the board. */}
        <div className="lg:hidden">
          <RoomTabs tabs={ROOM_TABS} active={tab} onChange={setTab} ariaLabel="Auction room sections" />
          {tab === 'players' && playersPanel}
          {tab === 'queue' && queuePanel}
          {tab === 'results' && resultsPanel}
        </div>

        {/* Desktop: players under the board (2/3), queue + results rail beside them. */}
        <div className="hidden lg:grid grid-cols-3 gap-6">
          <div className="col-span-2 min-w-0">{playersPanel}</div>
          <div className="min-w-0">
            <DesktopRail queuePanel={queuePanel} resultsPanel={resultsPanel} />
          </div>
        </div>
      </div>

      {nominateSheet && (
        <NominateSheet
          hit={nominateSheet}
          minBid={draft.minBid}
          maxBid={myState?.maxBid ?? draft.minBid}
          openingPrice={priceFor(prices, contest.competitionDef.playerLeague, nominateSheet.playerId)}
          onCancel={() => setNominateSheet(null)}
          onConfirm={handleNominate}
        />
      )}
    </div>
  );
}

function DesktopRail({ queuePanel, resultsPanel }: { queuePanel: React.ReactNode; resultsPanel: React.ReactNode }) {
  const [railTab, setRailTab] = useState<'queue' | 'results'>('queue');
  return (
    <div>
      <div className="flex gap-1 mb-4 bg-ink/[0.06] rounded-full p-1">
        {(['queue', 'results'] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setRailTab(id)}
            aria-pressed={railTab === id}
            className={[
              'flex-1 px-3 py-2 min-h-[40px] rounded-full font-tight text-[11px] font-bold tracking-[0.08em] uppercase transition-colors duration-150 cursor-pointer',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              railTab === id ? 'bg-surface-hi text-ink shadow-soft' : 'text-muted hover:text-ink',
            ].join(' ')}
          >
            {id}
          </button>
        ))}
      </div>
      {railTab === 'queue' ? queuePanel : resultsPanel}
    </div>
  );
}

// ─── Live data: bid ladder + SOLD moment ────────────────────────────────────

/** The open nomination's bids, oldest first (the opening bid is row 0). Keyed
 *  on the high bid + deadline, which every bid bumps, not on the object (each
 *  refetch and the 20s poll hand over a new one). */
function useNominationBids(nomination: DraftNomination | null): DraftBid[] {
  const [bids, setBids] = useState<DraftBid[]>([]);
  const nominationId = nomination?.id ?? null;
  const key = nomination ? `${nomination.id}:${nomination.highBid}:${nomination.endsAt}` : null;

  useEffect(() => {
    if (!nominationId) return;
    let cancelled = false;
    getNominationBids(nominationId)
      .then((b) => {
        if (!cancelled) setBids(b);
      })
      // Signed-out viewers can't read bids (authenticated RPC), and a failed
      // re-read keeps the ladder already on screen.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key, nominationId]);

  // Never show the last player's ladder under the next one.
  return useMemo(() => bids.filter((b) => b.nominationId === nominationId), [bids, nominationId]);
}

/** The nomination that just closed, for SOLD_MS after it's seen as won. Silent
 *  on first render; also fires when the next player is up before this client
 *  ever saw the gap (autodraft nominates instantly). */
function useSoldMoment(open: DraftNomination | null, nominations: DraftNomination[]): DraftNomination | null {
  const [sold, setSold] = useState<DraftNomination | null>(null);
  const lastOpenId = useRef<string | null>(null);

  useEffect(() => {
    const prevId = lastOpenId.current;
    if (prevId && prevId !== open?.id) {
      const won = nominations.find((n) => n.id === prevId && n.status === 'won');
      if (won) setSold(won);
      // Closed, but the won row isn't in yet: keep watching for it.
      else if (!open) return;
    }
    lastOpenId.current = open?.id ?? null;
  }, [open, nominations]);

  // Its own effect so refetches can't cancel the timer and leave the stamp up.
  useEffect(() => {
    if (!sold) return;
    const t = setTimeout(() => setSold(null), SOLD_MS);
    return () => clearTimeout(t);
  }, [sold]);

  return sold;
}

// ─── Stage (the player on the block) ────────────────────────────────────────

const EYEBROW = 'font-tight text-[10.5px] font-bold tracking-[0.16em] uppercase';

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return { first: '', last: parts[0] ?? '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function AuctionStage({
  draft,
  nomination,
  sold,
  lastSold,
  teamById,
  ratingMap,
  bids,
  myTeam,
  myState,
  nominatingTeamId,
  isMyNominateTurn,
  nominatingAuto,
  bidRemainingMs,
  nominationRemainingMs,
  onBid,
  onRequireAuth,
  onPickPlayer,
  error,
}: {
  draft: Draft;
  nomination: DraftNomination | null;
  sold: DraftNomination | null;
  lastSold: DraftNomination | null;
  teamById: Map<string, TeamInfo>;
  ratingMap: RatingMap;
  bids: DraftBid[];
  myTeam: TeamInfo | null;
  myState: AuctionTeamState | null;
  nominatingTeamId: string | null;
  isMyNominateTurn: boolean;
  nominatingAuto: boolean;
  bidRemainingMs: number | null;
  nominationRemainingMs: number | null;
  onBid: (amount: number) => Promise<void>;
  onRequireAuth: () => void;
  onPickPlayer: () => void;
  error: string | null;
}) {
  const teamName = (id: string | null) => (id && teamById.get(id)?.teamName) || 'Team';

  // The full stamp would hide my own nominate button and clock: when I'm up,
  // the sale shows as the compact strip on the nominating stage instead.
  if (!nomination && sold && !isMyNominateTurn) {
    return (
      <section aria-label="Sold" className="relative overflow-hidden rounded-card-lg bg-surface shadow-hero px-5 py-7 lg:px-8 lg:py-10">
        <div className="flex flex-col items-center text-center gap-2">
          <span className="font-display italic font-bold text-[56px] lg:text-[84px] leading-[0.9] tracking-[-0.03em] text-accent motion-safe:animate-slam">
            Sold
          </span>
          <span className="font-tight text-[18px] lg:text-[22px] font-extrabold text-ink">{sold.playerName}</span>
          <span className="inline-flex items-center gap-2.5 font-tight text-[14px] text-muted">
            <span className="font-display italic font-bold text-[26px] leading-none text-ink tabular">${sold.highBid}</span>
            <TeamAvatar id={sold.highTeamId} name={teamName(sold.highTeamId)} size="sm" />
            <span className="font-semibold text-ink truncate">{teamName(sold.highTeamId)}</span>
          </span>
        </div>
      </section>
    );
  }

  if (!nomination) {
    const name = teamName(nominatingTeamId);
    return (
      <section
        aria-label="Nominating"
        className={[
          'relative overflow-hidden rounded-card-lg bg-surface shadow-hero px-5 py-5 lg:px-8 lg:py-7',
          isMyNominateTurn ? 'ring-2 ring-accent' : '',
        ].join(' ')}
      >
        {sold && <SoldStrip sold={sold} teamName={teamName(sold.highTeamId)} />}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <span className={[EYEBROW, isMyNominateTurn ? 'text-accent' : 'text-muted'].join(' ')}>
              {isMyNominateTurn ? 'Your nomination' : 'Up to nominate'}
            </span>
            <div className="flex items-center gap-3 mt-3 min-w-0">
              <TeamAvatar id={nominatingTeamId ?? ''} name={name} size="lg" />
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-display italic font-bold text-[26px] lg:text-[34px] leading-[0.95] tracking-[-0.02em] text-ink truncate">
                    {isMyNominateTurn ? 'You' : name}
                  </span>
                  {nominatingAuto && <AutoBadge />}
                </div>
                <p className="font-tight text-[13px] text-muted mt-1">
                  {isMyNominateTurn ? 'Put a player on the block.' : 'is choosing who goes on the block.'}
                </p>
              </div>
            </div>
          </div>
          <CountdownRing remainingMs={nominationRemainingMs} totalSeconds={draft.nominationSeconds} />
        </div>

        {isMyNominateTurn && (
          <button
            type="button"
            onClick={onPickPlayer}
            className={[
              'mt-5 w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 min-h-[48px] rounded-full',
              'bg-accent text-accent-ink font-tight text-[13px] font-extrabold tracking-[0.08em] uppercase',
              'hover:opacity-90 transition-opacity duration-150 cursor-pointer',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
            ].join(' ')}
          >
            Pick a player
          </button>
        )}

        {lastSold && (
          <p className="mt-5 pt-4 border-t border-hairline font-tight text-[12.5px] text-muted truncate">
            <span className={[EYEBROW, 'text-faint mr-2'].join(' ')}>Last sold</span>
            <span className="font-semibold text-ink">{lastSold.playerName}</span>
            {' · '}
            <span className="font-bold text-ink tabular">${lastSold.highBid}</span>
            {' · '}
            {teamName(lastSold.highTeamId)}
          </p>
        )}
      </section>
    );
  }

  const { first, last } = splitName(nomination.playerName);
  const rating = ratingMap.get(ratingKey(nomination.playerLeague, nomination.playerId));
  const proj = rating ? projectedEventPoints(rating) : null;
  const highName = teamName(nomination.highTeamId);
  const iAmHigh = Boolean(myTeam) && nomination.highTeamId === myTeam?.id;
  const meta = [
    rating ? `#${rating.rank}` : null,
    proj != null ? `Proj ${proj}` : null,
    rating?.teamName ?? null,
  ].filter(Boolean);

  return (
    <section
      aria-label={`Bidding on ${nomination.playerName}`}
      className={[
        'relative overflow-hidden rounded-card-lg bg-surface shadow-hero px-4 pt-4 pb-5 lg:px-8 lg:pt-7 lg:pb-8',
        iAmHigh ? 'ring-2 ring-accent' : '',
      ].join(' ')}
    >
      {sold && <SoldStrip sold={sold} teamName={teamName(sold.highTeamId)} />}

      {/* Phones stack in DOM order. Desktop: player + controls on the left, the
          bid in the middle, clock + ladder on the right. */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto_280px] lg:gap-x-12">
        <div className="min-w-0 flex items-start justify-between gap-4 lg:col-start-1 lg:row-start-1">
          <div className="min-w-0">
            <span className={[EYEBROW, 'text-accent'].join(' ')}>On the block</span>
            <span className="font-tight text-[11.5px] text-muted ml-2">
              nominated by {teamName(nomination.teamId)}
            </span>
            <div className="mt-2 font-tight text-[15px] lg:text-[18px] font-semibold text-muted leading-tight truncate">
              {first}
            </div>
            <h2 className="m-0 font-display italic font-bold text-[40px] lg:text-[64px] leading-[0.9] tracking-[-0.03em] text-ink truncate">
              {last}
            </h2>
            {meta.length > 0 && (
              <div className="mt-2 font-tight text-[12px] lg:text-[13px] text-muted truncate tabular">{meta.join(' · ')}</div>
            )}
          </div>
          <div className="lg:hidden">
            <CountdownRing remainingMs={bidRemainingMs} totalSeconds={draft.bidSeconds} />
          </div>
        </div>

        <div className="mt-5 min-w-0 lg:mt-0 lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:self-center lg:flex lg:flex-col lg:items-center lg:text-center">
          <span className={[EYEBROW, 'text-muted'].join(' ')}>Current bid</span>
          <div
            key={nomination.highBid}
            className="font-display italic font-bold text-[64px] lg:text-[88px] leading-[0.85] tracking-[-0.04em] text-ink tabular motion-safe:animate-pulse-once"
          >
            ${nomination.highBid}
          </div>
          <div className="flex items-center gap-2 mt-2 min-w-0 lg:justify-center">
            <TeamAvatar id={nomination.highTeamId} name={highName} size="sm" />
            <span className="font-tight text-[14px] font-bold text-ink truncate">{highName}</span>
            {iAmHigh && (
              <span className="flex-shrink-0 inline-flex items-center h-6 px-2.5 rounded-full bg-accent text-accent-ink font-tight text-[10px] font-extrabold tracking-[0.14em] uppercase">
                You&apos;re winning
              </span>
            )}
          </div>
        </div>

        {/* Phones: the ladder as a strip under the bid (Sleeper style). */}
        {bids.length > 0 && (
          <ol aria-label="Bids" className="lg:hidden mt-4 -mx-4 px-4 flex gap-1.5 overflow-x-auto no-scrollbar">
            {[...bids].reverse().map((b, i) => (
              <li
                key={`${b.teamId}:${b.amount}`}
                className={[
                  'flex-shrink-0 inline-flex items-center gap-1.5 h-8 pl-1 pr-3 rounded-full font-tight text-[12px]',
                  i === 0 ? 'bg-accent/15 ring-1 ring-inset ring-accent/60 motion-safe:animate-fade-up' : 'bg-ink/[0.07]',
                ].join(' ')}
              >
                <TeamAvatar id={b.teamId} name={teamName(b.teamId)} size="sm" />
                <span className="font-extrabold text-ink tabular">${b.amount}</span>
                <span className="text-muted max-w-[96px] truncate">{teamName(b.teamId)}</span>
              </li>
            ))}
          </ol>
        )}

        <div className="mt-5 lg:mt-8 min-w-0 lg:col-start-1 lg:row-start-2">
          <BidControls
            key={nomination.id}
            nomination={nomination}
            myTeam={myTeam}
            myState={myState}
            iAmHigh={iAmHigh}
            onBid={onBid}
            onRequireAuth={onRequireAuth}
          />
          {error && (
            <p role="alert" className="font-tight text-[12px] text-live mt-2.5">
              {error}
            </p>
          )}
        </div>

        {/* Desktop: clock + the ladder as a column beside the player. */}
        <div className="hidden lg:flex lg:flex-col lg:gap-5 min-w-0 lg:col-start-3 lg:row-start-1 lg:row-span-2">
          <div className="flex justify-end">
            <CountdownRing remainingMs={bidRemainingMs} totalSeconds={draft.bidSeconds} large />
          </div>
          {bids.length > 0 && (
            <div className="min-w-0">
              <span className={[EYEBROW, 'text-muted'].join(' ')}>Bids</span>
              <ol aria-label="Bids" className="mt-2 max-h-[264px] overflow-y-auto space-y-1">
                {[...bids].reverse().map((b, i, all) => (
                  <li
                    key={`${b.teamId}:${b.amount}`}
                    className={[
                      'flex items-center gap-2.5 px-2.5 h-10 rounded-card-sm',
                      i === 0 ? 'bg-accent/15 ring-1 ring-inset ring-accent/60 motion-safe:animate-fade-up' : 'bg-ink/[0.05]',
                    ].join(' ')}
                  >
                    <TeamAvatar id={b.teamId} name={teamName(b.teamId)} size="sm" />
                    <span className="min-w-0 flex-1 font-tight text-[13px] font-semibold text-ink truncate">
                      {teamName(b.teamId)}
                    </span>
                    {i === 0 ? (
                      <span className="font-tight text-[9.5px] font-extrabold tracking-[0.14em] uppercase text-accent">Leading</span>
                    ) : i === all.length - 1 ? (
                      <span className="font-tight text-[9.5px] font-bold tracking-[0.14em] uppercase text-faint">Opening</span>
                    ) : null}
                    <span className="font-tight text-[14px] font-extrabold text-ink tabular">${b.amount}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** The sale that just closed, as a one-line strip when the stage is busy. */
function SoldStrip({ sold, teamName }: { sold: DraftNomination; teamName: string }) {
  return (
    <p className="mb-4 rounded-full bg-accent/15 px-3.5 py-1.5 font-tight text-[12px] text-ink truncate motion-safe:animate-fade-up">
      <span className={[EYEBROW, 'text-accent mr-2'].join(' ')}>Sold</span>
      {sold.playerName} · <span className="font-bold tabular">${sold.highBid}</span> · {teamName}
    </p>
  );
}

/** Sleeper-style stepper: − $X + with +5/+10 bumps and a big BID button. The
 *  amount is typeable; it never sits below the current high bid + 1. */
function BidControls({
  nomination,
  myTeam,
  myState,
  iAmHigh,
  onBid,
  onRequireAuth,
}: {
  nomination: DraftNomination;
  myTeam: TeamInfo | null;
  myState: AuctionTeamState | null;
  iAmHigh: boolean;
  onBid: (amount: number) => Promise<void>;
  onRequireAuth: () => void;
}) {
  const floor = nomination.highBid + 1;
  const [amount, setAmount] = useState(floor);
  // What's typed, while typing; clamped on blur and on submit.
  const [typed, setTyped] = useState<string | null>(null);
  const [bidding, setBidding] = useState(false);

  if (!myTeam) {
    return (
      <button
        type="button"
        onClick={onRequireAuth}
        className={[
          'w-full sm:w-auto inline-flex items-center justify-center px-6 min-h-[48px] rounded-full',
          'bg-ink/[0.08] text-ink font-tight text-[12.5px] font-bold tracking-[0.08em] uppercase',
          'hover:bg-ink/[0.14] transition-colors duration-150 cursor-pointer',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        ].join(' ')}
      >
        Sign in to bid
      </button>
    );
  }

  if (iAmHigh) {
    return (
      <p className="inline-flex items-center gap-2 font-tight text-[13.5px] font-semibold text-ink">
        <CheckIcon />
        You&apos;re the high bidder. Hold tight.
      </p>
    );
  }

  const max = myState?.maxBid ?? 0;
  if (!myState || myState.openSlots < 1 || max < floor) {
    return (
      <p className="font-tight text-[13px] text-muted">
        {myState && myState.openSlots < 1 ? 'Your roster is full.' : `Your max bid is $${Math.max(max, 0)}, so you can't top this one.`}
      </p>
    );
  }

  const clamp = (v: number) => Math.min(Math.max(v, floor), max);
  const value = typed !== null ? clamp(Number(typed) || floor) : clamp(amount);
  const set = (v: number) => {
    setTyped(null);
    setAmount(clamp(v));
  };
  const submit = async () => {
    set(value);
    setBidding(true);
    try {
      await onBid(value);
    } finally {
      setBidding(false);
    }
  };

  const STEP_BUTTON = [
    'flex-shrink-0 flex items-center justify-center w-11 h-11 rounded-full transition-colors duration-150',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
    'disabled:opacity-35 disabled:cursor-not-allowed',
  ].join(' ');

  return (
    <div>
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <div className="flex items-center gap-1.5 rounded-full bg-ink/[0.06] p-1">
          <button
            type="button"
            onClick={() => set(value - 1)}
            disabled={value <= floor || bidding}
            aria-label="Lower bid by $1"
            className={[STEP_BUTTON, 'text-ink bg-ink/[0.08] hover:bg-ink/[0.14] cursor-pointer'].join(' ')}
          >
            <MinusIcon />
          </button>
          <label className="flex-1 sm:flex-none flex items-center justify-center font-display italic font-bold text-[28px] leading-none text-ink tabular">
            <span aria-hidden="true">$</span>
            <span className="sr-only">Bid amount</span>
            <input
              type="text"
              inputMode="numeric"
              value={typed ?? String(value)}
              onChange={(e) => setTyped(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
              onBlur={() => typed !== null && set(Number(typed) || floor)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              className="w-[3.2ch] bg-transparent text-center font-display italic font-bold text-[28px] text-ink tabular focus:outline-none"
            />
          </label>
          <button
            type="button"
            onClick={() => set(value + 1)}
            disabled={value >= max || bidding}
            aria-label="Raise bid by $1"
            className={[STEP_BUTTON, 'text-accent-ink bg-accent hover:opacity-90 cursor-pointer'].join(' ')}
          >
            <PlusIcon />
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          {[5, 10].map((inc) => (
            <button
              key={inc}
              type="button"
              onClick={() => set(value + inc)}
              disabled={value >= max || bidding}
              className={[
                'flex-1 sm:flex-none min-h-[44px] px-4 rounded-full font-tight text-[12.5px] font-bold tabular',
                'bg-ink/[0.07] text-ink hover:bg-ink/[0.13] transition-colors duration-150 cursor-pointer',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                'disabled:opacity-35 disabled:cursor-not-allowed',
              ].join(' ')}
            >
              +${inc}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={submit}
          disabled={bidding}
          className={[
            'sm:ml-auto min-h-[52px] px-7 rounded-full font-tight text-[14px] font-extrabold tracking-[0.08em] uppercase tabular',
            'bg-accent text-accent-ink hover:opacity-90 transition-opacity duration-150 cursor-pointer',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
            'disabled:opacity-60 disabled:cursor-wait',
          ].join(' ')}
        >
          {bidding ? 'Bidding…' : `Bid $${value}`}
        </button>
      </div>
      <p className="mt-2.5 font-tight text-[10.5px] font-bold tracking-[0.12em] uppercase text-muted tabular">
        Max <span className="text-ink">${max}</span> · ${myState.remaining} left · {myState.openSlots}{' '}
        {myState.openSlots === 1 ? 'spot' : 'spots'}
      </p>
    </div>
  );
}

/** Clock ring that drains with the time left. The SVG's dash offset is an
 *  attribute, so no inline style. ≤10s pulses: live and accent are both coral
 *  in the draft arena, so urgency can't be a color change. */
function CountdownRing({
  remainingMs,
  totalSeconds,
  large = false,
}: {
  remainingMs: number | null;
  totalSeconds: number;
  large?: boolean;
}) {
  const sec = remainingMs === null ? totalSeconds : Math.max(0, Math.ceil(remainingMs / 1000));
  const frac = remainingMs === null ? 1 : Math.max(0, Math.min(1, remainingMs / (totalSeconds * 1000)));
  const r = 26;
  const c = 2 * Math.PI * r;
  const low = sec <= 10;
  return (
    <div
      role="timer"
      aria-label={`${sec} seconds remaining`}
      className={['relative flex-shrink-0', large ? 'w-24 h-24' : 'w-16 h-16'].join(' ')}
    >
      <svg viewBox="0 0 60 60" className="w-full h-full -rotate-90" aria-hidden="true">
        <circle cx="30" cy="30" r={r} fill="none" strokeWidth="4" className="stroke-ink/10" />
        <circle
          cx="30"
          cy="30"
          r={r}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          className="stroke-accent motion-safe:transition-[stroke-dashoffset] motion-safe:duration-300 motion-safe:ease-linear"
        />
      </svg>
      <span
        className={[
          'absolute inset-0 flex items-center justify-center font-tight font-extrabold tabular text-ink',
          large ? 'text-[22px]' : 'text-[15px]',
          low ? 'motion-safe:animate-cue-pulse' : '',
        ].join(' ')}
      >
        {formatClock(sec)}
      </span>
    </div>
  );
}

// ─── Auction board (team columns × roster spots) ────────────────────────────

function AuctionBoard({
  draft,
  picks,
  teamById,
  ratingMap,
  myTeamId,
  liveBidByTeam,
  highTeamId,
  autodraftTeamIds,
  sold,
}: {
  draft: Draft;
  picks: DraftPick[];
  teamById: Map<string, TeamInfo>;
  ratingMap: RatingMap;
  myTeamId: string | null;
  liveBidByTeam: Map<string, number>;
  highTeamId: string | null;
  autodraftTeamIds: Set<string>;
  sold: DraftNomination | null;
}) {
  const columns: BoardColumn[] = draft.draftOrder.map((id) => {
    const st = auctionTeamState(draft, picks, id);
    const bid = liveBidByTeam.get(id);
    return {
      id,
      name: teamById.get(id)?.teamName ?? 'Team',
      detail: (
        <span className="flex items-center justify-between gap-1">
          <span className="font-bold text-ink">{st.openSlots > 0 ? `Max $${st.maxBid}` : 'Full'}</span>
          <span>${st.remaining}</span>
        </span>
      ),
      badge: bid != null ? `$${bid}` : null,
      lit: id === highTeamId,
      auto: autodraftTeamIds.has(id),
    };
  });

  // Each team's wins fill its column top-down in the order they were won.
  const byTeam = new Map<string, DraftPick[]>();
  for (const p of [...picks].sort((a, b) => a.overall - b.overall)) {
    const list = byTeam.get(p.teamId) ?? [];
    list.push(p);
    byTeam.set(p.teamId, list);
  }
  const freshKey = sold ? `${sold.playerLeague}:${sold.playerId}` : null;

  const cellAt = (row: number, col: number): BoardCell => {
    const p = byTeam.get(draft.draftOrder[col])?.[row];
    if (!p) return { kind: 'empty', corner: String(row + 1) };
    const key = ratingKey(p.playerLeague, p.playerId);
    const r = ratingMap.get(key);
    return {
      kind: 'pick',
      playerName: p.playerName,
      meta: r?.teamName ?? null,
      corner: `$${p.price ?? 0}`,
      tone: toneForRank(r?.rank),
      auto: p.auto,
      fresh: key === freshKey,
    };
  };

  return (
    <DraftBoard
      columns={columns}
      rows={draft.rounds}
      cellAt={cellAt}
      myColumnId={myTeamId}
      legend={picks.some((p) => ratingMap.has(ratingKey(p.playerLeague, p.playerId)))}
      ariaLabel="Auction board"
    />
  );
}

function MinusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="text-accent">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.2 8.2l1.9 1.9 3.7-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Players panel (nominate variant) ──────────────────────────────────────

function AuctionPlayersPanel({
  contest,
  draftedByKey,
  teamById,
  ratings,
  queue,
  onQueue,
  canNominate,
  onNominate,
  actionError,
}: {
  contest: ContestView;
  draftedByKey: Map<string, string>;
  teamById: Map<string, TeamInfo>;
  ratings: PlayerRating[];
  queue: DraftRef[];
  onQueue: (ref: DraftRef) => void;
  canNominate: boolean;
  onNominate: (hit: FantasyPlayerHit) => void;
  actionError: string | null;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FantasyPlayerHit[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const league = contest.competitionDef.playerLeague;

  const ratingMap = useMemo(() => toRatingMap(ratings), [ratings]);
  const available = useMemo(
    () => ratings.filter((r) => !draftedByKey.has(ratingKey(r.playerLeague, r.playerId))),
    [ratings, draftedByKey],
  );
  const [shown, setShown] = useState(RANKED_PAGE_SIZE);
  // Nothing typed yet: the best players still on the board instead of a blank prompt.
  const showRanked = query.trim().length < 2 && available.length > 0;
  const listHits = showRanked ? available.slice(0, shown).map(ratingToHit) : results;

  // Responses can land out of order; only the latest search may write.
  const searchSeq = useRef(0);
  const runSearch = useCallback(
    (q: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      const seq = ++searchSeq.current;
      if (q.trim().length < 2) {
        setResults([]);
        setSearching(false);
        return;
      }
      // Spinner now, not after the debounce, so "No players found." can't flash first.
      setSearching(true);
      debounceRef.current = setTimeout(async () => {
        try {
          const hits = await searchContestPlayers(contest, q, 30);
          if (seq === searchSeq.current) setResults(hits);
        } catch {
          if (seq === searchSeq.current) setResults([]);
        } finally {
          if (seq === searchSeq.current) setSearching(false);
        }
      }, 200);
    },
    [contest],
  );

  const handleChange = (v: string) => {
    setQuery(v);
    runSearch(v);
  };

  return (
    <div className="bg-surface rounded-card-lg shadow-card p-4 lg:p-5">
      <input
        type="text"
        value={query}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="Search players…"
        aria-label="Search players"
        className="w-full px-3.5 py-2.5 rounded-card-sm bg-ink/5 font-tight text-[14px] text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent min-h-[44px] mb-4"
      />

      {actionError && (
        <p role="alert" className="mb-3 text-[12px] text-live font-tight">
          {actionError}
        </p>
      )}

      {ratings.length > 0 && (
        <RankingsHeader
          competition={contest.competition}
          title={showRanked ? 'Best available' : undefined}
          className="mb-2"
        />
      )}

      {query.trim().length < 2 && !showRanked ? (
        <p className="text-faint font-tight text-[13px] py-6 text-center">
          Search the player pool to nominate or queue someone.
        </p>
      ) : searching && !showRanked ? (
        <div className="space-y-2" aria-busy="true">
          <span className="sr-only">Loading…</span>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-11 rounded-card-sm bg-ink/[0.06] animate-pulse" aria-hidden="true" />
          ))}
        </div>
      ) : listHits.length === 0 ? (
        <p className="text-faint font-tight text-[13px] py-6 text-center">No players found.</p>
      ) : (
        <ul className="space-y-1.5">
          {listHits.map((hit) => {
            const key = `${league}:${hit.playerId}`;
            const draftedTeamId = draftedByKey.get(key) ?? null;
            const drafted = draftedTeamId !== null;
            const queued = queue.some((q) => q.playerId === hit.playerId && q.playerLeague === league);
            const rating = ratingMap.get(key);
            return (
              <li
                key={hit.playerId}
                className={[
                  'flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2.5 rounded-card-sm',
                  drafted ? 'opacity-45' : 'hover:bg-surface-hi transition-colors duration-150',
                ].join(' ')}
              >
                <div className="min-w-0 flex-1">
                  <div className="font-tight text-[13.5px] font-semibold text-ink truncate">{hit.fullName}</div>
                  <div className="font-tight text-[11px] text-muted truncate">
                    {drafted ? `Drafted — ${teamById.get(draftedTeamId)?.teamName ?? 'Team'}` : hit.teamName ?? ' '}
                  </div>
                </div>
                {!drafted && (
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => onQueue({ playerLeague: league, playerId: hit.playerId, playerName: hit.fullName })}
                      disabled={queued}
                      aria-label={queued ? `${hit.fullName} is queued` : `Queue ${hit.fullName}`}
                      className={[
                        'flex items-center justify-center w-9 h-9 rounded-full transition-colors duration-150',
                        queued ? 'text-accent bg-accent/10 cursor-default' : 'text-faint hover:text-ink hover:bg-ink/10 cursor-pointer',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      ].join(' ')}
                    >
                      <QueueGlyph filled={queued} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onNominate(hit)}
                      disabled={!canNominate}
                      className={[
                        'px-3.5 py-2 rounded-full min-h-[36px] font-tight text-[11px] font-bold tracking-[0.08em] uppercase transition-all duration-150',
                        canNominate
                          ? 'bg-accent text-accent-ink hover:opacity-90 cursor-pointer'
                          : 'bg-ink/[0.06] text-faint cursor-not-allowed',
                      ].join(' ')}
                    >
                      Nominate
                    </button>
                  </div>
                )}
                <RatingRowLine rating={rating} />
              </li>
            );
          })}
          {showRanked && shown < available.length && (
            <li className="pt-2">
              <ShowMoreButton onClick={() => setShown((n) => n + RANKED_PAGE_SIZE)} />
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function QueueGlyph({ filled }: { filled: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {filled ? (
        <path d="M8 2l1.6 3.9 4.2.4-3.2 2.8.9 4.1L8 11.1l-3.5 2.1.9-4.1-3.2-2.8 4.2-.4L8 2z" fill="currentColor" />
      ) : (
        <path
          d="M8 2l1.6 3.9 4.2.4-3.2 2.8.9 4.1L8 11.1l-3.5 2.1.9-4.1-3.2-2.8 4.2-.4L8 2z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

// ─── Results panel (won nominations, newest first) ─────────────────────────

function ResultsPanel({ wonResults, teamById }: { wonResults: DraftNomination[]; teamById: Map<string, TeamInfo> }) {
  if (wonResults.length === 0) {
    return (
      <div className="bg-surface rounded-card-lg shadow-card p-8 text-center">
        <p className="text-muted font-tight text-[13px]">No sales yet.</p>
      </div>
    );
  }
  return (
    <div className="bg-surface rounded-card-lg shadow-card overflow-hidden">
      <ul aria-label="Auction results">
        {wonResults.map((n, idx) => (
          <li
            key={n.id}
            className={['flex items-center gap-3 px-4 py-3', idx > 0 ? 'border-t border-hairline' : ''].join(' ')}
          >
            <div className="min-w-0 flex-1">
              <div className="font-tight text-[13.5px] font-semibold text-ink truncate">{n.playerName}</div>
              <div className="font-tight text-[11px] text-muted truncate">
                {teamById.get(n.highTeamId)?.teamName ?? 'Team'}
              </div>
            </div>
            <span className="font-tight text-[14px] font-bold text-accent tabular flex-shrink-0">${n.highBid}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Queue panel (auction variant) ─────────────────────────────────────────

function AuctionQueuePanel({
  draftId,
  myTeam,
  queue,
  setQueue,
  ratings,
  onRequireAuth,
}: {
  draftId: string;
  myTeam: TeamInfo | null;
  queue: DraftRef[];
  setQueue: (q: DraftRef[]) => void;
  ratings: PlayerRating[];
  onRequireAuth: () => void;
}) {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const ratingMap = useMemo(() => toRatingMap(ratings), [ratings]);

  const persist = useCallback(
    (next: DraftRef[]) => {
      setQueue(next);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      // Save the newest queue, not this call's: an add from the Players tab
      // saves at once, and a stale timer would overwrite it.
      saveTimer.current = setTimeout(() => {
        saveDraftQueue(draftId, queueRef.current).catch(() => {});
      }, 400);
    },
    [draftId, setQueue],
  );

  if (!myTeam) {
    return (
      <div className="bg-surface rounded-card-lg shadow-card p-8 text-center">
        <p className="text-muted font-tight text-[13px] mb-3">Sign in with a team in this league to build a queue.</p>
        <button
          type="button"
          onClick={onRequireAuth}
          className="text-accent font-tight text-[13px] font-bold hover:opacity-80 transition-opacity cursor-pointer"
        >
          Sign in
        </button>
      </div>
    );
  }

  if (queue.length === 0) {
    return (
      <div className="bg-surface rounded-card-lg shadow-card p-8 text-center">
        <p className="text-muted font-tight text-[13px]">
          Your queue is empty. Add players from the PLAYERS tab. If your nomination clock runs out, autodraft nominates
          for you: your queue first, then the top-ranked player left.
        </p>
      </div>
    );
  }

  const move = (idx: number, dir: -1 | 1) => {
    const next = [...queue];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    persist(next);
  };

  const remove = (idx: number) => {
    persist(queue.filter((_, i) => i !== idx));
  };

  return (
    <div className="bg-surface rounded-card-lg shadow-card overflow-hidden">
      <ul aria-label="Your draft queue">
        {queue.map((entry, idx) => (
          <li
            key={`${entry.playerLeague}:${entry.playerId}`}
            className={['flex items-center gap-2 px-4 py-3', idx > 0 ? 'border-t border-hairline' : ''].join(' ')}
          >
            <span className="font-tight text-[11px] font-bold text-faint tabular w-5">{idx + 1}</span>
            <div className="flex-1 min-w-0">
              <div className="font-tight text-[13.5px] font-semibold text-ink truncate">{entry.playerName}</div>
              <RatingLine rating={ratingMap.get(ratingKey(entry.playerLeague, entry.playerId))} compact />
            </div>
            <div className="flex items-center gap-0.5 flex-shrink-0">
              <button
                type="button"
                onClick={() => move(idx, -1)}
                disabled={idx === 0}
                aria-label={`Move ${entry.playerName} up`}
                className="flex items-center justify-center w-9 h-9 rounded-full text-faint hover:text-ink hover:bg-ink/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <ArrowIcon dir="up" />
              </button>
              <button
                type="button"
                onClick={() => move(idx, 1)}
                disabled={idx === queue.length - 1}
                aria-label={`Move ${entry.playerName} down`}
                className="flex items-center justify-center w-9 h-9 rounded-full text-faint hover:text-ink hover:bg-ink/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <ArrowIcon dir="down" />
              </button>
              <button
                type="button"
                onClick={() => remove(idx)}
                aria-label={`Remove ${entry.playerName} from queue`}
                className="flex items-center justify-center w-9 h-9 rounded-full text-faint hover:text-live hover:bg-live/10 transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <XIcon />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ArrowIcon({ dir }: { dir: 'up' | 'down' }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className={dir === 'down' ? 'rotate-180' : ''}>
      <path d="M2.5 7.5L6 4l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
